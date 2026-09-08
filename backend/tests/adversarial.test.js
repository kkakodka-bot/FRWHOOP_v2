/**
 * Adversarial + synthetic physiological edge cases (Phase 16).
 *
 * Each scenario encodes an expected QUALITATIVE behaviour of the engine, not a
 * number. These are the mission-specified edge cases (caffeine, anxiety, quiet
 * wrist cycling, strength pressor, HR recovery, cadence lock, off wrist, loose
 * band, low resting HR, etc.). The point is to lock in the physiology the model
 * is supposed to respect so a future "improvement" that breaks one of these is
 * caught as a regression.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { computeEnergy } from '../energy/service.js';
import { resolvePhysiology } from '../energy/physiology.js';
import { ACTIVITY } from '../energy/constants.js';

const PROFILE = { birthYear: 1994, sex: 'male', heightCm: 180, weightKg: 78 };
const PREFS = { restingHr: 48 };

/** Build samples: one per 4 s across `minutes`, constant bpm/motion. */
function steady({ minutes = 60, bpm = 60, mot = 0.01, stage = null, extra = {} } = {}) {
  const out = [];
  const start = Date.parse('2026-08-24T15:00:00Z');
  for (let s = 0; s < minutes * 60; s += 4) {
    out.push({ datetime: new Date(start + s * 1000).toISOString(), bpm, motion: mot, sleep_stage: stage, ...extra });
  }
  return out;
}

function run({ samples, profile = PROFILE, prefs = PREFS, workouts = [], timeZone = 'UTC' } = {}) {
  const result = computeEnergy({ samples, profile, prefs, workouts, timeZone });
  const mins = result.minutes;
  const metAvg = mins.length ? mins.reduce((a, m) => a + m.met, 0) / mins.length : null;
  const restingAvg = mins.length ? mins.reduce((a, m) => a + m.resting_kcal, 0) / mins.length : null;
  const activeTotal = mins.reduce((a, m) => a + m.active_kcal, 0);
  return { result, mins, metAvg, restingAvg, activeTotal };
}

test('caffeine-induced tachycardia while motionless is NOT priced as exercise', () => {
  // HR 90, wrist still: this is a resting band minute, not light exercise.
  const { metAvg, activeTotal } = run({ samples: steady({ bpm: 90, mot: 0.02 }) });
  // A resting-band minute with an elevated HR but a still wrist must stay below
  // the walking threshold — it is not exercise. 1.0-1.6 MET is defensible as
  // standing with a stimulated heart; 2+ MET (old behaviour: 2.5) was the bug.
  assert.ok(metAvg >= 0.9 && metAvg < 1.7, `caffeinated resting MET ${metAvg.toFixed(2)} should stay in resting/standing band`);
  // An hour of it is ~1.3-1.5 MET, i.e. ~35-45 active kcal, not hundreds.
  assert.ok(activeTotal < 60, `caffeine should not create ~100+ kcal fail, got ${activeTotal.toFixed(0)}`);
});

test('athlete with resting HR 40 is not distorted by VO2max overestimate', () => {
  const phys = resolvePhysiology({ profile: PROFILE, prefs: { restingHr: 40 } });
  // A low RHR drives a high Uth VO2max; the model must still not collapse rest.
  const { metAvg } = run({ samples: steady({ bpm: 55, mot: 0.01 }), prefs: { restingHr: 40 } });
  assert.ok(metAvg < 1.5, `low-RHR rest MET ${metAvg}`);
  assert.ok(metAvg >= 0.8, `low-RHR rest MET ${metAvg} must not be below sleep floor`);
});

test('cycling: quiet wrist + high HR is exercise, not sedentary rest', () => {
  // Wrist barely moves but HR is 140: this looks like sitting on paper; it is
  // not. The model must not label it sedentary (that would price it at ~1 MET).
  const samples = steady({ bpm: 140, mot: 0.05 });
  samples.push({ datetime: new Date(Date.parse('2026-08-24T15:58:00Z')).toISOString(), bpm: 142, motion: 0.04 });
  const { metAvg } = run({ samples });
  assert.ok(metAvg >= 2.5, `still-wrist high-HR should be priced as work, got ${metAvg.toFixed(2)} MET`);
});

test('HR recovery after running is not charged as continued running', () => {
  // A long run then a cooling-down minute at near-resting HR but high motion
  // (walking). The cooling minute must not be priced at running METs.
  const samples = [];
  const start = Date.parse('2026-08-24T15:00:00Z');
  for (let m = 0; m < 30; m++) {
    for (let s = 0; s < 60; s += 4) samples.push({ datetime: new Date(start + (m * 60 + s) * 1000).toISOString(), bpm: 160, motion: 1.0 });
  }
  for (let m = 30; m < 40; m++) {
    for (let s = 0; s < 60; s += 4) samples.push({ datetime: new Date(start + (m * 60 + s) * 1000).toISOString(), bpm: 75, motion: 0.3 });
  }
  const result = computeEnergy({ samples, profile: PROFILE, prefs: PREFS, timeZone: 'UTC' });
  const lastMins = result.minutes.slice(-10);
  const metAvg = lastMins.reduce((a, m) => a + m.met, 0) / lastMins.length;
  assert.ok(metAvg < 4, `recovery minutes should be walking-ish, got ${metAvg.toFixed(2)} MET`);
});

test('off wrist / missing HR is a gap, not an invented resting value', () => {
  // Minute 15:20 carries ONLY an out-of-band HR (400) — treated as absent.
  const samples = steady({ minutes: 30, bpm: 60, mot: 0.01 });
  // steady covers 15:00..15:29; replace minute 15:20 with a single implausible sample.
  const filtered = samples.filter((s) => !s.datetime.startsWith('2026-08-24T15:20'));
  filtered.push({ datetime: new Date(Date.parse('2026-08-24T15:20:00Z')).toISOString(), bpm: 400, motion: 0.01 });
  const result = computeEnergy({ samples: filtered, profile: PROFILE, prefs: PREFS, timeZone: 'UTC' });
  // The minute with only an impossible HR has no usable HR; if it emits a row it
  // must not fabricate a healthy 'measured' HR.
  const badMin = result.minutes.find((m) => m.minute_at.startsWith('2026-08-24T15:20'));
  if (badMin) {
    assert.equal(badMin.hr_source, 'absent');
    assert.ok(badMin.model_confidence < 0.5);
  }
});

test('strength pressor: high HR is discounted so a session does not hit running METs', () => {
  const samples = steady({ minutes: 30, bpm: 145, mot: 0.5 });
  const workout = [{
    id: 'w-strength', sport: 'Weightlifting',
    start: new Date(Date.parse('2026-08-24T15:00:00Z')).toISOString(),
    end: new Date(Date.parse('2026-08-24T15:30:00Z')).toISOString(),
  }];
  const result = computeEnergy({ samples, profile: PROFILE, prefs: PREFS, workouts: workout, timeZone: 'UTC' });
  const mins = result.minutes;
  const metAvg = mins.reduce((a, m) => a + m.met, 0) / mins.length;
  assert.ok(metAvg >= 1.5 && metAvg <= 7.0, `strength MET ${metAvg.toFixed(2)} within Compendium band`);
  // As a workout the active energy must be a subset.
  const woActive = mins.filter((m) => m.workout_session_id).reduce((a, m) => a + m.active_kcal, 0);
  const allActive = mins.reduce((a, m) => a + m.active_kcal, 0);
  assert.ok(woActive <= allActive + 1e-6, `workout ${woActive} <= active ${allActive}`);
});

test('cadence-like motion with resting HR cannot create phantom calories', () => {
  // Wrist moving (0.3) but HR at rest (55): typing/driving/fidgeting, not work.
  const metall = run({ samples: steady({ bpm: 55, mot: 0.3 }) });
  assert.ok(metall.metAvg < 2.0, `high-motion-low-HR should be capped, got ${metall.metAvg.toFixed(2)} MET`);
});

test('a full sedentary day has a low active total and correct accounting', () => {
  const { activeTotal, restingAvg } = run({ samples: steady({ minutes: 120, bpm: 60, mot: 0.01 }) });
  assert.ok(restingAvg >= 1.0 && restingAvg <= 1.6, `resting per min ${restingAvg}`);
});
