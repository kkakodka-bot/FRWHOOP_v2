/**
 * Observed resting-HR resolver (energy v2).
 *
 * Audit finding (2026-08-27): the stored profile often has no resting HR, which
 * kills the HR channel (hrr_frac was the #1 learned-model feature) and silently
 * skips minutes. This resolver derives a defensible resting HR from observed
 * history when the profile lacks one.
 *
 * Method: for each day with enough HR samples, take the day's low percentile of
 * HR (the daily floor - sleeping/quiet resting rate). Require the floor to be
 * credible on >= minDays distinct days, then take the median of those daily
 * floors. Bounded by the same physiological gates the profile value uses.
 *
 * The daily floor (not a nighttime-only filter) is used because day rows in the
 * store may be sparse; a full-day 5th percentile is dominated by sleep/quiescent
 * minutes in practice. Provenance and confidence are returned so callers can
 * record the source on the row.
 */

import { clamp, num } from '../constants.js';
import { resolvePhysiology } from '../physiology.js';

export const OBSERVED_RHR_MIN = 25;
export const OBSERVED_RHR_MAX = 130;

/**
 * @param {Array}  days   history days: { day, bpmData: [{bpm|hr, ...}] , ... }
 * @param {object} o
 * @returns null, or { value, source, confidence, daysUsed, samplesUsed }
 */
export function resolveObservedRestingHr(days = [], {
  minDays = 3,
  minSamplesPerDay = 60,
  percentile = 0.05,
  maxDays = 28,
} = {}) {
  if (!Array.isArray(days) || !days.length) return null;
  const dailyFloors = [];
  let totalSamples = 0;
  for (const day of days.slice(-maxDays)) {
    const hrs = [];
    for (const s of day?.bpmData || []) {
      const v = num(s?.bpm ?? s?.hr ?? s?.heartRate);
      if (v != null && v >= OBSERVED_RHR_MIN && v <= OBSERVED_RHR_MAX) hrs.push(v);
    }
    if (hrs.length < minSamplesPerDay) continue;
    hrs.sort((a, b) => a - b);
    const idx = Math.min(hrs.length - 1, Math.max(0, Math.floor(hrs.length * percentile)));
    dailyFloors.push({ day: day.day, value: hrs[idx], n: hrs.length });
  }
  if (dailyFloors.length < minDays) return null;
  const values = dailyFloors.map((d) => d.value).sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  if (median == null || median < OBSERVED_RHR_MIN || median > OBSERVED_RHR_MAX) return null;
  return {
    value: Math.round(median * 10) / 10,
    source: 'observed_daily_floor',
    confidence: clamp(values.length / 7, 0.3, 0.9),
    daysUsed: values.length,
    samplesUsed: dailyFloors.reduce((a, d) => a + d.n, 0),
  };
}

/**
 * Resolve physiology with the observed-resting-HR fallback layered on top of v1.
 * Returns { physiology, restingHrSource } - restingHrSource is one of
 * 'profile', 'observed_daily_floor', 'none'.
 */
export function resolvePhysiologyV2({ profile = {}, prefs = {}, days = [], calibration = null } = {}) {
  const direct = num(prefs.restingHr) ?? num(profile.restingHr);
  if (direct != null) {
    return { physiology: resolvePhysiology({ profile, prefs, days, calibration }), restingHrSource: 'profile' };
  }
  const observed = resolveObservedRestingHr(days);
  if (observed != null) {
    const physiology = resolvePhysiology({
      profile,
      prefs: { ...prefs, restingHr: observed.value },
      days,
      calibration,
    });
    physiology.notes.push('resting_hr_observed_daily_floor');
    return { physiology, restingHrSource: observed.source, restingHrProvenance: observed };
  }
  return { physiology: resolvePhysiology({ profile, prefs, days, calibration }), restingHrSource: 'none' };
}
