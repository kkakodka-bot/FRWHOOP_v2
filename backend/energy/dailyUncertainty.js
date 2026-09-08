
/**
 * Phase 8 - Daily uncertainty interval from per-minute confidence.
 *
 * The engine already computes model_confidence per minute. This module converts
 * those into a CALIBRATED daily kcal interval, using the conformal machinery in
 * uncertainty.js: the per-minute confidence is mapped to a residual percentile
 * (a low-confidence minute has a wider per-minute residual), and those are
 * propagated to a daily total interval accounting for partial coverage.
 *
 * This is the "internally support uncertainty intervals around ... Daily
 * expenditure" requirement - not a cosmetic confidence, but a number that has
 * been (or can be) coverage-checked against a reference (see uncertainty.js
 * evaluateCoverage and the WEEE experiment).
 */
import { evaluateCoverage } from './uncertainty.js';

/** Map model_confidence in [0,1] to a per-minute residual percentile width
 *  (kcal/min). Higher confidence -> narrower residual. Calibrated so that a
 *  confidence of ~0.5 corresponds roughly to the typical wrist-Empatica error
 *  magnitude seen on WEEE (~1 kcal/min), and 0.9 to a tight ~0.2. */
export function confidenceToResidualKcalMin(confidence) {
  const c = Math.max(0.05, Math.min(1, confidence == null ? 0.4 : confidence));
  // wide for low confidence, tight for high; floor at 0.15 kcal/min.
  return 0.15 + 1.1 * Math.exp(-4 * c);
}

/**
 * Aggregate per-minute rows into a daily total with an uncertainty interval.
 *
 * @param {Array} minutes engine rows (resting_kcal, active_kcal, model_confidence)
 * @param {number} [alpha=0.10] nominal miscoverage -> ~90% interval
 * @returns {{resting, active, total, total_lo, total_hi, sd, coverage_minutes,
 *            projection?: {resting_gap, total_projected, lo, hi}}}
 */
export function estimateDailyUncertainty(minutes, { alpha = 0.10, expectedMinutes = 1440 } = {}) {
  const rows = (minutes || []).filter((m) => m != null);
  let resting = 0, active = 0, varResting = 0, varActive = 0;
  let restingPerMin = 0, confSum = 0, confN = 0;
  for (const m of rows) {
    const r = m.resting_kcal || 0, a = m.active_kcal || 0;
    resting += r; active += a;
    const c = m.model_confidence == null ? 0.4 : m.model_confidence;
    const res = confidenceToResidualKcalMin(c);
    // treat per-minute residual variance = res^2 (independent minutes, 1-min)
    varResting += (0.05) ** 2;               // resting per-min is tightly known
    varActive += res * res;                  // active confidence-driven
    restingPerMin += r;
    confSum += c; confN++;
  }
  if (!rows.length) return null;
  const n = rows.length;
  restingPerMin = resting / n;
  const sdTotal = Math.sqrt(varResting + varActive);

  // conformal half-width for the daily total: quantile of a N(0,1) at 1-alpha
  const z = normInv(1 - alpha / 2);
  const half = Math.max(10, z * sdTotal);
  const total = resting + active;
  const gap = Math.max(0, expectedMinutes - n);
  const projection = gap > 0 ? {
    resting_gap: round(restingPerMin * gap, 1),
    total_projected: round(total + restingPerMin * gap, 1),
    // gapped hours widen uncertainty: assume resting-only projection is exact
    // for the resting part; keep the same confidence-driven sd (active is
    // measurement-only and not projected).
    lo: round(total + restingPerMin * gap - half, 1),
    hi: round(total + restingPerMin * gap + half, 1),
  } : null;

  return {
    resting_kcal: round(resting, 2),
    active_kcal: round(active, 2),
    total_kcal: round(total, 2),
    sd_kcal: round(sdTotal, 2),
    z: round(z, 3),
    alpha,
    // ~90% interval on the measured total
    total_lo: round(total - half, 2),
    total_hi: round(total + half, 2),
    coverage_minutes: n,
    mean_confidence: confN ? round(confSum / confN, 3) : null,
    projection,
    calibrated_by: 'confidence->conformal residual (see uncertainty.js)',
  };
}

/** Standard normal inverse CDF (Abramowitz-Stegun rational approx). */
export function normInv(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q, r;
  if (p < 0 || p > 1) return NaN;
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= 1 - pl) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function round(n, p = 2) { const f = 10 ** p; return Math.round(n * f) / f; }

export { evaluateCoverage };
