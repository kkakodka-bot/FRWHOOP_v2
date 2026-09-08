import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeStepsV3,
  inferGaitProbability,
  smoothGaitProbabilities,
  stepsV3ArtifactSha,
  validateStepsV3Artifact,
  _internal as stepsV3Internal,
} from '../metrics/stepsV3.js';
import {
  clearStepsV3ArtifactCache,
  loadStepsV3Artifact,
  STEPS_V3_FIXTURE_ARTIFACT_PATH,
  STEPS_V3_PUBLIC_ARTIFACT_PATH,
} from '../metrics/stepsV3Artifact.js';
import { makeImuRecords, walkAccel, walkGyro } from './stepsV2Synth.js';

const T0 = 1_787_000_000;
const fixture = JSON.parse(readFileSync(STEPS_V3_FIXTURE_ARTIFACT_PATH, 'utf8'));

test('artifact loader validates and caches the versioned JSON contract', () => {
  clearStepsV3ArtifactCache();
  const first = loadStepsV3Artifact({ path: STEPS_V3_FIXTURE_ARTIFACT_PATH });
  const second = loadStepsV3Artifact({ path: STEPS_V3_FIXTURE_ARTIFACT_PATH });
  assert.equal(first.ok, true);
  assert.equal(first, second);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);

  const invalid = structuredClone(first.artifact);
  invalid.model.weights = [1];
  assert.equal(validateStepsV3Artifact(invalid).reason, 'artifact_logistic_parameters_invalid');

  clearStepsV3ArtifactCache();
  const wrongHash = loadStepsV3Artifact({
    path: STEPS_V3_FIXTURE_ARTIFACT_PATH,
    expectedSha256: 'f'.repeat(64),
  });
  assert.equal(wrongHash.ok, false);
  assert.equal(wrongHash.reason, 'artifact_sha256_mismatch');

  const selfHashed = structuredClone(first.artifact);
  selfHashed.artifact_sha256 = stepsV3ArtifactSha(selfHashed);
  assert.equal(validateStepsV3Artifact(selfHashed).ok, true);
  selfHashed.model.bias += 0.1;
  assert.equal(validateStepsV3Artifact(selfHashed).reason, 'artifact_sha256_mismatch');
});

test('checked-in public shadow artifact validates with its self hash', () => {
  clearStepsV3ArtifactCache();
  const loaded = loadStepsV3Artifact({
    path: STEPS_V3_PUBLIC_ARTIFACT_PATH,
    allowFixture: false,
  });
  assert.equal(loaded.ok, true, loaded.reason);
  assert.equal(loaded.sha256, loaded.artifact.artifact_sha256);
  assert.equal(loaded.artifact.selection.architecture, 'engineered_logistic_gait_plus_peak');
});

test('logistic and Conv1D inference paths are deterministic', () => {
  const signal = Array.from({ length: 200 }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 2 * i / 100));
  const logisticA = inferGaitProbability(signal, fixture);
  const logisticB = inferGaitProbability(signal, fixture);
  assert.equal(logisticA, logisticB);
  assert.ok(logisticA > 0.6);

  const cnn = structuredClone(fixture);
  cnn.artifact_version = 'unit-cnn-v1';
  cnn.model = {
    type: 'cnn',
    input_mean: 0,
    input_scale: 1,
    conv_layers: [{
      weights: [[[-1], [1]]],
      bias: [0],
      activation: 'relu',
    }],
    output: { weights: [8], bias: -0.2 },
  };
  cnn.artifact_sha256 = stepsV3ArtifactSha(cnn);
  assert.equal(validateStepsV3Artifact(cnn).ok, true);
  const cnnA = inferGaitProbability(signal, cnn);
  const cnnB = inferGaitProbability(signal, cnn);
  assert.equal(cnnA, cnnB);
  assert.ok(cnnA > 0 && cnnA < 1);
});

test('exported PyTorch-style three-axis CNN contract validates and infers', () => {
  const artifact = structuredClone(fixture);
  delete artifact.artifact_sha256;
  artifact.artifact_version = 'pytorch-cnn-test';
  artifact.window.size_samples = 20;
  artifact.window.stride_samples = 10;
  artifact.model = {
    type: 'cnn',
    input: 'xyz_g',
    layers: [
      {
        type: 'Conv1d',
        weight: [[
          [0.1, 0, -0.1],
          [0.05, 0, -0.05],
          [0.2, 0, -0.2],
        ]],
        bias: [0],
        stride: [1],
        padding: [1],
        kernel_size: [3],
      },
      { type: 'ReLU' },
      { type: 'AdaptiveAvgPool1d' },
      { type: 'Flatten' },
      { type: 'Linear', weight: [[1]], bias: [0] },
    ],
  };
  artifact.artifact_sha256 = stepsV3ArtifactSha(artifact);
  const validation = validateStepsV3Artifact(artifact);
  assert.equal(validation.ok, true, validation.reason);
  const xyz = Array.from({ length: 20 }, (_, index) => [
    Math.sin(index / 2) * 0.1,
    0,
    1 + Math.cos(index / 2) * 0.1,
  ]);
  const probability = inferGaitProbability(new Array(20).fill(0), artifact, xyz);
  assert.ok(probability > 0 && probability < 1);
});

test('hysteresis smoothing has stable enter and exit boundaries', () => {
  assert.deepEqual(
    smoothGaitProbabilities(
      [0.59, 0.6, 0.5, 0.4, 0.399, 0.7],
      { type: 'hysteresis', enter: 0.6, exit: 0.4 },
      0.5,
    ),
    [false, true, true, true, false, true],
  );
});

test('walking emits unique timestamped events and exact 60s buckets', () => {
  const records = makeImuRecords({
    seconds: 70,
    accelAt: (t) => walkAccel(t, 110),
    gyroAt: (t) => walkGyro(t, 110),
    t0: T0,
  });
  const result = computeStepsV3({
    imuRecords: records,
    artifact: fixture,
    dayStartMs: T0 * 1000,
    dayEndMs: (T0 + 70) * 1000,
  });
  assert.equal(result.status, 'ok');
  assert.ok(result.total > 60);
  assert.ok(result.gait_windows.length > 0);
  assert.ok(result.candidate_events.length >= result.events.length);
  assert.equal(
    result.rejected_candidates.length + result.events.length,
    result.candidate_events.length,
  );
  const replay = computeStepsV3({
    imuRecords: records,
    artifact: fixture,
    dayStartMs: T0 * 1000,
    dayEndMs: (T0 + 70) * 1000,
  });
  assert.deepEqual(replay, result);
  assert.equal(new Set(result.events.map((event) => event.timestamp_ms)).size, result.events.length);
  assert.equal(result.buckets_60s.reduce((sum, bucket) => sum + bucket.count, 0), result.total);
  assert.ok(result.accepted_gait_intervals.length > 0);
  assert.equal(result.auxiliary_agreement.gyro.available, true);
});

test('isolated motion is rejected instead of counted as gait', () => {
  const records = makeImuRecords({
    seconds: 20,
    accelAt: (t) => {
      const hit = (t > 3 && t < 3.12) || (t > 10 && t < 10.12) || (t > 16 && t < 16.12);
      return { x: 0.1, y: 0, z: hit ? 2.4 : 1 };
    },
    t0: T0,
  });
  const result = computeStepsV3({
    imuRecords: records,
    artifact: fixture,
    dayStartMs: T0 * 1000,
    dayEndMs: (T0 + 20) * 1000,
  });
  assert.equal(result.total, 0);
  assert.equal(result.events.length, 0);
});

test('missing, invalid, and insufficient artifacts or coverage fail closed', () => {
  assert.equal(computeStepsV3({ artifact: null }).status, 'unavailable');
  assert.equal(computeStepsV3({ artifact: { schema_version: 'bad' } }).status, 'unavailable');
  const short = makeImuRecords({
    seconds: 2,
    accelAt: (t) => walkAccel(t, 110),
    t0: T0,
  });
  const result = computeStepsV3({ imuRecords: short, artifact: fixture });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.unavailable_reason, 'imu_coverage_below_minimum');
  assert.equal(result.total, null);
});

test('artifact schema and embedded SHA are mandatory', () => {
  const noHash = structuredClone(fixture);
  delete noHash.artifact_sha256;
  assert.equal(
    validateStepsV3Artifact(noHash).reason,
    'artifact_sha256_missing_or_invalid',
  );
  const noSchema = structuredClone(fixture);
  delete noSchema.schema;
  assert.equal(
    validateStepsV3Artifact(noSchema).reason,
    'artifact_public_schema_unsupported',
  );
});

test('artifact cache invalidates when content changes at the same path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'frwhoop-steps-v3-'));
  const path = join(directory, 'artifact.json');
  try {
    writeFileSync(path, `${JSON.stringify(fixture)}\n`);
    clearStepsV3ArtifactCache();
    const first = loadStepsV3Artifact({
      path,
      expectedSha256: fixture.artifact_sha256,
      allowFixture: false,
    });
    assert.equal(first.ok, true);
    const changed = structuredClone(fixture);
    changed.model.bias += 0.25;
    changed.artifact_sha256 = stepsV3ArtifactSha(changed);
    writeFileSync(path, `${JSON.stringify(changed)}\n`);
    const second = loadStepsV3Artifact({
      path,
      expectedSha256: fixture.artifact_sha256,
      allowFixture: false,
    });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'artifact_sha256_mismatch');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('published ML and runtime artifacts are byte-identical', () => {
  const mlArtifact = readFileSync(
    new URL('../../ml/steps_v3/artifacts/public_model_v3.json', import.meta.url),
  );
  const runtimeArtifact = readFileSync(STEPS_V3_PUBLIC_ARTIFACT_PATH);
  assert.deepEqual(runtimeArtifact, mlArtifact);
});

test('non-100 Hz input fails closed instead of being misinterpreted', () => {
  const records = makeImuRecords({
    seconds: 20,
    accelAt: (t) => walkAccel(t, 110),
    t0: T0,
  });
  records[0].sample_rate_hz = 50;
  const result = computeStepsV3({ imuRecords: records, artifact: fixture });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.unavailable_reason, 'imu_sample_rate_unsupported');
  assert.equal(result.input_integrity.unsupported_rate_records, 1);

  const unstamped = makeImuRecords({
    seconds: 20,
    accelAt: (t) => walkAccel(t, 110),
    t0: T0,
  });
  unstamped.forEach((record) => { delete record.sample_rate_hz; });
  const missing = computeStepsV3({ imuRecords: unstamped, artifact: fixture });
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.unavailable_reason, 'imu_sample_rate_unsupported');
  assert.equal(missing.input_integrity.unsupported_rate_records, 20);
});

test('day clipping prevents samples and events leaking across boundaries', () => {
  const records = makeImuRecords({
    seconds: 70,
    accelAt: (t) => walkAccel(t, 110),
    t0: T0 - 10,
  });
  const dayStartMs = T0 * 1000;
  const dayEndMs = (T0 + 40) * 1000;
  const result = computeStepsV3({
    imuRecords: records,
    artifact: fixture,
    dayStartMs,
    dayEndMs,
  });
  assert.notEqual(result.status, 'unavailable');
  assert.equal(
    result.events.every(
      (event) => event.timestamp_ms >= dayStartMs && event.timestamp_ms < dayEndMs,
    ),
    true,
  );
  assert.equal(
    result.candidate_events.every(
      (event) => event.timestamp_ms >= dayStartMs && event.timestamp_ms < dayEndMs,
    ),
    true,
  );
});

test('material gaps reset segments and preserve post-gap wall-clock time', () => {
  const records = makeImuRecords({
    seconds: 30,
    accelAt: (t) => walkAccel(t, 110),
    t0: T0,
  }).filter((_, index) => index < 10 || index >= 20);
  const prepared = stepsV3Internal.prepareRecords(records);
  const { segments } = stepsV3Internal.imuRecordsToV3Segments(prepared.records, {
    sampleRateHz: 100,
    gapThresholdMs: 250,
  });
  assert.equal(segments.length, 2);
  assert.equal(segments[0].t0, T0 * 1000);
  assert.equal(segments[1].t0, (T0 + 20) * 1000);
});

test('conflicting overlaps are deterministic and accuracy-ineligible', () => {
  const records = makeImuRecords({
    seconds: 30,
    accelAt: (t) => walkAccel(t, 110),
    t0: T0,
  });
  const conflict = structuredClone(records[5]);
  conflict.accel_z = conflict.accel_z.map((value) => value + 100);
  for (const record of [...records, conflict]) {
    record.clock_verified = true;
    record._manifest_verified = true;
    record._manifest_sha256 = 'a'.repeat(64);
  }
  const forward = computeStepsV3({
    imuRecords: [...records, conflict],
    artifact: fixture,
  });
  const reverse = computeStepsV3({
    imuRecords: [conflict, ...records].reverse(),
    artifact: fixture,
  });
  assert.deepEqual(forward.events, reverse.events);
  assert.equal(forward.input_integrity.conflicting_records, 1);
  assert.equal(forward.evidence_eligibility.reason, 'imu_conflicting_overlap');
});

test('partial record overlaps are deterministic and accuracy-ineligible', () => {
  const records = makeImuRecords({
    seconds: 30,
    accelAt: (t) => walkAccel(t, 110),
    t0: T0,
  });
  const overlap = structuredClone(records[5]);
  overlap.sensor_ts += 0.5;
  for (const record of [...records, overlap]) {
    record.clock_verified = true;
    record._manifest_verified = true;
    record._manifest_sha256 = 'a'.repeat(64);
  }
  const forward = computeStepsV3({
    imuRecords: [...records, overlap],
    artifact: fixture,
  });
  const reverse = computeStepsV3({
    imuRecords: [overlap, ...records].reverse(),
    artifact: fixture,
  });
  assert.deepEqual(forward.events, reverse.events);
  assert.ok(forward.input_integrity.overlap_samples_dropped > 0);
  assert.equal(forward.evidence_eligibility.reason, 'imu_conflicting_overlap');
});

test('clock and manifest provenance never infer verification metadata', () => {
  const records = makeImuRecords({
    seconds: 10,
    accelAt: (t) => walkAccel(t, 110),
    t0: T0,
  });
  records[0].corrected_at = new Date((T0 + 100) * 1000).toISOString();
  records[0]._manifest_sha256 = 'a'.repeat(64);
  let result = computeStepsV3({ imuRecords: records, artifact: fixture });
  assert.equal(result.clock.verified_records, 0);
  assert.equal(result.manifest_sha256.length, 0);
  assert.equal(result.evidence_eligibility.accuracy_eligible, false);

  records[0].clock_verified = true;
  records[0]._manifest_verified = true;
  result = computeStepsV3({ imuRecords: records, artifact: fixture });
  assert.deepEqual(result.manifest_sha256, ['a'.repeat(64)]);
  assert.equal(result.evidence_eligibility.accuracy_eligible, false);

  for (const record of records) {
    record.clock_verified = true;
    record._manifest_verified = true;
    record._manifest_sha256 = 'a'.repeat(64);
  }
  result = computeStepsV3({ imuRecords: records, artifact: fixture });
  assert.equal(result.evidence_eligibility.accuracy_eligible, true);
});

test('clock provenance distinguishes ordinary timestamps from applied correction', () => {
  const ordinary = stepsV3Internal.prepareRecords([{
    t: new Date(T0 * 1000).toISOString(),
  }]);
  assert.equal(ordinary.clock.corrected_records, 0);
  assert.equal(ordinary.clock.quality, 'unverified');

  const zeroOffset = stepsV3Internal.prepareRecords([{
    sensor_ts: T0,
    clock_offset_sec: 0,
  }]);
  assert.equal(zeroOffset.clock.corrected_records, 1);
  assert.equal(zeroOffset.clock.quality, 'corrected_unverified');
});

test('center-timeline gait gating does not union the full 10 s window', () => {
  const labels = new Array(20).fill(false);
  labels[5] = true;
  const sampleCount = 3000;
  const hop = 100;
  const width = 1000;
  const union = new Array(sampleCount).fill(false);
  for (let i = 0; i < labels.length; i += 1) {
    if (!labels[i]) continue;
    const start = i * hop;
    for (let s = start; s < Math.min(sampleCount, start + width); s += 1) union[s] = true;
  }
  const center = stepsV3Internal.gaitStateAtSamples(labels, sampleCount, {
    hopSamples: hop,
    windowSamples: width,
  });
  assert.ok(center.filter(Boolean).length < union.filter(Boolean).length);
  assert.ok(center.some(Boolean));
});

test('published-style signal clips and low-passes the acceleration norm', () => {
  const xyz = Array.from({ length: 200 }, () => [0, 0, 1]);
  const signal = stepsV3Internal.publishedStyleSignal(xyz);
  assert.equal(signal.length, 200);
  assert.ok(Math.max(...signal.map(Math.abs)) <= 2 + 1e-9);
});
