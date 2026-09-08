import { finiteNumber } from './math.js';
import { METHODOLOGY_VERSION, getMethodology } from './methodology.js';
import { aggregateWindow } from './aggregation.js';
import { maxValidRecoveriesInWindow, coverageFromCounts, calibrationStatus } from './calibration.js';
import { calculateFunctionalAge } from './engine.js';
import { calculatePaceOfAging } from './pace.js';

export function chronologicalAgeYears(profile = {}, asOfDay) {
  const asOf = asOfDay ? new Date(`${asOfDay}T12:00:00Z`) : new Date();
  const dob = profile.dateOfBirth || profile.date_of_birth;
  if (dob) {
    const bd = new Date(dob);
    if (!Number.isNaN(bd.getTime())) return (asOf.getTime() - bd.getTime()) / (365.25 * 86400000);
  }
  if (profile.birthYear != null) {
    const year = Number(profile.birthYear);
    if (Number.isFinite(year)) {
      const bd = Date.UTC(year, 6, 1);
      return (asOf.getTime() - bd) / (365.25 * 86400000);
    }
  }
  const chrono = finiteNumber(profile.chronoAge ?? profile.chronologicalAge);
  return chrono;
}

export function lastDayOf(days) {
  let last = null;
  for (const d of days || []) {
    if (d?.day && (!last || d.day > last)) last = d.day;
  }
  return last;
}

export function daysFromWhoopMap(map) {
  if (Array.isArray(map)) return map;
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map).map(([day, rec]) => {
    const p = rec?.physiological_summary || {};
    return {
      day,
      ...rec,
      recovery: rec.recovery ?? p['Recovery score %'],
      rhr: rec.rhr ?? p['Resting heart rate (bpm)'],
      asleepMin: rec.asleepMin ?? p['Asleep duration (min)'] ?? rec.sleep_summary?.['Asleep duration (min)'],
      sleepConsistency: rec.sleepConsistency ?? p['Sleep consistency %'] ?? rec.sleep_summary?.['Sleep consistency %'],
      nap: rec.nap ?? rec.sleep_summary?.Nap,
      steps: rec.steps ?? p.Steps ?? p.steps,
      vo2max: rec.vo2max ?? rec.vo2Max ?? p['VO2 Max'],
      workouts: rec.workouts || [],
    };
  }).sort((a, b) => a.day.localeCompare(b.day));
}

export function extraWorkoutsFromStore(store = {}) {
  const out = [];
  for (const a of store.activities || []) {
    out.push({
      date: a.date,
      name: a.name,
      durationMin: a.durationMin,
      zones: a.zones,
      start: a.start,
    });
  }
  return out;
}

function applyProfileMetrics(metrics, profile = {}) {
  const next = { ...metrics };
  const lbm = finiteNumber(profile.leanBodyMassPct ?? profile.lean_body_mass_pct);
  if (next.leanBodyMassPct == null && lbm != null) next.leanBodyMassPct = lbm;
  if (next.leanBodyMassPct == null && finiteNumber(profile.bodyFatPct) != null) {
    next.leanBodyMassPct = 100 - Number(profile.bodyFatPct);
  }
  const vo2 = finiteNumber(profile.vo2Max ?? profile.vo2max);
  if (next.vo2Max == null && vo2 != null) next.vo2Max = vo2;
  return next;
}

function vo2SourceFor(metrics, profile = {}) {
  if (finiteNumber(metrics.vo2Max) == null) return 'unavailable';
  const src = String(profile.vo2MaxSource || metrics.vo2Source || '').toLowerCase();
  if (src) return src;
  if (profile.vo2Max != null || profile.vo2max != null) return 'user_entered';
  return 'whoop_estimated';
}

export function buildHealthspanInput({
  days,
  profile = {},
  extraWorkouts = [],
  asOfDay,
  methodologyVersion = METHODOLOGY_VERSION,
}) {
  const m = getMethodology(methodologyVersion);
  const normalized = daysFromWhoopMap(days);
  const asOf = asOfDay || lastDayOf(normalized);
  if (!asOf) {
    return { error: 'no_days', asOfDay: null };
  }
  const chrono = chronologicalAgeYears(profile, asOf);
  if (!Number.isFinite(chrono) || chrono < 18 || chrono > 100) {
    return { error: 'invalid_age', asOfDay: asOf, chronologicalAge: chrono };
  }

  const historical = aggregateWindow(normalized, extraWorkouts, {
    asOfDay: asOf,
    windowDays: m.windows.historicalDays,
    methodologyVersion,
  });
  const recent = aggregateWindow(normalized, extraWorkouts, {
    asOfDay: asOf,
    windowDays: m.windows.recentDays,
    methodologyVersion,
  });

  const histMetrics = applyProfileMetrics(historical.metrics, profile);
  const recentMetrics = applyProfileMetrics(recent.metrics, profile);
  histMetrics.vo2Source = vo2SourceFor(histMetrics, profile);
  recentMetrics.vo2Source = vo2SourceFor(recentMetrics, profile);

  // Slow physiology: if the 30-day window lacks VO2/LBM, carry the long-window value.
  if (recentMetrics.vo2Max == null) recentMetrics.vo2Max = histMetrics.vo2Max;
  if (recentMetrics.vo2Source === 'unavailable') recentMetrics.vo2Source = histMetrics.vo2Source;
  if (recentMetrics.leanBodyMassPct == null) recentMetrics.leanBodyMassPct = histMetrics.leanBodyMassPct;

  const maxRec31 = maxValidRecoveriesInWindow(normalized, m.calibration.unlockWindowDays);
  const coverage = coverageFromCounts({
    ...historical.counts,
    maxRecoveriesIn31Days: maxRec31,
  }, m);
  coverage.maxRecoveriesIn31Days = maxRec31;
  const status = calibrationStatus(coverage, m);

  return {
    asOfDay: asOf,
    chronologicalAge: chrono,
    sex: profile.sex || 'male',
    methodologyVersion,
    historical,
    recent,
    histMetrics,
    recentMetrics,
    coverage,
    calibrationStatus: status,
  };
}

export function computeHealthspanFromData(params) {
  const built = buildHealthspanInput(params);
  if (built.error) return built;
  const current = calculateFunctionalAge({
    chronologicalAge: built.chronologicalAge,
    sex: built.sex,
    metrics: built.histMetrics,
    confidence: built.historical.confidence,
    methodologyVersion: built.methodologyVersion,
  });
  const pace = calculatePaceOfAging({
    current,
    recentMetrics: built.recentMetrics,
    confidence: built.recent.confidence,
    sex: built.sex,
    chronologicalAge: built.chronologicalAge,
    methodologyVersion: built.methodologyVersion,
  });
  return {
    ...current,
    ...pace,
    asOfDay: built.asOfDay,
    calibrationStatus: built.calibrationStatus,
    coverageDays: built.coverage.daysObserved,
    coverage: built.coverage,
    window: {
      historicalDays: getMethodology(built.methodologyVersion).windows.historicalDays,
      recentDays: getMethodology(built.methodologyVersion).windows.recentDays,
    },
    inputs: {
      historical: built.histMetrics,
      recent: built.recentMetrics,
    },
  };
}
