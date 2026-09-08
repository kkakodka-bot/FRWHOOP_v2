/**
 * HR V2 resting-heart-rate candidate family.
 *
 * Every candidate the mission lists is implemented here so the benchmark
 * (_hr_v2_research/rhr_daily_metrics_definitions.md section 7.3) can compare
 * them on the same inputs; one is promoted as canonical via
 * HR2_CONFIG.RHR_METHOD_DEFAULT (currently r2a - low percentiles of ~30 s
 * resting windows, the literature-defensible candidate - pending ECG evidence).
 *
 * Concepts kept SEPARATE (rhr report section 6 - physiologically different
 * statistics are never forced into one field):
 *   - canonical recovery RHR (promoted candidate)
 *   - nocturnal average HR (sleep_hr_twa)
 *   - overnight median level (r7, V1's overnightHr)
 *   - lowest sustained window floor (r3, Garmin-style diagnostic)
 *
 * All candidates consume ONLY quality-screened observations (score >= floor).
 * A window needs >= RHR_WINDOW_MIN_SAMPLES passing samples to produce a
 * value. Missing data stays missing: a night with too few usable windows
 * yields null, never a fabricated number.
 */

import { HR2_CONFIG, HR2_ALGORITHM_VERSION } from './version.js';
import { trapezoidWeights } from './series.js';

const MINUTE_MS = 60_000;

function round1(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}

/**
 * Linear-interpolation percentile over finite values.
 * Matches metrics/sleep.js percentile exactly (V1 compat for r1/r4):
 * idx = clamp((len-1)*p, 0, len-1), lo/hi interpolation.
 */
export function percentile(values, p) {
  const list = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const idx = Math.min(Math.max((list.length - 1) * p, 0), list.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return list[lo];
  return list[lo] + (list[hi] - list[lo]) * (idx - lo);
}

/**
 * Time-weighted mean of observations within [startMs, endMs).
 * `nowMs` (optional) bounds the last weight for in-progress intervals.
 * Returns {value, coveredMs} or null when the window has no observations.
 */
export function windowMean(obs, startMs, endMs, nowMs) {
  if (!obs.length) return null;
  const times = obs.map((x) => x.tMs);
  const weights = trapezoidWeights(times, startMs, endMs, HR2_CONFIG.WEIGHT_CAP_MS, nowMs != null ? { nowMs } : {});
  let wsum = 0;
  let sum = 0;
  for (let i = 0; i < obs.length; i += 1) {
    wsum += weights[i];
    sum += obs[i].bpm * weights[i];
  }
  if (wsum <= 0) return { value: obs[obs.length - 1].bpm, coveredMs: 0 };
  return { value: sum / wsum, coveredMs: wsum };
}

function passingInWindow(observations, floor, startMs, endMs) {
  return (observations || []).filter((x) => (
    x.bpm != null
    && (x._quality?.score ?? 1) >= floor
    && x.tMs >= startMs
    && x.tMs <= endMs
  ));
}

/** Sliding window means, 50% overlap. Only windows with >= minSamples count. */
export function rollingWindowMeans(obs, windowS, nowMs = null) {
  const windowMs = windowS * 1000;
  const stepMs = windowMs / 2;
  const minSamples = HR2_CONFIG.RHR_WINDOW_MIN_SAMPLES;
  const out = [];
  if (!obs.length) return out;
  const t0 = obs[0].tMs;
  const t1 = obs[obs.length - 1].tMs;
  for (let start = t0; start <= t1; start += stepMs) {
    const end = start + windowMs;
    const inner = obs.filter((x) => x.tMs >= start && x.tMs < end);
    if (inner.length < minSamples) continue;
    const mean = windowMean(inner, start, end, nowMs);
    if (mean == null) continue;
    out.push({ startMs: start, endMs: end, value: mean.value, coveredMs: mean.coveredMs, n: inner.length });
  }
  return out;
}

/** Non-overlapping bins aligned to windowStart, duration binS. */
export function nonOverlappingBinMeans(obs, windowStartMs, windowEndMs, binS) {
  const binMs = binS * 1000;
  const out = [];
  for (let start = Math.floor(windowStartMs / binMs) * binMs; start < windowEndMs; start += binMs) {
    const end = start + binMs;
    const inner = obs.filter((x) => x.tMs >= start && x.tMs < end);
    if (inner.length < HR2_CONFIG.RHR_WINDOW_MIN_SAMPLES) continue;
    const mean = windowMean(inner, start, end);
    if (mean == null) continue;
    out.push({ startMs: start, endMs: end, value: mean.value, coveredMs: mean.coveredMs, n: inner.length });
  }
  return out;
}

function windowEndMs(windowStartMs, obs) {
  if (obs.length) return Math.max(windowStartMs, obs[obs.length - 1].tMs);
  return windowStartMs;
}


/** Percentile-of-window-means candidate (r2 family). */
function candidateFromWindows(windows, method, p) {
  if (!windows.length) return null;
  return {
    value: round1(percentile(windows.map((w) => w.value), p)),
    n_windows: windows.length,
    n_samples: windows.reduce((acc, w) => acc + w.n, 0),
    coverage_sec: Math.round(windows.reduce((acc, w) => acc + w.coveredMs, 0) / 100) / 10,
    method,
  };
}

/** Garmin-style floor: minimum sustained-window mean. */
function lowestWindow(windows, method) {
  if (!windows.length) return null;
  let best = null;
  for (const w of windows) {
    if (best == null || w.value < best.value) best = w;
  }
  return {
    value: round1(best.value),
    n_windows: windows.length,
    n_samples: windows.reduce((acc, w) => acc + w.n, 0),
    at: new Date(best.startMs).toISOString(),
    method,
  };
}

/** Stage containing time t, or null. */
function stageAt(stageSegments, t) {
  for (const seg of stageSegments || []) {
    if (t >= seg.start && t < seg.end) return seg.stage;
  }
  return null;
}

/**
 * r5 (SHADOW): SWS-weighted dynamic average. Weights UNTUNED (no labeled
 * comparison set; WHOOP's weights are proprietary). Never promote without
 * labeled nights.
 */
function swsWeighted(passing, stageSegments) {
  if (!Array.isArray(stageSegments) || !stageSegments.length) return null;
  let wsum = 0;
  let num = 0;
  let n = 0;
  for (const x of passing) {
    const stage = stageAt(stageSegments, x.tMs);
    if (stage == null) continue;
    const w = HR2_CONFIG.SWS_WEIGHTS[stage] ?? 0;
    if (w <= 0) continue;
    wsum += w;
    num += x.bpm * w;
    n += 1;
  }
  if (wsum <= 0) return null;
  return { value: round1(num / wsum), n, method: 'r5_sws_weighted_shadow', untuned: true };
}

/**
 * Compute every RHR candidate for one sleep window.
 *
 * @param {Array} observations canonical observations, sorted by tMs, with _quality
 * @param {object} o {
 *   startMs, endMs,     sleep window (ms epoch)
 *   stageSegments,      optional [{stage:'deep'|'light'|'rem'|'awake', start, end}]
 *   qualityFloor,       default HR2_CONFIG.QUALITY_FLOOR
 * }
 */
export function rhrCandidates(observations, o = {}) {
  const floor = o.qualityFloor ?? HR2_CONFIG.QUALITY_FLOOR;
  const startMs = o.startMs;
  const endMs = o.endMs;
  const all = observations || [];
  const passing = passingInWindow(all, floor, startMs, endMs);
  const inWindowTotal = all.filter((x) => x.tMs >= startMs && x.tMs <= endMs).length;

  // r1: V1 compat - P10 of raw asleep samples (metrics/sleep.js:365 algorithm).
  const r1 = { value: round1(percentile(passing.map((x) => x.bpm), 0.10)), n: passing.length, method: 'r1_v1_p10_raw_asleep' };

  // r2a/r2b: P10 of quality-screened 30s / 60s rolling window means.
  const r2a = candidateFromWindows(rollingWindowMeans(passing, 30), 'r2a_p10_of_30s_window_means', 0.10);
  const r2b = candidateFromWindows(rollingWindowMeans(passing, 60), 'r2b_p10_of_60s_window_means', 0.10);

  // r2c: P10 of non-overlapping 5-min bin means (time-uniform grid).
  const r2c = candidateFromWindows(nonOverlappingBinMeans(passing, startMs, endMs, 300), 'r2c_p10_of_300s_bins', 0.10);

  // r3: robust lowest 5-min rolling window (Garmin-style floor diagnostic).
  const r3 = lowestWindow(rollingWindowMeans(passing, 300), 'r3_lowest_5min_window');

  // r4: P5 of raw asleep samples.
  const r4 = { value: round1(percentile(passing.map((x) => x.bpm), 0.05)), n: passing.length, method: 'r4_p5_raw_asleep' };

  // r6: stage-filtered low-tail, only when stage coverage >= 50%; else null
  // (the caller falls back via the promotion chain).
  let r6 = null;
  if (Array.isArray(o.stageSegments) && o.stageSegments.length) {
    const asleepSegments = o.stageSegments.filter((seg) => seg.stage !== 'awake');
    const coveredMs = asleepSegments.reduce((acc, seg) => acc + Math.max(0, seg.end - seg.start), 0);
    const stageCoverage = coveredMs / Math.max(endMs - startMs, 1);
    if (stageCoverage >= 0.5) {
      const inAsleep = passing.filter((x) => stageAt(asleepSegments, x.tMs) != null);
      r6 = candidateFromWindows(nonOverlappingBinMeans(inAsleep, startMs, endMs, 300), 'r6_stage_filtered_p10_300s', 0.10);
    }
  }

  // r7: overnight median level (V1 overnightHr compat).
  const r7 = { value: round1(percentile(passing.map((x) => x.bpm), 0.50)), n: passing.length, method: 'r7_overnight_median' };

  // r5 (SHADOW): SWS-weighted dynamic average - never promote without labels.
  const r5 = swsWeighted(passing, o.stageSegments);

  // sleep HR: nocturnal time-weighted mean (distinct concept from RHR).
  const nightMean = windowMean(passing, startMs, endMs);
  const sleepHr = nightMean
    ? { value: round1(nightMean.value), coverage_sec: Math.round(nightMean.coveredMs / 100) / 10, n: passing.length, method: 'sleep_hr_twa' }
    : null;

  const promotedMethod = HR2_CONFIG.RHR_METHOD_DEFAULT;
  const promotedCandidate = promotedFallback(promotedMethod, {
    r2a_p10_of_30s_window_means: r2a,
    r2b_p10_of_60s_window_means: r2b,
    r2c_p10_of_300s_bins: r2c,
    r6_stage_filtered: r6,
  });

  return {
    candidates: {
      r1_v1_p10: r1,
      r2a_p10_of_30s_window_means: r2a,
      r2b_p10_of_60s_window_means: r2b,
      r2c_p10_of_300s_bins: r2c,
      r3_lowest_5min_window: r3,
      r4_p5_raw_asleep: r4,
      r5_sws_weighted_shadow: r5,
      r6_stage_filtered: r6 ?? null,
      r7_overnight_median: r7,
      sleep_hr_twa: sleepHr,
    },
    promoted: promotedCandidate,
    promoted_method: promotedMethod,
    meta: { window_start: new Date(startMs).toISOString(), window_end: new Date(endMs).toISOString(), n_total: inWindowTotal, n_passing: passing.length, floor },
    algorithm_version: HR2_ALGORITHM_VERSION,
  };
}

/**
 * Promotion resolution: HR2_CONFIG.RHR_METHOD_DEFAULT picks the canonical
 * candidate; a null candidate (insufficient data) falls back in the documented
 * order r2a -> r2b -> r2c (r6 replaces r2a when it is the configured default),
 * and null when none produced a value. Sparse nights degrade deterministically
 * and transparently.
 */
function promotedFallback(method, c) {
  const chain = method === 'r6_stage_filtered'
    ? ['r6_stage_filtered', 'r2a_p10_of_30s_window_means', 'r2b_p10_of_60s_window_means', 'r2c_p10_of_300s_bins']
    : method === 'r2b_p10_of_60s_window_means'
      ? ['r2b_p10_of_60s_window_means', 'r2a_p10_of_30s_window_means', 'r2c_p10_of_300s_bins']
      : ['r2a_p10_of_30s_window_means', 'r2b_p10_of_60s_window_means', 'r2c_p10_of_300s_bins'];
  for (const key of chain) {
    if (c[key] && c[key].value != null) return { ...c[key], promoted_from: key };
  }
  return null;
}
