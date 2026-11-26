# Running Tape as a hosted service

`TAPE_MODE=hosted` turns one Tape server into a service for many people. Each person
starts a **paper account in one tap** (no form, no email) or connects **their own
Bybit testnet or demo-trading key**, and gets their own desk: positions, alerts,
settings and confirm cards.

## What you need

- A Linux machine with Docker. 1 vCPU / 1 GB RAM handles a few hundred users; idle desks are unloaded after 20 minutes. Whisper needs about 1 GB more.
- A domain name pointing at it (an A record such as `tape.example.com`), with ports 80 and 443 open.
- No exchange account of your own: paper accounts use public prices (Bybit, then Binance, then OKX), and Bybit users bring their own keys.

## Set up

```bash
cp server/.env.example server/.env
```

In `server/.env`, set:

```ini
TAPE_MODE=hosted
DATA_KEY=<output of: openssl rand -hex 32>   # encrypts users' API keys; keep a copy safe, apart from backups
MAX_ORDER_USD=2500                           # hard per-order cap for every user
SIGNUP_LIMIT_PER_HOUR=5                      # new accounts per IP
STT_PROVIDER=whisper                         # or none (typing still works)
```

Start it:

```bash
cd deploy
TAPE_DOMAIN=tape.example.com docker compose -f docker-compose.hosted.yml up -d --build
curl https://tape.example.com/api/info     # {"mode":"hosted","signup":["paper","bybit-testnet","bybit-demo"],...}
```

Then build the glasses app pointing at it, so users never type a URL:

```bash
cd app
echo "VITE_SERVER_URL=https://tape.example.com" > .env.production
npm run pack            # → tape.ehpk; network whitelist = exactly your domain; refuses to embed a token
```

## Operate it

| Task | How |
|---|---|
| Backups | `deploy/backup.sh /path/to/backups` (consistent online copy, keeps 14 days). Cron it daily. A backup is useless without `DATA_KEY`, and `DATA_KEY` without the backup exposes nothing |
| Logs | `docker compose -f docker-compose.hosted.yml logs -f tape` (JSON; tokens, API keys and secrets are redacted) |
| Health | `GET /health` |
| Upgrades | `git pull && docker compose -f docker-compose.hosted.yml up -d --build`. Database migrations run on start |
| Retention | Accounts nobody opens for 180 days are erased automatically; unused device tokens expire after 90 days |
| Rotate `DATA_KEY` | Not supported in place: changing it means Bybit users reconnect their keys |
| Scale | One process per database file (SQLite). For more users, run more servers or move `server/src/lib/db.ts` to Postgres |

## Safety rules the server enforces for every user

- Bybit **testnet and demo trading only**: the endpoints are hard-coded and there is no mainnet option.
- A key that can **withdraw** is refused at sign-up. A read-only key (or one without trade permission) gives a read-only desk.
- Every order, close, transfer and cancel needs a confirm tap. Cards expire after `PLAN_TTL_S`, run once, and are re-checked against a fresh price.
- New orders and transfers pause while prices or the exchange are unreachable. Closing stays possible.
- There is no fallback to made-up prices: `PRICE_SOURCE=synthetic` exists only for offline demos and is labelled "simulated" in the app.

## Before you invite the public

- Publish a privacy policy (start from [`PRIVACY.md`](../PRIVACY.md) and fill in your details).
- Bybit's API terms apply to each user's own key. Tape never holds funds.
