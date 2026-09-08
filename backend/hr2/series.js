/**
 * The ONE 5-minute bucket implementation for the 24 h HR series.
 *
 * Single shared implementation for the live overlay, the live flush, and
 * historical recomputation (mission: "one shared bucket implementation used by
 * both live overlays and finalized historical recomputation"). The V1 split -
 * finalized buckets use a mean while the frontend overlay used the latest
 * sample - is intentionally eliminated.
 *
 * Bucket point contract (additive to the V1 hr_series point shape):
 *   { bucket_start, bucket_minutes, avg_hr, min_hr, max_hr,
 *     coverage_sec, n, n_total, quality, imputed }
 * Missing data stays missing: a bucket with no quality-passing observations is
 * ABSENT for HR (never zero-filled, never interpolated, never carried
 * forward); n_total records the refusal so abstention is observable.
 *
 * Time weighting: trapezoid over the quality-passing observations only. The
 * weight unit is the MEASURED spacing of the stream (median gap), so a covered
 * run claims n * spacing - exactly the time the stream demonstrably covered -
 * and coincident/coalesced samples cannot hand their whole weight to the last
 * arrival through the bucket edge (found by the real-data burst fixture).
 * Every weight is capped at HR2_CONFIG.WEIGHT_CAP_MS.
 */

import { HR2_CONFIG } from './version.js';

const MINUTE_MS = 60_000;

/** Median inter-arrival gap of a sorted timestamp list, or null. */
export function medianGapMs(ts) {
  const t = [...(ts || [])].sort((a, b) => a - b);
  if (t.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < t.length; i += 1) gaps.push(t[i] - t[i - 1]);
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

/**
 * Trapezoid weights for sorted in-bucket timestamps (ms).
 *
 * w_i = half the span to each temporal neighbor, with VIRTUAL neighbors at
 * spacing/2 beyond the first and last observation, so the weight sum is
 * n * spacing: exactly the time the stream demonstrably covered. Coincident
 * samples all keep ~equal weight (their spans are ~0 but the virtual edges
 * are spacing-based), so a burst of coalesced rows averages like a burst, not
 * like its last row. `opts.nowMs` bounds the last weight for live buckets.
 */
export function trapezoidWeights(times, bucketStartMs, bucketEndMs, capMs, opts = {}) {
  const m = times.length;
  const cap = capMs ?? HR2_CONFIG.WEIGHT_CAP_MS;
  if (m === 0) return [];
  const bucketLen = bucketEndMs - bucketStartMs;
  const spacing = opts.spacingMs
    ?? (m >= 2 ? (medianGapMs(times) ?? Math.max(bucketLen / m, 1)) : Math.max(bucketLen / 2, 1));
  const weights = new Array(m).fill(0);
  for (let i = 0; i < m; i += 1) {
    const left = i > 0 ? times[i - 1] : times[i] - spacing / 2;
    let right = i < m - 1 ? times[i + 1] : times[i] + spacing / 2;
    if (i === m - 1 && opts.nowMs != null) {
      // Live (partial) bucket: never claim beyond what has been observed.
      right = Math.min(right, Math.max(times[i], opts.nowMs));
    }
    let w = (right - left) / 2;
    if (!Number.isFinite(w) || w <= 0) w = 0;
    if (w > cap) w = cap;
    weights[i] = w;
  }
  return weights;
}

/**
 * Aggregate one bucket from quality-passing observations.
 *
 * @param {Array} passing canonical observations (need bpm, tMs, _quality.score), inside the bucket
 * @param {number} bucketStartMs
 * @param {number} bucketMinutes
 * @param {object} [opts] { nowMs, nTotal, spacingMs }
 */
export function accumulateBucketV2(passing, bucketStartMs, bucketMinutes, opts = {}) {
  const bucketMs = bucketMinutes * MINUTE_MS;
  const bucketEndMs = bucketStartMs + bucketMs;
  const times = passing.map((o) => o.tMs);
  const weights = trapezoidWeights(times, bucketStartMs, bucketEndMs, HR2_CONFIG.WEIGHT_CAP_MS, opts);
  let wsum = 0;
  let bpmSum = 0;
  let qSum = 0;
  let min = null;
  let max = null;
  for (let i = 0; i < passing.length; i += 1) {
    const o = passing[i];
    const w = weights[i];
    wsum += w;
    bpmSum += o.bpm * w;
    qSum += o._quality?.score ?? 1;
    if (min == null || o.bpm < min) min = o.bpm;
    if (max == null || o.bpm > max) max = o.bpm;
  }
  const avg = wsum > 0
    ? Math.round((bpmSum / wsum) * 10) / 10
    : (passing.length ? Math.round(passing[passing.length - 1].bpm * 10) / 10 : null);
  return {
    bucket_start: new Date(bucketStartMs).toISOString(),
    bucket_minutes: bucketMinutes,
    avg_hr: avg,
    min_hr: min,
    max_hr: max,
    coverage_sec: Math.round(Math.min(Math.max(wsum, 0), bucketMs) / 100) / 10,
    n: passing.length,
    n_total: opts.nTotal ?? passing.length,
    quality: passing.length ? Math.round((qSum / passing.length) * 100) / 100 : null,
    imputed: false,
  };
}

const ABSENT = (startIso, bucketMinutes, nTotal) => ({
  bucket_start: startIso,
  bucket_minutes: bucketMinutes,
  avg_hr: null,
  min_hr: null,
  max_hr: null,
  coverage_sec: 0,
  n: 0,
  n_total: nTotal,
  quality: null,
  imputed: false,
});

/**
 * Build the finalized day series.
 *
 * @param {Array} observations canonical observations, sorted ascending by tMs,
 *        each carrying `_quality` ({score,...}) from assessWindow.
 * @param {object} opts { bucketMinutes=5, qualityFloor }
 * @returns {{buckets: object[], coverage_hours_total: number}}
 */
export function buildDaySeries(observations, opts = {}) {
  const bucketMinutes = opts.bucketMinutes ?? 5;
  const bucketMs = bucketMinutes * MINUTE_MS;
  const qualityFloor = opts.qualityFloor ?? HR2_CONFIG.QUALITY_FLOOR;
  const obs = observations || [];

  const byBucket = new Map();
  for (const o of obs) {
    const start = Math.floor(o.tMs / bucketMs) * bucketMs;
    let cell = byBucket.get(start);
    if (!cell) {
      cell = { passing: [], nTotal: 0 };
      byBucket.set(start, cell);
    }
    cell.nTotal += 1;
    if (o.bpm != null && (o._quality?.score ?? 1) >= qualityFloor) cell.passing.push(o);
  }

  const buckets = [];
  let coveredMs = 0;
  for (const [start, cell] of [...byBucket.entries()].sort((a, b) => a[0] - b[0])) {
    if (cell.passing.length) {
      const row = accumulateBucketV2(cell.passing, start, bucketMinutes, { nTotal: cell.nTotal });
      buckets.push(row);
      coveredMs += Math.min(row.coverage_sec * 1000, bucketMs);
    } else {
      buckets.push(ABSENT(new Date(start).toISOString(), bucketMinutes, cell.nTotal));
    }
  }
  return {
    buckets,
    coverage_hours_total: Math.round((coveredMs / 3.6e6) * 100) / 100,
  };
}

/**
 * Partial (in-progress) bucket for the live path: identical math, but the last
 * observation never claims beyond `nowMs`, so an in-progress bucket never
 * claims coverage it has not measured. This is what the frontend overlay
 * computes to stay definition-equal with the finalized series.
 */
export function accumulatePartialBucket(observations, { bucketStartMs, bucketMinutes = 5, qualityFloor, nowMs }) {
  const qualityFloorEff = qualityFloor ?? HR2_CONFIG.QUALITY_FLOOR;
  const bucketMs = bucketMinutes * MINUTE_MS;
  const start = Math.floor(bucketStartMs / bucketMs) * bucketMs;
  const inBucket = (observations || []).filter((o) => (
    o.bpm != null && (o._quality?.score ?? 1) >= qualityFloorEff
    && o.tMs >= start && o.tMs < start + bucketMs
  ));
  const nTotal = (observations || []).filter((o) => o.tMs >= start && o.tMs < start + bucketMs).length;
  if (!inBucket.length) return null;
  const row = accumulateBucketV2(inBucket, start, bucketMinutes, { nowMs, nTotal });
  row.provisional = true;
  return row;
}
