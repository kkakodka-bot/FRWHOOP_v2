import { inc } from '../observability/metrics.js';
import { READY_STATUSES } from './manifests.js';

const STALE_PENDING_MS = 60 * 60 * 1000;

/**
 * Reconcile B2 objects with object_manifests.
 * Handles: pending without object, ready without object, object without
 * manifest, checksum/size mismatch, stale uploads.
 */
export async function reconcileObjects({
  rest,
  objectStore,
  now = () => new Date(),
  userId,
  verifyChecksums = false,
  listPrefix = (p) => objectStore.listPrefix(p),
} = {}) {
  const report = {
    pending_missing_object: 0,
    ready_missing_object: 0,
    orphan_objects: 0,
    checksum_mismatch: 0,
    size_mismatch: 0,
    stale_pending: 0,
    marked_failed: 0,
    marked_ready: 0,
    listed_objects: 0,
    index_missing_objects: 0,
  };

  const query = userId
    ? `user_id=eq.${userId}&select=*`
    : 'select=*&limit=5000';
  const manifests = await rest.select('object_manifests', query);
  const byKey = new Map(manifests.map((m) => [m.object_key, m]));

  const staleBefore = new Date(now().getTime() - STALE_PENDING_MS).toISOString();

  for (const row of manifests) {
    if (row.status === 'deleted' || row.status === 'deleting') continue;
    let head = null;
    try {
      head = await objectStore.head(row.object_key);
    } catch {
      head = null;
    }
    const exists = Boolean(head?.exists);

    if (['pending', 'uploading', 'uploaded'].includes(row.status)) {
      if (row.created_at && row.created_at < staleBefore && !exists) {
        report.stale_pending += 1;
        report.pending_missing_object += 1;
        await rest.request(`object_manifests?id=eq.${row.id}`, {
          method: 'PATCH',
          body: { status: 'failed' },
        });
        report.marked_failed += 1;
        continue;
      }
      if (!exists) {
        report.pending_missing_object += 1;
        continue;
      }
      if (row.compressed_bytes != null && head.contentLength != null
          && Number(head.contentLength) !== Number(row.compressed_bytes)) {
        report.size_mismatch += 1;
        await rest.request(`object_manifests?id=eq.${row.id}`, {
          method: 'PATCH',
          body: { status: 'failed' },
        });
        report.marked_failed += 1;
        continue;
      }
      // Before stamping 'ready', re-read the bytes and require the recorded
      // sha256 to match (HEAD+size alone accepts a same-length corrupt write;
      // the checksum_mismatch counter was previously dead).
      if (verifyChecksums && row.sha256 && objectStore.getObject) {
        let actual = null;
        try {
          const obj = await objectStore.getObject(row.object_key);
          if (obj?.body) {
            const { sha256Hex } = await import('../ingest/archiveFormat.js');
            actual = sha256Hex(Buffer.from(obj.body));
          }
        } catch { actual = null; }
        if (actual != null && actual !== row.sha256) {
          report.checksum_mismatch += 1;
          await rest.request(`object_manifests?id=eq.${row.id}`, {
            method: 'PATCH',
            body: { status: 'corrupt', verified_at: now().toISOString() },
          });
          report.marked_failed += 1;
          continue;
        }
      }
      await rest.request(`object_manifests?id=eq.${row.id}`, {
        method: 'PATCH',
        body: {
          status: 'ready',
          verified_at: now().toISOString(),
          uploaded_at: now().toISOString(),
          etag: head.etag || row.etag,
        },
      });
      report.marked_ready += 1;
      continue;
    }

    if (READY_STATUSES.has(row.status) && !exists) {
      report.ready_missing_object += 1;
      await rest.request(`object_manifests?id=eq.${row.id}`, {
        method: 'PATCH',
        body: { status: 'corrupt' },
      });
      report.marked_failed += 1;
    }
  }

  if (typeof listPrefix === 'function') {
    const prefixes = userId
      ? [
        `v3/core/users/${userId}/`,
        `v3/imu/users/${userId}/`,
        `v2/users/${userId}/`,
        `v1/users/${userId}/`,
      ]
      : ['v3/core/', 'v3/imu/', 'v2/', 'v1/'];
    const seen = new Set();
    for (const prefix of prefixes) {
      let keys = [];
      try { keys = await listPrefix(prefix); } catch { keys = []; }
      for (const key of keys) {
        if (!key || seen.has(key)) continue;
        seen.add(key);
        report.listed_objects += 1;
        if (!byKey.has(key)) report.orphan_objects += 1;
      }
    }
    for (const row of manifests) {
      if (!READY_STATUSES.has(row.status) || !row.object_key) continue;
      if (row.object_key.startsWith('v3/') || row.object_key.startsWith('v2/') || row.object_key.startsWith('v1/')) {
        if (!seen.has(row.object_key)) report.index_missing_objects += 1;
      }
    }
  }

  inc('reconciliation_runs');
  if (report.orphan_objects || report.ready_missing_object || report.pending_missing_object) {
    inc('reconciliation_findings', report.orphan_objects + report.ready_missing_object + report.pending_missing_object);
  }
  return report;
}
