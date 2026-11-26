import { join } from 'node:path'
import { pino } from 'pino'
import { Accounts } from './accounts.js'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { Desk, type DeskData } from './desk.js'
import { BybitExchange } from './exchange/bybit.js'
import { PaperExchange, type PaperData, paperDefaults } from './exchange/paper.js'
import { BinancePublic, BybitPublic, CachedPrices, OkxPublic, PriceFeed, SyntheticPrices } from './exchange/prices.js'
import type { Exchange } from './exchange/types.js'
import { Database, Sealer } from './lib/db.js'
import type { Logger } from './lib/logger.js'
import { JsonStore } from './lib/store.js'
import { createStt } from './stt.js'

const VERSION = '1.1.0'

async function main() {
  const cfg = loadConfig()
  const log = pino({
    level: cfg.LOG_LEVEL,
    redact: ['req.headers.authorization', 'token', '*.token', 'secret', '*.secret', 'apiKey', '*.apiKey', 'apiSecret', '*.apiSecret'],
    ...(cfg.PRETTY_LOGS ? { transport: { target: 'pino-pretty' } } : {}),
  }) as unknown as Logger

  const watchlist = cfg.WATCHLIST.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 8)
  const feed = new PriceFeed(cfg.PRICE_SOURCE === 'synthetic' ? [new SyntheticPrices()] : [new BybitPublic(), new BinancePublic(), new OkxPublic()])
  const prices = new CachedPrices(feed)
  const deskOpts = { maxOrderUsd: cfg.MAX_ORDER_USD, planTtlMs: cfg.PLAN_TTL_S * 1000, pollMs: cfg.POLL_MS }
  const stt = createStt(cfg)
  void stt?.prepare?.().then(() => log.info({ stt: stt.name }, 'speech-to-text ready'))

  let stopAll: () => Promise<void>
  let app: Awaited<ReturnType<typeof buildApp>>
  let label: string

  if (cfg.TAPE_MODE === 'hosted') {
    const db = new Database(cfg.DATABASE_PATH || join(cfg.DATA_DIR, 'tape.db'), new Sealer(cfg.DATA_KEY))
    const accounts = new Accounts({
      db, prices, log,
      paper: { start: cfg.PAPER_START_USDT, leverage: cfg.PAPER_LEVERAGE, feeBps: cfg.PAPER_FEE_BPS },
      desk: { ...deskOpts, watchlist },
      maxLoaded: cfg.MAX_LOADED_DESKS,
    })
    accounts.start()
    app = await buildApp({ accounts, stt, corsOrigins: cfg.CORS_ORIGINS, logger: log, version: VERSION, priceSource: () => prices.name, maxOrderUsd: cfg.MAX_ORDER_USD, signupLimit: cfg.SIGNUP_LIMIT_PER_HOUR })
    label = `hosted (${db.countAccounts()} accounts)`
    stopAll = async () => {
      await accounts.stop()
      db.close()
    }
  } else {
    let exchange: Exchange
    if (cfg.EXCHANGE === 'bybit') {
      exchange = new BybitExchange(cfg.BYBIT_ENV, cfg.BYBIT_API_KEY, cfg.BYBIT_API_SECRET)
    } else {
      const paperStore = await new JsonStore<PaperData>(cfg.DATA_DIR, 'paper', paperDefaults(cfg.PAPER_START_USDT)).load()
      exchange = new PaperExchange(paperStore, prices, { leverage: cfg.PAPER_LEVERAGE, feeBps: cfg.PAPER_FEE_BPS })
    }
    const deskStore = await new JsonStore<DeskData>(cfg.DATA_DIR, 'desk', {
      settings: { watchlist, focus: watchlist[0] ?? 'BTC', readOnly: cfg.READ_ONLY, maxOrderUsd: cfg.MAX_ORDER_USD },
      alerts: [],
    }).load()
    // The server cap always wins over a stored, older, higher user limit.
    if (deskStore.get().settings.maxOrderUsd > cfg.MAX_ORDER_USD) await deskStore.update(d => { d.settings.maxOrderUsd = cfg.MAX_ORDER_USD })
    if (cfg.READ_ONLY && !deskStore.get().settings.readOnly) await deskStore.update(d => { d.settings.readOnly = true })
    try {
      await exchange.start()
    } catch (err) {
      log.error({ err: (err as Error).message }, `${exchange.label}: could not connect; will keep retrying`)
    }
    const desk = new Desk(exchange, deskStore, deskOpts, log.child({ mod: 'desk' }))
    await desk.start()
    app = await buildApp({ desk, token: cfg.APP_TOKEN, stt, corsOrigins: cfg.CORS_ORIGINS, logger: log, version: VERSION, priceSource: () => prices.name, maxOrderUsd: cfg.MAX_ORDER_USD })
    label = exchange.label
    stopAll = async () => {
      desk.stop()
      await exchange.stop().catch(() => {})
      await deskStore.flush()
    }
  }

  await app.listen({ port: cfg.PORT, host: cfg.HOST })
  log.info({ mode: cfg.TAPE_MODE, exchange: label, prices: prices.name, stt: stt?.name ?? 'disabled', maxOrderUsd: cfg.MAX_ORDER_USD }, `Tape server v${VERSION} ready`)

  let down = false
  const shutdown = async (signal: string) => {
    if (down) return
    down = true
    log.info({ signal }, 'shutting down')
    const force = setTimeout(() => process.exit(1), 8000)
    force.unref()
    // Stopping desks first ends the live streams, so closing the server doesn't wait on them.
    await stopAll().catch(err => log.error({ err }, 'shutdown error'))
    await app.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', err => log.error({ err }, 'unhandled rejection'))
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
