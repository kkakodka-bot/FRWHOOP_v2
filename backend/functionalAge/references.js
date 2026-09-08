import { interpolatePoints, lerp, clamp } from './math.js';
import { getMethodology, METHODOLOGY_VERSION } from './methodology.js';

export function normalizeSex(sex) {
  const s = String(sex || 'male').toLowerCase();
  if (s === 'female' || s === 'f' || s === 'woman') return 'female';
  if (s === 'male' || s === 'm' || s === 'man') return 'male';
  return 'nonbinary';
}

function tableValue(table, sex, age) {
  const key = sex === 'female' ? 'female' : 'male';
  const points = table[key];
  const v = interpolatePoints(points, clamp(age, points[0][0], points[points.length - 1][0]));
  if (sex !== 'nonbinary') return v;
  const other = interpolatePoints(
    table[key === 'male' ? 'female' : 'male'],
    clamp(age, points[0][0], points[points.length - 1][0]),
  );
  return (v + other) / 2;
}

function ageLerpTarget(age, youngAge, olderAge, youngValue, olderValue) {
  const t = clamp((age - youngAge) / Math.max(1e-6, olderAge - youngAge), 0, 1);
  return lerp(youngValue, olderValue, t);
}

export function referenceValues(chronologicalAge, sex, version = METHODOLOGY_VERSION) {
  const m = getMethodology(version);
  const sx = normalizeSex(sex);
  const age = Number(chronologicalAge);
  const rhrRef = sx === 'female' ? m.rhr.femaleRef : sx === 'male' ? m.rhr.maleRef : (m.rhr.maleRef + m.rhr.femaleRef) / 2;
  return {
    sleepDurationHours: (m.sleepDuration.optimalMinHours + m.sleepDuration.optimalMaxHours) / 2,
    sleepDurationMinHours: m.sleepDuration.optimalMinHours,
    sleepDurationMaxHours: m.sleepDuration.optimalMaxHours,
    sleepConsistencyPct: m.sleepConsistency.referencePct,
    stepsPerDay: ageLerpTarget(age, m.steps.youngAge, m.steps.olderAge, m.steps.youngTarget, m.steps.olderTarget),
    zone13MinPerWeek: ageLerpTarget(
      age,
      m.moderateActivity.youngAge,
      m.moderateActivity.olderAge,
      m.moderateActivity.youngTargetMin,
      m.moderateActivity.olderTargetMin,
    ),
    zone45MinPerWeek: ageLerpTarget(
      age,
      m.vigorousActivity.youngAge,
      m.vigorousActivity.olderAge,
      m.vigorousActivity.youngTargetMin,
      m.vigorousActivity.olderTargetMin,
    ),
    strengthMinPerWeek: m.strength.targetMin,
    vo2Max: tableValue(m.vo2.table, sx, age),
    restingHrBpm: rhrRef,
    leanBodyMassPct: tableValue(m.leanBodyMass.table, sx, age),
  };
}
