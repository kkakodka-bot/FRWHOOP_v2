import { storageConfig } from './config.js';
import { discoverS3Endpoint } from './s3.js';

function days(n, fallback) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * B2 fileNamePrefix matches from the START of the object key.
 * Stream-specific rules therefore require a key scheme that starts with the
 * retention class: v3/{ppg|imu|diag|export}/...
 */
export function desiredLifecycleRules(cfg = {}) {
  return [
    {
      fileNamePrefix: '',
      daysFromUploadingToHiding: null,
      daysFromHidingToDeleting: 1,
    },
    // Explicit never-hide rule for the raw corpus. B2 evaluates the most specific matching prefix,
    // so this keeps `v3/research/` permanent even if the catch-all above is ever tightened.
    {
      fileNamePrefix: 'v3/research/',
      daysFromUploadingToHiding: null,
      daysFromHidingToDeleting: 1,
    },
    {
      fileNamePrefix: 'v3/ppg/',
      daysFromUploadingToHiding: days(cfg.retentionPpgDays, 30),
      daysFromHidingToDeleting: 1,
    },
    {
      fileNamePrefix: 'v3/imu/',
      daysFromUploadingToHiding: days(cfg.retentionImuDays, 30),
      daysFromHidingToDeleting: 1,
    },
    {
      fileNamePrefix: 'v3/diag/',
      daysFromUploadingToHiding: days(cfg.retentionDiagDays, 7),
      daysFromHidingToDeleting: 1,
    },
    {
      fileNamePrefix: 'v3/export/',
      daysFromUploadingToHiding: 7,
      daysFromHidingToDeleting: 1,
    },
  ];
}

function normalizeRules(rules) {
  return (rules || [])
    .map((r) => ({
      fileNamePrefix: String(r.fileNamePrefix || ''),
      daysFromUploadingToHiding: r.daysFromUploadingToHiding == null ? null : Number(r.daysFromUploadingToHiding),
      daysFromHidingToDeleting: r.daysFromHidingToDeleting == null ? null : Number(r.daysFromHidingToDeleting),
    }))
    .sort((a, b) => a.fileNamePrefix.localeCompare(b.fileNamePrefix));
}

export function rulesMatch(a, b) {
  const left = JSON.stringify(normalizeRules(a));
  const right = JSON.stringify(normalizeRules(b));
  return left === right;
}

/**
 * A key restricted to one bucket is rejected with 401 unless the request names
 * that bucket, so always scope the listing to the bucket we are about to read.
 */
async function listBuckets(auth, fetchImpl, bucketName) {
  const res = await fetchImpl(`${String(auth.apiUrl).replace(/\/$/, '')}/b2api/v2/b2_list_buckets`, {
    method: 'POST',
    headers: {
      authorization: auth.authorizationToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      accountId: auth.accountId,
      ...(bucketName ? { bucketName } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`b2_list_buckets failed (${res.status}) ${text.slice(0, 120)}`);
  }
  const body = await res.json();
  return body.buckets || [];
}

export async function applyB2Lifecycle({
  cfg = storageConfig(),
  fetchImpl = fetch,
  apply = true,
} = {}) {
  if (!cfg.b2KeyId || !cfg.b2ApplicationKey || !cfg.b2Bucket) {
    return { ok: false, error: 'b2_not_configured' };
  }
  const wanted = desiredLifecycleRules(cfg);
  const auth = await discoverS3Endpoint(cfg.b2KeyId, cfg.b2ApplicationKey, fetchImpl);
  const buckets = await listBuckets(auth, fetchImpl, cfg.b2Bucket);
  const bucket = buckets.find((b) => b.bucketName === cfg.b2Bucket);
  if (!bucket) {
    return { ok: false, error: 'bucket_not_found', bucket: cfg.b2Bucket, wanted };
  }
  const before = bucket.lifecycleRules || [];
  if (rulesMatch(before, wanted)) {
    return {
      ok: true,
      applied: false,
      matched: true,
      bucket: bucket.bucketName,
      bucketId: bucket.bucketId,
      rules: normalizeRules(before),
    };
  }
  if (!apply) {
    return {
      ok: true,
      applied: false,
      matched: false,
      bucket: bucket.bucketName,
      bucketId: bucket.bucketId,
      before: normalizeRules(before),
      wanted: normalizeRules(wanted),
    };
  }
  const res = await fetchImpl(`${String(auth.apiUrl).replace(/\/$/, '')}/b2api/v2/b2_update_bucket`, {
    method: 'POST',
    headers: {
      authorization: auth.authorizationToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      accountId: auth.accountId,
      bucketId: bucket.bucketId,
      lifecycleRules: wanted,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      error: `b2_update_bucket failed (${res.status}) ${text.slice(0, 180)}`,
      bucket: bucket.bucketName,
      before: normalizeRules(before),
      wanted: normalizeRules(wanted),
    };
  }
  const updated = await res.json();
  const after = updated.lifecycleRules || [];
  return {
    ok: rulesMatch(after, wanted),
    applied: true,
    matched: rulesMatch(after, wanted),
    bucket: updated.bucketName || bucket.bucketName,
    bucketId: updated.bucketId || bucket.bucketId,
    before: normalizeRules(before),
    rules: normalizeRules(after),
  };
}
