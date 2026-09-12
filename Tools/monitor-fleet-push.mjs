#!/usr/bin/env node
/**
 * FRWHOOP fleet-push monitor (read-only). Queries Supabase directly — no Node API dependency.
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment.
 *
 * Usage: node Tools/monitor-fleet-push.mjs            (alert mode, exit 1 on failure)
 *        node Tools/monitor-fleet-push.mjs --now     (print status, exit 0 always)
 */
const url = String(process.env.SUPABASE_URL || process.env.PROJECT_URL || '').replace(/\/$/, '');
const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY || '').trim();

if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  process.exit(2);
}

const now = new Date();
const recentMin = Number(process.env.FRWHOOP_MONITOR_RECENT_MIN || 10);
const iso = (d) => d.toISOString();
const ago = (min) => new Date(now.getTime() - min * 60_000);

async function select(table, query) {
  const res = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`${table} ${res.status}`);
  return res.json();
}

async function checkWalFreshness() {
  const rows = await select('noop_push_wal', 'select=received_at,user_id,batch_id&order=received_at.desc&limit=1');
  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  const ok = row ? new Date(row.received_at).getTime() >= ago(recentMin).getTime() : false;
  return { ok, note: row ? `newest wal received_at=${row.received_at}` : 'no wal rows yet', row };
}

async function checkFailedObjects() {
  const rows = await select('object_manifests',
    'select=id,status,created_at,user_id,object_key&status=in.(failed,corrupt)&order=created_at.desc&limit=20');
  const ok = !(Array.isArray(rows) && rows.length);
  return { ok, note: ok ? 'no failed/corrupt manifests' : `${rows.length} failed/corrupt manifest(s)`, rows: Array.isArray(rows) ? rows : [] };
}

async function checkWindowCoverage() {
  const since = ago(2 * 60);
  const rows = await select('noop_signal_windows',
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
console.log(JSON.stringify({ ok, checkedAt: iso(now), recentMinutes: recentMin, checks: results }, null, 2));
if (!ok && !process.argv.includes('--now')) process.exit(1);
