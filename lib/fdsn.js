'use strict';

// The client lives in renderer/fdsn.js (dual-environment: the same file runs
// in the webview). This wrapper re-exports it for Node and keeps the CLI.
//
// CLI checks:
//   node lib/fdsn.js                      -> Cyprus inventory summary
//   node lib/fdsn.js --wave R9AD8 EHZ 30  -> fetch + parse 30 min of waveforms

module.exports = require('../renderer/fdsn.js');

if (require.main === module) {
  const { fetchInventory, fetchWaveform } = module.exports;
  const CYPRUS = { minLat: 34.3, maxLat: 35.9, minLon: 31.9, maxLon: 34.8 };
  (async () => {
    if (process.argv[2] === '--wave') {
      const miniseed = require('./miniseed');
      const station = process.argv[3] || 'R9AD8';
      const channel = process.argv[4] || 'EHZ';
      const minutes = Number(process.argv[5]) || 30;
      const now = Date.now();
      const { status, buffer } = await fetchWaveform({
        station,
        channel,
        startTime: now - minutes * 60000,
        endTime: now
      });
      if (!buffer) {
        console.log(`${station} ${channel}: HTTP ${status}, no data`);
        return;
      }
      const { records, errors } = miniseed.parseRecords(buffer);
      const segments = miniseed.toSegments(records);
      console.log(`${station} ${channel}: ${buffer.byteLength} bytes, ${records.length} records, ${errors.length} errors`);
      for (const s of segments) {
        const end = s.startTime + ((s.samples.length - 1) / s.sampleRate) * 1000;
        console.log(
          `  ${s.id} n=${s.samples.length} ${new Date(s.startTime).toISOString()} -> ${new Date(end).toISOString()}` +
            ` (lag ${((Date.now() - end) / 60000).toFixed(1)} min)`
        );
      }
      return;
    }
    const inv = await fetchInventory(CYPRUS);
    console.log(`${inv.stations.length} active stations`);
    for (const s of inv.stations) {
      const d = s.display;
      console.log(
        `  ${s.code} ${s.deviceType.padEnd(4)} lat=${s.latitude.toFixed(4)} lon=${s.longitude.toFixed(4)}` +
          (d ? ` ${d.location}.${d.channel}@${d.sampleRate}Hz scale=${d.scale}` : ' (no velocity channel)')
      );
    }
  })().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
  });
}
