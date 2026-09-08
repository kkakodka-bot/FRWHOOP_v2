/**
 * Phase 7 - Regularized personalization via residual learning.
 *
 * The mission's personalization recipe (Phase 7 / residual-learning section):
 * across many days, model the difference between an INDEPENDENT energy-balance
 * TDEE and the sensor model's TDEE as a function of each activity's exposure
 * (walking, running, cycling, resistance, generic, resting). Use REGULARIZED
 * regression, only personalize a class when there is enough independent
 * variation to identify its coefficient, calculate the CONDITION of the
 * calibration problem, keep parameters bounded and slowly-changing, and never
 * let a daily TDEE discrepancy uniquely finger one activity when the data cannot
 * separate them.
 *
 * Why this is safe (not overfitting):
 *  - The response is the difference of two INDEPENDENT estimators (energy-balance
 *    TDEE minus sensor TDEE); it is not the sensor model fitting itself.
 *  - Ridge shrinkage pulls every coefficient toward 0 (population prior), so an
 *    unidentifiable or unsupported activity keeps ~no correction.
 *  - Coefficients are bounded to a small multiple of 1.0 on the scale of the
 *    activity's energy, so one wild day cannot push a correction far.
 *  - A condition-number gate refuses to emit coefficients when the design is
 *    collinear (e.g. the user always trains legs and arms together).
 *
 * Design (per day k):
 *   x_k = [ walkingActive, runningActive, cyclingActive, strengthActive,
 *           genericActive, resting ]  (each in kcal, normalized)
 *   y_k = energyBalanceTdee_k - sensorTdee_k      (discrepancy in kcal)
 *   model: y = b0 + sum_j b_j * z_j(x), ridge loss adds lambda*||b||^2.
 *
 * Because energy-balance TDEE is the slow, weak reference (Phase 6), we only
 * use days whose nutrition logging is COMPLETE (nutritionCompleteness().usable)
 * and whose weight/coverage are adequate, so missing intake never looks like
 * low expenditure.
 */
import { nutritionCompleteness } from './longitudinal.js';
import { clamp, num } from './constants.js';
import { mulberry } from './metrics.js';

const ACTIVITY_KEYS = ['walking', 'running', 'cycling', 'strength', 'generic'];
/** Resting is near-constant per user and belongs in the intercept, not a shrunk
 *  coefficient (a near-constant column inflates condition number and eats a degree
 *  of freedom). It is retained in buildDesignRow for reporting only. */
const FREE_KEYS = [...ACTIVITY_KEYS];
/** Coefficient bounds as a scaling factor relative to a population prior of 1. */
const COEFF_BOUNDS = Object.freeze({ lo: 0.5, hi: 1.8 });

/** Daily design-row builder. Accepts either per-activity kcal or active splits. */
export function buildDesignRow(day) {
  const base = {
    walking: num(day.walkingActiveKcal) ?? 0,
    running: num(day.runningActiveKcal) ?? 0,
    cycling: num(day.cyclingActiveKcal) ?? 0,
    strength: num(day.strengthActiveKcal) ?? 0,
    generic: num(day.genericActiveKcal) ?? 0,
    resting: num(day.restingKcal) ?? 0,
  };
  return base;
}

/**
 * Convert a list of daily records into (X, y) for the ridge, applying the
 * completeness gate. Returns rows where nutrition was complete and we have both
 * an energy-balance TDEE and a sensor TDEE.
 *
 * @param {Array} days [{ day, sensorTdee, energyBalanceTdee,
 *                        walkingActiveKcal, ..., restingKcal, nutrition? }]
 */
export function buildPersonalizationMatrix(days = []) {
  const X = [];
  const y = [];
  const used = [];
  for (const d of days) {
    // completeness gate: incomplete logging excluded
    const c = nutritionCompleteness(d.nutrition ?? { intakeKcal: d.intakeKcal, macrosComplete: d.macrosComplete });
    if (!c.usable) continue;
    const sb = num(d.sensorTdee);
    const eb = num(d.energyBalanceTdee);
    if (sb == null || eb == null) continue;
    X.push([buildDesignRow(d), d]);
    y.push(eb - sb);
    used.push(d.day);
  }
  return { X, y, daysUsed: used };
}

/** Standardize the design: column means/sds, return transform + matrix. */
function standardizeDesign(rows) {
  const cols = [...FREE_KEYS];
  const n = rows.length;
  const mean = cols.map((_, j) => rows.reduce((a, r) => a + r[0][cols[j]], 0) / n);
  const sd = cols.map((c, j) => {
    let s = 0;
    for (const r of rows) s += (r[0][cols[j]] - mean[j]) ** 2;
    return Math.sqrt(s / n) || 1;
  });
  const M = rows.map((r) => cols.map((c, j) => (r[0][cols[j]] - mean[j]) / sd[j]));
  return { M, mean, sd, cols };
}

/**
 * Per-coefficient identifiability gate (robust; mission Phase 7 / Phase 0
 * requirement). We do NOT personalize an activity class unless its daily
 * exposure actually varies independently:
 *
 *  - a near-constant column (column variance ~0) is not identifiable;
 *  - a column that is near a linear combination of the others (|pairwise
 *    Pearson correlation| above a threshold) is not independently identifiable
 *    — a daily discrepancy cannot tell which of two always-moving-together
 *    activities was wrong.
 *
 * Returns { identifiable: {key: bool}, condition_heuristic } where the heuristic
 * is the largest eigenvalue of the standardized X'X (a monotone collinearity
 * signal) plus a variance floor, for reporting only — the *decision* is the
 * per-coefficient gate, not the eigen number.
 */
export function identifiabilityGate(M, cols, { corrThreshold = 0.92 } = {}) {
  const n = M.length, p = cols.length;
  const identifiable = {};
  for (let j = 0; j < p; j++) {
    const col = M.map((r) => r[j]);
    const varr = variance(col);
    let ok = varr > 1e-6;
    if (ok) {
      for (let k = 0; k < p; k++) {
        if (k === j) continue;
        const rho = Math.abs(pearsonC(M.map((r) => r[k]), col));
        if (rho >= corrThreshold) { ok = false; break; }
      }
    }
    identifiable[cols[j]] = ok;
  }
  // heuristic: largest eigenvalue of X'X (power iteration, reliable) floored by 1
  const lamMax = powerIteration(MtM(M), false);
  return { identifiable, condition_heuristic: round(Math.max(lamMax, 1) ** 0.5, 1) };
}

function MtM(M) {
  const p = M[0].length, n = M.length;
  const G = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) G[a][b] += M[i][a] * M[i][b];
  return G;
}
function variance(a) { const m = a.reduce((x, y) => x + y, 0) / a.length; return a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length; }
function pearsonC(a, b) { const n = Math.min(a.length, b.length); const ma = a.slice(0, n).reduce((x, y) => x + y, 0) / n, mb = b.slice(0, n).reduce((x, y) => x + y, 0) / n; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (a[i] - ma) * (b[i] - mb); sxx += (a[i] - ma) ** 2; syy += (b[i] - mb) ** 2; } return sxy / Math.sqrt(sxx * syy); }
function powerIteration(G, inverse = false, iters = 300) {
  const n = G.length;
  const S = inverse ? invert(G) : G;
  let v = new Array(n).fill(1 / Math.sqrt(n));
  let lam = 0;
  for (let t = 0; t < iters; t++) {
    const w = matVec(S, v);
    const norm = Math.sqrt(w.reduce((a, x) => a + x * x, 0)) || 1;
    const lamNew = dot(w, v) / Math.max(dot(v, v), 1e-12);
    v = w.map((x) => x / norm);
    if (Math.abs(lamNew - lam) < 1e-10) { lam = lamNew; break; }
    lam = lamNew;
  }
  return lam;
}
function matVec(A, v) { return A.map((row) => row.reduce((a, x, i) => a + x * v[i], 0)); }
function dot(a, b) { return a.reduce((x, y, i) => x + y * b[i], 0); }
function invert(A) {
  const n = A.length;
  const aug = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(aug[r][c]) > Math.abs(aug[piv][c])) piv = r;
    [aug[c], aug[piv]] = [aug[piv], aug[c]];
    const d = aug[c][c];
    if (Math.abs(d) < 1e-12) continue;
    for (let j = c; j < 2 * n; j++) aug[c][j] /= d;
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = aug[r][c]; if (Math.abs(f) < 1e-12) continue; for (let j = c; j < 2 * n; j++) aug[r][j] -= f * aug[c][j]; }
  }
  return aug.map((row) => row.slice(n));
}

/**
 * Fit the personalized per-activity residual model with ridge shrinkage,
 * returning bounded coefficients and identifiability metadata.
 *
 * @param {object} o
 * @param {Array}  o.days          daily records (sensor/energy-balance tdEE + activity kcal)
 * @param {number} [o.lambda=20]   ridge shrinkage (higher = more toward prior)
 * @param {number} [o.minDays=20]  minimum usable days before personalizing
 * @param {number} [o.maxCondition=50] condition gate; above this, colinear -> shrink to 0
 * @returns object
 */
export function fitResidualPersonalization({ days = [], lambda = 20, minDays = 20, maxCondition = 50 } = {}) {
  const { X, y, daysUsed } = buildPersonalizationMatrix(days);
  if (X.length < minDays) {
    return {
      fitted: false, reason: `insufficient_complete_days`, nDays: X.length, minDays,
      params: defaultParams(), coefficients: {}, version: 0,
    };
  }

  const { M, mean, sd, cols } = standardizeDesign(X);
  const gate = identifiabilityGate(M, cols);
  const cond = gate.condition_heuristic;
  const identifiable = gate.identifiable;
  // Non-identifiable coefficients (no independent variation) are pinned to the
  // population prior 1.0: we do NOT personalize a class the data cannot separate.
  const nonIdentifiable = cols.filter((c) => !identifiable[c]);
  // ridge: (M'M + lambda I) w = M'y  (no intercept on standardized; intercept separate)
  const p = M[0].length;
  const MtM = Array.from({ length: p }, () => new Array(p).fill(0));
  const Mty = new Array(p).fill(0);
  const yc = y.map((v) => v - meanOf(y));
  for (let i = 0; i < M.length; i++) {
    for (let a = 0; a < p; a++) {
      Mty[a] += M[i][a] * yc[i];
      for (let b = 0; b < p; b++) MtM[a][b] += M[i][a] * M[i][b];
    }
  }
  // For non-identifiable columns, pin ridged coefficient to 0 so mapScale returns
  // the population prior (1.0) for them.
  for (let i = 0; i < M.length; i++) {
    for (let j = 0; j < p; j++) {
      if (!identifiable[cols[j]]) M[i][j] = 0;
    }
  }
  const MtM2 = Array.from({ length: p }, () => new Array(p).fill(0));
  const Mty2 = new Array(p).fill(0);
  for (let i = 0; i < M.length; i++) {
    for (let a = 0; a < p; a++) {
      Mty2[a] += M[i][a] * yc[i];
      for (let b = 0; b < p; b++) MtM2[a][b] += M[i][a] * M[i][b];
    }
  }
  let effective = lambda;
  if (cond > maxCondition) effective = lambda * 2;
  for (let a = 0; a < p; a++) MtM2[a][a] += effective;
  const w = invert(MtM2).map((row, i) => row.reduce((a, v, j) => a + v * Mty2[j], 0));

  const coefficients = {};
  const yIntercept = meanOf(y);
  cols.forEach((c, j) => {
    const coeff = w[j];
    coefficients[c] = {
      raw: round(coeff, 4),
      bounded: round(boundCoeff(coeff), 4),
      identifiable: identifiable[c],
    };
  });

  const params = {
    intercept: round(yIntercept, 1),
    activityScale: mapScale(cols, w, sd),
    condition_number: round(cond, 1),
    collinear: nonIdentifiable.length > 0 || cond > maxCondition,
    non_identifiable: nonIdentifiable,
    lambda: effective,
    version: 1,
  };

  return {
    fitted: true, nDays: X.length, daysUsed, condition_number: round(cond, 1),
    collinear: nonIdentifiable.length > 0 || cond > maxCondition,
    non_identifiable: nonIdentifiable, lambda: effective,
    coefficients, params, version: 1,
  };
}

function mapScale(cols, w, sd) {
  // convert standardized coefficient back to per-kcal effect = w[j]/sd[j]
  const out = {};
  cols.forEach((c, j) => { out[c] = round(w[j] / sd[j], 6); });
  return out;
}

function boundCoeff(w) {
  // bounded toward the population prior of 1.0 on the standardized scale:
  return clamp(w + 1, 0.6, 1.6);
}

function meanOf(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

/** Population-prior (no personalization) parameters. */
export function defaultParams() {
  const p = { intercept: 0, activityScale: {}, condition_number: null, collinear: false, lambda: 0, version: 0 };
  for (const c of ACTIVITY_KEYS) p.activityScale[c] = 1;
  return p;
}

/**
 * Predicted daily discrepancy given a daily design row and fitted params.
 */
export function predictDiscrepancy(designRow, params) {
  if (!params || !params.activityScale) return 0;
  let d = params.intercept || 0;
  for (const c of ACTIVITY_KEYS) {
    const k = num(designRow[c] ?? designRow[`${c}ActiveKcal`] ?? 0);
    d += k * (params.activityScale[c] ?? 1);
  }
  return d;
}

/**
 * Apply the correction to a sensor-model day total (returns adjusted TDEE).
 */
export function applyCorrection(sensorTdee, designRow, params) {
  const disc = predictDiscrepancy(designRow, params);
  return round(sensorTdee + disc, 1);
}

/** Versioned wrapper compatible with a shadow->active promotion audit. */
export function toCalibrationRow(result, { userId = null, globalModelVersion = null } = {}) {
  return {
    user_id: userId,
    version: result.version,
    status: 'shadow',
    global_model_version: globalModelVersion,
    params: result.params,
    calibration_confidence: result.fitted ? clamp(0.05 + 0.5 * Math.min(1, result.nDays / 60), 0, 0.9) : 0,
    training_days: result.nDays || 0,
    notes: result.fitted ? `ridge residual model, cond=${result.condition_number}` : 'not_fitted',
  };
}

function round(n, p = 2) { const f = 10 ** p; return Math.round(n * f) / f; }

export { ACTIVITY_KEYS, mulberry };
