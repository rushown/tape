/**
 * Turns what the user said into one trading intent. Deliberately rules only:
 * no language model ever chooses a side, a size or a coin. Anything that is
 * not clear becomes "unknown" and the glasses show examples instead.
 */
import type { Side, Wallet } from './exchange/types.js'

export type Intent =
  | { kind: 'order'; side: Side; coin: string; qty?: number; usd?: number; price?: number }
  | { kind: 'close'; coin: string; fraction: number }
  | { kind: 'close_all' }
  | { kind: 'cancel_orders' }
  | { kind: 'transfer'; amount: number; from: Wallet; to: Wallet }
  /** value is a price, or with relativePct a signed % move from the current price. */
  | { kind: 'alert'; target: 'price'; coin: string; op?: 'above' | 'below'; value: number; relativePct?: number }
  | { kind: 'alert'; target: 'pnl'; op: 'above' | 'below'; value: number }
  | { kind: 'clear_alerts' }
  | { kind: 'price'; coin: string }
  | { kind: 'portfolio' }
  | { kind: 'orders' }
  | { kind: 'alerts' }
  | { kind: 'focus'; coin: string }
  | { kind: 'unknown'; reason?: string }

/** Spoken names (and common Whisper mishearings) → ticker. */
const COINS: Record<string, string> = {
  bitcoin: 'BTC', btc: 'BTC', 'bit coin': 'BTC', bitcoins: 'BTC',
  ethereum: 'ETH', ether: 'ETH', eth: 'ETH', 'e t h': 'ETH', etherium: 'ETH',
  solana: 'SOL', sol: 'SOL', salana: 'SOL', solano: 'SOL', soul: 'SOL', sole: 'SOL',
  ton: 'TON', toncoin: 'TON', 'ton coin': 'TON', tonne: 'TON', tonn: 'TON',
  bnb: 'BNB', binance: 'BNB', xrp: 'XRP', ripple: 'XRP', doge: 'DOGE', dogecoin: 'DOGE', dodge: 'DOGE',
  cardano: 'ADA', ada: 'ADA', avalanche: 'AVAX', avax: 'AVAX', chainlink: 'LINK', link: 'LINK',
  sui: 'SUI', sweet: 'SUI', litecoin: 'LTC', ltc: 'LTC', polkadot: 'DOT', dot: 'DOT', near: 'NEAR',
  hype: 'HYPE', hyperliquid: 'HYPE', arbitrum: 'ARB', arb: 'ARB', optimism: 'OP', aptos: 'APT', apt: 'APT',
  tron: 'TRX', trx: 'TRX', pepe: 'PEPE',
}

const SMALL: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}
const SCALE: Record<string, number> = { hundred: 100, thousand: 1_000, k: 1_000, grand: 1_000, million: 1_000_000 }

/** "ninety thousand" → "90000", "zero point zero one" → "0.01", "one hundred and fifty" → "150". */
export function wordsToDigits(text: string): string {
  const words = text.split(/\s+/)
  const out: string[] = []
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    const startsNumber = w in SMALL || ((w === 'a' || w === 'an') && words[i + 1]! in SCALE && words[i + 1] !== 'k') || (w === 'point' && /^\d/.test(out.at(-1) ?? 'x') === false && words[i + 1]! in SMALL)
    if (!startsNumber) { out.push(w); i++; continue }
    let total = 0
    let current = 0
    let any = false
    let decimals = ''
    while (i < words.length) {
      const x = words[i]!
      if (x in SMALL) { current += SMALL[x]!; any = true; i++; continue }
      if ((x === 'a' || x === 'an') && !any && words[i + 1]! in SCALE) { current = 1; any = true; i++; continue }
      if (x in SCALE && any) {
        const s = SCALE[x]!
        if (s === 100) current *= 100
        else { total += current * s; current = 0 }
        i++
        continue
      }
      if (x === 'and' && any && words[i + 1]! in SMALL) { i++; continue }
      if (x === 'point') {
        i++
        while (i < words.length && words[i]! in SMALL && SMALL[words[i]!]! < 10) { decimals += String(SMALL[words[i]!]); i++ }
        break
      }
      break
    }
    out.push(`${total + current}${decimals ? `.${decimals}` : ''}`)
  }
  return out.join(' ')
}

/** Lowercase, numbers as digits, "$500" → "500 usd", "90k" → "90000", "-200" kept. */
export function normalize(raw: string): string {
  let s = ` ${raw.toLowerCase()} `
    .replace(/[“”"!?]/g, ' ')
    .replace(/(\d),(?=\d{3}\b)/g, '$1') // 90,000 → 90000
    .replace(/p\s*&\s*l|p\.?\s*n\.?\s*l\.?|p and l|pnl/g, ' pnl ')
    .replace(/(\d)\s*%/g, '$1 percent')
    .replace(/[,;:]/g, ' ')
    .replace(/\.(?!\d)/g, ' ')
  s = wordsToDigits(s.replace(/\s+/g, ' ').trim())
  s = ` ${s} `
    .replace(/-\s*\$\s*(\d)/g, ' -$1') // -$200 → -200 (then usd marker below)
    .replace(/\$\s*(\d+(?:\.\d+)?)\s*(k|m)?\b/g, (_m, n: string, suf?: string) => ` ${scaled(n, suf)} usd `)
    .replace(/\b(\d+(?:\.\d+)?)\s*(k|m)\b/g, (_m, n: string, suf: string) => ` ${scaled(n, suf)} `)
    .replace(/\b(\d+(?:\.\d+)?)\s+(thousand|grand)\b/g, (_m, n: string) => ` ${Math.round(Number(n) * 1000)} `)
    .replace(/\b(?:minus|negative)\s+(\d)/g, ' -$1')
    .replace(/\b(dollars?|bucks|usdt|usdc|tether)\b/g, ' usd ')
    .replace(/\s+/g, ' ')
  return s.trim()
}

function scaled(n: string, suf?: string) {
  const k = suf === 'k' ? 1e3 : suf === 'm' ? 1e6 : 1
  return String(Math.round(Number(n) * k * 1e8) / 1e8)
}

const NOT_TICKERS = new Set(['usd', 'percent', 'of', 'at', 'worth', 'and', 'from', 'to', 'into', 'more', 'less', 'times', 'x', 'for', 'with', 'in', 'on', 'the', 'my', 'is', 'it', 'or', 'then', 'now', 'please', 'contracts', 'coins'])

export function findCoin(s: string): string | undefined {
  const padded = ` ${s} `
  let best: { coin: string; at: number } | undefined
  for (const [name, coin] of Object.entries(COINS)) {
    const at = padded.indexOf(` ${name} `)
    if (at >= 0 && (!best || at < best.at)) best = { coin, at }
  }
  if (best) return best.coin
  // Any explicit ticker like "arb" not in the list: three-to-five letter word right after an amount.
  for (const m of padded.matchAll(/\b\d+(?:\.\d+)?\s+(?:usd\s+(?:of|worth of)\s+)?([a-z]{2,6})\s/g)) {
    if (!NOT_TICKERS.has(m[1]!)) return m[1]!.toUpperCase()
  }
  return undefined
}

const has = (s: string, re: RegExp) => re.test(` ${s} `)

function wallet(word: string | undefined): Wallet | undefined {
  if (!word) return undefined
  if (/^(funding|fund|spot|wallet|savings|main)$/.test(word)) return 'funding'
  if (/^(trading|trade|margin|futures|perps?|derivatives|unified|contract|contracts)$/.test(word)) return 'trading'
  return undefined
}

export function parse(raw: string): Intent {
  const s = normalize(raw)
  if (!s) return { kind: 'unknown' }
  const coin = findCoin(s)
  const nums = [...s.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?/g)].map(m => ({ v: Number(m[0]), at: m.index! }))

  // Alerts first: "alert me if BTC goes below 90k" mentions a coin and a number like an order would.
  if (has(s, /\b(clear|cancel|delete|remove|stop)\b.*\balerts?\b/)) return { kind: 'clear_alerts' }
  if (has(s, /\b(alert|alerts|notify|ping me|warn me|tell me when|tell me if|let me know)\b/)) {
    const below = has(s, /\b(below|under|beneath|drops?|dips?|falls?|less than|lower than|down to|sinks?|loses)\b/)
    const above = has(s, /\b(above|over|rises?|more than|higher than|up to|breaks?|exceeds?|tops?|pumps?)\b/)
    const op = below && !above ? 'below' : above && !below ? 'above' : undefined
    const value = nums.at(-1)?.v
    if (has(s, /\b(pnl|profit|loss|down|up)\b/) && !coin) {
      if (value === undefined) return { kind: 'unknown', reason: 'Say a PnL level, e.g. "alert if PnL is below minus 200"' }
      // "if I'm down 200" / "loss of 200" means -200.
      const v = has(s, /\b(down|loss|losing)\b/) && value > 0 ? -value : value
      return { kind: 'alert', target: 'pnl', op: op ?? (v < 0 ? 'below' : 'above'), value: v }
    }
    if (!coin) return has(s, /\b(alerts|my alerts)\b/) && value === undefined ? { kind: 'alerts' } : { kind: 'unknown', reason: 'Which coin? e.g. "alert if BTC drops below 90k"' }
    const pct = s.match(/\b(\d+(?:\.\d+)?) percent\b/)
    if (pct) {
      const down = below || has(s, /\b(down|lower)\b/)
      const up = above || has(s, /\b(up|higher)\b/)
      if (down === up) return { kind: 'unknown', reason: `Up or down? e.g. "alert if ${coin} drops 5%"` }
      const p = Number(pct[1]) * (down ? -1 : 1)
      return { kind: 'alert', target: 'price', coin, op: down ? 'below' : 'above', value: 0, relativePct: p }
    }
    if (value === undefined || value <= 0) return { kind: 'unknown', reason: `At what price? e.g. "alert if ${coin} goes above ..."` }
    return { kind: 'alert', target: 'price', coin, ...(op ? { op } : {}), value }
  }

  // Only without a coin: "close all my ETH" must close ETH, never everything.
  if (!coin && (has(s, /\b(close|exit|flatten|kill|dump)\b.*\b(all|everything|every position|all positions)\b/) || has(s, /^\s*(flatten|panic)\b/))) {
    return { kind: 'close_all' }
  }
  if (has(s, /\b(cancel|kill|pull)\b.*\borders?\b/)) return { kind: 'cancel_orders' }

  // Transfers: "move 500 from funding to trading", "spot to margin".
  if (has(s, /\b(move|transfer|shift|send|put)\b/) && has(s, /\b(to|into|from)\b/) && !has(s, /\b(buy|sell|long|short)\b/)) {
    const from = wallet(s.match(/\bfrom (?:my |the )?(\w+)/)?.[1])
    const to = wallet(s.match(/\b(?:to|into) (?:my |the )?(\w+)/)?.[1])
    const amount = nums.find(n => n.v > 0)?.v
    if (amount === undefined) return { kind: 'unknown', reason: 'How much? e.g. "move 500 from funding to trading"' }
    const f = from ?? (to === 'funding' ? 'trading' : to === 'trading' ? 'funding' : undefined)
    const t = to ?? (f === 'funding' ? 'trading' : f === 'trading' ? 'funding' : undefined)
    if (!f || !t || f === t) return { kind: 'unknown', reason: 'Say which wallets, e.g. "from funding to trading"' }
    return { kind: 'transfer', amount, from: f, to: t }
  }

  if (has(s, /\b(close|exit|get out of|take profit on|take profits on|tp|cut|stop out)\b/) && coin) {
    let fraction = 1
    if (has(s, /\bhalf\b/)) fraction = 0.5
    else if (has(s, /\b(quarter|25 percent)\b/)) fraction = 0.25
    else if (has(s, /\bthird\b/)) fraction = 1 / 3
    else {
      const pct = s.match(/\b(\d+(?:\.\d+)?) percent\b/)
      if (pct) fraction = Math.min(1, Number(pct[1]) / 100)
    }
    if (!(fraction > 0)) return { kind: 'unknown', reason: 'How much to close?' }
    return { kind: 'close', coin, fraction }
  }

  const sideWord = s.match(/\b(buy|long|go long|sell|short|go short)\b/)?.[1]
  if (sideWord) {
    if (!coin) return { kind: 'unknown', reason: `${sideWord[0]!.toUpperCase()}${sideWord.slice(1)} what? e.g. "${sideWord} 0.01 BTC"` }
    const side: Side = /buy|long/.test(sideWord) ? 'buy' : 'sell'
    // Limit price: a number after "at"/"limit"/"@" (but not "at market").
    const priceM = s.match(/\b(?:at|limit|@|for a price of)\s+(?:price\s+)?(\d+(?:\.\d+)?)(?!\s*usd\s+(?:of|worth))/)
    const price = priceM ? Number(priceM[1]) : undefined
    const priceAt = priceM ? s.indexOf(priceM[0]) : -1
    const amounts = nums.filter(n => n.v > 0 && (priceAt < 0 || n.at < priceAt || n.at > priceAt + priceM![0].length))
    const first = amounts[0]
    if (!first) return { kind: 'unknown', reason: `How much ${coin}? e.g. "${side === 'buy' ? 'buy' : 'short'} 0.1 ${coin}" or "$500 of ${coin}"` }
    const after = s.slice(first.at, first.at + 24)
    const before = s.slice(Math.max(0, first.at - 10), first.at)
    const isUsd = /^\S+\s+usd\b/.test(after) || /\b(for|with|worth)\s+$/.test(before)
    return { kind: 'order', side, coin, ...(isUsd ? { usd: first.v } : { qty: first.v }), ...(price !== undefined ? { price } : {}) }
  }

  if (has(s, /\b(orders|open orders|my orders)\b/)) return { kind: 'orders' }
  if (has(s, /\b(alerts|my alerts)\b/)) return { kind: 'alerts' }
  if (has(s, /\b(watch|focus|follow|track|show me)\b/) && coin) return { kind: 'focus', coin }
  if (has(s, /\b(pnl|profit|how am i doing|how are we doing|positions?|portfolio|balance|equity|account|margin)\b/)) return { kind: 'portfolio' }
  if (coin) return { kind: 'price', coin }
  return { kind: 'unknown' }
}
