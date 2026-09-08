
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildWeeeDataset } from './weeeExperiments.js';
import { participantHeldOutSplit } from './groundTruth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../data/weee/dataset');

const FEATURES = [
  'enmo_mean', 'enmo_sma', 'vm_mean', 'accel_std', 'accel_peak', 'accel_rms',
  'jerk_mean', 'period_s', 'periodicity_strength', 'movement_intermittency',
  'cadence_band_power_frac', 'entropy', 'gravity_z_mean', 'tilt_estimate',
  'ax_ay_corr', 'ay_az_corr', 'ax_az_corr', 'enmo_mad',
];

export function ridgeFit(X, y, lambda = 1.0) {
  const n = X.length, p = X[0].length;
  const meanX = new Array(p).fill(0), sdX = new Array(p).fill(0);
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  for (let j = 0; j < p; j++) { let s = 0; for (let i = 0; i < n; i++) s += X[i][j]; meanX[j] = s / n; }
  for (let j = 0; j < p; j++) { let s = 0; for (let i = 0; i < n; i++) s += (X[i][j] - meanX[j]) ** 2; sdX[j] = Math.sqrt(Math.max(s / n, 1e-9)); if (sdX[j] < 1e-3) sdX[j] = 1; }
  const Xs = X.map((row) => row.map((v, j) => (v - meanX[j]) / sdX[j]));
  const yc = y.map((v) => v - meanY);
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < p; j++) {
    Xty[j] += Xs[i][j] * yc[i];
    for (let k = 0; k < p; k++) XtX[j][k] += Xs[i][j] * Xs[i][k];
  }
  for (let j = 0; j < p; j++) XtX[j][j] += lambda;
  const w = solveLinear(XtX, Xty);
  return { w, meanX, sdX, meanY, p, n };
}
export function ridgePredict(fit, x) {
  let acc = fit.meanY ?? 0;
  for (let j = 0; j < fit.p; j++) acc += fit.w[j] * ((x[j] - fit.meanX[j]) / fit.sdX[j]);
  return acc;
}
function solveLinear(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col]; if (Math.abs(d) < 1e-12) continue;
    for (let j = col; j <= n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) { if (r === col) continue; const f = M[r][col]; if (Math.abs(f) < 1e-12) continue; for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j]; }
  }
  return M.map((row) => row[n]);
}
function score(y, yhat) {
  const n = y.length; if (!n) return null;
  let abs = 0, sq = 0, pct = 0, pctN = 0, bias = 0, ysum = 0;
  for (let i = 0; i < n; i++) { abs += Math.abs(yhat[i] - y[i]); sq += (yhat[i] - y[i]) ** 2; bias += yhat[i] - y[i]; if (Math.abs(y[i]) > 0.5) { pct += Math.abs((yhat[i] - y[i]) / y[i]); pctN++; } ysum += y[i]; }
  const my = ysum / n; let ssTot = 0; for (let i = 0; i < n; i++) ssTot += (y[i] - my) ** 2;
  return { n, mae: round(abs / n), mape: pctN ? round((pct / pctN) * 100) : null, rmse: round(Math.sqrt(sq / n)), bias: round(bias / n), r2: ssTot > 0 ? round(1 - sq / ssTot) : null, mean_target: round(my) };
}
function round(x, p = 3) { return Math.round(x * 10 ** p) / 10 ** p; }

const ACTS = ['sit', 'stand', 'cycle1', 'cycle2', 'run1', 'run2'];

export function runWeeeExperiment({ root = ROOT, lambda = 1.0, seed = 1, nRepeats = 10 } = {}) {
  const ds = buildWeeeDataset(root);
  const ids = ds.map((d) => d.participant);
  const allRows = {
    imu: ds.map((d) => FEATURES.map((f) => d.agg[f] ?? 0)),
    hr: ds.map((d) => [d.hrMean ?? 0]),
    imu_hr: ds.map((d) => [...FEATURES.map((f) => d.agg[f] ?? 0), d.hrMean ?? 0]),
  };
  const y = ds.map((d) => d.metGt);
  const acts = ds.map((d) => d.activity);

  const result = {};
  for (const model of Object.keys(allRows)) {
    const agg = { mae: [], mape: [], r2: [] };
    const byActivity = {};
    const baselineMean = { mae: [] };
    const baselineMed = { mae: [] };
    for (let rep = 0; rep < nRepeats; rep++) {
      const { train, test } = participantHeldOutSplit(ids, { testFraction: 0.25, seed: seed + rep });
      const Xtr = train.map((i) => allRows[model][i]); const ytr = train.map((i) => y[i]);
      const Xte = test.map((i) => allRows[model][i]); const yte = test.map((i) => y[i]);
      const fit = ridgeFit(Xtr, ytr, lambda);
      const yhat = Xte.map((x) => ridgePredict(fit, x));
      const s = score(yte, yhat);
      agg.mae.push(s.mae); if (s.mape != null) agg.mape.push(s.mape); agg.r2.push(s.r2);
      // baselines
      const gm = ytr.reduce((a, b) => a + b, 0) / ytr.length;
      baselineMean.mae.push(Math.abs((gm - yte[0])) / 1 || 0); // placeholder; real calc below
      baselineMean.mae.length--; // remove placeholder
      let bm = 0; for (let i = 0; i < yte.length; i++) bm += Math.abs(gm - yte[i]); bm /= yte.length;
      baselineMean.mae.push(bm);
      // per-activity training median baseline
      const medByAct = {};
      for (let i = 0; i < train.length; i++) { const a = acts[train[i]]; (medByAct[a] ||= []).push(y[train[i]]); }
      let bmed = 0;
      for (let i = 0; i < test.length; i++) {
        const m = median(medByAct[acts[test[i]]] || [gm]);
        bmed += Math.abs(m - yte[i]);
      }
      baselineMed.mae.push(bmed / Math.max(test.length, 1));
      for (let i = 0; i < test.length; i++) {
        const a = acts[test[i]];
        (byActivity[a] ||= { y: [], yhat: [] });
        byActivity[a].y.push(yte[i]); byActivity[a].yhat.push(yhat[i]);
      }
    }
    const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    const actOut = {};
    for (const a of ACTS) if (byActivity[a]) actOut[a] = score(byActivity[a].y, byActivity[a].yhat);
    result[model] = {
      n_segments: ds.length, n_participants: new Set(ids).size,
      held_out_mae: round(mean(agg.mae)), held_out_mape: round(mean(agg.mape), 2), held_out_r2: round(mean(agg.r2)),
      baseline_global_mean_mae: round(mean(baselineMean.mae)),
      baseline_activity_median_mae: round(mean(baselineMed.mae)),
      by_activity: actOut,
    };
  }
  return result;
}

function median(a) {
  const v = a.slice().sort((x, y) => x - y);
  if (!v.length) return 0;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const kwargs = {};
  const li = args.indexOf('--lambda'); if (li >= 0) kwargs.lambda = Number(args[li + 1]);
  const ri = args.indexOf('--repeats'); if (ri >= 0) kwargs.nRepeats = Number(args[ri + 1]);
  const r = runWeeeExperiment(kwargs);
  if (json) { console.log(JSON.stringify(r, null, 2)); }
  else {
    for (const m of ['imu', 'hr', 'imu_hr']) {
      const row = r[m];
      console.log(`\n[${m}] participant-held-out (${row.n_segments} segs, ${row.n_participants} participants)`);
      console.log(`  ridge  MAE ${row.held_out_mae} MET | MAPE ${row.held_out_mape}% | R2 ${row.held_out_r2}`);
      console.log(`  baseline global-mean MAE ${row.baseline_global_mean_mae} | activity-median MAE ${row.baseline_activity_median_mae}`);
      console.log('  by activity (MAE / bias):');
      for (const a of ACTS) if (row.by_activity[a]) console.log(`    ${a}: n=${row.by_activity[a].n} MAE ${row.by_activity[a].mae} bias ${row.by_activity[a].bias}`);
    }
  }
}
