/**
 * Energy V3 minute engine: activity-aware routing over 6-axis IMU + HR.
 *
 * Canonical persisted calories stay on V1 until ENERGY_MODEL_V3=on and the
 * promotion gates pass. This engine is the shadow candidate.
 *
 * Learned motion is wrist-only. Bicep, strength, sleep, OOD, missing inputs,
 * and weak classification copy the real V1 row. Gyro is optional (separate
 * model); it is never zero-filled.
 *
 * Accounting matches V1: resting = RMR/1440 (sleep 0.95x), active = max(0,
 * total-resting), workout = subset of active, gaps stay gaps. Gross MET is
 * converted to total kcal once; rest is subtracted once.
 */

import { dayBounds, localDateKey, resolveTimeZone } from '../../time/dayBoundary.js';
import { ACTIVITY, ALGORITHM_VERSION, MODEL_VERSION } from '../constants.js';
import { classifyActivity } from '../activity.js';
import { routeEstimate } from '../estimators.js';
import { hrReserveFraction, vo2ToKcalPerMin, vo2ToMet, metToVo2 } from '../physiology.js';
import { walkingVo2, runningVo2 } from '../locomotion.js';
import { aggregateDay, computeEnergyMinutes } from '../engine.js';
import { extractV3SeriesFeatures } from './features.js';
import { WEAR_BICEP, WEAR_WRIST } from './placement.js';
import { FAMILY, FEATURE_GROUP, routeV3Minute } from './router.js';
import { domainGate } from './domain.js';
import { composeV3Features, loadV3ArtifactCached, predictFamily } from './models.js';

const MINUTE_MS = 60_000;

export const ALGORITHM_VERSION_V3 = '3.1.0';
export const FEATURE_VERSION_V3 = 'feat-v3-2';
export const MODEL_VERSION_V3 = 'energy-v3.1.1-unvalidated';

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
    if (!best || (s.end - s.start) > (best.end - s.start)) best = s;
  }
  return best;
}

function round(n, p) {
  const f = 10 ** p;
  return Math.round(n * f) / f;
}

function gpsVo2(features, activity) {
  if (features.speedMs == null || features.speedMs <= 0) return null;
  if (activity === ACTIVITY.WALKING) {
    return walkingVo2({ speedMs: features.speedMs, grade: features.grade || 0 })?.vo2MlPerKgMin ?? null;
  }
  if (activity === ACTIVITY.RUNNING) {
    return runningVo2({ speedMs: features.speedMs, grade: features.grade || 0 })?.vo2MlPerKgMin ?? null;
  }
  return null;
}

function v3FeaturesForClass(features, { dropMotion }) {
  if (dropMotion) return { ...features, motion: null, motionMax: null };
  if (features.imu?.dyn_enmo_mean != null) {
    return {
      ...features,
      motion: features.imu.dyn_enmo_mean,
      motionMax: features.imu.enmo_p90 ?? features.imu.dyn_enmo_mean,
      motionSource: 'imu6',
    };
  }
  return features;
}

function qualityWithImu(quality, imu, { dropMotion }) {
  if (dropMotion) return { ...quality, motion: 0 };
  if (!imu) return quality;
  const cov = imu.coverage == null ? 1 : imu.coverage;
  const imuQ = 0.4 + 0.6 * cov;
  return {
    ...quality,
    motion: Math.max(quality.motion || 0, imuQ),
    flags: (quality.flags || []).filter((f) => f !== 'motion_absent'),
  };
}

function estimatorName(route) {
  if (route.fallback_reason) return `v1-fallback:${route.fallback_reason}`;
  if (route.family === FAMILY.IMU_SEDENTARY) return 'v3-imu-sedentary';
  if (route.family === FAMILY.HR_IMU_LOCO) return 'v3-hr-imu-locomotion';
  if (route.family === FAMILY.HR_CYCLING) return 'v3-hr-cycling';
  return `v1-fallback:${route.router_reason || 'hr_scalar'}`;
}

function provenanceFlags(route, domain, usedLearned) {
  const flags = ['v3_criterion_uncalibrated', ...(domain?.flags || [])];
  for (const g of route.input_feature_groups || []) flags.push(`v3_feat_${g}`);
  if (usedLearned) flags.push('v3_learned');
  else if (!route.fallback_reason) flags.push('v3_v1phys');
  return flags;
}

function annotateV1Fallback(row, {
  placement, source, route, imuCoverage, domain, cls,
}) {
  const flags = [
    ...(row.quality_flags || []),
    ...provenanceFlags(route, domain, false),
  ];
  return {
    ...row,
    algorithm_version: ALGORITHM_VERSION_V3,
    feature_version: FEATURE_VERSION_V3,
    model_version: MODEL_VERSION_V3,
    estimator: estimatorName(route),
    wear_location: placement,
    wear_location_source: source,
    quality_flags: flags,
    debug: {
      ...(row.debug || {}),
      fallback: route.fallback_reason,
      activity_model: route.activity_model,
      input_feature_groups: route.input_feature_groups,
      router_reason: route.router_reason,
      imu_coverage: imuCoverage ?? 0,
      domain_in_support: domain?.in_support ?? null,
      domain_distance: domain?.distance ?? null,
      domain_threshold: domain?.threshold ?? null,
      domain_reference: domain?.reference_dataset ?? null,
      domain_rejection: domain?.in_support === false ? (domain?.reason ?? null) : null,
      classifier_score_heuristic: true,
      criterion_uncertainty: 'unavailable',
      used_learned: false,
      v1_model_version: MODEL_VERSION,
      v1_algorithm_version: ALGORITHM_VERSION,
      activity_classifier: cls?.reason ?? null,
    },
  };
}

function metToMinuteRow({
  met, features, physiology, cls, workout, quality, placement, route, domain, usedLearned,
}) {
  const vo2 = metToVo2(met);
  const totalKcal = vo2ToKcalPerMin(vo2, physiology);
  if (totalKcal == null) return null;
  const restingKcal = cls.activity === ACTIVITY.SLEEP
    ? physiology.sleepKcalPerMin
    : physiology.restingKcalPerMin;
  const activeKcal = Math.max(0, totalKcal - restingKcal);
  const iso = new Date(features.minuteMs).toISOString();
  const tz = features.timezone || 'UTC';
  return {
    minute_at: iso,
    day: localDateKey(iso, tz),
    timezone_name: tz,
    met: round(met, 3),
    resting_kcal: round(restingKcal, 4),
    active_kcal: round(activeKcal, 4),
    activity_type: cls.activity,
    activity_confidence: round(cls.confidence, 3),
    model_confidence: round(usedLearned ? Math.min(0.7, 0.4 + 0.3 * (cls.confidence || 0)) : 0.45, 3),
    hr: features.hr,
    hr_source: features.hrCount > 0 ? 'measured' : 'absent',
    motion_intensity: features.imu?.dyn_enmo_mean ?? features.motion,
    signal_quality: quality.overall,
    quality_flags: [...(quality.flags || []), ...provenanceFlags(route, domain, usedLearned)],
    workout_session_id: workout?.id ?? null,
    algorithm_version: ALGORITHM_VERSION_V3,
    feature_version: FEATURE_VERSION_V3,
    model_version: MODEL_VERSION_V3,
    calibration_version: physiology.calibration.version,
    estimator: estimatorName(route),
    wear_location: placement,
    wear_location_source: features.wear_location_source,
    debug: {
      vo2: round(vo2, 2),
      fallback: null,
      activity_model: route.activity_model,
      input_feature_groups: route.input_feature_groups,
      router_reason: route.router_reason,
      imu_coverage: features.imuCoverage,
      domain_in_support: domain?.in_support ?? null,
      domain_distance: domain?.distance ?? null,
      domain_threshold: domain?.threshold ?? null,
      domain_reference: domain?.reference_dataset ?? null,
      domain_rejection: domain?.in_support === false ? (domain?.reason ?? null) : null,
      classifier_score_heuristic: true,
      criterion_uncertainty: 'unavailable',
      used_learned: usedLearned,
      v1_model_version: MODEL_VERSION,
      v1_algorithm_version: ALGORITHM_VERSION,
    },
  };
}

function v1PhysEstimate({
  features, quality, physiology, cls, context, family, dropMotion,
}) {
  const useImuMotion = family !== FAMILY.HR_CYCLING && !dropMotion && features.imu;
  const routed = v3FeaturesForClass(features, { dropMotion: dropMotion || family === FAMILY.HR_CYCLING });
  if (!useImuMotion && family === FAMILY.HR_CYCLING) {
    routed.motion = features.motion;
  }
  const qualityForRoute = qualityWithImu(quality, features.imu, {
    dropMotion: dropMotion || family === FAMILY.HR_CYCLING,
  });
  let estimate = routeEstimate({
    features: routed,
    quality: qualityForRoute,
    physiology,
    activity: cls.activity === ACTIVITY.WORKOUT_OTHER && family === FAMILY.HR_CYCLING
      ? ACTIVITY.CYCLING
      : cls.activity,
    activityConfidence: cls.confidence,
    context,
  });
  const locVo2 = gpsVo2(features, cls.activity);
  if (estimate && locVo2 != null && Number.isFinite(locVo2)) {
    const blended = 0.5 * estimate.vo2 + 0.5 * locVo2;
    estimate = {
      ...estimate,
      vo2: blended,
      met: vo2ToMet(blended),
      totalKcalPerMin: vo2ToKcalPerMin(blended, physiology),
    };
  }
  return { estimate, routed, qualityForRoute };
}

/**
 * @returns {{minutes: Array, stats: object}}
 */
export function computeEnergyMinutesV3({
  samples,
  physiology,
  workouts = [],
  timeZone = 'UTC',
  imuRecords = [],
  wearLocationEvents = [],
  artifact,
} = {}) {
  const tz = resolveTimeZone(timeZone);
  const spans = indexWorkouts(workouts);
  const v1 = computeEnergyMinutes({ samples, physiology, workouts, timeZone });
  const windows = extractV3SeriesFeatures(samples, { imuRecords, wearLocationEvents });
  const model = artifact !== undefined ? artifact : loadV3ArtifactCached();

  const minutes = [];
  const handled = new Set();
  const stats = {
    input: samples?.length || 0,
    windows: windows.length,
    skipped: 0,
    byActivity: {},
    estimator_counts: {},
    fallback_minutes: 0,
    imu_minutes: 0,
    bicep_fallback_minutes: 0,
    learned_minutes: 0,
  };

  let sustainedEffortMinutes = 0;
  let previousActivity = null;
  let previousMinuteMs = null;
  const v1ByMs = new Map(v1.minutes.map((m) => [Date.parse(m.minute_at), m]));

  for (const { features, quality } of windows) {
    const contiguous = previousMinuteMs != null && features.minuteMs - previousMinuteMs === MINUTE_MS;
    const hrr = hrReserveFraction(features.hr, physiology);
    sustainedEffortMinutes = (contiguous && hrr != null && hrr > 0.4)
      ? sustainedEffortMinutes + 1
      : 0;
    previousMinuteMs = features.minuteMs;
    features.timezone = tz;

    const workout = workoutForMinute(spans, features.minuteMs);
    const context = { workout, previousActivity, sustainedEffortMinutes };
    const placement = features.wear_location || WEAR_WRIST;
    const dropMotion = placement === WEAR_BICEP;
    const routedForClass = v3FeaturesForClass(features, { dropMotion });
    const cls = classifyActivity(
      routedForClass,
      physiology,
      qualityWithImu(quality, features.imu, { dropMotion }),
      context,
    );

    const imuOk = Boolean(features.imu && (features.imu.coverage == null || features.imu.coverage >= 0.25));
    let route = routeV3Minute({
      activity: cls.activity,
      confidence: cls.confidence,
      reason: cls.reason,
      placement,
      imu: imuOk ? features.imu : null,
      hr: features.hr,
      physiology,
      quality,
    });

    const domain = route.use_learned
      ? domainGate(features, model?.domain, route.input_feature_groups, route.family)
      : { in_support: true, reason: 'not_required', distance: null, flags: [] };
    if (route.use_learned && domain.in_support === false) {
      route = {
        ...route,
        family: FAMILY.V1_OOD,
        activity_model: FAMILY.V1_OOD,
        router_reason: 'ood_or_insufficient_domain',
        fallback_reason: 'ood_or_insufficient_domain',
        input_feature_groups: [],
        use_learned: false,
      };
    }

    const v1Row = v1ByMs.get(features.minuteMs);
    const pushFallback = () => {
      if (!v1Row) {
        stats.skipped += 1;
        previousActivity = null;
        return;
      }
      minutes.push(annotateV1Fallback(v1Row, {
        placement,
        source: features.wear_location_source,
        route,
        imuCoverage: features.imuCoverage,
        domain,
        cls,
      }));
      handled.add(features.minuteMs);
      stats.byActivity[v1Row.activity_type] = (stats.byActivity[v1Row.activity_type] || 0) + 1;
      const est = estimatorName(route);
      stats.estimator_counts[est] = (stats.estimator_counts[est] || 0) + 1;
      stats.fallback_minutes += 1;
      if (placement === WEAR_BICEP) stats.bicep_fallback_minutes += 1;
      previousActivity = cls.activity;
    };

    if (!route.use_learned) {
      pushFallback();
      continue;
    }

    const composed = composeV3Features(features.imu, features, physiology);
    const gyroPresent = Boolean(features.imu?.gyro_present && features.imu?.gyro_mean_dps != null);
    const gyroInDomain = !model?.gyro_domain?.features
      || domainGate(features, model.gyro_domain, [], route.family).in_support;
    const learned = model
      ? predictFamily(model, route.family, composed, { allowGyro: gyroPresent && gyroInDomain })
      : null;
    if (learned?.met != null) {
      const row = metToMinuteRow({
        met: learned.met,
        features,
        physiology,
        cls,
        workout,
        quality: qualityWithImu(quality, features.imu, { dropMotion }),
        placement,
        route: {
          ...route,
          input_feature_groups: learned.used_gyro
            ? [...route.input_feature_groups, FEATURE_GROUP.GYRO]
            : route.input_feature_groups,
        },
        domain,
        usedLearned: true,
      });
      if (row) {
        minutes.push(row);
        handled.add(features.minuteMs);
        stats.byActivity[cls.activity] = (stats.byActivity[cls.activity] || 0) + 1;
        stats.estimator_counts[row.estimator] = (stats.estimator_counts[row.estimator] || 0) + 1;
        stats.imu_minutes += 1;
        stats.learned_minutes += 1;
        previousActivity = cls.activity;
        continue;
      }
    }

    const phys = v1PhysEstimate({
      features, quality, physiology, cls, context, family: route.family, dropMotion,
    });
    if (!phys.estimate) {
      pushFallback();
      continue;
    }
    const restingKcal = cls.activity === ACTIVITY.SLEEP
      ? physiology.sleepKcalPerMin
      : physiology.restingKcalPerMin;
    const activeKcal = Math.max(0, phys.estimate.totalKcalPerMin - restingKcal);
    const iso = new Date(features.minuteMs).toISOString();
    minutes.push({
      minute_at: iso,
      day: localDateKey(iso, tz),
      timezone_name: tz,
      met: round(phys.estimate.met, 3),
      resting_kcal: round(restingKcal, 4),
      active_kcal: round(activeKcal, 4),
      activity_type: cls.activity,
      activity_confidence: round(cls.confidence, 3),
      model_confidence: round(phys.estimate.modelConfidence, 3),
      hr: features.hr,
      hr_source: features.hrCount > 0 ? 'measured' : 'absent',
      motion_intensity: phys.routed.motion,
      signal_quality: phys.qualityForRoute.overall,
      quality_flags: [...(phys.qualityForRoute.flags || []), ...provenanceFlags(route, domain, false)],
      workout_session_id: workout?.id ?? null,
      algorithm_version: ALGORITHM_VERSION_V3,
      feature_version: FEATURE_VERSION_V3,
      model_version: MODEL_VERSION_V3,
      calibration_version: physiology.calibration.version,
      estimator: estimatorName(route),
      wear_location: placement,
      wear_location_source: features.wear_location_source,
      debug: {
        vo2: round(phys.estimate.vo2, 2),
        fallback: null,
        activity_model: route.activity_model,
        input_feature_groups: route.input_feature_groups,
        router_reason: route.router_reason,
        imu_coverage: features.imuCoverage,
        domain_in_support: domain?.in_support ?? null,
        domain_distance: domain?.distance ?? null,
        domain_threshold: domain?.threshold ?? null,
        domain_reference: domain?.reference_dataset ?? null,
        domain_rejection: domain?.in_support === false ? (domain?.reason ?? null) : null,
        classifier_score_heuristic: true,
        criterion_uncertainty: 'unavailable',
        used_learned: false,
        v1_model_version: MODEL_VERSION,
        v1_algorithm_version: ALGORITHM_VERSION,
      },
    });
    handled.add(features.minuteMs);
    stats.byActivity[cls.activity] = (stats.byActivity[cls.activity] || 0) + 1;
    stats.estimator_counts[estimatorName(route)] = (stats.estimator_counts[estimatorName(route)] || 0) + 1;
    stats.imu_minutes += 1;
    previousActivity = cls.activity;
  }

  for (const row of v1.minutes) {
    const ms = Date.parse(row.minute_at);
    if (handled.has(ms)) continue;
    const win = windows.find((w) => w.features.minuteMs === ms);
    const placement = win?.features.wear_location || WEAR_WRIST;
    const route = routeV3Minute({
      activity: row.activity_type,
      confidence: row.activity_confidence,
      reason: 'v1_row',
      placement,
      imu: null,
      hr: row.hr,
      physiology,
    });
    minutes.push(annotateV1Fallback(row, {
      placement,
      source: win?.features.wear_location_source,
      route,
      imuCoverage: win?.features.imuCoverage,
      domain: null,
      cls: { activity: row.activity_type, reason: 'v1_row' },
    }));
    stats.byActivity[row.activity_type] = (stats.byActivity[row.activity_type] || 0) + 1;
    stats.estimator_counts[estimatorName(route)] = (stats.estimator_counts[estimatorName(route)] || 0) + 1;
    stats.fallback_minutes += 1;
    if (placement === WEAR_BICEP) stats.bicep_fallback_minutes += 1;
  }

  minutes.sort((a, b) => Date.parse(a.minute_at) - Date.parse(b.minute_at));
  stats.skipped += v1.stats.skipped || 0;
  return { minutes, stats };
}

export function aggregateDayV3(minutes, opts = {}) {
  return aggregateDay(minutes, opts);
}

export { dayBounds };
