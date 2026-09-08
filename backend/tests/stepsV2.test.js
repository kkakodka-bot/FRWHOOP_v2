import test from 'node:test';
import assert from 'node:assert/strict';
import { makeImuRecords, walkAccel, walkGyro } from './stepsV2Synth.js';
import {
  computeStepsV2,
  imuRecordsToSegments,
  resolveCanonicalSteps,
  STEPS_V2_VERSION,
  stepsV2Mode,
} from '../metrics/stepsV2.js';
import { accumulateSteps } from '../metrics/steps.js';

const T0 = 1_787_000_000;

function v1For(seconds, stepsPerSec, t0 = T0) {
  const samples = [];
  let c = 1000;
  for (let s = 0; s < seconds; s += 1) {
    c += stepsPerSec;
    samples.push({
      t: new Date((t0 + s) * 1000).toISOString(),
      step_cumulative: c,
      activity_class: stepsPerSec > 0 ? 1 : 0,
    });
  }
  return { samples, v1: accumulateSteps(samples, { timeZone: 'UTC' }) };
}

test('v21-shaped records concatenate into a 100 Hz segment', () => {
  const recs = makeImuRecords({
    seconds: 3,
    accelAt: (t) => walkAccel(t, 110),
    gyroAt: (t) => walkGyro(t, 110),
    t0: T0,
  });
  const segs = imuRecordsToSegments(recs);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].ax.length, 300);
});

test('IMU record time includes WHOOP 1/32768-second subseconds', () => {
  const [record] = makeImuRecords({
    seconds: 1,
    accelAt: (t) => walkAccel(t, 110),
    t0: T0,
  });
  record.subsec = 16384;
  const [segment] = imuRecordsToSegments([record]);
  assert.equal(segment.t0, T0 * 1000 + 500);
});

test('without IMU coverage v2 falls back to the v1 counter', () => {
  const { samples, v1 } = v1For(20, 2);
  const v2 = computeStepsV2({ imuRecords: [], samples, v1, timeZone: 'UTC' });
  assert.equal(v2.source_mode, 'cumulative_fallback');
  assert.equal(v2.fallback, true);
  assert.equal(v2.total, v1.total);
  assert.equal(v2.algorithm_version, STEPS_V2_VERSION);
  assert.ok(v2.confidence < 0.5);
});

test('legacy V2 promotion environment values are hard-demoted to shadow', () => {
  assert.equal(stepsV2Mode({ FRWHOOP_STEPS_V2: 'canonical' }), 'shadow');
  assert.equal(stepsV2Mode({ FRWHOOP_STEPS_V2: 'v2' }), 'shadow');
  const v1 = { total: 12 };
  const v2 = { total: 99, fallback: false, status: 'ok' };
  assert.deepEqual(resolveCanonicalSteps(v1, v2, 'canonical'), {
    total: 12,
    source: v1,
    canonical: 'v1',
  });
});

test('isolated lifting peaks are not counted', () => {
  const recs = makeImuRecords({
    seconds: 20,
    accelAt: (t) => {
      const hit = (t > 3 && t < 3.12) || (t > 10 && t < 10.12) || (t > 16 && t < 16.12);
      return { x: 0.1, y: 0, z: hit ? 2.4 : 1.0 };
    },
    t0: T0,
  });
  const v2 = computeStepsV2({ imuRecords: recs, v1: { total: 0, status: 'ok', confidence: 0.5 } });
  assert.equal(v2.source_mode, 'imu_gait');
  assert.equal(v2.total, 0);
});

test('v2 emits timestamped IMU events and matching minute buckets', () => {
  const recs = makeImuRecords({
    seconds: 70,
    accelAt: (t) => walkAccel(t, 110),
    gyroAt: (t) => walkGyro(t, 110),
    t0: T0,
  });
  const v2 = computeStepsV2({
    imuRecords: recs,
    v1: { total: 0, status: 'ok', confidence: 0.5, buckets_60s: [] },
    dayStartMs: T0 * 1000,
    dayEndMs: (T0 + 70) * 1000,
  });
  assert.equal(v2.source_mode, 'imu_gait');
  assert.equal(v2.events.length, v2.total);
  assert.equal(
    v2.buckets_60s.reduce((sum, bucket) => sum + bucket.count, 0),
    v2.total,
  );
  assert.ok(v2.buckets_60s.every((bucket) => bucket.source_mode === 'v2_imu_event'));
});

test('activity_class 0 is unclassified and does not gate IMU gait', () => {
  const recs = makeImuRecords({
    seconds: 70,
    accelAt: (t) => walkAccel(t, 110),
    gyroAt: (t) => walkGyro(t, 110),
    t0: T0,
  });
  const samples = Array.from({ length: 70 }, (_, i) => ({
    t: new Date((T0 + i) * 1000).toISOString(),
    activity_class: 0,
  }));
  const gated = computeStepsV2({
    imuRecords: recs,
    samples,
    v1: { total: 0, status: 'ok', confidence: 0.5, buckets_60s: [] },
    dayStartMs: T0 * 1000,
    dayEndMs: (T0 + 70) * 1000,
  });
  const open = computeStepsV2({
    imuRecords: recs,
    v1: { total: 0, status: 'ok', confidence: 0.5, buckets_60s: [] },
    dayStartMs: T0 * 1000,
    dayEndMs: (T0 + 70) * 1000,
  });
  assert.equal(gated.source_mode, 'imu_gait');
  assert.equal(gated.total, open.total);
  assert.ok(gated.total > 0);
  assert.equal(gated.rejected?.activity_class_still, undefined);
});
