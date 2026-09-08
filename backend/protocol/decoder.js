// Versioned WHOOP frame decoder for the FRWHOOP redecode pipeline.
//
// This is an INDEPENDENT re-implementation of the protocol interpretation used
// by the redecode/replay path. It is deliberately separate from the live iOS
// decoder. Protocol facts are sourced from the NOOP whoop_protocol.json and
// Framing.swift (commit references recorded in PROTOCOL_COVERAGE.md). No sensor
// identity is invented here: uncertain channels are reported as neutral u8/i16
// arrays with `confidence:"low"` and never given a medical label.
//
// Contract:
//   - A raw frame is immutable evidence.
//   - A decoder is a versioned interpretation of that evidence.
//   - Every decoded record carries lineage: the originating frame bytes/hash
//     and the decoder version that produced it, so a newer decoder can be run
//     against the same historical frame later (redecode).
//   - Unknown / CRC-failed frames are still returned (with
//     `decode_status:"unknown"` / `"crc_failed"`), never discarded.
//   - decodeFrame never throws. Callers pass verified bytes; anything malformed
//     degrades to a status that still preserves the raw bytes.

import { createHash } from 'node:crypto';
import {
  decodeWhoop5Historical, decodeMetadata, decodeCommandResponse,
  decodeEvent, decodeConsoleLogs, decodeRealtimeRaw43, decodeConfigReadBack,
  decodeLive51, classifyHist52,
} from './whoop5.js';
import { decodePuffinEvents54, PUFFIN54_DECODER_VERSION } from './puffin54.js';
import { verifyFrame } from './framing.js';
import { SUBSEC_TICKS_PER_SECOND, strapTimeMs } from '../time/strapTime.js';
import { buildCoverage, envelopeSpans } from './coverage.js';
import { REGISTRY_VERSION } from './registry.js';

export const DECODER_VERSION = 'frwhoop-js/2';
// Deep WHOOP5 semantic decoder (v18/v20/v21/v22/v26, metadata, cmd-response,
// event, console) — frwhoop-gen5/2 evidence set: ryanbr/noop @2fe3a5c9 (facts)
// + OpenStrap/protocol @c78c1762 + judes.club (facts). Lineage per record.
export const NOOP_SOURCE_COMMIT = '2fe3a5c9';
export const NOOP_BASELINE_COMMIT = 'ab0f699e';
export const OPENSTRAP_COMMIT = 'c78c1762';
export const DECODER_LINEAGE = `frwhoop-js/2 <- noop@${NOOP_SOURCE_COMMIT} + openstrap@${OPENSTRAP_COMMIT}`;

// Packet type registry (whoop_protocol.json enums.PacketType).
export const PACKET_TYPES = {
  35: 'COMMAND',
  36: 'COMMAND_RESPONSE',
  37: 'PUFFIN_COMMAND',
  38: 'PUFFIN_COMMAND_RESPONSE',
  40: 'REALTIME_DATA',
  43: 'REALTIME_RAW_DATA',
  47: 'HISTORICAL_DATA',
  48: 'EVENT',
  49: 'METADATA',
  50: 'CONSOLE_LOGS',
  51: 'REALTIME_IMU_DATA_STREAM',
  52: 'HISTORICAL_IMU_DATA_STREAM',
  53: 'RELATIVE_PUFFIN_EVENTS',
  54: 'PUFFIN_EVENTS_FROM_STRAP',
  55: 'RELATIVE_BATTERY_PACK_CONSOLE_LOGS',
  56: 'PUFFIN_METADATA',
};

// EventNumber schema (subset emitted on WHOOP5, NOOP whoop_protocol.json).
export const EVENT_NUMBERS = {
  3: 'BATTERY_LEVEL', 9: 'WRIST_ON', 10: 'WRIST_OFF', 11: 'BLE_CONNECTION_UP',
  12: 'BLE_CONNECTION_DOWN', 14: 'DOUBLE_TAP', 15: 'BOOT', 17: 'TEMPERATURE_LEVEL',
  29: 'STRAP_CONDITION_REPORT', 30: 'BOOT_REPORT', 32: 'CAPTOUCH_AUTOTHRESHOLD_ACTION',
  33: 'BLE_REALTIME_HR_ON', 34: 'BLE_REALTIME_HR_OFF', 40: 'CH1_SATURATION_DETECTED',
  41: 'CH2_SATURATION_DETECTED', 42: 'ACCELEROMETER_SATURATION_DETECTED',
  46: 'RAW_DATA_COLLECTION_ON', 47: 'RAW_DATA_COLLECTION_OFF',
  63: 'EXTENDED_BATTERY_INFORMATION', 96: 'HIGH_FREQ_SYNC_PROMPT',
  97: 'HIGH_FREQ_SYNC_ENABLED', 98: 'HIGH_FREQ_SYNC_DISABLED', 100: 'HAPTICS_TERMINATED',
};

// Type 43 REALTIME_RAW_DATA variants (whoop_protocol.json). The variant is
// selected by the record header. Neutral channels only.
const REALTIME_RAW_VARIANTS = {
  imu: {
    kind: 'imu',
    hr_off: 21,
    rr_count_off: 22,
    rr_first_off: 23,
    samples: 100,
    axes: [
      ['accelX', 89], ['accelY', 289], ['accelZ', 489],
      ['gyroX', 692], ['gyroY', 892], ['gyroZ', 1092],
    ],
    accel_scale: 0.000244140625,
    gyro_scale: 0.06103515625,
  },
  optical: {
    kind: 'optical',
    ppg_off: 42,
    ppg_stride: 4,
    ppg_dtype: 's24',
    ppg_samples: 419,
    ppg_rate_hz: 437,
  },
};

function hexOf(buf, from, to) {
  let out = '';
  for (let i = from; i < to; i += 1) out += buf[i].toString(16).padStart(2, '0');
  return out;
}

function sha256(buf) {
  return createHash('sha256').update(Buffer.from(buf)).digest('hex');
}

function u16le(buf, off) {
  if (off + 2 > buf.length) return null;
  return buf[off] | (buf[off + 1] << 8);
}
function u32le(buf, off) {
  if (off + 4 > buf.length) return null;
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

// Family-specific type / seq offsets and REALTIME_DATA field offsets.
// WHOOP 4 (Harvard): envelope is [AA len crc8 type seq ...] -> type@4, seq@5.
//   timestamp u32@6, subseconds u16@10, hr u8@12, rr_count u8@13.
// WHOOP 5 (Puffin): envelope is [AA 01 len16 header16 crc16 type seq ...] ->
//   type@8, seq@9. timestamp u32@10, subseconds u16@14, hr u8@16, rr_count@17.
function familyOffsets(family) {
  return family === 'puffin'
    ? { type: 8, seq: 9, ts: 10, sub: 14, hr: 16, rrCount: 17, ev: 10, evTs: 12 }
    : { type: 4, seq: 5, ts: 6, sub: 10, hr: 12, rrCount: 13, ev: 6, evTs: 8 };
}

// REALTIME_DATA (type 40) with strict R-R validation (registry realtime/40):
// declared count capped at the 4 slots the form has; each interval must sit in
// [200, 2500] ms (openstrap kMinRrMs/kMaxRrMs); wire order preserved; an
// out-of-range slot contributes nothing and is reported, never fabricated.
export const RR_MIN_MS_RT = 200;
export const RR_MAX_MS_RT = 2500;

function decodeRealtimeData(buf, family, offs) {
  const warnings = [];
  const ts = u32le(buf, offs.ts);
  const sub = u16le(buf, offs.sub);
  const hrByte = offs.hr < buf.length ? buf[offs.hr] : null;
  const rrDeclared = offs.rrCount < buf.length ? buf[offs.rrCount] : 0;
  const rrs = [];
  const payloadEnd = buf.length >= 4 ? buf.length - 4 : 0;
  // Historical v18/Harvard realtime form has four RR slots. Puffin Type-40
  // realtime is bounded only by complete u16 values before the CRC trailer.
  const fourSlot = family !== 'puffin';
  if (fourSlot && rrDeclared > 4) {
    warnings.push(`rr_count ${rrDeclared} exceeds the 4-slot form - capped at 4`);
  }
  const rrBase = offs.rrCount + 1;
  const fit = Math.max(0, Math.floor((payloadEnd - rrBase) / 2));
  const want = fourSlot ? Math.min(rrDeclared, 4) : rrDeclared;
  const truncated = Math.max(0, want - fit);
  let zeroSlots = 0;
  let outOfRange = 0;
  for (let i = 0; i < Math.min(want, fit); i += 1) {
    const off = rrBase + i * 2;
    if (off + 2 > payloadEnd) break;
    const v = u16le(buf, off);
    if (v === null) break;
    if (v === 0) { zeroSlots += 1; continue; }
    if (v >= RR_MIN_MS_RT && v <= RR_MAX_MS_RT) rrs.push(v);
    else {
      outOfRange += 1;
      warnings.push(`rr[${i}]=${v} ms outside [200,2500] - slot rejected`);
    }
  }
  const spans = family === 'puffin'
    ? [
        { from: 10, to: 14, cls: 'decoded', name: 'timestamp' },
        { from: 14, to: 16, cls: 'decoded', name: 'subseconds' },
        { from: 16, to: 17, cls: 'decoded', name: 'heart_rate' },
        { from: 17, to: 18, cls: 'decoded', name: 'rr_count' },
        { from: 18, to: 18 + 2 * rrs.length, cls: 'decoded', name: 'rr_intervals' },
      ]
    : [
        { from: 6, to: 10, cls: 'decoded', name: 'timestamp' },
        { from: 10, to: 12, cls: 'decoded', name: 'subseconds' },
        { from: 12, to: 13, cls: 'decoded', name: 'heart_rate' },
        { from: 13, to: 14, cls: 'decoded', name: 'rr_count' },
        { from: 14, to: 14 + 2 * rrs.length, cls: 'decoded', name: 'rr_intervals' },
      ];
  return {
    decode_status: hrByte != null && hrByte >= 20 && hrByte <= 240 ? 'decoded' : 'partial',
    confidence: hrByte != null && hrByte >= 20 && hrByte <= 240 ? 'high' : 'low',
    timestamp: ts,
    subseconds: sub,
    subsec_seconds: sub === null ? null : sub / SUBSEC_TICKS_PER_SECOND,
    sensor_time_ms: strapTimeMs(ts, sub),
    packet_sequence: offs.seq < buf.length ? buf[offs.seq] : null,
    heart_rate: hrByte != null && hrByte >= 20 && hrByte <= 240 ? hrByte : null,
    hr: hrByte != null && hrByte >= 20 && hrByte <= 240 ? hrByte : null,
    rr_count_declared: rrDeclared,
    rr_intervals: rrs,
    rr_count: rrs.length,
    rr_zero_slots: zeroSlots,
    rr_out_of_range: outOfRange,
    rr_truncated_count: truncated,
    warnings,
    coverage: buildCoverage(buf.length, [...envelopeSpans(buf.length, family === 'puffin' ? 'puffin' : 'harvard'), ...spans], { warnings, confidence: hrByte != null && hrByte >= 20 && hrByte <= 240 ? 'high' : 'low' }),
  };
}

function decodeRealtimeRaw(buf, family, offs, extra = {}) {
  // Read the record header + variant selection bytes neutrally.
  const ts = u32le(buf, offs.ts);
  const sub = u16le(buf, offs.sub);
  const header = hexOf(buf, 17, Math.min(21, buf.length));
  const variantByte = buf.length > 21 ? buf[21] : null;
  const sel = extra.variant ? extra.variant : (variantByte !== null ? String(variantByte) : null);
  const variant = REALTIME_RAW_VARIANTS[sel] || null;
  const out = {
    decode_status: variant ? 'decoded' : 'unknown',
    confidence: variant ? 'medium' : 'low',
    kind: variant ? variant.kind : 'unknown',
    timestamp: ts !== null ? ts : null,
    subseconds: sub !== null ? sub : null,
    record_header_hex: header,
    variant: sel,
    // Neutral: positions of each axis block so a future decoder can slice it
    // without any semantic claim.
    channel_offsets: variant ? variant.axes.map(([name, off]) => ({ channel: name, offset: off })) : null,
    sample_count_hint: variant ? variant.samples : null,
  };
  return out;
}

function decodeHistorical(buf, family, offs) {
  // The WHOOP historical record carries its version in the envelope seq byte
  // (whoop_protocol.json HISTORICAL note: "Version = seq byte (frame[5])").
  // For puffin the seq byte is at offs.seq.
  const version = offs.seq < buf.length ? buf[offs.seq] : null;
  const ts = u32le(buf, offs.ts);
  const out = {
    decode_status: 'partial', // we identify the version + record header only here
    confidence: 'low',
    version,
    timestamp: ts !== null ? ts : null,
  };
  if (family === 'harvard') {
    // v24/v25 body decode is iOS-only. Do not invent Harvard historical fields.
    out.harvard_type47 = 'header_only';
    out.note = 'WHOOP 4.0 v24/v25 body decode is iOS-only; backend keeps raw_hex and does not invent v24 fields';
  }
  return out;
}

/**
 * Classify + decode a complete verified frame. Returns a decoded record with
 * full lineage. Never throws.
 */
export function decodeFrame(frame, family = 'harvard', { decoder = DECODER_VERSION, frameHash } = {}) {
  const buf = Array.from(frame);
  const hash = frameHash || sha256(buf);
  if (!buf.length || buf[0] !== 0xAA) {
    return {
      decode_status: 'malformed',
      confidence: 'low',
      packet_type: null,
      packet_name: null,
      version: null,
      raw_hex: hexOf(buf, 0, buf.length),
      raw_length: buf.length,
      frame_hash: hash,
      decoder,
      family,
      decoded: null,
    };
  }
  const offs = familyOffsets(family);
  const packetType = offs.type < buf.length ? buf[offs.type] : null;
  const version = offs.seq < buf.length ? buf[offs.seq] : null;
  const packetName = PACKET_TYPES[packetType] || null;

  // ADVERSARIAL HARDENING (see FINAL audit Part 25): never let a CRC-invalid frame
  // emit high-confidence physiological fields as if valid. The redecode pipeline also
  // CRC-gates before calling decodeFrame, but defense-in-depth requires the decoder
  // itself to refuse high-confidence decode of a corrupted envelope. Raw bytes are
  // always preserved; the frame is classified crc_failed (distinct from malformed).
  try {
    const check = verifyFrame(buf, family);
    if (check && check.ok !== true) {
      return {
        decode_status: 'crc_failed',
        confidence: 'low',
        packet_type: packetType,
        packet_name: packetName,
        version,
        crc8_ok: check.crc8_ok,
        crc32_ok: check.crc32_ok,
        crc_ok: false,
        raw_hex: hexOf(buf, 0, buf.length),
        raw_length: buf.length,
        frame_hash: hash,
        decoder,
        family,
        decoded: null,
      };
    }
  } catch {
    // verifyFrame never throws; this is belt-and-suspenders. Treat as unverified.
    return {
      decode_status: 'crc_failed', confidence: 'low', packet_type: packetType,
      packet_name: packetName, version, crc_ok: false, raw_hex: hexOf(buf,0,buf.length),
      raw_length: buf.length, frame_hash: hash, decoder, family, decoded: null,
    };
  }

  let decoded = null;
  let status = 'unknown';
  let confidence = 'low';

  if (packetType === 40) {
    decoded = decodeRealtimeData(buf, family, offs);
    status = decoded.decode_status;
    confidence = decoded.confidence;
  } else if (packetType === 43) {
    // Family-aware structural decode of the raw-data variants (1917 IMU / 1921 optical
    // on whoop4, +4-shifted whoop5 hypothesis). Full-resolution arrays preserved.
    const deep = decodeRealtimeRaw43(buf, family);
    if (deep && deep.kind !== 'unknown') {
      decoded = { ...deep, decode_status: deep.decode_status, confidence: deep.confidence,
                  lineage: DECODER_LINEAGE, packet_type: packetType };
      status = deep.decode_status; confidence = deep.confidence;
    } else {
      decoded = decodeRealtimeRaw(buf, family, offs);
      status = decoded.decode_status; confidence = decoded.confidence;
    }
  } else if (packetType === 51 && family === 'puffin') {
    // REALTIME_IMU_DATA_STREAM (51): labeled structural hypotheses (see
    // whoop5.js decodeLive51). Raw bytes always preserved by the caller.
    const deep = decodeLive51(buf);
    decoded = {
      decode_status: deep.mapped ? 'decoded' : 'unknown',
      confidence: deep.mapped ? 'medium' : 'low',
      packet_type: packetType,
      packet_name: PACKET_TYPES[packetType],
      version,
      timestamp: u32le(buf, offs.ts),
      lineage: DECODER_LINEAGE,
      live_imu_stream: true,
      live_layout: deep.layout || null,
      live_hypothesis: deep.hypothesis === true,
      parsed: deep.fields || deep.parsed || {},
      warnings: deep.warnings || [],
    };
    status = deep.mapped ? 'decoded' : 'unknown';
    confidence = decoded.confidence;
  } else if (packetType === 54 && family === 'puffin') {
    // PUFFIN_EVENTS_FROM_STRAP (54): strap-buffered / replayable events.
    // Timestamp is the record stored_unix, not the envelope u32 at offset 10
    // (that slot is kind packed with the unix low bytes).
    const deep = decodePuffinEvents54(buf, { fw: null, char: null });
    const mapped = !deep.unmapped && deep.records.length > 0;
    const first = deep.records[0] || null;
    decoded = {
      decode_status: mapped ? 'decoded' : 'unknown',
      confidence: mapped ? 'high' : 'low',
      packet_type: packetType,
      packet_name: PACKET_TYPES[packetType],
      version,
      timestamp: first ? first.stored_unix : null,
      lineage: DECODER_LINEAGE,
      puffin_events_from_strap: true,
      decoder_version: PUFFIN54_DECODER_VERSION,
      parsed: deep,
    };
    status = mapped ? 'decoded' : 'unknown';
    confidence = decoded.confidence;
  } else if (packetType === 52 && family === 'puffin') {
    // HISTORICAL_IMU_DATA_STREAM (52): a genuine 5/MG history body (Worker F, ab0f699e). The strap carries
    // IMU data here as a history body with the version byte in the [9] slot like type 47; route it through
    // the same versioned WHOOP5 historical dispatch so a v18/v20/v21/v26 body is decoded, else preserved
    // raw with the IMU-stream framing classified (whoop-vault header note attached when unmapped).
    const deep = decodeWhoop5Historical(buf);
    const hist = decodeHistorical(buf, family, offs);
    const h52 = classifyHist52(buf);
    decoded = {
      ...hist, lineage: DECODER_LINEAGE, mapped: deep.mapped,
      hist_version: deep.parsed.hist_version, parsed: deep.parsed,
      imu_data_stream: true,
      historical_imu_note: deep.mapped ? null : h52.layout_note,
      vault_header_plausible: deep.mapped ? null : h52.vault_header_plausible,
    };
    status = deep.mapped ? 'decoded' : 'unknown';
    confidence = deep.mapped ? (deep.parsed.accel_x ? 'medium' : 'high') : 'low';
  } else if (packetType === 47) {
    if (family === 'puffin') {
      // WHOOP5 deep decode: full v18/v20/v21/v26 semantic parity with NOOP.
      const deep = decodeWhoop5Historical(buf);
      const hist = decodeHistorical(buf, family, offs);
      const dv = deep.parsed.hist_version;
      decoded = {
        ...hist,
        lineage: DECODER_LINEAGE,
        mapped: deep.mapped,
        hist_version: dv,
        parsed: deep.parsed,
      };
      status = deep.mapped ? 'decoded' : 'unknown';
      confidence = deep.mapped ? (deep.parsed.ppg_waveform || deep.parsed.accel_x
        ? 'medium' : 'high') : 'low';
    } else {
      decoded = decodeHistorical(buf, family, offs);
      status = decoded.decode_status;
      confidence = decoded.confidence;
    }
  } else if (packetType === 49) {
    // WHOOP5 METADATA (type 49) history-drive bookkeeping.
    const deep = family === 'puffin' ? decodeMetadata(buf) : {};
    decoded = {
      decode_status: 'decoded',
      confidence: family === 'puffin' ? 'medium' : 'medium',
      timestamp: u32le(buf, offs.ts),
      lineage: family === 'puffin' ? DECODER_LINEAGE : undefined,
      parsed: deep,
    };
    status = 'decoded'; confidence = decoded.confidence;
  } else if (packetType === 48) {
    // WHOOP5 EVENT (type 48): event + timestamp + per-event payload.
    // ADVERSARIAL FIX (audit 2026-08-30): the event NUMBER lives at the event
    // offset (puffin frame[10] / harvard frame[6]), NOT at the packet-type
    // offset. The old code read the type byte (48) as the event number, so
    // EVENT_NUMBERS never matched and BATTERY_LEVEL payloads silently
    // stopped decoding in the redecode path.
    const evNum = offs.ev < buf.length ? buf[offs.ev] : null;
    const schemaName = EVENT_NUMBERS[String(evNum ?? '')];
    const deep = decodeEvent(buf, family, schemaName);
    decoded = {
      decode_status: 'decoded',
      confidence: 'medium',
      timestamp: u32le(buf, offs.ts),
      lineage: family === 'puffin' ? DECODER_LINEAGE : undefined,
      parsed: deep,
    };
    status = 'decoded'; confidence = decoded.confidence;
  } else if (packetType === 36 || packetType === 38) {
    // WHOOP5 COMMAND_RESPONSE (type 36/38).
    const deep = family === 'puffin' ? decodeCommandResponse(buf, buf.length - 4) : {};
    // Read-only feature-flag / device-config read-back (121/128/117/118/115/116).
    const rb = family === 'puffin' || family === 'harvard' ? decodeConfigReadBack(buf, family) : null;
    if (rb) deep.config_read_back = rb;
    decoded = {
      decode_status: 'decoded',
      confidence: 'medium',
      timestamp: u32le(buf, offs.ts),
      lineage: family === 'puffin' ? DECODER_LINEAGE : undefined,
      parsed: deep,
    };
    status = 'decoded'; confidence = decoded.confidence;
  } else if (packetType === 50) {
    // WHOOP5 CONSOLE_LOGS (type 50).
    const deep = family === 'puffin' ? decodeConsoleLogs(buf, buf.length - 4) : {};
    decoded = {
      decode_status: 'classified',
      confidence: 'medium',
      timestamp: u32le(buf, offs.ts),
      lineage: family === 'puffin' ? DECODER_LINEAGE : undefined,
      parsed: deep,
    };
    status = 'classified'; confidence = decoded.confidence;
  } else if (packetType === 56) {
    // PUFFIN_METADATA (56) is the 5/MG alias of METADATA(49) (Worker F, ab0f699e): meta_type@10,
    // unix u32@11, subsec@15, trim_cursor@21, end_data=frame[21:29]. Route through decodeMetadata.
    const deep = family === 'puffin' ? decodeMetadata(buf) : {};
    decoded = {
      decode_status: 'decoded',
      confidence: 'medium',
      timestamp: u32le(buf, offs.ts),
      lineage: family === 'puffin' ? DECODER_LINEAGE : undefined,
      puffin_metadata: true,
      parsed: deep,
    };
    status = 'decoded'; confidence = 'medium';
  }

  const coverage = decoded?.coverage?.summary
    ? decoded.coverage
    : buildCoverage(buf.length, [...envelopeSpans(buf.length, family === 'puffin' ? 'puffin' : 'harvard')], {
        warnings: ['packet body not decoded by this decoder version; bytes preserved raw'],
        confidence: 'low',
      });
  return {
    decode_status: status,
    confidence,
    packet_type: packetType,
    packet_name: packetName,
    version,
    crc_ok: true,
    raw_hex: hexOf(buf, 0, buf.length),
    raw_length: buf.length,
    frame_hash: hash,
    decoder,
    family,
    decoded,
    coverage,
    registry_version: REGISTRY_VERSION,
  };
}

export { sha256 };
