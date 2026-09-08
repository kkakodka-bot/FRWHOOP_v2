/**
 * Overnight heart-rate variability.
 *
 * RMSSD, not SDNN or a frequency-domain index, is the reported value. The
 * reasons are specific rather than conventional:
 *
 *  - RMSSD is a difference statistic, so it is insensitive to the slow drift
 *    that dominates an overnight recording (posture changes, circadian decline
 *    in heart rate). SDNN measures that drift as variability, which makes it a
 *    measure of how eventful the night was as much as of autonomic tone.
 *  - RMSSD is stable on short windows. Frequency-domain indices need stationary
 *    segments long enough to resolve the LF band (~0.04 Hz, so minutes), and an
 *    overnight recording is not stationary.
 *  - It is what the rest of the ecosystem reports, so the number is comparable
 *    to the user's own history from other devices.
 *
 * The night's value is the MEDIAN of per-window RMSSDs, not RMSSD over the whole
 * night pooled. Pooling is wrong in a way that matters: the squared successive
 * differences across a window boundary include the gap between windows, and a
 * single arousal with a large RR step contributes its square to the total. One
 * awakening can then double a pooled RMSSD. Taking per-window values and their
 * median makes that awakening one outlying window instead.
 *
 * Pure function of its inputs, so reprocessing the archive reproduces the value.
 */

import { metric, unavailable } from '../signal/envelope.js';
import { clamp } from '../signal/constants.js';
import { median, rrStats } from '../signal/quality.js';
import { beatsFromRrSamples } from './beats.js';

export const ALGORITHM_VERSION = '1.0.0';
export const HRV_ALGORITHM = 'hrv_rmssd_windowed';

const SECOND_MS = 1000;

/**
 * Window length for a single RMSSD, seconds.
 *
 * 300 s is the shortest interval the HRV literature treats as a "short-term"
 * recording and is the standard unit for RMSSD reporting. Shorter windows give
 * more of them but each is noisier, and the median does not recover precision
 * that was never measured.
 */
export const WINDOW_SECONDS = 300;

/**
 * Minimum clean intervals for one window to count.
 *
 * RMSSD's sampling error falls roughly as 1/sqrt(n); at 30 intervals it is
 * around 13%, which is the most error tolerable in a value whose day-to-day
 * changes are themselves ~10%. Below this the window is dropped, not estimated.
 */
export const MIN_WINDOW_BEATS = 30;

/**
 * Maximum artifact fraction for one window to count.
 *
 * Artifacts inflate RMSSD specifically — a missed beat creates one interval of
 * roughly double length and two large successive differences — so a permissive
 * threshold here biases the metric upward rather than merely adding noise.
 */
export const MAX_WINDOW_ARTIFACT_FRACTION = 0.2;

/** Minimum usable windows before a night is reported at all. */
export const MIN_NIGHT_WINDOWS = 3;

/**
 * Physiological range for overnight RMSSD, ms.
 *
 * Spans roughly the 1st to 99th percentile of adult overnight values. Outside
 * it the measurement is rejected rather than clamped: a 400 ms RMSSD is a beat
 * detector failure, and reporting it as 200 would present a fabricated value.
 */
export const RMSSD_LIMITS = Object.freeze({ min: 3, max: 300 });

/** Flatten samples carrying `rr_ms` arrays into timestamped intervals. */
export function intervalsFromSamples(samples) {
  return beatsFromRrSamples(samples);
}

/**
 * RMSSD over one window's intervals.
 *
 * Successive differences are taken only between intervals that BOTH survived
 * artifact rejection and were adjacent in the original series. Differencing
 * across a removed interval would manufacture exactly the large step that
 * rejection was meant to discard.
 */
export function windowRmssd(intervals) {
  const stats = rrStats(intervals);
  if (stats.count < MIN_WINDOW_BEATS) {
    return { value: null, reason: `${stats.count} clean intervals below ${MIN_WINDOW_BEATS}`, ...stats };
  }
  if (stats.artifactFraction > MAX_WINDOW_ARTIFACT_FRACTION) {
    return {
      value: null,
      reason: `artifact fraction ${stats.artifactFraction.toFixed(2)} above ${MAX_WINDOW_ARTIFACT_FRACTION}`,
      ...stats,
    };
  }

  let sumSq = 0;
  let pairs = 0;
  for (let i = 1; i < stats.keptIndices.length; i += 1) {
    // Adjacency in the ORIGINAL series, so a rejected interval breaks the pair.
    if (stats.keptIndices[i] !== stats.keptIndices[i - 1] + 1) continue;
    const prevIv = intervals[stats.keptIndices[i - 1]];
    const curIv = intervals[stats.keptIndices[i]];
    const pe = prevIv != null && typeof prevIv === 'object' ? (prevIv.epoch ?? prevIv.connection_epoch) : null;
    const ce = curIv != null && typeof curIv === 'object' ? (curIv.epoch ?? curIv.connection_epoch) : null;
    if (pe != null && ce != null && pe !== ce) continue;
    const d = stats.clean[i] - stats.clean[i - 1];
    sumSq += d * d;
    pairs += 1;
  }
  if (pairs < MIN_WINDOW_BEATS / 2) {
    return { value: null, reason: `only ${pairs} adjacent interval pairs survived`, ...stats };
  }

  return {
    value: Math.sqrt(sumSq / pairs),
    pairs,
    ...stats,
  };
}

/** Split intervals into non-overlapping windows aligned to the epoch. */
export function windowIntervals(intervals, windowSeconds = WINDOW_SECONDS) {
  const span = windowSeconds * SECOND_MS;
  const buckets = new Map();
  for (const iv of intervals) {
    const key = Math.floor(iv.ts / span) * span;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(iv);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, rows]) => ({ start, end: start + span, rows }));
}

/**
 * Overnight HRV for a sleep window.
 *
 * @param {object} input
 * @param {Array}  input.samples    samples overlapping the window
 * @param {string} input.startTime  ISO sleep onset
 * @param {string} input.endTime    ISO wake
 */
export function overnightHrv({
  samples = [],
  startTime = null,
  endTime = null,
  windowSeconds = WINDOW_SECONDS,
  now = () => new Date(),
} = {}) {
  const common = {
    algorithm: HRV_ALGORITHM,
    algorithmVersion: ALGORITHM_VERSION,
    unit: 'ms',
    sourceSignals: ['rr_intervals'],
    startTime,
    endTime,
    now,
  };

  const all = intervalsFromSamples(samples);
  const lo = startTime ? Date.parse(startTime) : null;
  const hi = endTime ? Date.parse(endTime) : null;
  const intervals = all.filter((iv) => (lo == null || iv.ts >= lo) && (hi == null || iv.ts <= hi));

  if (!intervals.length) {
    // Deliberately NOT reported as a missing signal. RR intervals are an
    // available capability; this window simply has none, which is a data gap.
    // Conflating the two would tell the client the hardware cannot do something
    // it can, and there is no other source of true HRV to unlock instead —
    // pulse-rate variability from PPG is a different quantity, not a substitute.
    return unavailable({
      ...common,
      reason: 'no RR intervals in the sleep window; the strap reports them only '
        + 'while the standard Heart Rate Service is the live source',
    });
  }

  const windows = windowIntervals(intervals, windowSeconds);
  const scored = windows.map((w) => ({ ...w, ...windowRmssd(w.rows) }));
  const usable = scored.filter((w) => w.value != null);

  if (usable.length < MIN_NIGHT_WINDOWS) {
    return unavailable({
      ...common,
      reason: `only ${usable.length} of ${scored.length} ${windowSeconds}s windows had `
        + `enough clean intervals; need ${MIN_NIGHT_WINDOWS}`,
    });
  }

  const values = usable.map((w) => w.value);
  const value = median(values);

  if (value < RMSSD_LIMITS.min || value > RMSSD_LIMITS.max) {
    return unavailable({
      ...common,
      reason: `median RMSSD ${value.toFixed(1)} ms outside the plausible `
        + `${RMSSD_LIMITS.min}-${RMSSD_LIMITS.max} ms range`,
    });
  }

  const artifactFraction = usable.reduce((a, w) => a + w.artifactFraction, 0) / usable.length;
  const coverage = clamp(usable.length / Math.max(scored.length, 1), 0, 1);

  // Spread across windows relative to the value itself: overnight RMSSD is
  // genuinely variable, so this is scaled rather than absolute. A night whose
  // windows disagree by more than the value is not a measurement of one thing.
  const spread = values.reduce((a, v) => a + Math.abs(v - value), 0) / values.length;
  const stability = clamp(1 - (spread / Math.max(value, 1e-9)) / 0.5, 0, 1);

  const windowTerm = clamp(usable.length / (MIN_NIGHT_WINDOWS * 4), 0.2, 1);
  const confidence = clamp(
    (0.3 + 0.3 * windowTerm + 0.2 * stability + 0.2 * coverage) * (1 - artifactFraction),
    0,
    1,
  );

  return metric({
    ...common,
    value: Math.round(value * 10) / 10,
    confidence,
    dataQuality: clamp((1 - artifactFraction) * coverage, 0, 1),
    inputCoverage: coverage,
    detail: {
      windowsTotal: scored.length,
      windowsUsed: usable.length,
      windowSeconds,
      intervals: intervals.length,
      artifactFraction: Math.round(artifactFraction * 1000) / 1000,
      spreadMs: Math.round(spread * 10) / 10,
      stability: Math.round(stability * 1000) / 1000,
      p10: Math.round(percentileOf(values, 0.1) * 10) / 10,
      p90: Math.round(percentileOf(values, 0.9) * 10) / 10,
      sdnnMs: Math.round(median(usable.map((w) => w.sdnn)) * 10) / 10,
      meanRrMs: Math.round(median(usable.map((w) => w.meanRr))),
      // The median RR gives the same quantity the sleep scorer derives from
      // BPM samples; reporting both lets a reviewer catch a beat detector that
      // disagrees with the device's own heart rate.
      impliedHrBpm: Math.round(60_000 / median(usable.map((w) => w.meanRr))),
      rejectedWindows: scored.filter((w) => w.value == null).map((w) => w.reason).slice(0, 5),
    },
  });
}

function percentileOf(values, p) {
  const list = [...values].sort((a, b) => a - b);
  if (!list.length) return null;
  return list[Math.min(list.length - 1, Math.max(0, Math.floor((list.length - 1) * p)))];
}
