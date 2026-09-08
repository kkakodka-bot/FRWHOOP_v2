import test from 'node:test';
import assert from 'node:assert/strict';
import {
  energyEquivalentKcalPerL, gtEnergyFromVo2, participantHeldOutSplit, scoreEePrediction,
} from '../energy/groundTruth.js';

test('1 MET (3.5 mL/kg/min) at 70 kg = ~1.19 kcal/min via ER 4.862', () => {
  const e = gtEnergyFromVo2({ vo2MlPerKgMin: 3.5, weightKg: 70 });
  assert.equal(e.met, 1);
  assert.ok(Math.abs(e.kcalPerMin - 1.191) < 0.01, `kcal ${e.kcalPerMin}`);
  // 3.5/1000 * 70 = 0.245 L/min * 4.862 = 1.191
});

test('running VO2 35 mL/kg/min at 70 kg = 10 MET, ~11.9 kcal/min', () => {
  const e = gtEnergyFromVo2({ vo2MlPerKgMin: 35, weightKg: 70 });
  assert.equal(e.met, 10);
  assert.ok(Math.abs(e.kcalPerMin - 11.91) < 0.1, `kcal ${e.kcalPerMin}`);
});

test('RER shifts the energy equivalent in the documented direction', () => {
  const highFat = energyEquivalentKcalPerL(0.70);
  const highCarb = energyEquivalentKcalPerL(1.00);
  assert.ok(highCarb > highFat, `E_C ${highCarb} > E_F ${highFat}`);
  assert.ok(highFat >= 4.68 && highCarb <= 5.05);
});

test('participant-held-out split never leaks a participant across folds', () => {
  const ids = ['p1','p1','p1','p2','p2','p3','p3','p4','p5','p6'];
  const { train, test, testParticipants } = participantHeldOutSplit(ids, { testFraction: 0.33, seed: 3 });
  const seenIds = new Set(test.map((i) => ids[i]));
  for (const i of train) assert.ok(!seenIds.has(ids[i]), `participant ${ids[i]} leaked into train`);
  assert.equal(seenIds.size, testParticipants.length);
});

test('scoreEePrediction reports MAE/RMSE/bias on calorimetry ground truth', () => {
  const pairs = [[1.2, 1.19], [11.9, 11.91], [2.0, 2.1]];
  const s = scoreEePrediction(pairs);
  assert.equal(s.n, 3);
  assert.ok(s.mae > 0 && s.rmse > 0);
  assert.ok(Number.isFinite(s.bias));
});
