import { decryptPayload, encryptPayload, fromBase64Url, toBase64Url, type Envelope } from './crypto.js'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Relay hosted by Pixel Genius — all sessions go through here. */
export const VEXCONNECT_RELAY = 'wss://connect.nodespark.fun'

/** How long a silent resume waits for the wallet to answer a ping before giving up. */
const RESUME_TIMEOUT_MS = 4_000

/** How often an active session pings the wallet, to catch a silently-dropped
 * connection (idle proxies/NATs, backgrounded mobile browser, etc.) instead
 * of finding out only when a real transaction is sent. */
const KEEPALIVE_INTERVAL_MS = 20_000

/** How long sendTransaction() waits for the wallet's response before giving up -
 * without this, a wallet that never replies (crashed, bug, user never acts on
 * the approval dialog) leaves the caller's promise pending forever. */
const TRANSACTION_TIMEOUT_MS = 120_000

// ─── Session persistence ───────────────────────────────────────────────────────
// Mirrors WalletConnect's pairing persistence: save the topic/key/session so a
// page reload can resume without re-scanning a QR, as long as the wallet is
// still around to answer the ping. One active session per browser/origin —
// matches how a dApp typically has a single "connected wallet" at a time.

const STORAGE_KEY = 'vexconnect:session'
const hasStorage = typeof localStorage !== 'undefined'

interface PersistedSession {
  sid: string
  symKeyB64Url: string
  session: VexSession
}

function loadPersisted(): PersistedSession | null {
  if (!hasStorage) return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as PersistedSession) : null
  } catch {
    return null
  }
}

function savePersisted(p: PersistedSession) {
  if (hasStorage) localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
}

function clearPersisted() {
  if (hasStorage) localStorage.removeItem(STORAGE_KEY)
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VexConnectOptions {
  dappName: string
  dappUrl: string
  dappIcon?: string
  /** Session connect timeout ms. Default: 300 000 */
  connectTimeoutMs?: number
}

export interface VexSession {
  sessionId: string
  account: string
  publicKey: string
}

export interface AntelopeAction {
  /** Contract account, e.g. "eosio.token" or "vexcore" */
  account: string
  /** Action name, e.g. "transfer" or "deposit" */
  name: string
  authorization: { actor: string; permission: string }[]
  /** Plain JSON action data — the wallet resolves it against the live ABI. */
  data: Record<string, unknown>
}

export interface TransactionRequest {
  actions: AntelopeAction[]
}

export interface TransactionResult {
  txId: string
  blockNum: number
}

interface RelayMsg {
  type: string
  topic?: string
  payload?: Record<string, unknown>
}

/** Wire shape actually sent to the relay — payload is ciphertext, never plain. */
interface RelayWireMsg {
  type: string
  topic?: string
  payload?: Envelope
}

// ─── VexConnect core class ────────────────────────────────────────────────────

export class VexConnect {
  private readonly sid: string
  private readonly symKey: Uint8Array
  private readonly opts: Required<VexConnectOptions> & { relayUrl: string }
  /** Set only when constructed via tryResume() — the session to confirm, not yet trusted. */
  private readonly resumeCandidate: VexSession | null

  private ws: WebSocket | null = null
  private session: VexSession | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null

  private connectResolve: ((s: VexSession) => void) | null = null
  private connectReject:  ((e: Error) => void) | null = null
  private pongResolve: (() => void) | null = null
  private pending = new Map<string, {
    resolve: (r: TransactionResult) => void
    reject:  (e: Error) => void
  }>()

  private disconnectHandlers: Array<() => void> = []
  private errorHandlers:      Array<(e: Error) => void> = []

  constructor(opts: VexConnectOptions, resume?: { sid: string; symKey: Uint8Array; session: VexSession }) {
    this.sid             = resume?.sid ?? crypto.randomUUID()
    this.symKey          = resume?.symKey ?? crypto.getRandomValues(new Uint8Array(32))
    this.resumeCandidate = resume?.session ?? null
    this.opts            = { dappIcon: '', relayUrl: VEXCONNECT_RELAY, ...opts, connectTimeoutMs: opts.connectTimeoutMs ?? 300_000 }

    // Mobile browsers suspend/kill the WS while the tab is backgrounded (e.g.
    // the user switches to the wallet app to approve something) and drop the
    // TCP connection on a wifi/cellular handoff. Catch both by re-attempting
    // once the tab is foregrounded or the network comes back, instead of
    // leaving the session dead until the user manually reloads the page.
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.reconnectIfNeeded())
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.reconnectIfNeeded()
      })
    }
  }

  private reconnectIfNeeded() {
    if (this.session && this.ws?.readyState !== WebSocket.OPEN) {
      this.attemptResume(this.session).catch(() => this.disconnectHandlers.forEach(fn => fn()))
    }
  }

  /**
   * Reconstructs a VexConnect from a previously-approved session saved in
   * localStorage (mirrors WalletConnect's pairing persistence), if any.
   * Returns null immediately if nothing's saved — no network attempt made.
   * Call connect() on the result to confirm the wallet is still reachable;
   * it resolves fast (a ping/pong round trip) instead of waiting for a fresh
   * approval, or rejects if the wallet's gone, so the caller can fall back to
   * a normal openVexConnectModal() pairing.
   */
  static tryResume(opts: VexConnectOptions): VexConnect | null {
    const p = loadPersisted()
    if (!p) return null
    let symKey: Uint8Array
    try {
      symKey = fromBase64Url(p.symKeyB64Url)
    } catch {
      clearPersisted()
      return null
    }
    return new VexConnect(opts, { sid: p.sid, symKey, session: p.session })
  }

  // ── URI ───────────────────────────────────────────────────────────────────

  /**
   * Returns the vexconnect:// pairing URI. Encode as QR for the wallet to scan.
   * Carries the symmetric key out-of-band (via QR/deep-link, never through the
   * relay) so the relay only ever sees encrypted payloads — same "blind relay"
   * property WalletConnect's bridge servers have.
   */
  getUri(): string {
    const p = new URLSearchParams({
      sid:   this.sid,
      relay: this.opts.relayUrl,
      name:  this.opts.dappName,
      url:   this.opts.dappUrl,
      key:   toBase64Url(this.symKey),
    })
    if (this.opts.dappIcon) p.set('icon', this.opts.dappIcon)
    return `vexconnect://wc?${p}`
  }

  // ── Events ────────────────────────────────────────────────────────────────

  on(event: 'disconnect', fn: () => void): this
  on(event: 'error', fn: (e: Error) => void): this
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, fn: (...a: any[]) => void): this {
    if (event === 'disconnect') this.disconnectHandlers.push(fn as () => void)
    if (event === 'error')      this.errorHandlers.push(fn as (e: Error) => void)
    return this
  }

  // ── Connection ────────────────────────────────────────────────────────────

  connect(): Promise<VexSession> {
    return this.resumeCandidate ? this.attemptResume(this.resumeCandidate) : this.attemptFreshPair()
  }

  private attemptFreshPair(): Promise<VexSession> {
    return new Promise<VexSession>((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject  = reject

      const timer = setTimeout(() => {
        this.cleanup()
        reject(new Error('VexConnect: timed out waiting for wallet approval'))
      }, this.opts.connectTimeoutMs)

      try {
        this.ws = new WebSocket(this.opts.relayUrl)
      } catch (e) {
        clearTimeout(timer)
        reject(new Error(`VexConnect: cannot open WebSocket — ${(e as Error).message}`))
        return
      }

      this.ws.addEventListener('open', () => {
        void this.send({ type: 'subscribe', topic: this.sid })
      })

      this.ws.addEventListener('message', (ev: MessageEvent<string>) => {
        void this.handleMsg(ev.data)
      })

      this.ws.addEventListener('error', () => {
        clearTimeout(timer)
        const err = new Error('VexConnect: WebSocket error')
        this.errorHandlers.forEach(fn => fn(err))
        reject(err)
      })

      this.ws.addEventListener('close', () => {
        clearTimeout(timer)
        this.stopKeepalive()
        if (this.session) {
          // Connection dropped mid-session (not a rejection/never-approved) -
          // try once to resume before telling the app the session is gone.
          this.attemptResume(this.session).catch(() => this.disconnectHandlers.forEach(fn => fn()))
        } else {
          reject(new Error('VexConnect: connection closed before approval'))
        }
      })
    })
  }

  /** Confirms a saved session is still live by pinging the wallet on its topic. */
  private attemptResume(candidate: VexSession): Promise<VexSession> {
    return new Promise<VexSession>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pongResolve = null
        this.cleanup()
        clearPersisted()
        reject(new Error('VexConnect: resume failed — no response from wallet'))
      }, RESUME_TIMEOUT_MS)

      try {
        this.ws = new WebSocket(this.opts.relayUrl)
      } catch (e) {
        clearTimeout(timer)
        clearPersisted()
        reject(new Error(`VexConnect: cannot open WebSocket — ${(e as Error).message}`))
        return
      }

      this.ws.addEventListener('open', () => {
        void this.send({ type: 'subscribe', topic: this.sid })
        void this.send({ type: 'ping', topic: this.sid })
      })

      this.ws.addEventListener('message', (ev: MessageEvent<string>) => {
        void this.handleMsg(ev.data)
      })

      this.ws.addEventListener('error', () => {
        clearTimeout(timer)
        clearPersisted()
        reject(new Error('VexConnect: WebSocket error during resume'))
      })

      this.ws.addEventListener('close', () => {
        clearTimeout(timer)
        this.stopKeepalive()
        if (this.session) this.disconnectHandlers.forEach(fn => fn())
      })

      this.pongResolve = () => {
        clearTimeout(timer)
        this.pongResolve = null
        this.session = candidate
        this.startKeepalive()
        resolve(candidate)
      }
    })
  }

  // ── Transaction ───────────────────────────────────────────────────────────

  sendTransaction(req: TransactionRequest): Promise<TransactionResult> {
    if (!this.session || !this.ws || this.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('VexConnect: no active session'))

    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(
          `VexConnect: no response from wallet after ${TRANSACTION_TIMEOUT_MS / 1000}s — the wallet may not have handled the request, or the transaction may still be processing.`
        ))
      }, TRANSACTION_TIMEOUT_MS)

      this.pending.set(requestId, {
        resolve: (r) => { clearTimeout(timer); resolve(r) },
        reject:  (e) => { clearTimeout(timer); reject(e) },
      })
      void this.send({
        type: 'request',
        topic: this.sid,
        payload: { requestId, actions: req.actions },
      })
    })
  }

  // ── Disconnect ────────────────────────────────────────────────────────────

  disconnect() {
    if (this.ws?.readyState === WebSocket.OPEN)
      void this.send({ type: 'session_delete', topic: this.sid, payload: {} })
    clearPersisted()
    this.cleanup()
    this.disconnectHandlers.forEach(fn => fn())
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  get currentSession() { return this.session }
  get isConnected()    { return !!this.session && this.ws?.readyState === WebSocket.OPEN }

  // ── Private ───────────────────────────────────────────────────────────────

  private async send(msg: RelayMsg) {
    // Capture the socket up front: cleanup() can null this.ws while the
    // encryption below is still in flight (e.g. disconnect() fires this then
    // immediately calls cleanup() without waiting). Re-check readyState via
    // this local reference afterward instead of dereferencing this.ws again,
    // which could crash on a socket that's since been torn down.
    const ws = this.ws
    if (ws?.readyState !== WebSocket.OPEN) return
    const wire: RelayWireMsg = { type: msg.type, topic: msg.topic }
    if (msg.payload) wire.payload = await encryptPayload(this.symKey, JSON.stringify(msg.payload))
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(wire))
  }

  private async handleMsg(raw: string) {
    let wire: RelayWireMsg
    try { wire = JSON.parse(raw) } catch { return }

    const type = wire.type
    const payload: Record<string, unknown> | undefined = wire.payload
      ? JSON.parse(await decryptPayload(this.symKey, wire.payload))
      : undefined

    if (type === 'session_approve') {
      const account   = payload?.account   as string | undefined
      const publicKey = payload?.publicKey as string | undefined
      if (!account || !publicKey) return
      this.session = { sessionId: this.sid, account, publicKey }
      savePersisted({ sid: this.sid, symKeyB64Url: toBase64Url(this.symKey), session: this.session })
      this.startKeepalive()
      this.connectResolve?.(this.session)
      this.connectResolve = this.connectReject = null
    }

    else if (type === 'session_reject') {
      const err = new Error(`VexConnect: ${payload?.reason ?? 'wallet rejected'}`)
      this.connectReject?.(err)
      this.connectResolve = this.connectReject = null
      this.cleanup()
    }

    else if (type === 'response') {
      const rid = payload?.requestId as string | undefined
      if (!rid) return
      const p = this.pending.get(rid)
      if (!p) return
      this.pending.delete(rid)
      if (payload?.error) p.reject(new Error(payload.error as string))
      else p.resolve({ txId: payload?.txId as string, blockNum: payload?.blockNum as number ?? 0 })
    }

    else if (type === 'pong') {
      this.pongResolve?.()
    }

    else if (type === 'session_delete') {
      this.session = null
      clearPersisted()
      this.cleanup()
      this.disconnectHandlers.forEach(fn => fn())
    }
  }

  /** Periodic ping while a session is active, so a silently-dropped connection
   * (idle proxy/NAT timeout, backgrounded mobile browser) surfaces as a
   * disconnect instead of a confusing failure on the next real request. */
  private startKeepalive() {
    this.stopKeepalive()
    this.keepaliveTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) void this.send({ type: 'ping', topic: this.sid })
    }, KEEPALIVE_INTERVAL_MS)
  }

  private stopKeepalive() {
    if (this.keepaliveTimer !== null) clearInterval(this.keepaliveTimer)
    this.keepaliveTimer = null
  }

  private cleanup() {
    this.stopKeepalive()
    try { this.ws?.close() } catch { /* ignore */ }
    this.ws = null
    this.pending.forEach(({ reject }) => reject(new Error('VexConnect: session ended')))
    this.pending.clear()
  }
}
