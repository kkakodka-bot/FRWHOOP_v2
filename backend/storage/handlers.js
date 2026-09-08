import { randomUUID } from 'node:crypto';
import { OBJECT_KINDS, MAX_COMPRESSED_BYTES, MAX_RANGE_MS, retentionFor, expiresAt } from './retention.js';
import { isUuid, objectKey, userPrefix, looksLikePii } from './keys.js';

const SHA_RE = /^[0-9a-f]{64}$/i;

function bearer(headers) {
  const raw = headers.authorization || headers.Authorization || '';
  const m = /^Bearer\s+(\S+)/i.exec(raw);
  return m ? m[1] : '';
}

function json(status, body) {
  return { status, body };
}

function parseTime(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function validateUploadIntent(body) {
  const errors = [];
  if (!isUuid(body?.device_id)) errors.push('device_id');
  if (!OBJECT_KINDS.includes(body?.object_kind)) errors.push('object_kind');
  const start = parseTime(body?.start_at);
  const end = parseTime(body?.end_at);
  if (!start) errors.push('start_at');
  if (!end) errors.push('end_at');
  if (start && end && end < start) errors.push('time_range');
  if (start && end && end - start > MAX_RANGE_MS) errors.push('time_range');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body?.period_day || ''))) errors.push('period_day');
  const bytes = Number(body?.compressed_bytes);
  const max = MAX_COMPRESSED_BYTES[body?.object_kind];
  if (!Number.isFinite(bytes) || bytes < 0 || (max != null && bytes > max)) errors.push('compressed_bytes');
  if (body?.sha256 && !SHA_RE.test(body.sha256)) errors.push('sha256');
  const schemaVersion = Number(body?.schema_version ?? 1);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) errors.push('schema_version');
  if (looksLikePii(body?.device_id) || looksLikePii(body?.object_key)) errors.push('pii');
  if (body?.object_key) errors.push('object_key'); // client must not choose paths
  return { ok: errors.length === 0, errors, start, end, bytes, schemaVersion };
}

export function mergeSession(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  if (local.user_modified) {
    return {
      ...remote,
      ...local,
      start_at: local.start_at,
      end_at: local.end_at,
      user_modified: true,
      summary: local.summary ?? remote.summary,
    };
  }
  if (remote.user_modified) {
    return {
      ...local,
      start_at: remote.start_at,
      end_at: remote.end_at,
      user_modified: true,
      summary: local.summary ?? remote.summary,
    };
  }
  return local;
}

export function shouldApplyDaily(local, remote) {
  if (!remote) return true;
  const a = Date.parse(local.computed_at);
  const b = Date.parse(remote.computed_at);
  if (!Number.isFinite(a)) return false;
  if (!Number.isFinite(b)) return true;
  return a >= b;
}

export function createHandlers({ db, s3, rateLimit, now = () => new Date(), uuid = randomUUID }) {
  async function requireUser(headers) {
    const token = bearer(headers);
    if (!token) return { error: json(401, { error: 'unauthorized' }) };
    const user = await db.getUser(token);
    if (!user?.id) return { error: json(401, { error: 'unauthorized' }) };
    return { user, token };
  }

  return {
    async uploadIntent({ headers, body }) {
      const auth = await requireUser(headers);
      if (auth.error) return auth.error;
      if (!rateLimit.allow(`upload:${auth.user.id}`)) return json(429, { error: 'rate_limited' });
      const v = validateUploadIntent(body);
      if (!v.ok) return json(400, { error: 'invalid_request', fields: v.errors });
      const device = await db.getDevice(auth.user.id, body.device_id);
      if (!device) return json(403, { error: 'forbidden' });

      const duplicate = await db.findDuplicateObject({
        userId: auth.user.id,
        deviceId: body.device_id,
        kind: body.object_kind,
        sha256: body.sha256,
        startAt: v.start.toISOString(),
        endAt: v.end.toISOString(),
      });
      if (duplicate?.status === 'ready') {
        return json(200, { object_id: duplicate.id, status: 'ready', duplicate: true });
      }
      if (duplicate?.status === 'pending') {
        const signed = s3.presignPut(duplicate.object_key, 15 * 60, now());
        return json(200, {
          object_id: duplicate.id,
          upload_url: signed.url,
          required_headers: { 'content-type': duplicate.content_type || 'application/octet-stream' },
          expires_at: signed.expiresAt,
          object_key: duplicate.object_key,
        });
      }

      const id = uuid();
      const key = objectKey({
        userId: auth.user.id,
        deviceId: body.device_id,
        kind: body.object_kind,
        day: body.period_day,
        objectId: id,
      });
      const ret = retentionFor(body.object_kind);
      const row = await db.insertSensorObject({
        id,
        user_id: auth.user.id,
        device_id: body.device_id,
        object_kind: body.object_kind,
        object_key: key,
        start_at: v.start.toISOString(),
        end_at: v.end.toISOString(),
        period_day: body.period_day,
        sample_count: body.sample_count == null ? null : Number(body.sample_count),
        compressed_bytes: v.bytes,
        content_type: 'application/octet-stream',
        format: body.format || 'protobuf_v1',
        compression: body.compression || 'zlib',
        sha256: body.sha256 || null,
        schema_version: v.schemaVersion,
        retention_class: ret.class,
        expires_at: expiresAt(body.object_kind, now()),
        status: 'pending',
      });
      const signed = s3.presignPut(key, 15 * 60, now());
      return json(200, {
        object_id: row.id,
        upload_url: signed.url,
        required_headers: { 'content-type': 'application/octet-stream' },
        expires_at: signed.expiresAt,
        object_key: key,
      });
    },

    async uploadComplete({ headers, body }) {
      const auth = await requireUser(headers);
      if (auth.error) return auth.error;
      if (!rateLimit.allow(`complete:${auth.user.id}`)) return json(429, { error: 'rate_limited' });
      if (!isUuid(body?.object_id)) return json(400, { error: 'invalid_request' });
      const row = await db.getSensorObject(body.object_id);
      if (!row || row.user_id !== auth.user.id) return json(403, { error: 'forbidden' });
      if (row.status === 'ready') return json(200, { object_id: row.id, status: 'ready' });
      const head = await s3.head(row.object_key);
      if (!head?.exists) return json(409, { error: 'object_missing' });
      if (row.compressed_bytes != null && head.contentLength != null
          && Number(head.contentLength) !== Number(row.compressed_bytes)) {
        await db.updateSensorObject(row.id, { status: 'failed' });
        return json(409, { error: 'size_mismatch' });
      }
      const updated = await db.updateSensorObject(row.id, { status: 'ready' });
      return json(200, { object_id: updated.id, status: 'ready' });
    },

    async downloadIntent({ headers, body }) {
      const auth = await requireUser(headers);
      if (auth.error) return auth.error;
      if (!rateLimit.allow(`download:${auth.user.id}`)) return json(429, { error: 'rate_limited' });
      if (!isUuid(body?.object_id)) return json(400, { error: 'invalid_request' });
      const row = await db.getSensorObject(body.object_id);
      if (!row || row.user_id !== auth.user.id) return json(403, { error: 'forbidden' });
      if (row.status !== 'ready') return json(409, { error: 'not_ready' });
      const signed = s3.presignGet(row.object_key, 5 * 60, now());
      return json(200, { download_url: signed.url, expires_at: signed.expiresAt });
    },

    async deleteAccount({ headers }) {
      const auth = await requireUser(headers);
      if (auth.error) return auth.error;
      await db.markPrivacyDeletionRequested(auth.user.id);
      const objects = await db.listSensorObjects(auth.user.id);
      const failures = [];
      for (const obj of objects) {
        try {
          await s3.deleteObject(obj.object_key);
          await db.updateSensorObject(obj.id, { status: 'deleting' });
        } catch {
          failures.push(obj.id);
        }
      }
      try {
        const leftover = await s3.listPrefix(userPrefix(auth.user.id));
        for (const key of leftover) {
          try { await s3.deleteObject(key); } catch { failures.push(key); }
        }
      } catch {
        // Listing is a safety net; manifest deletes above are the source of truth.
      }
      if (failures.length) return json(202, { status: 'retry', remaining: failures.length });
      await db.deleteAuthUser(auth.user.id);
      return json(200, { status: 'deleted' });
    },

    async exportAccount({ headers, body }) {
      const auth = await requireUser(headers);
      if (auth.error) return auth.error;
      if (!rateLimit.allow(`export:${auth.user.id}`)) return json(429, { error: 'rate_limited' });
      const bundle = await db.loadExportBundle(auth.user.id);
      const exportId = uuid();
      const day = now().toISOString().slice(0, 10);
      const key = objectKey({ userId: auth.user.id, kind: 'export', day, exportId });
      const payload = Buffer.from(JSON.stringify({
        exported_at: now().toISOString(),
        user_id: auth.user.id,
        include_archives: Boolean(body?.include_archives),
        profile: bundle.profiles?.[0] || null,
        devices: bundle.devices,
        daily_metrics: bundle.daily_metrics,
        sessions: bundle.sessions,
        events: bundle.events,
        provenance: (bundle.daily_metrics || []).map((r) => ({ day: r.day, provenance: r.provenance })),
        sensor_objects: bundle.sensor_objects,
      }));
      await db.insertSensorObject({
        id: exportId,
        user_id: auth.user.id,
        device_id: null,
        object_kind: 'export',
        object_key: key,
        start_at: now().toISOString(),
        end_at: now().toISOString(),
        period_day: day,
        sample_count: null,
        compressed_bytes: payload.length,
        content_type: 'application/json',
        format: 'export_v1',
        compression: 'none',
        sha256: null,
        schema_version: 1,
        retention_class: 'export',
        expires_at: expiresAt('export', now()),
        status: 'pending',
      });
      const put = s3.presignPut(key, 15 * 60, now());
      const get = s3.presignGet(key, 5 * 60, now());
      return json(200, {
        object_id: exportId,
        upload_url: put.url,
        download_url: get.url,
        payload_utf8: payload.toString('utf8'),
        expires_at: get.expiresAt,
      });
    },

    async expireObjects() {
      const rows = await db.listExpiredReady(now().toISOString());
      let deleted = 0;
      for (const row of rows) {
        await s3.deleteObject(row.object_key);
        await db.updateSensorObject(row.id, { status: 'deleting' });
        deleted += 1;
      }
      return json(200, { deleted });
    },
  };
}
