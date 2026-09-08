
// Agreement metrics for 30-second epoch sleep staging / detection.
export const STAGES = ['wake', 'light', 'deep', 'rem'];

// Build predicted per-epoch stage from segment list over [startSec, endSec)
// Each segment: {start, end, stage}. Epoch grid at 30s.
export function epochGrid(startSec, endSec, segments, fill = 'wake') {
  const eps = [];
  for (let t = startSec; t < endSec; t += 30) {
    const seg = segments.find((s) => t >= s.start && t < s.end);
    eps.push(seg ? seg.stage : fill);
  }
  return eps;
}

export function confusionMatrix(pred, truth) {
  const m = Object.fromEntries(STAGES.map((a) => [a, Object.fromEntries(STAGES.map((b) => [b, 0]))]));
  for (let i = 0; i < pred.length; i += 1) {
    m[pred[i]][truth[i]] += 1;
  }
  return m;
}

export function perStageMetrics(cm) {
  const out = {};
  for (const stage of STAGES) {
    const tp = cm[stage][stage];
    let col = 0, row = 0;
    for (const s of STAGES) { col += cm[s][stage]; row += cm[stage][s]; }
    const prec = row > 0 ? tp / row : 0;
    const rec = col > 0 ? tp / col : 0;
    const f1 = (prec + rec) > 0 ? 2 * prec * rec / (prec + rec) : 0;
    out[stage] = { tp, precision: prec, recall: rec, f1 };
  }
  return out;
}

export function overallAccuracy(cm) {
  let diag = 0, total = 0;
  for (const a of STAGES) for (const b of STAGES) { total += cm[a][b]; if (a === b) diag += cm[a][b]; }
  return total ? diag / total : 0;
}

export function macroF1(perStage) {
  return STAGES.reduce((s, st) => s + perStage[st].f1, 0) / STAGES.length;
}

export function balancedAccuracy(cm) {
  let sum = 0, n = 0;
  for (const stage of STAGES) {
    let col = 0;
    for (const s of STAGES) col += cm[s][stage];
    if (col > 0) { sum += cm[stage][stage] / col; n += 1; }
  }
  return n ? sum / n : 0;
}

export function cohenKappa(cm) {
  const classes = STAGES;
  const n = classes.reduce((s, a) => s + classes.reduce((t, b) => t + cm[a][b], 0), 0);
  if (!n) return 0;
  let po = 0, pe = 0;
  for (const a of classes) {
    let row = 0, col = 0;
    for (const b of classes) { row += cm[a][b]; col += cm[b][a]; }
    po += cm[a][a];
    pe += (row / n) * (col / n);
  }
  po /= n;
  return (po - pe) / Math.max(1e-9, 1 - pe);
}

// Binarized sleep (light/deep/rem) vs wake for the labeled truth window.
export function sleepWake(cm) {
  let predSleep = [], truthSleep = [];
  return null;
}
export function sleepWakeConfusion(pair) {
  // pair: array of [pred,truth] stage pairs
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const [p, t] of pair) {
    const ps = p !== 'wake', ts = t !== 'wake';
    if (ps && ts) tp += 1; else if (ps && !ts) fp += 1;
    else if (!ps && !ts) tn += 1; else fn += 1;
  }
  const se = tp + fn ? tp / (tp + fn) : 0;         // sleep sensitivity
  const sp = tn + fp ? tn / (tn + fp) : 0;          // wake specificity
  const acc = (tp + tn) / Math.max(1, tp + tn + fp + fn);
  return { tp, fp, tn, fn, sensitivity: se, specificity: sp, accuracy: acc };
}
