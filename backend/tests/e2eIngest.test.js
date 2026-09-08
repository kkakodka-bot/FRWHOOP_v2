import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeArchive } from '../ingest/archiveFormat.js';
import { createMetricsEngine } from '../metrics/engine.js';
import { snapshotToWhoopDay } from '../metrics/snapshot.js';
import { bucketsFromSamples } from '../metrics/buckets.js';

const USER = '11111111-1111-4111-8111-111111111111';

test('e2e BLE sample → verified archive → metric projection → compact day', async () => {
  const blobs = new Map();
  const dbRows = { daily_metrics: [], object_manifests: [], sessions: [] };
  const stores = {
    raw: {
      async putObject(key, body) { blobs.set(key, body); return { etag: '"x"', bytes: body.length }; },
      async head(key) {
        const b = blobs.get(key);
        return b ? { exists: true, contentLength: b.length } : null;
      },
      async getObject(key) {
        const b = blobs.get(key);
        return b ? { body: b } : null;
      },
    },
    derived: {
      async putObject(key, body) { blobs.set(key, body); return { etag: '"y"', bytes: body.length }; },
    },
  };
  const db = {
    async upsertPayload(payload) {
      if (payload.daily_metrics) dbRows.daily_metrics.push(...payload.daily_metrics);
      if (payload.object_manifests) dbRows.object_manifests.push(...payload.object_manifests);
      if (payload.sessions) dbRows.sessions.push(...payload.sessions);
      return { ok: true };
    },
    async loadUserDays() {
      return { daily_metrics: dbRows.daily_metrics, sleep_nights: [], sessions: dbRows.sessions };
    },
  };
  const engine = createMetricsEngine({
    cfg: { localUserId: USER, rawStore: 'b2', derivedStore: 'b2', b2Bucket: 'FRWHOOP', buildHash: 'test' },
    stores,
    db,
  });
  const samples = [];
  for (let i = 0; i < 40; i += 1) {
    samples.push({
      datetime: new Date(Date.UTC(2026, 7, 23, 23, i)).toISOString(),
      bpm: 52 + (i % 3),
      sleep_stage: 'light',
    });
  }
  for (let i = 0; i < 20; i += 1) {
    samples.push({
      datetime: new Date(Date.UTC(2026, 7, 24, 6, i)).toISOString(),
      bpm: 58,
      sleep_stage: 'none',
    });
  }
  const archived = await engine.archiveRawSamples({
    samples: samples.slice(0, 30),
    device: { id: 'strap' },
    startAt: samples[0].datetime,
    endAt: samples[29].datetime,
  });
  assert.equal(archived.status, 'ready');
  assert.ok(archived.sha256);
  assert.equal(archived.format, 'ndjson_gzip_v3');
  assert.match(archived.object_key, /\/physiology\//);
  assert.ok(archived.object_key.includes(USER));
  assert.equal(blobs.has(archived.object_key), true);
  const decoded = encodeArchive(samples.slice(0, 30));
  assert.equal(decoded.sha256, archived.sha256);

  const computed = await engine.persistComputed({
    samples,
    device: { id: 'strap' },
    extras: { inputObjectIds: [archived.id], timeZone: 'UTC' },
  });
  assert.ok(computed.dailyRow);
  assert.equal(computed.dailyRow.record_class, 'user');
  assert.ok(computed.dailyRow.strain_score == null || computed.dailyRow.strain_score <= 21);

  const snap = {
    day: computed.dailyRow.day,
    metrics: computed.dailyRow,
    sleep: computed.sleepRow ? [{
      session_id: computed.sleepRow.id,
      performance_pct: computed.sleepRow.performance_pct,
      original_start_at: computed.sleepRow.start_at,
      original_end_at: computed.sleepRow.end_at,
      asleep_min: computed.sleepRow.asleep_min,
      in_bed_min: computed.sleepRow.in_bed_min,
      hypnogram: computed.sleepRow.hypnogram,
    }] : [],
    sessions: [],
    events: [],
    chart: bucketsFromSamples(samples).map((b) => ({
      t: b.bucket_start, avg_hr: b.avg_hr, min_hr: b.min_hr, max_hr: b.max_hr, n: b.sample_count,
    })),
  };
  const whoop = snapshotToWhoopDay(snap);
  assert.ok(whoop.physiological_summary);
  assert.ok(Array.isArray(whoop.bpm_data));
  assert.ok(whoop.bpm_data.length < samples.length);
});

test('gravity-only history uses the current physiology B2 manifest flow', async () => {
  const blobs = new Map();
  const manifests = [];
  const engine = createMetricsEngine({
    cfg: { localUserId: USER, rawStore: 'b2', derivedStore: 'b2', b2Bucket: 'FRWHOOP', buildHash: 'test' },
    stores: {
      raw: {
        async putObject(key, body) { blobs.set(key, body); return { etag: '"g"', bytes: body.length }; },
        async head(key) {
          const body = blobs.get(key);
          return body ? { exists: true, contentLength: body.length } : null;
        },
        async getObject(key) {
          const body = blobs.get(key);
          return body ? { body } : null;
        },
      },
    },
    db: {
      async upsertPayload(payload) {
        manifests.push(...(payload.object_manifests || []));
        return { ok: true };
      },
    },
  });
  const archived = await engine.archiveRawSamples({
    samples: [{
      t: '2026-08-22T05:00:00.000Z',
      seq: 91,
      gx: 0.1,
      gy: -0.9,
      gz: 0.2,
      dyn_accel: 0.08,
      src: 'whoop_history',
      layout: 'history-v1',
      family: 'puffin',
      decoder: 'ios/3',
    }],
    device: { id: 'strap' },
    startAt: '2026-08-22T05:00:00.000Z',
    endAt: '2026-08-22T05:00:00.000Z',
    extras: { userId: USER, periodDay: '2026-08-22', timeZone: 'UTC' },
  });
  assert.equal(archived.status, 'ready');
  assert.equal(archived.format, 'ndjson_gzip_v3');
  assert.equal(archived.schema_version, 3);
  assert.equal(archived.sample_count, 1);
  assert.match(archived.object_key, /\/physiology\/2026\/08\/22\/05\//);
  assert.equal(manifests[0].object_kind, 'physiology');
  assert.equal(manifests[0].schema_version, 3);
  assert.equal(manifests[0].sample_count, 1);
});

test('e2e opaque BLE frames archive without bpm and keep hex', async () => {
  const blobs = new Map();
  const dbRows = { object_manifests: [] };
  let upserted = [];
  const engine = createMetricsEngine({
    cfg: { localUserId: USER, rawStore: 'b2', derivedStore: 'b2', b2Bucket: 'FRWHOOP', buildHash: 'test' },
    stores: {
      raw: {
        async putObject(key, body) { blobs.set(key, body); return { etag: '"x"', bytes: body.length }; },
        async head(key) {
          const b = blobs.get(key);
          return b ? { exists: true, contentLength: b.length } : null;
        },
        async getObject(key) {
          const b = blobs.get(key);
          return b ? { body: b } : null;
        },
      },
    },
    db: {
      async upsertPayload(payload) {
        upserted = Object.keys(payload);
        if (payload.object_manifests) dbRows.object_manifests.push(...payload.object_manifests);
        return { ok: true };
      },
    },
  });
  const archived = await engine.archiveRawFrames({
    frames: [{
      hex: 'aa0114000001e1e1',
      t: '2026-08-24T18:00:00.000Z',
      family: 'puffin',
      char: 'FD4B0003',
      seq: 1,
      fw: '50.35.0',
    }],
    device: { id: 'strap', firmware: '50.35.0' },
    startAt: '2026-08-24T18:00:00.000Z',
    endAt: '2026-08-24T18:00:00.000Z',
  });
  assert.equal(archived.status, 'ready');
  assert.equal(archived.format, 'ndjson_gzip_frames_v1');
  assert.equal(archived.retention_class, 'core');
  assert.equal(archived.expires_at, null);
  assert.match(archived.object_key, /\/frames\//);
  assert.match(archived.object_key, /^v3\/core\//);
  assert.equal(dbRows.object_manifests[0].object_kind, 'frames');
  assert.deepEqual(upserted.sort(), ['device', 'object_manifests', 'user_id']);
});
