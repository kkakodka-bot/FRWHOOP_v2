import test from 'node:test';
import assert from 'node:assert/strict';

import {
  accountMinute, accountDay, minuteInvariants, dayInvariants,
  estimateTef, tefAsPopulation, TEF_BY_MACRO,
} from '../energy/accounting.js';
import {
  estimateTdeeLongitudinal, nutritionCompleteness, stateTransition,
  ENERGY_DENSITY, FLUID_REVERSION,
} from '../energy/longitudinal.js';

// ---------------------------------------------------------------------------
// Canonical accounting
// ---------------------------------------------------------------------------

test('minute accounting enforces total = resting + active + tef', () => {
  const m = accountMinute({ resting_kcal: 1.2, active_kcal: 0.5, tef_kcal: 0.1, workout_session_id: 'w1' });
  assert.equal(m.total_kcal, 1.8);
  assert.deepEqual(minuteInvariants(m), []);
});

test('workout kcal cannot exceed active kcal', () => {
  const m = accountMinute({ resting_kcal: 0.5, active_kcal: 0.3, workout_session_id: 'w1' });
  assert.equal(m.workout_active_kcal, 0.3);
  assert.deepEqual(minuteInvariants(m), []);
  // A minute with workout kcal but no session id violates the invariant.
  const bad = { resting_kcal: 0.5, active_kcal: 0.5, workout_active_kcal: 0.5, total_kcal: 1.0, tef_kcal: 0 };
  assert.ok(minuteInvariants(bad).includes('workout_kcal_without_session'));
});

test('daily accounting: NEAT = active - workout; net workout <= gross', () => {
  const d = accountDay([
    accountMinute({ resting_kcal: 1.0, active_kcal: 0.5, workout_session_id: 'w1' }),
    accountMinute({ resting_kcal: 1.0, active_kcal: 1.0, workout_session_id: 'w1' }),
    accountMinute({ resting_kcal: 1.0, active_kcal: 0.2 }),
  ]);
  assert.equal(d.active_kcal, 1.7);
  assert.equal(d.workout_active_kcal, 1.5);
  assert.equal(d.neat_kcal, 0.2);
  assert.equal(d.net_workout_kcal, 1.5);
  assert.equal(d.gross_workout_kcal, 3.5); // (1.0+0.5)+(1.0+1.0)+... resting 1+active.5=1.5, resting1+active1=2.0 -> 3.5
  assert.deepEqual(dayInvariants(d), []);
});

test('TEF from macros uses documented ranges', () => {
  // p 150*0.25, c 300*0.075, f 100*0.015 around the centre
  const t = estimateTef({ complete: true, protein_kcal: 150, carbs_kcal: 300, fat_kcal: 100 });
  assert.equal(t.basis, 'macro');
  assert.equal(t.tef_kcal_lo, 45);   // 150*.20 + 300*.05 + 100*0
  assert.equal(t.tef_kcal_hi, 78);   // 150*.30 + 300*.10 + 100*.03
  assert.equal(t.tef_kcal_central, 61.5);
});

test('TEF is never counted when logging is incomplete', () => {
  const t = estimateTef({ complete: false, protein_kcal: 150 });
  assert.equal(t.basis, 'none');
  assert.equal(t.tef_kcal_central, 0);
});

test('TEF macro ranges are within primary-literature bounds', () => {
  assert.ok(TEF_BY_MACRO.protein.lo >= 0.15 && TEF_BY_MACRO.protein.hi <= 0.35);
  assert.ok(TEF_BY_MACRO.carbs.lo >= 0.03 && TEF_BY_MACRO.carbs.hi <= 0.15);
  assert.ok(TEF_BY_MACRO.fat.lo >= 0 && TEF_BY_MACRO.fat.hi <= 0.05);
});

// ---------------------------------------------------------------------------
// Longitudinal TDEE (energy balance) estimator
// ---------------------------------------------------------------------------

test('nutrition completeness excludes partial logging from calibration', () => {
  assert.equal(nutritionCompleteness({ intakeKcal: 2500, macrosComplete: true }).usable, true);
  assert.equal(nutritionCompleteness({ intakeKcal: 2500, macrosComplete: true, missingMeals: 2 }).usable, false);
  assert.equal(nutritionCompleteness({ intakeKcal: 200, macrosComplete: true }).usable, false); // suspiciously low
  assert.equal(nutritionCompleteness(null).usable, false);
});

test('state transition returns a 3x3 lower-triangular F for the linear model', () => {
  const { F, B } = stateTransition(2500, 7700);
  assert.equal(F.length, 3);
  assert.equal(F[0][0], 1);
  assert.equal(Math.abs(F[0][2] + 1 / 7700) < 1e-12, true); // -1/ED on tdee col
  assert.equal(F[1][1], FLUID_REVERSION);
  assert.equal(F[2][2], 1);
  assert.equal(B[0], 1 / 7700);
});

test('longitudinal filter recovers a known TDEE from synthetic intake+weight', () => {
  const rng = mulberry(7);
  const trueTdee = 2600, ed = 7700;
  let w = 78;
  const recs = [];
  for (let k = 0; k < 90; k++) {
    const intake = trueTdee + Math.round((k - 45) * 20); // surplus then deficit
    w += (intake - trueTdee) / ed;
    recs.push({ day: `d${k}`, intakeKcal: intake, scaleKg: w + (rng() * 0.8 - 0.4), macrosComplete: true });
  }
  const out = estimateTdeeLongitudinal(recs, { edKcalPerKg: ed, initialTdee: 2200, initialTrendKg: 80 });
  // Final TDEE posterior should be within ~5% of the truth after 90 days.
  const finalTdee = out[out.length - 1].tdee_kcal;
  assert.ok(Math.abs(finalTdee - trueTdee) / trueTdee < 0.05,
    `tdee ${finalTdee} not within 5% of ${trueTdee}`);
});

test('a single anomalous scale reading cannot jerk TDEE by hundreds of kcal', () => {
  const recs = [];
  for (let k = 0; k < 40; k++) recs.push({ day: `d${k}`, intakeKcal: 2500, scaleKg: 78, macrosComplete: true });
  const out = estimateTdeeLongitudinal(recs, { edKcalPerKg: 7700, initialTdee: 2400, initialTrendKg: 78 });
  const before = out[30].tdee_kcal;
  // Insert one huge outlier after day 30 and re-run.
  const recs2 = [...recs.slice(0, 31), { day: 'd31', intakeKcal: 2500, scaleKg: 85, macrosComplete: true }, ...recs.slice(31)];
  const out2 = estimateTdeeLongitudinal(recs2, { edKcalPerKg: 7700, initialTdee: 2400, initialTrendKg: 78 });
  const after = out2[31].tdee_kcal;
  assert.ok(Math.abs(after - before) < 200,
    `one outlier moved TDEE by ${Math.abs(after - before).toFixed(0)} kcal`);
});

// deterministic PRNG for tests
function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
