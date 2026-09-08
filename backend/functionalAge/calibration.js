import { clamp, roundTo } from './math.js';
import { getMethodology, METHODOLOGY_VERSION } from './methodology.js';

export const CALIBRATION_STATUS = Object.freeze({
  INSUFFICIENT: 'INSUFFICIENT',
  PROVISIONAL: 'PROVISIONAL',
  CALIBRATING: 'CALIBRATING',
  CALIBRATED: 'CALIBRATED',
});

export function isValidRecovery(recovery) {
  const n = Number(recovery);
  return Number.isFinite(n) && n >= 1 && n <= 100;
}

function dayTime(iso) {
  return Date.parse(`${iso}T00:00:00Z`);
}

export function maxValidRecoveriesInWindow(days, windowDays = 31) {
  const dated = (days || [])
    .filter((d) => d?.day)
    .slice()
    .sort((a, b) => a.day.localeCompare(b.day));
  if (!dated.length) return 0;
  let best = 0;
  let j = 0;
  for (let i = 0; i < dated.length; i += 1) {
    while (j < dated.length && dayTime(dated[j].day) - dayTime(dated[i].day) <= (windowDays - 1) * 86400000) {
      j += 1;
    }
    let count = 0;
    for (let k = i; k < j; k += 1) {
      if (isValidRecovery(dated[k].recovery)) count += 1;
    }
    if (count > best) best = count;
  }
  return best;
}

export function coverageFromCounts(counts, methodology) {
  const cal = methodology.calibration;
  const daysObserved = counts.daysObserved || 0;
  const parts = [
    ratio(counts.validSleepDays, daysObserved),
    counts.validStepDays ? ratio(counts.validStepDays, daysObserved) : null,
    ratio(counts.validHrDays, daysObserved),
    ratio(counts.validActivityWeeks, counts.weeksObserved || 0),
    counts.vo2Coverage ? counts.vo2Coverage : null,
    counts.bodyCompositionCoverage ? counts.bodyCompositionCoverage : null,
  ].filter((n) => n != null);
  const overall = parts.length ? parts.reduce((s, n) => s + n, 0) / parts.length : 0;
  return {
    daysObserved,
    validSleepDays: counts.validSleepDays || 0,
    validStepDays: counts.validStepDays || 0,
    validHRDays: counts.validHrDays || 0,
    validActivityWeeks: counts.validActivityWeeks || 0,
    vo2Coverage: roundTo(counts.vo2Coverage || 0, 3),
    bodyCompositionCoverage: roundTo(counts.bodyCompositionCoverage || 0, 3),
    overallCoverage: roundTo(overall, 3),
    validRecoveryDays: counts.validRecoveryDays || 0,
    maxRecoveriesIn31Days: counts.maxRecoveriesIn31Days || 0,
    unlockRecoveries: cal.unlockRecoveries,
  };
}

function ratio(n, d) {
  if (!d) return 0;
  return clamp(n / d, 0, 1);
}

export function calibrationStatus(coverage, methodology = getMethodology(METHODOLOGY_VERSION)) {
  const cal = methodology.calibration;
  const unlocked = (coverage.maxRecoveriesIn31Days || 0) >= cal.unlockRecoveries
    || (coverage.validRecoveryDays || 0) >= cal.unlockRecoveries;
  if (!unlocked) return CALIBRATION_STATUS.INSUFFICIENT;
  const days = coverage.daysObserved || 0;
  if (days < cal.provisionalDays) return CALIBRATION_STATUS.PROVISIONAL;
  if (days < cal.calibratedDays || (coverage.overallCoverage || 0) < cal.calibratedCoverage) {
    return CALIBRATION_STATUS.CALIBRATING;
  }
  return CALIBRATION_STATUS.CALIBRATED;
}

export { getMethodology };
