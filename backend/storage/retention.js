import { OBJECT_LANE_STREAMS, retentionClassForStream } from './keys.js';

/** Retention class defaults. Override with env, never scatter literals at call sites. */
export const RETENTION = {
  core: { class: 'core', defaultDays: null },
  hr: { class: 'core', defaultDays: null },
  rr: { class: 'core', defaultDays: null },
  ppg: { class: 'ppg', defaultDays: 30 },
  imu: { class: 'research_imu', defaultDays: 30 },
  diagnostic: { class: 'diagnostic', defaultDays: 7 },
  ble: { class: 'diagnostic', defaultDays: 7 },
  export: { class: 'export', defaultDays: 7 },
  derived: { class: 'derived', defaultDays: null },
  /**
   * The longitudinal raw corpus. `defaultDays: null` is load-bearing rather than a default nobody
   * set: an age cutoff on this class deletes the training data the archive exists to accumulate, and
   * a waveform has no aggregate that survives it. `b2LifecycleRules` deliberately emits no hiding
   * rule for the `v3/research/` prefix for the same reason.
   */
  research: { class: 'research', defaultDays: null },
};

/** Per-class expiry in days for an object-lane stream. Absent means never. */
const OBJECT_LANE_CLASS_DAYS = { research: null, diag: 7 };

export const OBJECT_KINDS = Object.freeze([
  'canonical', 'ppg', 'imu', 'diagnostic', 'export', 'live_hr',
  'hr', 'rr', 'hr_rr', 'physiology', 'frames', 'ble', 'ecg', 'derived',
]);

export const MANIFEST_STATUSES = Object.freeze([
  'pending', 'uploading', 'uploaded', 'verified', 'ready',
  'expired', 'deleting', 'deleted', 'corrupt', 'failed',
]);

export const MAX_COMPRESSED_BYTES = Object.freeze({
  canonical: 50 * 1024 * 1024,
  ppg: 80 * 1024 * 1024,
  imu: 200 * 1024 * 1024,
  diagnostic: 20 * 1024 * 1024,
  export: 100 * 1024 * 1024,
  live_hr: 40 * 1024 * 1024,
  hr: 40 * 1024 * 1024,
  rr: 40 * 1024 * 1024,
  hr_rr: 40 * 1024 * 1024,
  physiology: 40 * 1024 * 1024,
  frames: 80 * 1024 * 1024,
  ble: 40 * 1024 * 1024,
  derived: 20 * 1024 * 1024,
});

export const MAX_RANGE_MS = 48 * 60 * 60 * 1000;

/**
 * Ceiling for one presigned direct-to-bucket object. Generous against a real hour of any stream
 * (an hour of 100 Hz 6-axis i16 is ~4.3 MB before compression) while still bounding what a single
 * signed URL can write. B2 tolerates far larger single-part puts; this is our limit, not theirs.
 */
export const MAX_OBJECT_LANE_BYTES = 256 * 1024 * 1024;

export function retentionFor(kind, cfg = {}) {
  // Object-lane wire streams are camelCase and never collide with an `OBJECT_KINDS` value, so this
  // resolves them off the one canonical stream->class map instead of a second list that can drift.
  if (OBJECT_LANE_STREAMS.has(kind)) {
    const cls = retentionClassForStream(kind);
    const days = OBJECT_LANE_CLASS_DAYS[cls];
    return { class: cls, defaultDays: days == null ? null : days };
  }
  if (kind === 'frames') return { class: 'core', defaultDays: null };
  if (kind === 'canonical' || kind === 'hr' || kind === 'rr' || kind === 'hr_rr' || kind === 'live_hr' || kind === 'physiology') {
    const days = kind === 'rr' ? cfg.retentionRrDays : cfg.retentionHrDays;
    return { class: 'core', defaultDays: days == null ? null : days };
  }
  if (kind === 'ppg') return { class: 'ppg', defaultDays: cfg.retentionPpgDays ?? 30 };
  if (kind === 'imu') return { class: 'research_imu', defaultDays: cfg.retentionImuDays ?? 30 };
  if (kind === 'ble' || kind === 'diagnostic') {
    return { class: 'diagnostic', defaultDays: (kind === 'ble' ? cfg.retentionBleDays : cfg.retentionDiagDays) ?? 7 };
  }
  if (kind === 'export') return RETENTION.export;
  if (kind === 'derived' || kind === 'sleep_summary' || kind === 'daily_metrics') return RETENTION.derived;
  return RETENTION.core;
}

export function expiresAt(kind, now = new Date(), cfg = {}) {
  const spec = retentionFor(kind, cfg);
  if (!spec || spec.defaultDays == null) return null;
  return new Date(now.getTime() + spec.defaultDays * 86400 * 1000).toISOString();
}

export function b2LifecycleRules(cfg = {}) {
  const days = (n, fallback) => (Number.isFinite(Number(n)) ? Number(n) : fallback);
  return [
    { fileNamePrefix: '', daysFromUploadingToHiding: null, daysFromHidingToDeleting: 1 },
    // Explicit never-hide rule for the raw corpus. B2 matches the longest prefix, so this states the
    // intent at the prefix itself rather than relying on the catch-all above staying permissive.
    { fileNamePrefix: 'v3/research/', daysFromUploadingToHiding: null, daysFromHidingToDeleting: 1 },
    { fileNamePrefix: 'v3/ppg/', daysFromUploadingToHiding: days(cfg.retentionPpgDays, 30), daysFromHidingToDeleting: 1 },
    { fileNamePrefix: 'v3/imu/', daysFromUploadingToHiding: days(cfg.retentionImuDays, 30), daysFromHidingToDeleting: 1 },
    { fileNamePrefix: 'v3/diag/', daysFromUploadingToHiding: days(cfg.retentionDiagDays, 7), daysFromHidingToDeleting: 1 },
    { fileNamePrefix: 'v3/export/', daysFromUploadingToHiding: 7, daysFromHidingToDeleting: 1 },
  ];
}

export async function sweepExpiredManifests({
  rest,
  objectStore,
  now = () => new Date(),
} = {}) {
  if (!rest?.configured || !objectStore) return { deleted: 0 };
  const iso = now().toISOString();
  const rows = await rest.select(
    'object_manifests',
    `status=in.(ready,verified,expired)&expires_at=lte.${encodeURIComponent(iso)}&select=id,object_key,status`,
  );
  let deleted = 0;
  for (const row of rows || []) {
    try {
      if (typeof objectStore.deletePrefixAllVersions === 'function') {
        await objectStore.deletePrefixAllVersions(row.object_key);
      } else {
        await objectStore.deleteObject(row.object_key);
      }
      await rest.request(`object_manifests?id=eq.${row.id}`, {
        method: 'PATCH',
        body: { status: 'deleted' },
      });
      deleted += 1;
    } catch {
      await rest.request(`object_manifests?id=eq.${row.id}`, {
        method: 'PATCH',
        body: { status: 'failed' },
      }).catch(() => {});
    }
  }
  return { deleted };
}
