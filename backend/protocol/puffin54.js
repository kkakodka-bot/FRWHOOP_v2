// PUFFIN_EVENTS_FROM_STRAP (packet type 54) — strap-buffered battery-pack
// ("Puffin" HPS wrapper) events, replayed during history sync.
//
// Structure (frame-absolute, puffin envelope):
//   AA 01 | declared u16 LE | header | CRC16-Modbus | type=54 @8 | seq @9
//   records @10 .. CRC32, record walk:
//     kind         u16 LE
//     stored_unix  u32 LE   (pack event timestamp)
//     ts_subsec    u16 LE   (Q15 subsecond, /32768 s; legacy name "tag")
//     payload_len  u16 LE
//     payload      payload_len bytes
//
// OFFSET CONVENTION: this module is inner-relative. Inner record starts at
// full-frame offset 8 (Puffin/Gen5). Harvard/Gen4 inner starts at frame
// offset 4 and does not carry this packet type.
//
// ts_subsec: renamed from "tag" after corpus validation — the value stays in
// 0..32767 for every observed kind, and same-second event groups arrive
// non-decreasing in arrival order (308/308 groups, mission 3 evidence). The
// legacy `tag` key is retained as an alias for replay compatibility.
//
// Kind vocabulary: pack-family candidate names from whoop-rs pack.rs
// (@73b5a6a7, PolyForm-NC — facts only, independently implemented). The
// type-54 kind space is a PACK vocabulary and is deliberately NOT merged
// with the live type-48 EventNumber space (different vocabularies: type-54
// kinds 21/22 are reboot/module-failure reasons, not pack connect/remove).
//
// Kind payload bodies decoded here (corpus-validated on FRWHOOP captures,
// fw 50.35.2.0, pack family "WBB5B*"; whoop-rs real frames agree on content
// but segment the 10-byte header differently — see
// docs/protocol/SEMANTIC_CONFLICTS.md, entry pack-54.header-segmentation):
//   kind 2  PACK_STATE_OF_CHARGE: [rev u8][soc u16 LE tenths-of-percent][pad]
//   kind 9  PACK_DOUBLE_TAP (candidate): [rev u8][3 unknown bytes]
//   kind 19 PACK_WPT_HEALTH: [rev][00][value u16][mode][4 raw]
//   kind 20 PACK_HARDWARE_INFO: [rev u8][family u8][serial 16B NUL-term]
//                               [addr 6B][hw_rev u8][fw 4B][colorway u8]
//                               [soc u16 LE] — 32 bytes; the last two bytes
//                               are the SoC u16, not padding.
//
// Pack serials and Bluetooth addresses are REDACTED by default in derived
// output; the raw payload hex is retained in the Level A archive.
//
// Type 54 is replayable / historical. Decoding must not imply a live side
// effect; persistence is keyed by frame hash.

import { createHash } from 'node:crypto';
import { verifyFrame } from './framing.js';
import { u16le, u32le } from './crc.js';

export const PUFFIN54_DECODER_VERSION = 'frwhoop-p54/2';
export const PUFFIN54_PACKET_TYPE = 54;

// Reverse-engineering candidate names only. Never treated as proven.
// Superseded names (p54/1): 2 CONSOLE_OUTPUT, 9 WRIST_ON, 19/20 SERIAL_HEAD_*.
// whoop-rs pack.rs + FRWHOOP wire evidence support the pack reading.
export const PUFFIN54_CANDIDATE_NAMES = {
  2: 'PACK_STATE_OF_CHARGE',
  20: 'PACK_HARDWARE_INFO',
  1: 'PACK_ERROR',
  3: 'PACK_USB_CONNECTED',
  4: 'PACK_USB_DISCONNECTED',
  5: 'PACK_CHARGING_ON',
  6: 'PACK_CHARGING_OFF',
  7: 'PACK_BLE_CONNECTED',
  8: 'PACK_BLE_DISCONNECTED',
  9: 'PACK_DOUBLE_TAP',
  10: 'PACK_STRAP_DETECTED',
  11: 'PACK_STRAP_REMOVED',
  12: 'PACK_TRIM_ALL_DATA_START',
  13: 'PACK_TRIM_ALL_DATA_END',
  14: 'PACK_BOOT_REPORT',
  15: 'PACK_SHIPMODE_SET',
  16: 'PACK_SHIPMODE_CLEAR',
  17: 'PACK_EXTENDED_FG_INFO',
  18: 'PACK_BATTERY_HEALTH',
  19: 'PACK_WPT_HEALTH',
  21: 'PACK_REBOOT_REASON',
  22: 'PACK_MODULE_FAILURE_REASON',
  23: 'PACK_WPT_RESET',
  50: 'PACK_LOG',
};

// Kinds with corpus-validated payload layouts in THIS decoder.
export const PUFFIN54_DECODED_KINDS = new Set([2, 9, 19, 20]);

export const PUFFIN54_KIND2_NAME = 'PACK_STATE_OF_CHARGE';
export const PUFFIN54_KIND20_NAME = 'PACK_HARDWARE_INFO';
export const SOC_DECI_MAX = 1000;

export function puffin54DebugEnabled() {
  const v = String(process.env.WHOOP_PROTOCOL_DEBUG || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function puffin54Log(line) {
  if (puffin54DebugEnabled()) console.log(line);
}

function sha256Hex(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function hexOf(buf, from, to) {
  let out = '';
  for (let i = from; i < to; i += 1) {
    if (i < 0 || i >= buf.length) break;
    out += buf[i].toString(16).padStart(2, '0');
  }
  return out;
}

function payloadPrefix(hex, n = 16) {
  return String(hex || '').slice(0, n);
}

function semanticFor(kind) {
  const name = PUFFIN54_CANDIDATE_NAMES[kind] || null;
  if (!name) {
    return { candidate_name: null, semantic_status: 'structurally_verified' };
  }
  return { candidate_name: name, semantic_status: 'candidate_semantic' };
}

// ---------------------------------------------------------------------------
// Redaction helpers (serials / BLE addresses never leak into derived rows).
// ---------------------------------------------------------------------------
export function redactSerial(serial) {
  const s = String(serial || '');
  if (s.length <= 4) return '****';
  return `${s.slice(0, 4)}..${s.slice(-2)}(redacted)`;
}

export function redactAddress(addrHex) {
  const s = String(addrHex || '');
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}:..:${s.slice(-2)}(redacted)`;
}

// ---------------------------------------------------------------------------
// Kind payload decoders. Each returns { fields, warnings } or null when the
// payload cannot be the declared kind's body. Raw bytes always preserved by
// the caller; these functions never fabricate values.
// ---------------------------------------------------------------------------

/** kind 2 — pack state-of-charge: [rev][soc u16 LE tenths][pad]. */
export function decodeKind2StateOfCharge(payload) {
  if (!payload || payload.length < 3) return null;
  const soc = u16le(payload, 1);
  if (soc === null) return null;
  const fields = {
    kind_name: PUFFIN54_KIND2_NAME,
    payload_revision: payload[0],
  };
  const warnings = [];
  if (soc <= SOC_DECI_MAX) {
    fields.pack_soc_deci_percent = soc;
    fields.pack_soc_percent = soc / 10;
  } else {
    warnings.push(`kind-2 SoC ${soc} exceeds ${SOC_DECI_MAX} (tenths-of-percent cap); kept raw only`);
  }
  if (payload.length > 3) fields.padding_hex = hexOf(payload, 3, payload.length);
  return { fields, warnings };
}

/** kind 9 — pack double-tap candidate: [rev][3 unknown bytes]. */
export function decodeKind9DoubleTap(payload) {
  if (!payload || payload.length < 4) return null;
  return {
    fields: {
      kind_name: PUFFIN54_CANDIDATE_NAMES[9],
      payload_revision: payload[0],
      unknown_hex: hexOf(payload, 1, payload.length),
    },
    warnings: [],
  };
}

/** kind 19 — WPT (wireless power) health: [rev][00][value u16][mode][raw]. */
export function decodeKind19WptHealth(payload) {
  if (!payload || payload.length < 8) return null;
  const value = u16le(payload, 2);
  return {
    fields: {
      kind_name: PUFFIN54_CANDIDATE_NAMES[19],
      payload_revision: payload[0],
      wpt_field0: payload[1],
      wpt_value_u16: value,
      wpt_mode: payload[4],
      padding_hex: hexOf(payload, 5, payload.length),
    },
    warnings: ['kind 19 field names provisional (WPT-health family; unit unknown)'],
  };
}

/** kind 20 — pack hardware info (32-byte FRWHOOP form). */
export function decodeKind20HardwareInfo(payload) {
  if (!payload || payload.length < 32) return null;
  const serialBytes = payload.slice(2, 18);
  let end = 0;
  while (end < serialBytes.length && serialBytes[end] !== 0) end += 1;
  const serialAscii = Buffer.from(serialBytes.slice(0, end)).toString('utf8');
  const printable = serialAscii.length >= 6
    && Array.from(serialBytes.slice(0, end)).every((c) => c >= 32 && c <= 126);
  const soc = u16le(payload, 30);
  const fields = {
    kind_name: PUFFIN54_KIND20_NAME,
    payload_revision: payload[0],
    hardware_family: payload[1],
    pack_serial_redacted: printable ? redactSerial(serialAscii) : null,
    pack_serial_raw_fallback: printable ? null : hexOf(serialBytes, 0, serialBytes.length),
    pack_ble_addr_redacted: redactAddress(hexOf(payload, 18, 24)),
    hardware_revision: payload[24],
    firmware_version: [payload[25], payload[26], payload[27], payload[28]].join('.'),
    colorway: payload[29],
  };
  const warnings = [];
  if (soc !== null && soc <= SOC_DECI_MAX) {
    fields.pack_soc_deci_percent = soc;
    fields.pack_soc_percent = soc / 10;
  } else if (soc !== null) {
    warnings.push(`kind-20 SoC ${soc} exceeds cap; raw only`);
  }
  return { fields, warnings };
}

export function decodeKindPayload(kind, payload) {
  switch (kind) {
    case 2: return decodeKind2StateOfCharge(payload);
    case 9: return decodeKind9DoubleTap(payload);
    case 19: return decodeKind19WptHealth(payload);
    case 20: return decodeKind20HardwareInfo(payload);
    default: return null;
  }
}

function asciiSerialFromPayload(data) {
  if (!data || data.length < 3 || data[0] !== 0x01 || data[1] !== 0x0c) return null;
  let end = 2;
  while (end < data.length && data[end] !== 0) end += 1;
  const ascii = data.slice(2, end);
  if (ascii.length >= 6 && ascii.every((c) => c >= 32 && c <= 126)) {
    return String.fromCharCode(...ascii);
  }
  return null;
}

/**
 * Offset reader. Does not check CRC. Used by the corpus auditor so structure
 * is not circular with the semantic decoder.
 */
export function readPuffin54Structure(buf) {
  const bytes = buf instanceof Uint8Array ? buf : Uint8Array.from(buf || []);
  if (bytes.length < 20) {
    return { ok: false, reason: 'truncated', records: [], leftover: null };
  }
  if (bytes[8] !== PUFFIN54_PACKET_TYPE) {
    return { ok: false, reason: 'length', records: [], leftover: null };
  }
  const payloadEnd = bytes.length - 4;
  const records = [];
  let pos = 10;
  while (pos + 10 <= payloadEnd) {
    const kind = u16le(bytes, pos);
    const storedUnix = u32le(bytes, pos + 2);
    const tsSubsec = u16le(bytes, pos + 6);
    const payloadLen = u16le(bytes, pos + 8);
    if (pos + 10 + payloadLen > payloadEnd) {
      return { ok: false, reason: 'truncated', records, leftover: null, at: pos, payload_len: payloadLen };
    }
    const payload = bytes.subarray(pos + 10, pos + 10 + payloadLen);
    records.push({
      kind,
      stored_unix: storedUnix,
      ts_subsec: tsSubsec,
      tag: tsSubsec,
      payload_len: payloadLen,
      payload_hex: hexOf(payload, 0, payload.length),
      payload_bytes: Array.from(payload),
    });
    pos += 10 + payloadLen;
  }
  if (pos !== payloadEnd) {
    const rest = bytes.subarray(pos, payloadEnd);
    const allZero = rest.length > 0 && rest.every((b) => b === 0);
    return {
      ok: false,
      reason: allZero ? 'padding' : 'length',
      records,
      leftover: { bytes: rest.length, all_zero: allZero, hex: hexOf(rest, 0, rest.length) },
    };
  }
  return { ok: true, reason: null, records, leftover: null };
}

function reject(hash, reason, extra = {}) {
  puffin54Log(`[P54] reject hash=${hash} reason=${reason}`);
  return { records: [], unmapped: true, reject_reason: reason, frame_hash: hash, ...extra };
}

/**
 * Strict packet-54 decoder. CRC, declared length, and exact payload consume
 * are required. Unknown kinds still yield records (payload kept).
 */
export function decodePuffinEvents54(buf, ctx = {}) {
  const bytes = buf instanceof Uint8Array ? buf : Uint8Array.from(buf || []);
  const hash = sha256Hex(bytes);
  const fw = ctx.fw || ctx.firmware || null;
  const char = ctx.char || ctx.characteristic || ctx.source_characteristic || null;

  if (bytes.length < 12 || bytes[0] !== 0xAA || bytes[1] !== 0x01) {
    return reject(hash, bytes.length < 12 ? 'truncated' : 'length');
  }
  const declared = u16le(bytes, 2);
  const total = declared + 8;
  if (bytes.length < total) return reject(hash, 'truncated');
  if (bytes.length !== total) return reject(hash, 'length');

  const check = verifyFrame(bytes, 'puffin');
  if (!check.ok) return reject(hash, 'crc');
  if (bytes[8] !== PUFFIN54_PACKET_TYPE) {
    return { records: [], unmapped: true, reject_reason: 'length', frame_hash: hash };
  }

  const struct = readPuffin54Structure(bytes);
  if (!struct.ok) {
    puffin54Log(`[P54] reject hash=${hash} reason=${struct.reason}`);
    return {
      records: [],
      unmapped: true,
      reject_reason: struct.reason,
      frame_hash: hash,
      leftover: struct.leftover || null,
    };
  }

  const records = struct.records.map((r) => {
    const sem = semanticFor(r.kind);
    const rec = {
      packet_type: PUFFIN54_PACKET_TYPE,
      kind: r.kind,
      stored_unix: r.stored_unix,
      ts_subsec: r.ts_subsec,
      tag: r.tag,
      payload_len: r.payload_len,
      payload_hex: r.payload_hex,
      candidate_name: sem.candidate_name,
      semantic_status: sem.semantic_status,
      source_characteristic: char,
      firmware: fw,
      frame_hash: hash,
      decoder_version: PUFFIN54_DECODER_VERSION,
    };
    const decoded = PUFFIN54_DECODED_KINDS.has(r.kind) ? decodeKindPayload(r.kind, r.payload_bytes) : null;
    if (decoded) {
      rec.decoded = decoded.fields;
      rec.decode_warnings = decoded.warnings;
      rec.decode_status = decoded.warnings.length ? 'partial' : 'decoded';
    } else {
      rec.decode_status = PUFFIN54_DECODED_KINDS.has(r.kind) ? 'partial' : 'classified';
    }
    const serial = asciiSerialFromPayload(r.payload_bytes);
    if (serial) rec.serial_ascii = redactSerial(serial);
    if (sem.candidate_name && sem.semantic_status !== 'hardware_verified') {
      puffin54Log(`[P54] semantic_withheld kind=${r.kind} reason=insufficient_hardware_evidence`);
    }
    if (!PUFFIN54_CANDIDATE_NAMES[r.kind]) {
      const payloadSha = sha256Hex(r.payload_bytes);
      puffin54Log(
        `[P54] unknown_kind kind=${r.kind} payload_sha=${payloadSha} prefix=${payloadPrefix(r.payload_hex)}`,
      );
    }
    return rec;
  });

  for (const rec of records) {
    puffin54Log(
      `[P54] ok hash=${hash} fw=${fw || '-'} char=${char || '-'} kind=${rec.kind} stored=${rec.stored_unix} ts_subsec=${rec.ts_subsec} payload_len=${rec.payload_len}`,
    );
  }

  return {
    records,
    unmapped: false,
    reject_reason: null,
    frame_hash: hash,
    decoder_version: PUFFIN54_DECODER_VERSION,
  };
}

export function puffin54Identity(rec) {
  if (!rec) return null;
  return [
    rec.frame_hash || rec.envelope?.frame_hash || '',
    rec.kind ?? rec.event_id,
    rec.stored_unix ?? rec.event_ts,
    rec.ts_subsec ?? rec.tag,
    rec.payload_hex || '',
  ].join(':');
}
