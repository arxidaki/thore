/* Cyprus seismic dashboard: native rendering of Raspberry Shake FDSN data. */
(() => {
  'use strict';

  // Region + cadence. Edit BBOX to move the dashboard somewhere else.
  const BBOX = { minLat: 34.3, maxLat: 35.9, minLon: 31.9, maxLon: 34.8 };
  const DISPLAY_MINUTES = 10;
  const INITIAL_FETCH_MINUTES = 60;
  const POLL_MS = 30000;
  // Liveness sweep: every 5 min re-check the inventory for new/removed
  // stations and hide cards with no data for DEAD_AFTER_MS (45 min clears the
  // ~30 min FDSN archive embargo, so a stream outage can't mass-hide stations).
  const SWEEP_MS = 5 * 60000;
  const DEAD_AFTER_MS = 45 * 60000;

  // Device badges (validated categorical set; every badge carries its text label).
  const TYPE_COLORS = {
    '1D': '#4f8dff',
    '3D': '#ffd23f',
    '4D': '#f2711c',
    'S&B': '#b48cff',
    BOOM: '#b48cff',
    ACC: '#f2711c',
    '?': '#6b7688'
  };
  const STATUS_COLORS = { good: '#7ef3a4', warn: '#ffc857', bad: '#ff6b6b' };
  // Per-station accent: keys each card's edge to its map label (identity is
  // always also carried by the station code text on both ends).
  const STA_ACCENTS = ['#ff9d6b', '#ffd24d', '#9bec6f', '#3fe3a1', '#45d7e8', '#6ea8ff', '#a98bff', '#f07ee0', '#ff6b8a', '#e3d3b2'];
  const WAVE_COLOR = '#3fe3e8';
  const STRIP_BG = '#010409';

  // Data lag thresholds ("good" is reachable only via the live stream;
  // the FDSN archive trails real time by up to ~30 min).
  const LAG_GOOD_MS = 2 * 60000;
  const LAG_WARN_MS = 30 * 60000;

  // CAPS live stream — StationView's public real-time channel. The
  // credentials are the ones RS ships in StationView's own client bundle.
  const STREAM = {
    url: 'wss://data.raspberryshake.org/caps/',
    user: 'swarm',
    pass: 'ujHsN9qbYiTAx69H',
    backfillMs: 12 * 60000
  };

  const grid = document.getElementById('dash-grid');
  const statusLine = document.getElementById('status-line');
  const tooltip = document.getElementById('tooltip');
  const streamDot = document.getElementById('stream-dot');
  const streamLabel = document.getElementById('stream-label');

  const tiles = new Map(); // station code -> tile state
  let mapHandle = null;
  let stationCodesKey = '';
  let pollInFlight = false;
  let renderedNotified = false;
  let capsHandle = null;
  let streamState = 'off';
  const dirtyTiles = new Set();
  let dirtyFlushTimer = null;
  let lastStatuses = {};
  let mapHighlight = null;
  let firstPollDone = false;

  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

  /*
   * Fit-zoom: scale the whole UI so every card stays visible in the window.
   * Chromium's `zoom` reflows layout, so the grid re-columns as it shrinks;
   * iterate until the scale settles (column snaps change content height).
   */
  /*
   * Layout engine. Instead of measuring the DOM while zoom/scrollbars feed
   * back into the measurement (which could get stuck in a bad state), pick
   * (column count, zoom) by pure arithmetic over card heights measured once:
   * station cards have fixed heights; the map card is colWidth·⅔ + chrome.
   */
  let uiZoom = 1;
  let layoutMetrics = null;

  const SHELL_PAD_X = 12;
  const SHELL_PAD_Y = 12;
  const COL_GAP = 6;
  const CARD_MARGIN = 6;
  const CARD_CHROME_X = 12; // card border + padding around the map strip
  const MIN_COL_LOCAL = 280; // cards are designed for this width; zoom scales it
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 1.45;
  const STRIP_BASE = 58; // must match the --strip-h fallback in seismo.css
  const STRIP_MAX = 220;

  let currentStripH = STRIP_BASE;
  function applyStripHeight(h) {
    if (h === currentStripH) return;
    currentStripH = h;
    document.documentElement.style.setProperty('--strip-h', `${h}px`);
  }

  function redrawAllTiles() {
    for (const [, tile] of tiles) {
      drawWave(tile);
      drawSpec(tile);
    }
  }

  function columnsNeeded(items, height) {
    let cols = 1;
    let cur = 0;
    for (const h of items) {
      if (h > height + 0.5) return Infinity;
      if (cur > 0 && cur + h > height + 0.5) {
        cols++;
        cur = h;
      } else {
        cur += h;
      }
    }
    return cols;
  }

  /* Minimal balanced height for sequential fill — mirrors CSS multicol. */
  function packedHeight(items, cols) {
    let lo = Math.max(...items);
    let hi = items.reduce((a, b) => a + b, 0);
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (columnsNeeded(items, mid) <= cols) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  function measureLayout() {
    document.body.style.zoom = '1';
    grid.style.columnCount = '1';
    applyStripHeight(STRIP_BASE); // base heights are measured at minimum strips
    const mapCard = grid.querySelector('.map-card');
    const mapWrap = mapCard.querySelector('.map-wrap');
    layoutMetrics = {
      stationHeights: [...tiles.values()].filter((t) => !t.hidden).map((t) => t.card.offsetHeight),
      mapExtra: mapCard.offsetHeight - mapWrap.offsetHeight
    };
  }

  function computeLayout() {
    if (!tiles.size || !layoutMetrics) return;
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const count = layoutMetrics.stationHeights.length + 1;
    let best = { z: 0, c: Math.min(3, count) };

    for (let c = 1; c <= Math.min(count, 6); c++) {
      // Columns may never get narrower than the card design width — the whole
      // card scales down via zoom instead, so proportions (and text) hold.
      const zWidthMax = winW / (c * MIN_COL_LOCAL + (c - 1) * COL_GAP + SHELL_PAD_X);
      const hiCap = Math.min(ZOOM_MAX, zWidthMax);
      if (hiCap < ZOOM_MIN) continue; // too many columns for this window
      const heightAt = (z) => {
        const localW = winW / z - SHELL_PAD_X;
        const colW = (localW - (c - 1) * COL_GAP) / c;
        const mapItem = ((colW - CARD_CHROME_X) * 2) / 3 + layoutMetrics.mapExtra + CARD_MARGIN;
        const stationItems = layoutMetrics.stationHeights.map((h) => h + CARD_MARGIN);
        const mid = Math.floor(stationItems.length / 2);
        const items = [...stationItems.slice(0, mid), mapItem, ...stationItems.slice(mid)];
        return (packedHeight(items, c) + SHELL_PAD_Y) * z;
      };
      if (heightAt(ZOOM_MIN) > winH) continue;
      let lo = ZOOM_MIN;
      let hi = hiCap;
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2;
        if (heightAt(mid) <= winH) lo = mid;
        else hi = mid;
      }
      if (lo > best.z) best = { z: lo, c };
    }

    const floored = best.z === 0; // nothing fits even at minimum zoom
    let z = floored ? ZOOM_MIN : Math.min(best.z, ZOOM_MAX);
    document.documentElement.classList.toggle('allow-scroll', floored);
    document.body.style.zoom = String(z);
    grid.style.columnCount = String(best.c);
    // One corrective pass against the real layout, in case the packing
    // estimate and the CSS balancer disagree by a few pixels.
    if (!floored && document.documentElement.scrollHeight > winH + 1) {
      z = Math.max(ZOOM_MIN, z * (winH / document.documentElement.scrollHeight) * 0.995);
      document.body.style.zoom = String(z);
    }

    // Stretch the graph strips to absorb leftover vertical space: find the
    // largest strip height that still fits (58px when height is the binding
    // constraint, up to STRIP_MAX in tall narrow windows).
    let stripH = STRIP_BASE;
    if (!floored) {
      const localW = winW / z - SHELL_PAD_X;
      const colW = (localW - (best.c - 1) * COL_GAP) / best.c;
      const mapItem = ((colW - CARD_CHROME_X) * 2) / 3 + layoutMetrics.mapExtra + CARD_MARGIN;
      const localH = winH / z - SHELL_PAD_Y;
      const packsAt = (sh) => {
        const extra = 2 * (sh - STRIP_BASE);
        const st = layoutMetrics.stationHeights.map((h) => h + extra + CARD_MARGIN);
        const mid = Math.floor(st.length / 2);
        return packedHeight([...st.slice(0, mid), mapItem, ...st.slice(mid)], best.c);
      };
      if (packsAt(STRIP_MAX) <= localH) {
        stripH = STRIP_MAX;
      } else {
        let lo = STRIP_BASE;
        let hi = STRIP_MAX;
        for (let i = 0; i < 10; i++) {
          const mid = (lo + hi) / 2;
          if (packsAt(mid) <= localH) lo = mid;
          else hi = mid;
        }
        stripH = Math.floor(lo);
      }
    }
    applyStripHeight(stripH);
    // Real-layout guard in case the CSS balancer packs differently.
    let guard = 0;
    while (currentStripH > STRIP_BASE && document.documentElement.scrollHeight > winH + 1 && guard++ < 12) {
      applyStripHeight(Math.max(STRIP_BASE, currentStripH - 6));
    }

    uiZoom = z;
    updateLinkLines();
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fmtNum(x) {
    if (!Number.isFinite(x)) return '—';
    const opts =
      Math.abs(x) >= 10000
        ? { maximumFractionDigits: 0 }
        : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    return x.toLocaleString('en-US', opts);
  }

  function fmtUTC(ms) {
    return new Date(ms).toISOString().slice(11, 19);
  }

  function fmtLag(ms) {
    if (ms < 90000) return `${Math.max(0, Math.round(ms / 1000))} s`;
    return `${(ms / 60000).toFixed(1)} min`;
  }

  function lagClass(ms) {
    if (ms <= LAG_GOOD_MS) return 'good';
    if (ms <= LAG_WARN_MS) return 'warn';
    return 'bad';
  }

  function setStatus(text, cls) {
    if (!statusLine) return; // status chip removed from the UI
    statusLine.textContent = text;
    statusLine.className = `status-line${cls ? ` ${cls}` : ''}`;
  }

  function notifyRenderedOnce() {
    if (renderedNotified) return;
    renderedNotified = true;
    if (window.seismo && window.seismo.notifyRendered) window.seismo.notifyRendered();
  }

  /* ---------------- tiles ---------------- */

  function buildTile(meta) {
    const card = el('section', 'card station-card');

    const waveWrap = el('div', 'strip');
    const waveCanvas = el('canvas', 'wave');
    const waveCross = el('div', 'crosshair');
    waveWrap.append(waveCanvas, waveCross);

    const specWrap = el('div', 'strip');
    const specCanvas = el('canvas', 'spec');
    const specCross = el('div', 'crosshair');
    specWrap.append(specCanvas, specCross);

    const metaRow = el('div', 'meta-row');
    const staId = el('div', 'sta-id');
    const badge = el('span', 'type-badge', meta.deviceType);
    badge.style.background = TYPE_COLORS[meta.deviceType] || TYPE_COLORS['?'];
    staId.append(badge, el('span', 'sta-code', `${meta.code} · ${meta.display.channel}`));
    const tileStatus = el('div', 'tile-status');
    const statusDot = el('span', 'status-dot');
    const statusText = el('span', 'status-text', 'waiting');
    tileStatus.append(statusDot, statusText);
    metaRow.append(staId, tileStatus);

    const gmRow = el('div', 'gm-row2');
    const accCell = el('span', 'gm-cell');
    accCell.title = 'Peak acceleration over the visible window';
    const accNum = el('span', 'gm-num', '—');
    accCell.append(el('span', 'gm-key', 'Acc'), accNum, el('span', 'gm-unit', 'μm/s²'));
    const velCell = el('span', 'gm-cell');
    velCell.title = 'Peak velocity over the visible window';
    const velNum = el('span', 'gm-num', '—');
    velCell.append(el('span', 'gm-key', 'Vel'), velNum, el('span', 'gm-unit', 'μm/s'));
    gmRow.append(accCell, velCell);

    const gmNote = el('div', 'gm-note hidden', 'no response metadata — uncalibrated');

    card.append(waveWrap, specWrap, metaRow, gmRow, gmNote);
    grid.appendChild(card);

    const tile = {
      meta,
      card,
      waveCanvas,
      specCanvas,
      waveCross,
      specCross,
      els: { accNum, velNum, statusDot, statusText, tileStatus, gmNote },
      segments: [],
      view: null,
      lastError: null
    };

    attachStripTooltip(tile, waveCanvas, waveCross, 'wave');
    attachStripTooltip(tile, specCanvas, specCross, 'spec');
    if (!meta.display.scale) gmNote.classList.remove('hidden');
    return tile;
  }

  /* ---------------- data assembly ---------------- */

  function addSegments(tile, incoming) {
    for (const seg of incoming) {
      if (!seg || !seg.samples || !seg.sampleRate) continue;
      const samples = ArrayBuffer.isView(seg.samples) ? seg.samples : new Int32Array(seg.samples);
      const dup = tile.segments.some(
        (s) => s.startTime === seg.startTime && s.samples.length >= samples.length
      );
      if (dup) continue;
      // Live-stream records arrive as ~3 s chunks; append to the tail segment
      // when they continue it so the store stays compact.
      const last = tile.segments[tile.segments.length - 1];
      if (last && last.sampleRate === seg.sampleRate) {
        const dtMs = 1000 / seg.sampleRate;
        const lastEnd = last.startTime + last.samples.length * dtMs;
        if (Math.abs(seg.startTime - lastEnd) <= 1.5 * dtMs) {
          const merged = new Int32Array(last.samples.length + samples.length);
          merged.set(last.samples, 0);
          merged.set(samples, last.samples.length);
          last.samples = merged;
          continue;
        }
      }
      tile.segments.push({ startTime: seg.startTime, sampleRate: seg.sampleRate, samples });
      tile.segments.sort((a, b) => a.startTime - b.startTime);
    }
    if (tile.segments.length > 500) tile.segments.splice(0, tile.segments.length - 500);
  }

  function assemble(tile) {
    const segs = tile.segments;
    if (!segs.length) return null;
    const sr = segs[0].sampleRate;
    let latest = -Infinity;
    for (const s of segs) {
      if (s.sampleRate !== sr) continue;
      latest = Math.max(latest, s.startTime + ((s.samples.length - 1) / sr) * 1000);
    }
    if (!Number.isFinite(latest)) return null;

    const t1 = latest;
    const t0 = t1 - DISPLAY_MINUTES * 60000;
    const n = Math.round(DISPLAY_MINUTES * 60 * sr);
    const buf = new Float32Array(n).fill(NaN);
    for (const s of segs) {
      if (s.sampleRate !== sr) continue;
      const i0 = Math.round(((s.startTime - t0) / 1000) * sr);
      const from = Math.max(0, -i0);
      for (let i = from; i < s.samples.length; i++) {
        const j = i0 + i;
        if (j >= n) break;
        if (j >= 0) buf[j] = s.samples[i];
      }
    }

    // Prune segments that fell out of the window.
    const cutoff = t0 - 60000;
    tile.segments = segs.filter((s) => s.startTime + (s.samples.length / s.sampleRate) * 1000 >= cutoff);

    let mean = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const v = buf[i];
      if (!Number.isNaN(v)) {
        mean += v;
        count++;
      }
    }
    mean = count ? mean / count : 0;
    return { buf, sr, t0, t1, mean, samplesSeen: count };
  }

  /* ---------------- drawing ---------------- */

  function sizeCanvas(canvas) {
    const scale = dpr();
    const w = Math.max(50, Math.round(canvas.clientWidth * scale));
    const h = Math.max(30, Math.round(canvas.clientHeight * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    return { w, h, scale };
  }

  function drawGridlines(ctx, view, w, h) {
    ctx.strokeStyle = 'rgba(69, 215, 232, 0.07)';
    ctx.lineWidth = 1;
    const span = view.t1 - view.t0;
    for (let t = Math.ceil(view.t0 / 120000) * 120000; t < view.t1; t += 120000) {
      const x = Math.round(((t - view.t0) / span) * w) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }

  function drawWave(tile) {
    const view = tile.view;
    const { w, h } = sizeCanvas(tile.waveCanvas);
    const ctx = tile.waveCanvas.getContext('2d');
    ctx.fillStyle = STRIP_BG;
    ctx.fillRect(0, 0, w, h);
    if (!view) {
      ctx.fillStyle = 'rgba(143, 179, 217, 0.5)';
      ctx.font = `${10 * dpr()}px "Space Grotesk", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('awaiting data', w / 2, h / 2);
      return;
    }
    drawGridlines(ctx, view, w, h);

    const { mins, maxs } = window.ThoreDSP.envelope(view.buf, w);
    let amp = 1;
    for (let x = 0; x < w; x++) {
      if (!Number.isNaN(mins[x])) {
        amp = Math.max(amp, Math.abs(mins[x] - view.mean), Math.abs(maxs[x] - view.mean));
      }
    }
    const mid = h / 2;
    const gain = (h / 2 - 3) / amp;
    ctx.fillStyle = WAVE_COLOR;
    for (let x = 0; x < w; x++) {
      if (Number.isNaN(mins[x])) continue;
      const yTop = mid - (maxs[x] - view.mean) * gain;
      const yBot = mid - (mins[x] - view.mean) * gain;
      ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
    }
  }

  function drawSpec(tile) {
    const view = tile.view;
    const { w, h } = sizeCanvas(tile.specCanvas);
    const ctx = tile.specCanvas.getContext('2d');
    ctx.fillStyle = STRIP_BG;
    ctx.fillRect(0, 0, w, h);
    if (!view) return;

    const spec = window.ThoreDSP.spectrogram(view.buf, { fftSize: 256, maxCols: Math.min(900, w) });
    if (!spec) return;
    const lo = window.ThoreDSP.percentileOfFinite(spec.dB, 5);
    let hi = window.ThoreDSP.percentileOfFinite(spec.dB, 99.5);
    if (Number.isNaN(lo)) return;
    if (!(hi - lo >= 8)) hi = lo + 8;

    const lut = window.ThoreDSP.infernoLUT;
    const img = new ImageData(spec.cols, spec.bins);
    const px = img.data;
    for (let c = 0; c < spec.cols; c++) {
      for (let b = 0; b < spec.bins; b++) {
        const v = spec.dB[c * spec.bins + b];
        const row = spec.bins - 1 - b; // low frequencies at the bottom
        const o = (row * spec.cols + c) * 4;
        if (Number.isNaN(v)) {
          px[o] = 4;
          px[o + 1] = 6;
          px[o + 2] = 11;
          px[o + 3] = 255;
          continue;
        }
        let t = (v - lo) / (hi - lo);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const li = Math.round(t * 255) * 3;
        px[o] = lut[li];
        px[o + 1] = lut[li + 1];
        px[o + 2] = lut[li + 2];
        px[o + 3] = 255;
      }
    }
    const off = document.createElement('canvas');
    off.width = spec.cols;
    off.height = spec.bins;
    off.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, w, h);
  }

  function updateGroundMotion(tile) {
    const view = tile.view;
    const scale = tile.meta.display.scale;
    if (!view || !scale) {
      tile.els.accNum.textContent = '—';
      tile.els.velNum.textContent = '—';
      return;
    }
    const { buf, sr, mean } = view;
    let peakV = 0;
    let peakA = 0;
    for (let i = 1; i < buf.length - 1; i++) {
      const c = buf[i];
      if (Number.isNaN(c)) continue;
      const v = Math.abs(c - mean) / scale;
      if (v > peakV) peakV = v;
      const prev = buf[i - 1];
      const next = buf[i + 1];
      if (Number.isNaN(prev) || Number.isNaN(next)) continue;
      const a = Math.abs(((next - prev) / scale) * (sr / 2));
      if (a > peakA) peakA = a;
    }
    tile.els.accNum.textContent = fmtNum(peakA * 1e6);
    tile.els.velNum.textContent = fmtNum(peakV * 1e6);
  }

  function updateTileStatus(tile) {
    const { statusDot, statusText, tileStatus } = tile.els;
    if (tile.lastError) {
      statusDot.className = 'status-dot bad';
      statusText.textContent = tile.view ? `stale ${fmtLag(Date.now() - tile.view.t1)}` : 'fetch failed';
      tileStatus.title = `Last fetch failed: ${tile.lastError}`;
      return;
    }
    if (!tile.view) {
      statusDot.className = 'status-dot bad';
      statusText.textContent = 'no data 1 h';
      tileStatus.title = 'No samples in the last hour';
      tile.card.classList.add('is-stale');
      return;
    }
    const lag = Date.now() - tile.view.t1;
    const cls = lagClass(lag);
    statusDot.className = `status-dot ${cls}`;
    statusText.textContent = `lag ${fmtLag(lag)}`;
    tileStatus.title = `${DISPLAY_MINUTES} min window · ends ${fmtUTC(tile.view.t1)} UTC`;
    tile.card.classList.toggle('is-stale', cls === 'bad');
  }

  /* ---------------- tooltip ---------------- */

  function attachStripTooltip(tile, canvas, crosshair, kind) {
    canvas.addEventListener('mousemove', (event) => {
      const view = tile.view;
      if (!view) return;
      const rect = canvas.getBoundingClientRect();
      const fx = (event.clientX - rect.left) / rect.width;
      const t = view.t0 + fx * (view.t1 - view.t0);
      let line2;
      if (kind === 'wave') {
        const idx = Math.min(view.buf.length - 1, Math.max(0, Math.round(fx * (view.buf.length - 1))));
        const raw = view.buf[idx];
        if (Number.isNaN(raw)) line2 = 'gap in data';
        else if (tile.meta.display.scale) line2 = `${fmtNum(((raw - view.mean) / tile.meta.display.scale) * 1e6)} μm/s`;
        else line2 = `${fmtNum(raw - view.mean)} counts`;
      } else {
        const fy = 1 - (event.clientY - rect.top) / rect.height;
        line2 = `≈ ${(fy * (view.sr / 2)).toFixed(1)} Hz`;
      }
      tooltip.textContent = `${fmtUTC(t)} UTC · ${line2}`;
      tooltip.classList.remove('hidden');
      // Positions are window px; element coordinates live in zoomed space.
      const maxX = window.innerWidth / uiZoom - tooltip.offsetWidth - 8;
      const maxY = window.innerHeight / uiZoom - tooltip.offsetHeight - 8;
      tooltip.style.left = `${Math.min(maxX, (event.clientX + 14) / uiZoom)}px`;
      tooltip.style.top = `${Math.min(maxY, (event.clientY + 14) / uiZoom)}px`;
      crosshair.style.left = `${(event.clientX - rect.left) / uiZoom}px`;
      crosshair.style.display = 'block';
    });
    canvas.addEventListener('mouseleave', () => {
      tooltip.classList.add('hidden');
      crosshair.style.display = 'none';
    });
  }

  /* ---------------- map ---------------- */

  /* Leader lines: hexagon on the map -> matching station card. */
  const linkSvg = document.getElementById('link-lines');

  function updateLinkLines() {
    if (!linkSvg) return;
    if (!mapHandle || !mapHandle.markerViewportPositions || !tiles.size) {
      linkSvg.textContent = '';
      return;
    }
    const points = mapHandle.markerViewportPositions();
    const z = uiZoom;
    const parts = [];
    for (const [code, tile] of tiles) {
      if (tile.hidden) continue;
      const p = points[code];
      if (!p) continue;
      const rect = tile.card.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = p.x - cx;
      const dy = p.y - cy;
      // Attach to the card edge that faces the marker.
      const tEdgeX = dx !== 0 ? rect.width / 2 / Math.abs(dx) : Infinity;
      const tEdgeY = dy !== 0 ? rect.height / 2 / Math.abs(dy) : Infinity;
      const t = Math.min(tEdgeX, tEdgeY, 1);
      const ex = cx + dx * t;
      const ey = cy + dy * t;
      // Start just outside the hexagon, not at its center.
      const len = Math.hypot(ex - p.x, ey - p.y) || 1;
      const sx = p.x + ((ex - p.x) / len) * 10;
      const sy = p.y + ((ey - p.y) / len) * 10;
      const hl = mapHighlight === code;
      const lineOpacity = hl ? 1 : mapHighlight ? 0.14 : 0.5;
      const dotOpacity = hl ? 1 : mapHighlight ? 0.2 : 0.85;
      parts.push(
        `<line x1="${(sx / z).toFixed(1)}" y1="${(sy / z).toFixed(1)}" x2="${(ex / z).toFixed(1)}" y2="${(ey / z).toFixed(1)}"` +
          ` stroke="${tile.accent}" stroke-width="${hl ? 2.4 : 1.4}" opacity="${lineOpacity}"/>`,
        `<circle cx="${(ex / z).toFixed(1)}" cy="${(ey / z).toFixed(1)}" r="3" fill="${tile.accent}" opacity="${dotOpacity}"/>`
      );
    }
    linkSvg.innerHTML = parts.join('');
  }

  async function renderMap(stations) {
    const canvas = document.getElementById('map-canvas');
    const markers = stations.map((s) => ({
      code: s.code,
      lat: s.latitude,
      lon: s.longitude,
      type: s.deviceType,
      color: TYPE_COLORS[s.deviceType] || TYPE_COLORS['?'],
      accent: (tiles.get(s.code) || {}).accent
    }));
    mapHandle = await window.ThoreMap.render(canvas, BBOX, markers, {
      statusColors: STATUS_COLORS,
      pixelScale: uiZoom,
      onSelect: (code) => {
        const tile = tiles.get(code);
        if (!tile) return;
        tile.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        tile.card.classList.add('flash');
        setTimeout(() => tile.card.classList.remove('flash'), 1600);
      },
      onHover: (code) => {
        for (const [, t] of tiles) t.card.classList.remove('hl');
        if (code) {
          const t = tiles.get(code);
          if (t) t.card.classList.add('hl');
        }
        setMapHighlight(code);
      }
    });
    refreshMapStatuses();
    updateLinkLines();
  }

  function refreshMapStatuses() {
    if (!mapHandle) return;
    const statuses = {};
    for (const [code, tile] of tiles) {
      statuses[code] = tile.hidden ? 'dead' : tile.view ? lagClass(Date.now() - tile.view.t1) : 'bad';
    }
    lastStatuses = statuses;
    mapHandle.redrawMarkers(statuses, mapHighlight);
  }

  /* Hide cards of stations with no recent data; ghost their map markers.
     Revival is instant (see flushDirtyTiles); death is decided per sweep. */
  function sweepLiveness() {
    if (!firstPollDone) return;
    const now = Date.now();
    let changed = false;
    const hiddenCodes = [];
    for (const [code, tile] of tiles) {
      const last = tile.view ? tile.view.t1 : 0;
      // Hide only on evidence: a failed fetch means "unknown", not "dead".
      const dead = !tile.lastError && (!last || now - last > DEAD_AFTER_MS);
      if (dead !== tile.hidden) {
        tile.hidden = dead;
        tile.card.classList.toggle('hidden-card', dead);
        changed = true;
      }
      if (tile.hidden) hiddenCodes.push(code);
    }
    if (statusLine) {
      statusLine.title = hiddenCodes.length
        ? `hidden (no data > ${DEAD_AFTER_MS / 60000} min): ${hiddenCodes.join(', ')}`
        : '';
    }
    if (changed) {
      positionMapCard();
      measureLayout();
      computeLayout();
      redrawAllTiles();
      refreshMapStatuses();
    }
  }

  /* ---------------- live stream ---------------- */

  function updateStreamPill() {
    const states = {
      live: ['good', 'live', 'CAPS live stream connected'],
      connecting: ['warn', 'connecting…', 'Connecting to the live stream'],
      reconnecting: ['warn', 'reconnecting…', 'Live stream dropped — reconnecting'],
      error: ['bad', 'polling', 'Stream rejected — FDSN polling only'],
      stopped: ['bad', 'polling', 'Stream off — FDSN polling only'],
      off: ['bad', 'polling', 'Stream off — FDSN polling only']
    };
    if (!streamDot || !streamLabel) return; // status chip removed from the UI
    const [cls, label, title] = states[streamState] || states.off;
    streamDot.className = `status-dot ${cls}`;
    streamLabel.textContent = label;
    streamLabel.title = title;
  }

  function flushDirtyTiles() {
    dirtyFlushTimer = null;
    let revived = false;
    for (const code of dirtyTiles) {
      const tile = tiles.get(code);
      if (!tile) continue;
      const view = assemble(tile);
      if (view) tile.view = view;
      // A hidden station whose data returned comes back immediately.
      if (tile.hidden && tile.view && Date.now() - tile.view.t1 < DEAD_AFTER_MS) {
        tile.hidden = false;
        tile.card.classList.remove('hidden-card');
        revived = true;
      }
      drawWave(tile);
      drawSpec(tile);
      updateGroundMotion(tile);
      updateTileStatus(tile);
    }
    dirtyTiles.clear();
    if (revived) {
      positionMapCard();
      measureLayout();
      computeLayout();
      redrawAllTiles();
    }
    refreshMapStatuses();
    let reporting = 0;
    for (const [, tile] of tiles) if (tile.view) reporting++;
    setStatus(`${reporting}/${tiles.size} · ${fmtUTC(Date.now())}Z`);
  }

  function startStream() {
    if (capsHandle) capsHandle.stop();
    const ids = [];
    for (const [, tile] of tiles) {
      const d = tile.meta.display;
      ids.push(`${tile.meta.network}.${tile.meta.code}.${d.location}.${d.channel}`);
    }
    if (!ids.length) return;
    capsHandle = window.ThoreCaps.start({
      url: STREAM.url,
      user: STREAM.user,
      pass: STREAM.pass,
      backfillMs: STREAM.backfillMs,
      streams: ids,
      onSegments: (segments) => {
        for (const seg of segments) {
          const tile = tiles.get(seg.station);
          if (!tile || seg.channel !== tile.meta.display.channel) continue;
          addSegments(tile, [seg]);
          tile.lastError = null;
          dirtyTiles.add(seg.station);
        }
        if (dirtyTiles.size && !dirtyFlushTimer) dirtyFlushTimer = setTimeout(flushDirtyTiles, 400);
      },
      onStatus: (state) => {
        streamState = state;
        updateStreamPill();
      }
    });
  }

  /* ---------------- polling (initial history + fallback) ---------------- */

  async function poll() {
    if (pollInFlight || !tiles.size) return;
    pollInFlight = true;
    try {
      const requests = [];
      for (const [, tile] of tiles) {
        // Stations kept fresh by the live stream don't need FDSN polling.
        if (streamState === 'live' && tile.view && Date.now() - tile.view.t1 < 90000) continue;
        const minutes = tile.view
          ? Math.min(60, Math.max(2, Math.ceil((Date.now() - tile.view.t1) / 60000) + 1))
          : INITIAL_FETCH_MINUTES;
        requests.push({
          station: tile.meta.code,
          location: tile.meta.display.location,
          channel: tile.meta.display.channel,
          minutes
        });
      }
      const results = !requests.length
        ? {}
        : window.seismo && window.seismo.getWaveforms
          ? await window.seismo.getWaveforms(requests)
          : await fetchWaveformBatch(requests);
      const requested = new Set(requests.map((r) => r.station));
      let reporting = 0;
      for (const [code, tile] of tiles) {
        if (requested.has(code)) {
          const res = results[code];
          if (!res || !res.ok) {
            tile.lastError = (res && res.error) || 'no response';
          } else {
            tile.lastError = null;
            if (res.segments && res.segments.length) addSegments(tile, res.segments);
            const view = assemble(tile);
            if (view) tile.view = view;
          }
          drawWave(tile);
          drawSpec(tile);
          updateGroundMotion(tile);
          updateTileStatus(tile);
        }
        if (tile.view) reporting++;
      }
      refreshMapStatuses();
      setStatus(`${reporting}/${tiles.size} · ${fmtUTC(Date.now())}Z`);
    } catch (err) {
      setStatus(`Waveform update failed: ${err.message}`, 'bad');
    } finally {
      pollInFlight = false;
      firstPollDone = true;
      notifyRenderedOnce();
    }
  }

  /* ---------------- lifecycle ---------------- */

  function setMapHighlight(code) {
    mapHighlight = code;
    if (mapHandle) mapHandle.redrawMarkers(lastStatuses, mapHighlight);
    updateLinkLines();
  }

  function rebuildTiles(stations) {
    for (const [, tile] of tiles) tile.card.remove();
    tiles.clear();
    let idx = 0;
    for (const meta of stations) {
      if (!meta.display) continue;
      const tile = buildTile(meta);
      tile.accent = STA_ACCENTS[idx++ % STA_ACCENTS.length];
      tile.card.style.setProperty('--sta-accent', tile.accent);
      tile.card.addEventListener('mouseenter', () => setMapHighlight(meta.code));
      tile.card.addEventListener('mouseleave', () => setMapHighlight(null));
      tiles.set(meta.code, tile);
    }
    positionMapCard();
  }

  // The map sits mid-flow among VISIBLE cards, landing mid-masonry.
  function positionMapCard() {
    const mapCard = grid.querySelector('.map-card');
    const visible = [...tiles.values()].filter((t) => !t.hidden).map((t) => t.card);
    grid.insertBefore(mapCard, visible[Math.floor(visible.length / 2)] || null);
  }

  /* Fetch + decode a batch of waveform windows (formerly done in Electron main). */
  async function fetchWaveformBatch(requests) {
    const now = Date.now();
    const jobs = requests.map(async (req) => {
      try {
        const { status, buffer } = await window.ThoreFDSN.fetchWaveform({
          station: req.station,
          location: req.location,
          channel: req.channel,
          startTime: now - req.minutes * 60000,
          endTime: now
        });
        if (!buffer) return [req.station, { ok: true, status, segments: [] }];
        const { records, errors } = window.ThoreMiniseed.parseRecords(buffer);
        const segments = window.ThoreMiniseed
          .toSegments(records)
          .filter((s) => s.station === req.station && s.channel === req.channel);
        return [req.station, { ok: true, status, parseErrors: errors.length, segments }];
      } catch (err) {
        return [req.station, { ok: false, error: String((err && err.message) || err) }];
      }
    });
    return Object.fromEntries(await Promise.all(jobs));
  }

  async function loadInventory(initial) {
    // Electron's file:// origin can't make CORS fetches; use its IPC bridge
    // when present. Tauri/browser origins fetch directly.
    const inventory =
      window.seismo && window.seismo.getInventory
        ? await window.seismo.getInventory(BBOX)
        : await window.ThoreFDSN.fetchInventory(BBOX);
    // West-to-east order: the card columns mirror the stations' map positions.
    const usable = inventory.stations
      .filter((s) => s.display)
      .sort((a, b) => a.longitude - b.longitude);
    const key = usable.map((s) => s.code).join(',');
    if (key !== stationCodesKey) {
      stationCodesKey = key;
      rebuildTiles(usable);
      measureLayout();
      computeLayout();
      await renderMap(usable);
      startStream();
      if (!initial) await poll();
    }
    return usable.length;
  }

  async function init() {
    window.addEventListener('beforeunload', () => {
      if (capsHandle) capsHandle.stop();
    });
    updateStreamPill();

    setStatus('loading stations…');
    try {
      const count = await loadInventory(true);
      if (!count) {
        setStatus('No active stations found in the region.', 'bad');
        notifyRenderedOnce();
        return;
      }
      setStatus(`history ${INITIAL_FETCH_MINUTES}m…`);
      await poll();
      sweepLiveness(); // hide already-dead sensors right at startup
      setInterval(poll, POLL_MS);
      setInterval(async () => {
        try {
          await loadInventory(false); // new/removed stations in the bbox
        } catch (_err) {
          /* transient inventory failure; sweep still runs on cached tiles */
        }
        sweepLiveness();
      }, SWEEP_MS);
      setInterval(() => {
        for (const [, tile] of tiles) updateTileStatus(tile);
        refreshMapStatuses();
      }, 15000);
    } catch (err) {
      setStatus(`Failed to load inventory: ${err.message}`, 'bad');
      notifyRenderedOnce();
    }
  }

  window.addEventListener('scroll', () => updateLinkLines(), { passive: true });

  let resizeTimer = null;
  let lastLiveLayout = 0;
  window.addEventListener('resize', () => {
    // Relayout while the user is still dragging (cheap, pure arithmetic)…
    const now = Date.now();
    if (now - lastLiveLayout > 50) {
      lastLiveLayout = now;
      computeLayout();
    }
    // …then settle with a full canvas re-render once the size stops changing.
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      computeLayout();
      for (const [, tile] of tiles) {
        drawWave(tile);
        drawSpec(tile);
      }
      const stations = [...tiles.values()].map((t) => t.meta);
      if (stations.length) await renderMap(stations);
    }, 200);
  });

  init();
})();
