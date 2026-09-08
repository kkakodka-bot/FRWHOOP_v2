/**
 * Tier 2: async scoring + debounced recompute preserves canonical accuracy.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUserRuntimes } from '../identity/userRuntime.js';
import { createMetricsEngine } from '../metrics/engine.js';
import { presentMetric } from '../metrics/canonicalRegistry.js';

const USER = '55555555-5555-5555-8555-555555555555';
const DAY = '2026-08-24';
const TZ = 'UTC';
const PROFILE = { birthYear: 1994, sex: 'male', heightCm: 178, weightKg: 74, restingHr: 48 };

function makeObjectStore() {
  const blobs = new Map();
  return {
    blobs,
    async putObject(key, body) {
      blobs.set(key, body);
      return { etag: '"x"', bytes: Buffer.isBuffer(body) ? body.length : body.byteLength };
    },
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

function makeDb() {
  const state = {
    object_manifests: new Map(),
    daily_metrics: new Map(),
    series: new Map(),
    sessions: [],
    sleep_details: [],
    ingest_gaps: [],
    metric_runs: [],
    day_completeness: new Map(),
    energy_daily: [],
  };
  return {
    state,
    async upsertPayload(payload = {}) {
      for (const m of payload.object_manifests || []) state.object_manifests.set(m.id, m);
      for (const d of payload.daily_metrics || []) state.daily_metrics.set(`${d.user_id}|${d.day}`, d);
      for (const s of payload.daily_physiology_series || []) {
        const key = `${s.user_id}|${s.day}`;
        const existing = state.series.get(key);
        const map = new Map(existing?.hr_series || []);
        for (const pt of s.hr_series || []) map.set(pt.t, pt);
        const strain = new Map((existing?.strain_series || []).map((p) => [p.bucket_start || p.t, p]));
        for (const pt of s.strain_series || []) strain.set(pt.bucket_start || pt.t, pt);
        const skin = new Map((existing?.skin_temp_series || []).map((p) => [p.t || p.datetime, p]));
        for (const pt of s.skin_temp_series || []) skin.set(pt.t || pt.datetime, pt);
        state.series.set(key, {
          ...existing,
          ...s,
          user_id: s.user_id,
          day: s.day,
          sample_count: Math.max(existing?.sample_count || 0, s.sample_count || map.size),
          hr_series: map,
          strain_series: [...strain.values()],
          skin_temp_series: [...skin.values()],
        });
      }
      if (payload.sessions) state.sessions.push(...payload.sessions);
      if (payload.sleep_details) state.sleep_details.push(...payload.sleep_details);
      if (payload.ingest_gaps) state.ingest_gaps.push(...payload.ingest_gaps);
      if (payload.metric_runs) state.metric_runs.push(...payload.metric_runs);
      if (payload.energy_daily) state.energy_daily.push(...payload.energy_daily);
      return { ok: true };
    },
    async getDayCompleteness() { return null; },
    async upsertDayCompleteness(userId, row = {}) {
      state.day_completeness.set(`${userId}|${row.day}`, { ...row, user_id: userId });
      return state.day_completeness.get(`${userId}|${row.day}`);
    },
    async invalidateDayCompleteness() { return 0; },
    async listIngestGaps() { return state.ingest_gaps; },
    async resolveIngestGaps() { return 0; },
    async listPhysiologyManifests({ userId, days = [] } = {}) {
      const selected = new Set(days);
      return [...state.object_manifests.values()].filter((m) => (
        m.user_id === userId
        && m.object_kind === 'physiology'
        && ['ready', 'verified'].includes(m.status)
        && (selected.size ? selected.has(m.period_day) : true)
      )).sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));
    },
  };
}

function completeDaySamples() {
  const start = Date.parse(`${DAY}T00:00:00.000Z`);
  const samples = [];
  let stepCounter = 100;
  for (let sec = 0; sec < 24 * 3600; sec += 1) {
    const t = start + sec * 1000;
    const hour = Math.floor(sec / 3600);
    const night = hour < 7;
    const workout = hour === 10 && (sec % 3600) < 30 * 60;
    if (!night && sec % 10 !== 0) continue;
    const sample = {
      datetime: new Date(t).toISOString(),
      t: new Date(t).toISOString(),
      seq: samples.length + 1,
      bpm: workout ? 148 : (night ? 48 + (hour % 3) : 72 + (hour % 12)),
      gx: night ? 0 : (Math.floor(sec / 3) % 2),
      gy: 0,
      gz: night ? 1 : (Math.floor(sec / 3) % 2 ? 0 : 1),
      mot: workout ? 0.85 : (night ? 0.01 : 0.12),
      motion: workout ? 0.85 : (night ? 0.01 : 0.12),
      skin_temp_c: 33.4 + (hour % 5) * 0.05,
      connected: true,
      src: 'history',
    };
    if (night) sample.rr_ms = [1220, 1180, 1200];
    else {
      stepCounter += 1;
      sample.step_cumulative = stepCounter;
    }
    samples.push(sample);
  }
  return samples;
}

const CANONICAL_KEYS = [
  'steps',
  'strain_score',
  'recovery_score',
  'sleep_total_min',
  'resting_hr_bpm',
  'active_kcal',
  'basal_kcal',
  'hrv_ms',
  'avg_hr',
  'max_hr',
];

function metricSlice(row) {
  if (!row) return null;
  return Object.fromEntries(CANONICAL_KEYS.map((key) => [key, presentMetric(row[key])]));
}

function makeEngine(db) {
  const raw = makeObjectStore();
  const derived = makeObjectStore();
  const engine = createMetricsEngine({
    cfg: { localUserId: USER, rawStore: 'b2', derivedStore: 'b2', b2Bucket: 'FRWHOOP', buildHash: 'tier2-test' },
    stores: { raw, derived },
    db,
    energyContext: async () => ({ profile: PROFILE, workouts: [] }),
  });
  return { engine, raw, derived };
}

async function drainHistoryBuffer(runtimes, userId) {
  const history = runtimes.historyBufferOf(userId);
  for (let i = 0; i < 200; i += 1) {
    await history.flush();
    if (!history.pendingCount()) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(history.pendingCount(), 0, 'history buffer must drain before scoring');
}

async function ingestDayThroughRuntime({
  scoreAsync,
  scoreDebounceMs,
  chunkCount = 1,
  track = null,
}) {
  const db = makeDb();
  const { engine } = makeEngine(db);
  const wrapped = track ? {
    archiveRawSamples: async (...args) => {
      track.archives += 1;
      return engine.archiveRawSamples(...args);
    },
    archiveRawFrames: engine.archiveRawFrames?.bind(engine),
    archiveDerivedStream: engine.archiveDerivedStream?.bind(engine),
    persistComputed: async (...args) => {
      track.persists += 1;
      return engine.persistComputed(...args);
    },
    recomputeFromStorage: async (...args) => {
      track.recomputes.push([...(args[0]?.days || [])].sort());
      return engine.recomputeFromStorage(...args);
    },
  } : engine;

  const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-tier2-'));
  const runtimes = createUserRuntimes({
    engine: wrapped,
    liveDir,
    cfg: { historyBatchSamples: 600, historyFlushMs: 1, hrChunkMs: 3600_000 },
    scoreAsync,
    scoreDebounceMs,
    loadStore: () => ({ profile: { timezone: TZ, ...PROFILE }, activities: [], prefs: {} }),
    saveStore: () => {},
    loadPersistedDays: async () => ({}),
  });

  const samples = completeDaySamples();
  const chunkSize = Math.ceil(samples.length / chunkCount);
  for (let i = 0; i < chunkCount; i += 1) {
    const chunk = samples.slice(i * chunkSize, (i + 1) * chunkSize);
    if (!chunk.length) continue;
    runtimes.appendHistory(USER, chunk, { historyComplete: i === chunkCount - 1 });
    await drainHistoryBuffer(runtimes, USER);
  }
  await runtimes.flushAll();

  return { db, runtimes, engine: wrapped };
}

test('debounces multi-chunk history into one storage replay', async () => {
  const track = { archives: 0, persists: 0, recomputes: [] };
  const db = makeDb();
  const { engine } = makeEngine(db);
  const wrapped = {
    archiveRawSamples: async (...args) => {
      track.archives += 1;
      return engine.archiveRawSamples(...args);
    },
    persistComputed: async (...args) => {
      track.persists += 1;
      return engine.persistComputed(...args);
    },
    recomputeFromStorage: async (...args) => {
      track.recomputes.push([...(args[0]?.days || [])].sort());
      return engine.recomputeFromStorage(...args);
    },
  };
  const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-tier2-debounce-'));
  const runtimes = createUserRuntimes({
    engine: wrapped,
    liveDir,
    cfg: { historyBatchSamples: 1, historyFlushMs: 1, hrChunkMs: 3600_000 },
    scoreAsync: true,
    scoreDebounceMs: 500,
    loadStore: () => ({ profile: { timezone: TZ, ...PROFILE }, activities: [], prefs: {} }),
    saveStore: () => {},
    loadPersistedDays: async () => ({}),
  });
  for (let h = 0; h < 8; h += 1) {
    runtimes.appendHistory(USER, [{
      seq: h + 1,
      t: `2026-08-24T${String(h).padStart(2, '0')}:00:00.000Z`,
      bpm: 60 + h,
    }], { historyComplete: h === 7 });
    await drainHistoryBuffer(runtimes, USER);
  }
  assert.equal(track.recomputes.length, 0, 'debounce holds replays until drain');
  await runtimes.flushAllScores(USER);
  assert.equal(track.recomputes.length, 1, `expected one coalesced replay, got ${track.recomputes.length}`);
  assert.deepEqual(track.recomputes[0], ['2026-08-24']);
});

test('async tier2 scoring matches sync canonical metrics on a full day', async () => {
  const baselineDb = makeDb();
  const { engine: baselineEngine } = makeEngine(baselineDb);
  const samples = completeDaySamples();
  for (let hour = 0; hour < 24; hour += 1) {
    const chunk = samples.filter((s) => new Date(s.t).getUTCHours() === hour);
    await baselineEngine.archiveRawSamples({
      samples: chunk,
      device: { id: 'strap' },
      startAt: chunk[0].datetime,
      endAt: chunk.at(-1).datetime,
      extras: { userId: USER, timeZone: TZ, periodDay: DAY },
    });
  }
  await baselineEngine.recomputeFromStorage({ userId: USER, days: [DAY], timeZone: TZ });
  const baselineRow = baselineDb.state.daily_metrics.get(`${USER}|${DAY}`);
  assert.ok(baselineRow, 'baseline canonical replay must persist daily_metrics');

  const asyncRun = await ingestDayThroughRuntime({
    scoreAsync: true,
    scoreDebounceMs: 50,
    chunkCount: 12,
  });

  const asyncRow = asyncRun.db.state.daily_metrics.get(`${USER}|${DAY}`);
  assert.ok(asyncRow, 'async path must persist daily_metrics');

  const baselineSlice = metricSlice(baselineRow);
  const asyncSlice = metricSlice(asyncRow);
  assert.deepEqual(asyncSlice, baselineSlice, 'tier2 async must match canonical replay metrics');

  assert.ok(Number(baselineSlice.steps) > 0);
  assert.ok(Number(baselineSlice.strain_score) > 0);
  assert.ok(Number(baselineSlice.sleep_total_min) > 0);
  assert.ok(Number(baselineSlice.resting_hr_bpm) > 0);

  const baselineSeries = baselineDb.state.series.get(`${USER}|${DAY}`);
  const asyncSeries = asyncRun.db.state.series.get(`${USER}|${DAY}`);
  assert.ok((baselineSeries?.hr_series?.size || 0) >= 200);
  assert.equal(asyncSeries?.hr_series?.size || 0, baselineSeries?.hr_series?.size || 0);
  assert.equal(asyncSeries?.strain_series?.length || 0, baselineSeries?.strain_series?.length || 0);
});

test('idempotent second replay keeps async metrics stable', async () => {
  const { db, engine } = await ingestDayThroughRuntime({
    scoreAsync: true,
    scoreDebounceMs: 50,
    chunkCount: 6,
  });
  const first = metricSlice(db.state.daily_metrics.get(`${USER}|${DAY}`));
  assert.ok(first, 'async ingest must produce daily_metrics before idempotence check');
  await engine.recomputeFromStorage({ userId: USER, days: [DAY], timeZone: TZ });
  const second = metricSlice(db.state.daily_metrics.get(`${USER}|${DAY}`));
  assert.deepEqual(second, first, 'second replay must not drift async metrics');
});
