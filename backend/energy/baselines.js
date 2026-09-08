/**
 * Evaluation baselines.
 *
 * These exist so the candidate model has to beat something. They are never used
 * for production output; they are registered in `energy_model_versions` with
 * kind='baseline' purely so an evaluation run can be attributed.
 *
 * Baseline 1  demographic RMR x activity multiplier
 * Baseline 2  Keytel et al. 2005, the standard HR-based kcal equation
 * Baseline 3  fixed MET by sport at a hardcoded 70 kg — the whoordan-class
 *             formula, and byte-for-byte the legacy `estimateCalories()` this
 *             work replaces
 */

import { MOTION_THRESHOLDS, num } from './constants.js';

/**
 * Baseline 1: RMR x activity multiplier.
 *
 * Multiplier picked from wrist motion because that is the only activity signal a
 * demographic model can be given without becoming a different model.
 */
export function baselineBmrMultiplier(features, physiology) {
  const motion = features.motion;
  const m = MOTION_THRESHOLDS;
  let multiplier = 1.2;
  if (motion == null) multiplier = 1.3;
  else if (motion < m.still) multiplier = 1.0;
  else if (motion < m.fidget) multiplier = 1.3;
  else if (motion < m.ambulatory) multiplier = 1.8;
  else if (motion < m.vigorous) multiplier = 3.2;
  else multiplier = 6.5;
  if (features.sleepStage) multiplier = 0.95;

  const total = physiology.restingKcalPerMin * multiplier;
  return {
    total_kcal: total,
    resting_kcal: physiology.restingKcalPerMin,
    active_kcal: Math.max(0, total - physiology.restingKcalPerMin),
  };
}

/**
 * Baseline 2: Keytel et al. 2005, J Sports Sci 23(3):289-97.
 *
 * kJ/min from HR, mass, age and sex; divided by 4.184 for kcal. Fitted on
 * treadmill exercise, so it is expected to be poor at rest — it can and does go
 * negative there, which is floored at the resting rate rather than at zero
 * because a live subject does not stop metabolising.
 */
export function baselineKeytel(features, physiology) {
  const hr = num(features.hr);
  if (hr == null) return null;
  const { weightKg, age, sex } = physiology;
  const kj = sex === 'female'
    ? -20.4022 + 0.4472 * hr - 0.1263 * weightKg + 0.074 * age
    : -55.0969 + 0.6309 * hr + 0.1988 * weightKg + 0.2017 * age;
  const total = Math.max(kj / 4.184, physiology.restingKcalPerMin);
  return {
    total_kcal: total,
    resting_kcal: physiology.restingKcalPerMin,
    active_kcal: Math.max(0, total - physiology.restingKcalPerMin),
  };
}

/**
 * Baseline 3: the legacy in-repo formula, preserved exactly.
 *
 * Fixed MET by sport keyword, standard 3.5 mL/kg/min, and a hardcoded 70 kg that
 * ignores the user's own stored weight. Auto-detected workouts always arrive
 * labelled 'other', so in practice almost everything lands on MET 5.
 */
export function legacyFixedMet(durationMin, name = '') {
  const sport = String(name).toLowerCase();
  const met = /run|hiit/.test(sport) ? 9.8
    : /swim/.test(sport) ? 8
      : /cycl/.test(sport) ? 7.5
        : /box/.test(sport) ? 7.8
          : /walk/.test(sport) ? 3.5
            : /yoga/.test(sport) ? 3
              : 5;
  return Math.round(met * 3.5 * 70 / 200 * Math.max(0, Number(durationMin) || 0));
}

/** Per-minute form of baseline 3, for like-for-like comparison. */
export function baselineFixedMet(features, physiology, context = {}) {
  const perMin = legacyFixedMet(1, context.workout?.sport || (context.workout ? 'other' : ''));
  // Outside a workout the legacy formula produces nothing at all, which is the
  // honest representation of it: it has no concept of non-workout energy.
  const total = context.workout ? perMin : 0;
  return {
    total_kcal: total,
    resting_kcal: 0,
    active_kcal: total,
  };
}

export const BASELINES = Object.freeze({
  'baseline-bmr-multiplier-v1': baselineBmrMultiplier,
  'baseline-keytel-v1': baselineKeytel,
  'baseline-fixed-met-v1': baselineFixedMet,
});
