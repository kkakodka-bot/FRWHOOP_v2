/**
 * Energy v2 minute engine: learned estimator with v1-physiology fallback.
 *
 * Architecture (evidence-backed, see _energy_v2_research/DECISIONS.md):
 *   - The learned model (ridge on IMU+HR minute features, trained on WEEE
 *     indirect calorimetry with participant-held-out folds) is the PRIMARY
 *     estimator for minutes where its required feature groups are present.
 *   - The v1 physiological estimator (flex-HR + motion anchors) is the
 *     FALLBACK for minutes where the learned model cannot run, and the
 *     CONSERVATIVE route for strength training (pressor response makes
 *     wrist+HR fundamentally weak there; no learned strength model is trusted).
 *   - Sleep keeps v1's flat sleeping rate (Gonnissen 2013: stage differences
 *     are not metabolic; the flat rate is the defensible choice).
 *
 * Accounting invariants are IDENTICAL to v1 (energy/engine.js):
 *   resting_kcal = RMR/1440 (or 0.95x during sleep)
 *   active_kcal  = max(0, total - resting)
 *   workout_kcal = subset of active on workout-tagged minutes (never added twice)
 *   gaps stay gaps: no estimate -> no row
 *
 * Every row is versioned with algorithm/feature/model/calibration versions and
 * an estimator provenance tag so replay can reproduce any historical output.
 */

import { dayBounds, localDateKey, resolveTimeZone } from '../../time/dayBoundary.js';
import {
  ACTIVITY,
  KCAL_PER_LITRE_O2,
  clamp,
} from '../constants.js';
import { classifyActivity } from '../activity.js';
import { routeEstimate } from '../estimators.js';
import { hrReserveFraction, vo2ToKcalPerMin } from '../physiology.js';
import { extractV2SeriesFeatures } from './features.js';
import { predictV2, composeRuntimeFeatures } from './model.js';
import { predictV2Gbm } from './gbm.js';

const MINUTE_MS = 60_000;

export const ALGORITHM_VERSION_V2 = '2.0.0';
export const FEATURE_VERSION_V2 = 'feat-v2-1';
export const MODEL_VERSION_V2 = 'energy-v2.0.0';

/** Which degradation groups are missing from the composed runtime vector. */
function missingGroupsOf(model, runtimeFeatures) {
  const groups = model.degradation?.feature_groups;
  if (!groups) return [];
  const out = [];
  for (const [group, feats] of Object.entries(groups)) {
    if (!feats.some((f) => runtimeFeatures?.[f] != null && Number.isFinite(Number(runtimeFeatures[f])))) out.push(group);
  }
  return out;
}

/** A usable model satisfies exactly one runtime contract: trees or coefficients. */
export function isUsableV2Model(model) {
  if (!model || typeof model !== 'object') return false;
  if (Array.isArray(model.trees) && model.trees.length) return true;
  if (Array.isArray(model.features) && model.coefficients && typeof model.coefficients === 'object') return true;
  return false;
}

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
      end: Number.isFinite(end) ? end : Number.POSITIVE_INFINITY,
    });
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

function workoutForMinute(spans, minuteMs) {
  let best = null;
  for (const s of spans) {
    if (s.start > minuteMs + MINUTE_MS) break;
    if (minuteMs + MINUTE_MS <= s.start || minuteMs >= s.end) continue;
    if (!best || (s.end - s.start) > (best.end - best.start)) best = s;
  }
  return best;
}

/** Learned-minute confidence: interval width + coverage + quality. */
function v2Confidence(pred, quality) {
  if (!pred) return 0.5;
  let c = 0.55;
  if (pred.interval) {
    const width = pred.interval.met_high - pred.interval.met_low;
    // Narrow interval = confident. Width 0 -> +0.35, width 6 MET -> +0.
    c += 0.25 * clamp(1 - width / 6, 0, 1);
    if (pred.missing_groups?.length) c -= 0.15 * pred.missing_groups.length;
  } else {
    c += 0.1;
  }
  return clamp(c, 0.05, 0.97);
}

/**
 * @param {object} input
 * @param {Array}  input.samples     normalized samples
 * @param {object} input.physiology  from resolvePhysiology
 * @param {Array}  input.workouts    FRWHOOP workout records
 * @param {string} input.timeZone    IANA zone
 * @param {object} input.model       loaded v2 model artifact (loadV2Model output)
 * @returns {{minutes: Array, stats: object}}
 */
export function computeEnergyMinutesV2({ samples, physiology, workouts = [], timeZone = 'UTC', model = null } = {}) {
  const tz = resolveTimeZone(timeZone);
  const spans = indexWorkouts(workouts);
  const windows = extractV2SeriesFeatures(samples);

  const minutes = [];
  const stats = {
    input: samples?.length || 0,
    windows: windows.length,
    skipped: 0,
    byActivity: {},
    estimator_counts: {},
    fallback_minutes: 0,
    learned_minutes: 0,
    strength_fallback_minutes: 0,
  };

  let sustainedEffortMinutes = 0;
  let previousActivity = null;
  let previousMinuteMs = null;

  // Per-device rest-bias calibration (domain adaptation): WHOOP dynAccel reads
  // ~0.006-0.010 g at true rest (measured on the real device) while the
  // training sensor (E4) quantizes stillness to ~0.000 g. Subtract the day's
  // own strap-motion floor (1st percentile, bounded) from the model's motion
  // inputs so runtime stillness aligns with training stillness. Deterministic
  // per day: a pure function of that day's samples.
  const strapFloors = windows
    .map((w) => w.features.strapMotion)
    .filter((v) => v != null)
    .sort((a, b) => a - b);
  const restBias = strapFloors.length >= 10
    ? clamp(strapFloors[Math.floor(strapFloors.length * 0.02)] ?? 0, 0, 0.02)
    : 0;

  for (const { features, quality } of windows) {
    const contiguous = previousMinuteMs != null && features.minuteMs - previousMinuteMs === MINUTE_MS;
    const workout = workoutForMinute(spans, features.minuteMs);
    const context = { workout, previousActivity, sustainedEffortMinutes };

    const hrr = hrReserveFraction(features.hr, physiology);
    sustainedEffortMinutes = (contiguous && hrr != null && hrr > 0.4) ? sustainedEffortMinutes + 1 : 0;
    previousMinuteMs = features.minuteMs;

    const cls = classifyActivity(features, physiology, quality, context);
    let estimate = null;
    let usedV2 = false;

    const strengthGated = cls.activity === ACTIVITY.STRENGTH;

    // Source policy (evidence: the learned model is trained on strap-derived
    // motion only; phone-sourced and HR-only minutes have no training analog,
    // and a GBM extrapolating there over-prices by ~4x on real days).
    const learnedEligible = features.motionSource === 'strap';

    if (model && isUsableV2Model(model) && learnedEligible && !strengthGated && cls.activity !== ACTIVITY.SLEEP) {
      const runtimeFeatures = composeRuntimeFeatures(features, physiology, { restBias });
      const predRaw = model.trees ? predictV2Gbm(model, runtimeFeatures) : predictV2(model, runtimeFeatures);
      const pred = predRaw && {
        ...predRaw,
        missing_groups: missingGroupsOf(model, runtimeFeatures),
        interval: Number.isFinite(model.conformal?.q) && Number.isFinite(predRaw.met)
          ? { level: model.conformal.level ?? 0.9, met_low: predRaw.met - model.conformal.q, met_high: predRaw.met + model.conformal.q }
          : null,
      };
      if (pred != null) {
        // Physiological floor: no learned prediction may price a minute below
        // this subject's own sleeping metabolism (v1's finish() applies the
        // same floor to its route; the artifact's clip.min alone is not
        // subject-anchored).
        const floorVo2 = physiology.restingVo2 * 0.95;
        const metFloored = Math.max(pred.met, floorVo2 / 3.5);
        const vo2 = metFloored * 3.5; // conventional gross MET -> mL/kg/min
        const fallbackEst = routeEstimate({
          features, quality, physiology, activity: cls.activity,
          activityConfidence: cls.confidence, context,
        });
        estimate = {
          met: metFloored,
          totalKcalPerMin: vo2ToKcalPerMin(vo2, physiology),
          modelVersion: model.model_version ?? MODEL_VERSION_V2,
          estimator: pred.missing_groups.length ? `v2-gbm(degraded:${pred.missing_groups.join('+')})` : 'v2-gbm',
          uncertainty: pred.interval ? {
            met_low: round(pred.interval.met_low, 3),
            met_high: round(pred.interval.met_high, 3),
            level: pred.interval.level,
          } : null,
          modelConfidence: v2Confidence(pred),
          debug: {
            v1_fallback_met: fallbackEst ? round(fallbackEst.met, 3) : null,
            v2_met: round(pred.met, 3),
          },
        };
        usedV2 = true;
      }
    }

    if (!estimate) {
      estimate = routeEstimate({
        features, quality, physiology, activity: cls.activity,
        activityConfidence: cls.confidence, context,
      });
      if (estimate && strengthGated) stats.strength_fallback_minutes += 1;
    }
    if (!estimate) { stats.skipped += 1; previousActivity = null; continue; }

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
      motion_source: features.motionSource,
      signal_quality: quality.overall,
      quality_flags: quality.flags,
      workout_session_id: workout?.id ?? null,
      algorithm_version: ALGORITHM_VERSION_V2,
      feature_version: FEATURE_VERSION_V2,
      model_version: estimate.modelVersion ?? MODEL_VERSION_V2,
      calibration_version: physiology.calibration.version,
      estimator: estimate.estimator,
      uncertainty: estimate.uncertainty ?? null,
    });

    stats.byActivity[cls.activity] = (stats.byActivity[cls.activity] || 0) + 1;
    stats.estimator_counts[estimate.estimator] = (stats.estimator_counts[estimate.estimator] || 0) + 1;
    if (usedV2) stats.learned_minutes += 1; else stats.fallback_minutes += 1;
    previousActivity = cls.activity;
  }

  return { minutes, stats };
}

/** Aggregate a minute series into the daily shape (same semantics as v1). */
export function aggregateDayV2(minutes, opts = {}) {
  return aggregateDayV2Impl(minutes, opts);
}
function aggregateDayV2Impl(minutes, { expectedMinutes = 1440, now = Date.now() } = {}) {
  if (!minutes?.length) return null;
  const byDay = new Map();
  for (const m of minutes) {
    if (!byDay.has(m.day)) byDay.set(m.day, []);
    byDay.get(m.day).push(m);
  }
  const out = [];
  for (const [day, rows] of byDay) {
    let resting = 0, active = 0, workout = 0, metSum = 0, peakMet = 0, confidenceSum = 0;
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
    let gap = Math.max(0, dayLength - coverage);
    const restingPerMin = resting / coverage;
    const elapsedMinutes = elapsedMinutesOf(day, tz, now, dayLength);
    const elapsedGap = Math.max(0, elapsedMinutes - coverage);
    out.push({
      day, timezone_name: tz,
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
      resting_gap_kcal: round(restingPerMin * gap, 2),
      total_kcal: round(resting + active, 2),
      projected_total_kcal: round(resting + active + restingPerMin * gap, 2),
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

function round(n, places) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export { clamp };
