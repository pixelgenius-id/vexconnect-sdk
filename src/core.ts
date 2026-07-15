import {
  decryptPayload, encryptPayload, fromBase64Url, toBase64Url,
  generateX25519KeyPair, deriveSessionKey, type Envelope, type X25519KeyPair,
} from './crypto.js'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Relay hosted by Pixel Genius. First entry is the one embedded in the
 * pairing URI (the only one the wallet ever learns about from a QR scan) —
 * later entries are tried only as reconnect fallbacks for an already-paired
 * session. Redundancy only actually kicks in once a second relay is deployed
 * and added here; with one entry this behaves exactly as a single relay. */
export const VEXCONNECT_RELAY = 'wss://connect.nodespark.fun'
const DEFAULT_RELAY_URLS = [VEXCONNECT_RELAY]

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

/** Max age of a persisted session before it's treated as expired, regardless
 * of whether the wallet would still answer a resume ping - mirrors
 * WalletConnect's session TTL (they use 7 days). Bounds how long a stored
 * key/approval stays valid on disk instead of trusting it forever. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Reconnect backoff: 1s, 2s, 4s, 8s, 16s, capped, then give up and tell the
 * app the session is gone (rather than retrying forever in the background
 * while the UI silently shows a stale "connected" state). */
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS  = 16_000
const RECONNECT_MAX_ATTEMPTS  = 5

// ─── Session persistence ───────────────────────────────────────────────────────
// Mirrors WalletConnect's pairing persistence: save the topic/key/session so a
// page reload can resume without re-scanning a QR, as long as the wallet is
// still around to answer the ping. One active session per browser/origin —
// matches how a dApp typically has a single "connected wallet" at a time.

const STORAGE_KEY = 'vexconnect:session'
const hasStorage = typeof localStorage !== 'undefined'

interface PersistedSession {
  sid: string
  /** The ECDH-derived AES key, not a keypair — resume reuses it directly
   * rather than re-running the handshake, same as WalletConnect (a reconnect
   * re-opens transport, it doesn't re-derive the session key). */
  sessionKeyB64Url: string
  session: VexSession
  approvedAt: number
}

function loadPersisted(): PersistedSession | null {
  if (!hasStorage) return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as PersistedSession
    if (Date.now() - p.approvedAt > SESSION_TTL_MS) {
      localStorage.removeItem(STORAGE_KEY)
      return null
    }
    return p
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
  /** Relay URLs to try, in order. First is embedded in the pairing URI;
   * later ones are reconnect-only fallbacks. Default: just the hosted relay. */
  relayUrls?: string[]
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

/** Wire shape actually sent to the relay — payload is ciphertext, never plain.
 * `pub` carries the wallet's ephemeral X25519 public key on the one message
 * that establishes the session key (session_approve) - a public key isn't
 * secret, so it travels in the clear alongside the (still-encryptable-only-
 * after-this-arrives) payload. */
interface RelayWireMsg {
  type: string
  topic?: string
  payload?: Envelope
  pub?: string
}

// ─── VexConnect core class ────────────────────────────────────────────────────

export class VexConnect {
  private readonly sid: string
  private readonly opts: Required<Omit<VexConnectOptions, 'relayUrls'>> & { relayUrls: string[] }
  /** Own X25519 keypair — only generated for a fresh pairing. Resume skips
   * ECDH entirely and reuses the already-derived session key. */
  private readonly keyPair: X25519KeyPair | null
  /** AES-256 key. Null until the ECDH handshake completes (fresh pairing);
   * pre-populated immediately when constructed via tryResume(). */
  private sessionKey: Uint8Array | null
  /** Set only when constructed via tryResume() — the session to confirm, not yet trusted. */
  private readonly resumeCandidate: VexSession | null

  private ws: WebSocket | null = null
  private session: VexSession | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null

  private relayIndex = 0
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  private connectResolve: ((s: VexSession) => void) | null = null
  private connectReject:  ((e: Error) => void) | null = null
  private pongResolve: (() => void) | null = null
  private pending = new Map<string, {
    resolve: (r: TransactionResult) => void
    reject:  (e: Error) => void
  }>()

  private disconnectHandlers: Array<() => void> = []
  private errorHandlers:      Array<(e: Error) => void> = []

  constructor(
    opts: VexConnectOptions,
    resume?: { sid: string; sessionKey: Uint8Array; session: VexSession },
  ) {
    this.sid             = resume?.sid ?? crypto.randomUUID()
    this.resumeCandidate = resume?.session ?? null
    this.keyPair         = resume ? null : generateX25519KeyPair()
    this.sessionKey      = resume?.sessionKey ?? null
    this.opts = {
      dappName: opts.dappName,
      dappUrl:  opts.dappUrl,
      dappIcon: opts.dappIcon ?? '',
      connectTimeoutMs: opts.connectTimeoutMs ?? 300_000,
      relayUrls: opts.relayUrls ?? DEFAULT_RELAY_URLS,
    }

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

  private get currentRelayUrl(): string {
    return this.opts.relayUrls[this.relayIndex % this.opts.relayUrls.length]
  }

  private reconnectIfNeeded() {
    if (!this.session || this.ws?.readyState === WebSocket.OPEN) return
    // A real-world signal (network back, tab visible) just fired - worth a
    // fresh attempt cycle even if the backoff series had already given up.
    this.reconnectAttempt = 0
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.scheduleReconnect()
  }

  /** Exponential backoff (1s/2s/4s/8s/16s), trying the next relay in
   * `relayUrls` each attempt. Gives up and fires disconnectHandlers only
   * after RECONNECT_MAX_ATTEMPTS - a brief blip shouldn't kick the user back
   * to the connect screen, but a genuinely dead wallet/network should. */
  private scheduleReconnect() {
    if (!this.session || this.reconnectTimer) return
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      this.reconnectAttempt = 0
      this.disconnectHandlers.forEach(fn => fn())
      return
    }
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_DELAY_MS)
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.session) return
      this.relayIndex++
      this.attemptResume(this.session).catch(() => this.scheduleReconnect())
    }, delay)
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
    let sessionKey: Uint8Array
    try {
      sessionKey = fromBase64Url(p.sessionKeyB64Url)
    } catch {
      clearPersisted()
      return null
    }
    return new VexConnect(opts, { sid: p.sid, sessionKey, session: p.session })
  }

  // ── URI ───────────────────────────────────────────────────────────────────

  /**
   * Returns the vexconnect:// pairing URI. Encode as QR for the wallet to scan.
   * Carries the dApp's X25519 *public* key only — never a secret. The wallet
   * generates its own ephemeral keypair on approval and the two sides derive
   * a shared AES key via ECDH (mirrors WalletConnect v2's session key
   * derivation), so a leaked/logged QR or URI is useless on its own: it
   * takes the wallet's ephemeral private key too, which never leaves the
   * wallet and is discarded once the session key is derived.
   */
  getUri(): string {
    if (!this.keyPair) throw new Error('VexConnect: getUri() is only valid for a fresh pairing, not a resumed session')
    const p = new URLSearchParams({
      sid:   this.sid,
      relay: this.currentRelayUrl,
      name:  this.opts.dappName,
      url:   this.opts.dappUrl,
      pub:   toBase64Url(this.keyPair.publicKey),
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
        this.ws = new WebSocket(this.currentRelayUrl)
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
          // let the backoff reconnect loop handle it instead of declaring the
          // session dead on the very first blip.
          this.scheduleReconnect()
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
        this.ws = new WebSocket(this.currentRelayUrl)
      } catch (e) {
        clearTimeout(timer)
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
        reject(new Error('VexConnect: WebSocket error during resume'))
      })

      this.ws.addEventListener('close', () => {
        clearTimeout(timer)
        this.stopKeepalive()
        this.scheduleReconnect()
      })

      this.pongResolve = () => {
        clearTimeout(timer)
        this.pongResolve = null
        this.session = candidate
        this.reconnectAttempt = 0
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
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.ws?.readyState === WebSocket.OPEN)
      void this.send({ type: 'session_delete', topic: this.sid, payload: {} })
    // Must clear session before the socket's own 'close' listener fires
    // (asynchronously, after ws.close() below) - otherwise it sees a
    // still-truthy session and treats this deliberate disconnect as an
    // unexpected drop, kicking off a reconnect attempt right after we asked
    // to disconnect.
    this.session = null
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
    if (msg.payload) {
      // Only 'subscribe' (no payload) can be sent before the ECDH handshake
      // resolves this - every payload-bearing send happens after a session
      // exists, by which point sessionKey is always set.
      if (!this.sessionKey) return
      wire.payload = await encryptPayload(this.sessionKey, JSON.stringify(msg.payload))
    }
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(wire))
  }

  private async handleMsg(raw: string) {
    let wire: RelayWireMsg
    try { wire = JSON.parse(raw) } catch { return }

    const type = wire.type

    if (wire.pub && !this.sessionKey) {
      // Fresh pairing: the wallet's ephemeral X25519 public key travels in
      // the clear on the wallet's first message (it's not secret) - derive
      // the shared AES key now, before anything (including that message's
      // own payload) can be decrypted. Checked on ANY message type, not just
      // session_approve - a wallet rejecting the pairing outright never
      // approves, but its session_reject still needs to be decryptable, or
      // the reject is silently dropped and the dApp hangs until timeout.
      if (!this.keyPair) return
      try {
        this.sessionKey = deriveSessionKey(this.keyPair.secretKey, fromBase64Url(wire.pub))
      } catch { return }
    }

    if (!this.sessionKey) return // nothing decryptable yet

    const payload: Record<string, unknown> | undefined = wire.payload
      ? JSON.parse(await decryptPayload(this.sessionKey, wire.payload))
      : undefined

    if (type === 'session_approve') {
      const account   = payload?.account   as string | undefined
      const publicKey = payload?.publicKey as string | undefined
      if (!account || !publicKey) return
      this.session = { sessionId: this.sid, account, publicKey }
      savePersisted({
        sid: this.sid,
        sessionKeyB64Url: toBase64Url(this.sessionKey),
        session: this.session,
        approvedAt: Date.now(),
      })
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
