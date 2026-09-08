/**
 * V1 vs V2 side-by-side comparison over the same observation stream.
 *
 * Mission contract: "Compute V1 and V2 side by side on representative replay
 * data and produce a comparison artifact showing exactly where they differ."
 * V1 definitions here are byte-faithful re-implementations of the engine
 * formulas (engine.js L298-304: unweighted mean / raw max over the 20-240
 * gate; sleep.js P10 RHR), NOT calls into engine.js, so the artifact can be
 * produced for any B2 day without the storage stack.
 */

import { computeHr2Day } from './pipeline.js';
import { observationsFromSamples } from './observation.js';

/**
 * V1 metric definitions, exactly as metrics/engine.js computes them today.
 * @param {Array} rows raw sample rows (with bpm fields)
 */
export function computeV1Day(rows) {
  const hrValues = (rows || [])
    .map((s) => (Number.isFinite(Number(s.bpm ?? s.heartRate ?? s.heart_rate)) && Number(s.bpm ?? s.heartRate) >= 20 && Number(s.bpm ?? s.heartRate) <= 240 ? Math.round(Number(s.bpm ?? s.heartRate)) : null))
    .filter((v) => v != null);
  const avg = hrValues.length ? Math.round(hrValues.reduce((a, b) => a + b, 0) / hrValues.length) : null;
  const max = hrValues.length ? Math.max(...hrValues) : null;
  return { avg_hr: avg, max_hr: max, n: hrValues.length };
}

/**
 * Compare V1 and V2 for one day and return the row for the artifact.
 */
export function compareDay(rows, o = {}) {
  const v1 = computeV1Day(rows);
  const v2 = computeHr2Day(rows, o);
  return {
    day: o.day ?? null,
    v1: { avg_hr: v1.avg_hr, max_hr: v1.max_hr, n_samples: v1.n },
    v2: {
      avg_hr: v2.scalars.avg_hr.value,
      avg_coverage_hours: v2.scalars.avg_hr.coverage_hours,
      max_hr_raw: v2.scalars.peak.raw_max,
      max_hr_confirmed: v2.scalars.peak.confirmed ? v2.scalars.peak.confirmed.value : null,
      n_observations: v2.scalars.avg_hr.n,
      coverage_hours: v2.scalars.avg_hr.coverage_hours,
      rhr_promoted: v2.scalars.resting_hr ? v2.scalars.resting_hr.value : null,
      rhr_method: v2.scalars.resting_hr ? v2.scalars.resting_hr.promoted_from ?? v2.scalars.resting_hr.method : null,
      rhr_v1_p10: v2.scalars.resting_hr_candidates ? v2.scalars.resting_hr_candidates.r1_v1_p10.value : null,
      sleep_hr: v2.scalars.sleep_hr ? v2.scalars.sleep_hr.value : null,
    },
    delta: {
      avg_hr_delta: v1.avg_hr != null && v2.scalars.avg_hr.value != null
        ? Math.round((v2.scalars.avg_hr.value - v1.avg_hr) * 10) / 10
        : null,
      max_raw_vs_confirmed: v2.scalars.peak.raw_max != null && v2.scalars.peak.confirmed
        ? Math.round((v2.scalars.peak.raw_max - v2.scalars.peak.confirmed.value) * 10) / 10
        : null,
    },
    suppressed: v2.suppressed.length,
  };
}
