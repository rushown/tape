import { timingSafeEqual } from 'node:crypto'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance, type FastifyRequest, LogController } from 'fastify'
import { z, ZodError } from 'zod'
import type { Accounts } from './accounts.js'
import type { Desk, DeskEvent } from './desk.js'
import { symbolOf } from './exchange/types.js'
import { badRequest, HttpError } from './lib/errors.js'
import type { Logger } from './lib/logger.js'
import { MAX_PCM_BYTES, pcmLevel, type SttProvider } from './stt.js'

export interface AppDeps {
  stt: SttProvider | null
  corsOrigins: string
  logger?: Logger
  version?: string
  priceSource?: () => string
  /** Server ceiling for any order or transfer (users can only lower it). */
  maxOrderUsd: number
  /** Self-hosted: one desk behind one shared token. */
  desk?: Desk
  token?: string
  /** Hosted: many users, each with their own account and desk. */
  accounts?: Accounts
  /** Hosted: new accounts allowed per IP per hour (default 5). */
  signupLimit?: number
}

declare module 'fastify' {
  interface FastifyRequest {
    desk: Desk
    accountId?: string
    bearer?: string
  }
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const SettingsBody = z.object({
  watchlist: z.array(z.string().max(12)).max(8).optional(),
  focus: z.string().max(12).optional(),
  readOnly: z.boolean().optional(),
  maxOrderUsd: z.number().positive().max(1_000_000).optional(),
}).strict()

const CommandBody = z.object({ text: z.string().trim().min(1).max(300) })
const NudgeBody = z.object({ coin: z.string().min(2).max(10), pct: z.number().min(-50).max(50) })
const ExchangeBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('paper') }),
  z.object({
    kind: z.literal('bybit'),
    env: z.enum(['testnet', 'demo']),
    apiKey: z.string().trim().min(10).max(64).regex(/^[A-Za-z0-9]+$/, 'API key has unexpected characters'),
    apiSecret: z.string().trim().min(10).max(128).regex(/^[A-Za-z0-9]+$/, 'API secret has unexpected characters'),
  }),
])

/** Min speech length (0.4 s) and loudness before a clip is worth transcribing. */
const MIN_PCM_BYTES = 16_000 * 2 * 0.4
const MIN_LEVEL = 0.004
const PUBLIC = new Set(['/api/info', '/api/auth/signup'])

export async function buildApp(d: AppDeps): Promise<FastifyInstance> {
  if (!d.accounts && !(d.desk && d.token)) throw new Error('buildApp needs accounts (hosted) or desk + token (self-hosted)')
  const hosted = Boolean(d.accounts)
  const origins = d.corsOrigins === '*' ? null : d.corsOrigins.split(',').map(s => s.trim()).filter(Boolean)
  const app = Fastify({
    ...(d.logger ? { loggerInstance: d.logger } : { logger: false }),
    trustProxy: true,
    // Default request logs would include ?token= on the SSE route; a sanitized line is logged instead.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
    requestTimeout: 60_000,
  })

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_PCM_BYTES + 1024 }, (_req, body, done) => done(null, body))
  await app.register(cors, { origin: origins ?? true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type'], maxAge: 86400 })
  // Per account once known (after auth), else per IP.
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', hook: 'preHandler', keyGenerator: req => (req as FastifyRequest).accountId ?? req.ip })

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('Cache-Control', reply.getHeader('Cache-Control') ?? 'no-store')
  })
  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/health') return
    req.log.info({ method: req.method, url: req.url.replace(/token=[^&]*/g, 'token=***'), status: reply.statusCode, ms: Math.round(reply.elapsedTime), account: req.accountId }, 'request')
  })

  app.decorateRequest('desk', null as unknown as Desk)
  app.addHook('onRequest', async req => {
    const path = req.url.split('?')[0]!
    if (!path.startsWith('/api/') || req.method === 'OPTIONS' || PUBLIC.has(path)) return
    const header = req.headers.authorization ?? ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    // EventSource cannot send headers, so the SSE route alone accepts ?token=
    const query = path === '/api/events' ? ((req.query as { token?: string }).token ?? '') : ''
    const token = bearer || query
    if (d.accounts) {
      const accountId = token ? d.accounts.verify(token) : undefined
      if (!accountId) throw new HttpError(401, 'Sign in again', 'unauthorized')
      req.accountId = accountId
      req.bearer = token
      // Account routes that must work even if the exchange is unreachable don't load a desk.
      if (path.startsWith('/api/account') || path === '/api/auth/logout') return
      req.desk = await d.accounts.desk(accountId)
      return
    }
    if (!safeEqual(token, d.token!)) throw new HttpError(401, 'Invalid or missing token', 'unauthorized')
    req.desk = d.desk!
  })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: 'bad_request', message: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') })
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.code, message: err.message })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.status(status).send({ error: status === 429 ? 'rate_limited' : 'request_error', message: (err as Error).message })
    req.log.error({ err }, 'unhandled error')
    return reply.status(500).send({ error: 'internal', message: 'Something went wrong on the server' })
  })

  app.get('/health', async () => ({ ok: true }))

  /** Public: how to start on this server (no token needed). */
  app.get('/api/info', async () => ({
    version: d.version ?? 'dev',
    mode: hosted ? 'hosted' : 'self',
    signup: hosted ? ['paper', 'bybit-testnet', 'bybit-demo'] : [],
    voice: Boolean(d.stt),
    maxOrderUsd: d.maxOrderUsd,
  }))

  app.get('/api/status', async req => {
    const snap = req.desk.snapshot
    return {
      version: d.version ?? 'dev',
      hosted,
      mode: req.desk.exchange.mode,
      exchange: { label: req.desk.exchange.label, connected: Boolean(snap.account) && !snap.error, error: snap.error ?? null },
      prices: req.desk.exchange.mode === 'paper' ? (d.priceSource?.() ?? null) : req.desk.exchange.mode === 'bybit-demo' ? 'Bybit (mainnet prices)' : 'Bybit testnet',
      stt: d.stt?.name ?? null,
      maxOrderUsd: d.maxOrderUsd,
      settings: req.desk.settings,
    }
  })

  app.get('/api/snapshot', async req => req.desk.snapshot)

  app.get('/api/events', async (req, reply) => {
    const desk = req.desk
    reply.hijack()
    const res = reply.raw
    const origin = req.headers.origin
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': origin && (!origins || origins.includes(origin)) ? origin : origins?.[0] ?? '*',
    })
    const release = req.accountId ? d.accounts!.holdStream(req.accountId) : () => {}
    let off = () => {}
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
    const close = () => { clearInterval(ping); off(); release() }
    const send = (e: DeskEvent) => {
      if (e.type === 'closed') { close(); res.end(); return } // the client reconnects to a fresh desk
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    }
    send({ type: 'snapshot', snapshot: desk.snapshot })
    off = desk.subscribe(send)
    req.raw.on('close', close)
  })

  app.post('/api/command', async req => {
    const { text } = CommandBody.parse(req.body)
    return { transcript: text, result: await req.desk.command(text) }
  })

  app.post('/api/voice', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async req => {
    if (!d.stt) throw new HttpError(503, 'Speech-to-text is not configured on the server', 'stt_unavailable')
    const pcm = req.body
    if (!Buffer.isBuffer(pcm)) throw badRequest('Send raw 16 kHz s16le PCM as application/octet-stream')
    if (pcm.length < MIN_PCM_BYTES) throw new HttpError(400, 'Too short', 'too_short')
    if (pcmLevel(pcm) < MIN_LEVEL) throw new HttpError(400, 'Only silence was recorded', 'silence')
    const transcript = await d.stt.transcribe(pcm).catch(err => {
      req.log.warn({ err: (err as Error).message }, 'stt failed')
      throw new HttpError(502, 'Speech-to-text failed, try again', 'stt_failed')
    })
    if (!transcript) throw new HttpError(400, "Didn't catch that", 'silence')
    return { transcript, result: await req.desk.command(transcript) }
  })

  app.post('/api/plans/:id/execute', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => req.desk.execute((req.params as { id: string }).id))
  app.post('/api/plans/:id/cancel', async req => {
    req.desk.cancelPlan((req.params as { id: string }).id)
    return { ok: true }
  })

  app.get('/api/settings', async req => req.desk.settings)
  app.put('/api/settings', async req => req.desk.updateSettings(SettingsBody.parse(req.body)))
  app.delete('/api/alerts/:id', async req => ({ ok: await req.desk.removeAlert((req.params as { id: string }).id) }))

  /** Paper mode only: move a price to show an alert or PnL change in a demo. Affects only this account. */
  app.post('/api/demo/nudge', async req => {
    const ex = req.desk.exchange
    if (!ex.nudge) throw new HttpError(404, 'Only available on a paper account', 'not_paper')
    const { coin, pct } = NudgeBody.parse(req.body)
    ex.nudge(symbolOf(coin.toUpperCase()), pct)
    return req.desk.refresh()
  })

  // ── Hosted accounts ───────────────────────────────────────────────────
  if (d.accounts) {
    const accounts = d.accounts
    app.post('/api/auth/signup', { config: { rateLimit: { max: d.signupLimit ?? 5, timeWindow: '1 hour', keyGenerator: (r: FastifyRequest) => r.ip } } }, async req => {
      return accounts.signUp(ExchangeBody.parse(req.body))
    })
    app.post('/api/auth/logout', async req => {
      accounts.logout(req.bearer!)
      return { ok: true }
    })
    app.get('/api/account', async req => ({ id: req.accountId, exchange: accounts.exchangeInfo(req.accountId!) }))
    app.put('/api/account/exchange', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async req => accounts.setExchange(req.accountId!, ExchangeBody.parse(req.body)))
    app.get('/api/account/export', async (req, reply) => {
      reply.header('Content-Disposition', 'attachment; filename="tape-export.json"')
      return accounts.export(req.accountId!)
    })
    app.delete('/api/account', async req => {
      const { confirm } = z.object({ confirm: z.literal('DELETE') }).parse(req.body)
      void confirm
      await accounts.deleteAccount(req.accountId!)
      return { ok: true }
    })
  }

  return app
}
