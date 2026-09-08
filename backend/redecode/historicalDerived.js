// Historical B2 redecode of derived event streams.
//
// Live hourBuffer and this module share `deriveRecords`. Packet 54 is
// replayed into the events stream as historical/replayed records only.
// Frame-hash idempotency is shared across archive objects so identical
// evidence cannot duplicate durable events.

import { deriveRecords } from './derive.js';

export function isWhoopFramedNotify(row) {
  const hex = typeof row?.hex === 'string' ? row.hex : '';
  return hex.length >= 16 && hex.toLowerCase().startsWith('aa');
}

export function puffin54PersistOk(record) {
  if (!record || record.kind !== 'puffin_event_54') return false;
  if (record.historical !== true || record.live_side_effects !== false) return false;
  if (!Number.isFinite(record.event_id) || record.stored_unix == null) return false;
  if (record.payload_hex == null || !record.envelope?.frame_hash) return false;
  if (!record.provenance?.decoder_version || record.provenance.packet_type !== 54) return false;
  if (!String(record.event_name || '').startsWith('PUFFIN_EVENT_')) return false;
  return true;
}

/**
 * Derive events per archive object (isolated reassemblers), with a shared
 * type-54 frame-hash set. Attaches B2 key provenance without changing live
 * hourBuffer records.
 */
export function deriveHistoricalFromObjects(objects, { seenPuffin54 } = {}) {
  const seen = seenPuffin54 || new Set();
  const events = [];
  let puffin54Duplicates = 0;
  let notifications = 0;
  let frames = 0;
  for (const o of objects || []) {
    const rows = (o.rows || []).filter(isWhoopFramedNotify);
    const d = deriveRecords(rows, { seenPuffin54: seen });
    puffin54Duplicates += d.session.puffin54_duplicates || 0;
    notifications += d.session.notifications || 0;
    frames += d.session.frames || 0;
    for (const e of d.events) {
      const provenance = {
        ...(e.provenance || {}),
        b2_key: o.key || null,
        user_id: o.user || null,
        device_id: o.device || null,
      };
      events.push({ ...e, provenance });
    }
  }
  const puffin54 = events.filter((e) => e.kind === 'puffin_event_54');
  const kinds = {};
  for (const e of puffin54) {
    const k = String(e.event_id);
    kinds[k] = (kinds[k] || 0) + 1;
  }
  return {
    events,
    puffin54,
    seenPuffin54: seen,
    census: {
      objects: (objects || []).length,
      notifications,
      frames,
      event_records: events.length,
      puffin54_records: puffin54.length,
      puffin54_unique_hashes: seen.size,
      puffin54_kinds: kinds,
      puffin54_duplicates: puffin54Duplicates,
    },
  };
}
