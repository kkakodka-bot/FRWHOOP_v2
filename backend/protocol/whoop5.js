// WHOOP 5.0 / MG deep decoder — dispatcher + compatibility layer.
//
// DECODER VERSION frwhoop-js/2: the gen5 record layouts (v18/v20/v21/v22/v26)
// live in gen5.js (evidence sources: ryanbr/noop @2fe3a5c9 FACTS ONLY +
// OpenStrap/protocol @c78c1762 MIT + judes.club facts). This module keeps the
// stable public surface the rest of the repo imports:
//   - decodeWhoop5Historical(frame) -> { parsed, mapped } with BOTH the new
//     canonical fields and legacy alias keys (layout_marker, gravity_mag,
//     channel_bX_Y, ppg_waveform, rr_intervals, sensor_channel_samples) so the
//     imuArchive / redecode / metrics consumers keep working during migration.
//   - decodeMetadata / decodeCommandResponse / decodeEvent / decodeConsoleLogs
//   - decodeRealtimeRaw43 (types 43/52 shared-buffer dispatch)
//   - decodeLive51, classifyHist52, decodeConfigReadBack
//   - Puffin-54 re-exports (puffin54.js unchanged)
//
// SUPERSEDED READINGS (supersession recorded in registry.js CONFLICTS):
//   - v26 "24 i16 PPG samples @27..75" -> 24 saturated i16 deltas over a
//     25-sample window (first sample i32 @23). The legacy `ppg_waveform` key is
//     now populated from the RECONSTRUCTED 25-sample window.
//   - v20 channels: i32 sign-extended 20-bit containers with the eleven-field
//     neutral head; legacy channel_bX_Y keys retained.
//   - v21: decode EXACTLY the declared countA/countB samples (never stale
//     trailing bytes); legacy 100-sample keys retained when full.
//   - v18: RR [200,2500] ms cap 4; HR gate 25..230 with 0 = absent; accel
//     fields gated on full scale only (gen4 1 g window removed - conflict
//     v18.gravity_vector); flags@10 + Q15 subsec@19 decoded.

import {
  decodeGen5Historical, decodeGen5HistoricalHeader, decodeV18 as gen5V18,
  decodeV20 as gen5V20, decodeV22 as gen5V22, decodeV26 as gen5V26Imp,
  decodeGen5ImuBuffer as decodeGen5ImuBufferImpl, isGen5ImuBuffer,
  decodeLive51 as gen5Live51, reconstructSaturatedDeltaWindow,
  decodeLabradorEcgPayload, decodeLabradorStatusHeader,
  LABRADOR_STATUS_HEADER_LEN, ACCEL_SCALE_G_PER_LSB, GYRO_SCALE_DPS_PER_LSB,
  RR_MIN_MS, RR_MAX_MS,
} from './gen5.js';
import { decodePuffinEvents54, readPuffin54Structure, PUFFIN54_DECODER_VERSION, PUFFIN54_CANDIDATE_NAMES, puffin54DebugEnabled, puffin54Log } from './puffin54.js';

export {
  decodePuffinEvents54, readPuffin54Structure, PUFFIN54_DECODER_VERSION,
  PUFFIN54_CANDIDATE_NAMES, puffin54DebugEnabled, puffin54Log,
};
export {
  decodeGen5HistoricalHeader, isGen5ImuBuffer,
  decodeLabradorEcgPayload, decodeLabradorStatusHeader,
  LABRADOR_STATUS_HEADER_LEN, ACCEL_SCALE_G_PER_LSB, GYRO_SCALE_DPS_PER_LSB,
};
export { reconstructSaturatedDeltaWindow };

// ---- bail-safe readers (legacy helpers for non-historical decoders) ----
function u8(buf, off) { return (off >= 0 && off < buf.length) ? buf[off] : null; }
function u16(buf, off) { return (off + 2 <= buf.length) ? (buf[off] | (buf[off + 1] << 8)) >>> 0 : null; }
function u32(buf, off) {
  return (off + 4 <= buf.length)
    ? ((buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0) : null;
}
function i16(buf, off) { const v = u16(buf, off); return v === null ? null : (v << 16 >> 16); }
function i32(buf, off) { const v = u32(buf, off); return v === null ? null : (v | 0); }
function hexOf(buf, from, to) {
  let out = '';
  for (let i = from; i < Math.min(to, buf.length); i += 1) out += buf[i].toString(16).padStart(2, '0');
  return out;
}
function strideSamples(buf, off, count, reader, stride) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const v = reader(buf, off + i * stride);
    if (v === null) break;
    out.push(v);
  }
  return out;
}

// =============================================================================
// Historical dispatch: v21 shape-first, then the hist_version byte.
// Returns { parsed, mapped } - `parsed` carries canonical fields + legacy
// aliases + coverage. Never throws.
// =============================================================================
export function decodeWhoop5Historical(frame) {
  const buf = frame instanceof Uint8Array ? frame : Uint8Array.from(frame || []);
  const version = buf.length > 9 ? buf[9] : -1;
  if (isGen5ImuBuffer(buf)) {
    return { parsed: gen5ImuView(buf), mapped: true, decoder: 'gen5-v21-shape' };
  }
  if (buf.length > 9 && buf[8] !== 0x2F) {
    return { parsed: { hist_version: version }, mapped: false, reason: 'record_class is not 0x2F' };
  }
  switch (version) {
    case 18: {
      const r = gen5V18(buf);
      return { parsed: v18View(buf, r), mapped: true, decoder: 'gen5-v18' };
    }
    case 20: {
      const r = gen5V20(buf);
      return { parsed: v20View(buf, r), mapped: true, decoder: 'gen5-v20' };
    }
    case 22: {
      const r = gen5V22(buf);
      return { parsed: v22View(buf, r), mapped: Boolean(r.fields.known_layout), decoder: 'gen5-v22' };
    }
    case 26: {
      const r = gen5V26Imp(buf);
      return { parsed: v26View(buf, r), mapped: true, decoder: 'gen5-v26-pip' };
    }
    default:
      return { parsed: { hist_version: version }, mapped: false, decoder: null };
  }
}

// ---- adapters: canonical gen5 results -> legacy `parsed` views ----
function baseView(r) {
  const p = { ...r.fields };
  p.decode_warnings = r.warnings;
  p.confidence = r.confidence;
  p.coverage = r.coverage?.summary || null;
  p.unknown_spans = r.coverage?.unknown || [];
  return p;
}
function gen5ImuView(buf) {
  const r = decodeGen5ImuBufferImpl(buf);
  const p = { ...r.fields };
  p.decode_warnings = r.warnings;
  p.confidence = r.confidence;
  p.coverage = r.coverage?.summary || null;
  p.unknown_spans = r.coverage?.unknown || [];
  p.layout_marker = r.fields.flags;
  p.hist_version = r.fields.hist_version ?? 21;
  p.lineage = 'frwhoop-gen5/2 <- noop@2fe3a5c9 + openstrap@c78c1762';
  return p;
}
function v18View(buf, r) {
  const p = { ...r.fields };
  p.decode_warnings = r.warnings;
  p.confidence = r.confidence;
  p.coverage = r.coverage?.summary || null;
  p.unknown_spans = r.coverage?.unknown || [];
  p.hist_version = 18;
  // legacy heart_rate contract: 0 = the band's own absent sentinel.
  p.heart_rate = r.fields.heart_rate ?? 0;
  p.rr_intervals = r.fields.rr_intervals_ms || [];
  p.gravity_x = r.fields.gravity_or_accel_means?.[0];
  p.gravity_y = r.fields.gravity_or_accel_means?.[1];
  p.gravity_z = r.fields.gravity_or_accel_means?.[2];
  p.gravity_mag = r.fields.gravity_mag_validator;
  p.optical_baseline_a = r.fields.optical_baseline_ab?.[0];
  p.optical_baseline_b = r.fields.optical_baseline_ab?.[1];
  const rawAmp0 = u8(buf, 108), rawAmp1 = u8(buf, 109);
  if (rawAmp0 !== null) { p.optical_amp_a = rawAmp0; p.optical_amp_b = rawAmp1; }
  p.unknown_f32_113 = r.fields.f32_113;
  p.onwrist = r.fields.primary_flags_bit8_or_onwrist;
  p.wake_quality = r.fields.strap_fit_or_wake_quality;
  const ac = r.fields.activity_class;
  if (ac === 0 || ac === 1 || ac === 2) p.motion_wear_quality = ac;
  p.lineage = 'frwhoop-gen5/2 <- noop@2fe3a5c9 + openstrap@c78c1762';
  return p;
}
function v20View(buf, r) {
  const p = { ...r.fields };
  p.decode_warnings = r.warnings;
  p.confidence = r.confidence;
  p.coverage = r.coverage?.summary || null;
  p.unknown_spans = r.coverage?.unknown || [];
  p.hist_version = 20;
  p.layout_marker = r.fields.flags;
  for (let b = 0; b < 5; b += 1) {
    p[`block_b${b}_sample_count`] = r.fields[`block_${b}_sample_count`] ?? 0;
    for (const s of [0, 1]) {
      const arr = r.fields[`block_${b}_slot_${s}_samples`];
      p[`channel_b${b}_${s}`] = arr; // undefined when the block is empty (legacy behavior)
    }
  }
  p.lineage = 'frwhoop-gen5/2 <- noop@2fe3a5c9 + openstrap@c78c1762';
  return p;
}
function v22View(buf, r) {
  const p = { ...r.fields };
  p.decode_warnings = r.warnings;
  p.confidence = r.confidence;
  p.coverage = r.coverage?.summary || null;
  p.unknown_spans = r.coverage?.unknown || [];
  p.hist_version = 22;
  p.lineage = 'frwhoop-gen5/2 <- openstrap@c78c1762 (v22 layout; noop has no v22)';
  return p;
}
function v26View(buf, r) {
  const p = { ...r.fields };
  p.decode_warnings = r.warnings;
  p.confidence = r.confidence;
  p.coverage = r.coverage?.summary || null;
  p.unknown_spans = r.coverage?.unknown || [];
  p.hist_version = 26;
  // legacy: ppg_waveform is now the RECONSTRUCTED 25-sample window (the old
  // 24-i16 flat reading was WRONG: bytes 27..75 are saturated deltas).
  p.ppg_waveform = r.fields.ppg_window_reconstruction?.samples || [];
  p.ppg_sample_count = p.ppg_waveform.length;
  p.lineage = 'frwhoop-gen5/2 <- openstrap@c78c1762 (saturated-delta model; supersedes noop 24-i16 reading)';
  return p;
}
// =============================================================================
// WHOOP5 METADATA (type 49) — history drive bookkeeping. NOOP decodeWhoop5Metadata.
// =============================================================================
function decodeMetadata(buf) {
  const out = {};
  const unix = u32(buf, 11);   if (unix !== null) out.unix = unix;
  const ss = u16(buf, 15);     if (ss !== null) out.subsec = ss;
  const trim = u32(buf, 21);   if (trim !== null) out.trim_cursor = trim;
  return out;
}

// =============================================================================
// WHOOP5 COMMAND_RESPONSE (type 36). NOOP decodeWhoop5CommandResponse.
// =============================================================================
const COMMAND_RESULT = { 0: 'FAILURE', 1: 'SUCCESS', 2: 'PENDING', 3: 'UNSUPPORTED' };
function decodeCommandResponse(buf, payloadEnd) {
  const out = {};
  if (payloadEnd === null || payloadEnd <= 11 || payloadEnd > buf.length) return out;
  const respCmd = u8(buf, 10);   if (respCmd !== null) out.resp_command = respCmd;
  const payEnd = payloadEnd;
  const pay = Array.from(buf.slice(11, payEnd));
  out.resp_seq = pay[0];
  if (pay.length >= 2) out.result = COMMAND_RESULT[pay[1]] || String(pay[1]);
  // ADVERSARIAL FIX (final audit): only interpret value fields when the reply is SUCCESS (result==1).
  // A FAILURE/UNSUPPORTED reply must never leak envelope padding as a bogus battery% / range / name.
  const success = pay.length >= 2 && pay[1] === 1;
  if (success && pay.length >= 3) {
    // GET_BATTERY_LEVEL (26): battery percentage at pay[2] (direct % on WHOOP5)
    if (respCmd === 26) out.battery_pct = pay[2];
  }
  if (success && respCmd === 34 && pay.length >= 7) {   // GET_DATA_RANGE
    let oldest = 0xFFFFFFFF, newest = 0;
    for (let o = 3; o + 4 <= pay.length; o += 4) {
      const v = ((pay[o] | (pay[o+1] << 8) | (pay[o+2] << 16) | (pay[o+3] << 24)) >>> 0);
      if (v >= 1600000000 && v <= 1800000000) { oldest = Math.min(oldest, v); newest = Math.max(newest, v); }
    }
    if (newest > 0) { out.history_oldest = oldest; out.history_newest = newest; }
  } else if (success && respCmd === 145 && pay.length >= 26) {   // GET_HELLO
    let nameBytes = [];
    let i = 16;
    while (i < pay.length && pay[i] !== 0 && (32 <= pay[i] && pay[i] <= 126) && nameBytes.length < 24) {
      nameBytes.push(pay[i]); i++;
    }
    if (nameBytes.length >= 6) out.device_name = String.fromCharCode(...nameBytes);
    if (pay.length >= 97 && pay[93] === 50) {
      out.fw_version = [pay[93], pay[94], pay[95], pay[96]].join('.');
    }
  }
  return out;
}

// =============================================================================
// WHOOP5 EVENT (type 48). NOOP decodeWhoop5Event (BATTERY_LEVEL payload).
// Event name from the shared EventNumber schema (decoder.js dispatch).
// Family-aware: harvard event u8@6 / ts u32@8; puffin event u8@10 / ts u32@12.
// BATTERY_LEVEL payload (NOOP-verified, frame-absolute):
//   puffin: soc u16@21 (deci-percent, /10), mV u16@25 (3000..4300), charging u8@30 (<=1)
//   harvard: soc u16@17 (/10), mV u16@21, charging u8@26
// EXTENDED_BATTERY_INFORMATION (63): harvard-only heuristic mV scan (NOOP
// PostHooks.swift:140-155); 5/MG payload has no ground truth and stays raw.
// Every other event keeps its payload as raw hex — unknown stays unknown.
// =============================================================================
function decodeEvent(buf, family, schemaEventName) {
  const out = {};
  const puffin = family === 'puffin';
  // Event id is u16 LE @10 (puffin) / @6 (harvard): the unified event envelope
  // carries ids >= 109 in the HIGH byte (340k-frame corpus, sibling session
  // 01a05630). A u8 read silently truncates 109/110/111/112/116/117/120/123.
  const ev = u16(buf, puffin ? 10 : 6); if (ev !== null) out.event = ev;
  out.event_id_wide = ev != null && ev > 255;
  const ts = u32(buf, puffin ? 12 : 8); if (ts !== null) out.event_timestamp = ts;
  if (schemaEventName === 'BATTERY_LEVEL') {
    // unified body: [0]=revision, [1:3]=SoC u16 deci-percent, [5:7]=mV u16,
    // charging bit @body[10] (puffin frame 30) - 42k-frame corpus-validated.
    const body = puffin ? 20 : 16; // harvard body starts at 16 (rev@16, soc@17, mV@21, charging@26)
    out.battery_body_revision = u8(buf, body);
    const raw = u16(buf, body + 1);
    if (raw !== null && raw <= 1100) out.battery_pct = raw / 10;
    const mv = u16(buf, body + 5);
    if (mv !== null && mv >= 3000 && mv <= 4300) out.battery_mV = mv;
    const counter = u16(buf, body + 7);
    if (counter !== null) out.battery_counter = counter;
    const ch = u8(buf, body + 10);
    if (ch !== null && ch <= 1) out.battery_charging = ch & 1;
  } else if (schemaEventName === 'EXTENDED_BATTERY_INFORMATION' && !puffin) {
    // NOOP heuristic: scan the payload for any u16 in the li-ion range.
    const payloadEnd = buf.length - 4;
    for (let o = 17; o + 2 <= payloadEnd; o++) {
      const v = u16(buf, o);
      if (v !== null && v >= 3000 && v <= 4300) { out.battery_mV = v; break; }
    }
  }
  return out;
}

// =============================================================================
// WHOOP5 CONSOLE_LOGS (type 50). NOOP decodeWhoop5ConsoleLogs.
// =============================================================================
function decodeConsoleLogs(buf, payloadEnd) {
  const out = {};
  const idx = u16(buf, 9);    if (idx !== null) out.record_index = idx;
  const unix = u32(buf, 12);  if (unix !== null) out.unix = unix;
  const ss = u16(buf, 16);    if (ss !== null) out.subsec = ss;
  if (payloadEnd === null || payloadEnd <= 21 || payloadEnd > buf.length) return out;
  let text = Array.from(buf.slice(21, payloadEnd));
  while (text.length && text[text.length - 1] === 0) text.pop();
  if (text.length) out.log = Buffer.from(text).toString('utf8').slice(0, 2048);
  return out;
}

// =============================================================================
// HISTORICAL_IMU_DATA_STREAM (packet 52) - when the strap banks an IMU buffer
// under type 52 it wears the SAME v21 shape (handled by the shared
// decodeGen5ImuBuffer via decodeWhoop5Historical). For bodies the versioned
// dispatch does NOT map, this helper attaches a labeled plausibility note only.
// whoop-vault's [epoch u32][rate u16] header remains UNVERIFIED.
// =============================================================================
export function classifyHist52(buf) {
  const note = 'layout unknown; whoop-vault reports [epoch u32][rate u16] + N x 12 B samples (unverified)';
  const epoch = u32(buf, 10);
  const rate = u16(buf, 14);
  const plausible = epoch !== null && rate !== null
    && epoch >= 1500000000 && epoch <= 1800000000 && rate >= 1 && rate <= 1000;
  return { layout_note: note, vault_header_plausible: Boolean(plausible) };
}

export { isGen5ImuBuffer as isWhoop5ImuShape };

export function decodeLive51(buf, opts = {}) {
  return gen5Live51(buf, opts);
}

// =============================================================================
// REALTIME_RAW_DATA (type 43) - shared-buffer dispatch (registry
// puffin/imu_buffer): a WHOOP5 (puffin) 0x2B body wearing the v21 IMU shape is
// decoded by ONE decoder with the historical v21 path. The gen4 (harvard)
// variants keep NOOP's length-keyed layouts (1917 IMU / 1921 optical), verified
// against golden.json. Unmapped variants preserve bytes and report spans.
// =============================================================================
export const RAW43 = {
  imu: {
    whoop4: { lenKey: 1917, hr: 21, rrCount: 22, rrFirst: 23,
              axes: [['accel_x', 89], ['accel_y', 289], ['accel_z', 489],
                     ['gyro_x', 692], ['gyro_y', 892], ['gyro_z', 1092]], tail: 1292, samples: 100 },
  },
  optical: {
    whoop4: { lenKey: 1921, configFrom: 15, configTo: 42, ppgOff: 42, stride: 4, samples: 419 },
    whoop5: { configFrom: 19, configTo: 46, ppgOff: 46, stride: 4, samples: 419 },
  },
  accelScaleG: 1 / 4096,
  gyroScaleDps: 2000 / 32768,
  opticalRateHz: 437,
};

export function readS24(buf, off) {
  if (off + 3 > buf.length) return null;
  let v = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
  if (buf[off + 2] & 0x80) v |= 0xFF000000;
  return (v | 0);
}

function decodeImeArray(buf, cfg) {
  const chs = {};
  for (const [name, off] of cfg.axes) {
    const s = strideSamples(buf, off, cfg.samples, i16, 2);
    if (s.length === cfg.samples) chs[name] = s;
  }
  if (Object.keys(chs).length !== 6) return null;
  return chs;
}

export function decodeRealtimeRaw43(frame, family) {
  const buf = frame instanceof Uint8Array ? frame : Uint8Array.from(frame);
  const gen = family === 'puffin' ? 'whoop5' : 'whoop4';
  const out = {
    decode_status: 'unknown', confidence: 'low', kind: 'unknown',
    timestamp: u32(buf, gen === 'whoop4' ? 11 : 15),
    raw_length: buf.length,
  };
  if (gen === 'whoop4') {
    const declaredLen = u16(buf, 1) ?? (buf.length - 4);
    const dataLen = declaredLen - 7;
    const imuCfg = RAW43.imu.whoop4, optCfg = RAW43.optical.whoop4;
    if (dataLen === imuCfg.lenKey) {
      const chs = decodeImeArray(buf, imuCfg);
      if (chs) {
        out.decode_status = 'decoded'; out.confidence = 'medium'; out.kind = 'imu';
        out.variant = '1917'; out.heart_rate = u8(buf, imuCfg.hr); out.rr_count = u8(buf, imuCfg.rrCount);
        const rrCount = u8(buf, imuCfg.rrCount) ?? 0;
        const rrCap = Math.min(rrCount, 4);
        out.rr = [];
        for (let i = 0; i < rrCap; i += 1) {
          const v = u16(buf, imuCfg.rrFirst + i * 2);
          if (v !== null && v >= RR_MIN_MS && v <= RR_MAX_MS) out.rr.push(v);
        }
        Object.assign(out, chs);
        out.samples_per_axis = imuCfg.samples; out.sample_rate_hz = 100;
        out.accel_scale_g_per_lsb = RAW43.accelScaleG; out.gyro_scale_dps_per_lsb = RAW43.gyroScaleDps;
        out.axes = imuCfg.axes.map(([n, o]) => ({ channel: n, offset: o }));
        out.tail_bytes = buf.slice(imuCfg.tail, buf.length - 4);
        out.unmapped_tail_bytes = out.tail_bytes.length;
        return out;
      }
    } else if (dataLen === optCfg.lenKey) {
      const samples = [], aux = [];
      const n = Math.min(optCfg.samples, Math.floor((buf.length - optCfg.ppgOff) / optCfg.stride));
      for (let i = 0; i < n; i += 1) {
        const v = readS24(buf, optCfg.ppgOff + i * optCfg.stride);
        if (v === null) break;
        samples.push(v); aux.push(u8(buf, optCfg.ppgOff + i * optCfg.stride + 3));
      }
      if (samples.length) {
        out.decode_status = 'decoded'; out.confidence = 'medium'; out.kind = 'optical';
        out.variant = '1921'; out.optical_ac = samples; out.optical_aux = aux;
        out.optical_config_header = buf.slice(optCfg.configFrom, optCfg.configTo);
        out.samples = samples.length; out.sample_rate_hz = RAW43.opticalRateHz;
        return out;
      }
    }
    return out;
  }
  // WHOOP5 (puffin): the 1244-byte v21 IMU shape is the observed live variant
  // (registry puffin/imu_buffer). ONE decoder for 43/47/51/52.
  if (isGen5ImuBuffer(buf)) {
    const r = decodeGen5ImuBufferImpl(buf, { collectCoverage: false });
    out.decode_status = 'decoded'; out.confidence = 'medium'; out.kind = 'imu';
    out.variant = '1244(v21-shape-observed)';
    out.layout = 'whoop5-v21-shape';
    out.heart_rate = null; out.rr_count = null; // the v21 body carries no HR
    Object.assign(out, r.fields);
    out.samples_per_axis = r.fields.count_a;
    out.sample_rate_hz = 100;
    out.sample_rate_provenance = 'inferred_from_declared_counts_per_1s_record';
    out.sample_timestamps = 'not_on_wire';
    out.accel_scale_g_per_lsb = RAW43.accelScaleG; out.gyro_scale_dps_per_lsb = RAW43.gyroScaleDps;
    out.axes = [['accel_x', 28], ['accel_y', 228], ['accel_z', 428], ['gyro_x', 640], ['gyro_y', 840], ['gyro_z', 1040]]
      .map(([n, o]) => ({ channel: n, offset: o }));
    return out;
  }
  // Other 5/MG realtime-raw bodies: preserve + classify. MG ECG candidates are
  // triaged by decodeLabradorStatusHeader elsewhere; never invented here.
  return out;
}

// =============================================================================
// Read-only feature-flag / device-config read-back decoder.
//
// Commands 117/118 (feature-flag exchange/next), 115/116 (device-config exchange/
// next), 121 GET_DEVICE_CONFIG_VALUE, 128 GET_FF_VALUE are legitimately read-only.
// NOOP's DeviceConfigReadProbe decodes the reply as: COMMAND_RESPONSE payload =
// [lead 0x0A][result u8][b3 lead 0x01][32-byte NUL-padded key name][value u8 after
// the name field]. The 5/MG envelope pads the inner to a 4-byte boundary, so up to
// three trailing NULs are envelope padding — read the value as "the byte right
// after the echoed name field", never "the last byte".
//
// We surface the echoed key + value + result so FRWHOOP can drive read-only
// capability enumeration without guessing opcodes on the wire.
// =============================================================================
const READ_BACK_CMDS = new Set([117, 118, 115, 116, 121, 128]);

export function decodeConfigReadBack(frame, family) {
  const buf = Array.from(frame);
  const gen = family === 'puffin' ? 'whoop5' : 'whoop4';
  const respCmd = u8(buf, gen === 'whoop4' ? 6 : 10);
  if (respCmd === null || !READ_BACK_CMDS.has(respCmd)) return null;
  const out = { cmd: respCmd, result: null, key: null, value: null, raw_record: null };
  const payloadStart = gen === 'whoop4' ? 7 : 11;
  const payloadEnd = buf.length - 4;
  if (payloadEnd <= payloadStart) return out;
  const pay = buf.slice(payloadStart, payloadEnd);
  if (pay.length >= 2) out.result = COMMAND_RESULT[pay[1]] || String(pay[1]);
  if (respCmd === 121 || respCmd === 128) {
    // record starts after the [0x0A][result] header; iterated exchange replies
    // (117/118, 115/116) carry key lists we leave raw for now.
    let rec = pay.slice(2);
    if (rec.length >= 33) {
      // rec[0] is the b3 lead (0x01); rec[1..33] is the 32-byte name field.
      let name = rec.slice(1, 33);
      // trim NUL padding
      let end = name.length;
      while (end > 0 && name[end - 1] === 0) end--;
      const key = Buffer.from(name.slice(0, end)).toString('utf8');
      if (key) out.key = key;
      out.value = rec[33];
    }
  }
  out.raw_record = pay;
  return out;
}


// Legacy single-version aliases (gen5-backed). NOTE: v18/v26 now return the
// frwhoop-gen5/2 corrected views; see registry.js for supersession records.
export const decodeV18 = (b) => gen5V18(b);
export const decodeV20 = (b) => gen5V20(b);
export const decodeV21 = (b) => decodeGen5ImuBufferImpl(b);
export { gen5V26Imp as decodeV26 };
// decodeV2021 legacy name: v20 -> optical-buffer view, v21 -> shared IMU buffer.
export const decodeV2021 = (b, version = null) => {
  const v = version ?? (b && b.length > 9 ? b[9] : null);
  if (v === 21 || isGen5ImuBuffer(b)) return decodeGen5ImuBufferImpl(b);
  return gen5V20(b);
};

const whoop5Deep = {
  decodeHistorical: decodeWhoop5Historical,
  decodeMetadata,
  decodeCommandResponse,
  decodeEvent,
  decodeConsoleLogs,
  decodeV18,
  decodeV20,
  decodeV21,
  decodeV22: (b) => gen5V22(b),
  decodeV26: gen5V26Imp,
  decodeGen5ImuBuffer: decodeGen5ImuBufferImpl,
  reconstructSaturatedDeltaWindow,
  decodeLive51,
  COMMAND_RESULT,
};

export { decodeMetadata, decodeCommandResponse, decodeEvent, decodeConsoleLogs, whoop5Deep };
