/**
 * Respiratory-rate estimation constants.
 *
 * References for the band and window choices are in
 * docs/SENSOR_ANALYTICS_ARCHITECTURE.md.
 */

export const ALGORITHM_VERSION = '1.0.0';
export const FUSION_ALGORITHM = 'respiration_fusion';
export const FUSION_VERSION = 'respiration_fusion_v1';

/**
 * Respiratory band, Hz.
 *
 * Wider than the classical HRV high-frequency band (0.15-0.40 Hz, i.e. 9-24
 * breaths/min). The HF band was defined to isolate vagal tone at rest, not to
 * find a breathing rate: paced breathing, sleep, and trained athletes at rest
 * all run below 9 brpm, and those observations would be pushed to the band edge
 * and reported as ~9 rather than as what they are. 0.1-0.5 Hz covers 6-30
 * breaths/min, which spans wrist-measurable human respiration.
 */
export const RESP_BAND_HZ = Object.freeze({ min: 0.1, max: 0.5 });

/** Frequency resolution of the periodogram sweep, Hz. 0.002 Hz ~ 0.12 brpm. */
export const FREQ_STEP_HZ = 0.002;

/**
 * Analysis window.
 *
 * 120 s is the shortest window that reliably resolves 0.1 Hz: a 60 s window
 * holds six cycles of a 6 brpm breath, which is not enough to separate a peak
 * from the detrending residual. Anything shorter is refused rather than
 * estimated badly.
 */
export const WINDOW = Object.freeze({
  defaultSeconds: 120,
  minSeconds: 60,
  maxSeconds: 300,
});

/**
 * Minimum clean beats in a window.
 *
 * Respiratory sinus arrhythmia is sampled once per heartbeat, so the tachogram's
 * effective sampling rate IS the heart rate. Detecting a 0.5 Hz respiratory
 * component needs beats well above 1 Hz by Nyquist; 40 clean beats over 120 s
 * (~20 bpm effective) is the floor at which a band peak is meaningful rather
 * than aliased.
 */
export const MIN_CLEAN_BEATS = 40;

/**
 * Peak prominence below which a spectral peak is not called a breath.
 *
 * Fraction of in-band power held by the peak and its immediate neighbours. A
 * flat in-band spectrum has no respiratory component to find; reporting its
 * argmax would produce a confident number from noise, which is the specific
 * failure this threshold exists to prevent.
 */
export const MIN_PEAK_PROMINENCE = 0.18;

/**
 * Motion above which an RR-derived respiratory estimate is not trusted.
 *
 * Movement corrupts optical beat detection, and the resulting RR jitter lands
 * squarely in the respiratory band — it is indistinguishable from breathing by
 * spectrum alone, so it must be excluded by context rather than filtered.
 */
export const MOTION_CEILING_G = 0.12;

/**
 * Fusion spread tolerance, breaths/min.
 *
 * Two estimators within 2 brpm of each other are corroborating; beyond that
 * the agreement term decays. 2 is roughly the reproducibility of wrist-based
 * respiratory rate, so agreement inside it is not evidence of extra precision.
 */
export const FUSION_SPREAD_TOLERANCE_BRPM = 2;

/** Baseline conditions respiration is tracked under. */
export const RESP_CONDITIONS = Object.freeze({
  SLEEP: 'sleep',
  AWAKE_REST: 'awake:rest',
  EXERCISE: 'exercise',
  POST_EXERCISE: 'post_exercise',
});

/**
 * Population prior for the sleeping respiratory rate, breaths/min.
 *
 * Used only to blend a cold-start baseline; adult sleeping respiratory rate
 * centres near 14-16. Never reported as a measurement.
 */
export const SLEEP_RESP_PRIOR_BRPM = 15;
