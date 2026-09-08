import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHourBuffer } from '../ingest/hourBuffer.js';
import { createMetricsEngine } from '../metrics/engine.js';
import { decodeArchive } from '../ingest/archiveFormat.js';
import { dayBounds } from '../time/dayBoundary.js';
import { snapshotToWhoopDay } from '../metrics/snapshot.js';
import { createMetricsDb } from '../metrics/repository.js';
import { createSyncQueue } from '../cloud/syncQueue.js';

const USER = '22222222-2222-4222-8222-222222222222';
const TZ = 'America/Los_Angeles';
const DAY = '2026-08-24';

/** Minimal in-memory B2-like object store. */
function makeObjectStore() {
  const blobs = new Map();
  return {
    blobs,
    async putObject(key, body) { blobs.set(key, body); return { etag: '"x"', bytes: Buffer.isBuffer(body) ? body.length : body.byteLength }; },
    async head(key) {
      const b = blobs.get(key);
      return b ? { exists: true, contentLength: b.length } : null;
    },
    async getObject(key) {
      const b = blobs.get(key);
      return b ? { body: b } : null;
    },
  };
}

/** Minimal Supabase-like in-memory db with the merge semantics the real repository has. */
function makeDb() {
  const state = {
    object_manifests: new Map(),   // id -> row
    daily_metrics: new Map(),      // user|day -> row
    series: new Map(),             // user|day -> { hr_series: Map(t->pt), sample_count, ... }
    sessions: [],
    sleep_details: [],
    ingest_gaps: [],
    metric_runs: [],
    day_completeness: new Map(),   // user|day -> canonical gate row
  };
  const db = {
    state,
    async upsertPayload(payload = {}) {
      for (const m of payload.object_manifests || []) state.object_manifests.set(m.id, m);
      for (const d of payload.daily_metrics || []) state.daily_metrics.set(`${d.user_id}|${d.day}`, d);
      for (const s of payload.daily_physiology_series || []) {
        const key = `${s.user_id}|${s.day}`;
        const existing = state.series.get(key);
        const map = new Map(existing?.hr_series || []);
        for (const pt of s.hr_series || []) map.set(pt.t, pt);
        state.series.set(key, {
          ...existing,
          user_id: s.user_id,
          day: s.day,
          sample_count: Math.max(existing?.sample_count || 0, s.sample_count || map.size),
          hr_series: map,
        });
      }
      if (payload.sessions) state.sessions.push(...payload.sessions);
      if (payload.sleep_details) state.sleep_details.push(...payload.sleep_details);
      if (payload.ingest_gaps) state.ingest_gaps.push(...payload.ingest_gaps);
      if (payload.metric_runs) state.metric_runs.push(...payload.metric_runs);
      return { ok: true };
    },
    async getDayCompleteness(userId, day) {
      return state.day_completeness.get(`${userId}|${day}`) || null;
    },
    async upsertDayCompleteness(userId, row = {}) {
      const key = `${userId}|${row.day}`;
      const existing = state.day_completeness.get(key) || null;
      state.day_completeness.set(key, { ...existing, ...row, user_id: userId });
      return state.day_completeness.get(key);
    },
    async invalidateDayCompleteness(userId, days = []) {
      for (const day of days) {
        const key = `${userId}|${day}`;
        const row = state.day_completeness.get(key);
        if (row) state.day_completeness.set(key, { ...row, status: 'open', finalized_at: null });
      }
      return days.length;
    },
    async listIngestGaps(userId, loIso, hiIso) {
      return state.ingest_gaps.filter((g) => {
        const gs = Date.parse(g.start_at);
        const ge = Date.parse(g.end_at);
        return Number.isFinite(gs) && Number.isFinite(ge) && ge > Date.parse(loIso) && gs < Date.parse(hiIso);
      });
    },
    async resolveIngestGaps(userId, rows = []) {
      let n = 0;
      for (const r of rows) {
        const gap = state.ingest_gaps.find((g) => g.id === r.id);
        if (gap && !gap.resolved_at) {
          gap.resolved_at = r.resolved_at;
          gap.resolution = r.resolution || 'backfilled';
          n += 1;
        }
      }
      return n;
    },
    async listPhysiologyManifests({ userId, days = [], fromDay, toDay, timeZone = 'UTC' } = {}) {
      const selected = new Set(days);
      return [...state.object_manifests.values()].filter((m) => (
        m.user_id === userId
        && m.object_kind === 'physiology'
        && ['ready', 'verified'].includes(m.status)
        && (selected.size ? selected.has(m.period_day) : true)
      )).sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)) || 0);
    },
  };
  return db;
}

test('HOUR-BUFFER ACCEPTANCE: 24h continuous wear -> B2 -> derived -> restart -> requery (archive path, not the Supabase writer)', async () => {
  const raw = makeObjectStore();
  const derived = makeObjectStore();
  const db = makeDb();
  const cfg = { localUserId: USER, rawStore: 'b2', derivedStore: 'b2', b2Bucket: 'FRWHOOP', buildHash: 'test', hrChunkMs: 3600_000 };
  const engine = createMetricsEngine({ cfg, stores: { raw, derived }, db });

  // ---- 1. Generate 24h of representative WHOOP data (30s cadence -> 2880 samples) ----
  const bounds = dayBounds(DAY, TZ);
  const startMs = Date.parse(bounds.day_start_at);
  const endMs = Date.parse(bounds.day_end_at);
  const samples = [];
  for (let t = startMs; t < endMs; t += 30000) {
    const h = new Date(t).getUTCHours();
    const bpm = 52 + Math.round(10 * Math.sin(t / 3_600_000)) + (h % 5); // plausible resting/spike curve
    samples.push({ datetime: new Date(t).toISOString(), bpm, rr_ms: [], connected: true, src: 'ble_hr', seq: samples.length + 1 });
  }
  assert.equal(samples.length, 24 * 60 * 2); // 2880

  // ---- 2. Ingest through the normal live/hourly pipeline (hourBuffer -> engine archive) ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-accept-'));
  let now = startMs;
  const hourBuffer = createHourBuffer({
    dir,
    userId: USER,
    chunkMs: 3_600_000,
    timeZone: TZ,
    now: () => new Date(now),
    engine,
  });
  // Ingest hour by hour. Append is fire-and-forget in the real system (a flush
  // may still be in flight when we call flush()), so settle each hour with a
  // drain loop; the WAL guarantees nothing is lost in the meantime.
  for (let h = 0; h < 24; h += 1) {
    const hourSamples = samples.slice(h * 120, (h + 1) * 120);
    for (const s of hourSamples) {
      hourBuffer.append(s);
      now = Date.parse(s.datetime) + 1000;
    }
    let guard = 0;
    while (hourBuffer.pendingCount() > 0 && guard < 100) {
      await hourBuffer.flush();
      if (hourBuffer.pendingCount() > 0) await new Promise((r) => setTimeout(r, 30));
      guard += 1;
    }
    assert.equal(hourBuffer.pendingCount(), 0, `hour ${h} must fully flush`);
  }

  // ---- 3. Verify raw B2 objects + manifests are durable and complete ----
  const physManifests = [...db.state.object_manifests.values()].filter((m) => m.object_kind === 'physiology');
  assert.ok(physManifests.length >= 24, `expected ~24 hourly B2 objects, got ${physManifests.length}`);
  for (const m of physManifests) {
    assert.ok(['ready', 'verified'].includes(m.status), `manifest ${m.id} must be ready`);
    assert.ok(m.sample_count > 0, `manifest ${m.id} must have samples`);
    assert.ok(raw.blobs.has(m.object_key), `B2 object ${m.object_key} must exist`);
  }
  const totalB2Samples = physManifests.reduce((n, m) => n + m.sample_count, 0);
  assert.equal(totalB2Samples, samples.length, 'B2 must hold every ingested sample');

  // raw replay decode must reproduce the samples exactly
  let decoded = [];
  for (const m of physManifests) {
    const body = raw.blobs.get(m.object_key);
    decoded = decoded.concat(decodeArchive(body));
  }
  assert.equal(decoded.length, samples.length);
  assert.equal(decoded[0].bpm, samples[0].bpm);

  // ---- 4. Derived day is written (Supabase physiology series / daily metrics) ----
  const seriesKey = `${USER}|${DAY}`;
  assert.ok(db.state.series.has(seriesKey), 'daily physiology series must exist for the day');
  const series = db.state.series.get(seriesKey);
  const hrPoints = [...series.hr_series.values()];
  assert.ok(hrPoints.length >= 285, `expected >=285/288 5-min buckets covered, got ${hrPoints.length}`);

  // ---- 5. RESTART services: fresh engine + fresh stores view of the same persisted state ----
  const raw2 = makeObjectStore();
  for (const [k, v] of raw.blobs) raw2.blobs.set(k, v);
  const derived2 = makeObjectStore();
  for (const [k, v] of derived.blobs) derived2.blobs.set(k, v);
  const db2 = makeDb();
  for (const [k, m] of db.state.object_manifests) db2.state.object_manifests.set(k, { ...m });
  const engine2 = createMetricsEngine({ cfg, stores: { raw: raw2, derived: derived2 }, db: db2 });

  // ---- 6. After restart, requery the day via manifest replay + recompute ----
  const replay = await engine2.recomputeFromStorage({ userId: USER, days: [DAY], timeZone: TZ });
  assert.ok(replay.manifests >= 24, 'replay must find all hourly manifests after restart');
  assert.equal(replay.samples, samples.length, 'replay must reconstruct the full day');
  assert.ok(replay.results.length >= 1, 'recompute must produce a derived day result');

  // ---- 6b. Canonical DayCompleteness gate: the replayed day must be proven ----
  assert.ok(Array.isArray(replay.dayCompleteness) && replay.dayCompleteness.length >= 1,
    'replay must report canonical day completeness');
  const gateSummary = replay.dayCompleteness.find((g) => g.day === DAY);
  assert.ok(gateSummary, 'canonical gate must cover the acceptance day');
  assert.equal(gateSummary.status, 'complete', `gate status ${gateSummary?.status}`);
  assert.ok(gateSummary.finalized_at, 'a complete day must carry a finalize time');
  assert.equal(gateSummary.open_gaps, 0, 'a complete day must have zero open gaps');
  assert.equal(gateSummary.unclassified_ms, 0, 'a complete day must have zero unclassified gap time');
  const gateRow = db2.state.day_completeness.get(`${USER}|${DAY}`);
  assert.ok(gateRow, 'day_completeness row must persist');
  assert.equal(gateRow.status, 'complete');
  assert.ok(gateRow.finalized_at, 'persisted finalize time required');
  // The invariant, restated: a finalized day can never contain a recoverable or
  // unclassified gap.
  assert.equal(gateRow.result.gaps.counts.recoverable, 0);
  assert.equal(gateRow.result.gaps.counts.unclassified, 0);
  assert.equal(gateRow.result.raw_archive_verification.verification_complete, true);

  // ---- 7. Frontend retrieval: build a snapshot from persisted series + metrics and confirm bpm_data ----
  const dmRow = db2.state.daily_metrics.get(`${USER}|${DAY}`);
  const seriesRow = db2.state.series.get(`${USER}|${DAY}`);
  const snap = {
    day: DAY,
    metrics: dmRow || {},
    sleep: db2.state.sleep_details.filter((s) => String(s.start_at).slice(0, 10) === DAY || String(s.end_at).slice(0, 10) === DAY),
    sessions: db2.state.sessions,
    chart: [...(seriesRow?.hr_series.values() || [])],
  };
  const whoop = snapshotToWhoopDay(snap);
  assert.ok(Array.isArray(whoop.bpm_data));
  assert.ok(whoop.bpm_data.length >= 285, `frontend bpm_data must cover the day, got ${whoop.bpm_data.length}`);
  assert.ok(whoop.physiological_summary != null);
  // frontend bpm uses avg_hr (regression guard for the RPC empty-chart bug)
  assert.ok(Number.isFinite(Number(whoop.bpm_data[0].bpm)), 'frontend bpm_data must map avg_hr');
});

test('PRODUCTION PATH: outbox + createMetricsDb + engine_replace_sleep_day never empty-replaces a sparse live day', async () => {
  const USER_ID = '22222222-2222-4222-8222-222222222222';
  const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
  const rpcCalls = [];
  const daily = new Map();
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (String(url).includes('/rpc/engine_replace_sleep_day')) {
      const payload = JSON.parse(options.body).p_payload;
      rpcCalls.push({
        day: payload.daily_metrics?.[0]?.day,
        details: (payload.sleep_details || []).length,
        explicit_clear: (payload.sleep_details || []).length === 0,
      });
      return { ok: true, status: 200, async text() { return '{"ok":true}'; } };
    }
    if (String(url).includes('/daily_metrics') && method === 'POST') {
      const rows = JSON.parse(options.body);
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        const key = `${row.user_id}|${row.day}`;
        daily.set(key, { ...(daily.get(key) || {}), ...row });
      }
      return { ok: true, status: 201, async text() { return ''; } };
    }
    if (method === 'GET') {
      return { ok: true, status: 200, async text() { return '[]'; }, async json() { return []; } };
    }
    return { ok: true, status: 201, async text() { return ''; }, async json() { return []; } };
  };
  const db = createMetricsDb({
    cfg: {
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'service-key',
      supabaseAnonKey: 'anon',
      ingestSecret: 'secret',
    },
    fetchImpl,
  });
  daily.set(`${USER_ID}|2026-08-30`, {
    user_id: USER_ID, day: '2026-08-30', sleep_performance_pct: 12, recovery_score: 11,
  });
  const q = createSyncQueue({
    persist: false,
    flushIntervalMs: 60_000,
    now: () => 1_000,
    executor: {
      configured: () => true,
      async exec(op) { await db.upsertPayload(op.payload); },
    },
  });
  q.enqueue({
    type: 'ingest',
    payload: {
      user_id: USER_ID,
      device: { id: DEVICE_ID, source_kind: 'whoop', external_device_id: 'strap' },
      daily_metrics: [{
        user_id: USER_ID, day: '2026-08-29', source_device_id: DEVICE_ID, record_class: 'user',
        timezone_name: 'UTC', recovery_score: 44, sleep_performance_pct: 38.1,
      }],
      sessions: [{
        id: 'sess-29', user_id: USER_ID, device_id: DEVICE_ID, kind: 'sleep',
        source: 'frwhoop', external_id: `sleep:${DEVICE_ID}:2026-08-29:main`,
        start_at: '2026-08-28T22:00:00Z', end_at: '2026-08-29T06:00:00Z',
      }],
      sleep_details: [{
        session_id: 'sess-29', user_id: USER_ID, original_end_at: '2026-08-29T06:00:00Z',
      }],
    },
  });
  q.enqueue({
    type: 'ingest',
    payload: {
      user_id: USER_ID,
      device: { id: DEVICE_ID, source_kind: 'whoop', external_device_id: 'strap' },
      daily_metrics: [{
        user_id: USER_ID, day: '2026-08-30', source_device_id: DEVICE_ID, record_class: 'user',
        timezone_name: 'UTC', strain_score: 6.7, avg_hr_bpm: 71,
      }],
    },
  });
  await q.flush();
  q.stop();
  assert.deepEqual(rpcCalls.map((c) => c.day), ['2026-08-29']);
  assert.equal(rpcCalls.some((c) => c.day === '2026-08-30'), false);
  assert.equal(daily.get(`${USER_ID}|2026-08-30`).sleep_performance_pct, 12);
  assert.equal(daily.get(`${USER_ID}|2026-08-30`).strain_score, 6.7);
  assert.equal(daily.get(`${USER_ID}|2026-08-29`).recovery_score, 44);
});
