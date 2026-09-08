import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';

import {
  persistHealthKitResult,
  HealthKitPersistError,
  assertDurableIdentities,
  assertDurableStepBuckets,
} from '../healthkit/persist.js';
import { registerHealthKitRoutes } from '../healthkit/routes.js';

const USER = '7f2c9a10-4b3e-4d8a-9c11-00000000hk01';

function measurement(over = {}) {
  return {
    user_id: USER,
    metric_type: 'hrv',
    measured_at: '2026-08-25T12:00:00.000Z',
    value: 42,
    unit: 'ms',
    source: 'apple_watch_healthkit',
    source_system: 'apple_watch_healthkit',
    external_id: 'hk-1',
    quality: 0.9,
    metadata: {},
    ...over,
  };
}

function stepBucket(over = {}) {
  return {
    user_id: USER,
    device_fingerprint: `apple_watch:${'a'.repeat(64)}`,
    bucket_start: '2026-08-25T12:00:00.000Z',
    bucket_size_seconds: 60,
    bucket_key: '11111111-1111-5111-a111-111111111111',
    step_count: 30,
    allocated: true,
    coalesced: true,
    allocation_method: 'duration_overlap',
    source_sample_ids: ['watch-step-1'],
    device_provenance: {},
    metadata: { allocations: { 'watch-step-1@2026-08-25T12:00:00.000Z': 30 } },
    ...over,
  };
}

test('assertDurableIdentities rejects missing source_system or external_id', () => {
  assert.throws(
    () => assertDurableIdentities([{ source_system: 'apple_watch_healthkit' }]),
    HealthKitPersistError,
  );
  assert.throws(
    () => assertDurableIdentities([{ external_id: 'hk-1' }]),
    HealthKitPersistError,
  );
  assert.doesNotThrow(() => assertDurableIdentities([measurement()]));
});

test('persistHealthKitResult does not treat a local cache as acknowledgement', async () => {
  const out = await persistHealthKitResult({
    rest: { configured: false },
    userId: USER,
    result: { measurements: [measurement()], links: [], sessions: [] },
  });
  assert.equal(out.persisted, 'local_only');
});

test('assertDurableStepBuckets requires deterministic relational identity', () => {
  assert.doesNotThrow(() => assertDurableStepBuckets([stepBucket()]));
  assert.throws(
    () => assertDurableStepBuckets([stepBucket({ device_fingerprint: '' })]),
    (err) => err instanceof HealthKitPersistError && err.code === 'missing_step_bucket_identity',
  );
  assert.throws(
    () => assertDurableStepBuckets([stepBucket({ metadata: {} })]),
    (err) => err instanceof HealthKitPersistError && err.code === 'missing_step_bucket_identity',
  );
});

test('persistHealthKitResult requires auth when Supabase is configured', async () => {
  await assert.rejects(
    () => persistHealthKitResult({
      rest: { configured: true, rpc: async () => ({ ok: true }) },
      userId: null,
      result: { measurements: [], links: [], sessions: [] },
    }),
    (err) => err instanceof HealthKitPersistError && err.code === 'auth_required',
  );
});

test('persistHealthKitResult fails closed when the RPC errors', async () => {
  await assert.rejects(
    () => persistHealthKitResult({
      rest: {
        configured: true,
        rpc: async () => { throw new Error('on_conflict=user_id,source,external_id cannot match'); },
      },
      userId: USER,
      result: { measurements: [measurement()], links: [], sessions: [] },
    }),
    (err) => err instanceof HealthKitPersistError && err.code === 'upsert_failed',
  );
});

test('persistHealthKitResult fails closed when the RPC returns ok:false', async () => {
  await assert.rejects(
    () => persistHealthKitResult({
      rest: { configured: true, rpc: async () => ({ ok: false, error: 'disk_full' }) },
      userId: USER,
      result: { measurements: [measurement()], links: [], sessions: [] },
    }),
    (err) => err instanceof HealthKitPersistError && err.code === 'upsert_failed',
  );
});

test('successful persist calls healthkit_upsert_external with identity columns', async () => {
  const calls = [];
  const out = await persistHealthKitResult({
    rest: {
      configured: true,
      rpc: async (name, args) => {
        calls.push({ name, args });
        return { ok: true, measurements: 1, links: 0, sessions: 0 };
      },
    },
    userId: USER,
    result: {
      measurements: [measurement()], links: [], sessions: [], appleWatchStepBuckets: [stepBucket()],
    },
  });
  assert.equal(out.persisted, 'supabase');
  assert.equal(calls[0].name, 'healthkit_upsert_external');
  assert.equal(calls[0].args.p_user_id, USER);
  assert.equal(calls[0].args.p_measurements[0].source_system, 'apple_watch_healthkit');
  assert.equal(calls[0].args.p_measurements[0].external_id, 'hk-1');
  assert.equal(calls[0].args.p_step_buckets[0].bucket_size_seconds, 60);
});

test('POST /api/healthkit/ingest returns 503 when persistence fails', async () => {
  const store = { healthkit: {}, integrations: {} };
  const app = express();
  app.use(express.json());
  registerHealthKitRoutes(app, {
    loadStore: () => store,
    saveStore: () => {},
    rest: {
      configured: true,
      rpc: async () => { throw new Error('cannot match'); },
      select: async () => [],
    },
    sync: { configured: false },
    resolveUser: async () => USER,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/healthkit/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-frwhoop-user-id': USER },
      body: JSON.stringify({
        samples: [{
          uuid: 'hk-1',
          metric_type: 'hrv',
          value: 40,
          start_time: '2026-08-25T12:00:00.000Z',
          source_bundle: 'com.apple.health',
          source_device: 'Apple Watch',
        }],
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.equal(body.ok, false);
    assert.equal(store.healthkit.sync.lastError.includes('cannot match'), true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('POST /api/healthkit/ingest 401 when Supabase is configured without a user', async () => {
  const app = express();
  app.use(express.json());
  registerHealthKitRoutes(app, {
    loadStore: () => ({ healthkit: {} }),
    saveStore: () => {},
    rest: { configured: true, rpc: async () => ({ ok: true }), select: async () => [] },
    sync: { configured: false },
    resolveUser: async () => null,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/healthkit/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ samples: [] }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.ok, false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('local HealthKit cache stays idempotent when Watch steps re-sync', async () => {
  const store = { healthkit: {}, integrations: {} };
  const app = express();
  app.use(express.json());
  registerHealthKitRoutes(app, {
    loadStore: () => store,
    saveStore: () => {},
    rest: { configured: false },
    sync: { configured: false },
    resolveUser: async () => USER,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const payload = {
    samples: [{
      uuid: 'watch-step-cache-1',
      metric_type: 'steps',
      sample_kind: 'raw_quantity_sample',
      value: 60,
      start_time: '2026-08-25T12:00:30.000Z',
      end_time: '2026-08-25T12:01:30.000Z',
      source_bundle: 'com.apple.health.watch-1',
      device_provenance: {
        name: 'Apple Watch',
        manufacturer: 'Apple Inc.',
        model: 'Watch',
        hardware_version: 'Watch7,1',
        local_identifier: 'watch-local-cache',
      },
    }],
  };
  const port = server.address().port;
  try {
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/api/healthkit/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-frwhoop-user-id': USER },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 200);
    }
    assert.equal(store.healthkit.measurements.length, 1);
    assert.equal(store.healthkit.appleWatchStepBuckets.length, 3);
    const incremental = {
      samples: [{
        ...payload.samples[0],
        uuid: 'watch-step-cache-2',
        value: 20,
        start_time: '2026-08-25T12:00:00.000Z',
        end_time: '2026-08-25T12:01:00.000Z',
      }],
    };
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/api/healthkit/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-frwhoop-user-id': USER },
        body: JSON.stringify(incremental),
      });
      assert.equal(res.status, 200);
    }
    const firstMinute = store.healthkit.appleWatchStepBuckets.find((bucket) => (
      bucket.bucket_size_seconds === 60
      && bucket.bucket_start === '2026-08-25T12:00:00.000Z'
    ));
    assert.equal(firstMinute.step_count, 50);
    assert.equal(store.healthkit.measurements.length, 2);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('Steps V3 migration separates accuracy ground truth and merges Watch allocations', () => {
  const sql = readFileSync(
    new URL('../../supabase/migrations/20260830270000_apple_watch_step_reference_labels.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /create table if not exists public\.apple_watch_step_buckets/);
  assert.match(sql, /primary key \(user_id, device_fingerprint, bucket_start, bucket_size_seconds\)/);
  assert.match(sql, /create table if not exists public\.step_validation_sessions/);
  for (const column of [
    'requested_start', 'requested_end', 'scenario', 'device', 'firmware', 'wrist',
    'participant_key', 'raw_imu_refs', 'true_count', 'event_timestamps', 'metadata',
  ]) {
    assert.match(sql, new RegExp(`\\b${column}\\b`));
  }
  for (const source of ['video_manual', 'apple_watch', 'public_ground_truth', 'synthetic']) {
    assert.match(sql, new RegExp(`'${source}'::text`));
  }
  assert.match(sql, /with \(security_invoker = true\)/);
  assert.match(sql, /where label_source <> 'synthetic'/);
  assert.match(sql, /create or replace view public\.step_validation_ground_truth/);
  assert.match(sql, /where label_source = any \(array\['video_manual'::text, 'public_ground_truth'::text\]\)/);
  assert.match(sql, /jsonb_each_text\(/);
  assert.match(sql, /metadata->'allocations'/);
  assert.match(sql, /p_step_buckets jsonb default '\[\]'::jsonb/);
});

test('deployed-schema hardening keeps incremental Watch rows and weak labels separated', () => {
  const sql = readFileSync(
    new URL('../../supabase/migrations/20260830280000_steps_v3_reference_hardening.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /create trigger apple_watch_step_buckets_merge_allocations/);
  assert.match(sql, /old\.metadata->'allocations'.*\|\|/s);
  assert.match(sql, /drop view if exists public\.step_validation_real_labels/);
  assert.match(sql, /create or replace view public\.step_validation_ground_truth/);
  assert.match(sql, /'video_manual'::text, 'public_ground_truth'::text/);
});
