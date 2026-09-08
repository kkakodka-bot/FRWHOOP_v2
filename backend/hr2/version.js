/**
 * Heart Rate V2 algorithm identity, mode flag, and shared tunables.
 *
 * MODE CONTRACT (migration safety, mission item "keep V1 available behind an
 * explicit version or feature flag"):
 *   FRWHOOP_HR2=v1   (default) V1 metrics only, byte-identical legacy behavior.
 *   FRWHOOP_HR2=dual V1 stays canonical in the daily_metrics columns; the V2
 *                    pipeline runs on the same inputs and its scalars + candidate
 *                    matrix are persisted under extras.hr_v2 / confidence.hr_v2 /
 *                    provenance.hr_v2 for side-by-side comparison.
 *   FRWHOOP_HR2=v2   V2 scalars become canonical (avg/max/resting columns),
 *                    V1 values preserved under extras.hr_v2.v1_compat.
 * Promotion between modes is explicit, never in-place: recomputation from B2
 * regenerates any version deterministically (see energy/shadow.js precedent).
 */

export const HR2_ALGORITHM_VERSION = 'frwhoop-hr-v2.0.0';

export const HR2_MODES = Object.freeze(['v1', 'dual', 'v2']);

/**
 * Resolve the HR engine mode from an environment-like object.
 * Unknown/absent values fall back to 'v1' so production behavior can never
 * change silently.
 */
export function hr2Mode(env = process.env) {
  const raw = String(env?.FRWHOOP_HR2 ?? '').trim().toLowerCase();
  return HR2_MODES.includes(raw) ? raw : 'v1';
}

/**
 * Shared V2 tunables. Every constant is either:
 *  - cited inline (research report + section), or
 *  - marked ENGINEERING-DEFAULT (a deliberate, documented default that the
 *    benchmark harness may change; never load-bearing semantics hidden here).
 */
export const HR2_CONFIG = Object.freeze({
  /** Observations below this heuristic confidence are excluded from V2 aggregates. */
  QUALITY_FLOOR: 0.5,
  /** Max seconds one observation may represent in a time-weighted integral. */
  WEIGHT_CAP_MS: 60_000,
  /** Weight never bridges a gap longer than this (missing stays missing). */
  GAP_CAP_MIN: 15,
  /** Rolling windows evaluated for the temporally confirmed daily peak. */
  PEAK_WINDOWS_S: [30, 60, 120],
  /** Default confirmed-peak window (benchmark default; see compare.js). */
  PEAK_WINDOW_S_DEFAULT: 60,
  /** Fraction of a peak window that must be populated to count. */
  PEAK_MIN_POPULATION: 0.8,
  CONF_MIN: 0.05,
  CONF_MAX: 0.97,
  /** RHR candidate default until the benchmark promotes one. r2a = P10 of quality-screened 30 s window means. */
  RHR_METHOD_DEFAULT: 'r2a_p10_of_30s_window_means',
  /** A 30 s resting window needs at least this many samples to count (ENGINEERING-DEFAULT). */
  RHR_WINDOW_MIN_SAMPLES: 2,
  /** SWS-weighted RHR shadow weights - UNTUNED, no labeled comparison set exists yet. */
  SWS_WEIGHTS: Object.freeze({ deep: 1.0, light: 0.5, rem: 0.5, awake: 0.0 }),
});
