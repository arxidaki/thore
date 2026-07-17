/*
 * Minimal miniSEED 2.x reader for Raspberry Shake data.
 * Supports the 48-byte fixed header, blockette 1000 discovery, and
 * Steim-1 / Steim-2 / plain int32 payloads.
 *
 * Dual-environment: exposes window.ThoreMiniseed in the browser and
 * module.exports under Node (lib/miniseed.js re-exports it for the CLI).
 * Every Steim record carries the reverse integration constant (XN); the
 * decoder verifies the last decoded sample against it.
 */
(() => {
  'use strict';

  function toDataView(input) {
    if (input instanceof DataView) return input;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) {
      return new DataView(input.buffer, input.byteOffset, input.byteLength);
    }
    if (input instanceof ArrayBuffer) return new DataView(input);
    if (ArrayBuffer.isView(input)) {
      return new DataView(input.buffer, input.byteOffset, input.byteLength);
    }
    throw new TypeError('miniseed: unsupported input type');
  }

  function ascii(view, offset, length) {
    let out = '';
    for (let i = 0; i < length; i++) {
      const c = view.getUint8(offset + i);
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
    return out.trim();
  }

  function signExtend(value, bits) {
    const shift = 32 - bits;
    return (value << shift) >> shift;
  }

  function sampleRateFrom(factor, multiplier) {
    if (factor > 0 && multiplier > 0) return factor * multiplier;
    if (factor > 0 && multiplier < 0) return -factor / multiplier;
    if (factor < 0 && multiplier > 0) return -multiplier / factor;
    if (factor < 0 && multiplier < 0) return 1 / (factor * multiplier);
    return 0;
  }

  /* Decode one 32-bit Steim word into an array of differences (or null). */
  function decodeWord(word, code, version) {
    if (code === 1) {
      return [
        signExtend((word >>> 24) & 0xff, 8),
        signExtend((word >>> 16) & 0xff, 8),
        signExtend((word >>> 8) & 0xff, 8),
        signExtend(word & 0xff, 8)
      ];
    }
    if (version === 1) {
      if (code === 2) {
        return [signExtend((word >>> 16) & 0xffff, 16), signExtend(word & 0xffff, 16)];
      }
      return [word | 0]; // code 3: one 32-bit difference
    }
    // Steim-2
    const dnib = word >>> 30;
    if (code === 2) {
      if (dnib === 1) return [signExtend(word & 0x3fffffff, 30)];
      if (dnib === 2) return [signExtend((word >>> 15) & 0x7fff, 15), signExtend(word & 0x7fff, 15)];
      if (dnib === 3) {
        return [
          signExtend((word >>> 20) & 0x3ff, 10),
          signExtend((word >>> 10) & 0x3ff, 10),
          signExtend(word & 0x3ff, 10)
        ];
      }
      return null;
    }
    // code 3
    if (dnib === 0) {
      const out = new Array(5);
      for (let i = 0; i < 5; i++) out[i] = signExtend((word >>> (24 - 6 * i)) & 0x3f, 6);
      return out;
    }
    if (dnib === 1) {
      const out = new Array(6);
      for (let i = 0; i < 6; i++) out[i] = signExtend((word >>> (25 - 5 * i)) & 0x1f, 5);
      return out;
    }
    if (dnib === 2) {
      const out = new Array(7);
      for (let i = 0; i < 7; i++) out[i] = signExtend((word >>> (24 - 4 * i)) & 0xf, 4);
      return out;
    }
    return null;
  }

  function decodeSteim(view, dataStart, dataEnd, numSamples, version, littleEndian, errors, tag) {
    const out = new Int32Array(numSamples);
    if (numSamples === 0) return out;

    let produced = 0;
    let value = 0;
    let x0 = 0;
    let xn = 0;
    let sawFirst = false;

    for (let frame = dataStart; frame + 64 <= dataEnd && produced < numSamples; frame += 64) {
      const ctrl = view.getUint32(frame, littleEndian);
      const firstFrame = frame === dataStart;
      if (firstFrame) {
        x0 = view.getInt32(frame + 4, littleEndian);
        xn = view.getInt32(frame + 8, littleEndian);
      }
      for (let w = firstFrame ? 3 : 1; w < 16 && produced < numSamples; w++) {
        const code = (ctrl >>> (30 - 2 * w)) & 3;
        if (code === 0) continue;
        const diffs = decodeWord(view.getUint32(frame + 4 * w, littleEndian), code, version);
        if (!diffs) {
          errors.push(`${tag}: invalid Steim${version} nibble`);
          continue;
        }
        for (let d = 0; d < diffs.length && produced < numSamples; d++) {
          if (!sawFirst) {
            // The first difference references the previous record; X0 replaces it.
            sawFirst = true;
            value = x0;
          } else {
            value += diffs[d];
          }
          out[produced++] = value;
        }
      }
    }

    if (produced !== numSamples) {
      errors.push(`${tag}: decoded ${produced}/${numSamples} samples`);
    } else if (value !== xn) {
      errors.push(`${tag}: XN mismatch (got ${value}, want ${xn})`);
    }
    return out;
  }

  function parseRecord(view, offset, errors) {
    const tag = `record@${offset}`;

    // Endianness probe: the BTime year is the standard trick.
    const yearBE = view.getUint16(offset + 20, false);
    const yearLE = view.getUint16(offset + 20, true);
    let le;
    if (yearBE >= 1900 && yearBE <= 2500) le = false;
    else if (yearLE >= 1900 && yearLE <= 2500) le = true;
    else {
      errors.push(`${tag}: implausible header year (${yearBE}/${yearLE}), skipping 512 bytes`);
      return { record: null, nextOffset: offset + 512 };
    }

    const station = ascii(view, offset + 8, 5);
    const location = ascii(view, offset + 13, 2);
    const channel = ascii(view, offset + 15, 3);
    const network = ascii(view, offset + 18, 2);
    const year = view.getUint16(offset + 20, le);
    const doy = view.getUint16(offset + 22, le);
    const hour = view.getUint8(offset + 24);
    const minute = view.getUint8(offset + 25);
    const second = view.getUint8(offset + 26);
    const fract = view.getUint16(offset + 28, le); // 0.0001 s units
    const numSamples = view.getUint16(offset + 30, le);
    const rateFactor = view.getInt16(offset + 32, le);
    const rateMult = view.getInt16(offset + 34, le);
    const activity = view.getUint8(offset + 36);
    const numBlockettes = view.getUint8(offset + 39);
    const timeCorrection = view.getInt32(offset + 40, le);
    const dataOffset = view.getUint16(offset + 44, le);
    let blocketteOffset = view.getUint16(offset + 46, le);

    let encoding = null;
    let wordOrder = 1;
    let recordLength = null;
    for (let i = 0; i < numBlockettes; i++) {
      if (blocketteOffset < 48 || offset + blocketteOffset + 8 > view.byteLength) break;
      const type = view.getUint16(offset + blocketteOffset, le);
      const next = view.getUint16(offset + blocketteOffset + 2, le);
      if (type === 1000) {
        encoding = view.getUint8(offset + blocketteOffset + 4);
        wordOrder = view.getUint8(offset + blocketteOffset + 5);
        recordLength = 1 << view.getUint8(offset + blocketteOffset + 6);
      }
      if (!next || next <= blocketteOffset) break;
      blocketteOffset = next;
    }

    if (!recordLength || recordLength < 128 || recordLength > 1 << 20) {
      errors.push(`${tag}: missing blockette 1000, assuming 512-byte record`);
      recordLength = 512;
    }

    let startTime =
      Date.UTC(year, 0, 1) +
      (doy - 1) * 86400000 +
      hour * 3600000 +
      minute * 60000 +
      second * 1000 +
      fract / 10;
    if (!(activity & 0x02)) startTime += timeCorrection / 10;

    const sampleRate = sampleRateFrom(rateFactor, rateMult);
    const recTag = `${network}.${station}.${location}.${channel}@${offset}`;

    let samples = null;
    if (numSamples > 0 && dataOffset >= 48 && dataOffset < recordLength) {
      const dataLE = wordOrder === 0;
      const dataStart = offset + dataOffset;
      const dataEnd = Math.min(offset + recordLength, view.byteLength);
      if (encoding === 10 || encoding === 11) {
        samples = decodeSteim(view, dataStart, dataEnd, numSamples, encoding === 10 ? 1 : 2, dataLE, errors, recTag);
      } else if (encoding === 3) {
        const n = Math.min(numSamples, Math.floor((dataEnd - dataStart) / 4));
        samples = new Int32Array(n);
        for (let i = 0; i < n; i++) samples[i] = view.getInt32(dataStart + 4 * i, dataLE);
      } else {
        errors.push(`${recTag}: unsupported encoding ${encoding}`);
      }
    }

    return {
      record: {
        network,
        station,
        location,
        channel,
        startTime,
        sampleRate,
        numSamples,
        samples
      },
      nextOffset: offset + recordLength
    };
  }

  function parseRecords(input) {
    const view = toDataView(input);
    const records = [];
    const errors = [];
    let offset = 0;
    while (offset + 64 <= view.byteLength) {
      let parsed;
      try {
        parsed = parseRecord(view, offset, errors);
      } catch (err) {
        errors.push(`record@${offset}: ${err.message}`);
        break;
      }
      if (!parsed || parsed.nextOffset <= offset) break;
      if (parsed.record) records.push(parsed.record);
      offset = parsed.nextOffset;
    }
    return { records, errors };
  }

  /*
   * Stitch records into gap-free segments per channel.
   * A new segment starts whenever the record's start time deviates from the
   * expected continuation by more than `toleranceSamples` sample intervals.
   */
  function toSegments(records, toleranceSamples = 1.5) {
    const groups = new Map();
    for (const rec of records) {
      if (!rec.samples || !rec.sampleRate || rec.sampleRate <= 0) continue;
      const key = `${rec.network}.${rec.station}.${rec.location}.${rec.channel}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rec);
    }

    const segments = [];
    for (const [key, recs] of groups) {
      recs.sort((a, b) => a.startTime - b.startTime);
      let chunks = null;
      let segStart = 0;
      let expectedNext = 0;
      let total = 0;
      let sr = 0;

      const flush = () => {
        if (!chunks || !total) return;
        const samples = new Int32Array(total);
        let at = 0;
        for (const c of chunks) {
          samples.set(c, at);
          at += c.length;
        }
        const [network, station, location, channel] = key.split('.');
        segments.push({ id: key, network, station, location, channel, sampleRate: sr, startTime: segStart, samples });
      };

      for (const rec of recs) {
        const dtMs = 1000 / rec.sampleRate;
        const contiguous =
          chunks &&
          rec.sampleRate === sr &&
          Math.abs(rec.startTime - expectedNext) <= toleranceSamples * dtMs;
        if (!contiguous) {
          flush();
          chunks = [];
          segStart = rec.startTime;
          sr = rec.sampleRate;
          total = 0;
          expectedNext = rec.startTime;
        }
        chunks.push(rec.samples);
        total += rec.samples.length;
        expectedNext += rec.samples.length * dtMs;
      }
      flush();
    }

    segments.sort((a, b) => a.startTime - b.startTime);
    return segments;
  }

  const api = { parseRecords, toSegments };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ThoreMiniseed = api;
})();
