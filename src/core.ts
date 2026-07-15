// ─── Constants ────────────────────────────────────────────────────────────────

/** Relay hosted by Pixel Genius — all sessions go through here. */
export const VEXCONNECT_RELAY = 'wss://connect.nodespark.fun'

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

export interface TransactionRequest {
  /** e.g. "transfer" */
  action: string
  params: Record<string, string>
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

// ─── VexConnect core class ────────────────────────────────────────────────────

export class VexConnect {
  private readonly sid: string
  private readonly opts: Required<VexConnectOptions> & { relayUrl: string }

  private ws: WebSocket | null = null
  private session: VexSession | null = null

  private connectResolve: ((s: VexSession) => void) | null = null
  private connectReject:  ((e: Error) => void) | null = null
  private pending = new Map<string, {
    resolve: (r: TransactionResult) => void
    reject:  (e: Error) => void
  }>()

  private disconnectHandlers: Array<() => void> = []
  private errorHandlers:      Array<(e: Error) => void> = []

  constructor(opts: VexConnectOptions) {
    this.sid  = crypto.randomUUID()
    this.opts = { dappIcon: '', relayUrl: VEXCONNECT_RELAY, ...opts, connectTimeoutMs: opts.connectTimeoutMs ?? 300_000 }
  }

  // ── URI ───────────────────────────────────────────────────────────────────

  /** Returns the vexconnect:// pairing URI. Encode as QR for the wallet to scan. */
  getUri(): string {
    const p = new URLSearchParams({
      sid:   this.sid,
      relay: this.opts.relayUrl,
      name:  this.opts.dappName,
      url:   this.opts.dappUrl,
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
        this.send({ type: 'subscribe', topic: this.sid })
      })

      this.ws.addEventListener('message', (ev: MessageEvent<string>) => {
        this.handleMsg(ev.data)
      })

      this.ws.addEventListener('error', () => {
        clearTimeout(timer)
        const err = new Error('VexConnect: WebSocket error')
        this.errorHandlers.forEach(fn => fn(err))
        reject(err)
      })

      this.ws.addEventListener('close', () => {
        clearTimeout(timer)
        if (this.session) this.disconnectHandlers.forEach(fn => fn())
        else reject(new Error('VexConnect: connection closed before approval'))
      })
    })
  }

  // ── Transaction ───────────────────────────────────────────────────────────

  sendTransaction(req: TransactionRequest): Promise<TransactionResult> {
    if (!this.session || !this.ws || this.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('VexConnect: no active session'))

    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
      this.send({
        type: 'request',
        topic: this.sid,
        payload: { requestId, action: req.action, params: req.params },
      })
    })
  }

  // ── Disconnect ────────────────────────────────────────────────────────────

  disconnect() {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.send({ type: 'session_delete', topic: this.sid, payload: {} })
    this.cleanup()
    this.disconnectHandlers.forEach(fn => fn())
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  get currentSession() { return this.session }
  get isConnected()    { return !!this.session && this.ws?.readyState === WebSocket.OPEN }

  // ── Private ───────────────────────────────────────────────────────────────

  private send(msg: RelayMsg) {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(msg))
  }

  private handleMsg(raw: string) {
    let msg: RelayMsg
    try { msg = JSON.parse(raw) } catch { return }

    const { type, payload } = msg

    if (type === 'session_approve') {
      const account   = payload?.account   as string | undefined
      const publicKey = payload?.publicKey as string | undefined
      if (!account || !publicKey) return
      this.session = { sessionId: this.sid, account, publicKey }
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

    else if (type === 'session_delete') {
      this.session = null
      this.cleanup()
      this.disconnectHandlers.forEach(fn => fn())
    }
  }

  private cleanup() {
    try { this.ws?.close() } catch { /* ignore */ }
    this.ws = null
    this.pending.forEach(({ reject }) => reject(new Error('VexConnect: session ended')))
    this.pending.clear()
  }
}
