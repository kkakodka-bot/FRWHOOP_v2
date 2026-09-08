/**
 * Energy v2 service-integration tests: feature flag, shadow mode, mode 'on'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeEnergy, computeEnergyV2, v2ModeOf, loadV2ArtifactCached, __resetV2ArtifactCache } from '../energy/service.js';
import { resolveObservedRestingHr } from '../energy/v2/restingHr.js';
import { resolvePhysiology } from '../energy/physiology.js';

const T0 = Date.parse('2026-08-25T10:00:00.000Z');
const MINUTE = 60_000;

const PROFILE = { birthYear: 1991, weightKg: 74, heightCm: 178, sex: 'male' };
const PREFS = { restingHr: 48 };

const ARTIFACT = {
  artifact_version: 'energy-v2-ridge-1',
  feature_version: 'feat-v2-1',
  features: ['motion', 'hr'],
  standardize: { mean: { motion: 0.2, hr: 90 }, std: { motion: 0.3, hr: 20 } },
  coefficients: { motion: 2.1, hr: 1.0 },
  intercept: 1.7,
  target: 'met_gross',
  clip: { min: 0.8, max: 18 },
  conformal: { q: 1.9, level: 0.9 },
  degradation: { feature_groups: { imu: ['motion'], hr: ['hr'] } },
};

function samples() {
  const out = [];
  for (let i = 0; i < 45; i++) {
    out.push({ t: new Date(T0 + i * 1000).toISOString(), bpm: 120 + (i % 7), motion: 0.8 });
  }
  for (let i = 0; i < 45; i++) {
    out.push({ t: new Date(T0 + 10 * MINUTE + i * 1000).toISOString(), bpm: 64, motion: 0.006 });
  }
  return out;
}

test('v2ModeOf defaults to off and validates', () => {
  assert.equal(v2ModeOf({}), 'off');
  assert.equal(v2ModeOf({ ENERGY_MODEL_V2: 'shadow' }), 'shadow');
  assert.equal(v2ModeOf({ ENERGY_MODEL_V2: 'on' }), 'on');
  assert.equal(v2ModeOf({ ENERGY_MODEL_V2: 'bogus' }), 'off');
});

test('off mode is byte-identical to computeEnergy()', () => {
  const a = computeEnergy({ samples: samples(), profile: PROFILE, prefs: PREFS, timeZone: 'UTC', userId: 'u1' });
  const b = computeEnergyV2({ samples: samples(), profile: PROFILE, prefs: PREFS, timeZone: 'UTC', userId: 'u1', mode: 'off' });
  assert.deepEqual(b.rows, a.rows);
  assert.deepEqual(b.daily, a.daily);
  assert.equal(b.shadow, undefined);
});

test('shadow mode keeps v1 rows authoritative and records the comparison', () => {
  const r = computeEnergyV2({
    samples: samples(), profile: PROFILE, prefs: PREFS, timeZone: 'UTC',
    userId: 'u1', mode: 'shadow', artifact: ARTIFACT,
  });
  assert.ok(r.shadow);
  assert.ok(Number.isFinite(r.shadow.cand_total_kcal));
  assert.ok(Number.isFinite(r.shadow.prod_total_kcal));
  assert.equal(Math.round((r.shadow.cand_total_kcal - r.shadow.prod_total_kcal) * 100) / 100, r.shadow.delta_total_kcal);
  // authoritative rows are still v1
  const v1 = computeEnergy({ samples: samples(), profile: PROFILE, prefs: PREFS, timeZone: 'UTC', userId: 'u1' });
  assert.deepEqual(r.rows, v1.rows);
});

test('on mode makes v2 minutes authoritative with v2 provenance', () => {
  const r = computeEnergyV2({
    samples: samples(), profile: PROFILE, prefs: PREFS, timeZone: 'UTC',
    userId: 'u1', mode: 'on', artifact: ARTIFACT,
  });
  assert.ok(r.minutes.length >= 2);
  for (const m of r.minutes) assert.equal(m.algorithm_version, '2.0.0');
  assert.ok(!('shadow' in r));
  // daily rollup preserves the v1 accounting identity
  const d = r.daily[0];
  assert.ok(Math.abs(d.total_kcal - (d.resting_kcal + d.active_kcal)) < 0.011);
  assert.ok(d.workout_kcal <= d.active_kcal + 1e-9);
});

test('on mode with no loadable artifact degrades to v1', () => {
  __resetV2ArtifactCache();
  try {
    const r = computeEnergyV2({
      samples: samples(), profile: PROFILE, prefs: PREFS, timeZone: 'UTC',
      userId: 'u1', mode: 'on', artifact: { broken: true },
    });
    const v1 = computeEnergy({ samples: samples(), profile: PROFILE, prefs: PREFS, timeZone: 'UTC', userId: 'u1' });
    assert.deepEqual(r.rows, v1.rows);
  } finally {
    __resetV2ArtifactCache(); // restore the production artifact for other tests
  }
});

test('the committed runtime artifact loads and is the lgb shadow candidate', () => {
  const m = loadV2ArtifactCached();
  assert.ok(m);
  assert.equal(m.model_version, 'energy-v2-lgb-runtime-1');
  assert.ok(m.trees.length > 0);
});

test('observed resting HR: derived from daily floors with enough days', () => {
  const days = [];
  for (let d = 0; d < 5; d++) {
    const bpmData = [];
    for (let i = 0; i < 200; i++) bpmData.push({ bpm: 46 + ((i * 7) % 50) });
    days.push({ day: '2026-08-2' + d, bpmData });
  }
  const obs = resolveObservedRestingHr(days);
  assert.ok(obs && obs.value >= 25 && obs.value <= 130);
  assert.equal(obs.source, 'observed_daily_floor');
  assert.ok(obs.daysUsed >= 3);
});

test('observed resting HR: refuses to invent with sparse history', () => {
  assert.equal(resolveObservedRestingHr([]), null);
  const oneDay = [{ day: 'd', bpmData: Array.from({ length: 200 }, (_, i) => ({ bpm: 50 + (i % 30) })) }];
  assert.equal(resolveObservedRestingHr(oneDay), null);
});

test('computeEnergyV2 falls back to observed resting HR when profile lacks one', () => {
  const days = [];
  for (let d = 0; d < 5; d++) {
    days.push({ day: '2026-08-2' + d, bpmData: Array.from({ length: 200 }, (_, i) => ({ bpm: 47 + ((i * 7) % 40) })) });
  }
  const r = computeEnergyV2({
    samples: samples(), profile: PROFILE, prefs: {}, days, timeZone: 'UTC', userId: 'u1', mode: 'off',
  });
  assert.ok(r.physiology.restingHr >= 25 && r.physiology.restingHr <= 130);
  assert.ok(r.physiology.notes.includes('resting_hr_observed_daily_floor'));
});
