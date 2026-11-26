import { type Api, ApiError } from '../lib/api'
import { alertLine, homeBody, modeLabel, positionBody, positionLine, price, qty } from '../lib/format'
import { type Glasses, H, type Input, type Page, type TextSpec, W } from '../lib/glasses'
import { Recorder, startBrowserMic } from '../lib/recorder'
import { clip, clock, fitBytes, ITEM_BYTES, levelBar, paginate } from '../lib/text'
import type { CommandResult, Plan, ServerEvent, Snapshot, Status } from '../lib/types'

type Back = 'home' | 'positions'

type Screen =
  | { name: 'boot' }
  | { name: 'setup'; reason: string }
  | { name: 'home' }
  | { name: 'positions' }
  | { name: 'position'; coin: string }
  | { name: 'alerts' }
  | { name: 'orders' }
  | { name: 'listening'; back: Back; viaHold: boolean }
  | { name: 'working'; back: Back; label: string }
  | { name: 'confirm'; plan: Plan; back: Back }
  | { name: 'info'; title: string; pages: string[]; page: number; back: Back; auto?: boolean; retry?: boolean }
  | { name: 'flash'; title: string; body: string; coin?: string; hasPosition: boolean }

type ListAction =
  | { act: 'position'; coin: string }
  | { act: 'alerts' }
  | { act: 'orders' }
  | { act: 'speak' }
  | { act: 'back' }

// ~26 px per text line on G2 (measured in the Even Hub simulator).
const HDR_H = 32
const BODY_Y = 34
const FOOT_H = 30
const PAGE_LINES = 7

const hdr = (content: string): TextSpec => ({ name: 'hdr', x: 0, y: 0, w: W, h: HDR_H, content })
const body = (content: string, h = H - BODY_Y - FOOT_H - 2): TextSpec => ({ name: 'body', x: 0, y: BODY_Y, w: W, h, content, border: true })
const foot = (content: string): TextSpec => ({ name: 'foot', x: 0, y: H - FOOT_H, w: W, h: FOOT_H, content, brightness: 2 })

export interface ControllerState {
  screen: Screen['name']
  status: Status | null
  snapshot: Snapshot | null
  online: boolean
  lastTranscript: string
  error: string
  /** No account on this device yet, or the server signed it out: the phone shows sign-up. */
  needsSignIn: boolean
}

/**
 * Everything on the glasses. One screen at a time; input goes to the active
 * screen. Async work is token-guarded so a slow reply never overwrites a
 * newer screen, and nothing trades without a confirm card.
 */
export class Controller {
  private screen: Screen = { name: 'boot' }
  private status: Status | null = null
  private snap: Snapshot | null = null
  private focus = ''
  private online = false
  private actions: ListAction[] = []
  private recorder = new Recorder()
  private stopBrowserMic?: () => void
  private listenTick?: ReturnType<typeof setInterval>
  private confirmTick?: ReturnType<typeof setInterval>
  private autoTimer?: ReturnType<typeof setTimeout>
  private clockTimer?: ReturnType<typeof setInterval>
  private workToken = 0
  private lastTranscript = ''
  private lastError = ''
  private needsSignIn = false
  private pendingFlash: Extract<Screen, { name: 'flash' }>[] = []
  private stopEvents?: () => void
  private listeners = new Set<(s: ControllerState) => void>()
  private disposed = false

  constructor(private readonly g: Glasses, readonly api: Api) {
    g.onInput(i => this.onInput(i))
    g.onAudio(pcm => this.onPcm(pcm))
  }

  // ── Phone UI hooks ────────────────────────────────────────────────────
  onState(fn: (s: ControllerState) => void) {
    this.listeners.add(fn)
    fn(this.state())
    return () => this.listeners.delete(fn)
  }

  private state(): ControllerState {
    return { screen: this.screen.name, status: this.status, snapshot: this.snap, online: this.online, lastTranscript: this.lastTranscript, error: this.lastError, needsSignIn: this.needsSignIn }
  }

  /** Re-send the current state to listeners (e.g. after the phone learned the server kind). */
  notify() {
    this.changed()
  }

  private changed() {
    const s = this.state()
    for (const fn of this.listeners) fn(s)
  }

  async start() {
    this.clockTimer = setInterval(() => { if (this.screen.name === 'home') void this.g.setText('hdr', this.homeHeader()) }, 20_000)
    await this.boot()
  }

  async boot() {
    this.stopEvents?.()
    this.stopEvents = undefined
    await this.show({ name: 'boot' })
    this.status = null
    this.snap = null
    this.needsSignIn = Boolean(this.api.config.baseUrl && !this.api.config.token)
    if (!this.api.configured) {
      return this.show({ name: 'setup', reason: this.needsSignIn ? 'Open Tape on your phone\nand tap Start.' : 'Open Tape on your phone\nand connect your server.' })
    }
    try {
      this.status = await this.api.status()
      this.snap = await this.api.snapshot()
      this.focus = this.snap.settings.focus
      this.online = true
      this.lastError = ''
    } catch (err) {
      this.online = false
      this.lastError = describe(err)
      if (err instanceof ApiError && err.status === 401) {
        this.needsSignIn = true
        return this.show({ name: 'setup', reason: 'Signed out.\nOpen Tape on your phone to start again.' })
      }
      return this.show({ name: 'setup', reason: `Can't reach your Tape server:\n${describe(err)}\n\nCheck it on your phone.` })
    }
    this.stopEvents = this.api.events(
      e => this.onServerEvent(e),
      connected => { this.online = connected; this.changed() },
    )
    await this.show({ name: 'home' })
  }

  /** Same path as voice, for the phone's command box. */
  async runText(text: string) {
    const back = this.backHere()
    const token = await this.working(back, `"${clip(text, 80)}"`)
    try {
      const res = await this.api.command(text)
      if (token !== this.workToken) return
      this.lastTranscript = res.transcript
      await this.handle(res.result, res.transcript, back)
    } catch (err) {
      if (token === this.workToken) await this.fail(err, back)
    }
  }

  startVoice() {
    void this.startListening(this.backHere(), false)
  }

  dispose() {
    this.disposed = true
    this.stopEvents?.()
    this.stopMic()
    clearInterval(this.clockTimer)
    clearInterval(this.confirmTick)
    clearTimeout(this.autoTimer)
    this.listeners.clear()
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  private async show(next: Screen) {
    if (this.disposed) return
    clearTimeout(this.autoTimer)
    clearInterval(this.confirmTick)
    this.screen = next
    await this.g.render(this.layout(next))
    if (next.name === 'confirm') this.confirmTick = setInterval(() => this.tickConfirm(), 1000)
    this.changed()
  }

  private homeHeader() {
    const parts = ['TAPE', this.snap ? modeLabel(this.snap.mode) : '']
    if (this.snap?.settings.readOnly) parts.push('read-only')
    if (!this.online && this.status) parts.push('offline')
    parts.push(clock())
    return parts.filter(Boolean).join(' · ')
  }

  private layout(s: Screen): Page {
    switch (s.name) {
      case 'boot':
        return { texts: [hdr('TAPE'), body('Connecting…')], capture: 'body' }
      case 'setup':
        return { texts: [hdr('TAPE · setup'), body(s.reason), foot('tap: retry · 2x: exit')], capture: 'body' }
      case 'home':
        return {
          texts: [hdr(this.homeHeader()), body(homeBody(this.snap, this.focus)), foot('tap: positions · hold: speak · swipe: coin')],
          capture: 'body',
        }
      case 'positions': {
        const snap = this.snap
        this.actions = [
          ...(snap?.positions ?? []).slice(0, 15).map(p => ({ act: 'position', coin: p.coin }) as const),
          { act: 'speak' },
          { act: 'alerts' },
          ...(snap?.orders.length ? [{ act: 'orders' } as const] : []),
          { act: 'back' },
        ]
        const items = this.actions.map(a => {
          switch (a.act) {
            case 'position': return positionLine(snap!.positions.find(p => p.coin === a.coin)!)
            case 'speak': return '▶ Speak an order or alert'
            case 'alerts': return `■ Alerts (${snap?.alerts.length ?? 0})`
            case 'orders': return `■ Open orders (${snap?.orders.length ?? 0})`
            case 'back': return '‹ Back'
          }
        })
        const n = snap?.positions.length ?? 0
        return { texts: [hdr(`POSITIONS (${n}) · ${snap?.account ? `open ${signed(snap.account.upnl)}` : ''}`)], list: { name: 'list', x: 0, y: BODY_Y, w: W, h: H - BODY_Y, items }, capture: 'list' }
      }
      case 'position': {
        const p = this.snap?.positions.find(x => x.coin === s.coin)
        return {
          texts: [hdr(`‹ ${s.coin} ${p ? p.side.toUpperCase() : 'closed'}`), { name: 'ctx', x: 0, y: BODY_Y, w: W, h: 86, content: p ? positionBody(p) : 'Position closed.', brightness: 3 }],
          list: { name: 'list', x: 0, y: BODY_Y + 90, w: W, h: H - BODY_Y - 90, items: p ? [`Close ${s.coin} position`, 'Close half', '‹ Back'] : ['‹ Back'] },
          capture: 'list',
        }
      }
      case 'alerts': {
        const alerts = this.snap?.alerts ?? []
        const items = [...alerts.slice(0, 16).map(a => `✕ ${alertLine(a)}`), '▶ Speak a new alert', ...(alerts.length ? ['✕ Clear all alerts'] : []), '‹ Back']
        return { texts: [hdr(`ALERTS (${alerts.length}) · tap one to remove`)], list: { name: 'list', x: 0, y: BODY_Y, w: W, h: H - BODY_Y, items }, capture: 'list' }
      }
      case 'orders': {
        const orders = this.snap?.orders ?? []
        const items = [
          ...orders.slice(0, 16).map(o => fitBytes(`${o.side.toUpperCase()} ${qty(o.qty)} ${o.coin} @ ${price(o.price)}${o.reduceOnly ? ' reduce' : ''}`, ITEM_BYTES)),
          ...(orders.length ? ['✕ Cancel all orders'] : []),
          '‹ Back',
        ]
        return { texts: [hdr(`OPEN ORDERS (${orders.length})`)], list: { name: 'list', x: 0, y: BODY_Y, w: W, h: H - BODY_Y, items }, capture: 'list' }
      }
      case 'listening':
        return { texts: [hdr('● Listening'), body(this.listeningText()), foot(s.viaHold ? 'release: done · 2x: cancel' : 'tap: done · 2x: cancel')], capture: 'body' }
      case 'working':
        return { texts: [hdr('TAPE'), body(`${s.label}\n\nWorking…`)], capture: 'body' }
      case 'confirm': {
        const items = s.plan.danger ? [s.plan.cancel, s.plan.confirm] : [s.plan.confirm, s.plan.cancel]
        return {
          texts: [hdr(this.confirmHeader(s.plan)), body(`${s.plan.title}\n${s.plan.body}`, 150)],
          list: { name: 'choice', x: 0, y: 188, w: W, h: H - 188, items: items.map(i => fitBytes(i, ITEM_BYTES)) },
          capture: 'choice',
        }
      }
      case 'info': {
        const pager = s.pages.length > 1 ? ` ${s.page + 1}/${s.pages.length}` : ''
        const hint = s.retry ? 'hold: try again · tap: back' : s.pages.length > 1 ? 'swipe: more · tap: back' : 'tap: back'
        return { texts: [hdr(`${clip(s.title, 40)}${pager}`), body(s.pages[s.page] ?? ''), foot(s.auto ? '' : hint)], capture: 'body' }
      }
      case 'flash':
        return {
          texts: [hdr('!! ALERT'), body(`${s.title}\n${s.body}`, 150)],
          list: { name: 'choice', x: 0, y: 188, w: W, h: H - 188, items: s.hasPosition && s.coin ? [`Close ${s.coin} position`, 'Dismiss'] : ['Dismiss'] },
          capture: 'choice',
        }
    }
  }

  private confirmHeader(plan: Plan) {
    const left = Math.max(0, Math.ceil((plan.expiresAt - Date.now()) / 1000))
    return `${plan.danger ? '!! CONFIRM' : 'CONFIRM'} · ${left}s`
  }

  private tickConfirm() {
    const s = this.screen
    if (s.name !== 'confirm') return clearInterval(this.confirmTick)
    if (Date.now() > s.plan.expiresAt) {
      clearInterval(this.confirmTick)
      void this.show({ name: 'info', title: 'Expired', pages: ['Confirmation timed out. Prices move:\nask again.'], page: 0, back: s.back })
      return
    }
    void this.g.setText('hdr', this.confirmHeader(s.plan))
  }

  /** Live data: update the current screen in place instead of rebuilding it. */
  private onServerEvent(e: ServerEvent) {
    if (e.type === 'snapshot') {
      this.snap = e.snapshot
      if (!this.snap.tickers.some(t => t.coin === this.focus)) this.focus = this.snap.settings.focus
      const s = this.screen
      if (s.name === 'home') {
        void this.g.setText('body', homeBody(this.snap, this.focus))
        void this.g.setText('hdr', this.homeHeader())
      } else if (s.name === 'position') {
        const p = this.snap.positions.find(x => x.coin === s.coin)
        if (p) void this.g.setText('ctx', positionBody(p))
        else void this.show(s) // closed elsewhere: rebuild with only "Back"
      }
      this.changed()
      return
    }
    if (e.type === 'alert') {
      const flash = { name: 'flash', title: e.title, body: e.body, hasPosition: e.hasPosition, ...(e.coin ? { coin: e.coin } : {}) } as const
      // Never interrupt someone mid-sentence or mid-confirm; show it right after.
      if (['listening', 'working', 'confirm'].includes(this.screen.name)) this.pendingFlash.push(flash)
      else void this.show(flash)
    }
  }

  private async goBack(back: Back) {
    const flash = this.pendingFlash.shift()
    if (flash) return this.show(flash)
    await this.show({ name: back })
  }

  private backHere(): Back {
    const n = this.screen.name
    return n === 'positions' || n === 'position' || n === 'alerts' || n === 'orders' ? 'positions' : 'home'
  }

  private async working(back: Back, label: string): Promise<number> {
    const token = ++this.workToken
    await this.show({ name: 'working', back, label })
    return token
  }

  private async fail(err: unknown, back: Back) {
    this.lastError = describe(err)
    await this.show({ name: 'info', title: 'Something went wrong', pages: paginate(describe(err), PAGE_LINES), page: 0, back })
  }

  private async handle(r: CommandResult, transcript: string, back: Back) {
    this.changed()
    switch (r.type) {
      case 'confirm':
        return this.show({ name: 'confirm', plan: r.plan, back })
      case 'info':
        return this.show({ name: 'info', title: r.title, pages: paginate(r.body, PAGE_LINES), page: 0, back })
      case 'clarify': {
        const heard = transcript ? `Heard: "${clip(transcript, 80)}"\n` : ''
        return this.show({ name: 'info', title: 'Not sure what to do', pages: paginate(`${heard}${r.body}`, PAGE_LINES), page: 0, back, retry: true })
      }
    }
  }

  private async execute(plan: Plan, back: Back) {
    const token = await this.working(back, clip(plan.title, 50))
    try {
      const res = await this.api.execute(plan.id)
      if (token !== this.workToken) return
      await this.show({ name: 'info', title: res.title, pages: paginate(res.body, PAGE_LINES), page: 0, back, auto: true })
      this.autoTimer = setTimeout(() => { if (this.screen.name === 'info' && this.screen.auto) void this.goBack(back) }, 2500)
    } catch (err) {
      if (token === this.workToken) await this.fail(err, back)
    }
  }

  // ── Voice ─────────────────────────────────────────────────────────────
  private listeningText() {
    const secs = Math.floor(this.recorder.seconds)
    const hint = this.recorder.speechDetected ? 'Got it… pause when done' : 'Speak now'
    return `${hint}   0:${String(secs).padStart(2, '0')}\n${levelBar(this.recorder.level)}\n\n"Buy 0.01 BTC" · "Close half my SOL"\n"Alert if ETH drops below 3k"\n"Move 500 from funding to trading"`
  }

  private async startListening(back: Back, viaHold: boolean) {
    if (this.screen.name === 'listening' || this.screen.name === 'working') return
    if (this.status && !this.status.stt) {
      return this.show({ name: 'info', title: 'Voice unavailable', pages: ['Speech-to-text is not set up on the server.\nType commands on the phone, or set\nSTT_BASE_URL in the server .env.'], page: 0, back })
    }
    this.recorder.start()
    await this.show({ name: 'listening', back, viaHold })
    if (!(await this.g.mic(true))) {
      return this.show({ name: 'info', title: 'Microphone error', pages: ['Could not open the glasses microphone.'], page: 0, back, retry: true })
    }
    if (this.g.emulated) {
      try {
        this.stopBrowserMic = await startBrowserMic(pcm => this.g.pushEmulatedAudio(pcm))
      } catch {
        await this.g.mic(false)
        return this.show({ name: 'info', title: 'Microphone blocked', pages: ['Allow the microphone in the browser,\nor type a command on the phone.'], page: 0, back })
      }
    }
    clearInterval(this.listenTick)
    this.listenTick = setInterval(() => { if (this.screen.name === 'listening') void this.g.setText('body', this.listeningText()) }, 450)
  }

  private stopMic() {
    clearInterval(this.listenTick)
    this.listenTick = undefined
    this.stopBrowserMic?.()
    this.stopBrowserMic = undefined
    void this.g.mic(false)
  }

  private onPcm(pcm: Uint8Array) {
    if (this.screen.name !== 'listening') return
    const r = this.recorder.push(pcm)
    if (r === 'stop') void this.finishListening()
    else if (r === 'timeout') void this.cancelListening("Didn't hear anything.")
  }

  private async cancelListening(reason?: string) {
    const s = this.screen
    if (s.name !== 'listening') return
    this.stopMic()
    if (reason) await this.show({ name: 'info', title: 'Listening stopped', pages: [reason], page: 0, back: s.back, retry: true })
    else await this.goBack(s.back)
  }

  private async finishListening() {
    const s = this.screen
    if (s.name !== 'listening') return
    this.stopMic()
    if (!this.recorder.speechDetected) return this.cancelListening("Didn't hear anything.")
    const pcm = this.recorder.pcm()
    const token = await this.working(s.back, 'Transcribing…')
    try {
      const res = await this.api.voice(pcm)
      if (token !== this.workToken) return
      this.lastTranscript = res.transcript
      await this.handle(res.result, res.transcript, s.back)
    } catch (err) {
      if (token !== this.workToken) return
      if (err instanceof ApiError && ['silence', 'too_short'].includes(err.code)) {
        await this.show({ name: 'info', title: 'Listening stopped', pages: ["Didn't catch that."], page: 0, back: s.back, retry: true })
      } else await this.fail(err, s.back)
    }
  }

  // ── Input ─────────────────────────────────────────────────────────────
  private cycleFocus(dir: 1 | -1) {
    const coins = this.snap?.tickers.map(t => t.coin) ?? []
    if (coins.length < 2) return
    const i = Math.max(0, coins.indexOf(this.focus))
    this.focus = coins[(i + dir + coins.length) % coins.length]!
    void this.g.setText('body', homeBody(this.snap, this.focus))
    void this.api.saveSettings({ focus: this.focus }).catch(() => {})
  }

  private onInput(i: Input) {
    if (i.kind === 'exit') return this.dispose()
    if (i.kind === 'background') {
      if (this.screen.name === 'listening') void this.cancelListening()
      return
    }
    if (i.kind === 'foreground') {
      if (this.screen.name === 'home') void this.show({ name: 'home' })
      return
    }
    const s = this.screen
    switch (s.name) {
      case 'boot':
        return
      case 'setup':
        if (i.kind === 'tap') void this.boot()
        else if (i.kind === 'double') this.g.requestExit()
        return
      case 'home':
        if (i.kind === 'double') return this.g.requestExit()
        if (i.kind === 'tap') return void this.show({ name: 'positions' })
        if (i.kind === 'hold') return void this.startListening('home', true)
        if (i.kind === 'up') return this.cycleFocus(-1)
        if (i.kind === 'down') return this.cycleFocus(1)
        return
      case 'positions':
        if (i.kind === 'double') return void this.show({ name: 'home' })
        if (i.kind === 'hold') return void this.startListening('positions', true)
        if (i.kind === 'select') {
          const a = this.actions[i.index]
          if (!a) return
          if (a.act === 'position') return void this.show({ name: 'position', coin: a.coin })
          if (a.act === 'speak') return void this.startListening('positions', false)
          if (a.act === 'alerts') return void this.show({ name: 'alerts' })
          if (a.act === 'orders') return void this.show({ name: 'orders' })
          return void this.show({ name: 'home' })
        }
        return
      case 'position':
        if (i.kind === 'double') return void this.show({ name: 'positions' })
        if (i.kind === 'select') {
          const has = this.snap?.positions.some(p => p.coin === s.coin)
          if (!has || i.index === 2) return void this.show({ name: 'positions' })
          return void this.runText(i.index === 0 ? `close ${s.coin}` : `close half ${s.coin}`)
        }
        return
      case 'alerts':
        if (i.kind === 'double') return void this.show({ name: 'positions' })
        if (i.kind === 'select') return void this.onAlertSelect(i.index)
        return
      case 'orders':
        if (i.kind === 'double') return void this.show({ name: 'positions' })
        if (i.kind === 'select') {
          const n = this.snap?.orders.length ?? 0
          if (n && i.index === n) return void this.runText('cancel all orders')
          if (i.index >= n) return void this.show({ name: 'positions' })
        }
        return
      case 'listening':
        if (i.kind === 'double') return void this.cancelListening()
        if (i.kind === 'tap' || (i.kind === 'release' && s.viaHold)) return void this.finishListening()
        return
      case 'working':
        if (i.kind === 'double') {
          this.workToken++ // drop the in-flight result
          return void this.goBack(s.back)
        }
        return
      case 'confirm': {
        const cancel = async () => {
          void this.api.cancelPlan(s.plan.id).catch(() => {})
          await this.show({ name: 'info', title: 'Cancelled', pages: ['Nothing was sent.'], page: 0, back: s.back, auto: true })
          this.autoTimer = setTimeout(() => { if (this.screen.name === 'info' && this.screen.auto) void this.goBack(s.back) }, 1200)
        }
        if (i.kind === 'double') return void cancel()
        if (i.kind === 'select') {
          const confirmIndex = s.plan.danger ? 1 : 0
          return void (i.index === confirmIndex ? this.execute(s.plan, s.back) : cancel())
        }
        return
      }
      case 'info':
        if (i.kind === 'down' && s.page < s.pages.length - 1) return void this.show({ ...s, page: s.page + 1 })
        if (i.kind === 'up' && s.page > 0) return void this.show({ ...s, page: s.page - 1 })
        if (i.kind === 'hold' && s.retry) return void this.startListening(s.back, true)
        if (i.kind === 'tap' || i.kind === 'double') return void this.goBack(s.back)
        return
      case 'flash':
        if (i.kind === 'double') return void this.goBack('home')
        if (i.kind === 'select') {
          if (s.hasPosition && s.coin && i.index === 0) return void this.runText(`close ${s.coin}`)
          return void this.goBack('home')
        }
        return
    }
  }

  private async onAlertSelect(index: number) {
    const alerts = this.snap?.alerts ?? []
    const shown = alerts.slice(0, 16)
    if (index < shown.length) {
      const a = shown[index]!
      try {
        await this.api.removeAlert(a.id)
        if (this.snap) this.snap = { ...this.snap, alerts: this.snap.alerts.filter(x => x.id !== a.id) }
        return this.show({ name: 'alerts' })
      } catch (err) {
        return this.fail(err, 'positions')
      }
    }
    const rest = index - shown.length
    if (rest === 0) return this.startListening('positions', false)
    if (alerts.length && rest === 1) return this.runText('clear alerts')
    return this.show({ name: 'positions' })
  }
}

function signed(v: number) {
  return `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`
}

export function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
