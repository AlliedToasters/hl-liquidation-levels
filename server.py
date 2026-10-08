#!/usr/bin/env python3
"""Hyperliquid real-position liquidation-levels collector + dashboard server.

Watches the public trade feed for each configured coin, looks up every
counterparty's on-chain clearinghouse state, and keeps a live table of real
positions (entry, size, leverage, liquidation price).  Serves a browser
dashboard over HTTP + WebSocket.
"""
import asyncio
import json
import logging
import os
import signal
import sys
import time
from collections import deque
from pathlib import Path

import aiohttp
from aiohttp import web

HERE = Path(__file__).resolve().parent
INFO_URL = "https://api.hyperliquid.xyz/info"
WS_URL = "wss://api.hyperliquid.xyz/ws"
CLEARINGHOUSE_WEIGHT = 2   # per Hyperliquid docs: clearinghouseState costs weight 2
OTHER_WEIGHT = 20          # most other info requests cost weight 20

log = logging.getLogger("liq")


def load_config() -> dict:
    """config.json, overridable by --config/--host/--port/--state-file and LIQ_HOST / LIQ_PORT / LIQ_STATE_FILE."""
    import argparse
    ap = argparse.ArgumentParser(description="Hyperliquid liquidation-levels collector + dashboard")
    ap.add_argument("--config", default=os.environ.get("LIQ_CONFIG", str(HERE / "config.json")))
    ap.add_argument("--host", default=os.environ.get("LIQ_HOST"))
    ap.add_argument("--port", type=int, default=os.environ.get("LIQ_PORT"))
    ap.add_argument("--state-file", default=os.environ.get("LIQ_STATE_FILE"))
    ap.add_argument("--coins", help="comma-separated override, e.g. BTC,ETH,xyz:SKHX")
    args = ap.parse_args()
    cfg = json.loads(Path(args.config).read_text())
    if args.host:
        cfg["host"] = args.host
    if args.port:
        cfg["port"] = int(args.port)
    if args.state_file:
        cfg["state_file"] = args.state_file
    if args.coins:
        cfg["coins"] = [c.strip() for c in args.coins.split(",") if c.strip()]
    return cfg


def dex_of(coin: str) -> str:
    """HIP-3 coins are 'dex:NAME'; the main perp dex is ''."""
    return coin.split(":", 1)[0] if ":" in coin else ""


class RateBudget:
    """Token bucket over Hyperliquid info-API weight (1200/min per IP official cap)."""

    def __init__(self, weight_per_minute: int):
        self.capacity = float(weight_per_minute) / 4   # small burst allowance: the API limit is a rolling window
        self.tokens = self.capacity / 2
        self.rate = weight_per_minute / 60.0
        self.last = time.monotonic()

    def penalize(self):
        """Called on HTTP 429: drain the bucket so we pause for a while."""
        self.tokens = -self.rate * 5

    async def take(self, weight: int):
        while True:
            now = time.monotonic()
            self.tokens = min(self.capacity, self.tokens + (now - self.last) * self.rate)
            self.last = now
            if self.tokens >= weight:
                self.tokens -= weight
                return
            await asyncio.sleep((weight - self.tokens) / self.rate)


class Collector:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.coins: list[str] = cfg["coins"]
        self.dexes = sorted({dex_of(c) for c in self.coins})
        self.coins_by_dex = {d: [c for c in self.coins if dex_of(c) == d] for d in self.dexes}
        self.budget = RateBudget(cfg.get("info_weight_per_minute", 900))
        # separate, smaller budget for resolving true position-open times via userFills (weight 20 each)
        self.fills_budget = RateBudget(cfg.get("open_time_weight_per_minute", 200))
        self.session: aiohttp.ClientSession | None = None

        # market data
        self.meta: dict[str, dict] = {}          # coin -> {maxLeverage, szDecimals, marginTiers}
        self.ctx: dict[str, dict] = {}           # coin -> latest asset ctx (markPx, openInterest, funding...)
        self.candles: dict[str, deque] = {c: deque(maxlen=3000) for c in self.coins}
        self.last_px: dict[str, float] = {}

        # positions: coin -> user -> position dict
        self.positions: dict[str, dict[str, dict]] = {c: {} for c in self.coins}
        # address bookkeeping per dex
        self.addr: dict[str, dict[str, dict]] = {d: {} for d in self.dexes}  # dex -> user -> {last_fetch, last_trade, has_pos}
        self.queue: dict[str, deque] = {d: deque() for d in self.dexes}       # dex -> pending users (new / re-traded)
        self.queued: dict[str, set] = {d: set() for d in self.dexes}
        self.seed_queue: deque = deque()   # (dex, user) low-priority: leaderboard accounts never seen trading

        self.clients: set[web.WebSocketResponse] = set()
        self.stats = {"info_calls": 0, "ws_trades": 0, "started": time.time(), "liquidations": 0}
        self.recent_liqs: deque = deque(maxlen=200)
        self.gaps: list[list[float]] = []   # [start, end] wall-clock periods the collector was asleep/offline
        self._dirty = False

    # ------------------------------------------------------------------ info API
    async def info(self, payload: dict, weight: int = OTHER_WEIGHT, budget: RateBudget | None = None):
        await (budget or self.budget).take(weight)
        for attempt in range(4):
            try:
                async with self.session.post(INFO_URL, json=payload, timeout=aiohttp.ClientTimeout(total=20)) as r:
                    self.stats["info_calls"] += 1
                    if r.status == 429:
                        (budget or self.budget).penalize()
                        wait = 3.0 * (attempt + 1)
                        log.warning("429 from info API, backing off %.1fs", wait)
                        await asyncio.sleep(wait)
                        continue
                    r.raise_for_status()
                    return await r.json()
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                log.warning("info %s failed (%s), retry %d", payload.get("type"), e, attempt)
                await asyncio.sleep(1.0 + attempt)
        return None

    async def load_meta(self):
        for dex in self.dexes:
            payload = {"type": "metaAndAssetCtxs"}
            if dex:
                payload["dex"] = dex
            res = await self.info(payload)
            if not res:
                raise RuntimeError(f"could not load meta for dex '{dex}'")
            meta, ctxs = res
            tables = {int(k): v for k, v in meta.get("marginTables", [])}
            for u, ctx in zip(meta["universe"], ctxs):
                if u["name"] in self.coins_by_dex[dex]:
                    tiers = tables.get(u.get("marginTableId"), {}).get("marginTiers", [])
                    self.meta[u["name"]] = {
                        "maxLeverage": u["maxLeverage"],
                        "szDecimals": u["szDecimals"],
                        "marginTiers": tiers,
                        "dex": dex,
                    }
                    self.ctx[u["name"]] = ctx
                    self.last_px[u["name"]] = float(ctx["markPx"])
        missing = [c for c in self.coins if c not in self.meta]
        if missing:
            raise RuntimeError(f"unknown coins: {missing}")
        log.info("meta loaded: %s", {c: m["maxLeverage"] for c, m in self.meta.items()})

    async def backfill_candles(self, coin: str):
        hours = self.cfg.get("backfill_hours", 6)
        now = int(time.time() * 1000)
        res = await self.info({"type": "candleSnapshot", "req": {
            "coin": coin, "interval": self.cfg.get("candle_interval", "1m"),
            "startTime": now - hours * 3600_000, "endTime": now}})
        if not res:
            return
        self.candles[coin].clear()
        for c in res:
            self.candles[coin].append(self._bar(c))
        log.info("backfilled %d candles for %s", len(res), coin)

    @staticmethod
    def _bar(c: dict) -> dict:
        return {"t": c["t"] // 1000, "o": float(c["o"]), "h": float(c["h"]), "l": float(c["l"]),
                "c": float(c["c"]), "v": float(c["v"])}

    async def seed_addresses(self):
        for coin in self.coins:
            res = await self.info({"type": "recentTrades", "coin": coin})
            if res:
                for t in res:
                    for u in t.get("users", []):
                        self.note_trader(dex_of(coin), u, t["time"] / 1000)

    async def seed_from_leaderboard(self):
        """Low-priority sweep of the biggest accounts on the public leaderboard dump, so whales that
        have not traded since we started still get mapped.  Re-run daily."""
        top = self.cfg.get("leaderboard_seed_top", 0)
        if not top:
            return
        url = self.cfg.get("leaderboard_url", "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard")
        while True:
            try:
                async with self.session.get(url, timeout=aiohttp.ClientTimeout(total=120)) as r:
                    r.raise_for_status()
                    data = await r.json(content_type=None)
                rows = data.get("leaderboardRows", data) if isinstance(data, dict) else data
                rows = sorted(rows, key=lambda x: -float(x.get("accountValue", 0) or 0))[:top]
                n = 0
                for row in rows:
                    u = row.get("ethAddress")
                    if not u:
                        continue
                    for dex in self.dexes:
                        a = self.addr[dex].get(u)
                        if a is None or time.time() - a["last_fetch"] > 3600:
                            self.seed_queue.append((dex, u))
                            n += 1
                log.info("leaderboard: queued %d low-priority lookups from top %d accounts", n, len(rows))
            except Exception as e:  # noqa: BLE001
                log.warning("leaderboard seed failed: %s", e)
            await asyncio.sleep(self.cfg.get("leaderboard_refresh_seconds", 86400))

    # ------------------------------------------------------------- address tracking
    def note_trader(self, dex: str, user: str, ts: float):
        a = self.addr[dex].get(user)
        if a is None:
            a = self.addr[dex][user] = {"last_fetch": 0.0, "last_trade": ts, "has_pos": False}
        else:
            a["last_trade"] = ts
        cooldown = self.cfg.get("idle_address_cooldown_seconds", 30)
        if user not in self.queued[dex] and (time.time() - a["last_fetch"]) >= cooldown:
            self.queue[dex].append(user)
            self.queued[dex].add(user)

    async def refresh_user(self, dex: str, user: str):
        payload = {"type": "clearinghouseState", "user": user}
        if dex:
            payload["dex"] = dex
        st = await self.info(payload, CLEARINGHOUSE_WEIGHT)
        now = time.time()
        a = self.addr[dex].setdefault(user, {"last_fetch": 0.0, "last_trade": now, "has_pos": False})
        a["last_fetch"] = now
        if not isinstance(st, dict):
            return
        seen_coins = set()
        for ap in st.get("assetPositions", []):
            p = ap["position"]
            coin = p["coin"]
            if coin not in self.positions:
                continue
            seen_coins.add(coin)
            self.upsert_position(coin, user, p, now)
        for coin in self.coins_by_dex[dex]:
            if coin not in seen_coins and user in self.positions[coin]:
                self.remove_position(coin, user)
        a["has_pos"] = any(user in self.positions[c] for c in self.coins_by_dex[dex])

    def upsert_position(self, coin: str, user: str, p: dict, now: float):
        szi = float(p["szi"])
        if szi == 0:
            if user in self.positions[coin]:
                self.remove_position(coin, user)
            return
        liq = p.get("liquidationPx")
        lev = p["leverage"]
        prev = self.positions[coin].get(user)
        side = "long" if szi > 0 else "short"
        # When did this position open?  Funding is paid hourly, so cumFunding.sinceOpen == 0 means it
        # opened since the last funding tick; if we also just saw this user trade, that trade is the open.
        # Otherwise the origin is unknown until the fills resolver finds the opening fill.
        if prev and prev["side"] == side and prev.get("openedSrc") not in (None, "pending"):
            opened, opened_src = prev.get("opened"), prev["openedSrc"]
        else:
            since_open = float(p.get("cumFunding", {}).get("sinceOpen", "1") or 1)
            a = self.addr[self.meta[coin]["dex"]].get(user, {})
            recent_trade = a.get("last_trade", 0)
            if since_open == 0.0 and recent_trade and now - recent_trade < 1800:
                opened, opened_src = recent_trade, "trade"
            else:
                opened, opened_src = None, "pending"
        pos = {
            "coin": coin, "user": user,
            "side": side,
            "sz": abs(szi),
            "opened": opened, "openedSrc": opened_src,
            "entry": float(p["entryPx"]),
            "liq": float(liq) if liq is not None else None,
            "lev": lev["value"], "levType": lev["type"],
            "notional": float(p["positionValue"]),
            "margin": float(p["marginUsed"]),
            "upnl": float(p.get("unrealizedPnl", 0)),
            "maxLev": p.get("maxLeverage", self.meta[coin]["maxLeverage"]),
            "firstSeen": prev["firstSeen"] if prev else now,
            "updated": now,
        }
        if prev and (prev["side"] != pos["side"]):
            pos["firstSeen"] = now
        changed = (prev is None or any(prev.get(k) != pos[k] for k in ("sz", "entry", "liq", "lev", "levType", "side", "opened")))
        self.positions[coin][user] = pos
        if changed:
            self._dirty = True
            self.broadcast({"type": "pos", "pos": pos})

    def remove_position(self, coin: str, user: str, reason: str | None = None):
        pos = self.positions[coin].pop(user, None)
        if not pos:
            return
        if reason is None:
            reason = "closed"
            mark = self.last_px.get(coin)
            if pos["liq"] is not None and mark is not None:
                # if price went through the liquidation level since our last look, call it a liquidation
                if (pos["side"] == "long" and mark <= pos["liq"] * 1.002) or \
                   (pos["side"] == "short" and mark >= pos["liq"] * 0.998):
                    reason = "liquidated"
        if reason == "liquidated":
            self.stats["liquidations"] += 1
            self.recent_liqs.appendleft({"t": time.time(), **pos})
        self._dirty = True
        self.broadcast({"type": "pos_rm", "coin": coin, "user": user, "reason": reason, "pos": pos})

    async def resolve_open_times(self):
        """Find the real opening fill for positions whose origin is unknown, biggest / nearest first."""
        while True:
            cands = []
            for coin, users in self.positions.items():
                mark = self.last_px.get(coin)
                for pos in users.values():
                    if pos.get("openedSrc") != "pending":
                        continue
                    dist = abs(pos["liq"] / mark - 1) if (mark and pos["liq"]) else 9
                    # prefer what the dashboard will actually show: large and within 15% of price
                    score = pos["notional"] * (1.0 if dist < 0.15 else 0.05)
                    cands.append((score, coin, pos["user"]))
            if not cands:
                await asyncio.sleep(2)
                continue
            cands.sort(reverse=True)
            for _, coin, user in cands[:3]:
                await self.resolve_one(coin, user)

    async def resolve_one(self, coin: str, user: str):
        fills = await self.info({"type": "userFills", "user": user}, OTHER_WEIGHT, self.fills_budget)
        pos = self.positions[coin].get(user)
        if pos is None or pos.get("openedSrc") != "pending":
            return
        opened, src = None, "unknown"
        if isinstance(fills, list):
            want_long = pos["side"] == "long"
            for f in sorted(fills, key=lambda f: f["time"], reverse=True):
                if f.get("coin") != coin:
                    continue
                sp = float(f.get("startPosition", "0"))
                if sp == 0 or (sp > 0) != want_long:
                    opened, src = f["time"] / 1000, "fill"
                    break
        pos["opened"], pos["openedSrc"] = opened, src
        self._dirty = True
        self.broadcast({"type": "pos", "pos": pos})

    async def watchdog(self):
        """Detect the machine sleeping (laptop lid) or the loop stalling: wall clock jumps while we slept."""
        while True:
            t0 = time.time()
            await asyncio.sleep(5)
            gap = time.time() - t0 - 5
            if gap > 60:
                log.warning("time jump of %.0f s detected (sleep/suspend); marking state unverified", gap)
                self.gaps.append([t0, time.time()])
                self.gaps = self.gaps[-20:]
                self._dirty = True
                # every known holder must be re-verified; near-price ones first via the mark sweep below
                for dex in self.dexes:
                    for a in self.addr[dex].values():
                        if a["has_pos"]:
                            a["last_fetch"] = 0.0
                self.broadcast({"type": "gaps", "gaps": self.gaps})

    async def mark_sweep(self):
        """Re-check any position whose liquidation price the *mark* price has already passed.
        Liquidations key off mark price, and trades may not print through a level (or we may have
        missed them), so this catches what the per-trade crossing check cannot."""
        while True:
            await asyncio.sleep(3)
            now = time.time()
            for coin, users in self.positions.items():
                ctx = self.ctx.get(coin)
                if not ctx:
                    continue
                mark = float(ctx["markPx"])
                dex = self.meta[coin]["dex"]
                for user, pos in users.items():
                    liq = pos["liq"]
                    if liq is None or now - pos["updated"] < 20:
                        continue
                    if (pos["side"] == "long" and mark <= liq) or (pos["side"] == "short" and mark >= liq):
                        if user not in self.queued[dex]:
                            self.queue[dex].appendleft(user)
                            self.queued[dex].add(user)

    def refresh_due(self, dex: str, user: str, now: float) -> float:
        """How overdue a holder is (>1 means due).  Positions near price are refreshed often,
        far-away ones rarely, so the rate budget goes where lines can actually change the picture."""
        base = self.cfg.get("position_refresh_seconds", 45)
        dist = 9.0
        for coin in self.coins_by_dex[dex]:
            pos = self.positions[coin].get(user)
            mark = self.last_px.get(coin)
            if pos and pos["liq"] and mark:
                dist = min(dist, abs(pos["liq"] / mark - 1))
        due = base if dist < 0.03 else base * 3 if dist < 0.08 else base * 10 if dist < 0.20 else base * 40
        a = self.addr[dex][user]
        return (now - a["last_fetch"]) / due

    async def address_worker(self):
        """Drain the new-trader queue first; otherwise refresh known position holders round-robin."""
        forget_after = self.cfg.get("forget_idle_address_after_seconds", 3600)
        rounds = 0
        while True:
            did = False
            for dex in self.dexes:
                if self.queue[dex]:
                    user = self.queue[dex].popleft()
                    self.queued[dex].discard(user)
                    await self.refresh_user(dex, user)
                    did = True
            rounds += 1
            # new traders get priority, but every third round goes to refreshing known holders
            # so their liquidation prices never go stale while the queue is busy
            if did and rounds % 3:
                continue
            # periodic refresh of everyone holding a tracked position, most overdue first
            # (overdue = age relative to a refresh interval that grows with distance from price)
            now = time.time()
            stale, forget = [], []
            for dex in self.dexes:
                for user, a in self.addr[dex].items():
                    if a["has_pos"]:
                        score = self.refresh_due(dex, user, now)
                        if score >= 1:
                            stale.append((-score, dex, user))
                    elif now - a["last_trade"] > forget_after and now - a["last_fetch"] > forget_after:
                        forget.append((dex, user))
            for d, u in forget:
                self.addr[d].pop(u, None)
            stale.sort()
            if not stale:
                if self.seed_queue:
                    dex, user = self.seed_queue.popleft()
                    a = self.addr[dex].get(user)
                    if a is None or now - a["last_fetch"] > 600:
                        self.addr[dex].setdefault(user, {"last_fetch": 0.0, "last_trade": 0.0, "has_pos": False})
                        await self.refresh_user(dex, user)
                else:
                    await asyncio.sleep(0.25)
                continue
            # refresh up to a small batch, then loop back so new traders keep priority
            for _, dex, user in stale[:4]:
                await self.refresh_user(dex, user)

    # -------------------------------------------------------------- websocket feed
    async def ws_loop(self):
        while True:
            try:
                async with self.session.ws_connect(WS_URL, heartbeat=25, max_msg_size=2**24) as ws:
                    for coin in self.coins:
                        await ws.send_json({"method": "subscribe", "subscription": {"type": "trades", "coin": coin}})
                        await ws.send_json({"method": "subscribe", "subscription": {
                            "type": "candle", "coin": coin, "interval": self.cfg.get("candle_interval", "1m")}})
                        await ws.send_json({"method": "subscribe", "subscription": {"type": "activeAssetCtx", "coin": coin}})
                    log.info("hyperliquid ws connected, %d coins", len(self.coins))
                    async for msg in ws:
                        if msg.type != aiohttp.WSMsgType.TEXT:
                            if msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                                break
                            continue
                        self.handle_ws(json.loads(msg.data))
            except Exception as e:  # noqa: BLE001
                log.warning("hyperliquid ws error: %s; reconnecting", e)
            await asyncio.sleep(2)

    def handle_ws(self, d: dict):
        ch = d.get("channel")
        if ch == "trades":
            out = []
            for t in d["data"]:
                coin = t["coin"]
                px = float(t["px"])
                self.last_px[coin] = px
                self.stats["ws_trades"] += 1
                for u in t.get("users", []):
                    self.note_trader(dex_of(coin), u, t["time"] / 1000)
                out.append({"coin": coin, "px": px, "sz": float(t["sz"]), "side": t["side"], "t": t["time"] / 1000})
                self.check_crossings(coin, px)
            if out:
                self.broadcast({"type": "trades", "trades": out})
        elif ch == "candle":
            c = d["data"]
            coin = c["s"]
            bar = self._bar(c)
            dq = self.candles[coin]
            if dq and dq[-1]["t"] == bar["t"]:
                dq[-1] = bar
            elif not dq or dq[-1]["t"] < bar["t"]:
                dq.append(bar)
            self.broadcast({"type": "candle", "coin": coin, "bar": bar})
        elif ch == "activeAssetCtx":
            coin = d["data"]["coin"]
            self.ctx[coin] = d["data"]["ctx"]
            self.broadcast({"type": "ctx", "coin": coin, "ctx": self.ctx[coin]})

    def check_crossings(self, coin: str, px: float):
        """When price trades through a known liquidation level, re-check that holder right away."""
        dex = dex_of(coin)
        for user, pos in self.positions[coin].items():
            liq = pos["liq"]
            if liq is None:
                continue
            if (pos["side"] == "long" and px <= liq) or (pos["side"] == "short" and px >= liq):
                if user not in self.queued[dex]:
                    self.queue[dex].appendleft(user)
                    self.queued[dex].add(user)

    # ------------------------------------------------------------------ clients
    def snapshot(self) -> dict:
        return {
            "type": "snapshot",
            "coins": self.coins,
            "meta": self.meta,
            "ctx": self.ctx,
            "candles": {c: list(self.candles[c]) for c in self.coins},
            "positions": {c: list(self.positions[c].values()) for c in self.coins},
            "recentLiqs": list(self.recent_liqs),
            "stats": self.public_stats(),
            "serverTime": time.time(),
        }

    def public_stats(self) -> dict:
        return {
            **self.stats,
            "tracked_addresses": sum(len(a) for a in self.addr.values()),
            "holders": sum(1 for a in self.addr.values() for v in a.values() if v["has_pos"]),
            "queue": sum(len(q) for q in self.queue.values()),
            "seed_queue": len(self.seed_queue),
            "positions": {c: len(p) for c, p in self.positions.items()},
            "budget_tokens": round(self.budget.tokens),
            "unverified": self.unverified_count(),
            "gaps": self.gaps[-3:],
        }

    def unverified_count(self) -> int:
        """Positions not re-checked since the last sleep/offline gap (their lines may be stale)."""
        if not self.gaps:
            return 0
        cutoff = self.gaps[-1][1]
        return sum(1 for users in self.positions.values() for p in users.values() if p["updated"] < cutoff)

    def broadcast(self, msg: dict):
        if not self.clients:
            return
        data = json.dumps(msg)
        for ws in list(self.clients):
            if ws.closed:
                self.clients.discard(ws)
                continue
            asyncio.ensure_future(self._send(ws, data))

    async def _send(self, ws: web.WebSocketResponse, data: str):
        try:
            await ws.send_str(data)
        except Exception:  # noqa: BLE001
            self.clients.discard(ws)

    async def stats_loop(self):
        while True:
            await asyncio.sleep(2)
            self.broadcast({"type": "stats", "stats": self.public_stats()})

    # -------------------------------------------------------------- persistence
    def save_state(self):
        path = Path(self.cfg.get("state_file", "data/state.json"))
        path = path if path.is_absolute() else HERE / path
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({
            "positions": self.positions,
            "addr": self.addr,
            "recentLiqs": list(self.recent_liqs),
            "gaps": self.gaps,
            "saved": time.time(),
        }))
        tmp.replace(path)
        self._dirty = False

    def load_state(self):
        path = Path(self.cfg.get("state_file", "data/state.json"))
        path = path if path.is_absolute() else HERE / path
        if not path.exists():
            return
        try:
            st = json.loads(path.read_text())
        except Exception as e:  # noqa: BLE001
            log.warning("could not load state: %s", e)
            return
        for coin, users in st.get("positions", {}).items():
            if coin in self.positions:
                for pos in users.values():
                    pos.setdefault("opened", None)
                    pos.setdefault("openedSrc", "pending")
                self.positions[coin] = users
        for dex, users in st.get("addr", {}).items():
            if dex in self.addr:
                self.addr[dex] = users
                # everyone restored with a position gets re-verified promptly
                for u, a in users.items():
                    if a.get("has_pos"):
                        a["last_fetch"] = 0.0
        self.recent_liqs.extend(st.get("recentLiqs", []))
        self.gaps = st.get("gaps", [])
        # downtime between the last save and now is a gap too
        if st.get("saved") and time.time() - st["saved"] > 120:
            self.gaps.append([st["saved"], time.time()])
        log.info("restored %s positions", {c: len(p) for c, p in self.positions.items()})

    async def save_loop(self):
        every = self.cfg.get("save_every_seconds", 30)
        while True:
            await asyncio.sleep(every)
            if self._dirty:
                self.save_state()

    # --------------------------------------------------------------------- run
    async def run(self):
        self.session = aiohttp.ClientSession()
        await self.load_meta()
        self.load_state()
        await asyncio.gather(*(self.backfill_candles(c) for c in self.coins))
        await self.seed_addresses()
        tasks = [asyncio.create_task(x()) for x in (self.ws_loop, self.address_worker, self.resolve_open_times,
                                                      self.seed_from_leaderboard, self.watchdog, self.mark_sweep,
                                                      self.stats_loop, self.save_loop)]
        try:
            await asyncio.gather(*tasks)
        finally:
            self.save_state()
            await self.session.close()


# ----------------------------------------------------------------------- web app
async def index(request: web.Request):
    return web.FileResponse(HERE / "static" / "index.html")


async def api_state(request: web.Request):
    col: Collector = request.app["collector"]
    return web.json_response(col.snapshot())


async def ws_handler(request: web.Request):
    col: Collector = request.app["collector"]
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=2**26)
    await ws.prepare(request)
    col.clients.add(ws)
    await ws.send_str(json.dumps(col.snapshot()))
    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.ERROR:
                break
    finally:
        col.clients.discard(ws)
    return ws


def make_app(col: Collector) -> web.Application:
    app = web.Application()
    app["collector"] = col
    app.router.add_get("/", index)
    app.router.add_get("/api/state", api_state)
    app.router.add_get("/ws", ws_handler)
    app.router.add_static("/static", HERE / "static")
    return app


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    cfg = load_config()
    col = Collector(cfg)
    app = make_app(col)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, cfg.get("host", "127.0.0.1"), cfg.get("port", 8787))
    await site.start()
    log.info("dashboard at http://%s:%d", cfg.get("host", "127.0.0.1"), cfg.get("port", 8787))
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for s in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(s, stop.set)
    collector_task = asyncio.create_task(col.run())
    await stop.wait()
    collector_task.cancel()
    try:
        await collector_task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001
        pass
    col.save_state()
    await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
