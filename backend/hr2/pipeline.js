/**
 * HR V2 pipeline: one entry point from raw rows to finalized day metrics.
 *
 * This is the seam the mission demanded: every consumer (engine dual-run,
 * live flush, historical recompute, frontend equivalence tests) calls THIS
 * function, so a live computation and a recomputation from archived data of
 * the same underlying observations converge to identical finalized values by
 * construction (asserted in tests/hrV2.pipeline.test.js).
 *
 * Order of operations (deterministic):
 *   1. rows -> canonical observations (observation.js)
 *   2. dedupe (dedupe.js) - provenance-preserving, 3 layers
 *   3. quality pass (quality.js assessWindow) - neighbor-aware heuristic
 *   4. attach scores -> aggregate (series.js / metrics.js / rhr.js)
 *
 * Sleep window + workout windows are caller-supplied (they come from the
 * sleep scorer / workout detector, which remain V1 components); when absent,
 * RHR/sleep concepts are omitted rather than guessed.
 */

import { observationsFromSamples } from './observation.js';
import { dedupeObservations } from './dedupe.js';
import { assessWindow } from './quality.js';
import { buildDaySeries, accumulatePartialBucket } from './series.js';
import { dailyAverageHr, dailyPeak, sleepHr } from './metrics.js';
import { rhrCandidates } from './rhr.js';
import { HR2_CONFIG, HR2_ALGORITHM_VERSION } from './version.js';

const MINUTE_MS = 60_000;

/**
 * Run the full V2 pipeline over one day.
 *
 * @param {Array} rows raw sample rows (day-file rows, decoded archive rows, live rows)
 * @param {object} o {
 *   day 'YYYY-MM-DD', timeZone,
 *   dayStartMs, dayEndMs,     local-day bounds (ms epoch) - REQUIRED for correct day slicing
 *   age,
 *   sleepWindow: {startMs, endMs, stageSegments?},
 *   qualityFloor
 * }
 */
export function computeHr2Day(rows, o = {}) {
  const qualityFloor = o.qualityFloor ?? HR2_CONFIG.QUALITY_FLOOR;
  const observations = observationsFromSamples(rows);
  const { kept, suppressed, stats } = dedupeObservations(observations);

  // Temporal quality pass over the deduped, day-sliced stream.
  const inDay = kept.filter((x) => x.tMs >= o.dayStartMs && x.tMs < o.dayEndMs);
  const assessments = assessWindow(inDay, { age: o.age });
  for (let i = 0; i < inDay.length; i += 1) {
    inDay[i]._quality = assessments.get(i) ?? { score: 1, flags: [], calibrated: false };
  }
  const passing = inDay.filter((x) => x.bpm != null && x._quality.score >= qualityFloor && (x._quality.plausible !== false));

  const series = buildDaySeries(inDay, { qualityFloor });
  const avg = dailyAverageHr(inDay, { qualityFloor });
  const peak = dailyPeak(inDay, { qualityFloor });

  const rhr = o.sleepWindow
    ? rhrCandidates(inDay, { startMs: o.sleepWindow.startMs, endMs: o.sleepWindow.endMs, stageSegments: o.sleepWindow.stageSegments, qualityFloor })
    : null;
  const nightHr = o.sleepWindow
    ? sleepHr(inDay, { startMs: o.sleepWindow.startMs, endMs: o.sleepWindow.endMs, qualityFloor })
    : null;

  return {
    algorithm_version: HR2_ALGORITHM_VERSION,
    config: { qualityFloor, weight_cap_ms: HR2_CONFIG.WEIGHT_CAP_MS },
    input: { rows: rows?.length ?? 0, observations: observations.length, dedup: stats },
    suppressed: suppressed.length ? suppressed : [],
    scalars: {
      avg_hr: {
        value: avg.value,
        coverage_hours: avg.coverage_hours,
        n: avg.n,
        quality_mean: avg.quality_mean,
        gate_ok: avg.gate_ok,
        method: avg.method,
        candidates: avg.candidates,
      },
      peak: {
        raw_max: peak.raw_max,
        raw_max_at: peak.raw_max_at,
        confirmed: peak.confirmed,
        all_windows: peak.all_windows,
        method: peak.method,
      },
      sleep_hr: nightHr,
      resting_hr: rhr ? rhr.promoted : null,
      resting_hr_candidates: rhr ? rhr.candidates : null,
    },
    series,
    version: HR2_ALGORITHM_VERSION,
  };
}

/**
 * Partial (in-progress) bucket for the live overlay, computed by the SAME
 * pipeline stages (dedupe + quality) as the finalized one.
 */
export function computeHr2PartialBucket(rows, o = {}) {
  const qualityFloor = o.qualityFloor ?? HR2_CONFIG.QUALITY_FLOOR;
  const observations = observationsFromSamples(rows);
  const { kept } = dedupeObservations(observations);
  const inDay = o.dayStartMs != null ? kept.filter((x) => x.tMs >= o.dayStartMs && x.tMs < o.dayEndMs) : kept;
  const assessments = assessWindow(inDay, { age: o.age });
  for (let i = 0; i < inDay.length; i += 1) {
    inDay[i]._quality = assessments.get(i) ?? { score: 1, flags: [], calibrated: false };
  }
  return accumulatePartialBucket(inDay, {
    bucketStartMs: o.bucketStartMs,
    bucketMinutes: o.bucketMinutes ?? 5,
    qualityFloor,
    nowMs: o.nowMs,
  });
}
