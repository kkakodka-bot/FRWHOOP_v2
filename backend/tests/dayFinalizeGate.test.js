import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createHourBuffer } from '../ingest/hourBuffer.js';
import { createMetricsEngine } from '../metrics/engine.js';
import { registerHostRoutes } from '../host/routes.js';
import { dayBounds } from '../time/dayBoundary.js';

const USER = '44444444-4444-4444-8444-444444444444';
const TZ = 'America/Los_Angeles';
const DAY = '2026-08-24';

function makeObjectStore() {
  const blobs = new Map();
  return {
    blobs,
    async putObject(key, body) { blobs.set(key, body); return { etag: '"x"', bytes: body.length }; },
    async head(key) { const b = blobs.get(key); return b ? { exists: true, contentLength: b.length } : null; },
    async getObject(key) { const b = blobs.get(key); return b ? { body: b } : null; },
  };
}

/** In-memory Supabase-like db WITH the canonical gate tables. */
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
    resolveCalls: [],
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
        state.series.set(key, { ...existing, user_id: s.user_id, day: s.day, hr_series: map, sample_count: Math.max(existing?.sample_count || 0, s.sample_count || map.size) });
      }
      if (payload.sessions) state.sessions.push(...payload.sessions);
      if (payload.sleep_details) state.sleep_details.push(...payload.sleep_details);
      if (payload.ingest_gaps) state.ingest_gaps.push(...payload.ingest_gaps);
      if (payload.metric_runs) state.metric_runs.push(...payload.metric_runs);
      return { ok: true };
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
    async getDayCompleteness(userId, day) {
      return state.day_completeness.get(`${userId}|${day}`) || null;
    },
    async upsertDayCompleteness(userId, row = {}) {
      const key = `${userId}|${row.day}`;
      state.day_completeness.set(key, { ...state.day_completeness.get(key), ...row, user_id: userId });
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
        state.resolveCalls.push(r.id);
        const gap = state.ingest_gaps.find((g) => g.id === r.id);
        if (gap && !gap.resolved_at) {
          gap.resolved_at = r.resolved_at;
          gap.resolution = r.resolution || 'backfilled';
          n += 1;
        }
      }
      return n;
    },
  };
  return db;
}

function fullDaySamples(cadenceMs = 60000) {
  const b = dayBounds(DAY, TZ);
  const out = [];
  for (let t = Date.parse(b.day_start_at); t < Date.parse(b.day_end_at); t += cadenceMs) {
    out.push({ datetime: new Date(t).toISOString(), bpm: 55, rr_ms: [], connected: true, src: 'ble_hr' });
  }
  return out;
}

async function ingestDay(engine, samples, cadenceMs = 60000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-gate-'));
  const cfg = { localUserId: USER, rawStore: 'b2', derivedStore: 'b2', b2Bucket: 'FRWHOOP', buildHash: 'test', hrChunkMs: 3600_000 };
  let now = Date.parse(dayBounds(DAY, TZ).day_start_at);
  const hourBuffer = createHourBuffer({
    dir, userId: USER, chunkMs: 3_600_000, timeZone: TZ,
    now: () => new Date(now), engine,
  });
  const perHour = Math.round(3600000 / cadenceMs);
  for (let h = 0; h < 24; h += 1) {
    const chunk = samples.slice(h * perHour, (h + 1) * perHour);
    if (!chunk.length) break;
    for (const s of chunk) {
      hourBuffer.append(s);
      now = Date.parse(s.datetime) + 1000;
    }
    let guard = 0;
    while (hourBuffer.pendingCount() > 0 && guard < 100) {
      await hourBuffer.flush();
      if (hourBuffer.pendingCount() > 0) await new Promise((r) => setTimeout(r, 20));
      guard += 1;
    }
    assert.equal(hourBuffer.pendingCount(), 0, `hour ${h} must fully flush`);
  }
  return dir;
}

function engineFor(db, raw, derived) {
  const cfg = { localUserId: USER, rawStore: 'b2', derivedStore: 'b2', b2Bucket: 'FRWHOOP', buildHash: 'test', hrChunkMs: 3600_000 };
  return createMetricsEngine({ cfg, stores: { raw, derived }, db });
}

test('GATE: full day finalizes complete; B2 object loss re-opens it; repair re-finalizes', async () => {
  const raw = makeObjectStore();
  const derived = makeObjectStore();
  const db = makeDb();
  const engine = engineFor(db, raw, derived);

  await ingestDay(engine, fullDaySamples());

  // 1. Replay proves the day and finalizes it.
  const replay1 = await engine.recomputeFromStorage({ userId: USER, days: [DAY], timeZone: TZ });
  const gate1 = (replay1.dayCompleteness || []).find((g) => g.day === DAY);
  assert.ok(gate1, 'gate must run during replay');
  assert.equal(gate1.status, 'complete', `gate status ${gate1?.status}`);
  assert.ok(gate1.finalized_at, 'complete day is finalized');
  const row1 = db.state.day_completeness.get(`${USER}|${DAY}`);
  assert.equal(row1.status, 'complete');
  assert.ok(row1.finalized_at);
  const firstFinalizedAt = row1.finalized_at;

  // 2. B2 loses one object: the day must re-open. A finalized day never
  //    survives a broken archive, and verification is actual SHA256, not trust.
  const manifestRows = [...db.state.object_manifests.values()].filter((m) => m.object_kind === 'physiology');
  assert.ok(manifestRows.length >= 2, 'day must span several objects');
  const victim = manifestRows.find((m) => raw.blobs.has(m.object_key));
  assert.ok(victim, 'victim object exists');
  const backup = raw.blobs.get(victim.object_key);
  raw.blobs.delete(victim.object_key);

  const replay2 = await engine.recomputeFromStorage({ userId: USER, days: [DAY], timeZone: TZ });
  const gate2 = (replay2.dayCompleteness || []).find((g) => g.day === DAY);
  assert.ok(gate2, 'gate must run during the degraded replay');
  assert.equal(gate2.status, 'open', 'object loss must re-open the day');
  const row2 = db.state.day_completeness.get(`${USER}|${DAY}`);
  assert.equal(row2.status, 'open', 'persisted row must re-open');
  assert.equal(row2.finalized_at, null, 're-opened day loses its finalize stamp');

  // 3. Restore the object (B2 repair) and replay: the day re-proves itself.
  raw.blobs.set(victim.object_key, backup);

  const replay3 = await engine.recomputeFromStorage({ userId: USER, days: [DAY], timeZone: TZ });
  const gate3 = (replay3.dayCompleteness || []).find((g) => g.day === DAY);
  assert.ok(gate3, 'gate must run during the repair replay');
  assert.equal(gate3.status, 'complete');
  assert.ok(gate3.finalized_at);
  assert.equal(gate3.open_gaps, 0);
  const row3 = db.state.day_completeness.get(`${USER}|${DAY}`);
  assert.equal(row3.status, 'complete');
  assert.ok(row3.finalized_at, 're-finalize stamp present');
});

test('GATE: invariant holds — a finalized day never carries recoverable or unclassified gaps', async () => {
  const raw = makeObjectStore();
  const db = makeDb();
  const engine = engineFor(db, raw, raw);
  await ingestDay(engine, fullDaySamples());
  const replay = await engine.recomputeFromStorage({ userId: USER, days: [DAY], timeZone: TZ });
  const gates = replay.dayCompleteness || [];
  assert.ok(gates.length >= 1, 'gate must report');
  for (const gate of gates) {
    const row = db.state.day_completeness.get(`${USER}|${gate.day}`);
    if (gate.status === 'complete' || gate.status === 'degraded') {
      assert.equal(row.result.gaps.counts.recoverable, 0, `finalized day ${gate.day} has zero recoverable gaps`);
      assert.equal(row.result.gaps.unclassified_ms, 0, `finalized day ${gate.day} has zero unclassified gap time`);
      assert.equal(row.result.raw_archive_verification.verification_complete, true);
      assert.ok(row.finalized_at, 'finalized day carries a finalize time');
    } else {
      assert.equal(gate.status, 'open', 'non-finalized gate must be explicitly open');
    }
  }
});

test('GATE: late history backfill resolves the covering gap rows (close-out, no dup)', async () => {
  const raw = makeObjectStore();
  const db = makeDb();
  const engine = engineFor(db, raw, raw);
  await ingestDay(engine, fullDaySamples());

  // A pre-existing open gap row (e.g. a phone-reported suspend gap) that the
  // archived samples actually cover.
  const b = dayBounds(DAY, TZ);
  const gapStart = Date.parse(b.day_start_at) + 5 * 3600000;
  const gapEnd = gapStart + 30 * 60000;
  db.state.ingest_gaps.push({
    id: 'gap-1',
    user_id: USER,
    kind: 'suspend',
    start_at: new Date(gapStart).toISOString(),
    end_at: new Date(gapEnd).toISOString(),
    expected_samples: 450,
    received_samples: 0,
    meta: {},
  });

  const replay = await engine.recomputeFromStorage({ userId: USER, days: [DAY], timeZone: TZ });
  assert.ok(db.state.resolveCalls.includes('gap-1'), 'backfill resolver must be invoked for the covered gap');
  const stored = db.state.ingest_gaps.find((g) => g.id === 'gap-1');
  assert.equal(stored.resolved_at != null, true, 'gap row resolved durably');
  assert.equal(stored.resolution, 'backfilled');
  const gate = (replay.dayCompleteness || []).find((g) => g.day === DAY);
  assert.equal(gate.status, 'complete', 'covered gap must not block completion');
  const row = db.state.day_completeness.get(`${USER}|${DAY}`);
  assert.ok(row.result.gaps.counts.backfilled >= 1, 'resolved row appears as backfilled, not open');
});

test('VERIFY: /api/ingest/verify fails loudly (503) when manifest access is unavailable', async () => {
  const app = express();
  app.use(express.json());
  registerHostRoutes(app, {
    loadStore: () => ({ prefs: {} }),
    saveStore: () => {},
    resolveUser: () => ({ id: USER }),
    loadIngestVerify: async () => {
      const err = new Error('manifest_access_unavailable');
      err.code = 'ingest_verify_unavailable';
      throw err;
    },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ingest/verify?day=${DAY}`);
    assert.equal(res.status, 503, 'historical verify must fail loudly, not return an empty day');
    const body = await res.json();
    assert.equal(body.error, 'ingest_verify_manifest_unavailable');
    assert.equal(body.replay_available, false);
  } finally {
    server_close(server);
  }
  function server_close(s) { s.close(); }
});
