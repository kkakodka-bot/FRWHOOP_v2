import { clamp } from './math.js';
import { getMethodology, METHODOLOGY_VERSION } from './methodology.js';

/**
 * Gompertz effective-age transform.
 * AgeImpact = ln(HR) / gompertzRate   (WHOOP: gompertzRate ≈ 0.1)
 */
export function hazardRatioToAgeImpact(hr, gompertzRate, hrClamp) {
  const rate = Number.isFinite(gompertzRate) && gompertzRate > 0 ? gompertzRate : 0.1;
  const lo = hrClamp?.min ?? 0.5;
  const hi = hrClamp?.max ?? 2.5;
  const h = Number(hr);
  if (!Number.isFinite(h) || h <= 0) return 0;
  return Math.log(clamp(h, lo, hi)) / rate;
}

export function ageImpactToHazardRatio(years, gompertzRate = 0.1) {
  const rate = Number.isFinite(gompertzRate) && gompertzRate > 0 ? gompertzRate : 0.1;
  if (!Number.isFinite(years)) return 1;
  return Math.exp(years * rate);
}

export function methodologyAgeImpact(hr, version = METHODOLOGY_VERSION) {
  const m = getMethodology(version);
  return hazardRatioToAgeImpact(hr, m.gompertzRate, m.hrClamp);
}
