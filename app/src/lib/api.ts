import type { CommandResult, ExchangeChoice, ExchangeInfo, Info, ServerEvent, Settings, Snapshot, Status } from './types'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

export interface ApiConfig {
  baseUrl: string
  token: string
}

/** Typed client for the Tape server. Every call times out; none can hang the glasses. */
export class Api {
  constructor(private cfg: ApiConfig) {}

  get configured() {
    return Boolean(this.cfg.baseUrl && this.cfg.token)
  }

  get config(): ApiConfig {
    return { ...this.cfg }
  }

  setConfig(cfg: ApiConfig) {
    this.cfg = { baseUrl: cfg.baseUrl.trim().replace(/\/+$/, ''), token: cfg.token.trim() }
  }

  /** Signed out: forget the token (the server URL stays). */
  clearToken() {
    this.cfg = { ...this.cfg, token: '' }
  }

  private async req<T>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number; raw?: BodyInit; anonymous?: boolean } = {}): Promise<T> {
    if (!this.configured && !(opts.anonymous && this.cfg.baseUrl)) throw new ApiError(0, 'not_configured', 'Server not configured')
    let res: Response
    try {
      res = await fetch(`${this.cfg.baseUrl}${path}`, {
        method,
        headers: {
          ...(this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}),
          ...(opts.raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      })
    } catch (err) {
      const timeout = (err as Error).name === 'TimeoutError'
      throw new ApiError(0, timeout ? 'timeout' : 'network', timeout ? 'Server took too long' : 'Cannot reach server')
    }
    const text = await res.text()
    let json: Record<string, unknown> = {}
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      throw new ApiError(res.status, 'bad_response', res.ok ? 'Unexpected reply from server' : `HTTP ${res.status}`)
    }
    if (!res.ok) throw new ApiError(res.status, String(json.error ?? 'error'), String(json.message ?? `HTTP ${res.status}`))
    return json as T
  }

  /** Public: which kind of server this is and how to start (works before sign-up). */
  info = () => this.req<Info>('GET', '/api/info', undefined, { anonymous: true, timeoutMs: 8000 })
  signUp = (choice: ExchangeChoice) =>
    this.req<{ token: string; exchange: ExchangeInfo; readOnly: boolean }>('POST', '/api/auth/signup', choice, { anonymous: true, timeoutMs: 30_000 })
  account = () => this.req<{ id: string; exchange: ExchangeInfo }>('GET', '/api/account')
  setExchange = (choice: ExchangeChoice) => this.req<{ exchange: ExchangeInfo; readOnly: boolean }>('PUT', '/api/account/exchange', choice, { timeoutMs: 30_000 })
  exportAccount = () => this.req<Record<string, unknown>>('GET', '/api/account/export')
  signOut = () => this.req<{ ok: boolean }>('POST', '/api/auth/logout', {})
  deleteAccount = () => this.req<{ ok: boolean }>('DELETE', '/api/account', { confirm: 'DELETE' })
  status = () => this.req<Status>('GET', '/api/status', undefined, { timeoutMs: 8000 })
  snapshot = () => this.req<Snapshot>('GET', '/api/snapshot')
  command = (text: string) => this.req<{ transcript: string; result: CommandResult }>('POST', '/api/command', { text }, { timeoutMs: 20_000 })
  voice = (pcm: Uint8Array) =>
    this.req<{ transcript: string; result: CommandResult }>('POST', '/api/voice', undefined, { raw: new Blob([pcm as BlobPart]), timeoutMs: 45_000 })
  execute = (planId: string) => this.req<{ title: string; body: string }>('POST', `/api/plans/${planId}/execute`, {}, { timeoutMs: 20_000 })
  cancelPlan = (planId: string) => this.req<{ ok: boolean }>('POST', `/api/plans/${planId}/cancel`, {})
  saveSettings = (s: Partial<Settings>) => this.req<Settings>('PUT', '/api/settings', s)
  removeAlert = (id: string) => this.req<{ ok: boolean }>('DELETE', `/api/alerts/${encodeURIComponent(id)}`)
  nudge = (coin: string, pct: number) => this.req<Snapshot>('POST', '/api/demo/nudge', { coin, pct })

  /** Live snapshots, alerts and fills. Reconnects on its own; returns a disposer. */
  events(onEvent: (e: ServerEvent) => void, onState?: (connected: boolean) => void): () => void {
    if (!this.configured) return () => {}
    let es: EventSource | null = null
    let stopped = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const open = () => {
      es = new EventSource(`${this.cfg.baseUrl}/api/events?token=${encodeURIComponent(this.cfg.token)}`)
      for (const type of ['snapshot', 'alert', 'fill']) {
        es.addEventListener(type, ev => {
          try { onEvent(JSON.parse((ev as MessageEvent).data) as ServerEvent) } catch { /* ignore malformed */ }
        })
      }
      es.onopen = () => onState?.(true)
      es.onerror = () => {
        onState?.(false)
        if (es?.readyState === EventSource.CLOSED && !stopped) {
          es = null
          retry = setTimeout(open, 4000)
        }
      }
    }
    open()
    return () => {
      stopped = true
      clearTimeout(retry)
      es?.close()
    }
  }
}
