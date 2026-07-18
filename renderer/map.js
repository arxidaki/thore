/* Static slippy-tile map with station markers (label-free CARTO basemap, no map library). */
(() => {
  'use strict';

  const TILE = 256;
  const SUBDOMAINS = 'abcd';

  function project(lat, lon, zoom) {
    const world = TILE * Math.pow(2, zoom);
    const x = ((lon + 180) / 360) * world;
    const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
    const s = Math.sin((clamped * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world;
    return { x, y };
  }

  function tileUrl(z, x, y) {
    // CARTO voyager with the label layer removed: clean geography, zero text
    // (retina tiles, drawn at half size for extra sharpness).
    const sub = SUBDOMAINS[Math.abs(x + y) % SUBDOMAINS.length];
    return `https://${sub}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/${z}/${x}/${y}@2x.png`;
  }

  function fallbackTileUrl(z, x, y) {
    const sub = SUBDOMAINS[Math.abs(x + y) % SUBDOMAINS.length];
    return `https://${sub}.basemaps.cartocdn.com/light_nolabels/${z}/${x}/${y}.png`;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`tile failed: ${url}`));
      img.src = url;
    });
  }

  function hexPath(ctx, cx, cy, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = ((60 * i - 90) * Math.PI) / 180;
      const px = cx + r * Math.cos(a);
      const py = cy + r * Math.sin(a);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  /*
   * Render the map into `canvas`, fitted to `bbox`.
   * markers: [{ code, lat, lon, type, color }]
   * opts: { onSelect(code), statusColors: {good, warn, bad} }
   * Returns { redrawMarkers(statusByCode) } — statuses update without refetching tiles.
   */
  async function render(canvas, bbox, markers, opts = {}) {
    // Backing resolution accounts for the app's fit-zoom (opts.pixelScale) so
    // the map maps 1:1 to device pixels instead of being CSS-upscaled blurry.
    const scale = (window.devicePixelRatio || 1) * (opts.pixelScale || 1);
    const dpr = Math.min(Math.max(scale, 1), 2.5);
    const cssW = canvas.clientWidth || 400;
    const cssH = canvas.clientHeight || 300;
    const W = Math.round(cssW * dpr);
    const H = Math.round(cssH * dpr);
    canvas.width = W;
    canvas.height = H;

    // Frame the whole configured region — the island always shows in full.
    const ext = bbox;

    // Fractional zoom fills the canvas exactly (an integer-zoom fit can leave
    // ~40% margin). Tiles are fetched one level finer and drawn downscaled.
    const pad = 8 * dpr;
    const z0a = project(ext.maxLat, ext.minLon, 0);
    const z0b = project(ext.minLat, ext.maxLon, 0);
    const zoom = Math.min(
      Math.log2((W - 2 * pad) / (z0b.x - z0a.x)),
      Math.log2((H - 2 * pad) / (z0b.y - z0a.y)),
      12
    );
    const tileZ = Math.max(4, Math.min(12, Math.ceil(zoom)));
    const tileStep = TILE * Math.pow(2, zoom - tileZ); // on-canvas size of one tile

    const a = project(ext.maxLat, ext.minLon, zoom);
    const b = project(ext.minLat, ext.maxLon, zoom);
    const origin = {
      x: (a.x + b.x) / 2 - W / 2,
      y: (a.y + b.y) / 2 - H / 2
    };

    // Base layer (tiles + attribution) kept offscreen so markers can redraw cheaply.
    const base = document.createElement('canvas');
    base.width = W;
    base.height = H;
    const bctx = base.getContext('2d');
    bctx.fillStyle = '#d4dadc';
    bctx.fillRect(0, 0, W, H);

    const x0 = Math.floor(origin.x / tileStep);
    const x1 = Math.floor((origin.x + W) / tileStep);
    const y0 = Math.floor(origin.y / tileStep);
    const y1 = Math.floor((origin.y + H) / tileStep);
    const jobs = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const px = tx * tileStep - origin.x;
        const py = ty * tileStep - origin.y;
        jobs.push(
          loadImage(tileUrl(tileZ, tx, ty))
            .catch(() => loadImage(fallbackTileUrl(tileZ, tx, ty)))
            // +0.5px overlap hides hairline seams from fractional scaling.
            .then((img) => bctx.drawImage(img, px, py, tileStep + 0.5, tileStep + 0.5))
            .catch(() => {
              bctx.fillStyle = '#cfd6da';
              bctx.fillRect(px, py, tileStep + 0.5, tileStep + 0.5);
            })
        );
      }
    }
    await Promise.allSettled(jobs);

    bctx.font = `${9 * dpr}px "Space Grotesk", sans-serif`;
    bctx.fillStyle = 'rgba(60, 75, 95, 0.8)';
    bctx.textAlign = 'right';
    bctx.fillText('© OpenStreetMap · © CARTO', W - 6 * dpr, H - 6 * dpr);

    const placed = markers.map((m) => {
      const p = project(m.lat, m.lon, zoom);
      return { ...m, px: p.x - origin.x, py: p.y - origin.y };
    });

    const statusColors = opts.statusColors || { good: '#7ef3a4', warn: '#ffc857', bad: '#ff6b6b' };
    const ctx = canvas.getContext('2d');

    function redrawMarkers(statusByCode = {}, highlightCode = null) {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(base, 0, 0);
      const r = 11 * dpr;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const m of placed) {
        const status = statusByCode[m.code];
        const ghost = status === 'dead'; // hidden by the liveness sweep
        ctx.globalAlpha = ghost ? 0.35 : 1;
        if (highlightCode && m.code === highlightCode) {
          hexPath(ctx, m.px, m.py, r + 3.5 * dpr);
          ctx.lineWidth = 2.2 * dpr;
          ctx.strokeStyle = m.accent || '#ffffff';
          ctx.stroke();
        }

        // Hexagon with the device-type text inside.
        hexPath(ctx, m.px, m.py, r);
        ctx.fillStyle = m.color;
        ctx.fill();
        ctx.lineWidth = 1.5 * dpr;
        ctx.strokeStyle = '#0b0e14';
        ctx.stroke();
        ctx.fillStyle = '#0b0e14';
        ctx.font = `700 ${8 * dpr}px "Space Grotesk", sans-serif`;
        ctx.fillText(m.type, m.px, m.py + 0.5 * dpr);

        // Data-freshness dot pinned to the hexagon corner.
        if (status) {
          const sx = m.px + r * 0.75;
          const sy = m.py - r * 0.75;
          ctx.beginPath();
          ctx.arc(sx, sy, 3.2 * dpr, 0, 2 * Math.PI);
          ctx.fillStyle = statusColors[status] || statusColors.bad;
          ctx.fill();
          ctx.lineWidth = 1 * dpr;
          ctx.strokeStyle = '#0b0e14';
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    function markerAt(event, radius) {
      const rect = canvas.getBoundingClientRect();
      const cx = (event.clientX - rect.left) * (W / rect.width);
      const cy = (event.clientY - rect.top) * (H / rect.height);
      let best = null;
      let bestDist = radius * dpr;
      for (const m of placed) {
        const d = Math.hypot(m.px - cx, m.py - cy);
        if (d < bestDist) {
          bestDist = d;
          best = m;
        }
      }
      return best;
    }

    canvas.onclick = (event) => {
      if (!opts.onSelect) return;
      const hit = markerAt(event, 20);
      if (hit) opts.onSelect(hit.code);
    };

    let hoverCode = null;
    canvas.onmousemove = (event) => {
      const hit = markerAt(event, 18);
      const code = hit ? hit.code : null;
      if (code !== hoverCode) {
        hoverCode = code;
        canvas.style.cursor = code ? 'pointer' : 'default';
        if (opts.onHover) opts.onHover(code);
      }
    };
    canvas.onmouseleave = () => {
      if (hoverCode !== null) {
        hoverCode = null;
        canvas.style.cursor = 'default';
        if (opts.onHover) opts.onHover(null);
      }
    };

    /* Marker centers in window px — used to anchor the card leader lines. */
    function markerViewportPositions() {
      const rect = canvas.getBoundingClientRect();
      const out = {};
      for (const m of placed) {
        out[m.code] = {
          x: rect.left + (m.px / W) * rect.width,
          y: rect.top + (m.py / H) * rect.height
        };
      }
      return out;
    }

    redrawMarkers({});
    return { redrawMarkers, markerViewportPositions };
  }

  window.ThoreMap = { render };
})();
