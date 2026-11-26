import { randomUUID } from 'node:crypto'
import type { Store } from '../lib/store.js'
import type { PriceSource } from './prices.js'
import {
  type Account, coinOf, ExchangeError, type Exchange, type Fill, type Instrument, type OpenOrder,
  type OrderRequest, type Position, type Ticker, type Wallet,
} from './types.js'

export interface PaperData {
  /** Trading wallet cash (realised), USDT. */
  trading: number
  funding: number
  /** Signed size: + long, - short. */
  positions: Record<string, { size: number; entry: number }>
  orders: OpenOrder[]
  day: string
  dayStart: number
}

/** Some cash starts in the funding wallet so "move 500 from funding to trading" works out of the box. */
export const paperDefaults = (start: number, funding = 1000): PaperData => ({
  trading: start, funding, positions: {}, orders: [], day: '', dayStart: start + funding,
})

const today = () => new Date().toISOString().slice(0, 10)

/**
 * A simulated USDT-perp account on live public prices. Market orders fill at
 * the last price with a taker fee; limit orders fill when the price crosses.
 * Cross margin: free margin = cash + unrealised PnL - initial margin in use.
 */
export class PaperExchange implements Exchange {
  readonly mode = 'paper' as const
  /** Names the live price source, which can change after a failover. */
  get label() {
    return `Paper · ${this.opts.leverage}x · prices: ${this.prices.name}`
  }
  private readonly last = new Map<string, Ticker>()
  private readonly offsets = new Map<string, number>()

  constructor(
    private readonly store: Store<PaperData>,
    private readonly prices: PriceSource,
    private readonly opts: { leverage: number; feeBps: number },
  ) {
  }

  async start() {
    await this.rollDay()
  }
  async stop() {}

  private async rollDay() {
    const d = today()
    if (this.store.get().day === d) return
    const equity = await this.totalEquity().catch(() => this.store.get().trading + this.store.get().funding)
    await this.store.update(s => { s.day = d; s.dayStart = equity })
  }

  /** A live price, or an error: never a remembered one, so nothing fills at a stale price. */
  private async mark(symbol: string): Promise<Ticker> {
    const t = await this.prices.ticker(symbol)
    if (!t) throw new ExchangeError(`No price for ${coinOf(symbol)}`, 'no_price')
    const k = this.offsets.get(symbol) ?? 1
    const adj = { ...t, last: t.last * k }
    this.last.set(symbol, adj)
    return adj
  }

  nudge(symbol: string, pct: number) {
    this.offsets.set(symbol, (this.offsets.get(symbol) ?? 1) * (1 + pct / 100))
  }

  async tickers(symbols: string[]): Promise<Ticker[]> {
    const out = await Promise.allSettled(symbols.map(s => this.mark(s)))
    const ok = out.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []))
    // Unknown coins just drop out; a feed outage (every lookup failing) is reported.
    const outage = out.find(r => r.status === 'rejected' && !(r.reason instanceof ExchangeError && r.reason.code === 'no_price'))
    if (!ok.length && outage?.status === 'rejected') throw outage.reason
    await this.fillLimits()
    return ok
  }

  async positions(): Promise<Position[]> {
    const s = this.store.get()
    const out: Position[] = []
    for (const [symbol, p] of Object.entries(s.positions)) {
      if (!p.size) continue
      const mark = (await this.mark(symbol)).last
      const size = Math.abs(p.size)
      const upnl = (mark - p.entry) * p.size
      const margin = (size * p.entry) / this.opts.leverage
      out.push({
        symbol, coin: coinOf(symbol), side: p.size > 0 ? 'long' : 'short', size, entry: p.entry, mark,
        upnl, upnlPct: margin ? (upnl / margin) * 100 : 0, notional: size * mark,
      })
    }
    return out.sort((a, b) => b.notional - a.notional)
  }

  private async totalEquity() {
    const s = this.store.get()
    const upnl = (await this.positions()).reduce((n, p) => n + p.upnl, 0)
    return s.trading + s.funding + upnl
  }

  async account(): Promise<Account> {
    await this.rollDay()
    const s = this.store.get()
    const pos = await this.positions()
    const upnl = pos.reduce((n, p) => n + p.upnl, 0)
    const used = pos.reduce((n, p) => n + p.notional / this.opts.leverage, 0)
    const reserved = s.orders.filter(o => !o.reduceOnly).reduce((n, o) => n + (o.qty * o.price) / this.opts.leverage, 0)
    const equity = s.trading + upnl
    return { equity, available: Math.max(0, equity - used - reserved), upnl, funding: s.funding, dayPnl: equity + s.funding - s.dayStart }
  }

  async openOrders(): Promise<OpenOrder[]> {
    return this.store.get().orders.map(o => ({ ...o }))
  }

  async instrument(symbol: string): Promise<Instrument | null> {
    return this.prices.instrument(symbol)
  }

  async placeOrder(o: OrderRequest): Promise<Fill> {
    if (!(o.qty > 0)) throw new ExchangeError('Quantity must be positive', 'bad_qty')
    const t = await this.mark(o.symbol)
    const signed = o.side === 'buy' ? o.qty : -o.qty
    const cur = this.store.get().positions[o.symbol]?.size ?? 0
    if (o.reduceOnly && (cur === 0 || Math.sign(cur) === Math.sign(signed) || Math.abs(signed) > Math.abs(cur) + 1e-12)) {
      throw new ExchangeError('Reduce-only order would open or flip a position', 'reduce_only')
    }
    const price = o.price ?? t.last
    // Margin check on the part that adds exposure.
    const adds = Math.max(0, Math.abs(cur + signed) - Math.abs(cur))
    if (adds > 0) {
      const acct = await this.account()
      const need = (adds * price) / this.opts.leverage + adds * price * (this.opts.feeBps / 10_000)
      if (need > acct.available + 1e-9) {
        throw new ExchangeError(`Not enough margin: needs $${need.toFixed(2)}, $${acct.available.toFixed(2)} free`, 'insufficient_margin')
      }
    }
    const id = randomUUID()
    const crosses = o.price === undefined || (o.side === 'buy' ? t.last <= o.price : t.last >= o.price)
    if (!crosses) {
      await this.store.update(s => {
        s.orders.push({ id, symbol: o.symbol, coin: coinOf(o.symbol), side: o.side, qty: o.qty, price: o.price!, reduceOnly: Boolean(o.reduceOnly) })
      })
      return { orderId: id, symbol: o.symbol, side: o.side, qty: o.qty, price: o.price, status: 'open' }
    }
    // Market orders and marketable limits both fill at the current price (never worse than the limit).
    const fillPrice = t.last
    await this.store.update(s => this.apply(s, o.symbol, signed, fillPrice))
    return { orderId: id, symbol: o.symbol, side: o.side, qty: o.qty, price: fillPrice, status: 'filled' }
  }

  /** Book a fill into the account: realise PnL on the closed part, average the entry on the added part. */
  private apply(s: PaperData, symbol: string, signed: number, price: number) {
    const fee = Math.abs(signed) * price * (this.opts.feeBps / 10_000)
    const p = s.positions[symbol] ?? { size: 0, entry: 0 }
    const next = p.size + signed
    if (p.size !== 0 && Math.sign(signed) !== Math.sign(p.size)) {
      const closed = Math.min(Math.abs(signed), Math.abs(p.size))
      s.trading += (price - p.entry) * closed * Math.sign(p.size)
    }
    let entry = p.entry
    if (Math.abs(next) < 1e-12) entry = 0
    else if (p.size === 0 || Math.sign(next) !== Math.sign(p.size)) entry = price // opened or flipped
    else if (Math.abs(next) > Math.abs(p.size)) entry = (p.entry * Math.abs(p.size) + price * Math.abs(signed)) / Math.abs(next)
    s.trading -= fee
    if (Math.abs(next) < 1e-12) delete s.positions[symbol]
    else s.positions[symbol] = { size: next, entry }
  }

  private async fillLimits() {
    const orders = this.store.get().orders
    if (!orders.length) return
    const filled: Array<{ o: OpenOrder; price: number }> = []
    for (const o of orders) {
      const t = this.last.get(o.symbol)
      if (!t) continue
      if (o.side === 'buy' ? t.last <= o.price : t.last >= o.price) filled.push({ o, price: o.price })
    }
    if (!filled.length) return
    await this.store.update(s => {
      for (const { o, price } of filled) {
        const cur = s.positions[o.symbol]?.size ?? 0
        let signed = o.side === 'buy' ? o.qty : -o.qty
        if (o.reduceOnly) {
          if (cur === 0 || Math.sign(cur) === Math.sign(signed)) continue
          signed = Math.sign(signed) * Math.min(Math.abs(signed), Math.abs(cur))
        }
        this.apply(s, o.symbol, signed, price)
      }
      const ids = new Set(filled.map(f => f.o.id))
      s.orders = s.orders.filter(o => !ids.has(o.id))
    })
  }

  async cancelAll(): Promise<number> {
    const n = this.store.get().orders.length
    await this.store.update(s => { s.orders = [] })
    return n
  }

  async transfer(amount: number, from: Wallet, to: Wallet): Promise<{ id: string }> {
    if (from === to) throw new ExchangeError('Pick two different wallets', 'bad_transfer')
    if (!(amount > 0)) throw new ExchangeError('Amount must be positive', 'bad_transfer')
    if (from === 'funding' && amount > this.store.get().funding + 1e-9) {
      throw new ExchangeError(`Funding wallet has only $${this.store.get().funding.toFixed(2)}`, 'insufficient_balance')
    }
    if (from === 'trading') {
      const acct = await this.account()
      const free = Math.min(acct.available, this.store.get().trading)
      if (amount > free + 1e-9) throw new ExchangeError(`Only $${free.toFixed(2)} can leave the trading account`, 'insufficient_balance')
    }
    await this.store.update(s => {
      if (from === 'funding') { s.funding -= amount; s.trading += amount } else { s.trading -= amount; s.funding += amount }
    })
    return { id: randomUUID() }
  }
}
