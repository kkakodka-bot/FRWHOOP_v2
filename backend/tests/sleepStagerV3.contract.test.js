import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { crc16Modbus, crc32 } from '../protocol/crc.js';
import {
  ppgRecordFromFrame, decodePpgArchive, encodePpgArchive,
} from '../protocol/ppgArchive.js';
import { reconstructSaturatedDeltaWindow } from '../protocol/gen5.js';
import {
  extractSleepSensors, wristOffIntervalsFromEvents,
} from '../metrics/sleepSensors.js';
import {
  COMPACT_FEATURE_NAMES, FORBIDDEN_V3_FEATURES,
  resampleToTargetGrid, preprocessingContractSha256, assertNoForbiddenV3Features,
  buildEpochFeatures,
} from '../metrics/sleepFeaturesV3.js';
import {
  stageSessionV3, validateSleepV3Artifact, toySleepV3Artifact,
  INTERNAL_UNSCORED, domainSupported, sleepV3ArtifactSha,
} from '../metrics/sleepStagerV3.js';
import {
  sleepV3Mode, shouldComputeSleepV3, shouldSurfaceSleepV3,
  loadSleepV3Artifact, clearSleepV3ArtifactCache,
} from '../metrics/sleepV3Artifact.js';
import { stageSession } from '../metrics/sleepStagerV2.js';
import { scoreSleep } from '../metrics/sleep.js';
import { runSleepV3Onnx } from '../metrics/sleepV3Onnx.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function putI32(buf, off, v) {
  buf[off] = v & 0xFF;
  buf[off + 1] = (v >> 8) & 0xFF;
  buf[off + 2] = (v >> 16) & 0xFF;
  buf[off + 3] = (v >>> 24) & 0xFF;
}
function putI16(buf, off, v) {
  const u = v & 0xFFFF;
  buf[off] = u & 0xFF;
  buf[off + 1] = (u >> 8) & 0xFF;
}

function puffinFrame(innerBody) {
  const declared = innerBody.length + 4;
  const frame = [0xAA, 0x01, declared & 0xFF, (declared >> 8) & 0xFF, 0x00, 0x01];
  const c16 = crc16Modbus(frame, 0, 6);
  frame.push(c16 & 0xFF, (c16 >> 8) & 0xFF, ...innerBody);
  const c = crc32(innerBody);
  frame.push(c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF, (c >>> 24) & 0xFF);
  return Buffer.from(frame);
}

function v26Frame({
  flags = 0x80, first = 200000, deltas = Array(24).fill(12), pip = 1, unix = 1_700_000_000,
} = {}) {
  const inner = new Array(76).fill(0);
  inner[0] = 0x2F;
  inner[1] = 26;
  inner[2] = flags;
  const ri = 1;
  inner[3] = ri & 0xFF;
  putI32(inner, 7, unix); // frame 15
  inner[13] = pip & 0xFF; // frame 21
  inner[14] = (pip >> 8) & 0xFF;
  putI32(inner, 15, first); // frame 23
  for (let i = 0; i < 24; i += 1) putI16(inner, 19 + 2 * i, deltas[i] ?? 0); // frame 27
  return puffinFrame(inner);
}

function wristArtifact(extra = {}) {
  const base = toySleepV3Artifact();
  const artifact = {
    ...base,
    artifact_sha256: undefined,
    supported_domains: [{
      device_family: ['whoop5', 'whoop_mg'],
      signal_layout: ['v26'],
      placement: ['wrist'],
      native_rate_hz: [25, 50],
    }],
    modality_tiers: extra.modality_tiers || base.modality_tiers,
    ...extra,
  };
  return { ...artifact, artifact_sha256: sleepV3ArtifactSha(artifact) };
}

test('forbidden SpO2/wear fields cannot enter the V3 feature tensor', () => {
  assert.equal(assertNoForbiddenV3Features(), true);
  for (const name of FORBIDDEN_V3_FEATURES) {
    assert.equal(COMPACT_FEATURE_NAMES.includes(name), false, name);
  }
  const toy = toySleepV3Artifact();
  assert.equal(toy.compact_feature_names.includes('spo2'), false);
  assert.equal(toy.compact_feature_names.includes('wear'), false);
});

test('v26 25 Hz: retain absolute sample, deltas, reconstruct 25, duration 1s', () => {
  const frame = v26Frame({ flags: 0x80, first: 180000, deltas: Array(24).fill(8), pip: 4 });
  const rec = ppgRecordFromFrame(frame, 'puffin', { receivedAt: '2026-09-01T00:00:00Z' });
  assert.equal(rec.sample_rate_hz, 25);
  assert.equal(rec.sample_rate_provenance, 'v26_header_flags_bit7');
  assert.equal(rec.optical_deltas.length, 24);
  assert.equal(rec.first_sample_adc, 180000);
  assert.equal(rec.samples.length, 25);
  assert.equal(rec.samples[0], 180000);
  assert.equal(rec.pip_state_counter, 4);
  assert.equal(rec.duration_sec, 1);
  assert.equal(rec.canonical_stage_input, true);
  assert.deepEqual(rec.optical_deltas, Array(24).fill(8));
});

test('v26 50 Hz: native rate from flags, wall-clock duration 0.5s, not inferred from count', () => {
  const frame = v26Frame({ flags: 0x00, first: 180000, deltas: Array(24).fill(5) });
  const rec = ppgRecordFromFrame(frame, 'puffin', {});
  assert.equal(rec.sample_rate_hz, 50);
  assert.equal(rec.samples.length, 25);
  assert.equal(rec.duration_sec, 0.5);
  const grid = resampleToTargetGrid([{
    ts: 1000, hz: 50, native_rate_hz: 50, samples: rec.samples,
  }], { epochStart: 1000, epochEnd: 1001, targetHz: 25 });
  assert.equal(grid.values.length, 25);
  const present = grid.values.filter((v) => v != null).length;
  assert.ok(present <= 13, `50 Hz window must not fill a 1s 25 Hz grid, got ${present}`);
  assert.ok(grid.missing_fraction >= 0.4);
});

test('v26 saturation rail marks reconstruction ambiguous but keeps original deltas', () => {
  const deltas = Array(24).fill(3);
  deltas[5] = 32767;
  const frame = v26Frame({ first: 1000, deltas });
  const rec = ppgRecordFromFrame(frame, 'puffin', {});
  assert.equal(rec.has_saturated_delta, true);
  assert.equal(rec.reconstruction_ambiguous, true);
  assert.equal(rec.canonical_stage_input, false);
  assert.equal(rec.optical_deltas[5], 32767);
  assert.ok(rec.trusted_sample_count <= 6);
  assert.ok(rec.trusted_samples.every((v) => Number.isFinite(v)));
});

test('v26 invalid first sample is not a clean PPG input', () => {
  const recn = reconstructSaturatedDeltaWindow(null, [1, 2, 3]);
  assert.equal(recn.first_sample_invalid, true);
  assert.equal(recn.trusted_sample_count, 0);
  const frame = v26Frame({ first: 2_000_000_000, deltas: Array(24).fill(1) });
  const rec = ppgRecordFromFrame(frame, 'puffin', {});
  assert.equal(rec.first_sample_invalid, true);
  assert.equal(rec.canonical_stage_input, false);
  assert.equal(rec.optical_deltas.length, 24);
});

test('unsupported v26 rate is not a canonical stage input', () => {
  const rec = {
    schema: 'frwhoop_ppg_raw_v1',
    layout: 'v26',
    canonical_stage_input: true,
    sensor_ts: 50,
    sample_rate_hz: 24,
    samples: Array(24).fill(1),
    trusted_samples: Array(24).fill(1),
  };
  const sensors = extractSleepSensors({ ppgRecords: [rec] });
  assert.equal(sensors.ppg.length, 0);
});

test('WHOOP 4 type-43 vs WHOOP 5 v26 domain mismatch fails closed', () => {
  const artifact = wristArtifact();
  const start = 1_700_000_000;
  const end = start + 10 * 60;
  const gravity = [];
  const hr = [];
  for (let t = start; t < end; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 55 });
  }
  const ppgRecords = [];
  for (let t = start; t < end; t += 1) {
    ppgRecords.push({
      schema: 'frwhoop_ppg_raw_v1',
      kind: 'rt43_optical_whoop4',
      layout: 'whoop4-1921',
      sensor_ts: t,
      sample_rate_hz: 437,
      samples: Array(40).fill(1000),
      trusted_samples: Array(40).fill(1000),
      canonical_stage_input: true,
    });
  }
  const v3 = stageSessionV3({
    start, end, gravity, hr, rr: [], ppgRecords,
    artifact, allowSynthetic: true, expand: false, placement: 'wrist',
    deviceFamily: 'whoop4',
  });
  assert.equal(v3.fallback, true);
  assert.equal(v3.fallback_reason, 'unsupported_domain');
});

test('wrist-only artifact rejects bicep placement', () => {
  const artifact = wristArtifact();
  assert.equal(domainSupported({
    device_family: 'whoop5', signal_layout: 'v26', placement: 'bicep', native_rate_hz: 25,
  }, artifact, { needsPpg: true }).ok, false);
  const start = 1_700_000_000;
  const end = start + 8 * 60;
  const gravity = [];
  const hr = [];
  const ppgRecords = [];
  for (let t = start; t < end; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 55 });
    ppgRecords.push({
      schema: 'frwhoop_ppg_raw_v1', layout: 'v26', kind: 'hist_v26',
      sensor_ts: t, sample_rate_hz: 25, samples: Array(25).fill(200000),
      trusted_samples: Array(25).fill(200000), canonical_stage_input: true,
    });
  }
  const v3 = stageSessionV3({
    start, end, gravity, hr, rr: [], ppgRecords,
    artifact, allowSynthetic: true, expand: false, placement: 'bicep',
    deviceFamily: 'whoop5',
  });
  assert.equal(v3.fallback, true);
  assert.equal(v3.fallback_reason, 'unsupported_domain');
});

test('type-48 missing wrist-on is ambiguous and does not erase a worn night', () => {
  const spans = wristOffIntervalsFromEvents([
    { kind: 'event', event_id: 10, event_name: 'WRIST_OFF', event_ts: 100 },
  ]);
  assert.equal(spans[0].ambiguous, true);
  assert.equal(spans[0].missing_on, true);
  const start = 1_700_000_000;
  const end = start + 20 * 60;
  const gravity = [];
  const hr = [];
  for (let t = start; t < end; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 55 });
  }
  const v3 = stageSessionV3({
    start, end, gravity, hr, rr: [],
    events: [{ kind: 'event', event_id: 10, event_name: 'WRIST_OFF', event_ts: start + 60 }],
    artifact: toySleepV3Artifact(), allowSynthetic: true, expand: false,
  });
  assert.equal(v3.fallback, false);
  const later = v3.epochs.filter((e) => e.start >= start + 10 * 60);
  assert.ok(later.some((e) => e.stage !== INTERNAL_UNSCORED), 'worn signal after dangling OFF stays scored');
});

test('duplicate OFF/ON, boundary, and out-of-order type-48 events', () => {
  const spans = wristOffIntervalsFromEvents([
    { event_id: 9, event_name: 'WRIST_ON', event_ts: 80 },
    { event_id: 10, event_name: 'WRIST_OFF', event_ts: 50 },
    { event_id: 10, event_name: 'WRIST_OFF', event_ts: 55 },
    { event_id: 9, event_name: 'WRIST_ON', event_ts: 80 },
    { event_id: 9, event_name: 'WRIST_ON', event_ts: 81 },
  ]);
  assert.deepEqual(spans.map((s) => ({ start: s.start, end: s.end })), [{ start: 50, end: 80 }]);
  const onBoundary = wristOffIntervalsFromEvents([
    { event_id: 10, event_name: 'WRIST_OFF', event_ts: 90 },
    { event_id: 9, event_name: 'WRIST_ON', event_ts: 120 },
  ]);
  assert.deepEqual(onBoundary[0], { start: 90, end: 120, ambiguous: false });
});

test('nap detailed stages abstain rather than fabricating Light', () => {
  const start = 1_700_000_000;
  const end = start + 45 * 60;
  const gravity = [];
  const hr = [];
  for (let t = start; t < end; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 52 });
  }
  const v3 = stageSessionV3({
    start, end, gravity, hr, rr: [],
    artifact: toySleepV3Artifact(), allowSynthetic: true, isNap: true, expand: false,
  });
  assert.equal(v3.fallback, false);
  assert.ok(v3.stages.every((s) => s.stage === 'wake' || s.stage === INTERNAL_UNSCORED));
  assert.equal(v3.provenance.nap_stage_policy, 'wake_or_unscored');
});

test('irregular IBI and PPG corruption drop PPG tier rather than high-confidence deep/REM', () => {
  const start = 1_700_000_000;
  const end = start + 12 * 60;
  const gravity = [];
  const hr = [];
  const rr = [];
  const ppgRecords = [];
  for (let t = start; t < end; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 70 });
    rr.push({ ts: t, rrMs: t % 2 ? 400 : 1800 });
    ppgRecords.push({
      schema: 'frwhoop_ppg_raw_v1', layout: 'v26', sensor_ts: t, sample_rate_hz: 25,
      samples: Array(25).fill(524287), trusted_samples: [],
      canonical_stage_input: true, reconstruction_ambiguous: true, has_saturated_delta: true,
    });
  }
  const artifact = toySleepV3Artifact();
  const v3 = stageSessionV3({
    start, end, gravity, hr, rr, ppgRecords,
    artifact, allowSynthetic: true, expand: false, placement: 'unknown',
  });
  assert.equal(v3.ok, true);
  if (!v3.fallback) {
    assert.notEqual(v3.provenance.modality_tier, 'A');
  }
});

test('modality tier A-only artifact cannot run HR-only nights', () => {
  const artifact = wristArtifact({
    modality_tiers: { A: { ppg: 0.5, imu: 0.5, cardiac: 0.5 } },
    supported_domains: toySleepV3Artifact().supported_domains,
  });
  const start = 1_700_000_000;
  const end = start + 10 * 60;
  const gravity = [];
  const hr = [];
  for (let t = start; t < end; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 55 });
  }
  const v3 = stageSessionV3({
    start, end, gravity, hr, rr: [], artifact, allowSynthetic: true, expand: false,
  });
  assert.equal(v3.fallback, true);
  assert.equal(v3.fallback_reason, 'insufficient_v3_modalities');
});

test('preprocessing hash mismatch rejects the artifact', () => {
  const artifact = toySleepV3Artifact();
  artifact.preprocessing_sha256 = '0'.repeat(64);
  artifact.artifact_sha256 = undefined;
  const v = validateSleepV3Artifact(artifact, { allowSynthetic: true });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'preprocessing_sha256_mismatch');
});

test('feature_rules is not a production neural V3', () => {
  const toy = toySleepV3Artifact();
  assert.equal(validateSleepV3Artifact(toy).ok, false);
  const noPath = {
    ...toy,
    trained_on: 'dreamt',
    model: { type: 'onnx' },
    artifact_sha256: undefined,
  };
  assert.equal(validateSleepV3Artifact(noPath).ok, false);
  assert.equal(validateSleepV3Artifact(noPath).reason, 'onnx_path_missing');
});

test('class order is wake, light, deep, rem; interior gaps stay unscored without fake probs', () => {
  const start = 1_700_000_000;
  const gravity = [];
  const hr = [];
  for (let t = start; t < start + 6 * 60; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 55 });
  }
  for (let t = start + 12 * 60; t < start + 18 * 60; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 55 });
  }
  const v3 = stageSessionV3({
    start, end: start + 18 * 60, gravity, hr, rr: [],
    artifact: toySleepV3Artifact(), allowSynthetic: true, expand: false,
  });
  const mid = v3.epochs.filter((e) => e.start >= start + 7 * 60 && e.start < start + 11 * 60);
  assert.ok(mid.length > 3);
  assert.ok(mid.every((e) => e.stage === INTERNAL_UNSCORED));
  assert.ok(mid.every((e) => e.probs == null));
  const starts = v3.epochs.map((e) => e.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.equal(new Set(starts).size, starts.length);
});

test('quiet-wake family: stillness does not force Light; elevated HR does not force Wake', () => {
  const start = 1_700_000_000;
  const end = start + 20 * 60;
  function run(bpm) {
    const gravity = [];
    const hr = [];
    for (let t = start; t < end; t += 1) {
      gravity.push({ ts: t, x: 0, y: 0, z: 1 });
      hr.push({ ts: t, bpm });
    }
    const artifact = toySleepV3Artifact();
    artifact.model = {
      type: 'feature_mlp',
      features: ['enmo_mean'],
      mean: [0], scale: [1],
      weights: [[6], [1], [1], [1]],
      bias: [-2, 1.5, 1, 0.5],
    };
    artifact.artifact_sha256 = undefined;
    return stageSessionV3({
      start, end, gravity, hr, rr: [], artifact, allowSynthetic: true, expand: false,
    });
  }
  const still = run(58);
  const high = run(92);
  assert.equal(still.fallback, false);
  assert.equal(high.fallback, false);
  const mid = (v3) => v3.epochs.find((e) => e.start >= start + 300 && e.stage !== INTERNAL_UNSCORED);
  assert.ok(mid(still));
  assert.notEqual(mid(high).stage, 'wake');
});

test('deterministic replay of the same sensors', () => {
  const start = 1_700_000_000;
  const end = start + 8 * 60;
  const gravity = [];
  const hr = [];
  for (let t = start; t < end; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 55 });
  }
  const args = {
    start, end, gravity, hr, rr: [],
    artifact: toySleepV3Artifact(), allowSynthetic: true, expand: false,
  };
  const a = stageSessionV3(args);
  const b = stageSessionV3(args);
  assert.deepEqual(a.stages, b.stages);
  assert.deepEqual(a.epochProbabilities, b.epochProbabilities);
});

test('overlapping PPG objects dedupe; missing records leave holes', () => {
  const rec = {
    schema: 'frwhoop_ppg_raw_v1', layout: 'v26', sensor_ts: 100,
    sample_rate_hz: 25, samples: Array(25).fill(9), trusted_samples: Array(25).fill(9),
    canonical_stage_input: true, identity: { derived_id: 'x' },
  };
  const sensors = extractSleepSensors({ ppgRecords: [rec, { ...rec }, { ...rec, sensor_ts: 130 }] });
  assert.equal(sensors.ppg.length, 2);
});

test('FRWHOOP_SLEEP_V3=off restores V2-only and does not change V2 stages', () => {
  const prior = process.env.FRWHOOP_SLEEP_V3;
  process.env.FRWHOOP_SLEEP_V3 = 'off';
  try {
    assert.equal(sleepV3Mode(), 'off');
    assert.equal(shouldComputeSleepV3(), false);
    const start = 1_700_000_000;
    const samples = [];
    for (let t = start; t < start + 8 * 3600; t += 60) {
      samples.push({
        t: new Date(t * 1000).toISOString(),
        bpm: 52,
        gravity: { x: 0, y: 0, z: 1 },
      });
    }
    const v2 = stageSession({
      start, end: start + 8 * 3600,
      gravity: samples.map((s, i) => ({ ts: start + i * 60, x: 0, y: 0, z: 1 })),
      hr: samples.map((s, i) => ({ ts: start + i * 60, bpm: 52 })),
      rr: [],
    });
    const scored = scoreSleep({ samples, extras: { timeZone: 'UTC', shadowV3: false } });
    assert.equal(scored.ok, true);
    const main = (scored.sessions || [scored]).find((s) => !s.isNap) || scored;
    assert.ok(!main.shadowV3 || main.shadowV3.v3_not_executed_reason);
  } finally {
    if (prior == null) delete process.env.FRWHOOP_SLEEP_V3;
    else process.env.FRWHOOP_SLEEP_V3 = prior;
  }
});

test('missing and corrupt artifacts fall back to V2', () => {
  clearSleepV3ArtifactCache();
  const missing = loadSleepV3Artifact({ path: null });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'artifact_missing');
  const tmp = path.join(os.tmpdir(), 'sleep-v3-corrupt.json');
  fs.writeFileSync(tmp, '{not json');
  const corrupt = loadSleepV3Artifact({ path: tmp });
  assert.equal(corrupt.ok, false);
  const start = 1_700_000_000;
  const end = start + 10 * 60;
  const gravity = [];
  const hr = [];
  for (let t = start; t < end; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 55 });
  }
  const v2 = stageSession({ start, end, gravity, hr, rr: [] });
  const v3 = stageSessionV3({ start, end, gravity, hr, rr: [], artifact: { schema: 'nope' } });
  assert.equal(v3.fallback, true);
  assert.deepEqual(v3.stages, v2);
  const boom = stageSessionV3({
    start, end, gravity, hr, rr: [],
    artifact: {
      ...toySleepV3Artifact(),
      model: { type: 'onnx', path: path.join(os.tmpdir(), 'nope.onnx') },
      trained_on: 'synthetic',
      artifact_sha256: undefined,
    },
    allowSynthetic: true, expand: false,
  });
  assert.equal(boom.fallback, true);
  assert.ok(['onnx_artifact_missing', 'onnxruntime_unavailable', 'onnx_inference_exception', 'onnx_path_missing'].includes(boom.fallback_reason) || boom.fallback);
});

test('beta does not surface V3 without an enrolled user and real artifact', () => {
  const prior = process.env.FRWHOOP_SLEEP_V3;
  const priorUsers = process.env.FRWHOOP_SLEEP_V3_BETA_USERS;
  process.env.FRWHOOP_SLEEP_V3 = 'beta';
  process.env.FRWHOOP_SLEEP_V3_BETA_USERS = '';
  try {
    assert.equal(shouldSurfaceSleepV3({ userId: 'u1', artifactOk: true }), false);
    process.env.FRWHOOP_SLEEP_V3_BETA_USERS = 'u1';
    assert.equal(shouldSurfaceSleepV3({ userId: 'u1', artifactOk: false }), false);
    assert.equal(shouldSurfaceSleepV3({ userId: 'u1', artifactOk: true }), true);
  } finally {
    if (prior == null) delete process.env.FRWHOOP_SLEEP_V3;
    else process.env.FRWHOOP_SLEEP_V3 = prior;
    if (priorUsers == null) delete process.env.FRWHOOP_SLEEP_V3_BETA_USERS;
    else process.env.FRWHOOP_SLEEP_V3_BETA_USERS = priorUsers;
  }
});

test('ONNX adapter fails closed when runtime or model is absent', () => {
  const out = runSleepV3Onnx([], { model: { type: 'onnx', path: '/tmp/not-a-model.onnx' } });
  assert.equal(out.ok, false);
});

test('Python/Node box-mean resampling agrees on a 50 Hz window', () => {
  const samples = [];
  for (let i = 0; i < 25; i += 1) samples.push(1000 + i);
  const grid = resampleToTargetGrid([{
    ts: 0, hz: 50, native_rate_hz: 50, samples,
  }], { epochStart: 0, epochEnd: 1, targetHz: 25 });
  assert.equal(grid.method, 'box_mean_time_grid');
  assert.equal(grid.values.length, 25);
  assert.ok(Number.isFinite(grid.values[0]));
  assert.equal(grid.values[20], null);
  const golden = JSON.parse(fs.readFileSync(
    path.join(here, '../../ml/sleep_v3/tests/golden_resample_50hz.json'),
    'utf8',
  ));
  assert.deepEqual(grid.values, golden.expected);
});

test('discontinuous PIP counters still archive; duplicates at the same timestamp collapse', () => {
  const a = ppgRecordFromFrame(v26Frame({ pip: 1, unix: 1_700_000_000 }), 'puffin', {});
  const b = ppgRecordFromFrame(v26Frame({ pip: 40, unix: 1_700_000_001 }), 'puffin', {});
  assert.equal(a.pip_state_counter, 1);
  assert.equal(b.pip_state_counter, 40);
  const sensors = extractSleepSensors({
    ppgRecords: [a, a, b, { ...a, sensor_ts: a.sensor_ts, identity: { derived_id: 'dup' } }],
  });
  assert.equal(sensors.ppg.length, 2);
});

test('overlapping IMU manifests at the same timestamp keep one window', () => {
  const rec = {
    schema: 'frwhoop_imu_raw_v1', kind: 'hist_v21', layout: 'v21',
    sensor_ts: 100, sample_rate_hz: 100,
    accel_x: Array(100).fill(1), accel_y: Array(100).fill(0), accel_z: Array(100).fill(4096),
  };
  const sensors = extractSleepSensors({
    imuRecords: [rec, { ...rec, accel_x: Array(100).fill(9) }, { ...rec, sensor_ts: 101 }],
  });
  assert.equal(sensors.imu.length, 2);
});

test('DST local clock uses IANA offset at epoch mid, not a fixed UTC offset', () => {
  const start = Date.parse('2026-03-08T09:00:00Z') / 1000;
  const sensors = {
    gravity: [{ ts: start + 15, x: 0, y: 0, z: 1 }],
    hr: [{ ts: start + 15, bpm: 55 }],
    rr: [], imu: [], ppg: [], skinTemp: [], dynAccel: [], wristOff: [],
    placement: 'unknown',
  };
  const [epoch] = buildEpochFeatures(sensors, start, start + 30, { timeZone: 'America/Los_Angeles' });
  assert.ok(epoch);
  assert.notEqual(epoch.compact.clock_sin, 0);
});

test('replace-sleep RPC serializes concurrent recomputes and keeps user-edited bounds', () => {
  const sql = fs.readFileSync(
    path.join(here, '../../supabase/migrations/20260902120000_sleep_stager_v3_shadow_rpc.sql'),
    'utf8',
  );
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /when s\.user_modified then s\.start_at/);
  assert.match(sql, /shadow_v3/);
  assert.match(sql, /unscored_min/);
});

test('V2 stageSession output is independent of FRWHOOP_SLEEP_V3', () => {
  const start = 1_700_000_000;
  const gravity = [];
  const hr = [];
  for (let t = start; t < start + 20 * 60; t += 1) {
    gravity.push({ ts: t, x: 0, y: 0, z: 1 });
    hr.push({ ts: t, bpm: 55 });
  }
  const v2 = stageSession({ start, end: start + 20 * 60, gravity, hr, rr: [] });
  const prior = process.env.FRWHOOP_SLEEP_V3;
  process.env.FRWHOOP_SLEEP_V3 = 'shadow';
  try {
    const again = stageSession({ start, end: start + 20 * 60, gravity, hr, rr: [] });
    assert.deepEqual(again, v2);
  } finally {
    if (prior == null) delete process.env.FRWHOOP_SLEEP_V3;
    else process.env.FRWHOOP_SLEEP_V3 = prior;
  }
});

test('IMU without a declared or v21 layout rate is not inferred from sample count', () => {
  const sensors = extractSleepSensors({
    imuRecords: [{
      accel_x: Array(100).fill(1),
      accel_y: Array(100).fill(0),
      accel_z: Array(100).fill(4096),
      sensor_ts: 50,
    }],
  });
  assert.equal(sensors.imu.length, 0);
});

test('missing wrist-on extras survive extractSleepSensors and do not wipe later epochs', () => {
  const sensors = extractSleepSensors({
    wristOff: [{ start: 100, end: Number.POSITIVE_INFINITY, missing_on: true, ambiguous: true }],
  });
  assert.equal(sensors.wristOff.length, 1);
  assert.equal(sensors.wristOff[0].missing_on, true);
  assert.equal(sensors.wristOff[0].ambiguous, true);
});

test('saturated v26 is not compact PPG even when deltas are retained', () => {
  const deltas = Array(24).fill(3);
  deltas[5] = 32767;
  const rec = ppgRecordFromFrame(v26Frame({ first: 1000, deltas }), 'puffin', {});
  assert.equal(rec.canonical_stage_input, false);
  const sensors = extractSleepSensors({ ppgRecords: [rec] });
  assert.equal(sensors.ppg.length, 0);
});
