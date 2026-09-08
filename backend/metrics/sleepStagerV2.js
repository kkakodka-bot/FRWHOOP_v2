/**
 * Parity-oriented pure Node port of NOOP SleepStagerV2.swift.
 * Internal vocabulary matches NOOP ("awake"); stageSession emits "wake".
 */

export const STAGE_NAMES = Object.freeze(['deep', 'rem', 'light', 'awake']);
export const BASE_LOG_PRIOR = Object.freeze({
  light: Math.log(0.50),
  deep: Math.log(0.18),
  rem: Math.log(0.22),
  awake: Math.log(0.10),
});
export const TRANSITION = Object.freeze({
  deep: Object.freeze({ deep: 0.86, rem: 0.007, light: 0.126, awake: 0.007 }),
  rem: Object.freeze({ deep: 0.005, rem: 0.88, light: 0.10, awake: 0.015 }),
  light: Object.freeze({ deep: 0.06, rem: 0.06, light: 0.85, awake: 0.03 }),
  awake: Object.freeze({ deep: 0.0, rem: 0.0, light: 0.10, awake: 0.90 }),
});

export const V2_CONSTANTS = Object.freeze({
  padLo: 330,
  padHi: 390,
  deepGateThresh: 0.25,
  deepGateSlope: 5.0,
  jerkFloorMoveMult: 38.0,
  jerkFloorGateMult: 55.0,
  motionGateBoost: 2.0,
  respWeight: 0.6,
  remLatencyPenalty: 3.0,
  remLatencyMinutes: 60,
  onsetSustainedEpochs: 10,
});

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clip(samples, lo, hi) {
  return samples.filter((sample) => sample.ts >= lo && sample.ts < hi);
}

function aggregateBySecond(samples, valueOf) {
  const sums = new Map();
  const counts = new Map();
  for (const sample of samples) {
    const value = valueOf(sample);
    if (!Number.isFinite(value)) continue;
    sums.set(sample.ts, (sums.get(sample.ts) || 0) + value);
    counts.set(sample.ts, (counts.get(sample.ts) || 0) + 1);
  }
  const out = new Map();
  for (const [ts, sum] of sums) out.set(ts, sum / counts.get(ts));
  return out;
}

function stdPresent(values) {
  if (values.length < 2) return null;
  const m = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / values.length);
}

export function respRegularity(beats) {
  if (beats.length < 12) return null;
  const t0 = beats[0][0];
  const tN = beats.at(-1)[0];
  if (tN <= t0) return null;
  const n = Math.ceil((tN - t0) / 0.25 - 1e-9);
  if (n < 16) return null;
  const y = Array(n).fill(0);
  let seg = 0;
  for (let i = 0; i < n; i += 1) {
    const t = t0 + 0.25 * i;
    while (seg < beats.length - 2 && beats[seg + 1][0] < t) seg += 1;
    const [ta, va] = beats[seg];
    const [tb, vb] = beats[seg + 1];
    const fraction = tb <= ta ? 0 : Math.min(1, Math.max(0, (t - ta) / (tb - ta)));
    y[i] = tb <= ta ? va : va + fraction * (vb - va);
  }
  const m = y.reduce((sum, value) => sum + value, 0) / n;
  for (let i = 0; i < n; i += 1) y[i] -= m;
  const kLo = Math.ceil(0.15 * 0.25 * n);
  const kHi = Math.floor(0.40 * 0.25 * n);
  if (kHi < kLo || kLo < 0) return null;
  let maxPower = 0;
  let sumPower = 0;
  for (let k = kLo; k <= kHi; k += 1) {
    let re = 0;
    let im = 0;
    const w = -2 * Math.PI * k / n;
    for (let j = 0; j < n; j += 1) {
      re += y[j] * Math.cos(w * j);
      im += y[j] * Math.sin(w * j);
    }
    const power = re * re + im * im;
    sumPower += power;
    if (power > maxPower) maxPower = power;
  }
  return sumPower === 0 ? null : maxPower / sumPower;
}

export function features(start, end, gravity, hr, rr) {
  if (end <= start) return [];
  const span = Math.max(1, end - start);
  const secHr = aggregateBySecond(hr, (sample) => sample.bpm);

  const gx = aggregateBySecond(gravity, (sample) => sample.x);
  const gy = aggregateBySecond(gravity, (sample) => sample.y);
  const gz = aggregateBySecond(gravity, (sample) => sample.z);
  const secG = new Map();
  for (const ts of gx.keys()) {
    if (gy.has(ts) && gz.has(ts)) secG.set(ts, [gx.get(ts), gy.get(ts), gz.get(ts)]);
  }

  const rrBy = new Map();
  for (const sample of rr) {
    if (!rrBy.has(sample.ts)) rrBy.set(sample.ts, []);
    rrBy.get(sample.ts).push(sample.rrMs);
  }
  const stdOfSeconds = (lo, hi) => {
    const values = [];
    for (let second = lo; second < hi; second += 1) {
      if (secHr.has(second)) values.push(secHr.get(second));
    }
    return stdPresent(values);
  };

  const raws = [];
  const allJerks = [];
  const firstEpoch = Math.ceil(start / 30) * 30;
  for (let epoch = firstEpoch; epoch < end; epoch += 30) {
    const hrs = [];
    const gseq = [];
    for (let second = epoch; second < epoch + 30; second += 1) {
      if (secHr.has(second)) hrs.push(secHr.get(second));
      if (secG.has(second)) gseq.push(secG.get(second));
    }
    if (!hrs.length && !gseq.length) continue;
    const jerks = [];
    for (let i = 1; i < gseq.length; i += 1) {
      const a = gseq[i - 1];
      const b = gseq[i];
      jerks.push(Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2));
    }
    allJerks.push(...jerks);
    const beats = [];
    for (let second = epoch - 90; second < epoch + 120; second += 1) {
      for (const value of rrBy.get(second) || []) {
        beats.push([second, Math.min(2000, Math.max(300, value))]);
      }
    }
    beats.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    raws.push({
      start: epoch,
      hr: hrs.length ? hrs.reduce((sum, value) => sum + value, 0) / hrs.length : null,
      hrVar: stdOfSeconds(epoch - 150, epoch + 180),
      hrFlat11: stdOfSeconds(epoch - 330, epoch + 390),
      jerks,
      gapSec: Math.max(1, gseq.length - 1),
      jerkMax: jerks.length ? Math.max(...jerks) : 0,
      respReg: respRegularity(beats),
      clock: (epoch + 15 - start) / span,
      minutesSinceOnset: (epoch + 15 - start) / 60,
    });
  }
  const jerkScale = median(allJerks) ?? 1e-6;
  const moveThreshold = jerkScale * V2_CONSTANTS.jerkFloorMoveMult;
  return raws.map((raw) => ({
    ...raw,
    moveFrac: raw.jerks.filter((value) => value > moveThreshold).length / raw.gapSec,
    jerkScale,
  }));
}

export function remLatencyGuard(minutesSinceOnset) {
  return V2_CONSTANTS.remLatencyPenalty
    * Math.min(1, Math.max(0, 1 - minutesSinceOnset / V2_CONSTANTS.remLatencyMinutes));
}

export function cyclePrior(clock, minutesSinceOnset) {
  return {
    deep: 1.2 * Math.max(0, 1 - clock / 0.55),
    rem: clock - remLatencyGuard(minutesSinceOnset),
    light: 0,
    awake: 0,
  };
}


/**
 * Softmax over the emission log-probabilities to get normalized class
 * probabilities per epoch. The stager is heuristic, so these are calibration
 * targets, not calibrated probabilities — but exposing them lets the
 * persistence layer store per-epoch uncertainty and lets a later calibrated /
 * model-based stager drop in behind the same interface.
 */
export function softmaxEmissions(emissions) {
  const stages = STAGE_NAMES;
  const probs = emissions.map((em) => {
    const max = Math.max(...stages.map((st) => em[st]));
    const exps = stages.map((st) => Math.exp(em[st] - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    const p = {};
    stages.forEach((st, i) => { p[st] = exps[i] / sum; });
    return p;
  });
  return probs;
}

/** Per-epoch detail: predicted stage, class probabilities, and input coverage. */
export function stageEpochsDetailed(feats) {
  if (!feats.length) return [];
  // Emit the same emissions the Viterbi decoder consumes so probabilities and
  // the final path are mutually consistent.
  const labels = stageEpochs(feats);
  const probs = softmaxEmissions(emissionsFor(feats));
  return feats.map((f, i) => ({
    start: f.start,
    stage: labels[i] === 'awake' ? 'wake' : labels[i],
    probs: probs[i],
    hrPresent: Number.isFinite(f.hr),
    accPresent: f.jerks.length > 0,
    rrPresent: f.respReg != null,
    coverage: [Number.isFinite(f.hr), f.jerks.length > 0, f.respReg != null].filter(Boolean).length / 3,
  }));
}

export function sustainedSleepOnset(labels) {
  let run = 0;
  for (let i = 0; i < labels.length; i += 1) {
    if (labels[i] === 'awake') {
      run = 0;
      continue;
    }
    run += 1;
    if (run >= V2_CONSTANTS.onsetSustainedEpochs) return i - V2_CONSTANTS.onsetSustainedEpochs + 1;
  }
  return null;
}

export function viterbi(emissions) {
  if (!emissions.length) return [];
  const logTransition = Object.fromEntries(STAGE_NAMES.map((from) => [
    from,
    Object.fromEntries(STAGE_NAMES.map((to) => [to, Math.log(Math.max(TRANSITION[from][to], 1e-9))])),
  ]));
  let values = { ...emissions[0] };
  const back = [];
  for (let t = 1; t < emissions.length; t += 1) {
    const next = {};
    const pointers = {};
    for (const stage of STAGE_NAMES) {
      let bestPrevious = STAGE_NAMES[0];
      let bestValue = values[bestPrevious] + logTransition[bestPrevious][stage];
      for (const previous of STAGE_NAMES.slice(1)) {
        const value = values[previous] + logTransition[previous][stage];
        if (value > bestValue) {
          bestValue = value;
          bestPrevious = previous;
        }
      }
      next[stage] = bestValue + emissions[t][stage];
      pointers[stage] = bestPrevious;
    }
    values = next;
    back.push(pointers);
  }
  let last = STAGE_NAMES[0];
  for (const stage of STAGE_NAMES.slice(1)) {
    if (values[stage] > values[last]) last = stage;
  }
  const path = [last];
  for (let i = back.length - 1; i >= 0; i -= 1) {
    last = back[i][last];
    path.push(last);
  }
  return path.reverse();
}

function zFunction(values) {
  const present = values.filter(Number.isFinite);
  if (!present.length) return () => 0;
  const m = present.reduce((sum, value) => sum + value, 0) / present.length;
  const sd0 = Math.sqrt(present.reduce((sum, value) => sum + (value - m) ** 2, 0) / present.length);
  const sd = sd0 === 0 ? 1 : sd0;
  return (value) => (Number.isFinite(value) ? (value - m) / sd : 0);
}

function percentileRight(sorted, value) {
  if (!Number.isFinite(value) || !sorted.length) return 0.5;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

export function emissionsFor(feats) {
  if (!feats.length) return [];
  const zHr = zFunction(feats.map((f) => f.hr));
  const zHrVar = zFunction(feats.map((f) => f.hrVar));
  const zMove = zFunction(feats.map((f) => f.moveFrac));
  const zResp = zFunction(feats.map((f) => f.respReg));
  const flatSorted = feats.map((f) => f.hrFlat11).filter(Number.isFinite).sort((a, b) => a - b);
  return feats.map((f) => {
    const zhr = zHr(f.hr);
    const zhrv = zHrVar(f.hrVar);
    const zmv = zMove(f.moveFrac);
    const gate = V2_CONSTANTS.deepGateSlope
      * Math.max(0, percentileRight(flatSorted, f.hrFlat11) - V2_CONSTANTS.deepGateThresh);
    const cardiac0 = 0.8 * zhrv + 0.4 * zhr;
    const motionQuiescent = f.moveFrac <= 0
      && f.jerkMax <= f.jerkScale * V2_CONSTANTS.jerkFloorGateMult;
    const cardiac = motionQuiescent ? Math.min(0, cardiac0) : cardiac0;
    const emission = {
      deep: -1.1 * zhrv - 0.5 * zmv - gate + BASE_LOG_PRIOR.deep,
      rem: 0.6 * zhrv - 0.6 * zmv + 0.4 * zhr + BASE_LOG_PRIOR.rem,
      light: BASE_LOG_PRIOR.light,
      awake: zmv + cardiac + BASE_LOG_PRIOR.awake,
    };
    const prior = cyclePrior(f.clock, Number.POSITIVE_INFINITY);
    for (const stage of STAGE_NAMES) emission[stage] += prior[stage];
    if (f.jerkMax > f.jerkScale * V2_CONSTANTS.jerkFloorGateMult) {
      emission.awake += V2_CONSTANTS.motionGateBoost;
    }
    if (Number.isFinite(f.respReg)) {
      const z = zResp(f.respReg);
      emission.deep += V2_CONSTANTS.respWeight * z;
      emission.rem -= V2_CONSTANTS.respWeight * z;
    }
    return emission;
  });
}

export function stageEpochs(feats) {
  if (!feats.length) return [];
  const emissions = emissionsFor(feats);
  const provisional = viterbi(emissions);
  const onsetIndex = sustainedSleepOnset(provisional);
  const origin = onsetIndex == null ? 0 : feats[onsetIndex].minutesSinceOnset;
  for (let i = 0; i < emissions.length; i += 1) {
    emissions[i].rem -= remLatencyGuard(feats[i].minutesSinceOnset - origin);
  }
  return viterbi(emissions);
}


export function stageSession({
  start,
  end,
  gravity = [],
  hr = [],
  rr = [],
} = {}) {
  const gravWindow = clip(gravity, start - V2_CONSTANTS.padLo, end + V2_CONSTANTS.padHi)
    .sort((a, b) => a.ts - b.ts);
  const hrWindow = clip(hr, start - V2_CONSTANTS.padLo, end + V2_CONSTANTS.padHi)
    .sort((a, b) => a.ts - b.ts);
  const rrWindow = clip(rr, start - V2_CONSTANTS.padLo, end + V2_CONSTANTS.padHi)
    .map((row, index) => ({ ...row, _index: index }))
    .sort((a, b) => a.ts - b.ts || a._index - b._index);
  const feats = features(start, end, gravWindow, hrWindow, rrWindow);
  if (!feats.length) return [{ start, end, stage: 'light' }];
  const labels = stageEpochs(feats);
  const segments = [];
  for (let i = 0; i < feats.length; i += 1) {
    const stage = labels[i] === 'awake' ? 'wake' : labels[i];
    const segStart = i === 0 ? start : feats[i].start;
    const segEnd = i === feats.length - 1 ? end : feats[i + 1].start;
    const last = segments.at(-1);
    if (last?.stage === stage) last.end = segEnd;
    else segments.push({ start: segStart, end: segEnd, stage });
  }
  return segments;
}
