import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hourBucketUtc, localDateKey } from '../time/dayBoundary.js';
import { detectSampleGaps } from './gaps.js';
import { normalizeFrame } from './archiveFormat.js';
import { deriveRecords } from '../redecode/derive.js';
import { inc, timed, safeError, noteReject } from '../observability/metrics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultDir = path.join(here, '../data/live');

function hourKey(iso) {
  return hourBucketUtc(iso).toISOString();
}

/** Derived B2 stream specs (schema/format from the protocol record modules). */
const DERIVED_STREAM_SPECS = {
  imu_raw: { format: 'ndjson_gzip_imu_v1', schemaVersion: 1 },
  ppg_raw: { format: 'ndjson_gzip_ppg_v1', schemaVersion: 1 },
  whoop5_imu_v21: { format: 'ndjson_gzip_whoop5_imu_v21', schemaVersion: 1 },
  whoop5_ppg_v26: { format: 'ndjson_gzip_whoop5_ppg_v26', schemaVersion: 1 },
  whoop5_optical_v20: { format: 'ndjson_gzip_whoop5_optical_v20', schemaVersion: 1 },
  events: { format: 'ndjson_gzip_events_v1', schemaVersion: 1 },
  console_logs: { format: 'ndjson_gzip_console_v1', schemaVersion: 1 },
  cmd_battery: { format: 'ndjson_gzip_events_v1', schemaVersion: 1 },
};

const HOURLY_DERIVED_STREAMS = new Set([
  'imu_raw', 'ppg_raw', 'whoop5_imu_v21', 'whoop5_ppg_v26', 'whoop5_optical_v20',
]);

/** `Number(null)` is 0; live HR samples omit step/temp fields. */
function optionalFinite(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Strap unix when present so history IMU archives onto the sensor day, not receive-now. */
function derivedRecordIso(record) {
  const sensor = Number(record?.sensor_ts ?? record?.unix ?? record?.timestamp);
  if (Number.isFinite(sensor) && sensor > 1e9) {
    const ms = sensor > 1e12 ? sensor : sensor * 1000;
    return new Date(ms).toISOString();
  }
  const recv = Date.parse(record?.received_at || record?.t || '');
  return Number.isFinite(recv) ? new Date(recv).toISOString() : null;
}

function groupDerivedByHour(records = []) {
  const groups = new Map();
  for (const record of records) {
    const iso = derivedRecordIso(record);
    const hour = iso ? hourKey(iso) : 'unknown';
    if (!groups.has(hour)) groups.set(hour, []);
    groups.get(hour).push(record);
  }
  return [...groups.values()];
}

/**
 * Hourly raw-sample + BLE-frame buffer.
 *
 * The iPhone durable queues are the crash-safe source for in-hour data.
 * This buffer batches acknowledged samples and opaque ATT notifies into
 * independent hour-sized B2 archives. Local WALs are retry state only.
 * Physiology and frames never share a flush: one failing must not re-queue
 * the other.
 */
export function createHourBuffer({
  dir = defaultDir,
  userId,
  chunkMs = 60 * 60 * 1000,
  maxSamples = 4000,
  maxFrames = 20000,
  engine,
  now = () => new Date(),
  uuid = randomUUID,
  timeZone = 'UTC',
  onSamplesArchived = null,
  onScoreRequested = null,
  scoreAsync = false,
} = {}) {
  const pending = [];
  const pendingFrames = [];
  // Derived high-value records (IMU arrays / events / console / cmd-battery)
  // extracted from verified frames at flush time. Retry state lives in its
  // own WAL; the records are a pure function of Level A rows, so a crash can
  // at worst re-upload a content-addressed duplicate, never lose data.
  const pendingDerived = [];
  let flushingDerived = false;
  // Reassemblers persist across flushes so a split ATT frame that straddles
  // an hour boundary is not dropped from imu_raw (Level A still has both
  // notifies; this keeps the live derived path equivalent).
  const deriveReassemblers = { harvard: null, puffin: null };
  const seenPuffin54 = new Set();
  const openGaps = [];
  const recentSeq = new Set(); // keys: `${deviceId}:${seq}` (device-scoped dedupe)
  const recentFrameSeq = new Set();
  // Durable per-device watermark: the highest seq already flushed+acked. A
  // phone re-send after a lost ack must be deduped even after a backend
  // restart or a >20k-seq window rollover, so the watermark is fsynced to a
  // state file on every successful flush and rebuilt on recover.
  let lastSeqByDevice = {};
  let lastTsByDevice = {};
  let lastFrameSeqByDevice = {};
  let lastFrameTsByDevice = {};
  const liveStatePath = () => path.join(userFolder(), 'live-ingest-state.json');

  function loadLiveState() {
    try {
      const saved = JSON.parse(fs.readFileSync(liveStatePath(), 'utf8'));
      if (saved && typeof saved.last_seq === 'object' && saved.last_seq) {
        lastSeqByDevice = Object.fromEntries(
          Object.entries(saved.last_seq)
            .filter(([, v]) => Number.isFinite(Number(v)))
            .map(([k, v]) => [String(k), Number(v)])
        );
      }
      if (saved && typeof saved.last_frame_seq === 'object' && saved.last_frame_seq) {
        lastFrameSeqByDevice = Object.fromEntries(
          Object.entries(saved.last_frame_seq)
            .filter(([, v]) => Number.isFinite(Number(v)))
            .map(([k, v]) => [String(k), Number(v)])
        );
      }
      for (const [field, target] of [['last_ts', null], ['last_frame_ts', null]]) {
        const source = saved?.[field];
        if (source && typeof source === 'object') {
          const targetMap = field === 'last_ts' ? lastTsByDevice : lastFrameTsByDevice;
          for (const [k, v] of Object.entries(source)) {
            // Watermark timestamps are persisted as ms epoch numbers; accept an
            // ISO string too (Date.parse of a bare ms number yields NaN).
            const raw = String(v).trim();
            const t = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
            if (Number.isFinite(t)) targetMap[String(k)] = t;
          }
        }
      }
    } catch { /* state is advisory; WAL + day files remain authoritative */ }
  }

  function persistLiveState() {
    try {
      const tmp = `${liveStatePath()}.tmp`;
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, JSON.stringify({
          last_seq: lastSeqByDevice,
          last_ts: lastTsByDevice,
          last_frame_seq: lastFrameSeqByDevice,
          last_frame_ts: lastFrameTsByDevice,
        }));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, liveStatePath());
    } catch { /* advisory */ }
  }

  function deviceKey(row) {
    return String(row.deviceId || row.device_id || 'default');
  }

  function isDuplicateSample(row) {
    if (row.seq == null) return false;
    const seq = Number(row.seq);
    if (!Number.isFinite(seq)) return false;
    const device = String(row.deviceId || row.device_id || 'default');
    const key = `${device}:${seq}`;
    if (recentSeq.has(key)) return true;
    const watermark = Number(lastSeqByDevice[device]);
    if (Number.isFinite(watermark) && seq <= watermark) {
      // A pure seq watermark would silently drop every row from a phone whose
      // seq counter restarted (reinstall / UserDefaults wipe). A re-send
      // carries the ORIGINAL sample timestamp; a genuinely new row carries a
      // fresh one. Dedupe only when BOTH the seq and the timestamp are not
      // newer than what this device already flushed.
      const ts = Date.parse(row.datetime || row.t || '');
      const lastTs = Number(lastTsByDevice[device]);
      if (!Number.isFinite(lastTs) || !Number.isFinite(ts) || ts <= lastTs) {
        return true;
      }
    }
    recentSeq.add(key);
    if (recentSeq.size > 20_000) {
      // Drop the oldest half instead of clearing everything (Set preserves
      // insertion order) so a long in-memory window stays covered.
      const it = recentSeq.values();
      for (let i = 0; i < 10_000; i += 1) {
        const next = it.next();
        if (next.done) break;
        recentSeq.delete(next.value);
      }
    }
    return false;
  }
  let currentHour = null;
  let currentFrameHour = null;
  let flushing = false;
  let flushingFrames = false;
  let lastFlush = now().getTime();
  let lastFrameFlush = now().getTime();
  let lastSampleAt = null;

  function resolveTz() {
    try {
      return typeof timeZone === 'function' ? (timeZone() || 'UTC') : (timeZone || 'UTC');
    } catch {
      return 'UTC';
    }
  }

  function dayKey(iso) {
    return localDateKey(iso, resolveTz()) || String(iso || new Date().toISOString()).slice(0, 10);
  }

  function userFolder() {
    const safe = String(userId || 'local').replace(/[^a-zA-Z0-9_-]/g, '');
    const folder = path.join(dir, safe);
    fs.mkdirSync(folder, { recursive: true });
    return folder;
  }

  function walPath() {
    return path.join(userFolder(), 'pending-wal.ndjson');
  }

  function framesWalPath() {
    return path.join(userFolder(), 'frames-wal.ndjson');
  }

  function dayFile(day) {
    return path.join(userFolder(), `${day}.ndjson`);
  }

  function appendWal(sample) {
    // fsync + propagate: a sample is only ackable once its WAL row is durable.
    // Swallowing a WAL failure here would let routes.js ack a row that is not
    // on disk anywhere, and the phone would delete it (P1 ack-correctness).
    const fd = fs.openSync(walPath(), 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(sample)}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }

  function rewriteWal(rows) {
    try {
      const p = walPath();
      const tmp = `${p}.tmp`;
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, p);
    } catch { /* cache only */ }
  }

  function appendFramesWal(row) {
    // fsync + propagate: same ack-correctness contract as appendWal.
    const fd = fs.openSync(framesWalPath(), 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(row)}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }

  function rewriteFramesWal(rows) {
    try {
      const p = framesWalPath();
      const tmp = `${p}.tmp`;
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, p);
    } catch { /* cache only */ }
  }

  function derivedWalPath() {
    return path.join(userFolder(), 'derived-wal.ndjson');
  }

  function appendDerivedWal(rows) {
    if (!rows.length) return;
    const fd = fs.openSync(derivedWalPath(), 'a');
    try {
      fs.writeSync(fd, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }

  function rewriteDerivedWal(rows) {
    try {
      const p = derivedWalPath();
      const tmp = `${p}.tmp`;
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, p);
    } catch { /* cache only */ }
  }

  function recoverDerivedWal() {
    try {
      const p = derivedWalPath();
      if (!fs.existsSync(p)) return;
      const rows = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      pendingDerived.push(...rows);
      for (const row of rows) {
        if (row?.stream === 'events' && row.record?.kind === 'puffin_event_54') {
          const h = row.record?.envelope?.frame_hash;
          if (h) seenPuffin54.add(h);
        }
      }
    } catch { /* empty */ }
  }

  function appendDay(sample) {
    // Durable + propagate: the day file feeds metric computation directly, so
    // a failed write must not be acked as persisted (the WAL alone is not read
    // back into day files until a flush-time recompute).
    const p = dayFile(dayKey(sample.datetime));
    const fd = fs.openSync(p, 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(sample)}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }

  function readDay(day) {
    const file = dayFile(day);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  }

  function recoverWal() {
    try {
      const p = walPath();
      if (!fs.existsSync(p)) return;
      const rows = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      pending.push(...rows);
      for (const row of rows) {
        if (row?.seq != null && Number.isFinite(Number(row.seq))) {
          recentSeq.add(`${String(row.deviceId || row.device_id || 'default')}:${Number(row.seq)}`);
        }
      }
      if (rows[0]) currentHour = hourKey(rows[0].datetime);
      if (rows.length) lastSampleAt = rows[rows.length - 1].datetime;
    } catch { /* empty */ }
  }

  function recoverFramesWal() {
    try {
      const p = framesWalPath();
      if (!fs.existsSync(p)) return;
      const rows = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      pendingFrames.push(...rows);
      for (const row of rows) {
        if (row?.seq != null && Number.isFinite(Number(row.seq))) {
          recentFrameSeq.add(`${String(row.deviceId || row.device_id || 'default')}:${Number(row.seq)}`);
        }
      }
      const firstT = rows[0]?.t || rows[0]?.datetime;
      if (firstT) currentFrameHour = hourKey(firstT);
    } catch { /* empty */ }
  }

  loadLiveState();
  recoverWal();
  recoverFramesWal();
  recoverDerivedWal();

  function due(sampleHour) {
    if (!pending.length) return false;
    if (pending.length >= maxSamples) return true;
    if (sampleHour && currentHour && sampleHour !== currentHour) return true;
    if (now().getTime() - lastFlush >= chunkMs) return true;
    const first = Date.parse(pending[0].datetime);
    if (Number.isFinite(first) && now().getTime() - first >= chunkMs) return true;
    return false;
  }

  function dueFrames(frameHour) {
    if (!pendingFrames.length) return false;
    if (pendingFrames.length >= maxFrames) return true;
    if (frameHour && currentFrameHour && frameHour !== currentFrameHour) return true;
    if (now().getTime() - lastFrameFlush >= chunkMs) return true;
    const first = Date.parse(pendingFrames[0].t || pendingFrames[0].datetime);
    if (Number.isFinite(first) && now().getTime() - first >= chunkMs) return true;
    return false;
  }

  async function flushSamples() {
    if (flushing || !pending.length || !engine) return null;
    flushing = true;
    const batch = pending.splice(0, pending.length);
    const hour = currentHour;
    const gaps = openGaps.splice(0, openGaps.length);
    gaps.push(...detectSampleGaps(batch));
    currentHour = null;
    lastFlush = now().getTime();
    // Durability: do NOT trim the WAL before B2 confirms. The batch stays on
    // disk until the archive (object + manifest) lands, so a backend crash
    // mid-upload is recovered by recoverWal() instead of silently losing the
    // batch (P0 fixed 2026-08).
    const tz = resolveTz();
    try {
      inc('sensor_samples_flush', batch.length);
      const archived = await timed('b2_upload', () => engine.archiveRawSamples({
        samples: batch,
        device: batch[0],
        startAt: batch[0].datetime,
        endAt: batch[batch.length - 1].datetime,
        day: dayKey(batch[batch.length - 1].datetime),
        chunkId: uuid(),
        hourStart: hour,
        extras: {
          userId,
          timeZone: tz,
          periodDay: dayKey(batch[batch.length - 1].datetime),
          ingestGaps: gaps,
        },
      }));
      const affectedDays = [...new Set(batch
        .map((row) => localDateKey(row.datetime || row.t, tz))
        .filter(Boolean))].sort();
      const buildLiveScore = archived?.status === 'ready' ? async () => {
        const today = dayKey(now().toISOString());
        const yesterday = localDateKey(new Date(now().getTime() - 86400000), tz);
        const samples = [...readDay(yesterday), ...readDay(today)];
        if (samples.length < 20) return null;
        return timed('metric_process', () => engine.persistComputed({
          samples,
          device: batch[0],
          extras: {
            inputObjectIds: archived?.id ? [archived.id] : [],
            userId,
            timeZone: tz,
            imuRecords: pendingDerived.filter((r) => r.stream === 'imu_raw').map((r) => r.record),
            ppgRecords: pendingDerived.filter((r) => r.stream === 'ppg_raw').map((r) => r.record),
            events: pendingDerived.filter((r) => r.stream === 'events').map((r) => r.record),
            cmdBattery: pendingDerived.filter((r) => r.stream === 'cmd_battery').map((r) => r.record),
          },
        }));
      } : null;
      let computed = null;
      // Score as soon as the archive is durable. Tier 2 defers this to the
      // debounced score scheduler so ingest flush stays archive-only.
      if (!scoreAsync && buildLiveScore) {
        computed = await buildLiveScore();
      }
      if (archived?.status === 'ready' && affectedDays.length && typeof onSamplesArchived === 'function') {
        try {
          await onSamplesArchived({
            affectedDays,
            archived,
            trigger: 'live_archive',
            ...(scoreAsync && buildLiveScore ? { liveScore: buildLiveScore } : {}),
          });
        } catch (err) {
          console.error(`live_archive_recompute_failed ${userId}:`, err?.message || err);
        }
      }
      // Confirmation gate: only 'ready'/'verified' proves the object + manifest
      // landed. status 'pending' means the raw archive is disabled entirely
      // (RAW_STORE=none) — an explicit local-only mode where the fsynced day
      // files are the durable store. Anything else MUST NOT trim the WAL:
      // trimming without confirmation would ack data that exists nowhere
      // (adversarial break [2], same guard as historyBuffer's
      // history_archive_not_ready).
      if (archived?.status === 'pending' || archived?.provider === 'none') {
        inc('flush_raw_archive_disabled');
      } else if (!['ready', 'verified'].includes(archived?.status)) {
        inc('b2_upload_failures');
        throw new Error('raw_archive_not_ready');
      }
      // Archive confirmed; advance the durable per-device seq watermark so
      // re-sends of these rows are deduped even after a restart, then trim the
      // WAL. A crash between archive success and this write can at worst
      // re-upload a duplicate (deduped on replay), never lose data.
      for (const row of batch) {
        const seq = Number(row.seq);
        const ts = Date.parse(row.datetime || row.t || '');
        const device = String(row.deviceId || row.device_id || 'default');
        if (Number.isFinite(seq) && !(Number(lastSeqByDevice[device]) >= seq)) lastSeqByDevice[device] = seq;
        if (Number.isFinite(ts) && !(Number(lastTsByDevice[device]) >= ts)) lastTsByDevice[device] = ts;
      }
      persistLiveState();
      rewriteWal(pending);
      return { archived, computed, flushed: batch.length, gaps: gaps.length };
    } catch (err) {
      inc('b2_upload_failures');
      pending.unshift(...batch);
      openGaps.unshift(...gaps);
      currentHour = hour;
      throw err;
    } finally {
      flushing = false;
    }
  }

  async function flushFrames() {
    if (flushingFrames || !pendingFrames.length || !engine?.archiveRawFrames) return null;
    flushingFrames = true;
    const batch = pendingFrames.splice(0, pendingFrames.length);
    const hour = currentFrameHour;
    currentFrameHour = null;
    lastFrameFlush = now().getTime();
    // Durability: keep the frames WAL until B2 confirms (see flushSamples).
    const tz = resolveTz();
    const startAt = batch[0].t || batch[0].datetime;
    const endAt = batch[batch.length - 1].t || batch[batch.length - 1].datetime;
    let derivation = null;
    try {
      derivation = await deriveAndFlushDerived(batch, { device: batch[0], flush: false });
    } catch { /* derive is best-effort; Level A frames still archive */ }
    const imuTimes = (derivation?.imuRecords || []).map(derivedRecordIso).filter(Boolean).sort();
    const archiveStart = imuTimes[0] || startAt;
    const archiveEnd = imuTimes.at(-1) || endAt;
    try {
      inc('sensor_frames_flush', batch.length);
      const archived = await timed('b2_frames_upload', () => engine.archiveRawFrames({
        frames: batch,
        device: {
          firmware: batch[0].fw || batch[0].firmware || null,
          name: batch[0].model || null,
          externalId: batch[0].deviceId || null,
        },
        startAt: archiveStart,
        endAt: archiveEnd,
        day: dayKey(archiveEnd),
        chunkId: uuid(),
        hourStart: hour,
        extras: {
          userId,
          timeZone: tz,
          periodDay: dayKey(archiveStart),
          historyBackfill: imuTimes.length > 0,
        },
      }));
      if (archived?.status === 'pending' || archived?.provider === 'none') {
        inc('flush_raw_archive_disabled');
      } else if (!['ready', 'verified'].includes(archived?.status)) {
        inc('b2_frames_upload_failures');
        throw new Error('frames_archive_not_ready');
      }
      for (const row of batch) {
        const seq = Number(row.seq);
        const ts = Date.parse(row.t || row.datetime || '');
        const device = String(row.deviceId || row.device_id || 'default');
        if (Number.isFinite(seq) && !(Number(lastFrameSeqByDevice[device]) >= seq)) lastFrameSeqByDevice[device] = seq;
        if (Number.isFinite(ts) && !(Number(lastFrameTsByDevice[device]) >= ts)) lastFrameTsByDevice[device] = ts;
      }
      persistLiveState();
      rewriteFramesWal(pendingFrames);
      // Derived streams were extracted before the Level A PUT so history IMU
      // can be keyed by strap time. Flush them only after frames are durable.
      const derived = derivation?.summary || null;
      let computed = null;
      try {
        await flushDerived({ device: batch[0] });
      } catch {
        inc('derived_records_flush_failures');
      }
      try {
        if (derivation?.imuRecords?.length && engine?.persistComputed) {
          const imuDays = [...new Set(
            (derivation.imuRecords || [])
              .map((r) => localDateKey(derivedRecordIso(r), tz))
              .filter(Boolean)
          )].sort();
          const buildFrameLiveScore = async () => {
            const today = dayKey(now().toISOString());
            const yesterday = localDateKey(new Date(now().getTime() - 86400000), tz);
            const samples = [...readDay(yesterday), ...readDay(today)];
            if (samples.length < 20) return null;
            return timed('metric_process_after_imu', () => engine.persistComputed({
              samples,
              device: batch[0],
              extras: {
                userId,
                timeZone: tz,
                imuRecords: derivation.imuRecords,
                ppgRecords: derivation.ppgRecords || [],
                events: derivation.eventRecords || [],
                cmdBattery: derivation.cmdBattery || [],
              },
            }));
          };
          if (scoreAsync) {
            if (typeof onScoreRequested === 'function') {
              Promise.resolve(onScoreRequested({
                affectedDays: imuDays.length ? imuDays : [dayKey(archiveEnd)],
                trigger: 'frames_derived',
                liveScore: buildFrameLiveScore,
              })).catch((err) => {
                console.error(`frame_score_enqueue_failed ${userId}:`, err?.message || err);
              });
            }
          } else {
            computed = await buildFrameLiveScore();
          }
        }
      } catch (err) {
        inc('steps_v3_live_recompute_failures');
      }
      return {
        archived,
        flushed: batch.length,
        derived,
        computed,
      };
    } catch (err) {
      inc('b2_frames_upload_failures');
      pendingFrames.unshift(...batch);
      currentFrameHour = hour;
      throw err;
    } finally {
      flushingFrames = false;
    }
  }

  /**
   * Derive records from a frame batch, enqueue to the derived WAL, and try to
   * flush everything pending. Returns the batch derivation summary or null.
   */
  async function deriveAndFlushDerived(batch, { device, flush = true } = {}) {
    if (!engine?.archiveDerivedStream) return null;
    const { imu, ppg, events, console: consoleLogs, battery, session, whoop5Imu, whoop5Ppg, whoop5Optical } = deriveRecords(batch, {
      reassemblers: deriveReassemblers,
      reset: false,
      seenPuffin54,
    });
    const tagged = [
      ...imu.map((r) => ({ stream: 'imu_raw', record: r })),
      ...ppg.map((r) => ({ stream: 'ppg_raw', record: r })),
      ...(whoop5Imu || []).map((r) => ({ stream: 'whoop5_imu_v21', record: r })),
      ...(whoop5Ppg || []).map((r) => ({ stream: 'whoop5_ppg_v26', record: r })),
      ...(whoop5Optical || []).map((r) => ({ stream: 'whoop5_optical_v20', record: r })),
      ...events.map((r) => ({ stream: 'events', record: r })),
      ...consoleLogs.map((r) => ({ stream: 'console_logs', record: r })),
      ...battery.map((r) => ({ stream: 'cmd_battery', record: r })),
    ];
    if (tagged.length) {
      appendDerivedWal(tagged);
      pendingDerived.push(...tagged);
      inc('derived_records_extracted', tagged.length);
    }
    if (flush) await flushDerived({ device });
    return {
      summary: {
        imu: imu.length,
        ppg: ppg.length,
        whoop5_imu_v21: (whoop5Imu || []).length,
        whoop5_ppg_v26: (whoop5Ppg || []).length,
        whoop5_optical_v20: (whoop5Optical || []).length,
        events: events.length,
        console: consoleLogs.length,
        battery: battery.length,
        census: session,
      },
      imuRecords: imu,
      ppgRecords: ppg,
      eventRecords: events,
      cmdBattery: battery,
    };
  }

  /**
   * Flush pendingDerived to B2, grouped per stream. Content-addressed object
   * ids make re-flushes idempotent; the WAL is trimmed only after each
   * stream's archive reports ready/verified (or raw-archive disabled).
   */
  async function flushDerived({ device } = {}) {
    if (flushingDerived || !pendingDerived.length || !engine?.archiveDerivedStream) return null;
    flushingDerived = true;
    const work = pendingDerived.splice(0, pendingDerived.length);
    const tz = resolveTz();
    const byStream = new Map();
    for (const row of work) {
      if (!row?.stream || !row?.record) continue;
      if (!byStream.has(row.stream)) byStream.set(row.stream, []);
      byStream.get(row.stream).push(row.record);
    }
    const results = {};
    const failed = [];
    try {
      for (const [stream, records] of byStream) {
        if (!records.length) continue;
        const specs = DERIVED_STREAM_SPECS[stream];
        if (!specs) continue;
        const batches = HOURLY_DERIVED_STREAMS.has(stream)
          ? groupDerivedByHour(records)
          : [records];
        for (const group of batches) {
          if (!group.length) continue;
          const times = group.map(derivedRecordIso).filter(Boolean).sort();
          const startAt = times[0] || group[0]?.received_at || null;
          const endAt = times.at(-1) || group[group.length - 1]?.received_at || null;
          try {
            const archived = await timed(`b2_${stream}_upload`, () => engine.archiveDerivedStream({
              records: group,
              stream,
              format: specs.format,
              schemaVersion: specs.schemaVersion,
              device: {
                firmware: group[0]?.firmware?.fw || null,
                name: group[0]?.firmware?.model || null,
                externalId: device?.deviceId || device?.externalId || group[0]?.transport?.char || null,
              },
              startAt,
              endAt,
              extras: { userId, timeZone: tz, periodDay: dayKey(startAt || now().toISOString()) },
            }));
            results[stream] = archived?.status || results[stream] || null;
            if (archived?.status === 'pending' || archived?.provider === 'none') {
              inc('flush_raw_archive_disabled');
            } else if (!['ready', 'verified'].includes(archived?.status)) {
              throw new Error(`${stream}_archive_not_ready`);
            }
          } catch {
            failed.push(...group.map((record) => ({ stream, record })));
          }
        }
      }
      // Keep only records whose stream batch did not land. On partial success
      // this re-uploads surviving duplicates (content-addressed, idempotent).
      pendingDerived.unshift(...failed);
      rewriteDerivedWal(pendingDerived);
      return results;
    } catch (err) {
      pendingDerived.unshift(...failed.length ? failed : [...byStream].flatMap(([stream, records]) => records.map((record) => ({ stream, record }))));
      rewriteDerivedWal(pendingDerived);
      throw err;
    } finally {
      flushingDerived = false;
    }
  }

  async function flush() {
    let samples = null;
    let frames = null;
    let sampleErr = null;
    let frameErr = null;
    try { samples = await flushSamples(); } catch (err) { sampleErr = err; }
    try { frames = await flushFrames(); } catch (err) { frameErr = err; }
    // Recovered derived records (e.g. after a restart) drain on every flush,
    // independent of sample/frame success.
    try { await flushDerived(); } catch { /* derived WAL retries later */ }
    if (sampleErr) throw sampleErr;
    if (frameErr) throw frameErr;
    return {
      archived: samples?.archived,
      computed: samples?.computed,
      flushed: samples?.flushed || 0,
      gaps: samples?.gaps || 0,
      frames,
    };
  }

  return {
    append(sample) {
      const motion = Number(sample.motion);
      const row = {
        datetime: sample.datetime || sample.at || sample.t || now().toISOString(),
        bpm: Number(sample.bpm ?? sample.heartRate),
        rr_ms: Array.isArray(sample.rr_ms || sample.rrIntervals) ? (sample.rr_ms || sample.rrIntervals) : [],
        sleep_stage: sample.sleep_stage || null,
        // Archived, not just handed to the live detector: the energy model reads motion
        // back out of B2 to recompute history, so dropping it here makes every
        // motion-aware estimate unreproducible.
        motion: Number.isFinite(motion) ? motion : null,
        phoneMotion: optionalFinite(sample.phoneMotion ?? sample.phone_motion),
        strapMotion: optionalFinite(sample.strapMotion ?? sample.strap_motion),
        battery: sample.battery ?? null,
        // Core-health signals forwarded from the iOS decoder (reusing NOOP's
        // WHOOP5 step/temperature decode). Null when absent; the archive and
        // metrics engine validate ranges and never fabricate a value.
        steps: optionalFinite(sample.steps),
        step_cumulative: optionalFinite(
          sample.step_cumulative ?? sample.stepCounter ?? sample.step_motion_counter,
        ),
        step_cadence: optionalFinite(sample.step_cadence),
        activity_class: optionalFinite(sample.activity_class),
        skin_temp_c: optionalFinite(sample.skin_temp_c),
        connected: Boolean(sample.connected),
        deviceId: sample.deviceId || sample.externalId || null,
        name: sample.name || null,
        firmware: sample.firmware || null,
        src: sample.src || 'ble_hr',
        seq: sample.seq ?? null,
        connection_epoch: sample.connection_epoch ?? sample.connectionEpoch ?? null,
        rr_continuity: sample.rr_continuity ?? sample.rrContinuity ?? null,
        family: sample.family || null,
        packet_type: sample.packet_type ?? sample.packetType ?? null,
        packet_seq: sample.packet_seq ?? sample.packetSeq ?? sample.packetSequence ?? null,
        decoder: sample.decoder || null,
        sensor_ts_subsec: sample.sensor_ts_subsec ?? sample.sensorTsSubsec ?? null,
        raw_rr_count: sample.raw_rr_count ?? sample.rawRRCount ?? null,
        wear_location: (() => {
          const v = String(sample.wear_location ?? sample.wearLocation ?? '').trim().toLowerCase();
          return v === 'bicep' || v === 'wrist' ? v : null;
        })(),
        wear_location_source: sample.wear_location_source === 'legacy_default'
          ? 'legacy_default'
          : ((() => {
            const v = String(sample.wear_location ?? sample.wearLocation ?? '').trim().toLowerCase();
            return v === 'bicep' || v === 'wrist' ? 'user' : null;
          })()),
      };
      if (!Number.isFinite(row.bpm) && !row.rr_ms.length) {
        inc('sensor_samples_dropped');
        noteReject('no_hr');
        return { ...row, _ingest_reject: 'no_hr' };
      }
      if (isDuplicateSample(row)) {
        noteReject('duplicate_seq');
        return { ...row, _ingest_reject: 'duplicate_seq' };
      }
      if (lastSampleAt) {
        const dt = Date.parse(row.datetime) - Date.parse(lastSampleAt);
        if (Number.isFinite(dt) && dt >= 10_000) {
          openGaps.push({
            kind: sample.connected === false ? 'connection' : 'missing_interval',
            start_at: lastSampleAt,
            end_at: row.datetime,
            expected_samples: Math.max(0, Math.round(dt / 4000) - 1),
            received_samples: 0,
            sample_seq_start: sample.seq ?? null,
          });
        }
      }
      lastSampleAt = row.datetime;
      inc('sensor_samples_received');
      appendDay(row);
      const h = hourKey(row.datetime);
      if (due(h)) flushSamples().catch((err) => { inc('b2_upload_failures'); safeError(err); });
      pending.push(row);
      appendWal(row);
      if (!currentHour) currentHour = h;
      if (due(null)) flushSamples().catch(() => {});
      return row;
    },
    appendFrame(frame) {
      const row = normalizeFrame(frame, now().toISOString());
      if (!row) {
        inc('sensor_frames_dropped');
        return null;
      }
      if (row.seq != null) {
        const seq = Number(row.seq);
        if (Number.isFinite(seq)) {
          const device = String(row.deviceId || row.device_id || 'default');
          if (recentFrameSeq.has(`${device}:${seq}`)) return row;
          const frameWatermark = Number(lastFrameSeqByDevice[device]);
          if (Number.isFinite(frameWatermark) && seq <= frameWatermark) {
            // Same reinstall guard as samples: a re-send carries the ORIGINAL
            // timestamp; a restarted counter carries a fresh one.
            const fts = Date.parse(row.t || row.datetime || '');
            const lastFts = Number(lastFrameTsByDevice[device]);
            if (!(Number.isFinite(lastFts) && Number.isFinite(fts) && fts <= lastFts)) {
              // not a re-send
            } else {
              return row;
            }
          }
          recentFrameSeq.add(`${device}:${seq}`);
          if (recentFrameSeq.size > 50_000) {
            // Evict the oldest half, not everything: a full clear() drops the
            // dedupe window mid-session exactly when a long-unacked backlog
            // re-sends (adversarial break [6]).
            const it = recentFrameSeq.values();
            for (let i = 0; i < 25_000; i += 1) {
              const next = it.next();
              if (next.done) break;
              recentFrameSeq.delete(next.value);
            }
          }
        }
      }
      inc('sensor_frames_received');
      const h = hourKey(row.t);
      if (dueFrames(h)) flushFrames().catch((err) => { inc('b2_frames_upload_failures'); safeError(err); });
      pendingFrames.push(row);
      appendFramesWal(row);
      if (!currentFrameHour) currentFrameHour = h;
      if (dueFrames(null)) flushFrames().catch(() => {});
      return row;
    },
    recordGap(gap) {
      if (gap?.kind && gap.start_at && gap.end_at) openGaps.push({
        id: gap.id || undefined,
        kind: gap.kind,
        start_at: gap.start_at,
        end_at: gap.end_at,
        expected_samples: gap.expected_samples ?? 0,
        received_samples: gap.received_samples ?? 0,
        sample_seq_start: gap.sample_seq_start ?? null,
        sample_seq_end: gap.sample_seq_end ?? null,
        meta: gap.meta && typeof gap.meta === 'object' ? gap.meta : {},
      });
    },
    samplesFor(day) {
      return readDay(day || dayKey(now().toISOString()));
    },
    pendingCount() {
      return pending.length;
    },
    async flushDerived() {
      return flushDerived();
    },
    pendingFrameCount() {
      return pendingFrames.length;
    },
    gapCount() {
      return openGaps.length;
    },
    gaps() {
      return [...openGaps];
    },
    stats() {
      return {
        pending_samples: pending.length,
        pending_frames: pendingFrames.length,
        gap_count: openGaps.length,
        last_sample_at: lastSampleAt,
        current_hour: currentHour,
        current_frame_hour: currentFrameHour,
        last_seq: { ...lastSeqByDevice },
        last_ts: { ...lastTsByDevice },
        last_frame_seq: { ...lastFrameSeqByDevice },
        last_frame_ts: { ...lastFrameTsByDevice },
      };
    },
    currentHour: () => currentHour,
    flush,
    /**
     * Safety net for the append-driven flush: a strap that goes quiet mid-hour
     * would otherwise strand its buffered samples until the next sample or a
     * restart. Only flushes what append() would already consider due, so the
     * hour batching is preserved.
     */
    async flushIfDue() {
      let samples = null;
      let frames = null;
      let sampleErr = null;
      if (due(null)) {
        try { samples = await flushSamples(); } catch (err) { sampleErr = err; }
      }
      if (dueFrames(null)) {
        try { frames = await flushFrames(); } catch { /* independent of samples */ }
      }
      if (sampleErr) throw sampleErr;
      return { samples, frames };
    },
    recoverWal,
    recoverFramesWal,
  };
}
