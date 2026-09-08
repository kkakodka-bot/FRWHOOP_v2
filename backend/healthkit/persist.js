/**
 * Durable HealthKit persistence. Local `store.healthkit` is a cache, not an ACK.
 * The server either persists (RPC) or throws a real error. Never swallow loss.
 */

export class HealthKitPersistError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'HealthKitPersistError';
    this.code = code;
    this.cause = cause;
  }
}

export function assertDurableIdentities(measurements = []) {
  const bad = (measurements || []).filter((m) => !m?.external_id || !m?.source_system);
  if (bad.length) {
    throw new HealthKitPersistError(
      'missing_identity',
      `${bad.length} HealthKit measurement(s) missing source_system/external_id`,
    );
  }
}

export function assertDurableStepBuckets(buckets = []) {
  const bad = (buckets || []).filter((bucket) => (
    !bucket?.device_fingerprint
    || !bucket?.bucket_key
    || !bucket?.bucket_start
    || ![60, 300].includes(Number(bucket?.bucket_size_seconds))
    || !Number.isFinite(Number(bucket?.step_count))
    || !bucket?.metadata?.allocations
    || Object.keys(bucket.metadata.allocations).length === 0
  ));
  if (bad.length) {
    throw new HealthKitPersistError(
      'missing_step_bucket_identity',
      `${bad.length} Apple Watch step bucket(s) missing durable identity`,
    );
  }
}

/**
 * Persist measurements, source_links, and HealthKit sessions via the
 * `healthkit_upsert_external` RPC (partial unique indexes cannot be targeted
 * by PostgREST `on_conflict=`).
 *
 * @returns {{ persisted: 'supabase'|'local_only', ack?: object }}
 */
export async function persistHealthKitResult({ rest, userId, result }) {
  if (!rest?.configured) return { persisted: 'local_only' };
  if (!userId) {
    throw new HealthKitPersistError('auth_required', 'HealthKit ingest requires an authenticated user');
  }
  assertDurableIdentities(result.measurements);
  assertDurableStepBuckets(result.appleWatchStepBuckets);
  let ack;
  try {
    ack = await rest.rpc('healthkit_upsert_external', {
      p_user_id: userId,
      p_measurements: result.measurements || [],
      p_links: result.links || [],
      p_sessions: result.sessions || [],
      p_step_buckets: result.appleWatchStepBuckets || [],
    });
  } catch (err) {
    throw new HealthKitPersistError(
      'upsert_failed',
      err?.message || 'healthkit_upsert_failed',
      err,
    );
  }
  if (!ack || ack.ok === false) {
    throw new HealthKitPersistError('upsert_failed', ack?.error || 'healthkit_upsert_failed');
  }
  return { persisted: 'supabase', ack };
}
