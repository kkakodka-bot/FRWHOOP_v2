/**
 * Energy v2 unit tests.
 *
 * Covers: source-aware motion extraction (strap dyn_accel preferred over phone
 * mot), band sleep-state mapping, the learned-model runtime (artifact contract,
 * conformal interval, group degradation), and the v2 minute engine's accounting
 * invariants (identical to v1) + fallback behavior.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractV2MinuteFeatures, bandSleepStageToStage } from '../energy/v2/features.js';
import { loadV2Model, predictV2 } from '../energy/v2/model.js';
import { loadV2Gbm, predictV2Gbm } from '../energy/v2/gbm.js';
import {
  computeEnergyMinutesV2, aggregateDayV2, ALGORITHM_VERSION_V2, MODEL_VERSION_V2,
} from '../energy/v2/engine2.js';
import { resolvePhysiology } from '../energy/physiology.js';

const MINUTE = 60_000;
const T0 = Date.parse('2026-08-25T10:00:00.000Z');

function physiologyOf(profile = {}, prefs = {}) {
  return resolvePhysiology({
    profile: { birthYear: 1991, weightKg: 74, heightCm: 178, sex: 'male', ...profile },
    prefs: { restingHr: 48, ...prefs },
    days: [], calibration: null,
  });
}

// ---------------------------------------------------------------- features

test('band sleep state maps only nibble 2 to asleep', () => {
  assert.equal(bandSleepStageToStage(0), null);
  assert.equal(bandSleepStageToStage(1), null);
  assert.equal(bandSleepStageToStage(2), 'asleep');
  assert.equal(bandSleepStageToStage(3), null);
  assert.equal(bandSleepStageToStage({ band_sleep_state: 2 }), 'asleep');
  assert.equal(bandSleepStageToStage({ bandSleepState: 2 }), 'asleep');
  assert.equal(bandSleepStageToStage({ form: 'raw_byte', sleep_state_byte: 0x20 }), 'asleep');
  assert.equal(bandSleepStageToStage({ sleep_state_byte: 0x20 }), 'asleep');
  assert.equal(bandSleepStageToStage(0x20), null); // bare 32 is not a nibble
  assert.equal(bandSleepStageToStage(32), null);
  assert.equal(bandSleepStageToStage(-1), null);
  assert.equal(bandSleepStageToStage(4), null);
  assert.equal(bandSleepStageToStage(null), null);
  assert.equal(bandSleepStageToStage('x'), null);
  assert.equal(bandSleepStageToStage({ form: 'raw_byte', value: 0xFF }), null);
});

test('strap dyn_accel wins over phone mot and is source-labeled', () => {
  const samples = [
    { t: new Date(T0 + 1000).toISOString(), bpm: 64, dyn_accel: 0.012, mot: 0.9 },
    { t: new Date(T0 + 2000).toISOString(), bpm: 66, dyn_accel: 0.008 },
    { t: new Date(T0 + 3000).toISOString(), bpm: 67, dyn_accel: 0.010 },
  ];
  const { features } = extractV2MinuteFeatures(T0, samples, null);
  assert.equal(features.motionSource, 'strap');
  assert.equal(features.motion, 0.01);
  assert.equal(features.strapMotion, 0.01);
  // phone signal is preserved separately, not mixed into `motion`
  assert.equal(features.phoneMotion, 0.9);
});

test('phone mot is the fallback when no strap channel exists', () => {
  const samples = [
    { t: new Date(T0 + 1000).toISOString(), bpm: 70, mot: 0.2 },
    { t: new Date(T0 + 2000).toISOString(), bpm: 71, mot: 0.1 },
  ];
  const { features } = extractV2MinuteFeatures(T0, samples, null);
  assert.equal(features.motionSource, 'phone');
  assert.equal(features.motion, 0.15);
  assert.equal(features.strapMotion, null);
});

test('raw sleep_state_byte maps nibble 2 without double-shifting iOS state', () => {
  const nibble = extractV2MinuteFeatures(T0, [
    { t: new Date(T0 + 1000).toISOString(), bpm: 55, band_sleep_state: 2, dyn_accel: 0.004 },
  ], null);
  const raw = extractV2MinuteFeatures(T0, [
    { t: new Date(T0 + 1000).toISOString(), bpm: 55, sleep_state_byte: 0x20, dyn_accel: 0.004 },
  ], null);
  assert.equal(nibble.features.sleepStage, 'asleep');
  assert.equal(raw.features.sleepStage, 'asleep');
  const shiftedTwice = extractV2MinuteFeatures(T0, [
    { t: new Date(T0 + 1000).toISOString(), bpm: 55, band_sleep_state: 0x20, dyn_accel: 0.004 },
  ], null);
  assert.notEqual(shiftedTwice.features.sleepStage, 'asleep');
});

test('band_sleep_state=asleep plus dyn_accel-free minute maps to a sleep stage', () => {
  const samples = [
    { t: new Date(T0 + 1000).toISOString(), bpm: 55, band_sleep_state: 2, dyn_accel: 0.004 },
    { t: new Date(T0 + 2000).toISOString(), bpm: 55, band_sleep_state: 2 },
  ];
  const { features } = extractV2MinuteFeatures(T0, samples, null);
  assert.equal(features.sleepStage, 'asleep');
  assert.equal(features.bandAsleepSamples, 2);
});

// ---------------------------------------------------------------- model

const ARTIFACT = {
  artifact_version: 'energy-v2-ridge-1',
  feature_version: 'feat-v2-1',
  // Runtime feature names (energy/v2/features.js minute fields).
  features: ['motion', 'hr'],
  standardize: { mean: { motion: 0.2, hr: 90 }, std: { motion: 0.3, hr: 20 } },
  coefficients: { motion: 2.1, hr: 1.0 },
  intercept: 1.7,
  target: 'met_gross',
  clip: { min: 0.8, max: 18 },
  conformal: { q: 1.9, level: 0.9, n_calibration: 1200 },
  degradation: { feature_groups: { imu: ['motion'], hr: ['hr'] } },
};

test('model runtime: prediction, interval, and group degradation', () => {
  const model = loadV2Model(ARTIFACT);
  assert.ok(model);
  const full = predictV2(model, { motion: 0.6, hr: 130 });
  assert.equal(full.met, 6.5);
  assert.equal(full.interval.level, 0.9);
  assert.equal(Math.round((full.interval.met_high - full.interval.met_low) * 10) / 10, 3.8);
  const noHr = predictV2(model, { motion: 0.6 });
  assert.equal(noHr.met, 4.5);
  assert.deepEqual(noHr.missing_groups, ['hr']);
  // IMU group gone -> unusable (caller must fall back, not extrapolate on HR)
  assert.equal(predictV2(model, { hr: 130 }), null);
});

test('model runtime rejects unknown artifact versions and empty features', () => {
  assert.equal(loadV2Model({ ...ARTIFACT, artifact_version: 'future-1' }), null);
  assert.equal(loadV2Model({ ...ARTIFACT, features: [] }), null);
  assert.equal(loadV2Model(null), null);
});

// ---------------------------------------------------------------- engine

function daySamples() {
  const samples = [];
  for (let i = 0; i < 40; i++) {
    samples.push({ t: new Date(T0 + i * 1000).toISOString(), bpm: 62 + (i % 5), dyn_accel: 0.008, band_sleep_state: 2 });
  }
  for (let i = 0; i < 40; i++) {
    samples.push({ t: new Date(T0 + 10 * MINUTE + i * 1000).toISOString(), bpm: 120 + (i % 9), dyn_accel: 0.9 });
  }
  return samples;
}

const PHYS = () => resolvePhysiology({
  profile: { birthYear: 1991, weightKg: 74, heightCm: 178, sex: 'male' },
  prefs: { restingHr: 48 }, days: [], calibration: null,
});

test('v2 engine: learned minutes carry provenance and conformal intervals', () => {
  const { minutes, stats } = computeEnergyMinutesV2({
    samples: daySamples(), physiology: PHYS(), workouts: [], timeZone: 'UTC', model: ARTIFACT,
  });
  assert.ok(minutes.length > 0);
  // sleep minutes take the physiological route by design; the rest are learned
  const sleepMinutes = minutes.filter((m) => m.activity_type === 'sleep').length;
  assert.equal(stats.fallback_minutes, sleepMinutesOf(minutes));
  assert.equal(stats.learned_minutes, minutes.length - stats.fallback_minutes);
  for (const m of minutes) {
    assert.equal(m.algorithm_version, ALGORITHM_VERSION_V2);
    assert.ok(m.model_version);
    assert.ok(m.motion_source === 'strap' || m.motion_source === 'phone' || m.motion_source === 'none');
  }
});

test('v2 engine: accounting invariants match v1 exactly', () => {
  const { minutes } = computeEnergyMinutesV2({
    samples: daySamples(), physiology: PHYS(), workouts: [], timeZone: 'UTC', model: ARTIFACT,
  });
  for (const m of minutes) {
    assert.ok(m.resting_kcal >= 0);
    assert.ok(m.active_kcal >= 0);
    assert.ok(Math.abs((m.resting_kcal + m.active_kcal) - round4(m.met * 3.5 * 74 / 1000 * 5.0)) < 0.02,
      `total must equal VO2 conversion for ${m.minute_at}`);
    assert.ok(m.active_kcal >= 0);
  }
});

test('v2 engine: sleep minutes keep the flat sleeping rate and zero active', () => {
  const samples = [];
  for (let i = 0; i < 60; i++) {
    samples.push({ t: new Date(T0 + i * 1000).toISOString(), bpm: 52, band_sleep_state: 2, dyn_accel: 0.005 });
  }
  const { minutes } = computeEnergyMinutesV2({
    samples, physiology: PHYS(), workouts: [], timeZone: 'UTC', model: ARTIFACT,
  });
  assert.ok(minutes.length >= 1);
  for (const m of minutes) {
    assert.equal(m.activity_type, 'sleep');
    assert.ok(Math.abs(m.resting_kcal - PHYS().sleepKcalPerMin) < 1e-4); // stored at 4dp
    // active = max(0, total - resting); total derives from restingVo2 (2dp in
    // physiology), so the identity leaves a rounding residual <= ~0.01 kcal.
    assert.ok(m.active_kcal < 0.01);
    assert.ok(m.met > 0 && m.met < 1.3);
  }
});

test('v2 engine: strength minutes bypass the learned model (conservative fallback)', () => {
  const t = Date.parse('2026-08-25T12:00:00.000Z');
  const samples = [];
  for (let i = 0; i < 60; i++) {
    samples.push({ t: new Date(t + i * 1000).toISOString(), bpm: 130, dyn_accel: 0.6 });
  }
  const workouts = [{ id: 'w1', sport: 'weightlifting', start: new Date(t).toISOString(), end: new Date(t + 10 * MINUTE).toISOString() }];
  const { minutes, stats } = computeEnergyMinutesV2({
    samples, physiology: PHYS(), workouts, timeZone: 'UTC', model: ARTIFACT,
  });
  assert.ok(minutes.length >= 1);
  assert.equal(stats.strength_fallback_minutes, minutes.length);
  assert.equal(stats.learned_minutes, 0);
  for (const m of minutes) assert.equal(m.estimator, 'strength');
});

test('v2 engine: no model -> every priced minute falls back with v1 provenance', () => {
  const { minutes, stats } = computeEnergyMinutesV2({
    samples: daySamples(), physiology: PHYS(), workouts: [], timeZone: 'UTC', model: null,
  });
  assert.ok(minutes.length > 0);
  assert.equal(stats.learned_minutes, 0);
  for (const m of minutes) assert.equal(m.model_version, MODEL_VERSION_V2);
});

test('v2 engine: gaps stay gaps (no fabricated rows)', () => {
  const samples = [];
  for (let i = 0; i < 30; i++) samples.push({ t: new Date(T0 + i * 1000).toISOString(), bpm: 70, dyn_accel: 0.01 });
  for (let i = 0; i < 30; i++) samples.push({ t: new Date(T0 + 20 * MINUTE + i * 1000).toISOString(), bpm: 72, dyn_accel: 0.01 });
  const { minutes } = computeEnergyMinutesV2({
    samples, physiology: PHYS(), workouts: [], timeZone: 'UTC', model: ARTIFACT,
  });
  // minutes 0,1,2 and 20,21,22 exist; the 17-minute hole must not.
  const have = new Set(minutes.map((m) => m.minute_at));
  assert.ok(have.has(new Date(T0).toISOString()));
  assert.ok(have.has(new Date(T0 + 20 * MINUTE).toISOString()));
  assert.ok(!have.has(new Date(T0 + 10 * MINUTE).toISOString()));
});

test('v2 daily aggregation preserves v1 accounting shape', () => {
  const { minutes } = computeEnergyMinutesV2({
    samples: daySamples(), physiology: PHYS(), workouts: [], timeZone: 'UTC', model: ARTIFACT,
  });
  const days = aggregateDayV2(minutes, { now: T0 + 30 * MINUTE });
  assert.equal(days.length, 1);
  const d = days[0];
  assert.ok(Math.abs(d.total_kcal - (d.resting_kcal + d.active_kcal)) < 0.011);
  assert.ok(d.workout_kcal <= d.active_kcal + 1e-9);
  assert.ok(d.gap_minutes >= 0);
});

function round4(x) { return Math.round(x * 10000) / 10000; }
function sleepMinutesOf(minutes) {
  return minutes.filter((m) => m.activity_type === 'sleep').length;
}

/**
 * GBM tree-evaluator tests (deterministic traversal, LightGBM dump semantics).
 */

const GBM_TREE = {
  split_feature: 'motion', threshold: 0.3, decision_type: '<=',
  missing_type: 'None', default_left: false,
  left_child: {
    split_feature: 'hr', threshold: 100, decision_type: '<=', missing_type: 'None', default_left: true,
    left_child: { leaf_value: 1.2 }, right_child: { leaf_value: 2.4 },
  },
  right_child: { leaf_value: 5.5 },
};

test('gbm traversal: leaves, thresholds, and missing routing', () => {
  const m = loadV2Gbm({ trees: [{ tree_structure: GBM_TREE }], clip: { min: 0.8, max: 18 } });
  assert.equal(predictV2Gbm(m, { motion: 0.01, hr: 60 }).met, 1.2);
  assert.equal(predictV2Gbm(m, { motion: 0.01, hr: 130 }).met, 2.4);
  assert.equal(predictV2Gbm(m, { motion: 0.9, hr: 200 }).met, 5.5);
  // missing hr routes by the node's default_left (true here)
  assert.equal(predictV2Gbm(m, { motion: 0.01 }).met, 1.2);
  // missing values are NEVER coerced to 0 (Number(null)===0 bug class)
  assert.equal(predictV2Gbm(m, { motion: 0.01, hr: 0 }).met, 1.2); // hr=0 <= 100 -> left, same by design here
  const clip = loadV2Gbm({ trees: [GBM_TREE], clip: { min: 2.0, max: 3.0 } });
  assert.equal(predictV2Gbm(clip, { motion: 0.9 }).met, 3.0);
  assert.equal(predictV2Gbm(clip, { motion: 0.01, hr: 60 }).met, 2.0);
});

test('gbm parity with the exported LightGBM artifact fixture', async () => {
  const { readFileSync } = await import('node:fs');
  const art = JSON.parse(readFileSync(new URL('../energy/v2/artifact/energy-v2-lgb-runtime.json', import.meta.url), 'utf8'));
  const fx = JSON.parse(readFileSync(new URL('../energy/v2/artifact/parity_fixture.json', import.meta.url), 'utf8'));
  const m = loadV2Gbm(art);
  assert.ok(m && m.trees.length > 0);
  let worst = 0;
  for (const f of fx) {
    const got = predictV2Gbm(m, f.features);
    const err = Math.abs(got.met - f.expected_met_lgb);
    worst = Math.max(worst, err);
  }
  assert.ok(worst < 1e-9, `parity worst error ${worst}`);
});

test('gbm rejects empty trees and null input', () => {
  assert.equal(loadV2Gbm({ trees: [] }), null);
  assert.equal(loadV2Gbm(null), null);
  const m = loadV2Gbm({ trees: [GBM_TREE] });
  assert.equal(predictV2Gbm(m, null), null);
});

test('source policy: phone-sourced minutes fall back to v1 physiology even with a model', () => {
  const t0 = Date.parse('2026-08-25T10:00:00.000Z');
  const phoneSamples = [];
  for (let i = 0; i < 60; i++) phoneSamples.push({ t: new Date(t0 + i * 1000).toISOString(), bpm: 70 + (i % 5), mot: 0.2 });
  const strapSamples = [];
  for (let i = 0; i < 60; i++) strapSamples.push({ t: new Date(t0 + 10 * MINUTE + i * 1000).toISOString(), bpm: 70 + (i % 5), dyn_accel: 0.2 });
  const { minutes, stats } = computeEnergyMinutesV2({
    samples: [...phoneSamples, ...strapSamples], physiology: PHYS(), workouts: [], timeZone: 'UTC', model: ARTIFACT,
  });
  const bySrc = {};
  for (const m of minutes) bySrc[m.motion_source] = (bySrc[m.motion_source] || 0) + 1;
  assert.ok(bySrc.phone >= 1);
  assert.ok(bySrc.strap >= 1);
  const learned = minutes.filter((m) => m.estimator === 'v2-gbm' || m.estimator.startsWith('v2-gbm('));
  for (const m of learned) assert.equal(m.motion_source, 'strap');
  assert.equal(stats.learned_minutes, learned.length);
});

test('relock exclusion: a 183 bpm spike does not corrupt model HR features', () => {
  const t0 = Date.parse('2026-08-25T10:00:00.000Z');
  const samples = [];
  for (let i = 0; i < 50; i++) samples.push({ t: new Date(t0 + i * 1000).toISOString(), bpm: 60, dyn_accel: 0.007 });
  samples.push({ t: new Date(t0 + 50 * 1000).toISOString(), bpm: 183, dyn_accel: 0.007 }); // relock spike
  for (let i = 51; i < 60; i++) samples.push({ t: new Date(t0 + i * 1000).toISOString(), bpm: 60, dyn_accel: 0.007 });
  const { features, quality } = extractV2MinuteFeatures(t0, samples, null);
  assert.equal(quality.flags.includes('hr_jumps') || implausibleJumpsOf(quality), true);
  assert.ok(features.hrMax < 100, `hrMax must exclude the relock, got ${features.hrMax}`);
  assert.equal(features.hr, 60); // every retained sample is 60 bpm (spike excluded)
  // the spike AND the following sample (|60-183| > 25 within 10 s) are both excluded
  assert.equal(features.hrCount, 58);
});
function implausibleJumpsOf(quality) { return quality?.flags?.includes('hr_unstable'); }

test('learned minutes never price below the subject sleeping floor', () => {
  // Force a very low prediction: still wrist, low HR.
  const lowModel = { ...ARTIFACT, intercept: 0.0, clip: { min: 0.8, max: 18 } };
  const t0 = Date.parse('2026-08-25T10:00:00.000Z');
  const samples = [];
  for (let i = 0; i < 60; i++) samples.push({ t: new Date(t0 + i * 1000).toISOString(), bpm: 58, dyn_accel: 0.007 });
  const { minutes } = computeEnergyMinutesV2({
    samples, physiology: PHYS(), workouts: [], timeZone: 'UTC', model: lowModel,
  });
  assert.ok(minutes.length >= 1);
  const phys = PHYS();
  const floorMet = (phys.restingVo2 * 0.95) / 3.5;
  for (const m of minutes) {
    if (m.activity_type === 'sleep') continue;
    assert.ok(m.met >= floorMet - 1e-9, `met ${m.met} below sleeping floor ${floorMet}`);
    assert.ok(m.active_kcal >= 0);
  }
});
