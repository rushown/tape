import { fetchRetry } from '../lib/http.js'
import { coinOf, type Instrument, type Ticker } from './types.js'

/** Rough reference prices so the simulated feed starts somewhere believable when offline. */
const SEED: Record<string, number> = {
  BTCUSDT: 91_000, ETHUSDT: 3_100, SOLUSDT: 140, TONUSDT: 5.2, BNBUSDT: 610, XRPUSDT: 2.1, DOGEUSDT: 0.17,
  ADAUSDT: 0.65, AVAXUSDT: 24, LINKUSDT: 15, SUIUSDT: 3.4, LTCUSDT: 95, DOTUSDT: 4.5, NEARUSDT: 3.1,
  HYPEUSDT: 30, ARBUSDT: 0.45, OPUSDT: 0.8, APTUSDT: 6, TRXUSDT: 0.27, PEPEUSDT: 0.00001,
}

/** Lot sizes used when the public instruments endpoint is unreachable (match Bybit's linear perps). */
const LOTS: Record<string, [qtyStep: number, tick: number]> = {
  BTCUSDT: [0.001, 0.1], ETHUSDT: [0.01, 0.01], SOLUSDT: [0.1, 0.01], TONUSDT: [0.1, 0.0001], BNBUSDT: [0.01, 0.01],
  XRPUSDT: [1, 0.0001], DOGEUSDT: [1, 0.00001], ADAUSDT: [1, 0.0001], AVAXUSDT: [0.1, 0.001], LINKUSDT: [0.1, 0.001],
  SUIUSDT: [1, 0.0001], LTCUSDT: [0.1, 0.01], DOTUSDT: [0.1, 0.001], NEARUSDT: [0.1, 0.001], HYPEUSDT: [0.01, 0.001],
  ARBUSDT: [0.1, 0.0001], OPUSDT: [0.1, 0.0001], APTUSDT: [0.01, 0.0001], TRXUSDT: [1, 0.00001], PEPEUSDT: [100, 0.0000001],
}

/** Per-request budget for a public price API; a dead source must not stall the glasses. */
const TIMEOUT_MS = 3500

export interface PriceSource {
  readonly name: string
  ticker(symbol: string): Promise<Ticker | null>
  instrument(symbol: string): Promise<Instrument | null>
}

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

/** Bybit's public market endpoints: no key, read-only. */
export class BybitPublic implements PriceSource {
  readonly name: string
  constructor(private readonly base = 'https://api.bybit.com', name = 'Bybit') {
    this.name = name
  }
  async ticker(symbol: string): Promise<Ticker | null> {
    const res = await fetchRetry(`${this.base}/v5/market/tickers?category=linear&symbol=${symbol}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`${this.name} HTTP ${res.status}`)
    const j = (await res.json()) as { retCode: number; result?: { list?: Array<{ symbol: string; lastPrice: string; price24hPcnt: string }> } }
    const t = j.retCode === 0 ? j.result?.list?.[0] : undefined
    if (!t) return null
    const last = num(t.lastPrice)
    if (!(last > 0)) return null
    return { symbol, coin: coinOf(symbol), last, change24hPct: num(t.price24hPcnt) * 100 || 0 }
  }
  async instrument(symbol: string): Promise<Instrument | null> {
    const res = await fetchRetry(`${this.base}/v5/market/instruments-info?category=linear&symbol=${symbol}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`${this.name} HTTP ${res.status}`)
    const j = (await res.json()) as {
      retCode: number
      result?: { list?: Array<{ status: string; lotSizeFilter: { qtyStep: string; minOrderQty: string; minNotionalValue?: string }; priceFilter: { tickSize: string } }> }
    }
    const i = j.retCode === 0 ? j.result?.list?.[0] : undefined
    if (!i || i.status !== 'Trading') return null
    return {
      symbol,
      qtyStep: num(i.lotSizeFilter.qtyStep),
      minQty: num(i.lotSizeFilter.minOrderQty),
      minNotional: num(i.lotSizeFilter.minNotionalValue ?? '5') || 5,
      tickSize: num(i.priceFilter.tickSize),
    }
  }
}

/** Binance USD-M futures public endpoints, used when Bybit is blocked from the server's region. */
export class BinancePublic implements PriceSource {
  readonly name = 'Binance'
  async ticker(symbol: string): Promise<Ticker | null> {
    const res = await fetchRetry(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (res.status === 400) return null // unknown symbol
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`)
    const t = (await res.json()) as { lastPrice: string; priceChangePercent: string }
    const last = num(t.lastPrice)
    if (!(last > 0)) return null
    return { symbol, coin: coinOf(symbol), last, change24hPct: num(t.priceChangePercent) || 0 }
  }
  async instrument(symbol: string): Promise<Instrument | null> {
    return fallbackInstrument(symbol)
  }
}

/** OKX public swap tickers: a third independent real-price source. */
export class OkxPublic implements PriceSource {
  readonly name = 'OKX'
  async ticker(symbol: string): Promise<Ticker | null> {
    const inst = `${coinOf(symbol)}-USDT-SWAP`
    const res = await fetchRetry(`https://www.okx.com/api/v5/market/ticker?instId=${inst}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`OKX HTTP ${res.status}`)
    const j = (await res.json()) as { code: string; data?: Array<{ last: string; open24h: string }> }
    const t = j.code === '0' ? j.data?.[0] : undefined
    if (!t) return null
    const last = num(t.last)
    const open = num(t.open24h)
    if (!(last > 0)) return null
    return { symbol, coin: coinOf(symbol), last, change24hPct: open > 0 ? ((last - open) / open) * 100 : 0 }
  }
  async instrument(symbol: string): Promise<Instrument | null> {
    return fallbackInstrument(symbol)
  }
}

export function fallbackInstrument(symbol: string): Instrument | null {
  const lot = LOTS[symbol]
  const seed = SEED[symbol]
  if (!lot && !seed) return null
  const [qtyStep, tickSize] = lot ?? [seed! > 100 ? 0.01 : 1, seed! > 100 ? 0.01 : 0.0001]
  return { symbol, qtyStep, minQty: qtyStep, minNotional: 5, tickSize }
}

/** Offline random walk around SEED prices; also what tests use. */
export class SyntheticPrices implements PriceSource {
  readonly name = 'simulated'
  private readonly prices = new Map<string, { last: number; open: number }>()
  constructor(private readonly volatility = 0.0008, private readonly rand: () => number = Math.random) {}
  async ticker(symbol: string): Promise<Ticker | null> {
    const seed = SEED[symbol]
    if (!seed) return null
    let p = this.prices.get(symbol)
    if (!p) {
      p = { last: seed, open: seed * (1 + (this.rand() - 0.5) * 0.04) }
      this.prices.set(symbol, p)
    } else {
      p.last *= 1 + (this.rand() - 0.5) * 2 * this.volatility
    }
    return { symbol, coin: coinOf(symbol), last: p.last, change24hPct: ((p.last - p.open) / p.open) * 100 }
  }
  async instrument(symbol: string): Promise<Instrument | null> {
    return fallbackInstrument(symbol)
  }
}

/**
 * Tries each source in order and sticks with the first that answers, so one
 * blocked region or outage never leaves the glasses without prices. Never
 * invents prices: if every real source is down, it says so.
 */
export class PriceFeed implements PriceSource {
  private active = 0
  /** A source that just failed is skipped until this time, so every request doesn't re-wait on it. */
  private readonly downUntil = new Map<number, number>()
  constructor(private readonly sources: PriceSource[], private readonly cooldownMs = 60_000) {
    if (!sources.length) throw new Error('PriceFeed needs a source')
  }
  get name() {
    return this.sources[this.active]!.name
  }
  private async tryEach<T>(fn: (s: PriceSource) => Promise<T>): Promise<T> {
    let lastErr: unknown
    const now = Date.now()
    const order = this.sources.map((_, k) => (this.active + k) % this.sources.length)
    // Healthy sources first; cooling-down ones only as a last resort.
    const ranked = [...order.filter(i => (this.downUntil.get(i) ?? 0) <= now), ...order.filter(i => (this.downUntil.get(i) ?? 0) > now)]
    for (const i of ranked) {
      try {
        const v = await fn(this.sources[i]!)
        this.active = i
        this.downUntil.delete(i)
        return v
      } catch (err) {
        lastErr = err
        this.downUntil.set(i, Date.now() + this.cooldownMs)
      }
    }
    throw new Error(`Live prices unavailable (${lastErr instanceof Error ? lastErr.message : 'no source reachable'})`)
  }
  ticker(symbol: string) {
    return this.tryEach(s => s.ticker(symbol))
  }
  instrument(symbol: string) {
    return this.tryEach(s => s.instrument(symbol))
  }
}

/**
 * Shares one upstream request per symbol across every user on a hosted
 * server: answers from a short-lived cache and merges concurrent lookups.
 */
export class CachedPrices implements PriceSource {
  private readonly tickers = new Map<string, { at: number; v: Promise<Ticker | null> }>()
  private readonly instruments = new Map<string, Promise<Instrument | null>>()
  constructor(private readonly inner: PriceSource, private readonly ttlMs = 1500) {}
  get name() {
    return this.inner.name
  }
  ticker(symbol: string): Promise<Ticker | null> {
    const hit = this.tickers.get(symbol)
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.v
    const v = this.inner.ticker(symbol)
    this.tickers.set(symbol, { at: Date.now(), v })
    v.catch(() => this.tickers.delete(symbol))
    return v
  }
  instrument(symbol: string): Promise<Instrument | null> {
    let v = this.instruments.get(symbol)
    if (!v) {
      v = this.inner.instrument(symbol)
      this.instruments.set(symbol, v)
      v.catch(() => this.instruments.delete(symbol))
    }
    return v
  }
}
