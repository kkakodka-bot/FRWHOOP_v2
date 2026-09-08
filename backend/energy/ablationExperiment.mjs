
/**
 * Phase 16 — ablation study on WEEE calorimetry ground truth.
 *
 * Builds the model up component by component and measures, on participant-held-out
 * test folds, what EACH addition contributes (or fails to contribute) out of
 * sample. This is the mission's ablation discipline: delete complexity that does
 * not earn its keep, and never report a component as helping on the basis of a
 * within-sample improvement.
 *
 * Components (added in order):
 *   0. baseline           predict the global train mean
 *   1. imu                wrist-IMU ridge (Phase 9 winner)
 *   2. +hr                IMU + wrist-ish HR ridge
 *   3. +activity          per-activity expert composition using the GROUND-TRUTH
 *                         activity label (an oracle-activity upper bound for what
 *                         routing could buy once the classifier works): the HR+IMU
 *                         ridge prediction re-anchored by the per-activity training
 *                         median, i.e. activity-aware prediction.
 *   4. +loco              where activity is walking/running, replace with the ACSM
 *                         locomotion expert (cadence-derived speed); other
 *                         activities keep component 3.
 *
 * Every model is scored on the same held-out participants (same folds), so the
 * marginal MAE/R2 columns are directly comparable.
 *
 * Run: node energy/ablationExperiment.mjs  (or --json)
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildWeeeDataset } from './weeeExperiments.js';
import { ridgeFit, ridgePredict } from './weeeExperiment.mjs';
import { participantHeldOutSplit } from './groundTruth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../data/weee/dataset');

const IMU_FEAT = ['enmo_mean','enmo_sma','vm_mean','accel_std','accel_peak','jerk_mean',
  'period_s','movement_intermittency','cadence_band_power_frac','entropy','cadence_cycles_per_min'];

export function mulberry(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function perActMedian(fit, Xca, yca, cacts) {
  const med = {};
  for (let i = 0; i < Xca.length; i++) (med[cacts[i]] ||= []).push(ridgePredict(fit, Xca[i]) - yca[i]);
  const m = {};
  for (const a of Object.keys(med)) {
    const v = med[a].sort((x, y) => x - y);
    m[a] = v.length ? (v.length % 2 ? v[(v.length >> 1)] : (v[(v.length >> 1) - 1] + v[v.length >> 1]) / 2) : 0;
  }
  return m;
}

/** Very light cadence->speed (spm to m/s) and ACSM for walking/running. */
function locomotionMet(activity, cadSpm) {
  if (activity !== 'run1' && activity !== 'run2' && activity !== 'walking') return null;
  if (!cadSpm || cadSpm <= 0 || !Number.isFinite(cadSpm)) return null;
  const speed = (cadSpm * (activity.startsWith('run') ? 1.5 : 0.7)) / 60; // stride m
  const vo2 = activity.startsWith('run')
    ? 0.2 * speed * 60 + 3.5
    : 0.1 * speed * 60 + 3.5;
  const met = vo2 / 3.5;
  // Wrist-cadence harmonics inflate cadence (dominant freq up to 440 cpm), so the
  // ACSM equation returns absurd METs; clamp to a defensible locomotion band and
  // fall back to the activity estimate for anything implausible.
  if (!(met >= 1.0 && met <= 14)) return null;
  return met;
}

function score(y, yhat) {
  const n0 = y.length; if (!n0) return { n: 0 };
  let abs = 0, sq = 0, ysum = 0, pct = 0, pctN = 0, vn = 0;
  for (let i = 0; i < n0; i++) {
    if (!Number.isFinite(yhat[i]) || !Number.isFinite(y[i])) continue;
    vn++;
    abs += Math.abs(yhat[i] - y[i]); sq += (yhat[i] - y[i]) ** 2; ysum += y[i];
    if (Math.abs(y[i]) > 0.5) { pct += Math.abs((yhat[i] - y[i]) / y[i]); pctN++; }
  }
  if (vn === 0) return { n: 0 };
  const my = ysum / vn; let ssTot = 0;
  for (let i = 0; i < n0; i++) { if (Number.isFinite(y[i])) ssTot += (y[i] - my) ** 2; }
  return { n: vn, mae: round(abs / vn), rmse: round(Math.sqrt(sq / vn)), mape: pctN ? round((pct / pctN) * 100, 2) : null, r2: ssTot > 0 ? round(1 - sq / ssTot, 4) : null };
}
function round(x, p = 3) { const f = 10 ** p; return Math.round(x * f) / f; }

export function runAblationExperiment({ root = ROOT, nRepeats = 15, seed = 17, onlyLoco = false } = {}) {
  const ds = buildWeeeDataset(root);
  const ids = ds.map((d) => d.participant);
  const Ximu = ds.map((d) => IMU_FEAT.map((f) => d.agg[f] ?? 0));
  const XimuHr = ds.map((d) => [...IMU_FEAT.map((f) => d.agg[f] ?? 0), d.hrMean || 0]);
  const y = ds.map((d) => d.metGt);
  const acts = ds.map((d) => d.activity);

  const comps = ['baseline', 'imu', 'imu_hr', 'activity', 'loco'];
  const agg = Object.fromEntries(comps.map((c) => [c, { mae: [], r2: [], mape: [] }]));

  for (let rep = 0; rep < nRepeats; rep++) {
    const { train, test } = participantHeldOutSplit(ids, { testFraction: 0.25, seed: seed + rep });
    // further split train -> fit/calibration for activity-correction calibration
    const my = y[train[0]]; let ysum = 0; for (const i of train) ysum += y[i]; const gmean = ysum / train.length;
    const ytr = train.map((i) => y[i]); const yte = test.map((i) => y[i]);
    const tacts = test.map((i) => acts[i]);

    // Fit ridge on (all train) for imu and imu_hr; use same fold for all
    const fitImu = ridgeFit(train.map((i) => Ximu[i]), ytr, 1.0);
    const fitHr = ridgeFit(train.map((i) => XimuHr[i]), ytr, 1.0);

    // calibration residuals (use train itself; small-n, acceptable for correction bias)
    const actBias = {};
    for (let j = 0; j < train.length; j++) {
      const a = acts[train[j]];
      (actBias[a] ||= []).push(ridgePredict(fitHr, XimuHr[train[j]]) - y[train[j]]);
    }
    const bias = {};
    for (const a of Object.keys(actBias)) { const v = actBias[a].sort((x2, y2) => x2 - y2); bias[a] = v.length ? v[Math.floor(v.length / 2)] : 0; }

    const yhatBase = yte.map(() => gmean);
    const yhatImu = test.map((i) => ridgePredict(fitImu, Ximu[i]));
    const yhatImuHr = test.map((i) => ridgePredict(fitHr, XimuHr[i]));
    // activity-aware: ridge prediction minus per-activity median residual
    const yhatAct = test.map((i) => Math.max(0.5, ridgePredict(fitHr, XimuHr[i]) - (bias[acts[i]] || 0)));
    // locomotion: if running, use ACSM; else activity-corrected
    const yhatLoco = test.map((i) => {
      const m = locomotionMet(acts[i], ds[i].agg.cadence_cycles_per_min);
      return m != null ? m : yhatAct[i];
    });

    const preds = [yhatBase, yhatImu, yhatImuHr, yhatAct, yhatLoco];
    preds.forEach((pred, ci) => {
      const s2 = score(yte, pred);
      if (Number.isFinite(s2.mae)) agg[comps[ci]].mae.push(s2.mae);
      if (Number.isFinite(s2.r2)) agg[comps[ci]].r2.push(s2.r2);
      if (s2.mape != null && Number.isFinite(s2.mape)) agg[comps[ci]].mape.push(s2.mape);
    });
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const out = {};
  for (const c of comps) out[c] = { mae: round(mean(agg[c].mae)), r2: round(mean(agg[c].r2)), mape: round(mean(agg[c].mape), 2) };
  return { n_segments: ds.length, n_participants: new Set(ids).size, n_repeats: nRepeats, components: out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const r = runAblationExperiment();
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`WEEE ablation (${r.n_repeats} participant-held-out repeats, ${r.n_segments} segments, ${r.n_participants} participants)`);
    console.log('component                MAE(MET)   MAPE%    R2');
    console.log('------------------------ --------   ------   ------');
    for (const c of ['baseline','imu','imu_hr','activity','loco']) {
      const v = r.components[c];
      console.log(`${c.padEnd(24)} ${String(v.mae).padEnd(8)}  ${String(v.mape).padEnd(7)}  ${v.r2}`);
    }
    console.log('\nInterpretation: each row is the SAME held-out folds. A component that');
    console.log('does not reduce MAE/increase R2 has earned its place. activity = ridge');
    console.log('re-anchored by per-activity median residual (oracle activity label);');
    console.log('loco = ACSM running/walking equations on cadence-derived speed.');
  }
}
