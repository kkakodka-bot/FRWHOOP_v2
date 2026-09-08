/**
 * Energy-expenditure constants and vocabulary.
 *
 * Every magic number that has a citation lives here so the model files read as
 * physiology rather than arithmetic. Citations are in docs/ENERGY_MODEL.md.
 *
 * Sensor-level facts (plausibility gates, expected cadence, staleness) are NOT
 * defined here — they belong to the sensor, not to this model, and every engine
 * has to agree on them. They live in `signal/constants.js` and are re-exported
 * below so energy call sites are unchanged.
 */

export {
  CONFIDENCE,
  EXPECTED_SAMPLES_PER_MINUTE,
  HR_STALENESS,
  LIMITS,
  clamp,
  interpolateAnchors,
  num,
} from '../signal/constants.js';

import { clamp } from '../signal/constants.js';

export const ALGORITHM_VERSION = '1.0.0';
export const FEATURE_VERSION = 'feat-1.0.0';
export const MODEL_VERSION = 'energy-v1.0.0';

/**
 * Energy equivalent of oxygen, kcal per litre O2. 5.0 is the conventional value
 * used by the MET definition; true value is RER-dependent (4.69 at RER 0.70,
 * 5.05 at RER 1.00). We do not know substrate use, so the convention is used and
 * the resulting ~2% uncertainty is folded into model confidence.
 */
export const KCAL_PER_LITRE_O2 = 5.0;

/** Standard 1-MET oxygen uptake, mL O2 / kg / min (Ainsworth Compendium). */
export const STANDARD_MET_VO2 = 3.5;

/** Minutes in a full day, used as the coverage denominator. */
export const MINUTES_PER_DAY = 1440;

/**
 * Sleeping metabolic rate as a fraction of resting metabolic rate. Overnight
 * energy expenditure runs slightly below measured resting values.
 */
export const SLEEP_METABOLIC_FRACTION = 0.95;

/** Canonical activity classes. Must match the energy_minutes CHECK constraint. */
export const ACTIVITY = Object.freeze({
  SLEEP: 'sleep',
  SEDENTARY: 'sedentary',
  STANDING: 'standing',
  WALKING: 'walking',
  RUNNING: 'running',
  CYCLING: 'cycling',
  STRENGTH: 'strength',
  WORKOUT_OTHER: 'workout_other',
  DAILY_ACTIVITY: 'daily_activity',
  UNKNOWN: 'unknown',
});

export const ACTIVITY_CLASSES = Object.freeze(Object.values(ACTIVITY));

/**
 * Per-activity MET envelope and channel reliability priors.
 *
 * `hrWeight` / `motionWeight` encode how much each sensing channel is trusted
 * for that activity *before* looking at signal quality:
 *
 *  - cycling: wrist barely moves while VO2 is high, so motion is near-useless
 *    and HR carries the estimate.
 *  - strength: the pressor response inflates HR relative to VO2, and optical HR
 *    degrades under grip/forearm load, so HR is down-weighted and capped.
 *  - walking/running: both channels are informative.
 *  - sleep/sedentary: the answer is bounded tightly regardless of channel.
 */
export const ACTIVITY_MODEL = Object.freeze({
  [ACTIVITY.SLEEP]: {
    metMin: 0.85, metMax: 1.3, hrWeight: 0.5, motionWeight: 0.5, estimator: 'sleep',
  },
  [ACTIVITY.SEDENTARY]: {
    metMin: 1.0, metMax: 1.8, hrWeight: 0.6, motionWeight: 0.4, estimator: 'sedentary',
  },
  [ACTIVITY.STANDING]: {
    metMin: 1.1, metMax: 2.5, hrWeight: 0.6, motionWeight: 0.4, estimator: 'sedentary',
  },
  [ACTIVITY.WALKING]: {
    metMin: 2.0, metMax: 7.0, hrWeight: 0.6, motionWeight: 0.4, estimator: 'walking',
  },
  [ACTIVITY.RUNNING]: {
    metMin: 5.0, metMax: 20.0, hrWeight: 0.75, motionWeight: 0.25, estimator: 'running',
  },
  [ACTIVITY.CYCLING]: {
    metMin: 3.0, metMax: 16.0, hrWeight: 0.95, motionWeight: 0.05, estimator: 'cycling',
  },
  [ACTIVITY.STRENGTH]: {
    // Ceiling is the Compendium's own range for resistance work: 3.5 for light
    // effort, 6.0 for vigorous, ~8 for circuit training. Left wider than 6 for
    // circuits, but not open-ended: the HR channel alone will happily claim 10+
    // METs from the pressor response, which no resistance protocol actually costs.
    // The floor is a long inter-set rest: sitting on a bench between working
    // sets is ~1.5 MET, and a 2.0 floor prices every such minute as light work.
    metMin: 1.5, metMax: 7.0, hrWeight: 0.45, motionWeight: 0.55, estimator: 'strength',
  },
  [ACTIVITY.WORKOUT_OTHER]: {
    metMin: 2.0, metMax: 16.0, hrWeight: 0.75, motionWeight: 0.25, estimator: 'general',
  },
  [ACTIVITY.DAILY_ACTIVITY]: {
    // Floor is 1.0x resting, not 1.2x: this class absorbs every ambiguous
    // minute, so a floor above resting would add a fixed tax to most of the day.
    metMin: 1.0, metMax: 8.0, hrWeight: 0.6, motionWeight: 0.4, estimator: 'general',
  },
  [ACTIVITY.UNKNOWN]: {
    metMin: 1.0, metMax: 10.0, hrWeight: 0.7, motionWeight: 0.3, estimator: 'general',
  },
});

/**
 * Motion intensity (g-equivalent scalar) → MET anchors per activity, from the
 * Ainsworth Compendium of Physical Activities. The scalar is the wrist motion
 * intensity FRWHOOP already computes; these are piecewise-linear anchors, not a
 * fitted regression, because we receive a scalar rather than raw tri-axial data.
 */
export const MOTION_MET_ANCHORS = Object.freeze({
  [ACTIVITY.WALKING]: [[0.05, 2.0], [0.15, 2.8], [0.25, 3.5], [0.40, 4.3], [0.60, 5.0], [1.00, 6.3]],
  [ACTIVITY.RUNNING]: [[0.30, 6.0], [0.60, 8.3], [0.90, 9.8], [1.30, 11.5], [2.00, 14.5]],
  // Anchored on the Compendium's own resistance-training values: 3.5 MET for
  // "multiple exercises, 8-15 reps", 5.0 for slow/explosive squats, 6.0 for
  // vigorous effort. A logged session is mostly inter-set rest, so its *median*
  // minute must sit below the vigorous anchor, not above it.
  [ACTIVITY.STRENGTH]: [[0.02, 1.8], [0.10, 2.8], [0.25, 3.8], [0.50, 5.0], [1.00, 6.0]],
  [ACTIVITY.CYCLING]: [[0.02, 6.0], [0.20, 7.5], [0.60, 10.0]],
  [ACTIVITY.DAILY_ACTIVITY]: [[0.01, 1.3], [0.05, 1.8], [0.15, 2.5], [0.30, 3.3], [0.60, 4.5], [1.00, 5.5]],
  [ACTIVITY.WORKOUT_OTHER]: [[0.02, 3.0], [0.15, 4.5], [0.40, 6.0], [0.80, 8.0], [1.50, 11.0]],
  [ACTIVITY.SEDENTARY]: [[0.0, 1.0], [0.03, 1.3], [0.08, 1.6]],
  [ACTIVITY.STANDING]: [[0.0, 1.3], [0.05, 1.8], [0.12, 2.3]],
  [ACTIVITY.SLEEP]: [[0.0, 0.95], [0.05, 1.1]],
});

/** Motion-intensity thresholds used by the activity classifier. */
export const MOTION_THRESHOLDS = Object.freeze({
  still: 0.02,
  fidget: 0.06,
  ambulatory: 0.15,
  vigorous: 0.55,
});

/** Calibration gating: personalization strength ramps in with evidence. */
export const CALIBRATION = Object.freeze({
  minTrainingDays: 14,
  fullStrengthDays: 45,
  maxBlend: 0.5,
  bounds: {
    rmrScale: [0.85, 1.15],
    hrEfficiency: [0.85, 1.15],
    strengthCorrection: [0.75, 1.25],
    walkingEconomy: [0.85, 1.15],
    runningEconomy: [0.85, 1.15],
  },
});
