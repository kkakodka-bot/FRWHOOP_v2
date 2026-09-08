
/**
 * RR-interval artifact detection and correction, following Lipponen & Tarvainen
 * (2019) "A robust heart rate variability and complexity analysis..." and the
 * median-normalized derivative framework it builds on (Karlsson et al., 2012).
 *
 * The key idea: an ectopic (early/late) beat produces a large positive RR
 * deviation immediately followed (or preceded) by a large negative one, while a
 * missed beat doubles one interval. We normalize RR by its median, take the
 * first and second derivatives, threshold them, and classify each deviation
 * into: ectopic, missed-beat pair, or extra/short beat. We then correct by
 * replacing the artefactual intervals with the *local* median of neighbouring
 * valid intervals — never by interpolating across a long missing period.
 *
 * Guardrails (physiology, not code style):
 *  - Only beat-level corrections. Intervals that are part of a long gap are
 *    left untouched and reported, never "successfully corrected" into fake
 *    physiology.
 *  - All thresholds are configurable and default to the published values.
 */

import { median } from './quality.js';

export const RR_ARTIFACT_DEFAULTS = Object.freeze({
  // Median-normalized derivative thresholds (Lipponen & Tarvainen table).
  threshold1: 0.13,   // |RR1| above this on consecutive normalized beats -> candidate
  threshold2: 0.13,   // |RR2| above this can mark a second adjacent deviation
  gapBeats: 20,       // a run of >= this many missing intervals is a "long gap", not correctable
  minRrMs: 200,
  maxRrMs: 2500,
});

function finite(n) { return Number.isFinite(Number(n)) ? Number(n) : null; }

/**
 * @param {Array<number>} rrMs raw RR interval series (ms)
 * @returns {{
 *   corrected: number[],           // artifact-free series (artifacts replaced with local median)
 *   artifactIndices: number[],     // indices replaced
 *   artifactType: ('ectopic'|'missed'|'extra'|'unclassifiable|gap')[],
 *   gapStartIndices: number[],     // runs left untouched as long gaps
 *   gapCount: number,
 *   artifactFraction: number,
 * }}
 */
export function correctRRIntervals(rrMs, opts = {}) {
  const cfg = { ...RR_ARTIFACT_DEFAULTS, ...opts };
  const raw = (rrMs || []).map(finite).map((v) => (v == null ? NaN : v));
  const n = raw.length;
  if (n < 4) {
    return { corrected: [...raw.filter(Number.isFinite)], artifactIndices: [], artifactType: [], gapStartIndices: [], gapCount: 0, artifactFraction: 0 };
  }

  // Validate intervals and mark invalid (out of band) as missing.
  const missing = raw.map((v) => !Number.isFinite(v) || v < cfg.minRrMs || v > cfg.maxRrMs);
  const med = median(raw.filter((v) => Number.isFinite(v) && v >= cfg.minRrMs && v <= cfg.maxRrMs)) || 1000;
  const rr = raw.map((v, i) => (missing[i] ? NaN : v / med));

  // Long-gap detection: runs of missing intervals >= gapBeats are uncorrectable
  // and must never be interpolated.
  const gapStartIndices = [];
  let run = 0;
  for (let i = 0; i <= n; i += 1) {
    if (i < n && missing[i]) { run += 1; continue; }
    if (run >= cfg.gapBeats) gapStartIndices.push(i - run);
    run = 0;
  }
  const inLongGap = Array(n).fill(false);
  for (const gs of gapStartIndices) {
    for (let i = gs; i < n && missing[i]; i += 1) inLongGap[i] = true;
  }

  // derivatives of the normalized series (1-indexed guards)
  const d1 = Array(n).fill(NaN);
  const d2 = Array(n).fill(NaN);
  for (let i = 1; i < n; i += 1) d1[i] = rr[i] - rr[i - 1];
  for (let i = 1; i < n - 1; i += 1) d2[i] = rr[i + 1] - rr[i];

  const artifact = Array(n).fill(false);
  const artifactType = Array(n).fill(null);
  for (let i = 1; i < n; i += 1) {
    if (missing[i] || missing[i - 1]) continue;
    if (inLongGap[i] || inLongGap[i - 1]) continue;
    const a = Math.abs(d1[i]);
    const b = Math.abs(d2[i]);
    if (a < cfg.threshold1) continue;
    // Single ectopic: one large deviation that does not persist.
    if (i + 1 < n && !missing[i + 1] && b < cfg.threshold2) {
      artifact[i] = true; artifactType[i] = 'ectopic';
      continue;
    }
    // Missed beat: the next interval is long because one beat was skipped.
    if (i + 1 < n && !missing[i + 1] && rr[i] > 1.3 && rr[i + 1] < 1.0) {
      artifact[i] = true; artifactType[i] = 'missed';
      artifact[i + 1] = true; artifactType[i + 1] = 'missed';
      continue;
    }
    if (i + 1 < n && !missing[i + 1] && rr[i] < 0.7 && rr[i + 1] > 1.3) {
      artifact[i] = true; artifactType[i] = 'extra';
      artifact[i + 1] = true; artifactType[i + 1] = 'extra';
      continue;
    }
    artifact[i] = true; artifactType[i] = 'unclassifiable';
  }

  // Correct: replace each artifact with the local median of valid neighbours.
  const corrected = [...raw];
  const artifactIndices = [];
  for (let i = 0; i < n; i += 1) {
    if (!artifact[i]) continue;
    artifactIndices.push(i);
    // local median over a window excluding the artifact itself
    const lo = Math.max(0, i - 6);
    const hi = Math.min(n, i + 7);
    const nbr = [];
    for (let k = lo; k < hi; k += 1) {
      if (k === i) continue;
      if (Number.isFinite(raw[k]) && !artifact[k]) nbr.push(raw[k]);
    }
    if (nbr.length) corrected[i] = median(nbr);
  }
  const artifactFraction = n ? artifactIndices.length / n : 0;
  return {
    corrected,
    artifactIndices,
    artifactType: artifactIndices.map((i) => artifactType[i]),
    gapStartIndices,
    gapCount: gapStartIndices.length,
    artifactFraction: Math.round(artifactFraction * 100) / 100,
  };
}

/** Marks which intervals are usable (valid, non-artifact, non-gap). */
export function usableRRMask(result, rrMs) {
  const artifact = new Set(result.artifactIndices);
  return (rrMs || []).map((v, i) => Number.isFinite(finite(v))
    && v >= RR_ARTIFACT_DEFAULTS.minRrMs && v <= RR_ARTIFACT_DEFAULTS.maxRrMs
    && !artifact.has(i));
}
