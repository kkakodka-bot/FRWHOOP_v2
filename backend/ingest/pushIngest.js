import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  OBJECT_LANE_STREAMS,
  rawObjectKeyV3,
  noopDeviceId,
  isUuid,
} from '../storage/keys.js';
import {
  ALL_STREAMS,
  APPEND_STREAM_PROJECTIONS,
  REPLACE_STREAM_PROJECTIONS,
  INGEST_ENABLED_STREAMS,
  PushProtocolError,
  ackMatchesBatch,
  buildAck,
  parseNdjsonEntity,
  archiveWindowFromRecords,
  replacementKeys,
  windowBounds,
} from './pushRegistry.js';
import { createPushIngestQuota } from './pushIngestQuota.js';
import { createPushReplacementStaging } from './pushReplacementStaging.js';
import { deleteReplacementRows } from './pushDelete.js';

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function applyReplacement({
  header,
  records,
  userId,
  deviceId,
  upsertRows,
  deleteRows,
}) {
  const projection = REPLACE_STREAM_PROJECTIONS[header.stream];
  if (!projection || typeof upsertRows !== 'function') return;

  const replacementId = header.window?.replacementId || header.batchId;
  const rows = records
    .map((record) => projection.mapRow({
      userId,
      deviceId,
      headerDeviceId: header.deviceId,
      sourceId: header.sourceId,
      batchId: header.batchId,
      replacementId,
      record,
      protocolVersion: header.protocolVersion,
    }))
    .filter(Boolean);

  if (rows.length) {
    await upsertRows(projection.table, rows, { onConflict: projection.onConflict });
  }

  if (typeof deleteRows !== 'function') return;
  const keys = replacementKeys(header.stream, records, header.deviceId);
  const bounds = windowBounds(header);
  if (!bounds) return;

  if (projection.windowSelector === 'day') {
    await deleteRows(projection.table, {
      userId,
      deviceId,
      dayGte: bounds.startInclusive,
      dayLt: bounds.endExclusive,
      keepKeys: keys,
      stream: header.stream,
    });
    return;
  }

  if (projection.windowSelector === 'startTs') {
    await deleteRows(projection.table, {
      userId,
      deviceId,
      startTsGte: Number(bounds.startInclusive),
      startTsLt: Number(bounds.endExclusive),
      keepKeys: keys,
      stream: header.stream,
      kind: header.stream === 'sleepSession' ? 'sleep' : 'workout',
    });
  }
}

/**
 * Accept one NOOP push NDJSON batch: WAL commit → B2 archive → Supabase upsert → ack.
 * Scoring and frame decode are intentionally absent.
 */
export function createPushIngest({
  walFactory,
  walStore,
  archiveObject,
  upsertRows,
  deleteRows,
  ensureDevice,
  replacementStaging,
  quotaConfig,
  now = () => new Date(),
} = {}) {
  if (!walFactory) throw new Error('walFactory required');
  const quota = createPushIngestQuota({ store: walStore, config: quotaConfig });
  const staging = replacementStaging || createPushReplacementStaging();

  return {
    async acceptBatch({ userId, decodedBody }) {
      const bodySha256 = sha256Hex(decodedBody);
      const { header, records } = parseNdjsonEntity(decodedBody);
      const wal = walFactory(userId);

      if (!ALL_STREAMS.has(header.stream)) {
        throw new PushProtocolError('unsupported_stream', 422);
      }
      if (!INGEST_ENABLED_STREAMS.has(header.stream)) {
        throw new PushProtocolError('stream_not_enabled', 422);
      }
      // An object-lane stream IS enabled, just not here. Without this the request would fall through
      // to the delivery switch below and be refused as `unsupported_delivery`, which names the wrong
      // cause and sends whoever reads it looking for a malformed header.
      if (OBJECT_LANE_STREAMS.has(header.stream)) {
        throw new PushProtocolError('use_object_lane', 422);
      }

      const prior = await wal.getAck(header.batchId);
      if (prior?.bodySha256 === bodySha256 && prior?.ack) {
        return prior.ack;
      }
      if (prior && prior.bodySha256 !== bodySha256) {
        throw new PushProtocolError('batch_id_conflict', 409);
      }

      await quota.reserve(userId, decodedBody.length);

      await wal.appendWal({
        batchId: header.batchId,
        stream: header.stream,
        deviceId: header.deviceId,
        sourceId: header.sourceId,
        recordCount: header.recordCount,
        bodySha256,
        receivedAt: now().toISOString(),
      });

      const deviceId = noopDeviceId(userId, header.deviceId);
      if (typeof ensureDevice === 'function') {
        await ensureDevice({
          id: deviceId,
          user_id: userId,
          source_kind: 'noop_push',
          external_device_id: String(header.deviceId || ''),
          last_seen_at: now().toISOString(),
        });
      }

      const objectId = header.batchId && isUuid(header.batchId) ? header.batchId : randomUUID();
      const archiveRecords = header.delivery === 'replace_window' ? records : records;
      const { startAt, endAt } = archiveWindowFromRecords(header.stream, archiveRecords, now(), header);
      const archiveBytes = gzipSync(decodedBody);
      const archiveSha256 = sha256Hex(archiveBytes);
      const key = rawObjectKeyV3({
        userId,
        deviceId,
        stream: header.stream,
        startAt,
        objectId,
      });

      const manifest = await archiveObject({
        userId,
        deviceId,
        stream: header.stream,
        objectId,
        key,
        body: archiveBytes,
        contentType: 'application/x-ndjson',
        format: 'ndjson_gzip_noop_push_v1',
        compression: 'gzip',
        schemaVersion: 1,
        sha256: archiveSha256,
        sampleCount: header.recordCount,
        startAt,
        endAt,
        periodDay: startAt.slice(0, 10),
      });

      if (header.delivery === 'append') {
        const projection = APPEND_STREAM_PROJECTIONS[header.stream];
        if (projection && typeof upsertRows === 'function') {
          const rows = records
            .map((record) => projection.mapRow({
              userId,
              deviceId,
              sourceId: header.sourceId,
              batchId: header.batchId,
              record,
            }))
            .filter(Boolean);
          if (rows.length) {
            await upsertRows(projection.table, rows, { onConflict: projection.onConflict });
          }
        }
      } else if (header.delivery === 'replace_window') {
        if (!REPLACE_STREAM_PROJECTIONS[header.stream]) {
          throw new PushProtocolError('unsupported_delivery', 422);
        }
        const staged = staging.stagePart({ userId, header, records, bodySha256 });
        if (staged.isCompletingPart) {
          await applyReplacement({
            header,
            records: staged.records,
            userId,
            deviceId,
            upsertRows,
            deleteRows,
          });
          staging.clearGeneration({ userId, header });
        }
      } else {
        throw new PushProtocolError('unsupported_delivery', 422);
      }

      if (!manifest?.ready) {
        throw new PushProtocolError('archive_not_ready', 503);
      }

      const ack = buildAck(header);
      if (!ackMatchesBatch(ack, header)) {
        throw new PushProtocolError('ack_internal_mismatch', 500);
      }
      await wal.saveAck(header.batchId, ack, bodySha256);
      await wal.trimWal(header.batchId);
      return ack;
    },
  };
}
