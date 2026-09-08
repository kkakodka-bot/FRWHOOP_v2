// Redeode / replay orchestration for the FRWHOOP pipeline.
//
// The central invariant: WHOOP BLE bytes received by the application must never
// silently disappear. This module turns that into executable accounting.
//
// Two replay levels, both driven from byte-preserving archives:
//
//   Level A (notify archive): exact per-ATT-notify bytes as delivered by
//   CoreBluetooth, before any protocol parsing. This is what the iOS app writes
//   to ble-frames.ndjson and the backend archives to the B2 `frames` stream.
//
//   Level B (reassembled frame archive): complete WHOOP protocol frames after
//   fragment reassembly, preserved separately from the decoder so a newer
//   decoder can reinterpret the same historical frames later.
//
// `redecode()` replays Level A -> reassembler -> verify -> Level B -> decoder.
// It never discards a byte, never throws on an unknown/CRC-failed/malformed
// frame, and returns full accounting so gaps are observable, not silent.

import { createHash } from 'node:crypto';
import { createReassembler, verifyFrame } from '../protocol/framing.js';
import { decodeFrame, PACKET_TYPES } from '../protocol/decoder.js';

const PACKET_KNOWN = new Set(Object.keys(PACKET_TYPES).map(Number));

export function emptySession() {
  return {
    notifications_received: 0,
    bytes_received: 0,
    reassembled_frames: 0,
    crc_valid_frames: 0,
    crc_invalid_frames: 0,
    known_packet_types: 0,
    unknown_packet_types: 0,
    decoded_frames: 0,
    partially_decoded_frames: 0,
    classified_frames: 0,
    undecoded_frames: 0,
    raw_records_durably_stored: 0,
    b2_records_uploaded: 0,
    b2_objects_verified: 0,
    supabase_manifests_committed: 0,
    structured_samples_emitted: 0,
    duplicate_frames: 0,
    dropped_records: 0,
    parser_exceptions: 0,
    upload_failures: 0,
    resync_dropped_bytes: 0,
    incomplete_frame_discards: 0,
    dropped_reasons: {},
  };
}

function sha256Frame(frame) {
  return createHash('sha256').update(Buffer.from(frame)).digest('hex');
}

function frameToHex(frame) {
  let out = '';
  for (const b of frame) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Replay a stream of Level A notify rows through the reassembler + decoder.
 *
 * @param {Array} notifies  Level A rows: {hex|bytes, char, family, fw, model,
 *                          t, seq}
 * @param {Object} opts
 *   family   'harvard' | 'puffin' (per-connection generation). Default:
 *            inferred per notify from its characteristic; else 'harvard'.
 *   decoder  decoder version string
 *   filters  {startAt, endAt, packetTypes:[], versions:[], firmwareFamily,
 *             unknownOnly}
 */
export function replayNotifies(notifies, opts = {}) {
  const session = emptySession();
  const levelB = [];
  const decoded = [];
  const observed = {};
  const seenHashes = new Set();
  let lastFamily = opts.family || 'harvard';
  const filters = opts.filters || {};

  const familyOf = (row) => {
    if (opts.family) return opts.family;
    const fam = (row.family || '').toLowerCase();
    const ch = String(row.char || row.characteristic || '');
    if (fam === 'puffin' || ch.toUpperCase().startsWith('FD4B')) return 'puffin';
    if (fam === 'harvard' || ch.toUpperCase().startsWith('6108')) return 'harvard';
    return lastFamily;
  };

  const reassemblers = { harvard: null, puffin: null };
  function reassemblerFor(family) {
    if (!reassemblers[family]) reassemblers[family] = createReassembler({ family });
    if (lastFamily !== family) {
      const prev = reassemblers[lastFamily];
      if (prev) {
        const { discardedCount, incomplete } = prev.reset();
        if (incomplete) {
          session.incomplete_frame_discards += 1;
          session.dropped_records += 1;
          session.dropped_reasons.incomplete_frame_at_disconnect =
            (session.dropped_reasons.incomplete_frame_at_disconnect || 0) + 1;
        }
      }
      lastFamily = family;
    }
    return reassemblers[family];
  }

  const inFilter = (row, d) => {
    if (filters.unknownOnly) {
      return d.decode_status === 'unknown' || d.decode_status === 'malformed';
    }
    if (filters.packetTypes && filters.packetTypes.length
        && !filters.packetTypes.includes(d.packet_type)) return false;
    if (filters.versions && filters.versions.length && !filters.versions.includes(d.version)) return false;
    return true;
  };
  const inTime = (row) => {
    const ms = Date.parse(row.t || '');
    if (!Number.isFinite(ms)) return true;
    if (filters.startAt && ms < Date.parse(filters.startAt)) return false;
    if (filters.endAt && ms > Date.parse(filters.endAt)) return false;
    return true;
  };

  for (const row of notifies || []) {
    const fam = familyOf(row);
    const bytes = row.bytes
      ? Array.from(row.bytes)
      : (typeof row.hex === 'string' ? Buffer.from(row.hex, 'hex') : null);
    if (!bytes || !bytes.length) {
      session.dropped_records += 1;
      session.dropped_reasons.invalid_notify = (session.dropped_reasons.invalid_notify || 0) + 1;
      continue;
    }
    session.notifications_received += 1;
    session.bytes_received += bytes.length;
    if (!inTime(row)) {
      session.dropped_records += 1;
      session.dropped_reasons.out_of_selected_range = (session.dropped_reasons.out_of_selected_range || 0) + 1;
      continue;
    }
    const ack = reassemblerFor(fam).feed(bytes);
    session.resync_dropped_bytes += ack.droppedBytes;

    for (const frame of ack.frames) {
      session.reassembled_frames += 1;
      const check = verifyFrame(frame, fam);
      const hash = sha256Frame(frame);
      // Level B is a transport-faithful frame archive: every physical
      // occurrence is retained (the strap may retransmit). Deduplication is a
      // downstream structured-metric concern, so it is NOT applied here. We
      // still count duplicates for integrity accounting.
      if (seenHashes.has(hash)) session.duplicate_frames += 1;
      seenHashes.add(hash);

      if (check.crc8_ok === true && check.crc32_ok === true) session.crc_valid_frames += 1;
      else session.crc_invalid_frames += 1;

      let d;
      try {
        d = decodeFrame(frame, fam, { decoder: opts.decoder, frameHash: hash });
      } catch {
        session.parser_exceptions += 1;
        d = { decode_status: 'exception', confidence: 'low', frame_hash: hash,
              family: fam, decoder: opts.decoder, packet_type: null, version: null };
      }

      if (d.decode_status === 'decoded') session.decoded_frames += 1;
      else if (d.decode_status === 'partial') session.partially_decoded_frames += 1;
      else if (d.decode_status === 'classified') session.classified_frames += 1;
      else session.undecoded_frames += 1;

      if (d.packet_type != null && PACKET_KNOWN.has(d.packet_type)) session.known_packet_types += 1;
      else session.unknown_packet_types += 1;

      if (!inFilter(row, d)) continue;

      const layout = d.decoded?.hist_version ?? d.hist_version ?? d.version ?? null;
      levelB.push({
        schema: 'ndjson_gzip_frames_v1',
        kind: 'frame',
        family: fam,
        fw: row.fw || row.firmware || null,
        model: row.model || null,
        device_id: row.device_id || row.deviceId || null,
        user_id: row.user_id || row.userId || null,
        frame_hex: frameToHex(frame),
        frame_length: frame.length,
        declared_length: check.length,
        packet_type: d.packet_type,
        packet_name: d.packet_name,
        version: d.version,
        layout,
        crc8_ok: check.crc8_ok,
        crc32_ok: check.crc32_ok,
        crc_ok: check.ok,
        decode_status: d.decode_status,
        decoder: d.decoder,
        decoder_version: d.decoder || opts.decoder || null,
        frame_hash: hash,
        t: row.t || null,
        seq: row.seq ?? null,
        receive_seq: row.seq ?? null,
        char: row.char || row.characteristic || null,
        characteristic: row.char || row.characteristic || null,
        source_notify_seq: row.seq ?? null,
        // Deep decoded interpretation is persisted alongside the raw bytes so a
        // newer decoder can be re-run later and so high-frequency WHOOP5 arrays
        // (v21 100Hz IMU, v20 optical channels, v26 PPG waveform) are stored at
        // FULL RESOLUTION — never reduced to a mean. `parsed` carries NOOP-semantic
        // fields with the decoder lineage (protocol/whoop5.js, noop@ab0f699e).
        decoded: d.decoded,
      });
      decoded.push(d);

      if (d.decode_status === 'unknown' || d.decode_status === 'malformed'
          || d.packet_type == null) {
        const key = `${fam}|${row.fw || '?'}|${row.char || '?'}|${d.packet_type ?? '?'}|${d.version ?? '?'}|${check.length ?? '?'}|${d.decode_status}`;
        const firstT = row.t || null;
        const o = (observed[key] = observed[key] || {
          family: fam,
          firmware: row.fw || null,
          characteristic: row.char || null,
          packet_type: d.packet_type,
          packet_version: d.version,
          frame_length: check.length,
          parse_status: d.decode_status,
          first_seen: firstT,
          last_seen: firstT,
          occurrence_count: 0,
          representative_frame_hash: hash,
        });
        o.occurrence_count += 1;
        o.first_seen = o.first_seen || firstT;
        if (firstT) o.last_seen = firstT;
        o.representative_frame_hash = hash;
      }
    }
  }

  for (const family of Object.keys(reassemblers)) {
    const r = reassemblers[family];
    if (r) {
      const { incomplete } = r.reset();
      if (incomplete) {
        session.incomplete_frame_discards += 1;
        session.dropped_records += 1;
        session.dropped_reasons.incomplete_frame_at_end =
          (session.dropped_reasons.incomplete_frame_at_end || 0) + 1;
      }
    }
  }

  return { levelB, decoded, session, observed: Object.values(observed) };
}

const HIGH_RATE_LIVE = new Set([43, 51]);

/**
 * notifications → frames → CRC valid/invalid → known/unknown types/layouts
 * → decoded rows → raw-only rows. CRC-invalid frames are evidence, never
 * trusted physiology.
 */
export function pipelineAccounting(session = emptySession(), levelB = []) {
  let knownLayouts = 0;
  let unknownLayouts = 0;
  let decodedRows = 0;
  let rawOnly = 0;
  const realtimeHighRate = [];
  for (const rec of levelB || []) {
    const hist = rec.packet_type === 47 || rec.packet_type === 52;
    if (hist) {
      if (rec.decoded?.mapped === true) knownLayouts += 1;
      else unknownLayouts += 1;
    }
    const trusted = rec.crc_ok === true
      && (rec.decode_status === 'decoded' || rec.decode_status === 'partial');
    if (trusted && rec.decoded?.mapped !== false) decodedRows += 1;
    else rawOnly += 1;
    if (HIGH_RATE_LIVE.has(rec.packet_type)) {
      realtimeHighRate.push({
        packet_type: rec.packet_type,
        frame_hash: rec.frame_hash || null,
        recoverable: false,
      });
    }
  }
  return {
    notifications: session.notifications_received ?? 0,
    frames: session.reassembled_frames ?? 0,
    crc_valid: session.crc_valid_frames ?? 0,
    crc_invalid: session.crc_invalid_frames ?? 0,
    known_packet_types: session.known_packet_types ?? 0,
    unknown_packet_types: session.unknown_packet_types ?? 0,
    known_layouts: knownLayouts,
    unknown_layouts: unknownLayouts,
    decoded_rows: decodedRows,
    raw_only_rows: rawOnly,
    duplicate_frames: session.duplicate_frames ?? 0,
    realtime_high_rate: realtimeHighRate,
  };
}

/**
 * Compare old vs new decode output for the same Level A input.
 */
export function compareDecodes(levelA, { decoderA = 'frwhoop-js/0', decoderB = 'frwhoop-js/1' } = {}) {
  const a = replayNotifies(levelA, { decoder: decoderA });
  const b = replayNotifies(levelA, { decoder: decoderB });
  const byHash = (recs) => {
    const m = new Map();
    for (const r of recs) m.set(r.frame_hash, r);
    return m;
  };
  const am = byHash(a.decoded);
  const bm = byHash(b.decoded);
  const changed = [];
  for (const [hash, ra] of am) {
    const rb = bm.get(hash);
    if (!rb) { changed.push({ frame_hash: hash, change: 'missing_in_new', from: ra.decode_status, to: null }); continue; }
    if (ra.decode_status !== rb.decode_status) {
      changed.push({ frame_hash: hash, change: 'status', from: ra.decode_status, to: rb.decode_status });
    } else if (ra.packet_type !== rb.packet_type) {
      changed.push({ frame_hash: hash, change: 'packet_type', from: ra.packet_type, to: rb.packet_type });
    } else if (ra.decoded?.hr != null && rb.decoded?.hr != null && ra.decoded.hr !== rb.decoded.hr) {
      changed.push({ frame_hash: hash, change: 'hr', from: ra.decoded.hr, to: rb.decoded.hr });
    }
  }
  return {
    decodedA: a.decoded.length,
    decodedB: b.decoded.length,
    changed,
    changedCount: changed.length,
  };
}
