import { clamp, interpolateHazard } from './math.js';
import { getMethodology, METHODOLOGY_VERSION } from './methodology.js';
import { referenceValues } from './references.js';

function clampHr(hr, m) {
  return clamp(hr, m.hrClamp.min, m.hrClamp.max);
}

export function sleepDurationHazard(hours, _age, _sex, version = METHODOLOGY_VERSION) {
  const m = getMethodology(version);
  if (!Number.isFinite(hours)) return 1;
  return clampHr(interpolateHazard(m.sleepDuration.points, hours), m);
}

export function sleepConsistencyHazard(pct, _age, _sex, version = METHODOLOGY_VERSION) {
  const m = getMethodology(version);
  const c = m.sleepConsistency;
  if (!Number.isFinite(pct)) return 1;
  const delta10 = (c.referencePct - pct) / 10;
  const hr = Math.exp(c.logHrPer10PtsBelow * delta10);
  return clampHr(clamp(hr, c.minHr, c.maxHr), m);
}

export function stepsHazard(steps, age, sex, version = METHODOLOGY_VERSION) {
  const m = getMethodology(version);
  const ref = referenceValues(age, sex, version).stepsPerDay;
  if (!Number.isFinite(steps) || !(ref > 0)) return 1;
  const relative = Math.max(0, steps) / ref;
  return clampHr(interpolateHazard(m.steps.relativePoints, relative), m);
}

/**
 * Saturating activity curve: HR(0)=zeroHr, HR(target)=1, approaches saturatingHr by saturationMin.
 * For x > target the surplus uses an exponential approach to saturatingHr.
 */
export function saturatingActivityHazard(minutes, target, { zeroHr, saturatingHr, saturationMin, hardCapMin }, m) {
  const x = Math.max(0, Number(minutes) || 0);
  const cap = hardCapMin ?? saturationMin;
  const xx = Math.min(x, cap);
  if (!(target > 0)) return 1;
  if (xx <= target) {
    const t = xx / target;
    const logHr = Math.log(zeroHr) * (1 - t);
    return clampHr(Math.exp(logHr), m);
  }
  const span = Math.max(1e-6, saturationMin - target);
  const u = clamp((xx - target) / span, 0, 1);
  // Smooth 1 → saturatingHr
  const hr = Math.exp(Math.log(saturatingHr) * u);
  return clampHr(hr, m);
}

export function moderateActivityHazard(minPerWeek, age, sex, version = METHODOLOGY_VERSION) {
  const m = getMethodology(version);
  const target = referenceValues(age, sex, version).zone13MinPerWeek;
  return saturatingActivityHazard(minPerWeek, target, m.moderateActivity, m);
}

export function vigorousActivityHazard(minPerWeek, age, sex, version = METHODOLOGY_VERSION) {
  const m = getMethodology(version);
  const target = referenceValues(age, sex, version).zone45MinPerWeek;
  return saturatingActivityHazard(minPerWeek, target, m.vigorousActivity, m);
}

export function strengthHazard(minPerWeek, _age, _sex, version = METHODOLOGY_VERSION) {
  const m = getMethodology(version);
  const s = m.strength;
  const x = Math.max(0, Number(minPerWeek) || 0);
  if (x <= s.targetMin) {
    const t = x / s.targetMin;
    return clampHr(Math.exp(Math.log(s.zeroHr) * (1 - t)), m);
  }
  if (x >= s.plateauMin) return clampHr(s.bestHr, m);
  if (x <= s.bestMin) {
    const t = (x - s.targetMin) / Math.max(1e-6, s.bestMin - s.targetMin);
    const logHr = Math.log(s.bestHr) * t;
    return clampHr(Math.exp(logHr), m);
  }
  return clampHr(s.bestHr, m);
}

export function vo2MaxHazard(vo2, age, sex, version = METHODOLOGY_VERSION) {
  const m = getMethodology(version);
  const ref = referenceValues(age, sex, version).vo2Max;
  if (!Number.isFinite(vo2) || !Number.isFinite(ref)) return 1;
  const deltaMet = clamp((vo2 - ref) / m.vo2.metMlKgMin, m.vo2.deltaMetClamp.min, m.vo2.deltaMetClamp.max);
  return clampHr(m.vo2.hrPerMet ** deltaMet, m);
}

export function rhrHazard(bpm, age, sex, version = METHODOLOGY_VERSION) {
  const m = getMethodology(version);
  const ref = referenceValues(age, sex, version).restingHrBpm;
  if (!Number.isFinite(bpm) || !Number.isFinite(ref)) return 1;
  const x = clamp(bpm, m.rhr.floorBpm, m.rhr.ceilingBpm);
  return clampHr(m.rhr.rrPer10Bpm ** ((x - ref) / 10), m);
}

export function leanBodyMassHazard(pct, age, sex, version = METHODOLOGY_VERSION) {
  const m = getMethodology(version);
  const ref = referenceValues(age, sex, version).leanBodyMassPct;
  if (!Number.isFinite(pct) || !Number.isFinite(ref)) return 1;
  const deficit = ref - pct;
  if (deficit >= 0) return clampHr(m.leanBodyMass.hrPer10PctDeficit ** (deficit / 10), m);
  const surplus = Math.min(-deficit, m.leanBodyMass.surplusScalePct);
  const t = surplus / m.leanBodyMass.surplusScalePct;
  const hr = Math.exp(Math.log(m.leanBodyMass.surplusHrFloor) * t);
  return clampHr(hr, m);
}

export const HAZARD_FNS = Object.freeze({
  sleep_duration: sleepDurationHazard,
  sleep_consistency: sleepConsistencyHazard,
  steps: stepsHazard,
  moderate_activity: moderateActivityHazard,
  vigorous_activity: vigorousActivityHazard,
  strength: strengthHazard,
  vo2_max: vo2MaxHazard,
  rhr: rhrHazard,
  lean_body_mass: leanBodyMassHazard,
});
