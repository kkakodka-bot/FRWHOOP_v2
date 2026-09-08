// IMU raw archive — first-class, full-resolution six-axis records derived from
// verified WHOOP frames.
//
// PROVENANCE (all facts independently validated, see tests/fixtures/
// noop-whoop5-parity.json + tests/protocol/imuArchive.test.js):
//   - Banked HISTORICAL_DATA (type 47) v21, puffin 5/MG: one 1244-byte record
//     per second; six i16 LE arrays of exactly 100 samples:
//     accel_x@28, accel_y@228, accel_z@428, gyro_x@640, gyro_y@840, gyro_z@1040.
//     Scales: accel 1/4096 g/LSB (±8 g), gyro 2000/32768 °/s/LSB (±2000 dps).
//     Validated on real captures: per-sample |accel| 0.999-1.012 g while
//     stationary (gravity shell ~1 g), gyro means < 1 °/s. ~100 Hz per axis.
//   - REALTIME_RAW_DATA (type 43) IMU variant: whoop4 "1917" layout (axis
//     blocks @89/289/489/692/892/1092, 100 i16 samples, same scales, ~100 Hz).
//     A live WHOOP5 capture is the observed 1244-byte v21 shape at
//     @28/@228/@428/@640/@840/@1040; an unobserved +4 variant remains labeled
//     as a hypothesis rather than being silently treated as established.
//
// DESIGN RULES (mission contract):
//   - Raw LSB arrays are preserved EXACTLY as received; scales live beside them
//     as metadata, never applied destructively.
//   - Records carry full provenance: frame hash, frame length, CRC state,
//     firmware/model, characteristic, notify seq, decoder + lineage, layout.
//   - High-rate data lives in B2/raw archives (stream `imu_raw`), NEVER in
//     per-sample Supabase rows.
//   - Unknown fields remain unknown. No physiology is fabricated: only
//     derived, clearly-labeled summary stats (means/magnitudes) are attached,
//     and they are recomputable from the arrays themselves.
//
// This module never throws on malformed input: uninterpretable frames simply
// produce no record (their bytes remain in Level A / Level B archives).

import { gzipSync, gunzipSync } from 'node:zlib';
import { decodeFrame, DECODER_VERSION, DECODER_LINEAGE, PACKET_TYPES, sha256 } from './decoder.js';
import { decodeWhoop5ImuV21, DEEP_SENSOR_DECODER_VERSION, compactMotionFeatures } from './deepSensor.js';

export const IMU_ARCHIVE_SCHEMA = 'frwhoop_imu_raw_v1';
export const IMU_ARCHIVE_STREAM = 'imu_raw';
export const IMU_ARCHIVE_FORMAT = 'ndjson_gzip_imu_v1';
export const IMU_ARCHIVE_SCHEMA_VERSION = 1;

// Documented scales (NOOP Whoop5RawImu + whoop_protocol.json; independently
// validated by the gravity-shell + stationary-gyro physics checks).
export const ACCEL_SCALE_G_PER_LSB = 1 / 4096;      // ±8 g range
export const GYRO_SCALE_DPS_PER_LSB = 2000 / 32768; // ±2000 °/s range
export const IMU_SAMPLE_RATE_HZ = 100;              // 100 samples per 1 s record

/**
 * Idempotent derived-record identity: same source frame + decoder + layout +
 * kind always yields the same id, so live derivation and B2 replay converge.
 */
export function imuDerivedIdentity({
  frameHash, decoderVersion = DECODER_VERSION, layout, kind,
} = {}) {
  return sha256(Buffer.from(
    `${frameHash || ''}|${decoderVersion || ''}|${layout || ''}|${kind || ''}`,
    'utf8',
  ));
}

export function imuRecordIdentity(rec) {
  return rec?.identity?.derived_id
    || rec?.envelope?.frame_hash
    || null;
}

/** Drop duplicate IMU seconds (live pendingDerived concatenated with B2). */
export function dedupeImuRecords(records = []) {
  const seen = new Set();
  const out = [];
  for (const rec of records) {
    if (!rec) continue;
    const id = imuRecordIdentity(rec);
    const key = id || JSON.stringify([
      rec.sensor_ts, rec.kind, rec.accel_x?.[0], rec.accel_z?.[0], rec.gyro_x?.[0],
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out;
}

// Physics gates used ONLY for labeling/validation metadata. Records are
// archived regardless; a failed check downgrades `physics_ok`, it never
// destroys evidence.
const PHYSICS = {
  accelMagMinG: 0.6,   // generous stationary shell; motion pushes higher
  accelMagMaxG: 1.6,   // |a| of a wrist in normal motion rarely exceeds this
  gyroStillMaxDps: 8,  // mean |gyro| far above this while |a| ~1 g = rotation
};

function sixAxisFrom(src) {
  if (!src) return null;
  const ax = src.accel_x, ay = src.accel_y, az = src.accel_z;
  const gx = src.gyro_x, gy = src.gyro_y, gz = src.gyro_z;
  if (!ax?.length || !ay || !az || !gx || !gy || !gz) return null;
  const n = ax.length;
  if (![ay, az, gx, gy, gz].every((a) => a.length === n)) return null;
  return n;
}

/**
 * Derived, clearly-labeled summary stats recomputable from the raw arrays.
 * These exist so a reader can sanity-check a record without re-scaling.
 */
export function imuPhysicsStats(rec) {
  const ax = rec.accel_x, ay = rec.accel_y, az = rec.accel_z;
  const gx = rec.gyro_x, gy = rec.gyro_y, gz = rec.gyro_z;
  if (!ax || !ay || !az || !ax.length) return null;
  const n = ax.length;
  const sA = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < n; i++) { sA.x += ax[i]; sA.y += ay[i]; sA.z += az[i]; }
  const meanG = [sA.x / n * ACCEL_SCALE_G_PER_LSB, sA.y / n * ACCEL_SCALE_G_PER_LSB, sA.z / n * ACCEL_SCALE_G_PER_LSB];
  const mag = Math.sqrt(meanG[0] ** 2 + meanG[1] ** 2 + meanG[2] ** 2);
  // Per-sample magnitude extremes capture in-shell vs motion evidence.
  let minMag = Infinity, maxMag = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = ax[i] * ACCEL_SCALE_G_PER_LSB, y = ay[i] * ACCEL_SCALE_G_PER_LSB, z = az[i] * ACCEL_SCALE_G_PER_LSB;
    const m = Math.sqrt(x * x + y * y + z * z);
    if (m < minMag) minMag = m;
    if (m > maxMag) maxMag = m;
  }
  let gyroMean = null;
  if (gx && gy && gz && gx.length) {
    const s = [0, 0, 0];
    for (let i = 0; i < gx.length; i++) { s[0] += gx[i]; s[1] += gy[i]; s[2] += gz[i]; }
    gyroMean = s.map((v) => v / gx.length * GYRO_SCALE_DPS_PER_LSB);
  }
  return {
    accel_mean_g: meanG.map((v) => Number(v.toFixed(6))),
    accel_mag_mean_g: Number(mag.toFixed(6)),
    accel_mag_sample_min_g: Number(minMag.toFixed(6)),
    accel_mag_sample_max_g: Number(maxMag.toFixed(6)),
    gyro_mean_dps: gyroMean === null ? null : gyroMean.map((v) => Number(v.toFixed(4))),
    // Gravity-shell verdict: 1 g ± tolerance while the whole sample window
    // stays in shell implies a stationary, correctly-scaled, correctly-offset
    // record (mission physics rule). Not a physiology claim.
    gravity_shell_ok: mag >= PHYSICS.accelMagMinG && mag <= PHYSICS.accelMagMaxG
      && minMag >= PHYSICS.accelMagMinG && maxMag <= PHYSICS.accelMagMaxG,
  };
}

/**
 * Extract an IMU raw record from ONE complete verified frame.
 * Returns null when the frame carries no interpretable IMU body.
 *
 * @param {Array|Buffer|Uint8Array} frame  complete verified frame bytes
 * @param {string} family  'puffin' | 'harvard'
 * @param {Object} ctx  {fw, model, char, seq, receivedAt, frameHash}
 */
export function imuRecordFromFrame(frame, family, ctx = {}) {
  if (!frame || frame.length < 12) return null;
  const buf = frame instanceof Uint8Array ? frame : Array.from(frame);
  const packetType = family === 'puffin' ? buf[8] : buf[4];

  let parsed = null;
  let kind = null;
  let layout = null;
  let deep = null;
  if (packetType === 47 && family === 'puffin') {
    // Banked v21: fail closed on exact 1244 / type 47 / version 21 / 100+100.
    const imu = decodeWhoop5ImuV21(buf, { frameHash: ctx.frameHash, ...ctx });
    if (imu.ok) {
      kind = 'hist_v21';
      layout = 'v21';
      parsed = {
        unix: imu.frame.base_ts,
        record_index: imu.frame.record_index,
        subsec: imu.frame.subsec_q15,
        accel_x: imu.frame.accel_x_raw,
        accel_y: imu.frame.accel_y_raw,
        accel_z: imu.frame.accel_z_raw,
        gyro_x: imu.frame.gyro_x_raw,
        gyro_y: imu.frame.gyro_y_raw,
        gyro_z: imu.frame.gyro_z_raw,
        accel_x_g: imu.frame.accel_x_g,
        accel_y_g: imu.frame.accel_y_g,
        accel_z_g: imu.frame.accel_z_g,
        gyro_x_dps: imu.frame.gyro_x_dps,
        gyro_y_dps: imu.frame.gyro_y_dps,
        gyro_z_dps: imu.frame.gyro_z_dps,
        sample_time_s: imu.frame.sample_time_s,
      };
      deep = { crc_ok: true, frame_hash: imu.frame.source_frame_hash };
    }
  } else if (packetType === 43) {
    // Live R21 on puffin is the same 1244-byte v21 IMU as banked type 47.
    if (family === 'puffin') {
      const imu = decodeWhoop5ImuV21(buf, { frameHash: ctx.frameHash, ...ctx });
      if (imu.ok) {
        kind = 'rt43_imu';
        layout = 'v21';
        parsed = {
          unix: imu.frame.base_ts,
          record_index: imu.frame.record_index,
          subsec: imu.frame.subsec_q15,
          accel_x: imu.frame.accel_x_raw,
          accel_y: imu.frame.accel_y_raw,
          accel_z: imu.frame.accel_z_raw,
          gyro_x: imu.frame.gyro_x_raw,
          gyro_y: imu.frame.gyro_y_raw,
          gyro_z: imu.frame.gyro_z_raw,
          accel_x_g: imu.frame.accel_x_g,
          accel_y_g: imu.frame.accel_y_g,
          accel_z_g: imu.frame.accel_z_g,
          gyro_x_dps: imu.frame.gyro_x_dps,
          gyro_y_dps: imu.frame.gyro_y_dps,
          gyro_z_dps: imu.frame.gyro_z_dps,
          sample_time_s: imu.frame.sample_time_s,
        };
        deep = { crc_ok: true, frame_hash: imu.frame.source_frame_hash };
      }
    }
    if (!parsed) {
      deep = decodeFrame(buf, family, { frameHash: ctx.frameHash });
      if (deep?.decode_status === 'decoded' && deep?.decoded?.kind === 'imu'
          && sixAxisFrom(deep.decoded) === 100) {
        kind = 'rt43_imu';
        layout = family === 'puffin'
          ? (deep.decoded.layout || 'whoop5-v21-shape')
          : 'whoop4-1917';
        parsed = deep.decoded;
      }
    }
  } else if (packetType === 51 && family === 'puffin') {
    // Live IMU stream. Layout is a labeled hypothesis until a FRWHOOP capture
    // confirms it; arrays are only stored when all six axes decode.
    deep = decodeFrame(buf, family, { frameHash: ctx.frameHash });
    const p = deep?.decoded?.parsed;
    const n = sixAxisFrom(p);
    if (deep?.decoded?.live_imu_stream && n) {
      kind = 'rt51_imu';
      layout = p.layout || 'whoop5-live51-hypothesis';
      parsed = p;
    }
  } else if (packetType === 52 && family === 'puffin') {
    // Type 52 is routed through the versioned historical decoder. Only a v21
    // 6×100 body is archived; an unmapped 52 stays Level A only.
    deep = decodeFrame(buf, family, { frameHash: ctx.frameHash });
    const p = deep?.decoded?.parsed;
    if (deep?.decoded?.hist_version === 21 && sixAxisFrom(p) === 100) {
      kind = 'hist52_v21';
      layout = 'v21';
      parsed = p;
    }
  }
  if (!kind || !parsed) return null;

  const n = parsed.accel_x.length;
  const sensorSeconds = Number(parsed.unix ?? parsed.timestamp);
  const sensorMs = Number.isFinite(sensorSeconds)
    ? (sensorSeconds > 1e12 ? sensorSeconds : sensorSeconds * 1000)
    : null;
  const receivedMs = Date.parse(ctx.receivedAt || '');
  const liveClockReference = Number.isFinite(sensorMs)
    && Number.isFinite(receivedMs)
    && Math.abs(receivedMs - sensorMs) <= 5 * 60_000;
  const timestampVerified = Number.isFinite(sensorMs) && deep?.crc_ok === true;
  const clockVerified = ctx.clockVerified === true
    || (timestampVerified && liveClockReference);
  // 100 Hz is inferred from 100 samples in a 1-second record (countA/countB
  // are sample counts, not a rate field). Individual sample times are NOT on
  // the wire; array index i is sample i in that 1 s window.
  const record = {
    schema: IMU_ARCHIVE_SCHEMA,
    kind,
    family,
    layout,
    sensor_ts: parsed.unix ?? parsed.timestamp ?? null,
    subsec: parsed.subseconds ?? parsed.subsec ?? null,
    received_at: ctx.receivedAt || null,
    samples_per_axis: n,
    sample_index_start: 0,
    sample_rate_hz: n === 100 ? IMU_SAMPLE_RATE_HZ : (parsed.sample_rate_hz ?? null),
    sample_rate_provenance: 'inferred_from_100_samples_per_1s_record',
    sample_timestamps: 'not_on_wire',
    sample_time_s: parsed.sample_time_s || (n === 100 && Number.isFinite(Number(parsed.unix ?? parsed.timestamp))
      ? Array.from({ length: n }, (_, i) => Number(parsed.unix ?? parsed.timestamp) + i / IMU_SAMPLE_RATE_HZ)
      : null),
    record_index: parsed.record_index ?? null,
    timestamp_verified: timestampVerified,
    clock_verified: clockVerified,
    clock_provenance: {
      timestamp_source: 'strap_rtc_frame_header',
      frame_crc_verified: deep?.crc_ok === true,
      reference_source: ctx.clockVerified === true
        ? 'caller_verified_clock_mapping'
        : (liveClockReference ? 'live_receive_time_within_5m' : null),
      reference_at: Number.isFinite(receivedMs) ? new Date(receivedMs).toISOString() : null,
      corrected: false,
    },
    accel: { unit: 'g', scale_g_per_lsb: ACCEL_SCALE_G_PER_LSB },
    gyro: {
      unit: 'dps',
      scale_dps_per_lsb: GYRO_SCALE_DPS_PER_LSB,
      scale_status: 'reference_noop_2000dps',
    },
    // Raw LSB arrays — exact bytes as received, never rescaled in place.
    accel_x: parsed.accel_x,
    accel_y: parsed.accel_y,
    accel_z: parsed.accel_z,
    gyro_x: parsed.gyro_x,
    gyro_y: parsed.gyro_y,
    gyro_z: parsed.gyro_z,
    accel_x_g: parsed.accel_x_g || parsed.accel_x.map((v) => v * ACCEL_SCALE_G_PER_LSB),
    accel_y_g: parsed.accel_y_g || parsed.accel_y.map((v) => v * ACCEL_SCALE_G_PER_LSB),
    accel_z_g: parsed.accel_z_g || parsed.accel_z.map((v) => v * ACCEL_SCALE_G_PER_LSB),
    gyro_x_dps: parsed.gyro_x_dps || parsed.gyro_x.map((v) => v * GYRO_SCALE_DPS_PER_LSB),
    gyro_y_dps: parsed.gyro_y_dps || parsed.gyro_y.map((v) => v * GYRO_SCALE_DPS_PER_LSB),
    gyro_z_dps: parsed.gyro_z_dps || parsed.gyro_z.map((v) => v * GYRO_SCALE_DPS_PER_LSB),
    envelope: {
      packet_type: packetType,
      packet_name: PACKET_TYPES[packetType] || null,
      frame_hash: ctx.frameHash || deep?.frame_hash || null,
      frame_length: buf.length,
      crc_ok: deep?.crc_ok ?? null,
    },
    firmware: { fw: ctx.fw || null, model: ctx.model || null },
    transport: { char: ctx.char || null, seq: ctx.seq ?? null },
    decoder: {
      version: DECODER_VERSION,
      lineage: DECODER_LINEAGE,
      deep_sensor: (kind === 'hist_v21' || (kind === 'rt43_imu' && layout === 'v21'))
        ? DEEP_SENSOR_DECODER_VERSION : null,
    },
  };
  const frameHash = record.envelope.frame_hash;
  record.identity = {
    source_frame_hash: frameHash,
    decoder_version: DECODER_VERSION,
    layout,
    kind,
    derived_id: imuDerivedIdentity({
      frameHash, decoderVersion: DECODER_VERSION, layout, kind,
    }),
  };
  record.physics = imuPhysicsStats(record);
  record.features = compactMotionFeatures(record);
  return record;
}


/**
 * Encode IMU records as an immutable gzip NDJSON body (same object framing as
 * the Level A / Level B archives).
 */
export function encodeImuArchive(records) {
  const rows = (records || []).filter((r) => r && r.schema === IMU_ARCHIVE_SCHEMA);
  const ndjson = `${rows.map((r) => JSON.stringify(r)).join('\n')}${rows.length ? '\n' : ''}`;
  const body = gzipSync(Buffer.from(ndjson, 'utf8'));
  return {
    body,
    sample_count: rows.length,
    compressed_bytes: body.length,
    format: IMU_ARCHIVE_FORMAT,
    compression: 'gzip',
    content_type: 'application/x-ndjson',
    schema_version: IMU_ARCHIVE_SCHEMA_VERSION,
    stream: IMU_ARCHIVE_STREAM,
    rows,
  };
}

/**
 * Decode a gzip NDJSON imu_raw object back into records. Unknown lines
 * (wrong schema) are skipped so a mixed object cannot poison gait replay.
 */
export function decodeImuArchive(body) {
  if (!body) return [];
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  let text;
  try {
    text = gunzipSync(raw).toString('utf8');
  } catch {
    text = raw.toString('utf8');
  }
  const trimmed = text.trim();
  if (!trimmed) return [];
  const lines = trimmed.startsWith('[')
    ? JSON.parse(trimmed)
    : trimmed.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const rows = Array.isArray(lines) ? lines : [];
  return rows.filter((r) => r && r.schema === IMU_ARCHIVE_SCHEMA && Array.isArray(r.accel_x));
}
