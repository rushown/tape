import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BybitExchange, signV5 } from '../src/exchange/bybit.js'
import { PaperExchange, paperDefaults } from '../src/exchange/paper.js'
import type { PriceSource } from '../src/exchange/prices.js'
import { PriceFeed } from '../src/exchange/prices.js'
import { floorStep, roundStep } from '../src/exchange/types.js'
import { MemoryStore } from '../src/lib/store.js'

/** Fixed prices the test can move. */
export class FixedPrices implements PriceSource {
  readonly name = 'fixed'
  constructor(public prices: Record<string, number>) {}
  async ticker(symbol: string) {
    const last = this.prices[symbol]
    return last ? { symbol, coin: symbol.replace(/USDT$/, ''), last, change24hPct: 1.5 } : null
  }
  async instrument(symbol: string) {
    return this.prices[symbol] ? { symbol, qtyStep: 0.001, minQty: 0.001, minNotional: 5, tickSize: 0.1 } : null
  }
}

const paper = (prices: Record<string, number>, start = 10_000) => {
  const feed = new FixedPrices(prices)
  const ex = new PaperExchange(new MemoryStore(paperDefaults(start, 1000)), feed, { leverage: 10, feeBps: 0 })
  return { ex, feed }
}

describe('steps', () => {
  it('rounds without float dust', () => {
    expect(floorStep(0.0129999, 0.001)).toBe(0.012)
    expect(floorStep(0.3, 0.1)).toBe(0.3)
    expect(roundStep(3201.04, 0.1)).toBe(3201)
  })
})

describe('PaperExchange', () => {
  it('opens, marks and closes a long with realised PnL', async () => {
    const { ex, feed } = paper({ BTCUSDT: 100_000 })
    await ex.start()
    await ex.placeOrder({ symbol: 'BTCUSDT', side: 'buy', qty: 0.1 })
    feed.prices.BTCUSDT = 101_000
    const [p] = await ex.positions()
    expect(p).toMatchObject({ side: 'long', size: 0.1, entry: 100_000, upnl: 100 })
    const acct = await ex.account()
    expect(acct.equity).toBeCloseTo(10_100)
    expect(acct.available).toBeCloseTo(10_100 - 1010)
    expect(acct.dayPnl).toBeCloseTo(100)
    await ex.placeOrder({ symbol: 'BTCUSDT', side: 'sell', qty: 0.1, reduceOnly: true })
    expect(await ex.positions()).toEqual([])
    expect((await ex.account()).equity).toBeCloseTo(10_100)
  })

  it('averages entries and flips', async () => {
    const { ex, feed } = paper({ ETHUSDT: 3000 })
    await ex.placeOrder({ symbol: 'ETHUSDT', side: 'buy', qty: 1 })
    feed.prices.ETHUSDT = 3200
    await ex.placeOrder({ symbol: 'ETHUSDT', side: 'buy', qty: 1 })
    expect((await ex.positions())[0]!.entry).toBeCloseTo(3100)
    await ex.placeOrder({ symbol: 'ETHUSDT', side: 'sell', qty: 3 })
    const [p] = await ex.positions()
    expect(p).toMatchObject({ side: 'short', size: 1, entry: 3200 })
    expect((await ex.account()).equity).toBeCloseTo(10_000 + 200)
  })

  it('refuses orders beyond free margin and bad reduce-only', async () => {
    const { ex } = paper({ BTCUSDT: 100_000 }, 1000)
    await expect(ex.placeOrder({ symbol: 'BTCUSDT', side: 'buy', qty: 1 })).rejects.toThrow(/Not enough margin/)
    await expect(ex.placeOrder({ symbol: 'BTCUSDT', side: 'sell', qty: 0.01, reduceOnly: true })).rejects.toThrow(/Reduce-only/)
  })

  it('rests limit orders and fills them when price crosses', async () => {
    const { ex, feed } = paper({ SOLUSDT: 150 })
    const fill = await ex.placeOrder({ symbol: 'SOLUSDT', side: 'buy', qty: 10, price: 140 })
    expect(fill.status).toBe('open')
    expect(await ex.openOrders()).toHaveLength(1)
    feed.prices.SOLUSDT = 139
    await ex.tickers(['SOLUSDT'])
    expect(await ex.openOrders()).toHaveLength(0)
    expect((await ex.positions())[0]).toMatchObject({ side: 'long', size: 10, entry: 140 })
  })

  it('transfers between wallets with balance checks', async () => {
    const { ex } = paper({ BTCUSDT: 100_000 })
    await ex.transfer(500, 'funding', 'trading')
    let a = await ex.account()
    expect(a.funding).toBe(500)
    expect(a.equity).toBe(10_500)
    await expect(ex.transfer(600, 'funding', 'trading')).rejects.toThrow(/only \$500/)
    await ex.transfer(10_500, 'trading', 'funding')
    a = await ex.account()
    expect(a.funding).toBe(11_000)
  })

  it('nudges prices for demos', async () => {
    const { ex } = paper({ BTCUSDT: 100_000 })
    ex.nudge('BTCUSDT', -2)
    expect((await ex.tickers(['BTCUSDT']))[0]!.last).toBeCloseTo(98_000)
  })
})

describe('PriceFeed', () => {
  it('falls back to the next source when one fails', async () => {
    const broken: PriceSource = { name: 'broken', ticker: async () => { throw new Error('blocked') }, instrument: async () => { throw new Error('blocked') } }
    const feed = new PriceFeed([broken, new FixedPrices({ BTCUSDT: 5 })])
    expect((await feed.ticker('BTCUSDT'))!.last).toBe(5)
    expect(feed.name).toBe('fixed')
  })
})

describe('Bybit V5', () => {
  it('signs exactly as documented: timestamp + key + recvWindow + payload', () => {
    const want = createHmac('sha256', 'secret').update('1700000000000' + 'key' + '5000' + 'category=linear&symbol=BTCUSDT').digest('hex')
    expect(signV5('secret', '1700000000000', 'key', 'category=linear&symbol=BTCUSDT', '5000')).toBe(want)
  })

  it('sends signed requests to testnet only and maps errors', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.includes('/v5/market/time')) return Response.json({ retCode: 0, retMsg: 'OK', result: { timeSecond: '1', timeNano: String(Date.now() * 1e6) } })
      if (url.includes('/v5/order/create')) return Response.json({ retCode: 110007, retMsg: 'ab not enough for new order', result: {} })
      if (url.includes('/v5/position/list')) {
        return Response.json({ retCode: 0, retMsg: 'OK', result: { list: [{ symbol: 'ETHUSDT', side: 'Sell', size: '2', avgPrice: '3200', markPrice: '3100', unrealisedPnl: '200', positionValue: '6400', positionIM: '640', liqPrice: '4000' }, { symbol: 'BTCUSDT', side: '', size: '0', avgPrice: '0', markPrice: '1', unrealisedPnl: '0', positionValue: '0', liqPrice: '' }] } })
      }
      return Response.json({ retCode: 0, retMsg: 'OK', result: { list: [] } })
    }) as unknown as typeof fetch
    const ex = new BybitExchange('testnet', 'KEY123', 'SECRET', fake)
    const pos = await ex.positions()
    expect(pos).toEqual([{ symbol: 'ETHUSDT', coin: 'ETH', side: 'short', size: 2, entry: 3200, mark: 3100, upnl: 200, upnlPct: 31.25, notional: 6200, liq: 4000 }])
    const call = calls.at(-1)!
    expect(call.url.startsWith('https://api-testnet.bybit.com/v5/position/list?')).toBe(true)
    const h = call.init.headers as Record<string, string>
    const query = call.url.split('?')[1]!
    expect(h['X-BAPI-SIGN']).toBe(signV5('SECRET', h['X-BAPI-TIMESTAMP']!, 'KEY123', query))
    await expect(ex.placeOrder({ symbol: 'BTCUSDT', side: 'buy', qty: 0.01 })).rejects.toThrow(/Not enough available balance/)
    const order = calls.at(-1)!
    const body = JSON.parse(String(order.init.body))
    expect(body).toMatchObject({ category: 'linear', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '0.01', reduceOnly: false })
    const oh = order.init.headers as Record<string, string>
    expect(oh['X-BAPI-SIGN']).toBe(signV5('SECRET', oh['X-BAPI-TIMESTAMP']!, 'KEY123', String(order.init.body)))
  })
})

describe('PriceFeed outages', () => {
  it('skips a failed source for a cooldown and never invents prices', async () => {
    let calls = 0
    const slow: PriceSource = { name: 'down', ticker: async () => { calls++; throw new Error('timeout') }, instrument: async () => { throw new Error('timeout') } }
    const feed = new PriceFeed([slow, new FixedPrices({ BTCUSDT: 5 })])
    await feed.ticker('BTCUSDT')
    await feed.ticker('BTCUSDT')
    await feed.ticker('BTCUSDT')
    expect(calls).toBe(1) // tried once, then cooled down
    const allDown = new PriceFeed([slow])
    await expect(allDown.ticker('BTCUSDT')).rejects.toThrow(/Live prices unavailable/)
  })
})
