import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { type Intent, parse } from './commands.js'
import { HttpError } from './lib/errors.js'
import type { Logger } from './lib/logger.js'
import type { Store } from './lib/store.js'
import { unref } from './lib/timers.js'
import {
  type Account, ExchangeError, type Exchange, floorStep, type OpenOrder, type Position, roundStep,
  type Side, symbolOf, type Ticker, type Wallet,
} from './exchange/types.js'

export interface Alert {
  id: string
  target: 'price' | 'pnl'
  coin?: string
  op: 'above' | 'below'
  value: number
  createdAt: number
}

export interface DeskSettings {
  watchlist: string[]
  focus: string
  /** View and alerts only; trades and transfers are refused. */
  readOnly: boolean
  /** Per-order cap chosen by the user, never above the server's MAX_ORDER_USD. */
  maxOrderUsd: number
}

export interface DeskData {
  settings: DeskSettings
  alerts: Alert[]
}

export interface Snapshot {
  at: number
  mode: Exchange['mode']
  account: Account | null
  positions: Position[]
  tickers: Ticker[]
  orders: OpenOrder[]
  alerts: Alert[]
  settings: DeskSettings
  /** Set when the last refresh failed; the rest is the last good data. */
  error?: string
}

export type PlanKind = 'order' | 'close' | 'close_all' | 'cancel_orders' | 'transfer'

export interface Plan {
  id: string
  kind: PlanKind
  /** Short header for the glasses. */
  title: string
  /** Up to ~4 short lines. */
  body: string
  confirm: string
  cancel: string
  /** Irreversible and large: the glasses put "Cancel" first so a stray tap does nothing. */
  danger: boolean
  expiresAt: number
}

interface StoredPlan extends Plan {
  run: () => Promise<{ title: string; body: string }>
}

export type CommandResult =
  | { type: 'confirm'; plan: Plan }
  | { type: 'info'; title: string; body: string }
  | { type: 'clarify'; body: string }

export type DeskEvent =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'alert'; alert: Alert; title: string; body: string; coin?: string; hasPosition: boolean }
  | { type: 'fill'; title: string; body: string }
  /** The desk was unloaded (idle, exchange changed, account deleted): streams should end so clients reconnect. */
  | { type: 'closed' }

export interface DeskOptions {
  maxOrderUsd: number
  planTtlMs: number
  pollMs: number
}

const EXAMPLES = 'Try: "buy 0.01 BTC" · "short $500 of ETH"\n"close half my SOL" · "close everything"\n"alert if BTC drops below 90k"\n"move 500 from funding to trading"'

export function fmtUsd(v: number, sign = false): string {
  const abs = Math.abs(v)
  const s = abs >= 100_000 ? abs.toLocaleString('en-US', { maximumFractionDigits: 0 }) : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${v < 0 ? '-' : sign ? '+' : ''}$${s}`
}

export function fmtPrice(v: number): string {
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 })
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 3 })
  return v.toPrecision(4)
}

export function fmtQty(v: number): string {
  return Number(v.toPrecision(8)).toString()
}

/**
 * The trading desk: keeps a live snapshot (account, positions, prices),
 * checks alerts on every refresh, turns commands into confirm cards and runs
 * them only after the user confirms, with the same safety checks again.
 */
export class Desk {
  private readonly events = new EventEmitter()
  private readonly plans = new Map<string, StoredPlan>()
  private snap: Snapshot
  private timer?: ReturnType<typeof setTimeout>
  private refreshing?: Promise<Snapshot>
  private queued?: Promise<Snapshot>
  private stopped = false

  constructor(
    readonly exchange: Exchange,
    private readonly store: Store<DeskData>,
    private readonly opts: DeskOptions,
    private readonly log?: Logger,
  ) {
    this.events.setMaxListeners(50)
    this.snap = { at: 0, mode: exchange.mode, account: null, positions: [], tickers: [], orders: [], alerts: [], settings: this.settings }
  }

  get settings(): DeskSettings {
    return { ...this.store.get().settings }
  }

  get snapshot(): Snapshot {
    return this.snap
  }

  subscribe(fn: (e: DeskEvent) => void): () => void {
    this.events.on('event', fn)
    return () => this.events.off('event', fn)
  }

  private emit(e: DeskEvent) {
    this.events.emit('event', e)
  }

  async start() {
    await this.refresh()
    this.loop()
  }

  private loop() {
    if (this.stopped) return
    this.timer = unref(setTimeout(() => {
      void this.refresh().finally(() => this.loop())
    }, this.opts.pollMs))
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.emit({ type: 'closed' })
    this.events.removeAllListeners()
  }

  /**
   * One refresh at a time. A caller that arrives mid-refresh gets the next
   * one (shared by everyone who waits), so it always sees its own changes.
   */
  refresh(): Promise<Snapshot> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => { this.refreshing = undefined })
      return this.refreshing
    }
    this.queued ??= this.refreshing.then(() => { this.queued = undefined; return this.refresh() })
    return this.queued
  }

  private async doRefresh(): Promise<Snapshot> {
    const s = this.settings
    try {
      const [account, positions, orders] = await Promise.all([this.exchange.account(), this.exchange.positions(), this.exchange.openOrders()])
      const symbols = [...new Set([s.focus, ...s.watchlist, ...positions.map(p => p.coin)].map(symbolOf))]
      const tickers = await this.exchange.tickers(symbols)
      this.snap = { at: Date.now(), mode: this.exchange.mode, account, positions, tickers, orders, alerts: [...this.store.get().alerts], settings: s }
    } catch (err) {
      this.log?.warn({ err: (err as Error).message }, 'refresh failed')
      this.snap = { ...this.snap, at: Date.now(), settings: s, alerts: [...this.store.get().alerts], error: (err as Error).message }
    }
    await this.checkAlerts(this.snap)
    this.emit({ type: 'snapshot', snapshot: this.snap })
    return this.snap
  }

  private price(coin: string): number | undefined {
    return this.snap.tickers.find(t => t.coin === coin)?.last ?? this.snap.positions.find(p => p.coin === coin)?.mark
  }

  private async checkAlerts(snap: Snapshot) {
    const alerts = this.store.get().alerts
    if (!alerts.length || snap.error) return
    const fired: Alert[] = []
    for (const a of alerts) {
      const v = a.target === 'pnl' ? snap.account?.dayPnl : a.coin ? this.price(a.coin) : undefined
      if (v === undefined) continue
      if (a.op === 'above' ? v >= a.value : v <= a.value) fired.push(a)
    }
    if (!fired.length) return
    const ids = new Set(fired.map(a => a.id))
    await this.store.update(d => { d.alerts = d.alerts.filter(a => !ids.has(a.id)) })
    snap.alerts = [...this.store.get().alerts]
    for (const a of fired) {
      const now = a.target === 'pnl' ? fmtUsd(snap.account!.dayPnl, true) : fmtPrice(this.price(a.coin!)!)
      const what = a.target === 'pnl' ? 'PnL today' : a.coin!
      const level = a.target === 'pnl' ? fmtUsd(a.value, true) : fmtPrice(a.value)
      const pos = a.coin ? snap.positions.find(p => p.coin === a.coin) : undefined
      const body = pos
        ? `Now ${now}\nYour ${pos.side.toUpperCase()} ${fmtQty(pos.size)} ${pos.coin}: ${fmtUsd(pos.upnl, true)}`
        : `Now ${now}`
      this.log?.info({ alert: a.id, what, level, now }, 'alert fired')
      this.emit({ type: 'alert', alert: a, title: `${what} ${a.op} ${level}`, body, ...(a.coin ? { coin: a.coin } : {}), hasPosition: Boolean(pos) })
    }
  }

  // ── Settings & alerts ──────────────────────────────────────────────────
  async updateSettings(patch: Partial<DeskSettings>): Promise<DeskSettings> {
    await this.store.update(d => {
      if (patch.watchlist) d.settings.watchlist = [...new Set(patch.watchlist.map(c => c.trim().toUpperCase()).filter(c => /^[A-Z0-9]{2,10}$/.test(c)))].slice(0, 8)
      if (patch.focus && /^[A-Z0-9]{2,10}$/i.test(patch.focus)) d.settings.focus = patch.focus.toUpperCase()
      if (typeof patch.readOnly === 'boolean') d.settings.readOnly = patch.readOnly
      if (typeof patch.maxOrderUsd === 'number' && patch.maxOrderUsd > 0) d.settings.maxOrderUsd = Math.min(patch.maxOrderUsd, this.opts.maxOrderUsd)
    })
    void this.refresh()
    return this.settings
  }

  async addAlert(a: Omit<Alert, 'id' | 'createdAt'>): Promise<Alert> {
    if (this.store.get().alerts.length >= 20) throw new HttpError(400, 'You already have 20 alerts. Clear some first.', 'too_many_alerts')
    const alert: Alert = { ...a, id: randomUUID().slice(0, 8), createdAt: Date.now() }
    await this.store.update(d => { d.alerts.push(alert) })
    this.snap = { ...this.snap, alerts: [...this.store.get().alerts] }
    return alert
  }

  async removeAlert(id: string): Promise<boolean> {
    const before = this.store.get().alerts.length
    await this.store.update(d => { d.alerts = d.alerts.filter(a => a.id !== id) })
    this.snap = { ...this.snap, alerts: [...this.store.get().alerts] }
    return this.store.get().alerts.length < before
  }

  // ── Commands ───────────────────────────────────────────────────────────
  async command(text: string): Promise<CommandResult> {
    const intent = parse(text)
    try {
      return await this.plan(intent)
    } catch (err) {
      if (err instanceof ExchangeError) return { type: 'info', title: 'Exchange error', body: err.message }
      throw err
    }
  }

  private trading(): string | null {
    if (this.settings.readOnly) return 'Trading is off (read-only).\nTurn it on in the Tape phone app.'
    return null
  }

  private makePlan(p: Omit<Plan, 'id' | 'expiresAt'>, run: StoredPlan['run']): CommandResult {
    // Only the newest card is live: an old one on another screen can't fire.
    this.plans.clear()
    const plan: StoredPlan = { ...p, id: randomUUID(), expiresAt: Date.now() + this.opts.planTtlMs, run }
    this.plans.set(plan.id, plan)
    const { run: _run, ...pub } = plan
    return { type: 'confirm', plan: pub }
  }

  async plan(intent: Intent): Promise<CommandResult> {
    const snap = this.snap.at && Date.now() - this.snap.at < 10_000 ? this.snap : await this.refresh()
    switch (intent.kind) {
      case 'unknown':
        return { type: 'clarify', body: intent.reason ?? EXAMPLES }
      case 'portfolio':
        return { type: 'info', title: 'Portfolio', body: portfolioText(snap) }
      case 'orders':
        return { type: 'info', title: `Open orders (${snap.orders.length})`, body: snap.orders.length ? snap.orders.slice(0, 6).map(o => `${o.side.toUpperCase()} ${fmtQty(o.qty)} ${o.coin} @ ${fmtPrice(o.price)}${o.reduceOnly ? ' (reduce)' : ''}`).join('\n') : 'No open orders.' }
      case 'alerts':
        return { type: 'info', title: `Alerts (${snap.alerts.length})`, body: snap.alerts.length ? snap.alerts.map(alertText).join('\n') : 'No alerts set.\nSay "alert if BTC drops below 90k".' }
      case 'price': {
        const t = await this.ticker(intent.coin)
        if (!t) return { type: 'info', title: intent.coin, body: `No ${intent.coin} perpetual found.` }
        const pos = snap.positions.find(p => p.coin === intent.coin)
        return { type: 'info', title: `${t.coin} ${fmtPrice(t.last)}`, body: `${t.change24hPct >= 0 ? '+' : ''}${t.change24hPct.toFixed(2)}% in 24h${pos ? `\nYour ${pos.side.toUpperCase()} ${fmtQty(pos.size)}: ${fmtUsd(pos.upnl, true)}` : ''}` }
      }
      case 'focus': {
        const t = await this.ticker(intent.coin)
        if (!t) return { type: 'info', title: intent.coin, body: `No ${intent.coin} perpetual found.` }
        await this.updateSettings({ focus: intent.coin })
        return { type: 'info', title: `Watching ${intent.coin}`, body: `${intent.coin} is now on your home screen.` }
      }
      case 'clear_alerts': {
        const n = this.store.get().alerts.length
        await this.store.update(d => { d.alerts = [] })
        this.snap = { ...this.snap, alerts: [] }
        return { type: 'info', title: 'Alerts cleared', body: n ? `Removed ${n} alert${n === 1 ? '' : 's'}.` : 'There were no alerts.' }
      }
      case 'alert': {
        if (intent.target === 'pnl') {
          const a = await this.addAlert({ target: 'pnl', op: intent.op, value: intent.value })
          return { type: 'info', title: 'Alert set', body: `${alertText(a)}\nNow ${fmtUsd(snap.account?.dayPnl ?? 0, true)} today` }
        }
        const t = await this.ticker(intent.coin)
        if (!t) return { type: 'info', title: intent.coin, body: `No ${intent.coin} perpetual found.` }
        const value = intent.relativePct !== undefined ? t.last * (1 + intent.relativePct / 100) : intent.value
        const op = intent.op ?? (value >= t.last ? 'above' : 'below')
        if (op === 'below' ? t.last <= value : t.last >= value) {
          return { type: 'clarify', body: `${t.coin} is already ${op} ${fmtPrice(value)} (now ${fmtPrice(t.last)}).` }
        }
        const a = await this.addAlert({ target: 'price', coin: t.coin, op, value: Number(value.toPrecision(6)) })
        return { type: 'info', title: 'Alert set', body: `${alertText(a)}\nNow ${fmtPrice(t.last)}` }
      }
      case 'order':
        return this.planOrder(intent, snap)
      case 'close':
        return this.planClose(intent.coin, intent.fraction, snap)
      case 'close_all':
        return this.planCloseAll(snap)
      case 'cancel_orders': {
        const off = this.trading()
        if (off) return { type: 'info', title: 'Read-only', body: off }
        if (!snap.orders.length) return { type: 'info', title: 'No open orders', body: 'Nothing to cancel.' }
        return this.makePlan(
          { kind: 'cancel_orders', title: `Cancel ${snap.orders.length} order${snap.orders.length === 1 ? '' : 's'}?`, body: snap.orders.slice(0, 4).map(o => `${o.side.toUpperCase()} ${fmtQty(o.qty)} ${o.coin} @ ${fmtPrice(o.price)}`).join('\n'), confirm: 'Cancel orders', cancel: 'Keep them', danger: false },
          async () => {
            const n = await this.exchange.cancelAll()
            return { title: 'Orders cancelled', body: `${n || snap.orders.length} cancelled.` }
          },
        )
      }
      case 'transfer':
        return this.planTransfer(intent.amount, intent.from, intent.to, snap)
    }
  }

  private async ticker(coin: string): Promise<Ticker | null> {
    const known = this.snap.tickers.find(t => t.coin === coin)
    if (known) return known
    const [t] = await this.exchange.tickers([symbolOf(coin)])
    return t ?? null
  }

  private cap() {
    return Math.min(this.settings.maxOrderUsd, this.opts.maxOrderUsd)
  }

  /** Trading needs a live view: refuse while the exchange or prices can't be reached. */
  private stale(snap: Snapshot): CommandResult | null {
    if (snap.error || !snap.account) return { type: 'info', title: 'No live data', body: `${snap.error ?? 'Still connecting.'}\nTrading is paused until it is back.` }
    return null
  }

  private async planOrder(i: Extract<Intent, { kind: 'order' }>, snap: Snapshot): Promise<CommandResult> {
    const off = this.trading()
    if (off) return { type: 'info', title: 'Read-only', body: off }
    const stale = this.stale(snap)
    if (stale) return stale
    const symbol = symbolOf(i.coin)
    const [t, inst] = await Promise.all([this.ticker(i.coin), this.exchange.instrument(symbol)])
    if (!t || !inst) return { type: 'info', title: i.coin, body: `No ${i.coin} perpetual on ${this.exchange.mode === 'paper' ? 'the price feed' : 'Bybit'}.` }
    const price = i.price !== undefined ? roundStep(i.price, inst.tickSize) : undefined
    const ref = price ?? t.last
    const rawQty = i.qty ?? (i.usd ?? 0) / ref
    const qty = floorStep(rawQty, inst.qtyStep)
    if (!(qty >= inst.minQty) || qty <= 0) {
      return { type: 'clarify', body: `Too small: minimum is ${fmtQty(inst.minQty)} ${i.coin}${i.usd ? ` (about ${fmtUsd(inst.minQty * ref)})` : ''}.` }
    }
    const notional = qty * ref
    if (notional < inst.minNotional) return { type: 'clarify', body: `Too small: orders must be at least ${fmtUsd(inst.minNotional)}.` }
    const cap = this.cap()
    if (notional > cap) {
      return { type: 'clarify', body: `That's ${fmtUsd(notional)}, over your ${fmtUsd(cap)} per-order limit.\nSay a smaller size.` }
    }
    if (price !== undefined) {
      const away = Math.abs(price - t.last) / t.last
      if (away > 0.25) return { type: 'clarify', body: `${fmtPrice(price)} is ${(away * 100).toFixed(0)}% from the market (${fmtPrice(t.last)}).\nCheck the price and say it again.` }
    }
    const pos = snap.positions.find(p => p.coin === i.coin)
    const verb = i.side === 'buy' ? 'BUY' : 'SELL'
    const effect = !pos
      ? i.side === 'buy' ? 'Opens a LONG' : 'Opens a SHORT'
      : (pos.side === 'long') === (i.side === 'buy') ? `Adds to your ${pos.side.toUpperCase()} ${fmtQty(pos.size)}`
        : qty < pos.size - 1e-12 ? `Reduces your ${pos.side.toUpperCase()} ${fmtQty(pos.size)}`
          : qty > pos.size + 1e-12 ? `Flips your ${pos.side.toUpperCase()} to ${pos.side === 'long' ? 'SHORT' : 'LONG'}` : `Closes your ${pos.side.toUpperCase()}`
    const how = price !== undefined ? `Limit @ ${fmtPrice(price)} (now ${fmtPrice(t.last)})` : `Market · now ${fmtPrice(t.last)}`
    const side: Side = i.side
    return this.makePlan(
      {
        kind: 'order',
        title: `${verb} ${fmtQty(qty)} ${i.coin} · ${fmtUsd(notional)}`,
        body: `${how}\n${effect}`,
        confirm: `${i.side === 'buy' ? 'Buy' : 'Sell'} ${fmtQty(qty)} ${i.coin}`,
        cancel: 'Cancel',
        danger: false,
      },
      async () => {
        // Re-check against a fresh price from the exchange, never the cached snapshot.
        const [fresh] = await this.exchange.tickers([symbol])
        if (price === undefined && !fresh) throw new HttpError(503, `No live ${i.coin} price right now. Nothing was sent.`, 'no_price')
        if (price === undefined && fresh && Math.abs(fresh.last - t.last) / t.last > 0.01) {
          throw new HttpError(409, `${i.coin} moved over 1% since the card (${fmtPrice(t.last)} → ${fmtPrice(fresh.last)}). Ask again.`, 'price_moved')
        }
        const fill = await this.exchange.placeOrder({ symbol, side, qty, ...(price !== undefined ? { price } : {}) })
        return fill.status === 'filled'
          ? { title: `${verb} ${fmtQty(qty)} ${i.coin} done`, body: fill.price ? `Filled @ ${fmtPrice(fill.price)}` : 'Market order sent.' }
          : { title: 'Limit order placed', body: `${verb} ${fmtQty(qty)} ${i.coin} @ ${fmtPrice(price ?? 0)}` }
      },
    )
  }

  /** Closing is never blocked by stale data: a reduce-only exit can only lower risk. */
  private async planClose(coin: string, fraction: number, snap: Snapshot): Promise<CommandResult> {
    const off = this.trading()
    if (off) return { type: 'info', title: 'Read-only', body: off }
    const pos = snap.positions.find(p => p.coin === coin)
    if (!pos) return { type: 'info', title: `No ${coin} position`, body: snap.positions.length ? `Open: ${snap.positions.map(p => p.coin).join(', ')}` : 'You have no open positions.' }
    const inst = await this.exchange.instrument(pos.symbol)
    const step = inst?.qtyStep ?? 0
    const qty = fraction >= 0.999 ? pos.size : floorStep(pos.size * fraction, step)
    if (!(qty > 0) || (inst && qty < inst.minQty)) return { type: 'clarify', body: `That part is below the minimum size (${fmtQty(inst?.minQty ?? 0)} ${coin}).` }
    const share = qty / pos.size
    const side: Side = pos.side === 'long' ? 'sell' : 'buy'
    const label = fraction >= 0.999 ? 'Close' : `Close ${Math.round(share * 100)}% of`
    return this.makePlan(
      {
        kind: 'close',
        title: `${label} ${pos.side.toUpperCase()} ${coin}?`,
        body: `${fmtQty(qty)} of ${fmtQty(pos.size)} ${coin} @ market ~${fmtPrice(pos.mark)}\nLocks in about ${fmtUsd(pos.upnl * share, true)}`,
        confirm: fraction >= 0.999 ? `Close ${coin}` : `Close ${fmtQty(qty)} ${coin}`,
        cancel: 'Keep it',
        danger: false,
      },
      async () => {
        const fill = await this.exchange.placeOrder({ symbol: pos.symbol, side, qty, reduceOnly: true })
        return { title: `${coin} ${fraction >= 0.999 ? 'closed' : 'reduced'}`, body: fill.price ? `${fmtQty(qty)} ${coin} @ ${fmtPrice(fill.price)}` : `${fmtQty(qty)} ${coin} at market.` }
      },
    )
  }

  private planCloseAll(snap: Snapshot): CommandResult {
    const off = this.trading()
    if (off) return { type: 'info', title: 'Read-only', body: off }
    if (!snap.positions.length) return { type: 'info', title: 'Nothing to close', body: 'You have no open positions.' }
    const total = snap.positions.reduce((n, p) => n + p.upnl, 0)
    const positions = [...snap.positions]
    return this.makePlan(
      {
        kind: 'close_all',
        title: `Close ALL ${positions.length} position${positions.length === 1 ? '' : 's'}?`,
        body: `${positions.slice(0, 3).map(p => `${p.side.toUpperCase()} ${fmtQty(p.size)} ${p.coin} ${fmtUsd(p.upnl, true)}`).join('\n')}${positions.length > 3 ? `\n+${positions.length - 3} more` : ''}\nTotal ${fmtUsd(total, true)} · market orders`,
        confirm: 'Close all',
        cancel: 'Cancel',
        danger: true,
      },
      async () => {
        const results = await Promise.allSettled(positions.map(p => this.exchange.placeOrder({ symbol: p.symbol, side: p.side === 'long' ? 'sell' : 'buy', qty: p.size, reduceOnly: true })))
        const failed = results.flatMap((r, k) => (r.status === 'rejected' ? [`${positions[k]!.coin}: ${(r.reason as Error).message}`] : []))
        const ok = results.length - failed.length
        return { title: failed.length ? `Closed ${ok} of ${results.length}` : 'All positions closed', body: failed.length ? failed.join('\n') : `${ok} market order${ok === 1 ? '' : 's'} sent.` }
      },
    )
  }

  private planTransfer(amount: number, from: Wallet, to: Wallet, snap: Snapshot): CommandResult {
    const off = this.trading()
    if (off) return { type: 'info', title: 'Read-only', body: off }
    const stale = this.stale(snap)
    if (stale) return stale
    const cap = this.cap()
    if (amount > cap) return { type: 'clarify', body: `${fmtUsd(amount)} is over your ${fmtUsd(cap)} limit.` }
    const name = (w: Wallet) => (w === 'funding' ? 'Funding' : 'Trading')
    const have = from === 'funding' ? snap.account?.funding : snap.account?.available
    return this.makePlan(
      {
        kind: 'transfer',
        title: `Move ${fmtUsd(amount)} ${name(from)} → ${name(to)}?`,
        body: `USDT, instant, no fee${have !== undefined ? `\n${name(from)} has ${fmtUsd(have)}${from === 'trading' ? ' free' : ''}` : ''}`,
        confirm: `Move ${fmtUsd(amount)}`,
        cancel: 'Cancel',
        danger: false,
      },
      async () => {
        await this.exchange.transfer(amount, from, to)
        return { title: 'Transfer done', body: `${fmtUsd(amount)} moved to ${name(to)}.` }
      },
    )
  }

  /** Runs a confirmed plan exactly once. Expired or unknown plans are refused. */
  async execute(id: string): Promise<{ title: string; body: string }> {
    const plan = this.plans.get(id)
    if (!plan) throw new HttpError(404, 'This confirmation is no longer valid. Ask again.', 'plan_gone')
    this.plans.delete(id)
    if (Date.now() > plan.expiresAt) throw new HttpError(410, `Confirmation expired after ${Math.round(this.opts.planTtlMs / 1000)}s. Prices move: ask again.`, 'plan_expired')
    if (this.settings.readOnly) throw new HttpError(403, 'Trading was turned off.', 'read_only')
    try {
      const res = await plan.run()
      this.log?.info({ kind: plan.kind, title: plan.title }, 'plan executed')
      this.emit({ type: 'fill', ...res })
      void this.refresh()
      return res
    } catch (err) {
      if (err instanceof ExchangeError) throw new HttpError(502, err.message, err.code)
      throw err
    }
  }

  cancelPlan(id: string) {
    this.plans.delete(id)
  }
}

export function alertText(a: Alert): string {
  return a.target === 'pnl' ? `PnL today ${a.op} ${fmtUsd(a.value, true)}` : `${a.coin} ${a.op} ${fmtPrice(a.value)}`
}

export function portfolioText(s: Snapshot): string {
  const a = s.account
  if (!a) return s.error ?? 'Loading…'
  const lines = [
    `Equity ${fmtUsd(a.equity)} · free ${fmtUsd(a.available)}`,
    `Today ${fmtUsd(a.dayPnl, true)} · open ${fmtUsd(a.upnl, true)}`,
  ]
  if (a.funding > 0) lines.push(`Funding wallet ${fmtUsd(a.funding)}`)
  for (const p of s.positions.slice(0, 4)) lines.push(`${p.side.toUpperCase()} ${fmtQty(p.size)} ${p.coin} @ ${fmtPrice(p.entry)} ${fmtUsd(p.upnl, true)}`)
  if (!s.positions.length) lines.push('No open positions.')
  return lines.join('\n')
}
