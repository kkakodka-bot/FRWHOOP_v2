
/**
 * Phase 4 production integration: temporal activity smoothing over the engine's
 * per-minute classification series.
 *
 * The single-pass engine (engine.js computeEnergyMinutes) is byte-ideal for
 * recomputation, so we do NOT rewrite it. Instead this module runs the same
 * per-minute pipeline TWICE:
 *   pass 1: classify every minute (get emergent {activity, confidence})
 *   smooth: causal HMM filter over the raw label series (removes flicker)
 *   pass 2: re-route each minute with the SMOOTHED activity label, so the
 *           activity_type, confidence, resting/active split and MET all agree.
 * A minute whose classification drops out (no usable channel) is kept as a gap
 * and skipped in both passes, exactly like the single-pass engine.
 *
 * filtering (causal) so no future minute changes the current one - this is what
 * a live product would actually have known in real time.
 */
import { localDateKey, resolveTimeZone } from '../time/dayBoundary.js';
import {
  ACTIVITY, ALGORITHM_VERSION, FEATURE_VERSION, MODEL_VERSION, clamp,
} from './constants.js';
import { classifyActivity } from './activity.js';
import { extractSeriesFeatures } from './features.js';
import { routeEstimate } from './estimators.js';
import { smoothActivityFilter, smoothActivityFull } from './smoothing.js';

const MINUTE_MS = 60_000;

function indexWorkouts(workouts) {
  const spans = [];
  for (const w of workouts || []) {
    const start = Date.parse(w.start ?? w.start_time ?? w.startedAt ?? '');
    const end = Date.parse(w.end ?? w.end_time ?? w.endedAt ?? '');
    if (!Number.isFinite(start)) continue;
    spans.push({ id: w.id ?? w.session_id ?? null, sport: w.sport ?? w.name ?? w.activityType ?? null, start, end: Number.isFinite(end) ? end : Number.POSITIVE_INFINITY });
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

/**
 * Two-pass engine with optional temporal activity smoothing.
 * @param {object} o
 * @param {Array}  o.samples
 * @param {object} o.physiology
 * @param {Array}  [o.workouts]
 * @param {string} [o.timeZone='UTC']
 * @param {string} [o.smooth='filter']  'filter' | 'full' | 'none'
 * @returns {{minutes:Array, stats:object}}
 */
export function computeEnergyMinutesWithSmoothing({ samples, physiology, workouts = [], timeZone = 'UTC', smooth = 'filter' } = {}) {
  const tz = resolveTimeZone(timeZone);
  const spans = indexWorkouts(workouts);
  const windows = extractSeriesFeatures(samples);
  const stats = { input: samples?.length || 0, windows: windows.length, skipped: 0, byActivity: {} };
  if (smooth === 'none') {
    // fall back to the plain engine
    const { computeEnergyMinutes } = { ...{} };
  }
  // ---- pass 1: classify each minute ----
  const raw = [];
  let previousActivity = null;
  let previousMinuteMs = null;
  let sustainedEffortMinutes = 0;
  for (const { features, quality } of windows) {
    const contiguous = previousMinuteMs != null && features.minuteMs - previousMinuteMs === MINUTE_MS;
    const hrr = features.hr != null && physiology.restingHr != null ? (features.hr - physiology.restingHr) / Math.max(physiology.hrMax - physiology.restingHr, 20) : null;
    sustainedEffortMinutes = (contiguous && hrr != null && hrr > 0.4) ? sustainedEffortMinutes + 1 : 0;
    previousMinuteMs = features.minuteMs;
    const workout = workoutForMinute(spans, features.minuteMs);
    const context = { workout, previousActivity, sustainedEffortMinutes };
    const cls = classifyActivity(features, physiology, quality, context);
    raw.push({ features, quality, workout, cls, context, sustainedEffortMinutes });
    previousActivity = cls.activity;
  }
  // ---- apply temporal smoothing to the label series ----
  let labelless = raw;
  if (smooth === 'filter' || smooth === 'full') {
    const seq = raw.map((r) => ({ activity: r.cls.activity, confidence: r.cls.confidence }));
    const sm = smooth === 'full' ? smoothActivityFull(seq) : smoothActivityFilter(seq);
    labelless = raw.map((r, i) => ({ ...r, smoothedActivity: sm[i].activity, smoothedConfidence: sm[i].confidence }));
  } else {
    labelless = raw.map((r) => ({ ...r, smoothedActivity: r.cls.activity, smoothedConfidence: r.cls.confidence }));
  }
  // ---- pass 2: route with the (possibly smoothed) activity ----
  const minutes = [];
  for (const r of labelless) {
    const activity = r.smoothedActivity;
    const estimate = routeEstimate({
      features: r.features, quality: r.quality, physiology,
      activity, activityConfidence: r.smoothedConfidence, context: r.context,
    });
    if (!estimate) { stats.skipped += 1; continue; }
    const restingKcal = activity === ACTIVITY.SLEEP ? physiology.sleepKcalPerMin : physiology.restingKcalPerMin;
    const activeKcal = Math.max(0, estimate.totalKcalPerMin - restingKcal);
    const iso = new Date(r.features.minuteMs).toISOString();
    minutes.push({
      minute_at: iso,
      day: localDateKey(iso, tz),
      timezone_name: tz,
      met: round(estimate.met, 3),
      resting_kcal: round(restingKcal, 4),
      active_kcal: round(activeKcal, 4),
      activity_type: activity,
      activity_confidence: round(r.smoothedConfidence, 3),
      model_confidence: round(estimate.modelConfidence, 3),
      hr: r.features.hr,
      hr_source: r.features.hrCount > 0 ? 'measured' : 'absent',
      motion_intensity: r.features.motion,
      signal_quality: r.quality.overall,
      quality_flags: r.quality.flags,
      workout_session_id: r.workout?.id ?? null,
      algorithm_version: ALGORITHM_VERSION,
      feature_version: FEATURE_VERSION,
      model_version: MODEL_VERSION,
      calibration_version: physiology.calibration.version,
      estimator: estimate.estimator,
      debug: { vo2: round(estimate.vo2, 2), smoothed: activity !== r.cls.activity, rawActivity: r.cls.activity },
    });
    stats.byActivity[activity] = (stats.byActivity[activity] || 0) + 1;
  }
  return { minutes, stats };
}

function round(n, places) { if (n == null || !Number.isFinite(n)) return null; const f = 10 ** places; return Math.round(n * f) / f; }
