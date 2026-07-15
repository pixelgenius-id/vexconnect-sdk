import QRCode from 'qrcode'
import { VexConnect, VexSession, VEXCONNECT_RELAY } from './core'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WalletEntry {
  id: string
  name: string
  iconUrl: string
  description?: string
  deepLinkScheme?: string
  /**
   * https:// base URL the wallet has verified via its own App Links/Universal
   * Links config (assetlinks.json / apple-app-site-association). When set,
   * the pairing URI is wrapped as `${universalLink}?uri=<encoded uri>` so
   * tapping it opens the wallet directly, or falls back to a normal webpage
   * if the app isn't installed. Dynamic per-wallet — same model as
   * WalletConnect's wallet registry, no domain is hardcoded by the SDK.
   */
  universalLink?: string
  playStoreUrl?: string
  appStoreUrl?: string
}

/** Wraps the raw pairing URI for a specific wallet's deep-link/QR target. */
function walletOpenUrl(wallet: WalletEntry, coreUri: string): string {
  if (!wallet.universalLink) return coreUri
  const sep = wallet.universalLink.includes('?') ? '&' : '?'
  return `${wallet.universalLink}${sep}uri=${encodeURIComponent(coreUri)}`
}

export interface VexConnectModalOptions {
  dappName: string
  dappUrl: string
  dappIcon?: string
  /**
   * Override wallet list. If omitted, fetched automatically from
   * the official VexConnect registry.
   */
  wallets?: WalletEntry[]
  theme?: 'light' | 'dark' | 'auto'
  accentColor?: string
  connectTimeoutMs?: number
}

export interface VexConnectResult {
  session: VexSession
  bridge: VexConnect
}

// ─── Default wallets ──────────────────────────────────────────────────────────

const VEXWALLET_ICON = `data:image/svg+xml;base64,${btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0F172A"/><path d="M14 18L32 46L50 18H41L32 34L23 18Z" fill="#F59E0B"/></svg>'
)}`

const DEFAULT_WALLETS: WalletEntry[] = [
  {
    id: 'vexwallet',
    name: 'VexWallet',
    iconUrl: VEXWALLET_ICON,
    description: 'Official Vexanium wallet · Android',
    deepLinkScheme: 'vexconnect://',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=id.pixelgenius.vexwallet',
  },
]

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Opens the VexConnect wallet modal.
 *
 * @example
 * ```ts
 * const session = await openVexConnectModal({
 *   relayUrl: 'wss://connect.nodespark.fun',
 *   dappName: 'My dApp',
 *   dappUrl: 'https://mydapp.vex',
 * })
 * console.log(session.account) // "myaccount"
 * ```
 */
/**
 * Derives the HTTP(S) registry URL from the relay WebSocket URL.
 * wss://connect.nodespark.fun  →  https://connect.nodespark.fun/registry
 * ws://localhost:8080          →  http://localhost:8080/registry
 */
const REGISTRY_URL = VEXCONNECT_RELAY
  .replace(/^wss:\/\//, 'https://')
  .replace(/^ws:\/\//, 'http://')
  .replace(/\/$/, '') + '/registry'

async function fetchWallets(): Promise<WalletEntry[]> {
  try {
    const res = await fetch(REGISTRY_URL, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json() as { wallets: WalletEntry[] }
    return Array.isArray(json.wallets) ? json.wallets : []
  } catch {
    return DEFAULT_WALLETS   // fallback to bundled default
  }
}

export function openVexConnectModal(opts: VexConnectModalOptions): Promise<VexConnectResult> {
  return new Promise((resolve, reject) => {
    if (opts.wallets !== undefined) {
      new VexConnectModal(opts, opts.wallets, resolve, reject).mount()
      return
    }
    const modal = new VexConnectModal(opts, null, resolve, reject)
    modal.mount()
    fetchWallets().then((wallets) => modal.setWallets(wallets))
  })
}

// ─── Modal ────────────────────────────────────────────────────────────────────

type View = 'loading' | 'wallets' | 'qr' | 'connecting' | 'connected' | 'error'

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

/* ── Overlay ── */
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:999999;padding:16px;animation:fi .18s ease-out}
@keyframes fi{from{opacity:0}to{opacity:1}}

/* ── Modal card ── */
@keyframes su{from{opacity:0;transform:translateY(18px) scale(.97)}to{opacity:1;transform:none}}
.modal{--bg:#141618;--bd:rgba(255,255,255,.06);--sf:rgba(255,255,255,.05);--tx:#e2e8f0;--mt:#64748b;--ac:#f59e0b;background:var(--bg);border:1px solid var(--bd);border-radius:24px;width:100%;max-width:400px;overflow:hidden;animation:su .28s cubic-bezier(.34,1.56,.64,1);box-shadow:0 32px 96px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.03);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.modal.light{--bg:#ffffff;--bd:rgba(0,0,0,.08);--sf:rgba(0,0,0,.04);--tx:#0f172a;--mt:#64748b}

/* ── Header ── */
.hdr{display:flex;align-items:center;gap:8px;padding:20px 20px 0}
.hdr-brand{display:flex;align-items:center;gap:7px;flex:1;min-width:0}
.hdr-logo{flex-shrink:0;width:24px;height:24px}
.hdr-t{font-size:15px;font-weight:600;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.x{width:32px;height:32px;border-radius:50%;background:var(--sf);border:1px solid var(--bd);cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--mt);font-size:14px;transition:.15s;flex-shrink:0}
.x:hover{background:rgba(255,255,255,.1);color:var(--tx);border-color:rgba(255,255,255,.12)}
.modal.light .x:hover{background:rgba(0,0,0,.08);color:var(--tx);border-color:rgba(0,0,0,.12)}

/* ── Loading / shimmer ── */
.loading{padding:20px 16px 24px;display:flex;flex-direction:column;gap:10px}
@keyframes sh{0%{background-position:200% 0}100%{background-position:-200% 0}}
.shimmer-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:14px;background:var(--sf)}
.shimmer{border-radius:8px;background:linear-gradient(90deg,var(--sf) 25%,rgba(255,255,255,.09) 50%,var(--sf) 75%);background-size:200% 100%;animation:sh 1.4s ease-in-out infinite}
.modal.light .shimmer{background:linear-gradient(90deg,var(--sf) 25%,rgba(0,0,0,.07) 50%,var(--sf) 75%);background-size:200% 100%}
.sh-icon{width:52px;height:52px;border-radius:12px;flex-shrink:0}
.sh-lines{flex:1;display:flex;flex-direction:column;gap:6px}
.sh-name{height:14px;width:45%;border-radius:6px}
.sh-desc{height:11px;width:60%;border-radius:5px}

/* ── Wallet list ── */
.wlist{padding:14px 12px 8px;display:flex;flex-direction:column;gap:4px}
.wi-row{display:flex;align-items:center;gap:6px}
.wi{display:flex;align-items:center;gap:12px;padding:12px;border-radius:14px;border:1px solid transparent;background:var(--sf);cursor:pointer;transition:background .15s,border-color .15s,box-shadow .15s,transform .1s;text-align:left;flex:1}
.qr-ico{flex-shrink:0;width:40px;height:40px;border-radius:12px;background:var(--sf);border:1px solid transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--mt);transition:background .15s,border-color .15s,color .15s}
.qr-ico svg{width:18px;height:18px}
.qr-ico:hover{background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.3);color:var(--ac)}
.wi:hover{background:rgba(255,255,255,.07);border-color:rgba(245,158,11,.3);box-shadow:0 0 0 1px rgba(245,158,11,.12),0 4px 16px rgba(0,0,0,.2);transform:translateY(-1px)}
.modal.light .wi:hover{background:rgba(0,0,0,.04);border-color:rgba(245,158,11,.35);box-shadow:0 0 0 1px rgba(245,158,11,.15),0 4px 12px rgba(0,0,0,.08)}
.wi:nth-child(1){animation:wfi .18s ease both}
.wi:nth-child(2){animation:wfi .18s .05s ease both}
.wi:nth-child(3){animation:wfi .18s .10s ease both}
.wi:nth-child(4){animation:wfi .18s .15s ease both}
.wi:nth-child(n+5){animation:wfi .18s .18s ease both}
@keyframes wfi{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.wico{width:52px;height:52px;border-radius:12px;overflow:hidden;flex-shrink:0;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center}
.wico img{width:100%;height:100%;object-fit:cover}
.winfo{flex:1;min-width:0}
.wn{font-size:15px;font-weight:600;color:var(--tx);line-height:1.2}
.wd{font-size:12px;color:var(--mt);margin-top:2px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wa{font-size:20px;color:var(--mt);margin-left:auto;flex-shrink:0;padding-left:6px;line-height:1}

/* ── Footer ── */
.foot{display:flex;align-items:center;justify-content:center;gap:5px;padding:12px 12px 18px;color:var(--mt);font-size:10px;letter-spacing:.02em;opacity:.7}
.foot svg{flex-shrink:0}

/* ── QR view ── */
.qrp{padding:10px 20px 8px;display:flex;flex-direction:column;align-items:center}
.back{background:none;border:none;cursor:pointer;color:var(--mt);font-size:12px;padding:0 0 12px;align-self:flex-start;display:flex;align-items:center;gap:3px;transition:.15s}
.back:hover{color:var(--tx)}
.qrbox{background:#fff;border-radius:16px;padding:12px;width:260px;height:260px;display:flex;align-items:center;justify-content:center;position:relative;box-shadow:0 4px 24px rgba(0,0,0,.25)}
.qrbox svg{width:236px;height:236px}
.qrlogo{position:absolute;width:48px;height:48px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 4px #fff,0 2px 12px rgba(0,0,0,.2)}
.qrlogo img{width:38px;height:38px;object-fit:cover;border-radius:50%}
.hint{font-size:12px;color:var(--mt);text-align:center;margin-top:14px;line-height:1.5}
.cpbtn{margin-top:10px;display:flex;align-items:center;gap:6px;padding:9px 18px;border-radius:10px;border:1px solid var(--bd);background:var(--sf);color:var(--tx);font-size:13px;font-weight:500;cursor:pointer;transition:.15s}
.cpbtn:hover{background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.14)}
.modal.light .cpbtn:hover{background:rgba(0,0,0,.07);border-color:rgba(0,0,0,.14)}
.cpbtn.copied{color:var(--ac);border-color:rgba(245,158,11,.3)}
.div{width:100%;display:flex;align-items:center;gap:8px;margin:14px 0 10px}
.div::before,.div::after{content:'';flex:1;height:1px;background:var(--bd)}
.div span{font-size:10px;color:var(--mt);text-transform:uppercase;letter-spacing:.06em}
.dlbtn{width:100%;padding:13px;border-radius:12px;background:var(--ac);color:#0f172a;font-size:14px;font-weight:700;border:none;cursor:pointer;transition:.15s}
.dlbtn:hover{opacity:.88;transform:translateY(-1px)}

/* ── Center panel (connecting / connected / error) ── */
.ctr{padding:28px 22px 32px;display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center}
.spin{width:48px;height:48px;border:3px solid rgba(255,255,255,.08);border-top-color:var(--ac);border-radius:50%;animation:sp .7s linear infinite}
.modal.light .spin{border-color:rgba(0,0,0,.08);border-top-color:var(--ac)}
@keyframes sp{to{transform:rotate(360deg)}}
.ct{font-size:15px;font-weight:600;color:var(--tx)}
.cs{font-size:12px;color:var(--mt);line-height:1.5;max-width:260px}
.cwn{font-size:13px;font-weight:600;color:var(--ac);margin-top:-4px}

/* ── Connected ── */
@keyframes ck-in{0%{opacity:0;transform:scale(0)}60%{transform:scale(1.15)}100%{opacity:1;transform:scale(1)}}
.chk{width:56px;height:56px;border-radius:50%;background:rgba(52,211,153,.12);border:1.5px solid rgba(52,211,153,.3);display:flex;align-items:center;justify-content:center;animation:ck-in .4s cubic-bezier(.34,1.56,.64,1) both}
.chk-svg{width:26px;height:26px}
.ca{font-size:14px;color:var(--ac);font-weight:600}
.ck{font-size:11px;color:var(--mt);font-family:'SF Mono',ui-monospace,monospace;background:var(--sf);padding:4px 10px;border-radius:6px;border:1px solid var(--bd)}
.auto-close{font-size:11px;color:var(--mt)}

/* ── Error ── */
.err-ic{width:52px;height:52px;border-radius:50%;background:rgba(239,68,68,.12);border:1.5px solid rgba(239,68,68,.3);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0}
.et{font-size:15px;font-weight:600;color:#ef4444}
.em{font-size:12px;color:var(--mt);line-height:1.5;max-width:260px}
.rbtn{margin-top:4px;padding:11px 28px;border-radius:10px;background:var(--ac);color:#0f172a;font-size:14px;font-weight:700;border:none;cursor:pointer;transition:.15s}
.rbtn:hover{opacity:.88;transform:translateY(-1px)}
`

class VexConnectModal {
  private host: HTMLElement
  private shadow: ShadowRoot
  private vc: VexConnect
  private wallets: WalletEntry[]
  private selected: WalletEntry | null = null
  private view: View = 'loading'
  private errMsg = ''
  private session: VexSession | null = null
  private dark: boolean
  private resolve: (r: VexConnectResult) => void
  private reject: (e: Error) => void

  constructor(
    private opts: VexConnectModalOptions,
    initialWallets: WalletEntry[] | null,
    resolve: (r: VexConnectResult) => void,
    reject: (e: Error) => void,
  ) {
    this.resolve = resolve
    this.reject = reject
    this.wallets = initialWallets ?? []
    if (initialWallets !== null) this.view = 'wallets'
    this.dark = opts.theme === 'dark' ||
      (opts.theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)

    this.vc = this.makeVc()
    this.host = document.createElement('div')
    this.shadow = this.host.attachShadow({ mode: 'open' })
  }

  private makeVc() {
    const vc = new VexConnect({
      dappName: this.opts.dappName,
      dappUrl: this.opts.dappUrl,
      dappIcon: this.opts.dappIcon,
      connectTimeoutMs: this.opts.connectTimeoutMs,
    })
    vc.on('disconnect', () => { if (this.session) this.unmount() })
    vc.on('error', (e) => this.showErr(e.message))
    return vc
  }

  mount() {
    document.body.appendChild(this.host)
    this.render()
    document.addEventListener('keydown', this.onKey)
  }

  /** Called after registry fetch completes. Transitions loading → wallets. */
  setWallets(wallets: WalletEntry[]) {
    this.wallets = wallets
    if (this.view === 'loading') {
      this.view = 'wallets'
      this.render()
    }
  }

  private unmount() {
    document.removeEventListener('keydown', this.onKey)
    this.host.remove()
  }

  private dismiss() {
    this.vc.disconnect()
    this.unmount()
    this.reject(new Error('User closed'))
  }

  private onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.dismiss() }

  private render() {
    this.shadow.innerHTML = ''

    const style = document.createElement('style')
    style.textContent = CSS + (this.opts.accentColor ? `.modal{--ac:${this.opts.accentColor}}` : '')
    this.shadow.appendChild(style)

    const overlay = document.createElement('div')
    overlay.className = 'overlay'
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.dismiss() })

    const modal = document.createElement('div')
    modal.className = `modal${!this.dark ? ' light' : ''}`

    modal.appendChild(this.buildHeader())
    modal.appendChild(this.buildBody())
    overlay.appendChild(modal)
    this.shadow.appendChild(overlay)
  }

  private buildHeader() {
    const titles: Record<View, string> = {
      loading: 'Connect Wallet', wallets: 'Connect Wallet', qr: 'Scan QR Code',
      connecting: 'Connecting…', connected: 'Connected', error: 'Connection Failed',
    }
    const h = document.createElement('div')
    h.className = 'hdr'

    const brand = document.createElement('div')
    brand.className = 'hdr-brand'
    brand.innerHTML = `
      <svg class="hdr-logo" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect width="24" height="24" rx="6" fill="#0F172A"/>
        <path d="M5 7L12 17L19 7H15.5L12 13L8.5 7Z" fill="#F59E0B"/>
      </svg>
      <span class="hdr-t">${titles[this.view]}</span>`

    const x = document.createElement('button')
    x.className = 'x'
    x.setAttribute('aria-label', 'Close')
    x.innerHTML = '&#x2715;'
    x.addEventListener('click', () => this.dismiss())

    h.appendChild(brand)
    h.appendChild(x)
    return h
  }

  private buildBody() {
    switch (this.view) {
      case 'loading':    return this.buildLoading()
      case 'wallets':    return this.buildWallets()
      case 'qr':         return this.buildQr()
      case 'connecting': return this.buildConnecting()
      case 'connected':  return this.buildConnected()
      case 'error':      return this.buildError()
    }
  }

  private buildLoading() {
    const p = document.createElement('div')
    p.className = 'loading'
    for (let i = 0; i < 3; i++) {
      p.insertAdjacentHTML('beforeend', `
        <div class="shimmer-row">
          <div class="shimmer sh-icon"></div>
          <div class="sh-lines">
            <div class="shimmer sh-name"></div>
            <div class="shimmer sh-desc"></div>
          </div>
        </div>`)
    }
    return p
  }

  private buildWallets() {
    const wrap = document.createElement('div')

    const list = document.createElement('div')
    list.className = 'wlist'
    for (const w of this.wallets) {
      const row = document.createElement('div')
      row.className = 'wi-row'

      // Main area — opens deep link directly (or QR if no deep link)
      const btn = document.createElement('button')
      btn.className = 'wi'
      btn.innerHTML = `
        <div class="wico"><img src="${w.iconUrl}" alt="${w.name}"/></div>
        <div class="winfo">
          <div class="wn">${w.name}</div>
          <div class="wd">${w.description ?? ''}</div>
        </div>`
      btn.addEventListener('click', () => {
        this.selected = w
        this.startConnect()
        if (w.deepLinkScheme) {
          this.view = 'connecting'
          this.render()
        } else {
          this.view = 'qr'
          this.render()
        }
      })
      row.appendChild(btn)

      // QR icon button — always shows QR view
      const qrBtn = document.createElement('button')
      qrBtn.className = 'qr-ico'
      qrBtn.setAttribute('aria-label', 'Show QR code')
      qrBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>
        <rect x="14" y="14" width="3" height="3"/><rect x="18" y="14" width="3" height="3"/><rect x="14" y="18" width="3" height="3"/><rect x="18" y="18" width="3" height="3"/>
      </svg>`
      qrBtn.addEventListener('click', () => {
        this.selected = w
        this.view = 'qr'
        this.render()
        this.startConnect()
      })
      row.appendChild(qrBtn)

      list.appendChild(row)
    }
    wrap.appendChild(list)
    wrap.appendChild(this.buildFooter())
    return wrap
  }

  private buildQr() {
    const wrap = document.createElement('div')

    const p = document.createElement('div')
    p.className = 'qrp'

    const back = document.createElement('button')
    back.className = 'back'
    back.innerHTML = '‹ All wallets'
    back.addEventListener('click', () => { this.view = 'wallets'; this.render() })
    p.appendChild(back)

    const qrBox = document.createElement('div')
    qrBox.className = 'qrbox'
    qrBox.id = 'vc-qr'
    p.appendChild(qrBox)

    p.insertAdjacentHTML('beforeend', `<p class="hint">Scan with ${this.selected?.name ?? 'VexWallet'}</p>`)

    // Copy URI button
    const cpBtn = document.createElement('button')
    cpBtn.className = 'cpbtn'
    cpBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
      </svg>
      Copy URI`
    cpBtn.addEventListener('click', () => {
      navigator.clipboard?.writeText(this.vc.getUri()).catch(() => {})
      cpBtn.classList.add('copied')
      cpBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        Copied!`
      setTimeout(() => {
        cpBtn.classList.remove('copied')
        cpBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
          </svg>
          Copy URI`
      }, 2000)
    })
    p.appendChild(cpBtn)

    if (this.selected?.deepLinkScheme) {
      const wallet = this.selected
      p.insertAdjacentHTML('beforeend', `<div class="div"><span>or open on this device</span></div>`)
      const dl = document.createElement('button')
      dl.className = 'dlbtn'
      dl.textContent = `Open ${wallet.name}`
      dl.addEventListener('click', () => { window.location.href = walletOpenUrl(wallet, this.vc.getUri()) })
      p.appendChild(dl)
    }

    wrap.appendChild(p)
    wrap.appendChild(this.buildFooter())

    requestAnimationFrame(() => this.renderQr())
    return wrap
  }

  private async renderQr() {
    const el = this.shadow.getElementById('vc-qr')
    if (!el) return
    // Wrap in the selected wallet's universal link when it has one, so any
    // generic camera QR scanner (not just the wallet's own) can open it.
    const uri = this.selected ? walletOpenUrl(this.selected, this.vc.getUri()) : this.vc.getUri()
    try {
      el.innerHTML = await QRCode.toString(uri, {
        type: 'svg', margin: 0,
        color: { dark: '#000000', light: '#ffffff' },
        errorCorrectionLevel: 'H',
        width: 236,
      })
      const logo = document.createElement('div')
      logo.className = 'qrlogo'
      const iconSrc = this.selected?.iconUrl ?? VEXWALLET_ICON
      logo.innerHTML = `<img src="${iconSrc}" alt="wallet icon"/>`
      el.appendChild(logo)
    } catch { el.textContent = uri }
  }

  private startConnect() {
    this.vc.connect()
      .then((s) => {
        this.session = s
        this.view = 'connected'
        this.render()
        setTimeout(() => { this.unmount(); this.resolve({ session: s, bridge: this.vc }) }, 1500)
      })
      .catch((e: Error) => {
        if (!e.message.includes('User closed')) this.showErr(e.message)
      })
  }

  private buildConnecting() {
    const p = document.createElement('div')
    p.className = 'ctr'
    p.innerHTML = `
      <div class="spin"></div>
      <div class="ct">Waiting for approval</div>
      ${this.selected ? `<div class="cwn">${this.selected.name}</div>` : ''}
      <div class="cs">Open ${this.selected?.name ?? 'your wallet'} and approve the connection request.</div>`
    if (this.selected?.deepLinkScheme) {
      const wallet = this.selected
      const uri = walletOpenUrl(wallet, this.vc.getUri())
      const btn = document.createElement('button')
      btn.className = 'dlbtn'
      btn.textContent = `Open ${wallet.name}`
      btn.addEventListener('click', () => { window.location.href = uri })
      p.appendChild(btn)
    }
    return p
  }

  private buildConnected() {
    const p = document.createElement('div')
    p.className = 'ctr'
    const pubKey = this.session?.publicKey ?? ''
    const pubKeyTrunc = pubKey.length > 20 ? pubKey.slice(0, 10) + '…' + pubKey.slice(-8) : pubKey
    p.innerHTML = `
      <div class="chk">
        <svg class="chk-svg" viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="13" cy="13" r="13" fill="rgba(52,211,153,0.15)"/>
          <polyline points="7,13 11,17 19,9" stroke="#34d399" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="ct">Wallet Connected</div>
      <div class="ca">${this.session?.account ?? ''}</div>
      ${pubKey ? `<div class="ck">${pubKeyTrunc}</div>` : ''}
      <div class="auto-close">Closing automatically…</div>`
    return p
  }

  private buildError() {
    const p = document.createElement('div')
    p.className = 'ctr'
    p.innerHTML = `
      <div class="err-ic">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
      </div>
      <div class="et">Connection Failed</div>
      <div class="em">${this.errMsg}</div>`
    const r = document.createElement('button')
    r.className = 'rbtn'; r.textContent = 'Try Again'
    r.addEventListener('click', () => {
      this.vc = this.makeVc()
      this.view = 'wallets'; this.selected = null; this.errMsg = ''
      this.render()
    })
    p.appendChild(r)
    return p
  }

  private buildFooter() {
    const f = document.createElement('div')
    f.className = 'foot'
    f.innerHTML = `
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
      </svg>
      Secured by VexConnect&nbsp;·&nbsp;vexconnect.io`
    return f
  }

  private showErr(msg: string) { this.errMsg = msg; this.view = 'error'; this.render() }
}
