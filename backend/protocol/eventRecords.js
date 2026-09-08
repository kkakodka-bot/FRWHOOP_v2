// Derived event / diagnostic records — high-value low-rate streams surfaced
// from verified WHOOP frames (mission target 2).
//
// Streams (B2 raw archives, never per-sample Supabase rows):
//   `events`       — type-48 EVENT (live wrist/battery/diagnostic) plus
//                    type-54 PUFFIN_EVENTS_FROM_STRAP (historical/replayed
//                    only). Type 54 never drives wrist, connection, haptics,
//                    sleep, or notifications. Battery payloads decode
//                    (NOOP-verified layouts); every other event keeps its
//                    payload as raw hex — unknown stays unknown.
//   `console_logs` — type-50 strap firmware diagnostics (protocol validation
//                    evidence: "History burst success. Trim: …", sensor notes).
//   `cmd_battery`  — GET_BATTERY_LEVEL (cmd 26) command-response battery %
//                    sightings, so the battery series is continuous across
//                    event-burst gaps.
//
// Every record carries full provenance: frame hash, CRC state, firmware,
// characteristic, decoder lineage. Decode never throws.

import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { decodeEvent, decodeConsoleLogs, decodeCommandResponse } from './whoop5.js';
import { decodePuffinEvents54, PUFFIN54_DECODER_VERSION } from './puffin54.js';
import { u16le, u32le } from './crc.js';

export const EVENT_RECORD_SCHEMA = 'frwhoop_event_v1';
export const CONSOLE_RECORD_SCHEMA = 'frwhoop_console_v1';
export const EVENT_STREAM = 'events';
export const CONSOLE_STREAM = 'console_logs';
export const EVENT_ARCHIVE_FORMAT = 'ndjson_gzip_events_v1';
export const CONSOLE_ARCHIVE_FORMAT = 'ndjson_gzip_console_v1';

// Shared EventNumber schema for the LIVE type-48 channel.
//
// Sources: NOOP whoop_protocol.json (@2fe3a5c9), goose protocol.rs strap_event_name
// (@ba9ae028, unlicensed — names only), whoop-rs event.rs (@73b5a6a7, PolyForm-NC),
// wearable FINDINGS.md (@890e0c96). Names are reverse-engineering candidates:
// semantic_status is never hardware_verified from a name table alone.
//
// IMPORTANT: this is the LIVE event vocabulary. The type-54 strap-buffered
// channel carries a DIFFERENT pack vocabulary (see puffin54.js) — ids 21/22
// there are pack reboot/module-failure reasons, NOT the live pack
// connect/remove events below. The two vocabularies must not merge.
const EVENT_NAMES = {
  1: 'ERROR', 3: 'BATTERY_LEVEL', 7: 'CHARGING_ON', 8: 'CHARGING_OFF',
  9: 'WRIST_ON', 10: 'WRIST_OFF', 11: 'BLE_CONNECTION_UP',
  12: 'BLE_CONNECTION_DOWN', 13: 'RTC_LOST', 14: 'DOUBLE_TAP', 15: 'BOOT',
  16: 'SET_RTC', 17: 'TEMPERATURE_LEVEL', 18: 'PAIRING_MODE',
  21: 'BATTERY_PACK_CONNECTED', 22: 'BATTERY_PACK_REMOVED', 23: 'BLE_BONDED',
  28: 'FLASH_INIT_COMPLETE', 29: 'STRAP_CONDITION_REPORT', 30: 'BOOT_REPORT',
  32: 'CAPTOUCH_AUTOTHRESHOLD_ACTION',
  33: 'BLE_REALTIME_HR_ON', 34: 'BLE_REALTIME_HR_OFF', 40: 'CH1_SATURATION_DETECTED',
  41: 'CH2_SATURATION_DETECTED', 42: 'ACCELEROMETER_SATURATION_DETECTED',
  46: 'RAW_DATA_COLLECTION_ON', 47: 'RAW_DATA_COLLECTION_OFF',
  56: 'STRAP_DRIVEN_ALARM_SET', 57: 'STRAP_DRIVEN_ALARM_EXECUTED',
  58: 'APP_DRIVEN_ALARM_EXECUTED', 60: 'HAPTICS_FIRED',
  63: 'EXTENDED_BATTERY_INFORMATION', 96: 'HIGH_FREQ_SYNC_PROMPT',
  97: 'HIGH_FREQ_SYNC_ENABLED', 98: 'HIGH_FREQ_SYNC_DISABLED', 100: 'HAPTICS_TERMINATED',
  109: 'BATTERY_PACK_INFO', 123: 'GENERIC_FIRMWARE_EVENT',
};
export { EVENT_NAMES as EVENT_NUMBER_NAMES };

/** Type-48 live EVENT records only. Packet 54 is historical/replayed. */
export function isLiveWhoopEvent(record) {
  return record?.kind === 'event' && record?.envelope?.packet_type === 48;
}

/** Packet 54 durable records. Never a live wrist/connection/haptic source. */
export function isHistoricalPuffin54(record) {
  return record?.kind === 'puffin_event_54' || record?.envelope?.packet_type === 54;
}

function hexOf(buf, from, to) {
  let out = '';
  for (let i = from; i < to; i += 1) out += buf[i].toString(16).padStart(2, '0');
  return out;
}

// ---------------------------------------------------------------------------
// Unified puffin event envelope (types 48 / 53 / 55). Corpus-validated on
// 340k CRC-valid frames (28k+ type-48 frames; ids >= 109 ride the high byte):
//   [0]=type@frame8, [1]=seq@frame9, [2:4]=id u16 LE@frame10:12,
//   [4:8]=unix u32 LE@frame12:16, [8:10]=subsec u16 LE Q15@frame16:18,
//   [10:12]=body_len u16 LE@frame18:20, [12:12+body_len]=body@frame20.
// Type 50 shares the envelope with a console body (chunk_len@18, channel@20).
// The envelope reader is shared by the 53/55 relative variants below.
// ---------------------------------------------------------------------------
export const PUFFIN_EVENT_ENVELOPE = { header_len: 12 };

export function readPuffinEventEnvelope(buf, typeOff = 8) {
  const min = typeOff + PUFFIN_EVENT_ENVELOPE.header_len;
  if (!buf || buf.length < min) return { ok: false, reason: 'truncated' };
  const recordType = buf[typeOff];
  const id = buf[typeOff + 2] | (buf[typeOff + 3] << 8);
  const unix = u32le(buf, typeOff + 4);
  const subsec = u16le(buf, typeOff + 8);
  const bodyLen = u16le(buf, typeOff + 10);
  const bodyStart = typeOff + PUFFIN_EVENT_ENVELOPE.header_len;
  const innerEnd = buf.length - 4;
  const overrun = bodyStart + (bodyLen || 0) > innerEnd;
  return {
    ok: true,
    record_type: recordType,
    id,
    unix,
    subsec,
    subsec_seconds: subsec === null ? null : subsec / 32768,
    body_len: bodyLen,
    body_hex: hexOf(buf, bodyStart, Math.min(bodyStart + (bodyLen || 0), innerEnd)),
    warnings: overrun ? [`body_len ${bodyLen} overruns the frame interior; bytes kept raw`] : [],
  };
}

/**
 * One EVENT (type 48) frame -> an event record. Puffin uses the unified
 * envelope above (u16 id, Q15 subsec, u16 body_len). Harvard keeps the
 * NOOP-verified gen4 layout (event u8@6, ts u32@8, payload@12). Battery
 * payload decodes on both families; live event 109 decodes its 28-byte pack
 * body; every other payload stays raw hex — unknown stays unknown.
 */
export function eventRecordFromFrame(frame, family, ctx = {}) {
  const buf = frame instanceof Uint8Array ? frame : Array.from(frame);
  if (!buf.length || buf[0] !== 0xAA) return null;
  const puffin = family === 'puffin';
  const typeOff = puffin ? 8 : 4;
  if (buf.length <= typeOff || buf[typeOff] !== 48) return null;
  const evOff = puffin ? 10 : 6;
  const evNum = puffin
    ? (buf[evOff] | ((buf.length > evOff + 1 ? buf[evOff + 1] : 0) << 8))
    : buf[evOff];
  if (evNum === undefined || evNum === null) return null;
  const name = EVENT_NAMES[evNum] || `EVENT_${evNum}`;
  const payloadStart = puffin ? 16 : 12;
  const payloadEnd = buf.length - 4;
  const decoded = decodeEvent(buf, family, EVENT_NAMES[evNum] || null);
  const bodyFields = puffin ? decodeLiveEventBody(buf, evNum) : null;
  const env = puffin ? readPuffinEventEnvelope(buf, 8) : null;
  return {
    schema: EVENT_RECORD_SCHEMA,
    kind: 'event',
    event_id: evNum,
    event_name: name,
    event_ts: decoded.event_timestamp ?? null,
    event_subsec_q15: env ? env.subsec : null,
    event_subsec_seconds: env ? env.subsec_seconds : null,
    event_body_len: env ? env.body_len : null,
    event_body: bodyFields || null,
    battery_pct: decoded.battery_pct ?? null,
    battery_mV: decoded.battery_mV ?? null,
    battery_charging: decoded.battery_charging ?? null,
    battery_counter: decoded.battery_counter ?? bodyFields?.counter ?? null,
    payload_hex: hexOf(buf, payloadStart, payloadEnd) || null,
    family,
    received_at: ctx.receivedAt || null,
    envelope: {
      packet_type: 48,
      packet_name: 'EVENT',
      frame_hash: ctx.frameHash || sha256Of(buf),
      frame_length: buf.length,
      crc_ok: ctx.crcOk ?? null,
    },
    firmware: { fw: ctx.fw || null, model: ctx.model || null },
    transport: { char: ctx.char || null, seq: ctx.seq ?? null },
    decoder: { version: ctx.decoder || null, lineage: ctx.lineage || null },
  };
}

// ---------------------------------------------------------------------------
// Corpus-validated live event body helpers (structure only; names withheld
// unless carried by an external source: 109 = BATTERY_PACK_INFO per whoop-rs
// real frames + OpenStrap cmd-151 body; 61/62 are NOOP "serial-bearing").
//   109 (28 B): [rev][addr 6][serial 16 NUL-term][soc u16 deci][colorway]
//               [family][pad] — same content as pack cmd 151 and type-54
//               kind 20, in a different field order.
//   61 (40 B) / 62 (28 B): [rev][strap serial 10B ASCII][marker][addr 6][raw...]
//   56 (24 B): [rev][embedded unix u32][raw...]
// Serial/address outputs are redacted; payload_hex stays lossless.
// ---------------------------------------------------------------------------
function decodeLiveEventBody(buf, evNum) {
  const bodyStart = 20; // puffin: id u16@10, ts u32@12, subsec@16, len@18, body@20
  const bodyEnd = buf.length - 4;
  const body = buf.slice(bodyStart, bodyEnd);
  if (evNum === 3 && body.length >= 9) {
    const soc = u16le(body, 1);
    const mv = u16le(body, 5);
    const counter = u16le(body, 7);
    return {
      body_revision: body[0],
      soc_deci_percent: soc,
      millivolts: mv,
      counter,
      semantic_status: 'validated',
    };
  }
  if (evNum === 29 && body.length >= 10) {
    return {
      body_revision: body[0],
      tick_u32: u32le(body, 1),
      tick_div132_u16: u16le(body, 5),
      marker: body.length > 7 ? body[7] : null,
      flag: body.length > 8 ? body[8] : null,
      semantic_status: 'candidate_unpromoted',
      product_use: 'sync_hint_only',
    };
  }
  if (evNum === 110 && body.length >= 8) {
    return {
      body_revision: body[0],
      u16_1: u16le(body, 1),
      u32_2: u32le(body, 3),
      semantic_status: 'candidate_unpromoted',
      product_use: 'sync_hint_only',
    };
  }
  if (evNum === 63 && body.length >= 8) {
    return {
      body_revision: body[0],
      i16x3_raw: [u16le(body, 2), u16le(body, 4), u16le(body, 6)].map((v) => {
        if (v == null) return null;
        return v > 32767 ? v - 65536 : v;
      }),
      semantic_status: 'candidate_unpromoted',
      not_accelerometer: true,
    };
  }
  if (evNum === 109 && body.length >= 27) {
    const serialBytes = body.slice(7, 23);
    let end = 0;
    while (end < serialBytes.length && serialBytes[end] !== 0) end += 1;
    const serial = Buffer.from(serialBytes.slice(0, end)).toString('utf8');
    const soc = u16le(body, 23);
    return {
      body_revision: body[0],
      pack_ble_addr_redacted: redactAddr(hexOf(body, 1, 7)),
      pack_serial_redacted: isPrintable(serialBytes.slice(0, end)) ? redactSerial(serial.slice(0, end)) : null,
      pack_soc_deci_percent: soc !== null && soc <= 1000 ? soc : null,
      colorway: body[25],
      hardware_family: body[26],
    };
  }
  if ((evNum === 61 || evNum === 62) && body.length >= 18) {
    const serialBytes = body.slice(1, 11);
    return {
      body_revision: body[0],
      strap_serial_redacted: isPrintable(serialBytes) ? redactSerial(Buffer.from(serialBytes).toString('utf8')) : null,
      marker_byte: body[11],
      strap_ble_addr_redacted: redactAddr(hexOf(body, 12, 18)),
    };
  }
  if (evNum === 56 && body.length >= 6) {
    return { body_revision: body[0], flag_byte: body[1], embedded_unix: u32le(body, 2) };
  }
  return null;
}

function isPrintable(bytes) {
  return bytes.length > 0 && Array.from(bytes).every((c) => c >= 32 && c <= 126);
}
function redactSerial(s) {
  const str = String(s || '');
  return str.length <= 4 ? '****' : `${str.slice(0, 4)}..${str.slice(-2)}(redacted)`;
}
function redactAddr(hex) {
  const h = String(hex || '');
  return h.length <= 4 ? '****' : `${h.slice(0, 2)}:..:${h.slice(-2)}(redacted)`;
}

/**
 * RELATIVE_PUFFIN_EVENTS (type 53) — structural decode only. No public or
 * FRWHOOP capture exists, so the body is preserved raw and the "relative"
 * timestamp semantics are recorded as an explicit open question. When a
 * capture arrives, test the same unified envelope with a delta/reference
 * timestamp against type-48 pairs around the same physical event.
 */
export function relativeEventsRecordFromFrame(frame, family, ctx = {}) {
  return relativeEnvelopeRecord(frame, family, 53, 'RELATIVE_PUFFIN_EVENTS', ctx);
}

/**
 * RELATIVE_BATTERY_PACK_CONSOLE_LOGS (type 55) — no capture anywhere; body
 * preserved raw. If a capture arrives, test the type-50 text-envelope first
 * (chunk_len u16 + channel u8 + NUL-padded text) before any other reading.
 */
export function relativePackConsoleRecordFromFrame(frame, family, ctx = {}) {
  return relativeEnvelopeRecord(frame, family, 55, 'RELATIVE_BATTERY_PACK_CONSOLE_LOGS', ctx);
}

function relativeEnvelopeRecord(frame, family, packetType, packetName, ctx) {
  const buf = frame instanceof Uint8Array ? frame : Array.from(frame);
  if (!buf.length || buf[0] !== 0xAA) return null;
  if (family !== 'puffin') return null;
  if (buf.length <= 8 || buf[8] !== packetType) return null;
  const env = readPuffinEventEnvelope(buf, 8);
  return {
    schema: EVENT_RECORD_SCHEMA,
    kind: 'relative_event',
    event_id: env.id,
    event_name: packetType === 53 ? `RELATIVE_PUFFIN_EVENT_${env.id}` : `RELATIVE_PACK_LOG_${env.id}`,
    event_ts: env.unix ?? null,
    relative_timestamp_hypothesis: 'unresolved: delta-time | batch-relative | record-index reference | compact cross-event reference',
    event_subsec_q15: env.subsec,
    event_body_len: env.body_len,
    body_hex: env.body_hex || null,
    payload_hex: env.body_hex || null,
    battery_pct: null,
    battery_mV: null,
    battery_charging: null,
    family,
    received_at: ctx.receivedAt || null,
    envelope: {
      packet_type: packetType,
      packet_name: packetName,
      frame_hash: ctx.frameHash || sha256Of(buf),
      frame_length: buf.length,
      crc_ok: ctx.crcOk ?? null,
    },
    firmware: { fw: ctx.fw || null, model: ctx.model || null },
    transport: { char: ctx.char || null, seq: ctx.seq ?? null },
    decoder: { version: ctx.decoder || null, lineage: ctx.lineage || null },
  };
}


function sha256Of(buf) {
  return createHash('sha256').update(Buffer.from(buf)).digest('hex');
}

/**
 * One CONSOLE_LOGS (type 50) frame -> a console record.
 * Puffin layout (NOOP-verified across 3,257 real frames; corpus 28,263 all
 * chunk_len 52 / channel 1): record_index u16@9 with the seq slot as its LOW
 * byte, unix u32@12, subsec u16@16, chunk_len u16@18, channel u8@20, text
 * @21 NUL-padded to chunk_len. chunk_len/channel are new instrumentation
 * fields; record_index/log readings are unchanged.
 */
export function consoleRecordFromFrame(frame, family, ctx = {}) {
  const buf = frame instanceof Uint8Array ? frame : Array.from(frame);
  if (!buf.length || buf[0] !== 0xAA) return null;
  const typeOff = family === 'puffin' ? 8 : 4;
  if (buf.length <= typeOff || buf[typeOff] !== 50) return null;
  const deep = decodeConsoleLogs(buf, buf.length - 4);
  const chunkLen = family === 'puffin' ? u16le(buf, 18) : null;
  const channel = family === 'puffin' && buf.length > 20 ? buf[20] : null;
  return {
    schema: CONSOLE_RECORD_SCHEMA,
    kind: 'console_log',
    family,
    record_index: deep.record_index ?? null,
    unix: deep.unix ?? null,
    subsec: deep.subsec ?? null,
    chunk_len: chunkLen,
    channel,
    log: deep.log ?? null,
    received_at: ctx.receivedAt || null,
    envelope: {
      packet_type: 50,
      packet_name: 'CONSOLE_LOGS',
      frame_hash: ctx.frameHash || sha256Of(buf),
      frame_length: buf.length,
      crc_ok: ctx.crcOk ?? null,
    },
    firmware: { fw: ctx.fw || null, model: ctx.model || null },
    transport: { char: ctx.char || null, seq: ctx.seq ?? null },
    decoder: { version: ctx.decoder || null, lineage: ctx.lineage || null },
  };
}

/**
 * Battery sightings from GET_BATTERY_LEVEL (cmd 26) COMMAND_RESPONSE frames —
 * the ~60 s poll path gives a dense series between type-48 battery events.
 */
export function cmdBatteryRecordFromFrame(frame, family, ctx = {}) {
  const buf = frame instanceof Uint8Array ? frame : Array.from(frame);
  if (!buf.length || buf[0] !== 0xAA) return null;
  const puffin = family === 'puffin';
  const typeOff = puffin ? 8 : 4;
  if (buf.length <= typeOff) return null;
  const pt = buf[typeOff];
  if (pt !== 36 && pt !== 38) return null;
  const deep = decodeCommandResponse(buf, buf.length - 4);
  if (deep.resp_command !== 26 || deep.battery_pct == null) return null;
  return {
    schema: 'frwhoop_cmd_battery_v1',
    kind: 'cmd_response_battery',
    battery_pct: deep.battery_pct,
    resp_command: 26,
    resp_seq: deep.resp_seq ?? null,
    family,
    received_at: ctx.receivedAt || null,
    envelope: {
      packet_type: pt,
      packet_name: pt === 36 ? 'COMMAND_RESPONSE' : 'PUFFIN_COMMAND_RESPONSE',
      frame_hash: ctx.frameHash || sha256Of(buf),
      frame_length: buf.length,
      crc_ok: ctx.crcOk ?? null,
    },
    firmware: { fw: ctx.fw || null, model: ctx.model || null },
    transport: { char: ctx.char || null, seq: ctx.seq ?? null },
    decoder: { version: ctx.decoder || null, lineage: ctx.lineage || null },
  };
}

/**
 * Encode a list of derived records (events / console / cmd battery) as gzip
 * ndjson with the shared archive framing.
 */
export function encodeRecordArchive(records, { stream = EVENT_STREAM, format = EVENT_ARCHIVE_FORMAT, schemaVersion = 1 } = {}) {
  const rows = (records || []).filter(Boolean);
  const ndjson = `${rows.map((r) => JSON.stringify(r)).join('\n')}${rows.length ? '\n' : ''}`;
  const body = gzipSync(Buffer.from(ndjson, 'utf8'));
  return {
    body,
    sample_count: rows.length,
    compressed_bytes: body.length,
    format,
    compression: 'gzip',
    content_type: 'application/x-ndjson',
    schema_version: schemaVersion,
    stream,
    rows,
  };
}

export const encodeEventArchive = (rows) => encodeRecordArchiveImpl(rows, EVENT_STREAM, EVENT_ARCHIVE_FORMAT);

export function decodeEventArchive(body) {
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
  return (Array.isArray(lines) ? lines : []).filter((r) => r && r.schema === EVENT_RECORD_SCHEMA);
}

function encodeRecordArchiveImpl(rows, stream, format) {
  const list = (rows || []).filter((r) => r && r.schema);
  const ndjson = `${list.map((r) => JSON.stringify(r)).join('\n')}${list.length ? '\n' : ''}`;
  const body = gzipSync(Buffer.from(ndjson, 'utf8'));
  return {
    body,
    sample_count: list.length,
    compressed_bytes: body.length,
    format,
    compression: 'gzip',
    content_type: 'application/x-ndjson',
    schema_version: 1,
    stream,
    rows: list,
  };
}

export const encodeConsoleArchive = (consoleRows) => encodeRecordArchiveImpl(consoleRows, CONSOLE_STREAM, CONSOLE_ARCHIVE_FORMAT);

/**
 * One PUFFIN_EVENTS_FROM_STRAP (type 54) frame -> event records, one per
 * strap-buffered record. Display name stays PUFFIN_EVENT_N — candidate RE
 * names are not shown as fact. CRC-invalid or length-mismatched frames
 * yield no records (Level A bytes stay in the frames archive).
 */
export function puffin54RecordsFromFrame(frame, family, ctx = {}) {
  const buf = frame instanceof Uint8Array ? frame : Array.from(frame);
  if (!buf.length || buf[0] !== 0xAA) return [];
  if (family !== 'puffin') return [];
  const typeOff = 8;
  if (buf.length <= typeOff || buf[typeOff] !== 54) return [];
  const deep = decodePuffinEvents54(buf, { fw: ctx.fw || null, char: ctx.char || null });
  if (deep.unmapped || !deep.records?.length) return [];
  const frameHash = ctx.frameHash || deep.frame_hash || sha256Of(buf);
  return deep.records.map((r) => ({
    schema: EVENT_RECORD_SCHEMA,
    kind: 'puffin_event_54',
    event_id: r.kind,
    event_name: `PUFFIN_EVENT_${r.kind}`,
    event_ts: r.stored_unix ?? null,
    stored_unix: r.stored_unix ?? null,
    tag: r.tag ?? null,
    payload_len: r.payload_len ?? null,
    battery_pct: null,
    battery_mV: null,
    battery_charging: null,
    payload_hex: r.payload_hex ?? null,
    serial_ascii: r.serial_ascii ?? null,
    candidate_name: r.candidate_name ?? null,
    semantic_status: r.semantic_status || 'structurally_verified',
    source_characteristic: ctx.char || r.source_characteristic || null,
    historical: true,
    live_side_effects: false,
    family,
    received_at: ctx.receivedAt || null,
    envelope: {
      packet_type: 54,
      packet_name: 'PUFFIN_EVENTS_FROM_STRAP',
      frame_hash: frameHash,
      frame_length: buf.length,
      crc_ok: true,
    },
    firmware: { fw: ctx.fw || r.firmware || null, model: ctx.model || null },
    transport: { char: ctx.char || null, seq: ctx.seq ?? null },
    decoder: {
      version: r.decoder_version || PUFFIN54_DECODER_VERSION,
      lineage: ctx.lineage || null,
    },
    provenance: {
      packet_type: 54,
      source: 'puffin_events_from_strap',
      historical: true,
      live_side_effects: false,
      frame_hash: frameHash,
      firmware: ctx.fw || r.firmware || null,
      characteristic: ctx.char || null,
      decoder_version: r.decoder_version || PUFFIN54_DECODER_VERSION,
    },
  }));
}

/**
 * Derive all records from ONE verified frame. Returns { events, console, battery }.
 */
export function recordsFromFrame(frame, family, ctx = {}) {
  const buf = frame instanceof Uint8Array ? frame : Array.from(frame);
  if (!buf.length || buf[0] !== 0xAA) return { events: [], console: [], battery: [] };
  const typeOff = family === 'puffin' ? 8 : 4;
  const pt = buf.length > typeOff ? buf[typeOff] : null;
  const events = pt === 48
    ? [eventRecordFromFrame(buf, family, ctx)].filter(Boolean)
    : (pt === 54
      ? puffin54RecordsFromFrame(buf, family, ctx)
      : (pt === 53
        ? [relativeEventsRecordFromFrame(buf, family, ctx)].filter(Boolean)
        : (pt === 55
          ? [relativePackConsoleRecordFromFrame(buf, family, ctx)].filter(Boolean)
          : [])));
  const consoleLogs = pt === 50
    ? [consoleRecordFromFrame(buf, family, ctx)].filter(Boolean)
    : [];
  const battery = (pt === 36 || pt === 38)
    ? [cmdBatteryRecordFromFrame(buf, family, ctx)].filter(Boolean)
    : [];
  return { events, console: consoleLogs, battery };
}
