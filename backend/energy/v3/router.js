/**
 * Activity-aware V3 routing.
 *
 * Classifier scores are heuristic, not a calibrated probability. Abstention
 * uses deterministic evidence: workout sport labels, HR relative to flex/HRR,
 * HR quality, and IMU coverage. No fixed BPM gates (95/110) and no
 * activity_confidence cutoff.
 */

import { ACTIVITY } from '../constants.js';
import { hrEffortFraction } from '../physiology.js';
import { WEAR_BICEP } from './placement.js';

export const FAMILY = Object.freeze({
  IMU_SEDENTARY: 'imu_sedentary',
  HR_IMU_LOCO: 'hr_imu_locomotion',
  HR_CYCLING: 'hr_cycling',
  V1_STRENGTH: 'v1_strength',
  V1_SLEEP: 'v1_sleep',
  V1_BICEP: 'v1_bicep',
  V1_OOD: 'v1_ood',
  V1_WEAK: 'v1_weak_confidence',
  V1_MISSING: 'v1_missing_inputs',
});

export const FEATURE_GROUP = Object.freeze({
  ACCEL_20HZ: 'accel_20hz',
  HR: 'hr',
  GYRO: 'gyro',
});

const EXPLICIT_SPORT = 'workout_sport_label';

function hrQualityOk(quality) {
  if (quality == null || quality.hr == null) return true;
  return quality.hr >= 0.5;
}

/** Personalized: at or above flex HR, with usable HR quality. */
export function exercisingHr(hr, physiology, quality) {
  if (hr == null || physiology?.flexHr == null) return false;
  if (!hrQualityOk(quality)) return false;
  const effort = hrEffortFraction(hr, physiology);
  return effort != null && effort >= 0;
}

function quietWrist(imu) {
  return (imu?.dyn_enmo_mean ?? imu?.enmo_mean ?? 0) < 0.08;
}

function explicitSport(reason) {
  return reason === EXPLICIT_SPORT;
}

function highConfRunning(activity, reason) {
  if (activity !== ACTIVITY.RUNNING) return false;
  return explicitSport(reason)
    || reason === 'high_motion_high_hr'
    || reason === 'workout_signature:high_motion_high_hr';
}

export function routeV3Minute({
  activity,
  confidence,
  reason,
  placement,
  imu,
  domain,
  hr,
  physiology,
  quality,
} = {}) {
  if (placement === WEAR_BICEP) {
    return fail(FAMILY.V1_BICEP, 'bicep_unvalidated', 'bicep_unvalidated');
  }
  if (activity === ACTIVITY.STRENGTH) {
    return fail(FAMILY.V1_STRENGTH, 'ood_strength', 'ood_strength');
  }
  if (activity === ACTIVITY.SLEEP) {
    return fail(FAMILY.V1_SLEEP, 'sleep', 'ood_sleep');
  }
  if (!imu || (imu.coverage != null && imu.coverage < 0.25)) {
    return fail(FAMILY.V1_MISSING, 'missing_imu', 'missing_imu');
  }
  if (domain && domain.in_support === false) {
    return fail(FAMILY.V1_OOD, 'ood_or_insufficient_domain', 'ood_or_insufficient_domain');
  }

  if (activity === ACTIVITY.CYCLING && explicitSport(reason)) {
    if (!exercisingHr(hr, physiology, quality)) {
      return fail(FAMILY.V1_MISSING, 'cycling_insufficient_hr', 'cycling_insufficient_hr');
    }
    return ok(FAMILY.HR_CYCLING, 'explicit_cycling_workout', [FEATURE_GROUP.HR, FEATURE_GROUP.ACCEL_20HZ]);
  }

  if (highConfRunning(activity, reason)) {
    if (!exercisingHr(hr, physiology, quality)) {
      return fail(FAMILY.V1_MISSING, 'running_insufficient_hr', 'running_insufficient_hr');
    }
    return ok(FAMILY.HR_IMU_LOCO, 'locomotion_running_hr_imu', [FEATURE_GROUP.HR, FEATURE_GROUP.ACCEL_20HZ]);
  }

  if (activity === ACTIVITY.WALKING) {
    return fail(FAMILY.V1_MISSING, 'walking_unvalidated_model', 'walking_unvalidated_model');
  }

  if (activity === ACTIVITY.SEDENTARY || activity === ACTIVITY.STANDING) {
    if (quietWrist(imu) && exercisingHr(hr, physiology, quality)) {
      return fail(FAMILY.V1_MISSING, 'quiet_wrist_elevated_hr_unrouted', 'quiet_wrist_elevated_hr_unrouted');
    }
    return ok(FAMILY.IMU_SEDENTARY, 'validated_sedentary_standing', [FEATURE_GROUP.ACCEL_20HZ]);
  }

  return fail(FAMILY.V1_MISSING, 'unvalidated_activity_family', 'unvalidated_activity_family');
}

function fail(family, routerReason, fallback) {
  return {
    family,
    activity_model: family,
    router_reason: routerReason,
    fallback_reason: fallback,
    input_feature_groups: [],
    use_learned: false,
    classifier_score_heuristic: true,
  };
}

function ok(family, routerReason, groups) {
  return {
    family,
    activity_model: family,
    router_reason: routerReason,
    fallback_reason: null,
    input_feature_groups: groups,
    use_learned: true,
    classifier_score_heuristic: true,
  };
}
