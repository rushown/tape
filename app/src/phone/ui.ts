import type { Controller, ControllerState } from '../glasses/controller'
import type { ExchangeChoice, Info } from '../lib/types'
import type { Api } from '../lib/api'
import { alertLine, modeLabel, pct, price, qty, usd } from '../lib/format'
import { type Glasses, H, type MirrorFrame, W } from '../lib/glasses'
import { fitBytes, forGlasses } from '../lib/text'

export interface PhoneDeps {
  glasses: Glasses
  controller: Controller
  api: Api
  saveConfig: (url: string, token: string) => Promise<void>
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel)!
const tone = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '')

/**
 * Phone companion: live mirror + touchpad, command box, account at a glance,
 * safety settings and server connection. The glasses are the product; this
 * page is setup and a fallback.
 */
export function mountPhoneUi(root: HTMLElement, d: PhoneDeps) {
  root.innerHTML = `
  <main class="app">
    <header class="top">
      <div class="brand"><span class="logo" aria-hidden="true"></span><div><h1>Tape</h1><p>Trading at a glance, for Even G2</p></div></div>
      <span id="pill" class="pill">Connecting…</span>
    </header>

    <div class="grid">
      <section class="col">
        <figure class="lens">
          <div class="hud" id="hud" role="img" aria-label="Live mirror of the glasses display"></div>
          <figcaption><span id="lens-src">Emulator</span><span id="keys"></span></figcaption>
        </figure>
        <div class="pad" role="group" aria-label="Glasses touchpad">
          <button data-in="up" aria-label="Swipe up">▲</button>
          <button data-in="tap">Tap</button>
          <button data-in="down" aria-label="Swipe down">▼</button>
          <button data-in="double">Double tap</button>
          <button id="talk" class="primary">Hold to talk</button>
        </div>
        <form id="cmd" class="cmd" autocomplete="off">
          <input id="cmd-text" type="text" placeholder="buy 0.01 BTC · alert if ETH drops below 3k" aria-label="Type a command" />
          <button type="submit">Run</button>
        </form>
        <p id="heard" class="heard" hidden></p>
        <div class="chips" id="chips"></div>
      </section>

      <section class="col">
        <article class="card start" id="start-card" hidden>
          <div class="card-h"><h2>Start trading at a glance</h2></div>
          <p class="sub">Practice with $10,000 of paper money on live prices, or connect your Bybit testnet. No sign-up form, no email.</p>
          <button id="start-paper" class="btn primary">Start with paper money</button>
          <details><summary>Connect Bybit testnet or demo instead</summary>
          <div class="bybit">
            <label class="field"><span>Bybit account</span>
              <select id="su-env"><option value="testnet">Testnet (test coins)</option><option value="demo">Demo trading (real prices, demo funds)</option></select></label>
            <label class="field"><span>API key</span><input id="su-key" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
            <label class="field"><span>API secret</span><input id="su-secret" type="password" autocomplete="off" /></label>
            <p class="sub">Create it at <b>testnet.bybit.com → API → System-generated</b>: Read-Write, <b>Contracts: Orders + Positions</b>, <b>Wallet: Account transfer</b>. <b>Never enable Withdraw</b>; Tape refuses such keys. The key is stored encrypted on the server and never shown again.</p>
            <button id="su-go" class="btn">Connect Bybit</button>
          </div>
          </details>
          <p class="sub" id="start-err" role="alert"></p>
        </article>

        <article class="card needs-account" id="acct-card">
          <div class="card-h"><h2>Account</h2><span id="mode" class="tag"></span></div>
          <div class="stats" id="stats"></div>
          <table class="tbl" id="positions"></table>
          <div id="orders-wrap"></div>
        </article>

        <article class="card needs-account">
          <div class="card-h"><h2>Alerts</h2><span class="sub">fire on the glasses while Tape is open</span></div>
          <ul class="alerts" id="alerts"></ul>
        </article>

        <article class="card" id="demo-card" hidden>
          <div class="card-h"><h2>Demo controls</h2><span class="sub">paper mode only</span></div>
          <p class="sub">Move a price to show an alert firing or PnL changing.</p>
          <div class="row" id="nudges"></div>
        </article>

        <article class="card needs-account">
          <div class="card-h"><h2>Safety</h2></div>
          <label class="switch"><input type="checkbox" id="ro" /><span>Read-only: view and alerts, no trading</span></label>
          <label class="field"><span>Max per order (USD)</span><input id="cap" type="number" min="1" step="50" inputmode="decimal" /></label>
          <p class="sub" id="cap-note"></p>
          <label class="field"><span>Watchlist</span><input id="watch" type="text" placeholder="BTC, ETH, SOL" /></label>
          <button id="save-safety" class="btn">Save</button>
          <p class="sub">Every trade needs a tap on the glasses. Cards expire after 30 s and are re-checked against the price before sending.</p>
        </article>

        <article class="card" id="account-card" hidden>
          <div class="card-h"><h2>Your account</h2></div>
          <p id="acct-exchange" class="mono"></p>
          <details><summary>Switch exchange</summary>
            <button id="sw-paper" class="btn">Use a paper account</button>
            <div class="bybit">
            <label class="field"><span>Bybit account</span>
              <select id="sw-env"><option value="testnet">Testnet (test coins)</option><option value="demo">Demo trading (real prices, demo funds)</option></select></label>
            <label class="field"><span>API key</span><input id="sw-key" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
            <label class="field"><span>API secret</span><input id="sw-secret" type="password" autocomplete="off" /></label>
            <p class="sub">Create it at <b>testnet.bybit.com → API → System-generated</b>: Read-Write, <b>Contracts: Orders + Positions</b>, <b>Wallet: Account transfer</b>. <b>Never enable Withdraw</b>; Tape refuses such keys. The key is stored encrypted on the server and never shown again.</p>
            <button id="sw-go" class="btn">Connect Bybit</button>
          </div>
          </details>
          <div class="row">
            <button id="acct-export" class="btn">Export my data</button>
            <button id="acct-out" class="btn">Sign out</button>
            <button id="acct-del" class="btn danger">Delete account</button>
          </div>
          <p class="sub">Deleting erases your settings, alerts, paper account and stored API key from the server, immediately.</p>
        </article>

        <article class="card">
          <div class="card-h"><h2>Server</h2><span id="srv-state" class="sub"></span></div>
          <label class="field"><span>Server URL</span><input id="url" type="url" placeholder="https://tape.example.com" /></label>
          <label class="field" id="token-field"><span>App token</span><input id="token" type="password" placeholder="APP_TOKEN from the server .env" /></label>
          <button id="connect" class="btn primary">Connect</button>
          <p class="sub" id="srv-detail"></p>
        </article>
      </section>
    </div>
  </main>
  <div id="snack" class="snack" role="status" aria-live="polite"></div>`

  const hud = $(root, '#hud')
  const snack = $(root, '#snack')
  let snackTimer: ReturnType<typeof setTimeout> | undefined
  const toast = (msg: string) => {
    snack.textContent = msg
    snack.classList.add('on')
    clearTimeout(snackTimer)
    snackTimer = setTimeout(() => snack.classList.remove('on'), 2600)
  }

  // ── Glasses mirror ───────────────────────────────────────────────────
  const at = (v: number, total: number) => `${((v / total) * 100).toFixed(3)}%`
  d.glasses.onMirror((f: MirrorFrame) => {
    const parts: string[] = []
    for (const t of f.page.texts) {
      const dim = t.brightness !== undefined && t.brightness < 3
      parts.push(`<div class="hud-box${t.border ? ' framed' : ''}${dim ? ' dim' : ''}" style="left:${at(t.x, W)};top:${at(t.y, H)};width:${at(t.w, W)};height:${at(t.h, H)}">${esc(forGlasses(t.content))}</div>`)
    }
    if (f.page.list) {
      const l = f.page.list
      const items = l.items.map((it, i) => `<div class="hud-item${i === f.selected ? ' sel' : ''}">${esc(fitBytes(forGlasses(it), 63))}</div>`).join('')
      parts.push(`<div class="hud-box framed hud-list" style="left:${at(l.x, W)};top:${at(l.y, H)};width:${at(l.w, W)};height:${at(l.h, H)}">${items}</div>`)
    }
    hud.innerHTML = parts.join('')
    const sel = hud.querySelector<HTMLElement>('.hud-item.sel')
    const list = sel?.parentElement
    if (sel && list) {
      if (sel.offsetTop < list.scrollTop) list.scrollTop = sel.offsetTop
      else if (sel.offsetTop + sel.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = sel.offsetTop + sel.offsetHeight - list.clientHeight
    }
  })
  $(root, '#lens-src').textContent = d.glasses.emulated ? 'Emulator' : 'Live from your G2'
  $(root, '#keys').innerHTML = d.glasses.emulated ? '<kbd>↑</kbd><kbd>↓</kbd> swipe · <kbd>Enter</kbd> tap · <kbd>Esc</kbd> 2x · hold <kbd>Space</kbd> talk' : 'Buttons act like the temple touchpad'

  // ── Touchpad + talk ──────────────────────────────────────────────────
  root.querySelectorAll<HTMLButtonElement>('[data-in]').forEach(b =>
    b.addEventListener('click', () => d.glasses.inject({ kind: b.dataset.in as 'up' | 'down' | 'tap' | 'double' })),
  )
  const talk = $<HTMLButtonElement>(root, '#talk')
  const press = (e: Event) => { e.preventDefault(); d.glasses.inject({ kind: 'hold' }) }
  const release = () => d.glasses.inject({ kind: 'release' })
  talk.addEventListener('pointerdown', press)
  talk.addEventListener('pointerup', release)
  talk.addEventListener('pointerleave', e => { if ((e as PointerEvent).buttons) release() })
  let spaceDown = false
  window.addEventListener('keydown', e => {
    if ((e.target as HTMLElement).closest('input, textarea')) return
    if (e.key === 'ArrowUp') { e.preventDefault(); d.glasses.inject({ kind: 'up' }) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); d.glasses.inject({ kind: 'down' }) }
    else if (e.key === 'Enter') d.glasses.inject({ kind: 'tap' })
    else if (e.key === 'Escape') d.glasses.inject({ kind: 'double' })
    else if (e.key === ' ' && !spaceDown) { e.preventDefault(); spaceDown = true; d.glasses.inject({ kind: 'hold' }) }
  })
  window.addEventListener('keyup', e => {
    if (e.key === ' ' && spaceDown) { spaceDown = false; d.glasses.inject({ kind: 'release' }) }
  })

  // ── Command box ──────────────────────────────────────────────────────
  const examples = ['buy 0.01 BTC', 'short $300 of ETH', 'close half my BTC', 'close everything', 'alert if BTC drops 1%', 'alert if PnL below minus 100', 'move 500 from funding to trading', 'how am I doing']
  $(root, '#chips').innerHTML = examples.map(x => `<button class="chip" data-cmd="${esc(x)}">${esc(x)}</button>`).join('')
  root.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach(b => b.addEventListener('click', () => void d.controller.runText(b.dataset.cmd!)))
  const cmdInput = $<HTMLInputElement>(root, '#cmd-text')
  $(root, '#cmd').addEventListener('submit', e => {
    e.preventDefault()
    const text = cmdInput.value.trim()
    if (!text) return
    cmdInput.value = ''
    void d.controller.runText(text)
  })

  // ── Server, sign-up and account ──────────────────────────────────────
  const url = $<HTMLInputElement>(root, '#url')
  const token = $<HTMLInputElement>(root, '#token')
  url.value = d.api.config.baseUrl
  token.value = d.api.config.token
  let info: Info | null = null
  const hosted = () => info?.mode === 'hosted'
  const showServerMode = () => {
    $(root, '#token-field').hidden = hosted()
  }
  const loadInfo = async () => {
    info = null
    if (!d.api.config.baseUrl) return showServerMode()
    try { info = await d.api.info() } catch { /* shown via the controller state */ }
    showServerMode()
  }
  $(root, '#connect').addEventListener('click', async () => {
    await d.saveConfig(url.value, hosted() ? d.api.config.token : token.value)
    toast('Connecting…')
    await loadInfo()
    await d.controller.boot()
  })

  const busy = async (btn: HTMLButtonElement, fn: () => Promise<void>) => {
    btn.disabled = true
    try { await fn() } finally { btn.disabled = false }
  }
  const readBybit = (pre: string): ExchangeChoice | null => {
    const apiKey = $<HTMLInputElement>(root, `#${pre}-key`).value.trim()
    const apiSecret = $<HTMLInputElement>(root, `#${pre}-secret`).value.trim()
    if (!apiKey || !apiSecret) { toast('Paste both the API key and the secret'); return null }
    return { kind: 'bybit', env: $<HTMLSelectElement>(root, `#${pre}-env`).value as 'testnet' | 'demo', apiKey, apiSecret }
  }
  const clearBybit = (pre: string) => {
    $<HTMLInputElement>(root, `#${pre}-key`).value = ''
    $<HTMLInputElement>(root, `#${pre}-secret`).value = ''
  }
  const startErr = $(root, '#start-err')
  const signUp = async (choice: ExchangeChoice) => {
    startErr.textContent = ''
    try {
      const r = await d.api.signUp(choice)
      await d.saveConfig(d.api.config.baseUrl, r.token)
      clearBybit('su')
      settingsLoaded = false
      toast(r.readOnly ? `${r.exchange.label} · read-only key` : `Ready · ${r.exchange.label}`)
      await d.controller.boot()
    } catch (err) {
      startErr.textContent = (err as Error).message
    }
  }
  const startPaper = $<HTMLButtonElement>(root, '#start-paper')
  startPaper.addEventListener('click', () => busy(startPaper, () => signUp({ kind: 'paper' })))
  const suGo = $<HTMLButtonElement>(root, '#su-go')
  suGo.addEventListener('click', () => busy(suGo, async () => { const c = readBybit('su'); if (c) await signUp(c) }))

  const switchTo = async (choice: ExchangeChoice) => {
    try {
      const r = await d.api.setExchange(choice)
      clearBybit('sw')
      settingsLoaded = false
      toast(`Now on ${r.exchange.label}${r.readOnly ? ' (read-only key)' : ''}`)
      await d.controller.boot()
    } catch (err) {
      toast((err as Error).message)
    }
  }
  const swPaper = $<HTMLButtonElement>(root, '#sw-paper')
  swPaper.addEventListener('click', () => busy(swPaper, () => switchTo({ kind: 'paper' })))
  const swGo = $<HTMLButtonElement>(root, '#sw-go')
  swGo.addEventListener('click', () => busy(swGo, async () => { const c = readBybit('sw'); if (c) await switchTo(c) }))

  const signedOut = async (msg: string) => {
    await d.saveConfig(d.api.config.baseUrl, '')
    settingsLoaded = false
    toast(msg)
    await d.controller.boot()
  }
  $(root, '#acct-out').addEventListener('click', async () => {
    await d.api.signOut().catch(() => {})
    await signedOut('Signed out')
  })
  $(root, '#acct-del').addEventListener('click', async () => {
    if (!confirm('Delete your Tape account? Settings, alerts, your paper account and any stored API key are erased now. This cannot be undone.')) return
    try {
      await d.api.deleteAccount()
      await signedOut('Account deleted')
    } catch (err) {
      toast((err as Error).message)
    }
  })
  $(root, '#acct-export').addEventListener('click', async () => {
    try {
      const data = await d.api.exportAccount()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
      a.download = 'tape-export.json'
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    } catch (err) {
      toast((err as Error).message)
    }
  })
  void loadInfo().then(() => d.controller.notify())

  // ── Safety ───────────────────────────────────────────────────────────
  const ro = $<HTMLInputElement>(root, '#ro')
  const cap = $<HTMLInputElement>(root, '#cap')
  const watch = $<HTMLInputElement>(root, '#watch')
  let settingsLoaded = false
  $(root, '#save-safety').addEventListener('click', async () => {
    try {
      const s = await d.api.saveSettings({
        readOnly: ro.checked,
        maxOrderUsd: Number(cap.value) || undefined,
        watchlist: watch.value.split(/[\s,]+/).filter(Boolean),
      })
      cap.value = String(s.maxOrderUsd)
      watch.value = s.watchlist.join(', ')
      toast(s.readOnly ? 'Saved · read-only' : 'Saved · trading on')
    } catch (err) {
      toast((err as Error).message)
    }
  })

  // ── Live state ───────────────────────────────────────────────────────
  let nudgesFor = ''
  d.controller.onState((s: ControllerState) => {
    const pill = $(root, '#pill')
    pill.textContent = !s.status ? (s.needsSignIn ? 'Not signed in' : s.error ? 'Not connected' : 'Connecting…') : s.online ? `${modeLabel(s.status.mode)} · live` : 'Reconnecting…'
    pill.className = `pill ${s.status && s.online ? 'ok' : s.error ? 'err' : ''}`
    $(root, '#srv-state').textContent = s.status ? `v${s.status.version}` : ''
    root.querySelectorAll<HTMLElement>('.needs-account').forEach(el => { el.hidden = !s.status })
    const signIn = s.needsSignIn && hosted()
    $(root, '#start-card').hidden = !signIn
    $(root, '#account-card').hidden = !(hosted() && s.status && !s.needsSignIn)
    if (hosted() && s.status && !s.needsSignIn) $(root, '#acct-exchange').textContent = s.status.exchange.label
    $(root, '#srv-detail').textContent = s.status
      ? `${s.status.exchange.label}${s.status.exchange.label.includes("prices:") ? "" : ` · prices: ${s.status.prices ?? "—"}`} · voice: ${s.status.stt ?? 'off'}`
      : s.error || (hosted() ? 'Connected to a hosted Tape server.' : 'Run the Tape server, then paste its URL and APP_TOKEN.')
    const heard = $(root, '#heard')
    heard.hidden = !s.lastTranscript
    heard.textContent = s.lastTranscript ? `Heard: “${s.lastTranscript}”` : ''

    const snap = s.snapshot
    if (s.status && !settingsLoaded && snap) {
      settingsLoaded = true
      ro.checked = snap.settings.readOnly
      cap.value = String(snap.settings.maxOrderUsd)
      cap.max = String(s.status.maxOrderUsd)
      watch.value = snap.settings.watchlist.join(', ')
      $(root, '#cap-note').textContent = s.status.hosted ? `You can lower this. The service maximum is ${usd(s.status.maxOrderUsd)}.` : `Server limit: ${usd(s.status.maxOrderUsd)} (set MAX_ORDER_USD to change).`
    }
    $(root, '#mode').textContent = snap ? modeLabel(snap.mode) : ''
    const a = snap?.account
    $(root, '#stats').innerHTML = a
      ? [
          ['Today', usd(a.dayPnl, true), tone(a.dayPnl)],
          ['Open PnL', usd(a.upnl, true), tone(a.upnl)],
          ['Equity', usd(a.equity), ''],
          ['Free margin', usd(a.available), ''],
          ...(a.funding ? [['Funding wallet', usd(a.funding), ''] as const] : []),
        ].map(([k, v, t]) => `<div class="stat"><span>${k}</span><b class="mono ${t}">${v}</b></div>`).join('')
      : `<p class="sub">${esc(snap?.error ?? 'No data yet.')}</p>`
    const pos = snap?.positions ?? []
    $(root, '#positions').innerHTML = pos.length
      ? `<thead><tr><th>Position</th><th>Entry → mark</th><th class="r">PnL</th></tr></thead><tbody>${pos.map(p => `<tr><td><b class="${p.side === 'long' ? 'up' : 'down'}">${p.side.toUpperCase()}</b> ${qty(p.size)} ${esc(p.coin)}</td><td class="mono">${price(p.entry)} → ${price(p.mark)}</td><td class="r mono ${tone(p.upnl)}">${usd(p.upnl, true)}<small> ${pct(p.upnlPct)}</small></td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="sub">No open positions. Try “buy 0.01 BTC”.</td></tr></tbody>'
    const orders = snap?.orders ?? []
    $(root, '#orders-wrap').innerHTML = orders.length
      ? `<p class="sub">Open orders: ${orders.map(o => `${o.side.toUpperCase()} ${qty(o.qty)} ${esc(o.coin)} @ ${price(o.price)}`).join(' · ')}</p>`
      : ''
    const alerts = snap?.alerts ?? []
    $(root, '#alerts').innerHTML = alerts.length
      ? alerts.map(x => `<li><span class="mono">${esc(alertLine(x))}</span><button class="x" data-alert="${esc(x.id)}" aria-label="Remove alert">✕</button></li>`).join('')
      : '<li class="sub">None. Say “alert if BTC drops below 90k”.</li>'
    root.querySelectorAll<HTMLButtonElement>('[data-alert]').forEach(b =>
      b.addEventListener('click', async () => {
        b.disabled = true
        try { await d.api.removeAlert(b.dataset.alert!); toast('Alert removed') } catch (err) { toast((err as Error).message) }
      }),
    )

    const demo = snap?.mode === 'paper'
    $(root, '#demo-card').hidden = !demo
    const coins = snap ? [...new Set([snap.settings.focus, ...pos.map(p => p.coin)])].slice(0, 3) : []
    const key = coins.join(',')
    if (demo && key !== nudgesFor) {
      nudgesFor = key
      $(root, '#nudges').innerHTML = coins.flatMap(c => [-2, 2].map(p => `<button class="btn" data-nudge="${esc(c)}" data-pct="${p}">${esc(c)} ${p > 0 ? '+' : '−'}${Math.abs(p)}%</button>`)).join('')
      root.querySelectorAll<HTMLButtonElement>('[data-nudge]').forEach(b =>
        b.addEventListener('click', async () => {
          try { await d.api.nudge(b.dataset.nudge!, Number(b.dataset.pct)) } catch (err) { toast((err as Error).message) }
        }),
      )
    }
  })
}
