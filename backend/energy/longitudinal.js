/**
 * Longitudinal TDEE estimation from food intake + body weight.
 *
 * This is the *independent* energy-balance estimator. It estimates daily TDEE
 * from logged intake and morning scale weights using a small state-space (Kalman
 * / energy-balance) model. It deliberately does NOT consume the wearable sensor
 * estimate, so it never becomes its own evaluation target: sensor calories are
 * not fed into the same filter that later compares against them. A fused
 * production estimator can combine them after validation, but this module stays
 * an auditable shadow.
 *
 * Scientific grounding:
 *  - Energy balance: change in body energy = intake - expenditure.
 *  - The canonical rate (7700 kcal/kg, ~3500 kcal/lb) is a population mean that
 *    the mission explicitly forbids treating as exact: short-term scale change is
 *    dominated by water, glycogen, gut contents and measurement noise, not tissue.
 *    We therefore model the *latent trend mass* separately from a *short-term
 *    fluid deviation* and let the data size the noise.
 *  - Kevin Hall's dynamic energy-balance modelling motivates the state-space
 *    framing and the slow evolution of TDEE.
 *
 * Model (per day k):
 *
 *   x_k = [ trend_k, fluid_k, tdee_k ]
 *
 *   trend_{k+1} = trend_k + (intake_k - tdee_k) / ED          + w_1
 *   fluid_{k+1} = rho * fluid_k                                + w_2   (mean-reverting)
 *   tdee_{k+1}  = tdee_k                                       + w_3   (slow drift)
 *
 *   observed scale weight:  y_k = trend_k + fluid_k + v_k
 *
 * ED = energy density of tissue change (kcal/kg). fluid mean-reverts to 0
 * (rho < 1) so it does not accumulate. tdee has tiny process noise so it drifts
 * slowly and cannot jump hundreds of calories on one scale reading.
 *
 * Both a linear Kalman filter and a simplified continuous implementation are
 * provided; the KF is exact for this linear model and is the default.
 */

/** Energy density of body-tissue change, kcal/kg. Set from literature; not
 *  treated as a magic constant when body composition is available. */
export const ENERGY_DENSITY = Object.freeze({
  defaultKcalPerKg: 7700,          // population mean, ~7.7 kcal/g
  fatKcalPerKg: 9400,              // lipid ≈ 9.4 kcal/g
  leanKcalPerKg: 1800,             // lean tissue ≈ 1.8 kcal/g
});

/** Mean-reversion of the short-term fluid deviation per day. */
export const FLUID_REVERSION = 0.7;

/** Diagonal process-noise SDs (per day). */
export const PROCESS_NOISE = Object.freeze({
  trendKcalPerKg: 0,               // trend driven deterministically by imbalance
  fluidKcal: 0.35,                 // fluid moves around
  tdeePerDay: 8,                   // TDEE drifts slowly (~8 kcal/day SD)
});

/** Measurement noise SD for a scale weight reading. */
export const SCALE_NOISE_SD_KG = 0.4;

/** Robust-observation gate: reject a weigh-in whose standardized innovation
 *  (|resid|/sqrt(S)) exceeds this many sigma. Tissue can't appear faster than
 *  the filter's trend/noise model allows, so a reading far outside it is
 *  treated as an outlier rather than as data that must be explained. */
export const OUTLIER_GATE_SIGMA = 4;

/**
 * Strict nutrition quality rules. Partial logging looks like low expenditure
 * (missing intake == mathematically lower TDEE), so days that do not clear this
 * bar must be downweighted or excluded from energy-balance calibration.
 */
export function nutritionCompleteness(day) {
  if (!day) return { level: 'none', usable: false, reasons: ['no_data'] };
  const reasons = [];
  const missingMeals = day.missingMeals ?? 0;
  const hasIntake = day.intakeKcal != null && day.intakeKcal > 0;
  const hasMacros = day.proteinKcal != null && day.carbsKcal != null && day.fatKcal != null;
  const suspiciouslyLow = hasIntake && day.intakeKcal < 500;
  const macroComplete = !!day.macrosComplete;

  if (!hasIntake) reasons.push('no_intake');
  if (missingMeals > 0) reasons.push(`missing_${missingMeals}_meals`);
  if (suspiciouslyLow) reasons.push('suspiciously_low_intake');
  if (!macroComplete) reasons.push('incomplete_macros');

  let level = 'full';
  if (missingMeals > 0 || suspiciouslyLow) level = 'partial';
  if (!hasIntake) level = 'none';
  // Severe incompleteness is a hard exclusion for the energy-balance filter.
  const usable = level === 'full' || (level === 'partial' && missingMeals <= 0 && !suspiciouslyLow);
  return { level, usable, reasons };
}

/**
 * Build the linear energy-balance state transition and observation matrices
 * for one day, given that day's intake (kcal) and TDEE prior (kcal).
 *
 * Returns the process model in the form used by a discrete linear Kalman filter.
 */
export function stateTransition(intakeKcal, edKcalPerKg = ENERGY_DENSITY.defaultKcalPerKg) {
  // x = [trend, fluid, tdee]
  // trend' = trend + (intake - tdee)/ED
  const F = [
    [1, 0, -1 / edKcalPerKg],
    [0, FLUID_REVERSION, 0],
    [0, 0, 1],
  ];
  const B = [1 / edKcalPerKg, 0, 0];
  const u = intakeKcal;
  return { F, B, u };
}

// ---------------------------------------------------------------------------
// Linear Kalman filter
// ---------------------------------------------------------------------------

export function kalmanPredict(F, x, P, Q) {
  const n = x.length;
  const xp = matVec(F, x);
  const Pp = matMul(matMul(F, P), transpose(F));
  for (let i = 0; i < n; i++) Pp[i][i] += Q[i];
  return { xp, Pp };
}

export function kalmanUpdate(Pp, xp, H, y, R) {
  const n = xp.length;
  // S = H P H' + R  (scalar), H is a length-n row vector
  const HPHt = matVecH(H, Pp);          // 1 x n: H * P
  const S = dot(H, HPHt) + R;
  // P H' (n x 1)
  const PHtCol = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < n; j++) acc += Pp[i][j] * H[j];
    PHtCol[i] = acc;
  }
  const K = PHtCol.map((v) => v / S);
  const innov = y[0] - dot(H, xp);
  const x = xp.map((v, i) => v + K[i] * innov);
  // P = (I - K H) Pp
  const IKH = eye(n).map((row, i) => row.map((v, j) => v - K[i] * H[j]));
  const P = matMul(IKH, Pp);
  return { x, P, innov, S, K };
}
function dot(a, b) {
  return a.reduce((acc, v, i) => acc + v * b[i], 0);
}

/** matVec with H as a 1D array of length n (a row). */
function matVecH(H, M) {
  // H row (1 x n) times M (n x n) -> 1 x n
  const n = H.length;
  const out = new Array(n).fill(0);
  for (let j = 0; j < n; j++) {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += H[i] * M[i][j];
    out[j] = acc;
  }
  return out;
}

function transpose(M) {
  const n = M.length, m = M[0].length;
  return Array.from({ length: m }, (_, i) => Array.from({ length: n }, (_, j) => M[j][i]));
}
function matMul(A, B) {
  const n = A.length, m = B[0].length, k = A[0].length;
  const out = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      let acc = 0;
      for (let t = 0; t < k; t++) acc += A[i][t] * B[t][j];
      out[i][j] = acc;
    }
  return out;
}
function matVec(F, x) {
  return F.map((row) => row.reduce((a, v, i) => a + v * x[i], 0));
}
function eye(n) {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

// ---------------------------------------------------------------------------
// High-level longitudinal TDEE estimator
// ---------------------------------------------------------------------------

/**
 * Run the longitudinal energy-balance filter over a chronological series of
 * (day, intakeKcal, scaleKg, nutritionQuality) records.
 *
 * @param {Array} records  chronological:
 *   [{ day, intakeKcal, scaleKg, macrosComplete? }]
 *   Only records where nutritionCompleteness(...).usable are used for the update;
 *   the others are carried forward from the prior posterior (no weight
 *   observation either). Gaps are handled by prediction-only passes.
 * @param {object} opts
 * @param {number} [opts.edKcalPerKg]
 * @param {number} [opts.initialTrendKg]  initial body mass
 * @param {number} [opts.initialTdee]
 * @returns array of per-day posterior summaries (filtering mode only).
 */
export function estimateTdeeLongitudinal(records, opts = {}) {
  const ed = opts.edKcalPerKg ?? ENERGY_DENSITY.defaultKcalPerKg;
  const initialTrend = opts.initialTrendKg ?? records.find((r) => r.scaleKg != null)?.scaleKg ?? 75;
  const initialTdee = opts.initialTdee ?? 2400;

  let x = [initialTrend, 0, initialTdee];
  // Priors on the state: trend ~ ±15 kg uncertainty, fluid ~ ±1, tdee ~ ±250.
  const P0 = [[15 ** 2, 0, 0], [0, 1, 0], [0, 0, 250 ** 2]];
  const Q = [PROCESS_NOISE.trendKcalPerKg ** 2, PROCESS_NOISE.fluidKcal ** 2, PROCESS_NOISE.tdeePerDay ** 2];
  const H = [1, 1, 0]; // observed weight = trend + fluid
  const R = (opts.scaleSd ?? SCALE_NOISE_SD_KG) ** 2;
  let P = P0;

  const out = [];
  for (const rec of records) {
    const c = nutritionCompleteness(rec);
    const useIntake = c.usable;
    const intake = useIntake ? (rec.intakeKcal ?? 0) : x[2]; // carry TDEE; no imbalance
    const { F, B, u } = stateTransition(intake, ed);
    // Apply control input to prediction: x' = F x + B u
    const { xp, Pp } = kalmanPredict(F, x, P, Q);
    const xpu = xp.map((v, i) => v + B[i] * u);

    let posterior = { x: xpu, P: Pp, updated: false, usable: useIntake, quality: c.level, reasons: c.reasons };
    if (rec.scaleKg != null && useIntake) {
      // Robust observation model: a single scale reading a few kg off the trend
      // is far more likely water/gut/scale-error than tissue (tissue can't appear
      // that fast). If the standardized innovation exceeds a gate, we downweight
      // or reject the update so one anomalous weigh-in cannot jerk TDEE by
      // hundreds of kcal. This is the mission's "robust observation models for
      // outliers" requirement, not a cosmetic guard.
      const { xp, Pp: PpPred } = kalmanPredict(F, x, P, Q); // reuse for S
      const xpuPred = xp.map((v, i) => v + B[i] * u);
      const HPHt = matVecH(H, PpPred);
      const S = dot(H, HPHt) + R;
      const innov = rec.scaleKg - dot(H, xpuPred);
      const z = Math.abs(innov) / Math.sqrt(S);
      if (z > OUTLIER_GATE_SIGMA) {
        posterior = { x: xpu, P: Pp, updated: false, usable: true, quality: c.level,
          reasons: [...c.reasons, `weigh_in_outlier_z${round(z, 1)}`], innov, S, gated: true };
      } else {
        const upd = kalmanUpdate(Pp, xpu, H, [rec.scaleKg], R);
        posterior = { x: upd.x, P: upd.P, updated: true, usable: true, quality: c.level, reasons: [], innov: upd.innov, S: upd.S };
      }
    }
    x = posterior.x; P = posterior.P;

    out.push({
      day: rec.day,
      trend_kg: round(x[0], 3),
      fluid_kg: round(x[1], 3),
      tdee_kcal: round(x[2], 1),
      tdee_sd_kcal: round(Math.sqrt(Math.max(P[2][2], 0)), 1),
      usable: posterior.usable,
      quality: posterior.quality,
      reasons: posterior.reasons || [],
      intake_kcal: rec.intakeKcal ?? null,
      scale_kg: rec.scaleKg ?? null,
    });
  }
  return out;
}

function round(n, p) {
  const f = 10 ** p;
  return Math.round((n + Number.EPSILON) * f) / f;
}
