import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { Desk, type DeskData, type DeskEvent } from '../src/desk.js'
import { PaperExchange, paperDefaults } from '../src/exchange/paper.js'
import { MemoryStore } from '../src/lib/store.js'
import { FixedPrices } from './exchange.test.js'

const TOKEN = 'test-token-0123456789'

async function setup(opts: { maxOrderUsd?: number; ttl?: number } = {}) {
  const feed = new FixedPrices({ BTCUSDT: 100_000, ETHUSDT: 3000, SOLUSDT: 150, TONUSDT: 5 })
  const ex = new PaperExchange(new MemoryStore(paperDefaults(10_000, 1000)), feed, { leverage: 10, feeBps: 0 })
  const store = new MemoryStore<DeskData>({ settings: { watchlist: ['BTC', 'ETH'], focus: 'BTC', readOnly: false, maxOrderUsd: opts.maxOrderUsd ?? 2500 }, alerts: [] })
  const desk = new Desk(ex, store, { maxOrderUsd: opts.maxOrderUsd ?? 2500, planTtlMs: opts.ttl ?? 30_000, pollMs: 60_000 })
  await desk.refresh()
  const events: DeskEvent[] = []
  desk.subscribe(e => events.push(e))
  return { desk, feed, ex, events }
}

const confirmOf = async (desk: Desk, text: string) => {
  const r = await desk.command(text)
  if (r.type !== 'confirm') throw new Error(`expected confirm, got ${JSON.stringify(r)}`)
  return r.plan
}

describe('Desk', () => {
  it('voice order → confirm card → fill', async () => {
    const { desk } = await setup()
    const plan = await confirmOf(desk, 'buy $500 of ETH')
    expect(plan.title).toBe('BUY 0.166 ETH · $498.00')
    expect(plan.body).toContain('Opens a LONG')
    expect(plan.confirm).toBe('Buy 0.166 ETH')
    const res = await desk.execute(plan.id)
    expect(res.title).toBe('BUY 0.166 ETH done')
    const snap = await desk.refresh()
    expect(snap.positions[0]).toMatchObject({ coin: 'ETH', side: 'long', size: 0.166 })
    // A plan runs once.
    await expect(desk.execute(plan.id)).rejects.toThrow(/no longer valid/)
  })

  it('enforces the per-order cap and read-only mode', async () => {
    const { desk } = await setup({ maxOrderUsd: 1000 })
    const r = await desk.command('buy 1 BTC')
    expect(r).toMatchObject({ type: 'clarify' })
    expect((r as { body: string }).body).toMatch(/over your \$1,000.00 per-order limit/)
    await desk.updateSettings({ maxOrderUsd: 50_000 })
    expect(desk.settings.maxOrderUsd).toBe(1000) // can't exceed the server cap
    await desk.updateSettings({ readOnly: true })
    expect(await desk.command('buy 0.001 BTC')).toMatchObject({ type: 'info', title: 'Read-only' })
  })

  it('refuses a card when trading was turned off after it was shown', async () => {
    const { desk } = await setup()
    const plan = await confirmOf(desk, 'buy 0.001 btc')
    await desk.updateSettings({ readOnly: true })
    await expect(desk.execute(plan.id)).rejects.toThrow(/turned off/)
  })

  it('expires confirmations and only keeps the newest one', async () => {
    const { desk } = await setup({ ttl: 1 })
    const plan = await confirmOf(desk, 'buy 0.001 btc')
    await new Promise(r => setTimeout(r, 5))
    await expect(desk.execute(plan.id)).rejects.toThrow(/expired/)
    const { desk: d2 } = await setup()
    const a = await confirmOf(d2, 'buy 0.001 btc')
    const b = await confirmOf(d2, 'buy 0.002 btc')
    await expect(d2.execute(a.id)).rejects.toThrow(/no longer valid/)
    await expect(d2.execute(b.id)).resolves.toBeTruthy()
  })

  it('refuses a market card when the price ran away', async () => {
    const { desk, feed } = await setup()
    const plan = await confirmOf(desk, 'buy 0.001 btc')
    feed.prices.BTCUSDT = 102_000
    await desk.refresh()
    await expect(desk.execute(plan.id)).rejects.toThrow(/moved over 1%/)
  })

  it('closes half, then everything (danger card)', async () => {
    const { desk } = await setup()
    await desk.execute((await confirmOf(desk, 'long 0.5 eth')).id)
    await desk.execute((await confirmOf(desk, 'short 0.01 btc')).id)
    await desk.refresh()
    const half = await confirmOf(desk, 'close half my ETH')
    expect(half.title).toBe('Close 50% of LONG ETH?')
    await desk.execute(half.id)
    expect((await desk.refresh()).positions.find(p => p.coin === 'ETH')!.size).toBe(0.25)
    const all = await confirmOf(desk, 'close everything')
    expect(all.danger).toBe(true)
    expect(all.title).toBe('Close ALL 2 positions?')
    expect((await desk.execute(all.id)).title).toBe('All positions closed')
    expect((await desk.refresh()).positions).toEqual([])
  })

  it('price and PnL alerts fire once', async () => {
    const { desk, feed, events } = await setup()
    expect(await desk.command('alert me if bitcoin drops below 99k')).toMatchObject({ type: 'info', title: 'Alert set' })
    expect(await desk.command('alert if btc goes above 90k')).toMatchObject({ type: 'clarify' }) // already above
    expect(await desk.command('tell me when sol hits 160')).toMatchObject({ type: 'info', title: 'Alert set' })
    expect(desk.snapshot.alerts.map(a => [a.coin, a.op, a.value])).toEqual([['BTC', 'below', 99_000], ['SOL', 'above', 160]])
    feed.prices.BTCUSDT = 98_500
    await desk.refresh()
    await desk.refresh()
    const fired = events.filter(e => e.type === 'alert')
    expect(fired).toHaveLength(1)
    expect(fired[0]).toMatchObject({ title: 'BTC below 99,000', body: 'Now 98,500' })
    expect(desk.snapshot.alerts).toHaveLength(1)

    await desk.execute((await confirmOf(desk, 'long 0.5 eth')).id)
    await desk.command('alert if pnl below minus 100')
    feed.prices.ETHUSDT = 2700
    await desk.refresh()
    expect(events.filter(e => e.type === 'alert').at(-1)).toMatchObject({ title: 'PnL today below -$100.00' })
  })

  it('transfers with a confirm card', async () => {
    const { desk } = await setup()
    const plan = await confirmOf(desk, 'move 500 from funding to trading')
    expect(plan.title).toBe('Move $500.00 Funding → Trading?')
    await desk.execute(plan.id)
    expect((await desk.refresh()).account!.funding).toBe(500)
  })
})

describe('HTTP API', () => {
  it('requires the token and runs command → execute', async () => {
    const { desk } = await setup()
    const app = await buildApp({ desk, token: TOKEN, stt: null, corsOrigins: '*', maxOrderUsd: 2500 })
    expect((await app.inject({ url: '/api/status' })).statusCode).toBe(401)
    const auth = { authorization: `Bearer ${TOKEN}` }
    const status = await app.inject({ url: '/api/status', headers: auth })
    expect(status.json()).toMatchObject({ mode: 'paper', exchange: { connected: true }, stt: null })
    const cmd = await app.inject({ method: 'POST', url: '/api/command', headers: auth, payload: { text: 'short 0.5 sol' } })
    const plan = cmd.json().result.plan
    expect(plan.title).toBe('SELL 0.5 SOL · $75.00')
    const ex = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/execute`, headers: auth })
    expect(ex.json().title).toBe('SELL 0.5 SOL done')
    const voice = await app.inject({ method: 'POST', url: '/api/voice', headers: { ...auth, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(32_000) })
    expect(voice.statusCode).toBe(503)
    const nudge = await app.inject({ method: 'POST', url: '/api/demo/nudge', headers: auth, payload: { coin: 'sol', pct: 10 } })
    // SOL is not on the watchlist, but an open position puts it in the feed.
    expect(nudge.json().tickers.find((t: { coin: string }) => t.coin === 'SOL').last).toBeCloseTo(165)
    expect(nudge.json().positions[0].mark).toBeCloseTo(165)
    await app.close()
  })
})

describe('Desk during an outage', () => {
  it('pauses new orders and transfers, but still lets you close', async () => {
    const { desk, feed } = await setup()
    await desk.execute((await confirmOf(desk, 'long 0.5 eth')).id)
    expect((await desk.refresh()).positions).toHaveLength(1)
    feed.prices = {} // every price lookup now fails
    ;(feed as unknown as { ticker: () => Promise<never> }).ticker = async () => { throw new Error('Live prices unavailable (timeout)') }
    const snap = await desk.refresh()
    expect(snap.error).toMatch(/unavailable/)
    expect(snap.positions).toHaveLength(1) // last good data is kept
    expect(await desk.command('buy 0.001 btc')).toMatchObject({ type: 'info', title: 'No live data' })
    expect(await desk.command('move 100 from funding to trading')).toMatchObject({ type: 'info', title: 'No live data' })
    expect((await desk.command('close my eth')).type).toBe('confirm')
  })

  it('refuses a market card if no fresh price exists at send time', async () => {
    const { desk, feed } = await setup()
    const plan = await confirmOf(desk, 'buy 0.001 btc')
    delete feed.prices.BTCUSDT
    await expect(desk.execute(plan.id)).rejects.toThrow(/No live BTC price/)
  })
})
