import { getMethodology } from './methodology.js';
import { finiteNumber } from './math.js';

/** Uth 2004 / Tanaka HRmax. Baseline and sanity check only — not the product VO2. */
export function tanakaHrMax(age, version) {
  const m = getMethodology(version).tanaka;
  const a = finiteNumber(age);
  if (a == null) return null;
  return m.intercept - m.slope * a;
}

export function uthVo2Max(hrMax, hrRest, version) {
  const coef = getMethodology(version).uth.coefficient;
  const max = finiteNumber(hrMax);
  const rest = finiteNumber(hrRest);
  if (max == null || rest == null || rest <= 0) return null;
  return coef * (max / rest);
}
