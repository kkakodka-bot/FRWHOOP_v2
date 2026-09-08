// Derived-record derivation from Level A notify rows.
//
// One pass over Level A notify rows -> reassembly -> CRC verify -> decode ->
//   { imu, events, console, battery, census } records.
//
// Used by BOTH production paths so they can never disagree:
//   - hourBuffer frame flush (live): archiveImuRaw / archiveEvents / …
//   - bin/redecode.mjs --derive (offline): regenerate the same streams from
//     old Level A captures (mission target 3: replay new interpretations
//     against old captures).
//
// Invariants:
//   - never throws on any row; malformed rows are counted, not dropped
//   - every record carries frame-hash + decoder lineage
//   - census (packet-type counts + frame-size stats) is returned so callers
//     can attach before/after evidence to every derived batch.

import { createReassembler, verifyFrame } from '../protocol/framing.js';
import { sha256, DECODER_LINEAGE } from '../protocol/decoder.js';
import { imuRecordFromFrame } from '../protocol/imuArchive.js';
import { ppgRecordFromFrame } from '../protocol/ppgArchive.js';
import { recordsFromFrame } from '../protocol/eventRecords.js';
import { puffin54DebugEnabled, puffin54Log } from '../protocol/puffin54.js';
import { deepSensorRecordsFromFrame } from '../protocol/deepSensorArchive.js';
import { noteDeriveSession } from '../protocol/consumption.js';

export function emptyDeriveSession() {
  return {
    notifications: 0,
    bytes: 0,
    frames: 0,
    crc_valid_frames: 0,
    crc_invalid_frames: 0,
    puffin54_duplicates: 0,
    puffin54_records: 0,
    puffin54_kinds: {},
    puffin54_unique_hashes: 0,
    imu_records: 0,
    imu_kinds: {},
    ppg_records: 0,
    ppg_kinds: {},
    whoop5_imu_v21: 0,
    whoop5_ppg_v26: 0,
    whoop5_optical_v20: 0,
    events: 0,
    event_names: {},
    console_logs: 0,
    cmd_battery: 0,
    packet_census: {},
    frame_size_census: {},
    parser_exceptions: 0,
  };
}

function censusAdd(map, key, by = 1) {
  const k = String(key);
  map[k] = (map[k] || 0) + by;
}

/**
 * Derive records from Level A notify rows.
 * @param {Array} rows  [{hex|bytes, char, family, fw, model, t, seq}]
 * @param {Object} opts { family?: 'puffin'|'harvard' }
 */
export function deriveRecords(rows, opts = {}) {
  const session = emptyDeriveSession();
  const imu = [];
  const ppg = [];
  const whoop5Imu = [];
  const whoop5Ppg = [];
  const whoop5Optical = [];
  const events = [];
  const consoleLogs = [];
  const battery = [];
  const reassemblers = opts.reassemblers || { harvard: null, puffin: null };
  const seenPuffin54 = opts.seenPuffin54 || new Set();
  let lastFamily = opts.family || null;

  const familyOf = (row) => {
    if (opts.family) return opts.family;
    const fam = String(row?.family || '').toLowerCase();
    const ch = String(row?.char || row?.characteristic || '');
    if (fam === 'puffin' || ch.toUpperCase().startsWith('FD4B')) return 'puffin';
    if (fam === 'harvard' || ch.toUpperCase().startsWith('6108')) return 'harvard';
    return lastFamily || 'harvard';
  };

  const reassemblerFor = (family) => {
    if (!reassemblers[family]) reassemblers[family] = createReassembler({ family });
    return reassemblers[family];
  };

  for (const row of rows || []) {
    const bytes = row?.bytes
      ? Array.from(row.bytes)
      : (typeof row?.hex === 'string' ? Buffer.from(row.hex, 'hex') : null);
    if (!bytes || !bytes.length) continue;
    session.notifications += 1;
    session.bytes += bytes.length;
    const fam = familyOf(row);
    lastFamily = fam;
    let frames = [];
    try {
      const ack = reassemblerFor(fam).feed(bytes);
      frames = ack.frames || [];
    } catch {
      session.parser_exceptions += 1;
      continue;
    }
    for (const frame of frames) {
      session.frames += 1;
      const check = verifyFrame(frame, fam);
      if (check.crc8_ok === true && check.crc32_ok === true) session.crc_valid_frames += 1;
      else session.crc_invalid_frames += 1;
      const typeOff = fam === 'puffin' ? 8 : 4;
      const pt = frame.length > typeOff ? frame[typeOff] : null;
      const size = frame.length;
      censusAdd(session.packet_census, pt ?? 'unknown');
      censusAdd(session.frame_size_census, `${pt ?? '?'}:${size}`);
      if (check.ok !== true) {
        // CRC-invalid frames carry no trustworthy payload — count and skip
        // (their bytes remain in the Level A / Level B archives).
        continue;
      }
      const ctx = {
        fw: row?.fw || null,
        model: row?.model || null,
        char: row?.char || row?.characteristic || null,
        seq: row?.seq ?? null,
        receivedAt: row?.t || null,
        crcOk: check.ok === true,
        decoder: 'frwhoop-js/1',
        lineage: DECODER_LINEAGE,
        frameHash: sha256(frame),
        sourceObjectId: row?._key || row?._objectId || null,
      };
      // IMU record (hash must match the decoder's own hash so provenance is
      // consistent across streams).
      try {
        const rec = imuRecordFromFrame(frame, fam, ctx);
        if (rec) {
          imu.push(rec);
          censusAdd(session.imu_kinds, rec.kind);
          session.imu_records += 1;
        }
      } catch { session.parser_exceptions += 1; }
      try {
        const rec = ppgRecordFromFrame(frame, fam, ctx);
        if (rec) {
          ppg.push(rec);
          censusAdd(session.ppg_kinds, rec.kind);
          session.ppg_records += 1;
        }
      } catch { session.parser_exceptions += 1; }
      try {
        const deep = deepSensorRecordsFromFrame(frame, fam, ctx);
        if (deep.imu) {
          whoop5Imu.push(deep.imu);
          session.whoop5_imu_v21 += 1;
        }
        if (deep.ppg) {
          whoop5Ppg.push(deep.ppg);
          session.whoop5_ppg_v26 += 1;
        }
        if (deep.optical) {
          whoop5Optical.push(deep.optical);
          session.whoop5_optical_v20 += 1;
        }
      } catch { session.parser_exceptions += 1; }
      try {
        const recs = recordsFromFrame(frame, fam, ctx);
        if (pt === 54) {
          const h = ctx.frameHash;
          if (seenPuffin54.has(h)) {
            session.puffin54_duplicates += recs.events.length;
            recs.events = [];
          } else {
            seenPuffin54.add(h);
            session.puffin54_records += recs.events.length;
            for (const e of recs.events) censusAdd(session.puffin54_kinds, e.event_id);
          }
        }
        events.push(...recs.events);
        consoleLogs.push(...recs.console);
        battery.push(...recs.battery);
        session.events += recs.events.length;
        for (const e of recs.events) censusAdd(session.event_names, e.event_name);
        session.console_logs += recs.console.length;
      } catch { session.parser_exceptions += 1; }
    }
  }
  session.puffin54_unique_hashes = seenPuffin54.size;
  noteDeriveSession(session);
  if (opts.reset !== false) {
    for (const family of Object.keys(reassemblers)) {
      reassemblers[family]?.reset();
    }
  }
  if (puffin54DebugEnabled()) {
    const t48 = [];
    for (const e of events) {
      if (e?.kind === 'event' && Number.isFinite(e.event_ts) && Number.isFinite(e.event_id)) {
        t48.push(e);
      }
    }
    for (const e of events) {
      if (e?.kind !== 'puffin_event_54') continue;
      const unix = Number(e.event_ts);
      if (!Number.isFinite(unix)) continue;
      let best = null;
      for (const live of t48) {
        const dt = Math.abs(live.event_ts - unix);
        if (best == null || dt < best.dt) best = { event_id: live.event_id, dt };
      }
      if (best) {
        puffin54Log(`[P54] correlate kind=${e.event_id} type48=${best.event_id} dt_ms=${best.dt * 1000}`);
      }
    }
  }
  return {
    imu, ppg, events, console: consoleLogs, battery, session, reassemblers,
    whoop5Imu, whoop5Ppg, whoop5Optical,
  };
}
