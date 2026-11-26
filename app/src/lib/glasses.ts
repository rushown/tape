import {
  AudioInputSource,
  CreateStartUpPageContainer,
  type EvenAppBridge,
  type EvenHubEvent,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { fitBytes, forGlasses } from './text'

/** List item labels are limited to 63 UTF-8 bytes by the G2 protocol (simulator rejects 64+). */
export const LIST_ITEM_MAX_BYTES = 63

/** G2 canvas size. */
export const W = 576
export const H = 288

export interface TextSpec {
  name: string // <= 16 chars, unique per page
  x: number
  y: number
  w: number
  h: number
  content: string
  border?: boolean
  brightness?: 0 | 1 | 2 | 3 | 4
}

export interface ListSpec {
  name: string
  x: number
  y: number
  w: number
  h: number
  items: string[] // <= 20 items, <= 64 chars each
}

/** One full glasses page. Exactly one container captures input. */
export interface Page {
  texts: TextSpec[]
  list?: ListSpec
  capture: string // name of the container that receives input
}

export type Input =
  | { kind: 'tap' }
  | { kind: 'double' }
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'select'; index: number }
  | { kind: 'hold' }
  | { kind: 'release' }
  | { kind: 'foreground' }
  | { kind: 'background' }
  | { kind: 'exit' }

export interface MirrorFrame {
  page: Page
  selected: number
}

const CALL_TIMEOUT_MS = 5000

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    p.then(
      v => { clearTimeout(t); resolve(v) },
      e => { clearTimeout(t); reject(e) },
    )
  })
}

/**
 * Thin, safe wrapper around the Even Hub bridge.
 *  - Serializes every BLE call (concurrent calls can drop the link).
 *  - Times out hung calls so the UI never freezes.
 *  - Mirrors every frame to the phone UI.
 *  - Falls back to an emulator when not running inside the Even App, so the
 *    whole experience is testable in a desktop browser.
 */
export class Glasses {
  private queue: Promise<unknown> = Promise.resolve()
  private created = false
  private page: Page | null = null
  private selected = 0
  private inputFns = new Set<(i: Input) => void>()
  private audioFns = new Set<(pcm: Uint8Array) => void>()
  private mirrorFns = new Set<(f: MirrorFrame) => void>()
  private unsubscribe?: () => void

  private constructor(readonly bridge: EvenAppBridge | null) {
    if (bridge) this.unsubscribe = bridge.onEvenHubEvent(e => this.route(e))
  }

  static async connect(timeoutMs = 2500): Promise<Glasses> {
    const inHost = typeof (window as unknown as { flutter_inappwebview?: unknown }).flutter_inappwebview !== 'undefined'
    if (!inHost) return new Glasses(null)
    try {
      const bridge = await withTimeout(waitForEvenAppBridge(), timeoutMs, 'bridge')
      return new Glasses(bridge)
    } catch {
      return new Glasses(null)
    }
  }

  get emulated() {
    return this.bridge === null
  }

  // ── Subscriptions ─────────────────────────────────────────────────────
  onInput(fn: (i: Input) => void) { this.inputFns.add(fn); return () => this.inputFns.delete(fn) }
  onAudio(fn: (pcm: Uint8Array) => void) { this.audioFns.add(fn); return () => this.audioFns.delete(fn) }
  onMirror(fn: (f: MirrorFrame) => void) {
    this.mirrorFns.add(fn)
    if (this.page) fn({ page: this.page, selected: this.selected })
    return () => this.mirrorFns.delete(fn)
  }

  private emit(i: Input) {
    for (const fn of this.inputFns) {
      try { fn(i) } catch (err) { console.error('input handler failed', err) }
    }
  }
  private mirror() {
    if (!this.page) return
    for (const fn of this.mirrorFns) fn({ page: this.page, selected: this.selected })
  }

  /** Inject input from the phone UI / keyboard (works on device and in emulator). */
  inject(i: Input) {
    if (this.page?.list && this.page.capture === this.page.list.name) {
      const n = this.page.list.items.length
      if (i.kind === 'up') { this.selected = Math.max(0, this.selected - 1); this.mirror(); return }
      if (i.kind === 'down') { this.selected = Math.min(n - 1, this.selected + 1); this.mirror(); return }
      if (i.kind === 'tap') { this.emit({ kind: 'select', index: this.selected }); return }
    }
    this.emit(i)
  }

  pushEmulatedAudio(pcm: Uint8Array) {
    for (const fn of this.audioFns) fn(pcm)
  }

  // ── Event routing (device) ───────────────────────────────────────────
  private route(e: EvenHubEvent) {
    const pcm = e.audioEvent?.audioPcm
    if (pcm) {
      for (const fn of this.audioFns) fn(pcm)
      return
    }
    // Protobuf omits zero values: a missing eventType on a present envelope is a CLICK.
    const typeOf = (env?: { eventType?: OsEventTypeList }) => (env ? env.eventType ?? OsEventTypeList.CLICK_EVENT : null)
    const sys = typeOf(e.sysEvent)
    const text = typeOf(e.textEvent)
    const list = typeOf(e.listEvent)

    if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) return this.emit({ kind: 'exit' })
    if (sys === OsEventTypeList.FOREGROUND_ENTER_EVENT) return this.emit({ kind: 'foreground' })
    if (sys === OsEventTypeList.FOREGROUND_EXIT_EVENT) return this.emit({ kind: 'background' })
    if (sys === OsEventTypeList.IMU_DATA_REPORT) return

    const any = (t: OsEventTypeList) => sys === t || text === t || list === t
    if (any(OsEventTypeList.DOUBLE_CLICK_EVENT)) return this.emit({ kind: 'double' })
    if (any(OsEventTypeList.LONG_PRESS_EVENT)) return this.emit({ kind: 'hold' })
    if (any(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) return this.emit({ kind: 'release' })
    if (e.listEvent && list === OsEventTypeList.CLICK_EVENT) {
      const index = e.listEvent.currentSelectItemIndex ?? 0
      this.selected = index
      this.mirror()
      return this.emit({ kind: 'select', index })
    }
    if (text === OsEventTypeList.SCROLL_TOP_EVENT || sys === OsEventTypeList.SCROLL_TOP_EVENT) return this.emit({ kind: 'up' })
    if (text === OsEventTypeList.SCROLL_BOTTOM_EVENT || sys === OsEventTypeList.SCROLL_BOTTOM_EVENT) return this.emit({ kind: 'down' })
    if (sys === OsEventTypeList.CLICK_EVENT || text === OsEventTypeList.CLICK_EVENT) return this.emit({ kind: 'tap' })
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  private enqueue<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    const run = this.queue.then(() => withTimeout(fn(), CALL_TIMEOUT_MS, label)).catch(err => {
      console.warn(`[glasses] ${label} failed:`, err)
      return undefined
    })
    this.queue = run
    return run
  }

  render(page: Page): Promise<boolean> {
    this.page = page
    this.selected = 0
    this.mirror()
    if (!this.bridge) return Promise.resolve(true)
    const bridge = this.bridge
    const texts = page.texts.map(
      (t, i) =>
        new TextContainerProperty({
          xPosition: t.x, yPosition: t.y, width: t.w, height: t.h,
          borderWidth: t.border ? 1 : 0, borderColor: 6, borderRadius: t.border ? 6 : 0, paddingLength: 4,
          containerID: i + 1, containerName: t.name, content: forGlasses(t.content) || ' ',
          isEventCapture: page.capture === t.name ? 1 : 0,
          ...(t.brightness !== undefined ? { textColor: t.brightness } : {}),
        }),
    )
    const lists = page.list
      ? [
          new ListContainerProperty({
            xPosition: page.list.x, yPosition: page.list.y, width: page.list.w, height: page.list.h,
            borderWidth: 1, borderColor: 6, borderRadius: 6, paddingLength: 4,
            containerID: 20, containerName: page.list.name,
            itemContainer: new ListItemContainerProperty({
              itemCount: page.list.items.length, itemWidth: 0, isItemSelectBorderEn: 1,
              itemName: page.list.items.map(s => fitBytes(forGlasses(s), LIST_ITEM_MAX_BYTES)),
            }),
            isEventCapture: page.capture === page.list.name ? 1 : 0,
          }),
        ]
      : []
    const total = texts.length + lists.length
    return this.enqueue('render', async () => {
      if (!this.created) {
        const res = await bridge.createStartUpPageContainer(
          new CreateStartUpPageContainer({ containerTotalNum: total, textObject: texts, ...(lists.length ? { listObject: lists } : {}) }),
        )
        this.created = res === StartUpPageCreateResult.success
        if (this.created) return true
        // The host may still hold our startup page (e.g. after a WebView reload): rebuild instead.
        const rebuilt = await bridge.rebuildPageContainer(
          new RebuildPageContainer({ containerTotalNum: total, textObject: texts, ...(lists.length ? { listObject: lists } : {}) }),
        )
        this.created = Boolean(rebuilt)
        return this.created
      }
      return bridge.rebuildPageContainer(
        new RebuildPageContainer({ containerTotalNum: total, textObject: texts, ...(lists.length ? { listObject: lists } : {}) }),
      )
    }).then(Boolean)
  }

  /** Flicker-free text update of a container on the current page. */
  setText(name: string, content: string): Promise<void> {
    if (!this.page) return Promise.resolve()
    const idx = this.page.texts.findIndex(t => t.name === name)
    if (idx < 0) return Promise.resolve()
    if (this.page.texts[idx]!.content === content) return Promise.resolve()
    this.page = { ...this.page, texts: this.page.texts.map((t, i) => (i === idx ? { ...t, content } : t)) }
    this.mirror()
    if (!this.bridge) return Promise.resolve()
    const bridge = this.bridge
    return this.enqueue('text', () =>
      bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: idx + 1, containerName: name, content: forGlasses(content) || ' ' })),
    ).then(() => undefined)
  }

  hasText(name: string) {
    return Boolean(this.page?.texts.some(t => t.name === name))
  }

  // ── Hardware ─────────────────────────────────────────────────────────
  mic(on: boolean): Promise<boolean> {
    if (!this.bridge) return Promise.resolve(true)
    const bridge = this.bridge
    return this.enqueue('mic', () => (on ? bridge.audioControl(true, AudioInputSource.Glasses) : bridge.audioControl(false))).then(Boolean)
  }

  /** Ask the host to show its exit confirmation (required double-tap behaviour). */
  requestExit(): void {
    if (!this.bridge) return
    const bridge = this.bridge
    void this.enqueue('exit', () => bridge.shutDownPageContainer(1))
  }

  async storageGet(key: string): Promise<string> {
    if (this.bridge) {
      const v = await this.enqueue('storage', () => this.bridge!.getLocalStorage(key))
      if (v) return v
    }
    try { return localStorage.getItem(key) ?? '' } catch { return '' }
  }

  async storageSet(key: string, value: string): Promise<void> {
    try { localStorage.setItem(key, value) } catch { /* private mode */ }
    if (this.bridge) await this.enqueue('storage', () => this.bridge!.setLocalStorage(key, value))
  }

  dispose() {
    this.unsubscribe?.()
    this.inputFns.clear()
    this.audioFns.clear()
  }
}
