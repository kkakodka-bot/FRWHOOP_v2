import fs from 'node:fs';
import path from 'node:path';
import { inferSleepReplaceDays } from '../metrics/repository.js';
import { logOvernightEvent } from '../observability/overnightLog.js';

/**
 * Durable cloud-sync outbox. Every write destined for Supabase is enqueued
 * here first and persisted to disk, so a restart, offline period, or Supabase
 * hiccup never loses data. Ops flush in order with exponential backoff and
 * merge intelligently (latest settings win, daily metric rows merge by day,
 * ingest payloads merge per table row).
 *
 * Settings are not queued here. The iPhone writes user_settings through
 * authenticated PostgREST. Leftover type:'settings' ops on disk are dropped.
 *
 * Op types:
 *   { type: 'integration.upsert', provider, row, userId }
 *   { type: 'integration.delete', provider, userId }
 *   { type: 'daily_metrics',      rows }     — backfill chunks, merged by day
 *   { type: 'ingest',             payload }  — engine upsertPayload shape
 */

const BACKOFF_MS = [2_000, 5_000, 15_000, 60_000, 5 * 60_000, 30 * 60_000];
const MAX_TELEMETRY = 200; // live_windows / metric_runs cap inside merged ingest ops

function backoffFor(attempts) {
  return BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1)];
}

export function httpStatusOf(err) {
  if (Number.isFinite(err?.status)) return Number(err.status);
  const match = String(err?.message || '').match(/\((\d{3})\)/);
  return match ? Number(match[1]) : null;
}

export function postgresCodeOf(err) {
  const raw = err?.body != null ? err.body : err?.message;
  const text = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? JSON.stringify(raw) : '');
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.code) return String(parsed.code);
  } catch { /* not JSON */ }
  const match = text.match(/\b(PGRST\d{3}|P\d{4}|23\d{3}|22\d{3}|42\d{3}|42501|21000)\b/);
  return match ? match[1] : null;
}

/**
 * Classify an ingest write failure. HTTP status alone is not enough: 409 is
 * unique (already written) vs FK (payload/writer) vs unknown (retry).
 *   retry       — network / 408 / 429 / 5xx / unknown
 *   block       — auth/config; stays pending with backoff
 *   dead_letter — contract/constraint; inspectable, redrivable, not auto-flushed
 *   success     — idempotent unique_violation (23505)
 */
export function classifyIngestError(err) {
  const status = httpStatusOf(err);
  const pgCode = postgresCodeOf(err);
  const network = err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT'
    || err?.code === 'ENOTFOUND' || err?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT';
  if (network) return { action: 'retry', status, pgCode };
  if (status === 408 || status === 429 || (status != null && status >= 500)) {
    return { action: 'retry', status, pgCode };
  }
  if (status === 401 || status === 403 || pgCode === '42501' || status === 404) {
    return { action: 'block', status, pgCode };
  }
  if (status === 409) {
    if (pgCode === '23505') return { action: 'success', status, pgCode };
    if (pgCode === '23503') return { action: 'dead_letter', status, pgCode };
    return { action: 'retry', status, pgCode };
  }
  if (pgCode === 'PGRST102' || pgCode === '21000' || pgCode === 'P0001'
    || pgCode === '23514' || pgCode === '22P02') {
    return { action: 'dead_letter', status, pgCode };
  }
  if (status >= 400 && status < 500) return { action: 'dead_letter', status, pgCode };
  return { action: 'retry', status, pgCode };
}

/** @deprecated use classifyIngestError; kept for existing tests. */
export function isPermanentClientError(err) {
  return classifyIngestError(err).action === 'dead_letter';
}

function opKey(op) {
  switch (op?.type) {
    case 'settings': return null;
    case 'profile': return `profile:${op.row?.id || op.userId || 'unknown'}`;
    case 'integration.upsert': return `integration:${op.userId || 'unknown'}:${op.provider}`;
    case 'integration.delete': return `integration:${op.userId || 'unknown'}:${op.provider}`;
    case 'daily_metrics': return `daily_metrics:${op.userId || op.rows?.[0]?.user_id || 'unknown'}`;
    case 'ingest': return `ingest:${op.payload?.user_id || 'unknown'}:${op.payload?.device?.id || 'unknown'}`;
    case 'events_upsert': return `events:${op.userId || op.rows?.[0]?.user_id || 'unknown'}`;
    case 'sessions_upsert': return `sessions:${op.userId || op.rows?.[0]?.user_id || 'unknown'}`;
    case 'measurements_upsert': return `measurements:${op.userId || op.rows?.[0]?.user_id || 'unknown'}`;
    case 'algorithm_result': return `algo:${op.row?.user_id || 'unknown'}:${op.row?.algorithm || 'x'}`;
    case 'coach_memory': return `coach_memory:${op.row?.user_id || 'unknown'}`;
    case 'coach_session': return `coach_session:${op.row?.user_id || 'unknown'}`;
    default: return null;
  }
}

function mergeBy(rows, keyOf) {
  const map = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    map.set(keyOf(row), row);
  }
  return [...map.values()];
}

/**
 * Engine day of a sleep/nap session row (sleep:<device>:<day>:<slot>) without
 * a timezone. Used by the merge to scope empty sleep replacements to the days
 * they actually recomputed.
 */
const SLEEP_EXTERNAL_ID_DAY_RE = /^sleep:[0-9a-fA-F-]+:(\d{4}-\d{2}-\d{2}):/;
function sleepReplacementDayOfSession(session) {
  const match = SLEEP_EXTERNAL_ID_DAY_RE.exec(String(session?.external_id || ''));
  return match ? match[1] : null;
}

/**
 * Merge one daily_metrics row pair by (user_id, day). Key-level merge: a later
 * partial row (e.g. a finalization-record correction carrying only `extras`)
 * must update its own keys without clobbering the computed projection columns
 * of the queued full row. b still wins per key, so a full recompute row
 * replaces a previous full row exactly as before.
 */
function mergeDailyMetricsRow(a, b) {
  if (!a) return b;
  if (!b) return a;
  const merged = { ...a, ...b };
  // Explicit nulls in b are deliberate clears (replay clears sleep columns);
  // undefined/absent keys keep a's value via the spread above.
  if (a.extras && b.extras) {
    merged.extras = { ...a.extras, ...b.extras };
  }
  if (a.confidence && b.confidence) merged.confidence = { ...a.confidence, ...b.confidence };
  if (a.provenance && b.provenance) merged.provenance = { ...a.provenance, ...b.provenance };
  return merged;
}

/** Merge two engine upsertPayloads; b wins on conflicts. */
export function mergeIngestPayloads(a = {}, b = {}) {
  const out = { ...a, ...b, user_id: b.user_id || a.user_id };
  out.device = b.device || a.device || undefined;
  const dailyRows = new Map();
  for (const row of [...(a.daily_metrics || []), ...(b.daily_metrics || [])]) {
    const key = `${row?.user_id || out.user_id || 'unknown'}|${row?.day || 'unknown'}`;
    dailyRows.set(key, mergeDailyMetricsRow(dailyRows.get(key), row));
  }
  out.daily_metrics = [...dailyRows.values()];
  out.sleep_nights = mergeBy([...(a.sleep_nights || []), ...(b.sleep_nights || [])], (r) => r.id);
  out.sessions = mergeBy([...(a.sessions || []), ...(b.sessions || [])], (r) => r.id);
  out.sensor_objects = mergeBy([...(a.sensor_objects || []), ...(b.sensor_objects || [])], (r) => r.id || r.object_key);
  out.object_manifests = mergeBy([...(a.object_manifests || []), ...(b.object_manifests || [])], (r) => r.id || r.object_key);
  out.derived_objects = mergeBy([...(a.derived_objects || []), ...(b.derived_objects || [])], (r) => r.id || r.object_key);
  const aHasSleep = Object.prototype.hasOwnProperty.call(a, 'sleep_details');
  const bHasSleep = Object.prototype.hasOwnProperty.call(b, 'sleep_details');
  if (bHasSleep && !(b.sleep_details || []).length) {
    // An empty replacement is SCOPED to the days b recomputed (its daily rows
    // and its sleep/nap sessions carry the engine day). Clearing the whole
    // accumulated array threw away OTHER days' queued projections whenever a
    // no-sleep replay merged into an op that still held them (production
    // 2026-08-30: days 24-25's details were erased from the outbox by the
    // day-29/30 replays and never landed).
    const clearedDays = new Set([
      ...((b.daily_metrics || []).map((r) => r?.day).filter(Boolean)),
      ...((b.sessions || [])
        .filter((s) => ['sleep', 'nap'].includes(s?.kind))
        .map((s) => sleepReplacementDayOfSession(s))
        .filter(Boolean)),
    ]);
    const sessionDay = new Map(
      [...(a.sessions || []), ...(b.sessions || [])]
        .filter((s) => s?.id)
        .map((s) => [s.id, sleepReplacementDayOfSession(s)]),
    );
    out.sleep_details = (a.sleep_details || []).filter((d) => {
      const day = sessionDay.get(d?.session_id);
      return !(day && clearedDays.has(day));
    });
    // The same scope governs sessions: a day whose recompute produced no
    // sleep must not keep re-writing the previous projection from this op.
    out.sessions = (out.sessions || []).filter((s) => {
      if (!['sleep', 'nap'].includes(s?.kind)) return true;
      const day = sleepReplacementDayOfSession(s);
      return !(day && clearedDays.has(day));
    });
    // The key stays PRESENT (possibly empty): it is the signal that drives
    // the per-day sleep replacement, so the cleared days still get their
    // explicit empty projection in the database.
    out.sleep_details = mergeBy(out.sleep_details, (r) => r.session_id || r.id);
  } else if (aHasSleep || bHasSleep) {
    out.sleep_details = mergeBy(
      [...(a.sleep_details || []), ...(b.sleep_details || [])],
      (r) => r.session_id || r.id,
    );
  } else {
    delete out.sleep_details;
  }
  // Ledger rows (workout_confirmed, haptic_*, workout_persisted, …) arrive one op at
  // a time inside the debounce window; without this they overwrite each other.
  out.events = mergeBy([...(a.events || []), ...(b.events || [])], (r) => r.id || JSON.stringify(r));
  out.measurements = mergeBy([...(a.measurements || []), ...(b.measurements || [])], (r) => r.id || JSON.stringify(r));
  out.physiology_buckets = mergeBy([...(a.physiology_buckets || []), ...(b.physiology_buckets || [])], (r) => `${r.user_id}|${r.bucket_start}|${r.bucket_minutes}`);
  out.daily_physiology_series = mergeBy([...(a.daily_physiology_series || []), ...(b.daily_physiology_series || [])], (r) => `${r.user_id}|${r.day}`);
  out.ingest_gaps = mergeBy([...(a.ingest_gaps || []), ...(b.ingest_gaps || [])], (r) => r.id || `${r.kind}|${r.start_at}`);
  out.live_windows = [...(a.live_windows || []), ...(b.live_windows || [])].slice(-MAX_TELEMETRY);
  out.metric_runs = [...(a.metric_runs || []), ...(b.metric_runs || [])].slice(-MAX_TELEMETRY);
  const replaceDays = [...new Set([...inferSleepReplaceDays(a), ...inferSleepReplaceDays(b)])];
  if (replaceDays.length) out.sleep_replace_days = replaceDays;
  else delete out.sleep_replace_days;
  const aDays = (a.daily_metrics || []).map((r) => r?.day).filter(Boolean).join(',');
  const bDays = (b.daily_metrics || []).map((r) => r?.day).filter(Boolean).join(',');
  if (aDays || bDays) {
    logOvernightEvent('outbox.merge', {
      user_id: out.user_id,
      from: aDays || 'none',
      to: bDays || 'none',
      affected_days: replaceDays.join(',') || 'none',
    });
  }
  return out;
}

function mergeOp(existing, incoming) {
  switch (incoming.type) {
    case 'settings':
      existing.settings = { ...(existing.settings || {}), ...(incoming.settings || {}) };
      existing.userId = incoming.userId || existing.userId;
      return existing;
    case 'profile':
      existing.row = incoming.row;
      return existing;
    case 'integration.upsert':
      existing.row = incoming.row;
      return existing;
    case 'daily_metrics':
      existing.rows = mergeBy([...(existing.rows || []), ...(incoming.rows || [])], (r) => r.day);
      return existing;
    case 'events_upsert':
    case 'sessions_upsert':
    case 'measurements_upsert':
      existing.rows = mergeBy([...(existing.rows || []), ...(incoming.rows || [])], (r) => r.id || JSON.stringify(r));
      return existing;
    case 'algorithm_result':
    case 'coach_memory':
    case 'coach_session':
      existing.row = incoming.row;
      return existing;
    case 'ingest':
      existing.payload = mergeIngestPayloads(existing.payload, incoming.payload);
      return existing;
    default:
      return existing;
  }
}

export function createSyncQueue({
  filePath,
  executor, // { configured(): boolean, exec(op): Promise<any> }
  modeOf = () => 'none',
  now = () => Date.now(),
  flushIntervalMs = 15_000,
  persist = true,
} = {}) {
  let pending = [];
  let currentFlush = null;
  let timer = null;
  let debounce = null;
  let seq = 0;
  const totals = { enqueued: 0, flushed: 0, failed: 0 };
  let lastOkAt = null;
  let lastError = null;

  function save() {
    if (!persist || !filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ pending, totals, lastOkAt, lastError }));
      fs.renameSync(tmp, filePath);
    } catch { /* disk hiccup: ops still in memory */ }
  }

  function load() {
    if (!persist || !filePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      pending = Array.isArray(raw.pending)
        ? raw.pending.filter((o) => o?.type && o.type !== 'settings')
          .map((o) => {
            const loaded = { ...o, __key: opKey(o) || o.__key, nextAt: 0 };
            if (loaded.type === 'ingest'
              && Object.prototype.hasOwnProperty.call(loaded.payload || {}, 'sleep_details')
              && !loaded.payload.sleep_details?.length
              && !loaded.payload.daily_metrics?.length
              && !loaded.payload.sessions?.length) {
              delete loaded.payload.sleep_details;
            }
            return loaded;
          })
        : [];
      Object.assign(totals, raw.totals || {});
      lastOkAt = raw.lastOkAt || null;
      lastError = raw.lastError || null;
      seq = pending.reduce((m, o) => Math.max(m, Number(o.seq) || 0), 0);
    } catch { /* first boot or corrupt file: start empty */ }
  }

  function enqueue(op) {
    const key = opKey(op);
    if (!key) return false;
    // A delete supersedes any pending upsert for the same provider.
    if (op.type === 'integration.delete') {
      pending = pending.filter((o) => !(o.type === 'integration.upsert' && o.provider === op.provider));
    }
    // A fresh upsert supersedes a pending delete for the same provider.
    if (op.type === 'integration.upsert') {
      pending = pending.filter((o) => !(o.type === 'integration.delete' && o.provider === op.provider));
    }
    const existing = pending.find((o) => o.__key === key);
    if (existing) {
      mergeOp(existing, op);
      // Bump the content revision so an in-flight execution cannot declare
      // this op written while the merged rows were never part of its writes.
      existing.rev = (existing.rev || 0) + 1;
      existing.attempts = 0;
      existing.nextAt = 0;
      // The dead-letter verdict applied to the op's PREVIOUS content. The
      // merge just replaced that content, so the merged op is a new op and
      // must get a fresh retry cycle — otherwise a writer bug's dead letters
      // swallow every later payload for the same key forever, even after the
      // writer is fixed.
      if (existing.deadLetter) {
        existing.deadLetter = false;
        existing.deadLetterReason = null;
      }
      existing.enqueuedAt = new Date(now()).toISOString();
    } else {
      pending.push({
        ...op,
        __key: key,
        seq: ++seq,
        attempts: 0,
        nextAt: 0,
        enqueuedAt: new Date(now()).toISOString(),
      });
    }
    totals.enqueued += 1;
    save();
    // Debounced immediate flush; the interval is the safety net.
    if (!debounce) {
      debounce = setTimeout(() => { debounce = null; flush().catch(() => {}); }, 250);
      if (debounce.unref) debounce.unref();
    }
    return true;
  }

  // Concurrent callers share the in-flight pass so `await flush()` always
  // means "everything due so far has been processed".
  async function flush() {
    if (currentFlush) return currentFlush;
    currentFlush = (async () => {
      let flushed = 0;
      if (!executor?.configured?.()) return { flushed: 0 };
      while (true) {
        const due = pending
          .filter((o) => !o.deadLetter && (o.nextAt || 0) <= now())
          .sort((a, b) => a.seq - b.seq)[0];
        if (!due) break;
        // Snapshot the content revision: an enqueue() that merges into THIS op
        // while it is executing replaces its payload with rows the execution
        // never saw. Removing the op on success would silently drop them.
        const execRev = due.rev || 0;
        try {
          await executor.exec(due);
          if ((due.rev || 0) !== execRev) {
            // Content merged mid-flight: keep the op so the next pass writes
            // the merged rows. Everything already written is idempotent.
            due.attempts = 0;
            due.nextAt = 0;
            save();
            continue;
          }
          pending = pending.filter((o) => o !== due);
          totals.flushed += 1;
          flushed += 1;
          lastOkAt = new Date(now()).toISOString();
          lastError = null;
        } catch (err) {
          const classified = classifyIngestError(err);
          const body = err?.body != null ? String(err.body) : String(err?.message || err);
          logOvernightEvent(classified.action === 'dead_letter' ? 'outbox.dead_letter' : 'outbox.retry', {
            user_id: due.payload?.user_id || due.userId,
            status: classified.status,
            retry_class: classified.action,
            pg_code: classified.pgCode,
            error: `${classified.action} ${classified.status || ''} ${classified.pgCode || ''}`.trim(),
            detail: due.__key,
            attempt: (due.attempts || 0) + 1,
          });
          console.error(
            `outbox ${due.type} ${due.__key || ''} failed`,
            classified.action,
            classified.status || '',
            classified.pgCode || '',
            body.slice(0, 500),
          );
          due.lastError = body.slice(0, 400);
          due.pgCode = classified.pgCode;
          due.retryClass = classified.action;
          totals.failed += 1;
          lastError = {
            at: new Date(now()).toISOString(),
            op: due.type,
            message: due.lastError,
            attempts: (due.attempts || 0) + 1,
            status: classified.status,
            pgCode: classified.pgCode,
            retryClass: classified.action,
          };
          if (classified.action === 'success') {
            pending = pending.filter((o) => o !== due);
            totals.flushed += 1;
            flushed += 1;
            lastOkAt = new Date(now()).toISOString();
            lastError = null;
            save();
            continue;
          }
          due.attempts = (due.attempts || 0) + 1;
          if (classified.action === 'dead_letter') {
            due.deadLetter = true;
            due.blocked = false;
            due.deadLetterReason = due.lastError;
            due.lastError = `dead_letter ${classified.status || ''} ${classified.pgCode || ''}: ${due.lastError}`.trim();
            due.nextAt = Number.MAX_SAFE_INTEGER;
            save();
            continue;
          }
          due.deadLetter = false;
          due.blocked = classified.action === 'block';
          due.nextAt = now() + backoffFor(due.attempts);
          save();
          continue;
        }
        save();
      }
      save();
      return { flushed };
    })();
    try {
      return await currentFlush;
    } finally {
      currentFlush = null;
    }
  }

  function status() {
    return {
      configured: Boolean(executor?.configured?.()),
      mode: modeOf(),
      pending: pending.filter((o) => !o.deadLetter).length,
      deadLetters: pending.filter((o) => o.deadLetter).length,
      pendingTypes: pending.filter((o) => !o.deadLetter).map((o) => o.type),
      pendingErrors: pending.filter((o) => o.lastError).map((o) => ({
        key: o.__key,
        type: o.type,
        attempts: o.attempts,
        nextAt: o.nextAt,
        error: o.lastError,
        deadLetter: Boolean(o.deadLetter),
        blocked: Boolean(o.blocked),
        pgCode: o.pgCode || null,
        retryClass: o.retryClass || null,
        days: (o.payload?.sleep_replace_days || o.payload?.daily_metrics || []).map((d) => d?.day || d).filter(Boolean),
      })),
      oldestPendingAt: pending[0]?.enqueuedAt || null,
      lastOkAt,
      lastError,
      totals: { ...totals },
    };
  }

  function redrive({ keys = null, reason = 'manual' } = {}) {
    const want = keys ? new Set(keys) : null;
    let n = 0;
    for (const op of pending) {
      if (want && !want.has(op.__key)) continue;
      if (!op.deadLetter && !op.blocked) continue;
      op.deadLetter = false;
      op.blocked = false;
      op.deadLetterReason = null;
      op.attempts = 0;
      op.nextAt = 0;
      n += 1;
    }
    if (n) {
      logOvernightEvent('outbox.redrive', {
        detail: reason,
        pending: n,
        user_id: pending[0]?.payload?.user_id || pending[0]?.userId,
      });
      save();
    }
    return { redriven: n };
  }

  function start() {
    load();
    redrive({ reason: 'startup' });
    if (!timer) {
      timer = setInterval(() => flush().catch(() => {}), flushIntervalMs);
      if (timer.unref) timer.unref();
    }
    flush().catch(() => {});
    return () => stop();
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (debounce) clearTimeout(debounce);
    timer = null;
    debounce = null;
    save();
  }

  return { enqueue, flush, status, start, stop, redrive, _pending: () => pending.slice() };
}
