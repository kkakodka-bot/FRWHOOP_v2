/**
 * Subject physiology: the per-user constants the energy model needs before it
 * ever looks at a sensor sample.
 *
 * Everything here is derived from the profile FRWHOOP already collects
 * (`store.profile` / `store.prefs`) plus the existing HRmax resolver in
 * `vo2/hrMax.js`. No new user-facing fields are introduced.
 */

import { resolveHrMax } from '../vo2/hrMax.js';
import { uthVo2Max } from '../vo2/uth.js';
import {
  CALIBRATION,
  KCAL_PER_LITRE_O2,
  LIMITS,
  MINUTES_PER_DAY,
  SLEEP_METABOLIC_FRACTION,
  STANDARD_MET_VO2,
  clamp,
  num,
} from './constants.js';

const CURRENT_YEAR = new Date().getUTCFullYear();

function inRange(v, lo, hi) {
  return v != null && v >= lo && v <= hi;
}

/**
 * Mifflin–St Jeor resting metabolic rate, kcal/day.
 *
 * The sex constant is +5 for male and −161 for female. `nonbinary` and unknown
 * take the midpoint (−78): a deliberate modelling choice, flagged in the returned
 * `restingSource` so downstream confidence can account for it rather than
 * pretending the estimate is as good as a sexed one.
 */
export function mifflinStJeor({ weightKg, heightCm, age, sex }) {
  const w = num(weightKg);
  const h = num(heightCm);
  const a = num(age);
  if (w == null || h == null || a == null) return null;
  const sexConstant = sex === 'male' ? 5 : sex === 'female' ? -161 : -78;
  return 10 * w + 6.25 * h - 5 * a + sexConstant;
}

/**
 * Katch–McArdle resting metabolic rate, kcal/day. Preferred when body
 * composition is known because it drops the sex term entirely — lean mass is
 * what actually respires.
 */
export function katchMcArdle({ leanMassKg }) {
  const lbm = num(leanMassKg);
  if (lbm == null || lbm < 15 || lbm > 150) return null;
  return 370 + 21.6 * lbm;
}

/**
 * Resolve every physiological constant the model needs.
 *
 * @param {object} input
 * @param {object} input.profile  store.profile shape
 * @param {object} input.prefs    store.prefs shape (carries restingHr)
 * @param {Array}  input.days     history for observed-HRmax resolution
 * @param {object} input.calibration active energy_user_calibration row, if any
 */
export function resolvePhysiology({ profile = {}, prefs = {}, days = [], calibration = null } = {}) {
  const notes = [];

  const birthYear = num(profile.birthYear);
  let age = birthYear != null ? CURRENT_YEAR - birthYear : num(prefs.chronoAge);
  if (!inRange(age, LIMITS.ageMin, LIMITS.ageMax)) {
    age = 35;
    notes.push('age_defaulted');
  }

  let weightKg = num(profile.weightKg);
  if (!inRange(weightKg, LIMITS.weightKgMin, LIMITS.weightKgMax)) {
    weightKg = 75;
    notes.push('weight_defaulted');
  }

  let heightCm = num(profile.heightCm);
  if (!inRange(heightCm, LIMITS.heightCmMin, LIMITS.heightCmMax)) {
    heightCm = 172;
    notes.push('height_defaulted');
  }

  const sex = ['male', 'female', 'nonbinary'].includes(profile.sex) ? profile.sex : null;
  if (!sex) notes.push('sex_unknown');

  const leanPct = num(profile.leanBodyMassPct);
  const leanMassKg = leanPct != null ? (weightKg * leanPct) / 100 : null;

  const bmi = weightKg / ((heightCm / 100) ** 2);

  let restingHr = num(prefs.restingHr) ?? num(profile.restingHr);
  if (!inRange(restingHr, LIMITS.restingHrMin, LIMITS.restingHrMax)) {
    restingHr = null;
    notes.push('resting_hr_unknown');
  }

  const hrMaxResolved = resolveHrMax({
    age,
    override: prefs.hrMaxOverride ?? profile.hrMaxOverride ?? null,
    days,
    profileHrMax: profile.hrMax ?? null,
  });
  const hrMax = inRange(num(hrMaxResolved?.value), LIMITS.hrMaxMin, LIMITS.hrMaxMax)
    ? num(hrMaxResolved.value)
    : 208 - 0.7 * age;

  // VO2max: user-entered wins, then the Uth ratio (HRmax/HRrest), then a
  // sex/age population value. Each step is recorded so confidence can decay.
  let vo2Max = num(profile.vo2Max);
  let vo2MaxSource = profile.vo2MaxSource || 'user_entered';
  if (!inRange(vo2Max, LIMITS.vo2MaxMin, LIMITS.vo2MaxMax)) {
    const uth = restingHr != null ? num(uthVo2Max(hrMax, restingHr)) : null;
    if (inRange(uth, LIMITS.vo2MaxMin, LIMITS.vo2MaxMax)) {
      vo2Max = uth;
      vo2MaxSource = 'uth_ratio';
    } else {
      vo2Max = sex === 'female' ? 38 - 0.2 * (age - 30) : 44 - 0.25 * (age - 30);
      vo2Max = clamp(vo2Max, 22, 55);
      vo2MaxSource = 'population_default';
      notes.push('vo2max_population_default');
    }
  }

  // Resting metabolic rate. Katch–McArdle when body composition is known.
  const km = katchMcArdle({ leanMassKg });
  const msj = mifflinStJeor({ weightKg, heightCm, age, sex });
  let restingKcalPerDay = km ?? msj;
  let restingSource = km ? 'katch_mcardle' : 'mifflin_st_jeor';
  if (restingKcalPerDay == null) {
    restingKcalPerDay = 24 * weightKg; // ~1 kcal/kg/h fallback
    restingSource = 'weight_fallback';
    notes.push('rmr_fallback');
  }

  const cal = applyCalibration(calibration);
  if (cal.rmrScale !== 1) restingSource += '+calibrated';
  restingKcalPerDay *= cal.rmrScale;

  const restingKcalPerMin = restingKcalPerDay / MINUTES_PER_DAY;

  /**
   * Measured-RMR-anchored 1-MET oxygen cost, mL O2/kg/min.
   *
   * The 3.5 mL/kg/min convention systematically overstates resting VO2 for heavy
   * or older subjects (Byrne 2005), which inflates every MET-derived kcal. We
   * anchor MET to this subject's own predicted RMR instead, and keep the
   * convention only as a sanity clamp.
   */
  const restingVo2 = clamp(
    (restingKcalPerMin / KCAL_PER_LITRE_O2) * 1000 / weightKg,
    2.0,
    4.5,
  );

  const vo2Reserve = Math.max(vo2Max - restingVo2, 5);

  /**
   * Flex heart rate (Spurr et al. 1988).
   *
   * The %HRR → %VO2 reserve relationship is only linear in the exercise range
   * (validated roughly 40-90% of reserve). Below the flex point, HR moves with
   * posture, caffeine, stress and thermal load while VO2 barely changes, so
   * treating a 10 bpm rise above resting as a doubling of metabolic rate
   * manufactures hundreds of phantom kcal per day. Below this threshold the HR
   * channel is mapped onto a narrow band just above resting instead; above it,
   * the reserve relation applies.
   *
   * The method defines the flex point as the midpoint between the highest resting
   * and lowest activity heart rate — for adults, on the order of 25-30 bpm above
   * a sleeping rate. It has to sit above the whole awake-and-seated band: with a
   * resting HR of 48, sitting at a desk is commonly 65-75 bpm, and if the flex
   * point falls inside that band, ordinary desk minutes get priced on the
   * exercise line. That line is steep — around 0.11 MET per bpm — so a few bpm of
   * ordinary drift becomes half a MET, sustained across the whole waking day.
   */
  const flexHr = restingHr != null
    ? restingHr + Math.max(20, 0.20 * (hrMax - restingHr))
    : null;

  return {
    age,
    sex,
    weightKg,
    heightCm,
    bmi: Math.round(bmi * 10) / 10,
    leanMassKg,
    restingHr,
    hrMax: Math.round(hrMax * 10) / 10,
    hrMaxSource: hrMaxResolved?.source || 'tanaka_age',
    hrReserve: restingHr != null ? Math.max(hrMax - restingHr, 20) : null,
    flexHr: flexHr == null ? null : Math.round(flexHr * 10) / 10,
    vo2Max: Math.round(vo2Max * 10) / 10,
    vo2MaxSource,
    restingVo2: Math.round(restingVo2 * 100) / 100,
    vo2Reserve,
    restingKcalPerDay: Math.round(restingKcalPerDay * 10) / 10,
    restingKcalPerMin,
    sleepKcalPerMin: restingKcalPerMin * SLEEP_METABOLIC_FRACTION,
    restingSource,
    calibration: cal,
    notes,
  };
}

/**
 * kcal/min from oxygen uptake.
 *
 * VO2 (mL/kg/min) is the model's internal currency. Because `restingVo2` was
 * itself derived from the subject's RMR, feeding restingVo2 back through this
 * function reproduces `restingKcalPerMin` exactly — which is what makes
 * `total = resting + active` hold without a fudge term.
 */
export function vo2ToKcalPerMin(vo2, physiology) {
  const v = num(vo2);
  if (v == null || !physiology?.weightKg) return null;
  return (v * physiology.weightKg / 1000) * KCAL_PER_LITRE_O2;
}

/** Conventional (Compendium) MET, i.e. VO2 relative to 3.5 mL/kg/min. */
export function vo2ToMet(vo2) {
  const v = num(vo2);
  return v == null ? null : v / STANDARD_MET_VO2;
}

export function metToVo2(met) {
  const m = num(met);
  return m == null ? null : m * STANDARD_MET_VO2;
}

/** Fractional heart-rate reserve. Null when resting HR is unknown. */
export function hrReserveFraction(hr, physiology) {
  const h = num(hr);
  if (h == null || !physiology?.restingHr || !physiology?.hrReserve) return null;
  return clamp((h - physiology.restingHr) / physiology.hrReserve, -0.2, 1.3);
}

/**
 * Where this heart rate sits relative to the flex point, as a fraction of the
 * flex-to-max span. Negative below flex, 0 at flex, 1 at HRmax.
 *
 * This — not raw HR reserve — is the right axis for deciding whether someone is
 * exercising. Plain HR reserve treats the resting range as if it were the bottom
 * of the exercise range, so a 12 bpm rise from sitting up reads as 9% of maximal
 * effort and drags the minute into an activity class with an inflated MET floor.
 */
export function hrEffortFraction(hr, physiology) {
  const h = num(hr);
  if (h == null || physiology?.flexHr == null) return null;
  const span = Math.max(physiology.hrMax - physiology.flexHr, 20);
  return clamp((h - physiology.flexHr) / span, -1, 1.2);
}

/**
 * Resolve calibration parameters into safe multipliers.
 *
 * Personalization strength ramps with training days and never exceeds
 * CALIBRATION.maxBlend, so a fortnight of noisy data cannot swing estimates.
 */
export function applyCalibration(calibration) {
  const identity = {
    rmrScale: 1,
    hrEfficiency: 1,
    strengthCorrection: 1,
    walkingEconomy: 1,
    runningEconomy: 1,
    blend: 0,
    version: null,
    confidence: null,
    trainingDays: 0,
  };
  if (!calibration || calibration.active === false) return identity;

  const days = num(calibration.training_days ?? calibration.trainingDays) ?? 0;
  if (days < CALIBRATION.minTrainingDays) return { ...identity, trainingDays: days };

  const confidence = clamp(num(calibration.confidence) ?? 0.5, 0, 1);
  const ramp = clamp(
    (days - CALIBRATION.minTrainingDays)
      / Math.max(CALIBRATION.fullStrengthDays - CALIBRATION.minTrainingDays, 1),
    0,
    1,
  );
  const blend = clamp(ramp * confidence * CALIBRATION.maxBlend, 0, CALIBRATION.maxBlend);

  const params = calibration.params || {};
  const out = { ...identity, blend, version: calibration.version ?? null, confidence, trainingDays: days };
  for (const [key, [lo, hi]] of Object.entries(CALIBRATION.bounds)) {
    const raw = num(params[key]);
    if (raw == null) continue;
    out[key] = 1 + (clamp(raw, lo, hi) - 1) * blend;
  }
  return out;
}
