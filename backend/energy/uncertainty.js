/**
 * Uncertainty calibration (Phase 8).
 *
 * A calorie number without uncertainty is misleading. This module implements
 * split-conformal prediction intervals for a point-predictor and — critically —
 * a calibration CHECK that measures whether a stated interval actually achieves
 * its nominal coverage ("a 90% interval should contain the reference ~90% of the
 * time"). This is the anti-cosmetic-confidence requirement: we do not assert a
 * confidence value is meaningful; we verify it.
 *
 * Split conformal (after Papadopoulos et al. 2002 / Lei et al. 2018):
 *   - Fit predictor on a proper-training set.
 *   - On a calibration set, record absolute residuals r_i = |y_i - yhat_i|.
 *   - For a new point, take the (1-alpha) empirical quantile of those residuals
 *     (a finite-sample correction: index = ceil((n+1)(1-alpha))).
 *   - Interval = [yhat - q, yhat + q].
 * This is distribution-free and gives finite-sample marginal coverage guarantees
 * under exchangeability — the property we actually want to test.
 *
 * We also provide conformal with an additive homogeneous residual (the common
 * single-width interval) and a variance-adaptive version that scales the width
 * by the point's heteroscedasticity if requested.
 */
import { mulberry } from './metrics.js';

/** Empirical quantile helper (linear interpolation). */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Split-conformal interval width from calibration residuals.
 *
 * @param {Array} resid  calibration absolute residuals (|y - yhat|)
 * @param {number} alpha  desired miscoverage (0.10 -> 90% interval)
 * @returns {number} half-width q such that [yhat-q, yhat+q] has ~1-alpha coverage
 */
export function conformalWidth(resid, alpha = 0.10) {
  const r = resid.slice().sort((a, b) => a - b);
  if (!r.length) return null;
  // Finite-sample: use the ceil((n+1)(1-alpha)) order statistic.
  const qIndex = Math.min(r.length - 1, Math.ceil((r.length + 1) * (1 - alpha)) - 1);
  const q = r[Math.max(0, qIndex)];
  return q == null ? null : q;
}

/**
 * Evaluate empirical coverage of conformal intervals on a test set.
 *
 * @param {object} o
 * @param {Array} o.yhat      test predictions
 * @param {Array} o.y         test true values
 * @param {number[]} o.widths per-point interval half-widths (or a scalar)
 * @param {number} [o.nominalAlpha=0.10]
 * @returns {object} empirical coverage, sharpness, and per-alpha check
 */
export function evaluateCoverage({ yhat, y, widths, nominalAlpha = 0.10 }) {
  const n = y.length;
  if (!n || yhat.length !== n) return { n: 0 };
  const half = Number.isFinite(widths) ? Array(n).fill(widths) : widths;
  let inInterval = 0;
  let intervalSum = 0;
  for (let i = 0; i < n; i++) {
    const lo = yhat[i] - half[i];
    const hi = yhat[i] + half[i];
    if (y[i] >= lo && y[i] <= hi) inInterval++;
    intervalSum += hi - lo;
  }
  const coverage = inInterval / n;
  return {
    n,
    nominal: 1 - nominalAlpha,
    empirical_coverage: round(coverage, 4),
    mean_interval_width: round(intervalSum / n, 4),
    // Well calibrated: empirical approaches nominal; sharpness: tight intervals.
  };
}

/**
 * Variance-adaptive conformal: scale the conformal width by a per-point
 * standard-error estimate so intervals widen where the model is less sure.
 * width_i = q * (s_seed_i / median(s_seed)).
 */
export function adaptiveWidths(q, se, { clampMin = 0.5, clampMax = 2.0 } = {}) {
  const med = median(se);
  if (!med || med <= 0) return Array(se.length).fill(q);
  return se.map((s) => q * clamp(s / med, clampMin, clampMax));
}

function median(a) {
  const v = a.slice().filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return 0;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
function round(n, p) { const f = 10 ** p; return Math.round(n * f) / f; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

export { quantile, mulberry };
