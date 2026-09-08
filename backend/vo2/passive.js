import { getMethodology } from './methodology.js';
import { clamp, finiteNumber } from './math.js';
import { uthVo2Max } from './uth.js';

export function jacksonVo2(features, version) {
  const j = getMethodology(version).jackson;
  const age = finiteNumber(features.age);
  const body = finiteNumber(features.bmi);
  if (age == null || body == null) return null;
  const sex = String(features.sex || '').toLowerCase();
  const gender = sex === 'female' ? 0 : sex === 'male' ? 1 : 0.5;
  const par = clamp(features.activityRating ?? 2, 0, 7);
  return j.intercept + j.parCoef * par + j.ageCoef * age + j.bmiCoef * body + j.sexCoef * gender;
}

function adjustments(features, version) {
  const cfg = getMethodology(version).passiveBlend;
  let adj = 0;
  if (features.medianHrv != null && features.age != null) {
    const expected = cfg.expectedHrvIntercept - cfg.expectedHrvAgeSlope * features.age;
    adj += clamp((features.medianHrv - expected) / cfg.hrvAdjScale, -cfg.hrvAdjClamp, cfg.hrvAdjClamp);
  }
  if (features.medianSleepHours != null) {
    if (features.medianSleepHours >= 7 && features.medianSleepHours <= 9
      && (features.medianSleepConsistency == null || features.medianSleepConsistency >= 70)) {
      adj += 0.4;
    } else if (features.medianSleepHours < 6) {
      adj -= 0.8;
    }
  }
  if (features.freeLivingActiveHr != null && features.medianRhr != null) {
    const excess = features.freeLivingActiveHr - features.medianRhr;
    if (excess < 25) adj += 0.6;
    else if (excess > 50) adj -= 0.5;
  }
  if ((features.rhrTrend || 0) < -0.15) adj += 0.3;
  if ((features.rhrTrend || 0) > 0.2) adj -= 0.3;
  return clamp(adj, -cfg.adjustmentClamp, cfg.adjustmentClamp);
}

export function estimatePassive({ features, hrMax, version } = {}) {
  const m = getMethodology(version);
  const uth = uthVo2Max(hrMax, features?.medianRhr, version);
  const jackson = jacksonVo2(features || {}, version);
  const adj = adjustments(features || {}, version);
  const parts = [];
  if (uth != null) parts.push({ value: uth, weight: m.passiveBlend.uthWeight });
  if (jackson != null) parts.push({ value: jackson, weight: m.passiveBlend.jacksonWeight });
  if (!parts.length) return { vo2: null, uth, jackson, adjustment: adj };
  const wsum = parts.reduce((s, p) => s + p.weight, 0);
  const blended = parts.reduce((s, p) => s + p.value * p.weight, 0) / wsum;
  const vo2 = clamp(blended + adj, m.vo2Clamp.min, m.vo2Clamp.max);
  return { vo2, uth, jackson, adjustment: adj };
}
