import { OsEventTypeList, validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk'
import { describe, expect, it } from 'vitest'
import { Controller } from '../src/glasses/controller'
import { homeBody, positionLine } from '../src/lib/format'
import type { Api } from '../src/lib/api'
import { Glasses } from '../src/lib/glasses'
import type { Plan, ServerEvent, Snapshot } from '../src/lib/types'

type Container = Record<string, any>
const pages: Container[] = []
const textUpdates: Container[] = []
const calls: string[] = []
let emit: (e: any) => void = () => {}

const fakeBridge = {
  onEvenHubEvent: (cb: (e: any) => void) => { emit = cb; return () => {} },
  createStartUpPageContainer: async (c: Container) => { calls.push('create'); pages.push(c); return 0 },
  rebuildPageContainer: async (c: Container) => { calls.push('rebuild'); pages.push(c); return true },
  textContainerUpgrade: async (c: Container) => { textUpdates.push(c); return true },
  audioControl: async (on: boolean) => { calls.push(`mic:${on}`); return true },
  shutDownPageContainer: async (m: number) => { calls.push(`exit:${m}`); return true },
  getLocalStorage: async () => '',
  setLocalStorage: async () => true,
}

const snap: Snapshot = {
  at: 1, mode: 'paper',
  account: { equity: 10_128.4, available: 8_410.2, upnl: 69.3, funding: 1000, dayPnl: 128.4 },
  positions: [
    { symbol: 'BTCUSDT', coin: 'BTC', side: 'long', size: 0.05, entry: 90_100, mark: 91_240, upnl: 57, upnlPct: 12.65, notional: 4562 },
    { symbol: 'SOLUSDT', coin: 'SOL', side: 'short', size: 10, entry: 142.1, mark: 140.87, upnl: 12.3, upnlPct: 8.66, notional: 1408.7 },
    { symbol: 'DOGEUSDT', coin: 'DOGE', side: 'long', size: 123_456_789, entry: 0.17123, mark: 0.17, upnl: -151_851.85, upnlPct: -71.8, notional: 20_987_654 },
    { symbol: 'ETHUSDT', coin: 'ETH', side: 'long', size: 1, entry: 3000, mark: 3100, upnl: 100, upnlPct: 33, notional: 3100 },
  ],
  tickers: [
    { symbol: 'BTCUSDT', coin: 'BTC', last: 91_240, change24hPct: 1.2 },
    { symbol: 'ETHUSDT', coin: 'ETH', last: 3100, change24hPct: -0.4 },
    { symbol: 'SOLUSDT', coin: 'SOL', last: 140.87, change24hPct: 3.3 },
  ],
  orders: [{ id: 'o1', symbol: 'ETHUSDT', coin: 'ETH', side: 'buy', qty: 0.5, price: 2900, reduceOnly: false }],
  alerts: [{ id: 'a1', target: 'price', coin: 'BTC', op: 'below', value: 90_000, createdAt: 1 }],
  settings: { watchlist: ['BTC', 'ETH', 'SOL'], focus: 'BTC', readOnly: false, maxOrderUsd: 2500 },
}

const plan = (p: Partial<Plan>): Plan => ({ id: 'p1', kind: 'close', title: 'Close LONG BTC?', body: '0.05 of 0.05 BTC @ market ~91,240\nLocks in about +$57.00', confirm: 'Close BTC', cancel: 'Keep it', danger: false, expiresAt: Date.now() + 30_000, ...p })
const commands: string[] = []
let pushEvent: (e: ServerEvent) => void = () => {}
const fakeApi = {
  configured: true,
  config: { baseUrl: 'http://x', token: 't' },
  status: async () => ({ version: '1', mode: 'paper', exchange: { label: 'Paper', connected: true, error: null }, prices: 'Bybit', stt: 'fake', maxOrderUsd: 2500, settings: snap.settings }),
  snapshot: async () => snap,
  events: (fn: (e: ServerEvent) => void) => { pushEvent = fn; return () => {} },
  command: async (text: string) => {
    commands.push(text)
    if (text === 'close everything') return { transcript: text, result: { type: 'confirm', plan: plan({ id: 'p2', kind: 'close_all', title: 'Close ALL 4 positions?', confirm: 'Close all', cancel: 'Cancel', danger: true }) } }
    return { transcript: text, result: { type: 'confirm', plan: plan({}) } }
  },
  voice: async () => ({ transcript: 'close everything', result: { type: 'confirm', plan: plan({ id: 'p2', kind: 'close_all', title: 'Close ALL 4 positions?', confirm: 'Close all', cancel: 'Cancel', danger: true }) } }),
  execute: async (id: string) => { calls.push(`execute:${id}`); return { title: 'BTC closed', body: '0.05 @ 91,240' } },
  cancelPlan: async (id: string) => { calls.push(`cancel:${id}`); return { ok: true } },
  saveSettings: async () => snap.settings,
  removeAlert: async () => ({ ok: true }),
} as unknown as Api

const tick = () => new Promise(r => setTimeout(r, 20))
const loud = () => { const b = new Uint8Array(3200); const v = new DataView(b.buffer); for (let i = 0; i < 1600; i++) v.setInt16(i * 2, Math.round(Math.sin(i / 3) * 12000), true); return b }
const items = () => pages.at(-1)!.listObject[0].itemContainer.itemName as string[]
const header = () => pages.at(-1)!.textObject[0].content as string

function checkPage(c: Container) {
  const v = validateEvenHubPageContainer(c as any)
  expect(v.valid, JSON.stringify(v)).toBe(true)
  const all = [...(c.textObject ?? []), ...(c.listObject ?? [])]
  expect(all.filter((x: Container) => x.isEventCapture === 1)).toHaveLength(1)
  for (const x of all) {
    expect(x.containerName.length).toBeLessThanOrEqual(16)
    expect(x.xPosition + x.width).toBeLessThanOrEqual(576)
    expect(x.yPosition + x.height).toBeLessThanOrEqual(288)
  }
  for (const l of c.listObject ?? []) {
    expect(l.itemContainer.itemCount).toBeLessThanOrEqual(20)
    for (const n of l.itemContainer.itemName) expect(new TextEncoder().encode(n).length).toBeLessThanOrEqual(63)
  }
}

describe('format', () => {
  it('keeps every list label within 63 bytes and the home screen within 7 short lines', () => {
    for (const p of snap.positions) expect(new TextEncoder().encode(positionLine(p)).length).toBeLessThanOrEqual(63)
    const lines = homeBody(snap, 'BTC').split('\n')
    expect(lines.length).toBeLessThanOrEqual(7)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(56)
    expect(lines[0]).toBe('TODAY +$128.40 +1.3%   OPEN +$69.30')
    expect(lines[2]).toBe('▶ BTC 91,240 +1.2%   ETH 3,100  SOL 140.87')
  })
})

describe('controller on a (fake) G2', () => {
  it('home → positions → close → confirm → done, alert flash, danger card, voice', async () => {
    const g = new (Glasses as any)(fakeBridge) as Glasses
    const c = new Controller(g, fakeApi)
    await c.start()
    expect(calls.filter(x => x === 'create')).toHaveLength(1)
    expect(header()).toMatch(/^TAPE · PAPER · \d\d:\d\d$/)
    expect(pages.at(-1)!.textObject[1].content).toContain('TODAY +$128.40')

    // swipe changes the focused coin in place (no rebuild)
    const n = pages.length
    emit({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })
    await tick()
    expect(pages.length).toBe(n)
    expect(textUpdates.at(-1)!.content).toContain('▶ ETH 3,100')

    // live snapshot updates the body in place
    pushEvent({ type: 'snapshot', snapshot: { ...snap, account: { ...snap.account!, dayPnl: -20 } } })
    await tick()
    expect(pages.length).toBe(n)
    expect(textUpdates.some(t => String(t.content).startsWith('TODAY -$20.00'))).toBe(true)

    // tap → positions list
    emit({ sysEvent: {} })
    await tick()
    expect(items()[0]).toBe('LONG  BTC 0.05 · +$57.00 +13%')
    expect(items()).toContain('■ Open orders (1)')

    // first position (index 0 omitted by protobuf) → detail → close
    emit({ listEvent: { containerName: 'list' } })
    await tick()
    expect(header()).toBe('‹ BTC LONG')
    emit({ listEvent: { containerName: 'list' } })
    await tick()
    expect(commands.at(-1)).toBe('close BTC')
    expect(items()).toEqual(['Close BTC', 'Keep it'])
    expect(header()).toMatch(/^CONFIRM · (30|29)s$/)
    emit({ listEvent: { containerName: 'choice' } })
    await tick()
    expect(calls).toContain('execute:p1')
    expect(header()).toBe('BTC closed')

    // an alert while idle takes over the screen with a one-tap action
    pushEvent({ type: 'alert', alert: snap.alerts[0]!, title: 'BTC below 90,000', body: 'Now 89,950', coin: 'BTC', hasPosition: true })
    await tick()
    expect(header()).toBe('!! ALERT')
    expect(items()).toEqual(['Close BTC position', 'Dismiss'])
    emit({ listEvent: { containerName: 'choice', currentSelectItemIndex: 1 } })
    await tick()
    expect(header()).toMatch(/^TAPE/)

    // hold to talk → release → danger card puts Cancel first
    emit({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT } })
    await tick()
    expect(calls).toContain('mic:true')
    emit({ audioEvent: { audioPcm: loud() } })
    emit({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_RELEASE_EVENT } })
    await tick()
    expect(calls).toContain('mic:false')
    expect(header()).toMatch(/^!! CONFIRM/)
    expect(items()).toEqual(['Cancel', 'Close all'])
    // a stray tap on the first item cancels, it never trades
    emit({ listEvent: { containerName: 'choice' } })
    await tick()
    expect(calls).toContain('cancel:p2')
    expect(calls).not.toContain('execute:p2')

    // an alert during a confirm waits until the card is done
    await c.runText('close everything')
    pushEvent({ type: 'alert', alert: snap.alerts[0]!, title: 'PnL today below -$100.00', body: 'Now -$120.00', hasPosition: false })
    await tick()
    expect(header()).toMatch(/^!! CONFIRM/)
    emit({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } })
    await new Promise(r => setTimeout(r, 1300))
    expect(header()).toBe('!! ALERT')
    expect(items()).toEqual(['Dismiss'])

    for (const p of pages) checkPage(p)
    c.dispose()
  })
})
