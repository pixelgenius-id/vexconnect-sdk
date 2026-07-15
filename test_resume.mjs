// Verifies session persistence + resume end-to-end against the real relay:
// approve a session, persist it, drop the connection, then confirm
// VexConnect.tryResume() reconnects and resolves via ping/pong without
// needing a fresh QR/approval - and that a stale (wallet-gone) session
// correctly fails instead of hanging.
import assert from 'node:assert'
import WebSocket from 'ws'

// Minimal in-memory localStorage stub - real browsers always have one, this
// just lets the same core.ts run under plain Node for this check.
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
}
globalThis.WebSocket = WebSocket

const { VexConnect } = await import('./dist/esm/core.js')
const { encryptPayload } = await import('./dist/esm/crypto.js')

function b64urlToBytes(s) {
  const pad = (4 - (s.length % 4)) % 4
  return Uint8Array.from(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad), 'base64'))
}

// 1) Fresh pairing, simulate a wallet approving it.
const vc = new VexConnect({ dappName: 'Test dApp', dappUrl: 'https://test.local' })
const uri = new URL(vc.getUri())
const sid = uri.searchParams.get('sid')
const symKey = b64urlToBytes(uri.searchParams.get('key'))

const wallet = new WebSocket('wss://connect.nodespark.fun/')
await new Promise((r) => wallet.on('open', r))
wallet.send(JSON.stringify({ type: 'subscribe', topic: sid }))
await new Promise((r) => setTimeout(r, 200))

wallet.on('message', async (raw) => {
  const wire = JSON.parse(raw.toString())
  if (wire.type === 'ping') wallet.send(JSON.stringify({ type: 'pong', topic: sid }))
})

// dApp must subscribe to the topic (via connect()) BEFORE the wallet
// broadcasts approval - the relay doesn't queue/replay for late joiners.
const connectPromise = vc.connect()
await new Promise((r) => setTimeout(r, 300))
const env = await encryptPayload(symKey, JSON.stringify({ account: 'kunka', publicKey: 'PUBKEY_1' }))
wallet.send(JSON.stringify({ type: 'session_approve', topic: sid, payload: env }))

const session = await connectPromise
assert.strictEqual(session.account, 'kunka', 'fresh approve should resolve with the wallet account')
console.log('PASS: fresh pairing approved')

// 2) Simulate a page reload: nothing survives except localStorage.
const resumed = VexConnect.tryResume({ dappName: 'Test dApp', dappUrl: 'https://test.local' })
assert.ok(resumed, 'tryResume should find the session just persisted')

const resumedSession = await resumed.connect()
assert.strictEqual(resumedSession.account, 'kunka', 'resume should resolve with the same account, no new approval needed')
console.log('PASS: resume succeeded while the wallet is still listening')

wallet.close()
vc.disconnect()
resumed.disconnect()

// 3) Stale case: persist a session for a topic nobody's listening on anymore,
// confirm resume fails (rather than hanging) and clears the stale entry.
const deadKey = crypto.getRandomValues(new Uint8Array(32))
const { toBase64Url } = await import('./dist/esm/crypto.js')
store.set('vexconnect:session', JSON.stringify({
  sid: crypto.randomUUID(),
  symKeyB64Url: toBase64Url(deadKey),
  session: { sessionId: 'x', account: 'ghost', publicKey: 'y' },
}))
const deadResume = VexConnect.tryResume({ dappName: 'Test dApp', dappUrl: 'https://test.local' })
assert.ok(deadResume, 'tryResume should still construct an instance to attempt')
await assert.rejects(() => deadResume.connect(), 'resume against a topic nobody answers on must reject, not hang')
assert.strictEqual(store.get('vexconnect:session'), undefined, 'a failed resume must clear the stale persisted entry')
console.log('PASS: stale session resume fails cleanly and clears storage')
