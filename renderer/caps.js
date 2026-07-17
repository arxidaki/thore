/*
 * Minimal CAPS-over-WebSocket client (gempa CAPS, as served by Raspberry Shake).
 * Speaks the same dialect as StationView: hello -> auth -> begin request/end,
 * then binary frames of [int16le streamId][int32le length][payload], where
 * payload for "stream" subscriptions is a 512-byte miniSEED record,
 * decoded in-page by window.ThoreMiniseed.
 */
(() => {
  'use strict';

  const BACKOFF_MS = [2000, 4000, 8000, 16000, 32000, 60000, 120000, 300000];
  const WATCHDOG_INTERVAL_MS = 15000;
  const WATCHDOG_SILENCE_MS = 60000;

  const pad = (x) => String(x).padStart(2, '0');
  function capsTime(ms) {
    const t = new Date(ms);
    return (
      `${t.getUTCFullYear()},${pad(t.getUTCMonth() + 1)},${pad(t.getUTCDate())},` +
      `${pad(t.getUTCHours())},${pad(t.getUTCMinutes())},${pad(t.getUTCSeconds())}`
    );
  }

  /*
   * opts: {
   *   url, user, pass,
   *   streams: ['AM.R9AD8.00.EHZ', ...],
   *   backfillMs,
   *   onSegments(segments), onStatus(state)   // states: connecting|live|reconnecting|stopped|error
   * }
   * Returns { stop() }.
   */
  function start(opts) {
    let ws = null;
    let stopped = false;
    let attempts = 0;
    let lastMessageAt = 0;
    let sawBanner = false;
    let watchdog = null;
    let reconnectTimer = null;
    const requestMeta = new Map(); // stream id -> REQUESTS meta

    const setStatus = (state) => {
      if (!stopped && opts.onStatus) opts.onStatus(state);
    };

    function connect() {
      if (stopped) return;
      requestMeta.clear();
      sawBanner = false;
      setStatus(attempts ? 'reconnecting' : 'connecting');
      try {
        ws = new WebSocket(`${opts.url}?days=1`, 'caps');
      } catch (err) {
        scheduleReconnect();
        return;
      }
      ws.binaryType = 'arraybuffer';
      lastMessageAt = Date.now();

      ws.onopen = () => {
        if (ws.protocol !== 'caps') {
          ws.close();
          return;
        }
        ws.send('hello');
      };

      ws.onmessage = (event) => {
        lastMessageAt = Date.now();
        if (typeof event.data === 'string') {
          if (!sawBanner) {
            // Server banner in response to hello; authenticate and subscribe.
            sawBanner = true;
            ws.send(`auth ${opts.user} ${opts.pass}`);
            const since = Date.now() - opts.backfillMs;
            const lines = ['begin request', `time ${capsTime(since)}:`];
            for (const s of opts.streams) lines.push(`stream add ${s}`);
            lines.push('end');
            ws.send(lines.join('\n'));
            return;
          }
          try {
            const msg = JSON.parse(event.data);
            if (msg.STATUS && msg.STATUS.MSG !== 'OK') {
              setStatus('error');
              ws.close();
              return;
            }
            if (msg.REQUESTS) {
              if (msg.REQUESTS.ID > 0) requestMeta.set(msg.REQUESTS.ID, msg.REQUESTS);
              else setStatus('error'); // stream rejected
            }
          } catch (_err) {
            /* non-JSON text; ignore */
          }
          return;
        }
        handleBinary(event.data);
      };

      ws.onclose = () => {
        if (!stopped) scheduleReconnect();
      };
      ws.onerror = () => {
        /* onclose follows */
      };
    }

    function handleBinary(buffer) {
      const dv = new DataView(buffer);
      const chunks = [];
      let total = 0;
      let off = 0;
      while (off + 6 <= buffer.byteLength) {
        const id = dv.getInt16(off, true);
        const len = dv.getInt32(off + 2, true);
        off += 6;
        if (len < 0 || off + len > buffer.byteLength) {
          // Desynchronized framing; drop the connection and resubscribe.
          try {
            ws.close();
          } catch (_e) {}
          return;
        }
        const meta = requestMeta.get(id);
        if (!meta || meta.FMT === 'MSEED') {
          chunks.push(new Uint8Array(buffer, off, len));
          total += len;
        }
        off += len;
      }
      if (!total) return;
      attempts = 0; // healthy traffic resets backoff
      setStatus('live');
      const merged = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        merged.set(c, at);
        at += c.length;
      }
      const { records } = window.ThoreMiniseed.parseRecords(merged);
      const segments = window.ThoreMiniseed.toSegments(records);
      if (segments.length) opts.onSegments(segments);
    }

    function scheduleReconnect() {
      if (stopped || reconnectTimer) return;
      const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
      attempts++;
      setStatus('reconnecting');
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    watchdog = setInterval(() => {
      if (stopped || !ws) return;
      if (ws.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > WATCHDOG_SILENCE_MS) {
        try {
          ws.close();
        } catch (_e) {}
      }
    }, WATCHDOG_INTERVAL_MS);

    connect();

    return {
      stop() {
        stopped = true;
        clearInterval(watchdog);
        clearTimeout(reconnectTimer);
        if (ws) {
          try {
            ws.close();
          } catch (_e) {}
        }
        if (opts.onStatus) opts.onStatus('stopped');
      }
    };
  }

  window.ThoreCaps = { start };
})();
