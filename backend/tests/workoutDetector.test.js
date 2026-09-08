import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorkoutDetector,
  workoutFloor,
  hrZone,
  classifyLiveSport,
  sportDisplayName,
} from '../metrics/workoutDetector.js';

test('classifyLiveSport splits walk / lift / cardio', () => {
  assert.equal(classifyLiveSport({ motionMean: 0.4, meanHr: 96, cardioFloor: 119 }), 'walking');
  assert.equal(classifyLiveSport({ motionMean: 0.4, meanHr: 150, cardioFloor: 119 }), 'detected');
  assert.equal(classifyLiveSport({ motionMean: 0.02, pulseCount: 3 }), 'strength');
  assert.equal(sportDisplayName('strength'), 'Weightlifting');
  assert.equal(sportDisplayName('walking'), 'Walking');
});

// Test physiology: RHR 60, HRmax 190 → floor = max(60+40, 60+0.45·130) = 119.
const THRESHOLDS = () => ({ restingHr: 60, maxHr: 190 });
const FLOOR = 119;
const T0 = Date.parse('2026-08-24T12:00:00Z');

function make(config) {
  const events = [];
  const det = createWorkoutDetector({
    thresholds: THRESHOLDS,
    config,
    onEvent: (e) => events.push(e),
    now: () => T0,
  });
  return { det, events };
}

function feed(det, { ts, bpm, seconds, stepS = 1, motion }) {
  let snap;
  for (let i = 0; i < seconds; i += stepS) {
    const value = typeof bpm === 'function' ? bpm(i) : bpm;
    snap = det.ingest({ ts: ts + i * 1000, bpm: value, ...(motion != null ? { motion } : {}) });
  }
  return snap;
}

const starts = (events) => events.filter((e) => e.type === 'workout_start');
const ends = (events) => events.filter((e) => e.type === 'workout_end');
const discards = (events) => events.filter((e) => e.type === 'workout_discarded');

test('floor is personalized: max(RHR+40, RHR+0.45·HRR)', () => {
  assert.equal(workoutFloor({ restingHr: 60, maxHr: 190 }), FLOOR);
  assert.equal(workoutFloor({ restingHr: 50, maxHr: 200 }), Math.max(90, Math.round(50 + 67.5)));
  assert.equal(workoutFloor({}), 119); // helper defaults 60/190
});

test('missing or bogus RHR does not invent a floor; the detector abstains', () => {
  const det = createWorkoutDetector({ thresholds: () => ({ restingHr: null, maxHr: 190 }) });
  assert.equal(det.snapshot().floor, null);
  assert.equal(det.snapshot().restingHr, null);
  assert.equal(det.snapshot().physReady, false);
  const snap = feed(det, { ts: T0, bpm: 150, seconds: 20 * 60 });
  assert.equal(snap.state, 'IDLE');

  const zero = createWorkoutDetector({ thresholds: () => ({ restingHr: 0, maxHr: 190 }) });
  assert.equal(zero.snapshot().floor, null);
  const nan = createWorkoutDetector({ thresholds: () => ({ restingHr: Number.NaN, maxHr: 190 }) });
  assert.equal(nan.snapshot().floor, null);
});

test('missing HRmax uses RHR+40 and does not invent 190', () => {
  const det = createWorkoutDetector({ thresholds: () => ({ restingHr: 60, maxHr: null }) });
  assert.equal(det.snapshot().floor, 100);
  assert.equal(det.snapshot().maxHr, null);
});

test('hrZone buckets by %HRmax', () => {
  assert.equal(hrZone(140, 190), 3);
  assert.equal(hrZone(175, 190), 5);
  assert.equal(hrZone(80, 190), 0);
  assert.equal(hrZone(140, null), 0);
  assert.equal(hrZone(175, 0), 0);
});

test('sedentary day never leaves IDLE', () => {
  const { det, events } = make();
  const snap = feed(det, { ts: T0, bpm: (i) => 65 + (i % 7), seconds: 30 * 60 });
  assert.equal(snap.state, 'IDLE');
  assert.equal(events.length, 0);
});

test('stairs spike reaches LIKELY but never confirms', () => {
  const { det, events } = make();
  feed(det, { ts: T0, bpm: 70, seconds: 180 });
  feed(det, { ts: T0 + 180_000, bpm: 125, seconds: 90 });
  const mid = feed(det, { ts: T0 + 270_000, bpm: 70, seconds: 180 });
  assert.equal(starts(events).length, 0);
  assert.equal(ends(events).length, 0);
  assert.equal(mid.state, 'LIKELY');
  const snap = feed(det, { ts: T0 + 450_000, bpm: 70, seconds: 5 * 60 });
  assert.equal(starts(events).length, 0);
  assert.equal(snap.state, 'IDLE');
  const states = events.filter((e) => e.type === 'state').map((e) => e.state);
  assert.ok(states.includes('POSSIBLE'));
  assert.ok(states.includes('LIKELY'));
});

test('real workout with motion: confirm ~3 min in, backdated onset, finalized summary', () => {
  const { det, events } = make();
  feed(det, { ts: T0, bpm: 65, seconds: 300, motion: 0.05 });
  feed(det, { ts: T0 + 300_000, bpm: (i) => 65 + i * 1.25, seconds: 60, motion: 0.3 });
  feed(det, { ts: T0 + 360_000, bpm: 140, seconds: 20 * 60, motion: 0.3 });
  feed(det, { ts: T0 + 1560_000, bpm: 70, seconds: 5 * 60, motion: 0.05 });

  assert.equal(starts(events).length, 1);
  const start = starts(events)[0];
  // onset backdated to the first sample ≥ 119 during the ramp (~343 s)
  const expectedOnset = T0 + 300_000 + Math.ceil((FLOOR - 65) / 1.25) * 1000;
  assert.ok(Math.abs(start.workout.onsetTs - expectedOnset) <= 2000, `onset ${start.workout.onsetTs} vs ${expectedOnset}`);
  // confirmation lands in the 2–4 min band after onset
  const confirmLagS = (start.workout.confirmedTs - start.workout.onsetTs) / 1000;
  assert.ok(confirmLagS >= 170 && confirmLagS <= 250, `confirm lag ${confirmLagS}s`);
  assert.equal(start.workout.floor, FLOOR);
  assert.equal(start.workout.confirmPath, 'high_confidence');
  assert.equal(ends(events)[0].workout.startTs, start.workout.onsetTs);

  assert.equal(ends(events).length, 1);
  const w = ends(events)[0].workout;
  assert.ok(w.durationS >= 1150 && w.durationS <= 1300, `duration ${w.durationS}`);
  assert.equal(w.peakHr, 140);
  assert.ok(w.avgHr >= 130 && w.avgHr <= 141, `avg ${w.avgHr}`);
  // 140/190 ≈ 74% HRmax → almost all zone 3
  assert.ok(w.zonesPct[2] > 90, `zones ${w.zonesPct}`);
  // end is backdated to the last sample above the exit floor, not the grace tail
  assert.ok(w.endTs <= T0 + 1560_000);
});

test('HR-only confirmation waits ~8 min; 3 min without motion does not buzz', () => {
  const early = make();
  feed(early.det, { ts: T0, bpm: 65, seconds: 300 });
  const at3 = feed(early.det, { ts: T0 + 300_000, bpm: 140, seconds: 200 });
  assert.equal(starts(early.events).length, 0);
  assert.equal(at3.state, 'LIKELY');

  const full = make();
  feed(full.det, { ts: T0, bpm: 65, seconds: 300 });
  feed(full.det, { ts: T0 + 300_000, bpm: 140, seconds: 9 * 60 });
  assert.equal(starts(full.events).length, 1);
  assert.equal(starts(full.events)[0].workout.confirmPath, 'hr_only');
  const lag = (starts(full.events)[0].workout.confirmedTs - starts(full.events)[0].workout.onsetTs) / 1000;
  assert.ok(lag >= 470 && lag <= 520, `hr-only lag ${lag}`);
});

test('a brief mid-workout dip does not split the bout', () => {
  const { det, events } = make();
  feed(det, { ts: T0, bpm: 65, seconds: 300, motion: 0.3 });
  feed(det, { ts: T0 + 300_000, bpm: 140, seconds: 8 * 60, motion: 0.3 });
  feed(det, { ts: T0 + 780_000, bpm: 100, seconds: 45, motion: 0.1 });
  feed(det, { ts: T0 + 825_000, bpm: 140, seconds: 8 * 60, motion: 0.3 });
  feed(det, { ts: T0 + 1305_000, bpm: 70, seconds: 5 * 60, motion: 0.05 });
  assert.equal(starts(events).length, 1);
  assert.equal(ends(events).length, 1);
  assert.ok(ends(events)[0].workout.durationS > 900);
});

test('a 5-minute reconnect does not split a confirmed workout', () => {
  const { det, events } = make();
  feed(det, { ts: T0, bpm: 65, seconds: 300, motion: 0.3 });
  feed(det, { ts: T0 + 300_000, bpm: 140, seconds: 10 * 60, motion: 0.3 });
  const lastSeen = T0 + 300_000 + 599_000;
  const snap = feed(det, { ts: lastSeen + 300_000, bpm: 140, seconds: 60, motion: 0.3 });
  assert.equal(starts(events).length, 1);
  assert.equal(ends(events).length, 0);
  assert.equal(snap.detectorState, 'CONFIRMED');
});

test('a forgotten 31-minute gap auto-ends the confirmed session', () => {
  const { det, events } = make();
  feed(det, { ts: T0, bpm: 65, seconds: 300, motion: 0.3 });
  feed(det, { ts: T0 + 300_000, bpm: 140, seconds: 10 * 60, motion: 0.3 });
  const lastSeen = T0 + 300_000 + 599_000;
  feed(det, { ts: lastSeen + 31 * 60_000, bpm: 65, seconds: 5 });
  assert.equal(ends(events).length, 1);
  assert.equal(ends(events)[0].workout.endTs, lastSeen);
});

test('a confirmed bout that meets minWorkoutS is persisted, not discarded', () => {
  const { det, events } = make();
  feed(det, { ts: T0, bpm: 65, seconds: 300, motion: 0.3 });
  feed(det, { ts: T0 + 300_000, bpm: 140, seconds: 200, motion: 0.3 });
  feed(det, { ts: T0 + 500_000, bpm: 70, seconds: 250, motion: 0.05 });
  assert.equal(starts(events).length, 1);
  assert.equal(ends(events).length, 1);
  assert.equal(discards(events).length, 0);
  assert.ok(ends(events)[0].workout.durationS >= 180);
});

test('dismiss cancels an active bout and never re-fires on the same elevation', () => {
  const { det, events } = make();
  feed(det, { ts: T0, bpm: 65, seconds: 300, motion: 0.3 });
  feed(det, { ts: T0 + 300_000, bpm: 140, seconds: 5 * 60, motion: 0.3 });
  assert.equal(starts(events).length, 1);
  const dismissed = det.dismiss('user');
  assert.equal(dismissed.state, 'IDLE');
  assert.equal(discards(events).length, 1);
  // still 140 bpm: cooldown + rearm gate keep it idle
  let snap = feed(det, { ts: T0 + 600_000, bpm: 140, seconds: 60 });
  assert.equal(snap.state, 'IDLE');
  // HR drops, cooldown expires → a genuinely new bout can be detected
  feed(det, { ts: T0 + 1120_000, bpm: 70, seconds: 200 });
  snap = feed(det, { ts: T0 + 1320_000, bpm: 140, seconds: 9 * 60, motion: 0.3 });
  assert.equal(starts(events).length, 2);
});

test('stream starting mid-workout does not confirm at 3 min without an onset', () => {
  const { det, events } = make();
  const snap = feed(det, { ts: T0, bpm: 140, seconds: 10 * 60 });
  assert.equal(starts(events).length, 0);
  assert.notEqual(snap.state, 'CONFIRMED');
});

test('stream starting mid-workout confirms after OpenStrap 12-minute horizon', () => {
  const { det, events } = make();
  feed(det, { ts: T0, bpm: 140, seconds: 13 * 60 });
  feed(det, { ts: T0 + 13 * 60_000, bpm: 70, seconds: 5 * 60 });
  assert.equal(starts(events).length, 1);
  assert.equal(starts(events)[0].workout.onsetRiseBpm, null);
  assert.equal(ends(events).length, 1);
});

test('slow stress drift without an exercise onset is rejected', () => {
  const { det, events } = make();
  feed(det, { ts: T0, bpm: 105, seconds: 10 * 60 });                  // already-elevated baseline
  feed(det, { ts: T0 + 600_000, bpm: 122, seconds: 6 * 60 });         // crosses floor, weak rise
  const snap = feed(det, { ts: T0 + 960_000, bpm: 105, seconds: 120 });
  assert.equal(starts(events).length, 0);
  assert.notEqual(snap.state, 'CONFIRMED');
});

test('motion series confirms low-onset cardio; stillness rejects it', () => {
  // cycling/rowing: wrist still, but motion gate cleared by intensity
  const moving = make();
  feed(moving.det, { ts: T0, bpm: 105, seconds: 5 * 60, motion: 0.05 });
  feed(moving.det, { ts: T0 + 300_000, bpm: 122, seconds: 6 * 60, motion: 0.3 });
  assert.equal(starts(moving.events).length, 1);

  // desk fidget: same HR, no real movement → rejected at the confirm timeout;
  // HR is still above the floor afterwards, so it re-evaluates but never activates
  const still = make();
  feed(still.det, { ts: T0, bpm: 105, seconds: 5 * 60, motion: 0.05 });
  const snap = feed(still.det, { ts: T0 + 300_000, bpm: 122, seconds: 6 * 60, motion: 0.05 });
  assert.equal(starts(still.events).length, 0);
  assert.notEqual(snap.state, 'CONFIRMED');
});

test('confirmation time is independent of sample cadence', () => {
  const lags = [];
  for (const stepS of [1, 4, 10]) {
    const { det, events } = make();
    feed(det, { ts: T0, bpm: 65, seconds: 300, stepS, motion: 0.25 });
    feed(det, { ts: T0 + 300_000, bpm: 140, seconds: 8 * 60, stepS, motion: 0.25 });
    assert.equal(starts(events).length, 1, `cadence ${stepS}s`);
    lags.push((starts(events)[0].workout.confirmedTs - starts(events)[0].workout.onsetTs) / 1000);
  }
  assert.ok(Math.max(...lags) - Math.min(...lags) <= 12, `lags ${lags}`);
  for (const lag of lags) assert.ok(lag >= 170 && lag <= 200, `lag ${lag}`);
});

test('irregular intervals still confirm on elapsed time, not sample count', () => {
  const { det, events } = make();
  let ts = T0;
  let i = 0;
  const steps = [1000, 2500, 4000];
  while (ts < T0 + 300_000) {
    det.ingest({ ts, bpm: 65, motion: 0.25 });
    ts += steps[i % 3];
    i += 1;
  }
  const boutStart = ts;
  const boutSteps = [1500, 4500];
  while (ts < boutStart + 200_000) {
    det.ingest({ ts, bpm: 140, motion: 0.25 });
    ts += boutSteps[i % 2];
    i += 1;
  }
  assert.equal(starts(events).length, 1);
  const lag = (starts(events)[0].workout.confirmedTs - starts(events)[0].workout.onsetTs) / 1000;
  assert.ok(lag >= 170 && lag <= 220, `irregular lag ${lag}`);
});

test('out-of-order and duplicate samples are ignored', () => {
  const { det, events } = make();
  feed(det, { ts: T0, bpm: 65, seconds: 300, motion: 0.25 });
  feed(det, { ts: T0 + 300_000, bpm: 140, seconds: 4 * 60, motion: 0.25 });
  det.ingest({ ts: T0 + 100_000, bpm: 200 });
  det.ingest({ ts: T0 + 300_000 + 60_000, bpm: 200 });
  assert.equal(starts(events).length, 1);
  assert.ok(starts(events)[0].workout.onsetRiseBpm < 80);
});

test('bogus BPM values never enter the state machine', () => {
  const { det } = make();
  assert.equal(det.ingest({ ts: T0, bpm: 0 }).state, 'IDLE');
  assert.equal(det.ingest({ ts: T0 + 1000, bpm: 9 }).state, 'IDLE');
  assert.equal(det.ingest({ ts: T0 + 2000, bpm: 300 }).state, 'IDLE');
  assert.equal(det.ingest({ ts: T0 + 3000, bpm: NaN }).state, 'IDLE');
});

test('tick closes a forgotten silent gap without waiting for the next sample', () => {
  const { det, events } = make();
  feed(det, { ts: T0, bpm: 65, seconds: 300, motion: 0.3 });
  feed(det, { ts: T0 + 300_000, bpm: 140, seconds: 8 * 60, motion: 0.3 });
  assert.equal(starts(events).length, 1);
  const last = T0 + 300_000 + 8 * 60_000 - 1000;
  det.tick(last + 400_000);
  assert.equal(ends(events).length, 0);
  det.tick(last + 31 * 60_000);
  assert.equal(ends(events).length, 1);
  assert.equal(ends(events)[0].workout.endTs, last);
});

test('restore reconstructs a confirmed bout without emitting a second start', () => {
  const first = make();
  feed(first.det, { ts: T0, bpm: 65, seconds: 300, motion: 0.3 });
  feed(first.det, { ts: T0 + 300_000, bpm: 140, seconds: 4 * 60, motion: 0.3 });
  assert.equal(starts(first.events).length, 1);
  const checkpoint = first.det.exportCheckpoint();
  const second = make();
  second.det.restore(checkpoint);
  assert.equal(second.det.snapshot().detectorState, 'CONFIRMED');
  assert.equal(starts(second.events).length, 0);
  feed(second.det, { ts: T0 + 300_000 + 4 * 60_000, bpm: 140, seconds: 60, motion: 0.3 });
  assert.equal(starts(second.events).length, 0);
});

test('an easy walk below the cardio floor still auto-starts', () => {
  const { det, events } = make();
  feed(det, { ts: T0, bpm: 70, seconds: 180, motion: 0.04 });
  feed(det, { ts: T0 + 180_000, bpm: 96, seconds: 8 * 60, motion: 0.4 });
  feed(det, { ts: T0 + 180_000 + 8 * 60_000, bpm: 60, seconds: 5 * 60, motion: 0.04 });
  assert.equal(starts(events).length, 1);
  assert.equal(starts(events)[0].workout.confirmPath, 'walking');
  assert.equal(starts(events)[0].workout.sport, 'walking');
  assert.equal(ends(events).length, 1);
  assert.equal(ends(events)[0].workout.sport, 'walking');
});

test('quiet-wrist lifting with set rests auto-starts, then a walk switches sport', () => {
  const { det, events } = make();
  feed(det, { ts: T0, bpm: 70, seconds: 180, motion: 0.01 });
  let t = T0 + 180_000;
  for (let set = 0; set < 8; set += 1) {
    feed(det, { ts: t, bpm: 112, seconds: 40, motion: 0.04 });
    t += 40_000;
    feed(det, { ts: t, bpm: 84, seconds: 110, motion: 0.01 });
    t += 110_000;
  }
  assert.equal(starts(events).length, 1);
  assert.equal(starts(events)[0].workout.confirmPath, 'strength');
  assert.equal(starts(events)[0].workout.sport, 'strength');
  feed(det, { ts: t, bpm: 97, seconds: 8 * 60, motion: 0.45 });
  t += 8 * 60_000;
  const changes = events.filter((e) => e.type === 'sport_change');
  assert.ok(changes.some((e) => e.sport === 'walking'), `sport changes ${JSON.stringify(changes)}`);
  feed(det, { ts: t, bpm: 60, seconds: 16 * 60, motion: 0.02 });
  assert.equal(ends(events).length, 1);
  assert.equal(ends(events)[0].workout.sport, 'strength');
});
