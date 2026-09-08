/**
 * Robust statistics for personal baselines.
 *
 * Physiological series are contaminated, not Gaussian. A single night with a
 * half-worn strap, one fever, one workout logged at the wrong time — each is a
 * legitimate observation of the sensor and an illegitimate contribution to
 * "normal for this person". Mean and standard deviation move toward whichever
 * outlier is largest, which is exactly the wrong behaviour for a reference
 * value: the day the user most needs an accurate baseline is the day their
 * recent data is weirdest.
 *
 * So the baselines are built from medians, MAD and percentiles. The cost is
 * statistical efficiency (a MAD-based scale estimate is ~37% less efficient than
 * SD on genuinely normal data); the benefit is that one bad night moves the
 * baseline by roughly one observation's worth instead of by its own magnitude.
 *
 * Everything here is a pure function over an array of numbers. Non-finite values
 * are dropped, never coerced to zero.
 */

/** Consistency constant making MAD an unbiased SD estimator under normality. */
export const MAD_TO_SIGMA = 1.4826;

/**
 * Robust-Z magnitude at which an observation is treated as an outlier.
 *
 * 3.5 is the Iglewicz-Hoaglin recommendation for the MAD-based modified Z-score.
 * Under normality it corresponds to roughly a 1-in-2000 observation, so on a
 * 90-day window it flags about one day by chance.
 */
export const OUTLIER_Z = 3.5;

function finite(values) {
  const out = [];
  for (const v of values || []) {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function sortedFinite(values) {
  return finite(values).sort((a, b) => a - b);
}

/** Linear-interpolated percentile. `p` in [0,1]. */
export function percentile(values, p) {
  const list = sortedFinite(values);
  if (!list.length) return null;
  const idx = Math.min(Math.max((list.length - 1) * p, 0), list.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return list[lo];
  return list[lo] + (list[hi] - list[lo]) * (idx - lo);
}

export function median(values) {
  return percentile(values, 0.5);
}

/** Median absolute deviation about the median. Zero for a constant series. */
export function mad(values) {
  const list = finite(values);
  if (!list.length) return null;
  const m = median(list);
  return median(list.map((v) => Math.abs(v - m)));
}

/**
 * MAD rescaled to a standard-deviation equivalent.
 *
 * Falls back to the IQR-derived scale when MAD is zero, which happens whenever
 * more than half the window holds the same value (a quantised sensor, or a
 * mostly-flat night). Returning 0 there would make every robust-Z infinite.
 */
export function robustSigma(values) {
  const list = finite(values);
  if (list.length < 2) return null;
  const m = mad(list);
  if (m != null && m > 0) return m * MAD_TO_SIGMA;
  const spread = iqr(list);
  if (spread != null && spread > 0) return spread / 1.349;
  return 0;
}

export function iqr(values) {
  const q1 = percentile(values, 0.25);
  const q3 = percentile(values, 0.75);
  return q1 == null || q3 == null ? null : q3 - q1;
}

/**
 * Modified (MAD-based) Z-score of `x` against `values`.
 *
 * Returns null rather than Infinity when the reference window has no spread —
 * "this differs from a constant history" is not a magnitude, and pretending it
 * is would let a quantised sensor emit an unbounded anomaly score.
 */
export function robustZ(x, values) {
  const v = Number(x);
  if (!Number.isFinite(v)) return null;
  const list = finite(values);
  if (list.length < 2) return null;
  const m = median(list);
  const sigma = robustSigma(list);
  if (sigma == null || sigma === 0) return null;
  return (v - m) / sigma;
}

/** Values whose robust-Z magnitude is within `z`. Used to clean a window. */
export function withoutOutliers(values, z = OUTLIER_Z) {
  const list = finite(values);
  if (list.length < 4) return list;
  const m = median(list);
  const sigma = robustSigma(list);
  if (sigma == null || sigma === 0) return list;
  return list.filter((v) => Math.abs((v - m) / sigma) <= z);
}

/**
 * Exponentially weighted moving average, oldest-first.
 *
 * `halfLifeDays` is expressed in the series' own step units (one observation per
 * day for a nightly baseline), which is more interpretable than a bare alpha:
 * "half the weight is in the last week" is a statement a reviewer can check.
 */
export function ewma(values, { halfLifeDays = 7 } = {}) {
  const list = finite(values);
  if (!list.length) return null;
  const alpha = 1 - Math.exp(-Math.LN2 / Math.max(halfLifeDays, 1e-9));
  let acc = list[0];
  for (let i = 1; i < list.length; i += 1) acc += alpha * (list[i] - acc);
  return acc;
}

/**
 * Two-sided tabular CUSUM for a sustained level shift.
 *
 * Detects a change the eye would call "it has been running high for a while"
 * that no single day's Z-score would flag. Standardised by a ROBUST sigma, so
 * the alarm threshold means the same thing on a contaminated series as a clean
 * one.
 *
 * `k` is the slack (half the shift size to detect, in sigma) and `h` the
 * decision interval. k=0.5 / h=5 is the textbook pairing for detecting a 1-sigma
 * shift with an in-control run length in the hundreds.
 *
 * IMPORTANT: pass `center` (and ideally `sigma`) from a reference period the
 * shift is NOT in. The defaults are taken from the whole series, and a shift
 * that occupies half the window is then undetectable at ANY magnitude — the
 * median lands mid-shift and MAD grows in proportion, so the standardised
 * departure pins near 0.67 however large the step. `baseline/service.js`
 * supplies a head-based reference for exactly this reason.
 */
export function cusum(values, { k = 0.5, h = 5, center = null, sigma = null } = {}) {
  const list = finite(values);
  if (list.length < 3) {
    return { alarm: false, direction: null, high: 0, low: 0, index: null, series: [] };
  }
  const mu = center ?? median(list);
  const sd = sigma ?? robustSigma(list);
  if (sd == null || sd === 0) {
    return { alarm: false, direction: null, high: 0, low: 0, index: null, series: [] };
  }

  let high = 0;
  let low = 0;
  let alarmIndex = null;
  let direction = null;
  const series = [];
  for (let i = 0; i < list.length; i += 1) {
    const z = (list[i] - mu) / sd;
    high = Math.max(0, high + z - k);
    low = Math.max(0, low - z - k);
    series.push({ index: i, high, low });
    if (alarmIndex == null && (high > h || low > h)) {
      alarmIndex = i;
      direction = high > h ? 'up' : 'down';
    }
  }
  return { alarm: alarmIndex != null, direction, high, low, index: alarmIndex, series };
}

/**
 * Pettitt's test for a single change point.
 *
 * Rank-based and distribution-free, which is why it is used here instead of a
 * mean-shift t-scan: it does not assume normality and is not dragged by the
 * outliers that physiological series always contain. `pValue` is the standard
 * asymptotic approximation and is only meaningful for n >= 10.
 *
 * ponytail: ranks are computed by sort, so this is O(n log n) and fine for the
 * 90-day windows here. Detects ONE change point; for multiple shifts, segment
 * recursively.
 */
export function changePoint(values, { alpha = 0.05 } = {}) {
  const list = finite(values);
  const n = list.length;
  if (n < 10) return { found: false, index: null, pValue: null, reason: 'need at least 10 observations' };

  const order = list.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && order[j + 1][0] === order[i][0]) j += 1;
    // Mid-rank for ties, so a quantised sensor does not fabricate a shift.
    const midRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[order[k][1]] = midRank;
    i = j + 1;
  }

  let best = 0;
  let bestIndex = null;
  let running = 0;
  let signed = 0;
  for (let t = 0; t < n - 1; t += 1) {
    running += ranks[t];
    const u = 2 * running - (t + 1) * (n + 1);
    if (Math.abs(u) > best) { best = Math.abs(u); bestIndex = t; signed = u; }
  }

  const pValue = 2 * Math.exp((-6 * best * best) / (n ** 3 + n ** 2));
  const found = pValue <= alpha;
  return {
    found,
    index: found ? bestIndex : null,
    pValue: Math.min(1, pValue),
    statistic: best,
    // U > 0 means early values rank above later ones, i.e. the level dropped.
    direction: found ? (signed > 0 ? 'down' : 'up') : null,
  };
}

/**
 * Theil-Sen slope: the median of all pairwise slopes.
 *
 * Used instead of least squares because a trend is the thing an outlier
 * distorts most — one spurious value at the end of a window can invent an
 * entire trend under OLS, while Theil-Sen tolerates up to ~29% contamination.
 *
 * `points` is [[x, y], ...]. Returns slope in y-units per x-unit.
 *
 * ponytail: O(n^2) pairwise. Guarded at MAX_PAIRWISE_N; above that it subsamples
 * deterministically (every m-th point) rather than silently getting slow.
 */
export const MAX_PAIRWISE_N = 400;

export function theilSen(points) {
  let pts = (points || [])
    .map(([x, y]) => [Number(x), Number(y)])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    .sort((a, b) => a[0] - b[0]);
  if (pts.length < 3) return { slope: null, intercept: null, n: pts.length };

  if (pts.length > MAX_PAIRWISE_N) {
    const step = Math.ceil(pts.length / MAX_PAIRWISE_N);
    pts = pts.filter((_, i) => i % step === 0);
  }

  const slopes = [];
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      const dx = pts[j][0] - pts[i][0];
      if (dx === 0) continue;
      slopes.push((pts[j][1] - pts[i][1]) / dx);
    }
  }
  if (!slopes.length) return { slope: null, intercept: null, n: pts.length };
  const slope = median(slopes);
  const intercept = median(pts.map(([x, y]) => y - slope * x));
  return { slope, intercept, n: pts.length };
}

/** Longest run of consecutive values satisfying `predicate`, and its bounds. */
export function longestRun(values, predicate) {
  const list = values || [];
  let best = 0;
  let bestStart = null;
  let start = null;
  for (let i = 0; i < list.length; i += 1) {
    if (predicate(list[i], i)) {
      if (start == null) start = i;
      if (i - start + 1 > best) { best = i - start + 1; bestStart = start; }
    } else {
      start = null;
    }
  }
  return { length: best, startIndex: bestStart, endIndex: bestStart == null ? null : bestStart + best - 1 };
}

export { finite };
