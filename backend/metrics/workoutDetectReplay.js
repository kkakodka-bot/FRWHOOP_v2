/**
 * Deterministic V1/V2 workout-detector replay. No I/O.
 * Freeze V1 as baseline; V2 is the candidate under test.
 */
import { createWorkoutDetector } from './workoutDetector.js';
import {
  createWorkoutDetectorV2,
  FEATURE_SCHEMA_VERSION,
  WORKOUT_DETECT_V2_VERSION,
} from './workoutDetectV2.js';
import { decodeFrame, DECODER_VERSION } from '../protocol/decoder.js';
import { verifyFrame } from '../protocol/framing.js';
import { strapTimeMs } from '../time/strapTime.js';

export const REPLAY_VERSION = '1.1.0';
export const TYPE40_REPLAY_VERSION = '1.1.0';
export const REPLAY_UNAVAILABLE = Object.freeze([
  'phoneMotion',
  'strapMotion',
  'dynAccel',
  'gravity',
  'steps',
  'cadence',
  'gyro',
  'type43_imu',
]);

export const LABELED_WINDOWS = Object.freeze([
  { id: 'w1', day: '2026-08-30', start: '16:46', end: '17:48', sport: 'strength' },
  { id: 'w2', day: '2026-08-29', start: '18:50', end: '19:51', sport: 'strength' },
  { id: 'w3', day: '2026-08-28', start: '21:02', end: '21:53', sport: 'strength' },
  { id: 'w4', day: '2026-08-27', start: '22:02', end: '23:05', sport: 'indoor_walk' },
  { id: 'w5', day: '2026-08-26', start: '22:02', end: '23:12', sport: 'strength' },
  { id: 'w6', day: '2026-08-25', start: '22:32', end: '23:35', sport: 'strength' },
]);

function tsOf(s) {
  if (typeof s?.ts === 'number' && Number.isFinite(s.ts)) return s.ts;
  const t = Date.parse(s?.datetime || s?.at || s?.t || '');
  return Number.isFinite(t) ? t : null;
}

function overlap(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

function coverageOf(samples, start, end) {
  const inW = samples.filter((s) => {
    const t = tsOf(s);
    return t != null && t >= start && t < end;
  });
  const has = (pred) => inW.filter(pred).length;
  return {
    n: inW.length,
    hr: has((s) => Number.isFinite(Number(s.bpm ?? s.heartRate))),
    rr: has((s) => (s.rr_ms || s.rrIntervals || []).length),
    motion: has((s) => Number.isFinite(Number(s.motion ?? s.mot))),
    phoneMotion: has((s) => Number.isFinite(Number(s.phoneMotion ?? s.phone_motion))),
    strapMotion: has((s) => Number.isFinite(Number(s.strapMotion ?? s.strap_motion))),
    dynAccel: has((s) => Number.isFinite(Number(s.dyn_accel ?? s.dynAccel))),
    gravity: has((s) => s.gx != null && s.gy != null && s.gz != null),
    steps: has((s) => Number.isFinite(Number(s.steps ?? s.step_cadence))),
    cadence: has((s) => Number.isFinite(Number(s.cadence ?? s.step_cadence))),
    gyro: has((s) => Number.isFinite(Number(s.gyroRms ?? s.gyro_rms))),
  };
}

function runDetector(create, samples, { restingHr, maxHr, padStart, padEnd }) {
  const events = [];
  const det = create({
    thresholds: () => ({ restingHr, maxHr }),
    onEvent: (e) => events.push(e),
    now: () => padEnd,
  });
  let last = det.snapshot();
  for (const s of samples) {
    const t = tsOf(s);
    if (t == null || t < padStart || t > padEnd) continue;
    last = det.ingest({
      ts: t,
      bpm: s.bpm ?? s.heartRate,
      motion: s.motion ?? s.mot,
      phoneMotion: s.phoneMotion ?? s.phone_motion,
      strapMotion: s.strapMotion ?? s.strap_motion,
      dyn_accel: s.dyn_accel ?? s.dynAccel,
      rr_ms: s.rr_ms || s.rrIntervals,
      steps: s.steps,
      step_cadence: s.step_cadence ?? s.cadence,
      gx: s.gx,
      gy: s.gy,
      gz: s.gz,
      src: s.src,
      motionSource: s.motionSource || s.motion_source,
      historical: s.historical,
      origin: s.origin,
      sourceOrigin: s.sourceOrigin || s.origin,
      executionContext: s.executionContext || 'replay',
      phoneMotionLive: s.phoneMotionLive,
      gyroRms: s.gyroRms ?? s.gyro_rms,
      nativeV2: s.nativeV2,
    });
  }
  det.tick(padEnd);
  return { events, last, traces: typeof det.traces === 'function' ? det.traces() : null };
}

function summarize(run, start, end) {
  const starts = run.events.filter((e) => e.type === 'workout_start');
  const ends = run.events.filter((e) => e.type === 'workout_end');
  const hits = starts.filter((e) => overlap(e.workout.effectiveStartTs || e.workout.onsetTs, e.ts, start, end)
    || ends.some((x) => overlap(x.workout.startTs, x.workout.endTs, start, end)));
  const hit = hits[0] || null;
  return {
    hit: Boolean(hit),
    path: hit?.workout?.confirmPath || null,
    reason: hit?.workout?.confirmReason || null,
    sport: hit?.workout?.sport || null,
    onsetTs: hit?.workout?.effectiveStartTs || hit?.workout?.onsetTs || null,
    confirmedTs: hit?.workout?.confirmedTs || hit?.ts || null,
    scores: hit?.workout?.scores || run.last.scores || null,
    physReady: run.last.physReady,
    detectorState: run.last.detectorState,
    confirmReason: hit?.workout?.confirmReason || null,
    failReason: hit ? null : (run.last.scores?.reason || run.last.lastRejection || run.last.detectorState || null),
    lane: hit?.workout?.lane || run.last.lane || null,
    modalityTier: hit?.workout?.modalityTier || run.last.modalityTier || null,
  };
}

function missReason({ samples, start, end, summary, which }) {
  const inBout = samples.filter((s) => {
    const t = tsOf(s);
    return t != null && t >= start && t < end;
  });
  if (!inBout.length) return 'live_signal_gap';
  if (summary.hit) return null;
  if (summary.physReady === false) return 'missing_physiology_rhr';
  if (summary.detectorState === 'IDLE') return 'active_floor_failure';
  if (which === 'v1') return 'v1_unconfirmed';
  return summary.scores?.reason || 'v2_unconfirmed';
}

export function evaluateWindow({
  samples,
  start,
  end,
  restingHr,
  maxHr,
  padMin = 45,
} = {}) {
  const padStart = start - padMin * 60_000;
  const padEnd = end + padMin * 60_000;
  const v1 = summarize(runDetector(createWorkoutDetector, samples, {
    restingHr, maxHr, padStart, padEnd,
  }), start, end);
  const v2run = runDetector(createWorkoutDetectorV2, samples, {
    restingHr, maxHr, padStart, padEnd,
  });
  const v2 = summarize(v2run, start, end);
  const coverage = coverageOf(samples, start, end);
  const durationS = Math.max(1, (end - start) / 1000);
  const row = (s, which) => ({
    ...s,
    miss: missReason({ samples, start, end, summary: s, which }),
    latencyS: s.hit && s.confirmedTs != null ? Math.round((s.confirmedTs - start) / 1000) : null,
    onsetErrorS: s.hit && s.onsetTs != null ? Math.round((s.onsetTs - start) / 1000) : null,
  });
  const a = row(v1, 'v1');
  const b = row(v2, 'v2');
  const unavailable = REPLAY_UNAVAILABLE.filter((k) => {
    if (k === 'type43_imu') return coverage.dynAccel === 0 && coverage.gyro === 0;
    return (coverage[k] || 0) === 0;
  });
  return {
    coverage,
    unavailable,
    durationS,
    v1: a,
    v2: b,
    disagree: a.hit !== b.hit || (a.hit && b.hit && a.sport !== b.sport),
    feature_schema_version: FEATURE_SCHEMA_VERSION,
    detector_version: WORKOUT_DETECT_V2_VERSION,
    traces: v2run.traces,
  };
}

export function series({
  t0, seconds, bpm, motion, phoneMotion, strapMotion, cadence, steps, historical, motionSource,
} = {}) {
  const out = [];
  for (let i = 0; i < seconds; i += 1) {
    const rec = { ts: t0 + i * 1000 };
    if (typeof bpm === 'function') rec.bpm = bpm(i);
    else if (bpm != null) rec.bpm = bpm;
    if (typeof motion === 'function') rec.motion = motion(i);
    else if (motion != null) rec.motion = motion;
    if (typeof phoneMotion === 'function') rec.phoneMotion = phoneMotion(i);
    else if (phoneMotion != null) rec.phoneMotion = phoneMotion;
    if (typeof strapMotion === 'function') rec.strapMotion = strapMotion(i);
    else if (strapMotion != null) rec.strapMotion = strapMotion;
    if (rec.motion == null && rec.phoneMotion != null) rec.motion = rec.phoneMotion;
    if (cadence != null) rec.step_cadence = typeof cadence === 'function' ? cadence(i) : cadence;
    if (steps != null) rec.steps = typeof steps === 'function' ? steps(i) : steps;
    if (historical) rec.historical = true;
    if (motionSource) rec.motionSource = motionSource;
    out.push(rec);
  }
  return out;
}

function liftPulse(i, setS, cycle) {
  const p = i % cycle;
  if (p < setS) return 0.11 + 0.03 * Math.abs(Math.sin((2 * Math.PI * 0.4 * i)));
  return 0.012;
}

/** Set/rest lifting at 1 Hz on the wrist. Phone-only copy is phoneOnlySetRest. */
export function strengthSetRest({ t0, minutes = 8, hr = 92 } = {}) {
  const setS = 28;
  const restS = 42;
  const cycle = setS + restS;
  const pulse = (i) => liftPulse(i, setS, cycle);
  return series({
    t0,
    seconds: minutes * 60,
    bpm: hr,
    strapMotion: pulse,
    motion: pulse,
    motionSource: 'wrist_imu_51',
  });
}

export function phoneOnlySetRest({ t0, minutes = 8, hr = 92 } = {}) {
  const setS = 28;
  const restS = 42;
  const cycle = setS + restS;
  return series({
    t0,
    seconds: minutes * 60,
    bpm: hr,
    phoneMotion: (i) => liftPulse(i, setS, cycle),
  });
}

export function stairs({ t0, minutes = 3, hr = 118 } = {}) {
  return series({ t0, seconds: minutes * 60, bpm: hr, phoneMotion: 0.18, cadence: 90, steps: 1.4 });
}

export function driving({ t0, minutes = 20, hr = 78 } = {}) {
  return series({
    t0,
    seconds: minutes * 60,
    bpm: hr,
    phoneMotion: (i) => 0.04 + 0.02 * Math.abs(Math.sin(i / 9)),
  });
}

export function ordinaryWalk({ t0, minutes = 12, hr = 88 } = {}) {
  return series({ t0, seconds: minutes * 60, bpm: hr, phoneMotion: 0.14, cadence: 100, steps: 1.5 });
}

export function sleepWake({ t0, minutes = 15 } = {}) {
  return series({
    t0,
    seconds: minutes * 60,
    bpm: (i) => (i < 600 ? 52 : 68 + Math.min(20, (i - 600) / 10)),
    phoneMotion: 0.01,
  });
}

export function walkCadence({ t0, minutes = 8, hr = 98 } = {}) {
  return series({
    t0,
    seconds: minutes * 60,
    bpm: hr,
    phoneMotion: 0.22,
    cadence: 110,
    steps: 1.8,
  });
}

/** Trusted live strap gait + cadence. Phone copy is walkCadence. */
export function strapWalk({ t0, minutes = 8, hr = 100, cadence = 110 } = {}) {
  return series({
    t0,
    seconds: minutes * 60,
    bpm: hr,
    strapMotion: 0.2,
    phoneMotion: 0.18,
    cadence,
    steps: 1.7,
    motionSource: 'wrist_imu_51',
  });
}

export function cyclingQuietWrist({ t0, minutes = 12, hr = 140 } = {}) {
  return series({
    t0,
    seconds: minutes * 60,
    bpm: hr,
    strapMotion: 0.02,
    motionSource: 'wrist_imu_51',
  });
}

export function choresStrap({ t0, minutes = 10, hr = 82 } = {}) {
  return series({
    t0,
    seconds: minutes * 60,
    bpm: hr,
    strapMotion: (i) => 0.04 + 0.03 * ((i * 13) % 10) / 10,
    motionSource: 'wrist_imu_51',
  });
}

export function stressHr({ t0, minutes = 10, hr = 135 } = {}) {
  return series({ t0, seconds: minutes * 60, bpm: hr, phoneMotion: 0.01 });
}

export function noisyDesk({ t0, minutes = 8 } = {}) {
  return series({
    t0,
    seconds: minutes * 60,
    bpm: 72,
    phoneMotion: (i) => 0.03 + 0.02 * ((i * 17) % 10) / 10,
  });
}

function hexToBytes(hex) {
  const s = String(hex || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!s || s.length % 2) return [];
  const out = [];
  for (let i = 0; i < s.length; i += 2) out.push(Number.parseInt(s.slice(i, i + 2), 16));
  return out;
}

const TRUST_UNIX_MIN = 1_500_000_000;
const TRUST_UNIX_MAX = 2_200_000_000;

/**
 * Evaluation-only type-40 HR from Level A/B notify rows. No motion/IMU/steps.
 * Timestamp: trustworthy strap unix, else notify receive time.
 */
export function type40SamplesFromFrames(rows) {
  const samples = [];
  const stats = {
    raw_type40: 0,
    crc_valid: 0,
    hr_decoded: 0,
    ts_sensor: 0,
    ts_receive: 0,
    decoder: DECODER_VERSION,
  };
  for (const row of rows || []) {
    const bytes = hexToBytes(row.hex);
    if (!bytes.length) continue;
    const family = row.family === 'harvard' ? 'harvard' : 'puffin';
    const rec = decodeFrame(bytes, family);
    if (rec.packet_type !== 40) continue;
    stats.raw_type40 += 1;
    const crc = rec.crc_ok !== false && verifyFrame(bytes, family).ok;
    if (!crc) continue;
    stats.crc_valid += 1;
    const hr = rec.decoded?.heart_rate ?? rec.decoded?.hr;
    if (!Number.isFinite(hr)) continue;
    stats.hr_decoded += 1;
    const sensorUnix = Number(rec.decoded?.timestamp);
    const receiveMs = Date.parse(row.t || row.datetime || row.received_at || '');
    let ts;
    let timestamp_source;
    if (Number.isFinite(sensorUnix) && sensorUnix >= TRUST_UNIX_MIN && sensorUnix <= TRUST_UNIX_MAX) {
      ts = rec.decoded?.sensor_time_ms
        ?? strapTimeMs(sensorUnix, rec.decoded?.subseconds)
        ?? sensorUnix * (sensorUnix > 1e12 ? 1 : 1000);
      timestamp_source = 'sensor';
      stats.ts_sensor += 1;
    } else if (Number.isFinite(receiveMs)) {
      ts = receiveMs;
      timestamp_source = 'receive';
      stats.ts_receive += 1;
    } else {
      continue;
    }
    samples.push({
      ts,
      datetime: new Date(ts).toISOString(),
      bpm: hr,
      rr_ms: Array.isArray(rec.decoded?.rr_intervals) ? rec.decoded.rr_intervals : [],
      raw_rr_count: rec.decoded?.rr_count_declared ?? null,
      src: row.source || 'whoop_type40',
      family,
      packet_type: 40,
      packet_seq: rec.decoded?.packet_sequence ?? rec.version ?? row.seq ?? null,
      frame_hash: rec.frame_hash,
      decoder: rec.decoder,
      timestamp_source,
      receive_t: Number.isFinite(receiveMs) ? new Date(receiveMs).toISOString() : null,
      seq: row.seq ?? null,
      char: row.char || null,
    });
  }
  samples.sort((a, b) => a.ts - b.ts || String(a.frame_hash).localeCompare(String(b.frame_hash)));
  return { samples, stats, side_effects: [] };
}

export function labeledBoundsMs(w) {
  const start = Date.parse(`${w.day}T${w.start}:00-07:00`);
  const end = Date.parse(`${w.day}T${w.end}:00-07:00`);
  return { start, end };
}

export const CAPTURE_GAP_CLASSES = Object.freeze([
  'strap_not_connected',
  'custom_stream_missing',
  'gatt_fallback_available',
  'app_suspended',
  'process_terminated',
  'queue_write_failed',
  'raw_archive_missing',
  'unknown_capture_gap',
]);

export const GATT_STALE_AFTER_MS = 10_000;

/** Standard 0x180D/2A37 Heart Rate Measurement. Matches iOS parseHeartRate. */
export function parseGattHeartRate(bytes) {
  const b = Array.isArray(bytes) ? bytes : [];
  if (!b.length) return null;
  if (b.length === 1) {
    const bpm = b[0];
    return bpm >= 20 && bpm <= 240 ? { bpm, rrMs: [] } : null;
  }
  const flags = b[0];
  const hr16 = (flags & 0x01) !== 0;
  let offset = 1;
  let bpm;
  if (hr16) {
    if (b.length < 3) return null;
    bpm = b[1] | (b[2] << 8);
    offset = 3;
  } else if (b.length >= 2) {
    bpm = b[1];
    offset = 2;
  } else return null;
  if (flags & 0x08) offset += 2;
  const rrMs = [];
  if (flags & 0x10) {
    while (offset + 1 < b.length) {
      const raw = b[offset] | (b[offset + 1] << 8);
      offset += 2;
      const ms = Math.round((raw * 1000) / 1024);
      if (ms >= 200 && ms <= 2500) rrMs.push(ms);
    }
  }
  if (bpm >= 20 && bpm <= 240) return { bpm, rrMs };
  const fallback = flags;
  return fallback >= 20 && fallback <= 240 ? { bpm: fallback, rrMs } : null;
}

function isGattHrRow(row) {
  const fam = String(row?.family || '').toLowerCase();
  const ch = String(row?.char || '').replace(/-/g, '').toUpperCase();
  return fam === 'gatt' || ch.endsWith('2A37') || ch === '2A37';
}

export function gattSamplesFromFrames(rows) {
  const samples = [];
  const stats = { raw_gatt: 0, hr_decoded: 0 };
  for (const row of rows || []) {
    if (!isGattHrRow(row)) continue;
    stats.raw_gatt += 1;
    const parsed = parseGattHeartRate(hexToBytes(row.hex));
    if (!parsed) continue;
    stats.hr_decoded += 1;
    const ts = Date.parse(row.t || row.datetime || row.received_at || '');
    if (!Number.isFinite(ts)) continue;
    samples.push({
      ts,
      datetime: new Date(ts).toISOString(),
      bpm: parsed.bpm,
      rr_ms: parsed.rrMs,
      src: 'gatt_hr',
      family: 'gatt',
      timestamp_source: 'receive',
      seq: row.seq ?? null,
      char: row.char || null,
    });
  }
  samples.sort((a, b) => a.ts - b.ts);
  return { samples, stats };
}

/** Prefer type-40; take 2A37 only when custom is missing or stale. No 1s bpm dupes. */
export function mergeHrReplay(type40Samples, gattSamples, { staleAfterMs = GATT_STALE_AFTER_MS } = {}) {
  const custom = [...(type40Samples || [])].sort((a, b) => a.ts - b.ts);
  const gatt = [...(gattSamples || [])].sort((a, b) => a.ts - b.ts);
  const out = custom.map((s) => ({ ...s, src: s.src || 'type40_replay' }));
  let lastCustomTs = custom.length ? custom[0].ts : null;
  let ci = 0;
  for (const g of gatt) {
    while (ci < custom.length && custom[ci].ts <= g.ts) {
      lastCustomTs = custom[ci].ts;
      ci += 1;
    }
    const age = lastCustomTs == null ? Infinity : g.ts - lastCustomTs;
    if (age < staleAfterMs) continue;
    const last = out[out.length - 1];
    if (last && g.bpm === last.bpm && Math.abs(g.ts - last.ts) < 1000) continue;
    out.push(g);
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

export function classifyCaptureWindow({
  objectCount = 0,
  type40Count = 0,
  gattHrCount = 0,
  connected = null,
  disconnectWithoutReconnect = false,
  appSuspended = false,
  processTerminated = false,
  queueWriteFailed = false,
  anyNotify = false,
} = {}) {
  if (queueWriteFailed) return 'queue_write_failed';
  if (processTerminated && type40Count === 0 && gattHrCount === 0) return 'process_terminated';
  if (objectCount === 0 && type40Count === 0 && gattHrCount === 0 && !anyNotify) {
    return 'raw_archive_missing';
  }
  if (disconnectWithoutReconnect || connected === false) return 'strap_not_connected';
  if (type40Count === 0 && gattHrCount > 0) return 'gatt_fallback_available';
  if (type40Count === 0 && gattHrCount === 0 && appSuspended) return 'app_suspended';
  if (type40Count === 0 && (connected === true || anyNotify)) return 'custom_stream_missing';
  if (type40Count === 0 && gattHrCount === 0) return 'unknown_capture_gap';
  return null;
}

/** HR-only set/rest pulses. Freeze as the w5_neg false-positive shape (no motion). */
export function hrOnlySetRestPulses({ t0, minutes = 12, workHr = 105, restHr = 72 } = {}) {
  const setS = 25;
  const restS = 45;
  const cycle = setS + restS;
  return series({
    t0,
    seconds: minutes * 60,
    bpm: (i) => ((i % cycle) < setS ? workHr : restHr),
  });
}

export function productionMissCause({
  rawType40 = 0,
  gattHr = 0,
  physiologyHr = 0,
  reconstructedHr = 0,
  captureClass = null,
} = {}) {
  const raw = (rawType40 || 0) + (gattHr || 0);
  const reconstructed = reconstructedHr || 0;
  if (!raw && !reconstructed) return captureClass || 'unknown_capture_gap';
  if (physiologyHr > 0 && raw > 0) return 'detector';
  if (raw > 0 && physiologyHr === 0) return 'ingestion';
  return 'both';
}
