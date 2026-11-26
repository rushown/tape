import { z } from 'zod'

const bool = z
  .string()
  .optional()
  .transform(v => v === '1' || v?.toLowerCase() === 'true')

const schema = z
  .object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().int().positive().default(8791),
    HOST: z.string().default('0.0.0.0'),
    /** self = one trader, one shared APP_TOKEN, exchange from this file. hosted = anyone signs up in the app; data in SQLite. */
    TAPE_MODE: z.enum(['self', 'hosted']).default('self'),
    APP_TOKEN: z.string().default(''),
    /** hosted: 32-byte key that encrypts users' exchange API keys at rest (openssl rand -hex 32). */
    DATA_KEY: z.string().default(''),
    /** hosted: SQLite file (default DATA_DIR/tape.db). */
    DATABASE_PATH: z.string().default(''),
    /** hosted: new accounts per IP per hour. */
    SIGNUP_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(5),
    /** hosted: desks polling at once; idle ones are unloaded first. */
    MAX_LOADED_DESKS: z.coerce.number().int().min(1).default(300),
    CORS_ORIGINS: z.string().default('*'),
    DATA_DIR: z.string().default('./data'),
    LOG_LEVEL: z.string().default('info'),
    PRETTY_LOGS: bool,

    /** paper = simulated account on real public prices (no keys). bybit = Bybit testnet or demo trading. */
    EXCHANGE: z.enum(['paper', 'bybit']).default('paper'),
    /** Only non-mainnet Bybit environments exist here, on purpose. */
    BYBIT_ENV: z.enum(['testnet', 'demo']).default('testnet'),
    BYBIT_API_KEY: z.string().default(''),
    BYBIT_API_SECRET: z.string().default(''),

    /** Paper: where prices come from. auto = real public prices (Bybit, then Binance, then OKX). synthetic = offline random walk, for demos without internet only. */
    PRICE_SOURCE: z.enum(['auto', 'synthetic']).default('auto'),
    PAPER_START_USDT: z.coerce.number().positive().default(10_000),
    PAPER_LEVERAGE: z.coerce.number().min(1).max(50).default(10),
    PAPER_FEE_BPS: z.coerce.number().min(0).max(100).default(5.5),

    /** Safety: no single order or transfer above this many USD, whatever the user says. */
    MAX_ORDER_USD: z.coerce.number().positive().default(2500),
    /** Start with trading switched off (view and alerts only). The phone can turn it on/off at runtime. */
    READ_ONLY: bool,
    /** A confirm card is only valid this long; prices move. */
    PLAN_TTL_S: z.coerce.number().int().min(5).max(300).default(30),
    WATCHLIST: z.string().default('BTC,ETH,SOL,XRP'),
    POLL_MS: z.coerce.number().int().min(1000).default(3000),

    STT_PROVIDER: z.enum(['whisper', 'openai', 'deepgram', 'none']).default('whisper'),
    STT_API_KEY: z.string().default(''),
    STT_BASE_URL: z.string().url().default('http://127.0.0.1:8000/v1'),
    STT_MODEL: z.string().default('Systran/faster-whisper-small'),
    STT_LANGUAGE: z.string().default('en'),
  })
  .superRefine((c, ctx) => {
    if (c.TAPE_MODE === 'self' && c.APP_TOKEN.length < 16) ctx.addIssue({ code: 'custom', path: ['APP_TOKEN'], message: 'APP_TOKEN must be at least 16 characters (openssl rand -hex 24)' })
    if (c.TAPE_MODE === 'hosted' && !/^([0-9a-f]{64}|[A-Za-z0-9+/]{43}=)$/i.test(c.DATA_KEY)) {
      ctx.addIssue({ code: 'custom', path: ['DATA_KEY'], message: 'TAPE_MODE=hosted needs DATA_KEY (generate with: openssl rand -hex 32)' })
    }
    if (c.TAPE_MODE === 'self' && c.EXCHANGE === 'bybit' && (!c.BYBIT_API_KEY || !c.BYBIT_API_SECRET)) {
      ctx.addIssue({ code: 'custom', message: 'EXCHANGE=bybit needs BYBIT_API_KEY and BYBIT_API_SECRET (create them on testnet.bybit.com)' })
    }
  })

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => `  - ${i.path.join('.') || 'config'}: ${i.message}`).join('\n')
    throw new Error(`Invalid configuration:\n${msg}`)
  }
  return parsed.data
}
