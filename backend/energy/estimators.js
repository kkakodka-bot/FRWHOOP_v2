/**
 * Activity-gated energy estimation.
 *
 * The model's internal currency is VO2 in mL/kg/min, never kcal and never MET.
 * Two independent channels each produce a VO2 estimate; the router fuses them
 * with weights that are the product of (a) how informative that channel is for
 * the classified activity and (b) how good this minute's signal actually was.
 *
 * Channel 1 - cardiovascular. Fractional heart-rate reserve is used as a proxy
 * for fractional VO2 reserve (Swain & Leutholtz 1997), then mapped onto this
 * subject's own VO2 span. This is the only channel that works for cycling,
 * rowing and anything else where the wrist is quiet but the legs are not.
 *
 * Channel 2 - motion. Wrist motion intensity mapped through per-activity
 * Compendium MET anchors. This is the only channel that works when optical HR is
 * corrupted, which is exactly what happens under grip load.
 *
 * Neither channel is allowed to invent data: if both are unusable the minute
 * produces no estimate at all rather than a resting-shaped guess.
 */

import {
  ACTIVITY,
  ACTIVITY_MODEL,
  MOTION_MET_ANCHORS,
  MOTION_THRESHOLDS,
  SLEEP_METABOLIC_FRACTION,
  STANDARD_MET_VO2,
  clamp,
  interpolateAnchors,
} from './constants.js';
import { hrReserveFraction, vo2ToKcalPerMin, vo2ToMet } from './physiology.js';

/** VO2 at the flex point: light activity, 1.25x this subject's resting rate. */
const FLEX_VO2_MULTIPLE = 1.25;

/**
 * Cardiovascular VO2 estimate, flex-HR piecewise (Spurr et al. 1988).
 *
 * Below the flex heart rate, HR is mapped onto a narrow band between 1.0x and
 * 1.25x resting VO2. This is the single most important correction in the model:
 * applying the reserve relation across the resting range instead turns everyday
 * HR drift into hundreds of phantom active kcal per day, which is the failure
 * mode of every naive HR-based calorie formula.
 *
 * Above the flex point, fractional HR reserve proxies fractional VO2 reserve
 * (Swain & Leutholtz 1997), anchored at the flex VO2 so the two branches meet
 * continuously.
 *
 * Corrections on the exercise branch:
 *  - resistance-exercise pressor response: raised peripheral resistance and
 *    reduced stroke volume mean HR runs high for a given VO2, so the excess is
 *    scaled down rather than the absolute value.
 *  - cardiovascular drift: after ~20 min of sustained effort HR climbs several
 *    percent at constant VO2.
 */
export function estimateVo2FromHr(features, physiology, activity, context = {}) {
  const hr = features.hr;
  if (hr == null || physiology.restingHr == null || physiology.flexHr == null) {
    // Without a resting HR there is no reserve to take a fraction of, and
    // guessing one would silently invent a metabolic rate.
    return null;
  }

  const { restingVo2, restingHr, flexHr, hrMax, vo2Max } = physiology;
  const flexVo2 = restingVo2 * FLEX_VO2_MULTIPLE;

  if (hr <= flexHr) {
    const span = Math.max(flexHr - restingHr, 1);
    const t = clamp((hr - restingHr) / span, 0, 1);
    return restingVo2 + t * (flexVo2 - restingVo2);
  }

  const reserveAboveFlex = Math.max(hrMax - flexHr, 20);
  const frac = clamp((hr - flexHr) / reserveAboveFlex, 0, 1.15);
  let excess = frac * Math.max(vo2Max - flexVo2, 5);

  if (activity === ACTIVITY.STRENGTH) {
    // Resistance work decouples HR from VO2 more strongly than any other
    // activity: the pressor response raises peripheral resistance and cuts stroke
    // volume, so HR runs high on a low oxygen cost, and inter-set recovery keeps
    // it there while VO2 has already fallen. Uncorrected, the reserve relation
    // drives these minutes into the clamp at the top of the band. 0.6 puts a
    // vigorous session's median near the Compendium's 5.0 anchor rather than
    // above its 6.0 vigorous anchor.
    excess *= 0.60 * physiology.calibration.strengthCorrection;
  }

  const driftMinutes = context.sustainedEffortMinutes ?? 0;
  if (driftMinutes > 20) {
    excess *= clamp(1 - 0.004 * (driftMinutes - 20), 0.9, 1);
  }

  excess *= physiology.calibration.hrEfficiency;

  return flexVo2 + Math.max(excess, 0);
}

/**
 * Is the heart rate unambiguously in the exercise range?
 *
 * Well above the flex point, and only when the HR channel is trustworthy — a
 * corrupted HR spike must not be allowed to declare an exercise bout and then
 * silence the motion channel that would have contradicted it.
 */
function isClearlyExercising(features, physiology) {
  if (physiology.flexHr == null || features.hr == null) return false;
  const above = (features.hr - physiology.flexHr) / Math.max(physiology.hrMax - physiology.flexHr, 20);
  return above > 0.3;
}

/**
 * Is the cardiovascular system at rest, on a reading we can trust?
 *
 * At or below the flex heart rate, with a good-quality HR sample.
 */
function isCardiovascularlyAtRest(features, physiology, quality) {
  if (physiology.flexHr == null || features.hr == null) return false;
  return quality.hr >= 0.5 && features.hr <= physiology.flexHr;
}

/**
 * Ceiling on how far the fused estimate may exceed the cardiovascular channel
 * while the heart is at rest.
 *
 * Sustained whole-body work at 2 MET raises heart rate above the flex point; if
 * it has not risen, the wrist is moving but the body is not working — typing,
 * gesturing, driving, washing up. Left uncapped, the motion channel's own floor
 * for those minutes accumulates several hundred phantom kcal across a day, which
 * is the same bias the flex-HR correction removed from the HR channel.
 *
 * The 1.35x headroom is deliberate: heart rate lags movement onset by 30-60 s, so
 * a walk that genuinely just started must not be clipped. Once it is really
 * underway the heart rate clears flex and the cap stops applying.
 */
const AT_REST_MOTION_HEADROOM = 1.35;

/** HR-reserve fraction above which a quiet wrist is treated as work (hrr > 0.45). */
const CLEARLY_EXERCISING_HRR = 0.45;

/** Wrist-motion VO2 estimate, via per-activity Compendium MET anchors. */
export function estimateVo2FromMotion(features, physiology, activity) {
  if (features.motion == null) return null;
  const anchors = MOTION_MET_ANCHORS[activity] || MOTION_MET_ANCHORS[ACTIVITY.DAILY_ACTIVITY];
  const met = interpolateAnchors(anchors, features.motion);
  if (met == null) return null;

  let vo2 = met * STANDARD_MET_VO2;
  if (activity === ACTIVITY.WALKING) vo2 *= physiology.calibration.walkingEconomy;
  if (activity === ACTIVITY.RUNNING) vo2 *= physiology.calibration.runningEconomy;
  return vo2;
}

/**
 * Fuse the channels and clamp to the physiologically plausible band for the
 * classified activity.
 *
 * @returns {null|{vo2, met, channels, weights, agreement, modelConfidence, estimator}}
 */
export function routeEstimate({ features, quality, physiology, activity, activityConfidence, context = {} }) {
  const { workout = null } = context;
  const model = ACTIVITY_MODEL[activity] || ACTIVITY_MODEL[ACTIVITY.UNKNOWN];

  // Sleep is bounded so tightly by physiology that a noisy HR spike must not be
  // allowed to turn a sleeping minute into exercise.
  if (activity === ACTIVITY.SLEEP) {
    const vo2 = physiology.restingVo2 * SLEEP_METABOLIC_FRACTION;
    return finish({
      vo2, model, quality, activityConfidence, physiology,
      channels: { hr: null, motion: null }, weights: { hr: 0, motion: 0 },
      agreement: 1, estimator: 'sleep', clampBand: false,
    });
  }

  const vo2Hr = estimateVo2FromHr(features, physiology, activity, context);
  const vo2Motion = estimateVo2FromMotion(features, physiology, activity);

  let wHr = model.hrWeight * quality.hr;
  let wMotion = model.motionWeight * quality.motion;
  if (vo2Hr == null) wHr = 0;
  if (vo2Motion == null) wMotion = 0;

  // Under grip load optical HR degrades while the IMU stays clean. When the HR
  // channel is measurably bad during strength work, hand the minute to motion
  // rather than averaging in a corrupted value.
  if (activity === ACTIVITY.STRENGTH && quality.hr < 0.45 && wMotion > 0) {
    wHr *= 0.3;
  }

  // Wrist motion fails asymmetrically. High motion with low HR is informative
  // (the arm really is moving and the body really is not working hard). Low
  // motion with high HR is *not* evidence of low energy: it is the signature of
  // cycling, rowing, a stair machine, or a loaded carry, where the wrist is
  // braced while the legs do the work. Treating the quiet wrist as data there
  // halves a genuine 11 MET effort, so the channel is marked uninformative
  // instead of averaged in.
  if (features.motion != null && features.motion < MOTION_THRESHOLDS.ambulatory && isClearlyExercising(features, physiology)) {
    wMotion *= 0.15;
  }

  // Quiet wrist + only MODEST heart-rate elevation (free living): treat HR with
  // doubt. The mission calls this the caffeine/anxiety failure mode — a wrist
  // that is not moving and a heart rate that is only a little elevated is far
  // more likely stress, caffeine or posture than undetected aerobic work, and an
  // HR-first read of it prices a resting hour at ~2.5 MET. Genuine undetected
  // cycling/rowing drives HR higher (hrr >= CLEARLY_EXERCISING) and is handled
  // by the quiet-wrist high-HR branch; below that, movement should dominate
  // because small HR differences are cheaply caused by non-metabolic factors.
  // Only free living (no confirmed workout / no sport label) gets this discount:
  // inside a detected workout a quiet wrist is expected, not evidence of doubt.
  const quiet = features.motion != null && features.motion < MOTION_THRESHOLDS.fidget;
  const hrrVal = hrReserveFraction(features.hr, physiology);
  const modestHr = hrrVal != null && hrrVal < CLEARLY_EXERCISING_HRR;
  let hrChannelVo2 = vo2Hr;
  if (quiet && modestHr && !workout) {
    // Quiet wrist + only modest HR elevation (free living): cap the HR channel at
    // its flex (light-activity) VO2 so reserve-based exercise cost is NOT added to
    // a wrist that is not working. This is the caffeine/anxiety/posture failure
    // mode — an HR of 90 with a still wrist is cheap to produce non-metabolically,
    // so movement should dominate. Genuine undetected cycling/rowing (hrr >= 0.45)
    // is unaffected because that branch is handled above with full HR weight.
    if (hrChannelVo2 != null) hrChannelVo2 = Math.min(hrChannelVo2, physiology.restingVo2 * FLEX_VO2_MULTIPLE);
    wHr *= 0.35;
  }

  if (wHr <= 0 && wMotion <= 0) return null;

  let vo2 = ((hrChannelVo2 ?? 0) * wHr + (vo2Motion ?? 0) * wMotion) / (wHr + wMotion);

  // The other half of the asymmetry above: a trustworthy resting heart rate caps
  // what the wrist is allowed to claim.
  if (hrChannelVo2 != null && isCardiovascularlyAtRest(features, physiology, quality)) {
    vo2 = Math.min(vo2, hrChannelVo2 * AT_REST_MOTION_HEADROOM);
  }

  // Channel disagreement is the single most honest confidence signal we have.
  const agreement = (vo2Hr != null && vo2Motion != null)
    ? clamp(1 - Math.abs(vo2Hr - vo2Motion) / Math.max(vo2Hr, vo2Motion, 1), 0, 1)
    : 0.6;

  return finish({
    vo2, model, quality, activityConfidence, physiology,
    channels: { hr: vo2Hr, motion: vo2Motion },
    weights: { hr: wHr, motion: wMotion },
    agreement, estimator: model.estimator, clampBand: true,
  });
}

function finish({ vo2, model, quality, activityConfidence, physiology, channels, weights, agreement, estimator, clampBand }) {
  let v = vo2;
  if (clampBand) {
    // The floor is read as a multiple of *this subject's* resting VO2: "sedentary
    // is at least 1 MET" means at least their own resting rate, not the 3.5
    // mL/kg/min population convention, which overstates resting for heavy or
    // older subjects and would inflate every minute. The ceiling is read in
    // absolute Compendium units because it represents a capacity limit.
    v = clamp(v, model.metMin * physiology.restingVo2, model.metMax * STANDARD_MET_VO2);
  }
  // Never below this subject's own resting metabolism: you cannot burn less than
  // being alive costs.
  v = Math.max(v, physiology.restingVo2 * SLEEP_METABOLIC_FRACTION);

  const singleChannel = (weights.hr > 0) !== (weights.motion > 0);
  const modelConfidence = clamp(
    0.45 * quality.overall
    + 0.25 * clamp(activityConfidence, 0, 1)
    + 0.2 * agreement
    + (singleChannel ? 0.0 : 0.1),
    0.05,
    0.97,
  );

  return {
    vo2: v,
    met: vo2ToMet(v),
    totalKcalPerMin: vo2ToKcalPerMin(v, physiology),
    channels,
    weights,
    agreement,
    modelConfidence,
    estimator,
  };
}
