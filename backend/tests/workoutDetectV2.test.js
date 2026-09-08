import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autocorr,
  periodicity,
  setRestCycles,
  parseDetectorMode,
  extractFeatures,
  detectExercise,
  classifySport,
  modalityTier,
  compactMotionFeatures,
  normalizeObservation,
  createWorkoutDetectorV2,
  compareNativeBackend,
  reconcileWorkoutV2,
  replayParity,
  parityRecord,
  FEATURE_SCHEMA_VERSION,
  WORKOUT_DETECT_V2_VERSION,
  V2_DEFAULTS,
} from '../metrics/workoutDetectV2.js';
import {
  evaluateWindow,
  strengthSetRest,
  phoneOnlySetRest,
  walkCadence,
  strapWalk,
  cyclingQuietWrist,
  choresStrap,
  stressHr,
  noisyDesk,
  series,
  stairs,
  driving,
  ordinaryWalk,
  sleepWake,
} from '../metrics/workoutDetectReplay.js';
import { createWorkoutDetectionService } from '../metrics/workoutDetectionService.js';
import { createCorrectionEvent } from '../metrics/workoutDetectLabels.js';
import { eventLevelReport, losoFolds, HARD_NEGATIVE_IDS } from '../metrics/workoutDetectEval.js';
import { analyzeLive51Frames, analyzeType43Probe, WRIST51_SCRIPT } from '../metrics/liveImuLab.js';
import { puffinRT } from './fixtures/whoopFrames.mjs';

const T0 = Date.UTC(2026, 7, 20, 18, 0, 0);

function feed(det, samples) {
  for (const s of samples) det.ingest(s);
}

function phys() {
  return { restingHr: 60, maxHr: 174, floor: 114, activeFloor: 75, physReady: true };
}

function ringOf(samples) {
  return samples.map((s) => normalizeObservation(s)).filter(Boolean);
}

function v2() {
  return createWorkoutDetectorV2({ thresholds: () => ({ restingHr: 60, maxHr: 174 }) });
}

test('parseDetectorMode empty version is V2 canonical', () => {
  assert.equal(parseDetectorMode(undefined).canonical, 'v2');
  assert.equal(parseDetectorMode('').canonical, 'v2');
  assert.equal(parseDetectorMode('2.2.1-beta').canonical, 'v2');
  assert.deepEqual(parseDetectorMode('1.2.0'), { canonical: 'v1', shadow: 'v2', label: '1.3.0' });
  assert.equal(parseDetectorMode('1.3.0').canonical, 'v1');
  assert.equal(parseDetectorMode('2.0.0-shadow').canonical, 'v1');
  assert.equal(parseDetectorMode('2.0.0-shadow').shadow, 'v2');
  assert.equal(parseDetectorMode('2.0.0').canonical, 'v2');
});

test('autocorr / periodicity / set-rest are defined on a square wave', () => {
  const xs = [];
  for (let i = 0; i < 40; i += 1) xs.push(i % 8 < 4 ? 1 : 0);
  assert.ok(autocorr(xs, 8) > autocorr(xs, 3));
  const p = periodicity(xs);
  assert.ok(p.peak > 0.4);
  const energy = [];
  for (let i = 0; i < 18; i += 1) energy.push(i % 6 < 3 ? 0.2 : 0.01);
  assert.ok(setRestCycles(energy) >= 2);
});

test('1. trusted strap motion versus phone-only motion stay separate', () => {
  const samples = [];
  for (let i = 0; i < 60; i += 1) {
    samples.push({
      ts: T0 + i * 1000, bpm: 90, phoneMotion: 0.4, strapMotion: 0.02, motion: 0.4,
    });
  }
  const feat = extractFeatures(ringOf(samples), T0 + 59_000, phys(), V2_DEFAULTS);
  assert.ok(feat.phone.mean60 > 0.3);
  assert.ok(feat.strap.mean60 < 0.05);
  assert.equal(feat.coverage.phoneMotion, true);
  assert.equal(feat.coverage.strapMotion, true);
  assert.equal(feat.coverage.unspecifiedMotion, false);
  assert.equal(feat.tier, 'B');
  const collapsed = normalizeObservation({ ts: T0, bpm: 90, motion: 0.4, mot: 0.4, dynAccel: 0.4 });
  assert.equal(collapsed.strapMotion, null);
  assert.equal(collapsed.phoneMotion, null);
});

test('2. historical v18 dynamic acceleration cannot confirm a live workout', () => {
  const det = v2();
  feed(det, series({ t0: T0, seconds: 120, bpm: 70, strapMotion: 0.02 }));
  for (let i = 0; i < 8 * 60; i += 1) {
    det.ingest({
      ts: T0 + 120_000 + i * 1000,
      bpm: 140,
      strapMotion: 0.25,
      dynAccel: 0.25,
      historical: true,
      src: 'v18',
      origin: 'historical',
    });
  }
  assert.notEqual(det.snapshot().detectorState, 'CONFIRMED');
  const feat = extractFeatures(ringOf(series({
    t0: T0, seconds: 40, bpm: 90, strapMotion: 0.2, historical: true, origin: 'historical',
  }).map((s) => ({ ...s, src: 'v18', historical: true }))), T0 + 39_000, phys());
  assert.equal(feat.coverage.wristLive, false);
  assert.equal(feat.coverage.historicalDynAccel, true);
});

test('3. low motion does not imply strength', () => {
  const samples = series({ t0: T0, seconds: 90, bpm: 95, strapMotion: 0.02, motionSource: 'wrist_imu_51' });
  const feat = extractFeatures(ringOf(samples), T0 + 89_000, phys());
  const cls = classifySport(feat, 'cardio_low_wrist', V2_DEFAULTS);
  assert.notEqual(cls.sport, 'strength');
  assert.notEqual(cls.activity, 'strength');
});

test('4. HR pulses alone do not imply strength', () => {
  const samples = [];
  for (let i = 0; i < 8 * 60; i += 1) {
    const work = (i % 70) < 28;
    samples.push({ ts: T0 + i * 1000, bpm: work ? 110 : 72 });
  }
  const ev = evaluateWindow({
    samples, start: T0, end: T0 + 8 * 60_000, restingHr: 60, maxHr: 174, padMin: 0,
  });
  assert.equal(ev.v2.hit, false);
  const feat = extractFeatures(ringOf(samples), T0 + 7 * 60_000, phys());
  assert.notEqual(classifySport(feat, 'generic').sport, 'strength');
});

test('5. repeated real set-motion + HR episodes can become strength', () => {
  const samples = [
    ...series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02, motionSource: 'wrist_imu_51' }),
    ...strengthSetRest({ t0: T0 + 180_000, minutes: 8, hr: 92 }),
  ];
  const ev = evaluateWindow({
    samples,
    start: T0 + 180_000,
    end: T0 + 180_000 + 8 * 60_000,
    restingHr: 60,
    maxHr: 174,
    padMin: 5,
  });
  assert.equal(ev.v1.hit, false);
  assert.equal(ev.v2.hit, true);
  assert.equal(ev.v2.sport, 'strength');
});

test('6. steady cycling-like HR with quiet wrist is generic low-wrist cardio', () => {
  const samples = [
    ...series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02, motionSource: 'wrist_imu_51' }),
    ...cyclingQuietWrist({ t0: T0 + 180_000, minutes: 12, hr: 140 }),
  ];
  const ev = evaluateWindow({
    samples,
    start: T0 + 180_000,
    end: T0 + 180_000 + 12 * 60_000,
    restingHr: 60,
    maxHr: 174,
    padMin: 0,
  });
  assert.equal(ev.v2.hit, true);
  assert.notEqual(ev.v2.sport, 'walking');
  assert.notEqual(ev.v2.sport, 'strength');
  assert.equal(ev.v2.sport, 'detected');
});

test('7. rhythmic gait becomes walking only with supporting cadence', () => {
  const noCadence = [
    ...series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02 }),
    ...series({
      t0: T0 + 180_000, seconds: 8 * 60, bpm: 100, strapMotion: 0.2, motionSource: 'wrist_imu_51',
    }),
  ];
  const withCadence = [
    ...series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02 }),
    ...strapWalk({ t0: T0 + 180_000, minutes: 8, hr: 100 }),
  ];
  const a = evaluateWindow({
    samples: noCadence, start: T0 + 180_000, end: T0 + 180_000 + 8 * 60_000, restingHr: 60, maxHr: 174, padMin: 0,
  });
  const b = evaluateWindow({
    samples: withCadence, start: T0 + 180_000, end: T0 + 180_000 + 8 * 60_000, restingHr: 60, maxHr: 174, padMin: 0,
  });
  if (a.v2.hit) assert.notEqual(a.v2.sport, 'walking');
  assert.equal(b.v2.hit, true);
  assert.equal(b.v2.sport, 'walking');
});

test('8. chores do not become walking', () => {
  const ev = evaluateWindow({
    samples: choresStrap({ t0: T0, minutes: 10 }),
    start: T0, end: T0 + 10 * 60_000, restingHr: 60, maxHr: 174, padMin: 0,
  });
  assert.equal(ev.v2.hit, false);
});

test('9. desk stress does not become HR-only workout before conservative gates', () => {
  const samples = [
    ...series({ t0: T0, seconds: 120, bpm: 70, phoneMotion: 0.01 }),
    ...stressHr({ t0: T0 + 120_000, minutes: 10, hr: 138 }),
  ];
  const ev = evaluateWindow({
    samples, start: T0 + 120_000, end: T0 + 120_000 + 10 * 60_000, restingHr: 60, maxHr: 174, padMin: 0,
  });
  assert.equal(ev.v2.hit, false);
});

test('10. short stairs do not confirm', () => {
  const ev = evaluateWindow({
    samples: stairs({ t0: T0, minutes: 3, hr: 118 }),
    start: T0, end: T0 + 3 * 60_000, restingHr: 60, maxHr: 174, padMin: 0,
  });
  assert.equal(ev.v2.hit, false);
});

test('11. gap >90 s resets a pre-confirm candidate', () => {
  const det = v2();
  for (let i = 0; i < 40; i += 1) {
    det.ingest({ ts: T0 + i * 1000, bpm: 100, strapMotion: 0.2, motionSource: 'wrist_imu_51' });
  }
  assert.notEqual(det.snapshot().detectorState, 'IDLE');
  assert.notEqual(det.snapshot().detectorState, 'CONFIRMED');
  det.tick(T0 + 40_000 + 120_000);
  assert.equal(det.snapshot().detectorState, 'IDLE');
  assert.ok(det.snapshot().counters.reset_signal_gap >= 1);
});

test('12. strength-specific long rest is allowed only after strength evidence', () => {
  const det = v2();
  feed(det, series({ t0: T0, seconds: 60, bpm: 70, strapMotion: 0.02 }));
  feed(det, series({ t0: T0 + 60_000, seconds: 40, bpm: 95, strapMotion: 0.02 }));
  feed(det, series({ t0: T0 + 100_000, seconds: 200, bpm: 70, strapMotion: 0.02 }));
  assert.equal(det.snapshot().detectorState, 'IDLE');

  const strong = v2();
  feed(strong, series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02, motionSource: 'wrist_imu_51' }));
  feed(strong, strengthSetRest({ t0: T0 + 180_000, minutes: 8, hr: 92 }));
  assert.equal(strong.snapshot().detectorState, 'CONFIRMED');
  feed(strong, series({
    t0: T0 + 180_000 + 8 * 60_000, seconds: 5 * 60, bpm: 80, strapMotion: 0.02, motionSource: 'wrist_imu_51',
  }));
  assert.equal(strong.snapshot().detectorState, 'CONFIRMED');
});

test('13. reconnect retains one canonical ID', () => {
  const events = [];
  const det = createWorkoutDetectorV2({
    thresholds: () => ({ restingHr: 60, maxHr: 174 }),
    onEvent: (e) => events.push(e),
  });
  feed(det, series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02, motionSource: 'wrist_imu_51' }));
  feed(det, series({
    t0: T0 + 180_000, seconds: 10 * 60, bpm: 150, strapMotion: 0.22, motionSource: 'wrist_imu_51',
  }));
  const id = det.snapshot().workoutId;
  assert.equal(det.snapshot().detectorState, 'CONFIRMED');
  det.tick(T0 + 180_000 + 10 * 60_000 + 120_000);
  assert.equal(det.snapshot().internalState, 'SUSPENDED_UNKNOWN');
  det.ingest({
    ts: T0 + 180_000 + 10 * 60_000 + 150_000,
    bpm: 148,
    strapMotion: 0.2,
    motionSource: 'wrist_imu_51',
  });
  assert.equal(det.snapshot().detectorState, 'CONFIRMED');
  assert.equal(det.snapshot().workoutId, id);
  assert.equal(events.filter((e) => e.type === 'workout_start').length, 1);
});

test('14. long unknown gap does not inflate duration', () => {
  const events = [];
  const det = createWorkoutDetectorV2({
    thresholds: () => ({ restingHr: 60, maxHr: 174 }),
    onEvent: (e) => events.push(e),
  });
  feed(det, series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02, motionSource: 'wrist_imu_51' }));
  feed(det, series({
    t0: T0 + 180_000, seconds: 10 * 60, bpm: 150, strapMotion: 0.22, motionSource: 'wrist_imu_51',
  }));
  const lastLive = T0 + 180_000 + 10 * 60_000 - 1000;
  det.tick(lastLive + 8 * 60_000);
  const end = events.filter((e) => e.type === 'workout_end').at(-1);
  assert.ok(end);
  assert.ok(end.workout.endTs <= lastLive + 5000, `end ${end.workout.endTs} last ${lastLive}`);
  assert.ok(end.workout.durationS < 20 * 60);
});

test('15. effective start is backdated but never across a gap', () => {
  const events = [];
  const det = createWorkoutDetectorV2({
    thresholds: () => ({ restingHr: 60, maxHr: 174 }),
    onEvent: (e) => events.push(e),
  });
  feed(det, series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02, motionSource: 'wrist_imu_51' }));
  feed(det, series({
    t0: T0 + 180_000, seconds: 90, bpm: 148, strapMotion: 0.2, motionSource: 'wrist_imu_51',
  }));
  feed(det, series({
    t0: T0 + 180_000 + 90_000 + 120_000, seconds: 3 * 60, bpm: 65, strapMotion: 0.02, motionSource: 'wrist_imu_51',
  }));
  feed(det, series({
    t0: T0 + 180_000 + 90_000 + 120_000 + 180_000, seconds: 10 * 60, bpm: 150, strapMotion: 0.22, motionSource: 'wrist_imu_51',
  }));
  const start = events.find((e) => e.type === 'workout_start');
  assert.ok(start);
  assert.ok(start.workout.effectiveStartTs >= T0 + 180_000 + 90_000 + 120_000 - 15_000);
});

test('16. effective end trims the grace period', () => {
  const events = [];
  const det = createWorkoutDetectorV2({
    thresholds: () => ({ restingHr: 60, maxHr: 174 }),
    onEvent: (e) => events.push(e),
  });
  feed(det, series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02, motionSource: 'wrist_imu_51' }));
  feed(det, series({
    t0: T0 + 180_000, seconds: 10 * 60, bpm: 150, strapMotion: 0.22, motionSource: 'wrist_imu_51',
  }));
  const lastEx = T0 + 180_000 + 10 * 60_000 - 1000;
  feed(det, series({
    t0: T0 + 180_000 + 10 * 60_000, seconds: 5 * 60, bpm: 72, strapMotion: 0.02, motionSource: 'wrist_imu_51',
  }));
  const end = events.find((e) => e.type === 'workout_end');
  assert.ok(end);
  assert.ok(Math.abs(end.workout.endTs - lastEx) < 15_000, `end ${end.workout.endTs} lastEx ${lastEx}`);
});

test('17. dismissal cooldown works', () => {
  const events = [];
  const det = createWorkoutDetectorV2({
    thresholds: () => ({ restingHr: 60, maxHr: 174 }),
    onEvent: (e) => events.push(e),
    now: () => T0 + 900_000,
  });
  feed(det, series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02 }));
  feed(det, strapWalk({ t0: T0 + 180_000, minutes: 8, hr: 110 }));
  det.dismiss('user');
  assert.equal(det.snapshot().detectorState, 'IDLE');
  for (let i = 0; i < 40; i += 1) {
    det.ingest({
      ts: T0 + 900_000 + i * 1000, bpm: 150, strapMotion: 0.25, step_cadence: 110, motionSource: 'wrist_imu_51',
    });
  }
  assert.equal(det.snapshot().detectorState, 'IDLE');
});

test('18. user edits survive reconciliation', () => {
  const workout = {
    id: 'w1', startTs: T0, endTs: T0 + 600_000, sport: 'detected', userModified: true,
  };
  const obs = series({ t0: T0, seconds: 600, bpm: 150, strapMotion: 0.2 });
  const rec = reconcileWorkoutV2({ workout, observations: obs });
  assert.equal(rec.changed, false);
  assert.equal(rec.reason, 'user_edited');
});

test('19. HISTORY_COMPLETE reconciliation is idempotent', () => {
  const workout = { id: 'w2', startTs: T0 + 10_000, endTs: T0 + 500_000, sport: 'detected' };
  const obs = [
    ...series({ t0: T0, seconds: 600, bpm: 150, strapMotion: 0.2, origin: 'historical', historical: true }),
  ];
  const a = reconcileWorkoutV2({ workout, observations: obs });
  const b = reconcileWorkoutV2({ workout: a.changed ? a.workout : workout, observations: obs });
  assert.equal(b.changed, false);
  assert.equal(b.reason, 'idempotent');
});

test('20. repeated replay is idempotent', () => {
  const samples = [
    ...series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02, motionSource: 'wrist_imu_51' }),
    ...series({ t0: T0 + 180_000, seconds: 10 * 60, bpm: 150, strapMotion: 0.22, motionSource: 'wrist_imu_51' }),
  ];
  const a = replayParity(samples);
  const b = replayParity(samples);
  assert.deepEqual(a, b);
});

test('21. checkpoint export/restore produces identical state', () => {
  const det = v2();
  feed(det, series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02, motionSource: 'wrist_imu_51' }));
  feed(det, series({
    t0: T0 + 180_000, seconds: 10 * 60, bpm: 150, strapMotion: 0.22, motionSource: 'wrist_imu_51',
  }));
  const cp = det.exportCheckpoint();
  const rec = parityRecord(det.snapshot());
  const other = v2();
  other.restore(cp);
  const rec2 = parityRecord(other.snapshot());
  assert.equal(rec2.detectorState, rec.detectorState);
  assert.equal(rec2.sport, rec.sport);
  assert.equal(rec2.lane, rec.lane);
  assert.equal(rec2.effectiveStartTs, rec.effectiveStartTs);
  assert.equal(other.snapshot().workoutId, det.snapshot().workoutId);
});

test('22. Swift/Node shared fixtures agree on a locked stream', () => {
  const samples = [
    ...series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02, motionSource: 'wrist_imu_51' }),
    ...series({ t0: T0 + 180_000, seconds: 10 * 60, bpm: 150, strapMotion: 0.22, motionSource: 'wrist_imu_51' }),
  ];
  const trace = replayParity(samples, { every: 1 });
  const confirmed = trace.find((r) => r.detectorState === 'CONFIRMED');
  assert.ok(confirmed);
  assert.deepEqual({
    detectorState: confirmed.detectorState,
    sport: confirmed.sport,
    activity: confirmed.activity,
    lane: confirmed.lane,
    modalityTier: confirmed.modalityTier,
    confirmPath: confirmed.confirmPath,
    evidenceScore: confirmed.evidenceScore,
    effectiveStartTs: confirmed.effectiveStartTs,
    confirmedTs: confirmed.confirmedTs,
    version: confirmed.version,
  }, {
    detectorState: 'CONFIRMED',
    sport: 'detected',
    activity: 'cardio',
    lane: 'cardio_rhythmic',
    modalityTier: 'B',
    confirmPath: 'standard',
    evidenceScore: 0.74,
    effectiveStartTs: T0 + 189_000,
    confirmedTs: T0 + 669_000,
    version: WORKOUT_DETECT_V2_VERSION,
  });
});

test('23. V2 shadow produces no canonical side effects', async () => {
  let clock = T0;
  const store = {
    prefs: { restingHr: 60, autoWorkoutHaptics: true, autoWorkoutDetectorVersion: '2.2.1-beta-shadow' },
    profile: { birthYear: 1996 },
    activities: [],
    bleLive: { connected: true },
  };
  const enqueued = [];
  const service = createWorkoutDetectionService({
    loadStore: () => store,
    saveStore: (s) => Object.assign(store, s),
    syncQueue: { enqueue: (op) => enqueued.push(op) },
    userId: '00000000-0000-4000-8000-000000000097',
    estimateCalories: () => 100,
    loadPersistedDays: async () => ({
      '2026-08-24': { physiological_summary: { 'Resting heart rate (bpm)': 60 } },
    }),
    now: () => clock,
  });
  const samples = [
    ...series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02, motionSource: 'wrist_imu_51' }),
    ...strengthSetRest({ t0: T0 + 180_000, minutes: 8, hr: 92 }),
  ];
  for (const s of samples) {
    clock = s.ts;
    service.ingest(s);
  }
  const snap = service.state();
  assert.equal(snap.algorithm, 'workout_detect_v1');
  assert.equal(snap.shadowDetector, 'v2');
  assert.equal(store.activities.length, 0);
  assert.equal(snap.buzz, false);
  assert.ok(!snap.workout || snap.workout.lifecycle !== 'ACTIVE');
});

test('phone-only set/rest does not confirm V2 strength', () => {
  const samples = [
    ...series({ t0: T0, seconds: 120, bpm: 70, phoneMotion: 0.02 }),
    ...phoneOnlySetRest({ t0: T0 + 120_000, minutes: 8, hr: 90 }),
  ];
  const ev = evaluateWindow({
    samples,
    start: T0 + 120_000,
    end: T0 + 120_000 + 8 * 60_000,
    restingHr: 60,
    maxHr: 174,
    padMin: 0,
  });
  assert.equal(ev.v2.hit, false);
});

test('phone-only cadence walk is not classified walking', () => {
  const ev = evaluateWindow({
    samples: walkCadence({ t0: T0, minutes: 8, hr: 96 }),
    start: T0, end: T0 + 8 * 60_000, restingHr: 60, maxHr: 174, padMin: 0,
  });
  if (ev.v2.hit) assert.equal(ev.v2.sport, 'detected');
  else assert.equal(ev.v2.hit, false);
});

test('missing modalities stay missing and never zero-fill strap', () => {
  const obs = normalizeObservation({ ts: T0, bpm: 80 });
  assert.equal(obs.strapMotion, null);
  assert.equal(obs.cadence, null);
  assert.equal(obs.wear, null);
  const feat = extractFeatures([obs], T0, phys());
  assert.equal(feat.strap.mean60, null);
  assert.equal(feat.cadence.mean, null);
  assert.equal(modalityTier(feat.coverage), 'D');
});

test('compact 5s motion features stay local (no 100 Hz arrays)', () => {
  const feat = compactMotionFeatures({ dyn: [0.02, 0.18, 0.03, 0.17, 0.02], gyroRms: [0.4, 1.1, 0.3] });
  assert.equal(feat.schema, '1.1.0');
  assert.ok(feat.accelRms > 0);
  assert.ok(feat.jerk > 0);
  assert.ok(feat.gyroRms > 0);
  assert.equal(feat.gyroAvailable, true);
  const accelOnly = compactMotionFeatures({ dyn: [0.02, 0.18, 0.03, 0.17, 0.02], gyroRms: [] });
  assert.equal(accelOnly.gyroAvailable, false);
  assert.equal(accelOnly.gyroRms, 0);
  const golden = compactMotionFeatures({ dyn: [0.1, 0.2, 0.1], gyroRms: [0.01, 0.02] });
  assert.ok(Math.abs(golden.accelRms - Math.sqrt(0.06 / 3)) < 1e-9);
});

test('isolated 5s exercise window does not confirm', () => {
  const det = v2();
  det.ingest({ ts: T0, bpm: 70, strapMotion: 0.02 });
  for (let i = 1; i <= 6; i += 1) {
    det.ingest({ ts: T0 + i * 1000, bpm: 95, strapMotion: 0.2, motionSource: 'wrist_imu_51' });
  }
  assert.notEqual(det.snapshot().detectorState, 'CONFIRMED');
});

test('hard negatives stay unconfirmed', () => {
  const cases = [
    ['stress', stressHr({ t0: T0, minutes: 12, hr: 132 })],
    ['desk', noisyDesk({ t0: T0, minutes: 10 })],
    ['driving', driving({ t0: T0, minutes: 15 })],
    ['sleep_wake', sleepWake({ t0: T0, minutes: 15 })],
    ['phone_strength', phoneOnlySetRest({ t0: T0, minutes: 8, hr: 90 })],
    ['stairs', stairs({ t0: T0, minutes: 3, hr: 118 })],
    ['chores', series({ t0: T0, seconds: 600, bpm: 82, phoneMotion: (i) => 0.05 + 0.03 * ((i % 12) / 12) })],
    ['carrying', series({ t0: T0, seconds: 480, bpm: 88, phoneMotion: 0.09 })],
    ['eating', series({ t0: T0, seconds: 600, bpm: 72, phoneMotion: 0.03 })],
    ['standing', series({ t0: T0, seconds: 900, bpm: 74, phoneMotion: 0.01 })],
    ['ordinary_walk', ordinaryWalk({ t0: T0, minutes: 12, hr: 88 })],
  ];
  for (const [name, samples] of cases) {
    const ev = evaluateWindow({
      samples, start: T0, end: T0 + samples.length * 1000, restingHr: 60, maxHr: 174, padMin: 0,
    });
    assert.equal(ev.v2.hit, false, `${name} must not auto-confirm (${ev.v2.failReason})`);
  }
});

test('empty bout is live_signal_gap for both detectors', () => {
  const ev = evaluateWindow({
    samples: series({ t0: T0, seconds: 30, bpm: 70, motion: 0.02 }),
    start: T0 + 3_600_000,
    end: T0 + 3_600_000 + 60_000,
    restingHr: 60,
    maxHr: 174,
    padMin: 0,
  });
  assert.equal(ev.v1.miss, 'live_signal_gap');
  assert.equal(ev.v2.miss, 'live_signal_gap');
  assert.equal(ev.v1.hit, false);
  assert.equal(ev.v2.hit, false);
});

test('V2 traces are bounded and versioned independently', () => {
  const det = v2();
  for (let i = 0; i < 400; i += 1) {
    det.ingest({ ts: T0 + i * 1000, bpm: 90, phoneMotion: 0.1 });
  }
  const exp = det.featureExport();
  assert.equal(exp.feature_schema_version, FEATURE_SCHEMA_VERSION);
  assert.equal(exp.detector_version, WORKOUT_DETECT_V2_VERSION);
  assert.ok(exp.windows.length <= 120);
  assert.ok(exp.transitions.length <= 80);
});

test('default service is V2 canonical; explicit 1.3.0 rolls back to V1', async () => {
  let clock = Date.now();
  const t0 = clock;
  const v2Store = {
    prefs: { restingHr: 60, autoWorkoutHaptics: true },
    profile: { birthYear: 1996 },
    activities: [],
    bleLive: { connected: true },
  };
  const v2 = createWorkoutDetectionService({
    loadStore: () => v2Store,
    saveStore: (s) => Object.assign(v2Store, s),
    syncQueue: { enqueue: () => {} },
    userId: '00000000-0000-4000-8000-000000000099',
    loadPersistedDays: async () => ({
      '2026-08-24': { physiological_summary: { 'Resting heart rate (bpm)': 60 } },
    }),
    now: () => clock,
  });
  for (let i = 0; i < 180; i += 1) {
    clock = t0 + i * 1000;
    v2.ingest({ ts: clock, bpm: 65, strapMotion: 0.02, motionSource: 'wrist_imu_51' });
  }
  for (let i = 0; i < 10 * 60; i += 1) {
    clock = t0 + 180_000 + i * 1000;
    v2.ingest({ ts: clock, bpm: 150, strapMotion: 0.22, motionSource: 'wrist_imu_51' });
  }
  const snap = v2.state();
  assert.equal(snap.algorithm, 'workout_detect_v2');
  assert.equal(snap.detectorMode, '2.2.1-beta');
  assert.equal(snap.shadowDetector, 'v1');
  assert.equal(snap.detectorState, 'CONFIRMED');
  assert.ok(snap.pipeline.canonical_session_created >= 1);

  const v1Store = {
    prefs: { restingHr: 60, autoWorkoutHaptics: true, autoWorkoutDetectorVersion: '1.3.0' },
    profile: { birthYear: 1996 },
    activities: [],
    bleLive: { connected: true },
  };
  clock = t0;
  const v1 = createWorkoutDetectionService({
    loadStore: () => v1Store,
    saveStore: (s) => Object.assign(v1Store, s),
    syncQueue: { enqueue: () => {} },
    userId: '00000000-0000-4000-8000-000000000096',
    loadPersistedDays: async () => ({
      '2026-08-24': { physiological_summary: { 'Resting heart rate (bpm)': 60 } },
    }),
    now: () => clock,
  });
  for (let i = 0; i < 300; i += 1) {
    clock = t0 + i * 1000;
    v1.ingest({ ts: clock, bpm: 65, motion: 0.05 });
  }
  for (let i = 0; i < 200; i += 1) {
    clock = t0 + 300_000 + i * 1000;
    v1.ingest({ ts: clock, bpm: 140, motion: 0.3 });
  }
  const v1Snap = v1.state();
  assert.equal(v1Snap.algorithm, 'workout_detect_v1');
  assert.equal(v1Snap.detectorMode, '1.3.0');
  assert.equal(v1Snap.shadowDetector, 'v2');
  assert.equal(v1Snap.detectorState, 'CONFIRMED');
});

test('V2 canonical persists workout_detect_v2', async () => {
  let clock = T0;
  const store = {
    prefs: { restingHr: 60, autoWorkoutHaptics: true, autoWorkoutDetectorVersion: '2.0.0' },
    profile: { birthYear: 1996 },
    activities: [],
    bleLive: { connected: true },
  };
  const enqueued = [];
  const service = createWorkoutDetectionService({
    loadStore: () => store,
    saveStore: (s) => Object.assign(store, s),
    syncQueue: { enqueue: (op) => enqueued.push(op) },
    userId: '00000000-0000-4000-8000-000000000098',
    estimateCalories: () => 100,
    loadPersistedDays: async () => ({
      '2026-08-24': { physiological_summary: { 'Resting heart rate (bpm)': 60 } },
    }),
    now: () => clock,
  });
  const samples = [
    ...series({ t0: T0, seconds: 180, bpm: 70, strapMotion: 0.02, motionSource: 'wrist_imu_51' }),
    ...strapWalk({ t0: T0 + 180_000, minutes: 8, hr: 110 }),
    ...series({
      t0: T0 + 180_000 + 8 * 60_000, seconds: 6 * 60, bpm: 62, strapMotion: 0.02, motionSource: 'wrist_imu_51',
    }),
  ];
  for (const s of samples) {
    clock = s.ts;
    service.ingest(s);
  }
  const autos = store.activities.filter((a) => a.source === 'auto');
  assert.equal(autos.length, 1);
  const run = enqueued.find((op) => op.payload?.metric_runs)?.payload.metric_runs[0];
  assert.equal(run.algorithm, 'workout_detect_v2');
  assert.equal(run.version, WORKOUT_DETECT_V2_VERSION);
});

test('native vs backend compare records divergence', () => {
  const cmp = compareNativeBackend(
    { detectorState: 'CONFIRMED', sport: 'walking', activity: 'walking', confidenceTier: 'confirmed', onsetTs: T0, lastSampleTs: T0 },
    { detectorState: 'IDLE', sport: 'detected', activity: 'unknown', confidenceTier: null, onsetTs: T0 + 20_000, lastSampleTs: T0 + 30_000 },
  );
  assert.equal(cmp.disagree, true);
  assert.equal(cmp.fields.detectorState.agree, false);
});

test('correction events are immutable and do not clobber predictions', () => {
  const row = createCorrectionEvent({
    workoutId: 'w1',
    detectorVersion: WORKOUT_DETECT_V2_VERSION,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    predictedStart: T0,
    predictedEnd: T0 + 600_000,
    predictedType: 'strength',
    userStart: T0 + 10_000,
    userType: 'walking',
    action: 'edited',
    featureObjectRef: 'v2-1',
  });
  assert.equal(row.predicted_type, 'strength');
  assert.equal(row.user_type, 'walking');
  assert.equal(row.action, 'edited');
  assert.throws(() => { row.predicted_type = 'walking'; });
});

test('event-level report and LOSO do not split a session', () => {
  assert.ok(HARD_NEGATIVE_IDS.includes('w5_neg'));
  const labeled = [{ id: 'a', start: T0, end: T0 + 600_000, sport: 'strength' }];
  const detections = [{ onsetTs: T0 + 20_000, confirmedTs: T0 + 80_000, endTs: T0 + 580_000, sport: 'strength' }];
  const report = eventLevelReport({
    labeled,
    detections,
    corpusStart: T0 - 3600_000,
    corpusEnd: T0 + 7200_000,
  });
  assert.equal(report.tp, 1);
  assert.equal(report.fn, 0);
  assert.equal(report.fp, 0);
  const folds = losoFolds([
    { participantId: 'p1', sessionId: 's1', id: 1 },
    { participantId: 'p1', sessionId: 's2', id: 2 },
  ]);
  assert.equal(folds.length, 2);
  assert.equal(folds[0].test.length, 1);
  assert.equal(folds[0].train.length, 1);
});

test('packet-51 analyzer marks empty capture unsupported', () => {
  const empty = analyzeLive51Frames([]);
  assert.equal(empty.packet51_unsupported, true);
  assert.ok(WRIST51_SCRIPT.length >= 5);
  const probe = analyzeType43Probe({ frames: 10, bytes: 20000, seconds: 10, type40: 8, batteryStart: 60, batteryEnd: 59 });
  assert.equal(probe.disarmed, true);
  assert.equal(probe.packet_cadence_hz, 1);
  assert.equal(probe.battery_delta, -1);
});

test('synthetic puffin live51-shaped buffer decodes or stays raw', () => {
  const bytes = puffinRT(1, 1_782_000_000, 0, 80, 0);
  const report = analyzeLive51Frames([{ hex: Buffer.from(bytes).toString('hex'), t: Date.now() / 1000 }]);
  assert.equal(report.frames, 1);
});

test('HISTORY_COMPLETE reconcile does not mint a second workout id', () => {
  const det = v2();
  feed(det, series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02, motionSource: 'wrist_imu_51' }));
  feed(det, series({ t0: T0 + 180_000, seconds: 10 * 60, bpm: 150, strapMotion: 0.22, motionSource: 'wrist_imu_51' }));
  feed(det, series({ t0: T0 + 180_000 + 10 * 60_000, seconds: 5 * 60, bpm: 70, strapMotion: 0.02 }));
  const finished = det.lastFinished();
  assert.ok(finished);
  const id = finished.workoutId || finished.id;
  det.ingestHistorical({
    ts: T0 + 170_000, bpm: 90, strapMotion: 0.15, origin: 'historical', historical: true, src: 'v18',
  });
  const rec = det.reconcile({ ...finished, id: id || 'wid' });
  if (rec.changed) assert.equal(rec.workout.id, id || 'wid');
  const rec2 = det.reconcile(rec.changed ? rec.workout : { ...finished, id: id || 'wid' });
  assert.equal(rec2.changed, false);
});

test('detectExercise does not use phone motion as wrist proof', () => {
  const samples = series({ t0: T0, seconds: 90, bpm: 100, phoneMotion: 0.4 });
  const feat = extractFeatures(ringOf(samples), T0 + 89_000, phys());
  const bout = detectExercise(feat, phys());
  assert.equal(feat.coverage.strapMotion, false);
  assert.ok(bout.lane !== 'strength_candidate');
  assert.ok(bout.lane !== 'ambulatory');
});
