/**
 * Clock alignment between a ground-truth reference (Polar H10) and WHOOP-strap
 * observations.
 *
 * We never assume the strap clock is right. This module:
 *   1. resamples both HR series onto a shared 1 s grid;
 *   2. cross-correlates the two series over a bounded candidate constant-offset
 *      window (default ±120 s, 1 s step) and takes the argmax — this resolves
 *      the gross sync and prevents the drift fit from landing in a wrong
 *      correlation lobe;
 *   3. pairs reference samples with observations in the argmax neighbourhood
 *      and fits a LINEAR drift line on the per-pair offsets
 *      (offset_ms at the reference start + drift_ppm slope);
 *   4. reports the residual standard deviation so the caller sees how much
 *      non-linearity remains instead of trusting a single number blindly.
 *
 * Sign conventions (documented, deterministic):
 *   offset_ms  = (obs time − ref time) at the reference start; positive means
 *                the observation stream LAGS the reference (obs clock behind).
 *   drift_ppm  = relative rate of that offset in parts per million of elapsed
 *                time; positive means the observation clock runs FAST relative
 *                to the reference (offset grows more positive over time).
 *               (matches backend/time/clockCorrection.js estimateDrift sign for
 *                "strap runs fast → positive".)
 *   residual_std_ms = sample SD of per-pair offsets after removing the fitted
 *                line; the amount of clock behaviour left unexplained.
 *
 * Timing/sync guidance: timestamp sync to ≤1 s is the validation-literature
 * norm, and agreement improves with wider averaging windows
 * (_hr_v2_research/ppg_hr_accuracy_research.md §5.2, Van Oost 2025). The 1 s
 * grid and ±120 s window are the V2_DESIGN.md §2 defaults.
 */

import { normalizeReferenceSamples, parseTimestamp } from './reference.js';

const MS = 1000;

// ---------------------------------------------------------------------------
// HR-series helpers
// ---------------------------------------------------------------------------

function obsHr(s) {
  const v = s?.hr ?? s?.bpm;
  return Number.isFinite(v) ? v : null;
}

function obsT(s) {
  if (s == null) return null;
  for (const k of ['t', 'tMs', 't_strap', 'datetime']) {
    const v = Number.isFinite(s[k]) ? s[k] : parseTimestamp(s[k]);
    if (v != null) return v;
  }
  return null;
}

/** Build a 1 Hz (configurable) HR series on a contiguous grid.
 *  `stepMs` must be a whole number of ms (default 1000).
 *  Returns { startMs, stepMs, n, values: (number|null)[] } where values[i] is
 *  the mean HR in [startMs + i*step, startMs + (i+1)*step). */
export function gridHrSeries(samples, { stepMs = 1000 } = {}) {
  const pts = (samples || [])
    .map((s) => ({ t: obsT(s), hr: obsHr(s) }))
    .filter((p) => p.t != null && p.hr != null)
    .sort((a, b) => a.t - b.t);
  if (!pts.length) return { startMs: null, stepMs, n: 0, values: [] };
  const start = Math.floor(pts[0].t / stepMs) * stepMs;
  const end = Math.floor(pts[pts.length - 1].t / stepMs) * stepMs;
  const n = Math.floor((end - start) / stepMs) + 1;
  const sums = new Array(n).fill(0);
  const counts = new Array(n).fill(0);
  for (const p of pts) {
    const idx = Math.floor((p.t - start) / stepMs);
    if (idx >= 0 && idx < n) { sums[idx] += p.hr; counts[idx] += 1; }
  }
  const values = new Array(n);
  for (let i = 0; i < n; i += 1) values[i] = counts[i] ? sums[i] / counts[i] : null;
  return { startMs: start, stepMs, n, values };
}

function pearson(a, b) {
  let sa = 0, sb = 0, ssa = 0, ssb = 0, sab = 0;
  const n = a.length;
  for (let i = 0; i < n; i += 1) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - ma, db = b[i] - mb;
    ssa += da * da; ssb += db * db; sab += da * db;
  }
  if (ssa <= 0 || ssb <= 0) return null;
  return sab / Math.sqrt(ssa * ssb);
}

// ---------------------------------------------------------------------------
// Main alignment
// ---------------------------------------------------------------------------

/**
 * Align observations to a reference via HR cross-correlation + linear drift fit.
 *
 * @param {object} reference — parseReference output (or any { samples: [...] }).
 * @param {Array}  observations — strap observations; each element may use
 *   { t | tMs | t_strap | datetime, hr | bpm }.
 * @param {object} [options]
 * @param {number} [options.maxOffsetSec=120]   bound of the candidate offset window
 * @param {number} [options.stepSec=1]          coarse cross-correlation step (s)
 * @param {number} [options.minOverlapSec=30]   min overlap seconds for a valid xcorr lag
 * @param {number} [options.maxPairGapMs=5000]  max |obs − (ref + offset)| to form a drift pair
 * @param {number} [options.minPairs=10]        min drift-fit pairs to report a drift
 * @returns {{
 *   ok, offset_ms, drift_ppm, residual_std_ms, method, n_pairs,
 *   coarse_offset_ms, peak_correlation, at_window_edge, reason?
 * }} — ok:false with `reason` when there is not enough data/overlap.
 */
export function alignReference(reference, observations, options = {}) {
  const opts = {
    maxOffsetSec: 120,
    stepSec: 1,
    minOverlapSec: 30,
    maxPairGapMs: 5000,
    minPairs: 10,
    ...options,
  };
  const ref = normalizeReferenceSamples(reference?.samples ?? reference);
  const obs = normalizeReferenceSamples(
    (Array.isArray(observations) ? observations : []).map((o) => ({
      t: obsT(o), hr: obsHr(o),
    })),
  );
  if (ref.length < opts.minPairs || obs.length < opts.minPairs) {
    return { ok: false, reason: 'insufficient_data',
      offset_ms: null, drift_ppm: null, residual_std_ms: null, method: 'xcorr_1s_pearson+linear_drift', n_pairs: 0 };
  }
  const gRef = gridHrSeries(ref);
  const gObs = gridHrSeries(obs);

  // --- coarse cross-correlation over the bounded window ---------------------
  const stepIdx = Math.max(1, Math.round(opts.stepSec * 1000 / gRef.stepMs));
  const maxIdx = Math.round(opts.maxOffsetSec * 1000 / gRef.stepMs);
  const idxShift = Math.round((gRef.startMs - gObs.startMs) / gObs.stepMs);
  let best = null; // { k, r, n }
  for (let k = -maxIdx; k <= maxIdx; k += stepIdx) {
    const a = []; const b = [];
    for (let i = 0; i < gRef.n; i += 1) {
      const j = i + k + idxShift;
      const rv = gRef.values[i];
      const ov = (j >= 0 && j < gObs.n) ? gObs.values[j] : null;
      if (rv != null && ov != null) { a.push(rv); b.push(ov); }
    }
    if (a.length < opts.minOverlapSec * 1000 / gRef.stepMs) continue;
    const r = pearson(a, b);
    if (r == null) continue;
    if (!best || r > best.r) best = { k, r, n: a.length };
  }
  if (!best) {
    return { ok: false, reason: 'insufficient_overlap',
      offset_ms: null, drift_ppm: null, residual_std_ms: null, method: 'xcorr_1s_pearson+linear_drift',
      coarse_offset_ms: null, peak_correlation: null, n_pairs: 0 };
  }
  const coarseOffsetMs = best.k * gRef.stepMs;
  const atWindowEdge = Math.abs(best.k) >= maxIdx - stepIdx;

  // --- pair reference samples to observations in the argmax neighborhood ----
  const obsByT = obs; // normalized, sorted
  const pairs = [];
  const gapMs = opts.maxPairGapMs;
  for (const r of ref) {
    const want = r.t + coarseOffsetMs;
    // binary search nearest obs
    let lo = 0, hi = obsByT.length - 1, mid = 0;
    while (lo <= hi) {
      mid = (lo + hi) >> 1;
      if (obsByT[mid].t < want) lo = mid + 1; else hi = mid - 1;
    }
    let bestIdx = -1; let bestGap = Infinity;
    for (const cand of [lo - 1, lo, lo + 1]) {
      if (cand < 0 || cand >= obsByT.length) continue;
      const d = Math.abs(obsByT[cand].t - want);
      if (d < bestGap) { bestGap = d; bestIdx = cand; }
    }
    if (bestIdx !== -1 && bestGap <= gapMs) pairs.push({ t_ref: r.t, residual: obsByT[bestIdx].t - r.t });
  }
  if (pairs.length < opts.minPairs) {
    return { ok: false, reason: 'insufficient_pairs',
      offset_ms: null, drift_ppm: null, residual_std_ms: null, method: 'xcorr_1s_pearson+linear_drift',
      coarse_offset_ms: coarseOffsetMs, peak_correlation: best.r, n_pairs: pairs.length };
  }

  // --- robust outlier trim on the constant offset ---------------------------
  const sortedRes = pairs.map((p) => p.residual).sort((a, b) => a - b);
  const median = sortedRes.length % 2
    ? sortedRes[sortedRes.length >> 1]
    : (sortedRes[(sortedRes.length >> 1) - 1] + sortedRes[sortedRes.length >> 1]) / 2;
  const adev = [];
  for (const v of sortedRes) adev.push(Math.abs(v - median));
  adev.sort((a, b) => a - b);
  const mad = adev[adev.length >> 1];
  const sd0 = Math.max(1.4826 * mad, gapMs * 0.1); // absolute floor: pair gap * 0.1
  const kept = pairs.filter((p) => Math.abs(p.residual - median) <= Math.max(6 * sd0, 5000));

  // --- linear drift fit (offset at t_ref0 + slope) --------------------------
  const t0 = kept.length ? Math.min(...kept.map((p) => p.t_ref)) : 0;
  let n = kept.length;
  let sx = 0, sy = 0;
  for (const p of kept) { sx += p.t_ref - t0; sy += p.residual; }
  let slope = 0;
  let den = 0, num = 0;
  const mx = sx / n;
  const my = sy / n;
  for (const p of kept) {
    const dx = (p.t_ref - t0) - mx;
    den += dx * dx;
    num += dx * (p.residual - my);
  }
  if (den > 0) slope = num / den; // ms per ms
  const intercept = my - slope * mx; // residual at t0 (ms)
  let ss = 0;
  for (const p of kept) {
    const fitted = intercept + slope * (p.t_ref - t0);
    ss += (p.residual - fitted) ** 2;
  }
  const residualStdMs = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;

  return {
    ok: true,
    offset_ms: Math.round(intercept),
    drift_ppm: Math.round(slope * 1e6),
    residual_std_ms: Math.round(residualStdMs * 10) / 10,
    method: 'xcorr_1s_pearson+linear_drift',
    n_pairs: n,
    coarse_offset_ms: coarseOffsetMs,
    peak_correlation: Math.round(best.r * 1000) / 1000,
    repeatability_ms: atWindowEdge ? null : Math.round(6 * sd0 * 10) / 10, // ~±3σ acceptance band
    at_window_edge: atWindowEdge,
  };
}
