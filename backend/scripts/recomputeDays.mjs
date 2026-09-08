#!/usr/bin/env node
/**
 * Identify sparse days, replay B2 into persistComputed, verify RPC vs /api/days.
 * Never prints secrets.
 *
 *   node scripts/recomputeDays.mjs --user UUID --identify --replay --verify
 */
import { storageConfig, assertCredentialsPolicy } from '../storage/config.js';
import { createMetricsDb } from '../metrics/repository.js';
import { createMetricsEngine } from '../metrics/engine.js';
import { createSupabaseRest } from '../persistence/supabaseRest.js';
import { loadDaySnapshot, snapshotToWhoopDay, snapshotHeadlines, whoopDayHeadlines, headlinesMatch } from '../metrics/snapshot.js';
import { readProfileTimeZone } from '../identity/userTimezone.js';
import { getStores } from '../storage/stores.js';
import { reconcileObjects } from '../storage/reconcile.js';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
function has(name) {
  return args.includes(`--${name}`);
}

const userId = String(flag('user', '')).trim();
if (!/^[0-9a-f-]{36}$/i.test(userId)) {
  console.error('usage: node scripts/recomputeDays.mjs --user UUID [--identify] [--replay] [--verify] [--days YYYY-MM-DD,...] [--tz IANA]');
  process.exit(2);
}

const cfg = storageConfig();
assertCredentialsPolicy(cfg);
const rest = createSupabaseRest({ cfg });
const db = createMetricsDb({ cfg });
const engine = createMetricsEngine({
  cfg,
  db,
  energyContext: async (uid) => {
    const rows = await rest.select(
      'profiles',
      `id=eq.${uid}&select=date_of_birth,sex_model,height_cm,weight_kg,reported_age_years`,
    );
    const p = rows[0] || {};
    const dob = p.date_of_birth ? new Date(p.date_of_birth) : null;
    const birthYear = dob && Number.isFinite(dob.getUTCFullYear())
      ? dob.getUTCFullYear()
      : (Number.isFinite(Number(p.reported_age_years))
        ? new Date().getUTCFullYear() - Number(p.reported_age_years)
        : null);
    return {
      profile: {
        birthYear,
        sex: p.sex_model || null,
        heightCm: p.height_cm ?? null,
        weightKg: p.weight_kg ?? null,
      },
      workouts: [],
    };
  },
});

const profileTz = await readProfileTimeZone({ rest: (table, query) => rest.select(table, query), userId });
const tz = flag('tz', profileTz || 'America/Los_Angeles');

async function identifySparse() {
  const metrics = await rest.select(
    'daily_metrics',
    `user_id=eq.${userId}&record_class=eq.user&order=day.asc&select=day,steps,strain_score,sleep_total_min,resting_hr_bpm,avg_hr_bpm,timezone_name,active_kcal,basal_kcal`,
  );
  const series = await rest.select(
    'daily_physiology_series',
    `user_id=eq.${userId}&select=day,hr_series,strain_series,sample_count`,
  );
  const bySeries = new Map((series || []).map((row) => [row.day, row]));
  const flagged = [];
  for (const row of metrics || []) {
    const s = bySeries.get(row.day) || {};
    const hr = Array.isArray(s.hr_series) ? s.hr_series.length : 0;
    const strainPts = Array.isArray(s.strain_series) ? s.strain_series.length : 0;
    const reasons = [];
    if (hr < 200) reasons.push(`hr_buckets:${hr}`);
    if (strainPts === 0) reasons.push('empty_strain_series');
    if (row.sleep_total_min == null) reasons.push('missing_sleep_total');
    if (row.steps == null) reasons.push('missing_steps');
    if (row.timezone_name && row.timezone_name !== tz) reasons.push(`tz:${row.timezone_name}`);
    if (reasons.length) flagged.push({ day: row.day, reasons, hr_buckets: hr, sample_count: s.sample_count || 0 });
  }
  return flagged;
}

async function verifyDays(days) {
  const out = [];
  for (const day of days) {
    const snap = await loadDaySnapshot({ rest, userId, day, timeZone: tz });
    const whoop = snapshotToWhoopDay(snap);
    const rpc = await db.readDaySnapshot(userId, day);
    const fromSnap = snapshotHeadlines(snap);
    const fromWhoop = whoopDayHeadlines(day, whoop);
    const fromRpc = snapshotHeadlines(rpc);
    const apiDaysMatch = headlinesMatch(fromSnap, fromWhoop);
    const rpcMatch = headlinesMatch(fromSnap, fromRpc);
    out.push({
      day,
      match: apiDaysMatch && rpcMatch,
      api_days: apiDaysMatch,
      rpc: rpcMatch,
      headlines: fromSnap,
      ...(apiDaysMatch && rpcMatch ? {} : { rpc_headlines: fromRpc, whoop_headlines: fromWhoop }),
    });
  }
  return out;
}

const identified = await identifySparse();
const fromFlag = String(flag('days', '')).split(',').map((d) => d.trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
const days = fromFlag.length ? fromFlag : identified.map((row) => row.day);

const report = { user: `${userId.slice(0, 8)}…`, tz, identified, days, replay: null, verify: null, reconcile: null };

if (has('replay') && days.length) {
  report.replay = await engine.recomputeFromStorage({ userId, days, timeZone: tz });
}

if (has('verify') && days.length) {
  report.verify = await verifyDays(days);
}

if (has('reconcile')) {
  const stores = await getStores(cfg);
  report.reconcile = await reconcileObjects({
    rest,
    objectStore: stores.raw,
    userId,
  });
}

const verifyFailed = (report.verify || []).some((row) => !row.match);
console.log(JSON.stringify({
  ok: !verifyFailed,
  identified: report.identified.length,
  days: report.days,
  replay: report.replay && {
    days: report.replay.days,
    manifests: report.replay.manifests,
    samples: report.replay.samples,
    resultCount: (report.replay.results || []).length,
    error: report.replay.error || null,
  },
  verify: report.verify,
  reconcile: report.reconcile,
  tz,
}, null, 2));
if (verifyFailed) process.exit(1);
