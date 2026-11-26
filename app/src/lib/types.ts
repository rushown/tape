/** Mirrors server/src/desk.ts and server/src/exchange/types.ts. */
export interface Ticker { symbol: string; coin: string; last: number; change24hPct: number }
export interface Position { symbol: string; coin: string; side: 'long' | 'short'; size: number; entry: number; mark: number; upnl: number; upnlPct: number; notional: number; liq?: number }
export interface OpenOrder { id: string; symbol: string; coin: string; side: 'buy' | 'sell'; qty: number; price: number; reduceOnly: boolean }
export interface Account { equity: number; available: number; upnl: number; funding: number; dayPnl: number }
export interface Alert { id: string; target: 'price' | 'pnl'; coin?: string; op: 'above' | 'below'; value: number; createdAt: number }
export interface Settings { watchlist: string[]; focus: string; readOnly: boolean; maxOrderUsd: number }
export type Mode = 'paper' | 'bybit-testnet' | 'bybit-demo'

export interface Snapshot {
  at: number
  mode: Mode
  account: Account | null
  positions: Position[]
  tickers: Ticker[]
  orders: OpenOrder[]
  alerts: Alert[]
  settings: Settings
  error?: string
}

export interface Plan {
  id: string
  kind: 'order' | 'close' | 'close_all' | 'cancel_orders' | 'transfer'
  title: string
  body: string
  confirm: string
  cancel: string
  danger: boolean
  expiresAt: number
}

export type CommandResult =
  | { type: 'confirm'; plan: Plan }
  | { type: 'info'; title: string; body: string }
  | { type: 'clarify'; body: string }

export type ServerEvent =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'alert'; alert: Alert; title: string; body: string; coin?: string; hasPosition: boolean }
  | { type: 'fill'; title: string; body: string }

export interface Info {
  version: string
  mode: 'self' | 'hosted'
  signup: string[]
  voice: boolean
  maxOrderUsd: number
}

export interface ExchangeInfo { kind: 'paper' | 'bybit'; env?: 'testnet' | 'demo'; keyHint?: string; label: string }
export type ExchangeChoice = { kind: 'paper' } | { kind: 'bybit'; env: 'testnet' | 'demo'; apiKey: string; apiSecret: string }

export interface Status {
  version: string
  hosted: boolean
  mode: Mode
  exchange: { label: string; connected: boolean; error: string | null }
  prices: string | null
  stt: string | null
  maxOrderUsd: number
  settings: Settings
}
