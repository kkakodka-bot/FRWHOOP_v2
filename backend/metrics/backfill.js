import fs from 'node:fs';
import { loadDayIndex } from '../coach/days.js';

/**
 * Backfills the historical coach-days index (data/coach-days.json) into
 * cloud daily_metrics via the sync queue. Idempotent: rows upsert on the
 * (user_id, day) key and only fill/overwrite fields the coach history
 * actually has. Re-runs on boot and whenever the index file changes.
 */

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Coach uses 0 for "no data" on these fields; 0 is not a real measurement. */
function numOrNullWhenZero(v) {
  const n = num(v);
  return n === 0 ? null : n;
}

/** "2025-06-03 02:33:38" → "2025-06-03T02:33:38Z" (wall clock preserved, tagged UTC). */
function isoTs(v) {
  if (!v || typeof v !== 'string') return null;
  const t = v.trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t)) return null;
  return /Z|[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t}Z`;
}

export function coachRowToDailyMetric(row, userId) {
  if (!row?.day || !userId) return null;
  const workouts = Array.isArray(row.workouts) ? row.workouts : [];
  const efficiency = num(row.sleepEfficiency);
  return {
    user_id: userId,
    day: row.day,
    charge: numOrNullWhenZero(row.recovery),
    effort: num(row.strain),
    rest: num(row.sleepPerformance),
    hrv_rmssd_ms: num(row.hrv),
    resting_hr_bpm: num(row.rhr),
    avg_hr_bpm: numOrNullWhenZero(row.avgHr),
    max_hr_bpm: numOrNullWhenZero(row.maxHr),
    resp_rate_bpm: num(row.resp),
    skin_temp_c: num(row.skinTemp),
    spo2_pct: num(row.spo2),
    steps: num(row.steps),
    active_kcal: numOrNullWhenZero(row.calories),
    vo2max: num(row.vo2max ?? row.vo2Max),
    body_fat_pct: num(row.bodyFatPct),
    sleep_total_min: num(row.asleepMin),
    sleep_deep_min: num(row.deepMin),
    sleep_rem_min: num(row.remMin),
    sleep_light_min: num(row.lightMin),
    sleep_in_bed_min: num(row.inBedMin),
    sleep_awake_min: num(row.awakeMin),
    sleep_efficiency: efficiency == null ? null : (efficiency > 1 ? efficiency / 100 : efficiency),
    sleep_need_min: num(row.sleepNeedMin),
    sleep_consistency: num(row.sleepConsistency),
    sleep_onset_at: isoTs(row.sleepOnset),
    wake_onset_at: isoTs(row.wakeOnset),
    sleep_debt_balance_min: num(row.sleepDebtMin),
    exercise_count: workouts.length || null,
    extras: {
      nap: Boolean(row.nap),
      workouts: workouts.map((w) => ({
        name: w.name || 'Activity',
        start: w.start || null,
        durationMin: num(w.durationMin),
        strain: num(w.strain),
        calories: num(w.calories),
      })),
      sleep_onset_raw: row.sleepOnset || null,
      wake_onset_raw: row.wakeOnset || null,
    },
    provenance: { source: 'coach-days-backfill' },
    algorithm_version: 'coach-days-1',
    computed_at: new Date().toISOString(),
  };
}

export function buildBackfillRows(userId, indexPath) {
  const index = loadDayIndex(indexPath);
  return (index.days || [])
    .map((row) => coachRowToDailyMetric(row, userId))
    .filter(Boolean);
}

export function enqueueCoachBackfill(queue, userId, { indexPath, chunkSize = 40 } = {}) {
  const rows = buildBackfillRows(userId, indexPath);
  let enqueued = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    queue.enqueue({ type: 'daily_metrics', rows: rows.slice(i, i + chunkSize) });
    enqueued += 1;
  }
  return { days: rows.length, chunks: enqueued };
}

/**
 * Boot backfill + file watch. Returns a stop function. The queue dedupes and
 * merges by day, so re-enqueues are cheap and safe.
 */
export function startCoachBackfill({ queue, userId, indexPath, intervalMs = 60_000, log = () => {} } = {}) {
  if (!queue || !userId) return () => {};
  let lastMtime = 0;
  const run = () => {
    try {
      const file = indexPath || undefined;
      const stat = fs.statSync(file || new URL('../data/coach-days.json', import.meta.url));
      const mtime = stat.mtimeMs;
      if (mtime === lastMtime) return;
      lastMtime = mtime;
      const r = enqueueCoachBackfill(queue, userId, { indexPath });
      log(`coach backfill queued: ${r.days} days in ${r.chunks} chunks`);
    } catch (err) {
      log(`coach backfill skipped: ${err?.message || err}`);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}
