import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SOURCES,
  SOURCE_POLICY,
  classifySource,
  arbitrate,
  ingestHealthKit,
  normalizeMeasurement,
  applyCanonicalDay,
  buildExportPlan,
  syncIdentifier,
  nextSyncVersion,
  classifyWorkoutMatch,
  classifySleepMatch,
  pairIntervals,
  intervalIoU,
  primaryWorkouts,
  PERMISSION_GROUPS,
  appleWatchDeviceFingerprint,
  buildAppleWatchStepBuckets,
  mergeAppleWatchStepBucket,
} from '../healthkit/index.js';
import { combineActiveEnergy } from '../energy/accounting.js';

const USER = '7f2c9a10-4b3e-4d8a-9c11-00000000hk01';

function iso(h, day = '2026-08-25') {
  return `${day}T${String(h).padStart(2, '0')}:00:00.000Z`;
}

function workout(over = {}) {
  return {
    start_at: iso(18, '2026-08-25'),
    end_at: iso(19, '2026-08-25'),
    kind: 'workout',
    source: 'frwhoop',
    id: '11111111-1111-4111-8111-111111111111',
    summary: { sport: 'Running', name: 'Running', calories: 500, avg_hr: 148, distance_m: 10000 },
    ...over,
  };
}

function hkWorkout(over = {}) {
  return {
    start_time: '2026-08-25T18:03:00.000Z',
    end_time: '2026-08-25T19:11:00.000Z',
    sport: 'Running',
    calories: 510,
    avg_hr: 150,
    distance_m: 10100,
    uuid: 'watch-run-1',
    source_bundle: 'com.apple.health',
    source_app: 'Apple Watch',
    source_device: 'Apple Watch',
    device_model: 'Watch7,1',
    ...over,
  };
}

function watchStep(over = {}) {
  return {
    uuid: 'watch-steps-1',
    metric_type: 'steps',
    sample_kind: 'raw_quantity_sample',
    value: 120,
    unit: 'count',
    start_time: '2026-08-25T12:00:30.000Z',
    end_time: '2026-08-25T12:02:30.000Z',
    source_bundle: 'com.apple.health.watch-1',
    source_app: 'Apple Health',
    source_revision: '26.0',
    device_provenance: {
      name: 'Rahul Apple Watch',
      manufacturer: 'Apple Inc.',
      model: 'Watch',
      hardware_version: 'Watch7,1',
      firmware_version: '12.0',
      software_version: '12.0',
      local_identifier: 'watch-local-1',
      udi_device_identifier: '',
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Provenance + classification
// ---------------------------------------------------------------------------

test('HealthKit samples keep provenance through normalization', () => {
  const m = normalizeMeasurement({
    uuid: 'hk-1',
    metric_type: 'heart_rate',
    value: 72,
    unit: 'count/min',
    start_time: iso(12),
    end_time: iso(12),
    source_app: 'Apple Watch',
    sourceBundleIdentifier: 'com.apple.health',
    deviceName: 'Apple Watch',
    deviceModel: 'Watch7,1',
    sourceRevision: '12.0',
    metadata: { HKMetadataKeyHeartRateMotionContext: 0 },
  });
  assert.equal(m.source, SOURCES.APPLE_WATCH_HEALTHKIT);
  assert.equal(m.original_sample_id, 'hk-1');
  assert.equal(m.source_bundle, 'com.apple.health');
  assert.equal(m.source_app, 'Apple Watch');
  assert.equal(m.device_model, 'Watch7,1');
  assert.equal(m.source_revision, '12.0');
  assert.equal(m.metadata.HKMetadataKeyHeartRateMotionContext, 0);
  assert.ok(m.ingested_at);
  assert.equal(m.rejected, false);
});

test('iPhone and third-party HealthKit sources stay distinct from Apple Watch', () => {
  assert.equal(classifySource({ bundleId: 'com.apple.health', deviceName: 'iPhone 16' }), SOURCES.IPHONE_HEALTHKIT);
  assert.equal(classifySource({ bundleId: 'com.apple.health', deviceName: 'Apple Watch Ultra' }), SOURCES.APPLE_WATCH_HEALTHKIT);
  assert.equal(classifySource({ bundleId: 'com.strava.stravaride', sourceName: 'Strava' }), SOURCES.THIRD_PARTY_HEALTHKIT);
  assert.equal(classifySource({ bundleId: 'com.rahulvijayan.frwhoop' }), SOURCES.FRWHOOP_DERIVED);
});

test('corrupted HR samples are rejected, not merged', () => {
  const bad = normalizeMeasurement({ metric_type: 'heart_rate', value: 340, uuid: 'x', start_time: iso(1) });
  assert.equal(bad.rejected, true);
  assert.equal(bad.reject_reason, 'corrupted_hr');
  const neg = normalizeMeasurement({ metric_type: 'steps', value: -4, uuid: 'y', start_time: iso(1) });
  assert.equal(neg.rejected, true);
});

// ---------------------------------------------------------------------------
// Source arbitration
// ---------------------------------------------------------------------------

test('heart rate prefers WHOOP and never averages Apple Watch into it', () => {
  const r = arbitrate('heart_rate', [
    { source: SOURCES.WHOOP_BLE, value: 64 },
    { source: SOURCES.APPLE_WATCH_HEALTHKIT, value: 88 },
  ]);
  assert.equal(r.value, 64);
  assert.equal(r.source, SOURCES.WHOOP_BLE);
  assert.equal(r.comparison.length, 1);
  assert.equal(r.comparison[0].value, 88);
  assert.equal(SOURCE_POLICY.heart_rate.fusion, null);
});

test('WHOOP-only, Watch-only, and both-devices cases are deterministic', () => {
  assert.equal(arbitrate('heart_rate', [{ source: SOURCES.WHOOP_BLE, value: 60 }]).source, SOURCES.WHOOP_BLE);
  assert.equal(arbitrate('heart_rate', [{ source: SOURCES.APPLE_WATCH_HEALTHKIT, value: 70 }]).source, SOURCES.APPLE_WATCH_HEALTHKIT);
  const both = arbitrate('calories', [
    { source: SOURCES.FRWHOOP_DERIVED, value: 400 },
    { source: SOURCES.APPLE_WATCH_HEALTHKIT, value: 650 },
  ]);
  assert.equal(both.value, 400);
  assert.equal(both.reason, 'primary');
});

test('steps prefer WHOOP and are not the sum of WHOOP + Apple', () => {
  const r = arbitrate('steps', [
    { source: SOURCES.WHOOP_BLE, value: 4000 },
    { source: SOURCES.APPLE_WATCH_HEALTHKIT, value: 9800 },
  ]);
  assert.equal(r.value, 4000);
  assert.notEqual(r.value, 13800);
});

test('legacy merged daily step summaries are rejected and never become canonical', () => {
  const out = ingestHealthKit({
    userId: USER,
    payload: {
      daily: [
        {
          day: '2026-08-26',
          metric_type: 'steps',
          value: 1829.8790579441636,
          source_bundle: 'com.strava',
          source_app: 'Strava',
          start_time: '2026-08-26T07:00:00.000Z',
          end_time: '2026-08-27T07:00:00.000Z',
        },
        {
          day: '2026-08-26',
          metric_type: 'steps',
          value: 2099,
          source_bundle: 'com.apple.health',
          source_app: 'Apple Watch',
          source_device: 'Apple Watch',
          start_time: '2026-08-26T07:00:00.000Z',
          end_time: '2026-08-27T07:00:00.000Z',
        },
      ],
    },
  });
  assert.equal(out.daily['2026-08-26'], undefined);
  assert.equal(out.rejected.length, 2);
  assert.ok(out.rejected.every((sample) => sample.reject_reason === 'merged_step_summary_not_raw'));
  const applied = applyCanonicalDay({}, {});
  assert.equal(applied.steps, null);
  const strap = applyCanonicalDay({ steps: 1500 }, {});
  assert.equal(strap.steps, 1500);
});

test('HRV methodologies are not treated as interchangeable', () => {
  assert.match(SOURCE_POLICY.hrv.note, /not interchangeable/);
  const r = arbitrate('hrv', [
    { source: SOURCES.FRWHOOP_DERIVED, value: 42 },
    { source: SOURCES.APPLE_WATCH_HEALTHKIT, value: 68 },
  ]);
  assert.equal(r.value, 42);
  assert.equal(r.comparison[0].value, 68);
});

test('weight prefers HealthKit; sleep and calories stay FRWHOOP on primary screens', () => {
  const day = applyCanonicalDay({
    hrv_rmssd_ms: 50,
    resting_hr_bpm: 52,
    active_kcal: 700,
    sleep_total_min: 420,
    steps: null,
    weight_kg: null,
  }, {
    steps: 9000,
    steps_source: SOURCES.APPLE_WATCH_HEALTHKIT,
    weight_kg: 78.2,
    weight_source: SOURCES.IPHONE_HEALTHKIT,
    active_kcal: 1100,
    kcal_source: SOURCES.APPLE_WATCH_HEALTHKIT,
    asleep_min: 390,
    sleep_source: SOURCES.APPLE_WATCH_HEALTHKIT,
    hrv_sdnn: 80,
    hrv_source: SOURCES.APPLE_WATCH_HEALTHKIT,
  });
  assert.equal(day.steps, null);
  assert.equal(day.weight_kg, 78.2);
  assert.equal(day.active_kcal, 700);
  assert.equal(day.sleep_total_min, 420);
  assert.equal(day.hrv_rmssd_ms, 50);
  assert.equal(day.sources.steps, undefined);
  assert.equal(day.sources.calories, SOURCES.FRWHOOP_DERIVED);
});

test('revoked HealthKit (empty candidates) does not wipe FRWHOOP values', () => {
  const day = applyCanonicalDay({ active_kcal: 500, hrv_rmssd_ms: 40 }, {});
  assert.equal(day.active_kcal, 500);
  assert.equal(day.hrv_rmssd_ms, 40);
});

// ---------------------------------------------------------------------------
// Workout reconciliation
// ---------------------------------------------------------------------------

test('near-overlapping FRWHOOP and Apple Watch runs are the same logical workout', () => {
  const result = classifyWorkoutMatch(
    { start: '2026-08-25T18:04:00Z', end: '2026-08-25T19:10:00Z', sport: 'Running', avgHr: 148, distanceM: 10000, calories: 500 },
    { start: '2026-08-25T18:03:00Z', end: '2026-08-25T19:11:00Z', sport: 'Running', avgHr: 150, distanceM: 10100, calories: 510 },
  );
  assert.equal(result.match, 'same_workout');
  assert.ok(result.confidence >= 0.85);
  assert.ok(result.iou > 0.7);
});

test('exact timestamps are not required; IoU drives the match', () => {
  const a = { start: 1_000_000, end: 1_003_600 };
  const b = { start: 1_000_120, end: 1_003_720 };
  assert.ok(intervalIoU(a, b) > 0.9);
});

test('non-overlapping sessions are different_workout', () => {
  const result = classifyWorkoutMatch(
    { start: iso(7), end: iso(8), sport: 'Running' },
    { start: iso(18), end: iso(19), sport: 'Running' },
  );
  assert.equal(result.match, 'different_workout');
});

test('ingest links a matching Watch workout and does not emit a duplicate primary session', () => {
  const out = ingestHealthKit({
    userId: USER,
    existingSessions: [workout()],
    payload: { workouts: [hkWorkout()] },
  });
  const primaries = primaryWorkouts([...out.sessions, workout()]);
  assert.equal(primaries.filter((s) => s.source === SOURCES.APPLE_WATCH_HEALTHKIT).length, 0);
  assert.equal(out.links[0].match, 'same_workout');
  assert.equal(out.links[0].relationship, 'skip_write');
  assert.equal(out.exportPlan.skipped[0].reason, 'skip_write');
});

test('Watch-only workout becomes a fallback canonical event, not a second FRWHOOP copy', () => {
  const out = ingestHealthKit({
    userId: USER,
    existingSessions: [],
    payload: { workouts: [hkWorkout()] },
  });
  assert.equal(out.sessions.length, 1);
  assert.equal(out.sessions[0].source, SOURCES.APPLE_WATCH_HEALTHKIT);
  assert.equal(out.sessions[0].summary.role, 'canonical_fallback');
});

test('FRWHOOP writes are excluded from HealthKit re-ingest', () => {
  const out = ingestHealthKit({
    userId: USER,
    payload: {
      workouts: [{
        ...hkWorkout(),
        source_bundle: 'com.rahulvijayan.frwhoop',
        uuid: 'ours',
      }],
    },
  });
  assert.equal(out.sessions.length, 0);
});

test('pairing is greedy by IoU so one Apple workout cannot match two FRWHOOP sessions', () => {
  const { pairs, unmatchedExternal } = pairIntervals(
    [
      { id: 'a', start: iso(18), end: iso(19), sport: 'Run' },
      { id: 'b', start: iso(18, '2026-08-26'), end: iso(19, '2026-08-26'), sport: 'Run' },
    ],
    [{ id: 'w', start: '2026-08-25T18:02:00Z', end: '2026-08-25T19:05:00Z', sport: 'Run' }],
    classifyWorkoutMatch,
  );
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].canonical.id, 'a');
  assert.equal(unmatchedExternal.length, 0);
});

// ---------------------------------------------------------------------------
// Sleep reconciliation
// ---------------------------------------------------------------------------

test('overlapping Apple and FRWHOOP sleep stays source-separated and is not summed', () => {
  const match = classifySleepMatch(
    { start: '2026-08-24T22:10:00Z', end: '2026-08-25T06:40:00Z' },
    { start: '2026-08-24T22:20:00Z', end: '2026-08-25T06:35:00Z' },
  );
  assert.equal(match.match, 'same_sleep');
  const out = ingestHealthKit({
    userId: USER,
    existingSessions: [{
      id: 'sleep-1',
      kind: 'sleep',
      source: 'frwhoop',
      start_at: '2026-08-24T22:10:00Z',
      end_at: '2026-08-25T06:40:00Z',
      summary: { asleep_min: 420 },
    }],
    payload: {
      sleep: [{
        start_time: '2026-08-24T22:20:00Z',
        end_time: '2026-08-25T06:35:00Z',
        asleep_min: 400,
        uuid: 'watch-sleep',
        source_bundle: 'com.apple.health',
        source_device: 'Apple Watch',
      }],
    },
  });
  assert.equal(out.sessions[0].summary.role, 'external_comparison');
  assert.equal(out.links[0].relationship, 'comparison');
  const summed = 420 + 400;
  assert.notEqual(out.sessions[0].summary.asleep_min, summed);
});

// ---------------------------------------------------------------------------
// Energy double counting
// ---------------------------------------------------------------------------

test('overlapping FRWHOOP and Apple calories cannot be summed', () => {
  const mixed = combineActiveEnergy([
    { source: SOURCES.FRWHOOP_DERIVED, start: iso(18), end: iso(19), kcal: 500 },
    { source: SOURCES.APPLE_WATCH_HEALTHKIT, start: '2026-08-25T18:03:00Z', end: '2026-08-25T19:11:00Z', kcal: 510 },
  ]);
  assert.equal(mixed.ok, false);
  assert.equal(mixed.error, 'overlapping_energy_sources');
  assert.equal(mixed.kcal, null);
});

test('duplicate workout energy from the same source is rejected', () => {
  const dup = combineActiveEnergy([
    { source: SOURCES.APPLE_WATCH_HEALTHKIT, start: iso(18), end: iso(19), kcal: 400 },
    { source: SOURCES.APPLE_WATCH_HEALTHKIT, start: '2026-08-25T18:10:00Z', end: '2026-08-25T18:50:00Z', kcal: 380 },
  ]);
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'duplicate_energy_interval');
});

test('non-overlapping same-source intervals may be aggregated deliberately', () => {
  const ok = combineActiveEnergy([
    { source: SOURCES.FRWHOOP_DERIVED, start: iso(7), end: iso(8), kcal: 200 },
    { source: SOURCES.FRWHOOP_DERIVED, start: iso(18), end: iso(19), kcal: 400 },
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.kcal, 600);
});

test('third-party energy overlapping FRWHOOP is not added', () => {
  const r = combineActiveEnergy([
    { source: SOURCES.FRWHOOP_DERIVED, start: iso(18), end: iso(19), kcal: 500 },
    { source: SOURCES.THIRD_PARTY_HEALTHKIT, start: iso(18), end: iso(19), kcal: 300 },
  ]);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// Idempotent writes / sync identity
// ---------------------------------------------------------------------------

test('sync identifiers are stable and versions increment only on change', () => {
  assert.equal(syncIdentifier('workout', 'abc'), 'frwhoop:workout:abc');
  assert.equal(nextSyncVersion(1, false), 1);
  assert.equal(nextSyncVersion(1, true), 2);
  assert.equal(nextSyncVersion(undefined, false), 1);
});

test('exporting the same workout twice does not create a second write', () => {
  const canonical = [workout()];
  const first = buildExportPlan({ canonicalWorkouts: canonical, links: [] });
  assert.equal(first.writes.length, 1);
  const link = {
    canonical_kind: 'workout',
    canonical_id: canonical[0].id,
    relationship: 'skip_write',
    sync_version: 1,
    payload: { fingerprint: first.writes[0]?.fingerprint },
  };
  // After a match, skip_write: second export is empty.
  const second = buildExportPlan({ canonicalWorkouts: canonical, links: [link] });
  assert.equal(second.writes.length, 0);
  assert.equal(second.skipped.length, 1);
});

test('retrospective workout edit increments sync version instead of duplicating', () => {
  const original = workout();
  const first = buildExportPlan({ canonicalWorkouts: [original], links: [] });
  const edited = workout({ end_at: iso(20), summary: { ...original.summary, calories: 620 } });
  const second = buildExportPlan({
    canonicalWorkouts: [edited],
    links: [{
      canonical_kind: 'workout',
      canonical_id: original.id,
      relationship: 'write',
      sync_version: 1,
      payload: { fingerprint: first.writes[0].fingerprint },
    }],
  });
  assert.equal(second.writes[0].sync_identifier, first.writes[0].sync_identifier);
  assert.equal(second.writes[0].sync_version, 2);
});

test('ingest is idempotent on HealthKit UUID', () => {
  const payload = { workouts: [hkWorkout()], samples: [] };
  const a = ingestHealthKit({ userId: USER, payload, existingSessions: [] });
  const b = ingestHealthKit({ userId: USER, payload, existingSessions: a.sessions });
  assert.equal(a.sessions[0].external_id, 'watch-run-1');
  assert.equal(b.sessions.filter((s) => s.external_id === 'watch-run-1').length, 1);
});

// ---------------------------------------------------------------------------
// Historical vs incremental, anchors, retries, offline
// ---------------------------------------------------------------------------

test('empty incremental payload is a no-op and does not delete canonical sessions', () => {
  const existing = [workout()];
  const out = ingestHealthKit({ userId: USER, payload: {}, existingSessions: existing });
  assert.equal(out.sessions.length, 0);
  assert.equal(existing.length, 1);
});

test('partial authorization (only workouts) still ingests those types', () => {
  const out = ingestHealthKit({
    userId: USER,
    payload: { workouts: [hkWorkout()], samples: [], sleep: [] },
    existingSessions: [],
  });
  assert.equal(out.sessions.length, 1);
  assert.equal(out.measurements.length, 0);
});

test('offline ingest still produces a local export plan', () => {
  const out = ingestHealthKit({
    userId: USER,
    existingSessions: [workout()],
    payload: { workouts: [] },
  });
  assert.ok(out.exportPlan.writes.length >= 1);
});

// ---------------------------------------------------------------------------
// Timezones, DST, day boundary
// ---------------------------------------------------------------------------

test('DST spring-forward still matches overlapping workouts by epoch', () => {
  // US Pacific 2026-03-08: 02:00 does not exist. Epoch math must still overlap.
  const result = classifyWorkoutMatch(
    { start: '2026-03-08T09:30:00.000Z', end: '2026-03-08T11:30:00.000Z', sport: 'Run' },
    { start: '2026-03-08T09:25:00.000Z', end: '2026-03-08T11:35:00.000Z', sport: 'Run' },
  );
  assert.equal(result.match, 'same_workout');
});

test('sleep spanning local midnight matches on absolute timestamps', () => {
  const result = classifySleepMatch(
    { start: '2026-08-24T05:00:00.000Z', end: '2026-08-24T13:00:00.000Z' },
    { start: '2026-08-24T05:10:00.000Z', end: '2026-08-24T12:50:00.000Z' },
  );
  assert.equal(result.match, 'same_sleep');
});

test('historical HealthKit duplicates collapse to one link per external id', () => {
  const out = ingestHealthKit({
    userId: USER,
    existingSessions: [workout()],
    payload: { workouts: [hkWorkout(), hkWorkout()] },
  });
  const ids = out.links.map((l) => l.external_id);
  assert.equal(new Set(ids).size, ids.length);
});

test('gap-fill does not replace a present WHOOP heart rate', () => {
  const r = arbitrate('heart_rate', [
    { source: SOURCES.WHOOP_BLE, value: 61 },
    { source: SOURCES.APPLE_WATCH_HEALTHKIT, value: 90 },
  ]);
  assert.equal(r.value, 61);
  const gap = arbitrate('heart_rate', [
    { source: SOURCES.APPLE_WATCH_HEALTHKIT, value: 90 },
  ]);
  assert.equal(gap.value, 90);
  assert.equal(gap.reason, 'validation_gap_fill');
});

// ---------------------------------------------------------------------------
// Durable identity
// ---------------------------------------------------------------------------

test('HealthKit measurements carry source_system and HealthKit UUID', () => {
  const out = ingestHealthKit({
    userId: USER,
    payload: {
      samples: [{
        uuid: 'hk-hrv-1',
        metric_type: 'hrv',
        value: 48,
        unit: 'ms',
        start_time: iso(7),
        end_time: iso(7),
        source_bundle: 'com.apple.health',
        source_device: 'Apple Watch',
      }],
    },
  });
  assert.equal(out.measurements.length, 1);
  assert.equal(out.measurements[0].source_system, SOURCES.APPLE_WATCH_HEALTHKIT);
  assert.equal(out.measurements[0].external_id, 'hk-hrv-1');
});

test('HealthKit HRV and respiratory samples fill missing daily vitals', () => {
  const sample = (uuid, metric_type, value) => ({
    uuid, metric_type, value, start_time: iso(7),
    source_bundle: 'com.apple.health', source_device: 'Apple Watch',
  });
  const out = ingestHealthKit({
    userId: USER,
    payload: {
      daily: [{ day: '2026-08-25' }],
      samples: [
        sample('hrv-1', 'hrv', 40),
        sample('hrv-2', 'hrv', 60),
        sample('resp-1', 'respiratory_rate', 16),
      ],
    },
  });
  const applied = applyCanonicalDay({}, out.daily['2026-08-25']);
  assert.equal(applied.hrv_rmssd_ms, 50);
  assert.equal(applied.resp_rate_bpm, 16);
});

test('HealthKit resting HR samples fill missing daily RHR', () => {
  const out = ingestHealthKit({
    userId: USER,
    payload: {
      daily: [{ day: '2026-08-25', metric_type: 'steps', value: 6282, start_time: iso(7) }],
      samples: [{
        uuid: 'rhr-1',
        metric_type: 'resting_heart_rate',
        value: 52,
        start_time: '2026-08-24T05:00:00.000Z',
        end_time: '2026-08-25T12:00:00.000Z',
        source_bundle: 'com.apple.health',
        source_device: 'Apple Watch',
      }],
    },
  });
  assert.equal(out.daily['2026-08-25'].resting_hr, 52);
  assert.equal(out.daily['2026-08-25'].steps, undefined);
  assert.equal(out.rejected[0].reject_reason, 'merged_step_summary_not_raw');
});

test('samples without a HealthKit UUID are rejected, not persisted', () => {
  const out = ingestHealthKit({
    userId: USER,
    payload: { samples: [{ metric_type: 'hrv', value: 40, start_time: iso(7), source_bundle: 'com.apple.health', source_device: 'Apple Watch' }] },
  });
  assert.equal(out.measurements.length, 0);
  assert.equal(out.rejected[0].reject_reason, 'missing_external_id');
});

test('permission groups do not request unused HealthKit types', () => {
  const fitness = PERMISSION_GROUPS.fitness.read.join(',');
  const body = PERMISSION_GROUPS.body.read.join(',');
  const nutrition = PERMISSION_GROUPS.nutrition.read.join(',');
  assert.equal(fitness.includes('appleExerciseTime'), false);
  assert.equal(fitness.includes('walkingSpeed'), false);
  assert.equal(body.includes('appleSleepingWristTemperature'), false);
  assert.equal(nutrition.includes('dietaryWater'), false);
  assert.equal(nutrition.includes('dietaryCaffeine'), false);
  assert.ok(fitness.includes('workoutType'));
  assert.ok(PERMISSION_GROUPS.heart.read.includes('heartRateVariabilitySDNN'));
});

test('Strand and FRWHOOP bundles are classified as our own writes', () => {
  assert.equal(classifySource({ bundleId: 'com.noopapp.noop' }), SOURCES.FRWHOOP_DERIVED);
  assert.equal(classifySource({ bundleId: 'com.noop.strand' }), SOURCES.FRWHOOP_DERIVED);
});

// ---------------------------------------------------------------------------
// Adversarial arbitration
// ---------------------------------------------------------------------------

test('Watch workout starting 15 minutes before FRWHOOP is the same workout', () => {
  const result = classifyWorkoutMatch(
    { start: '2026-08-25T18:00:00.000Z', end: '2026-08-25T19:00:00.000Z', sport: 'Running' },
    { start: '2026-08-25T17:45:00.000Z', end: '2026-08-25T19:00:00.000Z', sport: 'Running' },
  );
  assert.equal(result.match, 'same_workout');
});

test('two FRWHOOP detections inside one Watch workout skip a second HealthKit write', () => {
  const a = workout({ id: '11111111-1111-4111-8111-111111111111', start_at: iso(18), end_at: '2026-08-25T18:25:00.000Z' });
  const b = workout({ id: '22222222-2222-4222-8222-222222222222', start_at: '2026-08-25T18:30:00.000Z', end_at: iso(19) });
  const out = ingestHealthKit({
    userId: USER,
    existingSessions: [a, b],
    payload: { workouts: [hkWorkout({ start_time: '2026-08-25T18:00:00.000Z', end_time: '2026-08-25T19:10:00.000Z' })] },
  });
  const skips = out.exportPlan.skipped.filter((s) => s.kind === 'workout');
  const writes = out.exportPlan.writes.filter((s) => s.kind === 'workout');
  assert.ok(skips.length >= 1);
  assert.equal(writes.length, 0);
});

test('different activity labels still match on overlap', () => {
  const result = classifyWorkoutMatch(
    { start: iso(18), end: iso(19), sport: 'Running' },
    { start: '2026-08-25T18:03:00.000Z', end: '2026-08-25T19:05:00.000Z', sport: 'Outdoor Run' },
  );
  assert.equal(result.match, 'same_workout');
});

test('two genuine close workouts stay distinct', () => {
  const result = classifyWorkoutMatch(
    { start: iso(18), end: '2026-08-25T18:40:00.000Z', sport: 'Running' },
    { start: '2026-08-25T18:50:00.000Z', end: '2026-08-25T19:30:00.000Z', sport: 'Running' },
  );
  assert.equal(result.match, 'different_workout');
  const out = ingestHealthKit({
    userId: USER,
    existingSessions: [workout({ start_at: iso(18), end_at: '2026-08-25T18:40:00.000Z' })],
    payload: {
      workouts: [hkWorkout({
        uuid: 'watch-run-2',
        start_time: '2026-08-25T18:50:00.000Z',
        end_time: '2026-08-25T19:30:00.000Z',
      })],
    },
  });
  assert.equal(out.sessions.filter((s) => s.kind === 'workout').length, 1);
  assert.equal(out.sessions[0].summary.role, 'canonical_fallback');
  assert.equal(out.exportPlan.writes.filter((w) => w.kind === 'workout').length, 1);
});

test('Watch pause and BLE gap do not change the overlap match', () => {
  const result = classifyWorkoutMatch(
    { start: iso(18), end: iso(19), sport: 'Cycling' },
    { start: iso(18), end: iso(19), sport: 'Cycling' },
  );
  assert.equal(result.match, 'same_workout');
});

test('sleep 11:02–7:31 vs 11:38–7:12 is the same night', () => {
  const result = classifySleepMatch(
    { start: '2026-08-24T06:38:00.000Z', end: '2026-08-24T14:12:00.000Z' },
    { start: '2026-08-24T06:02:00.000Z', end: '2026-08-24T14:31:00.000Z' },
  );
  assert.equal(result.match, 'same_sleep');
});

test('overlapping calories are never summed; FRWHOOP stays primary', () => {
  const r = arbitrate('calories', [
    { source: SOURCES.FRWHOOP_DERIVED, value: 740 },
    { source: SOURCES.APPLE_WATCH_HEALTHKIT, value: 620 },
  ]);
  assert.equal(r.value, 740);
  assert.notEqual(r.value, 1360);
  const combined = combineActiveEnergy([
    { source: SOURCES.FRWHOOP_DERIVED, kcal: 740, start: iso(0), end: iso(23) },
    { source: SOURCES.APPLE_WATCH_HEALTHKIT, kcal: 620, start: iso(0), end: iso(23) },
  ]);
  assert.equal(combined.ok, false);
  assert.equal(combined.error, 'overlapping_energy_sources');
});

test('Watch 12000 steps vs WHOOP 10900 uses WHOOP, not the sum', () => {
  const r = arbitrate('steps', [
    { source: SOURCES.WHOOP_BLE, value: 10900 },
    { source: SOURCES.APPLE_WATCH_HEALTHKIT, value: 12000 },
  ]);
  assert.equal(r.value, 10900);
  assert.notEqual(r.value, 22900);
});

test('retrying the same HealthKit workout is idempotent', () => {
  const first = ingestHealthKit({
    userId: USER,
    existingSessions: [workout()],
    payload: { workouts: [hkWorkout()] },
  });
  const second = ingestHealthKit({
    userId: USER,
    existingSessions: [workout(), ...first.sessions],
    existingLinks: first.links,
    payload: { workouts: [hkWorkout()] },
  });
  assert.equal(first.sessions[0]?.id, second.sessions[0]?.id);
  assert.equal(new Set(second.links.map((l) => l.external_id)).size, second.links.filter((l) => l.external_id === 'watch-run-1').length > 0 ? 1 : 0);
  const watchLinks = second.links.filter((l) => l.external_id === 'watch-run-1');
  assert.equal(new Set(watchLinks.map((l) => l.canonical_id)).size, watchLinks.length === 0 ? 0 : 1);
});

test('Watch steps fail closed for iPhone, nil, ambiguous, and third-party provenance', () => {
  const iPhone = watchStep({
    uuid: 'iphone-steps',
    device_provenance: {
      name: 'Rahul iPhone',
      manufacturer: 'Apple Inc.',
      model: 'iPhone',
      hardware_version: 'iPhone17,1',
      local_identifier: 'phone-local-1',
    },
  });
  const missingDevice = watchStep({ uuid: 'nil-device', device_provenance: {} });
  const ambiguous = watchStep({
    uuid: 'ambiguous-watch',
    source_bundle: 'com.apple.health',
    device_provenance: {
      name: 'Apple Watch',
      manufacturer: 'Apple Inc.',
      model: 'Watch',
      hardware_version: 'Watch7,1',
    },
  });
  const thirdParty = watchStep({ uuid: 'third-party-watch', source_bundle: 'com.example.pedometer' });
  const out = ingestHealthKit({
    userId: USER,
    payload: { samples: [iPhone, missingDevice, ambiguous, thirdParty] },
  });
  assert.equal(out.measurements.length, 0);
  assert.equal(out.appleWatchStepBuckets.length, 0);
  assert.deepEqual(new Set(out.rejected.map((sample) => sample.reject_reason)), new Set([
    'not_apple_watch_device',
    'ambiguous_watch_device',
    'third_party_step_source',
  ]));
});

test('duplicate raw HealthKit step UUIDs are ingested once', () => {
  const sample = watchStep();
  const out = ingestHealthKit({
    userId: USER,
    payload: { samples: [sample, { ...sample }] },
  });
  assert.equal(out.measurements.filter((m) => m.metric_type === 'steps').length, 1);
  assert.equal(out.measurements[0].metadata.device_provenance.local_identifier, 'watch-local-1');
  assert.equal(out.measurements[0].metadata.source_revision, '26.0');
  assert.equal(out.rejected[0].reject_reason, 'duplicate_healthkit_uuid');
  assert.equal(out.appleWatchStepBuckets.filter((bucket) => bucket.bucket_size_seconds === 60).length, 3);
});

test('coalesced and overlapping step intervals allocate fractionally into 60s then 300s', () => {
  const samples = [
    watchStep(),
    watchStep({
      uuid: 'watch-steps-2',
      value: 30,
      start_time: '2026-08-25T12:01:00.000Z',
      end_time: '2026-08-25T12:02:00.000Z',
    }),
  ].map((sample) => normalizeMeasurement(sample));
  const buckets = buildAppleWatchStepBuckets(samples, USER);
  const minute = buckets.filter((bucket) => bucket.bucket_size_seconds === 60);
  assert.deepEqual(minute.map((bucket) => bucket.step_count), [30, 90, 30]);
  assert.equal(minute[1].source_sample_ids.length, 2);
  assert.equal(minute[0].coalesced, true);
  assert.equal(minute[1].metadata.allocation_method, 'duration_overlap');
  const five = buckets.filter((bucket) => bucket.bucket_size_seconds === 300);
  assert.equal(five.length, 1);
  assert.equal(five[0].step_count, 150);
  assert.equal(five[0].allocation_method, 'sum_60s');
});

test('60s and 300s Watch bucket keys and device fingerprints are deterministic', () => {
  const sample = normalizeMeasurement(watchStep());
  const first = buildAppleWatchStepBuckets([sample], USER);
  const second = buildAppleWatchStepBuckets([sample], USER);
  assert.deepEqual(first.map((bucket) => bucket.bucket_key), second.map((bucket) => bucket.bucket_key));
  assert.deepEqual(new Set(first.map((bucket) => bucket.bucket_size_seconds)), new Set([60, 300]));
  assert.match(appleWatchDeviceFingerprint(sample), /^apple_watch:[0-9a-f]{64}$/);
  const upgraded = normalizeMeasurement(watchStep({
    device_provenance: { ...watchStep().device_provenance, firmware_version: '12.1' },
  }));
  assert.equal(appleWatchDeviceFingerprint(sample), appleWatchDeviceFingerprint(upgraded));
});

test('a unique Apple Health source bundle can identify a Watch when HKDevice identifiers are private', () => {
  const sample = normalizeMeasurement(watchStep({
    device_provenance: {
      ...watchStep().device_provenance,
      local_identifier: '',
      udi_device_identifier: '',
    },
  }));
  assert.match(appleWatchDeviceFingerprint(sample), /^apple_watch:[0-9a-f]{64}$/);
});

test('incremental Watch bucket contributions merge without overwrite or duplicate inflation', () => {
  const first = buildAppleWatchStepBuckets([
    normalizeMeasurement(watchStep({
      uuid: 'watch-incremental-1',
      value: 30,
      start_time: '2026-08-25T12:00:00.000Z',
      end_time: '2026-08-25T12:01:00.000Z',
    })),
  ], USER).find((bucket) => bucket.bucket_size_seconds === 60);
  const second = buildAppleWatchStepBuckets([
    normalizeMeasurement(watchStep({
      uuid: 'watch-incremental-2',
      value: 20,
      start_time: '2026-08-25T12:00:30.000Z',
      end_time: '2026-08-25T12:01:00.000Z',
    })),
  ], USER).find((bucket) => bucket.bucket_size_seconds === 60);
  const merged = mergeAppleWatchStepBucket(first, second);
  assert.equal(merged.step_count, 50);
  assert.deepEqual(merged.source_sample_ids, ['watch-incremental-1', 'watch-incremental-2']);
  assert.equal(mergeAppleWatchStepBucket(merged, second).step_count, 50);
});

test('multiple Apple Watches remain separate by stable device fingerprint', () => {
  const first = normalizeMeasurement(watchStep());
  const second = normalizeMeasurement(watchStep({
    uuid: 'watch-steps-other',
    device_provenance: {
      ...watchStep().device_provenance,
      local_identifier: 'watch-local-2',
    },
  }));
  const buckets = buildAppleWatchStepBuckets([first, second], USER);
  assert.equal(new Set(buckets.map((bucket) => bucket.device_fingerprint)).size, 2);
  assert.equal(buckets.filter((bucket) => bucket.bucket_size_seconds === 300).length, 2);
});

test('Watch buckets use absolute instants across DST and local midnight', () => {
  const dst = normalizeMeasurement(watchStep({
    uuid: 'dst-steps',
    value: 60,
    start_time: '2026-03-08T01:59:30.000-08:00',
    end_time: '2026-03-08T03:00:30.000-07:00',
  }));
  const midnight = normalizeMeasurement(watchStep({
    uuid: 'midnight-steps',
    value: 60,
    start_time: '2026-11-01T23:59:30.000-08:00',
    end_time: '2026-11-02T00:00:30.000-08:00',
  }));
  const dstBuckets = buildAppleWatchStepBuckets([dst], USER)
    .filter((bucket) => bucket.bucket_size_seconds === 60);
  assert.deepEqual(dstBuckets.map((bucket) => bucket.bucket_start), [
    '2026-03-08T09:59:00.000Z',
    '2026-03-08T10:00:00.000Z',
  ]);
  assert.deepEqual(dstBuckets.map((bucket) => bucket.step_count), [30, 30]);
  const midnightBuckets = buildAppleWatchStepBuckets([midnight], USER)
    .filter((bucket) => bucket.bucket_size_seconds === 60);
  assert.deepEqual(midnightBuckets.map((bucket) => bucket.bucket_start), [
    '2026-11-02T07:59:00.000Z',
    '2026-11-02T08:00:00.000Z',
  ]);
});

test('re-syncing raw Watch steps yields identical relational upsert identities', () => {
  const payload = { samples: [watchStep()] };
  const first = ingestHealthKit({ userId: USER, payload });
  const second = ingestHealthKit({ userId: USER, payload });
  assert.deepEqual(
    first.appleWatchStepBuckets.map((bucket) => [
      bucket.device_fingerprint,
      bucket.bucket_start,
      bucket.bucket_size_seconds,
      bucket.bucket_key,
    ]),
    second.appleWatchStepBuckets.map((bucket) => [
      bucket.device_fingerprint,
      bucket.bucket_start,
      bucket.bucket_size_seconds,
      bucket.bucket_key,
    ]),
  );
});
