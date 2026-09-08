/**
 * FRWHOOP Strain V2 — Layer 1 constants.
 *
 * Every constant carries its evidence. Empirical basis: measured distributions
 * on real WHOOP5/WHOOP4 capture (_strain_v2/work_cadence_data.md):
 *   - live/history HR cadence p50 = 993 ms, 80.7% of samples at 1 s (NOT the
 *     documented 4 s / 15-per-minute); gaps > 10 s are transport-level missing
 *     intervals; duplicates ~0.6%; RR 0-3/s sparse (333-2134 ms).
 */

export const STRAIN_V2_EPOCHS_VERSION = 'strainV2.epochs.1';

/** Canonical scoring epoch (60 s). Native HR cadence is ~1 Hz (p50 993 ms);
 * a 1-minute epoch aggregates 60 native samples, matches the minute-based
 * TRIMP literature, and is insensitive to the 4 s-vs-1 s documentation
 * mismatch. Raw 1 s / native data upstream is never modified. */
export const EPOCH_MS = 60_000;

/** Epochs are anchored to this grid start (epochStartMs = floor(t / EPOCH_MS)). */
export const EPOCH_ANCHOR = 'utc_min';

/** Physiologically plausible wrist-PPG HR band. Below ~25 the PPG is reading
 * noise/pressure artifact; above 230 exceeds any recorded human max
 * (record ~205+, Tanaka ceiling for adults well below). Reused from
 * energy/features.js LIMITS so the whole repo has one HR plausibility rule. */
export const HR_MIN_BPM = 25;
export const HR_MAX_BPM = 230;

/** A >25 bpm step inside <=10 s is not cardiac; it is an optical relock
 * (energy/features.js uses the same rule; Boudreaux 2018 shows one-sided
 * artifact spikes). Reused verbatim so behavior is consistent engine-wide. */
export const HR_JUMP_BPM = 25;
export const HR_JUMP_WINDOW_MS = 10_000;

/** Sample gap that turns the covered epochs UNKNOWN instead of sparse-
 * scorable. Evidence: ingest/gaps.js already treats >10 s as a gap event at
 * the transport layer; at scoring resolution a 90 s silence inside an
 * otherwise active period means the HR channel is unreliable for the span
 * (work_cadence_data.md: real days contain 121 gaps >=10 s incl. multi-hour
 * dropouts). Chosen well below V1's indefensible 10-minute contribution
 * window and well above BLE reconnect blips. */
export const GAP_TOLERANCE_MS = 90_000;

/** Minimum fraction of expected samples an epoch must contain to be a
 * defensible minute-level HR representation. Below this the surviving samples
 * cannot represent the epoch; it is UNKNOWN, never zero, never interpolated. */
export const EPOCH_MIN_COVERAGE = 0.5;

/** Epoch HR stability: within-epoch stddev above this means the sensor is
 * fighting motion rather than tracking the pulse (signal/quality.js flags
 * hr_unstable at the same 18 bpm threshold; HIGH additionally requires
 * <=HR_STABLE_STD_BPM). */
export const HR_STABLE_STD_BPM = 8;
export const HR_UNSTABLE_STD_BPM = 18;

/** Motion contamination threshold, mean normalized magnitude per epoch.
 * The repo already treats motion > 0.15 as contamination for PPG/temperature
 * channels (signal/quality.js scorePpgQuality / scoreTemperatureQuality).
 * Same threshold here: reject-don't-correct the epoch's HR unless the value
 * is corroborated by clean neighbors (see epochs.js corroboration rule). */
export const MOTION_SUSPECT_THRESHOLD = 0.15;

/** RR artifact fraction above which the epoch's RR channel is flagged
 * (signal/quality.js rrStats + scoreQuality use the same 0.4). */
export const RR_ARTIFACT_FRACTION_FLAG = 0.4;

/** Quality labels. These are STATE NAMES, not probabilities: they carry no
 * fabricated confidence semantics. */
export const QUALITY = Object.freeze({
  HIGH: 'HIGH',
  MODERATE: 'MODERATE',
  LOW: 'LOW',
  UNKNOWN: 'UNKNOWN',
});

/** Sufficiency states for a scored day. INSUFFICIENT is distinct from a
 * measured-zero-load day (mission D6): no data must never equal 0 strain. */
export const QUALITY_STATES = Object.freeze({
  HIGH: 'HIGH',        // >=80% coverage, mostly HIGH-quality epochs
  MODERATE: 'MODERATE',// >=50% coverage
  LOW: 'LOW',          // >=25% coverage
  INSUFFICIENT: 'INSUFFICIENT', // <25% coverage or no scorable epochs
});

export const DAY_COVERAGE_HIGH = 0.8;
export const DAY_COVERAGE_MODERATE = 0.5;
export const DAY_COVERAGE_LOW = 0.25;

/**
 * Expected samples per epoch: derived from the OBSERVED cadence of the day's
 * contiguous runs (median inter-sample delta), NOT from the documented 15/min
 * cadence — the measured reality is ~1 Hz and the coverage math must follow
 * the sensor, not the doc. Clamp [1, 300] guards pathological inputs.
 */
export const EXPECTED_SAMPLES_MIN = 1;
export const EXPECTED_SAMPLES_MAX = 300;

/** Contiguity window for cadence estimation: deltas <= 5 s count as a run
 * (real data is 1 s; documented max is 4 s). */
export const CADENCE_RUN_MAX_DELTA_MS = 5_000;
/** Need at least this many contiguous deltas before the estimate is trusted;
 * below it the estimator falls back to a conservative 1 Hz expectation. */
export const CADENCE_MIN_RUNS = 8;
