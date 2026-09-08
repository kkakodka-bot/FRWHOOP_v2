
// Versioned re-decode sidecars (mission: "write versioned re-decode sidecars so
// improved decoders never overwrite source data").
//
// Every Level B frame replay produces a DECODE SIDECAR: an immutable record
// keyed by (frame_hash, decoder_version) that carries the decoder's
// interpretation SUMMARY - statuses, coverage accounting, warnings, confidence,
// lineage - WITHOUT the raw bytes (those stay in Level A/B, unchanged forever).
// A future decoder version writes NEW sidecars under ITS version; nothing is
// ever overwritten in place.
//
// Retention: sidecars are cheap (no sample arrays) and are classed `core`.

import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { rawObjectKeyV3, uuidFromParts, isUuid } from '../storage/keys.js';
import { createManifestStore, completeUpload } from '../storage/manifests.js';
import { expiresAt } from '../storage/retention.js';
import { physiologicalDay } from '../time/dayBoundary.js';
import { replayNotifies } from './redecode.js';
import { FRAME_DECODER_VERSION } from '../ingest/archiveFormat.js';

export const SIDECAR_STREAM = 'frames_redecode_sidecars';
export const SIDECAR_FORMAT = 'ndjson_gzip_redecode_sidecars_v1';
export const SIDECAR_SCHEMA_VERSION = 2;

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Build one sidecar record from a decoded Level B frame record.
 * Pure: no I/O, no mutation of the input.
 */
export function sidecarFromLevelB(levelBRecord, decoderVersion) {
  const rec = levelBRecord || {};
  const decoded = rec.decoded || {};
  const coverage = rec.coverage?.summary || decoded?.coverage?.summary || decoded?.parsed?.coverage || null;
  return {
    sidecar_schema: 'frwhoop_redecode_sidecar_v2',
    schema_version: SIDECAR_SCHEMA_VERSION,
    frame_hash: rec.frame_hash ?? rec.envelope?.frame_hash ?? null,
    decoder_version: decoderVersion ?? rec.decoder ?? null,
    lineage: rec.decoded?.lineage ?? rec.decoded?.parsed?.lineage ?? null,
    family: rec.family ?? null,
    packet_type: rec.packet_type ?? null,
    packet_name: rec.packet_name ?? null,
    version: rec.version ?? null,
    hist_version: rec.decoded?.hist_version ?? rec.decoded?.parsed?.hist_version ?? null,
    body_tag: rec.decoded?.parsed?.tag ?? rec.decoded?.parsed?.kind ?? null,
    frame_length: rec.frame_length ?? rec.raw_length ?? null,
    decode_status: rec.decode_status ?? null,
    confidence: rec.confidence ?? rec.decoded?.confidence ?? null,
    crc_ok: rec.crc_ok ?? null,
    coverage_summary: coverage,
    unknown_spans: rec.coverage?.unknown || decoded?.coverage?.unknown || decoded?.parsed?.unknown_spans || [],
    warnings: rec.decoded?.warnings || rec.decoded?.parsed?.decode_warnings || decoded?.warnings || [],
    mapped: rec.decoded?.mapped ?? null,
    registry_version: rec.registry_version ?? null,
    // NO raw bytes here by design: the Level B/L-A archives keep the bytes.
    created_at: new Date().toISOString(),
  };
}

/**
 * Encode a batch of sidecars as a gzip NDJSON object body.
 */
export function encodeSidecarArchive(sidecars) {
  const rows = (sidecars || []).filter(Boolean);
  const ndjson = `${rows.map((r) => JSON.stringify(r)).join('\n')}${rows.length ? '\n' : ''}`;
  const body = gzipSync(Buffer.from(ndjson, 'utf8'));
  return {
    body,
    sample_count: rows.length,
    compressed_bytes: body.length,
    sha256: sha256Hex(body),
    format: SIDECAR_FORMAT,
    compression: 'gzip',
    content_type: 'application/x-ndjson',
    schema_version: SIDECAR_SCHEMA_VERSION,
    stream: SIDECAR_STREAM,
  };
}

export async function writeSidecarObject({
  stores = { raw: null, cfg: {} },
  manifests = null,
  rest = null,
  userId,
  deviceId,
  sidecars = [],
  startAt,
  endAt,
  objectId = null,
  firmware = null,
  timeZone = 'UTC',
} = {}) {
  const clean = (sidecars || []).filter((s) => s && s.frame_hash && s.decoder_version);
  if (!clean.length) return { ok: false, error: 'no_sidecars' };
  const encoded = encodeSidecarArchive(clean);
  if (!encoded.sample_count) return { ok: false, error: 'empty_sidecar_archive' };
  const firstHash = clean[0].frame_hash;
  const dv = clean[0].decoder_version;
  const objId = objectId && isUuid(objectId)
    ? objectId
    : uuidFromParts([firstHash, dv, 'sidecar']);
  const device = isUuid(deviceId)
    ? deviceId
    : uuidFromParts([userId || 'local', 'whoop', String(deviceId || 'strap')]);
  const cfg = stores.cfg || {};
  const start = startAt || clean[0]?.created_at || new Date().toISOString();
  const end = endAt || start;
  const day = physiologicalDay({ nowIso: end, timeZone });
  const key = rawObjectKeyV3({ userId, deviceId: device, stream: SIDECAR_STREAM, startAt: start, objectId: objId });
  const row = {
    id: objId,
    user_id: userId,
    device_id: device,
    object_class: 'derived',
    object_kind: SIDECAR_STREAM,
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
    schema_version: SIDECAR_SCHEMA_VERSION,
    sha256: encoded.sha256,
    retention_class: 'core', // sidecars are cheap and historically useful
    expires_at: expiresAt(SIDECAR_STREAM, new Date(), cfg),
    status: 'pending',
  };
  if (firmware) row.firmware = firmware;
  const manifestStore = manifests || (rest ? createManifestStore({ rest }) : null);
  if (manifestStore) await manifestStore.insertPending(row).catch(() => {});
  let uploaded = false;
  if (stores.raw) {
    const put = await stores.raw.putObject(key, encoded.body, { contentType: encoded.content_type });
    uploaded = Boolean(put?.etag);
  }
  if (manifestStore) {
    const out = await completeUpload({
      manifests: manifestStore,
      objectStore: stores.raw,
      objectId: objId,
      expectedBytes: encoded.compressed_bytes,
      expectedSha256: encoded.sha256,
    }).catch((err) => ({ ok: false, error: String(err.message || err) }));
    return { ok: uploaded && out.ok !== false, objectId: objId, objectKey: key, status: out.status || 'pending', error: out.error };
  }
  return { ok: uploaded, objectId: objId, objectKey: key, status: uploaded ? 'ready' : 'pending' };
}

export async function persistSidecarsFromFrames(frames, opts = {}) {
  if (!frames?.length) return { ok: false, error: 'no_frames' };
  const decoder = opts.decoder || FRAME_DECODER_VERSION;
  let replayed;
  try {
    replayed = replayNotifies(frames, { decoder });
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 120) };
  }
  const sidecars = (replayed.levelB || []).map((row) => (
    sidecarFromLevelB(row, row.decoder_version || decoder)
  ));
  return writeSidecarObject({ ...opts, sidecars });
}
