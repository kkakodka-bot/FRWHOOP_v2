// Gen5 (WHOOP 5.0 / MG "Puffin") shared record decoders — frwhoop-gen5/2.
//
// Evidence sources (pinned in protocol_sources.lock.json; facts only, no
// restricted code copied):
//   - ryanbr/noop @2fe3a5c9 (PolyForm-NC; facts): v18/v20/v21/v26 offsets,
//     signed-20-bit ADC domain, CRC span [8:2136], live-IMU sequence, ECG.
//   - OpenStrap/protocol @c78c1762 (MIT): shared gen5 header (flags@10,
//     Q15 subsec@19), v21 declared counts, v26 PIP saturated-delta model,
//     v22 tag layouts, reconstruction semantics.
//   - judes.club (facts): v18 layout + refuted quaternion reading.
//
// CONTRACT: inputs are complete verified frames (puffin envelope). Outputs are
// plain objects: { fields, spans, warnings, confidence, coverage, ... }.
// spans feed coverage.buildCoverage(). No function throws; malformed input
// degrades to status + warnings. Unknown bytes are never given semantics.

import { buildCoverage, envelopeSpans } from './coverage.js';
import { classifySpo2Byte } from './spo2.js';

// ---- bail-safe LE readers ----
export function u8(buf, off) { return (off >= 0 && off < buf.length) ? buf[off] : null; }
export function u16(buf, off) { return (off + 2 <= buf.length) ? (buf[off] | (buf[off + 1] << 8)) >>> 0 : null; }
export function u32(buf, off) {
  return (off + 4 <= buf.length)
    ? ((buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0) : null;
}
export function i16(buf, off) { const v = u16(buf, off); return v === null ? null : (v << 16 >> 16); }
export function i32(buf, off) { const v = u32(buf, off); return v === null ? null : (v | 0); }
export function f32(buf, off) {
  if (off + 4 > buf.length) return null;
  const d = new DataView(new Uint8Array([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]]).buffer);
  return d.getFloat32(0, true);
}
export function f32Finite(buf, off) {
  const v = f32(buf, off);
  return v === null || !Number.isFinite(v) ? null : v;
}

// Optical ADC domain: signed 20-bit, sign-extended into 4-byte LE containers.
export const OPTICAL_ADC_MIN = -524288;
export const OPTICAL_ADC_MAX = 524287;
export function readI20(buf, off) {
  const v = u32(buf, off);
  if (v === null) return null;
  const masked = v & 0xFFFFF;
  return (masked & 0x80000) !== 0 ? masked - 0x100000 : masked;
}
export function opticalAdcInRange(v) { return v >= OPTICAL_ADC_MIN && v <= OPTICAL_ADC_MAX; }

/**
 * Invert a "first absolute sample + saturated i16 deltas" optical window
 * (v26 PIP; v22 tags). Deltas at the i16 rails (-32768/+32767) mark a step the
 * encoder could not represent: that sample and everything after is ambiguous.
 * A reconstruction outside the 20-bit domain PROVES divergence. Wire deltas
 * stay authoritative; the reconstruction is always approximate.
 */
export function reconstructSaturatedDeltaWindow(firstSample, deltas) {
  if (firstSample == null || !Number.isFinite(Number(firstSample))) {
    return {
      samples: [],
      first_ambiguous_sample_index: 0,
      out_of_range_sample_indices: [],
      has_saturated_delta: false,
      divergence_proven: true,
      trusted_sample_count: 0,
      trusted_samples: [],
      first_sample_invalid: true,
    };
  }
  const first = Number(firstSample);
  const samples = [first];
  const outOfRange = [];
  let firstAmbiguous = null;
  if (first < OPTICAL_ADC_MIN || first > OPTICAL_ADC_MAX) {
    outOfRange.push(0);
    firstAmbiguous = 0;
  }
  let acc = first;
  for (let i = 0; i < deltas.length; i += 1) {
    const d = deltas[i];
    if (d === -32768 || d === 32767) firstAmbiguous ??= i + 1;
    acc += d;
    samples.push(acc);
    if (acc < OPTICAL_ADC_MIN || acc > OPTICAL_ADC_MAX) outOfRange.push(i + 1);
  }
  const trusted = firstAmbiguous === null ? samples.length : firstAmbiguous;
  return {
    samples,
    first_ambiguous_sample_index: firstAmbiguous,
    out_of_range_sample_indices: outOfRange,
    has_saturated_delta: firstAmbiguous !== null && firstAmbiguous > 0,
    divergence_proven: outOfRange.length > 0,
    trusted_sample_count: trusted,
    trusted_samples: samples.slice(0, trusted),
    first_sample_invalid: firstAmbiguous === 0,
  };
}

function flagsBit(buf, off, bit) {
  const b = u8(buf, off);
  return b === null ? false : ((b >> bit) & 1) === 1;
}

// =============================================================================
// Shared Gen5 historical header — frame [8:21), all type-47 record kinds.
// flags@10 bit7 = optical front end at 25 Hz (set) vs 50 Hz (clear);
// subsec u16@19 is Q15 (value/32768 s). NOOP reads @10 as opaque
// layout_marker — compatible (observed 0x80/0x81 = bit7 set + v20 bit0).
// =============================================================================
export function decodeGen5HistoricalHeader(buf) {
  if (!buf || buf.length < 21) {
    return { ok: false, fields: {}, spans: [], warnings: ['frame too short for the shared gen5 header (need >= 21 bytes)'] };
  }
  const recordClass = u8(buf, 8);
  const flags = u8(buf, 10);
  const subsecQ15 = u16(buf, 19);
  const fields = {
    record_class: recordClass,
    hist_version: u8(buf, 9),
    flags,
    record_index: u32(buf, 11),
    unix: u32(buf, 15),
    subsec_q15: subsecQ15,
    subsec_seconds: subsecQ15 === null ? null : subsecQ15 / 32768,
    ppg_sample_rate_hz: flags === null ? null : ((flags & 0x80) !== 0 ? 25 : 50),
  };
  return {
    ok: recordClass === 0x2F,
    fields,
    spans: [{ from: 8, to: 21, cls: 'envelope', name: 'gen5_historical_header' }],
    warnings: recordClass !== 0x2F && recordClass !== null
      ? [`record_class 0x${recordClass.toString(16)} is not 0x2F; header fields decoded, kind doubtful`] : [],
  };
}

// shared physiological bounds (openstrap records.dart kMinRrMs/kMaxRrMs)
export const RR_MIN_MS = 200;
export const RR_MAX_MS = 2500;
const ACCEL_FULL_SCALE_G = 16;
const V18_HR_MIN = 25;
const V18_HR_MAX = 230;

// =============================================================================
// v18 — per-second biometric summary (frame 124 B / inner 112 B).
// Corrected mapping: header flags/subsec; HR gate 25..230 with 0 = the band's
// own no-reading sentinel; RR capped at the 4 slots the form has with
// [200,2500] ms validation in wire order; accel fields gated only on
// finiteness + full scale (NEVER the gen4 1 g window — registry conflict
// v18.gravity_vector); all cross-source conflicts cited, none silently sided.
// =============================================================================
export const GEN5_V18_FRAME_LEN = 124;
export const GEN5_V18_INNER_LEN = 112;

export function decodeV18(buf, { collectCoverage = true } = {}) {
  const warnings = [];
  const fields = {};
  const spans = [];
  const conflictsCited = new Set();
  const hdr = decodeGen5HistoricalHeader(buf);
  if (buf.length < 118) warnings.push('v18 frame shorter than the field map needs; missing fields are absent, not zero');
  if (hdr.ok === false && buf.length >= 21) warnings.push('record_class byte is not 0x2F; decoding header-only');
  for (const [k, v] of Object.entries(hdr.fields)) fields[k] = v;

  // HR: 0 = absent sentinel (preserved as null), else plausible gate.
  const hrRaw = u8(buf, 22);
  if (hrRaw === 0) {
    fields.heart_rate = null;
    spans.push({ from: 22, to: 23, cls: 'decoded', name: 'heart_rate', note: 'band no-reading sentinel (0)' });
  } else if (hrRaw >= V18_HR_MIN && hrRaw <= V18_HR_MAX) {
    fields.heart_rate = hrRaw;
    spans.push({ from: 22, to: 23, cls: 'decoded', name: 'heart_rate' });
  } else {
    fields.heart_rate = null;
    warnings.push(`heart_rate byte ${hrRaw} outside [25,230] — treated as absent, not clamped`);
    spans.push({ from: 22, to: 23, cls: 'raw', name: 'heart_rate_out_of_range' });
  }

  // RR: declared count capped at 4; strict bounds; wire order preserved.
  const rrDeclared = u8(buf, 23) ?? 0;
  fields.rr_count_declared = rrDeclared;
  if (rrDeclared > 4) warnings.push(`rr_count ${rrDeclared} exceeds the 4-slot v18 form — capped at 4`);
  const rrs = [];
  const rrSlotsEnd = 24 + 2 * Math.min(Math.max(rrDeclared, 0), 4);
  for (let i = 0; i < Math.min(rrDeclared, 4); i += 1) {
    const off = 24 + i * 2;
    const v = i16(buf, off);
    if (v === null) break;
    if (v >= RR_MIN_MS && v <= RR_MAX_MS) {
      rrs.push(v);
      spans.push({ from: off, to: off + 2, cls: 'decoded', name: `rr[${i}]` });
    } else {
      warnings.push(`rr[${i}]=${v} ms outside [200,2500] — slot rejected`);
      spans.push({ from: off, to: off + 2, cls: 'raw', name: 'rr_rejected', note: 'outside physiological bounds' });
    }
  }
  // the four RR slots are structurally known: unused slots (declared 0 or
  // rejected) are kept raw, never left as unknown bytes
  if (rrSlotsEnd > 24) {
    spans.push({ from: rrSlotsEnd, to: 32, cls: 'raw', name: 'unused_rr_slots', note: 'declared-count slots not populated on the wire' });
  } else {
    spans.push({ from: 24, to: 32, cls: 'raw', name: 'unused_rr_slots', note: 'rr_count_declared = 0' });
  }
  fields.rr_intervals_ms = rrs;
  fields.rr_count = rrs.length;

  const scalar = (name, off, reader, len = 1, opts = {}) => {
    const v = reader(buf, off);
    if (v === null) { warnings.push(`${name} unreadable at ${off}`); return null; }
    fields[name] = v;
    spans.push({ from: off, to: off + len, cls: opts.cls || 'decoded', name, note: opts.note });
    if (opts.conflict) (fields.conflicts_cited = fields.conflicts_cited || []).push(opts.conflict);
    return v;
  };

  scalar('cardiac_flags', 33, u8);
  scalar('hr_quality_flags', 36, u8, 1, { note: 'CONFLICT v18.hr_quality_flags.bit7 — never gate HR on bit7' });
  scalar('heart_rate_alt', 37, u8);
  scalar('rr_packed', 38, u16, 2);
  scalar('cardiac_status', 40, u8);

  const dyn = f32Finite(buf, 41);
  if (dyn !== null && dyn >= 0 && dyn <= ACCEL_FULL_SCALE_G) {
    fields.dynamic_acceleration = dyn;
    spans.push({ from: 41, to: 45, cls: 'decoded', name: 'dynamic_acceleration', note: 'CONFLICT v18.dynamic_acceleration' });
  } else if (dyn !== null) {
    warnings.push(`dynamic_acceleration ${dyn} outside ±16 g full scale — kept raw`);
    spans.push({ from: 41, to: 45, cls: 'raw', name: 'dynamic_acceleration_ungated' });
  } else {
    warnings.push('dynamic_acceleration f32 @41 not finite — kept raw');
    spans.push({ from: 41, to: 45, cls: 'raw', name: 'dynamic_acceleration_unreadable' });
  }

  const g = [f32Finite(buf, 45), f32Finite(buf, 49), f32Finite(buf, 53)];
  if (g.every((v) => v !== null && Math.abs(v) <= ACCEL_FULL_SCALE_G)) {
    fields.gravity_or_accel_means = g;
    fields.gravity_mag_validator = Number(Math.sqrt(g[0] ** 2 + g[1] ** 2 + g[2] ** 2).toFixed(6));
    spans.push({ from: 45, to: 57, cls: 'decoded', name: 'gravity_or_accel_means', note: 'CONFLICT v18.gravity_vector (|g| metadata, not a gate)' });
  } else {
    warnings.push('gravity/accel-means triple @45 non-finite or full-scale-violating — kept raw');
    spans.push({ from: 45, to: 57, cls: 'raw', name: 'gravity_or_accel_means_ungated' });
  }

  scalar('step_motion_counter', 57, u16, 2);
  scalar('step_cadence', 59, u8);
  scalar('activity_class', 63, u8, 1, { note: '0 = unclassified/unknown; 1=walk 2=run; never product-still' });

  for (const [name, off] of [['temp_aux_1_raw', 69], ['temp_aux_2_raw', 71]]) {
    const v = i16(buf, off);
    if (v !== null && v / 10 >= 0 && v / 10 <= 60) {
      fields[name] = v;
      spans.push({ from: off, to: off + 2, cls: 'decoded', name });
    } else if (v !== null) {
      warnings.push(`${name} outside 0..60 C — kept raw`);
      spans.push({ from: off, to: off + 2, cls: 'raw', name: `${name}_ungated` });
    }
  }
  // skin temp: SIGNED i16 /100 C; raw -5000 = the unavailable sentinel
  // (340k-frame corpus + openstrap; supersedes the u16 reading in the noop port).
  const skinRaw = i16(buf, 73);
  if (skinRaw !== null && skinRaw < 0) {
    // negative codes are unavailable/error sentinels (corpus: -5000 and a
    // -1055..-1063 band); never a plausible skin temperature
    fields.skin_temp_unavailable = true;
    fields.skin_temp_unavailable_code = skinRaw;
    spans.push({ from: 73, to: 75, cls: 'decoded', name: 'skin_temp_unavailable', note: `negative sentinel code ${skinRaw}` });
  } else if (skinRaw !== null && skinRaw / 100 >= 5 && skinRaw / 100 <= 45) {
    fields.skin_temp_raw = skinRaw;
    spans.push({ from: 73, to: 75, cls: 'decoded', name: 'skin_temp_raw', note: 'signed i16; C = raw/100' });
  } else if (skinRaw !== null) {
    warnings.push(`skin_temp_raw ${skinRaw} outside 5..45 C — kept raw`);
    spans.push({ from: 73, to: 75, cls: 'raw', name: 'skin_temp_raw_ungated' });
  }

  scalar('status_word', 75, u16, 2);
  scalar('status_word_1', 77, u16, 2);
  scalar('status_word_2', 79, u16, 2);

  const sb = u8(buf, 81);
  if (sb !== null) {
    fields.sleep_state_byte = sb;
    fields.sleep_state = (sb >> 4) & 3;                       // agreed b4-5
    fields.primary_flags_bit8_or_onwrist = sb & 3;            // CONFLICT b0-1
    fields.strap_fit_or_wake_quality = (sb >> 2) & 3;         // CONFLICT b2-3
    fields.sleep_state_byte_bits67 = (sb >> 6) & 3;
    spans.push({ from: 81, to: 82, cls: 'decoded', name: 'sleep_state_byte' });
  }

  const sb82 = u8(buf, 82);
  if (sb82 !== null) {
    const spo2 = classifySpo2Byte(sb82);
    fields.aux_byte_82 = spo2.spo2_raw_byte;
    fields.spo2_raw_byte = spo2.spo2_raw_byte;
    fields.spo2_state = spo2.spo2_state;
    fields.spo2_mode = spo2.spo2_mode;
    if (spo2.spo2_candidate_pct != null) {
      fields.spo2_candidate_82 = spo2.spo2_candidate_pct;
      fields.spo2_candidate_pct = spo2.spo2_candidate_pct;
    }
    spans.push({ from: 82, to: 83, cls: 'decoded', name: 'aux_byte_82', note: 'tri-mode candidate; never spo2_pct' });
  }

  const ob0 = u8(buf, 106), ob1 = u8(buf, 107);
  if (ob0 !== null && ob1 !== null) {
    fields.optical_baseline_ab = [ob0, ob1];
    spans.push({ from: 106, to: 108, cls: 'decoded', name: 'optical_baseline_ab', note: 'CONFLICT v18.optical_tail_106_109' });
  }
  const oa0 = u8(buf, 108), oa1 = u8(buf, 109);
  if (oa0 !== null && oa1 !== null) {
    fields.optical_amp_or_psnr = [oa0 >= 128 ? oa0 - 256 : oa0, oa1 >= 128 ? oa1 - 256 : oa1];
    fields.optical_sentinel_pair = oa0 === 128 && oa1 === 128;
    spans.push({ from: 108, to: 110, cls: 'decoded', name: 'optical_amp_or_psnr', note: '0x80/-128 paired sentinel' });
  }
  const f113 = f32Finite(buf, 113);
  if (f113 !== null) {
    fields.f32_113 = f113;
    spans.push({ from: 113, to: 117, cls: 'decoded', name: 'f32_113', note: 'CONFLICT v18.f32_113' });
  }

  const confidence = fields.heart_rate != null && fields.rr_count > 0 ? 'high'
    : fields.heart_rate != null ? 'medium' : 'low';
  const cov = buildCoverage(buf.length, [
    ...hdr.spans, ...spans, ...envelopeSpans(buf.length, 'puffin'),
    { from: 84, to: 105, cls: 'padding', name: 'v18_padding', note: 'constant zero + @104 0x01 marker' },
    { from: 110, to: 112, cls: 'padding', name: 'v18_padding' },
    { from: 117, to: Math.min(121, buf.length), cls: 'padding', name: 'v18_padding' },
  ], { warnings, confidence });
  return { fields, warnings, confidence, coverage: cov, record_length: buf.length };
}
// =============================================================================
// v20 — five-block measurement buffer (frame 2140 B / inner 2128 B).
// Five 422-byte blocks from frame 26. Each: 21-byte head (sample_count +
// eleven neutral config fields) + two 200-byte slots of sign-extended 20-bit
// i32 containers + 1 reserved byte. Detector paths are NEVER labelled as
// wavelengths (registry conflict v20.block_identity). CRC32 span [8:2136].
// =============================================================================
export const GEN5_V20_FRAME_LEN = 2140;
export const GEN5_V20_INNER_LEN = 2128;
const V20_CAPACITY = 50;

// OpenStrap block-identity table, carried as CANDIDATE metadata only.
export const V20_CANDIDATE_BLOCK_IDENTITY = Object.freeze({
  0: 'green (primary HR channel) [candidate]',
  1: 'red [candidate]',
  2: 'fourth channel [candidate]',
  3: 'IR - fallback flagged by header flags bit0 [candidate]',
  4: 'ambient/dark reference [candidate]',
});

export function decodeV20(buf, { collectCoverage = true } = {}) {
  const warnings = [];
  const fields = {};
  const spans = [];
  const hdr = decodeGen5HistoricalHeader(buf);
  for (const [k, v] of Object.entries(hdr.fields)) fields[k] = v;
  if (buf.length !== GEN5_V20_FRAME_LEN) {
    warnings.push(`v20 exact-length gate failed: got ${buf.length}, need 2140`);
  }
  // explicit per-record sample-rate word (openstrap): u16 @23
  const rate = u16(buf, 23);
  if (rate !== null) {
    fields.sample_rate_hz_declared = rate;
    spans.push({ from: 23, to: 25, cls: 'decoded', name: 'sample_rate_hz_declared' });
    if (fields.ppg_sample_rate_hz != null && rate !== fields.ppg_sample_rate_hz) {
      warnings.push(`declared rate ${rate} Hz disagrees with flags-bit7 ${fields.ppg_sample_rate_hz} Hz — both kept`);
      fields.rate_disagreement = true;
    }
  }
  let maxSamples = 0;
  let present = 0;
  const blocks = [];
  for (let b = 0; b < 5; b += 1) {
    const start = 26 + b * 422;
    const sampleCountRaw = u8(buf, start);
    let sampleCount = sampleCountRaw === null ? 0 : sampleCountRaw;
    if (sampleCountRaw > V20_CAPACITY) {
      warnings.push(`block ${b} sample_count ${sampleCountRaw} exceeds 50-slot capacity - treated as empty (openstrap rule)`);
      sampleCount = 0;
    }
    const head = {
      sample_count: sampleCount,
      sample_count_raw: sampleCountRaw,
      led_a_driver_connection: u8(buf, start + 1),
      led_a_current_raw: u16(buf, start + 2),
      led_b_driver_connection: u8(buf, start + 4),
      led_b_current_raw: u16(buf, start + 5),
      detector0_source: u8(buf, start + 7),
      detector0_range: u32(buf, start + 8),
      detector0_offset_current: i16(buf, start + 12),
      detector1_source: u8(buf, start + 14),
      detector1_range: u32(buf, start + 15),
      detector1_offset_current: i16(buf, start + 19),
      reserved: u8(buf, start + 421),
    };
    fields[`block_${b}_header`] = head;
    fields[`block_${b}_sample_count`] = sampleCount;
    spans.push({ from: start, to: start + 21, cls: 'decoded', name: `block[${b}].head` });
    for (const slot of [0, 1]) {
      const slotStart = start + 21 + slot * 200;
      const samples = [];
      let outOfDomain = 0;
      for (let i = 0; i < sampleCount; i += 1) {
        const v = readI20(buf, slotStart + i * 4);
        if (v === null) break;
        samples.push(v);
        if (!opticalAdcInRange(v)) outOfDomain += 1;
      }
      if (sampleCount > 0) {
        present += 1;
        fields[`block_${b}_slot_${slot}_samples`] = samples;
        if (outOfDomain) warnings.push(`block ${b} slot ${slot}: ${outOfDomain} samples outside the signed-20-bit ADC domain`);
      }
      spans.push({ from: slotStart, to: slotStart + sampleCount * 4, cls: 'decoded', name: `block[${b}].slot[${slot}].samples`, note: 'sign-extended 20-bit' });
      if (sampleCount * 4 < 200) {
        spans.push({ from: slotStart + sampleCount * 4, to: slotStart + 200, cls: 'raw', name: 'unused_slot_bytes', note: 'not samples; NOT zero padding' });
      }
    }
    if (sampleCount > maxSamples) maxSamples = sampleCount;
    spans.push({ from: start + 421, to: start + 422, cls: 'padding', name: `block[${b}].reserved` });
  }
  if ((fields.flags ?? 0) & 1) {
    warnings.push('header flags bit0 set: block 3 fell back to another emitter source (IR path not active)');
    fields.block3_fallback_flag = true;
  }
  fields.candidate_block_identity = V20_CANDIDATE_BLOCK_IDENTITY;
  fields.sensor_block_count = 5;
  fields.sensor_channel_samples = maxSamples;
  fields.sensor_channels_present = present;

  const confidence = present > 0 ? 'medium' : 'low';
  const cov = buildCoverage(buf.length, [
    ...hdr.spans, ...spans, ...envelopeSpans(buf.length, 'puffin'),
    { from: 21, to: 23, cls: 'raw', name: 'unmapped_21_23', note: 'unproven bytes; rate word begins at 23' },
  ], { warnings, confidence });
  return { fields, warnings, confidence, coverage: cov, record_length: buf.length };
}

// =============================================================================
// v21 — 6-axis IMU buffer (frame 1244 B / inner 1232 B).
// ONE decoder shared by packet types 43 (live 0x2B), 47 (historical) and 52.
// Reads exactly countA/countB declared samples; never stale trailing bytes.
// =============================================================================
export const GEN5_V21_INNER_LEN = 1232;
export const GEN5_V21_FRAME_LEN = 1244;
export const ACCEL_SCALE_G_PER_LSB = 1 / 4096;
export const GYRO_SCALE_DPS_PER_LSB = 2000 / 32768;
const V21_SAMPLES_PER_AXIS = 100;

export function isGen5ImuBuffer(buf) {
  if (!buf || buf.length !== 1244) return false;
  const countA = u16(buf, 24);
  const countB = u16(buf, 630);
  return countA !== null && countB !== null
    && countA >= 1 && countA <= V21_SAMPLES_PER_AXIS
    && countB >= 1 && countB <= V21_SAMPLES_PER_AXIS;
}

export function decodeGen5ImuBuffer(buf, { collectCoverage = true } = {}) {
  const warnings = [];
  const fields = {};
  const spans = [];
  if (!buf || buf.length !== 1244) {
    return { fields, warnings: ['not a 1244-byte gen5 IMU buffer'], confidence: 'low', coverage: null, mapped: false };
  }
  const hdr = decodeGen5HistoricalHeader(buf);
  for (const [k, v] of Object.entries(hdr.fields)) fields[k] = v;
  const countA = u16(buf, 24);
  const countB = u16(buf, 630);
  if (countA === null || countA < 1 || countA > V21_SAMPLES_PER_AXIS) {
    warnings.push(`countA ${countA} outside 1..100 - buffer rejected (never reads stale bytes)`);
    return { fields: { count_a: countA, count_b: u16(buf, 630) }, warnings, confidence: 'low', coverage: null, mapped: false };
  }
  if (countB === null || countB < 1 || countB > V21_SAMPLES_PER_AXIS) {
    warnings.push(`countB ${countB} outside 1..100 - buffer rejected (never reads stale bytes)`);
    return { fields: { count_a: countA, count_b: countB }, warnings, confidence: 'low', coverage: null, mapped: false };
  }
  fields.count_a = countA;
  fields.count_b = countB;
  fields.block_a_capacity = u16(buf, 22);
  fields.block_a_sensor_id = u8(buf, 26);
  fields.block_a_flags = u8(buf, 27);
  fields.block_b_capacity = u16(buf, 624);
  fields.block_b_sensor_id = u8(buf, 632);
  fields.block_b_flags = u8(buf, 633);
  const axis = (start, count) => {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const v = i16(buf, start + i * 2);
      if (v === null) { warnings.push(`axis truncated at sample ${out.length}`); break; }
      out.push(v);
    }
    return out;
  };
  fields.accel_x = axis(28, countA);
  fields.accel_y = axis(228, countA);
  fields.accel_z = axis(428, countA);
  fields.gyro_x = axis(640, countB);
  fields.gyro_y = axis(840, countB);
  fields.gyro_z = axis(1040, countB);
  fields.accel_scale_g_per_lsb = ACCEL_SCALE_G_PER_LSB;
  fields.gyro_scale_dps_per_lsb = GYRO_SCALE_DPS_PER_LSB;
  fields.sensor_channel_samples = countA;
  fields.sensor_channels_present = 6;
  const cov = buildCoverage(buf.length, [
    ...hdr.spans,
    { from: 22, to: 24, cls: 'raw', name: 'block_a.capacity' },
    { from: 24, to: 26, cls: 'decoded', name: 'count_a' },
    { from: 26, to: 28, cls: 'raw', name: 'block_a.sensor_id_flags' },
    { from: 28, to: 28 + 2 * countA, cls: 'decoded', name: 'accel_x' },
    { from: 228, to: 228 + 2 * countA, cls: 'decoded', name: 'accel_y' },
    { from: 428, to: 428 + 2 * countA, cls: 'decoded', name: 'accel_z' },
    { from: 624, to: 626, cls: 'raw', name: 'block_b.capacity' },
    { from: 630, to: 632, cls: 'decoded', name: 'count_b' },
    { from: 632, to: 634, cls: 'raw', name: 'block_b.sensor_id_flags' },
    { from: 634, to: 640, cls: 'raw', name: 'block_b.header_gap', note: '6 structurally unused prefix bytes (openstrap header = capacity+count+id+flags; 634..640 unproven)' },
    { from: 640, to: 640 + 2 * countB, cls: 'decoded', name: 'gyro_x' },
    { from: 840, to: 840 + 2 * countB, cls: 'decoded', name: 'gyro_y' },
    { from: 1040, to: 1040 + 2 * countB, cls: 'decoded', name: 'gyro_z' },
    ...envelopeSpans(buf.length, 'puffin'),
  ], { warnings, confidence: 'high' });
  return { fields, warnings, confidence: 'high', coverage: cov, record_length: buf.length };
}
// =============================================================================
// v22 - research/diagnostic telemetry (frame 188 B / inner 176 B; body tag at
// frame 21). R22 is opt-in research data (feature flag enable_r22_packets);
// FRWHOOP decodes bytes it already archives but never WRITES the flag outside
// a consented developer-mode capture (see safety.js).
// Exact-length dispatch BEFORE tag trust. Six known tags; unknown tags decode
// to header + tag + raw body and nothing else. STALE-BYTES RULE: regions a
// variant does not write hold the PREVIOUS packet content, not zeros, so
// every typed accessor is tag-gated.
// =============================================================================
export const GEN5_V22_FRAME_LEN = 188;
export const GEN5_V22_INNER_LEN = 176;
export const GEN5_V22_KNOWN_TAGS = Object.freeze([1, 2, 3, 4, 5, 6]);
const V22_TAG_OFF = 21; // inner[13] = frame[21]
const V22_BODY_OFF = 21; // body byte N == frame byte N + 21

function v22Window(buf, start, slots) {
  const first = i32(buf, start);
  const deltas = [];
  for (let i = 0; i < slots; i += 1) {
    const d = i16(buf, start + 4 + 2 * i);
    if (d === null) break;
    deltas.push(d);
  }
  return {
    frame_offset: start,
    first_sample_adc: first,
    first_sample_adc_in_range: first === null ? false : opticalAdcInRange(first),
    deltas,
    is_clipped_flat: undefined,
  };
}

// a window sitting on the +clip code with every IN-BAND delta zero carries no
// information (openstrap isClippedFlat); "in-band" ends at the first rail delta
function markClippedFlat(w) {
  if (w.first_sample_adc !== OPTICAL_ADC_MAX) { w.is_clipped_flat = false; return w; }
  let clipped = true;
  for (const d of w.deltas) {
    if (d === -32768 || d === 32767) break;
    if (d !== 0) { clipped = false; break; }
  }
  w.is_clipped_flat = clipped;
  return w;
}

function v22MetaBlock(buf, base) {
  return {
    base_frame_offset: base,
    flags_snapshot: u8(buf, base + 1),
    accel_delta_g: f32Finite(buf, base + 4),
    unnamed_floats: [f32Finite(buf, base + 8), f32Finite(buf, base + 12), f32Finite(buf, base + 16)],
    state_word: u16(buf, base + 20),
    primary_flags: u8(buf, base + 26),
  };
}

export function decodeV22(buf, { collectCoverage = true } = {}) {
  const warnings = [];
  const fields = {};
  const spans = [];
  const hdr = decodeGen5HistoricalHeader(buf);
  for (const [k, v] of Object.entries(hdr.fields)) fields[k] = v;
  if (buf.length !== GEN5_V22_FRAME_LEN) {
    warnings.push(`v22 exact-length gate failed: got ${buf.length}, need 188`);
  }
  if (u8(buf, 22) !== 0) warnings.push('inner[14] expected 0x00 on R22; nonzero kept raw');
  const tag = u8(buf, V22_TAG_OFF);
  fields.tag = tag;
  fields.known_layout = GEN5_V22_KNOWN_TAGS.includes(tag);
  fields.raw_body_hex = hexOf(buf, V22_BODY_OFF, V22_BODY_OFF + 163);
  spans.push({ from: V22_TAG_OFF, to: V22_BODY_OFF + 163, cls: 'raw', name: 'v22_raw_body', note: 'tag-gated; stale bytes hold the previous packet, not zeros' });

  if (tag === 1 || tag === 2 || tag === 4) {
    const w = markClippedFlat(v22Window(buf, 23, 49));
    fields.optical_windows = [w];
    fields.reconstruction = [reconstructSaturatedDeltaWindow(w.first_sample_adc, w.deltas)];
    spans.push({ from: 23, to: 23 + 4 + 2 * 49, cls: 'decoded', name: 'tag_window', note: 'i32 first sample + 49 saturated i16 delta slots' });
    fields.meta = v22MetaBlock(buf, 125);
    spans.push({ from: 125, to: 152, cls: 'decoded', name: 'meta_block', note: 'inner[117:144] = frame 125:152' });
    if (tag !== 1) {
      fields.extended_metrics_raw_hex = hexOf(buf, 152, 163);
      spans.push({ from: 152, to: 163, cls: 'raw', name: 'extended_metrics', note: 'located but unsplit (tags 2/4)' });
    }
  fields.crosscheck_note = 'accel_delta_g byte-identical to twin v18 @41 (openstrap)';
  } else if (tag === 3) {
    const wA = markClippedFlat(v22Window(buf, 23, 24));
    const wB = markClippedFlat(v22Window(buf, 75, 24));
    fields.optical_windows = [wA, wB];
    fields.reconstruction = [
      reconstructSaturatedDeltaWindow(wA.first_sample_adc, wA.deltas),
      reconstructSaturatedDeltaWindow(wB.first_sample_adc, wB.deltas),
    ];
    spans.push({ from: 23, to: 23 + 4 + 2 * 24, cls: 'decoded', name: 'tag3_window_a' });
    spans.push({ from: 75, to: 75 + 4 + 2 * 24, cls: 'decoded', name: 'tag3_window_b' });
    fields.meta = v22MetaBlock(buf, 127);
    spans.push({ from: 127, to: 154, cls: 'decoded', name: 'meta_block', note: 'same block shifted +2 (4 + 24*2 bytes per window); inner[119:146] = frame 127:154' });
  } else if (tag === 5) {
    fields.pip_record_unix = u32(buf, 23);
    if (fields.unix != null && fields.pip_record_unix != null) {
      fields.carrier_minus_pip_seconds = fields.unix - fields.pip_record_unix;
      if (fields.carrier_minus_pip_seconds <= 0) {
        warnings.push(`tag5 embedded PIP unix ${fields.pip_record_unix} is not behind the carrier unix ${fields.unix} - expected carrier tens of seconds ahead`);
      }
    }
    const w = markClippedFlat(v22Window(buf, 31, 24));
    fields.optical_windows = [w];
    fields.reconstruction = [reconstructSaturatedDeltaWindow(w.first_sample_adc, w.deltas)];
    fields.accel_delta_g = f32Finite(buf, 31 + 52);
    fields.state_word = u16(buf, 87);
    fields.primary_flags = u8(buf, 89);
    spans.push({ from: 23, to: 27, cls: 'decoded', name: 'tag5_pip_record_unix' });
    spans.push({ from: 31, to: 31 + 4 + 2 * 24, cls: 'decoded', name: 'tag5_embedded_pip_window' });
    spans.push({ from: 83, to: 87, cls: 'decoded', name: 'tag5_accel_delta_f32' });
    spans.push({ from: 87, to: 89, cls: 'decoded', name: 'tag5_state_word' });
    spans.push({ from: 89, to: 90, cls: 'decoded', name: 'tag5_primary_flags' });
  } else if (tag === 6) {
    const axis = (start) => {
      const out = [];
      for (let i = 0; i < 25; i += 1) {
        const v = i16(buf, start + 2 * i);
        if (v === null) break;
        out.push(v);
      }
      return out;
    };
    fields.accel_raw_x = axis(26);
    fields.accel_raw_y = axis(76);
    fields.accel_raw_z = axis(126);
    fields.accel_tail_raw_hex = hexOf(buf, 176, 184);
    fields.accel_scale_g_per_lsb = ACCEL_SCALE_G_PER_LSB;
    spans.push({ from: 26, to: 76, cls: 'decoded', name: 'tag6_accel_x' });
    spans.push({ from: 76, to: 126, cls: 'decoded', name: 'tag6_accel_y' });
    spans.push({ from: 126, to: 176, cls: 'decoded', name: 'tag6_accel_z' });
    spans.push({ from: 176, to: 184, cls: 'raw', name: 'tag6_tail', note: 'sign-transition reading refuted; raw' });
  } else {
    warnings.push(`unknown v22 tag ${tag}: header + tag + raw body only (nothing invented)`);
  }

  const confidence = fields.known_layout ? 'medium' : 'low';
  const cov = buildCoverage(buf.length, [...hdr.spans, ...spans, ...envelopeSpans(buf.length, 'puffin')],
    { warnings, confidence });
  return { fields, warnings, confidence, coverage: cov, record_length: buf.length };
}

// =============================================================================
// v26 - Pulse Information Packet (typical frame 92 B / inner 76 B).
// Supersedes the "24 i16 PPG samples" reading: bytes 27:75 are 24 SATURATED
// i16 DELTAS over a 25-sample window whose sample 0 is the sign-extended
// 20-bit i32 at frame 23. Sample counts are NOT rates; the rate comes from the
// header flags bit7 (25/50 Hz). 72-byte PIP ring record: state counter @21,
// first sample @23, deltas @27, accel delta f32 @75, state word @79,
// primary-flags snapshot @81, morphology byte @82, tail @83.
// =============================================================================
export function decodeV26(buf, { collectCoverage = true } = {}) {
  const warnings = [];
  const fields = {};
  const spans = [];
  const hdr = decodeGen5HistoricalHeader(buf);
  for (const [k, v] of Object.entries(hdr.fields)) fields[k] = v;

  const pipCounter = u16(buf, 21);
  if (pipCounter !== null) {
    fields.pip_state_counter = pipCounter;
    spans.push({ from: 21, to: 23, cls: 'decoded', name: 'pip_state_counter', note: 'noop burst_index (same byte); episodes run 40 records at 1 Hz' });
  }
  const first = i32(buf, 23);
  if (first !== null) {
    fields.first_sample_adc = first;
    fields.first_sample_adc_in_range = opticalAdcInRange(first);
    if (!fields.first_sample_adc_in_range) {
      warnings.push(`first_sample_adc ${first} outside the 20-bit ADC domain - corrupt frame flag (kept raw)`);
    }
    spans.push({ from: 23, to: 27, cls: 'decoded', name: 'first_sample_adc', note: 'the only absolute sample in the record' });
  }
  const deltas = [];
  for (let i = 0; i < 24; i += 1) {
    const d = i16(buf, 27 + 2 * i);
    if (d === null) break;
    deltas.push(d);
  }
  fields.optical_deltas = deltas;
  spans.push({ from: 27, to: 27 + 2 * deltas.length, cls: 'decoded', name: 'optical_deltas', note: '24 saturated i16 deltas over a 25-sample window; NOT flat samples' });
  const rec = reconstructSaturatedDeltaWindow(first, deltas);
  fields.ppg_window_reconstruction = rec;
  fields.ppg_window_sample_count = rec.samples.length;
  fields.ppg_window_trusted_sample_count = rec.trusted_sample_count;
  if (rec.divergence_proven) warnings.push('v26 delta reconstruction diverged (samples outside the 20-bit ADC domain) - window is KNOWN untrustworthy past the first bad sample');
  if (rec.has_saturated_delta) warnings.push(`v26 window carries a saturated delta at index ${rec.first_ambiguous_sample_index - 1}: samples from ${rec.first_ambiguous_sample_index} on are ambiguous`);

  const accelDelta = f32Finite(buf, 75);
  if (accelDelta !== null) {
    fields.accel_delta_g = accelDelta;
    spans.push({ from: 75, to: 79, cls: 'decoded', name: 'accel_delta_g', note: 'byte-equal to twin v18 @41' });
  }
  const sw = u16(buf, 79);
  if (sw !== null) { fields.channel_state_word = sw; spans.push({ from: 79, to: 81, cls: 'decoded', name: 'channel_state_word' }); }
  const pf = u8(buf, 81);
  if (pf !== null) {
    fields.primary_flags_snapshot = pf;
    spans.push({ from: 81, to: 82, cls: 'decoded', name: 'primary_flags_snapshot' });
  }
  const morph = u8(buf, 82);
  if (morph !== null) {
    fields.waveform_morphology = morph;
    spans.push({ from: 82, to: 83, cls: 'decoded', name: 'waveform_morphology', note: 'binary acceptance result; semantics unpinned; never a product field' });
  }
  const tail = u8(buf, 83);
  if (morph !== null && buf.length >= 84) {
    fields.aligned_tail = u8(buf, 83);
    spans.push({ from: 83, to: 84, cls: 'raw', name: 'aligned_tail', note: 'outside the copied 72-byte PIP record' });
  }

  const confidence = first !== null && opticalAdcInRange(first) && !rec.divergence_proven ? 'medium' : 'low';
  const cov = buildCoverage(buf.length, [...hdr.spans, ...spans, ...envelopeSpans(buf.length, 'puffin')],
    { warnings, confidence });
  return { fields, warnings, confidence, coverage: cov, record_length: buf.length };
}
function hexOf(buf, from, to) {
  let out = '';
  for (let i = from; i < Math.min(to, buf.length); i += 1) out += buf[i].toString(16).padStart(2, '0');
  return out;
}

// =============================================================================
// Historical dispatch (types 47/52): v21 by SHAPE first (its counts cannot be
// trusted via the version byte alone), then hist_version byte.
// Returns { version, mapped, decoder, result }.
// =============================================================================
export function decodeGen5Historical(frame, { collectCoverage = true } = {}) {
  const buf = frame instanceof Uint8Array ? frame : Uint8Array.from(frame || []);
  const version = buf.length > 9 ? buf[9] : -1;
  // v21 shape gate first: exact 1244 bytes with paired declared counts 1..100
  if (isGen5ImuBuffer(buf)) {
    return { version: buf[9], hist_version_effective: 21, mapped: true, decoder: 'gen5-v21-shape', result: decodeGen5ImuBuffer(buf, { collectCoverage }) };
  }
  if (buf.length > 9 && u8(buf, 8) !== 0x2F) {
    return { version, mapped: false, decoder: null, result: null, reason: 'record_class is not 0x2F' };
  }
  switch (version) {
    case 18:
      return { version, mapped: true, decoder: 'gen5-v18', result: decodeV18(buf, { collectCoverage }) };
    case 20:
      return { version, mapped: true, decoder: 'gen5-v20', result: decodeV20(buf, { collectCoverage }) };
    case 22: {
      const r = decodeV22(buf, { collectCoverage });
      return { version, mapped: r.fields.known_layout, decoder: 'gen5-v22', result: r };
    }
    case 26:
      return { version, mapped: true, decoder: 'gen5-v26-pip', result: decodeV26(buf, { collectCoverage }) };
    default:
      return { version, mapped: false, decoder: null, result: null, reason: `unmapped hist_version ${version}` };
  }
}

// =============================================================================
// LIVE_IMU (packet 51 / the 0x2B live body).
// Hardware-verified by noop @2fe3a5c9 (#1709): live raw IMU requires
// START_RAW_DATA(81) [0x01] then TOGGLE_IMU_MODE(106) [0x01,0x01]; stop =
// STOP_RAW_DATA(82) [0x01] then 106 [0x01,0x00]. The live buffer wears the
// SAME 1244-byte v21 shape as the banked historical record, so ONE decoder
// (decodeGen5ImuBuffer) serves types 43/47/51/52. The old my-whoop
// variable-length layout is retained as a labeled fallback hypothesis for
// as-yet-unobserved variants.
// =============================================================================
export function decodeLive51(buf, { collectCoverage = true } = {}) {
  if (isGen5ImuBuffer(buf)) {
    const r = decodeGen5ImuBuffer(buf, { collectCoverage });
    {
    const merged = { ...r.fields, layout: 'whoop5-live51-v21-shape', layout_attestation: 'hardware-attested via noop #1709 (START_RAW_DATA 81 + TOGGLE_IMU_MODE 106 [1,1])', hypothesis: false };
    return { mapped: true, layout: 'whoop5-live51-v21-shape', hypothesis: false, fields: merged, warnings: r.warnings, confidence: r.confidence, coverage: r.coverage, record_length: r.record_length };
  }
  }
  // my-whoop variable-length body: [28-B header][accelX*G][accelY*G][accelZ*G][gyroX*H][gyroY*H][gyroZ*H]
  const gCount = u16(buf, 24);
  const hCount = u16(buf, 26);
  if (gCount !== null && hCount !== null && gCount >= 1 && gCount <= 1000 && hCount >= 1 && hCount <= 1000) {
    const need = 28 + 2 * (3 * gCount + 3 * hCount) + 4;
    if (Math.abs(need - buf.length) <= 4) {
      const axis = (start, count) => {
        const out = [];
        for (let i = 0; i < count; i += 1) {
          const v = i16(buf, start + i * 2);
          if (v === null) break;
          out.push(v);
        }
        return out;
      };
      const fields = {
        layout: 'whoop4-live51-varlen (my-whoop FINDINGS.md; hypothesis)',
        hypothesis: true,
        accel_samples_per_axis: gCount,
        gyro_samples_per_axis: hCount,
        accel_x: axis(28, gCount),
        accel_y: axis(28 + 2 * gCount, gCount),
        accel_z: axis(28 + 4 * gCount, gCount),
        gyro_x: axis(28 + 6 * gCount, hCount),
        gyro_y: axis(28 + 6 * gCount + 2 * hCount, hCount),
        gyro_z: axis(28 + 6 * gCount + 4 * hCount, hCount),
        accel_scale_g_per_lsb: ACCEL_SCALE_G_PER_LSB,
        gyro_scale_dps_per_lsb: GYRO_SCALE_DPS_PER_LSB,
      };
      return { mapped: true, fields, warnings: ['my-whoop variable-length layout is a labeled hypothesis for an unobserved variant'], confidence: 'low' };
    }
  }
  return { mapped: false, fields: {}, warnings: ['no known live-IMU shape matched; bytes preserved'], confidence: 'low' };
}

// =============================================================================
// MG/Labrador ECG payload decode (CANDIDATE tier; packet TYPE byte unattested).
// noop Whoop5Ecg @2fe3a5c9 (f2476f95): both Labrador shapes open with a
// 17-byte status block whose last two bytes are numberOfECGSamples u16 LE.
//   Filtered (live, TOGGLE_LABRADOR_FILTERED 139): [status17][n x i16][padding]
//   Raw save  (TOGGLE_LABRADOR_RAW_SAVE 125):      [status17][n * bytesPerSample]
// ECG activation is gated behind developer-mode consent (safety.js). These
// values NEVER feed product metrics.
// =============================================================================
export const LABRADOR_STATUS_HEADER_LEN = 17;

export function decodeLabradorStatusHeader(payload) {
  const buf = payload instanceof Uint8Array ? payload : Uint8Array.from(payload || []);
  if (buf.length < LABRADOR_STATUS_HEADER_LEN) return null;
  const numberOfECGSamples = u16(payload, 15);
  return {
    status_header_raw: Array.from(payload.slice(0, 17)),
    numberOfECGSamples,
    structural_triage_ok: numberOfSamplesPlausible(numberOfECGSamples, payload.length - 17),
  };
}

function numberOfSamplesPlausible(n, availableBytes) {
  if (n === null || n === 0) return false;
  if (availableBytes <= 0) return false;
  const bps = availableBytes / n;
  return bps >= 1 && bps <= 4;
}

/**
 * Structural decode of a candidate Labrador ECG payload (bytes AFTER the inner
 * record header). Fails closed: short headers and impossible sample counts
 * return null. Callers must treat the result as candidate-tier instrumentation.
 */
export function decodeLabradorEcgPayload(payload, { bytesPerSample = null } = {}) {
  const data = payload instanceof Uint8Array ? payload : Uint8Array.from(payload || []);
  if (data.length < LABRADOR_STATUS_HEADER_LEN) return null;
  const header = decodeLabradorStatusHeader(data);
  if (!header) return null;
  const n = header.numberOfECGSamples;
  const body = data.length - LABRADOR_STATUS_HEADER_LEN;
  if (n === null || n === 0 || body <= 0) return null;
  const bps = bytesPerSample ?? Math.floor(body / n);
  if (bps < 1 || bps > 4 || bps * n > body) return null;
  const out = { ...header, bytes_per_sample: bps, body_bytes: body };
  if (bps === 2) {
    const samples = [];
    for (let i = 0; i < n; i += 1) {
      const v = i16(data, LABRADOR_STATUS_HEADER_LEN + 2 * i);
      if (v === null) break;
      samples.push(v);
    }
    out.filtered_ecg_data_raw = samples;
    out.sample_count_decoded = samples.length;
  } else {
    out.raw_ecg_blob_hex = hexOf(data, LABRADOR_STATUS_HEADER_LEN, LABRADOR_STATUS_HEADER_LEN + bps * n);
  }
  out.experimental = true;
  out.product_metric = false;
  out.voltage_scale = null;
  out.carrier_unproven = true;
  return out;
}
