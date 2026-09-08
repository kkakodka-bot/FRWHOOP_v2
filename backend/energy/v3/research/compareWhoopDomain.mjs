/**
 * WHOOP vs public-data feature location (fixture, not calorimetry).
 * Run: node energy/v3/research/compareWhoopDomain.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imuRecordFromFrame } from '../../../protocol/imuArchive.js';
import { extractMinuteImuFeatures } from '../windows.js';
import { compareDistributions } from '../domain.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse('2026-08-25T10:00:00.000Z');

function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseCsv(file) {
  if (!fs.existsSync(file)) return [];
  const [h, ...lines] = fs.readFileSync(file, 'utf8').trim().split('\n');
  const cols = parseCsvLine(h);
  return lines.map((line) => {
    const p = parseCsvLine(line);
    const o = {};
    cols.forEach((c, i) => { o[c] = p[i]; });
    return o;
  });
}

const fx = JSON.parse(fs.readFileSync(path.join(here, '../../../tests/fixtures/noop-whoop5-parity.json'), 'utf8'));
const rec = imuRecordFromFrame(Buffer.from(fx.v21_real.hex, 'hex'), 'puffin', {
  receivedAt: new Date(T0).toISOString(),
});
const tiled = [];
for (let s = 0; s < 50; s++) {
  tiled.push({ ...rec, sensor_ts: (T0 + s * 1000) / 1000 });
}
const whoop = extractMinuteImuFeatures(tiled, T0);
const weee = parseCsv(path.join(here, 'cache/minutes_weee.csv'));
const habits = parseCsv(path.join(here, 'cache/minutes_habits.csv'));
const whoopRows = whoop ? [whoop] : [];
const report = {
  note: 'WHOOP row is the v21 parity fixture tiled to ~50 s still. Not a population. Not calorimetry.',
  whoop_features: whoop,
  vs_weee: compareDistributions(whoopRows, weee),
  vs_habits: compareDistributions(whoopRows, habits),
};
fs.writeFileSync(path.join(here, 'cache/whoop_domain.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  whoop_vm_mean: whoop?.vm_mean,
  whoop_enmo_mean: whoop?.enmo_mean,
  whoop_native_hz: whoop?.native_sample_rate,
  weee_n: weee.length,
  habits_n: habits.length,
}, null, 2));
