import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkoutDetectionService } from '../metrics/workoutDetectionService.js';
import { sessionsFromStore } from '../persistence/domainMap.js';

const T0 = Date.now();
const USER = '00000000-0000-4000-8000-000000000001';

function makeService({
  prefs,
  profile = { birthYear: 1996 },
  activities = [],
  extraStore = {},
  now,
} = {}) {
  const store = {
    prefs: prefs
      ? { autoWorkoutDetectorVersion: '1.3.0', ...prefs }
      : { restingHr: 60, autoWorkoutHaptics: true, autoWorkoutDetectorVersion: '1.3.0' },
    profile,
    activities,
    bleLive: { deviceId: 'whoop-4-test', firmware: '50.0', connected: true },
    ...extraStore,
  };
  const enqueued = [];
  const service = createWorkoutDetectionService({
    loadStore: () => store,
    saveStore: (s) => { Object.assign(store, s); return s; },
    syncQueue: { enqueue: (op) => enqueued.push(op) },
    userId: USER,
    estimateCalories: (min) => Math.round(5 * 3.5 * 70 / 200 * min),
    loadPersistedDays: async () => ({
      '2026-08-24': { physiological_summary: { 'Resting heart rate (bpm)': 60 } },
    }),
    now: now || (() => Date.now()),
  });
  return { service, store, enqueued };
}

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

function feedWorkout(service, { holdMin = 20, motion = 0.3 } = {}) {
  const push = (ts, bpm, seconds, m = motion) => {
    for (let i = 0; i < seconds; i += 1) service.ingest({ ts: ts + i * 1000, bpm, motion: m });
  };
  push(T0, 65, 300, 0.05);
  push(T0 + 300_000, 140, holdMin * 60);
  push(T0 + 300_000 + holdMin * 60_000, 70, 5 * 60, 0.05);
}

test('a confirmed bout lands as a local activity and a queued cloud session', async () => {
  const { service, store, enqueued } = makeService();
  feedWorkout(service);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(store.activities.length, 1);
  const a = store.activities[0];
  assert.equal(a.source, 'auto');
  assert.equal(a.autoDetected, true);
  assert.equal(a.userId, USER);
  assert.equal(a.name, 'Detected Workout');
  assert.match(a.id, /^[0-9a-f-]{36}$/);
  assert.equal(a.date, [
    new Date(T0 + 300_000).getFullYear(),
    String(new Date(T0 + 300_000).getMonth() + 1).padStart(2, '0'),
    String(new Date(T0 + 300_000).getDate()).padStart(2, '0'),
  ].join('-'));
  assert.ok(a.durationMin >= 19 && a.durationMin <= 21, `durationMin ${a.durationMin}`);
  assert.equal(a.maxHr, 140);
  assert.ok(a.avgHr >= 135);
  assert.ok(a.strain > 0);
  assert.ok(Array.isArray(a.zones) && a.zones.length === 5);

  const rows = sessionRows(enqueued);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'workout');
  assert.equal(rows[0].source, 'auto-detect');
  assert.equal(rows[0].summary.avg_hr, a.avgHr);
  const runOp = enqueued.find((o) => o.type === 'ingest' && o.payload?.metric_runs?.length);
  assert.equal(runOp.payload.metric_runs[0].algorithm, 'workout_detect_v1');
  assert.equal(store.liveDetectedWorkout, undefined);
  assert.ok(store.workoutEvents.some((e) => e.event_type === 'workout_confirmed'));
  assert.ok(store.workoutEvents.some((e) => e.event_type === 'workout_persisted'));
});

test('the store mapper and the detector label the same cloud session identically', async () => {
  const { service, store, enqueued } = makeService();
  feedWorkout(service);
  await new Promise((r) => setTimeout(r, 10));

  const fromDetector = sessionRows(enqueued)[0];
  const fromStore = sessionsFromStore(store, USER).find((s) => s.id === fromDetector.id);
  assert.ok(fromStore, 'the detected activity must map to a cloud session');
  // Both upsert the same row id; disagreement here relabels an auto workout as manual.
  assert.equal(fromStore.kind, fromDetector.kind);
  assert.equal(fromStore.source, fromDetector.source);
  assert.equal(fromStore.external_id, fromDetector.external_id);
});

test('a hand-logged activity still maps to a manual cloud session', () => {
  const rows = sessionsFromStore({
    activities: [{
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Weightlifting',
      start: new Date(T0).toISOString(),
      end: new Date(T0 + 1_500_000).toISOString(),
      source: 'user',
    }],
  }, USER);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'manual_workout');
  assert.equal(rows[0].source, 'user');
  assert.equal(rows[0].summary.name, 'Weightlifting');
});

test('canonical session is the authority after confirm', () => {
  const { service, store } = makeService();
  for (let i = 0; i < 300; i += 1) service.ingest({ ts: T0 + i * 1000, bpm: 65, motion: 0.05 });
  for (let i = 0; i < 200; i += 1) service.ingest({ ts: T0 + 300_000 + i * 1000, bpm: 140, motion: 0.3 });
  const snap = service.state();
  assert.equal(snap.detectorState, 'CONFIRMED');
  assert.equal(snap.workout.lifecycle, 'ACTIVE');
  assert.equal(snap.workout.id, store.activeWorkout.id);
  assert.equal(snap.live.id, store.activeWorkout.id);
  assert.equal(snap.workout.confirmationPath, 'high_confidence');
  assert.ok(snap.enabled);
});

test('shadow mode records the workout but does not buzz', () => {
  const { service } = makeService({ prefs: { restingHr: 60, autoWorkoutHaptics: false } });
  for (let i = 0; i < 300; i += 1) service.ingest({ ts: T0 + i * 1000, bpm: 65, motion: 0.05 });
  for (let i = 0; i < 200; i += 1) service.ingest({ ts: T0 + 300_000 + i * 1000, bpm: 140, motion: 0.3 });
  const first = service.state({ consumeBuzz: true });
  assert.equal(first.detectorState, 'CONFIRMED');
  assert.equal(first.buzz, false);
  assert.equal(first.shadow, true);
  assert.equal(first.workout.lifecycle, 'ACTIVE');
});

test('haptic alerts off blocks buzz even when the auto-workout flag is on', () => {
  const { service } = makeService({ prefs: { restingHr: 60, autoWorkoutHaptics: true, hapticAlerts: false } });
  for (let i = 0; i < 300; i += 1) service.ingest({ ts: T0 + i * 1000, bpm: 65, motion: 0.05 });
  for (let i = 0; i < 200; i += 1) service.ingest({ ts: T0 + 300_000 + i * 1000, bpm: 140, motion: 0.3 });
  const first = service.state({ consumeBuzz: true });
  assert.equal(first.detectorState, 'CONFIRMED');
  assert.equal(first.buzz, false);
});

test('dismiss cancels the bout and clears the marker', () => {
  const { service, store } = makeService();
  for (let i = 0; i < 300; i += 1) service.ingest({ ts: T0 + i * 1000, bpm: 65, motion: 0.05 });
  for (let i = 0; i < 200; i += 1) service.ingest({ ts: T0 + 300_000 + i * 1000, bpm: 140, motion: 0.3 });
  const snap = service.dismiss();
  assert.equal(snap.detectorState, 'IDLE');
  assert.equal(store.liveDetectedWorkout, undefined);
  assert.equal(store.activities.length, 0);
  assert.ok(store.workoutEvents.some((e) => e.event_type === 'workout_dismissed'));
});

test('autoWorkoutDetect=false disables detection entirely', () => {
  const { service, store, enqueued } = makeService({ prefs: { autoWorkoutDetect: false, restingHr: 60 } });
  feedWorkout(service);
  assert.equal(store.activities.length, 0);
  assert.equal(enqueued.length, 0);
  assert.equal(service.state().enabled, false);
});

test('an overlapping manual activity is not double-logged locally or in the outbox', () => {
  const start = new Date(T0 + 310_000);
  const date = [
    start.getFullYear(),
    String(start.getMonth() + 1).padStart(2, '0'),
    String(start.getDate()).padStart(2, '0'),
  ].join('-');
  const existing = {
    id: 'manual-1',
    date,
    name: 'Run',
    start: start.toISOString(),
    end: new Date(T0 + 1500_000).toISOString(),
    source: 'user',
  };
  const { service, store, enqueued } = makeService({ activities: [existing] });
  feedWorkout(service);
  assert.equal(store.activities.length, 1);
  assert.equal(store.activities[0].id, 'manual-1');
  assert.equal(sessionIngest(enqueued).length, 0);
});

test('the same bout cannot persist twice', () => {
  const { service, store, enqueued } = makeService();
  feedWorkout(service);
  const firstId = store.activities[0].id;
  feedWorkout(service, { holdMin: 20 });
  const autos = store.activities.filter((a) => a.source === 'auto');
  assert.equal(autos.length, 1);
  assert.equal(autos[0].id, firstId);
  assert.equal(sessionIngest(enqueued).length, 1);
});

test('confirmation consumeBuzz is edge-triggered', () => {
  const { service } = makeService();
  for (let i = 0; i < 300; i += 1) service.ingest({ ts: T0 + i * 1000, bpm: 65, motion: 0.05 });
  for (let i = 0; i < 200; i += 1) service.ingest({ ts: T0 + 300_000 + i * 1000, bpm: 140, motion: 0.3 });
  const first = service.state({ consumeBuzz: true });
  assert.equal(first.detectorState, 'CONFIRMED');
  assert.equal(first.buzz, true);
  const second = service.state({ consumeBuzz: true });
  assert.equal(second.detectorState, 'CONFIRMED');
  assert.equal(second.buzz, false);
  assert.equal(service.state().buzz, false);
});

test('dismiss persists the onset so a restart cannot save that bout', () => {
  const { service, store, enqueued } = makeService();
  for (let i = 0; i < 300; i += 1) service.ingest({ ts: T0 + i * 1000, bpm: 65, motion: 0.05 });
  for (let i = 0; i < 200; i += 1) service.ingest({ ts: T0 + 300_000 + i * 1000, bpm: 140, motion: 0.3 });
  service.dismiss();
  assert.ok(store.dismissedAutoOnsets?.length > 0);
  const enqueuedAfter = [];
  const restarted = createWorkoutDetectionService({
    loadStore: () => store,
    saveStore: (s) => { Object.assign(store, s); return s; },
    syncQueue: { enqueue: (op) => enqueuedAfter.push(op) },
    userId: USER,
    estimateCalories: (min) => Math.round(5 * 3.5 * 70 / 200 * min),
    loadPersistedDays: async () => ({
      '2026-08-24': { physiological_summary: { 'Resting heart rate (bpm)': 60 } },
    }),
  });
  feedWorkout(restarted);
  assert.equal(store.activities.filter((a) => a.source === 'auto').length, 0);
  assert.equal(sessionIngest(enqueued).length, 0);
  assert.equal(sessionIngest(enqueuedAfter).length, 0);
});

test('restart of an active workout restores without buzzing again', () => {
  const { service, store } = makeService();
  for (let i = 0; i < 300; i += 1) service.ingest({ ts: T0 + i * 1000, bpm: 65, motion: 0.05 });
  for (let i = 0; i < 200; i += 1) service.ingest({ ts: T0 + 300_000 + i * 1000, bpm: 140, motion: 0.3 });
  service.state({ consumeBuzz: true });
  service.reportHaptic(true);
  const restarted = createWorkoutDetectionService({
    loadStore: () => store,
    saveStore: (s) => { Object.assign(store, s); return s; },
    syncQueue: { enqueue: () => {} },
    userId: USER,
    now: () => T0 + 500_000,
  });
  const snap = restarted.state({ consumeBuzz: true });
  assert.equal(snap.detectorState, 'CONFIRMED');
  assert.equal(snap.workout.lifecycle, 'ACTIVE');
  assert.equal(snap.workout.id, store.activeWorkout.id);
  assert.equal(snap.buzz, false);
});

test('crash before haptic still does not re-buzz on restore', () => {
  const { service, store } = makeService();
  for (let i = 0; i < 300; i += 1) service.ingest({ ts: T0 + i * 1000, bpm: 65, motion: 0.05 });
  for (let i = 0; i < 200; i += 1) service.ingest({ ts: T0 + 300_000 + i * 1000, bpm: 140, motion: 0.3 });
  const pending = service.state();
  assert.equal(pending.workout.lifecycle, 'ACTIVE');
  assert.equal(pending.buzz, false);
  const restarted = createWorkoutDetectionService({
    loadStore: () => store,
    saveStore: (s) => { Object.assign(store, s); return s; },
    syncQueue: { enqueue: () => {} },
    userId: USER,
    now: () => T0 + 500_000,
  });
  const snap = restarted.state({ consumeBuzz: true });
  assert.equal(snap.workout.id, pending.workout.id);
  assert.equal(snap.workout.lifecycle, 'ACTIVE');
  assert.equal(snap.buzz, false);
});

test('a 2-minute disconnect after confirm keeps the same session and does not re-buzz', () => {
  let clock = T0;
  const { service, store } = makeService({ now: () => clock });
  for (let i = 0; i < 300; i += 1) {
    clock = T0 + i * 1000;
    service.ingest({ ts: clock, bpm: 65, motion: 0.05 });
  }
  for (let i = 0; i < 200; i += 1) {
    clock = T0 + 300_000 + i * 1000;
    service.ingest({ ts: clock, bpm: 140, motion: 0.3 });
  }
  clock = T0 + 500_000;
  const first = service.state({ consumeBuzz: true });
  assert.equal(first.buzz, true);
  const id = first.workout.id;
  store.bleLive = { ...store.bleLive, connected: false };
  clock = T0 + 500_000 + 120_000;
  const mid = service.state({ consumeBuzz: true });
  assert.equal(mid.workout.id, id);
  assert.equal(mid.workout.lifecycle, 'ACTIVE');
  assert.equal(mid.workout.connected, false);
  assert.equal(mid.buzz, false);
  store.bleLive = { ...store.bleLive, connected: true };
  const resume = T0 + 500_000 + 120_000;
  for (let i = 0; i < 60; i += 1) {
    clock = resume + i * 1000;
    service.ingest({ ts: clock, bpm: 142, motion: 0.3 });
  }
  const after = service.state({ consumeBuzz: true });
  assert.equal(after.workout.id, id);
  assert.equal(after.detectorState, 'CONFIRMED');
  assert.equal(after.buzz, false);
  assert.equal(store.activities.length, 0);
});

test('manual end without session.sport does not throw', () => {
  const { service, store } = makeService();
  for (let i = 0; i < 300; i += 1) service.ingest({ ts: T0 + i * 1000, bpm: 65, motion: 0.05 });
  for (let i = 0; i < 200; i += 1) service.ingest({ ts: T0 + 300_000 + i * 1000, bpm: 140, motion: 0.3 });
  assert.equal(service.state().detectorState, 'CONFIRMED');
  delete store.activeWorkout.sport;
  service._session().sport = undefined;
  const snap = service.end({ reason: 'manual' });
  assert.equal(snap.detectorState, 'IDLE');
  assert.equal(store.activities.length, 1);
  assert.ok(store.workoutDetectCorrections?.length >= 1);
  assert.equal(store.workoutDetectCorrections.at(-1).action, 'edited');
});

test('unset autoWorkoutHaptics is shadow, not a buzz', () => {
  const { service } = makeService({ prefs: { restingHr: 60 } });
  for (let i = 0; i < 300; i += 1) service.ingest({ ts: T0 + i * 1000, bpm: 65, motion: 0.05 });
  for (let i = 0; i < 200; i += 1) service.ingest({ ts: T0 + 300_000 + i * 1000, bpm: 140, motion: 0.3 });
  const first = service.state({ consumeBuzz: true });
  assert.equal(first.detectorState, 'CONFIRMED');
  assert.equal(first.hapticsEnabled, false);
  assert.equal(first.buzz, false);
  assert.equal(first.shadow, true);
});
