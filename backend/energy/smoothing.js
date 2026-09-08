/**
 * Temporal activity smoothing (Phase 4).
 *
 * The per-minute classifier is context-free: it can flicker between labels
 * minute to minute (walking -> daily_activity -> walking) even while the
 * underlying state is stable. This module imposes temporal continuity with a
 * first-order Hidden Markov Model forward pass over the emitted (label,
 * confidence) series, then returns the smoothed posterior distribution over
 * activity classes for each minute.
 *
 * Why forward-only (filtering), not backward (smoothing): in the live product a
 * minute must be priced when it happens; a backward pass would leak future
 * minutes into the current one. We provide the filtering posterior (what was
 * actually known in real time) as the default, and an optional smoothing pass
 * for retrospective analytics. This matches the mission's distinction between
 * filtering and smoothing modes.
 *
 * The transition matrix encodes how rapidly real activity actually changes
 * (slowly) and which transitions are physiologically rare (e.g. running ->
 * asleep), so a lone anomalous minute cannot reclassify a whole stable period.
 *
 * Emissions: the classifier's confidence is used as a soft observation. We do
 * NOT hard-commit to the argmax label; the HMM blends the observation with the
 * prior from the transition model. Distinguishable-from: we take the raw label
 * as the assertion and confidence as its weight, but the transition prior can
 * still move mass to a more plausible neighbour.
 */

import { ACTIVITY, ACTIVITY_CLASSES, clamp } from './constants.js';

/** Base self-transition (stay in current class) per minute. */
const SELF_TRANSITION = 0.93;
/** Small uniform probability to any state, prevents a zero-probability lockout. */
const EPSILON = 0.001;

/**
 * Build a symmetric-ish transition matrix from a base self-transition and a
 * structural penalty for implausible jumps (e.g. sleep <-> running).
 *
 * @returns {number[][]} index by ACTIVITY_CLASSES order
 */
export function transitionMatrix({ self = SELF_TRANSITION } = {}) {
  const n = ACTIVITY_CLASSES.length;
  const M = Array.from({ length: n }, () => new Array(n).fill(0));
  const offDiagShare = (1 - self) / (n - 1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) M[i][j] = self;
      else {
        // Structural penalty: physiological impossibility / extreme rarity.
        const pi = ACTIVITY_CLASSES[i];
        const pj = ACTIVITY_CLASSES[j];
        let w = offDiagShare;
        if (isImplausible(i, j)) w = offDiagShare * 0.15;
        // Running/sleep and sleep/vigorous are effectively blocked.
        M[i][j] = Math.max(w, EPSILON);
      }
    }
    // renormalize
    const rowSum = M[i].reduce((a, b) => a + b, 0);
    for (let j = 0; j < n; j++) M[i][j] /= rowSum;
  }
  return M;
}

/** Rare/blocked transitions: sleep vs vigorous exercise, and extreme jumps. */
function isImplausible(i, j) {
  const a = ACTIVITY_CLASSES[i];
  const b = ACTIVITY_CLASSES[j];
  if ((a === ACTIVITY.SLEEP && b !== ACTIVITY.SLEEP) || (b === ACTIVITY.SLEEP && a !== ACTIVITY.SLEEP)) return true;
  const vigorous = [ACTIVITY.RUNNING, ACTIVITY.CYCLING, ACTIVITY.STRENGTH];
  if ((vigorous.includes(a) && b === ACTIVITY.STANDING) || (vigorous.includes(b) && a === ACTIVITY.STANDING)) return true;
  if ((a === ACTIVITY.RUNNING && b === ACTIVITY.STRENGTH) || (a === ACTIVITY.STRENGTH && b === ACTIVITY.RUNNING)) return true;
  return false;
}

/**
 * Emission index for a classifier output label.
 */
function indexOf(activity) {
  const i = ACTIVITY_CLASSES.indexOf(activity);
  return i < 0 ? ACTIVITY_CLASSES.indexOf(ACTIVITY.UNKNOWN) : i;
}

/**
 * Filter (online) forward pass over per-minute classifier outputs.
 *
 * @param {Array} minutes  chronological [{ activity, confidence }]
 * @param {number[][]} [T] transition matrix (indexed by ACTIVITY_CLASSES)
 * @param {object} [opts]
 * @param {number} [opts.emissionWeight] how much to trust the emission vs prior
 * @returns Array of { activity, confidence, probs } where probs is the posterior
 *          distribution over ACTIVITY_CLASSES (filtering = causal).
 */
export function smoothActivityFilter(minutes, T = null, { emissionWeight = 0.85, initial = null } = {}) {
  const trans = T ?? transitionMatrix();
  const n = ACTIVITY_CLASSES.length;
  if (!minutes?.length) return [];
  const out = [];
  let prior = initial ?? new Array(n).fill(1 / n);
  for (const m of minutes) {
    const emIdx = indexOf(m.activity);
    // Observation likelihood: put mass on the emitted class, scaled by the
    // emission's confidence/weight.
    const emission = new Array(n).fill((1 - emissionWeight) * (m.confidence ?? 0.5));
    emission[emIdx] = emissionWeight; // strong mass on observed class
    // Predict: next prior = prior * T
    let pred = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) pred[j] += prior[i] * trans[i][j];
    }
    // Update: posterior ∝ pred * emission
    let posterior = pred.map((v, i) => v * (emission[i] + 0.05));
    const sum = posterior.reduce((a, b) => a + b, 0) || 1;
    posterior = posterior.map((v) => v / sum);
    // Put the prior back for the next step but don't let it collapse.
    prior = posterior.map((v) => clamp(v, EPSILON, 1));
    const norm = prior.reduce((a, b) => a + b, 0);
    prior = prior.map((v) => v / norm);

    const argmax = argmaxIndex(posterior);
    out.push({
      activity: ACTIVITY_CLASSES[argmax],
      raw_activity: m.activity,
      confidence: round(posterior[argmax], 4),
      raw_confidence: round(m.confidence ?? 0, 4),
      probs: posterior.map((v) => round(v, 4)),
    });
  }
  return out;
}

/** Backward-smoothing pass over the filtering results (analytics only). */
export function smoothActivityFull(minutes, T = null, opts = {}) {
  const fwd = smoothActivityFilter(minutes, T, opts);
  if (fwd.length < 2) return fwd;
  // A simple single-pass backward smoother: propagate the last posterior
  // backwards through the reversed transition matrix. Kept intentionally light;
  // the full forward-backward algorithm is deferred until a task needs it.
  const trans = T ?? transitionMatrix();
  const n = ACTIVITY_CLASSES.length;
  let back = fwd[fwd.length - 1].probs.slice();
  for (let i = fwd.length - 2; i >= 0; i--) {
    // back[t] = posterior[t] * T * back[t+1] normalized (approximation)
    let b = new Array(n).fill(0);
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) b[j] += back[k] * trans[k][j];
    }
    const combined = fwd[i].probs.map((v, k) => v * (b[k] + 0.05));
    const s = combined.reduce((a, c) => a + c, 0) || 1;
    back = combined.map((v) => v / s);
    const argmax = argmaxIndex(back);
    fwd[i] = {
      ...fwd[i],
      activity: ACTIVITY_CLASSES[argmax],
      confidence: round(back[argmax], 4),
      mode: 'smoothed',
      probs: back.map((v) => round(v, 4)),
    };
  }
  return fwd;
}

function argmaxIndex(arr) {
  let bi = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[bi]) bi = i;
  return bi;
}
function round(n, p) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** p;
  return Math.round(n * f) / f;
}

export { ACTIVITY_CLASSES, ACTIVITY };
