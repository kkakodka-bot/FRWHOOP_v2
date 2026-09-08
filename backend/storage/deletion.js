import { gzipSync } from 'node:zlib';
import { sha256Hex } from '../ingest/archiveFormat.js';
import { exportObjectKey, allUserPrefixes } from './keys.js';
import { expiresAt } from './retention.js';
import { inc } from '../observability/metrics.js';

const STEPS = [
  'record_job',
  'list_manifests',
  'delete_b2_versions',
  'delete_supabase_rows',
  'delete_local_cache',
  'delete_auth_user',
  'complete',
];

export function createDeletionService({
  rest,
  objectStore,
  now = () => new Date(),
  uuid,
  localCleanup,
} = {}) {
  async function loadJob(userId) {
    const rows = await rest.select(
      'deletion_jobs',
      `user_id=eq.${userId}&status=in.(pending,running,blocked)&order=created_at.desc&limit=1`,
    );
    return rows[0] || null;
  }

  async function saveJob(job) {
    return rest.upsert('deletion_jobs', job, { onConflict: 'id' });
  }

  async function run(userId, { existing } = {}) {
    const job = existing || await loadJob(userId) || {
      id: uuid ? uuid() : crypto.randomUUID(),
      user_id: userId,
      status: 'running',
      step: 'record_job',
      state: { failures: [], deleted_keys: [] },
      created_at: now().toISOString(),
      updated_at: now().toISOString(),
    };
    job.status = 'running';
    job.updated_at = now().toISOString();
    await saveJob(job);

    try {
      job.step = 'list_manifests';
      const manifests = await rest.select('object_manifests', `user_id=eq.${userId}&select=id,object_key,status`);
      job.state.manifest_ids = manifests.map((m) => m.id);
      job.state.object_keys = [...new Set(manifests.map((m) => m.object_key).filter(Boolean))];
      await saveJob(job);

      job.step = 'delete_b2_versions';
      const failures = [];
      if (objectStore?.deletePrefixAllVersions) {
        for (const prefix of allUserPrefixes(userId)) {
          const result = await objectStore.deletePrefixAllVersions(prefix);
          job.state.deleted_keys = (job.state.deleted_keys || []).concat(
            result.failures?.length ? [] : [prefix],
          );
          for (const f of result.failures || []) failures.push(f);
        }
      } else if (objectStore?.deleteObject) {
        for (const key of job.state.object_keys || []) {
          try { await objectStore.deleteObject(key); } catch { failures.push({ key }); }
        }
        for (const prefix of allUserPrefixes(userId)) {
          try {
            const leftover = await objectStore.listPrefix(prefix);
            for (const key of leftover) {
              try { await objectStore.deleteObject(key); } catch { failures.push({ key }); }
            }
          } catch {
            failures.push({ prefix });
          }
        }
      }
      job.state.failures = failures;
      if (failures.length) {
        job.status = 'blocked';
        job.updated_at = now().toISOString();
        await saveJob(job);
        inc('deletion_failures');
        return { status: 'retry', remaining: failures.length, job_id: job.id };
      }
      await saveJob(job);

      job.step = 'delete_supabase_rows';
      const tables = [
        'physiology_buckets',
        'daily_physiology_series',
        'ingest_gaps',
        'measurements',
        'sleep_details',
        'events',
        'sessions',
        'daily_metrics',
        'metric_runs',
        'object_manifests',
        'sensor_objects',
        'derived_objects',
        'live_windows',
        'sleep_nights',
        'coach_messages',
        'coach_sessions',
        'coach_memories',
        'user_documents',
        'algorithm_results',
        'user_settings',
        'integration_connections',
        'user_sync_state',
        'devices',
        'profiles',
      ];
      for (const table of tables) {
        try {
          const col = table === 'profiles' ? 'id' : 'user_id';
          await rest.delete(table, `${col}=eq.${userId}`);
        } catch {
          // table may not exist yet in older environments
        }
      }
      try {
        await rest.delete('integration_credentials', `user_id=eq.${userId}`, { schema: 'internal' });
      } catch { /* schema-qualified delete via content-profile */ }
      await saveJob(job);

      job.step = 'delete_local_cache';
      if (typeof localCleanup === 'function') {
        await localCleanup(userId);
      }
      await saveJob(job);

      job.step = 'delete_auth_user';
      await rest.adminDeleteAuthUser(userId);

      job.step = 'complete';
      job.status = 'complete';
      job.completed_at = now().toISOString();
      job.updated_at = now().toISOString();
      await saveJob(job);
      return { status: 'deleted', job_id: job.id };
    } catch (err) {
      job.status = 'blocked';
      job.state = { ...(job.state || {}), error: String(err?.message || err).slice(0, 200) };
      job.updated_at = now().toISOString();
      await saveJob(job);
      inc('deletion_failures');
      return { status: 'retry', job_id: job.id, error: job.state.error };
    }
  }

  return { run, loadJob, steps: STEPS };
}

export async function buildExportBundle({
  rest,
  objectStore,
  userId,
  includeArchives = false,
  includeArchiveBodies = false,
  now = () => new Date(),
  uuid,
  maxBodyBytes = 40 * 1024 * 1024,
} = {}) {
  const [profiles, devices, daily, sessions, events, measurements, manifests] = await Promise.all([
    rest.select('profiles', `id=eq.${userId}&select=*`),
    rest.select('devices', `user_id=eq.${userId}&select=*`),
    rest.select('daily_metrics', `user_id=eq.${userId}&record_class=eq.user&select=*`),
    rest.select('sessions', `user_id=eq.${userId}&select=*`),
    rest.select('events', `user_id=eq.${userId}&select=*`),
    rest.select('measurements', `user_id=eq.${userId}&select=*`).catch(() => []),
    rest.select('object_manifests', `user_id=eq.${userId}&select=*`).catch(() => []),
  ]);

  const omitted = [];
  const archives = [];
  if (includeArchives) {
    let used = 0;
    for (const m of manifests || []) {
      const item = {
        id: m.id,
        object_key: m.object_key,
        object_kind: m.object_kind,
        sha256: m.sha256,
        compressed_bytes: m.compressed_bytes,
        format: m.format,
        status: m.status,
      };
      if (includeArchiveBodies && objectStore?.getObject && used < maxBodyBytes) {
        try {
          const obj = await objectStore.getObject(m.object_key);
          if (obj?.body && used + obj.body.length <= maxBodyBytes) {
            item.encoding = 'base64';
            item.body_b64 = obj.body.toString('base64');
            used += obj.body.length;
          } else {
            omitted.push({ id: m.id, reason: 'size_cap' });
          }
        } catch {
          omitted.push({ id: m.id, reason: 'fetch_failed' });
        }
      }
      archives.push(item);
    }
  }

  const payload = {
    exported_at: now().toISOString(),
    user_id: userId,
    mode: includeArchiveBodies ? 'full' : (includeArchives ? 'structured_plus_manifests' : 'structured'),
    profile: profiles[0] || null,
    devices,
    daily_metrics: daily,
    sessions,
    events,
    measurements,
    object_manifests: (manifests || []).map((m) => ({
      id: m.id, object_key: m.object_key, object_kind: m.object_kind,
      sha256: m.sha256, compressed_bytes: m.compressed_bytes, status: m.status,
    })),
    archives,
    omitted_archive_bodies: omitted,
  };

  const json = Buffer.from(JSON.stringify(payload));
  const body = gzipSync(json);
  const objectId = uuid ? uuid() : crypto.randomUUID();
  const key = exportObjectKey({ userId, objectId, compression: 'gzip' });
  const meta = {
    id: objectId,
    user_id: userId,
    object_class: 'export',
    object_kind: 'export',
    provider: 'b2',
    object_key: key,
    start_at: now().toISOString(),
    end_at: now().toISOString(),
    period_day: now().toISOString().slice(0, 10),
    compressed_bytes: body.length,
    content_type: 'application/gzip',
    format: 'json_gzip_v1',
    compression: 'gzip',
    schema_version: 1,
    sha256: sha256Hex(body),
    status: 'pending',
    retention_class: 'export',
    expires_at: expiresAt('export', now()),
  };
  return { payload, body, key, meta, omitted };
}
