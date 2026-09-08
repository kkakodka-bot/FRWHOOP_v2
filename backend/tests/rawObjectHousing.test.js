import assert from 'node:assert/strict';
import test from 'node:test';
import { createPushObjects, SHA_SOURCE, windowCoverage } from '../ingest/pushObjects.js';
import { fetchRawObject, readRawObject, RawObjectFormatError } from '../storage/rawObjectReader.js';
import { dominantFrequencyHz } from '../signal/spectrum.js';
import {
  OBJECT_LANE_STREAMS,
  parseRawObjectKeyV3,
  rawObjectKeyV3,
  retentionClassFromObjectKey,
  noopDeviceId,
} from '../storage/keys.js';
import { advertisedStreams, capabilitiesBody } from '../ingest/pushRegistry.js';
import { OBJECT_LANE_PATH } from '../routes/push.js';
import { b2LifecycleRules, expiresAt, sweepExpiredManifests } from '../storage/retention.js';
import {
  compressFor,
  encodeImuObject,
  encodePpgObject,
  imuSecond,
  makeFakeB2,
  makeMemRest,
  ppgSecond,
  sha256Hex,
} from './fixtures/rawObjectLane.mjs';

/**
 * Housing tests for the raw object lane: does every byte the device sends land in the bucket, come
 * back byte-identical, get attributed to the right subject, and stay findable?
 *
 * Scope is collection integrity only. Nothing here scores, detects, or infers — the one place a
 * frequency is computed, it is computed to prove a waveform survived storage, which a checksum
 * cannot show (a checksum proves the blob is intact; it says nothing about whether the pipeline
 * handed back the blob it was asked for).
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const STRAP = 'strap-local-01';
const SECOND = 1_780_000_000;   // inside a UTC hour, deliberately not on the boundary
const CFG = { b2KeyId: 'k', b2ApplicationKey: 's', b2Bucket: 'frwhoop-test', rawStore: 'b2' };

function harness({ now = () => new Date('2026-09-07T18:30:00.000Z') } = {}) {
  const b2 = makeFakeB2({ now });
  const rest = makeMemRest();
  const objects = createPushObjects({
    cfg: CFG,
    rest,
    stores: { raw: b2.s3 },
    upsertRows: (table, rows, opts) => rest.upsert(table, rows, opts),
    ensureDevice: (row) => rest.upsert('devices', row, { onConflict: 'id' }),
    now,
  });
  return { b2, rest, objects, now };
}

/** Builds the manifest the device computes before it uploads anything. */
function manifestFor({ stream, payload, startTs, endTs, sampleCount, compression, objectId }) {
  const wire = compressFor(compression, payload);
  return {
    manifest: {
      type: 'binaryObject',
      protocolVersion: '1.2',
      batchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      deviceId: STRAP,
      stream,
      objectId,
      startTs,
      endTs,
      sampleCount,
      uncompressedBytes: payload.length,
      compressedBytes: wire.length,
      contentSha256: sha256Hex(payload),
      contentEncoding: compression,
    },
    wire,
  };
}

/** Full device round: intent, PUT straight to the bucket with the signed URL, then complete. */
async function shipObject(h, spec) {
  const { manifest, wire } = manifestFor(spec);
  const intent = await h.objects.createIntent({ userId: USER, manifest });
  assert.ok(intent.uploadUrl, 'intent must return a presigned upload url');
  h.b2.putViaPresignedUrl(intent.uploadUrl, wire, {
    contentType: intent.requiredHeaders['content-type'],
  });
  const ack = await h.objects.completeObject({ userId: USER, objectId: manifest.objectId });
  return { manifest, wire, intent, ack };
}

function ppgPayload({ seconds, pulseHz, startTs = SECOND }) {
  const records = Array.from({ length: seconds }, (_, i) => ({
    rowId: 1000 + i,
    ts: startTs + i,
    burstIndex: (i % 26) + 1,
    samples: ppgSecond({ second: i, pulseHz }),
  }));
  return { records, payload: encodePpgObject(records) };
}

function imuPayload({ seconds, cadenceHz, startTs = SECOND }) {
  const records = Array.from({ length: seconds }, (_, i) => ({
    rowId: 5000 + i,
    ts: startTs + i,
    columns: imuSecond({ second: i, cadenceHz }),
  }));
  return { records, payload: encodeImuObject(records) };
}

// ---------------------------------------------------------------------------
// The bytes land, and they come back unchanged
// ---------------------------------------------------------------------------

test('housing: a PPG object round-trips through a presigned PUT byte-for-byte', async () => {
  const h = harness();
  const { records, payload } = ppgPayload({ seconds: 120, pulseHz: 1.2 });
  const objectId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  const { ack, wire } = await shipObject(h, {
    stream: 'ppgWaveformSample',
    payload,
    startTs: SECOND,
    endTs: SECOND + 120,
    sampleCount: records.length,
    compression: 'gzip',
    objectId,
  });

  assert.equal(ack.status, 'ready');
  // The bytes reached the bucket via the signed URL, not through this process.
  assert.deepEqual(h.b2.puts.map((p) => p.bytes), [wire.length]);

  const row = h.rest.manifests.get(objectId);
  const decoded = await fetchRawObject({ objectStore: h.b2.s3, manifestRow: row });
  assert.equal(decoded.stream, 'ppgWaveformSample');
  assert.equal(decoded.records.length, records.length);
  for (let i = 0; i < records.length; i += 1) {
    assert.deepEqual(decoded.records[i].samples, records[i].samples, `waveform ${i} changed in storage`);
    assert.equal(decoded.records[i].ts, records[i].ts);
    assert.equal(decoded.records[i].burstIndex, records[i].burstIndex);
  }
});

test('housing: a 100 Hz IMU object round-trips every axis of every sample', async () => {
  const h = harness();
  const seconds = 300;                        // 5 min = 180,000 i16 across 6 axes
  const { records, payload } = imuPayload({ seconds, cadenceHz: 4 });
  const objectId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  await shipObject(h, {
    stream: 'rawImuSession',
    payload,
    startTs: SECOND,
    endTs: SECOND + seconds,
    sampleCount: seconds,
    compression: 'zstd',
    objectId,
  });

  const row = h.rest.manifests.get(objectId);
  const decoded = await fetchRawObject({ objectStore: h.b2.s3, manifestRow: row });
  assert.equal(decoded.records.length, seconds);
  for (let i = 0; i < seconds; i += 1) {
    assert.deepEqual(decoded.records[i].columns, records[i].columns, `imu second ${i} changed in storage`);
  }
  // Scaling is applied at read time from stored LSBs, so gravity has to reappear as ~1 g on Z.
  const az = decoded.records[0].samples.map((s) => s.az);
  assert.ok(Math.abs(az[0] - 1) < 0.01, `expected ~1 g on Z, got ${az[0]}`);
});

// ---------------------------------------------------------------------------
// The pipeline returns the object it was asked for, not a constant or a neighbour
// ---------------------------------------------------------------------------

/**
 * Two objects differing ONLY in the frequency of the signal inside them. A pipeline that serves a
 * cached blob, a stale key, or the wrong subject's object passes a single-frequency test and fails
 * this one, which is the whole reason it recovers a VARYING input rather than one fixed value.
 */
test('housing: each stored waveform decodes back to its own distinct pulse frequency', async () => {
  const h = harness();
  const cases = [
    { pulseHz: 1.2, objectId: '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a' },
    { pulseHz: 2.4, objectId: '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b' },
  ];

  const recovered = [];
  for (const [index, spec] of cases.entries()) {
    const startTs = SECOND + index * 3600;
    const { records, payload } = ppgPayload({ seconds: 60, pulseHz: spec.pulseHz, startTs });
    await shipObject(h, {
      stream: 'ppgWaveformSample',
      payload,
      startTs,
      endTs: startTs + records.length,
      sampleCount: records.length,
      compression: 'gzip',
      objectId: spec.objectId,
    });

    const row = h.rest.manifests.get(spec.objectId);
    const decoded = await fetchRawObject({ objectStore: h.b2.s3, manifestRow: row });
    const flat = decoded.records.flatMap((r) => r.samples);
    const peak = dominantFrequencyHz({ samples: flat, rateHz: 24, minHz: 0.7, maxHz: 3.5 });
    assert.ok(peak, 'stored waveform decoded to something with no usable variance');
    assert.ok(
      Math.abs(peak.freqHz - spec.pulseHz) < 0.1,
      `stored ${spec.pulseHz} Hz came back as ${peak.freqHz} Hz`,
    );
    assert.ok(peak.concentration > 2, `recovered signal is not peaked (${peak.concentration})`);
    recovered.push(peak.freqHz);
  }

  assert.notEqual(recovered[0], recovered[1], 'both objects decoded to the same frequency');
});

test('housing: a stored IMU object recovers the cadence it was built with', async () => {
  const h = harness();
  for (const [index, cadenceHz] of [3, 5].entries()) {
    const startTs = SECOND + index * 3600;
    const objectId = `3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3${index}`;
    const { payload } = imuPayload({ seconds: 30, cadenceHz, startTs });
    await shipObject(h, {
      stream: 'rawImuSession',
      payload,
      startTs,
      endTs: startTs + 30,
      sampleCount: 30,
      compression: 'zstd',
      objectId,
    });
    const row = h.rest.manifests.get(objectId);
    const decoded = await fetchRawObject({ objectStore: h.b2.s3, manifestRow: row });
    const ax = decoded.records.flatMap((r) => r.samples.map((s) => s.ax));
    const peak = dominantFrequencyHz({ samples: ax, rateHz: 100, minHz: 1, maxHz: 10 });
    assert.ok(
      Math.abs(peak.freqHz - cadenceHz) < 0.15,
      `stored ${cadenceHz} Hz cadence came back as ${peak.freqHz} Hz`,
    );
  }
});

// ---------------------------------------------------------------------------
// Refusal paths: a bad object must not become archive
// ---------------------------------------------------------------------------

test('housing: a truncated upload is refused and never reaches ready', async () => {
  const h = harness();
  const { payload } = ppgPayload({ seconds: 10, pulseHz: 1.2 });
  const objectId = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';
  const { manifest, wire } = manifestFor({
    stream: 'ppgWaveformSample',
    payload,
    startTs: SECOND,
    endTs: SECOND + 10,
    sampleCount: 10,
    compression: 'gzip',
    objectId,
  });

  const intent = await h.objects.createIntent({ userId: USER, manifest });
  h.b2.putViaPresignedUrl(intent.uploadUrl, wire.subarray(0, wire.length - 8));

  await assert.rejects(
    () => h.objects.completeObject({ userId: USER, objectId }),
    (err) => err.code === 'size_mismatch' && err.status === 409,
  );
  assert.equal(h.rest.manifests.get(objectId).status, 'failed');
  assert.equal(h.rest.rowCount('noop_signal_windows'), 0, 'a failed object must not be catalogued');
});

test('housing: completing before the upload lands is refused as object_missing', async () => {
  const h = harness();
  const { payload } = ppgPayload({ seconds: 4, pulseHz: 1.2 });
  const objectId = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
  const { manifest } = manifestFor({
    stream: 'ppgWaveformSample',
    payload,
    startTs: SECOND,
    endTs: SECOND + 4,
    sampleCount: 4,
    compression: 'gzip',
    objectId,
  });
  await h.objects.createIntent({ userId: USER, manifest });

  await assert.rejects(
    () => h.objects.completeObject({ userId: USER, objectId }),
    (err) => err.code === 'object_missing' && err.status === 409,
  );
  assert.equal(h.rest.manifests.get(objectId).status, 'failed');
});

test('housing: a ready row records the digest as claimed, and verification upgrades it', async () => {
  const h = harness();
  const { payload } = ppgPayload({ seconds: 20, pulseHz: 1.2 });
  const objectId = '6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f';
  await shipObject(h, {
    stream: 'ppgWaveformSample',
    payload,
    startTs: SECOND,
    endTs: SECOND + 20,
    sampleCount: 20,
    compression: 'gzip',
    objectId,
  });

  // Completion never saw the bytes, so it may only attest the byte count.
  assert.equal(h.rest.manifests.get(objectId).sha256_source, SHA_SOURCE.claimed);

  const verified = await h.objects.verifyObjectDigest({ objectId });
  assert.equal(verified.ok, true);
  assert.equal(h.rest.manifests.get(objectId).status, 'verified');
  assert.equal(h.rest.manifests.get(objectId).sha256_source, SHA_SOURCE.verified);
});

/**
 * Corruption has two shapes and they must not be conflated. A flipped bit usually breaks the
 * compression frame, which is caught on inflate; the dangerous case is a frame that still inflates
 * cleanly but holds different content, which only a payload digest catches. The two tests below
 * pin them separately — a single test asserting "verification fails" would pass even if the digest
 * comparison were broken outright, which is exactly how the compressed-vs-uncompressed hashing bug
 * that this pair now guards went unnoticed.
 */
test('housing: bitrot that breaks the frame is caught as unreadable, not left ready', async () => {
  const h = harness();
  const { payload } = ppgPayload({ seconds: 20, pulseHz: 1.2 });
  const objectId = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
  const { intent } = await shipObject(h, {
    stream: 'ppgWaveformSample',
    payload,
    startTs: SECOND,
    endTs: SECOND + 20,
    sampleCount: 20,
    compression: 'gzip',
    objectId,
  });

  // Same byte length, different content: the size check at completion cannot see this.
  const stored = h.b2.objects.get(intent.objectKey).body;
  const tampered = Buffer.from(stored);
  tampered[Math.floor(tampered.length / 2)] ^= 0xff;
  h.b2.corrupt(intent.objectKey, tampered);
  assert.equal(tampered.length, stored.length);

  const verified = await h.objects.verifyObjectDigest({ objectId });
  assert.equal(verified.ok, false);
  assert.equal(verified.error, 'unreadable');
  assert.equal(h.rest.manifests.get(objectId).status, 'corrupt');

  await assert.rejects(
    () => fetchRawObject({ objectStore: h.b2.s3, manifestRow: h.rest.manifests.get(objectId) }),
    RawObjectFormatError,
  );
});

test('housing: a valid frame holding the wrong payload is caught as a digest mismatch', async () => {
  const h = harness();
  const objectId = '7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b';
  const original = ppgPayload({ seconds: 20, pulseHz: 1.2 });
  const { intent } = await shipObject(h, {
    stream: 'ppgWaveformSample',
    payload: original.payload,
    startTs: SECOND,
    endTs: SECOND + 20,
    sampleCount: 20,
    compression: 'gzip',
    objectId,
  });

  // A well-formed object of the same shape, holding someone else's signal: inflates fine, hashes
  // differently. This is the restore-to-the-wrong-key / key-collision case.
  const impostor = ppgPayload({ seconds: 20, pulseHz: 2.4 });
  h.b2.corrupt(intent.objectKey, compressFor('gzip', impostor.payload));

  const verified = await h.objects.verifyObjectDigest({ objectId });
  assert.equal(verified.ok, false);
  assert.equal(verified.error, 'sha256_mismatch');
  assert.equal(verified.expected, sha256Hex(original.payload));
  assert.equal(verified.actual, sha256Hex(impostor.payload));
  assert.equal(h.rest.manifests.get(objectId).status, 'corrupt');
});

test('housing: a manifest rejects a client-chosen key, PII, and a mismatched encoding', async () => {
  const h = harness();
  const { payload } = ppgPayload({ seconds: 4, pulseHz: 1.2 });
  const base = manifestFor({
    stream: 'ppgWaveformSample',
    payload,
    startTs: SECOND,
    endTs: SECOND + 4,
    sampleCount: 4,
    compression: 'gzip',
    objectId: '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b',
  }).manifest;

  const cases = [
    ['objectKey', { ...base, objectKey: 'v3/research/users/x/anything' }],
    ['deviceId', { ...base, deviceId: 'patient@example.com' }],
    ['contentEncoding', { ...base, contentEncoding: 'zstd' }],
    ['stream', { ...base, stream: 'hrSample' }],
    ['endTs', { ...base, endTs: base.startTs }],
  ];
  for (const [field, manifest] of cases) {
    await assert.rejects(
      () => h.objects.createIntent({ userId: USER, manifest }),
      (err) => err.code === 'invalid_object_manifest' && err.fields.includes(field),
      `expected ${field} to be refused`,
    );
  }
  assert.equal(h.rest.manifests.size, 0);
});

// ---------------------------------------------------------------------------
// Idempotency and isolation
// ---------------------------------------------------------------------------

test('housing: replaying an object is idempotent and writes one manifest row', async () => {
  const h = harness();
  const { payload } = ppgPayload({ seconds: 30, pulseHz: 1.2 });
  const objectId = '9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c';
  const spec = {
    stream: 'ppgWaveformSample',
    payload,
    startTs: SECOND,
    endTs: SECOND + 30,
    sampleCount: 30,
    compression: 'gzip',
    objectId,
  };

  const first = await shipObject(h, spec);
  assert.equal(first.ack.duplicate, false);

  const { manifest } = manifestFor(spec);
  const replay = await h.objects.createIntent({ userId: USER, manifest });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.uploadUrl, undefined, 'a completed object must not be re-signed for upload');

  const secondAck = await h.objects.completeObject({ userId: USER, objectId });
  assert.equal(secondAck.duplicate, true);
  assert.equal(secondAck.status, 'ready');
  assert.equal(h.rest.manifests.size, 1);
  assert.equal(h.rest.rowCount('noop_signal_windows'), 1);
});

test('housing: an interrupted upload resumes onto the same key', async () => {
  const h = harness();
  const { payload } = ppgPayload({ seconds: 8, pulseHz: 1.2 });
  const objectId = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
  const spec = {
    stream: 'ppgWaveformSample',
    payload,
    startTs: SECOND,
    endTs: SECOND + 8,
    sampleCount: 8,
    compression: 'gzip',
    objectId,
  };

  const first = await h.objects.createIntent({ userId: USER, manifest: manifestFor(spec).manifest });
  const resumed = await h.objects.createIntent({ userId: USER, manifest: manifestFor(spec).manifest });
  assert.equal(resumed.objectKey, first.objectKey, 'a retry must not mint a second key');
  assert.ok(resumed.uploadUrl, 'a pending object must still be uploadable');
  assert.equal(h.rest.manifests.size, 1);
});

test('housing: reusing an object id for different bytes is a conflict, not an overwrite', async () => {
  const h = harness();
  const objectId = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';
  const original = ppgPayload({ seconds: 10, pulseHz: 1.2 });
  await shipObject(h, {
    stream: 'ppgWaveformSample',
    payload: original.payload,
    startTs: SECOND,
    endTs: SECOND + 10,
    sampleCount: 10,
    compression: 'gzip',
    objectId,
  });

  const different = ppgPayload({ seconds: 10, pulseHz: 2.4 });
  const { manifest } = manifestFor({
    stream: 'ppgWaveformSample',
    payload: different.payload,
    startTs: SECOND,
    endTs: SECOND + 10,
    sampleCount: 10,
    compression: 'gzip',
    objectId,
  });

  await assert.rejects(
    () => h.objects.createIntent({ userId: USER, manifest }),
    (err) => err.code === 'object_id_conflict' && err.status === 409,
  );

  // The original is untouched and still decodes to its own signal.
  const decoded = await fetchRawObject({
    objectStore: h.b2.s3,
    manifestRow: h.rest.manifests.get(objectId),
  });
  const peak = dominantFrequencyHz({
    samples: decoded.records.flatMap((r) => r.samples),
    rateHz: 24,
    minHz: 0.7,
    maxHz: 3.5,
  });
  assert.ok(Math.abs(peak.freqHz - 1.2) < 0.1, 'the conflicting intent overwrote the original');
});

test('housing: one subject cannot complete or read another subject object', async () => {
  const h = harness();
  const { payload } = ppgPayload({ seconds: 6, pulseHz: 1.2 });
  const objectId = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
  await shipObject(h, {
    stream: 'ppgWaveformSample',
    payload,
    startTs: SECOND,
    endTs: SECOND + 6,
    sampleCount: 6,
    compression: 'gzip',
    objectId,
  });

  await assert.rejects(
    () => h.objects.completeObject({ userId: OTHER_USER, objectId }),
    (err) => err.code === 'forbidden' && err.status === 403,
  );

  // Keys are minted per subject, so the other subject's prefix cannot even name this object.
  const row = h.rest.manifests.get(objectId);
  assert.ok(row.object_key.includes(`/users/${USER}/`));
  assert.ok(!row.object_key.includes(OTHER_USER));
});

// ---------------------------------------------------------------------------
// Coverage accounting: gaps stay legible as absence
// ---------------------------------------------------------------------------

test('housing: a dropout is catalogued as missing records, never interpolated', async () => {
  const h = harness();
  const objectId = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4';
  const hourSeconds = 3600;
  // A 7-minute BLE dropout in the middle of an hour: 3180 records for a 3600-second window.
  const present = [];
  for (let i = 0; i < hourSeconds; i += 1) {
    if (i >= 1200 && i < 1620) continue;
    present.push(i);
  }
  const records = present.map((i) => ({
    rowId: 9000 + i,
    ts: SECOND + i,
    columns: imuSecond({ second: i, cadenceHz: 4 }),
  }));

  await shipObject(h, {
    stream: 'rawImuSession',
    payload: encodeImuObject(records),
    startTs: SECOND,
    endTs: SECOND + hourSeconds,
    sampleCount: records.length,
    compression: 'zstd',
    objectId,
  });

  const [window] = h.rest.tables.get('noop_signal_windows');
  assert.equal(window.expected_records, 3600);
  assert.equal(window.received_records, 3180);
  assert.equal(window.missing_records, 420, 'the dropout must be reported, not absorbed');
  assert.equal(window.interpolated_records, 0);
  assert.ok(Math.abs(window.coverage - 3180 / 3600) < 1e-9);

  // The decoded object has 3180 records and a real timestamp discontinuity — no filler rows.
  const decoded = await fetchRawObject({
    objectStore: h.b2.s3,
    manifestRow: h.rest.manifests.get(objectId),
  });
  assert.equal(decoded.records.length, 3180);
  const stamps = decoded.records.map((r) => r.ts);
  const jumps = stamps.slice(1).map((t, i) => t - stamps[i]).filter((d) => d > 1);
  assert.deepEqual(jumps, [421], 'the gap should survive as one discontinuity');
});

test('windowCoverage reports null rather than a guess for a stream with no fixed rate', () => {
  const fixed = windowCoverage({ stream: 'rawImuSession', startTs: 100, endTs: 160, sampleCount: 45 });
  assert.equal(fixed.expectedRecords, 60);
  assert.equal(fixed.missingRecords, 15);
  assert.equal(fixed.coverage, 0.75);

  const unrated = windowCoverage({ stream: 'rawBatch', startTs: 100, endTs: 160, sampleCount: 12 });
  assert.equal(unrated.expectedRecords, null);
  assert.equal(unrated.coverage, null);
  assert.equal(unrated.missingRecords, null);
  assert.equal(unrated.receivedRecords, 12);
});

test('housing: an object carrying more records than its window claims is capped at full coverage', () => {
  const over = windowCoverage({ stream: 'rawImuSession', startTs: 100, endTs: 110, sampleCount: 40 });
  assert.equal(over.coverage, 1);
  assert.equal(over.missingRecords, 0);
});

// ---------------------------------------------------------------------------
// Version negotiation: never offer a sender something it cannot deliver
// ---------------------------------------------------------------------------

test('capabilities: object-lane streams are offered at 1.2 only', () => {
  const at12 = advertisedStreams('1.2');
  for (const stream of OBJECT_LANE_STREAMS) {
    assert.ok(at12.includes(stream), `${stream} must be offered to a 1.2 sender`);
  }

  for (const version of ['1.1', '1.0']) {
    const offered = advertisedStreams(version);
    for (const stream of OBJECT_LANE_STREAMS) {
      assert.ok(
        !offered.includes(stream),
        `${stream} offered at ${version}, which has no object lane to deliver it through`,
      );
    }
    // The ordinary inline streams must keep working for older senders.
    assert.ok(offered.includes('hrSample'));
  }
});

test('capabilities: the objectLane block appears only alongside the streams it describes', () => {
  const lane = { endpoint: OBJECT_LANE_PATH, maxObjectBytes: 1024, uploadUrlTtlSec: 900 };

  const v12 = capabilitiesBody({
    receiverStateId: 'r',
    streams: advertisedStreams('1.2'),
    protocolVersion: '1.2',
    objectLane: lane,
  });
  assert.equal(v12.objectLane.endpoint, OBJECT_LANE_PATH);
  assert.deepEqual(
    [...v12.objectLane.streams].sort(),
    [...OBJECT_LANE_STREAMS].sort(),
    'the lane must list exactly the streams it accepts',
  );

  const v11 = capabilitiesBody({
    receiverStateId: 'r',
    streams: advertisedStreams('1.1'),
    protocolVersion: '1.1',
    objectLane: lane,
  });
  assert.equal(v11.objectLane, undefined, 'a 1.1 sender must not be told about the object lane');
});

// ---------------------------------------------------------------------------
// Format contract
// ---------------------------------------------------------------------------

test('reader: a payload with trailing bytes is refused rather than partially decoded', () => {
  const { payload } = ppgPayload({ seconds: 3, pulseHz: 1.2 });
  const padded = Buffer.concat([payload, Buffer.from([0, 0, 0])]);
  assert.throws(() => readRawObject({ body: padded, compression: 'none' }), RawObjectFormatError);
});

test('reader: a truncated payload is refused rather than yielding the records it managed to read', () => {
  const { payload } = ppgPayload({ seconds: 5, pulseHz: 1.2 });
  assert.throws(
    () => readRawObject({ body: payload.subarray(0, payload.length - 10), compression: 'none' }),
    RawObjectFormatError,
  );
});

test('reader: a foreign or misversioned container is refused', () => {
  assert.throws(
    () => readRawObject({ body: Buffer.from('NOTNPB1payload'), compression: 'none' }),
    RawObjectFormatError,
  );
  const { payload } = ppgPayload({ seconds: 2, pulseHz: 1.2 });
  const bumped = Buffer.from(payload);
  bumped.writeUInt8(9, 4);
  assert.throws(() => readRawObject({ body: bumped, compression: 'none' }), RawObjectFormatError);
});

test('reader: an IMU record of the wrong width is refused, not transposed', () => {
  const short = [{ rowId: 1, ts: SECOND, columns: imuSecond({}).slice(0, 599) }];
  assert.throws(
    () => readRawObject({ body: encodeImuObject(short), compression: 'none' }),
    RawObjectFormatError,
  );
});

// ---------------------------------------------------------------------------
// Keys, retention, and deletion reach
// ---------------------------------------------------------------------------

test('keys: rawObjectKeyV3 and parseRawObjectKeyV3 are inverses across the object lane', () => {
  const device = noopDeviceId(USER, STRAP);
  for (const stream of ['ppgWaveformSample', 'rawImuSession', 'rawBatch', 'v18AuxSample']) {
    for (const iso of ['2026-01-01T00:00:00.000Z', '2026-09-07T18:45:30.500Z', '2026-12-31T23:59:59.999Z']) {
      const objectId = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0';
      const key = rawObjectKeyV3({ userId: USER, deviceId: device, stream, startAt: iso, objectId });
      const parsed = parseRawObjectKeyV3(key);
      assert.ok(parsed, `${stream} @ ${iso} did not parse`);
      assert.equal(parsed.userId, USER);
      assert.equal(parsed.deviceId, device);
      assert.equal(parsed.stream, stream);
      assert.equal(parsed.objectId, objectId);
      assert.equal(parsed.retentionClass, retentionClassFromObjectKey(key));
      assert.equal(rawObjectKeyV3({ ...parsed }), key, 'rebuild from parse must reproduce the key');
    }
  }
});

test('keys: a malformed or cross-class key parses to null instead of a wrong attribution', () => {
  const device = noopDeviceId(USER, STRAP);
  const good = rawObjectKeyV3({
    userId: USER,
    deviceId: device,
    stream: 'rawImuSession',
    startAt: '2026-09-07T18:00:00.000Z',
    objectId: 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0',
  });
  assert.ok(parseRawObjectKeyV3(good));
  // Class segment moved to another class: must not silently accept.
  assert.equal(parseRawObjectKeyV3(good.replace('v3/research/', 'v3/core/')), null);
  // Wrong extension for the stream.
  assert.equal(parseRawObjectKeyV3(good.replace('.bin.zst', '.ndjson.gz')), null);
  assert.equal(parseRawObjectKeyV3('v3/research/users/not-a-uuid/devices/x/s/2026/09/07/18/y.bin.zst'), null);
  assert.equal(parseRawObjectKeyV3(''), null);
  assert.equal(parseRawObjectKeyV3(`${good}/extra`), null);
});

test('retention: research objects never expire and no lifecycle rule hides their prefix', () => {
  for (const stream of ['ppgWaveformSample', 'rawImuSession', 'rawBatch']) {
    assert.equal(
      expiresAt(stream, new Date('2026-09-07T18:00:00.000Z')),
      null,
      `${stream} must not carry an expiry`,
    );
  }
  const rules = b2LifecycleRules();
  const hiding = rules.filter(
    (r) => 'v3/research/'.startsWith(r.fileNamePrefix) && r.daysFromUploadingToHiding != null,
  );
  assert.deepEqual(hiding, [], 'a lifecycle rule would delete the corpus underneath its manifests');

  // The diagnostic stream is deliberately still bounded — it is not corpus.
  assert.ok(expiresAt('v18AuxSample', new Date('2026-09-07T18:00:00.000Z')) != null);
});

/**
 * The corpus survives the expiry sweep only because SQL excludes NULL from `expires_at <= now`.
 * That is a thin guarantee to rest a permanent archive on: in JavaScript `null <= new Date()` is
 * `true`, so anyone who reimplements this filter in application code — or widens it to catch rows
 * with no expiry set — deletes every research object on the next run, with the manifests updated to
 * `deleted` so it looks intentional. This pins the behaviour and the reason.
 */
test('retention: the expiry sweep skips never-expiring research objects and still reaps diagnostics', async () => {
  const nowIso = '2026-09-07T18:00:00.000Z';
  const rows = [
    { id: 'research-1', object_key: 'v3/research/users/u/a.bin.zst', status: 'ready', expires_at: null },
    { id: 'diag-1', object_key: 'v3/diag/users/u/b.bin.gz', status: 'ready', expires_at: '2026-08-01T00:00:00.000Z' },
    { id: 'diag-2', object_key: 'v3/diag/users/u/c.bin.gz', status: 'ready', expires_at: '2027-01-01T00:00:00.000Z' },
  ];

  const deletedKeys = [];
  const patched = [];
  let seenFilter = '';
  const rest = {
    configured: true,
    async select(_table, filter) {
      seenFilter = filter;
      const cutoff = decodeURIComponent(filter.match(/expires_at=lte\.([^&]+)/)[1]);
      // SQL null semantics, deliberately: a null expiry is not <= anything.
      return rows.filter((r) => r.expires_at != null && r.expires_at <= cutoff);
    },
    async request(path, { body }) { patched.push({ path, body }); },
  };
  const objectStore = { async deleteObject(key) { deletedKeys.push(key); } };

  const result = await sweepExpiredManifests({ rest, objectStore, now: () => new Date(nowIso) });

  assert.deepEqual(deletedKeys, ['v3/diag/users/u/b.bin.gz'], 'the sweep reaped the wrong set');
  assert.equal(result.deleted, 1);
  assert.ok(!patched.some((p) => p.path.includes('research-1')), 'a research manifest was touched');

  // The filter must never opt nulls back in; `is.null` here would empty the archive.
  assert.match(seenFilter, /expires_at=lte\./);
  assert.ok(!seenFilter.includes('is.null'), 'the sweep filter now selects rows with no expiry');
});

test('deletion: every retention class in use is reachable by a per-subject prefix sweep', async () => {
  const { allUserPrefixes, RETENTION_CLASS } = await import('../storage/keys.js');
  const prefixes = allUserPrefixes(USER);
  for (const cls of new Set(Object.values(RETENTION_CLASS))) {
    assert.ok(
      prefixes.includes(`v3/${cls}/users/${USER}/`),
      `retention class '${cls}' has no delete prefix, so its objects outlive a delete request`,
    );
  }
});

test('housing: an archived object lands under the research prefix for its subject and hour', async () => {
  const h = harness();
  const { payload } = ppgPayload({ seconds: 5, pulseHz: 1.2 });
  const objectId = 'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5';
  const { intent } = await shipObject(h, {
    stream: 'ppgWaveformSample',
    payload,
    startTs: SECOND,
    endTs: SECOND + 5,
    sampleCount: 5,
    compression: 'gzip',
    objectId,
  });

  const parsed = parseRawObjectKeyV3(intent.objectKey);
  assert.equal(parsed.retentionClass, 'research');
  assert.equal(parsed.userId, USER);
  assert.equal(parsed.stream, 'ppgWaveformSample');
  // The hour segment is the window start, not the upload time.
  assert.equal(parsed.startAt.getTime(), Math.floor(SECOND / 3600) * 3600 * 1000);
  assert.ok(h.b2.objects.has(intent.objectKey));
});
