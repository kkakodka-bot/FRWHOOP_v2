import test from 'node:test';
import assert from 'node:assert/strict';
import {
  walkingVo2, runningVo2, locomotionExpert, cadenceToWalkSpeed, plausibleVo2ForActivity,
} from '../energy/locomotion.js';

test('ACSM walking: 1.4 m/s (5 km/h) is ~3.4 MET', () => {
  const w = walkingVo2({ speedMs: 1.4 });
  const met = w.vo2MlPerKgMin / 3.5;
  assert.ok(Math.abs(met - 3.4) < 0.25, `walk MET ${met}`);
});

test('ACSM running: 3.0 m/s is ~11 MET and grade increases VO2', () => {
  const flat = runningVo2({ speedMs: 3.0 });
  const grade = runningVo2({ speedMs: 3.0, grade: 0.05 });
  assert.ok(flat.vo2MlPerKgMin / 3.5 > 10, `run MET ${flat.vo2MlPerKgMin / 3.5}`);
  assert.ok(grade.vo2MlPerKgMin > flat.vo2MlPerKgMin, 'grade raises running VO2');
});

test('cadence-derived walk speed is a bounded range', () => {
  const cs = cadenceToWalkSpeed(110);
  assert.ok(cs.speedMsLo > 0.9 && cs.speedMsHi < 1.6, `cadence speed ${JSON.stringify(cs)}`);
});

test('locomotion expert uses GPS speed with low uncertainty, cadence with high', () => {
  const gps = locomotionExpert({ activity: 'walking', speedMs: 1.4 });
  assert.equal(gps.speedSource, 'gps');
  assert.equal(gps.uncertainty, 'low');
  const cad = locomotionExpert({ activity: 'walking', speedMs: null, cadenceSpm: 110 });
  assert.ok(cad.speedSource === 'cadence_derived' && cad.uncertainty === 'high');
});

test('locomotion expert returns nothing for non-locomotion activities', () => {
  assert.equal(locomotionExpert({ activity: 'strength', speedMs: 1.4 }), null);
  assert.equal(locomotionExpert({ activity: 'cycling', speedMs: 5 }), null);
});

test('plausibility band catches an impossible locomotion prediction', () => {
  assert.ok(plausibleVo2ForActivity('walking', 3.5 * 3.4));
  assert.ok(!plausibleVo2ForActivity('walking', 3.5 * 30));
  assert.ok(plausibleVo2ForActivity('running', 3.5 * 12));
});
