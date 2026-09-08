import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  correctImuHistoricalClock,
  createMetricsEngine,
  loadImuRecordsForWindow,
} from '../metrics/engine.js';
import { computeStepsV3 } from '../metrics/stepsV3.js';
import { STEPS_V3_FIXTURE_ARTIFACT_PATH } from '../metrics/stepsV3Artifact.js';
import { encodeImuArchive, IMU_ARCHIVE_SCHEMA } from '../protocol/imuArchive.js';
import { makeImuRecords, walkAccel, walkGyro } from './stepsV2Synth.js';

const USER = '22222222-2222-4222-8222-222222222222';
const T0 = 1_787_000_000;
const DAY = new Date(T0 * 1000).toISOString().slice(0, 10);
const artifact = JSON.parse(readFileSync(STEPS_V3_FIXTURE_ARTIFACT_PATH, 'utf8'));

function makeEngine({ raw = null } = {}) {
  const payloads = [];
  const engine = createMetricsEngine({
    cfg: {
      localUserId: USER,
      rawStore: raw ? 'b2' : 'none',
      derivedStore: 'none',
      b2Bucket: 'FRWHOOP',
      buildHash: 'test',
    },
    stores: { raw, derived: null },
    stepsV3Artifact: artifact,
    now: () => new Date('2026-08-30T12:00:00.000Z'),
    db: {
      async listObjectManifests() {
        return [];
      },
      async upsertPayload(payload) {
        payloads.push(payload);
        return { ok: true };
      },
    },
  });
  return { engine, payloads };
}

test('IMU replay preserves raw time and corrects only a provably wrong RTC', () => {
  const sensorSec = Date.parse('2014-08-30T12:00:00.000Z') / 1000;
  const receivedAt = '2026-08-30T12:00:00.500Z';
  const [corrected] = correctImuHistoricalClock([{
    sensor_ts: sensorSec,
    subsec: 16384,
    received_at: receivedAt,
  }]);
  assert.equal(corrected.sensor_ts, sensorSec);
  assert.equal(corrected.corrected_sensor_ts, Date.parse(receivedAt));
  assert.equal(corrected.clock_correction, 'historical_provably_wrong_rtc');

  const plausible = correctImuHistoricalClock([{
    sensor_ts: Date.parse('2026-08-29T12:00:00.000Z') / 1000,
    received_at: receivedAt,
  }]);
  assert.equal(plausible[0].corrected_sensor_ts, undefined);
});

test('V2 canonical env cannot promote over V1; V3 shadow persists deterministically', async () => {
  const prior = process.env.FRWHOOP_STEPS_V2;
  process.env.FRWHOOP_STEPS_V2 = 'canonical';
  try {
    const imuRecords = makeImuRecords({
      seconds: 70,
      accelAt: (t) => walkAccel(t, 110),
      gyroAt: (t) => walkGyro(t, 110),
      t0: T0,
    });
    const samples = Array.from({ length: 70 }, (_, second) => ({
      t: new Date((T0 + second) * 1000).toISOString(),
      sensor_ts: T0 + second,
      steps: 2,
      step_cumulative: 1000 + second * 2,
      activity_class: 1,
      step_cadence: 110,
      bpm: 70,
    }));
    const { engine, payloads } = makeEngine();
    const input = {
      samples,
      extras: {
        day: DAY,
        timeZone: 'UTC',
        replay: true,
        imuRecords,
      },
    };
    const first = await engine.persistComputed(input);
    const second = await engine.persistComputed(input);

    assert.equal(first.dailyRow.steps, 140, 'V1 explicit deltas remain canonical');
    assert.equal(first.dailyRow.provenance.steps.canonical, 'v1');
    assert.equal(
      first.dailyRow.extras.steps_v1.event_buckets_60s.reduce(
        (sum, bucket) => sum + bucket.count,
        0,
      ),
      first.dailyRow.steps,
    );
    assert.ok(first.dailyRow.extras.steps_v2.event_buckets_60s.length > 0);
    assert.equal(first.dailyRow.confidence.steps.v3.status, 'partial');
    assert.ok(first.dailyRow.extras.steps_v3.event_count > 60);
    assert.equal(first.dailyRow.extras.steps_v3.events, undefined);
    assert.ok(first.dailyRow.extras.steps_v3.gait_window_count > 0);
    assert.equal(first.dailyRow.extras.steps_v3.gait_windows, undefined);
    assert.equal(first.dailyRow.extras.steps_v3.candidate_events, undefined);
    assert.equal(first.dailyRow.extras.steps_v3.rejected_candidates, undefined);
    assert.deepEqual(first.dailyRow.extras.steps_v3, second.dailyRow.extras.steps_v3);
    assert.deepEqual(first.stepsV3.events, second.stepsV3.events);

    const run = payloads[0].metric_runs.find((row) => row.algorithm === 'steps_v3');
    assert.ok(run);
    assert.equal(run.output_refs.canonical, false);
    assert.equal(run.output_refs.total, first.stepsV3.total);
    assert.equal(run.input_refs.clock.quality, 'unverified');
    assert.deepEqual(run.input_refs.manifest_sha256, []);
  } finally {
    if (prior == null) delete process.env.FRWHOOP_STEPS_V2;
    else process.env.FRWHOOP_STEPS_V2 = prior;
  }
});

test('persisted V3 shadow output retains an auditable decision artifact', async () => {
  const objects = new Map();
  const raw = {
    async listPrefix() {
      return [];
    },
    async putObject(key, body) {
      objects.set(key, Buffer.from(body));
      return { etag: 'test-etag' };
    },
    async head(key) {
      const body = objects.get(key);
      return { exists: Boolean(body), contentLength: body?.length };
    },
    async getObject(key) {
      return { body: objects.get(key) };
    },
  };
  const imuRecords = makeImuRecords({
    seconds: 70,
    accelAt: (t) => walkAccel(t, 110),
    gyroAt: (t) => walkGyro(t, 110),
    t0: T0,
  });
  const samples = Array.from({ length: 70 }, (_, second) => ({
    t: new Date((T0 + second) * 1000).toISOString(),
    sensor_ts: T0 + second,
    steps: 2,
    step_cumulative: 1000 + second * 2,
    bpm: 70,
  }));
  const { engine } = makeEngine({ raw });
  const result = await engine.persistComputed({
    samples,
    extras: { day: DAY, timeZone: 'UTC', imuRecords },
  });
  const reference = result.dailyRow.extras.steps_v3.decision_artifact;
  assert.ok(reference);
  assert.equal(reference.status, 'ready');
  assert.match(reference.sha256, /^[a-f0-9]{64}$/);
  const body = objects.get(reference.object_key);
  assert.ok(body);
  const decision = JSON.parse(gunzipSync(body).toString('utf8').trim());
  assert.equal(decision.schema, 'frwhoop_steps_v3_decisions_v1');
  assert.equal(decision.events.length, result.stepsV3.events.length);
  assert.equal(decision.gait_windows.length, result.stepsV3.gait_windows.length);
});

test('a shared multi-day replay list remains isolated per persisted day', async () => {
  const nextT0 = T0 + 86_400;
  const nextDay = new Date(nextT0 * 1000).toISOString().slice(0, 10);
  const imuRecords = [
    ...makeImuRecords({
      seconds: 70,
      accelAt: (t) => walkAccel(t, 110),
      gyroAt: (t) => walkGyro(t, 110),
      t0: T0,
    }),
    ...makeImuRecords({
      seconds: 70,
      accelAt: (t) => walkAccel(t, 110),
      gyroAt: (t) => walkGyro(t, 110),
      t0: nextT0,
    }),
  ];
  const samples = [T0, nextT0].flatMap((start) => (
    Array.from({ length: 70 }, (_, second) => ({
      t: new Date((start + second) * 1000).toISOString(),
      sensor_ts: start + second,
      steps: 2,
      step_cumulative: 1000 + second * 2,
      bpm: 70,
    }))
  ));
  const { engine } = makeEngine();
  const first = await engine.persistComputed({
    samples,
    extras: { day: DAY, timeZone: 'UTC', replay: true, imuRecords },
  });
  const second = await engine.persistComputed({
    samples,
    extras: { day: nextDay, timeZone: 'UTC', replay: true, imuRecords },
  });
  const firstEnd = Date.parse(`${nextDay}T00:00:00.000Z`);
  const secondEnd = firstEnd + 86_400_000;
  assert.ok(first.stepsV3.events.every((event) => event.timestamp_ms < firstEnd));
  assert.ok(second.stepsV3.events.every(
    (event) => event.timestamp_ms >= firstEnd && event.timestamp_ms < secondEnd,
  ));
  assert.equal(first.stepsV3.total, second.stepsV3.total);
});

test('V3 artifact failure leaves V1 persistence intact', async () => {
  const { engine } = makeEngine();
  const payloads = [];
  const brokenEngine = createMetricsEngine({
    cfg: {
      localUserId: USER,
      rawStore: 'none',
      derivedStore: 'none',
      b2Bucket: 'FRWHOOP',
      buildHash: 'test',
    },
    stores: { raw: null, derived: null },
    stepsV3Artifact: { schema_version: 'invalid' },
    db: {
      async upsertPayload(payload) {
        payloads.push(payload);
        return { ok: true };
      },
    },
  });
  const samples = [{
    t: new Date(T0 * 1000).toISOString(),
    sensor_ts: T0,
    steps: 3,
    step_cumulative: 3,
    bpm: 70,
  }];
  const result = await brokenEngine.persistComputed({
    samples,
    extras: { day: DAY, timeZone: 'UTC' },
  });
  assert.equal(result.dailyRow.steps, 3);
  assert.equal(result.dailyRow.extras.steps_v3.status, 'unavailable');
  assert.match(String(result.dailyRow.extras.steps_v3.unavailable_reason || ''), /^artifact/);
  assert.equal(result.dailyRow.provenance.steps.canonical, 'v1');
  const v3Run = payloads.at(-1)?.metric_runs?.find((row) => row.algorithm === 'steps_v3');
  assert.equal(v3Run?.status, 'failed');
  assert.ok(engine);
});

test('partial IMU manifest failure is explicit and accuracy-ineligible', async () => {
  const source = makeImuRecords({
    t0: T0,
    seconds: 12,
    accelAt: walkAccel,
    gyroAt: walkGyro,
  });
  const encoded = encodeImuArchive(
    source.map((record) => ({ ...record, schema: IMU_ARCHIVE_SCHEMA })),
  );
  const sha256 = createHash('sha256').update(encoded.body).digest('hex');
  const manifests = [
    { object_key: 'v3/imu/good.ndjson.gz', sha256 },
    { object_key: 'v3/imu/bad.ndjson.gz', sha256: '0'.repeat(64) },
  ];
  const loaded = await loadImuRecordsForWindow({
    db: { listObjectManifests: async () => manifests },
    raw: { getObject: async () => ({ body: encoded.body }) },
    userId: USER,
    fromDay: DAY,
    toDay: DAY,
  });
  assert.equal(loaded.records.length, 12);
  assert.equal(loaded.records[0]._manifest_verified, true);
  assert.equal(loaded.integrity.expected_manifest_objects, 2);
  assert.equal(loaded.integrity.loaded_manifest_objects, 1);
  assert.equal(loaded.integrity.verified_manifest_objects, 1);
  assert.equal(loaded.integrity.complete, false);
  assert.equal(loaded.integrity.failures[0].reason, 'sha256_mismatch');
  const computed = computeStepsV3({
    imuRecords: loaded.records,
    artifact,
    dayStartMs: T0 * 1000,
    dayEndMs: (T0 + 12) * 1000,
    loadIntegrity: loaded.integrity,
  });
  assert.equal(computed.evidence_eligibility.accuracy_eligible, false);
  assert.equal(computed.evidence_eligibility.reason, 'imu_manifest_load_incomplete');
});
