import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/accounts.js'
import { buildApp } from '../src/app.js'
import { BybitExchange } from '../src/exchange/bybit.js'
import { Database, Sealer } from '../src/lib/db.js'
import { FixedPrices } from './exchange.test.js'

const KEY = 'a'.repeat(64)

/** A fake Bybit testnet that answers the calls Tape makes during sign-up and refresh. */
function fakeBybit(perms: Record<string, string[]>, opts: { readOnly?: number; badKey?: boolean } = {}) {
  return (async (url: string) => {
    const ok = (result: unknown) => Response.json({ retCode: 0, retMsg: 'OK', result })
    if (opts.badKey && !url.includes('/v5/market/')) return Response.json({ retCode: 10003, retMsg: 'API key is invalid.', result: {} })
    if (url.includes('/v5/market/time')) return ok({ timeSecond: '1', timeNano: String(Date.now() * 1e6) })
    if (url.includes('/v5/account/wallet-balance')) return ok({ list: [{ totalEquity: '5000', totalAvailableBalance: '4000', totalPerpUPL: '12.5' }] })
    if (url.includes('/v5/asset/transfer/query-account-coins-balance')) return ok({ balance: [{ walletBalance: '250' }] })
    if (url.includes('/v5/user/query-api')) return ok({ readOnly: opts.readOnly ?? 0, permissions: perms })
    if (url.includes('/v5/market/tickers')) return ok({ list: [{ lastPrice: '60000', price24hPcnt: '0.01' }] })
    return ok({ list: [] })
  }) as unknown as typeof fetch
}

const TRADE = { ContractTrade: ['Order', 'Position'], Wallet: ['AccountTransfer'] }

async function setup(perms: Record<string, string[]> = TRADE, bybitOpts: Parameters<typeof fakeBybit>[1] = {}) {
  const db = new Database(':memory:', new Sealer(KEY))
  const accounts = new Accounts({
    db,
    prices: new FixedPrices({ BTCUSDT: 60_000, ETHUSDT: 2000, SOLUSDT: 100, XRPUSDT: 2 }),
    paper: { start: 10_000, leverage: 10, feeBps: 0 },
    desk: { maxOrderUsd: 2500, planTtlMs: 30_000, pollMs: 60_000, watchlist: ['BTC', 'ETH'] },
    makeBybit: (env, key, secret) => new BybitExchange(env, key, secret, fakeBybit(perms, bybitOpts)),
    idleMs: 0,
  })
  const app = await buildApp({ accounts, stt: null, corsOrigins: '*', maxOrderUsd: 2500, signupLimit: 3 })
  const signup = async (body: unknown, ip = '1.1.1.1') => app.inject({ method: 'POST', url: '/api/auth/signup', payload: body as object, remoteAddress: ip })
  const as = (token: string) => ({ authorization: `Bearer ${token}` })
  return { db, accounts, app, signup, as }
}

describe('hosted mode', () => {
  it('anyone starts a paper account in one call; accounts are isolated', async () => {
    const { app, signup, as } = await setup()
    expect((await app.inject({ url: '/api/info' })).json()).toMatchObject({ mode: 'hosted', signup: ['paper', 'bybit-testnet', 'bybit-demo'] })
    const a = (await signup({ kind: 'paper' })).json()
    const b = (await signup({ kind: 'paper' })).json()
    expect(a.token).toMatch(/^tp_/)
    expect(a.exchange.label).toContain('Paper')
    expect((await app.inject({ url: '/api/status' })).statusCode).toBe(401)
    expect((await app.inject({ url: '/api/status', headers: as('tp_forged') })).statusCode).toBe(401)

    const cmd = await app.inject({ method: 'POST', url: '/api/command', headers: as(a.token), payload: { text: 'buy 0.01 btc' } })
    const id = cmd.json().result.plan.id
    // B cannot run A's confirm card.
    expect((await app.inject({ method: 'POST', url: `/api/plans/${id}/execute`, headers: as(b.token) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/plans/${id}/execute`, headers: as(a.token) })).json().title).toBe('BUY 0.01 BTC done')
    await app.inject({ method: 'POST', url: '/api/demo/nudge', headers: as(a.token), payload: { coin: 'BTC', pct: 10 } })
    const snapA = (await app.inject({ url: '/api/snapshot', headers: as(a.token) })).json()
    const snapB = (await app.inject({ url: '/api/snapshot', headers: as(b.token) })).json()
    expect(snapA.positions).toHaveLength(1)
    expect(snapA.positions[0].upnl).toBeCloseTo(60)
    expect(snapB.positions).toHaveLength(0)
    expect(snapB.tickers.find((t: { coin: string }) => t.coin === 'BTC').last).toBe(60_000) // A's demo nudge doesn't move B's prices
    await app.close()
  })

  it('stores Bybit keys encrypted and only shows a hint', async () => {
    const { db, app, signup, as } = await setup()
    const secret = 'S3cretSecretValue0123456789'
    const r = await signup({ kind: 'bybit', env: 'testnet', apiKey: 'KEYabcdef1234', apiSecret: secret })
    expect(r.statusCode).toBe(200)
    const { token, exchange, readOnly } = r.json()
    expect(exchange).toMatchObject({ kind: 'bybit', env: 'testnet', keyHint: '…1234' })
    expect(readOnly).toBe(false)
    const raw = db.db.prepare("SELECT data FROM docs WHERE name = 'exchange'").get() as { data: string }
    expect(raw.data.startsWith('v1:')).toBe(true)
    expect(raw.data).not.toContain(secret)
    expect(raw.data).not.toContain('KEYabcdef1234')
    const status = (await app.inject({ url: '/api/status', headers: as(token) })).json()
    expect(status).toMatchObject({ mode: 'bybit-testnet', exchange: { connected: true }, prices: 'Bybit testnet' })
    const exp = await app.inject({ url: '/api/account/export', headers: as(token) })
    expect(exp.body).not.toContain(secret)
    expect(exp.json().exchange.keyHint).toBe('…1234')
    await app.close()
  })

  it('refuses keys that can withdraw or do not work; read-only keys make a read-only desk', async () => {
    const w = await setup({ ...TRADE, Wallet: ['AccountTransfer', 'Withdraw'] })
    const r = await w.signup({ kind: 'bybit', env: 'testnet', apiKey: 'KEYabcdef1234', apiSecret: 'secretsecret1234' })
    expect(r.statusCode).toBe(400)
    expect(r.json().error).toBe('key_can_withdraw')
    expect(w.db.countAccounts()).toBe(0)

    const bad = await setup(TRADE, { badKey: true })
    const r2 = await bad.signup({ kind: 'bybit', env: 'testnet', apiKey: 'KEYabcdef1234', apiSecret: 'secretsecret1234' })
    expect(r2.statusCode).toBe(400)
    expect(r2.json().message).toMatch(/rejected the API key/)

    const ro = await setup(TRADE, { readOnly: 1 })
    const r3 = await ro.signup({ kind: 'bybit', env: 'testnet', apiKey: 'KEYabcdef1234', apiSecret: 'secretsecret1234' })
    expect(r3.json().readOnly).toBe(true)
    const cmd = await ro.app.inject({ method: 'POST', url: '/api/command', headers: ro.as(r3.json().token), payload: { text: 'buy 0.01 btc' } })
    expect(cmd.json().result).toMatchObject({ type: 'info', title: 'Read-only' })

    expect((await w.signup({ kind: 'bybit', env: 'mainnet', apiKey: 'KEYabcdef1234', apiSecret: 'secretsecret1234' })).statusCode).toBe(400)
  })

  it('switches exchange, logs out, deletes everything', async () => {
    const { db, app, signup, as } = await setup()
    const { token } = (await signup({ kind: 'paper' })).json()
    const sw = await app.inject({ method: 'PUT', url: '/api/account/exchange', headers: as(token), payload: { kind: 'bybit', env: 'demo', apiKey: 'KEYabcdef9999', apiSecret: 'secretsecret1234' } })
    expect(sw.json().exchange.label).toBe('Bybit demo trading · key …9999')
    expect((await app.inject({ url: '/api/status', headers: as(token) })).json().mode).toBe('bybit-demo')

    const { token: t2 } = (await signup({ kind: 'paper' })).json()
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: as(t2) })
    expect((await app.inject({ url: '/api/status', headers: as(t2) })).statusCode).toBe(401)

    expect((await app.inject({ method: 'DELETE', url: '/api/account', headers: as(token), payload: {} })).statusCode).toBe(400) // needs confirm
    expect((await app.inject({ method: 'DELETE', url: '/api/account', headers: as(token), payload: { confirm: 'DELETE' } })).json()).toEqual({ ok: true })
    expect((await app.inject({ url: '/api/status', headers: as(token) })).statusCode).toBe(401)
    expect(db.countAccounts()).toBe(1) // only the logged-out paper account remains
    await app.close()
  })

  it('limits sign-ups per IP', async () => {
    const { signup } = await setup()
    for (let i = 0; i < 3; i++) expect((await signup({ kind: 'paper' }, '9.9.9.9')).statusCode).toBe(200)
    expect((await signup({ kind: 'paper' }, '9.9.9.9')).statusCode).toBe(429)
    expect((await signup({ kind: 'paper' }, '8.8.8.8')).statusCode).toBe(200)
  })

  it('unloads idle desks and restores positions and alerts from the database', async () => {
    const { accounts, app, signup, as } = await setup()
    const { token } = (await signup({ kind: 'paper' })).json()
    const id = (await app.inject({ method: 'POST', url: '/api/command', headers: as(token), payload: { text: 'short 1 eth' } })).json().result.plan.id
    await app.inject({ method: 'POST', url: `/api/plans/${id}/execute`, headers: as(token) })
    await app.inject({ method: 'POST', url: '/api/command', headers: as(token), payload: { text: 'alert if btc drops below 50k' } })
    expect(accounts.loadedCount).toBe(1)
    accounts.sweep()
    expect(accounts.loadedCount).toBe(0)
    const snap = (await app.inject({ url: '/api/snapshot', headers: as(token) })).json()
    expect(snap.positions[0]).toMatchObject({ coin: 'ETH', side: 'short', size: 1 })
    expect(snap.alerts).toHaveLength(1)
    await app.close()
  })
})
