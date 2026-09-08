// WHOOP frame envelope validation and stream reassembly.
//
// Ported from the NOOP WHOOP protocol package
// (noop/Packages/WhoopProtocol/Sources/WhoopProtocol/Framing.swift) and
// cross-checked against the whoop_protocol.json envelope facts.
//
// Two family-specific encodings are supported:
//
//   WHOOP 4 (Harvard / 6108 service family)
//     [0]    SOF 0xAA
//     [1-2]  length u16 LE  (inner record byte count, incl. 4-byte CRC32 trailer)
//     [3]    crc8 header over frame[1..3]
//     [4..]  inner record
//     tail   crc32 (zlib LE) over the inner record
//     total  = length + 4
//
//   WHOOP 5 (Puffin / FD4B service family, gen 5/MG)
//     [0]    SOF 0xAA
//     [1]    format byte 0x01
//     [2-3]  declaredLength u16 LE  (= payload length + 4)
//     [4-5]  header bytes
//     [6-7]  crc16-Modbus over frame[0..6], u16 LE
//     [8..]  payload
//     tail   crc32 (zlib LE) over the payload
//     total  = declaredLength + 8
//
// Do NOT assume one WHOOP 5 record is a WHOOP 4 record shifted by four bytes.
// The two encodings differ in header CRC (crc8 vs crc16-Modbus), length
// position, and trailer placement. Dispatch must be family-aware.
//
// Verification never throws and never destroys input. Invalid/unknown frames
// are reported with `ok:false` and their bytes preserved for the caller to
// archive (Level A) and retain (Level B, `crc_ok:false`).

import { crc8, crc32, crc16Modbus, u16le, u32le } from './crc.js';

export const MAX_FRAME_BYTES = 8192;

// `crc8_ok` carries the header CRC outcome for BOTH families, so callers get a
// single uniform "header CRC ok?" signal regardless of generation.
export function verifyFrame(frame, family = 'harvard') {
  // frame may be a Uint8Array / Buffer / number[]
  if (!frame || frame.length < 8 || frame[0] !== 0xAA) {
    return { ok: false, length: null, crc8_ok: false, crc32_ok: null, family };
  }
  if (family === 'puffin') {
    if (frame.length < 12 || frame[1] !== 0x01) {
      return { ok: false, length: null, crc8_ok: false, crc32_ok: null, family };
    }
    const declared = u16le(frame, 2);
    if (declared < 4) return { ok: false, length: declared, crc8_ok: false, crc32_ok: null, family };
    const total = declared + 8;
    const wantHeaderCRC = crc16Modbus(frame, 0, 6);
    const gotHeaderCRC = u16le(frame, 6);
    const headerOK = wantHeaderCRC === gotHeaderCRC;
    let crc32OK = null;
    if (frame.length >= total) {
      const payloadEnd = total - 4;
      crc32OK = crc32(frame, 8, payloadEnd) === u32le(frame, payloadEnd);
    }
    return {
      ok: headerOK && (crc32OK === true),
      length: declared,
      crc8_ok: headerOK,
      crc32_ok: crc32OK,
      family,
      total,
      header_crc16: headerOK,
    };
  }
  // harvard / whoop4
  const length = u16le(frame, 1);
  const crc8OK = crc8(frame, 1, 3) === frame[3];
  let crc32OK = null;
  if (length >= 7 && length + 4 <= frame.length) {
    crc32OK = crc32(frame, 4, length) === u32le(frame, length);
  }
  return {
    ok: crc8OK && crc32OK === true,
    length,
    crc8_ok: crc8OK,
    crc32_ok: crc32OK,
    family,
    total: length + 4,
    header_crc16: null,
  };
}

/**
 * Accumulate BLE notification fragments into complete WHOOP frames.
 *
 * This is a faithful port of the NOOP `Reassembler` (which itself mirrors
 * framing.py and the Android `Framing.kt` window), plus explicit accounting of
 * bytes that must be dropped to resync (bytes ahead of a SOF, and obviously
 * corrupt SOFs whose declared length exceeds `MAX_FRAME_BYTES`).
 *
 * `feed()` returns `{ frames, droppedBytes, resyncs }`. Every byte the
 * reassembler drops is bytes that must still be preserved in the Level A
 * notify archive; the reassembler itself never mutates or destroys Level A
 * evidence, and it reports what it could not turn into a valid frame so the
 * caller can account for it instead of silently losing it.
 */
function puffinEnvelopeTotal(frag) {
  if (!frag || frag.length < 8 || frag[0] !== 0xAA || frag[1] !== 0x01) return null;
  const total = u16le(frag, 2) + 8;
  if (total < 12 || total > MAX_FRAME_BYTES) return null;
  if (crc16Modbus(frag, 0, 6) !== u16le(frag, 6)) return null;
  return total;
}

export function createReassembler({ family = 'harvard', intactNotify = true } = {}) {
  // flat buffer + read cursor (matches the Swift window; avoids O(n) shifting)
  let buf = [];
  let head = 0;
  let droppedBytes = 0;
  let resyncs = 0;

  function indexOfSOF() {
    for (let i = head; i < buf.length; i += 1) {
      if (buf[i] === 0xAA) return i;
    }
    return null;
  }

  function compact() {
    if (head === 0) return;
    if (head >= buf.length) {
      buf = [];
    } else {
      buf = buf.slice(head);
    }
    head = 0;
  }

  return {
    feed(fragment) {
      if (!fragment || !fragment.length) return { frames: [], droppedBytes: 0, resyncs: 0 };
      const frag = Array.isArray(fragment) ? fragment : Array.from(fragment);
      // Intact ATT notify: never splice a complete envelope into an in-progress
      // large frame (live type-40 is typically one notify; type-47 is not).
      let declared = null;
      if (frag[0] === 0xAA && frag.length >= 4) {
        if (family === 'puffin') {
          declared = puffinEnvelopeTotal(frag);
        } else {
          declared = u16le(frag, 1) + 4;
          if (declared < 8 || declared > MAX_FRAME_BYTES) declared = null;
        }
      }
      if (intactNotify && declared != null && frag.length === declared) {
        return { frames: [frag], droppedBytes, resyncs };
      }
      // ponytail: iOS ATT MTU 247 stores v20/v21 as 244-byte header prefixes.
      // Each prefix is a new envelope (valid header CRC, declared 1244/2140).
      // Concatenating them forges CRC-invalid frankenframes. A new header
      // abandons the incomplete previous record. Payload continuations that
      // are not themselves envelopes still concatenate.
      if (intactNotify && family === 'puffin' && declared != null && frag.length < declared) {
        const buffered = buf.length - head;
        if (buffered > 0) {
          droppedBytes += buffered;
          resyncs += 1;
          buf = [];
          head = 0;
        }
      }
      buf.push(...frag);
      const out = [];
      while (true) {
        const sof = indexOfSOF();
        if (sof === null) {
          // Nothing salvageable left in the window: drop it all and resync.
          droppedBytes += buf.length - head;
          buf = [];
          head = 0;
          break;
        }
        if (sof > head) {
          // Skip garbage ahead of the SOF; those bytes cannot be a frame.
          droppedBytes += sof - head;
          resyncs += 1;
          head = sof;
        }
        const avail = buf.length - head;
        if (avail < 4) break;
        let total;
        if (family === 'puffin') {
          total = u16le(buf, head + 2) + 8;
        } else {
          total = u16le(buf, head + 1) + 4;
        }
        if (total > MAX_FRAME_BYTES) {
          // Corrupt/SOF-injected length. Drop this SOF and resync to the next.
          droppedBytes += 1;
          resyncs += 1;
          head += 1;
          continue;
        }
        if (avail < total) break;
        out.push(buf.slice(head, head + total));
        head += total;
      }
      compact();
      return { frames: out, droppedBytes, resyncs };
    },
    // Calling `reset()` models a BLE disconnect: whatever partial frame is
    // buffered is discarded (those bytes remain in Level A). Returns the bytes
    // discarded so the caller can account for them as an incomplete frame.
    reset() {
      const discarded = buf.slice(head);
      buf = [];
      head = 0;
      return { discarded, discardedCount: discarded.length, incomplete: discarded.length > 0 };
    },
    family,
    stats() {
      return {
        family,
        buffered: buf.length - head,
        droppedBytes,
        resyncs,
      };
    },
  };
}
