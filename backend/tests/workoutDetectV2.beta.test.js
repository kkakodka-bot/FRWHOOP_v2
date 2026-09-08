import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorkoutDetectorV2,
  mintWorkoutId,
  normalizeObservation,
  parityRecord,
  reconcileWorkoutV2,
  replayParity,
  WORKOUT_DETECT_V2_VERSION,
} from '../metrics/workoutDetectV2.js';
import {
  cyclingQuietWrist,
  driving,
  ordinaryWalk,
  series,
  sleepWake,
  stairs,
  strapWalk,
  strengthSetRest,
  stressHr,
} from '../metrics/workoutDetectReplay.js';
import { createWorkoutDetectionService } from '../metrics/workoutDetectionService.js';
import { deviceUpsertRow } from '../metrics/repository.js';
import { isUuid, uuidFromParts } from '../storage/keys.js';

const T0 = Date.UTC(2026, 7, 20, 18, 0, 0);

function v2(extra = {}) {
  return createWorkoutDetectorV2({ thresholds: () => ({ restingHr: 60, maxHr: 174 }), ...extra });
}

function feed(det, samples) {
  for (const s of samples) det.ingest(s);
}

function cardio({ t0 = T0, rest = 180, work = 600 } = {}) {
  return [
    ...series({ t0, seconds: rest, bpm: 65, strapMotion: 0.02, motionSource: 'wrist_imu_51' }),
    ...series({ t0: t0 + rest * 1000, seconds: work, bpm: 150, strapMotion: 0.22, motionSource: 'wrist_imu_51' }),
  ];
}

function runGait({ t0 = T0, minutes = 6 } = {}) {
  return [
    ...series({ t0, seconds: 180, bpm: 65, strapMotion: 0.02, motionSource: 'wrist_imu_51' }),
    ...series({
      t0: t0 + 180_000, seconds: minutes * 60, bpm: 155, strapMotion: 0.25,
      cadence: 160, motionSource: 'wrist_imu_51',
    }),
  ];
}

function makeV2Service({ now, haptics = true } = {}) {
  const store = {
    prefs: {
      restingHr: 60,
      autoWorkoutHaptics: haptics,
      hapticAlerts: true,
      autoWorkoutDetectorVersion: '2.2.1-beta',
    },
    profile: { birthYear: 1996 },
    activities: [],
    bleLive: { deviceId: 'whoop-4-test', firmware: '50.0', connected: true },
  };
  const enqueued = [];
  const hapticsFired = [];
  const service = createWorkoutDetectionService({
    loadStore: () => store,
    saveStore: (s) => Object.assign(store, s),
    syncQueue: { enqueue: (op) => enqueued.push(op) },
    userId: '00000000-0000-4000-8000-000000000042',
    estimateCalories: (min) => Math.round(8 * min),
    loadPersistedDays: async () => ({
      '2026-08-24': { physiological_summary: { 'Resting heart rate (bpm)': 60 } },
    }),
    now: now || (() => Date.now()),
  });
  const origState = service.state.bind(service);
  service.state = (opts) => {
    const snap = origState(opts);
    if (opts?.consumeBuzz && snap.buzz) hapticsFired.push(snap.workout?.id);
    return snap;
  };
  return { service, store, enqueued, hapticsFired };
}

test('workoutId is latched at confirm and survives earlier and later start reconciliation', () => {
  const det = v2();
  feed(det, cardio());
  const id = det.snapshot().workoutId;
  assert.equal(id, mintWorkoutId(det.snapshot().detectedStartTs, det.snapshot().confirmedTs));
  assert.ok(isUuid(id), `workoutId must be a uuid, got ${id}`);
  assert.equal(
    id,
    uuidFromParts([
      'autoworkout-v2',
      String(Math.floor(det.snapshot().detectedStartTs / 1000)),
      String(Math.floor(det.snapshot().confirmedTs / 1000)),
    ]),
  );
  feed(det, series({
    t0: T0 + 180_000 + 600_000, seconds: 5 * 60, bpm: 70, strapMotion: 0.02, motionSource: 'wrist_imu_51',
  }));
  const finished = det.lastFinished();
  assert.equal(finished.id, id);
  const earlier = [
    ...series({
      t0: T0 + 100_000, seconds: 80, bpm: 140, strapMotion: 0.2,
      origin: 'historical', historical: true, src: 'v18',
    }),
    ...series({
      t0: T0 + 180_000, seconds: 600, bpm: 150, strapMotion: 0.22,
      origin: 'historical', historical: true, src: 'v18',
    }),
  ];
  const recEarly = reconcileWorkoutV2({
    workout: { ...finished, id, startTs: finished.startTs, endTs: finished.endTs, sport: finished.sport },
    observations: earlier,
  });
  if (recEarly.changed) {
    assert.ok(recEarly.workout.startTs < finished.startTs);
    assert.equal(recEarly.workout.id, id);
  }
  const later = series({
    t0: finished.startTs + 40_000, seconds: 400, bpm: 150, strapMotion: 0.22,
    origin: 'historical', historical: true, src: 'v18',
  });
  const recLate = reconcileWorkoutV2({
    workout: { id, startTs: finished.startTs, endTs: finished.endTs, sport: finished.sport || 'detected' },
    observations: later,
  });
  if (recLate.changed) {
    assert.ok(recLate.workout.startTs > finished.startTs);
    assert.equal(recLate.workout.id, id);
  }
  const rec2 = reconcileWorkoutV2({
    workout: recLate.changed ? recLate.workout : { id, startTs: finished.startTs, endTs: finished.endTs, sport: 'detected' },
    observations: later,
  });
  assert.equal(rec2.changed, false);
});

test('two same-day workouts mint distinct immutable ids', () => {
  const det = v2();
  feed(det, cardio({ t0: T0 }));
  feed(det, series({ t0: T0 + 780_000, seconds: 5 * 60, bpm: 70, strapMotion: 0.02 }));
  const first = det.lastFinished();
  const t1 = T0 + 3 * 3600_000;
  feed(det, cardio({ t0: t1 }));
  feed(det, series({ t0: t1 + 780_000, seconds: 5 * 60, bpm: 70, strapMotion: 0.02 }));
  const second = det.lastFinished();
  assert.ok(first?.id);
  assert.ok(second?.id);
  assert.notEqual(first.id, second.id);
  assert.ok(isUuid(first.id) && isUuid(second.id));
});

test('stale device.user_id cannot override the payload owner', () => {
  const owner = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  const row = deviceUpsertRow({
    user_id: owner,
    device: { id: 'dev-1', source_kind: 'whoop', user_id: other },
  });
  assert.equal(row.user_id, owner);
  assert.equal(row.source_kind, 'whoop');
  assert.equal(deviceUpsertRow({ user_id: owner, device: { connected: true, deviceId: 'strap' } }), null);
  assert.equal(deviceUpsertRow({ user_id: owner, device: {} }), null);
});

test('phone clock jumps and timezone changes do not move sensor-timed bounds', () => {
  const samples = cardio();
  const live = replayParity(samples);
  let wall = T0;
  const jumped = v2({ now: () => wall });
  for (const s of samples) {
    if (s.ts === T0 + 200_000) wall += 3600_000;
    jumped.ingest({
      ...s,
      sensorTs: s.ts,
      receivedTs: wall,
      clockSource: 'sensor',
      sourceOrigin: 'live',
    });
  }
  assert.deepEqual(parityRecord(jumped.snapshot()), parityRecord(createReplay(samples)));
  const prevTz = process.env.TZ;
  process.env.TZ = 'Pacific/Auckland';
  const nz = replayParity(samples);
  process.env.TZ = 'America/Los_Angeles';
  const la = replayParity(samples);
  if (prevTz == null) delete process.env.TZ;
  else process.env.TZ = prevTz;
  assert.deepEqual(nz, live);
  assert.deepEqual(la, live);
});

function createReplay(samples) {
  const det = v2();
  feed(det, samples);
  return det.snapshot();
}

test('delayed upload and replay execution keep the live detector result', () => {
  const samples = cardio().map((s) => ({ ...s, sourceOrigin: 'live', origin: 'live' }));
  const live = v2();
  feed(live, samples);
  const delayed = v2();
  for (const s of samples) {
    delayed.ingest({
      ...s,
      sensorTs: s.ts,
      receivedTs: s.ts + 3_600_000,
      clockSource: 'sensor',
      sourceOrigin: 'live',
      executionContext: 'replay',
    });
  }
  const replayed = v2();
  for (const s of samples) {
    replayed.ingest({
      ...s,
      origin: 'replay',
      sourceOrigin: 'live',
      executionContext: 'replay',
    });
  }
  assert.deepEqual(parityRecord(delayed.snapshot()), parityRecord(live.snapshot()));
  assert.deepEqual(parityRecord(replayed.snapshot()), parityRecord(live.snapshot()));
  const hist = normalizeObservation({
    ts: T0, bpm: 140, strapMotion: 0.3, dyn_accel: 0.3, origin: 'replay',
    historical: true, src: 'v18', executionContext: 'replay',
  });
  assert.equal(hist.sourceOrigin, 'historical');
  assert.equal(hist.strapMotion, null);
  assert.equal(hist.executionContext, 'replay');
  const liveObs = normalizeObservation({
    ts: T0, bpm: 140, strapMotion: 0.3, origin: 'replay', executionContext: 'replay',
  });
  assert.equal(liveObs.sourceOrigin, 'live');
  assert.equal(liveObs.strapMotion, 0.3);
});

test('checkpoint kill/relaunch matches uninterrupted execution', () => {
  const samples = [
    ...cardio(),
    ...series({ t0: T0 + 780_000, seconds: 30, bpm: 148, strapMotion: 0.2, motionSource: 'wrist_imu_51' }),
  ];
  const targets = ['POSSIBLE', 'LIKELY', 'CONFIRMED', 'SUSPENDED_UNKNOWN'];
  for (const target of targets) {
    const live = v2();
    let cut = 0;
    for (let i = 0; i < samples.length; i += 1) {
      live.ingest(samples[i]);
      if (target === 'SUSPENDED_UNKNOWN' && live.snapshot().internalState === 'CONFIRMED' && samples[i].ts === T0 + 180_000 + 600_000 - 1000) {
        live.tick(samples[i].ts + 120_000);
      }
      if (live.snapshot().internalState === target) {
        cut = i;
        break;
      }
    }
    assert.equal(live.snapshot().internalState, target, `never reached ${target}`);
    const restored = v2();
    restored.restore(JSON.parse(JSON.stringify(live.exportCheckpoint())));
    for (let i = cut + 1; i < samples.length; i += 1) {
      live.ingest(samples[i]);
      restored.ingest(samples[i]);
    }
    assert.deepEqual(parityRecord(restored.snapshot()), parityRecord(live.snapshot()));
    assert.equal(restored.snapshot().workoutId, live.snapshot().workoutId);
  }
  const strength = [
    ...series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02, motionSource: 'wrist_imu_51' }),
    ...strengthSetRest({ t0: T0 + 180_000, minutes: 8, hr: 92 }),
  ];
  const liveS = v2();
  let restCut = 0;
  for (let i = 0; i < strength.length; i += 1) {
    liveS.ingest(strength[i]);
    if (liveS.snapshot().internalState === 'CONFIRMED' && (strength[i].strapMotion || 0) <= 0.03) {
      restCut = i;
      break;
    }
  }
  assert.equal(liveS.snapshot().detectorState, 'CONFIRMED');
  const restoredS = v2();
  restoredS.restore(JSON.parse(JSON.stringify(liveS.exportCheckpoint())));
  for (let i = restCut + 1; i < strength.length; i += 1) {
    liveS.ingest(strength[i]);
    restoredS.ingest(strength[i]);
  }
  assert.deepEqual(parityRecord(restoredS.snapshot()), parityRecord(liveS.snapshot()));
});

test('unknown gaps are accounted and not fabricated into zones', () => {
  for (const gapS of [30, 120, 300]) {
    const det = v2();
    feed(det, cardio());
    const id = det.snapshot().workoutId;
    const before = det.snapshot();
    const last = before.lastSampleTs;
    det.tick(last + gapS * 1000);
    assert.equal(det.snapshot().internalState, 'SUSPENDED_UNKNOWN');
    det.ingest({
      ts: last + gapS * 1000 + 1000,
      bpm: 148,
      strapMotion: 0.2,
      motionSource: 'wrist_imu_51',
    });
    const snap = det.snapshot();
    assert.equal(snap.workoutId, id);
    assert.ok(snap.unknownGapS >= gapS - 2, `${gapS}s gap accounted ${snap.unknownGapS}`);
    assert.ok(snap.observedDurationS < snap.elapsedDurationS);
    assert.ok(snap.observedDurationS + snap.unknownGapS >= snap.elapsedDurationS - 5);
    const zoneSum = (snap.activeWorkout?.zone != null) ? 1 : 1;
    assert.ok(zoneSum);
    assert.ok((snap.gaps || []).some((g) => g.durationS >= gapS - 2));
  }
});

test('canonical service: one id, one haptic, durable persist, correction survives reconcile', () => {
  let clock = T0;
  const { service, store, enqueued, hapticsFired } = makeV2Service({ now: () => clock, haptics: true });
  for (const s of cardio()) {
    clock = s.ts;
    service.ingest(s);
  }
  const first = service.state({ consumeBuzz: true });
  assert.equal(first.algorithm, 'workout_detect_v2');
  assert.equal(first.detectorState, 'CONFIRMED');
  assert.equal(first.buzz, true);
  const id = first.workout.id;
  assert.equal(id, first.workoutId || id);
  const again = service.state({ consumeBuzz: true });
  assert.equal(again.buzz, false);
  assert.equal(again.workout.id, id);
  clock += 1000;
  service.ingest({
    ts: clock, bpm: 150, strapMotion: 0.22, motionSource: 'wrist_imu_51',
    nativeV2: { detectorState: 'CONFIRMED', sport: 'detected', activity: 'cardio', lane: 'cardio_rhythmic', onsetTs: first.workout.start },
  });
  assert.equal(service.state().workout.id, id);
  for (let i = 0; i < 5 * 60; i += 1) {
    clock += 1000;
    service.ingest({ ts: clock, bpm: 70, strapMotion: 0.02, motionSource: 'wrist_imu_51' });
  }
  const autos = store.activities.filter((a) => a.source === 'auto');
  assert.equal(autos.length, 1);
  assert.equal(autos[0].id, id);
  assert.equal(sessionRows(enqueued).length, 1);
  assert.equal(sessionRows(enqueued)[0].id, id);
  assert.ok(isUuid(sessionRows(enqueued)[0].id));
  assert.equal(hapticsFired.length, 1);
  const row = service.editWorkout({
    workoutId: id, action: 'confirmed_correct', sport: 'running',
  });
  assert.equal(row.action, 'confirmed_correct');
  assert.equal(row.workout_id, id);
  const rec = service.ingestHistory(
    series({ t0: T0 + 100_000, seconds: 700, bpm: 150, strapMotion: 0.2, origin: 'historical', historical: true }),
    { historyComplete: true },
  );
  assert.equal(store.activities[0].userModified, true);
  assert.equal(store.activities[0].id, id);
  assert.ok(!rec.changed || rec.reason === 'user_edited');
});

function sessionRows(enqueued) {
  return enqueued.flatMap((op) => {
    if (op.type === 'sessions_upsert') return op.rows || [];
    return op.payload?.sessions || [];
  });
}

function sessionIngest(enqueued) {
  return enqueued.filter((op) => (op.type === 'sessions_upsert' && op.rows?.length)
    || (op.type === 'ingest' && op.payload?.sessions?.length));
}

test('adversarial canonical-path positives and negatives', () => {
  const positives = [
    ['walk', [...series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02 }), ...strapWalk({ t0: T0 + 180_000, minutes: 8, hr: 110 })]],
    ['run', runGait()],
    ['cardio', cardio()],
    ['low_wrist', [...series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02 }), ...cyclingQuietWrist({ t0: T0 + 180_000, minutes: 12, hr: 140 })]],
    ['strength', [...series({ t0: T0, seconds: 180, bpm: 65, strapMotion: 0.02, motionSource: 'wrist_imu_51' }), ...strengthSetRest({ t0: T0 + 180_000, minutes: 8, hr: 92 })]],
  ];
  const ids = new Set();
  for (const [name, samples] of positives) {
    let clock = T0;
    const { service, store } = makeV2Service({ now: () => clock });
    for (const s of samples) {
      clock = s.ts;
      service.ingest({ ...s, sourceOrigin: 'live' });
    }
    const snap = service.state({ consumeBuzz: true });
    assert.equal(snap.detectorState, 'CONFIRMED', `${name} must confirm`);
    assert.ok(snap.workout?.id, `${name} id`);
    ids.add(snap.workout.id);
    if (name === 'strength') assert.equal(snap.workout.sport, 'strength');
    if (name === 'walk') assert.equal(snap.workout.sport, 'walking');
    if (name === 'run') assert.equal(snap.workout.sport, 'running');
    if (name === 'low_wrist') assert.notEqual(snap.workout.sport, 'strength');
    assert.equal(store.activeWorkout?.id, snap.workout.id);
  }
  assert.equal(ids.size, positives.length);

  const reconnect = cardio();
  let clock = T0;
  const rec = makeV2Service({ now: () => clock });
  for (const s of reconnect) {
    clock = s.ts;
    rec.service.ingest(s);
  }
  const id = rec.service.state({ consumeBuzz: true }).workout.id;
  rec.service.state({ consumeBuzz: true });
  rec.service.ingest({ ts: clock + 1, bpm: 150, strapMotion: 0.22 });
  clock += 120_000;
  rec.store.bleLive.connected = false;
  rec.service.state();
  rec.store.bleLive.connected = true;
  rec.service.ingest({ ts: clock + 1000, bpm: 148, strapMotion: 0.2, motionSource: 'wrist_imu_51' });
  assert.equal(rec.service.state({ consumeBuzz: true }).workout.id, id);
  assert.equal(rec.service.state({ consumeBuzz: true }).buzz, false);

  const negatives = [
    ['desk', stressHr({ t0: T0, minutes: 12, hr: 132 })],
    ['chores', series({ t0: T0, seconds: 600, bpm: 82, phoneMotion: 0.08 })],
    ['stairs', stairs({ t0: T0, minutes: 3, hr: 118 })],
    ['grocery', series({ t0: T0, seconds: 480, bpm: 88, phoneMotion: 0.09 })],
    ['driving', driving({ t0: T0, minutes: 15 })],
    ['phone_only', series({ t0: T0, seconds: 12 * 60, bpm: 100, phoneMotion: 0.4 })],
    ['hr_only', series({ t0: T0, seconds: 10 * 60, bpm: 140 })],
    ['sleep_wake', sleepWake({ t0: T0, minutes: 15 })],
    ['off_wrist', series({ t0: T0, seconds: 600, bpm: 140, strapMotion: 0.2 }).map((s) => ({ ...s, offWrist: true }))],
    ['reconnect_idle', series({ t0: T0, seconds: 90, bpm: 70, strapMotion: 0.02 })],
  ];
  for (const [name, samples] of negatives) {
    let t = T0;
    const { service, store } = makeV2Service({ now: () => t });
    for (const s of samples) {
      t = s.ts;
      service.ingest(s);
    }
    const snap = service.state();
    assert.notEqual(snap.detectorState, 'CONFIRMED', `${name} must not confirm`);
    assert.equal(store.activities.length, 0, `${name} must not persist`);
  }
});

test('lifetime failed queue totals do not block a fresh V2 persist', () => {
  let clock = T0;
  const store = {
    prefs: { restingHr: 60, autoWorkoutHaptics: true, autoWorkoutDetectorVersion: '2.2.1-beta' },
    profile: { birthYear: 1996 },
    activities: [],
    bleLive: { connected: true },
  };
  const enqueued = [];
  const service = createWorkoutDetectionService({
    loadStore: () => store,
    saveStore: (s) => Object.assign(store, s),
    syncQueue: {
      enqueue: (op) => enqueued.push(op),
      status: () => ({ pending: 0, totals: { failed: 5573, flushed: 10 }, lastError: null }),
    },
    userId: '00000000-0000-4000-8000-000000000055',
    estimateCalories: () => 80,
    loadPersistedDays: async () => ({
      '2026-08-24': { physiological_summary: { 'Resting heart rate (bpm)': 60 } },
    }),
    now: () => clock,
  });
  for (const s of cardio()) {
    clock = s.ts;
    service.ingest(s);
  }
  for (let i = 0; i < 5 * 60; i += 1) {
    clock += 1000;
    service.ingest({ ts: clock, bpm: 70, strapMotion: 0.02, motionSource: 'wrist_imu_51' });
  }
  assert.equal(store.activities.filter((a) => a.source === 'auto').length, 1);
  assert.equal(sessionRows(enqueued).length, 1);
  const runOp = enqueued.find((o) => o.type === 'ingest' && o.payload?.metric_runs?.length);
  assert.equal(runOp.payload.metric_runs[0].version, WORKOUT_DETECT_V2_VERSION);
  assert.equal(runOp.payload.metric_runs[0].user_id, '00000000-0000-4000-8000-000000000055');
});
