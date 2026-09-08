import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkoutDetector } from '../metrics/workoutDetector.js';

const T0 = Date.parse('2026-08-24T12:00:00Z');

function run({ restingHr = 60, maxHr = 190, traces }) {
  const events = [];
  const det = createWorkoutDetector({
    thresholds: () => ({ restingHr, maxHr }),
    onEvent: (e) => events.push(e),
  });
  let snap;
  for (const { ts, bpm, seconds, stepS = 1, motion } of traces) {
    for (let i = 0; i < seconds; i += stepS) {
      const value = typeof bpm === 'function' ? bpm(i) : bpm;
      snap = det.ingest({ ts: ts + i * 1000, bpm: value, ...(motion != null ? { motion } : {}) });
    }
  }
  return {
    snap,
    starts: events.filter((e) => e.type === 'workout_start').length,
    ends: events.filter((e) => e.type === 'workout_end').length,
  };
}

function bout({ from = 0, bpm, seconds, motion }) {
  return { ts: T0 + from * 1000, bpm, seconds, motion };
}

test('false positives: rest, sleep, sit, stand, caffeine, stress, heat, stairs', () => {
  const cases = {
    rest: [bout({ bpm: 58, seconds: 40 * 60 })],
    sleep: [bout({ bpm: (i) => 48 + (i % 5), seconds: 6 * 3600 })],
    sit: [bout({ bpm: (i) => 68 + (i % 6), seconds: 45 * 60 })],
    stand: [bout({ bpm: 72, seconds: 300 }), bout({ from: 300, bpm: 88, seconds: 8 * 60 })],
    caffeine: [bout({ bpm: 70, seconds: 600 }), bout({ from: 600, bpm: 92, seconds: 20 * 60 })],
    stress: [bout({ bpm: 80, seconds: 600 }), bout({ from: 600, bpm: 110, seconds: 15 * 60 })],
    heat: [bout({ bpm: 85, seconds: 20 * 60 }), bout({ from: 1200, bpm: 105, seconds: 20 * 60 })],
    stairs: [bout({ bpm: 70, seconds: 180 }), bout({ from: 180, bpm: 128, seconds: 80 }), bout({ from: 260, bpm: 75, seconds: 180 })],
    housework: [bout({ bpm: 70, seconds: 180 }), bout({ from: 180, bpm: 105, seconds: 15 * 60 })],
    groceries: [bout({ bpm: 70, seconds: 180 }), bout({ from: 180, bpm: 112, seconds: 8 * 60 })],
    yoga: [bout({ bpm: 70, seconds: 180 }), bout({ from: 180, bpm: 95, seconds: 40 * 60 })],
    warmup: [bout({ bpm: 70, seconds: 180 }), bout({ from: 180, bpm: 118, seconds: 90 })],
  };
  for (const [name, traces] of Object.entries(cases)) {
    const r = run({ traces });
    assert.equal(r.starts, 0, `${name} must not confirm (state=${r.snap?.state})`);
  }
});

test('false positives: deconditioned / high RHR still need an onset, not just a high number', () => {
  const r = run({
    restingHr: 80,
    maxHr: 175,
    traces: [
      bout({ bpm: 95, seconds: 600 }),
      bout({ from: 600, bpm: 122, seconds: 8 * 60 }),
    ],
  });
  assert.equal(r.starts, 0);
});

test('true positives: running, cycling (motion), HIIT-ish intervals', () => {
  const runn = run({
    traces: [
      bout({ bpm: 65, seconds: 300 }),
      bout({ from: 300, bpm: 155, seconds: 25 * 60 }),
      bout({ from: 300 + 25 * 60, bpm: 80, seconds: 5 * 60 }),
    ],
  });
  assert.equal(runn.starts, 1);
  assert.equal(runn.ends, 1);

  const cycle = run({
    traces: [
      bout({ bpm: 70, seconds: 300, motion: 0.04 }),
      bout({ from: 300, bpm: 130, seconds: 20 * 60, motion: 0.22 }),
      bout({ from: 300 + 20 * 60, bpm: 80, seconds: 5 * 60, motion: 0.04 }),
    ],
  });
  assert.equal(cycle.starts, 1);

  const hiit = run({
    traces: [
      bout({ bpm: 65, seconds: 300 }),
      bout({ from: 300, bpm: 160, seconds: 4 * 60 }),
      bout({ from: 540, bpm: 110, seconds: 60 }),
      bout({ from: 600, bpm: 158, seconds: 4 * 60 }),
      bout({ from: 840, bpm: 110, seconds: 60 }),
      bout({ from: 900, bpm: 155, seconds: 4 * 60 }),
      bout({ from: 1140, bpm: 75, seconds: 5 * 60 }),
    ],
  });
  assert.equal(hiit.starts, 1);
  assert.equal(hiit.ends, 1);
});

test('strength with long rests confirms via set-rest pulses, not the cardio floor', () => {
  const traces = [bout({ bpm: 70, seconds: 180, motion: 0.01 })];
  let t = 180;
  for (let set = 0; set < 6; set += 1) {
    traces.push(bout({ from: t, bpm: 125, seconds: 40, motion: 0.04 }));
    t += 40;
    traces.push(bout({ from: t, bpm: 85, seconds: 150, motion: 0.01 }));
    t += 150;
  }
  traces.push(bout({ from: t, bpm: 60, seconds: 16 * 60, motion: 0.01 }));
  const r = run({ traces });
  assert.equal(r.starts, 1);
  assert.equal(r.ends, 1);
});

test('strength with 4-minute rests below RHR+15 still confirms as one bout', () => {
  const traces = [bout({ bpm: 70, seconds: 180, motion: 0.01 })];
  let t = 180;
  for (let set = 0; set < 6; set += 1) {
    traces.push(bout({ from: t, bpm: 110, seconds: 40, motion: 0.04 }));
    t += 40;
    traces.push(bout({ from: t, bpm: 68, seconds: 4 * 60, motion: 0.01 }));
    t += 4 * 60;
  }
  traces.push(bout({ from: t, bpm: 97, seconds: 8 * 60, motion: 0.45 }));
  t += 8 * 60;
  traces.push(bout({ from: t, bpm: 60, seconds: 16 * 60, motion: 0.02 }));
  const events = [];
  const det = createWorkoutDetector({
    thresholds: () => ({ restingHr: 60, maxHr: 190 }),
    onEvent: (e) => events.push(e),
  });
  for (const { ts, bpm, seconds, stepS = 1, motion } of traces) {
    for (let i = 0; i < seconds; i += stepS) {
      det.ingest({ ts: ts + i * 1000, bpm, ...(motion != null ? { motion } : {}) });
    }
  }
  const starts = events.filter((e) => e.type === 'workout_start');
  const changes = events.filter((e) => e.type === 'sport_change');
  const ends = events.filter((e) => e.type === 'workout_end');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].workout.confirmPath, 'strength');
  assert.ok(changes.some((e) => e.sport === 'walking'));
  assert.equal(ends.length, 1);
});

test('trained athlete with RHR 42 still detects a run', () => {
  const r = run({
    restingHr: 42,
    maxHr: 190,
    traces: [
      bout({ bpm: 50, seconds: 300 }),
      bout({ from: 300, bpm: 150, seconds: 20 * 60 }),
      bout({ from: 300 + 20 * 60, bpm: 60, seconds: 5 * 60 }),
    ],
  });
  assert.equal(r.starts, 1);
  assert.equal(r.ends, 1);
});

test('midnight-crossing timestamps stay one bout', () => {
  const midnight = Date.parse('2026-08-24T23:58:00Z');
  const events = [];
  const det = createWorkoutDetector({
    thresholds: () => ({ restingHr: 60, maxHr: 190 }),
    onEvent: (e) => events.push(e),
  });
  for (let i = 0; i < 300; i += 1) det.ingest({ ts: midnight - 300_000 + i * 1000, bpm: 65 });
  for (let i = 0; i < 20 * 60; i += 1) det.ingest({ ts: midnight + i * 1000, bpm: 145 });
  for (let i = 0; i < 5 * 60; i += 1) det.ingest({ ts: midnight + 20 * 60_000 + i * 1000, bpm: 70 });
  assert.equal(events.filter((e) => e.type === 'workout_start').length, 1);
  assert.equal(events.filter((e) => e.type === 'workout_end').length, 1);
});

test('90s gap during likely does not confirm a split; 5 min active gap does not split', () => {
  const gap90 = run({
    traces: [
      bout({ bpm: 65, seconds: 300, motion: 0.25 }),
      bout({ from: 300, bpm: 145, seconds: 4 * 60, motion: 0.25 }),
      bout({ from: 300 + 4 * 60 + 90, bpm: 145, seconds: 16 * 60, motion: 0.25 }),
      bout({ from: 300 + 20 * 60 + 90, bpm: 70, seconds: 5 * 60, motion: 0.04 }),
    ],
  });
  assert.equal(gap90.starts, 1);
  assert.equal(gap90.ends, 1);

  const gap5 = run({
    traces: [
      bout({ bpm: 65, seconds: 300, motion: 0.25 }),
      bout({ from: 300, bpm: 145, seconds: 8 * 60, motion: 0.25 }),
      bout({ from: 300 + 8 * 60 + 5 * 60, bpm: 145, seconds: 4 * 60, motion: 0.25 }),
    ],
  });
  assert.equal(gap5.starts, 1);
  assert.equal(gap5.ends, 0);
});

test('stuck HR with advancing timestamps is not treated as a gap', () => {
  const r = run({
    traces: [
      bout({ bpm: 65, seconds: 300 }),
      bout({ from: 300, bpm: 150, seconds: 20 * 60 }),
      bout({ from: 300 + 20 * 60, bpm: 70, seconds: 5 * 60 }),
    ],
  });
  assert.equal(r.starts, 1);
  assert.equal(r.ends, 1);
});

test('short sprint under confirm horizon is not a workout', () => {
  const r = run({
    traces: [
      bout({ bpm: 65, seconds: 180 }),
      bout({ from: 180, bpm: 175, seconds: 45 }),
      bout({ from: 225, bpm: 70, seconds: 180 }),
    ],
  });
  assert.equal(r.starts, 0);
});
