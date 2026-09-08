#!/usr/bin/env node
// Differential experiment CLI — exact before/during/after packet census diff
// for one-reversible-change hardware experiments (cmd105/packet 52 etc.).
//
// Usage:
//   node bin/experiment-diff.mjs --before before.ndjson[.gz] --during during.ndjson[.gz] \
//        [--after after.ndjson[.gz]] [--out /tmp/experiment/]
//
// Every window gets: packet census, hist versions, command-response and event
// histograms, IMU physics summary, raw 51/52 samples. The diff reports
// new/disappeared types and frame-length deltas between windows.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { censusWindow, diffCensus, extractExperimentFrames } from '../redecode/experimentDiff.js';

function readMaybeGzip(path) {
  let buf = readFileSync(path);
  if (path.endsWith('.gz')) { try { buf = gunzipSync(buf); } catch { /* plain */ } }
  const text = buf.toString('utf8').trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text);
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function summarize(c, ex) {
  return {
    notifies: c.notifies, bytes: c.bytes, frames: c.frames,
    crc_valid: c.crc_valid, crc_invalid: c.crc_invalid,
    first_t: c.first_t, last_t: c.last_t,
    packet_types: c.packet_types, hist_versions: c.hist_versions,
    cmd_responses: c.cmd_responses, events: c.events,
    frame_lengths: c.frame_lengths,
    imu: {
      records: ex.imu.length,
      physics_shell_pass: ex.imu_physics_pass,
      kinds: ex.imu.reduce((m, r) => { m[r.kind] = (m[r.kind] || 0) + 1; return m; }, {}),
    },
    type51_count: ex.type51.length,
    type52_count: ex.type52.length,
    samples: ex.samples,
  };
}

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
if (!argv.includes('--before') || !argv.includes('--during')) {
  console.error('usage: node bin/experiment-diff.mjs --before <ndjson> --during <ndjson> [--after <ndjson>] [--out dir]');
  process.exit(2);
}

const beforePath = argOf('before');
const duringPath = argOf('during');
const afterPath = argOf('after');

const before = readMaybeGzip(beforePath);
const during = readMaybeGzip(duringPath);
const after = afterPath ? readMaybeGzip(afterPath) : null;

const cb = censusWindow(before);
const cd = censusWindow(during);
const ca = after ? censusWindow(after) : null;
const diff = diffCensus(cb, cd, ca);
const exb = extractExperimentFrames(before);
const exd = extractExperimentFrames(during);
const exa = after ? extractExperimentFrames(after) : null;

const report = {
  windows: {
    before: summarize(cb, exb),
    during: summarize(cd, exd),
    after: ca ? summarize(ca, exa) : null,
  },
  diff,
  verdicts: {
    new_packet_types_during: diff.new_types_during,
    disappeared_types_during: diff.disappeared_during,
    type52_frames: { before: exb.type52.length, during: exd.type52.length, after: exa ? exa.type52.length : null },
    imu_records: { before: exb.imu.length, during: exd.imu.length, after: exa ? exa.imu.length : null },
    imu_physics_shell_pass: { before: exb.imu_physics_pass, during: exd.imu_physics_pass, after: exa ? exa.imu_physics_pass : null },
  },
};

console.log(JSON.stringify(report, null, 2));
const outDir = argOf('out');
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/experiment-diff.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outDir}/during-type52.ndjson`, exd.type52.map((r) => JSON.stringify(r)).join('\n') + (exd.type52.length ? '\n' : ''));
  writeFileSync(`${outDir}/during-imu.ndjson`, exd.imu.map((r) => JSON.stringify(r)).join('\n') + (exd.imu.length ? '\n' : ''));
  console.error(`wrote ${outDir}/experiment-diff.json`);
}
