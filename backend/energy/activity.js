/**
 * Activity classification.
 *
 * This is a rule-based classifier, not a learned one, and that is a deliberate
 * choice given the input: FRWHOOP receives a *scalar* wrist-motion intensity from
 * the strap, not raw tri-axial accelerometer data. Window-based CNN/HMM
 * approaches (ActiNet, WristBased-EE) need the raw axes to compute the spectral
 * and orientation features they depend on, so their models cannot be fed our
 * data. The rules below reproduce the decision *structure* those models learn
 * (sleep → sedentary → ambulatory → vigorous, gated by workout context) using
 * the signal we actually have.
 *
 * FRWHOOP's existing automatic workout detector is authoritative for "is this a
 * workout"; this classifier only decides *which kind*, and only when the
 * detector has not already said.
 */

import { ACTIVITY, MOTION_THRESHOLDS, clamp } from './constants.js';
import { hrEffortFraction, hrReserveFraction } from './physiology.js';

/**
 * Sport-label patterns.
 *
 * Prefix matches, not whole-word: the labels in the wild are compounds
 * ("Weightlifting", "Powerlifting", "Running", "Trail Running"), so a trailing
 * \b silently fails on every one of them and drops the workout into the generic
 * estimator with its much wider MET ceiling.
 */
const SPORT_PATTERNS = [
  [/\b(run|jog|treadmill|sprint|trail)/i, ACTIVITY.RUNNING],
  [/\b(cycl|bike|biking|spin|peloton|ergometer)/i, ACTIVITY.CYCLING],
  [/\b(lift|weight|strength|resistance|crossfit|powerlift)/i, ACTIVITY.STRENGTH],
  [/\b(walk|hike|hiking|ruck|step)/i, ACTIVITY.WALKING],
];

/** Map a free-text sport label from the workout record onto an activity class. */
export function activityFromSport(sport) {
  if (!sport) return null;
  const s = String(sport);
  for (const [re, activity] of SPORT_PATTERNS) if (re.test(s)) return activity;
  return null;
}

/**
 * @param {object} features  from extractMinuteFeatures
 * @param {object} physiology from resolvePhysiology
 * @param {object} quality   per-channel signal quality
 * @param {object} context   { workout, localHour, previousActivity }
 * @returns {{activity: string, confidence: number, reason: string}}
 */
export function classifyActivity(features, physiology, quality, context = {}) {
  const { workout = null } = context;
  const motion = features.motion;
  const hrr = hrReserveFraction(features.hr, physiology);
  const m = MOTION_THRESHOLDS;

  // Trustworthy channels gate how confident any decision can be.
  const motionTrust = quality.motion;
  const hrTrust = quality.hr;

  // 1. Sleep. The strap's own stage label is the most reliable signal we get, but
  //    a stage label plus real movement means the label is stale, not that the
  //    user is exercising in their sleep.
  if (features.sleepStage && (motion == null || motion < m.fidget)) {
    return { activity: ACTIVITY.SLEEP, confidence: clamp(0.75 + 0.2 * motionTrust, 0, 0.95), reason: 'strap_sleep_stage' };
  }

  // 2. Inside a detected workout the sport label wins outright.
  if (workout) {
    const labelled = activityFromSport(workout.sport ?? workout.name ?? workout.activityType);
    if (labelled) {
      return { activity: labelled, confidence: 0.9, reason: 'workout_sport_label' };
    }
    const inferred = inferWorkoutKind({ motion, hrr, features, motionTrust, hrTrust });
    return { ...inferred, reason: `workout_signature:${inferred.reason}` };
  }

  // 3. Free living. Motion drives the decision; HR reserve breaks ties.
  if (motion == null) {
    // HR-only minute. We can separate rest from effort but not walking from
    // cycling, so we stay at the coarse class rather than guessing. The split is
    // on the flex point, not on HR reserve: below flex, HR variation is posture
    // and stress, and calling those minutes "daily activity" would apply that
    // class's higher MET floor to what is really sitting still.
    const effort = hrEffortFraction(features.hr, physiology);
    if (effort == null) return { activity: ACTIVITY.UNKNOWN, confidence: 0.1, reason: 'no_usable_channel' };
    if (effort <= 0) return { activity: ACTIVITY.SEDENTARY, confidence: clamp(0.4 * hrTrust + 0.2, 0, 0.7), reason: 'hr_only_below_flex' };
    if (effort > 0.3) return { activity: ACTIVITY.WORKOUT_OTHER, confidence: clamp(0.3 * hrTrust + 0.1, 0, 0.5), reason: 'hr_only_effort' };
    return { activity: ACTIVITY.DAILY_ACTIVITY, confidence: clamp(0.35 * hrTrust + 0.15, 0, 0.6), reason: 'hr_only_active' };
  }

  // A quiet wrist with a strongly elevated heart rate is an undetected effort,
  // not sedentary time: stationary cycling, rowing and machine work never move
  // the wrist enough for the workout detector to confirm. Labelling it
  // workout_other rather than daily_activity matters because the two classes
  // carry different MET ceilings, and the daily_activity ceiling would clip a
  // genuine hard session down to roughly two thirds of its real cost.
  if (motion < m.fidget && hrr != null && hrr > 0.45) {
    return {
      activity: ACTIVITY.WORKOUT_OTHER,
      confidence: clamp(0.3 + 0.25 * hrTrust, 0, 0.6),
      reason: 'undetected_effort_still_wrist',
    };
  }

  if (motion < m.still) {
    const sedentary = hrr == null || hrr < 0.15;
    return {
      activity: sedentary ? ACTIVITY.SEDENTARY : ACTIVITY.DAILY_ACTIVITY,
      confidence: clamp(0.6 + 0.3 * motionTrust, 0, 0.9),
      reason: sedentary ? 'still_low_hr' : 'still_elevated_hr',
    };
  }

  if (motion < m.fidget) {
    // A quiet wrist with a modest HR bump (hrr <= 0.45) is standing / light
    // indoor transition, not "daily activity" — the earlier branch already
    // routes genuinely elevated quiet-wrist effort (hrr > 0.45) to workout_other
    // as undetected cycling/rowing. Promoting on a small HR bump is exactly the
    // caffeine/anxiety false-exercise failure mode, so below the clearly-
    // exercising threshold we stay at STANDING (bounded ~1.3-1.8 MET) rather than
    // handing the minute daily_activity's wider ceiling.
    return {
      activity: ACTIVITY.STANDING,
      confidence: clamp(0.45 + 0.25 * motionTrust, 0, 0.75),
      reason: 'low_motion',
    };
  }

  if (motion < m.ambulatory) {
    return { activity: ACTIVITY.DAILY_ACTIVITY, confidence: clamp(0.5 + 0.2 * motionTrust, 0, 0.75), reason: 'incidental_movement' };
  }

  if (motion < m.vigorous) {
    // Sustained rhythmic arm swing at moderate intensity is walking; the same
    // mean intensity delivered in bursts is household activity.
    const sustained = (features.motionActiveFraction ?? 0) > 0.6;
    return {
      activity: sustained ? ACTIVITY.WALKING : ACTIVITY.DAILY_ACTIVITY,
      confidence: clamp(0.5 + 0.3 * motionTrust, 0, 0.85),
      reason: sustained ? 'sustained_ambulation' : 'intermittent_movement',
    };
  }

  if (hrr != null && hrr > 0.55) {
    return { activity: ACTIVITY.RUNNING, confidence: clamp(0.55 + 0.3 * Math.min(motionTrust, hrTrust), 0, 0.9), reason: 'high_motion_high_hr' };
  }
  return { activity: ACTIVITY.WALKING, confidence: clamp(0.4 + 0.25 * motionTrust, 0, 0.7), reason: 'high_motion_moderate_hr' };
}

/**
 * Decide the kind of an unlabelled workout.
 *
 * The discriminating case is cycling: the wrist is nearly stationary on the bars
 * while VO2 is high, which looks identical to sitting still unless HR is
 * consulted. Strength training is the mirror image — HR is moderate and motion
 * arrives in high-variance bursts between sets.
 */
function inferWorkoutKind({ motion, hrr, features, motionTrust, hrTrust }) {
  const m = MOTION_THRESHOLDS;
  const both = Math.min(motionTrust, hrTrust);

  if (motion != null && motion < m.fidget && hrr != null && hrr > 0.4) {
    return { activity: ACTIVITY.CYCLING, confidence: clamp(0.4 + 0.3 * both, 0, 0.7), reason: 'still_wrist_high_hr' };
  }
  if (motion != null && motion > m.vigorous && hrr != null && hrr > 0.6) {
    return { activity: ACTIVITY.RUNNING, confidence: clamp(0.5 + 0.3 * both, 0, 0.85), reason: 'high_motion_high_hr' };
  }
  // Bursty motion with a moderate cardiovascular response: resistance work.
  const bursty = (features.motionStd ?? 0) > 0.1 && (features.motionActiveFraction ?? 0) < 0.75;
  if (bursty && (hrr == null || hrr < 0.65)) {
    return { activity: ACTIVITY.STRENGTH, confidence: clamp(0.35 + 0.25 * both, 0, 0.65), reason: 'bursty_motion_moderate_hr' };
  }
  if (motion != null && motion >= m.ambulatory && motion <= m.vigorous) {
    return { activity: ACTIVITY.WALKING, confidence: clamp(0.4 + 0.2 * motionTrust, 0, 0.7), reason: 'moderate_sustained_motion' };
  }
  return { activity: ACTIVITY.WORKOUT_OTHER, confidence: 0.3, reason: 'unresolved' };
}
