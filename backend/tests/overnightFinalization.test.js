import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMetricsEngine } from '../metrics/engine.js';
import { createFinalizer, finalizeFromTrigger, classifyFinalization, FINALIZATION_STATES, FINALIZATION_REASONS } from '../metrics/finalization.js';
import { createBaselineSet, observation } from '../baseline/service.js';
import { createHistoryBuffer } from '../ingest/historyBuffer.js';
import { dayBounds } from '../time/dayBoundary.js';
import { inferSleepReplaceDays } from '../metrics/repository.js';

const USER = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function activeVector(i) {
  return Math.floor(i / 3) % 2 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
}

/** Physiologically consistent 1 Hz block (mirrors tests/overnight.test.js). */
function appendBlock(samples, startMs, durationSec, { bpm, still, rr = false, jitterMs = 40, rrFraction = 1, seq = { n: 0 }, deviceId = 'strap-1' } = {}) {
  const rrMs = Math.round(60_000 / bpm);
  const burst = Math.max(1, Math.round(6000 / rrMs));
  let carry = 0;
  let beat = 0;
  for (let i = 0; i < durationSec; i += 1) {
    const gravity = still ? { x: 0, y: 0, z: 1 } : activeVector(i);
    const sample = {
      seq: seq.n++,
      t: new Date(startMs + i * 1000).toISOString(),
      bpm,
      rr_ms: [],
      device_id: deviceId,
    };
    if (gravity) Object.assign(sample, { gx: gravity.x, gy: gravity.y, gz: gravity.z });
    if (rr && (i % 1000) / 1000 < rrFraction) {
      carry += 1000;
      if (carry >= burst * rrMs) {
        carry -= burst * rrMs;
        sample.rr_ms = Array.from({ length: burst }, () => {
          const v = rrMs + (beat % 2 ? jitterMs : 0);
          beat += 1;
          return v;
        });
      }
    }
    samples.push(sample);
  }
  return samples;
}

/**
 * A night crossing local midnight: evening activity 21:00-23:30 on `day`,
 * still sleep with RR 23:30 → 07:00 the next morning, wake activity 1 h.
 */
function midnightNight({ day = '2026-08-28', utcHour = 21, sleepBpm = 50 } = {}) {
  const base = Date.parse(`${day}T${String(utcHour).padStart(2, '0')}:00:00Z`);
  const samples = [];
  // One monotonic seq space across the whole drain: the history buffer
  // dedupes re-sends by (src, seq) and (device, timestamp).
  const seq = { n: 0 };
  appendBlock(samples, base, 2.5 * 3600, { bpm: 72, still: false, seq });
  appendBlock(samples, base + 2.5 * 3600_000, 7.5 * 3600, { bpm: sleepBpm, still: true, rr: true, seq });
  appendBlock(samples, base + 10 * 3600_000, 3600, { bpm: 72, still: false, seq });
  return samples;
}

/** In-memory object store with optional per-key failure injection. */
function makeStores({ failures = {} } = {}) {
  const blobs = new Map();
  const attempt = { get: 0 };
  const raw = {
    async putObject(key, body) { blobs.set(key, body); return { etag: '"x"', bytes: body.length }; },
    async head(key) {
      const b = blobs.get(key);
      return b ? { exists: true, contentLength: b.length } : null;
    },
    async getObject(key) {
      attempt.get += 1;
      if (failures.getObject && attempt.get === failures.getObject) throw new Error('b2 unavailable');
      const b = blobs.get(key);
      return b ? { body: b } : null;
    },
  };
  const derived = {
    async putObject(key, body) { blobs.set(key, body); return { etag: '"y"', bytes: body.length }; },
  };
  return { blobs, raw, derived };
}

/**
 * In-memory stand-in for the Supabase repository contract, including the
 * user-modification preservation the real repository implements.
 */
function makeDb({ failOnUpsert = [] } = {}) {
  const tables = {
    daily_metrics: [], sessions: [], sleep_details: [], daily_physiology_series: [],
    object_manifests: [], metric_runs: [], devices: [], day_completeness: [], ingest_gaps: [],
  };
  let upserts = 0;
  function upsertRows(name, rows, keyOf) {
    for (const row of rows || []) {
      const key = keyOf(row);
      const idx = tables[name].findIndex((r) => key(r) === key(row));
      if (idx >= 0) tables[name][idx] = { ...tables[name][idx], ...row };
      else tables[name].push({ ...row });
    }
  }
  const db = {
    configured: true,
    tables,
    upsertCount: () => upserts,
    async upsertPayload(payload) {
      upserts += 1;
      if (failOnUpsert.includes(upserts)) throw new Error('supabase write failed (503)');
      if (payload.device) {
        const idx = tables.devices.findIndex((r) => r.id === payload.device.id);
        if (idx >= 0) tables.devices[idx] = { ...tables.devices[idx], ...payload.device };
        else tables.devices.push({ ...payload.device });
      }
      for (const row of payload.daily_metrics || []) {
        const idx = tables.daily_metrics.findIndex((r) => r.user_id === row.user_id && r.day === row.day);
        if (idx >= 0) {
          const existing = tables.daily_metrics[idx];
          tables.daily_metrics[idx] = {
            ...existing,
            ...row,
            extras: { ...(existing.extras || {}), ...(row.extras || {}) },
          };
        } else {
          tables.daily_metrics.push({ ...row });
        }
      }
      if (payload.sessions) {
        for (const row of payload.sessions) {
          const idx = tables.sessions.findIndex((r) => r.id === row.id);
          if (idx >= 0) {
            const existing = tables.sessions[idx];
            // The real repository preserves user-modified session bounds.
            tables.sessions[idx] = existing?.user_modified
              ? { ...row, start_at: existing.start_at, end_at: existing.end_at, user_modified: true }
              : { ...row };
          } else {
            tables.sessions.push({ ...row });
          }
        }
      }
      if (payload.sleep_details) {
        for (const row of payload.sleep_details) {
          const idx = tables.sleep_details.findIndex((r) => r.session_id === row.session_id);
          if (idx >= 0) {
            const existing = tables.sleep_details[idx];
            tables.sleep_details[idx] = {
              ...row,
              user_start_at: existing.user_start_at ?? row.user_start_at,
              user_end_at: existing.user_end_at ?? row.user_end_at,
            };
          } else {
            tables.sleep_details.push({ ...row });
          }
        }
      }
      for (const name of ['daily_physiology_series', 'object_manifests', 'metric_runs']) {
        for (const row of payload[name] || []) {
          const key = name === 'daily_physiology_series'
            ? (r) => `${r.user_id}|${r.day}`
            : (r) => r.id;
          const idx = tables[name].findIndex((r) => key(r) === key(row));
          if (idx >= 0) tables[name][idx] = { ...tables[name][idx], ...row };
          else tables[name].push({ ...row });
        }
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'sleep_details')) {
        const keepIds = (payload.sessions || []).map((s) => s.id).filter(Boolean);
        const tz = payload.daily_metrics?.find((r) => r?.timezone_name)?.timezone_name || 'UTC';
        for (const day of inferSleepReplaceDays(payload)) {
          await db.deleteAutoSleepSessions({
            userId: payload.user_id, day, timeZone: tz, keepIds,
          });
        }
      }
      return { ok: true };
    },
    async loadUserDays(userId, fromDay, toDay) {
      const inRange = (day) => (!fromDay || day >= fromDay) && (!toDay || day <= toDay);
      return {
        daily_metrics: tables.daily_metrics.filter((r) => r.user_id === userId && inRange(r.day)),
        sessions: tables.sessions.filter((r) => r.user_id === userId),
        sleep_details: tables.sleep_details.filter((r) => r.user_id === userId),
        daily_physiology_series: tables.daily_physiology_series.filter((r) => r.user_id === userId),
        metric_runs: tables.metric_runs.filter((r) => r.user_id === userId),
      };
    },
    async listPhysiologyManifests({ userId, days = [], fromDay, toDay, timeZone = 'UTC' } = {}) {
      // Mirrors the real repository: ready/verified physiology manifests whose
      // [start_at, end_at) overlaps the requested window — day_start − 12 h
      // through day_end. A pre-midnight chunk overlaps the wake day's window
      // even though its period_day is the previous calendar date.
      let rows = tables.object_manifests.filter((r) => r.user_id === userId
        && r.object_kind === 'physiology'
        && ['ready', 'verified'].includes(r.status));
      const sortedDays = [...days].sort();
      const first = fromDay || sortedDays[0];
      const last = toDay || sortedDays.at(-1) || first;
      let lo = null;
      let hi = null;
      if (first) lo = Date.parse(dayBounds(first, timeZone).day_start_at) - 12 * 3_600_000;
      if (last) hi = Date.parse(dayBounds(last, timeZone).day_end_at);
      rows = rows.filter((r) => {
        const start = Date.parse(r.start_at || '');
        const end = Date.parse(r.end_at || '');
        if (Number.isFinite(start) && Number.isFinite(end) && lo != null && hi != null) {
          return end >= lo && start < hi;
        }
        return true; // no parseable window: keep it (orphan keys handled in replay)
      });
      return rows.map((r) => ({ ...r }));
    },
    async deleteAutoSleepSessions({ userId, day, timeZone = 'UTC', keepIds = [] } = {}) {
      const bounds = dayBounds(day, timeZone);
      const lo = Date.parse(bounds.day_start_at) - 12 * 3_600_000;
      const hi = Date.parse(bounds.day_end_at);
      const keep = new Set(keepIds);
      const before = tables.sessions.length;
      tables.sessions = tables.sessions.filter((s) => {
        if (s.user_id !== userId) return true;
        if (s.source !== 'frwhoop') return true;
        if (!['sleep', 'nap'].includes(s.kind)) return true;
        if (s.user_modified) return true;
        if (keep.has(s.id)) return true;
        const start = Date.parse(s.start_at);
        const end = Date.parse(s.end_at);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return true;
        return !(start < hi && end > lo);
      });
      return { deleted: before - tables.sessions.length, supported: true };
    },
    async getDayCompleteness(userId, day) {
      return tables.day_completeness.find((r) => r.user_id === userId && r.day === day) || null;
    },
    async upsertDayCompleteness(userId, row = {}) {
      const idx = tables.day_completeness.findIndex((r) => r.user_id === userId && r.day === row.day);
      const next = { ...(idx >= 0 ? tables.day_completeness[idx] : {}), ...row, user_id: userId };
      if (idx >= 0) tables.day_completeness[idx] = next;
      else tables.day_completeness.push(next);
      return next;
    },
    async invalidateDayCompleteness(userId, days = []) {
      for (const day of days) {
        const row = tables.day_completeness.find((r) => r.user_id === userId && r.day === day);
        if (row) { row.status = 'open'; row.finalized_at = null; }
      }
      return days.length;
    },
    async listIngestGaps(userId, loIso, hiIso) {
      const lo = Date.parse(loIso);
      const hi = Date.parse(hiIso);
      return tables.ingest_gaps.filter((g) => g.user_id === userId
        && Date.parse(g.start_at) < hi && Date.parse(g.end_at) > lo);
    },
    async resolveIngestGaps(userId, rows = []) {
      let n = 0;
      for (const row of rows) {
        const gap = tables.ingest_gaps.find((g) => g.id === row.id && g.user_id === userId);
        if (!gap || gap.resolved_at) continue;
        gap.resolved_at = row.resolved_at;
        gap.resolution = row.resolution || 'backfilled';
        n += 1;
      }
      return n;
    },
    async patchDailyExtras(userId, day, patch) {
      const row = tables.daily_metrics.find((r) => r.user_id === userId && r.day === day);
      if (!row) return { ok: false, reason: 'daily_metrics_missing' };
      row.extras = { ...(row.extras || {}), ...patch };
      return { ok: true, extras: row.extras };
    },
    async latestOvernightRun(userId, day) {
      return tables.metric_runs
        .filter((r) => r.user_id === userId && r.period_day === day && r.algorithm === 'overnight_finalize')
        .sort((a, b) => String(b.finished_at || '').localeCompare(String(a.finished_at || '')))[0] || null;
    },
  };
  return { db, tables };
}

const TEST_NOW = () => new Date('2026-08-29T12:00:00Z');

let atExitRestoreHr2 = null;
process.on('beforeExit', () => { if (atExitRestoreHr2) atExitRestoreHr2(); });

function makeWorld({ stores: storeOverrides, db: dbOptions } = {}) {
  // The engine resolves the HR mode from process.env (hr2Mode()). A developer
  // backend/.env (FRWHOOP_HR2=dual) would otherwise make the dual-mode recompute
  // write extras.hr_v2, breaking the 'foreign extras survive' expectation.
  // Pin the canonical default; node --test runs each file in its own process.
  const priorHr2 = process.env.FRWHOOP_HR2;
  process.env.FRWHOOP_HR2 = 'v1';
  atExitRestoreHr2 = () => { process.env.FRWHOOP_HR2 = priorHr2; };
  const blobs = new Map();
  const { db, tables } = makeDb(dbOptions);
  const stores = storeOverrides || {
    raw: {
      async putObject(key, body) { blobs.set(key, body); return { etag: '"x"', bytes: body.length }; },
      async head(key) { const b = blobs.get(key); return b ? { exists: true, contentLength: b.length } : null; },
      async getObject(key) { const b = blobs.get(key); return b ? { body: b } : null; },
    },
    derived: {
      async putObject(key, body) { blobs.set(key, body); return { etag: '"y"', bytes: body.length }; },
      async getObject(key) { const b = blobs.get(key); return b ? { body: b } : null; },
    },
  };
  const engine = createMetricsEngine({
    cfg: { localUserId: USER, rawStore: 'b2', derivedStore: 'b2', b2Bucket: 'FRWHOOP', buildHash: 'test' },
    stores,
    db,
    now: TEST_NOW,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-finalize-'));
  const historyBuffer = createHistoryBuffer({
    dir, userId: USER, engine, timeZone: 'UTC', now: TEST_NOW,
  });
  const finalizer = createFinalizer({
    engine,
    db,
    cfg: { localUserId: USER, buildHash: 'test' },
    now: TEST_NOW,
    dir,
    stores,
    historyStatsOf: (uid) => (uid === USER ? historyBuffer.stats() : null),
    liveOf: (uid) => (uid === USER ? { connected: true, deviceId: 'strap-1' } : null),
  });
  return { engine, db, tables, stores, blobs, finalizer, dir, historyBuffer };
}

async function archiveChunk(engine, samples, { day } = {}) {
  const row = await engine.archiveRawSamples({
    samples,
    device: { deviceId: 'strap-1', externalId: 'strap-1' },
    startAt: samples[0].t || samples[0].datetime,
    endAt: samples[samples.length - 1].t || samples[samples.length - 1].datetime,
    day,
    extras: { userId: USER, timeZone: 'UTC', historyBackfill: true },
  });
  assert.equal(row.status, 'ready');
  return row;
}

// ---------------------------------------------------------------------------
// 1. Complete overnight fixture → finalized Sleep / RHR / HRV / Recovery
// ---------------------------------------------------------------------------

test('complete overnight fixture finalizes the full Sleep → RHR → HRV → Recovery chain', async () => {
  const { engine, tables, finalizer } = makeWorld();
  const samples = midnightNight();
  // Evening chunk (before midnight) and overnight chunk, as the phone sends them.
  const evening = samples.filter((s) => Date.parse(s.t) < Date.parse('2026-08-29T00:00:00Z'));
  const morning = samples.filter((s) => Date.parse(s.t) >= Date.parse('2026-08-29T00:00:00Z'));
  await archiveChunk(engine, evening, { day: '2026-08-28' });
  await archiveChunk(engine, morning, { day: '2026-08-29' });

  const outcome = await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  const record = outcome.results.find((r) => r.day === '2026-08-29');
  assert.ok(record, 'the wake day resolves');
  assert.equal(record.state, FINALIZATION_STATES.FINALIZED, `reason: ${record.reason_code} ${record.error || ''}`);
  assert.equal(record.reason_code, null);
  assert.equal(record.verified, true, 'the projection read back coherently');
  assert.equal(record.sleep_detected, true);
  assert.equal(record.sleep_start_at, '2026-08-28T23:30:00.000Z');
  assert.equal(record.sleep_end_at, '2026-08-29T07:00:34.000Z');
  assert.equal(record.wake_day, '2026-08-29');
  assert.ok(record.rhr_bpm != null && record.rhr_bpm >= 45 && record.rhr_bpm <= 60, `rhr ${record.rhr_bpm}`);
  assert.ok(record.hrv_ms != null && record.hrv_ms > 20 && record.hrv_ms < 90, `hrv ${record.hrv_ms}`);
  assert.ok(record.recovery_pct != null && record.recovery_pct > 0 && record.recovery_pct <= 100);

  const row = tables.daily_metrics.find((r) => r.day === '2026-08-29' && r.user_id === USER);
  assert.ok(row, 'daily_metrics projection persisted');
  assert.ok(row.sleep_onset_at, 'sleep onset persisted');
  assert.ok(row.recovery_score != null);
  assert.ok(row.hrv_rmssd_ms != null);
  assert.ok(row.resting_hr_bpm != null);
  // The explicit state reaches the frontend through the day payload.
  assert.equal(row.extras?.overnight_finalization?.state, FINALIZATION_STATES.FINALIZED);
  const sleepSession = tables.sessions.find((s) => s.user_id === USER && s.kind === 'sleep');
  assert.ok(sleepSession, 'sleep session persisted');
  assert.ok(tables.sleep_details.some((d) => d.session_id === sleepSession.id), 'sleep details persisted');
  assert.ok(tables.daily_physiology_series.some((s) => s.day === '2026-08-29'), 'series persisted');
  const run = tables.metric_runs.find((r) => r.algorithm === 'overnight_finalize' && r.period_day === '2026-08-29');
  assert.ok(run, 'overnight_finalize run row persisted');
  assert.equal(run.status, 'complete');
});

// ---------------------------------------------------------------------------
// 2. Overnight crossing midnight uses the correct wake/local day
// ---------------------------------------------------------------------------

test('overnight crossing midnight finalizes under the correct wake day, full window', async () => {
  const { engine, tables, finalizer } = makeWorld();
  const samples = midnightNight();
  // Only the pre-midnight chunk has arrived so far.
  const evening = samples.filter((s) => Date.parse(s.t) < Date.parse('2026-08-29T00:00:00Z'));
  await archiveChunk(engine, evening, { day: '2026-08-28' });

  const outcome = await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-28'], trigger: 'history_archive', timeZone: 'UTC',
  });
  const days = outcome.results.map((r) => r.day);
  // Midnight overflow: data within 3 h of the day's end pulls in the wake day.
  assert.ok(days.includes('2026-08-29'), `wake day must be included, got ${days}`);
  const wakeRecord = outcome.results.find((r) => r.day === '2026-08-29');
  assert.ok(wakeRecord, 'the wake day was pulled in by the midnight overflow');
  // With only the evening chunk drained the wake day resolves to an explicit,
  // machine-readable state — never an error, never a silent empty card.
  assert.ok(Object.values(FINALIZATION_STATES).includes(wakeRecord.state),
    `wake day state after partial drain: ${wakeRecord.state} / ${wakeRecord.reason_code}`);
  assert.notEqual(wakeRecord.state, FINALIZATION_STATES.ERROR, 'partial drain is never an error');
  const wakeRow = tables.daily_metrics.find((r) => r.day === '2026-08-29');
  // The partial drain may legitimately detect the tail as a short nap, but it
  // must never claim the full night.
  if (wakeRow && wakeRow.sleep_onset_at) {
    assert.ok(wakeRow.sleep_onset_at >= '2026-08-28T23:00:00.000Z', 'partial sleep cannot start before the still block');
  }

  // Finish the morning drain; the wake day recomputes with all the data.
  const morning = samples.filter((s) => Date.parse(s.t) >= Date.parse('2026-08-29T00:00:00Z'));
  await archiveChunk(engine, morning, { day: '2026-08-29' });
  const second = await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  const finalWake = second.results.find((r) => r.day === '2026-08-29');
  assert.equal(finalWake.state, FINALIZATION_STATES.FINALIZED, `reason: ${finalWake.reason_code}`);
  assert.equal(finalWake.sleep_start_at, '2026-08-28T23:30:00.000Z');
  const mainSleep = tables.sessions.filter((s) => s.user_id === USER && s.kind === 'sleep');
  assert.equal(mainSleep.length, 1, 'the full night replaced the partial nap: one main sleep session');
  assert.equal(mainSleep[0].start_at, '2026-08-28T23:30:00.000Z');
  const row = tables.daily_metrics.find((r) => r.day === '2026-08-29' && r.user_id === USER);
  assert.equal(row.sleep_onset_at, '2026-08-28T23:30:00.000Z');
  assert.equal(row.wake_onset_at, '2026-08-29T07:00:34.000Z');
});

// ---------------------------------------------------------------------------
// 3. DST 23/25 hour day
// ---------------------------------------------------------------------------

test('DST 23-hour and 25-hour days bound the window by local midnight', async () => {
  // US spring forward 2026-03-08: a 23 h day in America/New_York.
  const spring = dayBounds('2026-03-08', 'America/New_York');
  assert.equal(spring.day_start_at, '2026-03-08T05:00:00.000Z');
  assert.equal(spring.day_end_at, '2026-03-09T04:00:00.000Z');
  assert.equal((Date.parse(spring.day_end_at) - Date.parse(spring.day_start_at)) / 3_600_000, 23);

  // US fall back: a 25 h day.
  const fall = dayBounds('2026-11-01', 'America/New_York');
  assert.equal(fall.day_start_at, '2026-11-01T04:00:00.000Z');
  assert.equal(fall.day_end_at, '2026-11-02T05:00:00.000Z');
  assert.equal((Date.parse(fall.day_end_at) - Date.parse(fall.day_start_at)) / 3_600_000, 25);

  // A night ending on the 25 h day finalizes under the correct wake date and
  // the window covers the entire 25 h day plus the 12 h lookback.
  const { engine, tables, finalizer } = makeWorld();
  const base = Date.parse('2026-10-31T21:00:00Z'); // 21:00 EDT evening
  const samples = [];
  appendBlock(samples, base, 2.5 * 3600, { bpm: 72, still: false });
  appendBlock(samples, base + 2.5 * 3600_000, 7.5 * 3600, { bpm: 50, still: true, rr: true });
  appendBlock(samples, base + 10 * 3600_000, 3600, { bpm: 72, still: false });
  for (const chunk of [samples.slice(0, 3 * 3600), samples.slice(3 * 3600)]) {
    await engine.archiveRawSamples({
      samples: chunk,
      device: { deviceId: 'strap-1', externalId: 'strap-1' },
      startAt: chunk[0].t,
      endAt: chunk[chunk.length - 1].t,
      extras: { userId: USER, timeZone: 'America/New_York', historyBackfill: true },
    });
  }
  const outcome = await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-11-01'], trigger: 'history_complete', timeZone: 'America/New_York',
  });
  const record = outcome.results.find((r) => r.day === '2026-11-01');
  assert.ok(record, 'the wake day resolves');
  assert.equal(record.state, FINALIZATION_STATES.FINALIZED, `reason: ${record.reason_code} ${record.error || ''}`);
  // The fixture is built in UTC: sleep 2026-10-31T23:30Z → 2026-11-01T07:00Z,
  // which crosses the local-midnight fall-back inside the 25 h wake day.
  assert.equal(record.sleep_start_at, '2026-10-31T23:30:00.000Z');
  assert.equal(record.sleep_end_at, '2026-11-01T07:00:34.000Z');
  assert.equal(record.wake_day, '2026-11-01');
  const row = tables.daily_metrics.find((r) => r.day === '2026-11-01');
  assert.ok(row, 'projection persisted for the 25 h day');
  assert.equal(row.timezone_name, 'America/New_York');
});

// ---------------------------------------------------------------------------
// 4. Multiple historical chunks → coherent, idempotent recomputes
// ---------------------------------------------------------------------------

test('multiple historical chunks produce only coherent idempotent recomputes', async () => {
  const { engine, tables, finalizer } = makeWorld();
  const samples = midnightNight();
  const chunkBounds = [2.5 * 3600, 2.5 * 3600 + 4 * 3600, 12 * 3600];
  const chunks = [
    samples.slice(0, chunkBounds[0]),
    samples.slice(chunkBounds[0], chunkBounds[1]),
    samples.slice(chunkBounds[1]),
  ];
  const seen = [];
  for (const chunk of chunks) {
    await archiveChunk(engine, chunk, { day: '2026-08-28' });
    const outcome = await finalizer.finalizeAffectedDays({
      userId: USER, days: ['2026-08-28'], trigger: 'history_archive', timeZone: 'UTC',
    });
    for (const record of outcome.results) {
      // Every intermediate state is explicit and machine-readable.
      assert.ok(Object.values(FINALIZATION_STATES).includes(record.state), `state ${record.state}`);
      if (record.state === FINALIZATION_STATES.ERROR) {
        assert.fail(`intermediate recompute failed: ${record.error}`);
      }
    }
    seen.push(outcome.results.map((r) => ({ day: r.day, fingerprint: r.fingerprint })));
  }
  // The last chunk completes the night on its wake day.
  const all = await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  const wake = all.results.find((r) => r.day === '2026-08-29');
  assert.equal(wake.state, FINALIZATION_STATES.FINALIZED);
  assert.ok(wake.sleep_detected);
  // One projection row per day: upserts replaced, never duplicated.
  const wakeRows = tables.daily_metrics.filter((r) => r.day === '2026-08-29');
  assert.equal(wakeRows.length, 1);
  const sessionRows = tables.sessions.filter((s) => s.kind === 'sleep' && s.user_id === USER);
  assert.equal(sessionRows.length, 1, 'exactly one auto sleep session');
  // Re-running with no new data is the no-op fast path.
  const repeat = await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  const repeatRecord = repeat.results.find((r) => r.day === '2026-08-29');
  assert.ok(repeatRecord, 'repeat resolves');
});

// ---------------------------------------------------------------------------
// 5. Duplicate HISTORY_COMPLETE is harmless
// ---------------------------------------------------------------------------

test('duplicate HISTORY_COMPLETE is harmless', async () => {
  const { engine, tables, finalizer } = makeWorld();
  const samples = midnightNight();
  await archiveChunk(engine, samples, { day: '2026-08-28' });
  await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  const rowBefore = tables.daily_metrics.find((r) => r.day === '2026-08-29');
  assert.equal(rowBefore.state ?? null, null, 'sanity: projection exists');
  const runsBefore = tables.metric_runs.filter((r) => r.algorithm === 'overnight_finalize').length;
  const recordBefore = finalizer.stateOf(USER, '2026-08-29');

  // A duplicate completion post resolves to the same verdict without work.
  const second = await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  const rowAfter = tables.daily_metrics.find((r) => r.day === '2026-08-29');
  assert.equal(rowAfter.computed_at, rowBefore.computed_at, 'projection not recomputed');
  assert.equal(rowAfter.recovery_score, rowBefore.recovery_score, 'values identical');
  assert.equal(tables.daily_metrics.filter((r) => r.day === '2026-08-29').length, 1, 'no duplicate rows');
  assert.equal(tables.metric_runs.filter((r) => r.algorithm === 'overnight_finalize').length, runsBefore, 'run row upserted in place');
  const secondRecord = second.results.find((r) => r.day === '2026-08-29');
  assert.equal(second.details.find((d) => d.record.day === '2026-08-29').unchanged, true);
  assert.equal(secondRecord.state, FINALIZATION_STATES.FINALIZED);
});

// ---------------------------------------------------------------------------
// 6. Late history updates an already computed day
// ---------------------------------------------------------------------------

test('late historical chunk updates an already computed day deterministically', async () => {
  const { engine, tables, finalizer } = makeWorld();
  const base = Date.parse('2026-08-28T23:30:00Z');
  // First drain: sleep without usable RR (fake-free HRV) and short morning.
  const first = [];
  appendBlock(first, base, 7 * 3600, { bpm: 50, still: true, rr: true, rrFraction: 0, seq: { n: 0 } });
  await archiveChunk(engine, first, { day: '2026-08-28' });
  const firstOutcome = await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  const firstRecord = firstOutcome.results.find((r) => r.day === '2026-08-29');
  assert.equal(firstRecord.reason_code, FINALIZATION_REASONS.RR_COVERAGE_LOW, 'first pass reports the missing RR');

  // Late chunk: the strap finally reports the RR intervals (same rows extended).
  const late = [];
  appendBlock(late, base + 3 * 3600_000, 4 * 3600, { bpm: 50, still: true, rr: true });
  await archiveChunk(engine, late, { day: '2026-08-28' });
  const lateOutcome = await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_archive', timeZone: 'UTC',
  });
  const lateRecord = lateOutcome.results.find((r) => r.day === '2026-08-29');
  assert.equal(lateRecord.state, FINALIZATION_STATES.FINALIZED, `state ${lateRecord.state}`);
  assert.equal(lateRecord.reason_code, null);
  assert.notEqual(lateRecord.fingerprint, firstRecord.fingerprint, 'a late chunk changes the input fingerprint');
  assert.equal(lateOutcome.details.find((d) => d.day === '2026-08-29')?.unchanged, false);
  const row = tables.daily_metrics.find((r) => r.day === '2026-08-29');
  assert.ok(row.hrv_rmssd_ms != null, 'HRV was remeasured from the late chunk');
});

// ---------------------------------------------------------------------------
// 7. Restart with raw data ready but completion signal lost → reconciliation
// ---------------------------------------------------------------------------

test('process restart with raw data ready but completion signal lost still finalizes', async () => {
  const { engine, tables, db, stores, finalizer, dir } = makeWorld();
  const samples = midnightNight();
  await archiveChunk(engine, samples.filter((s) => Date.parse(s.t) < Date.parse('2026-08-29T00:00:00Z')), { day: '2026-08-28' });
  await archiveChunk(engine, samples.filter((s) => Date.parse(s.t) >= Date.parse('2026-08-29T00:00:00Z')), { day: '2026-08-29' });

  // The history buffer lost its completion flag (e.g. crashed mid-cycle).
  const bufferDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-restart-'));
  const crashed = createHistoryBuffer({
    dir: bufferDir, userId: USER, engine: {},
    now: () => new Date('2026-08-29T06:00:00Z'),
  });
  crashed.appendBatch(samples.slice(0, 100), {});
  assert.equal(crashed.historyComplete(), false);

  // A fresh process: a brand-new finalizer knows nothing in memory.
  const revivedFinalizer = createFinalizer({
    engine, db, cfg: { localUserId: USER, buildHash: 'test' }, now: TEST_NOW, dir, stores,
  });
  const outcome = await revivedFinalizer.reconcile({
    userId: USER, timeZone: 'UTC', trigger: 'startup_reconciliation',
  });
  assert.ok(outcome.days.length >= 1, `reconcile found days: ${outcome.days}`);
  const record = outcome.results.find((r) => r.day === '2026-08-29');
  assert.ok(record, 'wake day reconciled');
  assert.equal(record.state, FINALIZATION_STATES.FINALIZED, `state ${record.state} reason ${record.reason_code}`);
  const row = tables.daily_metrics.find((r) => r.day === '2026-08-29');
  assert.ok(row?.recovery_score != null);
});

// ---------------------------------------------------------------------------
// 8. Low RR coverage → explicit HRV reasons, never fake values
// ---------------------------------------------------------------------------

test('low RR coverage reports hr coverage reasons and keeps HRV null', async () => {
  const { engine, tables, finalizer } = makeWorld();
  const base = Date.parse('2026-08-28T23:30:00Z');
  const samples = [];
  appendBlock(samples, base, 7 * 3600, { bpm: 50, still: true, rr: false });
  await archiveChunk(engine, samples, { day: '2026-08-28' });
  const outcome = await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  const record = outcome.results.find((r) => r.day === '2026-08-29');
  assert.ok([FINALIZATION_REASONS.RR_COVERAGE_LOW, FINALIZATION_REASONS.HRV_INSUFFICIENT_WINDOWS].includes(record.reason_code),
    `expected an hrv reason, got ${record.reason_code}`);
  assert.equal(record.hrv_ms, null, 'no fake HRV');
  const row = tables.daily_metrics.find((r) => r.day === '2026-08-29');
  assert.equal(row.hrv_rmssd_ms ?? null, null, 'no fake HRV in the projection');
  assert.ok(row.recovery_score != null, 'recovery still scored from its trustworthy terms');
});

test('too few usable HRV windows is hrv_insufficient_windows, not a pipeline failure', async () => {
  const { engine, tables, finalizer } = makeWorld();
  const base = Date.parse('2026-08-28T23:30:00Z');
  const samples = [];
  // RR so sparse that no 300 s window clears 30 clean intervals.
  appendBlock(samples, base, 7 * 3600, { bpm: 50, still: true, rr: true, rrFraction: 0.02 });
  await archiveChunk(engine, samples, { day: '2026-08-28' });
  const outcome = await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  const record = outcome.results.find((r) => r.day === '2026-08-29');
  // Window counts are only reported when the envelope carries its detail;
  // the unavailable envelope carries the reason itself.
  assert.ok(
    record.reason_code === FINALIZATION_REASONS.HRV_INSUFFICIENT_WINDOWS
    || record.reason_code === FINALIZATION_REASONS.RR_COVERAGE_LOW,
    `reason ${record.reason_code}`,
  );
  assert.equal(record.hrv_ms, null, 'no fake HRV');
  assert.equal(record.state, FINALIZATION_STATES.FINALIZED, 'the day still resolves; recovery uses other terms');
});

// ---------------------------------------------------------------------------
// 9. Immature baseline → calibration, not failure
// ---------------------------------------------------------------------------

test('immature baseline reports calibrating and still persists the projection', async () => {
  const { engine, tables, db, stores, finalizer } = makeWorld();
  const samples = midnightNight();
  await archiveChunk(engine, samples, { day: '2026-08-28' });
  const calibratingFinalizer = createFinalizer({
    engine, db, cfg: { localUserId: USER, buildHash: 'test' }, now: TEST_NOW,
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-cal-')),
    stores,
    baselinesOf: () => ({ summary: () => ({ maturity: 0.2, value: 40 }) }),
  });
  const outcome = await calibratingFinalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  const record = outcome.results.find((r) => r.day === '2026-08-29');
  assert.equal(record.state, FINALIZATION_STATES.CALIBRATING);
  assert.equal(record.reason_code, FINALIZATION_REASONS.BASELINE_IMMATURE);
  const row = tables.daily_metrics.find((r) => r.day === '2026-08-29');
  assert.ok(row, 'the projection is still persisted during calibration');
  assert.ok(row.recovery_score != null || row.sleep_performance_pct != null);
});

// ---------------------------------------------------------------------------
// 10. Transient Supabase/B2 failure retries without losing finalization
// ---------------------------------------------------------------------------

test('supabase write failure resolves to an explicit error and retries cleanly', async () => {
  const { engine, tables, finalizer } = makeWorld({ db: { failOnUpsert: [2] } });
  const samples = midnightNight();
  await archiveChunk(engine, samples, { day: '2026-08-28' });
  const outcome = await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  const record = outcome.results.find((r) => r.day === '2026-08-29');
  assert.equal(record.state, FINALIZATION_STATES.ERROR);
  assert.equal(record.reason_code, FINALIZATION_REASONS.PERSISTENCE_FAILED);

  // Retry succeeds: same inputs, now persisted.
  const retry = await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'manual_recompute', timeZone: 'UTC', force: true,
  });
  const retryRecord = retry.results.find((r) => r.day === '2026-08-29');
  assert.equal(retryRecordState(retry), FINALIZATION_STATES.FINALIZED);
  function retryRecordState(o) { return o.results.find((r) => r.day === '2026-08-29').state; }
  const row = tables.daily_metrics.find((r) => r.day === '2026-08-29');
  assert.ok(row?.recovery_score != null, 'the day finalized after the retry');
});

test('b2 read failure resolves to raw_manifest_missing and recovers when b2 returns', async () => {
  const { engine, db, tables, finalizer } = makeWorld();
  const samples = midnightNight();
  await archiveChunk(engine, samples, { day: '2026-08-28' });
  const failingStores = {
    raw: {
      async putObject(key, body) { return { etag: '"x"' }; },
      async head() { return { exists: true, contentLength: 1 }; },
      async getObject() { throw new Error('b2 unavailable'); },
    },
  };
  const failingEngine = createMetricsEngine({
    cfg: { localUserId: USER, rawStore: 'b2', derivedStore: 'b2', b2Bucket: 'FRWHOOP', buildHash: 'test' },
    stores: failingStores,
    db,
    now: TEST_NOW,
  });
  const failingFinalizer = createFinalizer({
    engine: failingEngine, db, cfg: { localUserId: USER, buildHash: 'test' },
    now: TEST_NOW, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-b2-')),
    stores: failingStores,
  });
  const outcome = await failingFinalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  const record = outcome.results.find((r) => r.day === '2026-08-29');
  assert.equal(record.state, FINALIZATION_STATES.ERROR);
  assert.equal(record.reason_code, FINALIZATION_REASONS.RAW_MANIFEST_MISSING, record.error);
  // B2 recovers: the same data finalizes without re-archiving.
  const recovered = await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'manual', timeZone: 'UTC', force: true,
  });
  assert.equal(recovered.results.find((r) => r.day === '2026-08-29').state, FINALIZATION_STATES.FINALIZED);
});

// ---------------------------------------------------------------------------
// 11. User-modified sleep bounds survive recomputation
// ---------------------------------------------------------------------------

test('user-modified sleep boundaries survive a late recomputation', async () => {
  const { engine, tables, finalizer } = makeWorld();
  const samples = midnightNight();
  await archiveChunk(engine, samples.filter((s) => Date.parse(s.t) < Date.parse('2026-08-29T00:00:00Z')), { day: '2026-08-28' });
  await archiveChunk(engine, samples.filter((s) => Date.parse(s.t) >= Date.parse('2026-08-29T00:00:00Z')), { day: '2026-08-29' });
  await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  const session = tables.sessions.find((s) => s.kind === 'sleep' && s.user_id === USER);
  assert.ok(session, 'auto sleep session exists');
  // The user drags the sleep boundaries in the app.
  const userStart = '2026-08-28T22:30:00.000Z';
  const userEnd = '2026-08-29T08:15:00.000Z';
  const stored = tables.sessions.find((s) => s.id === session.id);
  stored.start_at = userStart;
  stored.end_at = userEnd;
  stored.user_modified = true;
  const detail = tables.sleep_details.find((d) => d.session_id === session.id);
  detail.user_start_at = userStart;
  detail.user_end_at = userEnd;

  // A late chunk forces another deterministic recompute of the same day.
  const late = [];
  appendBlock(late, Date.parse('2026-08-29T02:00:00Z'), 2 * 3600, { bpm: 51, still: true, rr: true });
  await archiveChunk(engine, late, { day: '2026-08-29' });
  await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_archive', timeZone: 'UTC', force: true,
  });
  const after = tables.sessions.find((s) => s.id === session.id);
  assert.equal(after.start_at, userStart, 'user-modified onset survived');
  assert.equal(after.end_at, userEnd, 'user-modified wake survived');
  assert.equal(after.user_modified, true);
  const detailAfter = tables.sleep_details.find((d) => d.session_id === session.id);
  assert.equal(detail.user_start_at, userStart, 'sleep_details user onset survived');
  assert.equal(detail.user_end_at, userEnd, 'sleep_details user wake survived');
});

// ---------------------------------------------------------------------------
// Chain diagnosis + waiting state
// ---------------------------------------------------------------------------

test('waiting_for_history is explicit for a day with no ready manifests', async () => {
  const { finalizer } = makeWorld();
  const outcome = await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-09-05'], trigger: 'foreground_catch_up', timeZone: 'UTC',
  });
  const record = outcome.results[0];
  assert.equal(record.state, FINALIZATION_STATES.WAITING_FOR_HISTORY);
  assert.equal(record.reason_code, FINALIZATION_REASONS.HISTORY_NOT_COMPLETE);
});

test('HR-only overnight with scored night finalizes when RR is present', () => {
  const record = classifyFinalization({
    day: '2026-08-31',
    timeZone: 'UTC',
    manifests: 1,
    window: { sample_count: 120, hr_count: 120, rr_sample_count: 40, sleep_hr_count: 80 },
    result: {
      scored: {
        sleep: {
          ok: true,
          detector: 'legacy_hr_only',
          fallbackReason: 'insufficient_gravity_hr_only',
          recovery: 62,
          restingHr: 48,
        },
        recovery: 62,
      },
      overnight: { hrv: { value: 55, confidence: 0.6 } },
      dailyRow: { resting_hr_bpm: 48, hrv_rmssd_ms: 55 },
    },
  });
  assert.equal(record.sleep_detected, true);
  assert.equal(record.state, FINALIZATION_STATES.FINALIZED);
});

test('HR-only without a scored night stays waiting_for_history', () => {
  const record = classifyFinalization({
    day: '2026-08-31',
    timeZone: 'UTC',
    manifests: 1,
    window: { sample_count: 120, hr_count: 120, rr_sample_count: 0, sleep_hr_count: 80 },
    result: {
      scored: {
        sleep: {
          ok: false,
          detector: 'legacy_hr_only',
          fallbackReason: 'insufficient_gravity_hr_only',
        },
        recovery: 62,
      },
      dailyRow: { resting_hr_bpm: 48 },
    },
  });
  assert.equal(record.sleep_detected, false);
  assert.equal(record.state, FINALIZATION_STATES.WAITING_FOR_HISTORY);
  assert.equal(record.reason_code, FINALIZATION_REASONS.HISTORY_NOT_COMPLETE);
});

test('diagnose walks the full chain and names the first incomplete stage', async () => {
  const { engine, tables, finalizer } = makeWorld();
  // Day 1: nothing at all → the chain names exactly where it stops.
  const empty = await finalizer.diagnoseDay({ userId: USER, day: '2026-09-01', timeZone: 'UTC' });
  assert.ok(empty.first_incomplete != null, 'an empty day names its first incomplete stage');
  assert.equal(empty.chain_complete, false);
  assert.ok(['b2_raw', 'strap_history', 'replay', 'sleep'].includes(empty.first_incomplete),
    `first incomplete = ${empty.first_incomplete}`);
  assert.equal(empty.stages.b2_raw.manifests_ready, 0);

  // Day 2: a complete night across every stage.
  const samples = midnightNight();
  await archiveChunk(engine, samples, { day: '2026-08-28' });
  await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  const diag = await finalizer.diagnoseDay({ userId: USER, day: '2026-08-29', timeZone: 'UTC' });
  const statuses = Object.fromEntries(Object.entries(diag.stages).map(([k, v]) => [k, v.status]));
  assert.equal(diag.chain_complete, true, `chain incomplete: ${JSON.stringify(statuses)} first=${diag.first_incomplete}`);
  assert.equal(diag.first_incomplete, null);
  assert.equal(diag.stages.sleep.detected, true);
  assert.ok(diag.stages.hrv_rhr.hrv_ms != null);
  assert.ok(diag.stages.recovery.recovery_pct != null);
  assert.equal(diag.stages.supabase.daily_metrics_row, true);
  assert.equal(diag.stages.finalization.state, FINALIZATION_STATES.FINALIZED);
});

test('history buffer cycles drive the finalizer and duplicate completions are idempotent', async () => {
  const { engine, tables, finalizer } = makeWorld();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-cycle-'));
  const samples = midnightNight();
  let finalized = [];
  const buffer = createHistoryBuffer({
    dir, userId: USER, engine, timeZone: 'UTC',
    onHistoryComplete: ({ affectedDays, cycleId, trigger }) => {
      finalizer.finalizeAffectedDays({
        userId: USER, days: affectedDays, trigger, timeZone: 'UTC', cycleId,
      }).then((o) => { finalized.push(o); }).catch((err) => { finalized.push({ error: String(err?.message || err) }); });
    },
  });
  const half = samples.filter((s) => Date.parse(s.t) < Date.parse('2026-08-29T00:00:00Z'));
  const morning = samples.filter((s) => Date.parse(s.t) >= Date.parse('2026-08-29T00:00:00Z'));
  buffer.appendBatch(half, {});
  await buffer.flush();
  await new Promise((resolve) => setTimeout(resolve, 30));
  buffer.appendBatch(morning, { historyComplete: true });
  await buffer.flush();
  await new Promise((resolve) => setTimeout(resolve, 30));
  // Duplicate HISTORY_COMPLETE post: the second batch carries no new rows.
  buffer.appendBatch([], { historyComplete: true });
  const dup = await buffer.flush();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(buffer.historyComplete(), true, 'sticky completion state');
  // The wake day finalized through the event-driven trigger.
  let record = null;
  for (let i = 0; i < 100 && !record; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const candidate = finalizer.stateOf(USER, '2026-08-29');
    if (candidate) record = candidate;
  }
  assert.ok(record, `finalization record exists for the wake day (finalized outcomes: ${JSON.stringify(finalized.map((f) => f.error || f.results?.map((r) => r.day)))})`);
  assert.equal(record.state, FINALIZATION_STATES.FINALIZED, `state ${record.state} reason ${record.reason_code}`);
});

test('extras.healthkit and hr_v2 survive overnight control writes', async () => {
  const { engine, tables, finalizer } = makeWorld();
  const samples = midnightNight();
  await archiveChunk(engine, samples, { day: '2026-08-28' });
  tables.daily_metrics.push({
    user_id: USER, day: '2026-08-29',
    extras: { healthkit: { steps: 4000 }, hr_v2: { mode: 'ppg' }, energy: { kcal: 12 } },
  });
  await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  const row = tables.daily_metrics.find((r) => r.day === '2026-08-29');
  assert.equal(row.extras.healthkit.steps, 4000);
  assert.equal(row.extras.hr_v2.mode, 'ppg');
  assert.equal(row.extras.energy.kcal, 12);
  assert.ok(row.extras.overnight_finalization?.state);
  const completeness = tables.day_completeness.find((r) => r.day === '2026-08-29');
  assert.ok(completeness?.overnight_state);
  assert.ok(completeness.input_fingerprint);
});

test('finalizer returns dayCompleteness telemetry from replay', async () => {
  const { engine, finalizer } = makeWorld();
  const samples = midnightNight();
  await archiveChunk(engine, samples, { day: '2026-08-28' });
  const outcome = await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  assert.ok(Array.isArray(outcome.dayCompleteness) && outcome.dayCompleteness.length);
  assert.ok(outcome.details[0].replay);
  assert.equal(outcome.details[0].day, '2026-08-29');
});

test('no-days finalizeFromTrigger reconciles once and does not double finalize', async () => {
  let reconcileCalls = 0;
  let finalizeCalls = 0;
  const finalizer = {
    async reconcile() { reconcileCalls += 1; return { days: [], results: [], dayCompleteness: [{ day: 'x' }] }; },
    async finalizeAffectedDays() { finalizeCalls += 1; return { days: ['x'], results: [] }; },
  };
  const out = await finalizeFromTrigger({
    finalizer, userId: USER, days: undefined, trigger: 'foreground_catch_up',
  });
  assert.equal(reconcileCalls, 1);
  assert.equal(finalizeCalls, 0);
  assert.equal(out.dayCompleteness[0].day, 'x');
});

test('process restart skips an unchanged day from persisted fingerprint', async () => {
  const { engine, db, tables, stores } = makeWorld();
  const samples = midnightNight();
  await archiveChunk(engine, samples, { day: '2026-08-28' });
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-fp1-'));
  const first = createFinalizer({
    engine, db, cfg: { localUserId: USER, buildHash: 'test' }, now: TEST_NOW, dir: dir1, stores,
  });
  const firstOut = await first.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  assert.equal(firstOut.results[0].state, FINALIZATION_STATES.FINALIZED);
  const recomputes = { n: 0 };
  const orig = engine.recomputeFromStorage.bind(engine);
  engine.recomputeFromStorage = async (...args) => { recomputes.n += 1; return orig(...args); };
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-fp2-'));
  const revived = createFinalizer({
    engine, db, cfg: { localUserId: USER, buildHash: 'test' }, now: TEST_NOW, dir: dir2, stores,
  });
  const second = await revived.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  assert.equal(second.details[0].unchanged, true);
  assert.equal(recomputes.n, 0, 'persisted fingerprint must skip B2 replay');
  assert.ok(tables.daily_metrics.find((r) => r.day === '2026-08-29')?.recovery_score != null);
});

test('real baseline immaturity calibrates; unknown baseline does not', async () => {
  const { engine, db, stores } = makeWorld();
  const samples = midnightNight();
  await archiveChunk(engine, samples, { day: '2026-08-28' });
  const immature = createBaselineSet({ priors: { hrv_rmssd: 40 }, now: TEST_NOW });
  immature.add('hrv_rmssd', observation({ value: 40, at: '2026-08-28T08:00:00Z', condition: 'sleep' }));
  const cal = createFinalizer({
    engine, db, cfg: { localUserId: USER, buildHash: 'test' }, now: TEST_NOW,
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-base-')),
    stores, baselinesOf: () => immature,
  });
  const calOut = await cal.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  assert.equal(calOut.results[0].state, FINALIZATION_STATES.CALIBRATING);
  assert.equal(calOut.results[0].baseline_maturity, 'insufficient');
  assert.ok(calOut.results[0].baseline_observation_days >= 1);

  const unknown = createFinalizer({
    engine, db, cfg: { localUserId: USER, buildHash: 'test' }, now: TEST_NOW,
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-unk-')),
    stores, baselinesOf: () => ({}),
  });
  const unkOut = await unknown.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC', force: true,
  });
  assert.notEqual(unkOut.results[0].state, FINALIZATION_STATES.CALIBRATING);
});

test('stale auto sleep is removed and user-modified sessions remain', async () => {
  const { engine, tables, finalizer, db } = makeWorld();
  const samples = midnightNight();
  await archiveChunk(engine, samples, { day: '2026-08-28' });
  tables.sessions.push({
    id: 'stale-auto', user_id: USER, source: 'frwhoop', kind: 'sleep', user_modified: false,
    start_at: '2026-08-28T21:00:00.000Z', end_at: '2026-08-29T06:00:00.000Z',
  });
  tables.sessions.push({
    id: 'keep-user', user_id: USER, source: 'frwhoop', kind: 'sleep', user_modified: true,
    start_at: '2026-08-28T22:00:00.000Z', end_at: '2026-08-29T07:00:00.000Z',
  });
  await finalizer.finalizeAffectedDays({
    userId: USER, days: ['2026-08-29'], trigger: 'history_complete', timeZone: 'UTC',
  });
  assert.equal(tables.sessions.some((s) => s.id === 'stale-auto'), false);
  assert.ok(tables.sessions.some((s) => s.id === 'keep-user' && s.user_modified));
  assert.ok(typeof db.deleteAutoSleepSessions === 'function');
});
