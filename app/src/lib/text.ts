const enc = new TextEncoder()
export const utf8Len = (s: string) => enc.encode(s).length

/** List items are capped at 63 UTF-8 bytes by the G2 protocol (64+ rejects the whole page). */
export const ITEM_BYTES = 63

/** Trim to at most `max` UTF-8 bytes (G2 protocol limits are in bytes), never splitting a character. */
export function fitBytes(s: string, max: number): string {
  if (utf8Len(s) <= max) return s
  let out = ''
  let bytes = 0
  const ell = utf8Len('…')
  for (const ch of Array.from(s)) {
    const b = utf8Len(ch)
    if (bytes + b + ell > max) break
    out += ch
    bytes += b
  }
  return `${out.trimEnd()}…`
}

/** The G2 firmware font has no emoji: drop supplementary-plane symbols and joiners. */
export function forGlasses(s: string): string {
  return s
    .replace(/[︎️‍\u{E0020}-\u{E007F}]/gu, '')
    .replace(/[\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/ +$/gm, '')
}

export function clip(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length <= n ? clean : `${clean.slice(0, Math.max(0, n - 1)).trimEnd()}…`
}

/** ~52 characters fit on a full-width G2 line (measured in the Even Hub simulator). */
export const LINE_CHARS = 52

export function wrap(text: string, width = LINE_CHARS): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (!para.trim()) { out.push(''); continue }
    let line = ''
    for (const word of para.split(/\s+/)) {
      if (!word) continue
      if ((line ? line.length + 1 : 0) + word.length > width) { if (line) out.push(line); line = word }
      else line = line ? `${line} ${word}` : word
    }
    if (line) out.push(line)
  }
  return out
}

export function paginate(text: string, lines = 7, width = LINE_CHARS): string[] {
  const all = wrap(text, width)
  const pages: string[] = []
  for (let i = 0; i < all.length; i += lines) pages.push(all.slice(i, i + lines).join('\n'))
  return pages.length ? pages : ['']
}

export function clock(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function levelBar(level: number, width = 16): string {
  const n = Math.max(0, Math.min(width, Math.round(Math.min(1, level * 6) * width)))
  return '█'.repeat(n) + '─'.repeat(width - n)
}
