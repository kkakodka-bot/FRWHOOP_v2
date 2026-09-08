// Port of backend/ingest/pushObjects.js — the direct-to-bucket lane: intent, completion, and the
// coverage index. `verifyObjectDigest` deliberately stays in the Node backend (out-of-band job);
// it is the only piece that needs zstd decompression, which keeps it out of the edge runtime.
import {
  OBJECT_LANE_RECORD_HZ,
  OBJECT_LANE_STREAMS,
  looksLikePii,
  isUuid,
  noopDeviceId,
  pushArchiveSpecForStream,
  rawObjectKeyV3,
} from './keys.ts';
import { MAX_OBJECT_LANE_BYTES, MAX_RANGE_MS, expiresAt } from './retention.ts';
import { createManifestStore, READY_STATUSES, type ManifestStore } from './manifests.ts';
import { PushProtocolError } from './registry.ts';
import type { SupabaseRest } from './rest.ts';
import type { S3Store } from './s3.ts';
import type { PushFunctionConfig } from './config.ts';

/** Presigned PUT lifetime. Long enough for a large object on a slow link, short enough to expire. */
export const UPLOAD_URL_TTL_SEC = 15 * 60;

const SHA_RE = /^[0-9a-f]{64}$/i;
const MIN_PLAUSIBLE_UNIX = 1_400_000_000;

/**
 * The digest a manifest carries is whatever the device claimed at intent time. This lane never
 * routes the bytes through this server, so at completion we can only attest the byte COUNT, which
 * came from HEAD. `verifyObjectDigest` is what earns `verified` by reading the object back and
 * hashing it. Keeping the two apart stops a `ready` row from implying a check nobody ran.
 */
export const SHA_SOURCE = Object.freeze({ claimed: 'client_claimed', verified: 'server_verified' });

function fail(code: string, status = 400): PushProtocolError {
  return new PushProtocolError(code, status);
}

/**
 * Validates the `binaryObject` manifest the device already builds for the inline lane, plus the
 * `compressedBytes` the direct lane needs. Committing the byte count BEFORE the upload is what makes
 * the completion check meaningful — a count supplied afterwards would just describe whatever landed.
 */
export function validateObjectIntent(manifest: any) {
  const errors: string[] = [];
  const m = manifest || {};
  if (m.type !== 'binaryObject') errors.push('type');
  if (!OBJECT_LANE_STREAMS.has(m.stream)) errors.push('stream');
  if (!isUuid(m.objectId)) errors.push('objectId');
  if (!isUuid(m.batchId)) errors.push('batchId');
  if (!isUuid(m.sourceId)) errors.push('sourceId');
  if (typeof m.deviceId !== 'string' || !m.deviceId || looksLikePii(m.deviceId)) errors.push('deviceId');

  const startTs = Number(m.startTs);
  const endTs = Number(m.endTs);
  if (!Number.isInteger(startTs) || startTs < MIN_PLAUSIBLE_UNIX) errors.push('startTs');
  if (!Number.isInteger(endTs) || endTs <= startTs) errors.push('endTs');
  if (Number.isInteger(startTs) && Number.isInteger(endTs) && (endTs - startTs) * 1000 > MAX_RANGE_MS) {
    errors.push('window');
  }

  const sampleCount = Number(m.sampleCount);
  if (!Number.isInteger(sampleCount) || sampleCount < 0) errors.push('sampleCount');
  const uncompressedBytes = Number(m.uncompressedBytes);
  if (!Number.isInteger(uncompressedBytes) || uncompressedBytes <= 0) errors.push('uncompressedBytes');
  const compressedBytes = Number(m.compressedBytes);
  if (!Number.isInteger(compressedBytes) || compressedBytes <= 0 || compressedBytes > MAX_OBJECT_LANE_BYTES) {
    errors.push('compressedBytes');
  }
  if (!SHA_RE.test(String(m.contentSha256 || ''))) errors.push('contentSha256');

  // The wire encoding is a property of the stream, not a client choice: the reader picks its
  // decompressor from the stream registry, so an object encoded some other way is unreadable.
  if (OBJECT_LANE_STREAMS.has(m.stream)) {
    const spec = pushArchiveSpecForStream(m.stream);
    if (m.contentEncoding !== spec.compression) errors.push('contentEncoding');
  }
  // Paths are minted here. A client-chosen key is how one subject writes into another's prefix.
  if (m.objectKey || m.object_key) errors.push('objectKey');

  return {
    ok: errors.length === 0,
    errors,
    startTs,
    endTs,
    sampleCount,
    uncompressedBytes,
    compressedBytes,
  };
}

/**
 * Coverage for one object, from the stream's nominal record rate. Reported as expected/received
 * counts rather than a filled series: a gap in a seizure corpus must stay legible as absence, and
 * an interpolated stretch looks exactly like quiet data. `null` when the stream has no fixed rate.
 */
export function windowCoverage({ stream, startTs, endTs, sampleCount }: {
  stream: string;
  startTs: number;
  endTs: number;
  sampleCount: number;
}) {
  const hz = OBJECT_LANE_RECORD_HZ[stream];
  const seconds = Math.max(0, Number(endTs) - Number(startTs));
  if (hz == null || !seconds) {
    return { expectedRecords: null, receivedRecords: sampleCount, coverage: null, missingRecords: null };
  }
  const expectedRecords = Math.round(seconds * hz);
  const missingRecords = Math.max(0, expectedRecords - sampleCount);
  return {
    expectedRecords,
    receivedRecords: sampleCount,
    coverage: expectedRecords ? Math.min(1, sampleCount / expectedRecords) : null,
    missingRecords,
  };
}

/**
 * Direct-to-bucket lane for the high-rate raw streams.
 *
 * `createIntent` mints a manifest row plus a presigned PUT; the device writes the bytes straight to
 * the bucket; `completeObject` verifies the byte count and releases the device's local rows. The
 * payload never transits this process, which is the point — it is a URL broker and a ledger.
 */
export function createPushObjects({
  cfg,
  rest,
  raw,
  upsertRows,
  ensureDevice,
  now = () => new Date(),
  urlTtlSec = UPLOAD_URL_TTL_SEC,
}: {
  cfg: PushFunctionConfig;
  rest: SupabaseRest;
  raw: S3Store | null;
  upsertRows?: (table: string, rows: unknown[], opts: { onConflict: string }) => Promise<unknown>;
  ensureDevice?: (row: Record<string, unknown>) => Promise<unknown>;
  now?: () => Date;
  urlTtlSec?: number;
}) {
  const manifests: ManifestStore | null = rest?.configured ? createManifestStore({ rest, now }) : null;

  async function writeSignalWindow({ userId, deviceId, row, stream, startTs, endTs, sampleCount }: {
    userId: string;
    deviceId: string;
    row: any;
    stream: string;
    startTs: number;
    endTs: number;
    sampleCount: number;
  }) {
    if (typeof upsertRows !== 'function') return null;
    const cover = windowCoverage({ stream, startTs, endTs, sampleCount });
    const hourStart = Math.floor(startTs / 3600) * 3600;
    const window = {
      user_id: userId,
      device_id: deviceId,
      stream,
      hour_start: hourStart,
      start_ts: startTs,
      end_ts: endTs,
      object_id: row.id,
      object_key: row.object_key,
      expected_records: cover.expectedRecords,
      received_records: cover.receivedRecords,
      missing_records: cover.missingRecords,
      coverage: cover.coverage,
      interpolated_records: 0,
      compressed_bytes: row.compressed_bytes ?? null,
      uncompressed_bytes: row.uncompressed_bytes ?? null,
      updated_at: now().toISOString(),
    };
    await upsertRows('noop_signal_windows', [window], {
      onConflict: 'user_id,device_id,stream,hour_start,object_id',
    });
    return window;
  }

  return {
    get configured() {
      return Boolean(manifests && cfg?.b2KeyId && cfg?.b2ApplicationKey && cfg?.b2Bucket && raw);
    },

    async createIntent({ userId, manifest }: { userId: string; manifest: any }) {
      if (!isUuid(userId)) throw fail('unauthorized', 401);
      if (!manifests) throw fail('archive_not_configured', 503);
      if (!raw) throw fail('archive_not_configured', 503);

      const v = validateObjectIntent(manifest);
      if (!v.ok) {
        const err = fail('invalid_object_manifest', 400);
        err.fields = v.errors;
        throw err;
      }

      const deviceId = noopDeviceId(userId, manifest.deviceId);
      const startAt = new Date(v.startTs * 1000);
      const endAt = new Date(v.endTs * 1000);
      const key = rawObjectKeyV3({
        userId,
        deviceId,
        stream: manifest.stream,
        startAt,
        objectId: manifest.objectId,
      });

      const prior = await manifests.get(manifest.objectId);
      if (prior) {
        if (prior.user_id !== userId) throw fail('forbidden', 403);
        // A retry must reuse the same bytes. A different digest under a committed objectId is a
        // distinct object wearing a used id, and silently re-signing would overwrite the original.
        if (prior.sha256 && prior.sha256 !== manifest.contentSha256) {
          throw fail('object_id_conflict', 409);
        }
        if (READY_STATUSES.has(prior.status)) {
          return {
            objectId: prior.id,
            status: prior.status,
            objectKey: prior.object_key,
            duplicate: true,
          };
        }
        const resumed = raw.presignPut(prior.object_key, urlTtlSec, now());
        return {
          objectId: prior.id,
          status: prior.status,
          objectKey: prior.object_key,
          uploadUrl: resumed.url,
          requiredHeaders: { 'content-type': prior.content_type || 'application/octet-stream' },
          expiresAt: resumed.expiresAt,
          duplicate: false,
        };
      }

      if (typeof ensureDevice === 'function') {
        await ensureDevice({
          id: deviceId,
          user_id: userId,
          source_kind: 'noop_push',
          external_device_id: String(manifest.deviceId || ''),
          last_seen_at: now().toISOString(),
        });
      }

      const spec = pushArchiveSpecForStream(manifest.stream);
      await manifests.insertPending({
        id: manifest.objectId,
        user_id: userId,
        device_id: deviceId,
        object_class: 'raw',
        object_kind: manifest.stream,
        provider: cfg?.rawStore || 'b2',
        bucket: cfg?.b2Bucket || null,
        object_key: key,
        start_at: startAt.toISOString(),
        end_at: endAt.toISOString(),
        period_day: startAt.toISOString().slice(0, 10),
        sample_count: v.sampleCount,
        compressed_bytes: v.compressedBytes,
        uncompressed_bytes: v.uncompressedBytes,
        content_type: spec.contentType,
        format: spec.format,
        compression: spec.compression,
        schema_version: Number(manifest.schemaVersion ?? 1),
        sha256: manifest.contentSha256,
        sha256_source: SHA_SOURCE.claimed,
        retention_class: spec.retentionClass,
        expires_at: expiresAt(manifest.stream, now(), cfg as unknown as Record<string, unknown>),
        batch_id: manifest.batchId,
        source_id: manifest.sourceId,
        status: 'pending',
      });

      const signed = raw.presignPut(key, urlTtlSec, now());
      return {
        objectId: manifest.objectId,
        status: 'pending',
        objectKey: key,
        uploadUrl: signed.url,
        requiredHeaders: { 'content-type': spec.contentType },
        expiresAt: signed.expiresAt,
        duplicate: false,
      };
    },

    /**
     * Releases the device's local rows. Verifies the byte count against the value committed at
     * intent; the digest is recorded as claimed and upgraded by `verifyObjectDigest`.
     */
    async completeObject({ userId, objectId }: { userId: string; objectId: string }) {
      if (!isUuid(userId)) throw fail('unauthorized', 401);
      if (!isUuid(objectId)) throw fail('invalid_object_id', 400);
      if (!manifests) throw fail('archive_not_configured', 503);
      if (!raw) throw fail('archive_not_configured', 503);

      const row = await manifests.get(objectId);
      if (!row) throw fail('missing_manifest', 404);
      if (row.user_id !== userId) throw fail('forbidden', 403);
      if (READY_STATUSES.has(row.status)) {
        return { objectId: row.id, status: row.status, objectKey: row.object_key, duplicate: true };
      }

      await manifests.mark(objectId, { status: 'uploading' });
      const head = await raw.head(row.object_key);
      if (!head?.exists) {
        await manifests.mark(objectId, { status: 'failed' });
        throw fail('object_missing', 409);
      }
      if (row.compressed_bytes != null && head.contentLength != null
          && Number(head.contentLength) !== Number(row.compressed_bytes)) {
        await manifests.mark(objectId, { status: 'failed' });
        throw fail('size_mismatch', 409);
      }

      const at = now().toISOString();
      const updated = await manifests.mark(objectId, {
        status: 'ready',
        compressed_bytes: head.contentLength ?? row.compressed_bytes,
        uploaded_at: at,
      });
      const next = (Array.isArray(updated) ? updated[0] : updated) || row;

      const window = await writeSignalWindow({
        userId,
        deviceId: row.device_id,
        row: next,
        stream: row.object_kind,
        startTs: Math.floor(Date.parse(row.start_at) / 1000),
        endTs: Math.floor(Date.parse(row.end_at) / 1000),
        sampleCount: Number(row.sample_count ?? 0),
      });

      return { objectId: next.id, status: 'ready', objectKey: next.object_key, window, duplicate: false };
    },
  };
}

export type PushObjects = ReturnType<typeof createPushObjects>;
