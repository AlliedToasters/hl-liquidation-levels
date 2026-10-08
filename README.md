# Hyperliquid Liquidation Levels

A live, local dashboard in the style of the "Crypto Liquidation Levels" livestream, but built on
**real on-chain Hyperliquid positions** instead of estimated levels.

Every Hyperliquid fill names both counterparties. The collector watches the public trade feed for each
configured coin, looks up each counterparty's clearinghouse state, and keeps a live table of their open
positions: entry, size, leverage, margin mode and the **exact liquidation price** the exchange reports.
Each position is drawn as a horizontal line at its liquidation price, starting at the time the position
opened and extending right, coloured by leverage. Lines disappear when the position closes or is liquidated.

Design credit: the look and the idea follow [MartyParty](https://linktr.ee/martypartymusic)'s
"Crypto Liquidation Levels" livestream. This is an independent re-creation on Hyperliquid data, not
affiliated with him. See `THIRD_PARTY_NOTICES.md`.

## Run locally

```bash
git clone https://github.com/AlliedToasters/hl-liquidation-levels.git liquidation_levels && cd liquidation_levels
uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt   # or python3 -m venv + pip
.venv/bin/python server.py        # dashboard at http://127.0.0.1:8787
```

Options: `--host`, `--port`, `--config`, `--state-file`, `--coins BTC,ETH,xyz:SKHX`, or the environment
variables `LIQ_HOST`, `LIQ_PORT`, `LIQ_CONFIG`, `LIQ_STATE_FILE`.

## Run always-on (home server + Tailscale)

The collector only pays off when it runs continuously (coverage and open times accumulate, and a sleeping
laptop misses moves). On an always-on Linux box:

```bash
git clone https://github.com/AlliedToasters/hl-liquidation-levels.git ~/liquidation_levels && cd ~/liquidation_levels
./deploy/install.sh               # user-level systemd service, auto-restart, survives reboot
tailscale serve --bg 8787         # https://<machine>.<tailnet>.ts.net from any device on your tailnet
```

`tailscale serve` proxies the loopback port with HTTPS and tailnet-only access, so the server keeps binding
127.0.0.1 and nothing is exposed on the LAN. (Alternative: set `LIQ_HOST=0.0.0.0` and open the port, or use
`docker compose up -d`, which also binds loopback only.)

Logs: `journalctl --user -u liquidation-levels -f`. State lives in `data/state.json`.

Edit `config.json` to change coins, port or budgets. Coins on HIP-3 builder dexs use the `dex:NAME` form
(e.g. `xyz:SKHX`); the dex is detected from the prefix. State (positions, open times, watched addresses) is
saved to `data/state.json` every 30 s and restored on restart, so the picture fills in over time.

## What the picture shows

| Mark | Meaning |
|---|---|
| White line | price (1 m candles from the exchange, closes; last bar ticks with trades) |
| Red / yellow / blue lines | real liquidation prices of open positions. Red = leverage at or near the asset's maximum (≥ 75 % of max), yellow = 35–75 %, blue = below. The legend under each ticker shows the actual leverage range per colour for that asset |
| Line thickness | position notional: 1 px at ≤ $10k up to 4 px at ≥ $10M |
| Dashed line | cross-margin position (its liquidation price depends on the whole account, so it can jump as the trader's other positions move). Solid = isolated |
| Line start | when the position opened. Known exactly when the opening fill is found in the trader's fill history, approximately (trade time) when the position opened within the hour we saw them trade, and from the left edge when the position predates what we can see |
| Grey bars at the right edge | liquidation notional per price bin (a horizontal liquidation heatmap) |
| "L max pain" / "S max pain" | the price bin below / above price holding the most liquidation notional |
| "5m mid" / "4h mid" | midpoint of the high–low range over the window (the 50 % pullback level) |
| Coloured dot at the right edge | a position that was just liquidated (fades over 90 s). Recent liquidations are listed in the footer |
| "est. levels" (off by default) | dotted lines from the volume-spike model the TradingView-era stream used (LuxAlgo "Liquidation Levels" rules), for comparison with the real levels |

Filters: minimum position size, price range around last (also sets the y-axis), time window, leverage
tiers, long/short, cross on/off, table view (all shown positions with links to the account on Hypurrscan),
light/dark theme. Hover any line for the position's details.

## How the collector stays within Hyperliquid's limits

Hyperliquid allows 1200 "weight" per minute per IP on the info endpoint. A `clearinghouseState` lookup costs
2, so about 600 accounts/min is the ceiling. The collector uses a token bucket (`info_weight_per_minute`,
default 800) and a second small bucket for `userFills` lookups (`open_time_weight_per_minute`, default
150; each costs 20) used to find true position-open times for the biggest / nearest positions first.
New traders seen in the trade feed are looked up first; known holders are re-checked at least every
`position_refresh_seconds`, and immediately when price trades through their liquidation price.
Addresses that stop trading and hold no tracked position are forgotten after an hour.

**Laptop sleep / downtime.** If the machine sleeps, the collector misses everything in between. On
resume it logs the gap, shows a banner, fades every line not yet re-verified, and re-checks holders nearest
to price first (a mark-price sweep also re-checks any position whose level the mark has already passed, since
liquidations key off mark price, not the last trade). A full pass over all holders takes roughly
`holders / 300` minutes at the rate limit, so expect faded lines for a while after a long sleep.

Coverage grows with time. Compare the "positions" count and "longs/shorts at risk" per coin with the OI
shown in the header to judge how much of open interest is mapped; whales who have not traded since the
collector started will not be seen until they do (the optional seed from the public leaderboard dump,
`https://stats-data.hyperliquid.xyz/Mainnet/leaderboard`, is a natural next step).

## Data-source findings (Oct 2026)

**What the original stream used.** The TradingView-era panels ("Bitcoin / TetherUS PERPETUAL", 30 s) were
Binance USDT-M perps with the open-source LuxAlgo *Liquidation Levels* indicator: a bar whose volume is
> 1.7× its 13-bar average counts as a position open; lines are drawn at `open × (1 ± 1/L)` for L = 25/50/100
and removed when a later bar trades through them. Nothing in it is a real position. "M3A" is not defined
publicly; the behaviour matches 50 % pullback / midpoint lines over a window. "24 h max pain" is the price
bin holding the most outstanding estimated liquidation value above/below price. By October 2026 the stream
had moved to a custom dashboard tagged "hyperliquid:native".

**Hyperliquid (free, real).** Trades carry `users: [buyer, seller]`; `clearinghouseState` returns
`liquidationPx`, `leverage {type, value}`, `entryPx`, `szi`, `positionValue`, `marginUsed` per position
(pass `dex` for HIP-3 dexs, which have separate margin). `userFills` marks liquidation fills with
`liquidation: {liquidatedUser, markPx, method}`. There is no endpoint listing holders of a coin, no batch
lookup, no 30 s candles (1 m is the finest; build 30 s bars from trades if wanted) and no global liquidation
stream. Hyperdash, Coinglass's Hyperliquid pages and Kiyotaka all crawl addresses and poll the same endpoint.
A non-validator node (`--serve-info`, 128 GB RAM, Ubuntu 24.04) removes the rate limit and exposes full state.

**Aggregators.** Coinglass liquidation map/heatmap/max-pain need the $699/mo Professional tier and are a
leverage *model*; its Hyperliquid position endpoints ($299+/mo) are real. Coinalyze is free but only has
liquidation volume history, no levels. Laevitas has node-derived Hyperliquid liquidation events (free tier).
Kingfisher, Velo, MMT, Buildix, Kiyotaka sell heatmaps ($65–$2,499/mo). Hypurrscan has no position data.
Binance exposes a free `forceOrder` liquidation stream (throttled to one event per second per symbol), OI and
long/short ratios, so a Binance estimate layer is possible but would never be "real" levels.

## License

MIT. Vendored TradingView Lightweight Charts™ is Apache 2.0 and requires its attribution logo to stay
visible on the charts. Full notices in `THIRD_PARTY_NOTICES.md`.

## Files

- `server.py` collector + aiohttp server (`/`, `/ws`, `/api/state`, `/static`)
- `static/app.js`, `static/index.html`, `static/style.css` dashboard (lightweight-charts 4.2.3, vendored)
- `config.json` coins and budgets; `data/state.json` persisted state (git-ignored)
- `deploy/` systemd unit + installer; `Dockerfile`, `docker-compose.yml`
