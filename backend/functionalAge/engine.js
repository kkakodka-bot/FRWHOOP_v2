import { clamp, finiteNumber, roundTo } from './math.js';
import {
  CONTRIBUTOR_KEYS,
  CONTRIBUTOR_META,
  METHODOLOGY_VERSION,
  getMethodology,
} from './methodology.js';
import { referenceValues } from './references.js';
import { HAZARD_FNS } from './hazardCurves.js';
import { hazardRatioToAgeImpact } from './effectiveAge.js';
import { adjustHazardRatios } from './correlationAdjustment.js';

const METRIC_FIELDS = Object.freeze({
  sleep_duration: 'sleepDurationHours',
  sleep_consistency: 'sleepConsistencyPct',
  steps: 'stepsPerDay',
  moderate_activity: 'zone13MinPerWeek',
  vigorous_activity: 'zone45MinPerWeek',
  strength: 'strengthMinPerWeek',
  vo2_max: 'vo2Max',
  rhr: 'restingHrBpm',
  lean_body_mass: 'leanBodyMassPct',
});

const REF_FIELDS = Object.freeze({
  sleep_duration: 'sleepDurationHours',
  sleep_consistency: 'sleepConsistencyPct',
  steps: 'stepsPerDay',
  moderate_activity: 'zone13MinPerWeek',
  vigorous_activity: 'zone45MinPerWeek',
  strength: 'strengthMinPerWeek',
  vo2_max: 'vo2Max',
  rhr: 'restingHrBpm',
  lean_body_mass: 'leanBodyMassPct',
});

function vo2Usable(metrics, methodology) {
  const vo2 = finiteNumber(metrics.vo2Max);
  if (vo2 == null || vo2 < methodology.calibration.minValidVo2 || vo2 > methodology.calibration.maxValidVo2) {
    return false;
  }
  const source = String(metrics.vo2Source || 'whoop_estimated').toLowerCase();
  if (source === 'unavailable' || source === 'estimated_hr_ratio') return false;
  return methodology.vo2.acceptedSources.includes(source);
}

export function contributorAvailability(metrics, methodology) {
  const cal = methodology.calibration;
  const lbm = finiteNumber(metrics.leanBodyMassPct);
  return {
    sleep_duration: finiteNumber(metrics.sleepDurationHours) != null,
    sleep_consistency: finiteNumber(metrics.sleepConsistencyPct) != null,
    steps: finiteNumber(metrics.stepsPerDay) != null,
    moderate_activity: finiteNumber(metrics.zone13MinPerWeek) != null,
    vigorous_activity: finiteNumber(metrics.zone45MinPerWeek) != null,
    strength: finiteNumber(metrics.strengthMinPerWeek) != null,
    vo2_max: vo2Usable(metrics, methodology),
    rhr: finiteNumber(metrics.restingHrBpm) != null,
    lean_body_mass: lbm != null && lbm >= cal.minValidLbm && lbm <= cal.maxValidLbm,
  };
}

function explanationFor(key, impact, value, unit, available) {
  const label = CONTRIBUTOR_META[key].label;
  if (!available) {
    return `${label} is unavailable and is not changing Functional Age.`;
  }
  if (!Number.isFinite(impact) || Math.abs(impact) < 0.05) {
    return `${label} is near the health-optimized reference and is not changing Functional Age.`;
  }
  const years = Math.abs(roundTo(impact, 1)).toFixed(1);
  const direction = impact < 0 ? 'reducing' : 'increasing';
  const shown = value == null ? '' : ` (${formatValue(value)} ${unit})`;
  return `${label}${shown} is ${direction} your Functional Age by ${years} years.`;
}

function formatValue(v) {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 100) return String(Math.round(v));
  return String(roundTo(v, 1));
}

export function calculateFunctionalAge(input = {}, options = {}) {
  const version = options.methodologyVersion || input.methodologyVersion || METHODOLOGY_VERSION;
  const m = getMethodology(version);
  const chronologicalAge = Number(input.chronologicalAge);
  if (!Number.isFinite(chronologicalAge)) {
    throw new Error('chronologicalAge is required');
  }
  const sex = input.sex || 'male';
  const metrics = input.metrics || {};
  const confidenceIn = input.confidence || {};
  const refs = referenceValues(chronologicalAge, sex, version);
  const availability = contributorAvailability(metrics, m);

  const rawHrs = {};
  const contributors = [];

  for (const key of CONTRIBUTOR_KEYS) {
    const field = METRIC_FIELDS[key];
    const value = availability[key] ? Number(metrics[field]) : null;
    const referenceValue = refs[REF_FIELDS[key]];
    let rawHr = 1;
    if (availability[key]) rawHr = HAZARD_FNS[key](value, chronologicalAge, sex, version);
    rawHrs[key] = rawHr;
  }

  const { adjustedHrs } = adjustHazardRatios(rawHrs, availability, version);
  let ageDelta = 0;

  for (const key of CONTRIBUTOR_KEYS) {
    const field = METRIC_FIELDS[key];
    const value = availability[key] ? Number(metrics[field]) : null;
    const referenceValue = refs[REF_FIELDS[key]];
    const rawHr = rawHrs[key];
    const adjHr = availability[key] ? adjustedHrs[key] : 1;
    let impact = availability[key]
      ? hazardRatioToAgeImpact(adjHr, m.gompertzRate, m.hrClamp)
      : 0;
    impact = clamp(impact, m.ageImpactClampPerContributor.min, m.ageImpactClampPerContributor.max);
    if (!availability[key]) impact = 0;
    ageDelta += impact;
    const confidence = availability[key]
      ? clamp(confidenceIn[key] == null ? 1 : Number(confidenceIn[key]), 0, 1)
      : 0;
    contributors.push({
      key,
      label: CONTRIBUTOR_META[key].label,
      domain: CONTRIBUTOR_META[key].domain,
      value: value == null ? null : roundTo(value, key === 'steps' ? 0 : 2),
      unit: CONTRIBUTOR_META[key].unit,
      referenceValue: roundTo(referenceValue, key === 'steps' ? 0 : 2),
      rawHazardRatio: roundTo(rawHr, 4),
      adjustedHazardRatio: roundTo(adjHr, 4),
      ageImpactYears: roundTo(impact, 3),
      confidence: roundTo(confidence, 3),
      available: availability[key],
      explanation: explanationFor(key, impact, value, CONTRIBUTOR_META[key].unit, availability[key]),
    });
  }

  ageDelta = clamp(ageDelta, m.functionalAgeDeltaClamp.min, m.functionalAgeDeltaClamp.max);
  const functionalAge = chronologicalAge + ageDelta;

  return {
    methodologyVersion: version,
    chronologicalAge: roundTo(chronologicalAge, 3),
    functionalAge: roundTo(functionalAge, 3),
    ageDelta: roundTo(ageDelta, 3),
    sex,
    contributors,
    availability,
    references: refs,
  };
}

export { METRIC_FIELDS };
