/**
 * Does the strap bank to flash while no phone is connected?
 *
 * The flash islands we can drain stop at 2026-08-23, which is exactly when this
 * phone started connecting regularly — suggesting the strap streams instead of
 * banking whenever it has a subscribed consumer. If that is right, an app that
 * iOS suspends is the worst case: the strap keeps streaming to a dead listener
 * and never banks, so those hours are lost rather than backfillable.
 *
 * Usage:
 *   node tools/bank-test.mjs start                 # mark the window open
 *   node tools/bank-test.mjs check                 # after reconnecting
 *
 * `check` reports coverage inside the window, split by how each sample arrived:
 * live rows (streamed while connected) vs history rows (drained from flash).
 * History rows inside a window with no connection are the positive result.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { storageConfig } from '../storage/config.js';
import { getStores } from '../storage/stores.js';
import { createSupabaseRest } from '../persistence/supabaseRest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const markerFile = path.join(here, '../data/bank-test.json');
const mode = process.argv[2];
const userId = process.argv[3] || '9f33375b-e029-480f-9ebb-a99e5ff22ac9';

function daysBetween(startIso, endIso) {
  const out = [];
  const end = Date.parse(endIso);
  for (let t = Date.parse(startIso); t <= end + 86_400_000; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (!out.includes(day)) out.push(day);
  }
  return out;
}

if (mode === 'start') {
  const marker = { user_id: userId, opened_at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(markerFile), { recursive: true });
  fs.writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`);
  console.log(`window opened at ${marker.opened_at}`);
  console.log('Now disconnect the phone from the strap (turn iPhone Bluetooth off is cleanest),');
  console.log('keep wearing the strap, wait ~45 min, then re-enable Bluetooth, open FRWHOOP,');
  console.log('let it drain for a few minutes, and run: node tools/bank-test.mjs check');
  process.exit(0);
}

if (mode !== 'check') {
  console.error('usage: node tools/bank-test.mjs <start|check> [userId]');
  process.exit(1);
}

const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
const startIso = marker.opened_at;
const closedIso = new Date().toISOString();
const startMs = Date.parse(startIso);
const cfg = storageConfig();
const rest = createSupabaseRest({ cfg });
const { raw } = await getStores(cfg);

// Live rows land in the per-day NDJSON; history rows only ever reach the archive.
let live = 0;
const liveHours = new Set();
for (const day of daysBetween(startIso, closedIso)) {
  const file = path.join(here, '../data/live', userId, `${day}.ndjson`);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const ms = Date.parse(r.t || r.datetime || '');
    if (!r.bpm || !Number.isFinite(ms) || ms < startMs) continue;
    live += 1;
    liveHours.add(new Date(ms).toISOString().slice(0, 13));
  }
}

let history = 0;
const historyHours = new Set();
for (const day of daysBetween(startIso, closedIso)) {
  const manifests = await rest.select(
    'object_manifests',
    `user_id=eq.${userId}&period_day=eq.${day}&object_kind=eq.physiology&select=object_key`,
  );
  for (const m of manifests || []) {
    let got;
    try { got = await raw.getObject(m.object_key); } catch { continue; }
    if (!got?.body) continue;
    let text;
    try { text = zlib.gunzipSync(got.body).toString('utf8'); }
    catch { text = got.body.toString('utf8'); }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      // t_strap is stamped only on rows decoded from the strap's flash offload.
      if (!r.bpm || !r.t_strap) continue;
      const ms = Date.parse(r.t || '');
      if (!Number.isFinite(ms) || ms < startMs) continue;
      history += 1;
      historyHours.add(new Date(ms).toISOString().slice(0, 13));
    }
  }
}

const mins = Math.round((Date.parse(closedIso) - startMs) / 60_000);
console.log(`\nwindow ${startIso} → ${closedIso} (${mins} min)`);
console.log(`  live rows    ${live}  hours: ${[...liveHours].sort().join(',') || '-'}`);
console.log(`  flash rows   ${history}  hours: ${[...historyHours].sort().join(',') || '-'}`);
console.log(
  history > 0
    ? '\nRESULT: the strap DOES bank while disconnected. Dropping the BLE link when the\n'
      + 'app backgrounds would convert unrecoverable live gaps into recoverable flash.'
    : '\nRESULT: no flash rows for the disconnected window. The strap did not bank it,\n'
      + 'so those hours are unrecoverable and the gap must be closed at capture time.',
);
