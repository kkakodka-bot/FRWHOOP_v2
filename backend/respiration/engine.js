/**
 * The respiratory-rate engine.
 *
 * Pure function of its inputs: no I/O, no globals, no state between calls, so
 * reprocessing a night from the B2 archive reproduces the original numbers
 * exactly. Same contract as the energy engine, for the same reason.
 *
 * Structurally this is a confidence-weighted fusion of independent estimators.
 * Today exactly one estimator has inputs (see `estimators.js`), which makes the
 * fusion a formality — but building the single estimator's output as a fusion
 * contributor means adding the PPG mechanisms later is a registration, not a
 * rewrite, and the API shape does not change under users.
 */

import { metric, unavailable, fuse } from '../signal/envelope.js';
import { missingSignals } from '../signal/capability.js';
import { clamp, num } from '../signal/constants.js';
import {
  ALGORITHM_VERSION,
  FUSION_ALGORITHM,
  FUSION_SPREAD_TOLERANCE_BRPM,
  RESP_CONDITIONS,
  WINDOW,
} from './constants.js';
import { LIMITS } from '../signal/constants.js';
import { describeEstimators, respirationFromRrIntervals } from './estimators.js';
import { beatsFromRrSamples } from '../hrv/beats.js';

const SECOND_MS = 1000;

/** Flatten samples carrying `rr_ms` arrays into individual timestamped beats. */
export function beatsFromSamples(samples) {
  return beatsFromRrSamples(samples);
}

/** Mean motion magnitude across samples, or null when the channel is absent. */
function meanMotion(samples) {
  const vals = (samples || []).map((s) => num(s.mot ?? s.motion)).filter((v) => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

/**
 * Estimate respiratory rate over one window.
 *
 * Returns a metric envelope. Never returns a number without the confidence and
 * quality that qualify it.
 */
export function estimateWindow({
  samples = [],
  condition = RESP_CONDITIONS.SLEEP,
  startTime = null,
  endTime = null,
  now = () => new Date(),
} = {}) {
  const sourceSignals = ['rr_intervals'];
  const common = {
    algorithm: FUSION_ALGORITHM,
    algorithmVersion: ALGORITHM_VERSION,
    unit: 'brpm',
    sourceSignals,
    startTime,
    endTime,
    now,
  };

  const beats = beatsFromSamples(samples);
  if (!beats.length) {
    return unavailable({
      ...common,
      reason: 'no RR intervals in the window; the strap only reports them while '
        + 'the standard Heart Rate Service is the live source',
      missing: missingSignals('rr_intervals').concat(missingSignals('ppg_waveform')),
    });
  }

  const motion = meanMotion(samples);
  const spanSeconds = (beats[beats.length - 1].ts - beats[0].ts) / SECOND_MS;

  const rsa = respirationFromRrIntervals({ beats, motion, windowSeconds: spanSeconds });

  const candidates = [rsa].filter((e) => e && e.value != null);
  const fused = fuse(candidates, { spreadTolerance: FUSION_SPREAD_TOLERANCE_BRPM });

  if (!fused) {
    return unavailable({
      ...common,
      reason: rsa?.reason || 'no estimator produced a value',
      missing: missingSignals('ppg_waveform'),
    });
  }

  // Plausibility is enforced AFTER fusion and rejects rather than clamps: a
  // fused 38 brpm during sleep is a broken measurement, and clamping it to 30
  // would present a fabricated number as a real one.
  if (fused.value < LIMITS.respRateMin || fused.value > LIMITS.respRateMax) {
    return unavailable({
      ...common,
      reason: `fused estimate ${fused.value.toFixed(1)} brpm outside the plausible `
        + `${LIMITS.respRateMin}-${LIMITS.respRateMax} range`,
    });
  }

  const expectedBeats = spanSeconds > 0 ? spanSeconds : 1;
  const inputCoverage = clamp(spanSeconds / WINDOW.defaultSeconds, 0, 1);

  return {
    ...metric({
      ...common,
      value: Math.round(fused.value * 10) / 10,
      confidence: fused.confidence,
      dataQuality: rsa.quality ?? null,
      inputCoverage,
      detail: {
        condition,
        agreement: Math.round(fused.agreement * 1000) / 1000,
        spreadBrpm: Math.round(fused.spread * 100) / 100,
        contributors: fused.contributors,
        mechanismsAvailable: fused.usedCount,
        mechanismsTotal: describeEstimators().total,
        windowSeconds: Math.round(spanSeconds),
        beats: rsa.beats ?? null,
        artifactFraction: rsa.artifactFraction ?? null,
        motion: motion == null ? null : Math.round(motion * 1000) / 1000,
        peakHz: rsa.peakHz ?? null,
        prominence: rsa.prominence ?? null,
        expectedBeats: Math.round(expectedBeats),
      },
      // One of four mechanisms, with no PPG corroboration, is not a settled
      // measurement. The flag travels with the value so the UI cannot present it
      // as one by accident.
      experimental: fused.usedCount < 2,
    }),
  };
}

/**
 * Estimate across a series by splitting it into non-overlapping windows.
 *
 * Non-overlapping so each returned value is an independent measurement.
 * Overlapping windows would make a trend look smoother than the evidence
 * supports, and would double-count beats in any downstream aggregate.
 */
export function estimateSeries({
  samples = [],
  windowSeconds = WINDOW.defaultSeconds,
  condition = RESP_CONDITIONS.SLEEP,
  now = () => new Date(),
} = {}) {
  const rows = (samples || [])
    .map((s) => ({ ...s, __ts: Date.parse(s.t ?? s.datetime ?? s.at ?? '') }))
    .filter((s) => Number.isFinite(s.__ts))
    .sort((a, b) => a.__ts - b.__ts);
  if (!rows.length) return [];

  const span = clamp(windowSeconds, WINDOW.minSeconds, WINDOW.maxSeconds) * SECOND_MS;
  const out = [];
  let windowStart = Math.floor(rows[0].__ts / span) * span;
  let bucket = [];

  const flush = () => {
    if (!bucket.length) return;
    out.push(estimateWindow({
      samples: bucket,
      condition,
      startTime: new Date(windowStart).toISOString(),
      endTime: new Date(windowStart + span).toISOString(),
      now,
    }));
    bucket = [];
  };

  for (const r of rows) {
    while (r.__ts >= windowStart + span) {
      flush();
      windowStart += span;
    }
    bucket.push(r);
  }
  flush();
  return out;
}

/**
 * The nightly respiratory rate: the median of the usable windows.
 *
 * Median, not mean, because a single window contaminated by a wake-and-move
 * episode sits several breaths from the rest and would drag a mean. Windows are
 * weighted only by inclusion — a window either cleared its confidence gate or it
 * did not.
 */
export function nightlyRespiration({
  samples = [],
  condition = RESP_CONDITIONS.SLEEP,
  minWindows = 3,
  minConfidence = 0.35,
  startTime = null,
  endTime = null,
  now = () => new Date(),
} = {}) {
  const windows = estimateSeries({ samples, condition, now });
  const usable = windows.filter((w) => w.value != null && (w.confidence ?? 0) >= minConfidence);

  const common = {
    algorithm: FUSION_ALGORITHM,
    algorithmVersion: ALGORITHM_VERSION,
    unit: 'brpm',
    sourceSignals: ['rr_intervals'],
    startTime: startTime || windows[0]?.startTime || null,
    endTime: endTime || windows[windows.length - 1]?.endTime || null,
    now,
  };

  if (usable.length < minWindows) {
    return unavailable({
      ...common,
      reason: `only ${usable.length} of ${windows.length} windows cleared the `
        + `confidence gate; need ${minWindows}`,
      missing: missingSignals('ppg_waveform'),
    });
  }

  const values = usable.map((w) => w.value).sort((a, b) => a - b);
  const mid = values.length >> 1;
  const value = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;

  // Agreement ACROSS windows is independent evidence that the per-window
  // agreement term does not capture: a night whose windows all land within a
  // breath of each other is a stable measurement even if each window had only
  // one mechanism.
  const spread = values.reduce((a, v) => a + Math.abs(v - value), 0) / values.length;
  const stability = clamp(1 - spread / FUSION_SPREAD_TOLERANCE_BRPM, 0, 1);
  const meanConfidence = usable.reduce((a, w) => a + w.confidence, 0) / usable.length;
  const coverage = clamp(usable.length / Math.max(windows.length, 1), 0, 1);

  return metric({
    ...common,
    value: Math.round(value * 10) / 10,
    confidence: clamp(meanConfidence * (0.7 + 0.3 * stability), 0, 1),
    dataQuality: usable.reduce((a, w) => a + (w.dataQuality ?? 0), 0) / usable.length,
    inputCoverage: coverage,
    detail: {
      condition,
      windowsTotal: windows.length,
      windowsUsed: usable.length,
      spreadBrpm: Math.round(spread * 100) / 100,
      stability: Math.round(stability * 1000) / 1000,
      p10: values[Math.floor((values.length - 1) * 0.1)],
      p90: values[Math.floor((values.length - 1) * 0.9)],
      mechanismsTotal: describeEstimators().total,
    },
    experimental: true,
  });
}

export { describeEstimators };
