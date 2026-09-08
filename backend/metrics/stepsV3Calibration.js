/**
 * Deterministic FRWHOOP Steps V3 Apple Watch agreement calibration.
 *
 * This module is deliberately not imported by the metrics engine. It produces
 * shadow calibration artifacts only; neither Watch references nor the v18
 * fallback can become canonical steps through this code.
 */
import { createHash } from 'node:crypto';
import { stepsV3ArtifactSha, validateStepsV3Artifact } from './stepsV3.js';

export const STEPS_V3_CALIBRATION_SCHEMA = 'frwhoop_steps_v3_watch_calibration_v1';
export const STEPS_V18_FALLBACK_SCHEMA = 'frwhoop_steps_v18_fallback_v1';
export const WATCH_REFERENCE_ROLE = 'agreement_reference_not_ground_truth';

const MINUTE_MS = 60_000;
const FIVE_MINUTE_MS = 300_000;
const EPSILON = 1e-12;

export const DEFAULT_SPLIT_GATES = Object.freeze({
  min_total_days: 10,
  min_train_days: 6,
  min_validation_days: 2,
  min_test_days: 2,
});

export const DEFAULT_WATCH_GATES = Object.freeze({
  ...DEFAULT_SPLIT_GATES,
  min_reference_seconds_per_day: 3_600,
  min_reference_buckets_per_day: 12,
  min_window_reference_coverage: 0.8,
});

export const DEFAULT_V18_GATES = Object.freeze({
  ...DEFAULT_SPLIT_GATES,
  min_reference_minutes_per_day: 30,
  min_feature_coverage: 0.8,
  min_gate_coverage: 0.8,
});

const CALIBRATION_GRID_KEYS = new Set([
  'thresholds',
  'smoothing',
  'peak_min_amplitude',
  'peak_min_prominence',
  'peak_refractory_s',
  'min_bout_events',
  'max_bout_gap_s',
  'interval_cv_max',
]);

const DEFAULT_CALIBRATION_GRID = Object.freeze({
  thresholds: [0.35, 0.45, 0.5, 0.55, 0.65],
  smoothing: [
    { type: 'none' },
    { type: 'hysteresis', enter_offset: 0.05, exit_offset: 0.05 },
    { type: 'hysteresis', enter_offset: 0.1, exit_offset: 0.1 },
  ],
  peak_min_amplitude: [0, 0.05, 0.1],
  peak_min_prominence: [0],
  peak_refractory_s: [0.25, 0.32],
  min_bout_events: [2, 4],
  max_bout_gap_s: [1.2, 1.8],
  interval_cv_max: [1],
});

function finite(value) {
  return value != null && value !== '' && Number.isFinite(Number(value));
}

function numeric(value, fallback = null) {
  return finite(value) ? Number(value) : fallback;
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function round(value, places = 10) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return typeof value === 'number' ? round(value, 12) : value;
}

export function stableArtifactSha256(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function parseTime(value) {
  if (finite(value)) {
    const n = Number(value);
    return n > 1e12 ? n : n * 1000;
  }
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function startTime(row) {
  return parseTime(
    row?.start_ms ?? row?.start_at ?? row?.bucket_start ?? row?.start
      ?? row?.timestamp_ms ?? row?.timestamp ?? row?.t ?? row?.datetime ?? row?.at,
  );
}

function dayKey(row, timeMs = startTime(row)) {
  const explicit = row?.day ?? row?.day_key ?? row?.local_day;
  if (typeof explicit === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  return Number.isFinite(timeMs) ? new Date(timeMs).toISOString().slice(0, 10) : null;
}

function hasExplicitDay(row) {
  const value = row?.day ?? row?.day_key ?? row?.local_day;
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function dayAttribution(rows = []) {
  const valid = rows.filter((row) => Number.isFinite(startTime(row)));
  const explicit = valid.filter(hasExplicitDay).length;
  if (valid.length > 0 && explicit === valid.length) {
    return {
      strategy: 'caller_supplied_local_day',
      local_chronological_split: true,
      explicit_rows: explicit,
      utc_fallback_rows: 0,
      limitation: null,
    };
  }
  return {
    strategy: explicit > 0 ? 'mixed_explicit_and_utc_fallback' : 'utc_date_fallback',
    local_chronological_split: false,
    explicit_rows: explicit,
    utc_fallback_rows: valid.length - explicit,
    limitation: 'Rows without day/day_key/local_day are grouped by UTC date; UTC splitting is not a local-day chronological split.',
  };
}

function isSynthetic(row) {
  return row?.synthetic === true
    || row?.label_source === 'synthetic'
    || row?.source === 'synthetic'
    || row?.metadata?.synthetic === true
    || row?.metadata?.label_source === 'synthetic';
}

function intervalOverlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function mergeIntervals(intervals) {
  const ordered = intervals
    .filter((row) => Number.isFinite(row.start) && Number.isFinite(row.end) && row.end > row.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const interval of ordered) {
    const prior = merged.at(-1);
    if (prior && interval.start <= prior.end) prior.end = Math.max(prior.end, interval.end);
    else merged.push({ start: interval.start, end: interval.end });
  }
  return merged;
}

function unionDuration(intervals) {
  return mergeIntervals(intervals).reduce((sum, row) => sum + row.end - row.start, 0);
}

function splitFailure(reason, days, counts) {
  return {
    status: 'insufficient_data',
    reason,
    days,
    counts,
    train: [],
    validation: [],
    test: [],
  };
}

/**
 * Split complete calendar days by ordered cut points. No row-level random
 * partitioning is allowed, so one day can never leak across partitions.
 */
export function chronologicalDaySplit(dayValues = [], gates = {}) {
  const policy = { ...DEFAULT_SPLIT_GATES, ...gates };
  const days = [...new Set(dayValues.filter((day) => typeof day === 'string'))].sort();
  const trainCount = Math.floor(days.length * 0.6);
  const validationEnd = Math.floor(days.length * 0.8);
  const validationCount = validationEnd - trainCount;
  const testCount = days.length - validationEnd;
  const counts = {
    total: days.length,
    train: trainCount,
    validation: validationCount,
    test: testCount,
  };
  if (days.length < policy.min_total_days) {
    return splitFailure('minimum_total_days_not_met', days, counts);
  }
  if (trainCount < policy.min_train_days) {
    return splitFailure('minimum_train_days_not_met', days, counts);
  }
  if (validationCount < policy.min_validation_days) {
    return splitFailure('minimum_validation_days_not_met', days, counts);
  }
  if (testCount < policy.min_test_days) {
    return splitFailure('minimum_test_days_not_met', days, counts);
  }
  const train = days.slice(0, trainCount);
  const validation = days.slice(trainCount, validationEnd);
  const testDays = days.slice(validationEnd);
  return {
    status: 'ok',
    reason: null,
    ratios: { train: 0.6, validation: 0.2, test: 0.2 },
    counts,
    train,
    validation,
    test: testDays,
    boundaries: {
      train_start: train[0],
      train_end: train.at(-1),
      validation_start: validation[0],
      validation_end: validation.at(-1),
      test_start: testDays[0],
      test_end: testDays.at(-1),
    },
    leakage_check: {
      disjoint: new Set([...train, ...validation, ...testDays]).size === days.length,
      chronological: train.at(-1) < validation[0] && validation.at(-1) < testDays[0],
    },
  };
}

function normalizeWatchBuckets(rows = []) {
  const deduped = new Map();
  let excludedSynthetic = 0;
  let invalid = 0;
  for (const row of rows) {
    if (isSynthetic(row)) {
      excludedSynthetic += 1;
      continue;
    }
    const start = startTime(row);
    const size = numeric(row?.bucket_size_seconds ?? row?.bucket_seconds ?? row?.size_seconds);
    const count = numeric(row?.step_count ?? row?.count ?? row?.steps);
    if (!Number.isFinite(start) || ![60, 300].includes(size) || count == null || count < 0) {
      invalid += 1;
      continue;
    }
    const device = String(row?.device_fingerprint ?? row?.device_id ?? 'watch');
    const key = `${device}|${start}|${size}`;
    if (!deduped.has(key)) {
      deduped.set(key, {
        start,
        end: start + size * 1000,
        size,
        count,
        day: dayKey(row, start),
        device,
        allocated: row?.allocated !== false,
        coalesced: row?.coalesced === true,
        allocation_method: row?.allocation_method ?? null,
      });
    }
  }
  const buckets = [...deduped.values()].sort((a, b) => (
    a.start - b.start || a.size - b.size || a.device.localeCompare(b.device)
  ));
  return { buckets, excludedSynthetic, invalid };
}

function watchIndex(rows = []) {
  const normalized = normalizeWatchBuckets(rows);
  const minute = new Map();
  const fiveDirect = new Map();
  const devices = new Set();
  for (const bucket of normalized.buckets) {
    devices.add(bucket.device);
    const map = bucket.size === 60 ? minute : fiveDirect;
    const prior = map.get(bucket.start) || {
      start: bucket.start,
      end: bucket.end,
      count: 0,
      day: bucket.day,
      allocated: false,
      coalesced: false,
      sources: 0,
    };
    prior.count += bucket.count;
    prior.allocated ||= bucket.allocated;
    prior.coalesced ||= bucket.coalesced;
    prior.sources += 1;
    map.set(bucket.start, prior);
  }
  const five = new Map(fiveDirect);
  let derivedFiveMinute = 0;
  const groups = new Map();
  for (const bucket of minute.values()) {
    const start = Math.floor(bucket.start / FIVE_MINUTE_MS) * FIVE_MINUTE_MS;
    if (!groups.has(start)) groups.set(start, []);
    groups.get(start).push(bucket);
  }
  for (const [start, group] of groups) {
    if (five.has(start) || !group.length) continue;
    group.sort((a, b) => a.start - b.start);
    five.set(start, {
      start,
      end: start + FIVE_MINUTE_MS,
      count: group.reduce((sum, bucket) => sum + bucket.count, 0),
      day: group[0].day,
      allocated: group.some((bucket) => bucket.allocated),
      coalesced: group.some((bucket) => bucket.coalesced),
      sources: group.reduce((sum, bucket) => sum + bucket.sources, 0),
      derived_from_60s: true,
      observed_intervals: group.map((bucket) => ({ start: bucket.start, end: bucket.end })),
    });
    derivedFiveMinute += 1;
  }
  return {
    ...normalized,
    minute,
    five,
    fiveDirect,
    devices: [...devices].sort(),
    derivedFiveMinute,
  };
}

function predictionBucketIndex(rows = []) {
  const deduped = new Map();
  let invalid = 0;
  for (const row of rows) {
    if (isSynthetic(row)) continue;
    const start = startTime(row);
    const size = numeric(row?.bucket_size_seconds ?? row?.bucket_seconds ?? row?.size_seconds, 60);
    const count = numeric(row?.step_count ?? row?.count ?? row?.steps);
    if (!Number.isFinite(start) || ![60, 300].includes(size) || count == null || count < 0) {
      invalid += 1;
      continue;
    }
    const key = `${start}|${size}`;
    const prior = deduped.get(key);
    if (prior) {
      prior.count += count;
      prior.allocated ||= row?.allocated === true;
      prior.coalesced ||= row?.coalesced === true;
    } else {
      deduped.set(key, {
        start,
        end: start + size * 1000,
        size,
        count,
        day: dayKey(row, start),
        allocated: row?.allocated === true || !Number.isInteger(count),
        coalesced: row?.coalesced === true,
      });
    }
  }
  const buckets = [...deduped.values()].sort((a, b) => a.start - b.start || a.size - b.size);
  const minute = new Map(buckets.filter((row) => row.size === 60).map((row) => [row.start, row]));
  const five = new Map(buckets.filter((row) => row.size === 300).map((row) => [row.start, row]));
  return { buckets, minute, five, invalid };
}

function normalizeReferenceCoverage(rows = []) {
  return rows.map((row) => {
    const start = startTime(row);
    const explicitEnd = parseTime(row?.end_ms ?? row?.end_at ?? row?.end);
    const size = numeric(row?.bucket_size_seconds ?? row?.bucket_seconds ?? row?.size_seconds);
    const end = Number.isFinite(explicitEnd)
      ? explicitEnd
      : (Number.isFinite(start) && size > 0 ? start + size * 1000 : null);
    return { start, end, day: dayKey(row, start) };
  }).filter((row) => Number.isFinite(row.start) && Number.isFinite(row.end) && row.end > row.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function intervalFullyCovered(start, end, intervals) {
  const overlaps = intervals.flatMap((interval) => {
    const overlap = intervalOverlap(start, end, interval.start, interval.end);
    return overlap > 0
      ? [{ start: Math.max(start, interval.start), end: Math.min(end, interval.end) }]
      : [];
  });
  return unionDuration(overlaps) >= end - start - 1;
}

function normalizeWindows(rows = []) {
  let excludedSynthetic = 0;
  let invalid = 0;
  const windows = [];
  for (const row of rows) {
    if (isSynthetic(row)) {
      excludedSynthetic += 1;
      continue;
    }
    const start = startTime(row);
    const explicitEnd = parseTime(row?.end_ms ?? row?.end_at ?? row?.end);
    const duration = numeric(row?.duration_seconds ?? row?.window_seconds);
    const end = Number.isFinite(explicitEnd)
      ? explicitEnd
      : (Number.isFinite(start) && duration > 0 ? start + duration * 1000 : null);
    const probability = numeric(row?.probability ?? row?.gait_probability ?? row?.p);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start
        || probability == null || probability < 0 || probability > 1) {
      invalid += 1;
      continue;
    }
    windows.push({
      start,
      end,
      day: dayKey(row, start),
      probability,
      public_model_sha256: row?.public_model_sha256 ?? row?.model_sha256 ?? null,
    });
  }
  windows.sort((a, b) => a.start - b.start || a.end - b.end || a.probability - b.probability);
  return { windows, excludedSynthetic, invalid };
}

function normalizeEvents(rows = []) {
  let excludedSynthetic = 0;
  let invalid = 0;
  let duplicates = 0;
  const events = [];
  for (const row of rows) {
    if (isSynthetic(row)) {
      excludedSynthetic += 1;
      continue;
    }
    const timestamp = startTime(row);
    if (!Number.isFinite(timestamp)) {
      invalid += 1;
      continue;
    }
    events.push({
      timestamp,
      day: dayKey(row, timestamp),
      amplitude: numeric(row?.amplitude ?? row?.peak_g ?? row?.peak_height, Number.POSITIVE_INFINITY),
      prominence: numeric(row?.prominence ?? row?.peak_prominence, Number.POSITIVE_INFINITY),
      public_model_sha256: row?.public_model_sha256 ?? row?.model_sha256 ?? null,
    });
  }
  events.sort((a, b) => a.timestamp - b.timestamp
    || b.prominence - a.prominence || b.amplitude - a.amplitude);
  const unique = events.filter((event, index) => {
    if (index > 0 && event.timestamp === events[index - 1].timestamp) {
      duplicates += 1;
      return false;
    }
    return true;
  });
  return {
    events: unique,
    excludedSynthetic,
    invalid,
    duplicates,
  };
}

function eventsInBucket(events, start, end) {
  let count = 0;
  for (const event of events) {
    if (event.timestamp >= end) break;
    if (event.timestamp >= start) count += 1;
  }
  return count;
}

function referenceCountForInterval(index, start, end) {
  let count = 0;
  let overlapMs = 0;
  for (const bucket of index.minute.values()) {
    const overlap = intervalOverlap(start, end, bucket.start, bucket.end);
    if (overlap > 0) {
      count += bucket.count * overlap / (bucket.end - bucket.start);
      overlapMs += overlap;
    }
  }
  if (overlapMs > 0) return { count, overlap_ms: Math.min(end - start, overlapMs) };
  // Only direct 300s references may be fractionally projected into a window.
  // A derived sparse 300s aggregate must not smear positive 60s samples into
  // neighboring minutes and fabricate reference activity.
  for (const bucket of index.fiveDirect.values()) {
    const overlap = intervalOverlap(start, end, bucket.start, bucket.end);
    if (overlap > 0) {
      count += bucket.count * overlap / (bucket.end - bucket.start);
      overlapMs += overlap;
    }
  }
  return { count, overlap_ms: Math.min(end - start, overlapMs) };
}

function metricSummary(errors) {
  return {
    mae: errors.length ? round(errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length) : null,
    signed_bias: errors.length ? round(errors.reduce((sum, value) => sum + value, 0) / errors.length) : null,
    buckets: errors.length,
  };
}

function predictionCountForInterval(events, prediction, start, end, useBuckets) {
  if (!useBuckets) return eventsInBucket(events, start, end);
  let count = 0;
  let minuteOverlap = 0;
  for (const bucket of prediction.minute.values()) {
    const overlap = intervalOverlap(start, end, bucket.start, bucket.end);
    if (overlap > 0) {
      count += bucket.count * overlap / (bucket.end - bucket.start);
      minuteOverlap += overlap;
    }
  }
  if (minuteOverlap > 0) return count;
  for (const bucket of prediction.five.values()) {
    const overlap = intervalOverlap(start, end, bucket.start, bucket.end);
    if (overlap > 0) count += bucket.count * overlap / (bucket.end - bucket.start);
  }
  return count;
}

function predictionCountForReference(events, prediction, reference, useBuckets) {
  const intervals = reference.observed_intervals || [{
    start: reference.start,
    end: reference.end,
  }];
  return intervals.reduce((sum, interval) => sum + predictionCountForInterval(
    events,
    prediction,
    interval.start,
    interval.end,
    useBuckets,
  ), 0);
}

/**
 * Agreement metrics against Apple Watch fractional buckets. The output never
 * calls Watch accuracy or ground truth. Callers may provide either timestamped
 * V3 events or v1/v2/v3 count buckets. If no explicit local day is supplied,
 * rows fall back to UTC date and the limitation is reported in day_attribution.
 */
export function computeWatchAgreementMetrics({
  predictionEvents = [],
  predictionBuckets = null,
  predictionWindows = [],
  watchBuckets = [],
  referenceCoverage = [],
  days = null,
  referenceActiveThreshold = 0,
} = {}) {
  const index = watchIndex(watchBuckets);
  const useBuckets = Array.isArray(predictionBuckets);
  const prediction = predictionBucketIndex(predictionBuckets || []);
  const coverageIntervals = normalizeReferenceCoverage(referenceCoverage)
    .filter((row) => !days || new Set(days).has(row.day));
  const allowed = days ? new Set(days) : null;
  const events = normalizeEvents(predictionEvents).events
    .filter((event) => !allowed || allowed.has(event.day));
  const windows = predictionWindows
    .map((window) => ({
      start: startTime(window),
      end: parseTime(window?.end_ms ?? window?.end_at ?? window?.end),
      accepted: window?.accepted === true,
      day: dayKey(window),
    }))
    .filter((window) => Number.isFinite(window.start) && Number.isFinite(window.end)
      && window.end > window.start && (!allowed || allowed.has(window.day)))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const minuteErrors = [];
  for (const bucket of [...index.minute.values()].sort((a, b) => a.start - b.start)) {
    if (allowed && !allowed.has(bucket.day)) continue;
    minuteErrors.push(
      predictionCountForReference(events, prediction, bucket, useBuckets) - bucket.count,
    );
  }
  const fiveErrors = [];
  for (const bucket of [...index.five.values()].sort((a, b) => a.start - b.start)) {
    if (allowed && !allowed.has(bucket.day)) continue;
    fiveErrors.push(
      predictionCountForReference(events, prediction, bucket, useBuckets) - bucket.count,
    );
  }

  const zeroIntervals = index.buckets
    .filter((bucket) => bucket.count <= referenceActiveThreshold)
    .filter((bucket) => !allowed || allowed.has(bucket.day))
    .map((bucket) => ({ start: bucket.start, end: bucket.end, day: bucket.day }));
  const fpEvidenceIntervals = [...zeroIntervals, ...coverageIntervals];
  const fpAvailable = windows.length > 0 && fpEvidenceIntervals.some((interval) => (
    windows.some((window) => intervalOverlap(
      interval.start,
      interval.end,
      window.start,
      window.end,
    ) > 0)
  ));
  let fpWindows = fpAvailable ? 0 : null;
  let fnWindows = 0;
  let comparableWindows = 0;
  let fpComparableWindows = 0;
  let fnComparableWindows = 0;
  for (const window of windows) {
    const reference = referenceCountForInterval(index, window.start, window.end);
    const active = reference.count > referenceActiveThreshold;
    if (active) {
      comparableWindows += 1;
      fnComparableWindows += 1;
      if (!window.accepted) fnWindows += 1;
      continue;
    }
    if (fpAvailable && intervalFullyCovered(window.start, window.end, fpEvidenceIntervals)) {
      comparableWindows += 1;
      fpComparableWindows += 1;
      if (window.accepted) fpWindows += 1;
    }
  }

  const referenceIntervals = [];
  const preferredIntervals = [];
  for (const bucket of index.minute.values()) referenceIntervals.push(bucket);
  for (const bucket of index.five.values()) {
    referenceIntervals.push(bucket);
    if (index.fiveDirect.has(bucket.start)) preferredIntervals.push(bucket);
  }
  for (const bucket of index.minute.values()) {
    const coveredByDirect = [...index.fiveDirect.values()].some((five) => (
      bucket.start >= five.start && bucket.end <= five.end
    ));
    if (!coveredByDirect) preferredIntervals.push(bucket);
  }
  const byDay = new Map();
  for (const interval of preferredIntervals) {
    if (allowed && !allowed.has(interval.day)) continue;
    const row = byDay.get(interval.day) || { reference: 0, predicted: 0, intervals: [] };
    row.reference += interval.count;
    row.predicted += predictionCountForReference(events, prediction, interval, useBuckets);
    row.intervals.push({ start: interval.start, end: interval.end });
    byDay.set(interval.day, row);
  }
  const daily = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, row]) => ({
    day,
    predicted_count: row.predicted,
    watch_reference_count: round(row.reference),
    signed_bias: round(row.predicted - row.reference),
    reference_seconds: unionDuration(row.intervals) / 1000,
  }));
  const dailyBias = daily.map((row) => row.signed_bias);
  const referenceMs = unionDuration(referenceIntervals);
  const windowCoveredReferenceMs = unionDuration(referenceIntervals.flatMap((reference) => (
    windows
      .filter((window) => intervalOverlap(reference.start, reference.end, window.start, window.end) > 0)
      .map((window) => ({
        start: Math.max(reference.start, window.start),
        end: Math.min(reference.end, window.end),
      }))
  )));

  return {
    reference_role: WATCH_REFERENCE_ROLE,
    minute: metricSummary(minuteErrors),
    five_minute: metricSummary(fiveErrors),
    daily_signed_bias: {
      mean: dailyBias.length
        ? round(dailyBias.reduce((sum, value) => sum + value, 0) / dailyBias.length)
        : null,
      days: daily.length,
      by_day: daily,
      coverage_basis: 'observed_watch_reference_intervals_only',
    },
    fp_windows: fpWindows,
    fp_windows_availability: {
      available: fpAvailable,
      reason: fpAvailable ? null : 'no_explicit_zero_reference_or_coverage',
      comparable_windows: fpComparableWindows,
    },
    fn_windows: fnWindows,
    fn_windows_availability: {
      available: fnComparableWindows > 0,
      reason: fnComparableWindows > 0 ? null : 'no_positive_reference_windows',
      comparable_windows: fnComparableWindows,
    },
    comparable_windows: comparableWindows,
    coverage: {
      reference_seconds: referenceMs / 1000,
      reference_days: new Set(referenceIntervals.map((row) => row.day)).size,
      native_60s_buckets: index.minute.size,
      direct_300s_buckets: index.fiveDirect.size,
      derived_300s_buckets: index.derivedFiveMinute,
      window_reference_coverage: referenceMs > 0
        ? round(Math.min(1, windowCoveredReferenceMs / referenceMs))
        : 0,
    },
    coalescing: {
      allocated_buckets: index.buckets.filter((bucket) => bucket.allocated).length,
      coalesced_buckets: index.buckets.filter((bucket) => bucket.coalesced).length,
      fractional_buckets: index.buckets.filter((bucket) => !Number.isInteger(bucket.count)).length,
      duplicate_rows_removed: Math.max(
        0,
        watchBuckets.length - index.excludedSynthetic - index.invalid - index.buckets.length,
      ),
      watch_devices: index.devices,
    },
    prediction: {
      mode: useBuckets ? 'count_buckets' : 'events',
      buckets: prediction.buckets.length,
      allocated_buckets: prediction.buckets.filter((bucket) => bucket.allocated).length,
      coalesced_buckets: prediction.buckets.filter((bucket) => bucket.coalesced).length,
      fractional_buckets: prediction.buckets.filter((bucket) => !Number.isInteger(bucket.count)).length,
      invalid_buckets: prediction.invalid,
    },
    day_attribution: dayAttribution([
      ...watchBuckets,
      ...predictionWindows,
      ...(predictionBuckets || []),
    ]),
    exclusions: {
      synthetic: index.excludedSynthetic,
      invalid: index.invalid,
    },
    primary_join: 'not_used_exact_minute_key_equality_is_visualization_only',
    visualization_only: true,
    fractional_allocation_is_estimate: true,
  };
}

export function isAppleWatchRawSample(sample = {}) {
  const metadata = sample.metadata || {};
  const evidence = [
    sample.source,
    sample.source_system,
    sample.source_bundle,
    metadata.source_device,
    metadata.device_model,
    metadata.source_app,
    sample.device_fingerprint,
    JSON.stringify(metadata.source_revision || sample.source_revision || {}),
  ].join(' ').toLowerCase();
  if (/\b(?:iphone|ipad|ipod)\b/.test(evidence)) return false;
  const kind = metadata.sample_kind || sample.sample_kind;
  if (kind && kind !== 'raw_quantity_sample') return false;
  return /watch/.test(evidence) || /apple_watch/.test(evidence);
}

export function normalizeWatchQuantitySamples(rows = []) {
  const samples = [];
  let rejectedIphone = 0;
  let rejectedMerged = 0;
  let invalid = 0;
  for (const row of rows) {
    const metadata = row.metadata || {};
    const start = Date.parse(
      metadata.start_time || row.start_time || row.startDate || row.start || '',
    );
    const end = Date.parse(
      metadata.end_time || row.end_time || row.endDate || row.end || '',
    );
    const count = Number(row.value ?? row.step_count ?? row.count);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start
        || !Number.isFinite(count) || count < 0) {
      invalid += 1;
      continue;
    }
    const kind = metadata.sample_kind || row.sample_kind;
    if (kind && kind !== 'raw_quantity_sample') {
      rejectedMerged += 1;
      continue;
    }
    const sample = {
      uuid: row.external_id || row.original_sample_id || metadata.uuid || row.uuid || null,
      start,
      end,
      start_iso: new Date(start).toISOString(),
      end_iso: new Date(end).toISOString(),
      count,
      device_fingerprint: row.device_fingerprint || metadata.device_fingerprint || null,
      source: row.source || row.source_system || null,
      source_revision: metadata.source_revision || row.source_revision || null,
      coalesced: metadata.coalesced === true || row.coalesced === true,
      provenance: {
        source_revision: metadata.source_revision || row.source_revision || null,
        device: metadata.device_provenance || metadata.source_device || null,
        coalesced: metadata.coalesced === true || row.coalesced === true,
      },
    };
    if (!isAppleWatchRawSample({ ...row, metadata, sample_kind: kind })) {
      rejectedIphone += 1;
      continue;
    }
    samples.push(sample);
  }
  samples.sort((a, b) => a.start - b.start || a.end - b.end);
  return { samples, rejectedIphone, rejectedMerged, invalid };
}

function eventTimeMs(event) {
  if (Number.isFinite(event?.timestamp_ms)) return event.timestamp_ms;
  if (Number.isFinite(event?.t)) return event.t;
  const parsed = Date.parse(event?.timestamp || event?.start_at || '');
  return Number.isFinite(parsed) ? parsed : null;
}

export function countEventsInInterval(events, start, end) {
  return (events || []).filter((event) => {
    const time = eventTimeMs(event);
    return Number.isFinite(time) && time >= start && time < end;
  }).length;
}

export function computeWatchSampleIntervalMetrics({
  watchSamples = [],
  predictionEventsByAlgorithm = {},
  coverageIntervals = [],
} = {}) {
  const normalized = Array.isArray(watchSamples) && Number.isFinite(watchSamples[0]?.start)
    ? { samples: watchSamples, rejectedIphone: 0, rejectedMerged: 0, invalid: 0 }
    : normalizeWatchQuantitySamples(watchSamples);
  const algorithms = Object.keys(predictionEventsByAlgorithm);
  const rows = [];
  for (const sample of normalized.samples) {
    const covered = !coverageIntervals.length || coverageIntervals.some((interval) => (
      intervalOverlap(sample.start, sample.end, interval.start, interval.end) > 0
    ));
    if (!covered) continue;
    const row = {
      uuid: sample.uuid,
      start: sample.start_iso,
      end: sample.end_iso,
      watch_count: sample.count,
      coalesced: sample.coalesced,
      device_fingerprint: sample.device_fingerprint,
      source_revision: sample.source_revision,
    };
    for (const name of algorithms) {
      const events = predictionEventsByAlgorithm[name] || [];
      row[name] = countEventsInInterval(events, sample.start, sample.end);
      row[`${name}_error`] = row[name] - sample.count;
    }
    rows.push(row);
  }
  const byAlgorithm = {};
  for (const name of algorithms) {
    const errors = rows.map((row) => row[`${name}_error`]);
    const abs = errors.map((value) => Math.abs(value));
    byAlgorithm[name] = {
      samples: rows.length,
      mae: errors.length ? abs.reduce((sum, value) => sum + value, 0) / errors.length : null,
      signed_bias: errors.length
        ? errors.reduce((sum, value) => sum + value, 0) / errors.length
        : null,
      primary_join: 'raw_HKQuantitySample_interval_overlap',
      minute_key_equality_used: false,
      fractional_allocation_used: false,
    };
  }
  return {
    reference_role: WATCH_REFERENCE_ROLE,
    primary: true,
    visualization_buckets_are_estimates: true,
    apple_watch_is_not_ground_truth: true,
    comparable_samples: rows.length,
    rejected_iphone_or_ambiguous: normalized.rejectedIphone,
    rejected_merged_summaries: normalized.rejectedMerged,
    invalid_samples: normalized.invalid,
    by_algorithm: byAlgorithm,
    rows,
  };
}

function v18CounterDeltas(rows = []) {
  const ordered = rows
    .filter((row) => !isSynthetic(row) && v18Layout(row) === 'v18')
    .map((row) => ({ row, time: startTime(row) }))
    .filter(({ time }) => Number.isFinite(time))
    .sort((a, b) => a.time - b.time);
  const previous = new Map();
  const deltas = [];
  for (const item of ordered) {
    const key = String(item.row?.device_id ?? item.row?.deviceId ?? 'strap');
    const current = counterValue(item.row);
    let delta = explicitCounterDelta(item.row);
    if (delta == null && current != null && previous.has(key)) {
      const prior = previous.get(key);
      if (current >= prior) delta = current - prior;
      else if (prior >= 65_024) delta = current + 65_536 - prior;
      else delta = 0;
    }
    if (current != null) previous.set(key, current);
    if (delta != null && delta >= 0) {
      deltas.push({ time: item.time, delta, row: item.row });
    }
  }
  return deltas;
}

export function overlapV18WithWatchSamples(v18Rows = [], watchSamples = []) {
  const samples = Number.isFinite(watchSamples[0]?.start)
    ? watchSamples
    : normalizeWatchQuantitySamples(watchSamples).samples;
  const deltas = v18CounterDeltas(v18Rows);
  const rows = samples.map((sample) => {
    const predicted = deltas
      .filter((item) => item.time >= sample.start && item.time < sample.end)
      .reduce((sum, item) => sum + item.delta, 0);
    return {
      uuid: sample.uuid,
      start: sample.start_iso || new Date(sample.start).toISOString(),
      end: sample.end_iso || new Date(sample.end).toISOString(),
      watch_count: sample.count,
      v18_delta: predicted,
      error: predicted - sample.count,
    };
  });
  const errors = rows.map((row) => row.error);
  return {
    primary_join: 'v18_counter_delta_temporal_overlap_with_watch_interval',
    minute_key_equality_used: false,
    mixed_with_v3_imu_steps: false,
    samples: rows.length,
    mae: errors.length
      ? errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length
      : null,
    signed_bias: errors.length
      ? errors.reduce((sum, value) => sum + value, 0) / errors.length
      : null,
    rows,
  };
}

function eligibleWatchDays(index, windows, gates) {
  const days = [...new Set(index.buckets.map((bucket) => bucket.day))].filter(Boolean).sort();
  const eligible = [];
  const diagnostics = [];
  for (const day of days) {
    const references = index.buckets
      .filter((bucket) => bucket.day === day)
      .map((bucket) => ({ start: bucket.start, end: bucket.end }));
    const dayWindows = windows.filter((window) => window.day === day);
    const referenceMs = unionDuration(references);
    const coveredMs = unionDuration(references.flatMap((reference) => dayWindows
      .filter((window) => intervalOverlap(reference.start, reference.end, window.start, window.end) > 0)
      .map((window) => ({
        start: Math.max(reference.start, window.start),
        end: Math.min(reference.end, window.end),
      }))));
    const coverage = referenceMs > 0 ? Math.min(1, coveredMs / referenceMs) : 0;
    const bucketCount = index.buckets.filter((bucket) => bucket.day === day).length;
    let reason = null;
    if (referenceMs / 1000 < gates.min_reference_seconds_per_day) {
      reason = 'reference_seconds_below_minimum';
    } else if (bucketCount < gates.min_reference_buckets_per_day) {
      reason = 'reference_buckets_below_minimum';
    } else if (coverage < gates.min_window_reference_coverage) {
      reason = 'window_reference_coverage_below_minimum';
    }
    diagnostics.push({
      day,
      eligible: reason == null,
      reason,
      reference_seconds: referenceMs / 1000,
      reference_buckets: bucketCount,
      window_reference_coverage: round(coverage),
    });
    if (!reason) eligible.push(day);
  }
  return { eligible, diagnostics };
}

function smoothLabels(probabilities, smoothing, threshold) {
  if (smoothing.type === 'none') return probabilities.map((value) => value >= threshold);
  const enter = clamp(
    numeric(smoothing.enter, threshold + numeric(smoothing.enter_offset, 0)),
    0,
    1,
  );
  const exit = clamp(
    numeric(smoothing.exit, threshold - numeric(smoothing.exit_offset, 0)),
    0,
    enter,
  );
  let active = false;
  return probabilities.map((value) => {
    if (!active && value >= enter) active = true;
    else if (active && value < exit) active = false;
    return active;
  });
}

function coefficientOfVariation(values) {
  if (!values.length) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 0) return Number.POSITIVE_INFINITY;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function predictWithParams(windows, candidates, days, params, probabilityTransform = (value) => value) {
  const allowed = new Set(days);
  const selectedWindows = windows.filter((window) => allowed.has(window.day));
  const outputWindows = [];
  const acceptedIntervals = [];
  for (const day of days) {
    const dayWindows = selectedWindows.filter((window) => window.day === day);
    const probabilities = dayWindows.map((window) => clamp(probabilityTransform(window.probability), 0, 1));
    const labels = smoothLabels(probabilities, params.smoothing, params.threshold);
    dayWindows.forEach((window, index) => {
      outputWindows.push({
        start_ms: window.start,
        end_ms: window.end,
        accepted: labels[index],
        day,
      });
      if (labels[index]) acceptedIntervals.push({ start: window.start, end: window.end, day });
    });
  }
  const filtered = candidates.filter((event) => {
    if (!allowed.has(event.day)
        || event.amplitude < params.peak_min_amplitude
        || event.prominence < params.peak_min_prominence) return false;
    return acceptedIntervals.some((interval) => (
      interval.day === event.day && event.timestamp >= interval.start && event.timestamp < interval.end
    ));
  });
  const refractoryMs = params.peak_refractory_s * 1000;
  const refractory = [];
  for (const event of filtered) {
    if (!refractory.length || event.timestamp - refractory.at(-1).timestamp >= refractoryMs) {
      refractory.push(event);
    }
  }
  const credited = [];
  let run = [];
  const flush = () => {
    if (run.length >= params.min_bout_events) {
      const gaps = run.slice(1).map((event, index) => (
        (event.timestamp - run[index].timestamp) / 1000
      ));
      if (coefficientOfVariation(gaps) <= params.interval_cv_max) credited.push(...run);
    }
    run = [];
  };
  for (const event of refractory) {
    if (run.length && (event.day !== run.at(-1).day
      || event.timestamp - run.at(-1).timestamp > params.max_bout_gap_s * 1000)) flush();
    run.push(event);
  }
  flush();
  return {
    events: credited.map((event) => ({
      timestamp_ms: event.timestamp,
      timestamp: new Date(event.timestamp).toISOString(),
      day: event.day,
    })),
    windows: outputWindows,
  };
}

function normalizedSmoothing(value) {
  if (!value || value.type === 'none') return { type: 'none' };
  if (value.type !== 'hysteresis') return null;
  const output = { type: 'hysteresis' };
  for (const key of ['enter', 'exit', 'enter_offset', 'exit_offset']) {
    if (finite(value[key])) output[key] = Number(value[key]);
  }
  return output;
}

export function validateCalibrationGrid(grid = DEFAULT_CALIBRATION_GRID) {
  if (!grid || typeof grid !== 'object' || Array.isArray(grid)) {
    return { ok: false, reason: 'calibration_grid_invalid' };
  }
  const forbidden = Object.keys(grid).filter((key) => !CALIBRATION_GRID_KEYS.has(key));
  if (forbidden.length) {
    return { ok: false, reason: 'calibration_scope_violation', forbidden: forbidden.sort() };
  }
  const merged = { ...DEFAULT_CALIBRATION_GRID, ...grid };
  const positiveLists = [
    'thresholds', 'peak_min_amplitude', 'peak_min_prominence', 'peak_refractory_s',
    'min_bout_events', 'max_bout_gap_s', 'interval_cv_max',
  ];
  for (const key of positiveLists) {
    if (!Array.isArray(merged[key]) || !merged[key].length
      || !merged[key].every((value) => finite(value) && Number(value) >= 0)) {
      return { ok: false, reason: `calibration_grid_${key}_invalid` };
    }
  }
  if (merged.thresholds.some((value) => Number(value) <= 0 || Number(value) >= 1)
      || merged.peak_refractory_s.some((value) => Number(value) <= 0)
      || merged.min_bout_events.some((value) => !Number.isInteger(Number(value))
        || Number(value) < 1)
      || merged.max_bout_gap_s.some((value) => Number(value) <= 0)
      || merged.interval_cv_max.some((value) => Number(value) <= 0)
      || !Array.isArray(merged.smoothing) || !merged.smoothing.length) {
    return { ok: false, reason: 'calibration_grid_range_invalid' };
  }
  const smoothing = merged.smoothing.map(normalizedSmoothing);
  if (smoothing.some((value) => !value)) {
    return { ok: false, reason: 'calibration_grid_smoothing_invalid' };
  }
  return { ok: true, grid: { ...merged, smoothing } };
}

function parameterCandidates(grid) {
  const output = [];
  for (const threshold of grid.thresholds) {
    for (const smoothing of grid.smoothing) {
      for (const peakMinAmplitude of grid.peak_min_amplitude) {
        for (const peakMinProminence of grid.peak_min_prominence) {
          for (const peakRefractory of grid.peak_refractory_s) {
            for (const minBoutEvents of grid.min_bout_events) {
              for (const maxBoutGap of grid.max_bout_gap_s) {
                for (const intervalCvMax of grid.interval_cv_max) {
                  output.push({
                    threshold: Number(threshold),
                    smoothing,
                    peak_min_amplitude: Number(peakMinAmplitude),
                    peak_min_prominence: Number(peakMinProminence),
                    peak_refractory_s: Number(peakRefractory),
                    min_bout_events: Number(minBoutEvents),
                    max_bout_gap_s: Number(maxBoutGap),
                    interval_cv_max: Number(intervalCvMax),
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return output.sort((a, b) => JSON.stringify(stableValue(a)).localeCompare(JSON.stringify(stableValue(b))));
}

function agreementObjective(metrics) {
  const windowDisagreement = metrics.fn_windows
    + (Number.isFinite(metrics.fp_windows) ? metrics.fp_windows : 0);
  return [
    metrics.five_minute.mae ?? Number.POSITIVE_INFINITY,
    metrics.minute.mae ?? Number.POSITIVE_INFINITY,
    Math.abs(metrics.daily_signed_bias.mean ?? Number.POSITIVE_INFINITY),
    windowDisagreement,
  ];
}

function compareObjective(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (Math.abs(a[i] - b[i]) > EPSILON) return a[i] - b[i];
  }
  return 0;
}

function evaluateParameters(dataset, days, params, transform) {
  const prediction = predictWithParams(
    dataset.windows,
    dataset.events,
    days,
    params,
    transform,
  );
  const metrics = computeWatchAgreementMetrics({
    predictionEvents: prediction.events,
    predictionWindows: prediction.windows,
    watchBuckets: dataset.watchBuckets,
    referenceCoverage: dataset.referenceCoverage,
    days,
  });
  return { prediction, metrics, objective: agreementObjective(metrics) };
}

function logit(value) {
  const p = clamp(value, 1e-6, 1 - 1e-6);
  return Math.log(p / (1 - p));
}

function sigmoid(value) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function fitLearnedLogit(windows, watch, trainDays) {
  const allowed = new Set(trainDays);
  const rows = windows.filter((window) => allowed.has(window.day)).map((window) => {
    const reference = referenceCountForInterval(watch, window.start, window.end);
    return {
      x: logit(window.probability),
      y: reference.overlap_ms > 0 && reference.count > 0 ? 1 : 0,
      covered: reference.overlap_ms > 0,
    };
  }).filter((row) => row.covered);
  const positives = rows.filter((row) => row.y === 1).length;
  if (rows.length < 20 || positives === 0 || positives === rows.length) {
    return { ok: false, reason: 'insufficient_logit_training_labels', rows: rows.length, positives };
  }
  let slope = 1;
  let intercept = 0;
  const learningRate = 0.05;
  for (let iteration = 0; iteration < 500; iteration += 1) {
    let slopeGradient = 0;
    let interceptGradient = 0;
    for (const row of rows) {
      const error = sigmoid(slope * row.x + intercept) - row.y;
      slopeGradient += error * row.x;
      interceptGradient += error;
    }
    slope -= learningRate * (slopeGradient / rows.length + 0.001 * (slope - 1));
    intercept -= learningRate * interceptGradient / rows.length;
    slope = clamp(slope, 0, 10);
    intercept = clamp(intercept, -10, 10);
  }
  return {
    ok: true,
    slope: round(slope, 12),
    intercept: round(intercept, 12),
    training_rows: rows.length,
    positives,
  };
}

function primaryAgreement(metrics) {
  const values = [metrics?.five_minute?.mae, metrics?.minute?.mae]
    .filter((value) => Number.isFinite(value));
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/**
 * Select a learned probability calibration on validation only. The public
 * model itself is never rewritten, and the test partition is report-only.
 */
export function selectLearnedLogit({
  baselineValidation,
  learnedValidation,
} = {}) {
  const scores = {
    baseline_validation: primaryAgreement(baselineValidation),
    learned_validation: primaryAgreement(learnedValidation),
  };
  if (Object.values(scores).some((value) => !Number.isFinite(value))) {
    return { accepted: false, reason: 'insufficient_agreement_metrics', scores };
  }
  if (!(scores.learned_validation < scores.baseline_validation - EPSILON)) {
    return { accepted: false, reason: 'validation_agreement_not_improved', scores };
  }
  return { accepted: true, reason: null, scores };
}

function insufficientCalibration(reason, details = {}) {
  return {
    status: 'insufficient_data',
    reason,
    schema: STEPS_V3_CALIBRATION_SCHEMA,
    public_model_frozen: true,
    canonical: false,
    watch_reference_role: WATCH_REFERENCE_ROLE,
    ...details,
  };
}

/**
 * Calibrate postprocessing around frozen public-model probabilities and
 * permissive peak candidates.
 */
export function calibrateStepsV3WithWatch({
  publicModelArtifact = null,
  publicModelSha256 = null,
  windows: rawWindows = [],
  events: rawEvents = [],
  watchBuckets = [],
  referenceCoverage = [],
  gates = {},
  grid = DEFAULT_CALIBRATION_GRID,
  benchmarkLearnedLogit = false,
} = {}) {
  const watch = watchIndex(watchBuckets);
  const normalizedWindows = normalizeWindows(rawWindows);
  const normalizedEvents = normalizeEvents(rawEvents);
  if (publicModelArtifact) {
    const validation = validateStepsV3Artifact(publicModelArtifact);
    if (!validation.ok) {
      return insufficientCalibration('public_model_artifact_invalid', {
        artifact_validation_reason: validation.reason,
      });
    }
  }
  const resolvedModelSha = publicModelArtifact
    ? stepsV3ArtifactSha(publicModelArtifact)
    : publicModelSha256;
  if (!resolvedModelSha || !/^[a-f0-9]{64}$/i.test(resolvedModelSha)) {
    return insufficientCalibration('public_model_hash_missing');
  }
  if (publicModelArtifact && publicModelSha256
      && resolvedModelSha.toLowerCase() !== publicModelSha256.toLowerCase()) {
    return insufficientCalibration('public_model_hash_mismatch');
  }
  const frozenPredictions = [...normalizedWindows.windows, ...normalizedEvents.events];
  const stampedHashes = frozenPredictions.map((row) => row.public_model_sha256);
  if (stampedHashes.some((sha) => !/^[a-f0-9]{64}$/i.test(String(sha || '')))) {
    return insufficientCalibration('prediction_public_model_hash_missing');
  }
  if (stampedHashes.some((sha) => sha.toLowerCase() !== resolvedModelSha.toLowerCase())) {
    return insufficientCalibration('mixed_public_model_hashes');
  }
  if (!watch.buckets.length) {
    return insufficientCalibration('watch_reference_coverage_absent', {
      exclusions: { synthetic: watch.excludedSynthetic, invalid: watch.invalid },
    });
  }
  if (!normalizedWindows.windows.length || !normalizedEvents.events.length) {
    return insufficientCalibration('frozen_predictions_absent');
  }
  const gridValidation = validateCalibrationGrid(grid);
  if (!gridValidation.ok) {
    return {
      status: 'invalid_input',
      reason: gridValidation.reason,
      forbidden: gridValidation.forbidden,
      schema: STEPS_V3_CALIBRATION_SCHEMA,
      public_model_frozen: true,
      canonical: false,
      watch_reference_role: WATCH_REFERENCE_ROLE,
    };
  }
  const gatePolicy = { ...DEFAULT_WATCH_GATES, ...gates };
  const eligibility = eligibleWatchDays(watch, normalizedWindows.windows, gatePolicy);
  const split = chronologicalDaySplit(eligibility.eligible, gatePolicy);
  if (split.status !== 'ok') {
    return insufficientCalibration(split.reason, {
      split,
      coverage_by_day: eligibility.diagnostics,
      gates: gatePolicy,
      day_attribution: dayAttribution([...watchBuckets, ...rawWindows]),
    });
  }
  const dataset = {
    windows: normalizedWindows.windows,
    events: normalizedEvents.events,
    watchBuckets,
    referenceCoverage,
  };
  let best = null;
  let candidateCount = 0;
  for (const params of parameterCandidates(gridValidation.grid)) {
    const train = evaluateParameters(dataset, split.train, params);
    if (!Number.isFinite(train.objective[0]) && !Number.isFinite(train.objective[1])) continue;
    const validation = evaluateParameters(dataset, split.validation, params);
    candidateCount += 1;
    if (!best || compareObjective(validation.objective, best.validation.objective) < 0
        || (compareObjective(validation.objective, best.validation.objective) === 0
          && JSON.stringify(stableValue(params))
            .localeCompare(JSON.stringify(stableValue(best.params))) < 0)) {
      best = { params, train, validation };
    }
  }
  if (!best) {
    return insufficientCalibration('no_evaluable_parameter_candidate', {
      split,
      coverage_by_day: eligibility.diagnostics,
      gates: gatePolicy,
    });
  }

  let probabilityCalibration = { type: 'identity', selected: true };
  let learnedTransform = null;
  let logitBenchmark = {
    status: benchmarkLearnedLogit ? 'rejected' : 'not_benchmarked',
    accepted: false,
    reason: benchmarkLearnedLogit ? 'not_fitted' : 'disabled',
  };
  if (benchmarkLearnedLogit) {
    const fitted = fitLearnedLogit(normalizedWindows.windows, watch, split.train);
    if (!fitted.ok) {
      logitBenchmark = {
        status: 'rejected',
        accepted: false,
        reason: fitted.reason,
        training_rows: fitted.rows,
        positives: fitted.positives,
      };
    } else {
      const transform = (probability) => sigmoid(fitted.slope * logit(probability) + fitted.intercept);
      const learnedValidation = evaluateParameters(dataset, split.validation, best.params, transform);
      const selection = selectLearnedLogit({
        baselineValidation: best.validation.metrics,
        learnedValidation: learnedValidation.metrics,
      });
      logitBenchmark = {
        status: selection.accepted ? 'accepted' : 'rejected',
        accepted: selection.accepted,
        reason: selection.reason,
        model: {
          type: 'learned_logit',
          slope: fitted.slope,
          intercept: fitted.intercept,
          training_rows: fitted.training_rows,
          positives: fitted.positives,
        },
        validation: learnedValidation.metrics,
        selection_scores: selection.scores,
      };
      if (selection.accepted) {
        learnedTransform = transform;
        probabilityCalibration = {
          type: 'learned_logit',
          selected: true,
          slope: fitted.slope,
          intercept: fitted.intercept,
        };
      }
    }
  }
  // The held-out partition is evaluated once after every selection is fixed.
  const baselineTest = evaluateParameters(dataset, split.test, best.params);
  const learnedTest = learnedTransform
    ? evaluateParameters(dataset, split.test, best.params, learnedTransform)
    : null;
  const selectedTest = learnedTest || baselineTest;
  if (learnedTest) logitBenchmark.held_out_test = learnedTest.metrics;

  const postprocessing = {
    gait_probability_threshold: best.params.threshold,
    smoothing: best.params.smoothing,
    bout: {
      min_events: best.params.min_bout_events,
      max_gap_s: best.params.max_bout_gap_s,
      interval_cv_max: best.params.interval_cv_max,
    },
    peak_detector: {
      min_amplitude: best.params.peak_min_amplitude,
      min_prominence: best.params.peak_min_prominence,
      refractory_s: best.params.peak_refractory_s,
    },
  };
  const sourceSnapshot = {
    public_model_sha256: resolvedModelSha.toLowerCase(),
    windows: normalizedWindows.windows.map((row) => [row.start, row.end, row.probability]),
    events: normalizedEvents.events.map((row) => [row.timestamp, row.amplitude, row.prominence]),
    watch_buckets: watch.buckets.map((row) => [row.device, row.start, row.size, row.count]),
    reference_coverage: normalizeReferenceCoverage(referenceCoverage)
      .map((row) => [row.start, row.end, row.day]),
  };
  const splitDayAttribution = dayAttribution([...watchBuckets, ...rawWindows]);
  const artifactCore = {
    schema: STEPS_V3_CALIBRATION_SCHEMA,
    public_model_frozen: true,
    public_model_sha256: resolvedModelSha.toLowerCase(),
    canonical: false,
    watch_reference_role: WATCH_REFERENCE_ROLE,
    day_attribution: splitDayAttribution,
    split,
    gates: gatePolicy,
    calibrated_scope: [
      'gait_probability_threshold',
      'smoothing_hysteresis',
      'bout_parameters',
      'peak_detector_parameters',
    ],
    postprocessing,
    probability_calibration: probabilityCalibration,
    candidate_count: candidateCount,
    agreement: {
      train: best.train.metrics,
      validation: best.validation.metrics,
      held_out_test: selectedTest.metrics,
      baseline_held_out_test: baselineTest.metrics,
    },
    learned_logit_benchmark: logitBenchmark,
    diagnostics: {
      coverage_by_day: eligibility.diagnostics,
      synthetic_rows_excluded: watch.excludedSynthetic
        + normalizedWindows.excludedSynthetic + normalizedEvents.excludedSynthetic,
      invalid_rows_excluded: watch.invalid + normalizedWindows.invalid + normalizedEvents.invalid,
      duplicate_events_excluded: normalizedEvents.duplicates,
      coalescing: computeWatchAgreementMetrics({ watchBuckets }).coalescing,
    },
    provenance: {
      input_sha256: stableArtifactSha256(sourceSnapshot),
      generated_deterministically: true,
      dependencies: [],
    },
  };
  return {
    status: 'ok',
    reason: null,
    ...artifactCore,
    artifact_sha256: stableArtifactSha256(artifactCore),
  };
}

function v18Layout(row) {
  return String(row?.layout ?? row?.history_layout ?? row?.record_layout ?? '').toLowerCase();
}

function counterValue(row) {
  return numeric(row?.step_cumulative ?? row?.step_motion_counter ?? row?.stepCounter);
}

function explicitCounterDelta(row) {
  return numeric(row?.counter_delta ?? row?.step_delta ?? row?.steps);
}

function wearGate(row) {
  if (typeof row?.wear === 'boolean') return { pass: row.wear, observed: true };
  if (typeof row?.is_worn === 'boolean') return { pass: row.is_worn, observed: true };
  const value = numeric(row?.on_wrist ?? row?.onwrist ?? row?.wrist_on);
  if (value != null) return { pass: value > 0, observed: true };
  return { pass: true, observed: false };
}

function sleepGate(row) {
  if (typeof row?.sleep === 'boolean') return { sleeping: row.sleep, observed: true };
  if (typeof row?.is_sleep === 'boolean') return { sleeping: row.is_sleep, observed: true };
  const stage = String(row?.sleep_stage ?? row?.stage ?? '').toLowerCase();
  if (stage) return { sleeping: !['none', 'wake', 'awake'].includes(stage), observed: true };
  const value = numeric(row?.band_sleep_state ?? row?.sleep_state);
  if (value != null) return { sleeping: value > 0, observed: true };
  return { sleeping: false, observed: false };
}

function minuteReferenceRows(watch) {
  const output = new Map();
  for (const bucket of watch.minute.values()) {
    output.set(bucket.start, { target: bucket.count, source: 'watch_60s' });
  }
  for (const bucket of watch.fiveDirect.values()) {
    for (let index = 0; index < 5; index += 1) {
      const start = bucket.start + index * MINUTE_MS;
      if (!output.has(start)) {
        output.set(start, { target: bucket.count / 5, source: 'watch_300s_fractional' });
      }
    }
  }
  return output;
}

function normalizeV18MinuteRows(rows, references) {
  const ordered = rows
    .filter((row) => !isSynthetic(row))
    .map((row) => ({ row, time: startTime(row) }))
    .filter(({ time }) => Number.isFinite(time))
    .sort((a, b) => a.time - b.time
      || String(a.row?.device_id ?? '').localeCompare(String(b.row?.device_id ?? ''))
      || numeric(counterValue(a.row), -1) - numeric(counterValue(b.row), -1)
      || numeric(explicitCounterDelta(a.row), -1) - numeric(explicitCounterDelta(b.row), -1)
      || JSON.stringify(stableValue(a.row)).localeCompare(JSON.stringify(stableValue(b.row))));
  const minuteMap = new Map();
  const previousCounter = new Map();
  let nonV18Excluded = 0;
  let syntheticExcluded = rows.filter(isSynthetic).length;
  for (const item of ordered) {
    const row = item.row;
    if (v18Layout(row) !== 'v18') {
      nonV18Excluded += 1;
      continue;
    }
    const minute = Math.floor(item.time / MINUTE_MS) * MINUTE_MS;
    const key = `${row?.device_id ?? row?.deviceId ?? 'strap'}`;
    const currentCounter = counterValue(row);
    let delta = explicitCounterDelta(row);
    if (delta == null && currentCounter != null && previousCounter.has(key)) {
      const prior = previousCounter.get(key);
      if (currentCounter >= prior) delta = currentCounter - prior;
      else if (prior >= 65_024) delta = currentCounter + 65_536 - prior;
      else delta = 0;
    }
    if (currentCounter != null) previousCounter.set(key, currentCounter);
    const cadence = numeric(row?.step_cadence ?? row?.cadence);
    const activityClass = numeric(row?.activity_class);
    const dynAccel = numeric(row?.dyn_accel ?? row?.dynamic_acceleration);
    const wear = wearGate(row);
    const sleep = sleepGate(row);
    const aggregate = minuteMap.get(minute) || {
      start: minute,
      day: dayKey(row, minute),
      counter_delta: 0,
      counter_observed: 0,
      cadence_sum: 0,
      cadence_observed: 0,
      activity_sum: 0,
      activity_observed: 0,
      dyn_sum: 0,
      dyn_observed: 0,
      wear_pass: true,
      wear_observed: 0,
      sleeping: false,
      sleep_observed: 0,
      samples: 0,
    };
    aggregate.samples += 1;
    if (delta != null && delta >= 0) {
      aggregate.counter_delta += delta;
      aggregate.counter_observed += 1;
    }
    if (cadence != null && cadence >= 0) {
      aggregate.cadence_sum += cadence;
      aggregate.cadence_observed += 1;
    }
    if (activityClass != null && activityClass >= 0) {
      aggregate.activity_sum += activityClass;
      aggregate.activity_observed += 1;
    }
    if (dynAccel != null && dynAccel >= 0) {
      aggregate.dyn_sum += dynAccel;
      aggregate.dyn_observed += 1;
    }
    aggregate.wear_pass &&= wear.pass;
    aggregate.wear_observed += wear.observed ? 1 : 0;
    aggregate.sleeping ||= sleep.sleeping;
    aggregate.sleep_observed += sleep.observed ? 1 : 0;
    minuteMap.set(minute, aggregate);
  }
  const output = [];
  for (const aggregate of minuteMap.values()) {
    const reference = references.get(aggregate.start);
    if (!reference) continue;
    const availableFeatures = [
      aggregate.counter_observed,
      aggregate.cadence_observed,
      aggregate.activity_observed,
      aggregate.dyn_observed,
    ].filter((value) => value > 0).length;
    output.push({
      start: aggregate.start,
      day: aggregate.day,
      target: reference.target,
      reference_source: reference.source,
      gate: aggregate.wear_pass && !aggregate.sleeping ? 1 : 0,
      x: [
        aggregate.counter_delta,
        aggregate.cadence_observed ? aggregate.cadence_sum / aggregate.cadence_observed / 100 : 0,
        aggregate.activity_observed ? aggregate.activity_sum / aggregate.activity_observed / 2 : 0,
        aggregate.dyn_observed ? aggregate.dyn_sum / aggregate.dyn_observed / 0.1 : 0,
      ],
      feature_coverage: availableFeatures / 4,
      wear_gate_observed: aggregate.wear_observed > 0,
      sleep_gate_observed: aggregate.sleep_observed > 0,
    });
  }
  output.sort((a, b) => a.start - b.start);
  return { rows: output, nonV18Excluded, syntheticExcluded };
}

function fitNonnegativeLeastSquares(rows, ridge) {
  const coefficients = [0, 0, 0, 0];
  for (let iteration = 0; iteration < 500; iteration += 1) {
    let maxChange = 0;
    for (let feature = 0; feature < coefficients.length; feature += 1) {
      let numerator = 0;
      let denominator = ridge;
      for (const row of rows) {
        const x = row.x[feature] * row.gate;
        if (x === 0) continue;
        let without = 0;
        for (let other = 0; other < coefficients.length; other += 1) {
          if (other !== feature) without += coefficients[other] * row.x[other] * row.gate;
        }
        numerator += x * (row.target - without);
        denominator += x * x;
      }
      const next = denominator > 0 ? Math.max(0, numerator / denominator) : 0;
      maxChange = Math.max(maxChange, Math.abs(next - coefficients[feature]));
      coefficients[feature] = next;
    }
    if (maxChange < 1e-12) break;
  }
  return coefficients.map((value) => round(value, 12));
}

function countMetrics(rows, coefficients) {
  const errors = rows.map((row) => {
    const prediction = Math.max(
      0,
      row.gate * row.x.reduce((sum, value, index) => sum + value * coefficients[index], 0),
    );
    return prediction - row.target;
  });
  return {
    mae: errors.length
      ? round(errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length)
      : null,
    signed_bias: errors.length
      ? round(errors.reduce((sum, value) => sum + value, 0) / errors.length)
      : null,
    buckets: errors.length,
  };
}

function insufficientV18(reason, details = {}) {
  return {
    status: 'insufficient_data',
    reason,
    schema: STEPS_V18_FALLBACK_SCHEMA,
    applicability: 'v18_only',
    canonical: false,
    watch_reference_role: WATCH_REFERENCE_ROLE,
    ...details,
  };
}

/**
 * Fit a readable, nonnegative v18 count model. Coefficients are fit on train
 * only, ridge strength is selected on validation, and test is evaluated once.
 */
export function fitV18OnlyFallback({
  rows = [],
  watchBuckets = [],
  gates = {},
  ridgeCandidates = [0, 0.01, 0.1, 1],
} = {}) {
  const watch = watchIndex(watchBuckets);
  const splitDayAttribution = dayAttribution([...watchBuckets, ...rows]);
  if (!watch.buckets.length) return insufficientV18('watch_reference_coverage_absent');
  const references = minuteReferenceRows(watch);
  const normalized = normalizeV18MinuteRows(rows, references);
  if (!normalized.rows.length) {
    return insufficientV18('v18_reference_overlap_absent', {
      exclusions: {
        non_v18: normalized.nonV18Excluded,
        synthetic: normalized.syntheticExcluded,
      },
    });
  }
  const gatePolicy = { ...DEFAULT_V18_GATES, ...gates };
  const allDays = [...new Set(normalized.rows.map((row) => row.day))].sort();
  const coverageByDay = allDays.map((day) => {
    const dayRows = normalized.rows.filter((row) => row.day === day);
    const adequate = dayRows.filter((row) => row.feature_coverage >= gatePolicy.min_feature_coverage);
    const gated = dayRows.filter(
      (row) => row.wear_gate_observed && row.sleep_gate_observed,
    );
    let reason = null;
    if (dayRows.length < gatePolicy.min_reference_minutes_per_day) {
      reason = 'reference_minutes_below_minimum';
    } else if (adequate.length / dayRows.length < gatePolicy.min_feature_coverage) {
      reason = 'feature_coverage_below_minimum';
    } else if (gated.length / dayRows.length < gatePolicy.min_gate_coverage) {
      reason = 'wear_sleep_gate_coverage_below_minimum';
    }
    return {
      day,
      eligible: reason == null,
      reason,
      reference_minutes: dayRows.length,
      adequate_feature_minutes: adequate.length,
      feature_coverage: round(adequate.length / dayRows.length),
      wear_sleep_gate_minutes: gated.length,
      wear_sleep_gate_coverage: round(gated.length / dayRows.length),
    };
  });
  const eligibleDays = coverageByDay.filter((row) => row.eligible).map((row) => row.day);
  const split = chronologicalDaySplit(eligibleDays, gatePolicy);
  if (split.status !== 'ok') {
    return insufficientV18(split.reason, {
      split,
      coverage_by_day: coverageByDay,
      gates: gatePolicy,
      day_attribution: splitDayAttribution,
    });
  }
  const byDays = (days) => {
    const allowed = new Set(days);
    return normalized.rows.filter((row) => allowed.has(row.day)
      && row.feature_coverage >= gatePolicy.min_feature_coverage
      && row.wear_gate_observed
      && row.sleep_gate_observed);
  };
  const trainRows = byDays(split.train);
  const validationRows = byDays(split.validation);
  const testRows = byDays(split.test);
  if (!trainRows.length || !validationRows.length || !testRows.length) {
    return insufficientV18('split_feature_rows_absent', {
      split,
      coverage_by_day: coverageByDay,
      gates: gatePolicy,
    });
  }
  const ridges = [...new Set(ridgeCandidates.map(Number))]
    .filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!ridges.length) {
    return {
      status: 'invalid_input',
      reason: 'ridge_candidates_invalid',
      schema: STEPS_V18_FALLBACK_SCHEMA,
      applicability: 'v18_only',
      canonical: false,
      watch_reference_role: WATCH_REFERENCE_ROLE,
    };
  }
  let selected = null;
  for (const ridge of ridges) {
    const coefficients = fitNonnegativeLeastSquares(trainRows, ridge);
    const train = countMetrics(trainRows, coefficients);
    const validation = countMetrics(validationRows, coefficients);
    if (!selected || validation.mae < selected.validation.mae - EPSILON
      || (Math.abs(validation.mae - selected.validation.mae) <= EPSILON && ridge < selected.ridge)) {
      selected = { ridge, coefficients, train, validation };
    }
  }
  // Held-out test data is evaluated only after ridge selection is complete.
  const test = countMetrics(testRows, selected.coefficients);
  const coefficientNames = ['counter_delta', 'cadence', 'activity_class', 'dyn_accel'];
  const coefficientScales = [1, 100, 2, 0.1];
  const coefficients = Object.fromEntries(coefficientNames.map((name, index) => [
    name,
    {
      value: selected.coefficients[index],
      input_scale: coefficientScales[index],
      nonnegative: selected.coefficients[index] >= 0,
    },
  ]));
  const core = {
    schema: STEPS_V18_FALLBACK_SCHEMA,
    applicability: 'v18_only',
    canonical: false,
    watch_reference_role: WATCH_REFERENCE_ROLE,
    day_attribution: splitDayAttribution,
    model: {
      type: 'nonnegative_linear_count',
      intercept: 0,
      coefficients,
      wear_gate: 'prediction_zero_when_explicitly_not_worn',
      sleep_gate: 'prediction_zero_when_explicitly_sleeping',
      output_floor: 0,
      ridge: selected.ridge,
    },
    split,
    gates: gatePolicy,
    agreement: {
      train: selected.train,
      validation: selected.validation,
      held_out_test: test,
    },
    diagnostics: {
      coverage_by_day: coverageByDay,
      train_rows: trainRows.length,
      validation_rows: validationRows.length,
      test_rows: testRows.length,
      watch_300s_fractional_minutes: [...references.values()]
        .filter((row) => row.source === 'watch_300s_fractional').length,
      wear_gate_observed_rows: normalized.rows.filter((row) => row.wear_gate_observed).length,
      sleep_gate_observed_rows: normalized.rows.filter((row) => row.sleep_gate_observed).length,
      exclusions: {
        non_v18: normalized.nonV18Excluded,
        synthetic: normalized.syntheticExcluded,
      },
    },
    provenance: {
      input_sha256: stableArtifactSha256({
        rows: normalized.rows,
        watch: watch.buckets.map((row) => [row.device, row.start, row.size, row.count]),
      }),
      fitted_partitions: ['train'],
      selected_partitions: ['validation'],
      evaluated_partitions: ['test'],
      generated_deterministically: true,
      dependencies: [],
    },
  };
  return {
    status: 'ok',
    reason: null,
    ...core,
    artifact_sha256: stableArtifactSha256(core),
  };
}

export const _internal = {
  fitNonnegativeLeastSquares,
  normalizeEvents,
  normalizeV18MinuteRows,
  normalizeWatchBuckets,
  normalizeWindows,
  predictWithParams,
  watchIndex,
  v18CounterDeltas,
};
