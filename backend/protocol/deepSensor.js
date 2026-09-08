// WHOOP 5/MG deep historical sensor decode — fail-closed, lossless, no invented physiology.
//
// Layouts (type 47 historical; type 43 live R21 shares the v21 IMU decoder):
//   v21 1244 B  6-axis IMU, 100 samples, 100 Hz
//   v26   88 B  24 × i16 optical waveform, 24 Hz (no wavelength)
//   v20 2140 B  five 422-byte optical blocks, neutral channel_a/channel_b
//
// Product metrics still use gen5.js / imu_raw / ppg_raw (PIP). This module does
// not change sleep, SpO2, strain, or HRV. Unknown bytes stay raw.

import { verifyFrame } from './framing.js';
import { sha256 } from './decoder.js';
import {
  u8, u16, u32, i16, i32,
  ACCEL_SCALE_G_PER_LSB, GYRO_SCALE_DPS_PER_LSB,
  isGen5ImuBuffer,
} from './gen5.js';

export const DEEP_SENSOR_DECODER_VERSION = 'frwhoop-deep-sensor/2';

export const V21_FRAME_LEN = 1244;
export const V26_FRAME_LEN = 88;
export const V20_FRAME_LEN = 2140;
export const V18_FRAME_LEN = 124;

export const V21_SAMPLE_COUNT = 100;
export const V21_RATE_HZ = 100;
export const V26_SAMPLE_COUNT = 24;
export const V26_RATE_HZ = 24;
export const V20_BLOCK_COUNT = 5;
export const V20_BLOCK_LEN = 422;
export const V20_BLOCK_START = 26;
export const V20_HEADER_LEN = 21;
export const V20_SLOT_BYTES = 200;
export const V20_SLOT_CAPACITY = 50;

export { ACCEL_SCALE_G_PER_LSB, GYRO_SCALE_DPS_PER_LSB };

export const EVIDENCE = Object.freeze({
  STRUCTURAL: 'STRUCTURAL',
  PHYSICALLY_VALIDATED: 'PHYSICALLY_VALIDATED',
  REFERENCE_CORROBORATED: 'REFERENCE_CORROBORATED',
  HYPOTHESIS: 'HYPOTHESIS',
  RAW_UNKNOWN: 'RAW_UNKNOWN',
});

export const FIELD_EVIDENCE = Object.freeze({
  'v21.accel_offsets': EVIDENCE.PHYSICALLY_VALIDATED,
  'v21.gyro_offsets': EVIDENCE.PHYSICALLY_VALIDATED,
  'v21.accel_scale': EVIDENCE.PHYSICALLY_VALIDATED,
  // Gyro °/s scale is NOOP/Harvard-attested, not pinned on the 2026-09-01 5/MG corpus.
  'v21.gyro_scale': EVIDENCE.REFERENCE_CORROBORATED,
  'v21.countA_countB': EVIDENCE.STRUCTURAL,
  'v26.waveform_i16': EVIDENCE.STRUCTURAL,
  'v26.waveform_is_ppg': EVIDENCE.PHYSICALLY_VALIDATED,
  'v26.physical_wavelength': EVIDENCE.RAW_UNKNOWN,
  'v26.bytes_12_19_26_75_83': EVIDENCE.RAW_UNKNOWN,
  'v26.nominal_rate_24hz': EVIDENCE.REFERENCE_CORROBORATED,
  'v20.five_block_structure': EVIDENCE.STRUCTURAL,
  'v20.source_a_raw': EVIDENCE.RAW_UNKNOWN,
  'v20.wavelength_identity': EVIDENCE.RAW_UNKNOWN,
  'v20.channel_slots': EVIDENCE.STRUCTURAL,
});

function asBytes(frame) {
  if (!frame) return null;
  if (frame instanceof Uint8Array) return frame;
  return Uint8Array.from(frame);
}

function crcGate(buf) {
  const check = verifyFrame(buf, 'puffin');
  if (!check || check.ok !== true) {
    return { ok: false, reason: 'crc_invalid', crc_ok: false, check };
  }
  return { ok: true, crc_ok: true, check };
}

function axisI16(buf, start, count) {
  const end = start + count * 2;
  if (end > buf.length - 4) return null;
  const out = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const v = i16(buf, start + i * 2);
    if (v === null) return null;
    out[i] = v;
  }
  return out;
}

function sliceBytes(buf, from, to) {
  const a = from < 0 ? 0 : from;
  const b = Math.min(to, buf.length);
  if (b <= a) return [];
  return Array.from(buf.subarray(a, b));
}

function provenance(buf, ctx, extra = {}) {
  return {
    decoder_version: DEEP_SENSOR_DECODER_VERSION,
    source_frame_hash: ctx.frameHash || sha256(buf),
    source_object_id: ctx.sourceObjectId || ctx.objectId || null,
    firmware: ctx.fw || ctx.firmware || null,
    evidence: FIELD_EVIDENCE,
    ...extra,
  };
}

/**
 * Fail-closed v21 IMU. Exact 1244, countA=countB=100.
 * Type 47 version 21 (banked) and type 43 live R21 share this layout.
 * Type 43 is identified by length + count words, not seq-byte == 21.
 */
export function decodeWhoop5ImuV21(frame, ctx = {}) {
  const buf = asBytes(frame);
  if (!buf || buf.length !== V21_FRAME_LEN) {
    return { ok: false, reason: 'not_1244', frame_length: buf ? buf.length : 0 };
  }
  const crc = crcGate(buf);
  if (!crc.ok) return { ok: false, reason: 'crc_invalid', crc_ok: false };
  const packetType = buf[8];
  if (packetType !== 47 && packetType !== 43) {
    return { ok: false, reason: 'wrong_type', packet_type: packetType };
  }
  if (packetType === 47 && buf[9] !== 21) {
    return { ok: false, reason: 'wrong_version', version: buf[9] };
  }
  if (packetType === 43 && !isGen5ImuBuffer(buf)) {
    return { ok: false, reason: 'not_v21_shape' };
  }
  const countA = u16(buf, 24);
  const countB = u16(buf, 630);
  if (countA !== V21_SAMPLE_COUNT) return { ok: false, reason: 'countA', count_a: countA };
  if (countB !== V21_SAMPLE_COUNT) return { ok: false, reason: 'countB', count_b: countB };
  const accel_x = axisI16(buf, 28, V21_SAMPLE_COUNT);
  const accel_y = axisI16(buf, 228, V21_SAMPLE_COUNT);
  const accel_z = axisI16(buf, 428, V21_SAMPLE_COUNT);
  const gyro_x = axisI16(buf, 640, V21_SAMPLE_COUNT);
  const gyro_y = axisI16(buf, 840, V21_SAMPLE_COUNT);
  const gyro_z = axisI16(buf, 1040, V21_SAMPLE_COUNT);
  if (![accel_x, accel_y, accel_z, gyro_x, gyro_y, gyro_z].every(Boolean)) {
    return { ok: false, reason: 'array_overrun' };
  }
  const base_ts = u32(buf, 15);
  const scaleA = ACCEL_SCALE_G_PER_LSB;
  const scaleG = GYRO_SCALE_DPS_PER_LSB;
  const sample_time_s = new Array(V21_SAMPLE_COUNT);
  for (let i = 0; i < V21_SAMPLE_COUNT; i += 1) {
    sample_time_s[i] = base_ts + i / V21_RATE_HZ;
  }
  return {
    ok: true,
    crc_ok: true,
    reason: null,
    frame: {
      layout: 'v21',
      packet_type: packetType,
      version: packetType === 47 ? 21 : buf[9],
      source: packetType === 43 ? 'live' : 'historical',
      base_ts,
      record_index: u32(buf, 11),
      flags: u8(buf, 10),
      subsec_q15: u16(buf, 19),
      sample_count: V21_SAMPLE_COUNT,
      nominal_sample_rate_hz: V21_RATE_HZ,
      sample_time_s,
      accel_x_raw: accel_x,
      accel_y_raw: accel_y,
      accel_z_raw: accel_z,
      gyro_x_raw: gyro_x,
      gyro_y_raw: gyro_y,
      gyro_z_raw: gyro_z,
      accel_x_g: accel_x.map((v) => v * scaleA),
      accel_y_g: accel_y.map((v) => v * scaleA),
      accel_z_g: accel_z.map((v) => v * scaleA),
      // Scaled gyro is a NOOP reference, not a 5/MG physics pin.
      gyro_x_dps: gyro_x.map((v) => v * scaleG),
      gyro_y_dps: gyro_y.map((v) => v * scaleG),
      gyro_z_dps: gyro_z.map((v) => v * scaleG),
      accel_scale_g_per_lsb: scaleA,
      gyro_scale_dps_per_lsb: scaleG,
      gyro_scale_status: 'reference_noop_2000dps',
      frame_length: V21_FRAME_LEN,
      features: compactMotionFeatures({
        accel_x_raw: accel_x, accel_y_raw: accel_y, accel_z_raw: accel_z,
        gyro_x_raw: gyro_x, gyro_y_raw: gyro_y, gyro_z_raw: gyro_z,
        accel_x_g: accel_x.map((v) => v * scaleA),
        accel_y_g: accel_y.map((v) => v * scaleA),
        accel_z_g: accel_z.map((v) => v * scaleA),
      }),
      ...provenance(buf, ctx),
    },
  };
}

/**
 * Fail-closed v26 24 Hz raw optical waveform. Exact 88, type 47, version 26.
 * Bytes 12, 19..26, 75..83 stay RAW_UNKNOWN. No wavelength field.
 */
export function decodeWhoop5PpgV26(frame, ctx = {}) {
  const buf = asBytes(frame);
  if (!buf || buf.length !== V26_FRAME_LEN) {
    return { ok: false, reason: 'not_88', frame_length: buf ? buf.length : 0 };
  }
  const crc = crcGate(buf);
  if (!crc.ok) return { ok: false, reason: 'crc_invalid', crc_ok: false };
  if (buf[8] !== 47) return { ok: false, reason: 'wrong_type', packet_type: buf[8] };
  if (buf[9] !== 26) return { ok: false, reason: 'wrong_version', version: buf[9] };
  const samples = axisI16(buf, 27, V26_SAMPLE_COUNT);
  if (!samples || samples.length !== V26_SAMPLE_COUNT) {
    return { ok: false, reason: 'array_overrun' };
  }
  const base_ts = u32(buf, 15);
  const sample_time_s = new Array(V26_SAMPLE_COUNT);
  for (let i = 0; i < V26_SAMPLE_COUNT; i += 1) {
    sample_time_s[i] = base_ts + i / V26_RATE_HZ;
  }
  return {
    ok: true,
    crc_ok: true,
    reason: null,
    frame: {
      layout: 'v26',
      packet_type: 47,
      version: 26,
      base_ts,
      record_index: u32(buf, 11),
      flags: u8(buf, 10),
      sample_count: V26_SAMPLE_COUNT,
      nominal_sample_rate_hz: V26_RATE_HZ,
      sample_time_s,
      samples,
      raw_byte_12: u8(buf, 12),
      raw_19_26: sliceBytes(buf, 19, 27),
      raw_75_83: sliceBytes(buf, 75, 84),
      features: ppgWaveformFeatures(samples),
      frame_length: V26_FRAME_LEN,
      ...provenance(buf, ctx),
    },
  };
}

function packU16(v) { return [v & 0xFF, (v >> 8) & 0xFF]; }
function packI16(v) {
  const u = v < 0 ? (v + 0x10000) & 0xFFFF : v & 0xFFFF;
  return packU16(u);
}
function packU32(v) {
  const n = v >>> 0;
  return [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF];
}

export function reconstructV20Header(block) {
  return [
    block.sample_count & 0xFF,
    block.source_a_raw & 0xFF,
    ...packU16(block.drive_a_raw),
    block.source_b_raw & 0xFF,
    ...packU16(block.drive_b_raw),
    block.detector_a_select_raw & 0xFF,
    ...packU32(block.range_a_raw),
    ...packI16(block.offset_a_raw),
    block.detector_b_select_raw & 0xFF,
    ...packU32(block.range_b_raw),
    ...packI16(block.offset_b_raw),
  ];
}

function signExtensionOk(v) {
  // Unused high bits of a sign-extended 20-bit value in an i32 container.
  return (v >> 20) === 0 || (v >> 20) === -1;
}

function decodeV20Block(buf, blockIndex) {
  const start = V20_BLOCK_START + blockIndex * V20_BLOCK_LEN;
  if (start + V20_BLOCK_LEN > buf.length - 4) return { ok: false, reason: 'array_overrun' };
  const sampleCountRaw = u8(buf, start);
  if (sampleCountRaw === null || sampleCountRaw < 0 || sampleCountRaw > V20_SLOT_CAPACITY) {
    return { ok: false, reason: 'sample_count', sample_count: sampleCountRaw, block_index: blockIndex };
  }
  const raw_header = sliceBytes(buf, start, start + V20_HEADER_LEN);
  const slotA0 = start + V20_HEADER_LEN;
  const slotB0 = slotA0 + V20_SLOT_BYTES;
  const reservedOff = slotB0 + V20_SLOT_BYTES;
  const channel_a = [];
  const channel_b = [];
  let signExtA = 0;
  let signExtB = 0;
  for (let i = 0; i < sampleCountRaw; i += 1) {
    const a = i32(buf, slotA0 + i * 4);
    const b = i32(buf, slotB0 + i * 4);
    if (a === null || b === null) return { ok: false, reason: 'array_overrun' };
    channel_a.push(a);
    channel_b.push(b);
    if (signExtensionOk(a)) signExtA += 1;
    if (signExtensionOk(b)) signExtB += 1;
  }
  const unusedA = sliceBytes(buf, slotA0 + sampleCountRaw * 4, slotA0 + V20_SLOT_BYTES);
  const unusedB = sliceBytes(buf, slotB0 + sampleCountRaw * 4, slotB0 + V20_SLOT_BYTES);
  const reserved = u8(buf, reservedOff);
  const block = {
    block_index: blockIndex,
    sample_count: sampleCountRaw,
    raw_header,
    source_a_raw: u8(buf, start + 1),
    drive_a_raw: u16(buf, start + 2),
    source_b_raw: u8(buf, start + 4),
    drive_b_raw: u16(buf, start + 5),
    detector_a_select_raw: u8(buf, start + 7),
    range_a_raw: u32(buf, start + 8),
    offset_a_raw: i16(buf, start + 12),
    detector_b_select_raw: u8(buf, start + 14),
    range_b_raw: u32(buf, start + 15),
    offset_b_raw: i16(buf, start + 19),
    channel_a,
    channel_b,
    reserved,
    unused_a_raw: unusedA,
    unused_b_raw: unusedB,
    unused_a_all_zero: unusedA.every((b) => b === 0),
    unused_b_all_zero: unusedB.every((b) => b === 0),
    sign_extension: {
      channel_a_ok: sampleCountRaw === 0 ? null : signExtA / sampleCountRaw,
      channel_b_ok: sampleCountRaw === 0 ? null : signExtB / sampleCountRaw,
    },
  };
  return { ok: true, block };
}

/**
 * Fail-closed v20 structural optical buffer. Neutral names only.
 */
export function decodeWhoop5OpticalV20(frame, ctx = {}) {
  const buf = asBytes(frame);
  if (!buf || buf.length !== V20_FRAME_LEN) {
    return { ok: false, reason: 'not_2140', frame_length: buf ? buf.length : 0 };
  }
  const crc = crcGate(buf);
  if (!crc.ok) return { ok: false, reason: 'crc_invalid', crc_ok: false };
  if (buf[8] !== 47) return { ok: false, reason: 'wrong_type', packet_type: buf[8] };
  if (buf[9] !== 20) return { ok: false, reason: 'wrong_version', version: buf[9] };
  const blocks = [];
  for (let b = 0; b < V20_BLOCK_COUNT; b += 1) {
    const r = decodeV20Block(buf, b);
    if (!r.ok) return r;
    blocks.push(r.block);
  }
  const samplePattern = blocks.map((bl) => bl.sample_count);
  return {
    ok: true,
    crc_ok: true,
    reason: null,
    frame: {
      layout: 'v20',
      packet_type: 47,
      version: 20,
      base_ts: u32(buf, 15),
      record_index: u32(buf, 11),
      flags: u8(buf, 10),
      subsec_q15: u16(buf, 19),
      envelope_raw: sliceBytes(buf, 0, 8),
      raw_21_25: sliceBytes(buf, 21, 26),
      sample_rate_hz_declared: u16(buf, 23),
      crc_raw: sliceBytes(buf, V20_FRAME_LEN - 4, V20_FRAME_LEN),
      block_count: V20_BLOCK_COUNT,
      sample_count_pattern: samplePattern,
      block_0: blocks[0],
      block_1: blocks[1],
      block_2: blocks[2],
      block_3: blocks[3],
      block_4: blocks[4],
      v20_block_0: blocks[0],
      v20_block_1: blocks[1],
      v20_block_2: blocks[2],
      v20_block_3: blocks[3],
      v20_block_4: blocks[4],
      features: v20RecordDiagnostics(blocks),
      frame_length: V20_FRAME_LEN,
      ...provenance(buf, ctx),
    },
  };
}

export function classifyType47Puffin(frame) {
  const buf = asBytes(frame);
  if (!buf || buf.length < 12 || buf[0] !== 0xAA || buf[8] !== 47) {
    return { ok: false, reason: 'not_type47' };
  }
  const crc = crcGate(buf);
  const version = buf[9];
  const length = buf.length;
  const expected = version === 18 ? V18_FRAME_LEN
    : version === 20 ? V20_FRAME_LEN
      : version === 21 ? V21_FRAME_LEN
        : version === 26 ? V26_FRAME_LEN
          : null;
  const shape_ok = expected !== null && length === expected;
  return {
    ok: crc.ok === true,
    crc_ok: crc.ok === true,
    packet_type: 47,
    layout_version: version,
    layout: version === 18 ? 'v18' : version === 20 ? 'v20' : version === 21 ? 'v21' : version === 26 ? 'v26' : 'unknown',
    total_frame_length: length,
    expected_frame_length: expected,
    shape_ok,
    record_index: buf.length > 14 ? u32(buf, 11) : null,
    strap_timestamp: buf.length > 18 ? u32(buf, 15) : null,
    reason: crc.ok ? (shape_ok ? null : 'shape_rejected') : 'crc_invalid',
  };
}

export function decodeDeepSensor(frame, ctx = {}) {
  const buf = asBytes(frame);
  if (!buf || buf.length < 12) return { ok: false, reason: 'too_short' };
  if (buf[8] === 43) return decodeWhoop5ImuV21(buf, ctx);
  if (buf[8] !== 47) return { ok: false, reason: 'wrong_type' };
  const v = buf[9];
  if (v === 21) return decodeWhoop5ImuV21(buf, ctx);
  if (v === 26) return decodeWhoop5PpgV26(buf, ctx);
  if (v === 20) return decodeWhoop5OpticalV20(buf, ctx);
  return { ok: false, reason: 'unknown_layout', version: v, frame_length: buf.length };
}

/** Compact per-second IMU features. Gyro RMS stays in raw LSB. */
export function compactMotionFeatures(rec, { stillThresholdG = 0.12 } = {}) {
  const ax = rec?.accel_x_g || rec?.accel_x_raw?.map((v) => v * ACCEL_SCALE_G_PER_LSB)
    || rec?.accel_x?.map((v) => v * ACCEL_SCALE_G_PER_LSB);
  const ay = rec?.accel_y_g || rec?.accel_y_raw?.map((v) => v * ACCEL_SCALE_G_PER_LSB)
    || rec?.accel_y?.map((v) => v * ACCEL_SCALE_G_PER_LSB);
  const az = rec?.accel_z_g || rec?.accel_z_raw?.map((v) => v * ACCEL_SCALE_G_PER_LSB)
    || rec?.accel_z?.map((v) => v * ACCEL_SCALE_G_PER_LSB);
  const gx = rec?.gyro_x_raw || rec?.gyro_x;
  const gy = rec?.gyro_y_raw || rec?.gyro_y;
  const gz = rec?.gyro_z_raw || rec?.gyro_z;
  if (!ax?.length || !ay?.length || !az?.length) return null;
  const n = ax.length;
  let vmSum = 0;
  let enmoSum = 0;
  let still = 0;
  let clip = 0;
  const rawAx = rec?.accel_x_raw || rec?.accel_x;
  for (let i = 0; i < n; i += 1) {
    const vm = Math.sqrt(ax[i] * ax[i] + ay[i] * ay[i] + az[i] * az[i]);
    vmSum += vm;
    enmoSum += Math.max(0, vm - 1);
    if (Math.abs(vm - 1) < stillThresholdG) still += 1;
    if (rawAx && (rawAx[i] === 32767 || rawAx[i] === -32768)) clip += 1;
  }
  let jerkSum = 0;
  for (let i = 1; i < n; i += 1) {
    const dvx = ax[i] - ax[i - 1];
    const dvy = ay[i] - ay[i - 1];
    const dvz = az[i] - az[i - 1];
    jerkSum += dvx * dvx + dvy * dvy + dvz * dvz;
  }
  let gyroRmsRaw = null;
  if (gx?.length === n && gy?.length === n && gz?.length === n) {
    let g2 = 0;
    for (let i = 0; i < n; i += 1) g2 += gx[i] * gx[i] + gy[i] * gy[i] + gz[i] * gz[i];
    gyroRmsRaw = Math.sqrt(g2 / n);
  }
  const vmMean = vmSum / n;
  return {
    sample_count: n,
    accel_rms_g: Number(Math.sqrt(ax.reduce((s, v, i) => s + v * v + ay[i] * ay[i] + az[i] * az[i], 0) / n).toFixed(6)),
    vm_mean_g: Number(vmMean.toFixed(6)),
    enmo_mean: Number((enmoSum / n).toFixed(6)),
    jerk_rms_g: n > 1 ? Number(Math.sqrt(jerkSum / (n - 1)).toFixed(6)) : 0,
    gyro_rms_raw: gyroRmsRaw == null ? null : Number(gyroRmsRaw.toFixed(4)),
    stillness_fraction: Number((still / n).toFixed(4)),
    clipping_fraction: Number((clip / n).toFixed(4)),
    gyro_scale_status: 'reference_noop_2000dps',
  };
}

/** Neutral PPG diagnostics. Never SpO2, never a wavelength. */
export function ppgWaveformFeatures(samples) {
  if (!Array.isArray(samples) || !samples.length) return null;
  const n = samples.length;
  let sum = 0;
  let sum2 = 0;
  let clip = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of samples) {
    sum += v;
    sum2 += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
    if (v === 32767 || v === -32768) clip += 1;
  }
  const mean = sum / n;
  const variance = Math.max(0, sum2 / n - mean * mean);
  const ac = samples.map((v) => v - mean);
  let best = -Infinity;
  let bestLag = null;
  const minLag = 2;
  const maxLag = Math.min(n - 2, 18);
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let s = 0;
    for (let i = 0; i < n - lag; i += 1) s += ac[i] * ac[i + lag];
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  return {
    sample_count: n,
    coverage: 1,
    rms: Number(Math.sqrt(sum2 / n).toFixed(3)),
    ac_rms: Number(Math.sqrt(variance).toFixed(3)),
    min,
    max,
    clipping_fraction: Number((clip / n).toFixed(4)),
    dominant_lag_samples: bestLag,
    dominant_hz_candidate: bestLag ? Number((V26_RATE_HZ / bestLag).toFixed(3)) : null,
  };
}

function v20RecordDiagnostics(blocks) {
  const out = [];
  for (let i = 0; i < (blocks || []).length; i += 1) {
    const b = blocks[i];
    const diag = (arr) => {
      if (!arr?.length) return { n: 0, rms: null, variance: null, clipping_fraction: 0 };
      let s = 0;
      let s2 = 0;
      let clip = 0;
      for (const v of arr) {
        s += v;
        s2 += v * v;
        if (v === 524287 || v === -524288) clip += 1;
      }
      const mean = s / arr.length;
      return {
        n: arr.length,
        rms: Number(Math.sqrt(s2 / arr.length).toFixed(3)),
        variance: Number(Math.max(0, s2 / arr.length - mean * mean).toFixed(3)),
        clipping_fraction: Number((clip / arr.length).toFixed(4)),
      };
    };
    out.push({
      v20_block: i,
      sample_count: b?.sample_count ?? 0,
      channel_a: diag(b?.channel_a),
      channel_b: diag(b?.channel_b),
    });
  }
  return { blocks: out };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

export function gravityShellStats(imuFrames) {
  const mags = [];
  for (const rec of imuFrames || []) {
    const ax = rec.accel_x_g || rec.accel_x_raw?.map((v) => v * ACCEL_SCALE_G_PER_LSB);
    const ay = rec.accel_y_g || rec.accel_y_raw?.map((v) => v * ACCEL_SCALE_G_PER_LSB);
    const az = rec.accel_z_g || rec.accel_z_raw?.map((v) => v * ACCEL_SCALE_G_PER_LSB);
    if (!ax || !ay || !az) continue;
    for (let i = 0; i < ax.length; i += 1) {
      mags.push(Math.sqrt(ax[i] * ax[i] + ay[i] * ay[i] + az[i] * az[i]));
    }
  }
  if (!mags.length) return { n: 0 };
  const sorted = mags.slice().sort((a, b) => a - b);
  const inShell = mags.filter((m) => m >= 0.5 && m <= 1.5).length;
  return {
    n: mags.length,
    median: percentile(sorted, 50),
    p05: percentile(sorted, 5),
    p95: percentile(sorted, 95),
    fraction_0_5_to_1_5_g: inShell / mags.length,
  };
}

function mag3(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

export function gyroStats(imuFrames) {
  const resting = [];
  const motion = [];
  const gyroE = [];
  const accelE = [];
  for (const rec of imuFrames || []) {
    const gx = rec.gyro_x_dps || rec.gyro_x_raw?.map((v) => v * GYRO_SCALE_DPS_PER_LSB);
    const gy = rec.gyro_y_dps || rec.gyro_y_raw?.map((v) => v * GYRO_SCALE_DPS_PER_LSB);
    const gz = rec.gyro_z_dps || rec.gyro_z_raw?.map((v) => v * GYRO_SCALE_DPS_PER_LSB);
    const ax = rec.accel_x_g || rec.accel_x_raw?.map((v) => v * ACCEL_SCALE_G_PER_LSB);
    const ay = rec.accel_y_g || rec.accel_y_raw?.map((v) => v * ACCEL_SCALE_G_PER_LSB);
    const az = rec.accel_z_g || rec.accel_z_raw?.map((v) => v * ACCEL_SCALE_G_PER_LSB);
    if (!gx || !ax) continue;
    let gSum = 0;
    let aDev = 0;
    for (let i = 0; i < gx.length; i += 1) {
      const gm = mag3(gx[i], gy[i], gz[i]);
      const am = mag3(ax[i], ay[i], az[i]);
      gSum += gm;
      aDev += Math.abs(am - 1);
    }
    const gMean = gSum / gx.length;
    const aMean = aDev / ax.length;
    gyroE.push(gMean);
    accelE.push(aMean);
    if (gMean < 8 && aMean < 0.15) resting.push(gMean);
    else motion.push(gMean);
  }
  const all = gyroE.slice().sort((a, b) => a - b);
  const corr = pearson(gyroE, accelE);
  return {
    n_frames: gyroE.length,
    gyro_magnitude_median: percentile(all, 50),
    gyro_magnitude_p95: percentile(all, 95),
    resting_median: percentile(resting.slice().sort((a, b) => a - b), 50),
    motion_median: percentile(motion.slice().sort((a, b) => a - b), 50),
    resting_n: resting.length,
    motion_n: motion.length,
    gyro_accel_energy_corr: corr,
    garbage_zero_stream: all.length > 0 && Math.abs(all[all.length - 1] || 0) < 1e-9,
  };
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += xs[i]; sy += ys[i];
    sxx += xs[i] * xs[i]; syy += ys[i] * ys[i]; sxy += xs[i] * ys[i];
  }
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  const c = sxy - (sx * sy) / n;
  if (vx <= 0 || vy <= 0) return 0;
  return c / Math.sqrt(vx * vy);
}

export function v21Cadence(imuFrames) {
  const rows = (imuFrames || []).filter((r) => r.record_index != null && r.base_ts != null)
    .sort((a, b) => a.record_index - b.record_index || a.base_ts - b.base_ts);
  let indexInc = 0;
  let tsInc = 0;
  const dt = [];
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].record_index === rows[i - 1].record_index + 1) indexInc += 1;
    const d = rows[i].base_ts - rows[i - 1].base_ts;
    dt.push(d);
    if (d >= 0.5 && d <= 1.5) tsInc += 1;
  }
  const pairs = Math.max(0, rows.length - 1);
  return {
    n: rows.length,
    record_index_increment_frac: pairs ? indexInc / pairs : null,
    timestamp_about_1s_frac: pairs ? tsInc / pairs : null,
    samples_per_record: V21_SAMPLE_COUNT,
  };
}

function detrend(xs) {
  const n = xs.length;
  if (n < 2) return xs.slice();
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += i; sy += xs[i]; sxx += i * i; sxy += i * xs[i];
  }
  const den = n * sxx - sx * sx;
  const slope = den === 0 ? 0 : (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;
  return xs.map((v, i) => v - (intercept + slope * i));
}

function acfPeakBpm(samples, hz, minBpm = 40, maxBpm = 180) {
  const x = detrend(samples);
  const n = x.length;
  if (n < hz * 8) return null;
  let mean = 0;
  for (const v of x) mean += v;
  mean /= n;
  const y = x.map((v) => v - mean);
  const minLag = Math.max(1, Math.round(hz * 60 / maxBpm));
  const maxLag = Math.min(n - 2, Math.round(hz * 60 / minBpm));
  let best = -Infinity;
  let bestLag = null;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let s = 0;
    for (let i = 0; i < n - lag; i += 1) s += y[i] * y[i + lag];
    if (s > best) { best = s; bestLag = lag; }
  }
  if (bestLag == null || bestLag === 0) return null;
  return 60 * hz / bestLag;
}

/**
 * Sensor-identity check: 24 Hz waveform vs concurrent v18/type-40 HR.
 * Does not tune the decoder. Returns INSUFFICIENT_CAPTURE when windows are scarce.
 */
export function v26HrLock(ppgFrames, hrByUnix, { windowSec = 20 } = {}) {
  const rows = (ppgFrames || []).filter((r) => r.base_ts != null && Array.isArray(r.samples))
    .sort((a, b) => a.base_ts - b.base_ts);
  const wave = [];
  const ts = [];
  for (const r of rows) {
    for (let i = 0; i < r.samples.length; i += 1) {
      wave.push(r.samples[i]);
      ts.push(r.base_ts + i / V26_RATE_HZ);
    }
  }
  const winN = windowSec * V26_RATE_HZ;
  const errors = [];
  if (wave.length < winN * 3 || !hrByUnix || Object.keys(hrByUnix).length < 3) {
    return { status: 'INSUFFICIENT_CAPTURE', n_windows: 0, n_samples: wave.length };
  }
  for (let start = 0; start + winN <= wave.length; start += winN) {
    const chunk = wave.slice(start, start + winN);
    const t0 = ts[start];
    const t1 = ts[start + winN - 1];
    const hrs = [];
    for (let t = Math.floor(t0); t <= Math.ceil(t1); t += 1) {
      const hr = hrByUnix[t];
      if (hr >= 40 && hr <= 180) hrs.push(hr);
    }
    if (hrs.length < windowSec * 0.5) continue;
    const ref = hrs.reduce((a, b) => a + b, 0) / hrs.length;
    const est = acfPeakBpm(chunk, V26_RATE_HZ);
    if (est == null) continue;
    errors.push(Math.abs(est - ref));
  }
  if (errors.length < 3) {
    return { status: 'INSUFFICIENT_CAPTURE', n_windows: errors.length, n_samples: wave.length };
  }
  const sorted = errors.slice().sort((a, b) => a - b);
  return {
    status: 'ok',
    n_windows: errors.length,
    n_samples: wave.length,
    contiguous_minutes: wave.length / V26_RATE_HZ / 60,
    median_abs_bpm_error: percentile(sorted, 50),
    p90_abs_error: percentile(sorted, 90),
    fraction_within_3_bpm: errors.filter((e) => e <= 3).length / errors.length,
    fraction_within_6_bpm: errors.filter((e) => e <= 6).length / errors.length,
  };
}

export function v20StructuralStats(opticalFrames) {
  const patternFreq = {};
  const dc = [null, null, null, null, null].map(() => ({ a: [], b: [] }));
  let paddingViolations = 0;
  let reservedNonzero = 0;
  let activeBlocks = 0;
  const ranges = [];
  for (const rec of opticalFrames || []) {
    const blocks = [rec.block_0, rec.block_1, rec.block_2, rec.block_3, rec.block_4];
    const pat = (rec.sample_count_pattern || blocks.map((b) => b?.sample_count)).join(',');
    patternFreq[pat] = (patternFreq[pat] || 0) + 1;
    for (let i = 0; i < 5; i += 1) {
      const b = blocks[i];
      if (!b) continue;
      if (b.sample_count > 0) activeBlocks += 1;
      if (b.sample_count > 0 && b.unused_a_all_zero === false) paddingViolations += 1;
      if (b.sample_count > 0 && b.unused_b_all_zero === false) paddingViolations += 1;
      if (b.reserved) reservedNonzero += 1;
      if (b.channel_a?.length) {
        const mean = b.channel_a.reduce((s, v) => s + v, 0) / b.channel_a.length;
        dc[i].a.push(mean);
        for (const v of b.channel_a) ranges.push(v);
      }
      if (b.channel_b?.length) {
        const mean = b.channel_b.reduce((s, v) => s + v, 0) / b.channel_b.length;
        dc[i].b.push(mean);
        for (const v of b.channel_b) ranges.push(v);
      }
    }
  }
  const sorted = ranges.slice().sort((a, b) => a - b);
  const meanOf = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
  return {
    n_frames: (opticalFrames || []).length,
    sample_count_pattern_frequencies: patternFreq,
    active_block_slots: activeBlocks,
    padding_violations: paddingViolations,
    reserved_byte_nonzero: reservedNonzero,
    signed_value_min: sorted[0] ?? null,
    signed_value_max: sorted[sorted.length - 1] ?? null,
    signed_value_median: percentile(sorted, 50),
    block_dc: dc.map((d, i) => ({
      block: i,
      channel_a_mean: meanOf(d.a),
      channel_b_mean: meanOf(d.b),
    })),
  };
}

export function collectKeys(obj, out = new Set()) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const v of obj) collectKeys(v, out);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    out.add(k);
    collectKeys(v, out);
  }
  return out;
}

export const V20_FORBIDDEN_KEYS = Object.freeze([
  'red', 'infrared', 'ir', 'green', 'ambient', 'spo2', 'wavelength', 'blood',
]);
