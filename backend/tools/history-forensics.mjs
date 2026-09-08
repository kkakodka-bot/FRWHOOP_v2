/**
 * Read archived physiology objects for a day and report where each row's strap
 * clock says it belongs versus where it was filed.
 *
 * Rows carrying a large clock_offset_sec were rebased by the old historical
 * clock correction, so their t is the receive instant rather than sensor time.
 * t_strap survives in the archive, which is what makes those rows recoverable.
 *
 *   node tools/history-forensics.mjs <user-id> <day> [day...]
 */
import zlib from 'node:zlib';
import { storageConfig } from '../storage/config.js';
import { getStores } from '../storage/stores.js';
import { createSupabaseRest } from '../persistence/supabaseRest.js';

const [userId, ...days] = process.argv.slice(2);
if (!userId || !days.length) {
  console.error('usage: node tools/history-forensics.mjs <user-id> <day> [day...]');
  process.exit(1);
}

const cfg = storageConfig();
const rest = createSupabaseRest({ cfg });
const { raw } = await getStores(cfg);
if (!raw) {
  console.error('raw object store is not configured');
  process.exit(1);
}

function rowsOf(buf) {
  let text;
  try { text = zlib.gunzipSync(buf).toString('utf8'); }
  catch { text = buf.toString('utf8'); }
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* header or partial line */ }
  }
  return out;
}

for (const day of days) {
  const manifests = await rest.select(
    'object_manifests',
    `user_id=eq.${userId}&period_day=eq.${day}&object_kind=eq.physiology&select=object_key,sample_count,status`,
  );
  let total = 0;
  let rebased = 0;
  const filedHours = new Set();
  const strapHours = new Set();
  const recoverable = new Map();
  for (const m of manifests || []) {
    let got;
    try { got = await raw.getObject(m.object_key); }
    catch (err) { console.error(`  ! ${m.object_key}: ${err.message}`); continue; }
    if (!got?.body) { console.error(`  ! ${m.object_key}: missing`); continue; }
    for (const r of rowsOf(got.body)) {
      if (r.bpm == null) continue;
      total += 1;
      if (r.t) filedHours.add(String(r.t).slice(0, 13));
      const off = Number(r.clock_offset_sec) || 0;
      if (Math.abs(off) < 3600 || !r.t_strap) continue;
      rebased += 1;
      strapHours.add(String(r.t_strap).slice(0, 13));
      const trueDay = String(r.t_strap).slice(0, 10);
      recoverable.set(trueDay, (recoverable.get(trueDay) || 0) + 1);
    }
  }
  console.log(`\n${day}: ${manifests?.length || 0} objects, ${total} HR rows`);
  console.log(`  filed hours (UTC): ${[...filedHours].sort().map((h) => h.slice(11)).join(',') || '-'}`);
  console.log(`  rows rebased by the old clock bug: ${rebased}`);
  if (rebased) {
    console.log(`  their real strap hours: ${[...strapHours].sort().join(' ')}`);
    console.log('  recoverable onto:', Object.fromEntries([...recoverable].sort()));
  }
}
