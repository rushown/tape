/** Everything is USDT-margined linear perpetuals (BTCUSDT, ETHUSDT, ...). */
export type Side = 'buy' | 'sell'

export interface Ticker {
  symbol: string
  coin: string
  last: number
  change24hPct: number
}

export interface Position {
  symbol: string
  coin: string
  side: 'long' | 'short'
  /** Always positive, in coins. */
  size: number
  entry: number
  mark: number
  upnl: number
  upnlPct: number
  notional: number
  liq?: number
}

export interface OpenOrder {
  id: string
  symbol: string
  coin: string
  side: Side
  qty: number
  price: number
  reduceOnly: boolean
}

export interface Account {
  /** Trading account equity including unrealised PnL, USDT. */
  equity: number
  /** Free margin for new orders, USDT. */
  available: number
  upnl: number
  /** Funding (spot) wallet, USDT. */
  funding: number
  /** Realised + unrealised change since 00:00 UTC, USDT. */
  dayPnl: number
}

export interface Instrument {
  symbol: string
  qtyStep: number
  minQty: number
  minNotional: number
  tickSize: number
}

export interface OrderRequest {
  symbol: string
  side: Side
  qty: number
  /** Omit for market. */
  price?: number
  reduceOnly?: boolean
}

export interface Fill {
  orderId: string
  symbol: string
  side: Side
  qty: number
  /** Average fill price, when known (market orders on paper; Bybit reports it asynchronously). */
  price?: number
  status: 'filled' | 'open'
}

export type Wallet = 'funding' | 'trading'

export interface Exchange {
  readonly mode: 'paper' | 'bybit-testnet' | 'bybit-demo'
  readonly label: string
  /** Throws when the account cannot be reached (bad key, network). */
  start(): Promise<void>
  stop(): Promise<void>
  tickers(symbols: string[]): Promise<Ticker[]>
  account(): Promise<Account>
  positions(): Promise<Position[]>
  openOrders(): Promise<OpenOrder[]>
  instrument(symbol: string): Promise<Instrument | null>
  placeOrder(o: OrderRequest): Promise<Fill>
  cancelAll(): Promise<number>
  transfer(amount: number, from: Wallet, to: Wallet): Promise<{ id: string }>
  /** Paper only: shift a price so an alert or a PnL change can be shown in a demo. */
  nudge?(symbol: string, pct: number): void
}

export class ExchangeError extends Error {
  constructor(message: string, readonly code = 'exchange_error') {
    super(message)
  }
}

export const symbolOf = (coin: string) => `${coin.toUpperCase()}USDT`
export const coinOf = (symbol: string) => symbol.replace(/USDT$/, '')

/** Round down to a step without float dust (0.1 + 0.2 problems). */
export function floorStep(v: number, step: number): number {
  if (step <= 0) return v
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1)
  const n = Math.floor(v / step + 1e-9) * step
  return Number(n.toFixed(Math.min(12, decimals)))
}

export function roundStep(v: number, step: number): number {
  if (step <= 0) return v
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1)
  return Number((Math.round(v / step) * step).toFixed(Math.min(12, decimals)))
}
