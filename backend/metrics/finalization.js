/**
 * Overnight finalization state machine.
 *
 * One conceptual operation — `finalizeAffectedDays(user, affectedDays, trigger)`
 * — turns "raw physiology exists in B2" into "the wake day's Sleep → RHR → HRV →
 * Recovery projection is persisted and coherent", no matter which event asked
 * for it: a history chunk landing, HISTORY_COMPLETE, a restored BLE catch-up,
 * a morning foreground, or startup reconciliation. It is safe to run repeatedly:
 * every stage is the existing deterministic pipeline, and a day is only marked
 * finalized after the persisted projection is read back and confirmed.
 *
 * This module ORCHESTRATES; it never recomputes a metric. Sleep, RHR, HRV,
 * respiration, and recovery scoring stay in their modules. Missing physiology
 * stays null — the state machine records WHY a value is absent instead of
 * manufacturing one.
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dayBounds, localDateKey } from '../time/dayBoundary.js';
import { decodeArchive, decodeFieldCensus, ARCHIVE_SCHEMA_VERSION } from '../ingest/archiveFormat.js';
import { scoreDay, ALGORITHM_VERSION, isPersistableOvernight } from './sleep.js';
import { createOvernightProvider } from './overnight.js';
import { inc } from '../observability/metrics.js';
import { logOvernightEvent } from '../observability/overnightLog.js';
import { uuidFromParts } from '../storage/keys.js';
import { dedupeReplaySamples, correctReplayHistoricalClock, guardReplayWindowCoverage } from './engine.js';
import { getStores } from '../storage/stores.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(here, '../data/live');

/** Machine-readable finalization states. The UI reads these; never infer from an empty card. */
export const FINALIZATION_STATES = Object.freeze({
  WAITING_FOR_HISTORY: 'waiting_for_history',
  COMPUTING: 'computing',
  FINALIZED: 'finalized',
  CALIBRATING: 'calibrating',
  INSUFFICIENT_DATA: 'insufficient_data',
  ERROR: 'error',
});

/** Terminal reason codes. `null` means the day resolved cleanly. */
export const FINALIZATION_REASONS = Object.freeze({
  NO_SLEEP_WINDOW: 'no_sleep_window',
  HR_COVERAGE_LOW: 'hr_coverage_low',
  RR_COVERAGE_LOW: 'rr_coverage_low',
  HRV_INSUFFICIENT_WINDOWS: 'hrv_insufficient_windows',
  BASELINE_IMMATURE: 'baseline_immature',
  HISTORY_NOT_COMPLETE: 'history_not_complete',
  RAW_MANIFEST_MISSING: 'raw_manifest_missing',
  RECOMPUTE_FAILED: 'recompute_failed',
  PERSISTENCE_FAILED: 'persistence_failed',
});

/** Baseline maturity below this (when a baseline set is engaged) is calibration, not failure. */
export const BASELINE_MATURE_FRACTION = 0.6;
/** A night scored within this window before local midnight probably continues into the next wake day. */
export const MIDNIGHT_OVERFLOW_WINDOW_MS = 3 * 3_600_000;

export function safeUserId(userId) {
  return String(userId || 'local').replace(/[^a-zA-Z0-9_-]/g, '') || 'local';
}

/** Cheap identity of the raw-manifest set for one day. */
export function manifestFingerprint(manifestIds = [], day = null, timeZone = 'UTC') {
  return createHash('sha256').update(JSON.stringify({
    d: day, z: timeZone, m: [...manifestIds].sort(),
  })).digest('hex').slice(0, 24);
}

/** Stable identity of the exact inputs a day was last finalized from. */
export function dayFingerprint({
  manifestIds = [],
  sampleCount = 0,
  latestSensorAt = null,
  algorithmVersion = ALGORITHM_VERSION,
  timeZone = 'UTC',
  day = null,
}) {
  return createHash('sha256').update(JSON.stringify({
    d: day,
    m: [...manifestIds].sort(),
    n: sampleCount,
    t: latestSensorAt,
    a: algorithmVersion,
    z: timeZone,
  })).digest('hex').slice(0, 24);
}

/**
 * Map one deterministic day result onto the explicit finalization state.
 *
 * Pure: same inputs always produce the same verdict, so a replayed archive
 * reproduces the same classification. Precedence: transport/manifest gaps →
 * data sufficiency → compute errors → quality notes (calibration, weak HRV).
 */
export function classifyFinalization({
  day,
  timeZone = 'UTC',
  manifests = 0,
  window = null,
  result = null,
  error = null,
  persistError = null,
  baselines = null,
} = {}) {
  const bounds = dayBounds(day, timeZone);
  const emptyStats = {
    sample_count: 0, hr_count: 0, rr_sample_count: 0, latest_sensor_at: null,
    sleep_hr_count: null, manifest_ids: [], decoded: 0, deduplicated: 0,
  };
  const stats = { ...emptyStats, ...(window || {}) };
  const record = {
    day,
    wake_day: day,
    state: FINALIZATION_STATES.INSUFFICIENT_DATA,
    reason_code: null,
    manifests: manifests ?? 0,
    timeZone,
    sample_count: stats.sample_count,
    hr_count: stats.hr_count,
    rr_sample_count: stats.rr_sample_count,
    latest_sensor_at: stats.latest_sensor_at,
    sleep_hr_count: stats.sleep_hr_count,
    manifest_ids: stats.manifest_ids,
    decoded: stats.decoded,
    deduplicated: stats.deduplicated,
    sleep_detected: false,
    sleep_start_at: null,
    sleep_end_at: null,
    sleep_detector: null,
    fallback_reason: null,
    rhr_bpm: null,
    hrv_ms: null,
    recovery_pct: null,
    hrv_withheld_confidence: null,
    rr_windows_total: null,
    rr_windows_used: null,
    rr_artifact_fraction: null,
    gravity_coverage: null,
    baseline_maturity: null,
    algorithm_version: ALGORITHM_VERSION,
  };

  // ---- transport / manifest layer ----
  if (error) {
    record.state = FINALIZATION_STATES.ERROR;
    const message = String(error?.message || error);
    record.reason_code = /manifest|raw_object|decode|storage|b2|s3|object|unavailable|fetch|network/i.test(message)
      ? FINALIZATION_REASONS.RAW_MANIFEST_MISSING
      : (/supabase|write failed|upsert|persistence|readback|503|timeout/i.test(message)
        ? FINALIZATION_REASONS.PERSISTENCE_FAILED
        : FINALIZATION_REASONS.RECOMPUTE_FAILED);
    record.error = String(error?.message || error).slice(0, 200);
    return record;
  }
  if (!manifests) {
    record.state = FINALIZATION_STATES.WAITING_FOR_HISTORY;
    record.reason_code = FINALIZATION_REASONS.HISTORY_NOT_COMPLETE;
    return record;
  }
  if (!stats.sample_count) {
    record.state = FINALIZATION_STATES.INSUFFICIENT_DATA;
    record.reason_code = FINALIZATION_REASONS.RAW_MANIFEST_MISSING;
    return record;
  }

  // ---- compute layer ----
  if (!result) {
    record.state = FINALIZATION_STATES.ERROR;
    record.reason_code = FINALIZATION_REASONS.RECOMPUTE_FAILED;
    return record;
  }
  if (persistError) {
    record.state = FINALIZATION_STATES.ERROR;
    record.reason_code = FINALIZATION_REASONS.PERSISTENCE_FAILED;
    record.error = String(persistError?.message || persistError).slice(0, 200);
    return record;
  }
  const scored = result.scored || {};
  const night = scored.sleep || null;
  const persistable = Boolean(result.sleepRow) || Boolean(isPersistableOvernight(night));
  const overnightSummary = result.overnight || null;
  // provider.summary() shape: { hrv: envelopeSummary, respiration: …, withheld }.
  const hrvEnvelope = overnightSummary?.hrv || null;

  record.sleep_detected = Boolean(result.sleepRow) || Boolean(persistable && night?.ok);
  record.fallback_reason = night?.fallbackReason || null;
  record.sleep_detector = night?.detector || null;
  record.sleep_start_at = result.sleepRow?.start_at || night?.onsetIso || null;
  record.sleep_end_at = result.sleepRow?.end_at || night?.wakeIso || null;
  record.rhr_bpm = result.dailyRow?.resting_hr_bpm ?? scored.restingHr ?? null;
  record.hrv_ms = overnightSummary?.hrv?.value ?? null;
  record.recovery_pct = scored.recovery ?? null;
  record.rr_windows_total = overnightSummary?.hrv?.detail?.windowsTotal ?? null;
  record.rr_windows_used = overnightSummary?.hrv?.detail?.windowsUsed ?? null;
  record.rr_artifact_fraction = hrvEnvelope?.detail?.artifactFraction ?? null;
  record.gravity_coverage = night?.gravityCoverage ?? null;
  record.hrv_withheld_confidence = overnightSummary?.withheld?.hrv ?? null;
  record.wake_day = localDateKey(record.sleep_end_at || bounds.day_end_at, timeZone) || day;
  const baselineSummary = baselines?.summary
    ? baselines.summary('hrv_rmssd', { condition: 'sleep' })
    : null;
  record.baseline_maturity = baselineSummary?.maturity ?? null;
  record.baseline_observation_days = baselineSummary?.observationDays ?? null;
  if (!(record.baseline_observation_days > 0)) {
    try {
      const listed = typeof baselines?.store === 'function'
        ? baselines.store('hrv_rmssd').rows()
        : (typeof baselines?.rows === 'function' ? baselines.rows() : []);
      const days = new Set(listed.map((r) => String(r.at || '').slice(0, 10)).filter((d) => d.length === 10));
      if (days.size) record.baseline_observation_days = days.size;
    } catch { /* diagnostics only */ }
  }

  // ---- data sufficiency ----
  const hrvBlockedNoRr = hrvEnvelope
    && hrvEnvelope.value == null
    && /no RR intervals/i.test(String(hrvEnvelope.reason || ''));
  const hrvWindowsInsufficient = hrvEnvelope
    && hrvEnvelope.value == null
    && !hrvBlockedNoRr
    && String(hrvEnvelope.status || '') !== 'OK';
  // Measured but too thinly windowed to trust (withheld from recovery): the
  // explanation is the same insufficient-window coverage.
  const hrvWithheldThinWindows = hrvEnvelope
    && hrvEnvelope.value != null
    && Number(hrvEnvelope.confidence ?? 1) < 0.4
    && record.rr_windows_used != null
    && record.rr_windows_used < 3;

  if (!record.sleep_detected) {
    // Live HR-only without a scored night stays open for IMU/gravity history.
    const hrOnly = night?.detector === 'legacy_hr_only'
      || night?.fallbackReason === 'insufficient_gravity_hr_only';
    if (hrOnly && !night?.ok) {
      record.reason_code = FINALIZATION_REASONS.HISTORY_NOT_COMPLETE;
      record.state = FINALIZATION_STATES.WAITING_FOR_HISTORY;
      return record;
    }
    record.reason_code = record.recovery_pct != null
      ? FINALIZATION_REASONS.NO_SLEEP_WINDOW
      : (stats.sleep_hr_count === 0 || stats.hr_count === 0
        ? FINALIZATION_REASONS.HR_COVERAGE_LOW
        : FINALIZATION_REASONS.NO_SLEEP_WINDOW);
    record.state = record.recovery_pct != null
      ? FINALIZATION_STATES.FINALIZED
      : FINALIZATION_STATES.INSUFFICIENT_DATA;
    return record;
  }

  // Sleep detected. Calibration only when a real baseline result is immature.
  if (isImmatureBaseline(baselines)) {
    record.state = FINALIZATION_STATES.CALIBRATING;
    record.reason_code = FINALIZATION_REASONS.BASELINE_IMMATURE;
    return record;
  }
  if (stats.sleep_hr_count != null && stats.sleep_hr_count === 0) {
    record.reason_code = FINALIZATION_REASONS.HR_COVERAGE_LOW;
    record.state = FINALIZATION_STATES.INSUFFICIENT_DATA;
    return record;
  }
  if (hrvBlockedNoRr || hrvWindowsInsufficient || hrvWithheldThinWindows) {
    // HRV was not measured (or had too few usable windows). The pipeline
    // already withheld it from recovery; record exactly why instead of faking.
    record.reason_code = hrvBlockedNoRr
      ? FINALIZATION_REASONS.RR_COVERAGE_LOW
      : FINALIZATION_REASONS.HRV_INSUFFICIENT_WINDOWS;
    record.state = record.recovery_pct != null
      ? FINALIZATION_STATES.FINALIZED
      : FINALIZATION_STATES.INSUFFICIENT_DATA;
    return record;
  }
  record.state = FINALIZATION_STATES.FINALIZED;
  record.reason_code = null;
  return record;
}

/**
 * Terminal overnight states (pending clears). Continuity status stays separate.
 */
export const TERMINAL_OVERNIGHT_STATES = Object.freeze([
  FINALIZATION_STATES.FINALIZED,
  FINALIZATION_STATES.CALIBRATING,
  FINALIZATION_STATES.INSUFFICIENT_DATA,
]);

export function isImmatureBaseline(baselines) {
  if (!baselines || typeof baselines.summary !== 'function') return false;
  let summary = null;
  try { summary = baselines.summary('hrv_rmssd', { condition: 'sleep' }); } catch { return false; }
  if (!summary || summary.maturity == null || summary.maturity === '') return false;
  const maturity = summary.maturity;
  if (maturity === 'insufficient' || maturity === 'low') return true;
  if (typeof maturity === 'number' && Number.isFinite(maturity)) return maturity < BASELINE_MATURE_FRACTION;
  return false;
}

export function wrapFinalizeOutcome({ day, record, unchanged, replay = null }) {
  return {
    day,
    record,
    unchanged: Boolean(unchanged),
    replay: {
      dayCompleteness: replay?.dayCompleteness || [],
      metricRun: replay?.metricRun || null,
      inputManifestIds: record?.input_object_ids || replay?.inputManifestIds || [],
    },
  };
}

/**
 * Morning / no-days trigger: reconcile IS the finalization. Do not run
 * finalizeAffectedDays a second time afterward.
 */
export async function finalizeFromTrigger({
  finalizer,
  userId,
  days,
  timeZone = 'UTC',
  device = null,
  trigger = 'foreground_catch_up',
  flushHistory = null,
} = {}) {
  const flushed = typeof flushHistory === 'function' ? await flushHistory() : null;
  const extra = { flushed: flushed?.flushed || 0, cycle_id: flushed?.cycleId || null };
  if (!Array.isArray(days) || !days.length) {
    const reconciliation = await finalizer.reconcile({ userId, timeZone, device, trigger });
    return { ok: true, ...reconciliation, ...extra };
  }
  const outcome = await finalizer.finalizeAffectedDays({
    userId, days, trigger, timeZone, device,
  });
  return { ok: true, ...outcome, ...extra };
}

/**
 * A day whose newest data sits within `MIDNIGHT_OVERFLOW_WINDOW_MS` of local
 * midnight (or beyond it) continues into the next local wake day; that day
 * must be finalized too, with the full day_start − 12 h → day_end window.
 */
export function overflowWakeDay({ day, timeZone, latestSensorAt = null, sleepEndAt = null }) {
  const bounds = dayBounds(day, timeZone);
  const endMs = Date.parse(bounds.day_end_at);
  const candidates = [latestSensorAt, sleepEndAt]
    .map((iso) => Date.parse(iso))
    .filter((ms) => Number.isFinite(ms));
  if (!candidates.length) return null;
  const newest = Math.max(...candidates);
  if (newest > endMs) return localDateKey(new Date(newest), timeZone);
  if (endMs - newest <= MIDNIGHT_OVERFLOW_WINDOW_MS) {
    return localDateKey(new Date(endMs + 1), timeZone);
  }
  return null;
}

export function createFinalizer({
  engine,
  db = null,
  cfg = {},
  now = () => new Date(),
  uuid = randomUUID,
  flushOutbox = null,
  dir = DEFAULT_DIR,
  stores = null,
  historyStatsOf = null,
  liveOf = null,
  baselinesOf = null,
} = {}) {
  const chains = new Map(); // userId -> promise tail
  const dayLocks = new Map(); // `${userId}|${day}` -> promise tail
  const states = new Map(); // `${userId}|${day}` -> durable record

  function chainFor(userId, run) {
    const key = userId || 'local';
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.then(run, run);
    chains.set(key, next.catch(() => {}));
    return next;
  }

  function withDayLock(userId, day, run) {
    const key = `${userId}|${day}`;
    const prev = dayLocks.get(key) || Promise.resolve();
    const next = prev.then(run, run);
    dayLocks.set(key, next.catch(() => {}));
    return next;
  }

  function stateFile(userId) {
    return path.join(dir, safeUserId(userId), 'finalization-state.json');
  }

  function loadLocalState(userId) {
    const days = {};
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile(userId), 'utf8'));
      for (const [day, record] of Object.entries(raw?.days || {})) {
        states.set(`${userId}|${day}`, record);
        days[day] = record;
      }
      return days;
    } catch { return {}; }
  }

  function persistLocalState(userId, day, record) {
    states.set(`${userId}|${day}`, record);
    try {
      const file = stateFile(userId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let previous = {};
      try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first write */ }
      const days = { ...(previous.days || {}), [day]: record };
      const trimmed = Object.entries(days)
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .slice(0, 30);
      const body = { days: Object.fromEntries(trimmed), updated_at: now().toISOString() };
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(body));
      fs.renameSync(tmp, file);
    } catch { /* local mirror is advisory; the remote projection stays authoritative */ }
  }

  async function readBack({ userId, day, result }) {
    if (!db || typeof db.loadUserDays !== 'function') return { ok: null, detail: 'readback_unavailable' };
    try {
      const payload = await db.loadUserDays(userId, day, day);
      const row = (payload?.daily_metrics || []).find((r) => r?.day === day) || null;
      if (!row) return { ok: false, detail: 'daily_metrics_missing' };
      const wantedAt = result?.dailyRow?.computed_at || null;
      // A NEWER computed_at is still a coherent projection (a concurrent
      // deterministic recompute won the race). Only an OLDER one is stale.
      if (wantedAt && row.computed_at
        && Date.parse(row.computed_at) < Date.parse(wantedAt)) {
        return { ok: false, detail: 'daily_metrics_stale' };
      }
      const missing = [];
      if (result?.sleepRow) {
        if (!(payload?.sessions || []).some((s) => s?.id === result.sleepRow.id)) missing.push('session');
        if (!(payload?.sleep_details || []).some((d) => d?.session_id === result.sleepRow.id)) missing.push('sleep_details');
      }
      if (missing.length) return { ok: false, detail: `missing:${missing.join('+')}` };
      return { ok: true, detail: 'coherent' };
    } catch (error) {
      return { ok: false, detail: `readback_error:${String(error?.message || error).slice(0, 120)}` };
    }
  }

  async function readyManifestFingerprint(userId, day, timeZone) {
    const manifestsNow = db && typeof db.listPhysiologyManifests === 'function'
      ? await db.listPhysiologyManifests({ userId, days: [day], timeZone })
      : [];
    const readyIds = (manifestsNow || [])
      .filter((m) => m?.object_key && m.object_kind === 'physiology'
        && ['ready', 'verified'].includes(m.status || 'ready'))
      .map((m) => m.id).filter(Boolean).sort();
    return {
      fingerprint: manifestFingerprint(readyIds, day, timeZone),
      ids: readyIds,
    };
  }

  async function persistedOvernight(userId, day) {
    const completeness = typeof db?.getDayCompleteness === 'function'
      ? await db.getDayCompleteness(userId, day) : null;
    if (completeness?.input_fingerprint || completeness?.overnight_state) {
      return {
        fingerprint: completeness.input_fingerprint || null,
        state: completeness.overnight_state || null,
        reason: completeness.overnight_reason || null,
        record: completeness.result?.overnight || states.get(`${userId}|${day}`) || null,
        completeness,
      };
    }
    const run = typeof db?.latestOvernightRun === 'function'
      ? await db.latestOvernightRun(userId, day) : null;
    const quality = run?.quality || {};
    if (quality.manifest_fingerprint || quality.fingerprint) {
      return {
        fingerprint: quality.manifest_fingerprint || quality.fingerprint,
        state: quality.state || null,
        reason: quality.reason_code || null,
        record: run?.output_refs?.finalization || states.get(`${userId}|${day}`) || null,
        completeness: null,
      };
    }
    const local = states.get(`${userId}|${day}`);
    if (local?.manifest_fingerprint) {
      return {
        fingerprint: local.manifest_fingerprint,
        state: local.state,
        reason: local.reason_code,
        record: local,
        completeness: null,
      };
    }
    return null;
  }

  async function persistOvernightControl({ userId, day, timeZone, record, trigger }) {
    if (typeof db?.upsertDayCompleteness !== 'function') return null;
    const existing = typeof db.getDayCompleteness === 'function'
      ? await db.getDayCompleteness(userId, day) : null;
    const result = {
      ...(existing?.result && typeof existing.result === 'object' ? existing.result : {}),
      overnight: record,
    };
    const terminal = TERMINAL_OVERNIGHT_STATES.includes(record.state);
    return db.upsertDayCompleteness(userId, {
      day,
      timezone_name: timeZone,
      result,
      overnight_state: record.state,
      overnight_reason: record.reason_code,
      input_fingerprint: record.manifest_fingerprint || record.fingerprint,
      last_trigger: trigger,
      last_attempt_at: now().toISOString(),
      overnight_finalized_at: terminal ? now().toISOString() : null,
    });
  }

  function skippableOvernight(prior) {
    if (!prior?.fingerprint && !prior?.record?.manifest_fingerprint) return false;
    const state = prior.state || prior.record?.state;
    const reason = prior.reason || prior.record?.reason_code;
    const STABLE_INSUFFICIENT = new Set([
      FINALIZATION_REASONS.NO_SLEEP_WINDOW,
      FINALIZATION_REASONS.HR_COVERAGE_LOW,
      FINALIZATION_REASONS.RR_COVERAGE_LOW,
      FINALIZATION_REASONS.HRV_INSUFFICIENT_WINDOWS,
    ]);
    return state === FINALIZATION_STATES.FINALIZED
      || state === FINALIZATION_STATES.CALIBRATING
      || (state === FINALIZATION_STATES.INSUFFICIENT_DATA && STABLE_INSUFFICIENT.has(reason));
  }

  /** Resolve one local wake day to an explicit state. Never throws. */
  async function finalizeOneDay({ userId, day, trigger, timeZone, device, cycleId, force }) {
    const t0 = Date.now();
    const prior0 = states.get(`${userId}|${day}`);
    const persisted = !force ? await persistedOvernight(userId, day) : null;
    if (!force && skippableOvernight(persisted || { record: prior0, fingerprint: prior0?.manifest_fingerprint, state: prior0?.state, reason: prior0?.reason_code })) {
      try {
        const stored = persisted?.record || prior0;
        if (stored?.algorithm_version && stored.algorithm_version !== ALGORITHM_VERSION) {
          throw new Error('algorithm_version_changed');
        }
        const ready = await readyManifestFingerprint(userId, day, timeZone);
        const priorFp = persisted?.fingerprint || stored?.manifest_fingerprint;
        if (priorFp && ready.fingerprint === priorFp) {
          if ((persisted?.state || stored?.state) === FINALIZATION_STATES.FINALIZED && db?.loadUserDays) {
            const payload = await db.loadUserDays(userId, day, day);
            const rowExists = (payload?.daily_metrics || []).some((r) => r?.day === day);
            if (!rowExists) throw new Error('projection_deleted');
          }
          const record = { ...stored };
          logOvernightEvent('overnight.finalized', {
            user_id: userId, day, trigger, state: record.state,
            fingerprint: record.fingerprint, detail: 'unchanged', duration_ms: Date.now() - t0,
          });
          return wrapFinalizeOutcome({
            day,
            record,
            unchanged: true,
            replay: {
              dayCompleteness: persisted?.completeness ? [{
                day,
                status: persisted.completeness.status,
                overnight_state: persisted.completeness.overnight_state,
                finalized_at: persisted.completeness.overnight_finalized_at || persisted.completeness.finalized_at,
                hr_coverage_pct: persisted.completeness.result?.hr_coverage?.coverage_pct ?? null,
                open_gaps: persisted.completeness.result?.gaps?.counts?.live ?? null,
              }] : [],
              inputManifestIds: record.input_object_ids || ready.ids,
            },
          });
        }
      } catch { /* fall through to the full path */ }
    }
    const computing = makeRecord({
      classification: {
        day, wake_day: day, state: FINALIZATION_STATES.COMPUTING, reason_code: null,
        manifests: 0, timeZone, sample_count: null, hr_count: null, rr_sample_count: null,
        latest_sensor_at: null, sleep_hr_count: null, manifest_ids: [], decoded: 0, deduplicated: 0,
        sleep_detected: false, algorithm_version: ALGORITHM_VERSION,
      },
      trigger, cycleId, fingerprint: persisted?.fingerprint || prior0?.fingerprint || 'computing', durationMs: 0,
    });
    try { await persistOvernightControl({ userId, day, timeZone, record: computing, trigger }); } catch { /* control-plane write is best-effort */ }

    logOvernightEvent('overnight.recompute_start', { user_id: userId, day, trigger, cycle_id: cycleId });
    let replay = null;
    let replayError = null;
    try {
      replay = await engine.recomputeFromStorage({
        userId,
        device: device || {},
        days: [day],
        timeZone,
      });
    } catch (error) {
      replayError = error;
      inc('overnight_recompute_failures');
    }
    const resultsForDay = (replay?.results || []).filter((r) => (
      r?.scored?.day === day || r?.windowStats?.day === day || r?.day === day
    ));
    const result = resultsForDay.find((r) => r?.scored?.day === day)
      || resultsForDay[0]
      || (replay?.results || []).at(-1)
      || null;
    const windowStats = result?.windowStats || {
      sample_count: replay?.samples ?? 0,
      hr_count: 0,
      rr_sample_count: 0,
      latest_sensor_at: null,
      sleep_hr_count: null,
      manifest_ids: [],
      decoded: replay?.samples ?? 0,
      deduplicated: replay?.deduplicated ?? 0,
    };
    const prior = states.get(`${userId}|${day}`);
    const fingerprint = dayFingerprint({
      day,
      timeZone,
      manifestIds: windowStats.manifest_ids || [],
      sampleCount: windowStats.sample_count || replay?.samples || 0,
      latestSensorAt: windowStats.latest_sensor_at || null,
      algorithmVersion: result?.dailyRow?.algorithm_version || ALGORITHM_VERSION,
    });
    let baselines = null;
    if (typeof baselinesOf === 'function') {
      try { baselines = await Promise.resolve(baselinesOf(userId)); } catch { baselines = null; }
    }
    const classification = classifyFinalization({
      day,
      timeZone,
      manifests: replay?.manifests ?? 0,
      window: windowStats,
      result,
      error: replayError || (replay?.error ? new Error(replay.error) : null),
      baselines,
    });
    const sleepEndAt = classification.sleep_end_at;

    // Fast path: the exact same inputs already finalized coherently.
    if (!force && prior
      && prior.state === FINALIZATION_STATES.FINALIZED
      && prior.fingerprint === fingerprint
      && classification.state === FINALIZATION_STATES.FINALIZED) {
      logOvernightEvent('overnight.finalized', {
        user_id: userId, day, trigger, state: prior.state, fingerprint, detail: 'unchanged', duration_ms: Date.now() - t0,
      });
      return wrapFinalizeOutcome({
        day,
        record: { ...prior, attempts: prior.attempts },
        unchanged: true,
        replay: { dayCompleteness: replay?.dayCompleteness || [], inputManifestIds: windowStats.manifest_ids || [] },
      });
    }

    const durationMs = () => Date.now() - t0;
    if (classification.state === FINALIZATION_STATES.ERROR
      || classification.state === FINALIZATION_STATES.WAITING_FOR_HISTORY
      || classification.state === FINALIZATION_STATES.INSUFFICIENT_DATA && !result) {
      // Nothing was computed for this day this run: record the verdict where it
      // is durable (local mirror + logs) without minting an empty daily row.
      const record = makeRecord({
        classification,
        trigger, cycleId, fingerprint, verified: false, durationMs: durationMs(),
      });
      logOvernightEvent('overnight.failed', {
        user_id: userId, day, trigger, cycle_id: cycleId, state: record.state,
        reason_code: record.reason_code, detail: record.error || record.reason_code,
        duration_ms: record.duration_ms,
      });
      record.attempts = (prior?.attempts || 0) + 1;
      persistLocalState(userId, day, record);
      try { await persistOvernightControl({ userId, day, timeZone, record, trigger }); } catch { /* control plane */ }
      try { await attachFinalization({ userId, day, record, computed: null, mirrorExtras: false }); } catch { /* metric_run only */ }
      return wrapFinalizeOutcome({
        day,
        record,
        unchanged: false,
        replay: { dayCompleteness: replay?.dayCompleteness || [], inputManifestIds: windowStats.manifest_ids || [] },
      });
    }

    // A result exists. Write the computed projection with a preliminary record;
    // flip to the resolved record only after the persisted state reads back.
    // A `skipped` result (manifests but zero window samples) has no projection
    // to attach to: record the verdict locally and in metric_runs only, never
    // as an empty daily_metrics row.
    const hasProjection = Boolean(result && !result.skipped && result.dailyRow);
    let persistError = null;
    let readback = { ok: null, detail: 'skipped' };
    if (hasProjection) {
      if (typeof flushOutbox === 'function') {
        try { await flushOutbox(); } catch (error) { persistError = error; }
      }
      if (!persistError) readback = await readBack({ userId, day, result });
    }
    if (readback.ok === false) persistError = persistError || new Error(`persistence_${readback.detail}`);

    let record;
    if (persistError) {
      record = makeRecord({
        classification: {
          ...classification,
          state: FINALIZATION_STATES.ERROR,
          reason_code: FINALIZATION_REASONS.PERSISTENCE_FAILED,
          error: String(persistError?.message || persistError).slice(0, 180),
        },
        trigger, cycleId, fingerprint, durationMs: durationMs(),
      });
      logOvernightEvent('overnight.failed', {
        user_id: userId, day, trigger, cycle_id: cycleId, state: record.state,
        reason_code: record.reason_code, detail: record.error, duration_ms: record.duration_ms,
      });
    } else {
      record = makeRecord({
        classification,
        trigger, cycleId, fingerprint,
        verified: readback.ok === true || readback.ok === null,
        durationMs: durationMs(),
      });
      // Replace the preliminary `computing` record with the resolved verdict.
      // Same deterministic run id: the outbox merges it if the first write is
      // still pending; otherwise it is a tiny extras-only correction.
      if (hasProjection) {
        try {
          await attachFinalization({ userId, day, record, computed: result });
          if (typeof flushOutbox === 'function') {
            try { await flushOutbox(); } catch { /* the outbox retries on its own schedule */ }
          }
        } catch (error) {
          record.attach_error = String(error?.message || error).slice(0, 120);
          logOvernightEvent('overnight.failed', {
            user_id: userId, day, trigger, state: record.state, stage: 'finalization_record',
            detail: record.attach_error, reason_code: record.reason_code,
          });
        }
      }
      logOvernightEvent('overnight.persisted', {
        user_id: userId, day, trigger, cycle_id: cycleId, state: record.state,
        reason_code: record.reason_code, persisted: true, readback: readback.detail,
        duration_ms: record.duration_ms,
      });
      if (record.state === FINALIZATION_STATES.FINALIZED || record.state === FINALIZATION_STATES.CALIBRATING) {
        logOvernightEvent('overnight.finalized', {
          user_id: userId, day, wake_day: record.wake_day, trigger, cycle_id: cycleId,
          state: record.state, sleep_start_at: record.sleep_start_at,
          sleep_end_at: record.sleep_end_at, rhr_bpm: record.rhr_bpm,
          hrv_ms: record.hrv_ms, recovery_pct: record.recovery_pct,
          baseline_maturity: record.baseline_maturity,
          algorithm_version: record.algorithm_version, fingerprint,
          duration_ms: record.duration_ms,
        });
      }
    }
    record.attempts = (prior?.attempts || 0) + 1;
    persistLocalState(userId, day, record);
    try { await persistOvernightControl({ userId, day, timeZone, record, trigger }); } catch { /* control plane */ }
    return wrapFinalizeOutcome({
      day,
      record,
      unchanged: false,
      replay: {
        dayCompleteness: replay?.dayCompleteness || [],
        inputManifestIds: windowStats.manifest_ids || [],
      },
    });
  }

  /**
   * Durable overnight_finalize metric run + optional extras mirror.
   * Canonical control state is day_completeness. Never REST-upsert extras-only.
   */
  async function attachFinalization({ userId, day, record, computed = null, mirrorExtras = true }) {
    if (!db) return null;
    const runId = uuidFromParts([userId || cfg?.localUserId || 'local', 'metric-run', 'overnight_finalize', day]);
    const row = {
      id: runId,
      user_id: userId,
      period_day: day,
      algorithm: 'overnight_finalize',
      algorithm_name: 'overnight_finalize',
      version: ALGORITHM_VERSION,
      code_build_hash: cfg?.buildHash || 'dev',
      config_hash: dayFingerprint({ day, manifestIds: record.input_object_ids || [] }),
      device_id: record.device_id || null,
      status: record.state === FINALIZATION_STATES.FINALIZED || record.state === FINALIZATION_STATES.CALIBRATING
        ? 'complete'
        : (record.state === FINALIZATION_STATES.ERROR ? 'failed' : 'partial'),
      input_refs: {
        sample_count: record.sample_count ?? 0,
        object_ids: record.input_object_ids || [],
        trigger: record.trigger || null,
        cycle_id: record.cycle_id || null,
        fingerprint: record.manifest_fingerprint || record.fingerprint,
      },
      input_start_at: null,
      input_end_at: record.latest_sensor_at || null,
      input_schema_versions: { archive: ARCHIVE_SCHEMA_VERSION, algorithm: ALGORITHM_VERSION },
      output_refs: {
        finalization: record,
        sleep: Boolean(record.sleep_detected),
        rhr_bpm: record.rhr_bpm,
        hrv_ms: record.hrv_ms,
        recovery_pct: record.recovery_pct,
        reason_code: record.reason_code,
      },
      quality: {
        state: record.state,
        reason_code: record.reason_code ?? null,
        fingerprint: record.fingerprint,
        manifest_fingerprint: record.manifest_fingerprint,
        verified: Boolean(record.verified),
        attempts: record.attempts ?? 1,
        baseline_maturity: record.baseline_maturity ?? null,
        baseline_observation_days: record.baseline_observation_days ?? null,
      },
      started_at: record.checked_at,
      finished_at: record.checked_at,
    };
    if (typeof db.upsertPayload === 'function') {
      await db.upsertPayload({
        user_id: userId,
        metric_runs: [row],
      });
    }
    const terminal = TERMINAL_OVERNIGHT_STATES.includes(record.state) || record.state === FINALIZATION_STATES.ERROR;
    if (mirrorExtras && terminal && typeof db.patchDailyExtras === 'function' && computed?.dailyRow) {
      await db.patchDailyExtras(userId, day, { overnight_finalization: { ...record } });
    }
    return row;
  }

  /**
   * The durable record persisted into daily_metrics.extras and metric_runs.quality.
   * Carries every observability field the debugging contract requires.
   */
  function makeRecord({ classification, trigger, cycleId = null, fingerprint, verified = false, durationMs = null, attempts = 1 }) {
    return {
      state: classification.state,
      reason_code: classification.reason_code ?? null,
      trigger: trigger || null,
      cycle_id: cycleId ?? null,
      day: classification.day,
      wake_day: classification.wake_day || classification.day,
      device_id: classification.device_id || null,
      input_object_ids: classification.manifest_ids || [],
      latest_sensor_at: classification.latest_sensor_at || null,
      sample_count: classification.sample_count ?? null,
      hr_count: classification.hr_count ?? null,
      rr_sample_count: classification.rr_sample_count ?? null,
      rr_windows_total: classification.rr_windows_total ?? null,
      rr_windows_used: classification.rr_windows_used ?? null,
      rr_artifact_fraction: classification.rr_artifact_fraction ?? null,
      gravity_coverage: classification.gravity_coverage ?? null,
      sleep_detected: Boolean(classification.sleep_detected),
      sleep_start_at: classification.sleep_start_at ?? null,
      sleep_end_at: classification.sleep_end_at ?? null,
      rhr_bpm: classification.rhr_bpm ?? null,
      hrv_ms: classification.hrv_ms ?? null,
      recovery_pct: classification.recovery_pct ?? null,
      baseline_maturity: classification.baseline_maturity ?? null,
      baseline_observation_days: classification.baseline_observation_days ?? null,
      algorithm_version: classification.algorithm_version,
      fingerprint,
      manifest_fingerprint: manifestFingerprint(classification.manifest_ids || [], classification.day, classification.timeZone),
      attempts,
      verified: Boolean(verified),
      error: classification.error ?? null,
      duration_ms: durationMs,
      checked_at: now().toISOString(),
    };
  }

  /**
   * The one conceptual operation. All triggers converge here.
   *
   * Each affected day is expanded with its midnight-overflow wake day so a
   * night crossing midnight is finalized under the correct wake date.
   */
  async function finalizeAffectedDays({
    userId,
    days = [],
    trigger = 'manual',
    timeZone = 'UTC',
    device = null,
    cycleId = null,
    force = false,
  } = {}) {
    if (!userId) throw new Error('user id required');
    const initial = [...new Set(days)].filter(Boolean).sort();
    if (!initial.length) return { results: [], days: [] };
    logOvernightEvent('overnight.trigger', {
      user_id: userId, affected_days: initial, trigger, cycle_id: cycleId,
    });
    return chainFor(userId, async () => {
      const processed = new Set();
      const outcomes = [];
      let pending = [...initial].sort();
      for (let pass = 0; pass < 3 && pending.length; pass += 1) {
        const overflowDays = [];
        for (const day of pending) {
          if (processed.has(day)) continue;
          processed.add(day);
          const outcome = await withDayLock(userId, day, () => finalizeOneDay({
            userId, day, trigger, timeZone, device, cycleId, force,
          }));
          const { record } = outcome;
          outcomes.push(outcome);
          // Midnight-crossing: if this night's data reaches near (or past) the
          // day's end, the next local day must also be finalized — its window
          // covers the entire night.
          const overflow = outcome.unchanged
            ? (record.wake_day && record.wake_day > day ? record.wake_day : null)
            : overflowWakeDay({
              day, timeZone,
              latestSensorAt: record.latest_sensor_at,
              sleepEndAt: record.sleep_end_at,
            });
          if (overflow && overflow > day && !processed.has(overflow)) overflowDays.push(overflow);
        }
        pending = overflowDays;
      }
      // DayCompleteness gate results (computed inside recomputeFromStorage) are
      // surfaced so callers that capture per-flush completeness telemetry keep
      // working through the finalizer path.
      const dayCompleteness = outcomes
        .flatMap((r) => r.replay?.dayCompleteness || [])
        .filter(Boolean);
      return {
        results: outcomes.map((r) => r.record),
        days: outcomes.map((r) => r.record.day),
        details: outcomes,
        ...(dayCompleteness.length ? { dayCompleteness } : {}),
      };
    });
  }

  async function latestCompletedRunAt(userId, day) {
    if (typeof db?.latestOvernightRun === 'function') {
      try {
        const run = await db.latestOvernightRun(userId, day);
        return run?.finished_at || run?.started_at || null;
      } catch { /* fall through */ }
    }
    return null;
  }

  /**
   * Startup / periodic reconciliation: finalize every day whose ready raw
   * physiology is newer than the latest successful metric run, plus any day
   * whose durable local marker never resolved. Raw data alone is sufficient —
   * a lost completion signal costs nothing.
   */
  async function reconcile({
    userId,
    timeZone = 'UTC',
    device = null,
    trigger = 'startup_reconciliation',
    lookbackDays = 8,
  } = {}) {
    if (!userId) return { results: [], days: [] };
    const today = localDateKey(now(), timeZone);
    const fromMs = Date.parse(`${today}T12:00:00Z`) - lookbackDays * 86_400_000;
    const from = localDateKey(new Date(fromMs), timeZone);
    const candidates = [];
    try {
      const manifests = db && typeof db.listPhysiologyManifests === 'function'
        ? await db.listPhysiologyManifests({ userId, fromDay: from, toDay: today, timeZone })
        : [];
      const relevant = (manifests || []).filter((m) => m?.object_kind === 'physiology');
      const byDay = new Map();
      for (const manifest of relevant) {
        const day = manifest.period_day
          || localDateKey(manifest.end_at || manifest.start_at, timeZone);
        if (!day) continue;
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(manifest);
      }
      for (const [day, dayManifests] of [...byDay.entries()].sort()) {
        const ready = dayManifests.filter((m) => ['ready', 'verified'].includes(m.status || ''));
        if (!ready.length) continue;
        const readyFp = manifestFingerprint(
          ready.map((m) => m.id).filter(Boolean).sort(), day, timeZone,
        );
        const persisted = await persistedOvernight(userId, day);
        if (skippableOvernight(persisted) && persisted.fingerprint === readyFp) continue;
        const newestManifestAt = Math.max(0, ...dayManifests.map((m) => Date.parse(
          m.verified_at || m.uploaded_at || m.end_at || 0,
        )).filter(Number.isFinite));
        const latestRunAt = await latestCompletedRunAt(userId, day);
        const runMs = latestRunAt ? Date.parse(latestRunAt) : 0;
        if (!latestRunAt || newestManifestAt > runMs) candidates.push(day);
      }
      // Local durable markers: days that never resolved to a coherent state.
      const local = loadLocalState(userId);
      for (const [day, record] of Object.entries(local)) {
        if (record?.state === FINALIZATION_STATES.FINALIZED) continue;
        if (!candidates.includes(day)) candidates.push(day);
      }
    } catch (error) {
      logOvernightEvent('overnight.failed', {
        user_id: userId, trigger, stage: 'reconciliation', detail: String(error?.message || error).slice(0, 160),
      });
      return { results: [], days: [], error: String(error?.message || error).slice(0, 160) };
    }
    const unique = [...new Set(candidates)].sort();
    if (!unique.length) return { results: [], days: [] };
    return finalizeAffectedDays({
      userId,
      days: unique,
      trigger,
      timeZone,
      device,
    });
  }

  /** Machine-readable state for the diagnostic endpoint. */
  function stateOf(userId, day) {
    return states.get(`${userId}|${day}`) || null;
  }

  function allStates(userId) {
    const out = {};
    for (const [key, record] of states.entries()) {
      const [uid, day] = key.split('|');
      if (uid === userId) out[day] = record;
    }
    return out;
  }

  /**
   * Full-chain diagnosis for one day: strap/history → B2 → replay → sleep →
   * HRV/RHR → Recovery → Supabase, plus the finalization verdict. One request
   * identifies exactly which stage is incomplete and why. Read-only: the sleep
   * pipeline runs in memory, never persisted.
   */
  async function diagnoseDay({ userId, day, timeZone = 'UTC' } = {}) {
    const bounds = dayBounds(day, timeZone);
    const lo = Date.parse(bounds.day_start_at) - 12 * 3_600_000;
    const hi = Date.parse(bounds.day_end_at);
    const stages = {};

    // ---- stage 1: strap/history ----
    const hist = historyStatsOf?.(userId) || null;
    const live = liveOf?.(userId) || null;
    const historyReady = Boolean(hist?.history_complete) || (hist?.pending_history_samples ?? 0) === 0;
    stages.strap_history = {
      status: hist ? (historyReady ? 'ok' : 'incomplete') : 'ok',
      history_complete: hist?.history_complete ?? null,
      cycle_id: hist?.cycle_id ?? null,
      pending_history_samples: hist?.pending_history_samples ?? null,
      pending_days: hist?.pending_days ?? null,
      affected_days: hist?.affected_days ?? null,
      connected: live?.connected ?? null,
      device_id: live?.deviceId ?? null,
    };

    // ---- stage 2: B2 raw manifests (+ optional decode) ----
    let manifests = [];
    let decode = null;
    let windowSamples = [];
    try {
      manifests = db && typeof db.listPhysiologyManifests === 'function'
        ? await db.listPhysiologyManifests({ userId, days: [day], timeZone })
        : [];
      const ready = manifests.filter((m) => m?.object_kind === 'physiology'
        && ['ready', 'verified'].includes(m.status || ''));
      stages.b2_raw = {
        status: ready.length ? 'ok' : 'incomplete',
        reason_code: ready.length ? null : FINALIZATION_REASONS.RAW_MANIFEST_MISSING,
        manifests_total: manifests.length,
        manifests_ready: ready.length,
        object_ids: ready.map((m) => m.id).filter(Boolean),
        manifest_sample_count: ready.reduce((n, m) => n + (Number(m.sample_count) || 0), 0),
        window_start_at: new Date(lo).toISOString(),
        window_end_at: new Date(hi).toISOString(),
      };
      if (ready.length) {
        const stores_ = stores || await getStores(cfg);
        if (stores_?.raw) {
          let decoded = [];
          for (const manifest of ready) {
            try {
              const object = await stores_.raw.getObject(manifest.object_key);
              if (object?.body) decoded.push(...decodeArchive(object.body));
            } catch { /* per-object decode failure counts as absent */ }
          }
          const corrected = dedupeReplaySamples(correctReplayHistoricalClock(decoded));
          guardReplayWindowCoverage(corrected, { lo, hi, label: `diagnose:${userId.slice(0, 8)}:${day}` });
          windowSamples = corrected.filter((s) => {
            const t = Date.parse(s?.t || s?.datetime || s?.at || '');
            return Number.isFinite(t) && t >= lo && t < hi;
          });
          const inWindow = windowSamples;
          const fieldCensus = decodeFieldCensus(decoded);
          if (decoded.length && !fieldCensus.gravity && fieldCensus.bpm) {
            inc('decode_gravity_absent');
          }
          decode = {
            decoded_samples: decoded.length,
            deduped_samples: corrected.length,
            window_samples: inWindow.length,
            window_hr_count: inWindow.filter((s) => Number.isFinite(Number(s?.bpm))).length,
            window_rr_count: inWindow.filter((s) => Array.isArray(s?.rr_ms) && s.rr_ms.length).length,
            field_census: fieldCensus,
            latest_sensor_at: corrected.reduce((latest, s) => {
              const t = Date.parse(s?.t || s?.datetime || s?.at || '');
              return Number.isFinite(t) && t > latest ? t : latest;
            }, 0) || null,
          };
        }
      }
    } catch (error) {
      stages.b2_raw = { status: 'failed', error: String(error?.message || error).slice(0, 160) };
    }
    stages.replay = {
      status: decode
        ? (decode.window_samples > 0 ? 'ok' : 'incomplete')
        : 'skipped',
      reason_code: decode && !decode.window_samples ? FINALIZATION_REASONS.HR_COVERAGE_LOW : null,
      ...decode,
    };

    // ---- stage 3: sleep (dry-run, never persisted) ----
    let scored = null;
    let overnight = null;
    if (decode?.window_samples > 0) {
      try {
        const provider = createOvernightProvider({ baselines: null, now });
        scored = scoreDay({ samples: windowSamples, history: [], extras: { day, timeZone, overnight: provider } });
        overnight = provider.summary();
        const night = scored.sleep;
        const persistable = isPersistableOvernight(night);
        stages.sleep = {
          status: persistable ? 'ok' : 'incomplete',
          reason_code: persistable ? null : FINALIZATION_REASONS.NO_SLEEP_WINDOW,
          detected: Boolean(night?.ok),
          detector: night?.detector ?? null,
          fallback_reason: night?.fallbackReason ?? null,
          sleep_start_at: night?.onsetIso ?? null,
          sleep_end_at: night?.wakeIso ?? null,
          sessions: night?.sessions?.length ?? 0,
        };
        stages.hrv_rhr = {
          status: overnight?.hrv?.value != null ? 'ok' : 'incomplete',
          reason_code: overnight?.hrv?.value == null
            ? (/no RR intervals/i.test(String(overnight?.hrv?.reason || ''))
              ? FINALIZATION_REASONS.RR_COVERAGE_LOW
              : FINALIZATION_REASONS.HRV_INSUFFICIENT_WINDOWS)
            : null,
          hrv_ms: overnight?.hrv?.value ?? null,
          hrv_confidence: overnight?.hrv?.confidence ?? null,
          hrv_reason: overnight?.hrv?.reason ?? null,
          rr_windows_total: overnight?.hrv?.detail?.windowsTotal ?? null,
          rr_windows_used: overnight?.hrv?.detail?.windowsUsed ?? null,
          rhr_bpm: scored.restingHr ?? null,
          withheld: overnight?.withheld ?? null,
        };
        stages.recovery = {
          status: scored.recovery != null ? 'ok' : 'incomplete',
          recovery_pct: scored.recovery ?? null,
          inputs: {
            hrv: overnight?.hrv?.value ?? null,
            rhr: scored.restingHr ?? null,
            sleep_performance: night?.performance ?? null,
            resp: overnight?.resp?.value ?? null,
          },
        };
      } catch (error) {
        stages.sleep = { status: 'failed', error: String(error?.message || error).slice(0, 160) };
      }
    } else if (!stages.sleep) {
      stages.sleep = { status: 'incomplete', reason_code: FINALIZATION_REASONS.HISTORY_NOT_COMPLETE, detected: false };
    }

    // ---- stage 4: Supabase projection ----
    let persisted = null;
    try {
      const payload = db && typeof db.loadUserDays === 'function'
        ? await db.loadUserDays(userId, day, day)
        : null;
      const row = (payload?.daily_metrics || []).find((r) => r?.day === day) || null;
      persisted = {
        daily_metrics_row: Boolean(row),
        computed_at: row?.computed_at ?? null,
        algorithm_version: row?.algorithm_version ?? null,
        recovery_score: row?.recovery_score ?? null,
        hrv_rmssd_ms: row?.hrv_rmssd_ms ?? null,
        resting_hr_bpm: row?.resting_hr_bpm ?? null,
        sleep_onset_at: row?.sleep_onset_at ?? null,
        wake_onset_at: row?.wake_onset_at ?? null,
        sessions: (payload?.sessions || []).length,
        sleep_details: (payload?.sleep_details || []).length,
        series: Boolean((payload?.daily_physiology_series || []).some((s) => s?.day === day)),
        metric_runs: (payload?.metric_runs || []).map((r) => ({
          algorithm: r.algorithm, status: r.status, version: r.version,
          finished_at: r.finished_at || r.started_at || null,
        })),
      };
      stages.supabase = {
        status: row ? 'ok' : 'incomplete',
        ...persisted,
      };
    } catch (error) {
      stages.supabase = { status: 'unknown', error: String(error?.message || error).slice(0, 160) };
    }

    // ---- stage 5: finalization verdict ----
    const state = stateOf(userId, day);
    stages.finalization = {
      status: state?.state === FINALIZATION_STATES.FINALIZED ? 'ok'
        : (state ? 'incomplete' : 'unknown'),
      state: state?.state ?? null,
      reason_code: state?.reason_code ?? null,
      fingerprint: state?.fingerprint ?? null,
      attempts: state?.attempts ?? null,
      trigger: state?.trigger ?? null,
      cycle_id: state?.cycle_id ?? null,
      checked_at: state?.checked_at ?? null,
      verified: state?.verified ?? null,
    };

    const CHAIN_ORDER = ['strap_history', 'b2_raw', 'replay', 'sleep', 'hrv_rhr', 'recovery', 'supabase', 'finalization'];
    const firstIncomplete = CHAIN_ORDER.find((name) => {
      const stage = stages[name];
      return !stage || stage.status !== 'ok';
    }) || null;
    return {
      day,
      timezone_name: timeZone,
      day_start_at: bounds.day_start_at,
      day_end_at: bounds.day_end_at,
      stages,
      first_incomplete: firstIncomplete,
      chain_complete: firstIncomplete == null,
    };
  }

  return {
    finalizeAffectedDays,
    reconcile,
    attachFinalization,
    diagnoseDay,
    stateOf,
    allStates,
    loadLocalState,
    FINALIZATION_STATES,
    FINALIZATION_REASONS,
  };
}
