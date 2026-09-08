/**
 * The energy engine: samples in, per-minute energy rows out.
 *
 * Pure function of its inputs. It reads no globals, performs no I/O, and holds no
 * state between calls, which is what makes reprocessing a day from B2 produce
 * byte-identical output to the original live pass — the property Phase 11
 * requires for historical recomputation.
 *
 * Calorie semantics (Phase 7), enforced here and asserted in the tests:
 *
 *   resting_kcal   cost of being alive for that minute (RMR/1440, or the sleeping
 *                  rate during sleep)
 *   active_kcal    total - resting, floored at zero
 *   total_kcal     resting + active  (a generated column in Postgres)
 *   workout_kcal   the subset of active_kcal on minutes inside a workout
 *
 * Workout calories are therefore never additional to active calories; they are a
 * label on a slice of them. Nothing in this file adds them a second time.
 */

import { dayBounds, localDateKey, resolveTimeZone } from '../time/dayBoundary.js';
import {
  ACTIVITY,
  ALGORITHM_VERSION,
  FEATURE_VERSION,
  MODEL_VERSION,
  clamp,
} from './constants.js';
import { classifyActivity } from './activity.js';
import { extractSeriesFeatures } from './features.js';
import { hrReserveFraction } from './physiology.js';
import { routeEstimate } from './estimators.js';

const MINUTE_MS = 60_000;

/** Index workouts so minute lookup is O(1) amortised instead of O(workouts). */
function indexWorkouts(workouts) {
  const spans = [];
  for (const w of workouts || []) {
    const start = Date.parse(w.start ?? w.start_time ?? w.startedAt ?? '');
    const end = Date.parse(w.end ?? w.end_time ?? w.endedAt ?? '');
    if (!Number.isFinite(start)) continue;
    spans.push({
      id: w.id ?? w.session_id ?? null,
      sport: w.sport ?? w.name ?? w.activityType ?? null,
      start,
      // An open workout (no end yet) extends to now; a finalized one does not.
      end: Number.isFinite(end) ? end : Number.POSITIVE_INFINITY,
    });
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

/**
 * Which workout owns this minute.
 *
 * Overlapping workouts are possible after a manual edit. The longest-running
 * containing span wins, deterministically, so a minute is never counted into two
 * workouts and re-running the engine cannot flip the assignment.
 */
function workoutForMinute(spans, minuteMs) {
  let best = null;
  for (const s of spans) {
    if (s.start > minuteMs + MINUTE_MS) break;
    if (minuteMs + MINUTE_MS <= s.start || minuteMs >= s.end) continue;
    if (!best || (s.end - s.start) > (best.end - best.start)) best = s;
  }
  return best;
}

/**
 * @param {object} input
 * @param {Array}  input.samples     normalized samples: { t, bpm, rr_ms, mot, stage, q }
 * @param {object} input.physiology  from resolvePhysiology
 * @param {Array}  input.workouts    existing FRWHOOP workout records
 * @param {string} input.timeZone    IANA zone for local-day assignment
 * @returns {{minutes: Array, stats: object}}
 */
export function computeEnergyMinutes({ samples, physiology, workouts = [], timeZone = 'UTC' } = {}) {
  const tz = resolveTimeZone(timeZone);
  const spans = indexWorkouts(workouts);
  const windows = extractSeriesFeatures(samples);

  const minutes = [];
  const stats = { input: samples?.length || 0, windows: windows.length, skipped: 0, byActivity: {} };

  let sustainedEffortMinutes = 0;
  let previousActivity = null;
  let previousMinuteMs = null;

  for (const { features, quality } of windows) {
    // Cardiovascular drift only accrues across *contiguous* effort. A gap resets
    // it, otherwise a morning run would still be discounting an evening one.
    const contiguous = previousMinuteMs != null && features.minuteMs - previousMinuteMs === MINUTE_MS;
    const hrr = hrReserveFraction(features.hr, physiology);
    sustainedEffortMinutes = (contiguous && hrr != null && hrr > 0.4)
      ? sustainedEffortMinutes + 1
      : 0;
    previousMinuteMs = features.minuteMs;

    const workout = workoutForMinute(spans, features.minuteMs);
    const context = { workout, previousActivity, sustainedEffortMinutes };

    const cls = classifyActivity(features, physiology, quality, context);
    const estimate = routeEstimate({
      features,
      quality,
      physiology,
      activity: cls.activity,
      activityConfidence: cls.confidence,
      context,
    });

    // No usable channel means no row. A gap in the series is honest; a
    // resting-shaped placeholder would be a fabricated measurement.
    if (!estimate) {
      stats.skipped += 1;
      previousActivity = null;
      continue;
    }

    const restingKcal = cls.activity === ACTIVITY.SLEEP
      ? physiology.sleepKcalPerMin
      : physiology.restingKcalPerMin;
    const activeKcal = Math.max(0, estimate.totalKcalPerMin - restingKcal);

    const iso = new Date(features.minuteMs).toISOString();
    minutes.push({
      minute_at: iso,
      day: localDateKey(iso, tz),
      timezone_name: tz,
      met: round(estimate.met, 3),
      resting_kcal: round(restingKcal, 4),
      active_kcal: round(activeKcal, 4),
      activity_type: cls.activity,
      activity_confidence: round(cls.confidence, 3),
      model_confidence: round(estimate.modelConfidence, 3),
      hr: features.hr,
      hr_source: features.hrCount > 0 ? 'measured' : 'absent',
      motion_intensity: features.motion,
      signal_quality: quality.overall,
      quality_flags: quality.flags,
      workout_session_id: workout?.id ?? null,
      algorithm_version: ALGORITHM_VERSION,
      feature_version: FEATURE_VERSION,
      model_version: MODEL_VERSION,
      calibration_version: physiology.calibration.version,
      estimator: estimate.estimator,
      debug: {
        vo2: round(estimate.vo2, 2),
        hrChannel: round(estimate.channels.hr, 2),
        motionChannel: round(estimate.channels.motion, 2),
        weights: { hr: round(estimate.weights.hr, 3), motion: round(estimate.weights.motion, 3) },
        agreement: round(estimate.agreement, 3),
        classifier: cls.reason,
      },
    });

    stats.byActivity[cls.activity] = (stats.byActivity[cls.activity] || 0) + 1;
    previousActivity = cls.activity;
  }

  return { minutes, stats };
}

/**
 * Aggregate a minute series into the daily shape.
 *
 * Recomputed from the minute rows every time, never incremented, so a late
 * upload or a corrected workout produces a correct day rather than a drifted one.
 * Postgres does the same aggregation in `energy_rollup_day`; this JS version
 * exists so the engine can be evaluated and tested without a database.
 */
export function aggregateDay(minutes, { expectedMinutes = 1440, now = Date.now() } = {}) {
  if (!minutes?.length) return null;
  const byDay = new Map();
  for (const m of minutes) {
    if (!byDay.has(m.day)) byDay.set(m.day, []);
    byDay.get(m.day).push(m);
  }

  const out = [];
  for (const [day, rows] of byDay) {
    let resting = 0;
    let active = 0;
    let workout = 0;
    let metSum = 0;
    let peakMet = 0;
    let confidenceSum = 0;
    const counts = { high: 0, moderate: 0, sedentary: 0, sleep: 0 };

    for (const r of rows) {
      resting += r.resting_kcal;
      active += r.active_kcal;
      if (r.workout_session_id) workout += r.active_kcal;
      metSum += r.met;
      peakMet = Math.max(peakMet, r.met);
      confidenceSum += r.model_confidence;
      if (r.activity_type === ACTIVITY.SLEEP) counts.sleep += 1;
      else if (r.met >= 6) counts.high += 1;
      else if (r.met >= 3) counts.moderate += 1;
      else counts.sedentary += 1;
    }

    const coverage = rows.length;
    const tz = rows[0].timezone_name;
    let dayLength = expectedMinutes;
    try {
      const bounds = dayBounds(day, tz);
      const ms = Date.parse(bounds.day_end_at) - Date.parse(bounds.day_start_at);
      if (Number.isFinite(ms) && ms > 0) dayLength = Math.round(ms / MINUTE_MS);
    } catch { /* tests may pass a non-date day key */ }
    const gap = Math.max(0, dayLength - coverage);
    const restingPerMin = resting / coverage;
    const elapsedMinutes = elapsedMinutesOf(day, tz, now, dayLength);
    const elapsedGap = Math.max(0, elapsedMinutes - coverage);

    out.push({
      day,
      timezone_name: tz,
      resting_kcal: round(resting, 2),
      active_kcal: round(active, 2),
      workout_kcal: round(workout, 2),
      average_met: round(metSum / coverage, 3),
      peak_met: round(peakMet, 3),
      high_activity_minutes: counts.high,
      moderate_activity_minutes: counts.moderate,
      sedentary_minutes: counts.sedentary,
      sleep_minutes: counts.sleep,
      coverage_minutes: coverage,
      gap_minutes: gap,
      // Explicitly separate: resting metabolism continues during a strap gap, so
      // projecting it is defensible. Projecting *active* energy would not be, and
      // is never done. `total_kcal` stays measurement-only.
      resting_gap_kcal: round(restingPerMin * gap, 2),
      total_kcal: round(resting + active, 2),
      projected_total_kcal: round(resting + active + restingPerMin * gap, 2),
      // Calories so far: measured minutes plus resting fill for elapsed gaps
      // only — not the remaining hours of the day.
      elapsed_total_kcal: round(resting + active + restingPerMin * elapsedGap, 2),
      elapsed_minutes: elapsedMinutes,
      model_confidence: round(confidenceSum / coverage, 3),
      algorithm_version: rows[0].algorithm_version,
      model_version: rows[0].model_version,
      calibration_version: rows[0].calibration_version,
    });
  }
  return out;
}

function elapsedMinutesOf(day, timeZone, nowMs, dayLength) {
  try {
    const bounds = dayBounds(day, timeZone);
    const start = Date.parse(bounds.day_start_at);
    const end = Date.parse(bounds.day_end_at);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return dayLength;
    if (nowMs <= start) return 0;
    if (nowMs >= end) return dayLength;
    return Math.max(0, Math.min(dayLength, Math.floor((nowMs - start) / MINUTE_MS)));
  } catch {
    return dayLength;
  }
}

/** Aggregate a minute series into per-workout summaries. */
export function aggregateWorkouts(minutes, workouts = []) {
  const byWorkout = new Map();
  for (const m of minutes || []) {
    if (!m.workout_session_id) continue;
    if (!byWorkout.has(m.workout_session_id)) byWorkout.set(m.workout_session_id, []);
    byWorkout.get(m.workout_session_id).push(m);
  }

  const meta = new Map(
    (workouts || []).map((w) => [w.id ?? w.session_id, w]),
  );

  const out = [];
  for (const [sessionId, rows] of byWorkout) {
    rows.sort((a, b) => a.minute_at.localeCompare(b.minute_at));
    let active = 0;
    let resting = 0;
    let metSum = 0;
    let peakMet = 0;
    let hrSum = 0;
    let hrCount = 0;
    let peakHr = 0;
    let confidenceSum = 0;
    const activityCounts = new Map();

    for (const r of rows) {
      active += r.active_kcal;
      resting += r.resting_kcal;
      metSum += r.met;
      peakMet = Math.max(peakMet, r.met);
      if (r.hr != null) { hrSum += r.hr; hrCount += 1; peakHr = Math.max(peakHr, r.hr); }
      confidenceSum += r.model_confidence;
      activityCounts.set(r.activity_type, (activityCounts.get(r.activity_type) || 0) + 1);
    }

    let dominant = ACTIVITY.WORKOUT_OTHER;
    let dominantCount = 0;
    for (const [k, v] of activityCounts) if (v > dominantCount) { dominant = k; dominantCount = v; }

    const w = meta.get(sessionId) || {};
    out.push({
      session_id: sessionId,
      start_time: w.start ?? w.start_time ?? rows[0].minute_at,
      end_time: w.end ?? w.end_time ?? rows[rows.length - 1].minute_at,
      duration_minutes: rows.length,
      activity_type: dominant,
      active_kcal: round(active, 2),
      resting_kcal: round(resting, 2),
      total_kcal: round(active + resting, 2),
      average_met: round(metSum / rows.length, 3),
      peak_met: round(peakMet, 3),
      average_hr: hrCount ? round(hrSum / hrCount, 1) : null,
      peak_hr: peakHr || null,
      confidence: round(confidenceSum / rows.length, 3),
      coverage_minutes: rows.length,
      algorithm_version: rows[0].algorithm_version,
      model_version: rows[0].model_version,
      calibration_version: rows[0].calibration_version,
    });
  }
  return out;
}

/**
 * Instantaneous burn rate for the live UI, marked provisional.
 *
 * The backend stays authoritative: this is the same engine over the trailing few
 * minutes, so when the confirmed row lands it agrees to within rounding and the
 * number does not visibly jump.
 */
export function currentBurnRate(minutes, { staleAfterMinutes = 5, now = Date.now() } = {}) {
  if (!minutes?.length) return null;
  const recent = minutes
    .filter((m) => now - Date.parse(m.minute_at) <= staleAfterMinutes * MINUTE_MS)
    .slice(-3);
  if (!recent.length) return null;
  const total = recent.reduce((a, m) => a + m.resting_kcal + m.active_kcal, 0) / recent.length;
  const last = recent[recent.length - 1];
  return {
    kcal_per_min: round(total, 2),
    met: last.met,
    activity_type: last.activity_type,
    confidence: last.model_confidence,
    state: 'provisional',
    as_of: last.minute_at,
  };
}

function round(n, places) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export { clamp };
