/**
 * Error/agreement metrics for reference-vs-estimate HR comparison.
 *
 * Report set follows the consensus practice in wearable validation literature
 * (citations: _hr_v2_research/ppg_hr_accuracy_research.md §5.2):
 *   MAE / MAPE per activity, mean bias (systematic error), Bland–Altman 95%
 *   LoA (Bland & Altman 1986, Lancet 1:307), concordance (Lin's CCC),
 *   Pearson r, proportions within ±3/±5/±10/±20 bpm, large-error rate
 *   (|err| > 20 bpm, the severity band studied in §2.2), coverage and
 *   abstention, and a transition-lag (timing/window metrics — Van Oost 2025 in
 *   §5.2). Stratification by motion/activity/quality is provided via
 *   `stratify`, matching the §5.2 requirement to report night/day, sleep, and
 *   exercise strata separately.
 *
 * All functions are pure and deterministic. MAPE skips ref <= 0 (a resting
 * pulse of 0 is a data error, not a real reference) and reports how many were
 * skipped. `pairs` entries with a missing estimate represent abstention and
 * count toward abstention_rate, not toward the error statistics.
 */

import { gridHrSeries } from './align.js';

export const METRICS_VERSION = 'frwhoop-hr2-metrics-v1';

// ---------------------------------------------------------------------------
// Small statistics helpers (deterministic)
// ---------------------------------------------------------------------------

export function mean(v) {
  const a = (v || []).filter(Number.isFinite);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}

export function sampleStd(v, m) {
  const a = (v || []).filter(Number.isFinite);
  if (a.length < 2) return 0;
  const mu = m ?? mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / (a.length - 1));
}

/**
 * Pearson correlation coefficient (two same-length arrays).
 * Null when either side is constant (undefined SD).
 */
export function pearson(a, b) {
  if (!a || !b || a.length !== b.length || a.length < 2) return null;
  let sa = 0, sb = 0, ssa = 0, ssb = 0, sab = 0;
  for (const x of a) sa += x;
  for (const x of b) sb += x;
  const ma = sa / a.length, mb = sb / a.length;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - ma, db = b[i] - mb;
    ssa += da * da; ssb += db * db; sab += da * db;
  }
  if (ssa <= 0 || ssb <= 0) return null;
  return sab / Math.sqrt(ssa * ssb);
}

/**
 * Lin's concordance correlation coefficient (Lin 1989): agreement and
 * precision combined — 2·σ_xy / (σ_x² + σ_y² + (μ_x − μ_y)²). Uses sample
 * variances/covariance. §5.2 lists CCC as consensus practice (Lambe 2026,
 * Moghaddam 2025, Doherty 2026).
 */
export function linCcc(a, b) {
  if (!a || !b || a.length !== b.length || a.length < 2) return null;
  const ma = mean(a), mb = mean(b);
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - ma; const db = b[i] - mb;
    sxx += da * da; syy += db * db; sxy += da * db;
  }
  const den = sxx + syy + a.length * (ma - mb) ** 2;
  if (den <= 0) return null;
  return (2 * sxy) / den;
}

// ---------------------------------------------------------------------------
// Transition lag (timing agreement) — heuristic, ENGINEERING-DEFAULT
// ---------------------------------------------------------------------------

/**
 * Median lag (seconds) at which the estimate best tracks the reference across
 * abrupt HR transitions ("step windows"). Rationale (§5.2): agreement depends
 * on timing/sync — a strap that reports the same true HR as the chest strap,
 * but a few seconds later, has zero amplitude error yet is clinically late
 * (Van Oost 2025 §5.2). Steps are found on the smoothed reference derivative;
 * within each step window the ref-vs-est cross-correlation is maximized over a
 * bounded ±lagRangeSec lag set and the argmax lag is recorded.
 *
 * Heuristic thresholds (ENGINEERING-DEFAULT, tunable via options):
 *   stepThresholdBpm  |dHR/dt| on a 5 s window that counts as a transition (8 bpm)
 *   minStepLenSec     minimum step-window length (5 s)
 *   lagRangeSec       candidate lags to test (±10 s)
 *   stepSec           lag step granularity (1 s)
 */
export function transitionLag(pairsInput, options = {}) {
  const opts = {
    stepThresholdBpm: 8,
    minStepLenSec: 5,
    lagRangeSec: 10,
    stepSec: 1,
    ...options,
  };
  const pairs = (pairsInput || [])
    .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.ref_bpm) && Number.isFinite(p.est_bpm))
    .map((p) => ({ t: p.t, ref: p.ref_bpm, est: p.est_bpm }))
    .sort((a, b) => a.t - b.t);
  if (pairs.length < opts.minStepLenSec + 2) {
    return { lag_s: null, n_steps: 0, method: 'step_xcorr' };
  }
  // smoothed reference via 3 s rolling mean (ENGINEERING-DEFAULT window)
  const n = pairs.length;
  const smoothed = new Array(n);
  for (let i = 0; i < n; i += 1) {
    let s = 0; let c = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 1); j += 1) { s += pairs[j].ref; c += 1; }
    smoothed[i] = s / c;
  }
  // absolute change over a 5 s span (ENGINEERING-DEFAULT, from stepSec grid)
  const span = Math.max(1, Math.round(5 / Math.max(1, opts.stepSec)));
  const active = new Array(n).fill(false);
  for (let i = span; i < n; i += 1) {
    active[i] = Math.abs(smoothed[i] - smoothed[i - span]) >= opts.stepThresholdBpm;
  }
  // contiguous runs of active seconds (a run shorter than minStepLenSec is dropped)
  const windows = [];
  let start = -1;
  for (let i = 0; i < n; i += 1) {
    if (active[i]) { if (start < 0) start = i; }
    else if (start >= 0) {
      if (i - start >= opts.minStepLenSec) windows.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0 && n - start >= opts.minStepLenSec) windows.push([start, n - 1]);

  const lags = [];
  for (const [a, b] of windows) {
    const refs = [];
    for (let i = a; i <= b; i += 1) refs.push({ t: pairs[i].t, v: pairs[i].ref });
    const estByTime = pairs.slice(a, b + 1).map((p) => ({ t: p.t, v: p.est }));
    let bestLag = null; let bestR = null;
    for (let lag = -opts.lagRangeSec * 1000; lag <= opts.lagRangeSec * 1000; lag += opts.stepSec * 1000) {
      const ra = []; const rb = [];
      // for each ref sample, find est at ref.t + lag (nearest within half step)
      for (const r of refs) {
        const want = r.t + lag;
        let lo = 0, hi = estByTime.length - 1, mid = 0;
        while (lo <= hi) { mid = (lo + hi) >> 1; if (estByTime[mid].t < want) lo = mid + 1; else hi = mid - 1; }
        let bi = -1; let bg = Infinity;
        for (const c of [lo - 1, lo, lo + 1]) {
          if (c < 0 || c >= estByTime.length) continue;
          const d = Math.abs(estByTime[c].t - want);
          if (d < bg) { bg = d; bi = c; }
        }
        if (bi !== -1 && bg <= (opts.stepSec * 1000) / 2) { ra.push(r.v); rb.push(estByTime[bi].v); }
      }
      if (ra.length < 3) continue;
      const r = pearson(ra, rb);
      if (r == null) continue;
      if (bestR == null || r > bestR) { bestR = r; bestLag = lag; }
    }
    if (bestLag != null) lags.push(bestLag / 1000);
  }
  if (!lags.length) return { lag_s: null, n_steps: 0, method: 'step_xcorr' };
  const sorted = [...lags].sort((a, b) => a - b);
  const med = sorted.length % 2
    ? sorted[sorted.length >> 1]
    : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2;
  return { lag_s: Math.round(med * 10) / 10, n_steps: lags.length, method: 'step_xcorr' };
}

// ---------------------------------------------------------------------------
// Main comparison metrics
// ---------------------------------------------------------------------------

/**
 * Compute agreement metrics between reference and estimated HR.
 *
 * @param {Array} pairs [{ t, ref_bpm, est_bpm, quality? }] — `est_bpm` may be
 *   null to represent an abstained estimate.
 * @param {object} [options]
 * @param {number} [options.totalExpected]  denominator for coverage: number of
 *   reference time points the estimator was expected to cover. Defaults to
 *   pairs.length.
 * @param {number} [options.qualityFloor]  pairs with quality < floor are treated
 *   as abstained (excluded from errors, counted in abstention_rate).
 * @param {number} [options.round=2]       rounding for scalar outputs.
 * @returns {object} see inline docs below.
 */
export function comparisonMetrics(pairsInput, options = {}) {
  const opts = { round: 2, ...options };
  const pairs = (Array.isArray(pairsInput) ? pairsInput : []).filter((p) => p && Number.isFinite(p.t));

  // eligibility: est is a valid number AND quality at/above floor
  const usable = [];
  let abstained = 0;
  for (const p of pairs) {
    const refOk = Number.isFinite(p.ref_bpm);
    const estOk = p.est_bpm != null && Number.isFinite(p.est_bpm);
    const qualOk = (opts.qualityFloor == null) || (Number.isFinite(p.quality) && p.quality >= opts.qualityFloor);
    if (refOk && estOk && qualOk) usable.push(p);
    else abstained += 1;
  }
  const totalExpected = Number.isFinite(opts.totalExpected) ? opts.totalExpected : pairs.length;
  const n = usable.length;
  const coverage = totalExpected > 0 ? n / totalExpected : null;
  const abstentionRate = coverage == null ? null : 1 - coverage;

  const ref = usable.map((p) => p.ref_bpm);
  const est = usable.map((p) => p.est_bpm);
  const err = usable.map((p) => p.est_bpm - p.ref_bpm);
  const absErr = err.map((x) => Math.abs(x));

  const round = (x) => (x == null ? null : Math.round(x * 10 ** opts.round) / 10 ** opts.round);
  const mae = mean(absErr);
  const rmse = n ? Math.sqrt(err.reduce((s, x) => s + x * x, 0) / n) : null;
  const bias = mean(err);

  // Bland–Altman 95% limits of agreement (Bland & Altman 1986, §5.2)
  const sdDiffs = n > 1 ? sampleStd(err, bias) : 0;
  const k = 1.96;
  const loa = { lo: bias - k * sdDiffs, hi: bias + k * sdDiffs, sd_diffs: sdDiffs, k };

  // MAPE is guarded: ref <= 0 is a degenerate dataset at rest, skip + report.
  let mapeSum = 0; let mapeN = 0; let mapeSkipped = 0;
  for (const p of usable) {
    if (p.ref_bpm <= 0) { mapeSkipped += 1; continue; }
    mapeSum += Math.abs(p.est_bpm - p.ref_bpm) / p.ref_bpm;
    mapeN += 1;
  }
  const mape = mapeN ? (100 * mapeSum) / mapeN : null;

  const frac = (t) => (n ? absErr.filter((x) => x <= t).length / n : null);
  const largeN = n ? absErr.filter((x) => x > 20).length : null;
  const largeErrorRate = n ? largeN / n : null;

  const ccc = linCcc(ref, est);
  const pr = pearson(ref, est);

  const tl = transitionLag(usable);
  return {
    version: METRICS_VERSION,
    n,
    n_total_pairs: pairs.length,
    abstained,
    total_expected: totalExpected,
    coverage: round(coverage),
    abstention_rate: round(abstentionRate),
    mae: round(mae),
    rmse: round(rmse),
    mape: round(mape),
    mape_skipped: mapeSkipped,
    mape_denominator: mapeN,
    bias: round(bias),
    loa: { lo: round(loa.lo), hi: round(loa.hi), sd_diffs: round(loa.sd_diffs), k },
    ccc: round(ccc),
    pearson: round(pr),
    within: {
      b3: round(frac(3)),
      b5: round(frac(5)),
      b10: round(frac(10)),
      b20: round(frac(20)),
    },
    large_error_rate: round(largeErrorRate),
    large_error_n: largeN,
    mean_ref: round(mean(ref)),
    mean_est: round(mean(est)),
    sd_ref: round(sampleStd(ref)),
    sd_est: round(sampleStd(est)),
    transition_lag_s: tl.lag_s,
    transition_steps: tl.n_steps,
  };
}

// ---------------------------------------------------------------------------
// Stratification
// ---------------------------------------------------------------------------

function keyOf(pair, by) {
  if (typeof by === 'function') return by(pair);
  const v = pair?.[by];
  return v == null || v === '' ? 'unknown' : String(v);
}

function qualityKey(q) {
  if (q == null || !Number.isFinite(q)) return 'unknown';
  if (q >= 0.8) return 'high';
  if (q >= 0.5) return 'med';
  return 'low';
}

const sortKey = (a, b) => {
  const an = Number(a); const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Group `pairs` by a stratum and compute metrics per group (deterministic).
 *
 * @param {Array} pairs     same shape as comparisonMetrics
 * @param {string|Function} by — field name ('motion' | 'activity' | 'quality')
 *   or a (pair) => key function. `quality` is auto-bucketed into
 *   low/med/high on ENGINEERING-DEFAULT thresholds [0.5, 0.8]
 *   (accuracy report §5.2 quality strata).
 * @param {object} [opts]   opts.overrideKey — custom key fn for 'quality'.
 * @returns {Array<{key, count, n, pairs, metrics}>} sorted by key; each group's
 *   pairs share the original references so results compose with other tools.
 */
export function stratify(pairsInput, by = 'activity', opts = {}) {
  const pairs = (Array.isArray(pairsInput) ? pairsInput : []).filter(Boolean);
  const groups = new Map();
  for (const p of pairs) {
    const k = typeof by === 'function'
      ? String(keyOf(p, by))
      : (String(by).toLowerCase() === 'quality'
        ? (typeof opts.overrideKey === 'function' ? String(opts.overrideKey(p)) : qualityKey(p.quality))
        : keyOf(p, by));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const keys = [...groups.keys()].sort(sortKey);
  return keys.map((key) => {
    const group = groups.get(key);
    const metrics = comparisonMetrics(group, opts.metrics ?? {});
    return { key, count: group.length, n: metrics.n, pairs: group, metrics };
  });
}
