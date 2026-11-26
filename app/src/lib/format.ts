import { fitBytes, ITEM_BYTES } from './text'
import type { Alert, Mode, Position, Snapshot, Ticker } from './types'

export function usd(v: number, sign = false): string {
  const abs = Math.abs(v)
  const s = abs >= 10_000
    ? abs.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${v < 0 ? '-' : sign ? '+' : ''}$${s}`
}

export function price(v: number): string {
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 })
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 3 })
  return v.toPrecision(4)
}

export const qty = (v: number) => Number(v.toPrecision(8)).toString()
export function pct(v: number): string {
  const s = v.toFixed(Math.abs(v) >= 10 ? 0 : 1)
  // Avoid "-0.0%" for tiny losses.
  return Number(s) === 0 ? '0.0%' : `${v > 0 ? '+' : ''}${s}%`
}

export function modeLabel(m: Mode): string {
  return m === 'paper' ? 'PAPER' : m === 'bybit-demo' ? 'DEMO' : 'TESTNET'
}

/** One position on one line: fits a 63-byte list item. */
export function positionLine(p: Position): string {
  return fitBytes(`${p.side === 'long' ? 'LONG ' : 'SHORT'} ${p.coin} ${qty(p.size)} · ${usd(p.upnl, true)} ${pct(p.upnlPct)}`, ITEM_BYTES)
}

export function tickerLine(t: Ticker): string {
  return `${t.coin} ${price(t.last)} ${pct(t.change24hPct)}`
}

export function alertLine(a: Alert): string {
  return fitBytes(a.target === 'pnl' ? `PnL today ${a.op} ${usd(a.value, true)}` : `${a.coin} ${a.op} ${price(a.value)}`, ITEM_BYTES)
}

/**
 * The home screen: today's PnL first (the one number a trader glances for),
 * then the focused coin, then the biggest positions. 7 lines max.
 */
export function homeBody(s: Snapshot | null, focus: string): string {
  if (!s || !s.account) return s?.error ? `Exchange unreachable:\n${s.error}` : 'Loading account…'
  const a = s.account
  const base = a.equity - a.dayPnl
  const dayPct = base > 0 ? (a.dayPnl / base) * 100 : 0
  const lines = [
    `TODAY ${usd(a.dayPnl, true)} ${pct(dayPct)}   OPEN ${usd(a.upnl, true)}`,
    `Equity ${usd(a.equity)} · free ${usd(a.available)}`,
  ]
  const f = s.tickers.find(t => t.coin === focus) ?? s.tickers[0]
  const others = s.tickers.filter(t => t !== f).slice(0, 2)
  lines.push(f ? `▶ ${tickerLine(f)}${others.length ? `   ${others.map(t => `${t.coin} ${price(t.last)}`).join('  ')}` : ''}` : '')
  if (s.positions.length) {
    for (const p of s.positions.slice(0, 3)) lines.push(positionLine(p))
    if (s.positions.length > 3) lines.push(`+${s.positions.length - 3} more · tap to see all`)
  } else {
    lines.push('No open positions')
  }
  const extras = [s.orders.length ? `${s.orders.length} order${s.orders.length === 1 ? '' : 's'}` : '', s.alerts.length ? `${s.alerts.length} alert${s.alerts.length === 1 ? '' : 's'}` : ''].filter(Boolean)
  if (extras.length && lines.length < 7) lines.push(extras.join(' · '))
  if (s.error) lines[lines.length - 1] = `! stale: ${s.error}`.slice(0, 52)
  return lines.join('\n')
}

export function positionBody(p: Position): string {
  return [
    `${p.side.toUpperCase()} ${qty(p.size)} ${p.coin} · ${usd(p.notional)}`,
    `Entry ${price(p.entry)} · mark ${price(p.mark)}`,
    `PnL ${usd(p.upnl, true)} (${pct(p.upnlPct)} on margin)${p.liq ? ` · liq ${price(p.liq)}` : ''}`,
  ].join('\n')
}
