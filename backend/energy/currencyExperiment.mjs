
/**
 * Phase 12 — internal-currency re-evaluation.
 *
 * The current engine uses VO2 (mL/kg/min) as its internal currency: every
 * channel produces a VO2 estimate, fusion happens in VO2 space, and kcal is
 * derived at the end. This experiment checks whether that choice adds anything
 * versus modelling in a different currency directly, on real calorimetry
 * ground truth (WEEE).
 *
 * We fit a participant-held-out ridge to each of three targets:
 *   - MET   (ground-truth VO2 / 3.5)
 *   - VO2   (ground-truth VO2 mL/kg/min)
 *   - kcal  (ground-truth VO2 * weightKg/1000 * ER, with subject weight)
 * all from the SAME wrist-IMU features, in the SAME hold-out frame. Because the
 * currencies are deterministic bijections of each other (VO2 -> MET is /3.5;
 * VO2 -> kcal is *weight*ER/1000), an OLS/ridge that is scale-covariant should
 * give identical relative error in every currency. Any large difference would
 * indicate the currency is doing work (or the model is not scale-covariant).
 *
 * Run: node energy/currencyExperiment.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildWeeeDataset } from './weeeExperiments.js';
import { ridgeFit, ridgePredict } from './weeeExperiment.mjs';
import { participantHeldOutSplit } from './groundTruth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../data/weee/dataset');

const FEAT = ['enmo_mean','enmo_sma','vm_mean','accel_std','accel_peak','jerk_mean',
  'period_s','movement_intermittency','cadence_band_power_frac','entropy','cadence_cycles_per_min'];

export function mulberry(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function mapc(v) {
  let mae = 0, r2 = 0, n = 0;
  return { mae, r2 };
}

export function runCurrencyExperiment({ root = ROOT, nRepeats = 15, seed = 11 } = {}) {
  const ds = buildWeeeDataset(root);
  const ids = ds.map((d) => d.participant);
  const X = ds.map((d) => [...FEAT.map((f) => d.agg[f] ?? 0), d.hrMean || 0]);
  const met = ds.map((d) => d.metGt);
  // VO2 from segment mean (recovered: MET*3.5)
  const vo2 = ds.map((d) => d.metGt * 3.5);
  // kcal/min from subject weight
  const kcalPerMin = ds.map((d, i) => {
    const w = d.weightKg || 70;
    return (d.metGt * 3.5 / 1000) * w * 4.862;
  });

  const agg = { met: { mae: [], r2: [] }, vo2: { mae: [], r2: [] }, kcal: { mae: [], r2: [] } };

  for (let rep = 0; rep < nRepeats; rep++) {
    const { train, test } = participantHeldOutSplit(ids, { testFraction: 0.25, seed: seed + rep });
    const Xtr = train.map((i) => X[i]), Xte = test.map((i) => X[i]);
    for (const [name, yT] of [['met', met], ['vo2', vo2], ['kcal', kcalPerMin]]) {
      const ytr = train.map((i) => yT[i]), yte = test.map((i) => yT[i]);
      const fit = ridgeFit(Xtr, ytr, 1.0);
      const yhat = Xte.map((x) => ridgePredict(fit, x));
      let abs = 0, sq = 0, sy = 0, ys = 0;
      const my = yte.reduce((a, b) => a + b, 0) / yte.length;
      for (let i = 0; i < yte.length; i++) {
        abs += Math.abs(yhat[i] - yte[i]); sq += (yhat[i] - yte[i]) ** 2; sy += (yte[i] - my) ** 2; ys += yte[i];
      }
      const mae = abs / yte.length;
      const r2 = sy > 0 ? 1 - sq / sy : 0;
      agg[name].mae.push(mae); agg[name].r2.push(r2);
    }
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const out = {};
  for (const name of ['met', 'vo2', 'kcal']) {
    out[name] = {
      mae: round(mean(agg[name].mae), 4), r2: round(mean(agg[name].r2), 4),
      mape_rel_met: name === 'met' ? 'host' : 'n/a',
    };
  }
  // Express every currency's error back in MET-equiv for a fair comparison.
  const metMAE = out.met.mae;                       // in MET
  const vo2MAE = out.vo2.mae / 3.5;                  // VO2 mL/kg/min -> MET
  const kcalMAEmet = out.kcal.mae / ((ds[0].weightKg || 70) / 1000 * 4.862 * 3.5); // approx
  return {
    n_segments: ds.length, n_participants: new Set(ids).size, n_repeats: nRepeats,
    per_currency: out,
    comparison:
      `met MAE ${metMAE.toFixed(3)} MET | vo2 MAE ${vo2MAE.toFixed(3)} MET-eq | kcal MAE ${Math.abs(kcalMAEmet).toFixed(3)} MET-eq (approx)`,
  };
}

function round(n, p) { const f = 10 ** p; return Math.round(n * f) / f; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = runCurrencyExperiment();
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`WEEE internal-currency comparison (${r.n_repeats} participant-held-out repeats, ${r.n_segments} segments, ${r.n_participants} participants)`);
    for (const name of ['met', 'vo2', 'kcal']) console.log(`  ${name}: MAE ${r.per_currency[name].mae}  R2 ${r.per_currency[name].r2}`);
    console.log('  comparison (MET-equivalent):', r.comparison);
    console.log('  The three are scalar multiples of each other, so OLS-in-each-currency');
    console.log('  differing -> the VO2 intermediate vs direct-kcal choice is NOT free.');
  }
}
