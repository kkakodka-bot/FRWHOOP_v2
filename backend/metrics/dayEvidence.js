/**
 * Canonical day evidence: one loader for verify, replay, the finalize gate,
 * and late-data invalidation. B2 objects + object_manifests + ingest_gaps
 * are authoritative. Local day files are diagnostics only.
 */

import { decodeArchive, sha256Hex } from '../ingest/archiveFormat.js';
import { dayBounds } from '../time/dayBoundary.js';
import { inc } from '../observability/metrics.js';
import { parseArchiveRows } from '../protocol/census.js';

function toMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function unavailable(detail, code = 'ingest_verify_unavailable') {
  const err = new Error(detail);
  err.code = code;
  return err;
}

/** Sleep scoring / overnight replay window: local day start minus 12 h. */
export const OVERNIGHT_LOOKBACK_MS = 12 * 3600000;

/** Actual timestamps only. period_day is never a correctness filter. */
export function manifestOverlapsWindow(row, loMs, hiMs) {
  const start = toMs(row?.start_at);
  const end = toMs(row?.end_at);
  if (start != null && end != null) return end > loMs && start < hiMs;
  if (start != null && end == null) return start < hiMs;
  if (start == null && end != null) return end > loMs;
  return false;
}

export function dedupeManifests(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const id = row?.id || row?.object_key;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

/**
 * Clip verified [start,end) intervals to the local day, merge overlapping or
 * adjacent spans, then walk from day start. Returns the contiguous verified
 * frontier (ms) or null if the head is uncovered.
 */
export function verifiedArchiveFrontierMs(intervals, loMs, hiMs) {
  const clipped = [];
  for (const iv of intervals || []) {
    const start = toMs(iv.start_at ?? iv.start);
    const end = toMs(iv.end_at ?? iv.end);
    if (start == null || end == null || end <= start) continue;
    const s = Math.max(start, loMs);
    const e = Math.min(end, hiMs);
    if (e > s) clipped.push([s, e]);
  }
  clipped.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [s, e] of clipped) {
    const last = merged[merged.length - 1];
    if (!last || s > last[1]) merged.push([s, e]);
    else last[1] = Math.max(last[1], e);
  }
  if (!merged.length) return null;
  if (merged[0][0] > loMs) return null;
  let frontier = merged[0][1];
  for (let i = 1; i < merged.length; i += 1) {
    if (merged[i][0] > frontier) break;
    frontier = Math.max(frontier, merged[i][1]);
  }
  return frontier;
}

export async function loadVerifiedArchiveObject(raw, manifest, decodeRows = decodeArchive) {
  const key = manifest?.object_key;
  if (!key) return { ok: false, reason: 'missing_key' };
  if (manifest.status && !['ready', 'verified'].includes(manifest.status)) {
    return { ok: false, reason: 'not_ready', object_key: key };
  }
  const expected = manifest.sha256 ? String(manifest.sha256) : '';
  if (!raw || typeof raw.getObject !== 'function') {
    return { ok: false, reason: 'raw_object_store_unavailable', object_key: key };
  }
  try {
    const obj = await raw.getObject(key);
    if (!obj?.body) return { ok: false, reason: 'missing_object', object_key: key };
    if (!expected) return { ok: false, reason: 'missing_digest', object_key: key };
    const sha = sha256Hex(Buffer.from(obj.body));
    if (sha !== expected) {
      inc('object_verification_failures');
      return { ok: false, reason: 'digest_mismatch', object_key: key, sha256: sha, expected };
    }
    return {
      ok: true,
      object_key: key,
      sha256: sha,
      rows: decodeRows(obj.body),
    };
  } catch (err) {
    inc('object_verification_failures');
    return { ok: false, reason: 'unreadable', object_key: key, detail: String(err?.message || err).slice(0, 120) };
  }
}

/**
 * Download exact compressed bytes, SHA256-compare to the recorded digest,
 * then decode. Missing digest or mismatch fails closed.
 */
export async function loadVerifiedPhysiologyObject(raw, manifest) {
  const loaded = await loadVerifiedArchiveObject(raw, manifest, decodeArchive);
  if (!loaded.ok) return loaded;
  return { ...loaded, samples: loaded.rows };
}

export async function loadCanonicalWindowEvidence({
  db,
  raw,
  userId,
  fromDay,
  toDay,
  timeZone = 'UTC',
  extraKeys = [],
} = {}) {
  const from = fromDay || toDay;
  const to = toDay || fromDay;
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(String(from)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
    throw unavailable('day_completeness_requires_day', 'day_completeness_requires_day');
  }
  if (!db || typeof db.listPhysiologyManifests !== 'function') {
    throw unavailable('physiology_manifest_replay_unavailable');
  }
  if (!raw) throw unavailable('raw_object_store_unavailable');

  const startBounds = dayBounds(from, timeZone);
  const endBounds = dayBounds(to, timeZone);
  const hiMs = Date.parse(endBounds.day_end_at);
  const loMs = Date.parse(startBounds.day_start_at) - OVERNIGHT_LOOKBACK_MS;

  let listed;
  try {
    listed = await db.listPhysiologyManifests({
      userId,
      days: [from, to],
      fromDay: from,
      toDay: to,
      timeZone,
    });
  } catch (err) {
    throw unavailable(err?.message || 'manifest_access_unavailable');
  }
  if (!Array.isArray(listed)) throw unavailable('manifest_access_unavailable');

  const overlapping = dedupeManifests(listed).filter((row) => (
    row?.object_key
    && (row.object_kind == null || row.object_kind === 'physiology')
    && manifestOverlapsWindow(row, loMs, hiMs)
  ));

  const verifiedByObjectKey = {};
  const failures = [];
  const samples = [];
  for (const manifest of overlapping) {
    const loaded = await loadVerifiedPhysiologyObject(raw, manifest);
    if (!loaded.ok) {
      failures.push(loaded);
      if (
        typeof db.markManifestCorrupt === 'function'
        && (loaded.reason === 'digest_mismatch' || loaded.reason === 'missing_digest')
      ) {
        try { await db.markManifestCorrupt(manifest.object_key); } catch { /* best-effort */ }
      }
      continue;
    }
    verifiedByObjectKey[manifest.object_key] = {
      sha256: loaded.sha256,
      verified_at: new Date().toISOString(),
    };
    for (const sample of loaded.samples || []) samples.push(sample);
  }

  const have = new Set(overlapping.map((row) => row.object_key));
  for (const key of extraKeys || []) {
    if (!key || have.has(key)) continue;
    try {
      const obj = await raw.getObject(key);
      if (!obj?.body) continue;
      for (const sample of decodeArchive(obj.body)) samples.push(sample);
    } catch { /* extra keys cannot satisfy the gate */ }
  }

  let gapRows = [];
  if (typeof db.listIngestGaps === 'function') {
    try {
      gapRows = await db.listIngestGaps(userId, new Date(loMs).toISOString(), endBounds.day_end_at);
    } catch (err) {
      throw unavailable(err?.message || 'ingest_gaps_unavailable');
    }
  }

  return {
    fromDay: from,
    toDay: to,
    timeZone,
    loMs,
    hiMs,
    manifestRows: overlapping,
    verifiedByObjectKey,
    failures,
    samples,
    gapRows: Array.isArray(gapRows) ? gapRows : [],
    blocked: failures.length > 0 && overlapping.length > 0 && failures.length === overlapping.length,
    unavailableReason: failures.length === overlapping.length && overlapping.length > 0
      ? (failures[0]?.reason || 'raw_archive_unreadable')
      : null,
  };
}

export async function loadCanonicalDayEvidence({
  db,
  raw,
  userId,
  day,
  timeZone = 'UTC',
  extraKeys = [],
} = {}) {
  const evidence = await loadCanonicalWindowEvidence({
    db, raw, userId, fromDay: day, toDay: day, timeZone, extraKeys,
  });
  return { ...evidence, day, bounds: dayBounds(day, timeZone) };
}

/**
 * Level-A notify rows for a local day from the frames stream. Missing
 * listObjectManifests is unknown, not an empty day.
 *
 * ponytail: verify replays a bounded prefix (32 objects / 20k rows). Upgrade
 * by paging objects newest-first if a day regularly exceeds the cap.
 */
export const MAX_FRAME_OBJECTS = 32;
export const MAX_FRAME_ROWS = 20_000;

export async function loadCanonicalFrameRows({
  db,
  raw,
  userId,
  day,
  timeZone = 'UTC',
} = {}) {
  if (!db || typeof db.listObjectManifests !== 'function' || !raw) {
    return { rows: [], manifests: [], failures: [], truncated: false, unavailableReason: null };
  }
  let listed;
  try {
    listed = await db.listObjectManifests({
      userId, days: [day], timeZone, objectKind: 'frames',
    });
  } catch (err) {
    return {
      rows: [],
      manifests: [],
      failures: [],
      truncated: false,
      unavailableReason: err?.message || 'frame_manifest_unavailable',
    };
  }
  const manifests = (listed || []).filter((row) => row?.object_key);
  const truncated = manifests.length > MAX_FRAME_OBJECTS;
  const take = truncated ? manifests.slice(0, MAX_FRAME_OBJECTS) : manifests;
  const rows = [];
  const failures = [];
  for (const manifest of take) {
    const loaded = await loadVerifiedArchiveObject(raw, manifest, parseArchiveRows);
    if (!loaded.ok) {
      failures.push(loaded);
      continue;
    }
    for (const row of loaded.rows || []) {
      if (!row || typeof row !== 'object') continue;
      if (rows.length >= MAX_FRAME_ROWS) {
        return {
          rows,
          manifests,
          failures,
          truncated: true,
          unavailableReason: null,
        };
      }
      rows.push(row);
    }
  }
  const unavailableReason = failures.length && !rows.length
    ? (failures[0]?.reason || 'frame_archive_unreadable')
    : null;
  return { rows, manifests, failures, truncated, unavailableReason };
}
