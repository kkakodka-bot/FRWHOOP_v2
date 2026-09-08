import {
  CONFIDENCE, ELIGIBILITY, TIERS, getMethodology,
} from './methodology.js';
import { clamp, finiteNumber, lastDayOf, roundTo } from './math.js';
import { uthVo2Max } from './uth.js';
import { resolveHrMax } from './hrMax.js';
import { evaluateEligibility } from './eligibility.js';
import { extractPassiveFeatures } from './features.js';
import { estimatePassive } from './passive.js';
import { aggregateGpsEstimates, estimateGps } from './exercise.js';
import { activeLabAnchor, applyLabCalibration } from './calibration.js';
import { effectiveWeekStart, smoothVo2 } from './smoothing.js';

function qualityScore({ eligibility, features, gps, lab, hrMax }) {
  const rec = clamp((eligibility.validRecoveries21d || 0) / 21, 0, 1);
  const cov = clamp((features?.observedDays || 0) / 28, 0, 1);
  const rest = features?.medianRhr != null ? 1 : 0.3;
  const hr = hrMax?.confidence === CONFIDENCE.HIGH ? 1 : hrMax?.confidence === CONFIDENCE.MEDIUM ? 0.75 : 0.45;
  const gpsQ = gps?.quality != null ? gps.quality : 0;
  const labQ = lab ? 1 : 0;
  return roundTo(0.28 * rec + 0.22 * cov + 0.15 * rest + 0.15 * hr + 0.12 * gpsQ + 0.08 * labQ, 3);
}

function confidenceFor(tier, quality, gps) {
  if (tier === TIERS.INSUFFICIENT_DATA) return CONFIDENCE.LOW;
  if (tier === TIERS.LAB_CALIBRATED && quality >= 0.55) return CONFIDENCE.HIGH;
  if (tier === TIERS.GPS_AUGMENTED && gps?.fidelity === 'timeseries' && quality >= 0.7) return CONFIDENCE.HIGH;
  if (tier === TIERS.GPS_AUGMENTED) return CONFIDENCE.MEDIUM;
  if (tier === TIERS.PASSIVE && quality >= 0.65) return CONFIDENCE.MEDIUM;
  return CONFIDENCE.LOW;
}

function pickTier(eligibility, gps, labCalibrated) {
  if (eligibility.eligibility === ELIGIBILITY.INSUFFICIENT_DATA && !labCalibrated) {
    return TIERS.INSUFFICIENT_DATA;
  }
  if (labCalibrated) return TIERS.LAB_CALIBRATED;
  if (eligibility.eligibility === ELIGIBILITY.GPS_ELIGIBLE && gps?.vo2 != null) return TIERS.GPS_AUGMENTED;
  if (eligibility.eligibility === ELIGIBILITY.PASSIVE_ELIGIBLE || eligibility.eligibility === ELIGIBILITY.GPS_ELIGIBLE) {
    return TIERS.PASSIVE;
  }
  if (eligibility.eligibility === ELIGIBILITY.LAB_CALIBRATED && !labCalibrated) return TIERS.PASSIVE;
  return TIERS.INSUFFICIENT_DATA;
}

export function calculateVo2Max(input = {}, options = {}) {
  const version = input.methodologyVersion || options.methodologyVersion;
  const m = getMethodology(version);
  const days = input.days || [];
  const asOfDay = input.asOfDay || lastDayOf(days);
  const profile = input.profile || {};
  const age = input.age ?? profile.age;

  if (!asOfDay) {
    return { error: 'no_days', asOfDay: null, methodologyVersion: m.version };
  }

  const hrMax = resolveHrMax({
    age,
    override: input.hrMaxOverride,
    days,
    profileHrMax: profile.hrMax ?? profile.maxHr,
    version,
  });

  const features = extractPassiveFeatures({ days, asOfDay, profile, age, version });
  const uth = uthVo2Max(hrMax.value, features.medianRhr, version);
  const passive = estimatePassive({ features, hrMax: hrMax.value, version });

  const labAnchor = activeLabAnchor(input.labAnchors, asOfDay);
  const eligibility = evaluateEligibility({
    age,
    days,
    asOfDay,
    hrMax: hrMax.value,
    labAnchor,
    version,
  });

  const gpsResults = (eligibility.gpsRuns || []).map((run) => (
    estimateGps(run.workout, features.medianRhr, hrMax.value, version)
  ));
  const gps = aggregateGpsEstimates(gpsResults);

  const modelNow = gps?.vo2 ?? passive.vo2 ?? uth;
  let lab = null;
  if (labAnchor) {
    lab = applyLabCalibration({
      labValue: labAnchor.value,
      measuredOn: labAnchor.measuredOn,
      asOfDay,
      modelNow,
      modelAtAnchor: labAnchor.modelAtAnchor ?? labAnchor.modelNow,
      version,
    });
  }

  const tier = pickTier(eligibility, gps, lab);
  let raw = null;
  if (tier === TIERS.LAB_CALIBRATED) raw = lab?.vo2;
  else if (tier === TIERS.GPS_AUGMENTED) raw = gps.vo2;
  else if (tier === TIERS.PASSIVE) raw = passive.vo2 ?? uth;
  if (raw != null) raw = clamp(raw, m.vo2Clamp.min, m.vo2Clamp.max);

  const quality = qualityScore({ eligibility, features, gps, lab: labAnchor, hrMax });
  const prior = input.priorSnapshot && input.priorSnapshot.methodologyVersion === m.version
    ? input.priorSnapshot.vo2Max
    : null;
  const smoothed = tier === TIERS.INSUFFICIENT_DATA
    ? { vo2: null, gain: 0, delta: 0 }
    : smoothVo2({ raw, prior, quality, tier, version });

  const vo2Max = smoothed.vo2 == null ? null : roundTo(smoothed.vo2, 1);
  const previous = finiteNumber(prior);
  const trend = previous == null || vo2Max == null
    ? { previous: previous, change: null }
    : { previous: roundTo(previous, 1), change: roundTo(vo2Max - previous, 1) };

  return {
    vo2Max,
    unit: m.unit,
    tier,
    eligibility: eligibility.eligibility,
    dataQualityScore: quality,
    confidence: confidenceFor(tier, quality, gps),
    coverage: {
      validRecoveries21d: eligibility.validRecoveries21d,
      validDays: features.observedDays,
      qualifyingGpsRuns90d: eligibility.qualifyingGpsRuns90d,
    },
    sources: {
      uthBaseline: uth == null ? null : roundTo(uth, 1),
      passiveEstimate: passive.vo2 == null ? null : roundTo(passive.vo2, 1),
      gpsEstimate: gps?.vo2 == null ? null : roundTo(gps.vo2, 1),
      labAnchor: labAnchor ? roundTo(labAnchor.value, 1) : null,
    },
    hrMax: {
      value: hrMax.value == null ? null : roundTo(hrMax.value, 1),
      source: hrMax.source,
      confidence: hrMax.confidence,
    },
    trend,
    weightKg: finiteNumber(profile.weightKg),
    gps: gps ? { fidelity: gps.fidelity, quality: gps.quality, runCount: gps.runCount, segmentCount: gps.segmentCount } : null,
    lab: lab ? { k: roundTo(lab.k, 3), delta: roundTo(lab.delta, 2), measuredOn: labAnchor.measuredOn, modality: labAnchor.modality } : null,
    features,
    reasons: eligibility.reasons,
    methodologyVersion: m.version,
    modelVersion: m.modelVersion,
    featureVersion: m.featureVersion,
    smoothingVersion: m.smoothingVersion,
    calculatedAt: options.calculatedAt || new Date().toISOString(),
    effectiveDate: effectiveWeekStart(asOfDay),
    asOfDay,
    disclaimer: m.disclaimer,
  };
}
