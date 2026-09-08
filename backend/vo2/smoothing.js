import { getMethodology } from './methodology.js';
import { TIERS } from './methodology.js';
import { clamp, finiteNumber, isoWeekMonday } from './math.js';

export function weeklyDeltaCap(tier, version) {
  const s = getMethodology(version).smoothing;
  if (tier === TIERS.LAB_CALIBRATED) return s.maxWeeklyDeltaLab;
  if (tier === TIERS.GPS_AUGMENTED) return s.maxWeeklyDeltaGps;
  return s.maxWeeklyDeltaPassive;
}

export function smoothVo2({
  raw,
  prior,
  quality = 0.5,
  tier,
  version,
} = {}) {
  const s = getMethodology(version).smoothing;
  const current = finiteNumber(raw);
  if (current == null) return { vo2: null, gain: 0, delta: 0 };
  const prev = finiteNumber(prior);
  if (prev == null) return { vo2: current, gain: 1, delta: 0 };

  const q = clamp(quality, 0, 1);
  const tierBoost = tier === TIERS.LAB_CALIBRATED ? 1.4
    : tier === TIERS.GPS_AUGMENTED ? 1.15
    : 1;
  const gain = clamp(s.baseGain * (0.6 + 0.8 * q) * tierBoost, s.minGain, s.maxGain);
  let next = prev + gain * (current - prev);
  const cap = weeklyDeltaCap(tier, version);
  next = clamp(next, prev - cap, prev + cap);
  return { vo2: next, gain, delta: next - prev };
}

export function effectiveWeekStart(asOfDay) {
  return isoWeekMonday(asOfDay);
}
