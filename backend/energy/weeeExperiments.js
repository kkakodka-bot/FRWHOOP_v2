/**
 * WEEE wrist energy experiments (Phase 9).
 *
 * Scientific core: does wrist accelerometry from a WHOOP-like wrist device
 * predict VO2-Master calorimetry MET across 6 activities, with participant-held-
 * out folds? This is the honest transfer test the mission demands.
 *
 * Design:
 *  - Reduce each segment's 32 Hz ACC to 10-s epoch features (imuFeatures.js).
 *  - Segment ground-truth MET = mean VO2(mL/kg/min) / 3.5 over the segment
 *    (indirect calorimetry, per-subject).
 *  - Models: IMU-only ridge (the WHOOP-wrist-relevant one) evaluated with
 *    participant-held-out splits. Report MAE/MAPE/R2 on MET, and by activity.
 */
import { extractImuFeatures } from './imuFeatures.js';
import { loadWeeeDataset, loadE4Acc } from './weeeLoader.js';
import path from 'node:path';

const EPOCH_S = 10;

/** Per-segment: compute mean epoch features + HR + ground-truth MET.
 *  ACC samples are Sliced to the segment's wall-clock window [startMs,endMs):
 *  acc index i is at unix (acc.t0 + i/rate) seconds. */
export function segmentFeatures(seg, rootDir) {
  const acc = loadE4Acc(path.join(rootDir, seg.participant, 'E4', 'ACC.csv'));
  const rate = acc.rate || 32;
  const win = rate * EPOCH_S;
  // compute the acc sample-index range covering [seg.startMs, seg.endMs)
  const sStartRel = (seg.startMs / 1000 - acc.t0) * rate;
  const sEndRel = (seg.endMs / 1000 - acc.t0) * rate;
  const i0 = Math.max(0, Math.floor(sStartRel));
  const i1 = Math.min(acc.n, Math.ceil(sEndRel));
  const feats = [];
  for (let s = i0; s + win <= i1; s += win) {
    const f = extractImuFeatures({
      ax: acc.ax.slice(s, s + win), ay: acc.ay.slice(s, s + win), az: acc.az.slice(s, s + win),
      sampleRate: rate,
    });
    if (f) feats.push(f);
  }
  const metGt = seg.vo2.length ? Math.round((seg.vo2.reduce((a, v) => a + v.vo2MlPerKgMin, 0) / seg.vo2.length) / 3.5 * 1000) / 1000 : null;
  const hr = seg.vo2.length ? Math.round(seg.vo2.reduce((a, v) => a + (v.hr > 30 && v.hr < 220 ? v.hr : 0), 0) / seg.vo2.filter((v) => v.hr > 30 && v.hr < 220).length) : null;
  const hrMeanRaw = seg.vo2.filter((v) => v.hr > 30 && v.hr < 220).map((v) => v.hr);
  const hrMean = hrMeanRaw.length ? hrMeanRaw.reduce((a, b) => a + b, 0) / hrMeanRaw.length : null;
  // aggregate features over epochs (mean)
  const agg = {};
  if (feats.length) {
    const keys = Object.keys(feats[0]);
    for (const k of keys) {
      const vals = feats.map((f) => f[k]).filter((v) => v != null);
      agg[k] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000 : null;
    }
  }
  return { ...seg, metGt, hrMean, agg };
}

/** Build the full per-segment dataset. */
export function buildWeeeDataset(rootDir) {
  const ds = loadWeeeDataset(rootDir);
  const rows = [];
  for (const p of ds.participants) {
    for (const seg of p.segs) {
      // only segments with real VO2 and full accel
      if (!seg.vo2 || seg.vo2.length < 30) continue;
      const f = segmentFeatures(seg, rootDir);
      if (!f.metGt || !f.agg || !Object.keys(f.agg).length) continue;
      rows.push(f);
    }
  }
  return rows;
}

export { EPOCH_S };
