
/**
 * Uncertainty calibration on WEEE calorimetry ground truth (Phase 8).
 *
 * Fits the wrist-IMU(+HR) ridge on train participants, computes a split-conformal
 * interval width from calibration (hold-out) participants' residuals, and then
 * measures EMPIRICAL coverage on held-out test participants. The mission
 * requirement: a stated 90% interval must contain the reference ~90% of the
 * time — we verify it rather than assert it.
 *
 * Run: node energy/uncertaintyExperiment.mjs [--json]
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildWeeeDataset } from './weeeExperiments.js';
import { ridgeFit, ridgePredict } from './weeeExperiment.mjs';
import { conformalWidth, evaluateCoverage, adaptiveWidths } from './uncertainty.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../data/weee/dataset');

const FEAT = ['enmo_mean','enmo_sma','vm_mean','accel_std','accel_peak','jerk_mean',
  'period_s','movement_intermittency','cadence_band_power_frac','entropy','cadence_cycles_per_min'];

export function mulberry(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** 3-way participant split: train / calibration / test (no participant leaks). */
function threeWay(ids, { calFrac = 0.15, testFrac = 0.25, seed = 5 } = {}) {
  const uniq = [...new Set(ids)];
  const rng = mulberry(seed);
  const sh = uniq.map((id) => ({ id, r: rng() })).sort((a, b) => a.r - b.r).map((o) => o.id);
  const nCal = Math.max(1, Math.round(sh.length * calFrac));
  const nTe = Math.max(1, Math.round(sh.length * testFrac));
  const calSet = new Set(sh.slice(0, nCal));
  const testSet = new Set(sh.slice(nCal, nCal + nTe));
  const trainSet = new Set(sh.slice(nCal + nTe));
  return { trainSet, calSet, testSet };
}

/**
 * Run one conformal-coverage evaluation over several participant splits.
 * Returns mean empirical coverage and mean interval width (homogeneous + adaptive).
 */
export function runUncertaintyExperiment({ root = ROOT, alpha = 0.10, lambda = 1.0, nRepeats = 10, seed = 5 } = {}) {
  const ds = buildWeeeDataset(root);
  const ids = ds.map((d) => d.participant);
  const X = ds.map((d) => [...FEAT.map((f) => d.agg[f] ?? 0), d.hrMean || 0]);
  const y = ds.map((d) => d.metGt);
  // residual std by activity (heteroscedasticity proxy for adaptive widths)
  const actResid = {};
  for (let i = 0; i < ds.length; i++) (actResid[ds[i].activity] ||= []);

  const homo = { coverage: [], width: [] };
  const adapt = { coverage: [], width: [] };

  for (let rep = 0; rep < nRepeats; rep++) {
    const { trainSet, calSet, testSet } = threeWay(ids, { seed: seed + rep });
    const tri = (i) => trainSet.has(ids[i]), cai = (i) => calSet.has(ids[i]), tei = (i) => testSet.has(ids[i]);
    const Xtr = X.filter((_, i) => tri(i)), ytr = y.filter((_, i) => tri(i));
    const Xca = X.filter((_, i) => cai(i)), yca = y.filter((_, i) => cai(i));
    const Xte = X.filter((_, i) => tei(i)), yte = y.filter((_, i) => tei(i));
    if (Xtr.length < 10 || Xca.length < 3 || Xte.length < 3) continue;
    const fit = ridgeFit(Xtr, ytr, lambda);
    const calResid = Xca.map((x, i) => Math.abs(ridgePredict(fit, x) - yca[i]));
    const q = conformalWidth(calResid, alpha);
    const yhatTe = Xte.map((x) => ridgePredict(fit, x));
    const testActs = ds.map((d, i) => (tei(i) ? d.activity : null)).filter(Boolean);

    const h = evaluateCoverage({ yhat: yhatTe, y: yte, widths: Array(yte.length).fill(q), nominalAlpha: alpha });
    homo.coverage.push(h.empirical_coverage); homo.width.push(h.mean_interval_width);

    // adaptive: per-activity residual spread estimated from the CALIBRATION set
    const calActs = ds.map((d, i) => (cai(i) ? d.activity : null)).filter(Boolean);
    const calResidByAct = {};
    let ci = 0;
    for (let i = 0; i < ds.length; i++) if (cai(i)) { (calResidByAct[ds[i].activity] ||= []).push(calResid[ci]); ci++; }
    const actSe = {};
    for (const a of Object.keys(calResidByAct)) actSe[a] = median(calResidByAct[a]) || 1;
    const seTe = yhatTe.map((_, i) => actSe[testActs[i]] || 1);
    const aw = adaptiveWidths(q, seTe, { clampMin: 0.5, clampMax: 2.0 });
    const a2 = evaluateCoverage({ yhat: yhatTe, y: yte, widths: aw, nominalAlpha: alpha });
    adapt.coverage.push(a2.empirical_coverage); adapt.width.push(a2.mean_interval_width);
  }
  const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  return {
    alpha, nominal: 1 - alpha, n_repeats: homo.coverage.length,
    homogeneous: { coverage: round(mean(homo.coverage), 4), width: round(mean(homo.width), 4) },
    adaptive: { coverage: round(mean(adapt.coverage), 4), width: round(mean(adapt.width), 4) },
  };
}

function median(a) { const v = a.slice().sort((x, y) => x - y); if (!v.length) return 0; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; }
function round(n, p) { const f = 10 ** p; return Math.round(n * f) / f; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const r = runUncertaintyExperiment(args.includes('--json') ? {} : {});
  if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`WEEE split-conformal uncertainty calibration (nominal ${(r.nominal * 100).toFixed(0)}% interval, ${r.n_repeats} participant splits)`);
    console.log(`  homogeneous: empirical coverage ${(r.homogeneous.coverage * 100).toFixed(1)}%  mean width ${r.homogeneous.width.toFixed(3)} MET`);
    console.log(`  adaptive   : empirical coverage ${(r.adaptive.coverage * 100).toFixed(1)}%  mean width ${r.adaptive.width.toFixed(3)} MET`);
    console.log('  A coverage near 90% = well calibrated; >95% = over-wide; <85% = over-confident.');
  }
}
