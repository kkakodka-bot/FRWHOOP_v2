// Level B archive writer for the redecode pipeline.
//
// Level B records (complete reassembled WHOOP frames) are archived to B2 as a
// distinct immutable `frames_reassembled` stream, separate from the Level A
// notify `frames` stream. The object key is content-addressed by an objectId
// supplied by the caller and versioned under v3 (retention core, never expires).
//
// Idempotency: the caller derives a deterministic objectId (e.g. from the first
// frame hash + decoder version), so a retried redecode overwrites the same key
// instead of duplicating an object. `completeUpload` marks the manifest `ready`
// only after the object passes size verification; a failed verification marks
// it `failed` and the caller may retry.
//
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { rawObjectKeyV3 } from '../storage/keys.js';
import { createManifestStore, completeUpload } from '../storage/manifests.js';
import { expiresAt } from '../storage/retention.js';
import { physiologicalDay } from '../time/dayBoundary.js';

export const LEVELB_STREAM = 'frames_reassembled';
export const LEVELB_FORMAT = 'ndjson_gzip_frames_v1'; // frame-level records
export const LEVELB_SCHEMA_VERSION = 1;

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Encode Level B frame records as an immutable gzip NDJSON object body.
 * Each line is one complete reassembled WHOOP frame plus its verification,
 * decode, and lineage metadata. Reuses the gzip NDJSON framing established by
 * the Level A `frames` stream so existing tooling can read both.
 */
export function encodeLevelBArchive(levelBRecords) {
  const rows = (levelBRecords || []).filter((r) => r && r.frame_hex);
  const ndjson = `${rows.map((r) => JSON.stringify(r)).join('\n')}${rows.length ? '\n' : ''}`;
  const body = gzipSync(Buffer.from(ndjson, 'utf8'));
  return {
    body,
    sample_count: rows.length,
    compressed_bytes: body.length,
    sha256: sha256Hex(body),
    format: LEVELB_FORMAT,
    compression: 'gzip',
    content_type: 'application/x-ndjson',
    schema_version: LEVELB_SCHEMA_VERSION,
    rows,
  };
}

/**
 * Write a Level B object to B2 and commit its manifest.
 *
 * @param {Object} deps
 *   stores      resolved { raw, cfg } from storage/stores.js
 *   manifests   a manifest store ({insertPending, mark, get})
 *   rest        supabase rest client (for manifest fallback)
 *   userId, deviceId  opaque UUIDs (keys never contain PII)
 *   levelB      array of Level B frame records
 *   startAt, endAt   ISO instants
 *   objectId    deterministic id (recommended). Default: randomUUID.
 *   periodDay   optional local day string
 * @returns {{ok:boolean, objectId, objectKey, status, duplicate?}}
 */
export async function writeLevelBObject({
  stores = { raw: null, cfg: {} },
  manifests,
  rest = null,
  userId,
  deviceId,
  levelB = [],
  startAt,
  endAt,
  objectId = randomUUID(),
  periodDay,
  firmware = null,
  decoder = null,
  timeZone = 'UTC',
} = {}) {
  if (!levelB.length) return { ok: false, error: 'no_records' };
  const encoded = encodeLevelBArchive(levelB);
  if (!encoded.sample_count) return { ok: false, error: 'empty_archive' };
  const cfg = stores.cfg || {};
  const objId = objectId;
  const start = startAt || levelB[0]?.t || new Date().toISOString();
  const end = endAt || levelB[levelB.length - 1]?.t || new Date().toISOString();
  const day = periodDay || physiologicalDay({ nowIso: end, timeZone });

  const manifestStore = manifests || (rest ? createManifestStore({ rest }) : null);
  // Pre-check: an already-ready manifest for this objectId short-circuits.
  if (manifestStore) {
    const existing = await manifestStore.get(objId).catch(() => null);
    if (existing && (existing.status === 'ready' || existing.status === 'verified')) {
      return { ok: true, objectId: objId, objectKey: existing.object_key, status: existing.status, duplicate: true };
    }
  }

  const stream = LEVELB_STREAM;
  const key = rawObjectKeyV3({ userId, deviceId, stream, startAt: start, objectId: objId });
  const row = {
    id: objId,
    user_id: userId,
    device_id: deviceId,
    object_class: 'raw',
    object_kind: stream,
    provider: cfg.rawStore || 'b2',
    object_key: key,
    store: cfg.rawStore || 'b2',
    bucket: cfg.b2Bucket || null,
    start_at: start,
    end_at: end,
    period_day: day,
    sample_count: encoded.sample_count,
    compressed_bytes: encoded.compressed_bytes,
    content_type: encoded.content_type,
    format: encoded.format,
    compression: encoded.compression,
    schema_version: LEVELB_SCHEMA_VERSION,
    sha256: encoded.sha256,
    retention_class: 'core',
    expires_at: expiresAt('frames_reassembled', new Date(), cfg),
    status: 'pending',
  };
  if (firmware) row.firmware = firmware;
  if (decoder) row.decoder_version = decoder;

  if (manifestStore) await manifestStore.insertPending(row).catch(() => {});

  let etag = null;
  let rawOk = false;
  if (stores.raw) {
    const put = await stores.raw.putObject(key, encoded.body, { contentType: encoded.content_type });
    etag = put?.etag || null;
    const head = await stores.raw.head(key);
    if (head?.exists && (head.contentLength == null || Number(head.contentLength) === encoded.compressed_bytes)) {
      rawOk = true;
    }
  }

  if (manifestStore) {
    const out = await completeUpload({
      manifests: manifestStore,
      objectStore: stores.raw,
      objectId: objId,
      expectedBytes: encoded.compressed_bytes,
      expectedSha256: encoded.sha256,
    }).catch((err) => ({ ok: false, error: String(err.message || err) }));
    return {
      ok: rawOk && out.ok !== false,
      status: out.status || (rawOk ? 'ready' : 'pending'),
      objectId: objId,
      objectKey: key,
      duplicate: out.duplicate === true,
      uploaded: Boolean(etag) || rawOk,
      error: out.error,
    };
  }
  return { ok: rawOk, status: rawOk ? 'ready' : 'pending', objectId: objId, objectKey: key, uploaded: Boolean(etag) || rawOk };
}
