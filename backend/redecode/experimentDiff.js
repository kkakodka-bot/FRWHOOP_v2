// Differential experiment analyzer — mission core tool for one-reversible-
// change hardware experiments (cmd105/packet-52, cmd81/packet-51, cmd132).
//
// Given Level A notify rows split into windows (before / during / after), it
// produces exact per-window packet censuses and a strict diff, so a single
// protocol change is judged by evidence, not by staring at bytes:
//   - packet-type counts, frame-length histograms, hist-version histograms
//   - command-response (cmd,result) histogram
//   - new/disappeared packet types between windows
//   - for IMU-carrying frames: physics-gated records (gravity shell, gyro
//     stillness, motion response) via the same imuArchive code as production
//   - for packet 52: raw preservation + vault-header plausibility, never an
//     unproven parse presented as decoded
//
// Never throws on any row; CRC-invalid frames are counted, never decoded.

import { createReassembler, verifyFrame } from '../protocol/framing.js';
import { decodeFrame } from '../protocol/decoder.js';
import { imuRecordFromFrame } from '../protocol/imuArchive.js';
import { PACKET_TYPES } from '../protocol/decoder.js';

const INTERESTING_TYPES = new Set([43, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56]);

export function censusWindow(rows, { family } = {}) {
  const session = {
    notifies: 0, bytes: 0, frames: 0,
    crc_valid: 0, crc_invalid: 0,
    packet_types: {}, frame_lengths: {}, hist_versions: {},
    cmd_responses: {}, events: {},
    puffin54_kinds: {},
    type_counts: {},   // interesting types detail
    first_t: null, last_t: null,
  };
  const reassemblers = { harvard: null, puffin: null };
  let lastFamily = family || null;
  const famOf = (row) => {
    if (family) return family;
    const f = String(row?.family || '').toLowerCase();
    const ch = String(row?.char || row?.characteristic || '');
    if (f === 'puffin' || ch.toUpperCase().startsWith('FD4B')) return 'puffin';
    if (f === 'harvard' || ch.toUpperCase().startsWith('6108')) return 'harvard';
    return lastFamily || 'harvard';
  };
  const bump = (map, key, by = 1) => { const k = String(key); map[k] = (map[k] || 0) + by; };
  const bufs = { harvard: null, puffin: null };
  for (const row of rows || []) {
    const bytes = row?.bytes ? Array.from(row.bytes)
      : (typeof row?.hex === 'string' ? Buffer.from(row.hex, 'hex') : null);
    if (!bytes || !bytes.length) continue;
    session.notifies += 1;
    session.bytes += bytes.length;
    const t = row?.t || row?.datetime || null;
    if (t) { if (!session.first_t) session.first_t = t; session.last_t = t; }
    const fam = famOf(row);
    lastFamily = fam;
    if (!bufs[fam]) bufs[fam] = createReassembler({ family: fam });
    let frames = [];
    try { frames = bufs[fam].feed(bytes).frames || []; } catch { continue; }
    for (const frame of frames) {
      session.frames += 1;
      const check = verifyFrame(frame, fam);
      const typeOff = fam === 'puffin' ? 8 : 4;
      const pt = frame.length > typeOff ? frame[typeOff] : null;
      if (check.crc8_ok === true && check.crc32_ok === true) {
        session.crc_valid += 1;
      } else {
        session.crc_invalid += 1;
        continue;
      }
      bump(session.packet_types, pt ?? 'unknown');
      bump(session.frame_lengths, `${pt ?? '?'}:${frame.length}`);
      if (pt === 47 || pt === 52) bump(session.hist_versions, frame[typeOff + 1]);
      if (pt === 36 || pt === 38) {
        // resp_cmd@10(resp puffin)/6(harvard), result payload byte
        const cmd = fam === 'puffin' ? frame[10] : frame[6];
        const result = fam === 'puffin' && frame.length > 13 ? frame[13] : (fam === 'harvard' && frame.length > 9 ? frame[9] : null);
        bump(session.cmd_responses, `${cmd}:${result ?? '?'}`);
      }
      if (pt === 48) {
        const ev = fam === 'puffin' ? frame[10] : frame[6];
        bump(session.events, ev);
      }
      if (pt === 54 && fam === 'puffin' && frame.length >= 12) {
        const kind = frame[10] | (frame[11] << 8);
        bump(session.puffin54_kinds, kind);
      }
      if (INTERESTING_TYPES.has(pt)) bump(session.type_counts, pt);
    }
  }
  for (const fam of Object.keys(bufs)) bufs[fam]?.reset?.();
  return session;
}

/**
 * Extract the experiment-relevant evidence from a Level A window:
 *   - IMU physics records (v21 banked + type-43/51 realtime attempts)
 *   - every packet-52 frame raw + classification (layout unknown stays unknown)
 *   - any other interesting-type frame hex samples (bounded)
 */
export function extractExperimentFrames(rows, { maxSamplesPerType = 5 } = {}) {
  const out = {
    imu: [],
    imu_physics_pass: 0,
    type51: [],
    type52: [],
    samples: {},   // packet_type -> [{hex, length, t, char}]
  };
  const reassemblers = {};
  const famOf = (row) => {
    const f = String(row?.family || '').toLowerCase();
    const ch = String(row?.char || row?.characteristic || '');
    if (f === 'puffin' || ch.toUpperCase().startsWith('FD4B')) return 'puffin';
    if (f === 'harvard' || ch.toUpperCase().startsWith('6108')) return 'harvard';
    return 'harvard';
  };
  const bufs = {};
  const seenPerType = {};
  for (const row of rows || []) {
    const bytes = row?.bytes ? Array.from(row.bytes)
      : (typeof row?.hex === 'string' ? Buffer.from(row.hex, 'hex') : null);
    if (!bytes || !bytes.length) continue;
    const fam = famOf(row);
    if (!bufs[fam]) bufs[fam] = createReassembler({ family: fam });
    let frames = [];
    try { frames = bufs[fam].feed(bytes).frames || []; } catch { continue; }
    for (const frame of frames) {
      const check = verifyFrame(frame, fam);
      if (check.ok !== true) continue;
      const typeOff = fam === 'puffin' ? 8 : 4;
      const pt = frame.length > typeOff ? frame[typeOff] : null;
      if (pt === 51 || pt === 52 || INTERESTING_TYPES.has(pt)) {
        const rec = { t: row?.t || null, char: row?.char || null, hex: Buffer.from(frame).toString('hex') };
        if (pt === 52) out.type52.push(rec);
        if (pt === 51) out.type51.push(rec);
        seenPerType[pt] = (seenPerType[pt] || 0) + 1;
        if (seenPerType[pt] <= maxSamplesPerType) {
          (out.samples[pt] = out.samples[pt] || []).push(rec);
        }
      }
      // IMU physics records through the production code path (v21 banked, 43/51 live)
      const rec = imuRecordFromFrame(frame, fam, {
        fw: row?.fw || null, model: row?.model || null,
        char: row?.char || row?.characteristic || null, seq: row?.seq ?? null,
        receivedAt: row?.t || null, crcOk: true,
      });
      if (rec) {
        out.imu.push(rec);
        if (rec.physics?.gravity_shell_ok) out.imu_physics_pass += 1;
      }
    }
  }
  for (const fam of Object.keys(bufs)) bufs[fam]?.reset?.();
  return out;
}

export function diffCensus(before, during, after) {
  const types = new Set([
    ...Object.keys(before?.packet_types || {}),
    ...Object.keys(during?.packet_types || {}),
    ...Object.keys(after?.packet_types || {}),
  ]);
  const rows = [];
  for (const t of types) {
    const b = before?.packet_types?.[t] || 0;
    const d = during?.packet_types?.[t] || 0;
    const a = after?.packet_types?.[t] || 0;
    if (d !== b || (after && a !== b)) {
      rows.push({ packet_type: t, before: before?.packet_types?.[t] || 0, during: d, after: after?.packet_types?.[t] || 0, delta_during: d - (before?.packet_types?.[t] || 0) });
    }
  }
  rows.sort((x, y) => Math.abs(y.delta_during) - Math.abs(x.delta_during) || y.during - x.during);
  // length-histogram diff for the most protocol-relevant types
  const lengths = {};
  for (const key of new Set([
    ...Object.keys(before?.frame_lengths || {}),
    ...Object.keys(during?.frame_lengths || {}),
  ])) {
    const b = before?.frame_lengths?.[key] || 0;
    const d = during?.frame_lengths?.[key] || 0;
    if (b !== d) lengths[key] = { before: b, during: d, delta: d - b };
  }
  return {
    changed_types: rows,
    new_types_during: rows.filter((r) => r.before === 0 && r.during > 0).map((r) => r.packet_type),
    disappeared_during: rows.filter((r) => r.before > 0 && r.during === 0).map((r) => r.packet_type),
    frame_length_diffs: lengths,
  };
}
