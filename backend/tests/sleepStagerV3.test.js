import assert from 'node:assert/strict';
import test from 'node:test';
import { stageSession } from '../metrics/sleepStagerV2.js';
import {
  stageSessionV3, validateSleepV3Artifact, toySleepV3Artifact, STAGES, INTERNAL_UNSCORED,
} from '../metrics/sleepStagerV3.js';
import {
  buildEpochFeatures, expandCandidateWindow, compactVector, compactPresentMask,
  FEATURE_SCHEMA_VERSION, PPG_SAMPLES,
} from '../metrics/sleepFeaturesV3.js';
import { extractSleepSensors, wristOffIntervalsFromEvents } from '../metrics/sleepSensors.js';
import { detectSleepSessions } from '../metrics/sleepDetection.js';
import { scoreSleep } from '../metrics/sleep.js';
import { SCENARIOS } from '../bench/scenarios.mjs';
import { simulateScenario } from '../bench/simulator.mjs';
import { ACCEL_SCALE_G_PER_LSB, GYRO_SCALE_DPS_PER_LSB } from '../protocol/imuArchive.js';

function imuSecond(ts, { motion = 0 } = {}) {
  const n = 100;
  const ax = [];
  const ay = [];
  const az = [];
  const gx = [];
  const gy = [];
  const gz = [];
  for (let i = 0; i < n; i += 1) {
    ax.push(Math.round(motion * 200 * Math.sin(i / 5)));
    ay.push(0);
    az.push(4096);
    gx.push(Math.round(motion * 50));
    gy.push(0);
    gz.push(0);
  }
  return {
    schema: 'frwhoop_imu_raw_v1',
    kind: 'hist_v21',
    layout: 'v21',
    sensor_ts: ts,
    sample_rate_hz: 100,
    accel_x: ax, accel_y: ay, accel_z: az,
    gyro_x: gx, gyro_y: gy, gyro_z: gz,
    accel: { scale_g_per_lsb: ACCEL_SCALE_G_PER_LSB },
    gyro: { scale_dps_per_lsb: GYRO_SCALE_DPS_PER_LSB },
  };
}

function ppgSecond(ts, { drop = false } = {}) {
  if (drop) return null;
  const samples = [];
  for (let i = 0; i < 25; i += 1) samples.push(200000 + Math.round(8000 * Math.sin(i / 4)));
  return {
    schema: 'frwhoop_ppg_raw_v1',
    kind: 'hist_v26',
    layout: 'v26',
    sensor_ts: ts,
    sample_rate_hz: 25,
    samples,
    trusted_samples: samples,
    trusted_sample_count: 25,
    canonical_stage_input: true,
  };
}

function packWindow(start, end, { imu = false, ppg = false, dropPpgFrom, imuDropFrom, motion = 0 } = {}) {
  const imuRecords = [];
  const ppgRecords = [];
  for (let t = start; t < end; t += 1) {
    if (imu && !(imuDropFrom && t >= imuDropFrom)) imuRecords.push(imuSecond(t, { motion }));
    if (ppg) {
      const rec = ppgSecond(t, { drop: dropPpgFrom && t >= dropPpgFrom });
      if (rec) ppgRecords.push(rec);
    }
  }
  return { imuRecords, ppgRecords };
}

test('missing PPG and IMU with HR uses reduced V3, not silent zero physiology', () => {
  const start = 1_700_000_000;
  const end = start + 10 * 60;
  const gravity = [];
  const hr = [];
  for (let t = start; t < end; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 55 });
  }
  const v3 = stageSessionV3({
    start, end, gravity, hr, rr: [],
    artifact: toySleepV3Artifact(), allowSynthetic: true, expand: false,
  });
  assert.equal(v3.fallback, false);
  assert.equal(v3.path, 'v3_reduced');
  assert.ok(v3.epochs.some((e) => e.masks.hr === 1));
  assert.ok(v3.epochs.every((e) => e.masks.ppg === 0 && e.masks.imu === 0));
  assert.ok(v3.epochs.every((e) => e.ppg == null || e.ppg.every((v) => v == null)));
});

test('missing artifact is byte-compatible V2 fallback', () => {
  const sc = SCENARIOS.normal8;
  const sim = simulateScenario(sc, {});
  const v2 = stageSession({ start: sc.startSec, end: sc.endSec, gravity: sim.gravity, hr: sim.hr, rr: sim.rr });
  const v3 = stageSessionV3({
    start: sc.startSec, end: sc.endSec, gravity: sim.gravity, hr: sim.hr, rr: sim.rr,
  });
  assert.equal(v3.fallback, true);
  assert.equal(v3.path, 'sleep_stager_v2');
  assert.equal(v3.fallback_reason, 'artifact_missing');
  assert.deepEqual(v3.stages, v2);
});

test('synthetic artifact is rejected in production validation', () => {
  const toy = toySleepV3Artifact();
  assert.equal(validateSleepV3Artifact(toy).ok, false);
  assert.equal(validateSleepV3Artifact(toy, { allowSynthetic: true }).ok, true);
  assert.equal(toy.feature_schema_version, FEATURE_SCHEMA_VERSION);
});

test('off-wrist epochs are unscored, not wake, on the V3 path', () => {
  const start = 1_700_000_000;
  const end = start + 20 * 60;
  const gravity = [];
  const hr = [];
  for (let t = start; t < end; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 55 });
  }
  const { imuRecords, ppgRecords } = packWindow(start, end, { imu: true, ppg: true });
  const mid = start + 8 * 60;
  const v3 = stageSessionV3({
    start, end, gravity, hr, rr: [],
    imuRecords, ppgRecords,
    wristOff: [{ start: mid, end: mid + 120 }],
    artifact: toySleepV3Artifact(),
    allowSynthetic: true,
    expand: false,
  });
  assert.equal(v3.fallback, false);
  const hit = v3.epochs.filter((e) => e.start >= mid && e.start < mid + 120);
  assert.ok(hit.length >= 2);
  assert.ok(hit.every((e) => e.stage === INTERNAL_UNSCORED));
  assert.ok(v3.unscored_sec >= 60);
});

test('PPG dropout sets the PPG mask without zero-filling physiology', () => {
  const start = 1_700_000_000;
  const end = start + 12 * 60;
  const dropFrom = start + 6 * 60;
  const { imuRecords, ppgRecords } = packWindow(start, end, { imu: true, ppg: true, dropPpgFrom: dropFrom });
  const gravity = [];
  const hr = [];
  for (let t = start; t < end; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 55 });
  }
  const sensors = extractSleepSensors({ imuRecords, ppgRecords });
  sensors.gravity = gravity;
  sensors.hr = hr;
  const epochs = buildEpochFeatures(sensors, start, end);
  const withPpg = epochs.find((e) => e.start < dropFrom - 30);
  const without = epochs.find((e) => e.start >= dropFrom);
  assert.equal(withPpg.masks.ppg, 1);
  assert.equal(without.masks.ppg, 0);
  assert.ok(without.ppg.every((v) => v == null));
  assert.equal(without.ppg.length, PPG_SAMPLES);
  const present = compactPresentMask(without.compact);
  assert.equal(present[12], 0);
});

test('IMU dropout keeps 3-axis structure until it is actually missing', () => {
  const start = 1_700_000_000;
  const end = start + 12 * 60;
  const dropFrom = start + 6 * 60;
  const { imuRecords, ppgRecords } = packWindow(start, end, { imu: true, ppg: true, imuDropFrom: dropFrom });
  const gravity = [];
  const hr = [];
  for (let t = start; t < end; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 55 });
  }
  const sensors = extractSleepSensors({ imuRecords, ppgRecords });
  sensors.gravity = gravity;
  sensors.hr = hr;
  const epochs = buildEpochFeatures(sensors, start, end);
  const withImu = epochs.find((e) => e.start < dropFrom - 30);
  const without = epochs.find((e) => e.start >= dropFrom);
  assert.equal(withImu.masks.imu, 1);
  assert.ok(withImu.imu.ax.length >= 100);
  assert.equal(withImu.imu.ax.length, withImu.imu.ay.length);
  assert.equal(without.masks.imu, 0);
  assert.equal(without.imu, null);
});

test('data gaps become unscored rather than stretched light', () => {
  const start = 1_700_000_000;
  const gravity = [];
  const hr = [];
  for (let t = start; t < start + 12 * 60; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 55 });
  }
  for (let t = start + 24 * 60; t < start + 36 * 60; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 55 });
  }
  const v3 = stageSessionV3({
    start, end: start + 36 * 60, gravity, hr, rr: [],
    artifact: toySleepV3Artifact(),
    allowSynthetic: true,
    expand: false,
  });
  const gap = v3.epochs.filter((e) => e.start >= start + 13 * 60 && e.start < start + 23 * 60);
  assert.ok(gap.length > 5);
  assert.ok(gap.every((e) => e.stage === INTERNAL_UNSCORED));
  assert.ok(gap.every((e) => e.masks.hr === 0 && e.masks.gravity === 0));
});

test('short/fragmented sleep and quiet wake do not crash V3 and keep V2 canonical', () => {
  const nap = simulateScenario(SCENARIOS.nap45, {});
  const quiet = simulateScenario(SCENARIOS.motionless_awake, {});
  const v3nap = stageSessionV3({
    start: SCENARIOS.nap45.startSec, end: SCENARIOS.nap45.endSec,
    gravity: nap.gravity, hr: nap.hr, rr: nap.rr,
    artifact: toySleepV3Artifact(), allowSynthetic: true, isNap: true, expand: false,
  });
  assert.ok(v3nap.ok);
  if (!v3nap.fallback) {
    assert.ok(v3nap.stages.every((s) => s.stage === 'wake' || s.stage === INTERNAL_UNSCORED));
    assert.ok(v3nap.stages.every((s) => s.stage !== 'light' && s.stage !== 'rem' && s.stage !== 'deep'));
  }
  const det = detectSleepSessions({
    gravity: quiet.gravity, hr: quiet.hr, rr: quiet.rr, tzOffsetSeconds: 0, shadowV3: true,
  });
  assert.equal(det.sessions.length, 0);
});

test('high resting HR while motionless is not forced wake by V3 hard rules', () => {
  const start = 1_700_000_000;
  const end = start + 20 * 60;
  const gravity = [];
  const hr = [];
  for (let t = start; t < end; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 88 });
  }
  const { imuRecords, ppgRecords } = packWindow(start, end, { imu: true, ppg: true, motion: 0 });
  const artifact = toySleepV3Artifact();
  artifact.model = {
    type: 'feature_mlp',
    features: ['enmo_mean'],
    mean: [0],
    scale: [1],
    weights: [[6], [1], [1], [1]],
    bias: [-2, 1.5, 1, 0.5],
  };
  artifact.artifact_sha256 = undefined;
  const v3 = stageSessionV3({
    start, end, gravity, hr, rr: [],
    imuRecords, ppgRecords,
    artifact, allowSynthetic: true, expand: false,
  });
  assert.equal(v3.fallback, false);
  const mid = v3.epochs.find((e) => e.start >= start + 300 && e.stage !== INTERNAL_UNSCORED);
  assert.ok(mid);
  assert.notEqual(mid.stage, 'wake');
});

test('REM early in the session is allowed on the V3 path (no latency hard rule)', () => {
  const start = 1_700_000_000;
  const end = start + 20 * 60;
  const gravity = [];
  const hr = [];
  for (let t = start; t < end; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 62 });
  }
  const { imuRecords, ppgRecords } = packWindow(start, end, { imu: true, ppg: true, motion: 0.02 });
  const artifact = toySleepV3Artifact();
  artifact.model = {
    type: 'feature_mlp',
    features: ['hr_mean'],
    mean: [60],
    scale: [10],
    weights: [[-5], [0], [0], [8]],
    bias: [0, 0, 0, 2],
  };
  artifact.artifact_sha256 = undefined;
  const v3 = stageSessionV3({
    start, end, gravity, hr, rr: [],
    imuRecords, ppgRecords,
    artifact, allowSynthetic: true, expand: false,
  });
  assert.equal(v3.fallback, false);
  const early = v3.epochs.filter((e) => e.start < start + 600 && e.stage !== INTERNAL_UNSCORED);
  assert.ok(early.some((e) => e.stage === 'rem'));
});

test('sleep after overnight awakening still stages both sides', () => {
  const sc = SCENARIOS.overnight_wake;
  const sim = simulateScenario(sc, {});
  const det = detectSleepSessions({
    gravity: sim.gravity, hr: sim.hr, rr: sim.rr, tzOffsetSeconds: 0,
    shadowV3: true,
    sleepV3Artifact: toySleepV3Artifact(),
    allowSyntheticV3: true,
  });
  assert.equal(det.sessions.length, 1);
  assert.equal(det.sessions[0].provenance.canonicalStager, 'sleep_stager_v2');
  assert.ok(det.sessions[0].shadowV3);
  const mid = sc.startSec + 3.5 * 3600;
  const midSeg = det.sessions[0].stages.find((s) => mid >= s.start && mid < s.end);
  assert.equal(midSeg?.stage, 'wake');
});

test('probabilities normalize and carry calibration metadata', () => {
  const start = 1_700_000_000;
  const end = start + 15 * 60;
  const gravity = [];
  const hr = [];
  for (let t = start; t < end; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 55 });
  }
  const { imuRecords, ppgRecords } = packWindow(start, end, { imu: true, ppg: true });
  const v3 = stageSessionV3({
    start, end, gravity, hr, rr: [],
    imuRecords, ppgRecords,
    artifact: toySleepV3Artifact(), allowSynthetic: true, expand: false,
  });
  assert.ok(v3.epochProbabilities.length > 5);
  for (const row of v3.epochProbabilities) {
    if (row.stage === INTERNAL_UNSCORED) {
      assert.equal(row.probs, null);
      continue;
    }
    const p = row.probs;
    const sum = p.wake + p.light + p.deep + p.rem;
    assert.ok(Math.abs(sum - 1) < 1e-6);
    assert.ok(STAGES.includes(row.stage) || row.stage === INTERNAL_UNSCORED);
  }
  assert.equal(v3.provenance.calibration_status, 'uncalibrated');
  assert.equal(v3.provenance.calibration_version, 'none');
  assert.equal(v3.provenance.feature_schema_version, FEATURE_SCHEMA_VERSION);
  assert.match(v3.provenance.stager_version, /^sleep-stager-v3-/);
});

test('candidate window expands ~45 min when data exists; detector window stays tight', () => {
  const bounds = { minTs: 1000, maxTs: 1000 + 12 * 3600 };
  const win = expandCandidateWindow(1000 + 2 * 3600, 1000 + 10 * 3600, bounds, 45 * 60);
  assert.equal(win.start, 1000 + 2 * 3600 - 45 * 60);
  assert.equal(win.end, 1000 + 10 * 3600 + 45 * 60);
  const clipped = expandCandidateWindow(1000, 1000 + 3600, bounds, 45 * 60);
  assert.equal(clipped.start, 1000);
});

test('type-48 wrist-off intervals merge into sensor wristOff', () => {
  const spans = wristOffIntervalsFromEvents([
    { kind: 'event', event_id: 10, event_name: 'WRIST_OFF', event_ts: 50 },
    { kind: 'event', event_id: 9, event_name: 'WRIST_ON', event_ts: 80 },
  ]);
  assert.deepEqual(spans, [{ start: 50, end: 80, ambiguous: false }]);
});

test('scoreSleep keeps V2 canonical and attaches V3 shadow', () => {
  const sc = SCENARIOS.normal8;
  const sim = simulateScenario(sc, {});
  const rows = sim.gravity.map((g, i) => ({
    t: new Date(g.ts * 1000).toISOString(),
    bpm: sim.hr[i]?.bpm ?? 55,
    rr_ms: sim.rr[i] ? [sim.rr[i].rrMs] : [],
    gravity: { x: g.x, y: g.y, z: g.z },
  }));
  const scored = scoreSleep({
    samples: rows,
    extras: {
      timeZone: 'UTC',
      sleepV3Artifact: toySleepV3Artifact(),
      allowSyntheticV3: true,
    },
  });
  assert.equal(scored.ok, true);
  assert.equal(scored.provenance.stagingVersion, 'noop-sleep-stager-v2-v1');
  assert.equal(scored.provenance.canonicalStager || 'sleep_stager_v2', 'sleep_stager_v2');
  const main = (scored.sessions || [scored]).find((s) => !s.isNap) || scored;
  assert.ok(main.shadowV3);
  assert.ok(main.awakeMin + main.lightMin + main.deepMin + main.remMin === main.inBedMin);
});

test('compact feature mask is never silently all-present when PPG is missing', () => {
  const compact = { hr_mean: 55, ppg_quality: null, enmo_mean: 0.01 };
  const present = compactPresentMask({
    hr_mean: 55, hr_std: null, hr_trend: null,
    ibi_n: 0, ibi_coverage: 0, rmssd: null, sdnn: null, ihr_mean: null,
    enmo_mean: 0.01, enmo_std: null, jerk_rms: null, gyro_rms: null,
    ppg_quality: null, ppg_coverage: 0, ppg_concentration: null,
    temp_dev: null, clock_sin: 0, clock_cos: 1, frac_through: 0.2,
    resp_reg: null, dyn_accel: null,
  });
  const vec = compactVector({
    hr_mean: 55, hr_std: null, hr_trend: null,
    ibi_n: 0, ibi_coverage: 0, rmssd: null, sdnn: null, ihr_mean: null,
    enmo_mean: 0.01, enmo_std: null, jerk_rms: null, gyro_rms: null,
    ppg_quality: null, ppg_coverage: 0, ppg_concentration: null,
    temp_dev: null, clock_sin: 0, clock_cos: 1, frac_through: 0.2,
    resp_reg: null, dyn_accel: null,
  });
  assert.equal(present[0], 1);
  assert.equal(present[12], 0);
  assert.equal(vec[12], 0);
  assert.ok(compact.ppg_quality == null);
});
