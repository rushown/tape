import { createHmac, randomUUID } from 'node:crypto'
import {
  type Account, coinOf, ExchangeError, type Exchange, type Fill, type Instrument, type OpenOrder,
  type OrderRequest, type Position, type Ticker, type Wallet,
} from './types.js'

/**
 * Non-mainnet Bybit only. There is deliberately no way to point Tape at
 * api.bybit.com with keys: testnet uses test coins, demo trading uses demo
 * funds on real mainnet prices.
 */
export const BYBIT_BASES = {
  testnet: 'https://api-testnet.bybit.com',
  demo: 'https://api-demo.bybit.com',
} as const
export type BybitEnv = keyof typeof BYBIT_BASES

const RECV_WINDOW = '10000'

/** Bybit V5 signature: HMAC-SHA256(secret, timestamp + apiKey + recvWindow + (query string | JSON body)), hex. */
export function signV5(secret: string, timestamp: string, apiKey: string, payload: string, recvWindow = RECV_WINDOW): string {
  return createHmac('sha256', secret).update(timestamp + apiKey + recvWindow + payload).digest('hex')
}

/** Friendlier text for the Bybit errors people actually hit. */
const ERRORS: Record<number, string> = {
  10003: 'Bybit rejected the API key. Check it was made on the same environment (testnet vs demo).',
  10004: 'Bybit rejected the request signature. Check BYBIT_API_SECRET.',
  10005: 'This API key lacks permission. Enable Contract (orders, positions) and Wallet (transfer).',
  10006: 'Bybit rate limit, try again in a moment.',
  10002: 'Server clock is off. Tape re-syncs; try again.',
  110007: 'Not enough available balance for this order.',
  110017: 'Reduce-only order has no position to reduce.',
  131212: 'Not enough balance in that wallet.',
  131228: 'Transfer amount is not valid for this wallet.',
}

interface V5<T> {
  retCode: number
  retMsg: string
  result: T
  time?: number
}

type FetchLike = typeof fetch

export interface KeyInfo {
  readOnly: boolean
  canWithdraw: boolean
  canTrade: boolean
  permissions: string[]
  expiresAt?: number
}

export class BybitExchange implements Exchange {
  readonly mode: 'bybit-testnet' | 'bybit-demo'
  readonly label: string
  private readonly base: string
  private clockSkew = 0
  private readonly instruments = new Map<string, Instrument | null>()

  constructor(
    private readonly env: BybitEnv,
    private readonly key: string,
    private readonly secret: string,
    private readonly fetchFn: FetchLike = fetch,
  ) {
    this.base = BYBIT_BASES[env]
    this.mode = env === 'demo' ? 'bybit-demo' : 'bybit-testnet'
    this.label = env === 'demo' ? `Bybit demo trading · key …${key.slice(-4)}` : `Bybit testnet · key …${key.slice(-4)}`
  }

  async start() {
    await this.syncClock()
    await this.account() // fails fast on a bad key
  }
  async stop() {}

  private async syncClock() {
    try {
      const r = await this.call<{ timeSecond: string; timeNano: string }>('GET', '/v5/market/time', {}, false)
      this.clockSkew = Math.round(Number(r.timeNano) / 1e6) - Date.now()
    } catch { /* keep local clock */ }
  }

  private async call<T>(method: 'GET' | 'POST', path: string, params: Record<string, string | number | boolean | undefined>, signed = true): Promise<T> {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))
    const query = method === 'GET' ? new URLSearchParams(clean).toString() : ''
    const body = method === 'POST' ? JSON.stringify(params) : ''
    const headers: Record<string, string> = method === 'POST' ? { 'Content-Type': 'application/json' } : {}
    if (signed) {
      const ts = String(Date.now() + this.clockSkew)
      headers['X-BAPI-API-KEY'] = this.key
      headers['X-BAPI-TIMESTAMP'] = ts
      headers['X-BAPI-RECV-WINDOW'] = RECV_WINDOW
      headers['X-BAPI-SIGN'] = signV5(this.secret, ts, this.key, method === 'GET' ? query : body)
    }
    let res: Response
    try {
      res = await this.fetchFn(`${this.base}${path}${query ? `?${query}` : ''}`, {
        method, headers, body: body || undefined, signal: AbortSignal.timeout(8000),
      })
    } catch (err) {
      throw new ExchangeError(`Cannot reach Bybit (${(err as Error).name === 'TimeoutError' ? 'timeout' : 'network'})`, 'network')
    }
    if (res.status === 403) throw new ExchangeError('Bybit refused the connection from this server (403, often a region block).', 'forbidden')
    let json: V5<T>
    try {
      json = (await res.json()) as V5<T>
    } catch {
      throw new ExchangeError(`Bybit HTTP ${res.status}`, 'bad_response')
    }
    if (json.retCode !== 0) {
      if (json.retCode === 10002) void this.syncClock()
      throw new ExchangeError(ERRORS[json.retCode] ?? `Bybit: ${json.retMsg} (${json.retCode})`, `bybit_${json.retCode}`)
    }
    return json.result
  }

  /**
   * What this key may do (GET /v5/user/query-api). Used to refuse keys that
   * can withdraw: Tape never needs that, and a leaked server must not be able to.
   */
  async keyInfo(): Promise<KeyInfo> {
    const r = await this.call<{ readOnly: number; permissions?: Record<string, string[]>; expiredAt?: string }>('GET', '/v5/user/query-api', {})
    const perms = Object.entries(r.permissions ?? {}).flatMap(([group, list]) => (list ?? []).map(p => `${group}:${p}`))
    return {
      readOnly: Number(r.readOnly) === 1,
      canWithdraw: perms.some(p => /withdraw/i.test(p)),
      canTrade: perms.some(p => /^(ContractTrade|Derivatives):/i.test(p)),
      permissions: perms,
      expiresAt: r.expiredAt ? Date.parse(r.expiredAt) || undefined : undefined,
    }
  }

  async tickers(symbols: string[]): Promise<Ticker[]> {
    const out = await Promise.all(
      symbols.map(async symbol => {
        try {
          const r = await this.call<{ list: Array<{ lastPrice: string; price24hPcnt: string }> }>('GET', '/v5/market/tickers', { category: 'linear', symbol }, false)
          const t = r.list[0]
          if (!t) return null
          return { symbol, coin: coinOf(symbol), last: Number(t.lastPrice), change24hPct: Number(t.price24hPcnt) * 100 } satisfies Ticker
        } catch {
          return null
        }
      }),
    )
    return out.filter((t): t is Ticker => t !== null && t.last > 0)
  }

  async account(): Promise<Account> {
    const [wallet, fund, closed] = await Promise.all([
      this.call<{ list: Array<{ totalEquity: string; totalAvailableBalance: string; totalPerpUPL: string }> }>('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' }),
      this.call<{ balance: Array<{ walletBalance: string }> }>('GET', '/v5/asset/transfer/query-account-coins-balance', { accountType: 'FUND', coin: 'USDT' })
        .catch(() => ({ balance: [] })), // demo trading has no funding wallet
      this.closedPnlToday(),
    ])
    const w = wallet.list[0]
    const upnl = Number(w?.totalPerpUPL ?? 0)
    return {
      equity: Number(w?.totalEquity ?? 0),
      available: Number(w?.totalAvailableBalance ?? 0),
      upnl,
      funding: Number(fund.balance[0]?.walletBalance ?? 0),
      dayPnl: closed + upnl,
    }
  }

  private async closedPnlToday(): Promise<number> {
    const start = new Date()
    start.setUTCHours(0, 0, 0, 0)
    try {
      const r = await this.call<{ list: Array<{ closedPnl: string }> }>('GET', '/v5/position/closed-pnl', { category: 'linear', startTime: start.getTime(), limit: 100 })
      return r.list.reduce((n, x) => n + Number(x.closedPnl || 0), 0)
    } catch {
      return 0
    }
  }

  async positions(): Promise<Position[]> {
    const r = await this.call<{
      list: Array<{ symbol: string; side: 'Buy' | 'Sell' | ''; size: string; avgPrice: string; markPrice: string; unrealisedPnl: string; positionValue: string; positionIM?: string; liqPrice: string }>
    }>('GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT', limit: 50 })
    return r.list
      .filter(p => Number(p.size) > 0 && p.side)
      .map(p => {
        const size = Number(p.size)
        const mark = Number(p.markPrice)
        const upnl = Number(p.unrealisedPnl)
        const im = Number(p.positionIM ?? 0) || Number(p.positionValue) / 10
        const liq = Number(p.liqPrice)
        return {
          symbol: p.symbol, coin: coinOf(p.symbol), side: p.side === 'Buy' ? 'long' : 'short', size,
          entry: Number(p.avgPrice), mark, upnl, upnlPct: im ? (upnl / im) * 100 : 0, notional: size * mark,
          ...(liq > 0 ? { liq } : {}),
        } satisfies Position
      })
      .sort((a, b) => b.notional - a.notional)
  }

  async openOrders(): Promise<OpenOrder[]> {
    const r = await this.call<{ list: Array<{ orderId: string; symbol: string; side: 'Buy' | 'Sell'; qty: string; price: string; reduceOnly: boolean }> }>(
      'GET', '/v5/order/realtime', { category: 'linear', settleCoin: 'USDT', limit: 50 },
    )
    return r.list.map(o => ({
      id: o.orderId, symbol: o.symbol, coin: coinOf(o.symbol), side: o.side === 'Buy' ? 'buy' : 'sell',
      qty: Number(o.qty), price: Number(o.price), reduceOnly: o.reduceOnly,
    }))
  }

  async instrument(symbol: string): Promise<Instrument | null> {
    if (this.instruments.has(symbol)) return this.instruments.get(symbol)!
    const r = await this.call<{ list: Array<{ status: string; lotSizeFilter: { qtyStep: string; minOrderQty: string; minNotionalValue?: string }; priceFilter: { tickSize: string } }> }>(
      'GET', '/v5/market/instruments-info', { category: 'linear', symbol }, false,
    )
    const i = r.list[0]
    const inst = i && i.status === 'Trading'
      ? { symbol, qtyStep: Number(i.lotSizeFilter.qtyStep), minQty: Number(i.lotSizeFilter.minOrderQty), minNotional: Number(i.lotSizeFilter.minNotionalValue ?? 5) || 5, tickSize: Number(i.priceFilter.tickSize) }
      : null
    this.instruments.set(symbol, inst)
    return inst
  }

  async placeOrder(o: OrderRequest): Promise<Fill> {
    const r = await this.call<{ orderId: string }>('POST', '/v5/order/create', {
      category: 'linear',
      symbol: o.symbol,
      side: o.side === 'buy' ? 'Buy' : 'Sell',
      orderType: o.price === undefined ? 'Market' : 'Limit',
      qty: String(o.qty),
      ...(o.price !== undefined ? { price: String(o.price), timeInForce: 'GTC' } : {}),
      reduceOnly: Boolean(o.reduceOnly),
      orderLinkId: `tape-${randomUUID().slice(0, 18)}`,
    })
    // Bybit acknowledges first and fills asynchronously; market orders on liquid perps fill immediately.
    return { orderId: r.orderId, symbol: o.symbol, side: o.side, qty: o.qty, status: o.price === undefined ? 'filled' : 'open' }
  }

  async cancelAll(): Promise<number> {
    const r = await this.call<{ list: unknown[] }>('POST', '/v5/order/cancel-all', { category: 'linear', settleCoin: 'USDT' })
    return r.list?.length ?? 0
  }

  async transfer(amount: number, from: Wallet, to: Wallet): Promise<{ id: string }> {
    if (this.env === 'demo') throw new ExchangeError('Bybit demo trading has no funding wallet to transfer from.', 'unsupported')
    const acct = (w: Wallet) => (w === 'funding' ? 'FUND' : 'UNIFIED')
    const transferId = randomUUID()
    await this.call('POST', '/v5/asset/transfer/inter-transfer', {
      transferId, coin: 'USDT', amount: String(amount), fromAccountType: acct(from), toAccountType: acct(to),
    })
    return { id: transferId }
  }
}
