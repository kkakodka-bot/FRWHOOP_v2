import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShadowReadModel, shadowById, statusFromReason, foldWristState } from '../metrics/shadowReadModel.js';
import { hasCompleteV21Imu } from '../energy/v3/imuEvidence.js';

test('statusFromReason maps artifact and v21/imu to explicit blockers', () => {
  assert.equal(statusFromReason('artifact_missing'), 'artifact_missing');
  assert.equal(statusFromReason('onnx_artifact_missing'), 'artifact_missing');
  assert.equal(statusFromReason('v21_frames_incomplete'), 'input_missing');
  assert.equal(statusFromReason('imu_coverage_below_minimum'), 'input_missing');
  assert.equal(statusFromReason('not_computed'), 'unavailable');
});

test('hasCompleteV21Imu ignores compact features and truncated frames', () => {
  assert.equal(hasCompleteV21Imu([]), false);
  assert.equal(hasCompleteV21Imu([{ layout: 'v21', enmo_mean: 0.04 }]), false);
  assert.equal(hasCompleteV21Imu([{ layout: 'v21', accel_x: [1, 2, 3] }]), false);
  assert.equal(hasCompleteV21Imu([{
    layout: 'v21',
    kind: 'hist_v21',
    accel_x: Array.from({ length: 100 }, (_, i) => i),
  }]), true);
});

test('read model folds persisted extras without inventing canonical values', () => {
  const model = buildShadowReadModel({
    metrics: {
      steps: 12,
      strain_score: 8,
      strain_score_v2: 9.1,
      avg_hr_bpm: 62,
      energy_kcal: 2000,
      spo2_pct: null,
    },
    extras: {
      steps_v2: { total: 14, algorithm_version: 'frwhoop-steps-v2', imu_coverage: 400 },
      steps_v3: { total: null, status: 'unavailable', unavailable_reason: 'artifact_missing' },
      hr_v2: { avg_hr: 61.4, algorithm_version: 'frwhoop-hr-v2.0.0', coverage_hours: 22 },
      energy_v2: { cand_total_kcal: 2110, candidate_model_version: 'energy-v2.0.0' },
      energy_v3_blocker: { reason: 'v21_frames_incomplete' },
      spo2_candidate: { spo2_candidate_pct: 96, spo2_pct: null, coverage: { n: 8 } },
    },
    sleep: [{ is_nap: false, asleep_min: 420, shadow_v3: { path: 'v2', fallback_reason: 'artifact_missing' } }],
  });
  assert.equal(shadowById(model, 'steps_v2').status, 'shadow');
  assert.equal(shadowById(model, 'steps_v2').canonical_value, 12);
  assert.equal(shadowById(model, 'steps_v2').shadow_value, 14);
  assert.equal(shadowById(model, 'steps_v3').status, 'artifact_missing');
  assert.equal(shadowById(model, 'steps_v3').shadow_value, null);
  assert.equal(shadowById(model, 'hr_v2').status, 'shadow');
  assert.equal(shadowById(model, 'hr_v2').canonical_value, 62);
  assert.equal(shadowById(model, 'strain_v2').status, 'shadow');
  assert.equal(shadowById(model, 'sleep_v3').status, 'artifact_missing');
  assert.equal(shadowById(model, 'energy_v2').status, 'shadow');
  assert.equal(shadowById(model, 'energy_v3').status, 'input_missing');
  assert.equal(shadowById(model, 'spo2_candidate').status, 'experimental');
  assert.equal(shadowById(model, 'spo2_candidate').canonical_value, null);
});

test('foldWristState tracks last on/off event without a health claim', () => {
  const off = foldWristState([{ event_id: 9, event_ts: 'a' }, { event_id: 10, event_ts: 'b' }]);
  assert.equal(off.on_wrist, false);
  const on = foldWristState([{ event_id: 10 }, { event_id: 9, event_ts: 'c' }]);
  assert.equal(on.on_wrist, true);
});
