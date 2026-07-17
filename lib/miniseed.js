'use strict';

// The parser lives in renderer/miniseed.js (dual-environment: the same file
// runs in the webview). This wrapper re-exports it for Node and keeps the CLI.
//
// Self-test: node lib/miniseed.js <file.mseed>

module.exports = require('../renderer/miniseed.js');

if (require.main === module) {
  const fs = require('fs');
  const { parseRecords, toSegments } = module.exports;
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node miniseed.js <file.mseed>');
    process.exit(2);
  }
  const buf = fs.readFileSync(file);
  const started = Date.now();
  const { records, errors } = parseRecords(buf);
  const segments = toSegments(records);
  console.log(`${records.length} records, ${errors.length} errors, ${Date.now() - started} ms`);
  for (const e of errors.slice(0, 10)) console.log('  !', e);
  for (const s of segments) {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (let i = 0; i < s.samples.length; i++) {
      const v = s.samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    const end = s.startTime + ((s.samples.length - 1) / s.sampleRate) * 1000;
    console.log(
      `  ${s.id} sr=${s.sampleRate} n=${s.samples.length}` +
        ` ${new Date(s.startTime).toISOString()} -> ${new Date(end).toISOString()}` +
        ` min=${min} max=${max} mean=${(sum / s.samples.length).toFixed(1)}`
    );
  }
}
