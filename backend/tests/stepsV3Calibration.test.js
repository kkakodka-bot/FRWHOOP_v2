import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  calibrateStepsV3WithWatch,
  chronologicalDaySplit,
  computeWatchAgreementMetrics,
  computeWatchSampleIntervalMetrics,
  overlapV18WithWatchSamples,
  fitV18OnlyFallback,
  selectLearnedLogit,
  validateCalibrationGrid,
} from '../metrics/stepsV3Calibration.js';
import { accumulateSteps } from '../metrics/steps.js';
import {
  stepsV3ArtifactSha,
  validateStepsV3Artifact,
} from '../metrics/stepsV3.js';
import { STEPS_V3_FIXTURE_ARTIFACT_PATH } from '../metrics/stepsV3Artifact.js';

const MODEL = JSON.parse(readFileSync(STEPS_V3_FIXTURE_ARTIFACT_PATH, 'utf8'));
const MODEL_SHA = MODEL.artifact_sha256;
const BASE = Date.parse('2026-01-01T00:00:00.000Z');

function dayAt(index) {
  return new Date(BASE + index * 86_400_000).toISOString().slice(0, 10);
}

function watchBucket(start, size, count, extra = {}) {
  return {
    bucket_start: new Date(start).toISOString(),
    bucket_size_seconds: size,
    step_count: count,
    device_fingerprint: 'apple_watch:test',
    allocated: true,
    allocation_method: size === 60 ? 'duration_overlap' : 'sum_60s',
    ...extra,
  };
}

function exactCalibrationData(days = 10, modelSha = MODEL_SHA) {
  const windows = [];
  const events = [];
  const watchBuckets = [];
  for (let dayIndex = 0; dayIndex < days; dayIndex += 1) {
    const dayStart = BASE + dayIndex * 86_400_000;
    for (let minute = 0; minute < 5; minute += 1) {
      const start = dayStart + minute * 60_000;
      windows.push({
        start_ms: start,
        end_ms: start + 60_000,
        probability: 0.8,
        public_model_sha256: modelSha,
      });
      events.push(
        {
          timestamp_ms: start + 10_000,
          amplitude: 0.2,
          prominence: 0.1,
          public_model_sha256: modelSha,
        },
        {
          timestamp_ms: start + 30_000,
          amplitude: 0.2,
          prominence: 0.1,
          public_model_sha256: modelSha,
        },
      );
      watchBuckets.push(watchBucket(start, 60, 2, { coalesced: minute === 0 }));
    }
    watchBuckets.push(watchBucket(dayStart, 300, 10));
  }
  return { windows, events, watchBuckets };
}

const SMALL_GATES = {
  min_total_days: 5,
  min_train_days: 3,
  min_validation_days: 1,
  min_test_days: 1,
  min_reference_seconds_per_day: 300,
  min_reference_buckets_per_day: 5,
  min_window_reference_coverage: 1,
};

const ONE_CANDIDATE_GRID = {
  thresholds: [0.5],
  smoothing: [{ type: 'hysteresis', enter: 0.6, exit: 0.4 }],
  peak_min_amplitude: [0.1],
  peak_min_prominence: [0.05],
  peak_refractory_s: [0.25],
  min_bout_events: [1],
  max_bout_gap_s: [50],
  interval_cv_max: [1],
};

test('chronological split uses disjoint whole-day 60/20/20 boundaries', () => {
  const days = Array.from({ length: 10 }, (_, index) => dayAt(index)).reverse();
  const split = chronologicalDaySplit(days);
  assert.equal(split.status, 'ok');
  assert.deepEqual(split.counts, { total: 10, train: 6, validation: 2, test: 2 });
  assert.deepEqual(split.train, Array.from({ length: 6 }, (_, index) => dayAt(index)));
  assert.deepEqual(split.validation, [dayAt(6), dayAt(7)]);
  assert.deepEqual(split.test, [dayAt(8), dayAt(9)]);
  assert.equal(split.boundaries.train_end < split.boundaries.validation_start, true);
  assert.equal(split.boundaries.validation_end < split.boundaries.test_start, true);
  assert.deepEqual(split.leakage_check, { disjoint: true, chronological: true });
});

test('chronological split fails its explicit minimum-day gates closed', () => {
  const split = chronologicalDaySplit(Array.from({ length: 9 }, (_, index) => dayAt(index)));
  assert.equal(split.status, 'insufficient_data');
  assert.equal(split.reason, 'minimum_total_days_not_met');
  assert.deepEqual(split.train, []);
  assert.deepEqual(split.validation, []);
  assert.deepEqual(split.test, []);
});

test('Watch metric math includes minute, five-minute, bias, FP and FN agreement', () => {
  const watchBuckets = [
    watchBucket(BASE, 60, 0, { coalesced: true }),
    watchBucket(BASE + 60_000, 60, 2.5),
    watchBucket(BASE + 120_000, 60, 3),
    watchBucket(BASE + 180_000, 60, 4),
    watchBucket(BASE + 240_000, 60, 5),
    watchBucket(BASE, 300, 14.5),
  ];
  const predictionEvents = Array.from({ length: 5 }, (_, index) => ({
    timestamp_ms: BASE + index * 60_000 + 1_000,
  }));
  const metrics = computeWatchAgreementMetrics({
    predictionEvents,
    predictionWindows: [
      { start_ms: BASE, end_ms: BASE + 60_000, accepted: true },
      { start_ms: BASE + 60_000, end_ms: BASE + 120_000, accepted: false },
    ],
    watchBuckets,
  });
  assert.equal(metrics.reference_role, 'agreement_reference_not_ground_truth');
  assert.equal(metrics.minute.mae, 2.3);
  assert.equal(metrics.five_minute.mae, 9.5);
  assert.equal(metrics.daily_signed_bias.mean, -9.5);
  assert.equal(metrics.fp_windows, 1);
  assert.equal(metrics.fn_windows, 1);
  assert.equal(metrics.coalescing.coalesced_buckets, 1);
  assert.equal(metrics.coalescing.fractional_buckets, 2);
});

test('60s prediction buckets support deterministic v1/v2/v3 agreement comparisons', () => {
  const localDay = '2025-12-31';
  const watchBuckets = [
    watchBucket(BASE, 60, 2, { day: localDay }),
    watchBucket(BASE + 60_000, 60, 3, { day: localDay }),
  ];
  const predictionBuckets = [
    {
      bucket_start: new Date(BASE).toISOString(),
      bucket_size_seconds: 60,
      count: 1.5,
      day: localDay,
      allocated: true,
    },
    {
      bucket_start: new Date(BASE + 60_000).toISOString(),
      bucket_size_seconds: 60,
      count: 4,
      day: localDay,
      coalesced: true,
    },
  ];
  const first = computeWatchAgreementMetrics({ predictionBuckets, watchBuckets });
  const second = computeWatchAgreementMetrics({
    predictionBuckets: [...predictionBuckets].reverse(),
    watchBuckets: [...watchBuckets].reverse(),
  });
  assert.equal(first.minute.mae, 0.75);
  assert.equal(first.five_minute.mae, 0.5);
  assert.equal(first.daily_signed_bias.mean, 0.5);
  assert.equal(first.daily_signed_bias.by_day[0].day, localDay);
  assert.equal(first.prediction.mode, 'count_buckets');
  assert.equal(first.prediction.fractional_buckets, 1);
  assert.equal(first.prediction.coalesced_buckets, 1);
  assert.deepEqual(first, second);
});

test('sparse positive Watch buckets make false-positive windows unavailable', () => {
  const watchBuckets = [watchBucket(BASE + 60_000, 60, 3)];
  const predictionWindows = [
    { start_ms: BASE, end_ms: BASE + 60_000, accepted: true },
    { start_ms: BASE + 60_000, end_ms: BASE + 120_000, accepted: false },
  ];
  const sparse = computeWatchAgreementMetrics({ watchBuckets, predictionWindows });
  assert.equal(sparse.fp_windows, null);
  assert.deepEqual(sparse.fp_windows_availability, {
    available: false,
    reason: 'no_explicit_zero_reference_or_coverage',
    comparable_windows: 0,
  });
  assert.equal(sparse.fn_windows, 1);
  assert.equal(sparse.fn_windows_availability.available, true);

  const covered = computeWatchAgreementMetrics({
    watchBuckets,
    predictionWindows,
    referenceCoverage: [{
      start_at: new Date(BASE).toISOString(),
      end_at: new Date(BASE + 120_000).toISOString(),
    }],
  });
  assert.equal(covered.fp_windows, 1);
  assert.equal(covered.fp_windows_availability.available, true);
  assert.equal(covered.fn_windows, 1);
});

test('explicit local days are honored and UTC fallback is labeled as non-local', () => {
  const explicit = computeWatchAgreementMetrics({
    watchBuckets: [watchBucket(BASE, 60, 2, { local_day: '2025-12-31' })],
    predictionBuckets: [{
      bucket_start: new Date(BASE).toISOString(),
      bucket_size_seconds: 60,
      count: 2,
      local_day: '2025-12-31',
    }],
  });
  assert.equal(explicit.daily_signed_bias.by_day[0].day, '2025-12-31');
  assert.deepEqual(explicit.day_attribution, {
    strategy: 'caller_supplied_local_day',
    local_chronological_split: true,
    explicit_rows: 2,
    utc_fallback_rows: 0,
    limitation: null,
  });

  const fallback = computeWatchAgreementMetrics({
    watchBuckets: [watchBucket(BASE, 60, 2)],
    predictionBuckets: [watchBucket(BASE, 60, 2)],
  });
  assert.equal(fallback.day_attribution.strategy, 'utc_date_fallback');
  assert.equal(fallback.day_attribution.local_chronological_split, false);
  assert.match(fallback.day_attribution.limitation, /UTC splitting is not a local-day/);
});

test('self-hashed exported public artifacts use production canonical hashing', () => {
  const artifact = JSON.parse(readFileSync(STEPS_V3_FIXTURE_ARTIFACT_PATH, 'utf8'));
  artifact.artifact_sha256 = stepsV3ArtifactSha(artifact);
  assert.equal(validateStepsV3Artifact(artifact).ok, true);
  const data = exactCalibrationData(10, artifact.artifact_sha256);
  const result = calibrateStepsV3WithWatch({
    publicModelArtifact: artifact,
    publicModelSha256: artifact.artifact_sha256,
    ...data,
    gates: SMALL_GATES,
    grid: ONE_CANDIDATE_GRID,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.public_model_sha256, artifact.artifact_sha256);
  assert.equal(artifact.artifact_sha256, stepsV3ArtifactSha(artifact));
});

test('calibration rejects attempts to tune frozen public-model parameters', () => {
  const validation = validateCalibrationGrid({
    ...ONE_CANDIDATE_GRID,
    model_weights: [[9, 9, 9]],
  });
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'calibration_scope_violation');
  assert.deepEqual(validation.forbidden, ['model_weights']);

  const data = exactCalibrationData();
  const result = calibrateStepsV3WithWatch({
    publicModelArtifact: MODEL,
    ...data,
    gates: SMALL_GATES,
    grid: { ...ONE_CANDIDATE_GRID, model_bias: [10] },
  });
  assert.equal(result.status, 'invalid_input');
  assert.equal(result.public_model_frozen, true);
  assert.equal(result.canonical, false);
});

test('Watch calibration excludes synthetic rows and only emits postprocessing scope', () => {
  const data = exactCalibrationData();
  data.windows.push({
    start_ms: BASE - 86_400_000,
    end_ms: BASE - 86_400_000 + 60_000,
    probability: 1,
    synthetic: true,
  });
  data.events.push({ timestamp_ms: BASE - 86_390_000, synthetic: true });
  data.watchBuckets.push(watchBucket(BASE - 86_400_000, 60, 999, { synthetic: true }));
  const result = calibrateStepsV3WithWatch({
    publicModelArtifact: MODEL,
    ...data,
    gates: SMALL_GATES,
    grid: ONE_CANDIDATE_GRID,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.public_model_sha256, MODEL_SHA);
  assert.equal(result.public_model_frozen, true);
  assert.equal(result.canonical, false);
  assert.equal(result.watch_reference_role, 'agreement_reference_not_ground_truth');
  assert.equal(result.day_attribution.local_chronological_split, false);
  assert.match(result.day_attribution.limitation, /UTC splitting is not a local-day/);
  assert.equal(result.diagnostics.synthetic_rows_excluded, 3);
  assert.deepEqual(result.split.counts, { total: 10, train: 6, validation: 2, test: 2 });
  assert.deepEqual(result.calibrated_scope, [
    'gait_probability_threshold',
    'smoothing_hysteresis',
    'bout_parameters',
    'peak_detector_parameters',
  ]);
  assert.equal('model' in result.postprocessing, false);
  assert.equal(result.agreement.held_out_test.minute.mae, 0);
  assert.equal(result.agreement.held_out_test.fp_windows, null);
  assert.equal(
    result.agreement.held_out_test.fp_windows_availability.reason,
    'no_explicit_zero_reference_or_coverage',
  );
  assert.match(result.artifact_sha256, /^[a-f0-9]{64}$/);
  assert.match(result.provenance.input_sha256, /^[a-f0-9]{64}$/);
});

test('Watch calibration requires every frozen prediction to carry the public-model hash', () => {
  const data = exactCalibrationData();
  delete data.events[0].public_model_sha256;
  const result = calibrateStepsV3WithWatch({
    publicModelArtifact: MODEL,
    ...data,
    gates: SMALL_GATES,
    grid: ONE_CANDIDATE_GRID,
  });
  assert.equal(result.status, 'insufficient_data');
  assert.equal(result.reason, 'prediction_public_model_hash_missing');
});

test('Watch calibration deterministically excludes duplicate event timestamps', () => {
  const data = exactCalibrationData();
  data.events.push({
    ...data.events[0],
    amplitude: 999,
    prominence: 999,
  });
  const result = calibrateStepsV3WithWatch({
    publicModelArtifact: MODEL,
    ...data,
    gates: SMALL_GATES,
    grid: ONE_CANDIDATE_GRID,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.diagnostics.duplicate_events_excluded, 1);
});

test('calibration output and artifact hashes are independent of input order', () => {
  const firstData = exactCalibrationData();
  const secondData = {
    windows: [...firstData.windows].reverse(),
    events: [...firstData.events].reverse(),
    watchBuckets: [...firstData.watchBuckets].reverse(),
  };
  const options = {
    publicModelArtifact: MODEL,
    gates: SMALL_GATES,
    grid: ONE_CANDIDATE_GRID,
  };
  const first = calibrateStepsV3WithWatch({ ...options, ...firstData });
  const second = calibrateStepsV3WithWatch({ ...options, ...secondData });
  assert.equal(first.status, 'ok');
  assert.equal(second.status, 'ok');
  assert.equal(first.artifact_sha256, second.artifact_sha256);
  assert.equal(first.provenance.input_sha256, second.provenance.input_sha256);
  assert.deepEqual(first, second);
});

test('learned logit acceptance uses validation only', () => {
  const metrics = (minute, five) => ({
    minute: { mae: minute },
    five_minute: { mae: five },
  });
  const accepted = selectLearnedLogit({
    baselineValidation: metrics(4, 6),
    learnedValidation: metrics(3, 5),
    baselineTest: metrics(5, 7),
    learnedTest: metrics(8, 10),
  });
  assert.equal(accepted.accepted, true);

  const rejectedValidation = selectLearnedLogit({
    baselineValidation: metrics(4, 6),
    learnedValidation: metrics(4, 6),
    baselineTest: metrics(5, 7),
    learnedTest: metrics(4, 6),
  });
  assert.equal(rejectedValidation.accepted, false);
  assert.equal(rejectedValidation.reason, 'validation_agreement_not_improved');

});

test('learned logit benchmark rejects insufficient training labels explicitly', () => {
  const data = exactCalibrationData();
  const result = calibrateStepsV3WithWatch({
    publicModelArtifact: MODEL,
    ...data,
    gates: SMALL_GATES,
    grid: ONE_CANDIDATE_GRID,
    benchmarkLearnedLogit: true,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.learned_logit_benchmark.status, 'rejected');
  assert.equal(result.learned_logit_benchmark.accepted, false);
  assert.equal(result.learned_logit_benchmark.reason, 'insufficient_logit_training_labels');
  assert.deepEqual(result.probability_calibration, { type: 'identity', selected: true });
});

test('Watch calibration fails closed when coverage or frozen predictions are absent', () => {
  assert.equal(calibrateStepsV3WithWatch({
    publicModelArtifact: MODEL,
  }).reason, 'watch_reference_coverage_absent');
  assert.equal(calibrateStepsV3WithWatch({
    publicModelArtifact: MODEL,
    watchBuckets: [watchBucket(BASE, 60, 1)],
  }).reason, 'frozen_predictions_absent');

  const data = exactCalibrationData(4);
  const result = calibrateStepsV3WithWatch({
    publicModelArtifact: MODEL,
    ...data,
    gates: SMALL_GATES,
    grid: ONE_CANDIDATE_GRID,
  });
  assert.equal(result.status, 'insufficient_data');
  assert.equal(result.reason, 'minimum_total_days_not_met');
});

function v18FitData({ days = 10, minutes = 5, use300 = false } = {}) {
  const rows = [];
  const watchBuckets = [];
  for (let dayIndex = 0; dayIndex < days; dayIndex += 1) {
    const dayStart = BASE + dayIndex * 86_400_000;
    for (let minute = 0; minute < minutes; minute += 1) {
      const start = dayStart + minute * 60_000;
      rows.push({
        t: new Date(start + 1_000).toISOString(),
        layout: 'v18',
        steps: 2,
        step_cadence: 100,
        activity_class: 1,
        dyn_accel: 0.1,
        on_wrist: 1,
        sleep_stage: 'none',
      });
      if (!use300) watchBuckets.push(watchBucket(start, 60, 4));
    }
    if (use300) watchBuckets.push(watchBucket(dayStart, 300, 20));
  }
  return { rows, watchBuckets };
}

const SMALL_V18_GATES = {
  min_total_days: 5,
  min_train_days: 3,
  min_validation_days: 1,
  min_test_days: 1,
  min_reference_minutes_per_day: 5,
  min_feature_coverage: 1,
};

test('v18-only model has readable nonnegative train-only coefficients and held-out metrics', () => {
  const data = v18FitData();
  data.rows.push({
    t: new Date(BASE + 2_000).toISOString(),
    layout: 'v20',
    steps: 10_000,
    step_cadence: 255,
    activity_class: 2,
    dyn_accel: 8,
  });
  const result = fitV18OnlyFallback({
    ...data,
    gates: SMALL_V18_GATES,
    ridgeCandidates: [1, 0],
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.applicability, 'v18_only');
  assert.equal(result.canonical, false);
  assert.equal(result.model.type, 'nonnegative_linear_count');
  assert.equal(result.model.intercept, 0);
  for (const name of ['counter_delta', 'cadence', 'activity_class', 'dyn_accel']) {
    assert.equal(result.model.coefficients[name].value >= 0, true);
    assert.equal(result.model.coefficients[name].nonnegative, true);
  }
  assert.equal(result.model.output_floor, 0);
  assert.deepEqual(result.provenance.fitted_partitions, ['train']);
  assert.deepEqual(result.provenance.selected_partitions, ['validation']);
  assert.deepEqual(result.provenance.evaluated_partitions, ['test']);
  assert.equal(result.agreement.held_out_test.mae, 0);
  assert.equal(result.diagnostics.exclusions.non_v18, 1);
  assert.match(result.artifact_sha256, /^[a-f0-9]{64}$/);
});

test('v18 fitting accepts 300s fractional Watch references deterministically', () => {
  const data = v18FitData({ use300: true });
  const first = fitV18OnlyFallback({
    ...data,
    gates: SMALL_V18_GATES,
    ridgeCandidates: [0, 0.1],
  });
  const second = fitV18OnlyFallback({
    rows: [...data.rows].reverse(),
    watchBuckets: [...data.watchBuckets].reverse(),
    gates: SMALL_V18_GATES,
    ridgeCandidates: [0.1, 0],
  });
  assert.equal(first.status, 'ok');
  assert.equal(first.diagnostics.watch_300s_fractional_minutes, 50);
  assert.equal(first.artifact_sha256, second.artifact_sha256);
  assert.deepEqual(first, second);
});

test('v18 fallback fails closed without reference overlap and excludes synthetic rows', () => {
  assert.equal(fitV18OnlyFallback().reason, 'watch_reference_coverage_absent');
  const result = fitV18OnlyFallback({
    rows: [{
      t: new Date(BASE).toISOString(),
      layout: 'v18',
      steps: 2,
      synthetic: true,
    }],
    watchBuckets: [watchBucket(BASE, 60, 2)],
    gates: SMALL_V18_GATES,
  });
  assert.equal(result.status, 'insufficient_data');
  assert.equal(result.reason, 'v18_reference_overlap_absent');
  assert.equal(result.exclusions.synthetic, 1);
});

test('v18 fallback requires observed wear and sleep gates', () => {
  const data = v18FitData();
  for (const row of data.rows) {
    delete row.on_wrist;
    delete row.sleep_stage;
  }
  const result = fitV18OnlyFallback({
    ...data,
    gates: SMALL_V18_GATES,
  });
  assert.equal(result.status, 'insufficient_data');
  assert.equal(result.reason, 'minimum_total_days_not_met');
  assert.ok(result.coverage_by_day.every(
    (row) => row.reason === 'wear_sleep_gate_coverage_below_minimum',
  ));
});

test('calibration and fallback are isolated from V1 canonical accumulation', () => {
  const canonicalInput = [
    { t: '2026-01-01T00:00:00.000Z', sensor_ts: 1_767_225_600, steps: 3 },
  ];
  const before = accumulateSteps(canonicalInput);
  const calibration = calibrateStepsV3WithWatch({
    publicModelArtifact: MODEL,
    ...exactCalibrationData(),
    gates: SMALL_GATES,
    grid: ONE_CANDIDATE_GRID,
  });
  const fallback = fitV18OnlyFallback({
    ...v18FitData(),
    gates: SMALL_V18_GATES,
  });
  const after = accumulateSteps(canonicalInput);
  assert.equal(before.total, 3);
  assert.deepEqual(after, before);
  assert.equal(calibration.canonical, false);
  assert.equal(fallback.canonical, false);
});

test('Watch raw sample comparison uses interval overlap, not minute-key equality', () => {
  const samples = [{
    uuid: 'sample-1',
    start_time: new Date(BASE + 15_000).toISOString(),
    end_time: new Date(BASE + 75_000).toISOString(),
    value: 4,
    source_system: 'apple_watch_healthkit',
    metadata: {
      sample_kind: 'raw_quantity_sample',
      source_device: 'Apple Watch',
      device_model: 'Watch6,9',
      start_time: new Date(BASE + 15_000).toISOString(),
      end_time: new Date(BASE + 75_000).toISOString(),
    },
  }];
  const metrics = computeWatchSampleIntervalMetrics({
    watchSamples: samples,
    predictionEventsByAlgorithm: {
      steps_v3: [
        { timestamp_ms: BASE + 20_000 },
        { timestamp_ms: BASE + 40_000 },
        { timestamp_ms: BASE + 80_000 },
      ],
    },
  });
  assert.equal(metrics.primary, true);
  assert.equal(metrics.by_algorithm.steps_v3.minute_key_equality_used, false);
  assert.equal(metrics.rows[0].steps_v3, 2);
  assert.equal(metrics.rows[0].steps_v3_error, -2);

  const v18 = overlapV18WithWatchSamples([
    { layout: 'v18', start_at: new Date(BASE + 10_000).toISOString(), step_cumulative: 10 },
    { layout: 'v18', start_at: new Date(BASE + 40_000).toISOString(), step_cumulative: 13 },
    { layout: 'v18', start_at: new Date(BASE + 90_000).toISOString(), step_cumulative: 20 },
  ], metrics.rows.length ? [{
    uuid: 'sample-1',
    start: BASE + 15_000,
    end: BASE + 75_000,
    start_iso: new Date(BASE + 15_000).toISOString(),
    end_iso: new Date(BASE + 75_000).toISOString(),
    count: 4,
  }] : []);
  assert.equal(v18.minute_key_equality_used, false);
  assert.equal(v18.mixed_with_v3_imu_steps, false);
  assert.equal(v18.rows[0].v18_delta, 3);
});

test('iPhone and merged Watch summaries are rejected from raw interval samples', () => {
  const metrics = computeWatchSampleIntervalMetrics({
    watchSamples: [{
      value: 8,
      source_system: 'iphone',
      metadata: {
        sample_kind: 'raw_quantity_sample',
        source_device: 'iPhone',
        start_time: new Date(BASE).toISOString(),
        end_time: new Date(BASE + 60_000).toISOString(),
      },
    }, {
      value: 8,
      source_system: 'apple_watch_healthkit',
      metadata: {
        sample_kind: 'merged_step_summary',
        source_device: 'Apple Watch',
        start_time: new Date(BASE).toISOString(),
        end_time: new Date(BASE + 60_000).toISOString(),
      },
    }],
    predictionEventsByAlgorithm: { steps_v3: [] },
  });
  assert.equal(metrics.comparable_samples, 0);
  assert.ok(metrics.rejected_iphone_or_ambiguous + metrics.rejected_merged_summaries >= 1);
});
