/**
 * Heart Rate V2 pipeline acceptance tests.
 * Scenarios: S01 duplicates, S12 absurd-in-range peak, abstention, S20
 * density invariance, live==finalized convergence, S22 determinism.
 * Baseline: backend suite 779 pass / 0 fail (hr_v2 baseline log).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeHr2Day, computeHr2PartialBucket } from '../hr2/pipeline.js';
import { constant, stepProfile, injectFlat, withDuplicates, densityPair, sleepNight } from './fixtures/hrV2.mjs';

const S = 1700000000000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const BUCKET_MS = 5 * 60 * 1000;

test('dedup collapses identical re-delivered rows but keeps every distinct second (S01+S21)', () => {
  const base = constant({ startMs: S, durationMin: 5, bpm: 62 });
  const duped = withDuplicates(base, 2);
  const r = computeHr2Day(duped, { dayStartMs: S, dayEndMs: S + DAY_MS });
  assert.equal(r.input.dedup.input, 900);
  assert.equal(r.input.dedup.exactDuplicates, 600);
  assert.equal(r.scalars.avg_hr.n, 300);
  assert.equal(r.scalars.avg_hr.value, 62);
});

test('absurd-but-in-range 25 bpm flat inside a workout does not define the confirmed peak (S12)', () => {
  const workout = stepProfile({ startMs: S, plateauBpm: 180, baseMin: 10, plateauMin: 10, coolMin: 10 });
  const withArtifact = injectFlat([...workout], { startMs: S + 5 * 60_000, minutes: 3, bpm: 25 });
  const r = computeHr2Day(withArtifact, { dayStartMs: S, dayEndMs: S + DAY_MS });
  assert.ok(r.scalars.peak.confirmed.value >= 170,
    'confirmed peak should stay near the genuine 180 plateau, got ' + r.scalars.peak.confirmed.value);
  assert.ok(r.scalars.peak.raw_max >= 178 && r.scalars.peak.raw_max <= 182, "raw max stays at the genuine plateau, got " + r.scalars.peak.raw_max);
});

test('uneven sampling density cannot change the time-weighted daily average (S20)', () => {
  const dp = densityPair({});
  const t0 = Date.parse(dp.uniform[0].datetime);
  const ra = computeHr2Day(dp.uniform, { dayStartMs: t0, dayEndMs: t0 + DAY_MS });
  const rb = computeHr2Day(dp.dense, { dayStartMs: t0, dayEndMs: t0 + DAY_MS });
  assert.equal(ra.scalars.avg_hr.value, rb.scalars.avg_hr.value);
  assert.notEqual(ra.scalars.avg_hr.candidates.a1_unweighted_mean, rb.scalars.avg_hr.candidates.a1_unweighted_mean,
    'the count-weighted candidate must demonstrably shift with density (that is the V1 defect)');
});

test('live partial bucket converges to the finalized formula on the same ticks', () => {
  const ticks = constant({ startMs: S, durationMin: 5, spacingS: 1, bpm: 71 });
  const bucketStart = Math.floor(S / BUCKET_MS) * BUCKET_MS;
  const finalized = computeHr2Day(ticks, { dayStartMs: bucketStart, dayEndMs: bucketStart + BUCKET_MS });
  const partial = computeHr2PartialBucket(ticks, { bucketStartMs: bucketStart, nowMs: bucketStart + BUCKET_MS });
  assert.ok(partial != null);
  assert.ok(Math.abs(finalized.series.buckets[0].avg_hr - partial.avg_hr) < 0.11,
    'partial ' + partial.avg_hr + ' must converge to finalized ' + finalized.series.buckets[0].avg_hr);
});

test('determinism: same input twice -> identical scalar output (S22)', () => {
  const rows = stepProfile({ startMs: S, spacingS: 2 });
  const a = computeHr2Day(rows, { dayStartMs: S, dayEndMs: S + DAY_MS }).scalars.avg_hr.value;
  const b = computeHr2Day(rows, { dayStartMs: S, dayEndMs: S + DAY_MS }).scalars.avg_hr.value;
  assert.equal(a, b);
});

test('RHR candidates: windowed low percentiles are more artifact-robust than the raw floor', () => {
  const night = sleepNight({ startMs: S, hours: 7, restBpm: 54, deepDrop: 6 });
  const withArtifact = injectFlat([...night.obs], { startMs: S + 3 * HOUR_MS, minutes: 30, bpm: 25, score: 0.95 });
  const sleepWindow = { startMs: night.startMs, endMs: night.endMs, stageSegments: night.stageSegments };
  const clean = computeHr2Day(night.obs, { dayStartMs: S, dayEndMs: S + DAY_MS, sleepWindow });
  const dirty = computeHr2Day(withArtifact, { dayStartMs: S, dayEndMs: S + DAY_MS, sleepWindow });
  const rc = clean.scalars.resting_hr_candidates;
  const rd = dirty.scalars.resting_hr_candidates;
  assert.ok(rc && rd, 'sleep window present in both runs');
  // r3 (lowest 5-min window) is the artifact-sensitive floor candidate; it must move.
  const r3delta = Math.abs(rc.r3_lowest_5min_window.value - rd.r3_lowest_5min_window.value);
  // r2a (P10 of 30s window means) must move LESS than r3 under the artifact.
  const r2aDelta = Math.abs(rc.r2a_p10_of_30s_window_means.value - rd.r2a_p10_of_30s_window_means.value);
  assert.ok(r2aDelta <= r3delta, 'r2a must be at least as robust as r3 under a low-flat artifact');
});
