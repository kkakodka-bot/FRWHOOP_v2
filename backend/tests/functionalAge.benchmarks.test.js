import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateFunctionalAge } from '../functionalAge/engine.js';
import { computeHealthspanFromData } from '../functionalAge/adapter.js';
import { scoreObservations } from '../functionalAge/validation.js';
import { loadDayIndex } from '../coach/days.js';
import {
  PUBLISHED_PROFILES,
  US_MALE_30,
  US_FEMALE_30,
  WHOOP_MALE_30,
  WHOOP_FEMALE_30,
} from '../functionalAge/fixtures.js';

test('published WHOOP Table 2 profiles are directionally and quantitatively plausible', () => {
  for (const profile of PUBLISHED_PROFILES) {
    const result = calculateFunctionalAge(profile);
    assert.ok(
      result.ageDelta >= profile.expectedBand[0] && result.ageDelta <= profile.expectedBand[1],
      `${profile.id} delta ${result.ageDelta} outside ${profile.expectedBand}`,
    );
  }
  const usM = calculateFunctionalAge(US_MALE_30);
  const whoopM = calculateFunctionalAge(WHOOP_MALE_30);
  const usF = calculateFunctionalAge(US_FEMALE_30);
  const whoopF = calculateFunctionalAge(WHOOP_FEMALE_30);
  assert.ok(usM.ageDelta > 0);
  assert.ok(whoopM.ageDelta < usM.ageDelta);
  assert.ok(usF.ageDelta > usM.ageDelta - 0.3);
  assert.ok(whoopF.ageDelta < usF.ageDelta);
  assert.ok(Math.abs(whoopM.ageDelta - (-1.6)) < 2.4);
  assert.ok(Math.abs(usM.ageDelta - 6) < 3.2);
  assert.ok(Math.abs(usF.ageDelta - 7.5) < 3.8);
});

test('validation harness reports MAE and pace metrics', () => {
  const rows = [
    { date: '2025-01-01', actualWhoopAge: 28.4, actualWhoopPace: 0.7, ...WHOOP_MALE_30 },
    { date: '2025-01-08', actualWhoopAge: 36.1, actualWhoopPace: 1.4, ...US_MALE_30 },
  ];
  const scored = scoreObservations(rows, (row) => {
    const fa = calculateFunctionalAge(row);
    return { ...fa, paceOfAging: row.id === 'whoop_male_30' ? 0.72 : 1.35 };
  });
  assert.equal(scored.n, 2);
  assert.ok(scored.mae > 0);
  assert.ok(scored.rmse >= scored.mae);
  assert.ok(Number.isFinite(scored.paceMae));
  assert.ok(scored.perContributor.vo2_max);
});

test('engine runs on historical coach-days without fabricating missing inputs', () => {
  const index = loadDayIndex();
  const result = computeHealthspanFromData({
    days: index.days,
    profile: { sex: 'male', birthYear: 1995, leanBodyMassPct: null },
    extraWorkouts: [],
    asOfDay: index.lastDay,
  });
  assert.equal(result.error, undefined);
  assert.ok(Number.isFinite(result.functionalAge));
  assert.ok(result.functionalAge > 18 && result.functionalAge < 80);
  const vo2 = result.contributors.find((c) => c.key === 'vo2_max');
  const steps = result.contributors.find((c) => c.key === 'steps');
  const lbm = result.contributors.find((c) => c.key === 'lean_body_mass');
  assert.equal(vo2.available, false);
  assert.equal(vo2.ageImpactYears, 0);
  assert.match(vo2.explanation, /unavailable/i);
  assert.equal(steps.available, false);
  assert.equal(lbm.available, false);
  assert.ok(['INSUFFICIENT', 'PROVISIONAL', 'CALIBRATING', 'CALIBRATED'].includes(result.calibrationStatus));
  assert.ok(result.coverageDays > 50);
  const rhr = result.contributors.find((c) => c.key === 'rhr');
  const sleep = result.contributors.find((c) => c.key === 'sleep_duration');
  assert.equal(rhr.available, true);
  assert.equal(sleep.available, true);
  assert.ok(Number.isFinite(result.paceOfAgingRaw));
});
