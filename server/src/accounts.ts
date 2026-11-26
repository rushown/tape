import { Desk, type DeskData, type DeskOptions } from './desk.js'
import { BYBIT_BASES, BybitExchange, type BybitEnv } from './exchange/bybit.js'
import { PaperExchange, type PaperData, paperDefaults } from './exchange/paper.js'
import type { PriceSource } from './exchange/prices.js'
import { ExchangeError, type Exchange } from './exchange/types.js'
import type { Database } from './lib/db.js'
import { HttpError } from './lib/errors.js'
import type { Logger } from './lib/logger.js'
import { unref } from './lib/timers.js'

export type ExchangeChoice =
  | { kind: 'paper' }
  | { kind: 'bybit'; env: BybitEnv; apiKey: string; apiSecret: string }

/** Stored sealed (AES-256-GCM): the only document holding exchange secrets. */
interface ExchangeDoc {
  kind: 'paper' | 'bybit'
  env?: BybitEnv
  apiKey?: string
  apiSecret?: string
}

export interface ExchangeInfo {
  kind: 'paper' | 'bybit'
  env?: BybitEnv
  keyHint?: string
  label: string
}

export interface AccountsOptions {
  db: Database
  /** One shared, cached feed for every paper account on this server. */
  prices: PriceSource
  paper: { start: number; leverage: number; feeBps: number }
  desk: Omit<DeskOptions, 'pollMs'> & { pollMs: number; watchlist: string[] }
  makeBybit?: (env: BybitEnv, key: string, secret: string) => BybitExchange
  log?: Logger
  /** Unload a user's desk after this long with no open stream and no request. */
  idleMs?: number
  /** At most this many desks polling at once (least recently used without a stream are unloaded first). */
  maxLoaded?: number
  /** Erase accounts unused for this many days (default 180). */
  retentionDays?: number
}

interface Loaded {
  desk: Desk
  lastUsed: number
  streams: number
}

/**
 * Hosted mode: anyone can start with a paper account in one tap, or connect
 * their own Bybit testnet / demo key. Each account gets its own desk (live
 * snapshot, alerts, confirm cards), loaded on first use and unloaded when idle.
 */
export class Accounts {
  private readonly loaded = new Map<string, Loaded>()
  private readonly loading = new Map<string, Promise<Desk>>()
  private sweeper?: ReturnType<typeof setInterval>
  private readonly idleMs: number
  private readonly maxLoaded: number
  private readonly retentionSec: number
  private readonly makeBybit: NonNullable<AccountsOptions['makeBybit']>

  constructor(private readonly o: AccountsOptions) {
    this.idleMs = o.idleMs ?? 20 * 60_000
    this.maxLoaded = o.maxLoaded ?? 300
    this.retentionSec = (o.retentionDays ?? 180) * 86400
    this.makeBybit = o.makeBybit ?? ((env, key, secret) => new BybitExchange(env, key, secret))
  }

  start() {
    this.sweeper = unref(setInterval(() => this.sweep(), 60_000))
  }

  async stop() {
    clearInterval(this.sweeper)
    for (const id of [...this.loaded.keys()]) this.unload(id)
  }

  get loadedCount() {
    return this.loaded.size
  }

  // ── Sign-up and tokens ──────────────────────────────────────────────────
  async signUp(choice: ExchangeChoice): Promise<{ token: string; exchange: ExchangeInfo; readOnly: boolean }> {
    const checked = await this.check(choice)
    const account = this.o.db.createAccount()
    this.writeExchange(account.id, choice)
    if (checked.readOnly) this.o.db.store<DeskData>(account.id, 'desk', this.deskDefaults()).update(d => { d.settings.readOnly = true })
    const token = this.o.db.issueToken(account.id, 'app')
    this.o.log?.info({ account: account.id, exchange: choice.kind }, 'account created')
    return { token, exchange: this.exchangeInfo(account.id), readOnly: checked.readOnly }
  }

  verify(token: string): string | undefined {
    return this.o.db.verifyToken(token)
  }

  logout(token: string) {
    this.o.db.revokeToken(token)
  }

  // ── Exchange connection ─────────────────────────────────────────────────
  /**
   * Proves a Bybit key works and is safe before it is stored: it must reach
   * the account, and must not be able to withdraw. A read-only key is
   * accepted and puts the desk in read-only mode.
   */
  private async check(choice: ExchangeChoice): Promise<{ readOnly: boolean }> {
    if (choice.kind === 'paper') return { readOnly: false }
    if (!(choice.env in BYBIT_BASES)) throw new HttpError(400, 'Only Bybit testnet and demo trading are supported', 'bad_env')
    const ex = this.makeBybit(choice.env, choice.apiKey, choice.apiSecret)
    try {
      await ex.start()
    } catch (err) {
      throw new HttpError(400, err instanceof ExchangeError ? err.message : 'Could not reach Bybit with this key', 'bad_key')
    }
    const info = await ex.keyInfo().catch(err => {
      this.o.log?.warn({ err: (err as Error).message }, 'key permission check unavailable')
      return null
    })
    if (info?.canWithdraw) {
      throw new HttpError(400, 'This key can withdraw funds. Tape never needs that: create a key without the Withdraw permission.', 'key_can_withdraw')
    }
    return { readOnly: Boolean(info && (info.readOnly || !info.canTrade)) }
  }

  private writeExchange(accountId: string, choice: ExchangeChoice) {
    const doc: ExchangeDoc = choice.kind === 'paper' ? { kind: 'paper' } : { kind: 'bybit', env: choice.env, apiKey: choice.apiKey, apiSecret: choice.apiSecret }
    void this.o.db.store<ExchangeDoc>(accountId, 'exchange', { kind: 'paper' }, true).update(d => Object.assign(d, { apiKey: undefined, apiSecret: undefined, env: undefined }, doc))
  }

  async setExchange(accountId: string, choice: ExchangeChoice): Promise<{ exchange: ExchangeInfo; readOnly: boolean }> {
    const checked = await this.check(choice)
    this.unload(accountId)
    this.writeExchange(accountId, choice)
    const desk = this.o.db.store<DeskData>(accountId, 'desk', this.deskDefaults())
    // A new key starts cautious: read-only if the key can't trade, otherwise as the user had it.
    if (checked.readOnly) await desk.update(d => { d.settings.readOnly = true })
    await desk.update(d => { d.alerts = [] }) // levels from another account's prices don't carry over
    this.o.log?.info({ account: accountId, exchange: choice.kind }, 'exchange changed')
    return { exchange: this.exchangeInfo(accountId), readOnly: checked.readOnly }
  }

  exchangeInfo(accountId: string): ExchangeInfo {
    const d = this.o.db.store<ExchangeDoc>(accountId, 'exchange', { kind: 'paper' }, true).get()
    if (d.kind === 'bybit' && d.apiKey) {
      return { kind: 'bybit', env: d.env, keyHint: `…${d.apiKey.slice(-4)}`, label: `Bybit ${d.env === 'demo' ? 'demo trading' : 'testnet'} · key …${d.apiKey.slice(-4)}` }
    }
    return { kind: 'paper', label: `Paper account · ${this.o.paper.leverage}x · prices: ${this.o.prices.name}` }
  }

  // ── Desks ───────────────────────────────────────────────────────────────
  private deskDefaults(): DeskData {
    const w = this.o.desk.watchlist
    return { settings: { watchlist: w, focus: w[0] ?? 'BTC', readOnly: false, maxOrderUsd: this.o.desk.maxOrderUsd }, alerts: [] }
  }

  private buildExchange(accountId: string): Exchange {
    const d = this.o.db.store<ExchangeDoc>(accountId, 'exchange', { kind: 'paper' }, true).get()
    if (d.kind === 'bybit' && d.apiKey && d.apiSecret && d.env) return this.makeBybit(d.env, d.apiKey, d.apiSecret)
    const store = this.o.db.store<PaperData>(accountId, 'paper', paperDefaults(this.o.paper.start))
    return new PaperExchange(store, this.o.prices, { leverage: this.o.paper.leverage, feeBps: this.o.paper.feeBps })
  }

  async desk(accountId: string): Promise<Desk> {
    const hit = this.loaded.get(accountId)
    if (hit) {
      hit.lastUsed = Date.now()
      return hit.desk
    }
    let p = this.loading.get(accountId)
    if (!p) {
      p = this.load(accountId).finally(() => this.loading.delete(accountId))
      this.loading.set(accountId, p)
    }
    return p
  }

  private async load(accountId: string): Promise<Desk> {
    if (!this.o.db.account(accountId)) throw new HttpError(401, 'This account no longer exists', 'unauthorized')
    this.makeRoom()
    const exchange = this.buildExchange(accountId)
    await exchange.start().catch(err => this.o.log?.warn({ account: accountId, err: (err as Error).message }, 'exchange start failed'))
    const store = this.o.db.store<DeskData>(accountId, 'desk', this.deskDefaults())
    // The server cap always wins over an older, higher stored limit.
    if (store.get().settings.maxOrderUsd > this.o.desk.maxOrderUsd) await store.update(d => { d.settings.maxOrderUsd = this.o.desk.maxOrderUsd })
    const desk = new Desk(exchange, store, this.o.desk, this.o.log?.child({ account: accountId }))
    // Answer quickly even if the exchange or price feed is slow: the first snapshot then arrives over the live stream.
    await Promise.race([desk.start(), new Promise(r => setTimeout(r, 2500))])
    this.loaded.set(accountId, { desk, lastUsed: Date.now(), streams: 0 })
    return desk
  }

  /** Count open live streams so an active user is never unloaded. Returns the release function. */
  holdStream(accountId: string): () => void {
    const l = this.loaded.get(accountId)
    if (!l) return () => {}
    l.streams++
    let released = false
    return () => {
      if (released) return
      released = true
      l.streams = Math.max(0, l.streams - 1)
      l.lastUsed = Date.now()
    }
  }

  private unload(accountId: string) {
    const l = this.loaded.get(accountId)
    if (!l) return
    l.desk.stop()
    void l.desk.exchange.stop()
    this.loaded.delete(accountId)
  }

  private makeRoom() {
    if (this.loaded.size < this.maxLoaded) return
    const idle = [...this.loaded.entries()].filter(([, l]) => l.streams === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    const victim = idle[0]
    if (!victim) throw new HttpError(503, 'Server is at capacity, try again in a minute', 'capacity')
    this.unload(victim[0])
  }

  sweep() {
    const cutoff = Date.now() - this.idleMs
    for (const [id, l] of this.loaded) if (l.streams === 0 && l.lastUsed < cutoff) this.unload(id)
    this.o.db.pruneTokens()
    // Data minimisation: accounts nobody has opened for RETENTION are erased (see PRIVACY.md).
    for (const id of this.o.db.staleAccountIds(this.retentionSec)) {
      if (this.loaded.has(id)) continue
      this.o.db.deleteAccount(id)
      this.o.log?.info({ account: id }, 'inactive account erased')
    }
  }

  // ── Account rights ──────────────────────────────────────────────────────
  async deleteAccount(accountId: string) {
    this.unload(accountId)
    this.o.db.deleteAccount(accountId)
    this.o.log?.info({ account: accountId }, 'account deleted')
  }

  /** Everything stored for the account, minus secrets (API keys are shown only as a hint). */
  export(accountId: string) {
    const a = this.o.db.account(accountId)
    if (!a) throw new HttpError(404, 'No such account', 'not_found')
    const read = (name: string) => {
      const raw = this.o.db.readDoc(accountId, name)
      return raw ? JSON.parse(raw) : null
    }
    return {
      account: { id: a.id, createdAt: new Date(a.createdAt * 1000).toISOString() },
      exchange: this.exchangeInfo(accountId),
      desk: read('desk'),
      paper: read('paper'),
      exportedAt: new Date().toISOString(),
    }
  }
}
