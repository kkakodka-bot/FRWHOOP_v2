import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gravityVectorOf, normalizeSample } from './archiveFormat.js';
import { hourBucketUtc, localDateKey } from '../time/dayBoundary.js';
import {
  HISTORICAL_CLOCK_FLOOR_MS,
  HISTORICAL_CLOCK_FUTURE_SKEW_MS,
  historicalClockOffsetMs,
} from '../time/clockCorrection.js';
import { logOvernightEvent } from '../observability/overnightLog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultDir = path.join(here, '../data/live');
// WHOOP did not exist before 2015; a corrected historical timestamp landing
// earlier is an epoch/lost-RTC clock, not real sensor time.
const FLOOR_MS = HISTORICAL_CLOCK_FLOOR_MS;

// Live-evidence anchor bounds (mirror the phone-side anchor in
// WhoopProtocol.bankedClockAnchorOffset; see the MARK block below for the
// failure mode these address).
const LIVE_ANCHOR_MIN_SPACING_MS = 5 * 60_000;      // two probes ≥ 5 min apart
const LIVE_ANCHOR_LAG_TOLERANCE_MS = 10 * 60_000;   // lags agree within ±10 min
const LIVE_ANCHOR_ADVANCE_FRACTION = 0.5;           // frontier advances ≥ ½ wall rate
const BANKED_MISDATE_MIN_GAP_MS = 6 * 3_600_000;    // below: banking is current
const BANKED_MISDATE_MAX_GAP_MS = 4 * 86_400_000;   // above: outside this fix
export const HISTORY_CONTIGUOUS_GAP_MS = 90_000;

export function advanceContiguousThrough(current, sampleMs, gapMs = HISTORY_CONTIGUOUS_GAP_MS) {
  if (!Number.isFinite(sampleMs)) return current ?? null;
  if (current == null) return sampleMs;
  if (sampleMs <= current) return current;
  if (sampleMs - current <= gapMs) return sampleMs;
  return current;
}

function safeUserId(userId) {
  return String(userId || 'local').replace(/[^a-zA-Z0-9_-]/g, '') || 'local';
}

function rowKeys(t, timeZone = 'UTC') {
  const ms = t instanceof Date ? t.getTime() : Date.parse(t);
  const iso = Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
  return {
    day: localDateKey(iso, timeZone) || iso.slice(0, 10),
    hour: hourBucketUtc(iso).toISOString(),
  };
}

function writeDurable(file, text, flags = 'a') {
  const fd = fs.openSync(file, flags);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function atomicJson(file, value) {
  const tmp = `${file}.tmp`;
  writeDurable(tmp, `${JSON.stringify(value)}\n`, 'w');
  fs.renameSync(tmp, file);
}

function hasField(row, key) {
  return row != null && Object.prototype.hasOwnProperty.call(row, key) && row[key] != null;
}

/**
 * Historical rows are deliberately whitelisted. In particular, phoneMotion
 * and the live `motion` scalar cannot leak into a strap gravity vector.
 */
export function normalizeHistoricalSample(sample, nowIso = new Date().toISOString()) {
  if (!sample || typeof sample !== 'object') return null;
  const rawTime = sample.t || sample.datetime || sample.at;
  const parsed = Date.parse(rawTime || '');
  if (!Number.isFinite(parsed)) return null;

  const rawSeq = sample.seq ?? sample.sequence;
  if (typeof rawSeq !== 'number' && typeof rawSeq !== 'string') return null;
  const seq = Number(rawSeq);
  if (!Number.isSafeInteger(seq) || seq < 0) return null;

  const gravity = gravityVectorOf(sample);
  // iOS v18 still emits gx=gy=gz=0 when gravity fails its gate so the HR/steps
  // second is kept. Dropping the whole row here used to discard that HR.
  const dyn = gravity ? (sample.dyn_accel ?? sample.dynAccel) : undefined;

  let row;
  try {
    row = normalizeSample({
      t: new Date(parsed).toISOString(),
      t_strap: sample.t_strap,
      clock_offset_sec: sample.clock_offset_sec,
      bpm: sample.bpm ?? sample.heartRate ?? sample.heart_rate,
      rr_ms: sample.rr_ms ?? sample.rrIntervals,
      device_id: sample.device_id ?? sample.deviceId,
      q: sample.q ?? sample.quality,
      bat: sample.bat ?? sample.battery,
      src: sample.src ?? sample.source ?? 'whoop_history',
      gx: gravity?.gx,
      gy: gravity?.gy,
      gz: gravity?.gz,
      dyn_accel: dyn,
      layout: sample.layout ?? 'unknown',
      family: sample.family ?? 'unknown',
      decoder: sample.decoder ?? 'unknown',
      seq,
      band_sleep_state: sample.band_sleep_state ?? sample.bandSleepState ?? sample.sleep_state,
      on_wrist: sample.on_wrist ?? sample.onWrist ?? sample.onwrist,
      wake_quality: sample.wake_quality ?? sample.wakeQuality,
      skin_contact: sample.skin_contact ?? sample.skinContact,
      wrist_on: sample.wrist_on ?? sample.wristOn,
      wrist_off: sample.wrist_off ?? sample.wristOff,
      steps: sample.steps,
      step_cumulative: sample.step_cumulative ?? sample.stepsCumulative ?? sample.stepCounter ?? sample.step_motion_counter,
      step_cadence: sample.step_cadence ?? sample.stepCadence,
      activity_class: sample.activity_class ?? sample.activityClass,
      skin_temp_c: sample.skin_temp_c ?? sample.skinTempC ?? sample.skinTemp
        ?? (Number.isFinite(Number(sample.skin_temp_raw)) ? Number(sample.skin_temp_raw) / 100 : undefined),
      spo2_raw_byte: sample.spo2_raw_byte ?? sample.spo2RawByte ?? sample.aux_byte_82,
      spo2_candidate_pct: sample.spo2_candidate_pct ?? sample.spo2CandidatePct ?? sample.spo2_candidate_82,
      spo2_state: sample.spo2_state ?? sample.spo2State,
      source_frame_hash: sample.source_frame_hash ?? sample.sourceFrameHash,
      firmware: sample.firmware ?? sample.fw,
      sensor_ts: sample.sensor_ts,
      connection_epoch: sample.connection_epoch ?? sample.connectionEpoch,
      rr_continuity: sample.rr_continuity ?? sample.rrContinuity,
      packet_type: sample.packet_type ?? sample.packetType,
      packet_seq: sample.packet_seq ?? sample.packetSeq,
      wear_location: sample.wear_location ?? sample.wearLocation,
      wear_location_source: sample.wear_location_source ?? sample.wearLocationSource,
      record_index: sample.record_index ?? sample.recordIndex,
      imu_source: sample.imu_source ?? sample.imuSource,
      enmo_mean: sample.enmo_mean ?? sample.enmoMean,
      accel_rms_g: sample.accel_rms_g ?? sample.accelRmsG,
      jerk_rms_g: sample.jerk_rms_g ?? sample.jerkRmsG,
      gyro_rms_raw: sample.gyro_rms_raw ?? sample.gyroRmsRaw,
      stillness_fraction: sample.stillness_fraction ?? sample.stillnessFraction,
      imu_sample_count: sample.imu_sample_count ?? sample.imuSampleCount,
    }, nowIso);
  } catch {
    return null;
  }
  // Sleep/wear/skin-contact-only rows are kept too: the band's sleep/wear
  // byte (v18 @81) and v24 skin contact are independently meaningful evidence
  // (mission target 2), so a second with ONLY wear state survives instead of
  // being silently dropped.
  if (row.bpm == null && !row.rr_ms.length && !gravityVectorOf(row)
      && row.steps == null && row.step_cumulative == null && row.skin_temp_c == null
      && row.band_sleep_state == null && row.on_wrist == null
      && row.wake_quality == null && row.skin_contact == null
      && row.spo2_state !== 'candidate' && row.spo2_state !== 'sentinel'
      && row.spo2_state !== 'diagnostic'
      && row.enmo_mean == null && row.accel_rms_g == null) return null;
  return row;
}

/**
 * Crash-safe, sensor-time-bucketed queue for phone history backfill.
 *
 * A route acknowledgement is based on appendBatch().results[].durable. Rows
 * become durable only after the history WAL has been written and fsynced.
 * Upload removal is also WAL-backed, so a failed B2 archive is retried.
 */
export function createHistoryBuffer({
  dir = defaultDir,
  userId,
  engine,
  maxBatchSamples = 2000,
  flushMs = 5 * 60_000,
  now = () => new Date(),
  uuid = randomUUID,
  onHistoryComplete = null,
  timeZone = 'UTC',
} = {}) {
  const folder = path.join(dir, safeUserId(userId));
  fs.mkdirSync(folder, { recursive: true });
  const resolveTz = () => {
    try {
      return typeof timeZone === 'function' ? (timeZone() || 'UTC') : (timeZone || 'UTC');
    } catch {
      return 'UTC';
    }
  };
  const batchSize = Number.isSafeInteger(maxBatchSamples) && maxBatchSamples > 0
    ? maxBatchSamples
    : 2000;
  const flushAfterMs = Number.isFinite(flushMs) && flushMs >= 0 ? flushMs : 5 * 60_000;
  const walFile = path.join(folder, 'history-pending-wal.ndjson');
  const stateFile = path.join(folder, 'history-state.json');
  const pending = [];
  const durableSeq = new Set();
  // Reconnect-safe dedup by (device, sensor timestamp). The phone mints a fresh
  // seq every time it re-appends a re-sent offload chunk (the strap trims only
  // after an ack), so src:seq alone never catches a re-send. Timestamp+device
  // does. Bounded to bound memory in long sessions.
  const durableTs = new Map();
  const MAX_DURABLE_TS = 250_000;
  // Durable re-send dedupe: the in-memory maps above are rebuilt ONLY from the
  // history WAL, and the WAL is emptied on the first successful flush — the
  // exact moment a lost-ack re-send arrives is the moment the backend has
  // forgotten every flushed row (adversarial break [1]: re-send after
  // flush+restart produced duplicate B2 objects). These keys are persisted to
  // the state file on every successful flush and consulted in appendBatch.
  // Bounded; like the in-memory cap, very old keys (> MAX_ACKED_TS) fall out.
  let ackedTs = new Set();
  const MAX_ACKED_TS = 60_000;
  let ackedTsDirty = false;
  let flushing = false;
  let state = {
    affected_days: [],
    history_complete: false,
    updated_at: null,
    clock_offset_ms: 0,
    max_strap_ms: 0,
    contiguous_through_ms: null,
    progress_revision: 0,
    // Identity of the current drain cycle. Every archived chunk and every
    // recompute trigger carries it, so one night's path is traceable end to
    // end and duplicate HISTORY_COMPLETE posts are idempotent by identity.
    cycle_id: null,
  };
  // Days archived in the current historical cycle. Reset at the next cycle
  // boundary and used to recompute exactly the affected local days once a
  // cycle is signalled complete (Phase 4: history upload -> recompute).
  let cycleArchivedDays = new Set();

  function seqKey(row) {
    return `${row.src || 'unknown'}:${row.seq}`;
  }

  function tsKey(row) {
    const device = row.device_id || row.deviceId || '?';
    const sensor = Number.isFinite(Number(row.sensor_ts)) && Number(row.sensor_ts) > 0
      ? `s${Math.floor(Number(row.sensor_ts))}`
      : `t${row.t || row.datetime || ''}`;
    const counter = Number.isFinite(Number(row.step_cumulative))
      ? `c${Math.round(Number(row.step_cumulative))}`
      : '';
    return `${device}:${sensor}:${counter}`;
  }

  function noteTs(row) {
    const key = tsKey(row);
    if (durableTs.has(key)) durableTs.delete(key);
    durableTs.set(key, true);
    if (durableTs.size > MAX_DURABLE_TS) {
      const head = durableTs.keys().next().value;
      if (head) durableTs.delete(head);
    }
  }

  function recover() {
    try {
      if (fs.existsSync(stateFile)) {
        const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        state = {
          affected_days: Array.isArray(saved?.affected_days) ? [...new Set(saved.affected_days)].sort() : [],
          history_complete: Boolean(saved?.history_complete),
          updated_at: saved?.updated_at || null,
          clock_offset_ms: Number.isFinite(Number(saved?.clock_offset_ms)) ? Number(saved.clock_offset_ms) : 0,
          max_strap_ms: Number.isFinite(Number(saved?.max_strap_ms)) ? Number(saved.max_strap_ms) : 0,
          contiguous_through_ms: Number.isFinite(Number(saved?.contiguous_through_ms))
            ? Number(saved.contiguous_through_ms)
            : null,
          progress_revision: Number.isFinite(Number(saved?.progress_revision)) ? Number(saved.progress_revision) : 0,
          cycle_id: typeof saved?.cycle_id === 'string' ? saved.cycle_id : null,
        };
        // Durable re-send dedupe (adversarial break [1]): flushed rows survive
        // in the state file even after the WAL is emptied by a flush.
        if (Array.isArray(saved?.acked_ts)) {
          ackedTs = new Set(saved.acked_ts.filter((k) => typeof k === 'string'));
        }
      }
    } catch { /* state is advisory; WAL remains authoritative */ }
    try {
      if (!fs.existsSync(walFile)) return;
      const rows = fs.readFileSync(walFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter((row) => row?._wal_id && row?._hour && row?._day);
      for (const row of rows) {
        const key = seqKey(row);
        if (durableSeq.has(key)) continue;
        durableSeq.add(key);
        noteTs(row);
        pending.push(row);
      }
    } catch { /* a later append/retry can recreate the queue */ }
  }

  recover();

  function persistState(affectedDays, historyComplete) {
    state = {
      affected_days: [...new Set([...state.affected_days, ...affectedDays])].sort(),
      history_complete: state.history_complete || Boolean(historyComplete),
      updated_at: now().toISOString(),
      clock_offset_ms: state.clock_offset_ms || 0,
      max_strap_ms: state.max_strap_ms || 0,
      contiguous_through_ms: state.contiguous_through_ms ?? null,
      progress_revision: state.progress_revision || 0,
      cycle_id: state.cycle_id || null,
    };
    atomicJson(stateFile, state);
  }

  function rewriteWal() {
    const text = pending.map((row) => JSON.stringify(row)).join('\n');
    const tmp = `${walFile}.tmp`;
    writeDurable(tmp, `${text}${text ? '\n' : ''}`, 'w');
    fs.renameSync(tmp, walFile);
  }

  function noteFarStrapClock(strapMs, receivedMs) {
    const off = historicalClockOffsetMs(strapMs, receivedMs);
    if (!off) return;
    if (strapMs < (state.max_strap_ms || 0)) return;
    state.max_strap_ms = strapMs;
    state.clock_offset_ms = off;
  }

  // MARK: live-evidence anchor for recent misdated banking
  //
  // Hardware-observed (2026-08): a WHOOP 5/MG can bank type-47 history with a
  // clock DAYS behind wall time while its realtime type-40 stream is correct.
  // The phone carries GET_DATA_RANGE + live-stream evidence and stamps
  // `clock_offset_sec` when it corrects; when it cannot (a relaunch that went
  // straight to offload), this backend layer catches the same signature from
  // the evidence the phone posts anyway:
  //   - `diag.data_range_newest` — the strap's newest BANKED record stamp,
  //     straight from GET_DATA_RANGE (the banking-clock domain);
  //   - live rows in the same POST — wall-dated ≈ now (the correct domain).
  // Misdated banking (A): the banked newest lags live by a STABLE band
  // [6 h, 4 d] while it advances at ≈ wall rate. Genuine backlog (B): the
  // banked newest ≈ now (banking is current, lag ≈ 0). A pace-limited drain
  // under B cannot fake A — the BANKED newest, not the drain position, is
  // compared, and under B it is current regardless of drain speed.
  //
  // Bounds mirror the phone's anchor: lag band [6 h, 4 d]; two observations
  // ≥ 5 min apart agreeing within ±10 min.

  /// Frontier probes from posted evidence: [{newestTs (banked strap stamp),
  /// liveWallMs}] — the phone's diag pairs, folded over time.
  let anchorProbes = [];

  function noteAnchorEvidence(dataRangeNewestMs, liveWallMs) {
    if (!Number.isFinite(dataRangeNewestMs) || dataRangeNewestMs <= 0) return;
    if (!Number.isFinite(liveWallMs) || liveWallMs <= 0) return;
    const last = anchorProbes[anchorProbes.length - 1];
    if (last && liveWallMs - last.liveWallMs < LIVE_ANCHOR_MIN_SPACING_MS) {
      // Fold into the current observation window: keep the newest evidence.
      if (dataRangeNewestMs > last.newestTs) last.newestTs = dataRangeNewestMs;
      if (liveWallMs > last.liveWallMs) last.liveWallMs = liveWallMs;
      return;
    }
    anchorProbes.push({ newestTs: dataRangeNewestMs, liveWallMs });
    if (anchorProbes.length > 4) anchorProbes.shift();
    // First engagement: rows that arrived BEFORE the anchor had two spaced
    // probes were stamped without it (the generic rules left a misdated
    // banking clock on its strap days). Re-stamp every still-pending row now
    // that the measured lag exists — this is the same recovery the startup
    // `applyPendingClockCorrection` performs for WAL rows.
    if (liveAnchorOffsetMs() > 0 && pending.length) {
      applyPendingClockCorrection();
    }
  }

  /// Live-evidence anchor offset (ms) or 0. Pure given the probe series.
  function liveAnchorOffsetMs() {
    if (anchorProbes.length < 2) return 0;
    const first = anchorProbes[anchorProbes.length - 2];
    const second = anchorProbes[anchorProbes.length - 1];
    const spacing = second.liveWallMs - first.liveWallMs;
    if (spacing < LIVE_ANCHOR_MIN_SPACING_MS) return 0;
    // The banked frontier must advance at ≈ wall rate (banking is live).
    const advanced = second.newestTs - first.newestTs;
    if (advanced < spacing * LIVE_ANCHOR_ADVANCE_FRACTION) return 0;
    // Stable lag of the banked newest behind the live clock.
    const lag1 = first.liveWallMs - first.newestTs;
    const lag2 = second.liveWallMs - second.newestTs;
    if (Math.abs(lag1 - lag2) > LIVE_ANCHOR_LAG_TOLERANCE_MS) return 0;
    if (lag2 < BANKED_MISDATE_MIN_GAP_MS || lag2 > BANKED_MISDATE_MAX_GAP_MS) return 0;
    return lag2;
  }

  function stampClockCorrection(row, receivedMs) {
    const strapIso = row.t_strap || row.t;
    if (!row.t_strap) row.t_strap = strapIso;
    if (row.clock_offset_sec != null && Number.isFinite(Number(row.clock_offset_sec))) {
      const keys = rowKeys(row.t, resolveTz());
      row._day = keys.day;
      row._hour = keys.hour;
      return row;
    }
    const strapMs = Date.parse(strapIso);
    const recv = Number.isFinite(receivedMs) ? receivedMs : Date.parse(row._queued_at || '') || now().getTime();
    noteFarStrapClock(strapMs, recv);
    // Defense-in-depth (see the live-evidence anchor MARK block): when the
    // posted GET_DATA_RANGE/live evidence proves the BANKING clock runs days
    // behind wall while still banking, recent strap stamps are misdated onto
    // days-old dates. Correct by the measured lag BEFORE the generic rules.
    const anchorOff = liveAnchorOffsetMs();
    if (anchorOff > 0) {
      const corrected = strapMs + anchorOff;
      if (corrected > FLOOR_MS && corrected <= recv + HISTORICAL_CLOCK_FUTURE_SKEW_MS) {
        const iso = new Date(corrected).toISOString();
        const keys = rowKeys(iso, resolveTz());
        row.t = iso;
        row.datetime = iso;
        row._day = keys.day;
        row._hour = keys.hour;
        row.clock_offset_sec = Math.round(anchorOff / 1000);
        row.clock_anchor = 'live_evidence';
        return row;
      }
    }
    // A strap banks weeks of flash while unsynced, so an old timestamp is normal
    // history, not a bad clock. Shifting it forward would restamp real history
    // onto the present and paint samples that never happened today. Only a clock
    // that is provably wrong — ahead of the receive clock, or pre-2015 — moves.
    const clockBroken = strapMs < FLOOR_MS || strapMs > recv + HISTORICAL_CLOCK_FUTURE_SKEW_MS;
    const off = clockBroken ? (state.clock_offset_ms || 0) : 0;
    if (!off) {
      // An epoch/lost RTC can land pre-2015 with offset 0 (beyond the correctable
      // bound). WHOOP did not exist then: rebase onto the receive time instead of
      // polluting 1970 metrics days, and mark the rebase explicitly.
      const strapDate = new Date(strapMs).toISOString();
      if (clockBroken && recv > FLOOR_MS) {
        const keys = rowKeys(new Date(recv).toISOString(), resolveTz());
        row.t = new Date(recv).toISOString();
        row.datetime = row.t;
        row._day = keys.day;
        row._hour = keys.hour;
        row.clock_offset_sec = Math.round((recv - strapMs) / 1000);
      } else {
        const keys = rowKeys(strapIso, resolveTz());
        row.t = strapIso;
        row.datetime = strapIso;
        row._day = keys.day;
        row._hour = keys.hour;
      }
      return row;
    }
    let corrected = strapMs + off;
    // Plausibility floor: WHOOP did not exist before 2015. An epoch/lost RTC
    // far older than the correction bound (e.g. 1970) must not land on a 1970
    // metrics day — rebase it onto the receive time instead, which is the same
    // constant-offset correction already used for months-wrong clocks, with
    // the receive anchor marked in clock_offset_sec.
    if (corrected < FLOOR_MS) {
      corrected = recv;
    }
    const iso = new Date(corrected).toISOString();
    const keys = rowKeys(iso, resolveTz());
    row.t = iso;
    row.datetime = iso;
    row._day = keys.day;
    row._hour = keys.hour;
    row.clock_offset_sec = Math.round(off / 1000);
    return row;
  }

  function applyPendingClockCorrection() {
    if (!pending.length) return;
    let changed = false;
    for (const row of pending) {
      const before = row.t;
      const queuedMs = Date.parse(row._queued_at || '') || now().getTime();
      stampClockCorrection(row, queuedMs);
      if (row.t !== before) changed = true;
    }
    if (!changed) return;
    durableTs.clear();
    for (const row of pending) noteTs(row);
    rewriteWal();
    persistState(pending.map((row) => row._day), false);
  }

  function appendBatch(samples, { historyComplete = false } = {}) {
    const incoming = Array.isArray(samples) ? samples : [];
    // A completed backfill is a cycle boundary. Further rows belong to a new
    // sync even if the phone is still echoing historyComplete from an unacked
    // POST — otherwise the buffer stays pinned to the old affected_days.
    if (incoming.length && state.history_complete) {
      state = {
        affected_days: [],
        history_complete: false,
        updated_at: now().toISOString(),
        clock_offset_ms: state.clock_offset_ms || 0,
        max_strap_ms: state.max_strap_ms || 0,
        contiguous_through_ms: state.contiguous_through_ms ?? null,
        progress_revision: state.progress_revision || 0,
        cycle_id: uuid(),
      };
      cycleArchivedDays = new Set();
      atomicJson(stateFile, state);
    } else if (incoming.length && !state.cycle_id) {
      // A cycle that started before this field existed (or a fresh buffer).
      state.cycle_id = uuid();
      atomicJson(stateFile, state);
    }
    const receivedIso = now().toISOString();
    const receivedMs = Date.parse(receivedIso);
    for (const sample of incoming) {
      const raw = sample?.t || sample?.datetime || sample?.at;
      const strapMs = Date.parse(raw || '');
      if (Number.isFinite(strapMs)) noteFarStrapClock(strapMs, receivedMs);
    }
    const prepared = [];
    const seenThisBatch = new Set();
    const seenTsThisBatch = new Set();
    const results = incoming.map((sample) => {
      const row = normalizeHistoricalSample(sample, receivedIso);
      if (!row) return { durable: false, reason: 'invalid_sample', seq: sample?.seq ?? sample?.sequence ?? null };
      const walRow = stampClockCorrection({
        ...row,
        _wal_id: uuid(),
        _queued_at: receivedIso,
      }, receivedMs);
      const key = seqKey(walRow);
      const tk = tsKey(walRow);
      if (durableSeq.has(key) || seenThisBatch.has(key) || durableTs.has(tk) || seenTsThisBatch.has(tk) || ackedTs.has(tk)) {
        return { durable: true, duplicate: true, seq: walRow.seq, day: rowKeys(walRow.t, resolveTz()).day };
      }
      seenThisBatch.add(key);
      seenTsThisBatch.add(tk);
      prepared.push({ key, row: walRow });
      return { durable: true, duplicate: false, seq: walRow.seq, day: walRow._day, _prepared: walRow };
    });

    if (prepared.length) {
      const text = prepared.map(({ row }) => JSON.stringify(row)).join('\n');
      writeDurable(walFile, `${text}\n`);
      for (const { key, row } of prepared) {
        durableSeq.add(key);
        noteTs(row);
        pending.push(row);
        const sampleMs = Date.parse(row.t);
        const next = advanceContiguousThrough(state.contiguous_through_ms, sampleMs);
        if (next !== state.contiguous_through_ms) {
          state.contiguous_through_ms = next;
          state.progress_revision = (state.progress_revision || 0) + 1;
        }
      }
    }

    const allDurable = results.every((result) => result.durable);
    const affectedDays = [...new Set(results.filter((result) => result.durable).map((result) => result.day))].sort();
    persistState(affectedDays, historyComplete && allDurable);

    let ackedThrough = null;
    for (const result of results) {
      if (!result.durable || !Number.isSafeInteger(Number(result.seq))) break;
      ackedThrough = Number(result.seq);
    }

    const shouldFlush = historyComplete || pending.length >= batchSize;
    if (shouldFlush) flush().catch(() => {});
    return {
      accepted: prepared.length,
      durable: results.filter((result) => result.durable).length,
      rejected: results.filter((result) => !result.durable).length,
      ackedThrough,
      affectedDays,
      historyComplete: state.history_complete,
      history_contiguous_through: state.contiguous_through_ms != null
        ? new Date(state.contiguous_through_ms).toISOString()
        : null,
      history_queue_depth: pending.length,
      history_progress_revision: state.progress_revision || 0,
      results: results.map(({ _prepared, ...result }) => result),
    };
  }

  function archiveRow(row) {
    const {
      _wal_id, _queued_at, _hour, _day,
      ...sample
    } = row;
    return sample;
  }

  async function flush() {
    if (flushing || !pending.length || !engine?.archiveRawSamples) return null;
    flushing = true;
    const flushedDays = new Set();
    let flushed = 0;
    try {
      const hours = [...new Set(pending.map((row) => row._hour))].sort();
      for (const hour of hours) {
        while (true) {
          const batchRows = pending
            .filter((row) => row._hour === hour)
            .sort((a, b) => Date.parse(a.t) - Date.parse(b.t) || Number(a.seq) - Number(b.seq))
            .slice(0, batchSize);
          if (!batchRows.length) break;
          const samples = batchRows.map(archiveRow);
          const archived = await engine.archiveRawSamples({
            samples,
            device: {
              deviceId: samples[0].device_id || null,
              externalId: samples[0].device_id || null,
            },
            startAt: samples[0].t,
            endAt: samples[samples.length - 1].t,
            day: batchRows[0]._day,
            hourStart: hour,
            chunkId: uuid(),
            extras: {
              userId,
              timeZone: resolveTz(),
              periodDay: batchRows[0]._day,
              historyBackfill: true,
              historyComplete: state.history_complete,
              historyCycleId: state.cycle_id || null,
              affectedDays: [...new Set(batchRows.map((row) => row._day))].sort(),
            },
          });
          if (!archived || !['ready', 'verified'].includes(archived.status)) {
            throw new Error('history_archive_not_ready');
          }
          // Observability: a raw physiology object is durable in B2 and its
          // manifest row is upserting — the first link in the overnight chain.
          logOvernightEvent('history.archive_ready', {
            user_id: userId,
            day: batchRows[0]._day,
            hour,
            object_id: archived.id || null,
            sample_count: batchRows.length,
            latest_sensor_at: archived.end_at || null,
            cycle_id: state.cycle_id || null,
            history_complete: state.history_complete,
          });

          const ids = new Set(batchRows.map((row) => row._wal_id));
          const removed = pending.filter((row) => ids.has(row._wal_id));
          for (let i = pending.length - 1; i >= 0; i -= 1) {
            if (ids.has(pending[i]._wal_id)) pending.splice(i, 1);
          }
          try {
            rewriteWal();
          } catch (error) {
            pending.push(...removed);
            throw error;
          }
          // Rows are now archived: record their (device, ts) identity in the
          // durable re-send dedupe set before the WAL rows are gone.
          for (const row of batchRows) {
            const key = tsKey(row);
            if (!ackedTs.has(key)) {
              ackedTs.add(key);
              ackedTsDirty = true;
            }
            if (ackedTs.size > MAX_ACKED_TS) {
              const first = ackedTs.values().next().value;
              if (first) ackedTs.delete(first);
            }
          }
          if (ackedTsDirty) {
            const saved = JSON.parse(fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : '{}');
            atomicJson(stateFile, {
              ...saved,
              affected_days: state.affected_days,
              history_complete: state.history_complete,
              updated_at: state.updated_at,
              clock_offset_ms: state.clock_offset_ms || 0,
              max_strap_ms: state.max_strap_ms || 0,
              contiguous_through_ms: state.contiguous_through_ms ?? null,
              progress_revision: state.progress_revision || 0,
              acked_ts: [...ackedTs],
            });
            ackedTsDirty = false;
          }
          for (const row of batchRows) { flushedDays.add(row._day); cycleArchivedDays.add(row._day); }
          flushed += batchRows.length;
        }
      }
      let ret = {
        flushed,
        affectedDays: [...flushedDays].sort(),
        historyComplete: state.history_complete,
        cycleAffectedDays: [...cycleArchivedDays].sort(),
      };
      // Recompute as soon as hours land, not only after the strap's END
      // packet. Waiting for historyComplete left Overview empty whenever an
      // offload stalled or the phone queued samples faster than a full cycle.
      if (flushedDays.size && typeof onHistoryComplete === 'function') {
        const recomputeDays = state.history_complete
          ? [...cycleArchivedDays].sort()
          : [...flushedDays].sort();
        if (state.history_complete) cycleArchivedDays = new Set();
        Promise.resolve()
          .then(() => onHistoryComplete({
            affectedDays: recomputeDays,
            historyComplete: state.history_complete,
            cycleId: state.cycle_id || null,
            trigger: state.history_complete ? 'history_complete' : 'history_archive',
          }))
          .catch(() => {});
        ret = { ...ret, recomputeScheduled: true, recomputeDays, cycleId: state.cycle_id || null };
      }
      return ret;
    } finally {
      flushing = false;
    }
  }

  applyPendingClockCorrection();

  return {
    appendBatch,
    flush,
    /// Feed the live-evidence anchor with the phone's posted frontier
    /// evidence (GET_DATA_RANGE newest banked stamp + live wall time).
    noteAnchorEvidence,
    async flushIfDue() {
      if (!pending.length) return null;
      const queuedAt = Math.min(...pending.map((row) => Date.parse(row._queued_at)).filter(Number.isFinite));
      if (state.history_complete || pending.length >= batchSize
        || (Number.isFinite(queuedAt) && now().getTime() - queuedAt >= flushAfterMs)) {
        return flush();
      }
      return null;
    },
    pendingCount: () => pending.length,
    pendingSamples() {
      return pending
        .filter((row) => Number.isFinite(Number(row?.bpm)) && Number(row.bpm) >= 20 && Number(row.bpm) <= 240)
        .map((row) => ({
          datetime: row.t,
          t: row.t,
          bpm: Number(row.bpm),
          heartRate: Number(row.bpm),
          sleep_stage: row.sleep_stage || row.band_sleep_state,
        }));
    },
    affectedDays: () => [...state.affected_days],
    pendingDays: () => [...new Set(pending.map((row) => row._day))].sort(),
    historyComplete: () => state.history_complete,
    cycleId: () => state.cycle_id || null,
    stats: () => ({
      pending_history_samples: pending.length,
      affected_days: [...state.affected_days],
      pending_days: [...new Set(pending.map((row) => row._day))].sort(),
      history_complete: state.history_complete,
      clock_offset_ms: state.clock_offset_ms || 0,
      cycle_id: state.cycle_id || null,
      contiguous_through_ms: state.contiguous_through_ms ?? null,
      history_contiguous_through: state.contiguous_through_ms != null
        ? new Date(state.contiguous_through_ms).toISOString()
        : null,
      history_progress_revision: state.progress_revision || 0,
    }),
    recover,
  };
}
