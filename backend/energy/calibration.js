/**
 * Per-user calibration fitting.
 *
 * Produces a *new* calibration row; it never edits an existing one and never
 * touches the global model. Activation is a separate decision (status flips from
 * 'shadow' to 'active'), so a fit can be inspected before it affects any number
 * the user sees, and reverting is re-activating the previous version.
 *
 * The fit is ratio-based rather than gradient-based on purpose: with a handful of
 * daily reference totals there is not enough signal to justify anything more,
 * and medians are robust to the one bad day that a least-squares fit would chase.
 */

import { CALIBRATION, clamp, num } from './constants.js';

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Median absolute deviation, normalized by the median. Robust spread in [0,inf). */
function relativeMad(values) {
  const m = median(values);
  if (m == null || m === 0) return 1;
  const mad = median(values.map((v) => Math.abs(v - m)));
  return mad == null ? 1 : mad / Math.abs(m);
}

/**
 * @param {object} input
 * @param {Array} input.minutes         engine output (needs day, activity_type, resting_kcal, active_kcal, workout_session_id)
 * @param {Array} input.dayReferences   [{ day, total_kcal }] external benchmark or measured
 * @param {Array} input.workoutReferences [{ session_id, total_kcal }]
 * @param {number} input.previousVersion
 * @returns {null|object} an energy_user_calibration row, status 'shadow'
 */
export function fitCalibration({
  minutes = [],
  dayReferences = [],
  workoutReferences = [],
  previousVersion = 0,
  globalModelVersion = null,
  userId = null,
} = {}) {
  if (!minutes.length || !dayReferences.length) return null;

  const byDay = new Map();
  for (const m of minutes) {
    if (!byDay.has(m.day)) byDay.set(m.day, { resting: 0, active: 0, minutes: 0 });
    const d = byDay.get(m.day);
    d.resting += m.resting_kcal;
    d.active += m.active_kcal;
    d.minutes += 1;
  }

  // Only days with near-complete coverage can be compared to a daily reference;
  // a half-covered day would look like a systematic underestimate.
  const usable = [];
  for (const ref of dayReferences) {
    const actual = num(ref.total_kcal);
    const pred = byDay.get(ref.day);
    if (actual == null || !pred || pred.minutes < 1200) continue;
    usable.push({ ...pred, actual });
  }
  if (usable.length < CALIBRATION.minTrainingDays) {
    return {
      user_id: userId,
      version: previousVersion + 1,
      status: 'shadow',
      global_model_version: globalModelVersion,
      params: {},
      calibration_confidence: 0,
      training_days: usable.length,
      notes: `insufficient reference days (${usable.length} of ${CALIBRATION.minTrainingDays})`,
    };
  }

  // Resting scale comes from the quietest days, where active energy is a small
  // enough share that any residual is attributable to resting metabolism.
  const quiet = usable.filter((d) => d.active / (d.resting + d.active) < 0.15);
  const rmrRatios = (quiet.length >= 3 ? quiet : usable)
    .map((d) => d.actual / (d.resting + d.active));
  const rmrScale = median(rmrRatios) ?? 1;

  // With resting pinned, the remaining error on active days is HR-response error.
  const active = usable.filter((d) => d.active > 50);
  const hrRatios = active.map((d) => (d.actual - rmrScale * d.resting) / d.active);
  const hrEfficiency = median(hrRatios) ?? 1;

  const params = {
    rmrScale: bound('rmrScale', rmrScale),
    hrEfficiency: bound('hrEfficiency', hrEfficiency),
    ...fitPerActivity(minutes, workoutReferences),
  };

  // Confidence: evidence volume x agreement between days. A wide spread of
  // per-day ratios means the model is wrong in a way a single scalar will not fix,
  // so the calibration should not be trusted to fix it either.
  const volume = clamp(usable.length / CALIBRATION.fullStrengthDays, 0, 1);
  const agreement = clamp(1 - relativeMad(rmrRatios), 0, 1);
  const confidence = Math.round(clamp(volume * agreement, 0, 1) * 1000) / 1000;

  return {
    user_id: userId,
    version: previousVersion + 1,
    status: 'shadow',
    global_model_version: globalModelVersion,
    params,
    calibration_confidence: confidence,
    training_days: usable.length,
    notes: `fit on ${usable.length} reference days, ${active.length} active`,
  };
}

/**
 * Per-activity economy from workout-level references.
 *
 * Requires at least three workouts of a kind before emitting a parameter for it,
 * because a single mislabelled session would otherwise become a permanent bias.
 */
function fitPerActivity(minutes, workoutReferences) {
  if (!workoutReferences?.length) return {};
  const refs = new Map(workoutReferences.map((r) => [r.session_id, num(r.total_kcal)]));
  const bySession = new Map();
  for (const m of minutes) {
    if (!m.workout_session_id || !refs.has(m.workout_session_id)) continue;
    if (!bySession.has(m.workout_session_id)) {
      bySession.set(m.workout_session_id, { resting: 0, active: 0, activities: new Map() });
    }
    const s = bySession.get(m.workout_session_id);
    s.resting += m.resting_kcal;
    s.active += m.active_kcal;
    s.activities.set(m.activity_type, (s.activities.get(m.activity_type) || 0) + 1);
  }

  const ratiosByActivity = new Map();
  for (const [sessionId, s] of bySession) {
    if (s.active <= 5) continue;
    let dominant = null;
    let best = 0;
    for (const [k, v] of s.activities) if (v > best) { dominant = k; best = v; }
    const ratio = (refs.get(sessionId) - s.resting) / s.active;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    if (!ratiosByActivity.has(dominant)) ratiosByActivity.set(dominant, []);
    ratiosByActivity.get(dominant).push(ratio);
  }

  const map = { walking: 'walkingEconomy', running: 'runningEconomy', strength: 'strengthCorrection' };
  const out = {};
  for (const [activity, key] of Object.entries(map)) {
    const ratios = ratiosByActivity.get(activity);
    if (!ratios || ratios.length < 3) continue;
    out[key] = bound(key, median(ratios));
  }
  return out;
}

function bound(key, value) {
  const [lo, hi] = CALIBRATION.bounds[key];
  const v = num(value);
  return v == null ? 1 : Math.round(clamp(v, lo, hi) * 1000) / 1000;
}
