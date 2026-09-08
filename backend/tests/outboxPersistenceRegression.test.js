/**
 * Regression coverage for the 2026-08-30 production outage: every Overview
 * metric after Aug 26 vanished because the durable outbox merged per-day
 * ingest payloads into multi-day ops, and the Supabase writer could not
 * write those:
 *   - engine_replace_sleep_day rejects multi-day daily_metrics (P0001)
 *   - PostgREST rejects heterogeneous-key bulk POSTs (PGRST102)
 *   - live_windows.raw_object_id has an FK into sensor_objects, but the
 *     archive path records manifests in object_manifests (23503)
 * Permanent 4xx ops dead-letter; before the fix, new payloads merged into the
 * dead op and were swallowed forever.
 *
 * These tests run the REAL repository write path against a fetch mock that
 * enforces the same constraints Postgres/PostgREST does.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMetricsDb, rowsByShape, normalizeIngestGapRow, splitSleepReplacement, inferSleepReplaceDays } from '../metrics/repository.js';
import { createSyncQueue, mergeIngestPayloads, classifyIngestError } from '../cloud/syncQueue.js';

const USER = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const PREFER = 'resolution=merge-duplicates,return=minimal';

/** PostgREST/Postgres-faithful mock. Enforces the exact failure modes. */
function makeSupabaseMock() {
  const state = {
    devices: new Map(),
    daily_metrics: new Map(),     // `${user}|${day}` -> row
    sessions: new Map(),
    sleep_details: new Map(),
    sensor_objects: new Map(),
    object_manifests: new Map(),
    ingest_gaps: new Map(),
    live_windows: new Map(),
    metric_runs: new Map(),
    rpcCalls: [],
    posts: [],
  };

  function applyUpsert(table, pkOf, rows, prefer) {
    const merge = String(prefer || '').includes('merge-duplicates');
    const seenThisPost = new Set();
    for (const row of rows) {
      const key = pkOf(row);
      // Postgres 21000: ON CONFLICT DO UPDATE cannot affect a row twice.
      if (seenThisPost.has(key)) {
        throw Object.assign(new Error('ON CONFLICT DO UPDATE cannot affect row a second time'), { status: 500 });
      }
      seenThisPost.add(key);
      const existing = state[table].get(key);
      if (existing && merge) {
        state[table].set(key, { ...existing, ...row });
      } else if (existing) {
        throw Object.assign(new Error('duplicate key'), { status: 409 });
      } else {
        state[table].set(key, row);
      }
    }
  }

  const TABLES = {
    devices: { pk: (r) => r.id },
    daily_metrics: { pk: (r) => `${r.user_id}|${r.day}` },
    sessions: { pk: (r) => r.id },
    sleep_details: { pk: (r) => r.session_id },
    sensor_objects: { pk: (r) => r.id },
    object_manifests: { pk: (r) => r.id },
    ingest_gaps: { pk: (r) => r.id },
    live_windows: { pk: (r) => r.id },
    metric_runs: { pk: (r) => r.id },
  };

  function rowMatches(row, url) {
    const qs = String(url).split('?')[1] || '';
    for (const part of qs.split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const col = decodeURIComponent(part.slice(0, eq));
      const rest = decodeURIComponent(part.slice(eq + 1));
      if (col === 'select' || col === 'order' || col === 'limit') continue;
      const match = /^(eq|gte|lte|gt|lt|in|is)\.(.*)$/.exec(rest);
      if (!match) continue;
      const [, op, raw] = match;
      const value = row[col];
      if (op === 'eq' && String(value) !== raw) return false;
      if (op === 'gte' && String(value ?? '') < raw) return false;
      if (op === 'lte' && String(value ?? '') > raw) return false;
      if (op === 'gt' && String(value ?? '') <= raw) return false;
      if (op === 'lt' && String(value ?? '') >= raw) return false;
      if (op === 'in') {
        const inner = raw.replace(/^\(/, '').replace(/\)$/, '').split(',');
        if (!inner.includes(String(value))) return false;
      }
      if (op === 'is' && raw === 'null' && value != null) return false;
    }
    return true;
  }

  async function fetchImpl(url, options = {}) {
    const method = options.method || 'GET';
    if (url.includes('/rpc/engine_replace_sleep_day')) {
      state.rpcCalls.push({ rpc: 'engine_replace_sleep_day', payload: JSON.parse(options.body).p_payload });
      const payload = JSON.parse(options.body).p_payload;
      const days = new Set((payload.daily_metrics || []).map((r) => r.day));
      if (days.size > 1) {
        return {
          ok: false, status: 400,
          async text() { return JSON.stringify({ code: 'P0001', message: 'sleep replacement accepts one physiological day' }); },
        };
      }
      // Simulate the RPC's projection ownership for the single day.
      const day = [...days][0] || null;
      for (const s of payload.sessions || []) state.sessions.set(s.id, s);
      for (const d of payload.sleep_details || []) state.sleep_details.set(d.session_id, d);
      if (day) {
        const key = `${payload.user_id}|${day}`;
        const details = payload.sleep_details || [];
        const clear = !details.length;
        const existing = state.daily_metrics.get(key) || {};
        const sleepCols = [
          'rest', 'sleep_performance_pct', 'sleep_total_min', 'sleep_in_bed_min',
          'sleep_awake_min', 'sleep_light_min', 'sleep_deep_min', 'sleep_rem_min',
          'sleep_efficiency', 'sleep_need_min', 'sleep_debt_balance_min', 'sleep_consistency',
          'sleep_onset_at', 'wake_onset_at', 'overnight_hr_bpm', 'disturbances',
        ];
        let sleepPatch;
        if (clear) {
          sleepPatch = Object.fromEntries(sleepCols.map((c) => [c, null]));
        } else {
          const main = details.find((d) => !d.is_nap) || details[0];
          sleepPatch = {
            rest: main.performance_pct ?? null,
            sleep_performance_pct: main.performance_pct ?? null,
            sleep_total_min: main.asleep_min ?? null,
            sleep_onset_at: main.original_start_at ?? null,
            wake_onset_at: main.original_end_at ?? null,
          };
        }
        state.daily_metrics.set(key, { ...existing, ...sleepPatch, user_id: payload.user_id, day });
      }
      return { ok: true, status: 200, async text() { return '{"ok":true}'; } };
    }
    const table = Object.keys(TABLES).find((t) => url.includes(`/${t}`) && !url.includes('/rpc/'));
    if (table && method === 'POST') {
      const parsed = JSON.parse(options.body);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      state.posts.push({ table, rows, prefer: options.headers?.prefer || '' });
      // PGRST102: every row in one POST must carry an identical key set.
      const shapes = new Set(rows.map((r) => Object.keys(r).sort().join(',')));
      if (shapes.size > 1) {
        return {
          ok: false, status: 400,
          async text() { return JSON.stringify({ code: 'PGRST102', message: 'All object keys must match' }); },
        };
      }
      if (table === 'live_windows') {
        for (const row of rows) {
          if (row.raw_object_id && !state.sensor_objects.has(row.raw_object_id)) {
            return {
              ok: false, status: 409,
              async text() { return JSON.stringify({ code: '23503', message: 'violates foreign key constraint' }); },
            };
          }
        }
      }
      applyUpsert(table, TABLES[table].pk, rows, options.headers?.prefer);
      return { ok: true, status: 201, async text() { return ''; } };
    }
    if (table && method === 'DELETE') {
      const idMatch = /id=eq\.([^&]+)/.exec(url);
      if (idMatch) state[table].delete(idMatch[1]);
      return { ok: true, status: 204, async text() { return ''; } };
    }
    if (table && method === 'GET') {
      const rows = [...state[table].values()].filter((row) => rowMatches(row, url));
      const body = JSON.stringify(rows);
      return { ok: true, status: 200, async text() { return body; }, async json() { return rows; } };
    }
    return { ok: true, status: 200, async text() { return '[]'; }, async json() { return []; } };
  }

  return { state, fetchImpl };
}

function makeDb(fetchImpl) {
  return createMetricsDb({
    cfg: {
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'service-key',
      ingestSecret: 'secret',
      supabaseAnonKey: 'anon',
    },
    fetchImpl,
  });
}

function dailyRow(day, extra = {}) {
  return {
    user_id: USER, day, source_device_id: DEVICE, record_class: 'user',
    timezone_name: 'UTC', computed_at: `2026-08-30T10:00:00Z`, algorithm_version: 'test',
    ...extra,
  };
}

function sleepSession(day, slot = 'main') {
  const externalId = `sleep:${DEVICE}:${day}:${slot}`;
  return {
    id: `sess-${day}-${slot}`, user_id: USER, device_id: DEVICE, kind: slot.includes('nap') ? 'nap' : 'sleep',
    source: 'frwhoop', external_id: externalId,
    start_at: `${day}T22:00:00Z`, end_at: `${day}T06:00:00Z`, user_modified: false,
  };
}

function sleepDetail(session, extra = {}) {
  return {
    session_id: session.id, user_id: USER, is_nap: false,
    asleep_min: 420, performance_pct: 80, recovery_pct: 55,
    original_start_at: session.start_at, original_end_at: session.end_at,
    ...extra,
  };
}

test('multi-day merged outbox payload persists every day (the production failure)', async () => {
  const mock = makeSupabaseMock();
  const db = makeDb(mock.fetchImpl);
  const sleepA = sleepSession('2026-08-28');
  const sleepB = sleepSession('2026-08-29');
  // A merged outbox payload: three days of daily rows, two nights of sleep
  // projections, plus telemetry — exactly what the queue merges into one op.
  const payload = {
    user_id: USER,
    device: { id: DEVICE, source_kind: 'whoop', external_device_id: 'strap' },
    daily_metrics: [
      dailyRow('2026-08-28', { recovery_score: 44, resting_hr_bpm: 59, sleep_performance_pct: 38.1 }),
      dailyRow('2026-08-29', { recovery_score: null }),
      dailyRow('2026-08-30', { strain_score: 7, steps: 1200 }),
    ],
    sessions: [sleepA, sleepB, { id: 'workout-1', user_id: USER, device_id: DEVICE, kind: 'workout' }],
    sleep_details: [sleepDetail(sleepA), sleepDetail(sleepB)],
    object_manifests: [
      { id: 'm1', user_id: USER, object_kind: 'physiology', object_key: 'k1', status: 'ready', provider: 'b2' },
      { id: 'm2', user_id: USER, object_kind: 'hr', object_key: 'k2', status: 'ready', provider: 'b2' },
    ],
    ingest_gaps: [
      { user_id: USER, kind: 'missing_interval', start_at: '2026-08-29T00:00:00Z', end_at: '2026-08-29T01:00:00Z' },
      { user_id: USER, kind: 'connection', start_at: '2026-08-29T02:00:00Z', end_at: '2026-08-29T03:00:00Z', meta: { reason: 'x' }, sample_seq_end: 42 },
    ],
    // One window references a canonical physiology manifest (whose kind the
    // legacy sensor_objects registry rejects), one an 'hr' object (mirrorable).
    live_windows: [
      { user_id: USER, device_id: DEVICE, period_day: '2026-08-29', start_at: '2026-08-29T00:00:00Z', end_at: '2026-08-29T01:00:00Z', sample_count: 10, raw_object_id: 'm1', status: 'ready' },
      { user_id: USER, device_id: DEVICE, period_day: '2026-08-29', start_at: '2026-08-29T01:00:00Z', end_at: '2026-08-29T02:00:00Z', sample_count: 8, raw_object_id: 'm2', status: 'ready' },
    ],
    metric_runs: [{ id: 'run-1', user_id: USER, period_day: '2026-08-28', algorithm: 'overnight_finalize', status: 'complete' }],
  };

  await db.upsertPayload(payload);

  // Per-day sleep replacement: one RPC per day that has sleep work, never the
  // strain-only live day that only shares the merged op.
  const sleepRpcCalls = mock.state.rpcCalls.filter((c) => c.rpc === 'engine_replace_sleep_day');
  assert.equal(sleepRpcCalls.length, 2, `expected RPC for sleep days only, got ${sleepRpcCalls.length}`);
  for (const call of sleepRpcCalls) {
    const days = new Set((call.payload.daily_metrics || []).map((r) => r.day));
    assert.equal(days.size, 1, 'RPC payload must be single-day');
  }
  const rpcDays = sleepRpcCalls.map((c) => c.payload.daily_metrics?.[0]?.day).sort();
  assert.deepEqual(rpcDays, ['2026-08-28', '2026-08-29']);
  const day28 = sleepRpcCalls.find((c) => c.payload.daily_metrics?.[0]?.day === '2026-08-28');
  assert.deepEqual(day28.payload.sleep_details.map((d) => d.session_id), [sleepA.id]);

  // All three daily rows land.
  assert.equal(mock.state.daily_metrics.get(`${USER}|2026-08-28`).recovery_score, 44);
  assert.equal(mock.state.daily_metrics.get(`${USER}|2026-08-29`).recovery_score, null);
  assert.equal(mock.state.daily_metrics.get(`${USER}|2026-08-30`).steps, 1200);

  // Sleep projections land through the RPC; the workout goes through the table.
  assert.ok(mock.state.sleep_details.has(sleepA.id));
  assert.ok(mock.state.sleep_details.has(sleepB.id));
  assert.ok(mock.state.sessions.has('workout-1'));

  // Gaps land in one uniform-shape POST with deterministic ids.
  const gapPost = mock.state.posts.find((p) => p.table === 'ingest_gaps');
  assert.equal(gapPost.rows.length, 2);
  const shapes = new Set(gapPost.rows.map((r) => Object.keys(r).sort().join(',')));
  assert.equal(shapes.size, 1, 'normalized gaps must share one key shape');
  for (const row of gapPost.rows) assert.ok(/^[0-9a-f-]{36}$/.test(row.id), 'gap ids must be uuids');
  assert.ok(mock.state.ingest_gaps.size >= 2);

  // The window referencing the physiology manifest lands with the legacy FK
  // satisfied: the registry rejects the 'physiology' kind, so the link is
  // dropped while the telemetry row survives. The mirrorable 'hr' object is
  // mirrored and keeps its link.
  assert.equal(mock.state.live_windows.size, 2);
  const physWindow = [...mock.state.live_windows.values()].find((w) => w.period_day === '2026-08-29' && w.start_at === '2026-08-29T00:00:00Z');
  const hrWindow = [...mock.state.live_windows.values()].find((w) => w.start_at === '2026-08-29T01:00:00Z');
  assert.equal(physWindow.raw_object_id, null, 'unmirrorable link must be dropped, not FK-violate');
  assert.ok(mock.state.sensor_objects.has('m2'), 'mirrorable kind must be mirrored to sensor_objects');
  assert.equal(hrWindow.raw_object_id, 'm2');

  assert.ok(mock.state.metric_runs.has('run-1'));
});

test('a sparse live daily row cannot erase persisted overnight metrics', async () => {
  const mock = makeSupabaseMock();
  const db = makeDb(mock.fetchImpl);
  // Persist the overnight projection first.
  const overnightSession = sleepSession('2026-08-28');
  await db.upsertPayload({
    user_id: USER,
    device: { id: DEVICE, source_kind: 'whoop', external_device_id: 'strap' },
    daily_metrics: [dailyRow('2026-08-28', {
      recovery_score: 44, hrv_rmssd_ms: 62, resting_hr_bpm: 59,
      sleep_performance_pct: 38.1, sleep_total_min: 183, sleep_onset_at: '2026-08-27T21:19:16Z',
    })],
    sessions: [overnightSession],
    sleep_details: [sleepDetail(overnightSession, {
      performance_pct: 38.1, asleep_min: 183, original_start_at: '2026-08-27T21:19:16Z',
    })],
  });
  // Now the same day flushes live with no sleep keys at all (the live path's
  // daily row when no window was scored): strain + avg HR only. The engine
  // omits the unscored keys entirely; merge-duplicates must leave them.
  await db.upsertPayload({
    user_id: USER,
    daily_metrics: [{
      user_id: USER, day: '2026-08-28', source_device_id: DEVICE, record_class: 'user',
      timezone_name: 'UTC', computed_at: '2026-08-30T11:00:00Z', algorithm_version: 'test',
      strain_score: 3.9, avg_hr_bpm: 71,
    }],
  });
  const row = mock.state.daily_metrics.get(`${USER}|2026-08-28`);
  assert.equal(row.recovery_score, 44, 'overnight recovery must survive the sparse live write');
  assert.equal(row.hrv_rmssd_ms, 62, 'overnight HRV must survive');
  assert.equal(row.resting_hr_bpm, 59, 'overnight RHR must survive');
  assert.equal(row.sleep_performance_pct, 38.1, 'overnight sleep performance must survive');
  assert.equal(row.sleep_total_min, 183, 'overnight sleep duration must survive');
  assert.equal(row.strain_score, 3.9, 'the sparse write must still land its own keys');
  assert.equal(row.avg_hr_bpm, 71);
});

test('queue merge then write: overnight values survive a merged sparse live row', async () => {
  // The production order: the finalizer enqueues the overnight projection,
  // the live flush enqueues a sparse row for the same day, the queue merges
  // them into ONE op, then the writer flushes the merged op once.
  const overnight = {
    user_id: USER,
    device: { id: DEVICE, source_kind: 'whoop', external_device_id: 'strap' },
    daily_metrics: [dailyRow('2026-08-28', { recovery_score: 44, hrv_rmssd_ms: 62, resting_hr_bpm: 59, sleep_performance_pct: 38.1 })],
    sessions: [sleepSession('2026-08-28')],
    sleep_details: [sleepDetail(sleepSession('2026-08-28'), { performance_pct: 38.1 })],
  };
  // The engine's live daily row omits keys it did not measure (it never writes
  // explicit undefined/null for unscored sleep), so the merge must keep the
  // overnight projection's values for those keys.
  const liveSparse = {
    user_id: USER,
    device: { id: DEVICE, source_kind: 'whoop', external_device_id: 'strap' },
    daily_metrics: [{
      user_id: USER, day: '2026-08-28', source_device_id: DEVICE, record_class: 'user',
      timezone_name: 'UTC', computed_at: '2026-08-30T11:00:00Z', algorithm_version: 'test',
      strain_score: 5, steps: 900,
    }],
  };
  const merged = mergeIngestPayloads(mergeIngestPayloads({}, overnight), liveSparse);
  const mock = makeSupabaseMock();
  const db = makeDb(mock.fetchImpl);
  await db.upsertPayload(merged);
  const row = mock.state.daily_metrics.get(`${USER}|2026-08-28`);
  assert.equal(row.recovery_score, 44, 'merged op must keep the overnight recovery');
  assert.equal(row.sleep_performance_pct, 38.1, 'merged op must keep overnight sleep');
  assert.equal(row.strain_score, 5, 'merged op must take the live strain');
  assert.equal(row.steps, 900);
  // The merged op still carries the sleep projection for the RPC.
  const rpcCalls = mock.state.rpcCalls.filter((c) => c.rpc === 'engine_replace_sleep_day');
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].payload.sleep_details.length, 1);
});

test('a resolved ingest gap is never reopened by a re-post', async () => {
  const mock = makeSupabaseMock();
  const db = makeDb(mock.fetchImpl);
  const gap = { user_id: USER, kind: 'missing_interval', start_at: '2026-08-29T00:00:00Z', end_at: '2026-08-29T01:00:00Z' };
  await db.upsertPayload({ user_id: USER, ingest_gaps: [gap] });
  const id = normalizeIngestGapRow(gap, USER).id;
  // The resolve path closes the gap.
  const stored = mock.state.ingest_gaps.get(id);
  stored.resolved_at = '2026-08-30T00:00:00Z';
  stored.resolution = 'backfilled';
  // A queue retry re-posts the same gap without resolved_at.
  await db.upsertPayload({ user_id: USER, ingest_gaps: [gap] });
  const after = mock.state.ingest_gaps.get(id);
  assert.equal(after.resolved_at, '2026-08-30T00:00:00Z', 're-post must not reopen a resolved gap');
  assert.equal(after.resolution, 'backfilled');
  // The id is deterministic: the re-post upserted the same row.
  assert.equal([...mock.state.ingest_gaps.keys()].length, 1);
});

test('rowsByShape groups heterogeneous rows into uniform posts', () => {
  const groups = rowsByShape([
    { a: 1, b: 2 },
    { b: 3, a: 4 },
    { a: 5 },
    null,
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map((r) => r.a).sort(), [1, 4]);
  assert.equal(groups[1][0].a, 5);
});

test('splitSleepReplacement attributes sleep rows by external_id day', () => {
  const payload = {
    user_id: USER,
    device: { id: DEVICE },
    daily_metrics: [dailyRow('2026-08-28'), dailyRow('2026-08-29')],
    sessions: [sleepSession('2026-08-28'), sleepSession('2026-08-29', 'nap:0')],
    sleep_details: [sleepDetail(sleepSession('2026-08-28')), sleepDetail(sleepSession('2026-08-29', 'nap:0'))],
  };
  const plan = splitSleepReplacement(payload);
  assert.equal(plan.slices.length, 2);
  const days = plan.slices.map((s) => s.day).sort();
  assert.deepEqual(days, ['2026-08-28', '2026-08-29']);
  for (const slice of plan.slices) {
    assert.equal(slice.sessions.length, 1);
    assert.equal(slice.sleep_details.length, 1);
    assert.ok(slice.daily_metrics.every((r) => r.day === slice.day));
  }
  assert.deepEqual(plan.direct, { sessions: [], sleep_details: [] });
});

test('dead-lettered outbox ops re-arm when new content merges in', async () => {
  let fail = true;
  const results = [];
  const q = createSyncQueue({
    persist: false,
    flushIntervalMs: 60_000,
    now: () => 1_000,
    executor: {
      configured: () => true,
      async exec(op) {
        if (fail) {
          const err = new Error('engine_replace_sleep_day failed (400) multi-day');
          err.status = 400;
          err.body = 'P0001';
          throw err;
        }
        results.push(op);
      },
    },
  });
  q.enqueue({ type: 'ingest', payload: { user_id: USER, device: { id: DEVICE }, daily_metrics: [dailyRow('2026-08-28', { recovery_score: 44 })] } });
  await q.flush();
  assert.equal(q.status().deadLetters, 1, 'the permanent 4xx dead-letters the op');
  // The writer is fixed; a NEW payload merges into the dead op.
  fail = false;
  q.enqueue({ type: 'ingest', payload: { user_id: USER, device: { id: DEVICE }, daily_metrics: [dailyRow('2026-08-29', { strain_score: 6 })] } });
  await q.flush();
  assert.equal(q.status().deadLetters, 0, 'the merged op must be re-armed');
  assert.equal(q.status().pending, 0, 'the merged op must flush');
  assert.equal(results.length, 1, 'the merged op (old + new content) is written once');
  const written = results[0].payload.daily_metrics.map((r) => r.day).sort();
  assert.deepEqual(written, ['2026-08-28', '2026-08-29'], 'the re-armed op carries BOTH days');
  q.stop();
});

test('duplicate conflict keys in one merged batch dedupe before posting (21000)', async () => {
  const mock = makeSupabaseMock();
  const db = makeDb(mock.fetchImpl);
  // The queue merges without deduping metric_runs (it caps the array), so the
  // same run id can appear twice in one op. The writer must dedupe by conflict
  // key instead of tripping Postgres 21000.
  await db.upsertPayload({
    user_id: USER,
    metric_runs: [
      { id: 'run-1', user_id: USER, period_day: '2026-08-28', algorithm: 'overnight_finalize', status: 'partial', finished_at: '2026-08-30T10:00:00Z' },
      { id: 'run-1', user_id: USER, period_day: '2026-08-28', algorithm: 'overnight_finalize', status: 'complete', finished_at: '2026-08-30T11:00:00Z' },
      { id: 'run-2', user_id: USER, period_day: '2026-08-29', algorithm: 'overnight_finalize', status: 'complete', finished_at: '2026-08-30T12:00:00Z' },
    ],
    // Same for daily rows merged from two eras of the same recompute.
    daily_metrics: [dailyRow('2026-08-28', { recovery_score: 44 }), dailyRow('2026-08-28', { recovery_score: 45 })],
  });
  assert.equal(mock.state.metric_runs.get('run-1').status, 'complete', 'newest duplicate wins');
  assert.equal(mock.state.metric_runs.get('run-1').finished_at, '2026-08-30T11:00:00Z');
  assert.equal(mock.state.daily_metrics.get(`${USER}|2026-08-28`).recovery_score, 45);
});

test('a merge racing an in-flight op is never dropped on success', async () => {
  // Production failure mode: a big op (e.g. a drained backlog) executes for
  // minutes; a live flush merges fresh rows into the SAME op mid-flight; the
  // execution succeeds and removes the op -> the merged rows are silently
  // lost. The rev check must keep the op pending for a re-write.
  const written = [];
  let mergeDuringExec = null;
  const q = createSyncQueue({
    persist: false,
    flushIntervalMs: 60_000,
    now: () => 1_000,
    executor: {
      configured: () => true,
      async exec(op) {
        written.push(JSON.parse(JSON.stringify(op.payload)));
        // A live flush lands while this op is executing.
        if (!mergeDuringExec) {
          mergeDuringExec = true;
          q.enqueue({ type: 'ingest', payload: { user_id: USER, device: { id: DEVICE }, daily_metrics: [dailyRow('2026-08-29', { strain_score: 9 })] } });
        }
      },
    },
  });
  q.enqueue({ type: 'ingest', payload: { user_id: USER, device: { id: DEVICE }, daily_metrics: [dailyRow('2026-08-28', { recovery_score: 44 })] } });
  await q.flush();
  // The raced pass wrote only the first day; the merged second day forces a
  // second pass that writes it.
  assert.equal(written.length, 2, 'the merged content must be rewritten');
  const days = written.flatMap((p) => p.daily_metrics.map((r) => r.day));
  assert.ok(days.includes('2026-08-29'), 'the mid-flight merge must survive');
  assert.equal(q.status().pending, 0, 'the op settles once a pass has no race');
  const finalPass = written.at(-1);
  assert.deepEqual(finalPass.daily_metrics.map((r) => r.day).sort(), ['2026-08-28', '2026-08-29']);
  q.stop();
});

test('stale sleep cleanup respects the engine day, not the window overlap', async () => {
  const mock = makeSupabaseMock();
  const db = makeDb(mock.fetchImpl);
  const dev = DEVICE;
  const mk = (slot, day, start, end) => ({
    id: `s-${day}-${slot}`, user_id: USER, device_id: dev,
    kind: slot.startsWith('nap') ? 'nap' : 'sleep', source: 'frwhoop',
    external_id: `sleep:${dev}:${day}:${slot}`, start_at: start, end_at: end,
    user_modified: false,
  });
  // Seed sessions: a midnight-crossing night owned by 2026-08-23 (its wake
  // instant is 2026-08-24 00:00:01 PDT), a nap owned by 2026-08-24, and an
  // unattributed legacy row inside the day-24 window.
  const owned23 = mk('main', '2026-08-23', '2026-08-24T05:25:56Z', '2026-08-24T07:00:01Z');
  const owned24 = mk('nap:0', '2026-08-24', '2026-08-24T15:00:00Z', '2026-08-24T16:00:00Z');
  const legacy = { id: 's-legacy', user_id: USER, device_id: dev, kind: 'sleep', source: 'frwhoop', start_at: '2026-08-24T10:00:00Z', end_at: '2026-08-24T11:00:00Z', user_modified: false };
  for (const row of [owned23, owned24, legacy]) mock.state.sessions.set(row.id, row);
  // Day 24's recompute produces only its own nap; the keep list has its id.
  const result = await db.deleteAutoSleepSessions({
    userId: USER, day: '2026-08-24', timeZone: 'America/Los_Angeles',
    keepIds: [owned24.id],
  });
  assert.equal(result.deleted, 1, 'only the unattributed legacy row is stale');
  assert.ok(mock.state.sessions.has(owned23.id), 'the day-23-owned midnight-crossing session must survive');
  assert.ok(mock.state.sessions.has(owned24.id), 'the kept day-24 row survives');
  assert.ok(!mock.state.sessions.has(legacy.id), 'the legacy unattributed row is cleaned by the window');
  // Without the keep list, day 24 still must not touch day 23's projection.
  await db.deleteAutoSleepSessions({
    userId: USER, day: '2026-08-24', timeZone: 'America/Los_Angeles', keepIds: [],
  });
  assert.ok(mock.state.sessions.has(owned23.id), 'a neighbor day must never delete an owned projection');
  assert.ok(!mock.state.sessions.has(owned24.id), 'the same-day stale row is deleted');
});

test('an empty sleep replacement only clears the days it recomputed', () => {
  const dev = DEVICE;
  const s24 = { id: 's-24', user_id: USER, device_id: dev, kind: 'sleep', external_id: `sleep:${dev}:2026-08-24:main` };
  const s25 = { id: 's-25', user_id: USER, device_id: dev, kind: 'sleep', external_id: `sleep:${dev}:2026-08-25:main` };
  const d24 = { session_id: 's-24', user_id: USER, asleep_min: 400 };
  const d25 = { session_id: 's-25', user_id: USER, asleep_min: 300 };
  const overnight = {
    user_id: USER, device: { id: dev },
    daily_metrics: [dailyRow('2026-08-24'), dailyRow('2026-08-25')],
    sessions: [s24, s25],
    sleep_details: [d24, d25],
  };
  // A replay of day 2026-08-25 finds no persistable sleep: its payload carries
  // an explicit empty replacement for that day only.
  const clear25 = {
    user_id: USER, device: { id: dev },
    daily_metrics: [{
      user_id: USER, day: '2026-08-25', source_device_id: dev, record_class: 'user',
      timezone_name: 'UTC', computed_at: '2026-08-30T12:00:00Z', algorithm_version: 'test',
      recovery_score: null,
    }],
    sessions: [],
    sleep_details: [],
  };
  const merged = mergeIngestPayloads(mergeIngestPayloads({}, overnight), clear25);
  assert.deepEqual(
    merged.sleep_details.map((d) => d.session_id).sort(),
    ['s-24'],
    "day 24's queued details must survive day 25's empty replacement",
  );
  assert.deepEqual(
    merged.sessions.map((s) => s.id).sort(),
    ['s-24'],
    "day 24's queued session must survive; day 25's cleared rows are removed",
  );
  assert.ok(Array.isArray(merged.sleep_details), 'the key stays present to drive the per-day clear');
  // The unaffected day-24 daily row is untouched.
  assert.deepEqual(merged.daily_metrics.map((r) => r.day).sort(), ['2026-08-24', '2026-08-25']);
});

test('the finalizer readback window sees nights that start after UTC midnight', async () => {
  const mock = makeSupabaseMock();
  const db = makeDb(mock.fetchImpl);
  // Day 2026-08-23 (America/Los_Angeles): the night starts 05:25 UTC on
  // Aug 24 — AFTER the UTC day end of Aug 23. The read must still find it.
  mock.state.sleep_details.set('sess-x', {
    session_id: 'sess-x', user_id: USER, is_nap: false,
    asleep_min: 79, performance_pct: 16.5,
    original_start_at: '2026-08-24T05:25:56Z', original_end_at: '2026-08-24T07:00:01Z',
  });
  const payload = await db.loadUserDays(USER, '2026-08-23', '2026-08-23');
  assert.ok(
    (payload.sleep_details || []).some((d) => d.session_id === 'sess-x'),
    'a night starting after UTC midnight must be inside the day read window',
  );
});

test('normalizeIngestGapRow keeps resolution only when carried', () => {
  const base = { user_id: USER, kind: 'missing_interval', start_at: '2026-08-29T00:00:00Z', end_at: '2026-08-29T01:00:00Z' };
  const open = normalizeIngestGapRow(base, USER);
  assert.equal('resolved_at' in open, false, 'an open gap must not carry a null resolution');
  const closed = normalizeIngestGapRow({ ...base, resolved_at: '2026-08-30T00:00:00Z', resolution: 'backfilled' }, USER);
  assert.equal(closed.resolved_at, '2026-08-30T00:00:00Z');
  assert.equal(closed.resolution, 'backfilled');
  assert.equal(normalizeIngestGapRow({ start_at: 'x' }, USER), null);
});

test('inferSleepReplaceDays: omitted sleep_details is no-op; empty array is originating days only', () => {
  assert.deepEqual(inferSleepReplaceDays({
    daily_metrics: [dailyRow('2026-08-30', { strain_score: 4 })],
  }), []);
  assert.deepEqual(inferSleepReplaceDays({
    device: { id: DEVICE },
    daily_metrics: [dailyRow('2026-08-29')],
    sleep_details: [],
  }).sort(), ['2026-08-29']);
  const overnight = {
    sessions: [sleepSession('2026-08-28')],
    sleep_details: [sleepDetail(sleepSession('2026-08-28'))],
    daily_metrics: [dailyRow('2026-08-28'), dailyRow('2026-08-30', { strain_score: 1 })],
  };
  assert.deepEqual(inferSleepReplaceDays(overnight), ['2026-08-28']);
  const merged = mergeIngestPayloads(overnight, {
    user_id: USER,
    daily_metrics: [dailyRow('2026-08-30', { strain_score: 5 })],
  });
  assert.deepEqual(merged.sleep_replace_days, ['2026-08-28']);
  assert.deepEqual(splitSleepReplacement(merged).slices.map((s) => s.day), ['2026-08-28']);
});

test('PRODUCTION PATH: queued overnight day N + sparse live N+1 does not empty-replace N+1', async () => {
  const mock = makeSupabaseMock();
  const db = makeDb(mock.fetchImpl);
  const nap = {
    id: 'nap-30', user_id: USER, device_id: DEVICE, kind: 'nap',
    source: 'frwhoop', external_id: `sleep:${DEVICE}:2026-08-30:nap:0`,
    start_at: '2026-08-30T18:00:00Z', end_at: '2026-08-30T18:20:00Z', user_modified: false,
  };
  mock.state.sessions.set(nap.id, nap);
  mock.state.sleep_details.set(nap.id, { session_id: nap.id, user_id: USER, is_nap: true, asleep_min: 20 });
  mock.state.daily_metrics.set(`${USER}|2026-08-30`, dailyRow('2026-08-30', {
    sleep_performance_pct: 12, sleep_total_min: 20, recovery_score: 11,
  }));

  const overnight = {
    user_id: USER,
    device: { id: DEVICE, source_kind: 'whoop', external_device_id: 'strap' },
    daily_metrics: [dailyRow('2026-08-29', { recovery_score: 44, sleep_performance_pct: 38.1 })],
    sessions: [sleepSession('2026-08-29')],
    sleep_details: [sleepDetail(sleepSession('2026-08-29'))],
  };
  const live = {
    user_id: USER,
    device: { id: DEVICE, source_kind: 'whoop', external_device_id: 'strap' },
    daily_metrics: [dailyRow('2026-08-30', { strain_score: 6.7, avg_hr_bpm: 71 })],
  };

  const q = createSyncQueue({
    persist: false,
    flushIntervalMs: 60_000,
    now: () => 1_000,
    executor: {
      configured: () => true,
      async exec(op) { await db.upsertPayload(op.payload); },
    },
  });
  q.enqueue({ type: 'ingest', payload: overnight });
  q.enqueue({ type: 'ingest', payload: live });
  await q.flush();
  q.stop();

  const rpcDays = mock.state.rpcCalls
    .filter((c) => c.rpc === 'engine_replace_sleep_day')
    .map((c) => c.payload.daily_metrics?.[0]?.day)
    .sort();
  assert.deepEqual(rpcDays, ['2026-08-29']);
  assert.equal(mock.state.sleep_details.has(nap.id), true, 'N+1 nap must survive');
  assert.equal(mock.state.sessions.has(nap.id), true);
  const day30 = mock.state.daily_metrics.get(`${USER}|2026-08-30`);
  assert.equal(day30.sleep_performance_pct, 12, 'N+1 sleep headline must not be RPC-cleared');
  assert.equal(day30.recovery_score, 11);
  assert.equal(day30.strain_score, 6.7);
  assert.equal(mock.state.daily_metrics.get(`${USER}|2026-08-29`).recovery_score, 44);
});

test('explicit sleep_details [] still clears the originating day only', async () => {
  const mock = makeSupabaseMock();
  const db = makeDb(mock.fetchImpl);
  const s24 = sleepSession('2026-08-24');
  const s25 = sleepSession('2026-08-25');
  await db.upsertPayload({
    user_id: USER,
    device: { id: DEVICE, source_kind: 'whoop', external_device_id: 'strap' },
    daily_metrics: [
      dailyRow('2026-08-24', { recovery_score: 40, sleep_performance_pct: 70 }),
      dailyRow('2026-08-25', { recovery_score: 50, sleep_performance_pct: 80 }),
    ],
    sessions: [s24, s25],
    sleep_details: [sleepDetail(s24, { performance_pct: 70 }), sleepDetail(s25, { performance_pct: 80 })],
  });
  const merged = mergeIngestPayloads(
    {
      user_id: USER, device: { id: DEVICE },
      daily_metrics: [
        dailyRow('2026-08-24', { recovery_score: 40, sleep_performance_pct: 70 }),
        dailyRow('2026-08-25', { recovery_score: 50, sleep_performance_pct: 80 }),
      ],
      sessions: [s24, s25],
      sleep_details: [sleepDetail(s24, { performance_pct: 70 }), sleepDetail(s25, { performance_pct: 80 })],
    },
    {
      user_id: USER, device: { id: DEVICE },
      daily_metrics: [dailyRow('2026-08-25', { recovery_score: null })],
      sessions: [],
      sleep_details: [],
    },
  );
  assert.deepEqual(merged.sleep_replace_days.sort(), ['2026-08-24', '2026-08-25']);
  mock.state.rpcCalls.length = 0;
  await db.upsertPayload(merged);
  const rpcDays = mock.state.rpcCalls.map((c) => ({
    day: c.payload.daily_metrics?.[0]?.day,
    details: (c.payload.sleep_details || []).length,
  })).sort((a, b) => a.day.localeCompare(b.day));
  assert.deepEqual(rpcDays, [
    { day: '2026-08-24', details: 1 },
    { day: '2026-08-25', details: 0 },
  ]);
  assert.equal(mock.state.daily_metrics.get(`${USER}|2026-08-25`).sleep_performance_pct, null);
  assert.equal(mock.state.daily_metrics.get(`${USER}|2026-08-24`).sleep_performance_pct, 70);
});

test('dead-lettered ingest redrives without a new merge', async () => {
  let fail = true;
  const written = [];
  const q = createSyncQueue({
    persist: false,
    flushIntervalMs: 60_000,
    now: () => 1_000,
    executor: {
      configured: () => true,
      async exec(op) {
        if (fail) {
          const err = new Error('engine_replace_sleep_day failed (400)');
          err.status = 400;
          err.body = JSON.stringify({ code: 'P0001', message: 'sleep replacement accepts one physiological day' });
          throw err;
        }
        written.push(op.payload.daily_metrics.map((r) => r.day));
      },
    },
  });
  q.enqueue({
    type: 'ingest',
    payload: { user_id: USER, device: { id: DEVICE }, daily_metrics: [dailyRow('2026-08-28', { recovery_score: 44 })] },
  });
  await q.flush();
  assert.equal(q.status().deadLetters, 1);
  fail = false;
  assert.equal(q.redrive({ reason: 'test' }).redriven, 1);
  await q.flush();
  assert.equal(q.status().deadLetters, 0);
  assert.equal(q.status().pending, 0);
  assert.deepEqual(written, [['2026-08-28']]);
  q.stop();
});

test('409 classification depends on the Postgres code', () => {
  assert.equal(classifyIngestError({ status: 409, body: '{"code":"23505"}' }).action, 'success');
  assert.equal(classifyIngestError({ status: 409, body: '{"code":"23503"}' }).action, 'dead_letter');
  assert.equal(classifyIngestError({ status: 409, body: 'conflict' }).action, 'retry');
  assert.equal(classifyIngestError({ status: 401 }).action, 'block');
  assert.equal(classifyIngestError({ status: 503 }).action, 'retry');
  assert.equal(classifyIngestError({ status: 429 }).action, 'retry');
});

test('unique 409 is treated as an idempotent success', async () => {
  const q = createSyncQueue({
    persist: false,
    flushIntervalMs: 60_000,
    now: () => 1_000,
    executor: {
      configured: () => true,
      async exec() {
        const err = new Error('sessions write failed (409)');
        err.status = 409;
        err.body = JSON.stringify({ code: '23505', message: 'duplicate key' });
        throw err;
      },
    },
  });
  q.enqueue({ type: 'ingest', payload: { user_id: USER, daily_metrics: [dailyRow('2026-08-28')] } });
  await q.flush();
  assert.equal(q.status().pending, 0);
  assert.equal(q.status().deadLetters, 0);
  q.stop();
});

test('the finalizer readback window filters by original_end_at', async () => {
  const mock = makeSupabaseMock();
  const db = makeDb(mock.fetchImpl);
  mock.state.sleep_details.set('sess-x', {
    session_id: 'sess-x', user_id: USER, is_nap: false,
    asleep_min: 79, performance_pct: 16.5,
    original_start_at: '2026-08-24T05:25:56Z', original_end_at: '2026-08-24T07:00:01Z',
  });
  mock.state.sleep_details.set('sess-old', {
    session_id: 'sess-old', user_id: USER, is_nap: false,
    original_end_at: '2026-08-20T07:00:00Z',
  });
  const payload = await db.loadUserDays(USER, '2026-08-23', '2026-08-23');
  assert.ok(
    (payload.sleep_details || []).some((d) => d.session_id === 'sess-x'),
    'a night starting after UTC midnight must be inside the day read window',
  );
  assert.equal(
    (payload.sleep_details || []).some((d) => d.session_id === 'sess-old'),
    false,
    'nights outside the original_end_at window must not leak in',
  );
});
