/**
 * Synthetic validation harness for frwhoop_steps_v2.
 *
 * Ground truth here is the generating function (known cadence × duration),
 * NOT a labeled walk. MAPE / bias / false-positive counts are reported so
 * the algorithm can be checked for gross failure modes. They are NOT a
 * claim of improved accuracy vs WHOOP official Steps or vs a video count.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStepsV2, shadowCompare } from '../metrics/stepsV2.js';
import { accumulateSteps } from '../metrics/steps.js';
import { makeImuRecords, walkAccel, walkGyro } from './stepsV2Synth.js';

const T0 = 1_787_000_000;

function truthSteps(spm, seconds) {
  return Math.round((spm / 60) * seconds);
}

function v1Proxy({ seconds, stepsPerSec, t0 = T0 }) {
  const samples = [];
  let c = 2000;
  for (let s = 0; s < seconds; s += 1) {
    c += stepsPerSec;
    samples.push({
      t: new Date((t0 + s) * 1000).toISOString(),
      step_cumulative: c,
      activity_class: stepsPerSec > 0.5 ? 1 : 0,
    });
  }
  return { samples, v1: accumulateSteps(samples, { timeZone: 'UTC' }) };
}

function mape(pred, truth) {
  if (!truth) return pred === 0 ? 0 : 100;
  return Math.abs(pred - truth) / truth * 100;
}

function runScenario(name, {
  seconds, accelAt, gyroAt, spm = 0, v1StepsPerSec = 0, expectFp = false,
}) {
  const recs = makeImuRecords({ seconds, accelAt, gyroAt, t0: T0 });
  const { samples, v1 } = v1Proxy({ seconds, stepsPerSec: v1StepsPerSec });
  const v2 = computeStepsV2({
    imuRecords: recs,
    samples,
    v1,
    dayStartMs: T0 * 1000,
    dayEndMs: (T0 + seconds) * 1000,
    timeZone: 'UTC',
  });
  const truth = spm > 0 ? truthSteps(spm, seconds) : 0;
  const cmp = shadowCompare(v1, v2);
  return {
    name,
    truth,
    v1: v1.total,
    v2: v2.total,
    v2_mode: v2.source_mode,
    mape_v1: mape(v1.total, truth),
    mape_v2: mape(v2.total, truth),
    bias_v1: v1.total - truth,
    bias_v2: v2.total - truth,
    fp_v1: expectFp ? v1.total : (truth === 0 ? v1.total : 0),
    fp_v2: expectFp || truth === 0 ? v2.total : 0,
    rejected: v2.rejected,
    cmp,
  };
}

const SCENARIOS = [
  {
    name: 'normal_walk',
    seconds: 40, spm: 110, v1StepsPerSec: Math.round(110 / 60),
    accelAt: (t) => walkAccel(t, 110),
    gyroAt: (t) => walkGyro(t, 110),
  },
  {
    name: 'slow_walk',
    seconds: 40, spm: 80, v1StepsPerSec: Math.round(80 / 60),
    accelAt: (t) => walkAccel(t, 80, 0.34),
    gyroAt: (t) => walkGyro(t, 80),
  },
  {
    name: 'fast_walk',
    seconds: 30, spm: 140, v1StepsPerSec: Math.round(140 / 60),
    accelAt: (t) => walkAccel(t, 140, 0.38),
    gyroAt: (t) => walkGyro(t, 140),
  },
  {
    name: 'run',
    seconds: 25, spm: 170, v1StepsPerSec: Math.round(170 / 60),
    accelAt: (t) => walkAccel(t, 170, 0.55),
    gyroAt: (t) => walkGyro(t, 170),
  },
  {
    name: 'stairs',
    seconds: 30, spm: 100, v1StepsPerSec: 2,
    accelAt: (t) => {
      const a = walkAccel(t, 100, 0.4);
      a.z += 0.08 * Math.sin(2 * Math.PI * 0.4 * t);
      return a;
    },
    gyroAt: (t) => walkGyro(t, 100),
  },
  {
    name: 'carrying_objects',
    seconds: 30, spm: 110, v1StepsPerSec: 2,
    accelAt: (t) => walkAccel(t, 110, 0.30),
    gyroAt: (t) => ({ x: 1, y: 8 * Math.sin(Math.PI * (110 / 60) * t), z: 1 }),
  },
  {
    name: 'busy_hands',
    seconds: 25, spm: 0, v1StepsPerSec: 1, expectFp: true,
    accelAt: (t) => ({
      x: 0.2 * Math.sin(2 * Math.PI * 6 * t) + 0.15 * Math.sin(2 * Math.PI * 2.7 * t),
      y: 0.12 * Math.sin(2 * Math.PI * 4.1 * t),
      z: 1.0 + 0.08 * Math.sin(2 * Math.PI * 5.2 * t),
    }),
    gyroAt: (t) => ({ x: 40 * Math.sin(2 * Math.PI * 6 * t), y: 20, z: 10 }),
  },
  {
    name: 'stationary_arm_swings',
    seconds: 30, spm: 0, v1StepsPerSec: 1, expectFp: true,
    accelAt: (t) => ({
      x: 0.55 * Math.sin(2 * Math.PI * 1.0 * t),
      y: 0.1,
      z: 1.0 + 0.15 * Math.sin(2 * Math.PI * 1.0 * t),
    }),
    gyroAt: (t) => ({ x: 5, y: 120 * Math.sin(2 * Math.PI * 1.0 * t), z: 8 }),
  },
  {
    name: 'brushing_teeth',
    seconds: 20, spm: 0, v1StepsPerSec: 2, expectFp: true,
    accelAt: (t) => ({
      x: 0.35 * Math.sin(2 * Math.PI * 4.6 * t),
      y: 0.2 * Math.sin(2 * Math.PI * 4.6 * t),
      z: 1.0 + 0.25 * Math.sin(2 * Math.PI * 4.6 * t),
    }),
    gyroAt: (t) => ({ x: 80 * Math.sin(2 * Math.PI * 4.6 * t), y: 40, z: 15 }),
  },
  {
    name: 'lifting',
    seconds: 20, spm: 0, v1StepsPerSec: 1, expectFp: true,
    accelAt: (t) => {
      const hit = (t > 4 && t < 4.2) || (t > 11 && t < 11.2);
      return { x: 0.05, y: 0, z: hit ? 2.6 : 1.0 };
    },
  },
  {
    name: 'driving',
    seconds: 30, spm: 0, v1StepsPerSec: 1, expectFp: true,
    accelAt: (t) => ({
      x: 0.04 * Math.sin(2 * Math.PI * 12 * t),
      y: 0.03 * Math.sin(2 * Math.PI * 15 * t),
      z: 1.0 + 0.035 * Math.sin(2 * Math.PI * 11 * t),
    }),
    gyroAt: (t) => ({ x: 8 * Math.sin(2 * Math.PI * 0.2 * t), y: 3, z: 2 }),
  },
  {
    name: 'sleep',
    seconds: 60, spm: 0, v1StepsPerSec: 0,
    accelAt: () => ({ x: 0.02, y: -0.01, z: 1.0 }),
    gyroAt: () => ({ x: 0.2, y: -0.1, z: 0.05 }),
  },
];

test('v2 synthetic harness: gait vs false-positive scenarios (not labeled accuracy)', () => {
  const rows = SCENARIOS.map((s) => runScenario(s.name, s));
  const report = {};
  for (const row of rows) {
    report[row.name] = {
      truth: row.truth,
      v1: row.v1,
      v2: row.v2,
      mape_v1: Number(row.mape_v1.toFixed(1)),
      mape_v2: Number(row.mape_v2.toFixed(1)),
      bias_v1: row.bias_v1,
      bias_v2: row.bias_v2,
      fp_v1: row.fp_v1,
      fp_v2: row.fp_v2,
      mode: row.v2_mode,
    };
  }
  // eslint-disable-next-line no-console
  console.log('steps_v2_synthetic_report', JSON.stringify(report, null, 2));

  const gait = rows.filter((r) => r.truth > 0);
  for (const row of gait) {
    assert.equal(row.v2_mode, 'imu_gait', row.name);
    assert.ok(row.v2 > row.truth * 0.4, `${row.name} v2 undercounted badly (${row.v2} vs ${row.truth})`);
    assert.ok(row.v2 < row.truth * 1.8, `${row.name} v2 overcounted badly (${row.v2} vs ${row.truth})`);
  }

  const fps = rows.filter((r) => r.truth === 0);
  for (const row of fps) {
    assert.ok(row.v2 <= 8, `${row.name} false positives too high: ${row.v2}`);
  }

  const brush = rows.find((r) => r.name === 'brushing_teeth');
  assert.ok(brush.v2 < brush.v1, 'v2 must not treat brushing as walking when v1 proxy ticks');
  const sleep = rows.find((r) => r.name === 'sleep');
  assert.equal(sleep.v2, 0);
});
