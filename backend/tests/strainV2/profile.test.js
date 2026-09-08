import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveStrainV2Profile,
  resolveRestingHrBaseline,
  resolveThresholds,
  STRAIN_V2_PROFILE_VERSION,
} from '../../metrics/strainV2/profile.js';

const Y = new Date().getUTCFullYear();
const prof = (extra = {}) => ({ birthYear: Y - 34, ...extra });

test('profile: lab-measured HRmax is highest authority', () => {
  const p = resolveStrainV2Profile({
    profile: { birthYear: Y - 30, hrMaxLab: { value: 197, measuredAt: '2026-01-10', method: 'cpet' } },
    prefs: {}, days: [], currentDay: '2026-08-28',
  });
  assert.equal(p.hrMax.source, 'lab_measured');
  assert.equal(p.hrMax.value, 197);
  assert.equal(p.hrMax.confidence, 'HIGH');
  assert.equal(p.version, STRAIN_V2_PROFILE_VERSION);
});

test('profile: validated field test beats override and observed', () => {
  const p = resolveStrainV2Profile({
    profile: { birthYear: Y - 30, hrMaxFieldTest: { value: 194, measuredAt: '2026-06-01', method: 'field_running' } },
    prefs: { hrMaxOverride: 200 },
    days: [], currentDay: '2026-08-28',
  });
  assert.equal(p.hrMax.source, 'validated_field_test');
  assert.equal(p.hrMax.value, 194);
});

test('profile: field test without measuredAt is NOT validated (falls through)', () => {
  const p = resolveStrainV2Profile({
    profile: { birthYear: Y - 30, hrMaxFieldTest: { value: 194 } },
    prefs: {}, days: [], currentDay: '2026-08-28',
  });
  assert.notEqual(p.hrMax.source, 'validated_field_test');
});

test('profile: single PPG spike cannot redefine HRmax (spike guard)', () => {
  const days = [{
    day: '2026-08-27', rhr: 52,
    bpmData: [{ bpm: 220, datetime: '2026-08-27T10:00:00Z' }],
    workouts: [],
  }];
  const p = resolveStrainV2Profile({ profile: { birthYear: Y - 34 }, prefs: {}, days, currentDay: '2026-08-28' });
  // One outlier sample day: observed chain requires >=2 distinct days or >=3
  // persisted samples; must fall back to Tanaka (208 - 0.7*34 = 184.2).
  assert.equal(p.hrMax.source, 'tanaka_age');
  assert.equal(Math.abs(p.hrMax.value - (208 - 0.7 * 34)) < 0.5, true);
});

test('profile: resting HR baseline uses rolling prior-day median, never today', () => {
  const days = Array.from({ length: 14 }, (_, i) => ({
    day: `2026-08-${String(10 + i).padStart(2, '0')}`,
    rhr: 50 + (i % 2),
  }));
  const b = resolveRestingHrBaseline({ days, currentDay: '2026-08-23', prefs: {}, profile: {} });
  assert.equal(b.source, 'overnight_history_rolling_median');
  assert.equal(b.windowDays, 13); // current day excluded
  assert.equal(b.value, 50); // 13 values (today excluded): 7x50 + 6x51 -> median 50
  // Today's value is not silently folded into the load-scale reference.
  assert.ok(b.windowDays <= 14);
});

test('profile: acute resting HR deviation is recovery context, not load weighting', () => {
  const days = Array.from({ length: 14 }, (_, i) => ({ day: `2026-08-${String(10 + i).padStart(2, '0')}`, rhr: 50 }));
  const p = resolveStrainV2Profile({ profile: { birthYear: Y - 30 }, prefs: {}, days, currentDay: '2026-08-28', acuteRestingHr: 62 });
  assert.equal(p.restingHr.value, 50);
  assert.equal(p.acuteRestingHrDelta, 12);
});

test('profile: RHR falls back to user-entered, then population default with note', () => {
  const a = resolveStrainV2Profile({ profile: { birthYear: Y - 30, restingHr: 48 }, prefs: {}, days: [], currentDay: '2026-08-28' });
  assert.equal(a.restingHr.source, 'user_entered');
  const b = resolveStrainV2Profile({ profile: { birthYear: Y - 30 }, prefs: {}, days: [], currentDay: '2026-08-28' });
  assert.equal(b.restingHr.source, 'population_default');
  assert.ok(b.restingHr.notes.includes('rhr_population_default_insufficient_history'));
});

test('profile: thresholds pass only with trusted provenance and sane bands', () => {
  const ok = resolveThresholds({ profile: { lactateThresholds: { lt1Hr: 140, lt2Hr: 168, source: 'lab_lactate' } }, hrMax: { value: 190 }, restingHr: { value: 55 } });
  assert.equal(ok.lt1Hr, 140);
  assert.equal(ok.source, 'lab_lactate');
  const untrusted = resolveThresholds({ profile: { lactateThresholds: { lt1Hr: 140, source: 'inferred_somehow' } }, hrMax: { value: 190 }, restingHr: { value: 55 } });
  assert.equal(untrusted, null);
  const absurd = resolveThresholds({ profile: { lactateThresholds: { lt2Hr: 300, source: 'lab_cpet' } }, hrMax: { value: 190 }, restingHr: { value: 55 } });
  assert.equal(absurd, null);
});

test('profile: thresholds never silently inferred — default profile has null thresholds', () => {
  const p = resolveStrainV2Profile({ profile: { birthYear: Y - 30 }, prefs: {}, days: [], currentDay: '2026-08-28' });
  assert.equal(p.thresholds, null);
});

test('profile: hrReserve computed and floored at 20', () => {
  const p = resolveStrainV2Profile({
    profile: { birthYear: Y - 30, hrMaxLab: { value: 125 } }, // 125-108=17 < 20 exercises the floor
    prefs: { restingHr: 108 }, // within sane band; 175 - 108 < 20 exercises the floor
    days: [], currentDay: '2026-08-28',
  });
  assert.equal(p.hrReserve, 20);
});
