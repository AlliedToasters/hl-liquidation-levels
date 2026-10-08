# Third-party notices

## Design credit

The layout and visual language (narrow per-coin panels, horizontal liquidation lines that start when a
position opens and extend right, red / yellow / blue by leverage, max-pain and pullback lines) follow
**MartyParty's "Crypto Liquidation Levels" livestream**. This project is an independent re-creation using
on-chain Hyperliquid data and is not affiliated with or endorsed by him.
Links: https://linktr.ee/martypartymusic

## TradingView Lightweight Charts™ (vendored at `static/lightweight-charts.js`, v4.2.3)

Copyright (c) 2025 TradingView, Inc. Licensed under the Apache License, Version 2.0:
https://www.apache.org/licenses/LICENSE-2.0 and https://github.com/tradingview/lightweight-charts/blob/master/LICENSE

The license requires the TradingView attribution notice (the logo drawn in the corner of every chart) to
remain visible. Do not disable it in forks.

## aiohttp — Apache License 2.0. https://github.com/aio-libs/aiohttp
## websockets — BSD 3-Clause. https://github.com/python-websockets/websockets

## Volume-spike estimate layer ("est. levels", off by default)

`estimateLevels()` in `static/app.js` is an independent JavaScript implementation of the position-open and
level rules described by the open-source **"Liquidation Levels [LuxAlgo]"** TradingView indicator
(https://www.tradingview.com/script/VBLeqKvy-Liquidation-Levels-LuxAlgo/), which LuxAlgo publishes under
CC BY-NC-SA 4.0. No Pine code is included here; the method is credited to LuxAlgo. If that layer's
provenance matters for your use, delete the function and the "est. levels" toggle.

## Data

Market data and positions come from the public Hyperliquid API (https://hyperliquid.xyz). Addresses shown are
public on-chain data. This software is for information only and is not trading advice.
