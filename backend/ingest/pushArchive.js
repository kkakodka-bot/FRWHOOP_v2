import { getStores } from '../storage/stores.js';
import { createManifestStore, completeUpload } from '../storage/manifests.js';
import { pushArchiveSpecForStream } from '../storage/keys.js';
import { expiresAt } from '../storage/retention.js';
import { inc } from '../observability/metrics.js';
import { sha256Hex } from '../ingest/archiveFormat.js';

export function createPushArchive({ cfg, rest, stores: fixedStores }) {
  const manifests = rest?.configured ? createManifestStore({ rest }) : null;

  return {
    configured: Boolean(manifests && cfg.b2KeyId && cfg.b2ApplicationKey),
    async archiveObject(args) {
      const { raw } = fixedStores || await getStores(cfg);
      if (!raw || !manifests) {
        return { ready: false, reason: 'archive_not_configured' };
      }
      const {
        userId, deviceId, stream, objectId, key, body,
        schemaVersion, sha256, sampleCount, startAt, endAt, periodDay,
      } = args;
      const spec = pushArchiveSpecForStream(stream);
      const row = {
        id: objectId,
        user_id: userId,
        device_id: deviceId,
        object_class: 'raw',
        object_kind: stream,
        provider: cfg.rawStore,
        bucket: cfg.b2Bucket,
        object_key: key,
        start_at: startAt,
        end_at: endAt,
        period_day: periodDay,
        sample_count: sampleCount,
        compressed_bytes: body.length,
        content_type: spec.contentType,
        format: spec.format,
        compression: spec.compression,
        schema_version: schemaVersion,
        sha256,
        retention_class: spec.retentionClass,
        expires_at: expiresAt(stream, new Date(), cfg),
        status: 'pending',
      };
      await manifests.insertPending(row);
      const put = await raw.putObject(key, body, { contentType: spec.contentType });
      inc('b2_objects_created');
      const digest = sha256 || sha256Hex(Buffer.from(body));
      const done = await completeUpload({
        manifests,
        objectStore: raw,
        objectId,
        expectedBytes: body.length,
        expectedSha256: digest,
      });
      if (!done.ok) {
        throw new Error(done.error || 'archive_verify_failed');
      }
      return { ready: true, objectKey: key, manifest: done.row, etag: put?.etag || null };
    },
  };
}
