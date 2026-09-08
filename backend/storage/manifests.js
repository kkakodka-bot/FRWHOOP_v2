import { expiresAt } from './retention.js';
import { inc } from '../observability/metrics.js';

export const READY_STATUSES = new Set(['verified', 'ready']);

export function createManifestStore({ rest, now = () => new Date() } = {}) {
  async function insertPending(row) {
    const body = {
      ...row,
      status: row.status || 'pending',
      created_at: now().toISOString(),
    };
    const saved = await rest.upsert('object_manifests', body, { onConflict: 'id' });
    return Array.isArray(saved) ? saved[0] : saved;
  }

  async function mark(id, patch) {
    return rest.request(`object_manifests?id=eq.${id}`, {
      method: 'PATCH',
      body: { ...patch, updated_at: now().toISOString() },
      prefer: 'return=representation',
    });
  }

  async function get(id) {
    const rows = await rest.select('object_manifests', `id=eq.${id}&select=*`);
    return rows[0] || null;
  }

  async function byKey(objectKey) {
    const rows = await rest.select(
      'object_manifests',
      `object_key=eq.${encodeURIComponent(objectKey)}&select=*`,
    );
    return rows[0] || null;
  }

  async function listByUser(userId, extra = '') {
    const q = [`user_id=eq.${userId}`, 'select=*', extra].filter(Boolean).join('&');
    return rest.select('object_manifests', q);
  }

  async function listPendingStale(beforeIso) {
    return rest.select(
      'object_manifests',
      `status=in.(pending,uploading,uploaded)&created_at=lt.${beforeIso}&select=*`,
    );
  }

  async function listReady(userId) {
    return rest.select(
      'object_manifests',
      `user_id=eq.${userId}&status=in.(ready,verified)&select=*`,
    );
  }

  return { insertPending, mark, get, byKey, listByUser, listPendingStale, listReady, expiresAt };
}

/**
 * pending → uploading → uploaded → verified/ready.
 * Idempotent: a second complete with the same id does not duplicate.
 */
export async function completeUpload({
  manifests,
  objectStore,
  objectId,
  expectedBytes,
  expectedSha256,
  now = () => new Date(),
} = {}) {
  const row = await manifests.get(objectId);
  if (!row) return { ok: false, error: 'missing_manifest' };
  if (READY_STATUSES.has(row.status)) return { ok: true, row, duplicate: true };
  await manifests.mark(objectId, { status: 'uploading' });
  const head = await objectStore.head(row.object_key);
  if (!head?.exists) {
    inc('object_verification_failures');
    await manifests.mark(objectId, { status: 'failed' });
    return { ok: false, error: 'object_missing', row };
  }
  const bytes = head.contentLength;
  const wantBytes = expectedBytes ?? row.compressed_bytes;
  if (wantBytes != null && bytes != null && Number(bytes) !== Number(wantBytes)) {
    inc('object_verification_failures');
    await manifests.mark(objectId, { status: 'failed' });
    return { ok: false, error: 'size_mismatch', row };
  }
  let etag = head.etag || null;
  let sha = expectedSha256 || row.sha256 || null;
  if (!sha) {
    const obj = await objectStore.getObject(row.object_key);
    if (!obj?.body) {
      inc('object_verification_failures');
      await manifests.mark(objectId, { status: 'corrupt' });
      return { ok: false, error: 'object_missing', row };
    }
    const { sha256Hex } = await import('../ingest/archiveFormat.js');
    sha = sha256Hex(obj.body);
    if (expectedBytes != null && obj.body.length !== Number(expectedBytes)) {
      inc('object_verification_failures');
      await manifests.mark(objectId, { status: 'failed' });
      return { ok: false, error: 'size_mismatch', row };
    }
  }
  const verifiedAt = now().toISOString();
  const updated = await manifests.mark(objectId, {
    status: 'ready',
    sha256: sha,
    etag,
    compressed_bytes: bytes ?? wantBytes,
    uploaded_at: verifiedAt,
    verified_at: verifiedAt,
  });
  const next = Array.isArray(updated) ? updated[0] : updated;
  return { ok: true, row: next, duplicate: false };
}
