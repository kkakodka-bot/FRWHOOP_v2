#!/usr/bin/env node
import { storageConfig } from '../storage/config.js';
import { getStores } from '../storage/stores.js';
import { decodeFrameArchive } from '../ingest/archiveFormat.js';
import { decodeFrame } from '../protocol/decoder.js';
import { decodeWhoop5Historical } from '../protocol/whoop5.js';

const cfg = storageConfig();
const stores = await getStores(cfg);
const windows = [
  ['w1', Date.parse('2026-08-30T23:46:00Z'), Date.parse('2026-08-31T00:48:00Z')],
  ['w2', Date.parse('2026-08-30T01:50:00Z'), Date.parse('2026-08-30T02:51:00Z')],
  ['w3', Date.parse('2026-08-29T04:02:00Z'), Date.parse('2026-08-29T04:53:00Z')],
  ['w4', Date.parse('2026-08-28T05:02:00Z'), Date.parse('2026-08-28T06:05:00Z')],
  ['w5', Date.parse('2026-08-27T05:02:00Z'), Date.parse('2026-08-27T06:12:00Z')],
  ['w6', Date.parse('2026-08-26T05:32:00Z'), Date.parse('2026-08-26T06:35:00Z')],
];

function hexToBytes(hex) {
  if (!hex) return [];
  const out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return out;
}

const stats = {
  frameKeys: 0, frames: 0, t40: 0, t43: 0, t47: 0, t51: 0, t52: 0,
  t40InWin: {}, t47InWin: {}, t47Hr: 0, t47Versions: {},
};
for (const [id] of windows) {
  stats.t40InWin[id] = 0;
  stats.t47InWin[id] = { n: 0, hrN: 0, min: null, max: null, dyn: 0, steps: 0, gyro: 0 };
}

const keys = [];
for (const uid of [cfg.localUserId, '9f33375b-e029-480f-9ebb-a99e5ff22ac9']) {
  try { keys.push(...await stores.raw.listPrefix(`v3/core/users/${uid}/`)); } catch { /* */ }
}
const frameKeys = keys.filter((k) => /\/frames\//.test(k) && /\/2026\/08\/(2[5-9]|30|31)\//.test(k));
stats.frameKeys = frameKeys.length;

function hitWin(t) {
  for (const [id, s, e] of windows) {
    if (t >= s && t < e) return id;
  }
  return null;
}

let i = 0;
for (const k of frameKeys) {
  i += 1;
  const obj = await stores.raw.getObject(k);
  if (!obj?.body) continue;
  let rows;
  try { rows = decodeFrameArchive(obj.body); } catch { continue; }
  for (const row of rows) {
    stats.frames += 1;
    const bytes = hexToBytes(row.hex);
    if (bytes.length < 10) continue;
    const family = row.family === 'harvard' ? 'harvard' : 'puffin';
    const rec = decodeFrame(bytes, family);
    const pt = rec.packet_type;
    const wall = Date.parse(row.t || '');
    if (pt === 40) {
      stats.t40 += 1;
      const id = Number.isFinite(wall) ? hitWin(wall) : null;
      if (id && rec.decoded?.hr) stats.t40InWin[id] += 1;
    } else if (pt === 43) stats.t43 += 1;
    else if (pt === 51) stats.t51 += 1;
    else if (pt === 52) stats.t52 += 1;
    else if (pt === 47) {
      stats.t47 += 1;
      const deep = decodeWhoop5Historical(bytes);
      const ver = deep.parsed?.hist_version;
      stats.t47Versions[ver] = (stats.t47Versions[ver] || 0) + 1;
      if (deep.parsed?.heart_rate) stats.t47Hr += 1;
      const unix = Number(deep.parsed?.unix);
      const t = Number.isFinite(unix) ? (unix > 1e12 ? unix : unix * 1000) : (Number.isFinite(wall) ? wall : null);
      const id = t != null ? hitWin(t) : null;
      if (id) {
        const w = stats.t47InWin[id];
        w.n += 1;
        const hr = deep.parsed?.heart_rate;
        if (hr) {
          w.hrN += 1;
          w.min = w.min == null ? hr : Math.min(w.min, hr);
          w.max = w.max == null ? hr : Math.max(w.max, hr);
        }
        if (deep.parsed?.dynamic_acceleration != null) w.dyn += 1;
        if (deep.parsed?.step_motion_counter != null || deep.parsed?.step_cadence != null) w.steps += 1;
        if (deep.parsed?.gyro_x) w.gyro += 1;
      }
    }
  }
  if (i % 25 === 0) console.error(`scan ${i}/${frameKeys.length}`);
}

process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
