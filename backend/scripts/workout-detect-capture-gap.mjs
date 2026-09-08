#!/usr/bin/env node
/**
 * ±60 min Level-A scan around labeled workouts. Does not collapse gaps
 * into generic capture_gap. Eval-only; no production writes.
 */
import { storageConfig } from '../storage/config.js';
import { getStores } from '../storage/stores.js';
import { decodeFrameArchive } from '../ingest/archiveFormat.js';
import { decodeFrame } from '../protocol/decoder.js';
import {
  LABELED_WINDOWS,
  labeledBoundsMs,
  gattSamplesFromFrames,
  classifyCaptureWindow,
} from '../metrics/workoutDetectReplay.js';

const PAD = 60 * 60_000;
const cfg = storageConfig();
const stores = await getStores(cfg);

const windows = LABELED_WINDOWS.map((w) => {
  const { start, end } = labeledBoundsMs(w);
  return {
    ...w,
    start,
    end,
    lo: start - PAD,
    hi: end + PAD,
    objects: 0,
    type40: 0,
    type40Bout: 0,
    gatt: 0,
    gattBout: 0,
    gatt: 0,
    t43: 0,
    t51: 0,
    notifies: 0,
    families: {},
    chars: {},
    interpKinds: {},
    connect: 0,
    disconnect: 0,
    lifecycle: {},
    lastNotify: null,
    firstNotify: null,
    queueWrite: 0,
  };
});

function hit(t) {
  const out = [];
  for (const w of windows) {
    if (t >= w.lo && t < w.hi) out.push(w);
  }
  return out;
}

const keys = [];
for (const uid of [cfg.localUserId, '9f33375b-e029-480f-9ebb-a99e5ff22ac9']) {
  try { keys.push(...await stores.raw.listPrefix(`v3/core/users/${uid}/`)); } catch { /* */ }
}
const frameKeys = keys.filter((k) => /\/frames\//.test(k) && /\/2026\/08\/(2[5-9]|30|31)\//.test(k));
const gattRows = [];

let i = 0;
for (const k of frameKeys) {
  i += 1;
  const obj = await stores.raw.getObject(k);
  if (!obj?.body) continue;
  let rows;
  try { rows = decodeFrameArchive(obj.body); } catch { continue; }
  for (const row of rows) {
    const t = Date.parse(row.t || '');
    if (!Number.isFinite(t)) continue;
    const ws = hit(t);
    if (!ws.length) continue;
    const gattHit = String(row.family || '').toLowerCase() === 'gatt'
      || /2A37/i.test(String(row.char || ''));
    const interp = row.interp && typeof row.interp === 'object' ? row.interp : {};
    const kind = String(interp.kind || interp.event || interp.state || '');
    for (const w of ws) {
      w.objects += 1;
      w.notifies += 1;
      w.families[row.family || 'unknown'] = (w.families[row.family || 'unknown'] || 0) + 1;
      const ch = String(row.char || 'none');
      w.chars[ch] = (w.chars[ch] || 0) + 1;
      if (kind) w.interpKinds[kind] = (w.interpKinds[kind] || 0) + 1;
      if (/disconnect/i.test(kind)) w.disconnect += 1;
      if (/connect/i.test(kind) && !/disconnect/i.test(kind)) w.connect += 1;
      if (/suspend|background/i.test(kind)) w.lifecycle.suspended = (w.lifecycle.suspended || 0) + 1;
      if (/terminat|killed|force.?quit|didEnterBackground/i.test(kind)) {
        w.lifecycle.terminated = (w.lifecycle.terminated || 0) + 1;
      }
      if (/queue_write_failed|enospc|eio/i.test(kind)) w.queueWrite += 1;
      if (!w.firstNotify) w.firstNotify = row.t;
      w.lastNotify = row.t;
    }
      if (gattHit) {
        gattRows.push(row);
        for (const w of ws) {
          w.gatt += 1;
          if (t >= w.start && t < w.end) w.gattBout += 1;
        }
        continue;
      }
    const bytes = [];
    const hex = String(row.hex || '');
    for (let n = 0; n < hex.length; n += 2) bytes.push(Number.parseInt(hex.slice(n, n + 2), 16));
    if (bytes.length < 10) continue;
    const family = row.family === 'harvard' ? 'harvard' : 'puffin';
    const rec = decodeFrame(bytes, family);
    for (const w of ws) {
      if (rec.packet_type === 40) {
        w.type40 += 1;
        if (t >= w.start && t < w.end) w.type40Bout += 1;
      }
      if (rec.packet_type === 43) w.t43 += 1;
      if (rec.packet_type === 51) w.t51 += 1;
    }
  }
  if (i % 30 === 0) console.error(`capture-gap ${i}/${frameKeys.length}`);
}

const gattDecoded = gattSamplesFromFrames(gattRows);
const report = windows.map((w) => {
  const gattInPad = gattDecoded.samples.filter((s) => s.ts >= w.lo && s.ts < w.hi);
  const gattInBout = gattDecoded.samples.filter((s) => s.ts >= w.start && s.ts < w.end);
  const last = Date.parse(w.lastNotify || '');
  const className = classifyCaptureWindow({
    objectCount: w.objects,
    type40Count: w.type40Bout,
    gattHrCount: gattInBout.length,
    connected: w.disconnect > w.connect ? false : (w.connect > 0 || w.notifies > 0 ? true : null),
    disconnectWithoutReconnect: w.disconnect > 0 && w.connect === 0,
    appSuspended: (w.lifecycle.suspended || 0) > 0 && w.type40Bout === 0 && gattInBout.length === 0,
    processTerminated: (w.lifecycle.terminated || 0) > 0,
    queueWriteFailed: w.queueWrite > 0,
    anyNotify: w.type40Bout + gattInBout.length > 0
      || (Number.isFinite(last) && last >= w.start && last < w.end),
  });
  return {
    id: w.id,
    sport: w.sport,
    class: className,
    objects: w.objects,
    type40_pad: w.type40,
    type40_bout: w.type40Bout,
    gatt_rows_pad: w.gatt,
    gatt_hr_pad: gattInPad.length,
    gatt_hr_bout: gattInBout.length,
    t43: w.t43,
    t51: w.t51,
    connect: w.connect,
    disconnect: w.disconnect,
    lifecycle: w.lifecycle,
    firstNotify: w.firstNotify,
    lastNotify: w.lastNotify,
    families: w.families,
  };
});

console.log(JSON.stringify({
  pad_min: 60,
  gatt_decoded: gattDecoded.stats,
  windows: report,
}, null, 2));
