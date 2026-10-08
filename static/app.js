/* Hyperliquid liquidation levels dashboard — client. */
(() => {
  const LWC = window.LightweightCharts;
  window.addEventListener('error', (e) => console.log('ERR', e.message, e.filename, e.lineno, e.colno));
  window.addEventListener('unhandledrejection', (e) => console.log('REJ', String(e.reason)));
  const $ = (s, el = document) => el.querySelector(s);

  // ------------------------------------------------------------- state
  const state = {
    coins: [], meta: {}, ctx: {}, bars: {}, positions: {}, recentLiqs: [], interval: 60,
    filters: { minNotional: 1000, maxDist: 0.05, windowMin: 120, tiers: { max: true, mid: true, low: true },
               sides: { long: true, short: true }, cross: true, maxPain: true, mids: true, est: false },
    flashes: {},  // coin -> [{liq, tier, until}]
    gapEnd: 0,    // end of the most recent collector sleep/offline gap; older updates are unverified
  };
  const panels = {};
  window.__panels = panels;

  // ---------------------------------------------------------- helpers
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const colors = () => ({
    surface: css('--surface'), ink: css('--ink'), ink2: css('--ink-2'), muted: css('--muted'), grid: css('--grid'),
    axis: css('--axis'), price: css('--price'), max: css('--tier-max'), mid: css('--tier-mid'), low: css('--tier-low'),
    cluster: css('--cluster'), up: css('--up'), down: css('--down'),
  });
  function tierOf(pos) {
    const r = pos.lev / (pos.maxLev || 1);
    return r >= 0.75 ? 'max' : r >= 0.35 ? 'mid' : 'low';
  }
  function tierRanges(maxLev) {
    const hi = Math.ceil(maxLev * 0.75), mid = Math.ceil(maxLev * 0.35);
    return { max: `≥${hi}x`, mid: `${mid}–${hi - 1}x`, low: `<${mid}x` };
  }
  function fmtPx(px) {
    if (px == null || !isFinite(px)) return '–';
    const a = Math.abs(px);
    const d = a >= 10000 ? 0 : a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 6;
    return px.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtUsd(v) {
    const a = Math.abs(v);
    if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (v / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M';
    if (a >= 1e3) return '$' + (v / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'k';
    return '$' + v.toFixed(0);
  }
  const fmtPct = (x, d = 2) => (x * 100).toFixed(d) + '%';
  const shortAddr = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  function fmtAge(sec) {
    if (sec < 60) return Math.round(sec) + 's';
    if (sec < 3600) return Math.round(sec / 60) + 'm';
    if (sec < 86400) return (sec / 3600).toFixed(1) + 'h';
    return (sec / 86400).toFixed(1) + 'd';
  }
  function openedText(p) {
    if (p.opened != null) return fmtAge(Date.now() / 1000 - p.opened) + (p.openedSrc === 'fill' ? '' : ' ~');
    return p.openedSrc === 'pending' ? 'resolving…' : 'older';
  }
  // time <-> fractional logical index for a coin's bar array (panels sync by time, not by index)
  function timeToLogical(coin, t) {
    const b = state.bars[coin]; if (!b || !b.length) return null;
    const n = b.length, iv = state.interval;
    if (t <= b[0].t) return (t - b[0].t) / iv;
    if (t >= b[n - 1].t) return (n - 1) + (t - b[n - 1].t) / iv;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (b[m].t <= t) lo = m; else hi = m - 1; }
    return lo + (t - b[lo].t) / Math.max(1, b[lo + 1].t - b[lo].t);
  }
  function logicalToTime(coin, l) {
    const b = state.bars[coin]; if (!b || !b.length) return null;
    const n = b.length, iv = state.interval, i = Math.floor(l);
    if (i < 0) return b[0].t + l * iv;
    if (i >= n - 1) return b[n - 1].t + (l - (n - 1)) * iv;
    return b[i].t + (l - i) * (b[i + 1].t - b[i].t);
  }
  let syncing = false;
  function syncRange(src, r) {
    if (syncing || !r) return;
    const tFrom = logicalToTime(src.coin, r.from), tTo = logicalToTime(src.coin, r.to);
    if (tFrom == null) return;
    syncing = true;
    try {
      for (const p of Object.values(panels)) {
        if (p === src) continue;
        const from = timeToLogical(p.coin, tFrom), to = timeToLogical(p.coin, tTo);
        if (from != null && to != null && to > from) p.chart.timeScale().setVisibleLogicalRange({ from, to });
      }
    } finally { syncing = false; }
  }
  function syncCrosshair(src, time) {
    for (const p of Object.values(panels)) {
      if (p === src) continue;
      if (time == null) { p.chart.clearCrosshairPosition(); continue; }
      const b = state.bars[p.coin]; if (!b || !b.length) continue;
      let lo = 0, hi = b.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (b[m].t <= time) lo = m; else hi = m - 1; }
      p.chart.setCrosshairPosition(b[lo].c, b[lo].t, p.series);
    }
  }
  const lineWidth = (notional) => 1 + Math.max(0, Math.min(3, Math.log10(Math.max(notional, 1) / 1e4)));

  function visiblePositions(coin) {
    const f = state.filters, mark = lastPrice(coin);
    const out = [];
    for (const p of Object.values(state.positions[coin] || {})) {
      if (p.liq == null || p.notional < f.minNotional) continue;
      if (!f.sides[p.side] || !f.tiers[tierOf(p)]) continue;
      if (!f.cross && p.levType === 'cross') continue;
      if (mark && f.maxDist < 1 && Math.abs(p.liq - mark) / mark > f.maxDist) continue;
      out.push(p);
    }
    return out;
  }
  function lastPrice(coin) {
    const b = state.bars[coin];
    return b && b.length ? b[b.length - 1].c : (state.ctx[coin] ? +state.ctx[coin].markPx : null);
  }

  // -------------------------------------------- volume-spike estimate layer
  // Port of the open-source LuxAlgo "Liquidation Levels" rules (what the TradingView-era stream used):
  // a bar whose volume exceeds 1.7x its 13-bar average is treated as a position open at the bar's open,
  // levels are drawn at open*(1 ± 1/L) and removed once a later bar trades through them.
  const estCache = {};
  function estimateLevels(coin) {
    const bars = state.bars[coin] || [];
    const m = state.meta[coin];
    if (bars.length < 15 || !m) return [];
    const key = bars.length + ':' + bars[bars.length - 1].t + ':' + bars[bars.length - 1].c;
    if (estCache[coin] && estCache[coin].key === key) return estCache[coin].levels;
    const tiers = [[m.maxLeverage, 'max'], [m.maxLeverage / 2, 'mid'], [m.maxLeverage / 4, 'low']];
    let levels = [];
    for (let i = 13; i < bars.length; i++) {
      const b = bars[i];
      // remove levels this bar trades through
      levels = levels.filter((l) => !(b.h > l.y && b.l < l.y));
      let vsum = 0; for (let k = i - 12; k <= i; k++) vsum += bars[k].v;
      const vbMA = vsum / 13, ref = b.o;
      const spike = b.v > vbMA * 1.7;
      const volatile = (b.l !== ref && ref / (ref - b.l) <= 10) || (b.h !== ref && ref / (b.h - ref) <= 10);
      const eC = ref * (1 + 1 / 333) < b.h || ref * (1 - 1 / 333) > b.l;
      if (!(spike || volatile) || !eC) continue;
      const width = b.v > vbMA * 3.7 ? 3 : b.v > vbMA * 2.7 ? 2 : 1;
      for (const [L, tier] of tiers) {
        const sh = ref * (1 + 1 / L), lo = ref * (1 - 1 / L);
        if (sh > b.h) levels.push({ y: sh, t: b.t, tier, width, side: 'short' });
        if (lo < b.l) levels.push({ y: lo, t: b.t, tier, width, side: 'long' });
      }
      if (levels.length > 500) levels = levels.slice(-500);
    }
    estCache[coin] = { key, levels };
    return levels;
  }
  function midLevels(coin) {
    const bars = state.bars[coin] || [];
    if (!bars.length) return [];
    const out = [];
    for (const [n, label] of [[Math.max(1, Math.round(300 / state.interval)), '5m mid'], [Math.round(14400 / state.interval), '4h mid']]) {
      const sl = bars.slice(-n);
      let h = -Infinity, l = Infinity;
      for (const b of sl) { if (b.h > h) h = b.h; if (b.l < l) l = b.l; }
      if (isFinite(h) && isFinite(l)) out.push({ y: (h + l) / 2, label });
    }
    return out;
  }

  // ------------------------------------------------- liquidation primitive
  class LiqPrimitive {
    constructor(panel) { this.panel = panel; this._view = { renderer: () => this, zOrder: () => 'top' }; }
    attached({ chart, series, requestUpdate }) { this.chart = chart; this.series = series; this.requestUpdate = requestUpdate; }
    detached() {}
    updateAllViews() {}
    paneViews() { return [this._view]; }

    xFor(ts, width) {
      const bars = state.bars[this.panel.coin];
      if (!bars || !bars.length) return null;
      const iv = state.interval;
      let logical;
      if (ts < bars[0].t) logical = -(bars[0].t - ts) / iv;
      else {
        let lo = 0, hi = bars.length - 1;
        while (lo < hi) { const m = (lo + hi + 1) >> 1; if (bars[m].t <= ts) lo = m; else hi = m - 1; }
        logical = lo + Math.min(1.5, (ts - bars[lo].t) / iv);
      }
      // logicalToCoordinate only accepts integers, so interpolate with the bar spacing
      const ts_ = this.chart.timeScale();
      const base = Math.floor(logical);
      const x0 = ts_.logicalToCoordinate(Math.max(0, base));
      if (x0 == null) return null;
      const spacing = ts_.options().barSpacing || 6;
      const x = x0 + (logical - Math.max(0, base)) * spacing;
      return Math.max(0, Math.min(x, width));
    }

    draw(target) {
      target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
        const W = mediaSize.width, H = mediaSize.height;
        const C = colors();
        const coin = this.panel.coin;
        const pos = visiblePositions(coin);
        const now = Date.now() / 1000;
        this.panel.hits = [];

        // cluster histogram (notional per price bin) along the right edge
        const top = this.series.coordinateToPrice(0), bot = this.series.coordinateToPrice(H);
        if (top != null && bot != null && top > bot) {
          const nb = Math.max(20, Math.floor(H / 6));
          const bins = new Float64Array(nb);
          const step = (top - bot) / nb;
          let maxBin = 0;
          for (const p of pos) {
            const k = Math.floor((p.liq - bot) / step);
            if (k >= 0 && k < nb) { bins[k] += p.notional; if (bins[k] > maxBin) maxBin = bins[k]; }
          }
          if (maxBin > 0) {
            const maxW = Math.min(64, W * 0.3);
            ctx.fillStyle = C.cluster;
            for (let k = 0; k < nb; k++) {
              if (!bins[k]) continue;
              const w = Math.max(1, (bins[k] / maxBin) * maxW);
              const y0 = this.series.priceToCoordinate(bot + (k + 1) * step), y1 = this.series.priceToCoordinate(bot + k * step);
              ctx.fillRect(W - w, y0, w, Math.max(1, y1 - y0 - 1));
            }
            // max pain: the price bin holding the most liquidation notional below price (longs) and above (shorts)
            const mark = lastPrice(coin);
            if (state.filters.maxPain && mark) {
              const kMark = Math.floor((mark - bot) / step);
              let bestL = -1, bestS = -1;
              for (let k = 0; k < nb; k++) {
                if (!bins[k]) continue;
                if (k < kMark && (bestL < 0 || bins[k] > bins[bestL])) bestL = k;
                if (k > kMark && (bestS < 0 || bins[k] > bins[bestS])) bestS = k;
              }
              ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
              for (const [k, label] of [[bestL, 'L max pain'], [bestS, 'S max pain']]) {
                if (k < 0) continue;
                const price = bot + (k + 0.5) * step, y = this.series.priceToCoordinate(price);
                ctx.strokeStyle = C.ink2; ctx.lineWidth = 2; ctx.setLineDash([]); ctx.globalAlpha = 0.9;
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W - (bins[k] / maxBin) * maxW - 2, y); ctx.stroke();
                ctx.globalAlpha = 1; ctx.fillStyle = C.ink2;
                ctx.fillText(`${label} ${fmtPx(price)} · ${fmtUsd(bins[k])}`, 4, y - 2);
              }
            }
          }
        }
        // 50% pullback / mid levels over 5 min and 4 h windows
        if (state.filters.mids) {
          ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
          for (const m of midLevels(coin)) {
            const y = this.series.priceToCoordinate(m.y);
            if (y == null || y < 0 || y > H) continue;
            ctx.strokeStyle = C.muted; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); ctx.globalAlpha = 0.9;
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
            ctx.globalAlpha = 1; ctx.fillStyle = C.muted; ctx.fillText(`${m.label} ${fmtPx(m.y)}`, 4, y + 2);
          }
          ctx.setLineDash([]);
        }
        // optional estimated layer (volume-spike model), dotted and faint so it never reads as a real position
        if (state.filters.est) {
          ctx.setLineDash([1, 3]); ctx.globalAlpha = 0.55;
          for (const l of estimateLevels(coin)) {
            if (!state.filters.tiers[l.tier] || !state.filters.sides[l.side]) continue;
            const y = this.series.priceToCoordinate(l.y);
            if (y == null || y < 0 || y > H) continue;
            const x0 = this.xFor(l.t, W);
            if (x0 == null || x0 >= W) continue;
            ctx.strokeStyle = C[l.tier]; ctx.lineWidth = l.width;
            ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(W, y); ctx.stroke();
          }
          ctx.setLineDash([]); ctx.globalAlpha = 1;
        }

        // liquidation lines: low tier first, biggest last so they sit on top
        const order = { low: 0, mid: 1, max: 2 };
        pos.sort((a, b) => (order[tierOf(a)] - order[tierOf(b)]) || (a.notional - b.notional));
        const labels = pos.slice().sort((a, b) => b.notional - a.notional).slice(0, 3);
        for (const p of pos) {
          const y = this.series.priceToCoordinate(p.liq);
          if (y == null || y < -2 || y > H + 2) continue;
          const x0 = p.opened != null ? this.xFor(p.opened, W) : 0;
          if (x0 == null || x0 >= W) continue;
          const tier = tierOf(p);
          ctx.strokeStyle = C[tier];
          ctx.globalAlpha = (state.gapEnd && p.updated < state.gapEnd) ? 0.3 : 0.85;  // unverified since offline gap
          ctx.lineWidth = lineWidth(p.notional);
          ctx.setLineDash(p.levType === 'cross' ? [5, 4] : []);
          ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(W, y); ctx.stroke();
          this.panel.hits.push({ y, p });
        }
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        // direct labels on the three largest visible positions
        ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
        let lastLabelY = -1e9;
        for (const p of labels.sort((a, b) => a.liq - b.liq)) {
          const y = this.series.priceToCoordinate(p.liq);
          if (y == null || y < 0 || y > H - 12 || Math.abs(y - lastLabelY) < 12) continue;
          lastLabelY = y;
          ctx.fillStyle = C.ink2;
          ctx.fillText(`${fmtUsd(p.notional)} ${p.side === 'long' ? 'L' : 'S'} ${p.lev}x`, W - 70, y + 2);
        }
        // recent liquidation flashes
        const fl = state.flashes[coin] || [];
        for (const f of fl) {
          if (f.until < now) continue;
          const y = this.series.priceToCoordinate(f.liq);
          if (y == null) continue;
          const a = Math.min(1, (f.until - now) / 20);
          ctx.globalAlpha = a; ctx.fillStyle = C[f.tier];
          ctx.beginPath(); ctx.arc(W - 6, y, 4, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        }
      });
    }
  }

  // ------------------------------------------------------------ panel
  class Panel {
    constructor(coin) {
      this.coin = coin;
      this.hits = [];
      const el = document.createElement('section');
      el.className = 'panel';
      const label = coin.includes(':') ? coin.split(':')[1] : coin;
      const dex = coin.includes(':') ? coin.split(':')[0] : '';
      el.innerHTML = `
        <div class="panel-head">
          <div class="row"><span class="ticker">$${label}${dex ? `<small>${dex}</small>` : ''}</span><span class="chg"></span></div>
          <div class="row"><span class="price">–</span><span class="kv kv-r"></span></div>
          <div class="kv kv-b"></div>
        </div>
        <div class="legend"></div>
        <div class="chart"><div></div></div>`;
      $('#panels').appendChild(el);
      this.el = el;
      this.priceEl = $('.price', el); this.chgEl = $('.chg', el); this.kvR = $('.kv-r', el); this.kvB = $('.kv-b', el);
      this.legendEl = $('.legend', el);
      this.buildChart($('.chart > div', el));
      this.renderLegend();
    }
    buildChart(container) {
      const C = colors();
      this.chart = LWC.createChart(container, {
        autoSize: true,
        layout: { background: { type: 'solid', color: C.surface }, textColor: C.muted, fontFamily: 'system-ui, sans-serif', fontSize: 11 },
        grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
        rightPriceScale: { borderColor: C.axis, scaleMargins: { top: 0.04, bottom: 0.04 } },
        timeScale: { borderColor: C.axis, timeVisible: true, secondsVisible: false, rightOffset: 14, minBarSpacing: 0.5,
          tickMarkFormatter: (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
        localization: { timeFormatter: (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                        priceFormatter: (p) => fmtPx(p) },
        crosshair: { mode: LWC.CrosshairMode.Normal, vertLine: { color: C.axis, labelBackgroundColor: C.ink2 },
                     horzLine: { color: C.axis, labelBackgroundColor: C.ink2 } },
        handleScale: { axisPressedMouseMove: true },
      });
      this.series = this.chart.addLineSeries({
        color: C.price, lineWidth: 2, priceLineVisible: true, lastValueVisible: true, crosshairMarkerVisible: false,
        priceLineColor: C.ink2, priceLineStyle: LWC.LineStyle.Dotted,
        autoscaleInfoProvider: (orig) => this.autoscale(orig),
      });
      this.prim = new LiqPrimitive(this);
      this.series.attachPrimitive(this.prim);
      this.chart.subscribeCrosshairMove((param) => this.onCrosshair(param));
      this.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => syncRange(this, r));
      container.addEventListener('mouseleave', () => { hideTooltip(); syncCrosshair(this, null); });
      this.setBars(state.bars[this.coin] || []);
    }
    autoscale(orig) {
      const r = orig();
      const mark = lastPrice(this.coin);
      if (!mark) return r;
      const d = state.filters.maxDist;
      let lo = mark * (1 - Math.min(d, 0.5)), hi = mark * (1 + Math.min(d, 0.5));
      if (d >= 1) {
        for (const p of visiblePositions(this.coin)) {
          if (p.liq > mark * 0.3 && p.liq < mark * 3) { lo = Math.min(lo, p.liq); hi = Math.max(hi, p.liq); }
        }
      }
      if (r && r.priceRange) { lo = Math.min(lo, r.priceRange.minValue); hi = Math.max(hi, r.priceRange.maxValue); }
      return { priceRange: { minValue: lo, maxValue: hi }, margins: r ? r.margins : undefined };
    }
    setBars(bars) {
      this.series.setData(bars.map((b) => ({ time: b.t, value: b.c })));
      this.applyWindow();
      this.renderHead();
    }
    applyWindow() {
      const bars = state.bars[this.coin] || [];
      if (!bars.length) return;
      const n = Math.round(state.filters.windowMin * 60 / state.interval);
      const last = bars.length - 1;
      syncing = true;
      try { this.chart.timeScale().setVisibleLogicalRange({ from: last - n, to: last + 14 }); } finally { syncing = false; }
    }
    onBar(bar, isNew) {
      this.series.update({ time: bar.t, value: bar.c });
      if (isNew) this.redraw();
    }
    onTick(px) {
      const bars = state.bars[this.coin];
      if (!bars || !bars.length) return;
      const b = bars[bars.length - 1];
      b.c = px; if (px > b.h) b.h = px; if (px < b.l) b.l = px;
      this.series.update({ time: b.t, value: px });
      this.renderHead();
    }
    renderLegend() {
      const m = state.meta[this.coin];
      if (!m) return;
      const r = tierRanges(m.maxLeverage);
      this.legendEl.innerHTML =
        `<span><i class="sw sw-max"></i>${r.max}</span><span><i class="sw sw-mid"></i>${r.mid}</span><span><i class="sw sw-low"></i>${r.low}</span>` +
        `<span title="cross-margin positions are dashed">┄ cross</span>`;
    }
    renderHead() {
      const px = lastPrice(this.coin), c = state.ctx[this.coin];
      this.priceEl.textContent = fmtPx(px);
      if (c && px) {
        const chg = px / +c.prevDayPx - 1;
        this.chgEl.textContent = (chg >= 0 ? '+' : '') + fmtPct(chg);
        this.chgEl.className = 'chg ' + (chg >= 0 ? 'up' : 'down');
        this.kvR.innerHTML = `<span>OI <b>${fmtUsd(+c.openInterest * +c.markPx)}</b></span><span>fund <b>${(+c.funding * 100).toFixed(4)}%</b></span>`;
      }
      const all = Object.values(state.positions[this.coin] || {});
      const vis = visiblePositions(this.coin);
      let longN = 0, shortN = 0;
      for (const p of vis) (p.side === 'long' ? (longN += p.notional) : (shortN += p.notional));
      this.kvB.innerHTML = `<span>${vis.length}/${all.length} positions shown</span>` +
        `<span>longs at risk <b>${fmtUsd(longN)}</b></span><span>shorts at risk <b>${fmtUsd(shortN)}</b></span>`;
    }
    redraw() {
      this.renderHead();
      if (this.prim.requestUpdate) this.prim.requestUpdate();
    }
    restyle() {
      const C = colors();
      this.chart.applyOptions({
        layout: { background: { type: 'solid', color: C.surface }, textColor: C.muted },
        grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
        rightPriceScale: { borderColor: C.axis }, timeScale: { borderColor: C.axis },
        crosshair: { vertLine: { color: C.axis, labelBackgroundColor: C.ink2 }, horzLine: { color: C.axis, labelBackgroundColor: C.ink2 } },
      });
      this.series.applyOptions({ color: C.price, priceLineColor: C.ink2 });
      this.redraw();
    }
    onCrosshair(param) {
      if (!param.sourceEvent) return;  // programmatic crosshair from another panel: no tooltip, no re-sync
      if (!param.point || param.point.x < 0 || param.point.y < 0) { hideTooltip(); syncCrosshair(this, null); return; }
      syncCrosshair(this, param.time != null ? param.time : null);
      const y = param.point.y;
      const price = this.series.coordinateToPrice(y);
      const near = this.hits.filter((h) => Math.abs(h.y - y) <= 5).sort((a, b) => b.p.notional - a.p.notional).slice(0, 8);
      const mark = lastPrice(this.coin);
      const rect = this.el.getBoundingClientRect();
      const C = colors();
      let html = `<div class="tt-price">${fmtPx(price)}${mark ? ` · ${fmtPct(price / mark - 1)} from last` : ''}</div>`;
      if (near.length) {
        html += '<table>' + near.map(({ p }) =>
          `<tr><td><i class="mark" style="background:${C[tierOf(p)]}"></i></td><td>${p.side}</td><td>${p.lev}x ${p.levType}</td>` +
          `<td class="n">${fmtUsd(p.notional)}</td><td class="n">liq ${fmtPx(p.liq)}</td><td class="n">in ${fmtPx(p.entry)}</td>` +
          `<td class="mono">${shortAddr(p.user)}</td><td>${openedText(p)}</td></tr>`).join('') + '</table>';
      }
      showTooltip(html, rect.left + param.point.x, rect.top + param.point.y);
    }
  }

  // ---------------------------------------------------------- tooltip
  const tip = $('#tooltip');
  function showTooltip(html, x, y) {
    tip.innerHTML = html; tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top + h > window.innerHeight - 8) top = y - h - 14;
    tip.style.left = Math.max(4, left) + 'px'; tip.style.top = Math.max(4, top) + 'px';
  }
  function hideTooltip() { tip.hidden = true; }

  // -------------------------------------------------------- table view
  function renderTable() {
    const el = $('#table-view');
    if (el.hidden) return;
    const now = Date.now() / 1000;
    el.innerHTML = state.coins.map((coin) => {
      const mark = lastPrice(coin) || 1;
      const rows = visiblePositions(coin).sort((a, b) => Math.abs(a.liq / mark - 1) - Math.abs(b.liq / mark - 1));
      return `<h2>${coin} — ${rows.length} positions (filters applied), last ${fmtPx(mark)}</h2>
        <table><thead><tr><th>side</th><th>lev</th><th>tier</th><th>size</th><th>notional</th><th>entry</th><th>liq price</th><th>distance</th><th>uPnL</th><th>opened</th><th>account</th></tr></thead><tbody>` +
        rows.map((p) => `<tr><td>${p.side}</td><td>${p.lev}x ${p.levType}</td><td>${tierOf(p)}</td><td>${p.sz}</td><td>${fmtUsd(p.notional)}</td>` +
          `<td>${fmtPx(p.entry)}</td><td>${fmtPx(p.liq)}</td><td>${fmtPct(p.liq / mark - 1)}</td><td>${fmtUsd(p.upnl)}</td><td>${openedText(p)}</td>` +
          `<td class="mono"><a href="https://hypurrscan.io/address/${p.user}" target="_blank" rel="noopener">${p.user}</a></td></tr>`).join('') +
        '</tbody></table>';
    }).join('');
  }

  // --------------------------------------------------------- controls
  function redrawAll() { for (const p of Object.values(panels)) p.redraw(); renderTable(); }
  $('#min-notional').addEventListener('change', (e) => { state.filters.minNotional = +e.target.value; redrawAll(); });
  $('#max-dist').addEventListener('change', (e) => {
    state.filters.maxDist = +e.target.value;
    for (const p of Object.values(panels)) p.chart.priceScale('right').applyOptions({ autoScale: true });
    redrawAll();
  });
  $('#window').addEventListener('change', (e) => { state.filters.windowMin = +e.target.value; for (const p of Object.values(panels)) p.applyWindow(); });
  $('#tier-chips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    b.classList.toggle('on'); state.filters.tiers[b.dataset.tier] = b.classList.contains('on'); redrawAll();
  });
  $('#side-chips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    b.classList.toggle('on'); state.filters.sides[b.dataset.side] = b.classList.contains('on'); redrawAll();
  });
  $('#toggle-cross').addEventListener('click', (e) => {
    state.filters.cross = !state.filters.cross; e.target.textContent = `cross: ${state.filters.cross ? 'on' : 'off'}`;
    e.target.classList.toggle('on', !state.filters.cross); redrawAll();
  });
  for (const [id, key] of [['toggle-maxpain', 'maxPain'], ['toggle-mids', 'mids'], ['toggle-est', 'est']]) {
    $('#' + id).addEventListener('click', (e) => {
      state.filters[key] = !state.filters[key]; e.currentTarget.classList.toggle('on', state.filters[key]); redrawAll();
    });
  }
  $('#toggle-table').addEventListener('click', (e) => {
    const el = $('#table-view'); el.hidden = !el.hidden; e.target.classList.toggle('on', !el.hidden); renderTable();
  });
  $('#toggle-theme').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.getAttribute('data-theme') !== 'light';
    root.setAttribute('data-theme', dark ? 'light' : 'dark');
    $('#toggle-theme').textContent = dark ? '☀' : '☾';
    try { localStorage.setItem('liq-theme', dark ? 'light' : 'dark'); } catch (_) {}
    for (const p of Object.values(panels)) p.restyle();
  });
  try {
    const t = localStorage.getItem('liq-theme');
    if (t) { document.documentElement.setAttribute('data-theme', t); $('#toggle-theme').textContent = t === 'dark' ? '☾' : '☀'; }
  } catch (_) {}
  setInterval(renderTable, 5000);
  setInterval(() => { for (const p of Object.values(panels)) p.redraw(); }, 10000);  // age the flashes, keep head stats fresh

  // ---------------------------------------------------------- status
  function setGaps(gaps) {
    const g = gaps && gaps.length ? gaps[gaps.length - 1] : null;
    state.gapEnd = g ? g[1] : 0;
  }
  function renderBanner(s) {
    const el = $('#banner');
    const g = s.gaps && s.gaps.length ? s.gaps[s.gaps.length - 1] : null;
    const recent = g && (Date.now() / 1000 - g[1]) < 6 * 3600 && s.unverified > 0;
    el.hidden = !recent;
    if (!recent) return;
    const f = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.textContent = `Collector was offline ${f(g[0])}–${f(g[1])} (machine asleep?). ${s.unverified} positions not re-verified yet; their lines are faded until checked. Nearest to price are checked first.`;
  }
  function renderStats(s) {
    renderBanner(s);
    const pos = Object.values(s.positions || {}).reduce((a, b) => a + b, 0);
    $('#stat-positions').innerHTML = `positions <b>${pos}</b>`;
    $('#stat-holders').innerHTML = `holders <b>${s.holders}</b>`;
    $('#stat-addr').innerHTML = `addresses watched <b>${s.tracked_addresses}</b> · queue <b>${s.queue}</b>`;
    const mins = Math.max(1, (Date.now() / 1000 - s.started) / 60);
    $('#stat-calls').innerHTML = `api calls <b>${s.info_calls}</b> (${(s.info_calls / mins).toFixed(0)}/min) · liquidations seen <b>${s.liquidations}</b>`;
  }
  function renderLiqTicker() {
    const items = state.recentLiqs.slice(0, 6).map((l) =>
      `${l.coin.replace('xyz:', '')} ${l.side} ${fmtUsd(l.notional)} ${l.lev}x @ ${fmtPx(l.liq)}`);
    $('#stat-liqs').textContent = items.length ? 'liquidated: ' + items.join('  ·  ') : 'no liquidations observed yet';
  }

  // ------------------------------------------------------------- socket
  function handle(msg) {
    switch (msg.type) {
      case 'snapshot': {
        state.coins = msg.coins; state.meta = msg.meta; state.ctx = msg.ctx; state.recentLiqs = msg.recentLiqs || [];
        state.bars = msg.candles;
        const anyBars = Object.values(msg.candles).find((b) => b.length > 1);
        if (anyBars) state.interval = anyBars[1].t - anyBars[0].t;
        state.positions = {};
        for (const c of msg.coins) { state.positions[c] = {}; for (const p of msg.positions[c]) state.positions[c][p.user] = p; }
        for (const c of msg.coins) {
          if (!panels[c]) panels[c] = new Panel(c); else panels[c].setBars(state.bars[c]);
          panels[c].renderLegend(); panels[c].redraw();
        }
        setGaps(msg.stats.gaps); renderStats(msg.stats); renderLiqTicker(); renderTable();
        break;
      }
      case 'trades': {
        for (const t of msg.trades) if (panels[t.coin]) panels[t.coin].onTick(t.px);
        break;
      }
      case 'candle': {
        const bars = state.bars[msg.coin]; if (!bars) break;
        const last = bars[bars.length - 1];
        let isNew = false;
        if (last && last.t === msg.bar.t) bars[bars.length - 1] = msg.bar;
        else if (!last || last.t < msg.bar.t) { bars.push(msg.bar); isNew = true; }
        else break;
        if (panels[msg.coin]) panels[msg.coin].onBar(msg.bar, isNew);
        break;
      }
      case 'pos': {
        const p = msg.pos; if (!state.positions[p.coin]) break;
        state.positions[p.coin][p.user] = p;
        if (panels[p.coin]) panels[p.coin].redraw();
        break;
      }
      case 'pos_rm': {
        if (!state.positions[msg.coin]) break;
        delete state.positions[msg.coin][msg.user];
        if (msg.reason === 'liquidated' && msg.pos && msg.pos.liq != null) {
          (state.flashes[msg.coin] = state.flashes[msg.coin] || []).push({ liq: msg.pos.liq, tier: tierOf(msg.pos), until: Date.now() / 1000 + 90 });
          state.flashes[msg.coin] = state.flashes[msg.coin].slice(-30);
          state.recentLiqs.unshift({ t: Date.now() / 1000, ...msg.pos }); state.recentLiqs = state.recentLiqs.slice(0, 50);
          renderLiqTicker();
        }
        if (panels[msg.coin]) panels[msg.coin].redraw();
        break;
      }
      case 'ctx': state.ctx[msg.coin] = msg.ctx; if (panels[msg.coin]) panels[msg.coin].renderHead(); break;
      case 'stats': setGaps(msg.stats.gaps); renderStats(msg.stats); break;
      case 'gaps': setGaps(msg.gaps); redrawAll(); break;
    }
  }
  let backoff = 1000;
  function connect() {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => { $('#conn-dot').className = 'dot ok'; backoff = 1000; };
    ws.onmessage = (e) => { try { const m = JSON.parse(e.data); handle(m); } catch (err) { console.log('HANDLE ERR', String(err), err && err.stack); } };
    ws.onclose = () => { $('#conn-dot').className = 'dot bad'; setTimeout(connect, backoff); backoff = Math.min(15000, backoff * 2); };
    ws.onerror = () => ws.close();
  }
  connect();
})();
