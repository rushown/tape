# Tape: DoraHacks "Heads Up: Even Realities" submission

**Track:** 03 · Exchanges & Stocks (Bybit).

## Problem

During a trading session, people check the same three things over and over: PnL, open positions and one or two prices. Each check is a phone unlock and an app switch. Acting fast ("get me out of half my BTC", "move $500 to margin") means hunting through small menus at the worst possible moment, and price alerts arrive as one notification among fifty.

## Who it's for

Active crypto derivatives traders: people who run positions during the day while doing other things (working, commuting, meetings) and want to stay in control without staring at a screen. Also anyone learning to trade on testnet or paper, safely.

## How it works

- **Glasses (Even Hub app, TypeScript):** the home screen shows today's PnL, open PnL, equity and free margin, the focused coin and the top positions. It updates live without flicker. Swipe to change coin; tap for positions; tap a position to **Close** or **Close half**. Price and PnL alerts take over the screen when they fire, with a one-tap **Close position**.
- **Voice orders, one-tap confirm:** hold the touchpad or ring and say "short $200 of SOL", "close half of my bitcoin", "move 500 from funding to trading", "alert me if Ethereum drops below 1500". Tape shows a confirm card (size, notional, price, effect on your position) with a 30-second countdown. One tap sends it.
- **Server (Node):** Bybit V5 API (HMAC-signed; testnet and demo trading only), or a built-in paper account on live public prices. Whisper speech-to-text (self-hosted, free) and a deterministic command parser. **No AI decides a trade.**
- **Safety:** confirm card for every order; cards expire and run once; a price re-check at send time (refused if price moved over 1%); a per-order USD cap the user can lower but never raise; a danger card for "close everything" with Cancel as the first item; read-only mode; no mainnet, no custody, no withdrawals.

## Getting started as a user

Install Tape from Even Hub → open it in the Even Realities app → tap **Start with paper money**. That's the whole sign-up: no form, no email. To trade a real test account instead, paste a Bybit testnet key (Tape refuses keys that can withdraw).

## Production readiness

Hosted multi-user mode: per-device tokens stored hashed, Bybit keys encrypted at rest (AES-256-GCM), export and delete in the app, inactive accounts erased after 180 days, per-IP sign-up limits, Caddy + HTTPS deploy kit, daily backups, privacy policy template. Outage-safe: if prices or the exchange are unreachable, new orders pause and nothing fills at a stale price; closing stays possible. 79 automated tests.

## Business potential

Wearables are a natural "second screen" for exchanges, and a safer one: confirm on glasses instead of fat-fingering on a phone. Model: free for paper and testnet; a paid hosted tier (managed server, speech-to-text, multi-exchange) once exchanges offer scoped, capped API keys (see feature requests). Exchanges get a partner channel to engaged traders.

## Links

- **Repository:** README covers 5-minute local setup (no accounts), Bybit testnet setup, Docker deploy and the Even Hub package.
- **Demo video:** _add link_
- **Packaged build:** `app/tape.ehpk` (`npm run pack`)

## Feature requests

1. Even Hub: background alerts (push a line to the glasses while another app is open).
2. Even Hub: SDK speech-to-text for short commands.
3. Even Hub: a glyph coverage API for the G2 font.
4. Bybit: scoped, capped, expiring API keys for wearables.
5. Bybit: a lightweight fill and alert push channel for small clients.
