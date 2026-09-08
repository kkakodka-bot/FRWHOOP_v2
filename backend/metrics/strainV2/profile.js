import { resolveHrMax } from '../../vo2/hrMax.js';
import { tanakaHrMax } from '../../vo2/uth.js';

/**
 * Strain V2 Layer 2 — durable user physiology profile with provenance.
 *
 * Design (see _strain_v2/ARCHITECTURE_DRAFT.md D2):
 * - HRmax source hierarchy (highest authority first):
 *     1. lab_measured          — profile.hrMaxLab (CPET / lab ECG / lactate-verified max)
 *     2. validated_field_test  — profile.hrMaxFieldTest (documented maximal field test)
 *     3. manual_tested         — prefs.hrMaxOverride (resolveHrMax, 120-220 guard)
 *     4. observed_historical   — resolveHrMax credibleObserved (spike-guarded:
 *                                sample peaks > tanaka+10 rejected; needs >=2 distinct
 *                                days or >=3 samples within tolerance) -> a single PPG
 *                                spike can never redefine HRmax
 *     5. personalized_existing — profile.hrMax
 *     6. tanaka_age            — 208 - 0.7*age (Tanaka 2001)
 * - Resting HR load reference is a rolling median of PRIOR-day overnight resting
 *   HR (default window 14 days, min 3 observations). The current day's acute RHR
 *   never silently redefines the load scale; it is reported separately as
 *   acuteRestingHrDelta (recovery context only).
 * - Thresholds are optional and provenance-carrying; ignored unless an explicit
 *   trusted source is present. Never silently inferred from daily data.
 */

export const STRAIN_V2_PROFILE_VERSION = 'strainV2.profile.1';

// Justification: population median resting HR for adults (large-cohort ranges
// 55-70 bpm); used only when no user or history evidence exists. Marked
// population_default so downstream sufficiency state can degrade quality.
export const POPULATION_RHR_DEFAULT = 60;

const RHR_WINDOW_DAYS = 14;
const RHR_MIN_HISTORY_DAYS = 3;

const THRESHOLD_SOURCES = new Set(['lab_cpet', 'lab_lactate', 'user_entered', 'hrv_graded_test']);

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function inRange(n, lo, hi) {
  return n != null && n >= lo && n <= hi;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Rolling resting-HR baseline from PRIOR-day overnight history only.
 * days: [{ day, rhr }] sorted or unsorted; currentDay excluded so today's
 * acute recovery state cannot move the load scale.
 */
export function resolveRestingHrBaseline({ days = [], currentDay = null, prefs = {}, profile = {} } = {}) {
  const notes = [];
  const prior = (days || [])
    .filter((d) => d && (!currentDay || d.day !== currentDay))
    .map((d) => num(d.rhr ?? d.restingHr))
    .filter((n) => inRange(n, 30, 110))
    .slice(-RHR_WINDOW_DAYS);

  if (prior.length >= RHR_MIN_HISTORY_DAYS) {
    return {
      value: Math.round(median(prior) * 10) / 10,
      source: 'overnight_history_rolling_median',
      windowDays: prior.length,
      notes: [],
    };
  }

  const userEntered = num(prefs.restingHr) ?? num(profile.restingHr);
  if (inRange(userEntered, 30, 110)) {
    return {
      value: userEntered,
      source: 'user_entered',
      windowDays: prior.length,
      notes: prior.length
        ? ['insufficient_overnight_history_for_baseline']
        : [],
    };
  }

  return {
    value: POPULATION_RHR_DEFAULT,
    source: 'population_default',
    windowDays: prior.length,
    notes: ['rhr_population_default_insufficient_history'],
  };
}

/**
 * Optional individualized thresholds. Returns null unless an explicit trusted
 * source is present on the profile. Values must sit inside a physiologically
 * defensible band relative to resting and max HR.
 */
export function resolveThresholds({ profile = {}, prefs = {}, hrMax, restingHr } = {}) {
  const src = profile.lactateThresholds || prefs.lactateThresholds || null;
  if (!src || typeof src !== 'object') return null;
  const source = typeof src.source === 'string' ? src.source : null;
  if (!THRESHOLD_SOURCES.has(source)) return null;

  const hrLo = (restingHr?.value ?? 40) + 10;
  const hrHi = (hrMax?.value ?? 210) - 5;
  const pick = (k) => {
    const v = num(src[k]);
    return inRange(v, hrLo, hrHi) ? v : null;
  };
  const thresholds = {
    lt1Hr: pick('lt1Hr'),
    lt2Hr: pick('lt2Hr'),
    vt1Hr: pick('vt1Hr'),
    vt2Hr: pick('vt2Hr'),
  };
  if (thresholds.lt1Hr == null && thresholds.lt2Hr == null
    && thresholds.vt1Hr == null && thresholds.vt2Hr == null) {
    return null;
  }
  return {
    ...thresholds,
    source,
    measuredAt: src.measuredAt || null,
  };
}

export function resolveStrainV2Profile({
  profile = {},
  prefs = {},
  days = [],
  currentDay = null,
  acuteRestingHr = null,
} = {}) {
  const notes = [];

  const birthYear = num(profile.birthYear);
  const age = birthYear != null ? new Date().getUTCFullYear() - birthYear : num(prefs.chronoAge);
  const ageSafe = inRange(age, 13, 100) ? age : null;
  if (ageSafe == null) notes.push('age_unresolved');

  // Tier 1: laboratory measured max (CPET / lab ECG verified).
  const lab = profile.hrMaxLab && typeof profile.hrMaxLab === 'object' ? profile.hrMaxLab : null;
  const labValue = num(lab?.value);
  if (inRange(labValue, 120, 230)) {
    const hrMax = { value: labValue, source: 'lab_measured', confidence: 'HIGH' };
    return finish({ hrMax, profile, prefs, days, currentDay, acuteRestingHr, notes });
  }

  // Tier 2: validated maximal field test (documented hard effort, e.g. race or
  // field max test). Distinguished from a stray PPG spike by requiring an
  // explicit user/lab-entered record with date and method.
  const field = profile.hrMaxFieldTest && typeof profile.hrMaxFieldTest === 'object' ? profile.hrMaxFieldTest : null;
  const fieldValue = num(field?.value);
  if (inRange(fieldValue, 120, 230) && field?.measuredAt) {
    const hrMax = { value: fieldValue, source: 'validated_field_test', confidence: 'HIGH' };
    return finish({ hrMax, profile, prefs, days, currentDay, acuteRestingHr, notes });
  }

  // Tiers 3-6: existing resolveHrMax chain (manual override -> guarded observed
  // peaks -> profile -> Tanaka). The spike ceiling + persistence guards inside
  // credibleObserved satisfy the mission's "a single PPG spike must never
  // redefine HRmax" requirement; enforced by test.
  const resolved = resolveHrMax({
    age: ageSafe ?? 35,
    override: prefs.hrMaxOverride ?? profile.hrMaxOverride ?? null,
    days,
    profileHrMax: profile.hrMax ?? null,
  });
  if (resolved?.value != null) {
    return finish({ hrMax: resolved, profile, prefs, days, currentDay, acuteRestingHr, notes });
  }

  notes.push('hrmax_unavailable');
  return finish({ hrMax: { value: null, source: 'unavailable', confidence: 'LOW' }, profile, prefs, days, currentDay, acuteRestingHr, notes });
}

function finish({ hrMax, profile, prefs, days, currentDay, acuteRestingHr, notes }) {
  const rhr = resolveRestingHrBaseline({ days, currentDay, prefs, profile });

  let acuteDelta = null;
  const acute = num(acuteRestingHr);
  if (acute != null && rhr.value != null) {
    acuteDelta = Math.round((acute - rhr.value) * 10) / 10;
  }

  const thresholds = resolveThresholds({ profile, prefs, hrMax, restingHr: rhr });
  const hrReserve = hrMax.value != null && rhr.value != null
    ? Math.max(hrMax.value - rhr.value, 20)
    : null;

  return {
    age: num(profile.birthYear) != null ? ageFromProfile(profile) : null,
    hrMax,
    restingHr: rhr,
    acuteRestingHrDelta: acuteDelta,
    hrReserve,
    thresholds,
    version: STRAIN_V2_PROFILE_VERSION,
    notes: [...notes, ...rhr.notes],
  };
}

function ageFromProfile(profile) {
  const birthYear = num(profile.birthYear);
  if (birthYear == null) return null;
  return new Date().getUTCFullYear() - birthYear;
}
