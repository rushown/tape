# Tape privacy policy (template)

> Template for anyone running Tape as a hosted service. Replace the
> `[bracketed]` parts before publishing. Self-hosted Tape keeps everything on
> your own server and sends nothing to the Tape authors.

Last updated: [date]. Operator: [name, contact email].

## What Tape is

Tape shows a trading account on Even Realities G2 glasses (balance, positions,
prices, alerts) and places orders you confirm on the glasses. It works with a
**paper account** (simulated money) or **your own Bybit testnet or demo-trading
account**. It never touches real money: there is no mainnet support.

## What we store

| Data | Why | How it is protected |
|---|---|---|
| A random account id | To recognise your device | No name, email or phone number is collected |
| Access tokens for your devices | To keep you signed in | Only a one-way hash is stored |
| Your settings (watchlist, focus coin, read-only switch, per-order limit) and price alerts | To run the app | Stored in our database |
| Your paper account (simulated balance, positions, orders) | So paper trading works | Stored in our database |
| Your Bybit API key and secret, if you connect one | To read your testnet/demo account and place the orders you confirm | Encrypted (AES-256-GCM); never shown again, even to you. Keys that can withdraw are refused |

**We do not store your voice.** Voice commands are transcribed and the audio is
discarded right away. We keep no history of what you said.

## Who else sees your data

- **Bybit**, if you connect a key: Tape calls Bybit's testnet or demo API with your key to show your account and send orders you confirmed.
- **Public price APIs** (Bybit, Binance, OKX): asked for prices only. Nothing about you is sent.
- **Speech-to-text**: your voice commands are transcribed by [our own Whisper server / provider name].

We do not sell data, show ads, or use your data to train models. No AI model
sees your account or decides any trade.

## Your choices

- **Sign out** in the app (Your account → Sign out).
- **Export** your stored data in the app (Your account → Export my data). API keys are shown only as their last 4 characters.
- **Delete your account** in the app (Your account → Delete account). This erases everything above immediately. Backups are overwritten within [14] days.
- Accounts nobody opens for **180 days** are erased automatically.
- You can also revoke Tape's access at any time by deleting the API key on Bybit.

## Not financial advice

Tape shows your own data and does what you confirm. It gives no recommendations.

## Contact

[email]
