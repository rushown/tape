import { fetchRetry } from './lib/http.js'
import type { Config } from './config.js'

export const SAMPLE_RATE = 16_000
/** 60 s of 16-bit mono PCM at 16 kHz. */
export const MAX_PCM_BYTES = SAMPLE_RATE * 2 * 60

/** Wrap raw PCM s16le mono into a WAV container. */
export function pcmToWav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // PCM chunk size
  header.writeUInt16LE(1, 20) // format = PCM
  header.writeUInt16LE(1, 22) // channels
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** RMS level of s16le PCM in [0,1]; used to reject silent recordings early. */
export function pcmLevel(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2)
  if (!n) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768
    sum += v * v
  }
  return Math.sqrt(sum / n)
}

export interface SttProvider {
  readonly name: string
  transcribe(pcm: Buffer): Promise<string>
  /** Best-effort warm-up (e.g. download the model into a fresh local server). */
  prepare?(): Promise<void>
}

class OpenAiCompatibleStt implements SttProvider {
  readonly name: string
  constructor(private readonly cfg: Pick<Config, 'STT_API_KEY' | 'STT_BASE_URL' | 'STT_MODEL' | 'STT_LANGUAGE'> & { prompt?: string }) {
    this.name = `whisper · ${cfg.STT_MODEL.split('/').pop()}`
  }
  async transcribe(pcm: Buffer): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(pcmToWav(pcm))], { type: 'audio/wav' }), 'speech.wav')
    form.append('model', this.cfg.STT_MODEL)
    if (this.cfg.STT_LANGUAGE) form.append('language', this.cfg.STT_LANGUAGE)
    form.append('response_format', 'json')
    // Biases Whisper toward trading words and tickers ("short SOL", "90k") instead of look-alike phrases.
    if (this.cfg.prompt) form.append('prompt', this.cfg.prompt)
    const res = await fetchRetry(`${this.cfg.STT_BASE_URL.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
      // Local servers need no key; hosted ones (Groq, OpenAI) do.
      headers: this.cfg.STT_API_KEY ? { Authorization: `Bearer ${this.cfg.STT_API_KEY}` } : {},
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200)
      // A fresh speaches/faster-whisper server has no models yet: fetch it once and retry.
      if (res.status === 404 && !this.downloaded && (await this.download())) return this.transcribe(pcm)
      throw new Error(`STT HTTP ${res.status}: ${detail}`)
    }
    const json = (await res.json()) as { text?: string }
    return (json.text ?? '').trim()
  }

  private downloaded = false

  /** speaches exposes POST /v1/models/{id} to download a model; other servers just 404/405, which is fine. */
  private async download(): Promise<boolean> {
    this.downloaded = true
    try {
      const res = await fetchRetry(`${this.cfg.STT_BASE_URL.replace(/\/$/, '')}/models/${this.cfg.STT_MODEL}`, {
        method: 'POST',
        headers: this.cfg.STT_API_KEY ? { Authorization: `Bearer ${this.cfg.STT_API_KEY}` } : {},
        signal: AbortSignal.timeout(15 * 60_000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  async prepare() {
    // Only local servers: hosted APIs (Groq, OpenAI) have their models already.
    if (this.cfg.STT_API_KEY) return
    try {
      const res = await fetchRetry(`${this.cfg.STT_BASE_URL.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) return
      const json = (await res.json()) as { data?: Array<{ id: string }> }
      if (!json.data?.some(m => m.id === this.cfg.STT_MODEL)) await this.download()
    } catch {
      /* server not up yet; transcribe() retries the download on first use */
    }
  }
}

class DeepgramStt implements SttProvider {
  readonly name = 'deepgram'
  constructor(private readonly cfg: Pick<Config, 'STT_API_KEY' | 'STT_MODEL' | 'STT_LANGUAGE'>) {}
  async transcribe(pcm: Buffer): Promise<string> {
    const model = /whisper/i.test(this.cfg.STT_MODEL) ? 'nova-3' : this.cfg.STT_MODEL
    const q = new URLSearchParams({ model, smart_format: 'true', punctuate: 'true', language: this.cfg.STT_LANGUAGE || 'en' })
    const res = await fetchRetry(`https://api.deepgram.com/v1/listen?${q}`, {
      method: 'POST',
      headers: { Authorization: `Token ${this.cfg.STT_API_KEY}`, 'Content-Type': 'audio/wav' },
      body: new Uint8Array(pcmToWav(pcm)),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`Deepgram HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json = (await res.json()) as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } }
    return (json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim()
  }
}

/** Vocabulary hint for Whisper: the words Tape listens for. */
export const TRADING_PROMPT =
  'Buy 0.01 BTC. Short 2 ETH at 3,200. Long $500 of SOL. Close my BTC position. Close half of ETH. Close everything. ' +
  'Alert me if Bitcoin drops below 90k. Alert if PnL is below minus 200. Move 500 USDT from funding to trading. Cancel my orders. What is SOL at?'

export function createStt(cfg: Config): SttProvider | null {
  if (cfg.STT_PROVIDER === 'none') return null
  if (cfg.STT_PROVIDER === 'deepgram') return cfg.STT_API_KEY ? new DeepgramStt(cfg) : null
  return new OpenAiCompatibleStt({ ...cfg, prompt: TRADING_PROMPT })
}
