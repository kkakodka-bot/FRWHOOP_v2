/**
 * Energy V3: placement, replay, IMU features, V1 fallback, accounting, shadow isolation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveWearLocation, appendWearLocationEvent, stampLiveWearLocation,
} from '../energy/v3/placement.js';
import { gravityRemoved } from '../energy/imuFeatures.js';
import { computeEnergyMinutesV3 } from '../energy/v3/engine3.js';
import { computeEnergyMinutes, aggregateDay } from '../energy/engine.js';
import { computeEnergy, computeEnergyV3, v3ModeOf } from '../energy/service.js';
import { resolvePhysiology } from '../energy/physiology.js';
import { encodeImuArchive, decodeImuArchive, imuRecordFromFrame, IMU_ARCHIVE_SCHEMA, ACCEL_SCALE_G_PER_LSB, GYRO_SCALE_DPS_PER_LSB } from '../protocol/imuArchive.js';
import { deriveRecords } from '../redecode/derive.js';
import { routeV3Minute } from '../energy/v3/router.js';
import { selectImuForEnergyV3 } from '../energy/v3/imuEvidence.js';
import { notifyOf } from './fixtures/whoopFrames.mjs';
import { decodeFrame } from '../protocol/decoder.js';
import { normalizeSample } from '../ingest/archiveFormat.js';
import { extractMinuteImuFeatures } from '../energy/v3/windows.js';
import { mergeWearLocationEvents } from '../energy/v3/placement.js';
import { applyWorkoutRuntimePrefs } from '../host/runtimePrefs.js';
import { createMetricsEngine } from '../metrics/engine.js';
import { refuseNonCartLabel, wristHzToImuRecords, scoreFrozenMinute, isCartGroundTruthColumn, discoverInlab } from '../energy/v3/habitsInlab.js';
import { accelToG, resampleCopy, harmonizeImu } from '../energy/v3/preprocess.js';
import { refuseVendorLabel } from '../energy/v3/datasets.js';
import { loadV3ArtifactCached, __resetV3ArtifactCache, predictFamily, composeV3Features } from '../energy/v3/models.js';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const T0 = Date.parse('2026-08-25T10:00:00.000Z');
const MINUTE = 60_000;
const PROFILE = { birthYear: 1991, weightKg: 74, heightCm: 178, sex: 'male' };
const PREFS = { restingHr: 48 };

function physiology() {
  return resolvePhysiology({ profile: PROFILE, prefs: PREFS, days: [], calibration: null });
}

function hrSamples({ minutes = 3, bpm = 72, motion = 0.01, wear_location, wear_location_source, t0 = T0 } = {}) {
  const out = [];
  for (let m = 0; m < minutes; m++) {
    for (let i = 0; i < 45; i++) {
      out.push({
        t: new Date(t0 + m * MINUTE + i * 1000).toISOString(),
        bpm,
        motion,
        wear_location,
        wear_location_source,
      });
    }
  }
  return out;
}

function imuSecond(tMs, {
  swingAmp = 0.5, rest = false, gyroAmp = 0, n = 100, sample_rate_hz,
} = {}) {
  const accel_x = [], accel_y = [], accel_z = [];
  const gyro_x = [], gyro_y = [], gyro_z = [];
  const aScale = 1 / ACCEL_SCALE_G_PER_LSB;
  const gScale = 1 / GYRO_SCALE_DPS_PER_LSB;
  for (let i = 0; i < n; i++) {
    const phase = 2 * Math.PI * 1.4 * (i / n);
    const ax = rest ? 0.02 : swingAmp * Math.sin(phase);
    const ay = rest ? 0 : 0.05;
    const az = rest ? 1 : 1 + 0.2 * Math.sin(phase);
    accel_x.push(Math.round(ax * aScale));
    accel_y.push(Math.round(ay * aScale));
    accel_z.push(Math.round(az * aScale));
    gyro_x.push(Math.round(gyroAmp * Math.sin(phase) * gScale));
    gyro_y.push(0);
    gyro_z.push(Math.round(gyroAmp * 0.4 * Math.cos(phase) * gScale));
  }
  return {
    schema: IMU_ARCHIVE_SCHEMA,
    sensor_ts: tMs / 1000,
    sample_rate_hz,
    accel_x, accel_y, accel_z, gyro_x, gyro_y, gyro_z,
    accel: { scale_g_per_lsb: ACCEL_SCALE_G_PER_LSB },
    gyro: { scale_dps_per_lsb: GYRO_SCALE_DPS_PER_LSB },
  };
}

function imuMinute(t0 = T0, seconds = 30, opts = {}) {
  const recs = [];
  for (let s = 0; s < seconds; s++) recs.push(imuSecond(t0 + s * 1000, opts));
  return recs;
}

test('v3ModeOf defaults to off', () => {
  assert.equal(v3ModeOf({}), 'off');
  assert.equal(v3ModeOf({ ENERGY_MODEL_V3: 'shadow' }), 'shadow');
  assert.equal(v3ModeOf({ ENERGY_MODEL_V3: 'on' }), 'on');
  assert.equal(v3ModeOf({ ENERGY_MODEL_V3: 'nope' }), 'off');
});

test('placement: stamped sample wins over later toggle', () => {
  const events = appendWearLocationEvent([], 'bicep', new Date('2026-08-25T12:00:00Z'));
  const sample = { t: '2026-08-25T10:00:00Z', wear_location: 'wrist', wear_location_source: 'user' };
  const r = resolveWearLocation({ sample, events, t: sample.t });
  assert.equal(r.location, 'wrist');
  assert.equal(r.source, 'user');
});

test('placement: unstamped history uses event-time, not the live toggle', () => {
  let events = appendWearLocationEvent([], 'wrist', new Date('2026-08-25T08:00:00Z'));
  events = appendWearLocationEvent(events, 'bicep', new Date('2026-08-25T12:00:00Z'));
  const before = resolveWearLocation({ sample: { t: '2026-08-25T09:00:00Z' }, events });
  const after = resolveWearLocation({ sample: { t: '2026-08-25T13:00:00Z' }, events });
  assert.equal(before.location, 'wrist');
  assert.equal(after.location, 'bicep');
  const legacy = resolveWearLocation({ sample: { t: '2026-08-24T09:00:00Z' }, events: [] });
  assert.equal(legacy.location, 'wrist');
  assert.equal(legacy.source, 'legacy_default');
});

test('placement: append-only events never rewrite the past', () => {
  const t0 = new Date('2026-08-25T10:00:00Z');
  const events = appendWearLocationEvent([], 'wrist', t0);
  const again = appendWearLocationEvent(events, 'wrist', new Date('2026-08-25T11:00:00Z'));
  assert.equal(again.length, 1);
  const flipped = appendWearLocationEvent(events, 'bicep', new Date('2026-08-25T11:00:00Z'));
  assert.equal(flipped.length, 2);
  assert.equal(flipped[0].location, 'wrist');
  assert.equal(flipped[1].location, 'bicep');
});

test('live stamp does not invent a location when unset', () => {
  assert.equal(stampLiveWearLocation(null), null);
  assert.deepEqual(stampLiveWearLocation('bicep'), {
    wear_location: 'bicep', wear_location_source: 'user',
  });
});

test('gravity-removed magnitude is near zero at rest', () => {
  const ax = [0.02, 0.01, -0.01, 0, 0.02];
  const ay = [0, 0, 0, 0, 0];
  const az = [1, 0.99, 1.01, 1, 0.98];
  const g = gravityRemoved(ax, ay, az);
  const mag = g.dx.map((x, i) => Math.sqrt(x * x + g.dy[i] ** 2 + g.dz[i] ** 2));
  const mean = mag.reduce((a, b) => a + b, 0) / mag.length;
  assert.ok(mean < 0.05, `rest dyn mag ${mean}`);
});

test('off mode is identical to V1 persist rows', () => {
  const samples = hrSamples({ minutes: 2, bpm: 110, motion: 0.4 });
  const a = computeEnergy({ samples, profile: PROFILE, prefs: PREFS, timeZone: 'UTC', userId: 'u1' });
  const b = computeEnergyV3({
    samples, profile: PROFILE, prefs: PREFS, timeZone: 'UTC', userId: 'u1', mode: 'off',
  });
  assert.deepEqual(b.rows, a.rows);
  assert.equal(b.shadow, undefined);
});

test('shadow keeps V1 rows and isolates the candidate', () => {
  const samples = hrSamples({ minutes: 2, bpm: 110, motion: 0.4 });
  const v1 = computeEnergy({ samples, profile: PROFILE, prefs: PREFS, timeZone: 'UTC', userId: 'u1' });
  const r = computeEnergyV3({
    samples, profile: PROFILE, prefs: PREFS, timeZone: 'UTC', userId: 'u1', mode: 'shadow',
  });
  assert.deepEqual(r.rows, v1.rows);
  assert.ok(r.shadow);
  assert.ok(Number.isFinite(r.shadow.prod_total_kcal));
  assert.ok(Number.isFinite(r.shadow.cand_total_kcal));
  for (const m of r.minutes) {
    assert.equal(m.algorithm_version, '1.0.0');
  }
});

test('missing IMU falls back to V1 with explicit provenance', () => {
  const samples = hrSamples({ minutes: 2, bpm: 120, motion: 0.3, wear_location: 'wrist', wear_location_source: 'user' });
  const { minutes, stats } = computeEnergyMinutesV3({
    samples, physiology: physiology(), timeZone: 'UTC', imuRecords: [],
  });
  assert.ok(minutes.length >= 1);
  for (const m of minutes) {
    assert.match(m.estimator, /^v1-fallback:missing_imu$/);
    assert.equal(m.wear_location, 'wrist');
    assert.ok(m.resting_kcal > 0);
    assert.ok(m.active_kcal >= 0);
  }
  assert.ok(stats.fallback_minutes >= 1);
  assert.equal(stats.imu_minutes, 0);
});

test('bicep uses V1 physiology fallback, never a calorie multiplier', () => {
  const wrist = hrSamples({ minutes: 2, bpm: 130, motion: 0.8, wear_location: 'wrist', wear_location_source: 'user' });
  const bicep = hrSamples({ minutes: 2, bpm: 130, motion: 0.8, wear_location: 'bicep', wear_location_source: 'user' });
  const w = computeEnergyMinutesV3({ samples: wrist, physiology: physiology(), timeZone: 'UTC' });
  const b = computeEnergyMinutesV3({ samples: bicep, physiology: physiology(), timeZone: 'UTC' });
  assert.ok(b.minutes.length);
  for (const m of b.minutes) {
    assert.equal(m.estimator, 'v1-fallback:bicep_unvalidated');
    assert.equal(m.wear_location, 'bicep');
  }
  const wr = w.minutes.reduce((s, m) => s + m.resting_kcal, 0);
  const br = b.minutes.reduce((s, m) => s + m.resting_kcal, 0);
  assert.ok(Math.abs(wr - br) < 1e-6, 'RMR is placement-independent');
  const ratio = b.minutes[0].active_kcal / Math.max(w.minutes[0].active_kcal, 1e-6);
  assert.ok(Math.abs(ratio - 1.15) > 0.02 && Math.abs(ratio - 0.85) > 0.02, 'no fixed bicep multiplier');
});

test('wrist IMU path tags a V3 family estimator and keeps accounting identity', () => {
  const samples = hrSamples({ minutes: 1, bpm: 62, motion: 0, wear_location: 'wrist', wear_location_source: 'user' });
  const imuRecords = [];
  for (let s = 0; s < 30; s++) imuRecords.push(imuSecond(T0 + s * 1000, { rest: true }));
  const { minutes } = computeEnergyMinutesV3({
    samples, physiology: physiology(), timeZone: 'UTC', imuRecords,
  });
  assert.ok(minutes.length >= 1);
  assert.equal(minutes[0].estimator, 'v3-imu-sedentary');
  assert.equal(minutes[0].algorithm_version, '3.1.0');
  assert.ok(minutes[0].debug.activity_model);
  assert.equal(minutes[0].debug.criterion_uncertainty, 'unavailable');
  const m = minutes[0];
  assert.ok(m.resting_kcal > 0);
  assert.ok(m.active_kcal >= 0);
  assert.ok(m.met >= 0.8 && m.met <= 20);
});

test('replay of stamped wrist minutes is unchanged after a later bicep event', () => {
  const samples = [
    ...hrSamples({
      minutes: 1, bpm: 90, t0: T0,
      wear_location: 'wrist', wear_location_source: 'user',
    }),
    ...hrSamples({
      minutes: 1, bpm: 90, t0: T0 + 2 * MINUTE,
      wear_location: 'bicep', wear_location_source: 'user',
    }),
  ];
  const events = appendWearLocationEvent(
    [{ at: new Date(T0 - 3600_000).toISOString(), location: 'wrist' }],
    'bicep',
    new Date(T0 + MINUTE + 30_000),
  );
  const { minutes } = computeEnergyMinutesV3({
    samples, physiology: physiology(), timeZone: 'UTC', wearLocationEvents: events,
  });
  const first = minutes.find((m) => Date.parse(m.minute_at) === T0);
  const later = minutes.find((m) => Date.parse(m.minute_at) === T0 + 2 * MINUTE);
  assert.equal(first.wear_location, 'wrist');
  assert.equal(later.wear_location, 'bicep');
});

test('normalizeSample does not apply a current global to unstamped history', () => {
  const row = normalizeSample({ t: '2026-08-20T10:00:00Z', bpm: 64 });
  assert.equal(row.wear_location, null);
});

test('V3 on mode uses v3 provenance; resting+active identity holds', () => {
  const samples = hrSamples({ minutes: 2, bpm: 100, motion: 0.2 });
  const r = computeEnergyV3({
    samples, profile: PROFILE, prefs: PREFS, timeZone: 'UTC', userId: 'u1', mode: 'on',
  });
  assert.ok(r.minutes.length);
  for (const m of r.minutes) assert.equal(m.algorithm_version, '3.1.0');
  const d = r.daily[0];
  assert.ok(Math.abs(d.total_kcal - (d.resting_kcal + d.active_kcal)) < 0.02);
});

function v1ByMinute(samples) {
  return new Map(computeEnergyMinutes({
    samples, physiology: physiology(), timeZone: 'UTC',
  }).minutes.map((m) => [m.minute_at, m]));
}

test('missing IMU V3 kcal matches V1 per minute_at', () => {
  const samples = hrSamples({ minutes: 2, bpm: 120, motion: 0.3, wear_location: 'wrist', wear_location_source: 'user' });
  const v1 = v1ByMinute(samples);
  const { minutes } = computeEnergyMinutesV3({
    samples, physiology: physiology(), timeZone: 'UTC', imuRecords: [],
  });
  assert.ok(minutes.length);
  for (const m of minutes) {
    const a = v1.get(m.minute_at);
    assert.ok(a, m.minute_at);
    assert.equal(m.resting_kcal, a.resting_kcal);
    assert.equal(m.active_kcal, a.active_kcal);
    assert.equal(m.met, a.met);
    assert.equal(m.estimator, 'v1-fallback:missing_imu');
  }
});

test('bicep with six-axis IMU never enters the wrist estimator', () => {
  const samples = hrSamples({ minutes: 1, bpm: 140, motion: 0.8, wear_location: 'bicep', wear_location_source: 'user' });
  const { minutes } = computeEnergyMinutesV3({
    samples, physiology: physiology(), timeZone: 'UTC', imuRecords: imuMinute(T0, 30, { swingAmp: 0.8 }),
  });
  assert.ok(minutes.length);
  for (const m of minutes) {
    assert.equal(m.estimator, 'v1-fallback:bicep_unvalidated');
    assert.ok(!String(m.estimator).startsWith('v3-imu') && !String(m.estimator).startsWith('v3-hr'));
  }
});

test('shadow V3 exception leaves V1 rows byte-equal', () => {
  const samples = hrSamples({ minutes: 2, bpm: 110, motion: 0.4 });
  const v1 = computeEnergy({ samples, profile: PROFILE, prefs: PREFS, timeZone: 'UTC', userId: 'u1' });
  class Boom extends Array {
    filter() { throw new Error('v3_boom'); }
  }
  const r = computeEnergyV3({
    samples, profile: PROFILE, prefs: PREFS, timeZone: 'UTC', userId: 'u1',
    mode: 'shadow', imuRecords: new Boom(imuSecond(T0)),
  });
  assert.deepEqual(r.rows, v1.rows);
  assert.equal(r.shadow.error, 'v3_exception');
  for (const m of r.minutes) assert.equal(m.algorithm_version, '1.0.0');
});

test('real v21 six-axis arrays reach V3 features with correct rate and near-still gyro', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fx = JSON.parse(readFileSync(path.join(here, 'fixtures/noop-whoop5-parity.json'), 'utf8'));
  const frame = Buffer.from(fx.v21_real.hex, 'hex');
  const rec = imuRecordFromFrame(frame, 'puffin', { receivedAt: new Date(T0).toISOString() });
  assert.equal(rec.kind, 'hist_v21');
  assert.equal(rec.accel_x.length, 100);
  assert.equal(rec.gyro_z.length, 100);
  assert.equal(rec.sample_rate_hz, 100);
  const parsed = decodeFrame(frame, 'puffin').decoded.parsed;
  assert.deepEqual(rec.accel_x, parsed.accel_x);
  const tiled = [];
  for (let s = 0; s < 20; s++) {
    tiled.push({ ...rec, sensor_ts: (T0 + s * 1000) / 1000, accel_x: rec.accel_x, gyro_z: rec.gyro_z });
  }
  const feat = extractMinuteImuFeatures(tiled, T0);
  assert.ok(feat);
  assert.equal(feat.native_sample_rate, 100);
  assert.equal(feat.sampleRate, 20);
  assert.ok(feat.native_n >= 20 * 100 - 5);
  assert.ok(feat.gyro_mean_dps != null);
  assert.ok(feat.gyro_mean_dps < 8, `stationary v21 gyro ${feat.gyro_mean_dps}`);
  assert.ok(feat.vm_mean > 0.8 && feat.vm_mean < 1.3, `gravity shell ${feat.vm_mean}`);
});

test('partial gyro is omitted; partial accel is rejected', () => {
  const full = imuMinute(T0, 20, { swingAmp: 0.4, gyroAmp: 40 });
  const noGy = full.map((r) => {
    const { gyro_y, ...rest } = r;
    return rest;
  });
  const featGyro = extractMinuteImuFeatures(full, T0);
  const featNoGy = extractMinuteImuFeatures(noGy, T0);
  assert.ok(featGyro.gyro_mean_dps > 1);
  assert.equal(featNoGy.gyro_mean_dps, null);
  assert.equal(featNoGy.gyro_energy, null);
  const noAy = full.map((r) => {
    const { accel_y, ...rest } = r;
    return rest;
  });
  assert.equal(extractMinuteImuFeatures(noAy, T0), null);
});

test('low IMU coverage falls back to missing_imu', () => {
  const samples = hrSamples({ minutes: 1, bpm: 120, motion: 0.3, wear_location: 'wrist', wear_location_source: 'user' });
  const { minutes } = computeEnergyMinutesV3({
    samples, physiology: physiology(), timeZone: 'UTC', imuRecords: imuMinute(T0, 5, { swingAmp: 0.5 }),
  });
  assert.equal(minutes[0].estimator, 'v1-fallback:missing_imu');
});

test('mixed sample rates do not warp frequency features', () => {
  const hz100 = imuMinute(T0, 20, { swingAmp: 0.5 });
  const hz20 = [];
  for (let s = 20; s < 40; s++) {
    hz20.push(imuSecond(T0 + s * 1000, { swingAmp: 0.5, n: 20, sample_rate_hz: 20 }));
  }
  const feat = extractMinuteImuFeatures([...hz100, ...hz20], T0);
  assert.ok(feat);
  assert.equal(feat.native_sample_rate, 100);
  assert.equal(feat.sampleRate, 20);
});

test('placement: stamped sample in the minute wins over first-in-bucket', () => {
  const samples = [];
  for (let i = 0; i < 45; i++) {
    samples.push({
      t: new Date(T0 + i * 1000).toISOString(),
      bpm: 90,
      motion: 0.1,
      wear_location: i < 5 ? undefined : 'bicep',
      wear_location_source: i < 5 ? undefined : 'user',
    });
  }
  const { minutes } = computeEnergyMinutesV3({ samples, physiology: physiology(), timeZone: 'UTC' });
  assert.equal(minutes[0].wear_location, 'bicep');
});

test('placement merge ignores truncated and backdated rewrites', () => {
  const t0 = '2026-08-25T10:00:00.000Z';
  const t1 = '2026-08-25T11:00:00.000Z';
  const existing = [
    { at: t0, location: 'wrist' },
    { at: t1, location: 'bicep' },
  ];
  assert.deepEqual(mergeWearLocationEvents(existing, []), existing.map((e) => ({ ...e })));
  const backdated = mergeWearLocationEvents(existing, [{ at: '2026-08-25T09:00:00.000Z', location: 'bicep' }]);
  assert.equal(backdated.length, 2);
  assert.equal(backdated[0].location, 'wrist');
  const outOfOrder = mergeWearLocationEvents(
    [{ at: t1, location: 'bicep' }],
    [{ at: t1, location: 'bicep' }, { at: t0, location: 'wrist' }],
  );
  assert.equal(outOfOrder.length, 1);
  assert.equal(outOfOrder[0].location, 'bicep');
  const skipped = appendWearLocationEvent(
    [{ at: t1, location: 'bicep' }],
    'wrist',
    new Date('2026-08-25T10:30:00.000Z'),
  );
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].location, 'bicep');
});

test('host prefs merge is append-only across restart-shaped replacements', () => {
  const t0 = '2026-08-25T10:00:00.000Z';
  const t1 = '2026-08-25T11:00:00.000Z';
  const prefs = { wearLocationEvents: [{ at: t0, location: 'wrist' }, { at: t1, location: 'bicep' }] };
  const truncated = applyWorkoutRuntimePrefs(prefs, { wearLocationEvents: [{ at: t1, location: 'bicep' }] });
  assert.equal(truncated.wearLocationEvents.length, 2);
  assert.equal(truncated.wearLocationEvents[0].location, 'wrist');
  const rapid = applyWorkoutRuntimePrefs(
    { wearLocation: 'wrist', wearLocationEvents: [{ at: t0, location: 'wrist' }] },
    { wearLocation: 'bicep' },
  );
  assert.ok(rapid.wearLocationEvents.length >= 2);
  assert.equal(rapid.wearLocationEvents.at(-1).location, 'bicep');
});

test('adversarial activities route to the expected estimator', () => {
  const phys = physiology();
  const run = (opts) => computeEnergyMinutesV3({
    physiology: phys, timeZone: 'UTC', artifact: null, ...opts,
  }).minutes[0];

  const cycle = run({
    samples: hrSamples({ minutes: 1, bpm: 155, motion: 0, wear_location: 'wrist', wear_location_source: 'user' }),
    imuRecords: imuMinute(T0, 30, { rest: true }),
  });
  assert.match(cycle.estimator, /^v1-fallback:(unvalidated_activity_family|quiet_wrist_elevated_hr_unrouted)$/);
  assert.notEqual(cycle.debug.activity_model, 'hr_cycling');
  assert.ok((cycle.motion_intensity ?? 0) < 0.15, `quiet-wrist ENMO ${cycle.motion_intensity}`);

  const labelledCycle = run({
    samples: hrSamples({ minutes: 1, bpm: 155, motion: 0, wear_location: 'wrist', wear_location_source: 'user' }),
    imuRecords: imuMinute(T0, 30, { rest: true }),
    workouts: [{ id: 'c1', sport: 'cycling', start: new Date(T0).toISOString(), end: new Date(T0 + MINUTE).toISOString() }],
  });
  assert.equal(labelledCycle.estimator, 'v3-hr-cycling');

  const typing = run({
    samples: hrSamples({ minutes: 1, bpm: 62, motion: 0, wear_location: 'wrist', wear_location_source: 'user' }),
    imuRecords: imuMinute(T0, 30, { rest: true }),
  });
  assert.equal(typing.estimator, 'v3-imu-sedentary');

  const walk = run({
    samples: hrSamples({ minutes: 1, bpm: 125, motion: 0, wear_location: 'wrist', wear_location_source: 'user' }),
    imuRecords: imuMinute(T0, 30, { swingAmp: 0.55, gyroAmp: 30 }),
    workouts: [{ id: 'w1', sport: 'walking', start: new Date(T0).toISOString(), end: new Date(T0 + MINUTE).toISOString() }],
  });
  assert.equal(walk.estimator, 'v1-fallback:walking_unvalidated_model');

  const sweep = run({
    samples: hrSamples({ minutes: 1, bpm: 72, motion: 0, wear_location: 'wrist', wear_location_source: 'user' }),
    imuRecords: imuMinute(T0, 30, { swingAmp: 0.9, gyroAmp: 120 }),
  });
  assert.match(sweep.estimator, /^v1-fallback:(unvalidated_activity_family|walking_unvalidated_model)$|^v3-imu-sedentary$/);
  const sweepFeat = extractMinuteImuFeatures(imuMinute(T0, 30, { swingAmp: 0.9, gyroAmp: 120 }), T0);
  assert.ok(sweepFeat.gyro_energy > 100);
  assert.ok((sweepFeat.bandpass_motion_auc_20hz ?? sweepFeat.mims_mean) > 0);

  const transA = run({
    samples: hrSamples({ minutes: 1, bpm: 62, motion: 0, wear_location: 'wrist', wear_location_source: 'user' }),
    imuRecords: imuMinute(T0, 30, { rest: true }),
  });
  const transB = computeEnergyMinutesV3({
    physiology: phys, timeZone: 'UTC', artifact: null,
    samples: [
      ...hrSamples({ minutes: 1, bpm: 62, t0: T0, wear_location: 'wrist', wear_location_source: 'user' }),
      ...hrSamples({ minutes: 1, bpm: 150, t0: T0 + MINUTE, wear_location: 'wrist', wear_location_source: 'user' }),
    ],
    imuRecords: [
      ...imuMinute(T0, 30, { rest: true }),
      ...imuMinute(T0 + MINUTE, 30, { rest: true }),
    ],
  }).minutes;
  assert.ok(transA.estimator);
  assert.equal(transB.length, 2);
  assert.notEqual(transB[0].estimator, transB[1].estimator);

  const strength = run({
    samples: hrSamples({ minutes: 1, bpm: 130, motion: 0.6, wear_location: 'wrist', wear_location_source: 'user' }),
    imuRecords: imuMinute(T0, 30, { swingAmp: 0.8 }),
    workouts: [{ id: 'w1', sport: 'strength', start: new Date(T0).toISOString(), end: new Date(T0 + MINUTE).toISOString() }],
  });
  assert.equal(strength.estimator, 'v1-fallback:ood_strength');

  const missingHr = run({
    samples: hrSamples({ minutes: 1, bpm: undefined, motion: 0.4, wear_location: 'wrist', wear_location_source: 'user' })
      .map((s) => ({ ...s, bpm: undefined })),
    imuRecords: imuMinute(T0, 30, { swingAmp: 0.5 }),
  });
  assert.ok(missingHr);
  assert.match(missingHr.estimator, /v3-|v1-fallback:/);
  assert.equal(missingHr.hr_source, 'absent');

  const badTs = run({
    samples: hrSamples({ minutes: 1, bpm: 110, motion: 0.3, wear_location: 'wrist', wear_location_source: 'user' }),
    imuRecords: imuMinute(T0, 30, { swingAmp: 0.5 }).map((r) => ({ ...r, sensor_ts: 'nope' })),
  });
  assert.equal(badTs.estimator, 'v1-fallback:missing_imu');
});

test('IMU substitution still fires when sample motion is zero', () => {
  const samples = hrSamples({ minutes: 1, bpm: 62, motion: 0, wear_location: 'wrist', wear_location_source: 'user' });
  const v1 = v1ByMinute(samples);
  const { minutes } = computeEnergyMinutesV3({
    samples, physiology: physiology(), timeZone: 'UTC', imuRecords: imuMinute(T0, 30, { rest: true }),
  });
  assert.equal(minutes[0].estimator, 'v3-imu-sedentary');
  assert.notEqual(minutes[0].active_kcal, v1.get(minutes[0].minute_at).active_kcal);
});

test('shadow accounting: total=resting+active, workout subset, gaps invent no active, replay idempotent', () => {
  const samples = hrSamples({ minutes: 3, bpm: 140, motion: 0.5, wear_location: 'wrist', wear_location_source: 'user' });
  const workouts = [{
    id: 'w1', sport: 'running',
    start: new Date(T0).toISOString(),
    end: new Date(T0 + MINUTE).toISOString(),
  }];
  const a = computeEnergyV3({
    samples, profile: PROFILE, prefs: PREFS, timeZone: 'UTC', userId: 'u1', mode: 'shadow',
    imuRecords: imuMinute(T0, 30, { swingAmp: 0.5 }),
    workouts,
  });
  const b = computeEnergyV3({
    samples, profile: PROFILE, prefs: PREFS, timeZone: 'UTC', userId: 'u1', mode: 'shadow',
    imuRecords: imuMinute(T0, 30, { swingAmp: 0.5 }),
    workouts,
  });
  assert.deepEqual(a.rows, b.rows);
  for (const m of a.rows) assert.equal(m.algorithm_version, '1.0.0');
  const d = a.daily[0];
  assert.ok(Math.abs(d.total_kcal - (d.resting_kcal + d.active_kcal)) < 0.02);
  assert.ok(d.workout_kcal <= d.active_kcal + 1e-6);
  const v3 = computeEnergyMinutesV3({
    samples, physiology: physiology(), timeZone: 'UTC',
    imuRecords: imuMinute(T0, 30, { swingAmp: 0.5 }),
    workouts,
  });
  const day = aggregateDay(v3.minutes, { now: T0 + 3 * MINUTE })[0];
  assert.ok(day.gap_minutes > 0);
  assert.equal(day.resting_gap_kcal > 0, true);
  const coveredActive = v3.minutes.reduce((s, m) => s + m.active_kcal, 0);
  assert.ok(Math.abs(day.active_kcal - coveredActive) < 0.05);
});

test('persistComputed loads B2 imu_raw in shadow without extras.imuRecords', async () => {
  const prior = process.env.ENERGY_MODEL_V3;
  process.env.ENERGY_MODEL_V3 = 'shadow';
  const USER = '11111111-1111-4111-8111-111111111111';
  // Stamp the kind/layout markers the real decoder always produces
  // (imuRecordFromFrame). The engine's hasCompleteV21Imu gate deliberately
  // ignores unlabeled synthetic records, so the B2-archive fixture must be
  // v21-shaped like real imu_raw objects.
  const recs = imuMinute(T0, 30, { rest: true })
    .map((r) => ({ ...r, kind: 'hist_v21', layout: 'v21' }));
  const archived = encodeImuArchive(recs);
  const key = `v3/core/users/${USER}/imu_raw/2026/08/25/10/obj.ndjson.gz`;
  const payloads = [];
  try {
    const engine = createMetricsEngine({
      cfg: { localUserId: USER, rawStore: 'b2', derivedStore: 'b2', b2Bucket: 'FRWHOOP', buildHash: 'test' },
      stores: {
        raw: {
          async listPrefix(prefix) { return prefix.includes(USER) ? [key] : []; },
          async getObject(k) { return k === key ? { body: archived.body } : null; },
        },
        derived: { async putObject() { return { etag: '"d"', bytes: 1 }; } },
      },
      db: { async upsertPayload(p) { payloads.push(p); return { ok: true }; } },
      energyContext: async () => ({ profile: PROFILE, prefs: PREFS, timeZone: 'UTC', workouts: [] }),
    });
    await engine.persistComputed({
      samples: hrSamples({ minutes: 1, bpm: 62, motion: 0, wear_location: 'wrist', wear_location_source: 'user' }),
      extras: { day: '2026-08-25', timeZone: 'UTC', userId: USER },
    });
    const energy = payloads.find((p) => p.energy_minutes?.length);
    assert.ok(energy);
    assert.ok(energy.energy_minutes.every((m) => m.algorithm_version === '1.0.0'));
    const shadow = energy.daily_metrics?.[0]?.extras?.energy_v3_shadow;
    assert.ok(shadow);
    const v3Count = Object.entries(shadow.estimator_counts || {})
      .filter(([k]) => k.startsWith('v3-'))
      .reduce((s, [, n]) => s + n, 0);
    assert.ok(v3Count >= 1);
  } finally {
    if (prior == null) delete process.env.ENERGY_MODEL_V3;
    else process.env.ENERGY_MODEL_V3 = prior;
  }
});

test('HAbits harness refuses Ainsworth/in-wild labels and scores MetCart only', () => {
  assert.equal(isCartGroundTruthColumn('MET (MetCart)'), true);
  assert.equal(isCartGroundTruthColumn('MET (Ainsworth)'), false);
  assert.throws(() => refuseNonCartLabel({ source: 'ainsworth', met_ainsworth: 3.5 }), /habits_gt_refused/);
  assert.throws(() => refuseNonCartLabel({ source: 'in_wild', met_cart: 4 }), /habits_gt_refused/);
  const imu = wristHzToImuRecords(Array.from({ length: 1200 }, (_, i) => ({
    accX: 0.3 * Math.sin(i / 5), accY: 0.05, accZ: 1, rotX: 10, rotY: 0, rotZ: 4,
  })), { t0Ms: T0, hz: 20 });
  assert.equal(imu[0].sample_rate_hz, 20);
  assert.equal(imu[0].accel_x.length, 20);
  const scored = scoreFrozenMinute({
    samples: hrSamples({ minutes: 1, bpm: 90, motion: 0, wear_location: 'wrist', wear_location_source: 'user' }),
    imuRecords: imu,
    physiology: physiology(),
    metCart: 3.5,
  });
  assert.ok(scored);
  assert.equal(typeof scored.yhat, 'number');
  const info = discoverInlab();
  assert.equal(info.zenodo, '14858226');
  if (!existsSync(info.root)) assert.equal(info.skipped, true);
});

test('WEEE epoch labels are VO2-derived, not constant protocol MET', () => {
  const csv = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../_energy_v2_research/experiments/weee_epochs.csv');
  if (!existsSync(csv)) return;
  const lines = readFileSync(csv, 'utf8').trim().split('\n');
  const cols = lines[0].split(',');
  const ti = cols.indexOf('target_met');
  const pi = cols.indexOf('participant');
  const ai = cols.indexOf('activity');
  const sit = [];
  for (const line of lines.slice(1)) {
    const p = line.split(',');
    if (p[pi] === 'P01' && p[ai] === 'sit') sit.push(Number(p[ti]));
  }
  assert.ok(sit.length > 4);
  const uniq = new Set(sit.map((v) => v.toFixed(3)));
  assert.ok(uniq.size > 1, 'P01 sit target_met varies — VO2, not Study_Information MET');
});

test('vendor calorie names are refused as labels', () => {
  assert.throws(() => refuseVendorLabel('Apple Watch calories'), /refused/);
  assert.throws(() => refuseVendorLabel('WHOOP'), /refused/);
  assert.throws(() => refuseVendorLabel('Ainsworth MET'), /refused/);
});

test('accel m/s2 converts to g; resample is a copy; mixed rates stay native-separated', () => {
  const n = 100;
  const ax = Array(n).fill(0), ay = Array(n).fill(0), az = Array(n).fill(9.81);
  const g = accelToG(ax, ay, az);
  assert.equal(g.from, 'm_s2');
  assert.ok(Math.abs(g.az[0] - 1) < 0.02);
  const native = az.slice();
  const copy = resampleCopy(az, 100, 20);
  assert.equal(copy.length, 20);
  assert.deepEqual(az, native);
  const harm = harmonizeImu({ ax, ay, az, sampleRate: 100 });
  assert.equal(harm.native.sampleRate, 100);
  assert.equal(harm.cross.sampleRate, 20);
  assert.equal(harm.native.ax.length, 100);
});

test('walking workout without a walking model falls back to V1', () => {
  const { minutes } = computeEnergyMinutesV3({
    samples: hrSamples({ minutes: 1, bpm: 125, motion: 0, wear_location: 'wrist', wear_location_source: 'user' }),
    physiology: physiology(),
    timeZone: 'UTC',
    imuRecords: imuMinute(T0, 30, { rest: true }),
    workouts: [{ id: 'w1', sport: 'walking', start: new Date(T0).toISOString(), end: new Date(T0 + MINUTE).toISOString() }],
    artifact: null,
  });
  assert.equal(minutes[0].estimator, 'v1-fallback:walking_unvalidated_model');
  assert.ok((minutes[0].motion_intensity ?? 0) < 0.15);
});

test('WHOOP OOD domain gate falls back without inventing a MET', () => {
  const artifact = {
    artifact_version: 'energy-v3-ridge-1',
    models: {
      imu_sedentary: {
        features: ['enmo_mean'], coef: [0], intercept: 1.1,
        standardize: { mean: { enmo_mean: 0 }, std: { enmo_mean: 1 } },
        clip: { min: 0.8, max: 2 },
      },
    },
    domain: {
      features: ['enmo_mean', 'dyn_enmo_mean'],
      median: { enmo_mean: 5, dyn_enmo_mean: 5 },
      mad: { enmo_mean: 0.002, dyn_enmo_mean: 0.002 },
      p01: { enmo_mean: 4.9, dyn_enmo_mean: 4.9 },
      p99: { enmo_mean: 5.1, dyn_enmo_mean: 5.1 },
      k_mad: 4,
      reference_dataset: 'weee_sit_stand',
    },
  };
  const samples = hrSamples({ minutes: 1, bpm: 62, motion: 0, wear_location: 'wrist', wear_location_source: 'user' });
  const v1 = v1ByMinute(samples);
  const { minutes } = computeEnergyMinutesV3({
    samples, physiology: physiology(), timeZone: 'UTC',
    imuRecords: imuMinute(T0, 30, { rest: true }),
    artifact,
  });
  assert.equal(minutes[0].estimator, 'v1-fallback:ood_or_insufficient_domain');
  assert.equal(minutes[0].active_kcal, v1.get(minutes[0].minute_at).active_kcal);
  assert.equal(minutes[0].debug.criterion_uncertainty, 'unavailable');
});

test('gross MET converts to total then active exactly once', () => {
  const samples = hrSamples({ minutes: 1, bpm: 140, motion: 0, wear_location: 'wrist', wear_location_source: 'user' });
  const { minutes } = computeEnergyMinutesV3({
    samples, physiology: physiology(), timeZone: 'UTC',
    imuRecords: imuMinute(T0, 30, { swingAmp: 0.5 }),
    artifact: null,
  });
  const m = minutes[0];
  const phys = physiology();
  const total = m.resting_kcal + m.active_kcal;
  const fromMet = (m.met * 3.5 * phys.weightKg / 1000) * 5.0;
  assert.ok(Math.abs(total - fromMet) < 0.05, `total ${total} vs met-derived ${fromMet}`);
  assert.ok(m.active_kcal === Math.max(0, total - m.resting_kcal) || Math.abs(m.active_kcal - Math.max(0, total - m.resting_kcal)) < 1e-6);
});

test('shipped ridge artifact predicts without fabricating missing gyro', () => {
  __resetV3ArtifactCache();
  const art = loadV3ArtifactCached();
  if (!art) return;
  assert.equal(art.artifact_version, 'energy-v3-ridge-1');
  assert.ok(art.models.imu_sedentary);
  assert.equal(art.uncertainty.criterion_calibrated_whoop, false);
  const imu = extractMinuteImuFeatures(imuMinute(T0, 30, { rest: true }), T0);
  const composed = composeV3Features(imu, { hr: 62 }, physiology());
  const withGyro = predictFamily(art, 'imu_sedentary', composed, { allowGyro: true });
  const noGyro = predictFamily(art, 'imu_sedentary', composed, { allowGyro: false });
  assert.ok(noGyro?.met >= 0.8 && noGyro.met <= 6);
  if (withGyro?.used_gyro) {
    assert.ok(imu.gyro_mean_dps != null);
  } else {
    assert.equal(noGyro.met, withGyro.met);
  }
  const missing = predictFamily(art, 'imu_sedentary', { enmo_mean: 0 }, { allowGyro: false });
  assert.equal(missing, null);
  const { minutes } = computeEnergyMinutesV3({
    samples: hrSamples({ minutes: 1, bpm: 62, motion: 0, wear_location: 'wrist', wear_location_source: 'user' }),
    physiology: physiology(),
    timeZone: 'UTC',
    imuRecords: imuMinute(T0, 30, { rest: true }),
  });
  assert.equal(minutes[0].estimator, 'v3-imu-sedentary');
  assert.equal(minutes[0].debug.used_learned, true);
  assert.equal(minutes[0].debug.criterion_uncertainty, 'unavailable');
  if (art.uncertainty.split_conformal != null) {
    assert.equal(art.uncertainty.split_conformal, false);
  }
});

test('router: no BPM gates; walking and quiet+high-HR without sport stay V1', () => {
  const phys = physiology();
  const restImu = extractMinuteImuFeatures(imuMinute(T0, 30, { rest: true }), T0);
  const quietHigh = routeV3Minute({
    activity: 'workout_other', reason: 'undetected_effort_still_wrist',
    imu: restImu, hr: 155, physiology: phys, quality: { hr: 0.9 },
  });
  assert.equal(quietHigh.use_learned, false);
  assert.notEqual(quietHigh.family, 'hr_cycling');

  const walk = routeV3Minute({
    activity: 'walking', reason: 'workout_sport_label',
    imu: restImu, hr: 125, physiology: phys, quality: { hr: 0.9 },
  });
  assert.equal(walk.fallback_reason, 'walking_unvalidated_model');

  const cycle = routeV3Minute({
    activity: 'cycling', reason: 'workout_sport_label',
    imu: restImu, hr: 155, physiology: phys, quality: { hr: 0.9 },
  });
  assert.equal(cycle.family, 'hr_cycling');
  assert.equal(cycle.use_learned, true);

  const run = routeV3Minute({
    activity: 'running', reason: 'workout_sport_label',
    imu: { ...restImu, dyn_enmo_mean: 0.6, coverage: 1 },
    hr: 155, physiology: phys, quality: { hr: 0.9 },
  });
  assert.equal(run.family, 'hr_imu_locomotion');
});

test('finalized shadow consumes only verified imu_raw', () => {
  const recs = imuMinute(T0, 30, { rest: true });
  const live = selectImuForEnergyV3(recs, { finalized: false });
  assert.ok(live.records.length > 0);
  const replay = selectImuForEnergyV3(recs, { finalized: true });
  assert.equal(replay.records.length, 0);
  assert.equal(replay.evidence.eligibility, 'no_verified_imu');
  const marked = recs.map((r) => ({ ...r, _manifest_verified: true, _manifest_sha256: 'a'.repeat(64) }));
  const ok = selectImuForEnergyV3(marked, { finalized: true });
  assert.equal(ok.records.length, recs.length);
});

test('Level-A split v21 replay is idempotent through V3 features', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fx = JSON.parse(readFileSync(path.join(here, 'fixtures/noop-whoop5-parity.json'), 'utf8'));
  const frame = Buffer.from(fx.v21_real.hex, 'hex');
  const rows = [];
  for (let i = 0; i < frame.length; i += 20) {
    rows.push(notifyOf(frame.subarray(i, i + 20), {
      family: 'puffin', char: 'FD4B0003-7185-4667-B7A6-36C427CBA76A', seq: i / 20,
      t: new Date(T0).toISOString(),
    }));
  }
  const a = deriveRecords(rows);
  const b = deriveRecords(rows);
  assert.equal(a.imu.length, 1);
  assert.equal(a.imu[0].identity.derived_id, b.imu[0].identity.derived_id);
  assert.equal(a.imu[0].accel_x.length, 100);
  assert.equal(a.imu[0].gyro_z.length, 100);
  const rec = a.imu[0];
  const tiled = [];
  for (let s = 0; s < 60; s++) {
    tiled.push({ ...rec, sensor_ts: (T0 + s * 1000) / 1000 });
  }
  const featA = extractMinuteImuFeatures(tiled, T0);
  const roundtrip = decodeImuArchive(encodeImuArchive(tiled).body);
  const featB = extractMinuteImuFeatures(roundtrip, T0);
  assert.ok(featA && featB);
  assert.equal(featA.native_sample_rate, 100);
  assert.equal(featA.sampleRate, 20);
  assert.equal(featA.bandpass_motion_auc_20hz, featB.bandpass_motion_auc_20hz);
  assert.equal(featA.enmo_mean, featB.enmo_mean);
  const samples = hrSamples({ minutes: 1, bpm: 62, motion: 0, wear_location: 'wrist', wear_location_source: 'user' });
  const candA = computeEnergyMinutesV3({
    samples, physiology: physiology(), timeZone: 'UTC', imuRecords: tiled,
  }).minutes[0];
  const candB = computeEnergyMinutesV3({
    samples, physiology: physiology(), timeZone: 'UTC', imuRecords: roundtrip,
  }).minutes[0];
  assert.equal(candA.estimator, candB.estimator);
  assert.equal(candA.met, candB.met);
  assert.equal(candA.active_kcal, candB.active_kcal);
  assert.equal(candA.debug.criterion_uncertainty, 'unavailable');
});
