// FRWHOOP fleet-push monitor (read-only). Queries Supabase directly so the deployed Edge Function
// ingestion is watched independent of the local Node API. Exit 0 = healthy, 1 = any check failed.
// Usage: node bin/monitor-fleet-push.mjs            (alert mode, exit code)
//        node bin/monitor-fleet-push.mjs --now     (print current status, exit 0 always)
// Cadence owner: launchd (see install-fleet-push-monitor.mjs) or cron, every 15 minutes.
import { createSupabaseRest } from '../persistence/supabaseRest.js';
import { storageConfig } from '../storage/config.js';

const cfg = storageConfig();
const rest = createSupabaseRest({ cfg });
const now = new Date();
const recentMin = Number(process.env.FRWHOOP_MONITOR_RECENT_MIN || 10);
const iso = (d) => d.toISOString();
const ago = (min) => new Date(now.getTime() - min * 60_000);

function summarize(label, rows) {
  const arr = Array.isArray(rows) ? rows : [];
  const meta = arr.length ? { newest: arr[0] } : {};
  return { count: arr.length, ...meta };
}

async function checkWalFreshness() {
  // newest received batch in the WAL
  const rows = await rest.select('noop_push_wal', `select=received_at,user_id,batch_id&order=received_at.desc&limit=1`);
  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  const ok = row ? new Date(row.received_at).getTime() >= ago(recentMin).getTime() : false;
  return { ok, note: row ? `newest wal received_at=${row.received_at}` : 'no wal rows yet', row };
}

async function checkFailedObjects() {
  const rows = await rest.select('object_manifests',
    `select=id,status,created_at,user_id,object_key&status=in.(failed,corrupt)&order=created_at.desc&limit=20`);
  const ok = !(Array.isArray(rows) && rows.length);
  return { ok, note: ok ? 'no failed/corrupt manifests' : `${rows.length} failed/corrupt manifest(s)`, rows: Array.isArray(rows) ? rows : [] };
}

async function checkWindowCoverage() {
  // Recent signal windows, client-side coverage filter (hour_start unit is opaque to this probe).
  const since = ago(2 * 60);
  const rows = await rest.select('noop_signal_windows',
    `select=user_id,device_id,stream,hour_start,coverage,updated_at&updated_at=gte.${encodeURIComponent(iso(since))}&limit=500`);
  const list = Array.isArray(rows) ? rows : [];
  const poor = list.filter((r) => r.coverage != null && r.coverage >= 0 && r.coverage < 0.5);
  return { ok: poor.length === 0, note: `${list.length} recent window(s), ${poor.length} with coverage<0.5`, poor };
}

const results = {
  walFreshness: await checkWalFreshness(),
  failedObjects: await checkFailedObjects(),
  windowCoverage: await checkWindowCoverage(),
};
const ok = Object.values(results).every((r) => r.ok);
const out = { ok, checkedAt: iso(now), recentMinutes: recentMin, checks: results };
console.log(JSON.stringify(out, null, 2));
if (!ok && !process.argv.includes('--now')) process.exit(1);
