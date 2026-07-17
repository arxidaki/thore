/*
 * Raspberry Shake FDSN web-service client (station inventory + waveforms).
 * The server sends Access-Control-Allow-Origin: *, so this runs equally in
 * the webview (Tauri/Electron/browser) and under Node (lib/fdsn.js CLI).
 * Exposes window.ThoreFDSN in the browser, module.exports under Node.
 */
(() => {
  'use strict';

  const FDSN_BASE = 'https://data.raspberryshake.org/fdsnws';
  const TIMEOUT_MS = 25000;

  function buildQuery(params) {
    return Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
  }

  function isoSeconds(ms) {
    return new Date(ms).toISOString().slice(0, 19);
  }

  async function fdsnFetch(url) {
    return fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  /* Sensor-type badge from the set of channel codes, RS product conventions. */
  function classifyDevice(codes) {
    const vel = codes.filter((c) => /^[ES]H[ZNE123]$/.test(c)).length;
    const accel = codes.some((c) => /^EN[ZNE123]$/.test(c));
    const pressure = codes.some((c) => /DF$/.test(c));
    if (accel && vel) return '4D';
    if (accel) return 'ACC';
    if (vel >= 3) return '3D';
    if (vel >= 1 && pressure) return 'S&B';
    if (pressure) return 'BOOM';
    if (vel >= 1) return '1D';
    return '?';
  }

  function pickDisplayChannel(channels) {
    const byCode = (code) => channels.find((c) => c.code === code);
    return (
      byCode('EHZ') ||
      byCode('SHZ') ||
      channels.find((c) => /Z$/.test(c.code)) ||
      channels[0] ||
      null
    );
  }

  function parseInventoryText(text, now = Date.now()) {
    const perStation = new Map();

    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const cols = line.split('|');
      if (cols.length < 17) continue;
      const [net, sta, loc, chan, lat, lon, elev, , , , desc, scale, scaleFreq, scaleUnits, sps, start, end] = cols;
      const startMs = Date.parse(start);
      const endMs = end ? Date.parse(end) : Infinity;
      if (!(endMs > now)) continue; // closed epoch

      if (!perStation.has(sta)) perStation.set(sta, new Map());
      const chanKey = `${loc}.${chan}`;
      const existing = perStation.get(sta).get(chanKey);
      if (existing && existing.epochStart >= startMs) continue; // keep newest epoch
      perStation.get(sta).set(chanKey, {
        network: net,
        location: loc,
        code: chan,
        latitude: Number(lat),
        longitude: Number(lon),
        elevation: Number(elev),
        description: desc,
        scale: Number(scale),
        scaleFrequency: Number(scaleFreq),
        scaleUnits: scaleUnits,
        sampleRate: Number(sps),
        epochStart: startMs
      });
    }

    const stations = [];
    for (const [code, chanMap] of perStation) {
      const channels = [...chanMap.values()].sort((a, b) => a.code.localeCompare(b.code));
      if (!channels.length) continue;
      const display = pickDisplayChannel(channels);
      const anchor = display || channels[0];
      stations.push({
        network: anchor.network,
        code,
        latitude: anchor.latitude,
        longitude: anchor.longitude,
        elevation: anchor.elevation,
        deviceType: classifyDevice(channels.map((c) => c.code)),
        channels,
        display: display
          ? {
              location: display.location,
              channel: display.code,
              sampleRate: display.sampleRate,
              // Placeholder epochs carry scale=1.0; treat those as uncalibrated.
              scale: Number.isFinite(display.scale) && display.scale > 1 ? display.scale : null,
              scaleUnits: display.scaleUnits
            }
          : null
      });
    }

    stations.sort((a, b) => a.code.localeCompare(b.code));
    return stations;
  }

  async function fetchInventory(bbox) {
    const url =
      `${FDSN_BASE}/station/1/query?` +
      buildQuery({
        minlatitude: bbox.minLat,
        maxlatitude: bbox.maxLat,
        minlongitude: bbox.minLon,
        maxlongitude: bbox.maxLon,
        level: 'channel',
        format: 'text'
      });
    const res = await fdsnFetch(url);
    if (res.status === 204) return { fetchedAt: Date.now(), stations: [] };
    if (!res.ok) throw new Error(`station service HTTP ${res.status}`);
    const text = await res.text();
    return { fetchedAt: Date.now(), stations: parseInventoryText(text) };
  }

  async function fetchWaveform({ network = 'AM', station, location, channel, startTime, endTime }) {
    const url =
      `${FDSN_BASE}/dataselect/1/query?` +
      buildQuery({
        network,
        station,
        location: location || undefined,
        channel,
        starttime: isoSeconds(startTime),
        endtime: isoSeconds(endTime)
      });
    const res = await fdsnFetch(url);
    if (res.status === 204) return { status: 204, buffer: null };
    if (!res.ok) throw new Error(`dataselect HTTP ${res.status}`);
    return { status: 200, buffer: await res.arrayBuffer() };
  }

  const api = { FDSN_BASE, fetchInventory, fetchWaveform, parseInventoryText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ThoreFDSN = api;
})();
