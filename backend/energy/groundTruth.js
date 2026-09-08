/**
 * Energy ground-truth conversion + validation metric layer (Phase 9).
 *
 * Dataset-agnostic: any public wrist dataset (WEEE, etc.) is reduced to a common
 * representation — per-participant, per-minute segments with (a) wrist sensor
 * features and (b) a ground-truth EE reference — and handed to this module for
 * scoring. Keeps the metric definitions in one place so every dataset and model
 * variant is compared on exactly the same yardstick.
 *
 * GRound truth hierarchy (mission): indirect calorimetry > DLW > research-grade
 * mechanical > energy balance > commercial wearable. WEEE's VO2 Master is
 * portable indirect calorimetry: a spirometry device measuring VO2 + VCO2 (and
 * RER) breath-by-breath. That is the top tier and the ground truth this module
 * is built around.
 *
 * VO2 -> EE:  EE(kcal/min) = VO2(L/min) * ER(kcal/L O2). ER is the energy
 * equivalent of oxygen, RER-dependent: 4.69-5.05 kcal/L. MET = VO2 / 3.5
 * (mL/kg/min convention), which is a *population* convention, not per-subject —
 * see Byrne et al. 2005. We report both the kcal result and the MET, and flag
 * that the 3.5 convention applies.
 */

/** Energy equivalent of O2 (kcal/L) by RER, via the classic table. */
export function energyEquivalentKcalPerL(rer) {
  // Standard calorimetry table (e.g. RER 0.71->4.686, 0.82->4.825, 0.95->4.985, 1.0->5.047)
  // Linear interpolation over the well-characterized range.
  const table = [
    [0.70, 4.686], [0.75, 4.739], [0.80, 4.801], [0.85, 4.862],
    [0.90, 4.924], [0.95, 4.985], [1.00, 5.047],
  ];
  if (rer == null || !Number.isFinite(rer)) return 4.862; // no RER -> RER~0.85 convention
  if (rer <= table[0][0]) return table[0][1];
  if (rer >= table[table.length - 1][0]) return table[table.length - 1][1];
  for (let i = 1; i < table.length; i++) {
    const [x0, y0] = table[i - 1];
    const [x1, y1] = table[i];
    if (rer <= x1) return y0 + ((rer - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 4.862;
}

/**
 * Ground-truth EE from a VO2 / VCO2 (or RER) breath sample.
 *
 * @param {object} g
 * @param {number} g.vo2MlPerKgMin  VO2, mL/kg/min
 * @param {number} g.vo2LPerMin      VO2, L/min (alternative)
 * @param {number} g.weightKg
 * @param {number} [g.vco2LPerMin]  for RER
 * @param {number} [g.rer]          directly supplied RER
 * @param {number} [g.minutes]      duration of this sample in minutes
 * @returns ground-truth kcal (and MET) for the sample
 */
export function gtEnergyFromVo2({ vo2MlPerKgMin, vo2LPerMin, weightKg, vco2LPerMin, rer, minutes = 1 } = {}) {
  let vo2L = vo2LPerMin;
  if (vo2L == null && vo2MlPerKgMin != null && weightKg != null) {
    vo2L = (vo2MlPerKgMin / 1000) * weightKg;
  }
  if (vo2L == null) return null;
  const r = rer ?? (vco2LPerMin != null && vo2L > 0 ? vco2LPerMin / vo2L : null);
  const kcalPerL = energyEquivalentKcalPerL(r);
  const kcalPerMin = vo2L * kcalPerL;
  const met = vo2MlPerKgMin != null ? vo2MlPerKgMin / 3.5 : (vo2L * 1000 / weightKg) / 3.5;
  return {
    kcal: kcalPerMin * minutes, // total for the sample
    kcal_per_min: kcalPerMin * minutes,
    kcalPerMin: kcalPerMin,
    met: Math.round(met * 100) / 100,
    rer: r == null ? null : Math.round(r * 100) / 100,
    kcal_per_l_o2: Math.round(kcalPerL * 1000) / 1000,
    basis: vo2MlPerKgMin != null || vo2LPerMin != null ? 'indirect_calorimetry' : null,
  };
}

/**
 * Split participants into train/test without leaking the same participant's
 * sessions across folds (the mission's participant-held-out requirement).
 * Returns { train, test } as indeices.
 */
export function participantHeldOutSplit(participantIds, { testFraction = 0.2, seed = 1 } = {}) {
  const uniq = [...new Set(participantIds)];
  const rng = mulberry(seed);
  const shuffled = uniq.map((id, i) => [id, rng()]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
  const nTest = Math.max(1, Math.round(shuffled.length * testFraction));
  const testSet = new Set(shuffled.slice(0, nTest));
  const train = [], test = [];
  participantIds.forEach((id, i) => (testSet.has(id) ? test : train).push(i));
  return { train, test, testParticipants: [...testSet], trainParticipants: shuffled.slice(nTest) };
}

function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Score predicted-kcal vs ground-truth-kcal minutes with the full metric suite.
 * Reuses energy/metrics.js semantics; here ground truth is calorimetry, not a
 * wearable, so these are the numbers that decide model promotion.
 */
export function scoreEePrediction(pairs) {
  const n = pairs.length;
  if (!n) return { n: 0 };
  let absSum = 0, sqSum = 0, biasSum = 0, pctSum = 0, pctN = 0, actualSum = 0;
  for (const [p, a] of pairs) {
    absSum += Math.abs(p - a);
    sqSum += (p - a) ** 2;
    biasSum += p - a;
    if (Math.abs(a) > 1e-6) { pctSum += Math.abs((p - a) / a); pctN++; }
    actualSum += a;
  }
  const meanActual = actualSum / n;
  let ssTot = 0;
  for (const [, a] of pairs) ssTot += (a - meanActual) ** 2;
  return {
    n,
    mae: round(absSum / n, 3),
    rmse: round(Math.sqrt(sqSum / n), 3),
    mape: pctN ? round((pctSum / pctN) * 100, 2) : null,
    bias: round(biasSum / n, 3),
    r2: ssTot > 0 ? round(1 - sqSum / ssTot, 4) : null,
    mean_actual_kcal_per_min: round(meanActual, 4),
  };
}

function round(n, p) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** p;
  return Math.round(n * f) / f;
}
