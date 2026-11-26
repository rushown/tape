/**
 * Accumulates 16 kHz s16le mono PCM and runs a tiny energy-based VAD so the
 * user can just talk: recording stops ~1.4 s after they finish speaking.
 */
export const SAMPLE_RATE = 16_000
const MAX_SECONDS = 30
const SPEECH_RMS = 0.015
const END_SILENCE_MS = 1400
const NO_SPEECH_TIMEOUT_MS = 7000

export class Recorder {
  private chunks: Uint8Array[] = []
  private bytes = 0
  private heardSpeech = false
  private lastSpeechAt = 0
  private startedAt = 0
  level = 0

  start() {
    this.chunks = []
    this.bytes = 0
    this.heardSpeech = false
    this.startedAt = this.lastSpeechAt = performance.now()
    this.level = 0
  }

  get seconds() {
    return this.bytes / (SAMPLE_RATE * 2)
  }

  get speechDetected() {
    return this.heardSpeech
  }

  /** Returns 'stop' when the utterance is complete, 'timeout' if nobody spoke. */
  push(chunk: Uint8Array): 'continue' | 'stop' | 'timeout' {
    this.chunks.push(chunk)
    this.bytes += chunk.byteLength
    const rms = rmsOf(chunk)
    this.level = this.level * 0.6 + rms * 0.4
    const now = performance.now()
    if (rms > SPEECH_RMS) { this.heardSpeech = true; this.lastSpeechAt = now }
    if (this.seconds >= MAX_SECONDS) return 'stop'
    if (this.heardSpeech && now - this.lastSpeechAt > END_SILENCE_MS) return 'stop'
    if (!this.heardSpeech && now - this.startedAt > NO_SPEECH_TIMEOUT_MS) return 'timeout'
    return 'continue'
  }

  pcm(): Uint8Array {
    const out = new Uint8Array(this.bytes)
    let off = 0
    for (const c of this.chunks) { out.set(c, off); off += c.byteLength }
    return out
  }
}

export function rmsOf(chunk: Uint8Array): number {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  const n = Math.floor(chunk.byteLength / 2)
  if (!n) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = view.getInt16(i * 2, true) / 32768
    sum += v * v
  }
  return Math.sqrt(sum / n)
}

/**
 * Browser microphone → 16 kHz s16le chunks, used by the emulator (desktop
 * browser) so voice commands work without glasses.
 */
export async function startBrowserMic(onChunk: (pcm: Uint8Array) => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  const ctx = new AudioContext()
  const src = ctx.createMediaStreamSource(stream)
  const proc = ctx.createScriptProcessor(4096, 1, 1)
  const ratio = ctx.sampleRate / SAMPLE_RATE
  proc.onaudioprocess = ev => {
    const input = ev.inputBuffer.getChannelData(0)
    const outLen = Math.floor(input.length / ratio)
    const out = new Uint8Array(outLen * 2)
    const view = new DataView(out.buffer)
    for (let i = 0; i < outLen; i++) {
      // box-filter downsample
      const start = Math.floor(i * ratio)
      const end = Math.min(input.length, Math.floor((i + 1) * ratio))
      let acc = 0
      for (let j = start; j < end; j++) acc += input[j]!
      const s = Math.max(-1, Math.min(1, acc / Math.max(1, end - start)))
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
    onChunk(out)
  }
  src.connect(proc)
  proc.connect(ctx.destination)
  return () => {
    proc.disconnect()
    src.disconnect()
    stream.getTracks().forEach(t => t.stop())
    void ctx.close()
  }
}
