/* Static slippy-tile map with station markers (CARTO dark basemap, no map library). */
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
    // StationView's own tile server — the original map, hillshade and all.
    return `https://mapserver.raspberryshake.org/tiles/${z}/${x}/${y}.png`;
  }

  function fallbackTileUrl(z, x, y) {
    const sub = SUBDOMAINS[Math.abs(x + y) % SUBDOMAINS.length];
    return `https://${sub}.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`;
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
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || 400;
    const cssH = canvas.clientHeight || 300;
    const W = Math.round(cssW * dpr);
    const H = Math.round(cssH * dpr);
    canvas.width = W;
    canvas.height = H;

    // Frame the stations themselves (padded), not the whole search bbox —
    // on small canvases the bbox wastes most of the panel.
    let ext = bbox;
    if (markers.length) {
      let minLat = Infinity;
      let maxLat = -Infinity;
      let minLon = Infinity;
      let maxLon = -Infinity;
      for (const m of markers) {
        if (m.lat < minLat) minLat = m.lat;
        if (m.lat > maxLat) maxLat = m.lat;
        if (m.lon < minLon) minLon = m.lon;
        if (m.lon > maxLon) maxLon = m.lon;
      }
      const padLat = Math.max(0.1, (maxLat - minLat) * 0.3);
      const padLon = Math.max(0.15, (maxLon - minLon) * 0.2);
      // Extra room below for the station code labels.
      ext = {
        minLat: minLat - padLat - 0.08,
        maxLat: maxLat + padLat,
        minLon: minLon - padLon,
        maxLon: maxLon + padLon
      };
    }

    // Largest zoom at which the extent fits with padding.
    const pad = 8 * dpr;
    let zoom = 4;
    for (let z = 12; z >= 4; z--) {
      const p1 = project(ext.maxLat, ext.minLon, z);
      const p2 = project(ext.minLat, ext.maxLon, z);
      if (p2.x - p1.x <= W - 2 * pad && p2.y - p1.y <= H - 2 * pad) {
        zoom = z;
        break;
      }
    }

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
    bctx.fillStyle = '#79b4c2';
    bctx.fillRect(0, 0, W, H);

    const x0 = Math.floor(origin.x / TILE);
    const x1 = Math.floor((origin.x + W) / TILE);
    const y0 = Math.floor(origin.y / TILE);
    const y1 = Math.floor((origin.y + H) / TILE);
    const jobs = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const px = tx * TILE - origin.x;
        const py = ty * TILE - origin.y;
        jobs.push(
          loadImage(tileUrl(zoom, tx, ty))
            .catch(() => loadImage(fallbackTileUrl(zoom, tx, ty)))
            .then((img) => bctx.drawImage(img, px, py, TILE, TILE))
            .catch(() => {
              bctx.fillStyle = '#6da9b8';
              bctx.fillRect(px, py, TILE, TILE);
            })
        );
      }
    }
    await Promise.allSettled(jobs);

    bctx.font = `${9 * dpr}px "Space Grotesk", sans-serif`;
    bctx.fillStyle = 'rgba(60, 75, 95, 0.8)';
    bctx.textAlign = 'right';
    bctx.fillText('© OpenStreetMap · © Raspberry Shake', W - 6 * dpr, H - 6 * dpr);

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
