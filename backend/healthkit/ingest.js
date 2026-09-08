/**
 * HealthKit ingest: normalize with provenance, reconcile, apply source policy,
 * and build an idempotent HealthKit export plan.
 *
 * Does not write raw WHOOP telemetry. Does not mutate Apple-owned samples.
 */

import { createHash } from 'node:crypto';
import { arbitrate, classifySource, isCanonicalSource, isHealthKitSource, SOURCES } from './policy.js';
import { uuidFromParts } from '../storage/keys.js';
import {
  classifySleepMatch,
  classifyWorkoutMatch,
  pairIntervals,
  sleepRelationship,
  workoutRelationship,
} from './reconcile.js';

export const SYNC_PREFIX = 'frwhoop';

export function syncIdentifier(kind, canonicalId) {
  return `${SYNC_PREFIX}:${kind}:${canonicalId}`;
}

export function nextSyncVersion(prev, changed) {
  const n = Number(prev) || 0;
  return changed ? Math.max(1, n + 1) : Math.max(1, n || 1);
}

const HR_MIN = 20;
const HR_MAX = 240;
const STEP_BUCKET_SECONDS = 60;
const DERIVED_STEP_BUCKET_SECONDS = 300;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isStepMetric(metric) {
  return ['steps', 'stepCount', 'step_count'].includes(String(metric || ''));
}

function readDeviceProvenance(raw = {}) {
  const device = raw.device_provenance || raw.deviceProvenance || {};
  return {
    name: text(device.name || raw.device_name || raw.deviceName || raw.source_device),
    manufacturer: text(device.manufacturer || raw.device_manufacturer || raw.deviceManufacturer),
    model: text(device.model || raw.device_model || raw.deviceModel),
    hardware_version: text(device.hardware_version || device.hardwareVersion
      || raw.device_hardware_version || raw.deviceHardwareVersion || raw.productType),
    firmware_version: text(device.firmware_version || device.firmwareVersion
      || raw.device_firmware_version || raw.deviceFirmwareVersion),
    software_version: text(device.software_version || device.softwareVersion
      || raw.device_software_version || raw.deviceSoftwareVersion),
    local_identifier: text(device.local_identifier || device.localIdentifier
      || raw.device_local_identifier || raw.deviceLocalIdentifier),
    udi_device_identifier: text(device.udi_device_identifier || device.udiDeviceIdentifier
      || raw.device_udi_identifier || raw.deviceUdiIdentifier),
  };
}

export function validateAppleWatchStepSample(sample = {}) {
  if (!isStepMetric(sample.metric_type)) return null;
  if (sample.sample_kind !== 'raw_quantity_sample') return 'merged_step_summary_not_raw';
  if (!sample.original_sample_id) return 'missing_external_id';

  const device = readDeviceProvenance(sample);
  const manufacturer = device.manufacturer.toLowerCase();
  if (manufacturer !== 'apple' && manufacturer !== 'apple inc.') return 'not_apple_watch_device';

  const evidence = [device.name, device.model, device.hardware_version].join(' ').toLowerCase();
  if (!evidence.includes('watch') || /\b(?:iphone|ipad|ipod)\b/.test(evidence)) {
    return 'not_apple_watch_device';
  }
  const bundle = text(sample.source_bundle).toLowerCase();
  if (bundle !== 'com.apple.health' && !bundle.startsWith('com.apple.health.')) {
    return 'third_party_step_source';
  }
  const deviceIdentifier = device.local_identifier || device.udi_device_identifier;
  const sourceIdentifier = bundle.startsWith('com.apple.health.') ? bundle : '';
  if (!deviceIdentifier && !sourceIdentifier) return 'ambiguous_watch_device';

  const start = Date.parse(sample.start_time || '');
  const end = Date.parse(sample.end_time || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 'invalid_step_interval';
  const count = Number(sample.value);
  if (!Number.isFinite(count) || count < 0) return 'invalid_step_count';
  return null;
}

export function appleWatchDeviceFingerprint(sample = {}) {
  const device = readDeviceProvenance(sample);
  const reason = validateAppleWatchStepSample({ ...sample, device_provenance: device });
  if (reason) return null;
  const stableIdentity = {
    manufacturer: device.manufacturer.toLowerCase(),
    identifier_type: device.local_identifier
      ? 'local_identifier'
      : (device.udi_device_identifier ? 'udi_device_identifier' : 'source_bundle'),
    identifier: device.local_identifier || device.udi_device_identifier
      || text(sample.source_bundle).toLowerCase(),
  };
  const hash = createHash('sha256').update(JSON.stringify(stableIdentity)).digest('hex');
  return `apple_watch:${hash}`;
}

function roundedSteps(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e12) / 1e12;
}

function bucketKey(userId, fingerprint, bucketStart, bucketSizeSeconds) {
  return uuidFromParts([
    userId,
    'apple-watch-step-bucket',
    fingerprint,
    bucketStart,
    String(bucketSizeSeconds),
  ]);
}

export function buildAppleWatchStepBuckets(samples = [], userId) {
  const minuteBuckets = new Map();
  const orderedSamples = [...samples].sort((a, b) => (
    Date.parse(a.start_time) - Date.parse(b.start_time)
    || String(a.original_sample_id).localeCompare(String(b.original_sample_id))
  ));
  for (const sample of orderedSamples) {
    const fingerprint = appleWatchDeviceFingerprint(sample);
    if (!fingerprint) continue;
    const startMs = Date.parse(sample.start_time);
    const endMs = Date.parse(sample.end_time);
    const durationMs = endMs - startMs;
    const firstBucketMs = Math.floor(startMs / 60000) * 60000;
    const lastBucketMs = Math.floor((endMs - 1) / 60000) * 60000;
    const coalesced = lastBucketMs > firstBucketMs;
    const device = readDeviceProvenance(sample);

    for (let bucketMs = firstBucketMs; bucketMs <= lastBucketMs; bucketMs += 60000) {
      const overlapMs = Math.max(
        0,
        Math.min(endMs, bucketMs + 60000) - Math.max(startMs, bucketMs),
      );
      if (!overlapMs) continue;
      const bucketStart = new Date(bucketMs).toISOString();
      const mapKey = `${fingerprint}|${bucketStart}`;
      const allocatedSteps = Number(sample.value) * overlapMs / durationMs;
      const row = minuteBuckets.get(mapKey) || {
        user_id: userId,
        device_fingerprint: fingerprint,
        bucket_start: bucketStart,
        bucket_size_seconds: STEP_BUCKET_SECONDS,
        bucket_key: bucketKey(userId, fingerprint, bucketStart, STEP_BUCKET_SECONDS),
        step_count: 0,
        allocated: true,
        coalesced: false,
        allocation_method: 'duration_overlap',
        source_sample_ids: [],
        device_provenance: device,
        metadata: { allocations: {} },
      };
      row.step_count = roundedSteps(row.step_count + allocatedSteps);
      row.coalesced ||= coalesced;
      row.source_sample_ids.push(sample.original_sample_id);
      row.metadata.allocations[`${sample.original_sample_id}@${bucketStart}`] = roundedSteps(allocatedSteps);
      minuteBuckets.set(mapKey, row);
    }
  }

  const minutes = [...minuteBuckets.values()]
    .map((row) => ({
      ...row,
      source_sample_ids: [...new Set(row.source_sample_ids)].sort(),
      metadata: {
        ...row.metadata,
        allocated: true,
        coalesced: row.coalesced,
        allocation_method: row.allocation_method,
      },
    }))
    .sort((a, b) => a.device_fingerprint.localeCompare(b.device_fingerprint)
      || Date.parse(a.bucket_start) - Date.parse(b.bucket_start));

  const fiveMinuteBuckets = new Map();
  for (const minute of minutes) {
    const bucketMs = Math.floor(Date.parse(minute.bucket_start) / 300000) * 300000;
    const bucketStart = new Date(bucketMs).toISOString();
    const mapKey = `${minute.device_fingerprint}|${bucketStart}`;
    const row = fiveMinuteBuckets.get(mapKey) || {
      user_id: userId,
      device_fingerprint: minute.device_fingerprint,
      bucket_start: bucketStart,
      bucket_size_seconds: DERIVED_STEP_BUCKET_SECONDS,
      bucket_key: bucketKey(userId, minute.device_fingerprint, bucketStart, DERIVED_STEP_BUCKET_SECONDS),
      step_count: 0,
      allocated: true,
      coalesced: false,
      allocation_method: 'sum_60s',
      source_sample_ids: [],
      device_provenance: minute.device_provenance,
      metadata: {
        derived_from_bucket_size_seconds: STEP_BUCKET_SECONDS,
        allocations: {},
      },
    };
    row.step_count = roundedSteps(row.step_count + minute.step_count);
    row.coalesced ||= minute.coalesced;
    row.source_sample_ids.push(...minute.source_sample_ids);
    Object.assign(row.metadata.allocations, minute.metadata.allocations);
    fiveMinuteBuckets.set(mapKey, row);
  }

  const fiveMinutes = [...fiveMinuteBuckets.values()]
    .map((row) => ({
      ...row,
      source_sample_ids: [...new Set(row.source_sample_ids)].sort(),
      metadata: {
        ...row.metadata,
        allocated: true,
        coalesced: row.coalesced,
        allocation_method: row.allocation_method,
      },
    }))
    .sort((a, b) => a.device_fingerprint.localeCompare(b.device_fingerprint)
      || Date.parse(a.bucket_start) - Date.parse(b.bucket_start));
  return [...minutes, ...fiveMinutes];
}

export function mergeAppleWatchStepBucket(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const allocations = {
    ...(existing.metadata?.allocations || {}),
    ...(incoming.metadata?.allocations || {}),
  };
  const stepCount = roundedSteps(
    Object.values(allocations).reduce((sum, value) => sum + (Number(value) || 0), 0),
  );
  return {
    ...existing,
    ...incoming,
    step_count: stepCount,
    allocated: Boolean(existing.allocated || incoming.allocated),
    coalesced: Boolean(existing.coalesced || incoming.coalesced),
    source_sample_ids: [...new Set([
      ...(existing.source_sample_ids || []),
      ...(incoming.source_sample_ids || []),
    ])].sort(),
    device_provenance: {
      ...(existing.device_provenance || {}),
      ...(incoming.device_provenance || {}),
    },
    metadata: {
      ...(existing.metadata || {}),
      ...(incoming.metadata || {}),
      allocations,
    },
  };
}

export function sampleQuality(sample = {}) {
  const flags = [];
  const value = Number(sample.value);
  const ageSec = sample.ingested_at && sample.end_time
    ? Math.max(0, (Date.parse(sample.ingested_at) - Date.parse(sample.end_time)) / 1000)
    : 0;
  if (ageSec > 7 * 86400) flags.push('stale');
  if (sample.metric_type === 'heart_rate' || sample.metric_type === 'resting_heart_rate') {
    if (!Number.isFinite(value) || value < HR_MIN || value > HR_MAX) flags.push('out_of_range');
  }
  if (sample.metadata?.HKMetadataKeyHeartRateMotionContext === 1) flags.push('motion');
  const missingness = Number(sample.missingness);
  if (Number.isFinite(missingness) && missingness > 0.3) flags.push('sparse');
  const quality = Math.max(0, Math.min(1, 1 - flags.length * 0.2));
  return { quality, flags };
}

export function rejectSample(sample = {}) {
  const start = Date.parse(sample.start_time || sample.timestamp || '');
  const end = Date.parse(sample.end_time || sample.start_time || sample.timestamp || '');
  if (sample.start_time && !Number.isFinite(start)) return 'bad_timestamp';
  if (Number.isFinite(start) && Number.isFinite(end) && end < start) return 'negative_duration';
  const value = sample.value;
  if (value != null && typeof value === 'number' && !Number.isFinite(value)) return 'non_finite';
  if (sample.metric_type === 'heart_rate' || sample.metric_type === 'resting_heart_rate') {
    const n = Number(value);
    if (Number.isFinite(n) && (n < HR_MIN || n > HR_MAX)) return 'corrupted_hr';
  }
  if (sample.metric_type === 'hrv' && Number(value) < 0) return 'corrupted_hrv';
  if (typeof value === 'number' && value < 0 && !['skin_temperature'].includes(sample.metric_type)) {
    return 'negative_value';
  }
  return null;
}

/**
 * Keep provenance. Never drop source fields during normalization.
 */
export function normalizeMeasurement(raw = {}, ingestedAt = new Date().toISOString()) {
  const deviceProvenance = readDeviceProvenance(raw);
  const source = raw.source || classifySource({
    bundleId: raw.source_bundle || raw.sourceBundleIdentifier,
    sourceName: raw.source_app || raw.sourceName,
    deviceName: raw.source_device || raw.deviceName,
    deviceModel: raw.device_model || raw.deviceModel,
    productType: raw.productType,
  });
  const start = raw.start_time || raw.startTime || raw.timestamp;
  const end = raw.end_time || raw.endTime || start;
  const sample = {
    timestamp: start,
    start_time: start,
    end_time: end,
    metric_type: raw.metric_type || raw.metricType || raw.quantityType,
    value: raw.value,
    unit: raw.unit,
    source,
    source_device: raw.source_device || raw.deviceName || null,
    source_app: raw.source_app || raw.sourceName || null,
    source_bundle: raw.source_bundle || raw.sourceBundleIdentifier || null,
    device_model: deviceProvenance.model || null,
    device_provenance: deviceProvenance,
    source_revision: raw.source_revision || raw.sourceRevision || null,
    source_revision_provenance: raw.source_revision_provenance || raw.sourceRevisionProvenance || {},
    original_sample_id: raw.original_sample_id || raw.uuid || raw.sampleId || null,
    sample_kind: raw.sample_kind || raw.sampleKind || null,
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
    ingested_at: ingestedAt,
    missingness: raw.missingness ?? null,
  };
  const rejected = rejectSample(sample);
  const q = sampleQuality(sample);
  return {
    ...sample,
    rejected: Boolean(rejected),
    reject_reason: rejected,
    quality: q.quality,
    quality_flags: q.flags,
    confidence: q.quality,
  };
}

function asSessionInterval(row) {
  return {
    ...row,
    start: row.start_at || row.start,
    end: row.end_at || row.end,
    sport: row.summary?.sport || row.summary?.name || row.sport,
    avgHr: row.summary?.avg_hr,
    distanceM: row.summary?.distance_m,
    calories: row.summary?.calories ?? row.summary?.calories_kcal,
  };
}

function workoutFromHk(sample, userId) {
  const id = uuidFromParts([userId, 'hk-workout', sample.source, sample.original_sample_id]);
  return {
    id,
    user_id: userId,
    kind: 'workout',
    source: sample.source,
    external_id: sample.original_sample_id,
    start_at: sample.start_time,
    end_at: sample.end_time,
    summary: {
      name: sample.sport || sample.metadata?.sport || 'Workout',
      sport: sample.sport || sample.metadata?.sport || 'Workout',
      duration_min: sample.duration_min
        ?? (Date.parse(sample.end_time) - Date.parse(sample.start_time)) / 60000,
      calories: sample.calories ?? sample.energy_kcal ?? null,
      distance_m: sample.distance_m ?? null,
      avg_hr: sample.avg_hr ?? null,
      max_hr: sample.max_hr ?? null,
      has_route: Boolean(sample.route),
      route: sample.route || null,
      role: 'external',
      provenance: {
        original_sample_id: sample.original_sample_id,
        source_app: sample.source_app,
        source_bundle: sample.source_bundle,
        source_device: sample.source_device,
        device_model: sample.device_model,
        source_revision: sample.source_revision,
      },
    },
    quality: { quality: sample.quality, flags: sample.quality_flags },
  };
}

function sleepFromHk(episode, userId) {
  const externalId = episode.original_sample_id || episode.id;
  return {
    id: uuidFromParts([userId, 'hk-sleep', episode.source, externalId]),
    user_id: userId,
    kind: 'sleep',
    source: episode.source,
    external_id: episode.original_sample_id || episode.id,
    start_at: episode.start_time,
    end_at: episode.end_time,
    summary: {
      asleep_min: episode.asleep_min,
      in_bed_min: episode.in_bed_min,
      deep_min: episode.deep_min,
      rem_min: episode.rem_min,
      light_min: episode.light_min,
      awake_min: episode.awake_min,
      stages: episode.stages || [],
      role: 'external_comparison',
      provenance: {
        original_sample_id: episode.original_sample_id,
        source_app: episode.source_app,
        source_bundle: episode.source_bundle,
        source_device: episode.source_device,
      },
    },
    quality: { quality: episode.quality ?? 0.7, flags: episode.quality_flags || [] },
  };
}

function linkRow({ userId, canonicalKind, canonicalId, external, match, confidence, relationship }) {
  return {
    user_id: userId,
    canonical_kind: canonicalKind,
    canonical_id: canonicalId,
    external_source: external.source,
    external_id: external.external_id || external.original_sample_id,
    sync_identifier: canonicalId ? syncIdentifier(canonicalKind, canonicalId) : null,
    sync_version: 1,
    match,
    confidence,
    relationship,
    last_seen_at: new Date().toISOString(),
    payload: {
      source_app: external.source_app || external.summary?.provenance?.source_app || null,
      source_bundle: external.source_bundle || external.summary?.provenance?.source_bundle || null,
    },
  };
}

function canonicalWorkouts(sessions = []) {
  return sessions.filter((s) => /workout/i.test(String(s.kind || '')) && isCanonicalSource(s.source || 'frwhoop'));
}

function externalWorkouts(sessions = []) {
  return sessions.filter((s) => /workout/i.test(String(s.kind || '')) && isHealthKitSource(s.source));
}

function canonicalSleep(sessions = []) {
  return sessions.filter((s) => /sleep|nap/i.test(String(s.kind || '')) && isCanonicalSource(s.source || 'frwhoop'));
}

/**
 * Apply source policy to a daily FRWHOOP row + HealthKit extras.
 * Canonical physiological scores stay FRWHOOP. Weight/nutrition may come from HealthKit.
 * Steps are strap-only (never copied onto daily_metrics from HealthKit extras).
 */
export function applyCanonicalDay(row = {}, healthkitDay = {}) {
  const sources = {};
  const pick = (metric, frValue, hkValue, hkSource) => {
    const result = arbitrate(metric, [
      frValue == null ? null : { source: SOURCES.FRWHOOP_DERIVED, value: frValue },
      hkValue == null ? null : { source: hkSource || SOURCES.APPLE_WATCH_HEALTHKIT, value: hkValue },
    ].filter(Boolean));
    if (result.source) sources[metric] = result.source;
    return result;
  };
  const steps = pick('steps', row.steps, null);
  const weight = pick('weight', row.weight_kg, healthkitDay.weight_kg, healthkitDay.weight_source);
  const distance = pick('distance', row.distance_m, healthkitDay.distance_m, healthkitDay.distance_source);
  const hr = pick('heart_rate', row.avg_hr_bpm, healthkitDay.avg_hr, healthkitDay.hr_source);
  const hrv = pick('hrv', row.hrv_rmssd_ms, healthkitDay.hrv_sdnn, healthkitDay.hrv_source);
  const rhr = pick('resting_heart_rate', row.resting_hr_bpm, healthkitDay.resting_hr, healthkitDay.rhr_source);
  const resp = pick('respiratory_rate', row.resp_rate_bpm, healthkitDay.resp_rate, healthkitDay.resp_source);
  const spo2 = pick('oxygen_saturation', row.spo2_pct, healthkitDay.spo2, healthkitDay.spo2_source);
  const kcal = pick('calories', row.active_kcal, healthkitDay.active_kcal, healthkitDay.kcal_source);
  const sleep = pick('sleep', row.sleep_total_min, healthkitDay.asleep_min, healthkitDay.sleep_source);

  return {
    steps: steps.value == null || !Number.isFinite(Number(steps.value))
      ? null
      : Math.round(Number(steps.value)),
    weight_kg: weight.value,
    distance_m: distance.value,
    avg_hr_bpm: hr.value,
    hrv_rmssd_ms: hrv.value,
    resting_hr_bpm: rhr.value,
    resp_rate_bpm: resp.value,
    spo2_pct: spo2.value,
    active_kcal: kcal.value,
    sleep_total_min: sleep.value,
    sources,
    comparison: {
      heart_rate: hr.comparison,
      hrv: hrv.comparison,
      calories: kcal.comparison,
      sleep: sleep.comparison,
      steps: steps.comparison,
    },
  };
}

function dailyFromSummaries(summaries = [], ingestedAt, rejected = []) {
  const byDay = {};
  for (const raw of summaries) {
    const sample = normalizeMeasurement(raw, ingestedAt);
    if (isStepMetric(sample.metric_type)) {
      sample.rejected = true;
      sample.reject_reason = 'merged_step_summary_not_raw';
      rejected.push(sample);
      continue;
    }
    if (sample.rejected) continue;
    const day = raw.day || String(sample.start_time || '').slice(0, 10);
    if (!day) continue;
    const bucket = byDay[day] || { day, byMetric: {} };
    const metric = sample.metric_type;
    const list = bucket.byMetric[metric] || [];
    list.push(sample);
    bucket.byMetric[metric] = list;
    byDay[day] = bucket;
  }
  const days = {};
  for (const [day, bucket] of Object.entries(byDay)) {
    const extras = { day, sources: {} };
    const take = (metric, field, sourceField) => {
      const result = arbitrate(metric, (bucket.byMetric[metric] || []).map((s) => ({
        ...s,
        value: s.value,
      })));
      if (result.value != null) {
        extras[field] = field === 'steps' ? Math.round(Number(result.value)) : result.value;
        extras[sourceField] = result.source;
        extras.sources[metric] = result.source;
      }
    };
    take('calories', 'active_kcal', 'kcal_source');
    take('heart_rate', 'avg_hr', 'hr_source');
    take('hrv', 'hrv_sdnn', 'hrv_source');
    take('resting_heart_rate', 'resting_hr', 'rhr_source');
    take('distance', 'distance_m', 'distance_source');
    take('vo2_max', 'vo2max', 'vo2_source');
    take('weight', 'weight_kg', 'weight_source');
    take('respiratory_rate', 'resp_rate', 'resp_source');
    take('oxygen_saturation', 'spo2', 'spo2_source');
    take('walking_heart_rate', 'walking_hr', 'walking_hr_source');
    const basal = (bucket.byMetric.basal_energy || bucket.byMetric.basalEnergyBurned || [])[0];
    if (basal) extras.basal_kcal = basal.value;
    days[day] = extras;
  }
  return days;
}

function exportFingerprint(record) {
  return JSON.stringify({
    start: record.start_at,
    end: record.end_at,
    kind: record.kind,
    calories: record.summary?.calories ?? record.summary?.calories_kcal ?? null,
    asleep: record.summary?.asleep_min ?? null,
    value: record.value ?? null,
  });
}

/**
 * Build HealthKit writes from canonical FRWHOOP records. Repeatable: same
 * identifier + version must not create a duplicate object.
 */
export function buildExportPlan({
  canonicalWorkouts: workouts = [],
  canonicalSleep: sleeps = [],
  vitals = [],
  links = [],
} = {}) {
  const linkByCanonical = new Map(
    links.filter((l) => l.canonical_id).map((l) => [`${l.canonical_kind}:${l.canonical_id}`, l]),
  );
  const writes = [];
  const skipped = [];

  for (const w of workouts) {
    if (!isCanonicalSource(w.source || 'frwhoop')) continue;
    const link = linkByCanonical.get(`workout:${w.id}`);
    const relationship = link?.relationship;
    const identifier = syncIdentifier('workout', w.id);
    const fingerprint = exportFingerprint(w);
    const prevFp = link?.payload?.fingerprint;
    const changed = Boolean(prevFp && prevFp !== fingerprint);
    const version = nextSyncVersion(link?.sync_version, changed || !link?.sync_version);
    if (relationship === 'skip_write' || relationship === 'associate') {
      skipped.push({
        kind: 'workout',
        id: w.id,
        reason: relationship,
        sync_identifier: identifier,
        sync_version: version,
      });
      continue;
    }
    writes.push({
      kind: 'workout',
      canonical_id: w.id,
      sync_identifier: identifier,
      sync_version: version,
      start: w.start_at,
      end: w.end_at,
      sport: w.summary?.sport || w.summary?.name || 'Workout',
      calories: w.summary?.calories ?? w.summary?.calories_kcal ?? null,
      distance_m: w.summary?.distance_m ?? null,
      fingerprint,
    });
  }

  for (const s of sleeps) {
    if (!isCanonicalSource(s.source || 'frwhoop')) continue;
    const identifier = syncIdentifier('sleep', s.id);
    const link = linkByCanonical.get(`sleep:${s.id}`);
    const fingerprint = exportFingerprint(s);
    const changed = Boolean(link?.payload?.fingerprint && link.payload.fingerprint !== fingerprint);
    writes.push({
      kind: 'sleep',
      canonical_id: s.id,
      sync_identifier: identifier,
      sync_version: nextSyncVersion(link?.sync_version, changed),
      start: s.start_at,
      end: s.end_at,
      stages: s.summary?.stages || s.segments || [],
      fingerprint,
    });
  }

  for (const v of vitals) {
    if (v.value == null || !Number.isFinite(Number(v.value))) continue;
    const id = v.id || `${v.metric}:${v.day}`;
    writes.push({
      kind: 'vital',
      metric: v.metric,
      canonical_id: id,
      sync_identifier: syncIdentifier(`vital:${v.metric}`, v.day || id),
      sync_version: nextSyncVersion(v.sync_version, Boolean(v.changed)),
      at: v.at,
      day: v.day,
      value: v.value,
      unit: v.unit,
    });
  }

  return { writes, skipped };
}

/**
 * Pure ingest. Callers persist the returned rows.
 */
export function ingestHealthKit({
  userId,
  payload = {},
  existingSessions = [],
  existingLinks = [],
  ingestedAt = new Date().toISOString(),
} = {}) {
  const measurements = [];
  const rejected = [];
  const appleWatchStepSamples = [];
  const seenStepUuids = new Set();
  for (const raw of payload.samples || []) {
    const sample = normalizeMeasurement(raw, ingestedAt);
    if (!sample.rejected && !sample.original_sample_id) {
      sample.rejected = true;
      sample.reject_reason = 'missing_external_id';
    }
    if (!sample.rejected && isStepMetric(sample.metric_type)) {
      const watchReason = validateAppleWatchStepSample(sample);
      if (watchReason) {
        sample.rejected = true;
        sample.reject_reason = watchReason;
      } else if (seenStepUuids.has(sample.original_sample_id)) {
        sample.rejected = true;
        sample.reject_reason = 'duplicate_healthkit_uuid';
      } else {
        sample.source = SOURCES.APPLE_WATCH_HEALTHKIT;
        seenStepUuids.add(sample.original_sample_id);
        appleWatchStepSamples.push(sample);
      }
    }
    if (sample.rejected) {
      rejected.push(sample);
      continue;
    }
    if (sample.source === SOURCES.FRWHOOP_DERIVED) continue;
    measurements.push(sample);
  }

  const incomingWorkouts = (payload.workouts || [])
    .map((w) => normalizeMeasurement({ ...w, metric_type: 'workout' }, ingestedAt))
    .filter((w) => {
      if (w.source === SOURCES.FRWHOOP_DERIVED) return false;
      if (!w.rejected && !w.original_sample_id) {
        w.rejected = true;
        w.reject_reason = 'missing_external_id';
      }
      if (w.rejected) {
        rejected.push(w);
        return false;
      }
      return true;
    })
    .map((w) => workoutFromHk(w, userId));

  const incomingSleep = (payload.sleep || [])
    .map((s) => normalizeMeasurement({ ...s, metric_type: 'sleep' }, ingestedAt))
    .filter((s) => {
      if (s.source === SOURCES.FRWHOOP_DERIVED) return false;
      if (!s.rejected && !s.original_sample_id) {
        s.rejected = true;
        s.reject_reason = 'missing_external_id';
      }
      if (s.rejected) {
        rejected.push(s);
        return false;
      }
      return true;
    })
    .map((s) => sleepFromHk(s, userId));

  const knownCanonicalW = canonicalWorkouts(existingSessions);
  const knownExternalW = [...externalWorkouts(existingSessions), ...incomingWorkouts];
  const workoutPairs = pairIntervals(
    knownCanonicalW.map(asSessionInterval),
    incomingWorkouts.map(asSessionInterval),
    classifyWorkoutMatch,
  );

  const sessionsToUpsert = [];
  const linksToUpsert = [...existingLinks];
  const matchedExternalIds = new Set();

  for (const pair of workoutPairs.pairs) {
    const relationship = workoutRelationship(pair.match);
    const canonicalId = pair.canonical.id;
    const ext = incomingWorkouts.find((w) => w.external_id === pair.external.external_id) || pair.external;
    matchedExternalIds.add(ext.external_id);
    linksToUpsert.push(linkRow({
      userId,
      canonicalKind: 'workout',
      canonicalId,
      external: ext,
      match: pair.match,
      confidence: pair.confidence,
      relationship,
    }));
    if (relationship === 'write' || relationship === 'comparison') {
      if (relationship === 'comparison') ext.summary = { ...ext.summary, role: 'external_comparison' };
      sessionsToUpsert.push(ext);
    }
  }
  for (const leftover of workoutPairs.unmatchedCanonical) {
    const covering = incomingWorkouts.find((w) => {
      const r = classifyWorkoutMatch(leftover, asSessionInterval(w));
      return r.match === 'same_workout' || r.match === 'likely_same_workout' || r.iou >= 0.3;
    });
    if (!covering) continue;
    linksToUpsert.push(linkRow({
      userId,
      canonicalKind: 'workout',
      canonicalId: leftover.id,
      external: covering,
      match: 'likely_same_workout',
      confidence: 0.6,
      relationship: 'skip_write',
    }));
  }
  for (const ext of workoutPairs.unmatchedExternal) {
    const row = incomingWorkouts.find((w) => w.external_id === ext.external_id) || ext;
    if (!row.summary) row.summary = {};
    row.summary.role = 'canonical_fallback';
    sessionsToUpsert.push(row);
  }

  const sleepPairs = pairIntervals(
    canonicalSleep(existingSessions).map(asSessionInterval),
    incomingSleep.map(asSessionInterval),
    classifySleepMatch,
  );
  for (const pair of sleepPairs.pairs) {
    const relationship = sleepRelationship(pair.match);
    const ext = incomingSleep.find((s) => s.external_id === pair.external.external_id) || pair.external;
    ext.summary = { ...ext.summary, role: 'external_comparison' };
    linksToUpsert.push(linkRow({
      userId,
      canonicalKind: 'sleep',
      canonicalId: pair.canonical.id,
      external: ext,
      match: pair.match,
      confidence: pair.confidence,
      relationship,
    }));
    sessionsToUpsert.push(ext);
  }
  for (const ext of sleepPairs.unmatchedExternal) {
    const row = incomingSleep.find((s) => s.external_id === ext.external_id) || ext;
    row.summary = { ...row.summary, role: 'fallback' };
    sessionsToUpsert.push(row);
  }

  const daily = dailyFromSummaries(payload.daily || payload.summaries || [], ingestedAt, rejected);
  const appleWatchStepBuckets = buildAppleWatchStepBuckets(appleWatchStepSamples, userId);

  const weightRows = measurements
    .filter((m) => m.metric_type === 'weight' || m.metric_type === 'bodyMass')
    .map((m) => ({
      user_id: userId,
      measured_at: m.timestamp,
      weight_kg: m.value,
      source: m.source,
      quality: m.quality_flags.includes('out_of_range') ? 'doubtful' : 'ok',
      note: m.original_sample_id,
    }));
  for (const m of weightRows) {
    const day = String(m.measured_at || '').slice(0, 10);
    if (!day) continue;
    const bucket = daily[day] || { day, sources: {} };
    if (bucket.weight_kg == null) {
      bucket.weight_kg = m.weight_kg;
      bucket.weight_source = m.source;
      bucket.sources = { ...(bucket.sources || {}), weight: m.source };
      daily[day] = bucket;
    }
  }

  const dailyVitals = new Map();
  for (const m of measurements.filter((m) => ['hrv', 'respiratory_rate', 'resting_heart_rate'].includes(m.metric_type))) {
    const day = String(
      m.metric_type === 'resting_heart_rate'
        ? (m.end_time || m.start_time || '')
        : (m.start_time || ''),
    ).slice(0, 10);
    const value = Number(m.value);
    if (!day || !Number.isFinite(value)) continue;
    const key = `${day}:${m.metric_type}`;
    dailyVitals.set(key, [...(dailyVitals.get(key) || []), value]);
  }
  for (const [key, values] of dailyVitals) {
    values.sort((a, b) => a - b);
    const [day, metric] = key.split(':');
    const bucket = daily[day] || { day, sources: {} };
    const mid = values.length >> 1;
    const value = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    if (metric === 'hrv') {
      bucket.hrv_sdnn = value;
      bucket.hrv_source = SOURCES.APPLE_WATCH_HEALTHKIT;
    } else if (metric === 'resting_heart_rate') {
      bucket.resting_hr = value;
      bucket.rhr_source = SOURCES.APPLE_WATCH_HEALTHKIT;
    } else {
      bucket.resp_rate = value;
      bucket.resp_source = SOURCES.APPLE_WATCH_HEALTHKIT;
    }
    bucket.sources[metric] = SOURCES.APPLE_WATCH_HEALTHKIT;
    daily[day] = bucket;
  }

  const nutritionByDay = {};
  for (const m of measurements.filter((m) => String(m.metric_type || '').startsWith('dietary') || m.metric_type === 'nutrition')) {
    const day = String(m.start_time || '').slice(0, 10);
    if (!day) continue;
    const row = nutritionByDay[day] || {
      user_id: userId, day, source: m.source, intake_kcal: 0, protein_kcal: 0, carbs_kcal: 0, fat_kcal: 0,
    };
    if (m.metric_type === 'dietaryEnergyConsumed' || m.metric_type === 'nutrition') row.intake_kcal += Number(m.value) || 0;
    if (m.metric_type === 'dietaryProtein') row.protein_kcal += Number(m.value) || 0;
    if (m.metric_type === 'dietaryCarbohydrates') row.carbs_kcal += Number(m.value) || 0;
    if (m.metric_type === 'dietaryFatTotal') row.fat_kcal += Number(m.value) || 0;
    nutritionByDay[day] = row;
  }

  const exportPlan = buildExportPlan({
    canonicalWorkouts: knownCanonicalW,
    canonicalSleep: canonicalSleep(existingSessions),
    vitals: payload.vitals || [],
    links: linksToUpsert,
  });

  return {
    measurements: measurements.map((m) => ({
      user_id: userId,
      metric_type: m.metric_type,
      measured_at: m.timestamp,
      value: m.value,
      unit: m.unit,
      source: m.source,
      source_system: m.source,
      external_id: m.original_sample_id,
      quality: m.quality,
      metadata: {
        source_app: m.source_app,
        source_bundle: m.source_bundle,
        source_device: m.source_device,
        device_model: m.device_model,
        source_revision: m.source_revision,
        source_revision_provenance: m.source_revision_provenance,
        device_provenance: m.device_provenance,
        sample_kind: m.sample_kind,
        start_time: m.start_time,
        end_time: m.end_time,
        ingested_at: m.ingested_at,
        quality_flags: m.quality_flags,
        hk_metadata: m.metadata,
      },
    })),
    sessions: sessionsToUpsert,
    links: dedupeLinks(linksToUpsert),
    daily,
    weightRows,
    nutritionRows: Object.values(nutritionByDay),
    appleWatchStepBuckets,
    rejected,
    exportPlan,
    matchedExternalIds: [...matchedExternalIds],
  };
}

function dedupeLinks(links) {
  const map = new Map();
  for (const link of links) {
    const key = `${link.user_id}|${link.external_source}|${link.external_id}`;
    map.set(key, link);
  }
  return [...map.values()];
}

export function primaryWorkouts(sessions = []) {
  return sessions.filter((s) => {
    if (!/workout/i.test(String(s.kind || ''))) return false;
    const role = s.summary?.role;
    if (role === 'external_comparison' || role === 'external') return false;
    return true;
  });
}

export function primarySleep(sessions = []) {
  return sessions.filter((s) => {
    if (!/sleep|nap/i.test(String(s.kind || ''))) return false;
    const role = s.summary?.role;
    if (role === 'external_comparison') return false;
    return isCanonicalSource(s.source || 'frwhoop') || role === 'fallback';
  });
}
