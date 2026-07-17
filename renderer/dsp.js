/* Signal-processing helpers for the seismic dashboard (no dependencies). */
(() => {
  'use strict';

  const fftTables = new Map();

  function tablesFor(n) {
    let t = fftTables.get(n);
    if (t) return t;
    const rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      cos[k] = Math.cos((2 * Math.PI * k) / n);
      sin[k] = -Math.sin((2 * Math.PI * k) / n);
    }
    t = { rev, cos, sin };
    fftTables.set(n, t);
    return t;
  }

  /* In-place iterative radix-2 FFT; n must be a power of two. */
  function fft(re, im) {
    const n = re.length;
    const { rev, cos, sin } = tablesFor(n);
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let tmp = re[i];
        re[i] = re[j];
        re[j] = tmp;
        tmp = im[i];
        im[i] = im[j];
        im[j] = tmp;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let base = 0; base < n; base += size) {
        for (let j = base, k = 0; j < base + half; j++, k += step) {
          const c = cos[k];
          const s = sin[k];
          const tre = re[j + half] * c - im[j + half] * s;
          const tim = re[j + half] * s + im[j + half] * c;
          re[j + half] = re[j] - tre;
          im[j + half] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }

  const hannCache = new Map();
  function hann(n) {
    let w = hannCache.get(n);
    if (w) return w;
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
    return w;
  }

  /*
   * STFT power spectrogram over a NaN-gapped Float32 timeline.
   * Returns column-major dB magnitudes for bins 1..fftSize/2 (DC dropped);
   * columns overlapping a gap stay NaN.
   */
  function spectrogram(samples, { fftSize = 256, maxCols = 800 } = {}) {
    const n = samples.length;
    if (n < fftSize) return null;
    const bins = fftSize >> 1;
    const targetCols = Math.max(2, Math.min(maxCols, n));
    const hop = Math.max(1, Math.floor((n - fftSize) / (targetCols - 1)));
    const cols = Math.floor((n - fftSize) / hop) + 1;
    const dB = new Float32Array(cols * bins).fill(NaN);
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    const win = hann(fftSize);

    for (let c = 0; c < cols; c++) {
      const s0 = c * hop;
      let mean = 0;
      let ok = true;
      for (let i = 0; i < fftSize; i++) {
        const v = samples[s0 + i];
        if (Number.isNaN(v)) {
          ok = false;
          break;
        }
        mean += v;
      }
      if (!ok) continue;
      mean /= fftSize;
      for (let i = 0; i < fftSize; i++) {
        re[i] = (samples[s0 + i] - mean) * win[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let b = 0; b < bins; b++) {
        const k = b + 1; // skip DC
        const p = re[k] * re[k] + im[k] * im[k];
        dB[c * bins + b] = 10 * Math.log10(p + 1e-20);
      }
    }
    return { cols, bins, hop, fftSize, dB };
  }

  /* Per-pixel-column min/max envelope of a NaN-gapped timeline. */
  function envelope(samples, width) {
    const mins = new Float32Array(width).fill(NaN);
    const maxs = new Float32Array(width).fill(NaN);
    const n = samples.length;
    for (let x = 0; x < width; x++) {
      const a = Math.floor((x * n) / width);
      const b = Math.max(a + 1, Math.floor(((x + 1) * n) / width));
      let mn = Infinity;
      let mx = -Infinity;
      let seen = false;
      for (let i = a; i < b && i < n; i++) {
        const v = samples[i];
        if (Number.isNaN(v)) continue;
        seen = true;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (seen) {
        mins[x] = mn;
        maxs[x] = mx;
      }
    }
    return { mins, maxs };
  }

  function percentileOfFinite(values, p) {
    const finite = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Number.isNaN(v) && Number.isFinite(v)) finite.push(v);
    }
    if (!finite.length) return NaN;
    finite.sort((a, b) => a - b);
    const idx = Math.min(finite.length - 1, Math.max(0, Math.round((p / 100) * (finite.length - 1))));
    return finite[idx];
  }

  /* Inferno-style perceptually uniform sequential colormap (magnitude job). */
  const INFERNO_STOPS = [
    [0, 0, 4],
    [22, 11, 57],
    [66, 10, 104],
    [106, 23, 110],
    [147, 38, 103],
    [186, 54, 85],
    [221, 81, 58],
    [243, 120, 25],
    [252, 165, 10],
    [246, 215, 70],
    [252, 255, 164]
  ];

  function buildLUT(size = 256) {
    const lut = new Uint8ClampedArray(size * 3);
    const segments = INFERNO_STOPS.length - 1;
    for (let i = 0; i < size; i++) {
      const t = (i / (size - 1)) * segments;
      const s = Math.min(segments - 1, Math.floor(t));
      const f = t - s;
      for (let c = 0; c < 3; c++) {
        lut[i * 3 + c] = INFERNO_STOPS[s][c] + (INFERNO_STOPS[s + 1][c] - INFERNO_STOPS[s][c]) * f;
      }
    }
    return lut;
  }

  window.ThoreDSP = { spectrogram, envelope, percentileOfFinite, infernoLUT: buildLUT() };
})();
