import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindLiveMetricsReads,
  shouldReplaceSleepDay,
  sanitizeIngestGaps,
  isExtrasOnlyDailyRow,
  createMetricsDb,
} from '../metrics/repository.js';
import { createSyncQueue, isPermanentClientError, classifyIngestError } from '../cloud/syncQueue.js';
import { createFinalizer } from '../metrics/finalization.js';

test('bindLiveMetricsReads throws when DayCompleteness APIs are missing', () => {
  assert.throws(
    () => bindLiveMetricsReads({ loadUserDays: async () => {} }).upsertDayCompleteness('u', {}),
    /upsertDayCompleteness required/,
  );
  const live = {
    loadUserDays: async () => ({}),
    listPhysiologyManifests: async () => [],
    getDayCompleteness: async () => null,
    upsertDayCompleteness: async () => ({ ok: true }),
    invalidateDayCompleteness: async () => 0,
    listIngestGaps: async () => [],
    resolveIngestGaps: async () => 0,
    patchDailyExtras: async () => ({ ok: true }),
    latestOvernightRun: async () => null,
  };
  const bound = bindLiveMetricsReads(live);
  assert.equal(typeof bound.upsertDayCompleteness, 'function');
  assert.equal(typeof bound.listIngestGaps, 'function');
  assert.equal(typeof bound.resolveIngestGaps, 'function');
});

test('extras-only daily rows do not call engine_replace_sleep_day', () => {
  assert.equal(isExtrasOnlyDailyRow({ user_id: 'u', day: '2026-08-29', extras: { overnight_finalization: {} } }), true);
  assert.equal(shouldReplaceSleepDay({
    sleep_details: [],
    daily_metrics: [{ user_id: 'u', day: '2026-08-29', extras: { overnight_finalization: {} } }],
  }), false);
  assert.equal(shouldReplaceSleepDay({
    sleep_details: [],
    device: { id: 'd' },
    daily_metrics: [{ user_id: 'u', day: '2026-08-29', source_device_id: 'd', recovery_score: 50 }],
  }), true);
});

test('unknown ingest gap kinds coerce instead of 400', () => {
  const rows = sanitizeIngestGaps([
    { kind: 'hr_stream_stalled', start_at: '2026-08-29T00:00:00Z', end_at: '2026-08-29T01:00:00Z' },
    { kind: 'not-a-kind', start_at: '2026-08-29T01:00:00Z', end_at: '2026-08-29T02:00:00Z' },
    { kind: 'upload' },
  ]);
  assert.equal(rows[0].kind, 'hr_stream_stalled');
  assert.equal(rows[1].kind, 'missing_interval');
  assert.equal(rows.length, 2);
});

test('REST daily_metrics merges extras instead of replacing them', async () => {
  const calls = [];
  const db = createMetricsDb({
    cfg: {
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'service-key',
      ingestSecret: 'secret',
      supabaseAnonKey: 'anon',
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      if (String(url).includes('daily_metrics') && (options.method || 'GET') === 'GET') {
        return {
          ok: true,
          status: 200,
          async json() {
            return [{ extras: { healthkit: { steps: 9 }, hr_v2: { mode: 'ppg' } } }];
          },
          async text() { return '[]'; },
        };
      }
      return { ok: true, status: 200, async text() { return ''; }, async json() { return []; } };
    },
  });
  await db.upsertPayload({
    user_id: 'u',
    daily_metrics: [{
      user_id: 'u',
      day: '2026-08-29',
      record_class: 'user',
      extras: { overnight_finalization: { state: 'finalized' } },
    }],
  });
  const post = calls.find((c) => c.url.includes('/daily_metrics') && c.method === 'POST');
  assert.equal(post.body[0].extras.healthkit.steps, 9);
  assert.equal(post.body[0].extras.hr_v2.mode, 'ppg');
  assert.equal(post.body[0].extras.overnight_finalization.state, 'finalized');
});

test('patchDailyExtras uses the merge RPC, never extras-only REST', async () => {
  const calls = [];
  const db = createMetricsDb({
    cfg: {
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'service-key',
      ingestSecret: 'secret',
      supabaseAnonKey: 'anon',
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      return { ok: true, status: 200, async text() { return '{"ok":true}'; }, async json() { return { ok: true }; } };
    },
  });
  await db.patchDailyExtras('11111111-1111-4111-8111-111111111111', '2026-08-29', {
    overnight_finalization: { state: 'finalized' },
  });
  assert.ok(calls.some((c) => String(c.url).includes('engine_patch_daily_extras')));
  assert.equal(calls.some((c) => String(c.url).endsWith('/daily_metrics') && c.method === 'POST'), false);
});

test('patchDailyExtras supports service-role persistence without an ingest secret', async () => {
  const calls = [];
  const db = createMetricsDb({
    cfg: {
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'service-key',
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, async text() { return '{"ok":true}'; } };
    },
  });
  await db.patchDailyExtras('11111111-1111-4111-8111-111111111111', '2026-08-29', {
    steps_v3: { status: 'ok' },
  });
  assert.ok(calls[0].url.includes('engine_patch_daily_extras'));
  assert.equal(calls[0].body.p_secret, '');
});

test('latestOvernightRun queries one overnight_finalize row', async () => {
  const calls = [];
  const db = createMetricsDb({
    cfg: {
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'service-key',
    },
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, async json() { return []; }, async text() { return '[]'; } };
    },
  });
  await db.latestOvernightRun('11111111-1111-4111-8111-111111111111', '2026-08-29');
  assert.match(String(calls[0]), /algorithm=eq.overnight_finalize/);
  assert.match(String(calls[0]), /limit=1/);
});

test('permanent 4xx outbox ops dead-letter instead of retrying forever', async () => {
  const err = new Error('ingest_gaps write failed (400) invalid kind');
  err.status = 400;
  err.body = '{"code":"23514"}';
  assert.equal(isPermanentClientError(err), true);
  assert.equal(isPermanentClientError(new Error('write failed (503)')), false);
  assert.equal(classifyIngestError({ status: 409, body: '{"code":"23505"}' }).action, 'success');
  assert.equal(classifyIngestError({ status: 409, body: '{"code":"23503"}' }).action, 'dead_letter');
  assert.equal(classifyIngestError({ status: 401 }).action, 'block');

  let attempts = 0;
  const q = createSyncQueue({
    persist: false,
    flushIntervalMs: 60_000,
    now: () => 1_000,
    executor: {
      configured: () => true,
      async exec() {
        attempts += 1;
        const e = new Error('engine_replace_sleep_day failed (400) user_id required');
        e.status = 400;
        e.body = 'user_id required';
        throw e;
      },
    },
  });
  q.enqueue({ type: 'ingest', payload: { user_id: 'u', ingest_gaps: [{ kind: 'nope' }] } });
  await q.flush();
  await q.flush();
  assert.equal(attempts, 1);
  assert.equal(q.status().deadLetters, 1);
  assert.equal(q.status().pending, 0);
  assert.match(q._pending()[0].lastError, /400/);
  q.stop();
});

test('service-role session upsert preserves user-modified bounds', async () => {
  const posts = [];
  const db = createMetricsDb({
    cfg: {
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'service-key',
    },
    fetchImpl: async (url, options = {}) => {
      const method = options.method || 'GET';
      if (String(url).includes('/sessions') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          async json() {
            return [{ id: 'sleep-1', user_modified: true, start_at: 'user-start', end_at: 'user-end' }];
          },
          async text() { return '[]'; },
        };
      }
      if (method === 'POST' && String(url).includes('/sessions')) {
        posts.push(JSON.parse(options.body));
      }
      return { ok: true, status: 200, async text() { return ''; }, async json() { return []; } };
    },
  });
  await db.upsertPayload({
    user_id: '11111111-1111-4111-8111-111111111111',
    sessions: [{
      id: 'sleep-1', kind: 'sleep', start_at: 'auto-start', end_at: 'auto-end', user_modified: false,
    }],
  });
  assert.equal(posts[0][0].start_at, 'user-start');
  assert.equal(posts[0][0].end_at, 'user-end');
  assert.equal(posts[0][0].user_modified, true);
});

test('createFinalizer still constructs without a completeness db', () => {
  const finalizer = createFinalizer({
    engine: { recomputeFromStorage: async () => ({ results: [] }) },
    db: { upsertPayload: async () => ({}) },
  });
  assert.equal(typeof finalizer.finalizeAffectedDays, 'function');
});
