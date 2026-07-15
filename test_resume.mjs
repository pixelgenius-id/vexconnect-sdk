// Verifies session persistence + resume end-to-end against the real relay:
// approve a session via the ECDH handshake, persist it, drop the connection,
// then confirm VexConnect.tryResume() reconnects and resolves via ping/pong
// without needing a fresh QR/approval - and that a stale (wallet-gone)
// session correctly fails instead of hanging.
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
const { encryptPayload, decryptPayload, toBase64Url, fromBase64Url, generateX25519KeyPair, deriveSessionKey } = await import('./dist/esm/crypto.js')

// 1) Fresh pairing: simulate a wallet that generates its own X25519 keypair,
// derives the shared key via ECDH against the dApp's public key from the
// URI, and sends its own public key back in the clear on session_approve -
// exactly what a real wallet implementation must do.
const vc = new VexConnect({ dappName: 'Test dApp', dappUrl: 'https://test.local' })
const uri = new URL(vc.getUri())
const sid = uri.searchParams.get('sid')
const dappPub = fromBase64Url(uri.searchParams.get('pub'))

const walletKeyPair = generateX25519KeyPair()
const sessionKey = deriveSessionKey(walletKeyPair.secretKey, dappPub)

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
const env = await encryptPayload(sessionKey, JSON.stringify({ account: 'kunka', publicKey: 'PUBKEY_1' }))
wallet.send(JSON.stringify({ type: 'session_approve', topic: sid, payload: env, pub: toBase64Url(walletKeyPair.publicKey) }))

const session = await connectPromise
assert.strictEqual(session.account, 'kunka', 'fresh approve should resolve with the wallet account')
console.log('PASS: fresh pairing approved via ECDH handshake')

// 1b) Rejection before any approval ever happens - the wallet's very first
// (and only) message is session_reject, which must still carry `pub` or the
// dApp can never derive a key to decrypt it, and the reject is silently
// dropped (regression test for exactly that bug).
{
  const vc2 = new VexConnect({ dappName: 'Test dApp', dappUrl: 'https://test.local', connectTimeoutMs: 10_000 })
  const uri2 = new URL(vc2.getUri())
  const sid2 = uri2.searchParams.get('sid')
  const dappPub2 = fromBase64Url(uri2.searchParams.get('pub'))
  const walletKeyPair2 = generateX25519KeyPair()
  const sessionKey2 = deriveSessionKey(walletKeyPair2.secretKey, dappPub2)

  const wallet2 = new WebSocket('wss://connect.nodespark.fun/')
  await new Promise((r) => wallet2.on('open', r))
  wallet2.send(JSON.stringify({ type: 'subscribe', topic: sid2 }))
  await new Promise((r) => setTimeout(r, 200))

  const connectPromise2 = vc2.connect()
  await new Promise((r) => setTimeout(r, 300))
  const rejectEnv = await encryptPayload(sessionKey2, JSON.stringify({ reason: 'User rejected' }))
  wallet2.send(JSON.stringify({ type: 'session_reject', topic: sid2, payload: rejectEnv, pub: toBase64Url(walletKeyPair2.publicKey) }))

  await assert.rejects(() => connectPromise2, /rejected/, 'a reject-only handshake must surface the rejection, not hang')
  console.log('PASS: session_reject with no prior approve still decrypts and rejects promptly')
  wallet2.close()
}

// 2) Simulate a page reload: nothing survives except localStorage. Resume
// must reuse the already-derived session key directly - no new handshake.
const resumed = VexConnect.tryResume({ dappName: 'Test dApp', dappUrl: 'https://test.local' })
assert.ok(resumed, 'tryResume should find the session just persisted')

const resumedSession = await resumed.connect()
assert.strictEqual(resumedSession.account, 'kunka', 'resume should resolve with the same account, no new approval needed')
console.log('PASS: resume succeeded while the wallet is still listening')

// 2b) sendTransaction: wallet answers with a "response" - confirms the
// per-request timeout added alongside it doesn't fire when a response
// actually arrives (it must clear its timer via the wrapped resolve/reject).
wallet.on('message', async (raw) => {
  const wire = JSON.parse(raw.toString())
  if (wire.type !== 'request') return
  const payload = JSON.parse(await decryptPayload(sessionKey, wire.payload))
  const respEnv = await encryptPayload(sessionKey, JSON.stringify({ requestId: payload.requestId, txId: 'abc123', blockNum: 42 }))
  wallet.send(JSON.stringify({ type: 'response', topic: sid, payload: respEnv }))
})
const txResult = await resumed.sendTransaction({
  actions: [{ account: 'vexcore', name: 'deposit', authorization: [{ actor: 'kunka', permission: 'active' }], data: { owner: 'kunka', amount: '1.0000 VEX' } }],
})
assert.strictEqual(txResult.txId, 'abc123', 'sendTransaction should resolve with the wallet-provided txId')
assert.strictEqual(txResult.blockNum, 42, 'sendTransaction should resolve with the wallet-provided blockNum')
console.log('PASS: sendTransaction resolves normally when the wallet responds (per-request timeout stays dormant)')

wallet.close()
vc.disconnect()
resumed.disconnect()

// 3) Stale case: persist a session for a topic nobody's listening on anymore,
// confirm resume fails (rather than hanging) and clears the stale entry.
const deadKey = crypto.getRandomValues(new Uint8Array(32))
store.set('vexconnect:session', JSON.stringify({
  sid: crypto.randomUUID(),
  sessionKeyB64Url: toBase64Url(deadKey),
  session: { sessionId: 'x', account: 'ghost', publicKey: 'y' },
  approvedAt: Date.now(),
}))
const deadResume = VexConnect.tryResume({ dappName: 'Test dApp', dappUrl: 'https://test.local' })
assert.ok(deadResume, 'tryResume should still construct an instance to attempt')
await assert.rejects(() => deadResume.connect(), 'resume against a topic nobody answers on must reject, not hang')
assert.strictEqual(store.get('vexconnect:session'), undefined, 'a failed resume must clear the stale persisted entry')
console.log('PASS: stale session resume fails cleanly and clears storage')

// 4) Expired case: a session older than SESSION_TTL_MS must be rejected
// locally (no network attempt at all) even if the wallet would still answer.
store.set('vexconnect:session', JSON.stringify({
  sid: crypto.randomUUID(),
  sessionKeyB64Url: toBase64Url(deadKey),
  session: { sessionId: 'x', account: 'ghost', publicKey: 'y' },
  approvedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago, TTL is 7
}))
const expiredResume = VexConnect.tryResume({ dappName: 'Test dApp', dappUrl: 'https://test.local' })
assert.strictEqual(expiredResume, null, 'a session past its TTL must not be offered for resume at all')
assert.strictEqual(store.get('vexconnect:session'), undefined, 'loading an expired session must clear it from storage')
console.log('PASS: expired session is rejected locally without a network attempt')
