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
    // Esri World Ocean Base — the same bathymetry-and-hillshade style as the
    // original StationView map, but its labels live in a separate reference
    // layer that we simply never fetch (note the z/y/x path order).
    return `https://services.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/${z}/${y}/${x}`;
  }

  function fallbackTileUrl(z, x, y) {
    const sub = SUBDOMAINS[Math.abs(x + y) % SUBDOMAINS.length];
    return `https://${sub}.basemaps.cartocdn.com/light_nolabels/${z}/${x}/${y}.png?ck=2`;
  }

  function reliefTileUrl(z, x, y) {
    // Label-free hillshade, multiplied over land for the original map's depth.
    return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/${z}/${y}/${x}`;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous'; // CORS-clean so the canvas stays readable
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

    // Hillshade layer, composited manually in the pixel pass below.
    const relief = document.createElement('canvas');
    relief.width = W;
    relief.height = H;
    const rctx = relief.getContext('2d');
    rctx.fillStyle = '#ffffff'; // neutral (no shading) where relief is missing
    rctx.fillRect(0, 0, W, H);

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
            }),
          loadImage(reliefTileUrl(tileZ, tx, ty))
            .then((img) => rctx.drawImage(img, px, py, tileStep + 0.5, tileStep + 0.5))
            .catch(() => {})
        );
      }
    }
    await Promise.allSettled(jobs);

    // Recolor to the palette of the original map: teal bathymetric water and
    // hillshaded, slightly saturated land (skipped if a canvas ends up
    // tainted, e.g. a tile server stops sending CORS headers).
    try {
      const baseImg = bctx.getImageData(0, 0, W, H);
      const reliefImg = rctx.getImageData(0, 0, W, H);
      const d = baseImg.data;
      const rd = reliefImg.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const rr = rd[i];
        const rb = rd[i + 2];
        // Real sea is blue in BOTH layers; rivers are blue only in Ocean Base
        // (the relief layer has no rivers), so they render as land and vanish.
        if (b > r + 20 && b > 150 && rb > rr + 8) {
          // Depth-to-teal ramp fitted on matched pixels of the original map:
          // deep (48,88,97) -> shallow (86,145,159), banding preserved.
          const t = Math.max(0, Math.min(1, ((r + g + b) / 765 - 0.63) / 0.19));
          d[i] = 48 + 38 * t;
          d[i + 1] = 88 + 57 * t;
          d[i + 2] = 97 + 62 * t;
        } else {
          // Land: warm tan hillshade measured from the original tiles.
          // The relief source packs 90% of land into a narrow light band
          // (p5=189..p95=239), so stretch it across the original's full
          // range — shadows (130,126,122) to lit flats (214,212,209) —
          // or the terrain reads flat. Ocean Base's land colors are
          // ignored entirely: no roads, no river tints.
          // Where the two sources' coastlines disagree, the relief pixel is
          // partly its blue sea — that value stretched to "deep shadow" and
          // drew a dark rim around the island. Render such shoreline pixels
          // as low-lying light ground instead.
          const shoreline = rb > rr + 8;
          const rn = shoreline ? 0.78 : Math.max(0, Math.min(1, (rr - 186) / 55));
          const v = 122 + 102 * rn;
          d[i] = v + 4;
          d[i + 1] = v;
          d[i + 2] = v - 4;
        }
      }
      bctx.putImageData(baseImg, 0, 0);
    } catch (err) {
      // Surface the failure on the map itself instead of failing silently.
      bctx.fillStyle = '#b00020';
      bctx.font = `${10 * dpr}px monospace`;
      bctx.textAlign = 'left';
      bctx.fillText(`recolor: ${String(err).slice(0, 90)}`, 6 * dpr, H - 8 * dpr);
    }

    bctx.font = `${9 * dpr}px "Space Grotesk", sans-serif`;
    bctx.fillStyle = 'rgba(60, 75, 95, 0.8)';
    bctx.textAlign = 'right';
    bctx.fillStyle = 'rgba(230, 242, 248, 0.78)';
    bctx.fillText('© Esri · GEBCO · © OpenStreetMap', W - 6 * dpr, H - 6 * dpr);

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
        ctx.lineWidth = 0.55 * dpr;
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
          ctx.lineWidth = 0.6 * dpr;
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
