/**
 * Respiratory-rate estimators.
 *
 * Each estimator is an independent measurement of the same quantity from a
 * different physical mechanism, returning `{ value, confidence, quality }` or
 * null. They are deliberately NOT allowed to fall back on each other: the fusion
 * layer needs to see which mechanisms agreed, and an estimator that silently
 * borrows another's answer would inflate the agreement term with a copy of
 * itself.
 *
 * Only ONE estimator is live today. Respiratory sinus arrhythmia works from RR
 * intervals, which FRWHOOP receives. The three PPG-derived mechanisms
 * (respiratory-induced amplitude, frequency and baseline-wander variation) need
 * a raw PPG waveform, which does not reach the backend — see `capability.js`.
 * They are declared here with their requirements so `describeEstimators()` can
 * report exactly what is missing, rather than the fusion silently having one
 * input and looking like it had four.
 */

import { SENSORS, missingSignals } from '../signal/capability.js';
import { clamp, num } from '../signal/constants.js';
import { rrStats } from '../signal/quality.js';
import {
  FREQ_STEP_HZ,
  MIN_CLEAN_BEATS,
  MIN_PEAK_PROMINENCE,
  MOTION_CEILING_G,
  RESP_BAND_HZ,
  WINDOW,
} from './constants.js';

/**
 * Lomb-Scargle periodogram.
 *
 * Used instead of resample-then-FFT because an RR tachogram is inherently
 * unevenly sampled — one point per heartbeat, and the strap delivers beats in
 * bursts. Interpolating onto a uniform grid to satisfy an FFT injects power at
 * the interpolation scale, which lands in the respiratory band and is precisely
 * the thing being measured. Lomb-Scargle takes the irregular timestamps as they
 * are.
 *
 * `times` in seconds, `values` in the series' own unit. Returns normalized power
 * per probed frequency.
 */
export function lombScargle(times, values, { minHz, maxHz, stepHz = FREQ_STEP_HZ }) {
  const n = Math.min(times.length, values.length);
  if (n < 8) return [];

  const mean = values.reduce((a, b) => a + b, 0) / n;
  let variance = 0;
  for (const v of values) variance += (v - mean) ** 2;
  variance /= (n - 1);
  if (variance <= 0) return [];

  const out = [];
  for (let f = minHz; f <= maxHz + 1e-12; f += stepHz) {
    const w = 2 * Math.PI * f;

    // Time offset tau makes the sine and cosine sums orthogonal, which is what
    // removes the periodogram's dependence on the arbitrary time origin.
    let sin2 = 0;
    let cos2 = 0;
    for (let i = 0; i < n; i += 1) {
      sin2 += Math.sin(2 * w * times[i]);
      cos2 += Math.cos(2 * w * times[i]);
    }
    const tau = Math.atan2(sin2, cos2) / (2 * w);

    let cTerm = 0;
    let sTerm = 0;
    let cc = 0;
    let ss = 0;
    for (let i = 0; i < n; i += 1) {
      const arg = w * (times[i] - tau);
      const c = Math.cos(arg);
      const s = Math.sin(arg);
      const dy = values[i] - mean;
      cTerm += dy * c;
      sTerm += dy * s;
      cc += c * c;
      ss += s * s;
    }

    const power = (1 / (2 * variance))
      * ((cc > 0 ? (cTerm * cTerm) / cc : 0) + (ss > 0 ? (sTerm * sTerm) / ss : 0));
    out.push({ freqHz: f, power });
  }
  return out;
}

/**
 * Locate the dominant peak and how much it stands out from the band.
 *
 * `prominence` is the share of total in-band power held by the peak and its two
 * neighbours. A single sharp respiratory peak concentrates power; broadband
 * motion noise does not, and that difference is the only thing distinguishing
 * them here.
 */
export function dominantPeak(spectrum) {
  if (!spectrum?.length) return null;
  const total = spectrum.reduce((a, p) => a + p.power, 0);
  if (total <= 0) return null;

  let bestIndex = 0;
  for (let i = 1; i < spectrum.length; i += 1) {
    if (spectrum[i].power > spectrum[bestIndex].power) bestIndex = i;
  }

  const near = spectrum
    .slice(Math.max(0, bestIndex - 1), bestIndex + 2)
    .reduce((a, p) => a + p.power, 0);

  return {
    freqHz: spectrum[bestIndex].freqHz,
    power: spectrum[bestIndex].power,
    prominence: near / total,
    index: bestIndex,
    // A peak pinned to the band edge is usually a detrending residual or an
    // out-of-band component leaking in, not a resolved respiratory frequency.
    atEdge: bestIndex === 0 || bestIndex === spectrum.length - 1,
  };
}

/**
 * Respiratory sinus arrhythmia: respiratory rate from RR-interval modulation.
 *
 * Breathing modulates vagal outflow, which modulates beat-to-beat interval, so
 * the breathing frequency appears as a peak in the RR tachogram's spectrum. This
 * is the only estimator with live inputs.
 *
 * Known limitations, all of which reduce confidence rather than being hidden:
 *  - RSA amplitude falls with age and with sympathetic dominance, so the peak
 *    weakens exactly when a user is stressed or unwell.
 *  - During exercise, motion artifact in the beat detector produces in-band RR
 *    jitter indistinguishable from breathing, so windows above MOTION_CEILING_G
 *    are refused outright rather than estimated.
 *
 * @param {object} input
 * @param {Array}  input.beats  [{ ts (ms), rrMs }] or samples with rr_ms arrays
 * @param {number} input.motion mean motion magnitude over the window
 */
export function respirationFromRrIntervals({ beats = [], motion = null, windowSeconds = null } = {}) {
  const mot = num(motion);
  if (mot != null && mot > MOTION_CEILING_G) {
    return { estimator: 'rsa_rr', value: null, reason: 'motion above trust ceiling', motion: mot };
  }

  const rows = (beats || [])
    .map((b) => ({ ts: num(b.ts) ?? Date.parse(b.at ?? b.t ?? ''), rrMs: num(b.rrMs ?? b.rr_ms) }))
    .filter((b) => Number.isFinite(b.ts) && b.rrMs != null)
    .sort((a, b) => a.ts - b.ts);

  if (rows.length < MIN_CLEAN_BEATS) {
    return { estimator: 'rsa_rr', value: null, reason: `need ${MIN_CLEAN_BEATS} beats, have ${rows.length}` };
  }

  const spanSeconds = windowSeconds ?? (rows[rows.length - 1].ts - rows[0].ts) / 1000;
  if (spanSeconds < WINDOW.minSeconds) {
    return { estimator: 'rsa_rr', value: null, reason: `window ${Math.round(spanSeconds)}s below ${WINDOW.minSeconds}s minimum` };
  }

  // Artifact rejection first: a single missed or double-counted beat creates a
  // step in the tachogram whose spectral leakage covers the whole band.
  const stats = rrStats(rows.map((r) => r.rrMs));
  if (stats.count < MIN_CLEAN_BEATS) {
    return {
      estimator: 'rsa_rr',
      value: null,
      reason: `only ${stats.count} beats survived artifact rejection`,
      artifactFraction: stats.artifactFraction,
    };
  }

  // Exact re-pairing via the positions rrStats kept, so a beat's time always
  // belongs to its own interval.
  const kept = stats.keptIndices.map((i) => rows[i]);

  const t0 = kept[0].ts;
  const times = kept.map((r) => (r.ts - t0) / 1000);
  const values = kept.map((r) => r.rrMs);

  const spectrum = lombScargle(times, values, {
    minHz: RESP_BAND_HZ.min,
    maxHz: RESP_BAND_HZ.max,
  });
  const peak = dominantPeak(spectrum);
  if (!peak) {
    return { estimator: 'rsa_rr', value: null, reason: 'no spectral power in the respiratory band' };
  }
  if (peak.prominence < MIN_PEAK_PROMINENCE) {
    return {
      estimator: 'rsa_rr',
      value: null,
      reason: `peak prominence ${peak.prominence.toFixed(3)} below ${MIN_PEAK_PROMINENCE}`,
      prominence: peak.prominence,
    };
  }

  const brpm = peak.freqHz * 60;

  // Confidence is built from the three things that actually determine whether
  // this number is real: how cleanly the peak stands out, how much of the beat
  // series survived artifact rejection, and how much of the window was covered.
  const prominenceTerm = clamp((peak.prominence - MIN_PEAK_PROMINENCE) / (0.6 - MIN_PEAK_PROMINENCE), 0, 1);
  const cleanTerm = clamp(1 - stats.artifactFraction, 0, 1);
  const beatTerm = clamp(stats.count / (MIN_CLEAN_BEATS * 3), 0.2, 1);
  let confidence = 0.25 + 0.45 * prominenceTerm + 0.2 * cleanTerm + 0.1 * beatTerm;
  if (peak.atEdge) confidence *= 0.6;
  if (mot != null) confidence *= clamp(1 - mot / MOTION_CEILING_G * 0.3, 0.6, 1);

  return {
    estimator: 'rsa_rr',
    value: Math.round(brpm * 10) / 10,
    confidence: clamp(confidence, 0, 1),
    quality: clamp(cleanTerm * clamp(stats.count / MIN_CLEAN_BEATS, 0, 1), 0, 1),
    mechanism: 'respiratory sinus arrhythmia',
    peakHz: peak.freqHz,
    prominence: Math.round(peak.prominence * 1000) / 1000,
    beats: stats.count,
    artifactFraction: Math.round(stats.artifactFraction * 1000) / 1000,
    windowSeconds: Math.round(spanSeconds),
    sourceSignals: ['rr_intervals'],
  };
}

/**
 * The PPG-derived estimators, declared but not implemented.
 *
 * Each is a genuinely different mechanism and would be a real fourfold increase
 * in evidence — respiratory-induced intensity variation (baseline wander from
 * venous return), amplitude variation (pulse strength modulation), and frequency
 * variation (the PPG-side view of RSA). All three need the raw waveform.
 *
 * They are listed rather than stubbed so that `describeEstimators()` reports a
 * fusion running at one of four mechanisms, with the unlock path attached. A
 * stub returning a plausible number would be the single most damaging thing in
 * this module.
 */
export const PPG_ESTIMATORS = Object.freeze([
  {
    estimator: 'riiv_ppg',
    mechanism: 'respiratory-induced intensity variation (baseline wander)',
    requires: ['ppg_waveform'],
  },
  {
    estimator: 'riav_ppg',
    mechanism: 'respiratory-induced amplitude variation',
    requires: ['ppg_waveform'],
  },
  {
    estimator: 'rifv_ppg',
    mechanism: 'respiratory-induced frequency variation',
    requires: ['ppg_waveform'],
  },
]);

/**
 * What the fusion can and cannot run right now, and why.
 *
 * Exposed on the API so a caller can tell a one-mechanism estimate from a
 * four-mechanism one without reading this file.
 */
export function describeEstimators() {
  const live = [{
    estimator: 'rsa_rr',
    mechanism: 'respiratory sinus arrhythmia',
    requires: ['rr_intervals'],
    available: SENSORS.rr_intervals?.status === 'available',
    missing: missingSignals('rr_intervals'),
  }];
  const pending = PPG_ESTIMATORS.map((e) => ({
    ...e,
    available: false,
    missing: missingSignals(e.requires),
  }));
  const all = [...live, ...pending];
  return {
    total: all.length,
    availableCount: all.filter((e) => e.available).length,
    estimators: all,
  };
}
