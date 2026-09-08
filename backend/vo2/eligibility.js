import { ELIGIBILITY, getMethodology } from './methodology.js';
import { addDays, finiteNumber } from './math.js';

export function isValidRecovery(recovery, version) {
  const cfg = getMethodology(version).eligibility;
  const n = finiteNumber(recovery);
  return n != null && n >= cfg.minValidRecovery && n <= cfg.maxValidRecovery;
}

export function validRecoveriesInWindow(days, asOfDay, windowDays, version) {
  const start = addDays(asOfDay, -(windowDays - 1));
  let n = 0;
  for (const day of days || []) {
    if (!day?.day || day.day < start || day.day > asOfDay) continue;
    if (isValidRecovery(day.recovery, version)) n += 1;
  }
  return n;
}

export function isOutdoorRunName(name) {
  const s = String(name || '');
  if (/treadmill/i.test(s)) return false;
  return /run|jog/i.test(s);
}

export function impliedSpeedMps(workout) {
  const dist = finiteNumber(workout?.distanceM ?? workout?.distance_m);
  const dur = finiteNumber(workout?.durationMin ?? workout?.duration_min);
  if (dist == null || dist <= 0 || dur == null || dur <= 0) return null;
  return dist / (dur * 60);
}

export function gpsSessionQuality(workout, hrMax, version) {
  const gps = getMethodology(version).gps;
  const dur = finiteNumber(workout?.durationMin ?? workout?.duration_min) || 0;
  const gpsOn = Boolean(workout?.gpsEnabled ?? workout?.gps_enabled);
  const dist = finiteNumber(workout?.distanceM ?? workout?.distance_m);
  const avgHr = finiteNumber(workout?.avgHr ?? workout?.avg_hr);
  const speed = impliedSpeedMps(workout);
  const reasons = [];
  if (dur < getMethodology(version).eligibility.gpsMinDurationMin) reasons.push('short');
  if (!gpsOn && !(dist > 0)) reasons.push('no_gps');
  if (speed != null && (speed < gps.minSpeedMps || speed > gps.maxSpeedMps)) reasons.push('speed_band');
  if (speed != null && speed > gps.jumpSpeedMps) reasons.push('gps_jump');
  if (hrMax && avgHr != null) {
    const frac = avgHr / hrMax;
    if (frac < gps.minPctHrMax || frac > gps.maxPctHrMax) reasons.push('hr_band');
  }
  const ok = !reasons.includes('short') && !reasons.includes('no_gps') && !reasons.includes('gps_jump')
    && !reasons.includes('speed_band') && !reasons.includes('hr_band');
  return { ok, reasons, speed };
}

export function qualifyingGpsRuns(days, asOfDay, hrMax, version) {
  const m = getMethodology(version);
  const start = addDays(asOfDay, -(m.eligibility.gpsLookbackDays - 1));
  const runs = [];
  for (const day of days || []) {
    if (!day?.day || day.day < start || day.day > asOfDay) continue;
    for (const w of day.workouts || []) {
      const name = w.name || w.activityName || '';
      if (!isOutdoorRunName(name)) continue;
      const q = gpsSessionQuality(w, hrMax, version);
      if (q.ok) runs.push({ day: day.day, workout: w, ...q });
    }
  }
  return runs;
}

export function evaluateEligibility({
  age,
  days,
  asOfDay,
  hrMax,
  labAnchor,
  version,
} = {}) {
  const m = getMethodology(version);
  const reasons = [];
  if (age == null || age < m.adultMinAge) {
    reasons.push(age == null ? 'missing_age' : 'pediatric');
    return {
      eligibility: ELIGIBILITY.INSUFFICIENT_DATA,
      validRecoveries21d: 0,
      qualifyingGpsRuns90d: 0,
      reasons,
    };
  }
  const validRecoveries21d = validRecoveriesInWindow(days, asOfDay, m.eligibility.recoveryWindowDays, version);
  const gpsRuns = qualifyingGpsRuns(days, asOfDay, hrMax, version);
  const hasLab = labAnchor && finiteNumber(labAnchor.value) != null;

  if (hasLab) {
    return {
      eligibility: ELIGIBILITY.LAB_CALIBRATED,
      validRecoveries21d,
      qualifyingGpsRuns90d: gpsRuns.length,
      reasons,
      gpsRuns,
    };
  }
  if (validRecoveries21d >= m.eligibility.minValidRecoveries && gpsRuns.length > 0) {
    return {
      eligibility: ELIGIBILITY.GPS_ELIGIBLE,
      validRecoveries21d,
      qualifyingGpsRuns90d: gpsRuns.length,
      reasons,
      gpsRuns,
    };
  }
  if (validRecoveries21d >= m.eligibility.minValidRecoveries) {
    return {
      eligibility: ELIGIBILITY.PASSIVE_ELIGIBLE,
      validRecoveries21d,
      qualifyingGpsRuns90d: gpsRuns.length,
      reasons,
      gpsRuns,
    };
  }
  reasons.push('insufficient_recoveries');
  return {
    eligibility: ELIGIBILITY.INSUFFICIENT_DATA,
    validRecoveries21d,
    qualifyingGpsRuns90d: gpsRuns.length,
    reasons,
    gpsRuns,
  };
}
