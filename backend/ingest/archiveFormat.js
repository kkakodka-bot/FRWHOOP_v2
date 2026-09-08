import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { classifySpo2Byte } from '../protocol/spo2.js';

export const ARCHIVE_SCHEMA_VERSION = 3;
export const ARCHIVE_FORMAT = 'ndjson_gzip_v3';
export const ARCHIVE_CONTENT_TYPE = 'application/x-ndjson';
export const ARCHIVE_COMPRESSION = 'gzip';
export const FRAME_ARCHIVE_SCHEMA_VERSION = 1;
export const FRAME_ARCHIVE_FORMAT = 'ndjson_gzip_frames_v1';
export const FRAME_DECODER_VERSION = 'frwhoop-whoop-ble/1';
export const FRAME_MAX_BYTES = 8192;

/**
 * Normalized time-series archive (HR / RR / strap gravity). This is the
 * product projection.
 * Opaque BLE capture is `encodeFrameArchive` / `ndjson_gzip_frames_v1`.
 * Do not mix the two: physiology keeps interpreted HR/RR or gravity, while
 * frames keep hex.
 *
 * On-disk bytes: gzip(NDJSON), one sample per line. This replaces the v1
 * contract which labelled objects as NDJSON while storing gzip(JSON array).
 *
 * Parquet + zstd is the preferred long-term analytical layout, but the Node
 * runtime here has no native parquet/zstd dependency. Columns below are
 * parquet-compatible so a converter can rewrite objects later without
 * re-ingesting BLE.
 *
 * Columns:
 *   t           ISO-8601 UTC timestamp
 *   bpm         integer heart rate or null
 *   rr_ms       array of RR intervals in milliseconds (may be empty)
 *   device_id   opaque device uuid string or null
 *   q           quality 0–1
 *   bat         battery percent or null
 *   src         'ble_hr' | 'whoop_rt' | 'unknown'
 *   mot         wrist motion intensity scalar (g-equivalent) or null
 *   stage       strap-reported sleep stage or null
 *   gx/gy/gz    strap gravity vector in g, or all null
 *   dyn_accel   strap dynamic acceleration scalar, or null
 *   layout      decoder packet layout name or null
 *   family      WHOOP protocol family or null
 *   decoder     decoder version or null
 *   seq         source sequence number or null
 *
 * `mot` and `stage` were added for the energy-expenditure model. Both are
 * additive nullable columns: v2 readers ignore them, and objects written before
 * they existed decode with both absent. The energy engine treats absent as
 * unknown, never as zero.
 */

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a per-second step count. Returns null when absent or invalid.
 * `steps` is a per-interval DELTA count (steps taken during that second).
 * `step_cumulative` is the raw monotonic device counter, converted to a
 * per-second delta by the accumulator (with u16 rollover), never stored as a
 * delta here.
 */
export function normalizeSteps(sample) {
  if (sample == null) return null;
  const steps = finiteNumber(sample?.steps);
  if (steps == null) return null;
  // Plausible per-second cadence: walking ~1-2/s, running up to ~5/s. Values
  // far beyond running cadence are almost certainly miscalibrated units or an
  // accumulated (non-delta) value mislabeled as a delta; refuse rather than
  // poison the daily total. (Task: never double-count / never trust units.)
  if (!(steps >= 0 && steps <= 20)) return null;
  return Math.round(steps);
}

export function normalizeStepCumulative(sample) {
  if (sample == null) return null;
  const c = finiteNumber(
    sample?.step_cumulative ?? sample?.stepsCumulative ?? sample?.stepCounter ?? sample?.step_motion_counter,
  );
  if (c == null) return null;
  // Cumulative counters are non-negative. The WHOOP5 u16 counter lives in
  // [0, 65535] and wraps; allow larger values for future 32-bit counters.
  if (!(c >= 0 && c <= 1e9)) return null;
  return Math.round(c);
}

export function normalizeSpo2(sample) {
  const classified = classifySpo2Byte(sample?.spo2_raw_byte ?? sample?.aux_byte_82 ?? sample?.spo2RawByte);
  const hash = String(sample?.source_frame_hash ?? sample?.sourceFrameHash ?? '').toLowerCase();
  const fw = sample?.firmware ?? sample?.fw;
  return {
    spo2_raw_byte: classified.spo2_raw_byte,
    spo2_candidate_pct: classified.spo2_state === 'candidate' ? classified.spo2_candidate_pct : null,
    spo2_state: classified.spo2_state,
    source_frame_hash: /^[0-9a-f]{64}$/.test(hash) ? hash : null,
    firmware: fw ? String(fw) : null,
  };
}

/** Normalize a per-second skin temperature in degrees Celsius. */
export function normalizeSkinTempC(sample) {
  if (sample == null) return null;
  let c = finiteNumber(sample?.skin_temp_c ?? sample?.skinTempC ?? sample?.skinTemp);
  if (c == null) {
    const raw = finiteNumber(sample?.skin_temp_raw);
    if (raw != null) c = raw / 100;
  }
  if (c == null) return null;
  // Physiologically-plausible on-wrist skin temperature band (20–45 °C). Everything
  // outside is a unit error (raw ADC sent as °C, or an off-wrist artifact)
  // and must not be treated as body/skin temperature.
  if (!(c >= 20 && c <= 45)) return null;
  return Math.round(c * 100) / 100;
}

export function gravityVectorOf(sample) {
  // Match the iOS strap decoder's physical sanity gate (Phase 4): each axis is
  // bounded to ±8 g AND the resultant-vector magnitude must sit near 1 g
  // (0.5..1.5) — the signature of a real wrist gravity reading. A vector whose
  // magnitude is far from 1 g is a decode error, not a physiological event, and
  // must never seed the sleep detector. This closes the gap where only a loose
  // per-axis bound existed, so the archive/decoder/recompute path always sees
  // the same physics the iOS bridge enforces.
  const values = [sample?.gx, sample?.gy, sample?.gz].map(finiteNumber);
  if (values.some((n) => n == null || Math.abs(n) > 8)) return null;
  const [gx, gy, gz] = values;
  const magnitude = Math.sqrt(gx * gx + gy * gy + gz * gz);
  if (magnitude < 0.5 || magnitude > 1.5) return null;
  return { gx, gy, gz };
}

export function normalizeSample(sample, nowIso) {
  const t = sample?.t || sample?.datetime || sample?.at || nowIso;
  const bpmN = Number(sample?.bpm ?? sample?.heartRate ?? sample?.heart_rate);
  const bpm = Number.isFinite(bpmN) && bpmN >= 20 && bpmN <= 240 ? Math.round(bpmN) : null;
  const rr = Array.isArray(sample?.rr_ms || sample?.rrIntervals)
    ? (sample.rr_ms || sample.rrIntervals)
      .map((n) => Math.round(Number(n)))
      .filter((n) => Number.isFinite(n) && n >= 200 && n <= 2500)
    : [];
  const qN = Number(sample?.q ?? sample?.quality);
  const motN = Number(sample?.mot ?? sample?.motion);
  const stage = sample?.stage ?? sample?.sleep_stage;
  const gravity = gravityVectorOf(sample);
  const dynAccel = finiteNumber(sample?.dyn_accel ?? sample?.dynAccel);
  const seq = finiteNumber(sample?.seq ?? sample?.sequence);
  const strapTime = Date.parse(sample?.t_strap || '');
  return {
    t: new Date(t).toISOString(),
    t_strap: Number.isFinite(strapTime) ? new Date(strapTime).toISOString() : null,
    clock_offset_sec: finiteNumber(sample?.clock_offset_sec),
    bpm,
    rr_ms: rr,
    device_id: sample?.device_id || sample?.deviceId || null,
    q: Number.isFinite(qN) ? Math.min(1, Math.max(0, qN)) : 1,
    bat: sample?.bat ?? sample?.battery ?? null,
    src: sample?.src || sample?.source || 'ble_hr',
    // Phone motion is a separate signal. A gravity row may never silently
    // inherit or combine it with the strap vector.
    mot: gravity ? null : (Number.isFinite(motN) && motN >= 0 && motN <= 16 ? motN : null),
    phone_motion: (() => {
      const n = finiteNumber(sample?.phone_motion ?? sample?.phoneMotion);
      return n != null && n >= 0 && n <= 16 ? n : null;
    })(),
    strap_motion: (() => {
      const n = finiteNumber(sample?.strap_motion ?? sample?.strapMotion);
      return n != null && n >= 0 && n <= 16 ? n : null;
    })(),
    stage: stage && stage !== 'none' ? String(stage) : null,
    gx: gravity?.gx ?? null,
    gy: gravity?.gy ?? null,
    gz: gravity?.gz ?? null,
    dyn_accel: gravity && dynAccel != null && dynAccel >= 0 && dynAccel <= 32 ? dynAccel : null,
    layout: sample?.layout ? String(sample.layout) : null,
    family: sample?.family ? String(sample.family) : null,
    decoder: sample?.decoder ? String(sample.decoder) : null,
    seq: seq != null ? seq : null,
    sensor_ts: (() => {
      const ts = finiteNumber(sample?.sensor_ts);
      if (ts != null && ts > 1e9 && ts < 4e9) return Math.floor(ts);
      return null;
    })(),
    // Phase 4: carry wrist/wear signals through the archive so historical
    // replay is not blind to them the way the live path can be. Null when
    // absent (older decoders); never fabricate a value.
    band_sleep_state: Number.isInteger(Number(sample?.band_sleep_state ?? sample?.bandSleepState ?? sample?.sleep_state))
      ? Number(sample.band_sleep_state ?? sample.bandSleepState ?? sample.sleep_state)
      : null,
    on_wrist: Number.isInteger(Number(sample?.on_wrist ?? sample?.onWrist ?? sample?.onwrist))
      ? Number(sample.on_wrist ?? sample.onWrist ?? sample.onwrist)
      : null,
    wake_quality: Number.isInteger(Number(sample?.wake_quality ?? sample?.wakeQuality))
      ? Number(sample.wake_quality ?? sample.wakeQuality)
      : null,
    skin_contact: finiteNumber(sample?.skin_contact ?? sample?.skinContact),
    wrist_on: finiteNumber(sample?.wrist_on ?? sample?.wristOn),
    wrist_off: finiteNumber(sample?.wrist_off ?? sample?.wristOff),
    // Core-health signals carried through the archive (see normalizeSteps /
    // normalizeStepCumulative / normalizeSkinTempC for validity rules).
    // `steps` is a per-second delta; `step_cumulative` the raw counter;
    // `activity_class` 0=unclassified/unknown, 1=walk, 2=run; `skin_temp_c` in °C.
    steps: normalizeSteps(sample),
    step_cumulative: normalizeStepCumulative(sample),
    step_cadence: Number.isInteger(Number(sample?.step_cadence ?? sample?.stepCadence))
      ? Number(sample.step_cadence ?? sample.stepCadence)
      : null,
    activity_class: Number.isInteger(Number(sample?.activity_class ?? sample?.activityClass))
      ? Number(sample.activity_class ?? sample.activityClass)
      : null,
    skin_temp_c: normalizeSkinTempC(sample),
    ...normalizeSpo2(sample),
    connection_epoch: finiteNumber(sample?.connection_epoch ?? sample?.connectionEpoch),
    rr_continuity: finiteNumber(sample?.rr_continuity ?? sample?.rrContinuity),
    packet_type: finiteNumber(sample?.packet_type ?? sample?.packetType),
    packet_seq: finiteNumber(sample?.packet_seq ?? sample?.packetSeq ?? sample?.packetSequence),
    sensor_ts_subsec: finiteNumber(sample?.sensor_ts_subsec ?? sample?.sensorTsSubsec),
    raw_rr_count: finiteNumber(sample?.raw_rr_count ?? sample?.rawRRCount),
    wear_location: (() => {
      const v = String(sample?.wear_location ?? sample?.wearLocation ?? '').trim().toLowerCase();
      return v === 'bicep' || v === 'wrist' ? v : null;
    })(),
    wear_location_source: (() => {
      const v = String(sample?.wear_location ?? sample?.wearLocation ?? '').trim().toLowerCase();
      if (v !== 'bicep' && v !== 'wrist') return null;
      return sample?.wear_location_source === 'legacy_default' ? 'legacy_default' : 'user';
    })(),
    record_index: Number.isInteger(Number(sample?.record_index ?? sample?.recordIndex))
      ? Number(sample.record_index ?? sample.recordIndex)
      : null,
    imu_source: sample?.imu_source === 'live' || sample?.imuSource === 'live' ? 'live'
      : (sample?.layout === 'v21' ? (sample?.imu_source || sample?.imuSource || 'historical') : (sample?.imu_source || sample?.imuSource || null)),
    enmo_mean: finiteNumber(sample?.enmo_mean ?? sample?.enmoMean),
    accel_rms_g: finiteNumber(sample?.accel_rms_g ?? sample?.accelRmsG),
    jerk_rms_g: finiteNumber(sample?.jerk_rms_g ?? sample?.jerkRmsG),
    gyro_rms_raw: finiteNumber(sample?.gyro_rms_raw ?? sample?.gyroRmsRaw),
    stillness_fraction: finiteNumber(sample?.stillness_fraction ?? sample?.stillnessFraction),
    imu_sample_count: finiteNumber(sample?.imu_sample_count ?? sample?.imuSampleCount),
  };
}

export function encodeArchive(samples, { nowIso = new Date().toISOString() } = {}) {
  const rows = (samples || [])
    .map((s) => normalizeSample(s, nowIso))
    .filter((s) => s.bpm != null || s.rr_ms.length || gravityVectorOf(s)
              || s.steps != null || s.step_cumulative != null || s.skin_temp_c != null
              || s.spo2_state === 'candidate' || s.spo2_state === 'sentinel'
              || s.spo2_state === 'diagnostic'
              || s.enmo_mean != null || s.accel_rms_g != null);
  const ndjson = `${rows.map((r) => JSON.stringify(r)).join('\n')}${rows.length ? '\n' : ''}`;
  const body = gzipSync(Buffer.from(ndjson, 'utf8'));
  return {
    body,
    sample_count: rows.length,
    compressed_bytes: body.length,
    sha256: sha256Hex(body),
    format: ARCHIVE_FORMAT,
    compression: ARCHIVE_COMPRESSION,
    content_type: ARCHIVE_CONTENT_TYPE,
    schema_version: ARCHIVE_SCHEMA_VERSION,
    rows,
  };
}

export function decodeArchive(body) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  let text;
  try {
    text = gunzipSync(raw).toString('utf8');
  } catch {
    text = raw.toString('utf8');
  }
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    return Array.isArray(arr) ? arr : [];
  }
  return trimmed.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** Decode-time field census — surfaces silently dropped physiology columns. */
export function decodeFieldCensus(samples = []) {
  const rows = Array.isArray(samples) ? samples : [];
  const count = (pred) => rows.filter(pred).length;
  return {
    samples: rows.length,
    bpm: count((s) => Number.isFinite(Number(s?.bpm))),
    rr_ms: count((s) => Array.isArray(s?.rr_ms) && s.rr_ms.length > 0),
    gravity: count((s) => s?.gx != null && s?.gy != null && s?.gz != null),
    steps: count((s) => s?.steps != null || s?.step_cumulative != null),
    skin_temp_c: count((s) => s?.skin_temp_c != null),
    spo2_candidate: count((s) => s?.spo2_candidate_pct != null || s?.spo2_state === 'candidate'),
    mot: count((s) => s?.mot != null || s?.strap_motion != null),
  };
}

export function archiveMeta() {
  return {
    format: ARCHIVE_FORMAT,
    compression: ARCHIVE_COMPRESSION,
    content_type: ARCHIVE_CONTENT_TYPE,
    schema_version: ARCHIVE_SCHEMA_VERSION,
  };
}

/**
 * Canonical BLE capture. One ATT notify (or reassembled write) per line.
 * `hex` is the opaque payload. Optional `interp` is today's decode and must
 * never be treated as the source of truth for a later reprocess.
 */
export function normalizeFrame(row, nowIso) {
  const hex = String(row?.hex || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!hex || hex.length % 2 !== 0) return null;
  const rawBytes = hex.length / 2;
  // LOSSLESS: never truncate. The frames archive is the re-decode source, so a
  // payload larger than the normal cap must still be fully preserved. Only the
  // legacy `truncated` flag is carried through for provenance; we do not slice.
  const truncated = Boolean(row?.truncated);
  const stored = hex;
  const tRaw = row?.t || row?.datetime || row?.at || nowIso;
  const t = new Date(tRaw);
  if (Number.isNaN(t.getTime())) return null;
  const n = Number(row?.n);
  return {
    schema: FRAME_ARCHIVE_SCHEMA_VERSION,
    kind: row?.kind || 'notify',
    t: t.toISOString(),
    seq: row?.seq ?? null,
    family: row?.family || 'unknown',
    char: row?.char || row?.characteristic || null,
    hex: stored,
    n: Number.isFinite(n) ? n : stored.length / 2,
    fw: row?.fw || row?.firmware || null,
    model: row?.model || null,
    decoder: row?.decoder || FRAME_DECODER_VERSION,
    truncated: truncated || undefined,
    interp: row?.interp && typeof row.interp === 'object' ? row.interp : undefined,
  };
}

export function encodeFrameArchive(frames, { nowIso = new Date().toISOString() } = {}) {
  const rows = (frames || []).map((f) => normalizeFrame(f, nowIso)).filter(Boolean);
  const ndjson = `${rows.map((r) => JSON.stringify(r)).join('\n')}${rows.length ? '\n' : ''}`;
  const body = gzipSync(Buffer.from(ndjson, 'utf8'));
  return {
    body,
    sample_count: rows.length,
    compressed_bytes: body.length,
    sha256: sha256Hex(body),
    format: FRAME_ARCHIVE_FORMAT,
    compression: ARCHIVE_COMPRESSION,
    content_type: ARCHIVE_CONTENT_TYPE,
    schema_version: FRAME_ARCHIVE_SCHEMA_VERSION,
    rows,
  };
}

export function decodeFrameArchive(body) {
  return decodeArchive(body);
}
