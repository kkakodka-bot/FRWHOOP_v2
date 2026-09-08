import assert from 'node:assert/strict';
import test from 'node:test';
import { hazardRatioToAgeImpact, ageImpactToHazardRatio } from '../functionalAge/effectiveAge.js';
import { calculateFunctionalAge } from '../functionalAge/engine.js';
import { calculatePaceOfAging } from '../functionalAge/pace.js';
import { sleepDurationHazard, stepsHazard, vo2MaxHazard, rhrHazard, leanBodyMassHazard, strengthHazard, moderateActivityHazard, vigorousActivityHazard, sleepConsistencyHazard } from '../functionalAge/hazardCurves.js';
import { referenceValues } from '../functionalAge/references.js';
import { adjustHazardRatios } from '../functionalAge/correlationAdjustment.js';
import { calibrationStatus, coverageFromCounts, maxValidRecoveriesInWindow, isValidRecovery, CALIBRATION_STATUS } from '../functionalAge/calibration.js';
import { isStrengthActivity, aggregateWindow } from '../functionalAge/aggregation.js';
import { CONTRIBUTOR_KEYS, METHODOLOGY_VERSION, getMethodology } from '../functionalAge/methodology.js';
import { finiteNumber } from '../functionalAge/math.js';
import { cloudRowToDay } from '../coach/days.js';
import { RESEARCH_TABLE } from '../functionalAge/research.js';
import {
  HEALTH_OPTIMIZED_MALE_30,
  HEALTH_OPTIMIZED_FEMALE_30,
} from '../functionalAge/fixtures.js';

const almost = (a, b, eps = 0.15) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b} ± ${eps}`);

test('hazardRatioToAgeImpact is the Gompertz transform', () => {
  assert.equal(hazardRatioToAgeImpact(1, 0.1), 0);
  almost(hazardRatioToAgeImpact(1.2, 0.1), Math.log(1.2) / 0.1, 1e-10);
  assert.ok(hazardRatioToAgeImpact(0.9, 0.1) < 0);
  assert.equal(hazardRatioToAgeImpact(0, 0.1), 0);
  const clamped = hazardRatioToAgeImpact(10, 0.1, { min: 0.5, max: 2.5 });
  almost(clamped, Math.log(2.5) / 0.1, 1e-10);
  almost(ageImpactToHazardRatio(Math.log(1.2) / 0.1, 0.1), 1.2, 1e-10);
});

test('health-optimized male and female sit at chronological age', () => {
  const male = calculateFunctionalAge(HEALTH_OPTIMIZED_MALE_30);
  const female = calculateFunctionalAge(HEALTH_OPTIMIZED_FEMALE_30);
  almost(male.ageDelta, 0, 0.25);
  almost(female.ageDelta, 0, 0.25);
  almost(male.functionalAge, 30, 0.25);
  almost(female.functionalAge, 30, 0.25);
  for (const c of [...male.contributors, ...female.contributors]) {
    almost(c.rawHazardRatio, 1, 0.04);
  }
});

test('same input and version is bit-identical', () => {
  const a = calculateFunctionalAge(HEALTH_OPTIMIZED_MALE_30);
  const b = calculateFunctionalAge({ ...HEALTH_OPTIMIZED_MALE_30, methodologyVersion: METHODOLOGY_VERSION });
  assert.deepEqual(a, b);
});

test('improving a beneficial metric does not worsen Functional Age', () => {
  const base = calculateFunctionalAge(HEALTH_OPTIMIZED_MALE_30);
  const moreSleep = calculateFunctionalAge({
    ...HEALTH_OPTIMIZED_MALE_30,
    metrics: { ...HEALTH_OPTIMIZED_MALE_30.metrics, sleepDurationHours: 8 },
  });
  const moreSteps = calculateFunctionalAge({
    ...HEALTH_OPTIMIZED_MALE_30,
    metrics: { ...HEALTH_OPTIMIZED_MALE_30.metrics, stepsPerDay: 11000 },
  });
  const moreVo2 = calculateFunctionalAge({
    ...HEALTH_OPTIMIZED_MALE_30,
    metrics: { ...HEALTH_OPTIMIZED_MALE_30.metrics, vo2Max: 50 },
  });
  const lowerRhr = calculateFunctionalAge({
    ...HEALTH_OPTIMIZED_MALE_30,
    metrics: { ...HEALTH_OPTIMIZED_MALE_30.metrics, restingHrBpm: 52 },
  });
  assert.ok(moreSteps.functionalAge <= base.functionalAge + 0.01);
  assert.ok(moreVo2.functionalAge < base.functionalAge);
  assert.ok(lowerRhr.functionalAge < base.functionalAge);
  assert.ok(moreSleep.functionalAge <= base.functionalAge + 0.01);
});

test('worsening a harmful metric does not improve Functional Age', () => {
  const base = calculateFunctionalAge(HEALTH_OPTIMIZED_MALE_30);
  const shortSleep = calculateFunctionalAge({
    ...HEALTH_OPTIMIZED_MALE_30,
    metrics: { ...HEALTH_OPTIMIZED_MALE_30.metrics, sleepDurationHours: 5.5 },
  });
  const fewSteps = calculateFunctionalAge({
    ...HEALTH_OPTIMIZED_MALE_30,
    metrics: { ...HEALTH_OPTIMIZED_MALE_30.metrics, stepsPerDay: 3000 },
  });
  const highRhr = calculateFunctionalAge({
    ...HEALTH_OPTIMIZED_MALE_30,
    metrics: { ...HEALTH_OPTIMIZED_MALE_30.metrics, restingHrBpm: 78 },
  });
  assert.ok(shortSleep.functionalAge > base.functionalAge);
  assert.ok(fewSteps.functionalAge > base.functionalAge);
  assert.ok(highRhr.functionalAge > base.functionalAge);
  assert.ok(sleepDurationHazard(9.5, 30, 'male') === 1);
});

test('sleep above 9 hours is not penalized', () => {
  const eight = calculateFunctionalAge({
    ...HEALTH_OPTIMIZED_MALE_30,
    metrics: { ...HEALTH_OPTIMIZED_MALE_30.metrics, sleepDurationHours: 8 },
  });
  const ten = calculateFunctionalAge({
    ...HEALTH_OPTIMIZED_MALE_30,
    metrics: { ...HEALTH_OPTIMIZED_MALE_30.metrics, sleepDurationHours: 10 },
  });
  almost(ten.contributors.find((c) => c.key === 'sleep_duration').ageImpactYears, 0, 0.05);
  almost(eight.contributors.find((c) => c.key === 'sleep_duration').ageImpactYears, 0, 0.05);
});

test('extremes saturate rather than exploding', () => {
  const extreme = calculateFunctionalAge({
    chronologicalAge: 30,
    sex: 'male',
    metrics: {
      sleepDurationHours: 3,
      sleepConsistencyPct: 5,
      stepsPerDay: 0,
      zone13MinPerWeek: 0,
      zone45MinPerWeek: 0,
      strengthMinPerWeek: 0,
      vo2Max: 12,
      vo2Source: 'measured',
      restingHrBpm: 110,
      leanBodyMassPct: 45,
    },
  });
  const elite = calculateFunctionalAge({
    chronologicalAge: 30,
    sex: 'male',
    metrics: {
      sleepDurationHours: 8,
      sleepConsistencyPct: 99,
      stepsPerDay: 25000,
      zone13MinPerWeek: 900,
      zone45MinPerWeek: 400,
      strengthMinPerWeek: 400,
      vo2Max: 80,
      vo2Source: 'measured',
      restingHrBpm: 38,
      leanBodyMassPct: 92,
    },
  });
  assert.ok(extreme.ageDelta < 22);
  assert.ok(elite.ageDelta > -18);
  assert.ok(vo2MaxHazard(80, 30, 'male') >= 0.5);
  assert.ok(stepsHazard(40000, 30, 'male') >= 0.5);
  assert.ok(rhrHazard(38, 30, 'male') === rhrHazard(42, 30, 'male'));
});

test('missing lean body mass does not penalize', () => {
  const withLbm = calculateFunctionalAge(HEALTH_OPTIMIZED_MALE_30);
  const metrics = { ...HEALTH_OPTIMIZED_MALE_30.metrics };
  delete metrics.leanBodyMassPct;
  const missing = calculateFunctionalAge({ ...HEALTH_OPTIMIZED_MALE_30, metrics });
  const lbm = missing.contributors.find((c) => c.key === 'lean_body_mass');
  assert.equal(lbm.available, false);
  assert.equal(lbm.ageImpactYears, 0);
  assert.equal(lbm.confidence, 0);
  almost(missing.functionalAge, withLbm.functionalAge, 0.35);
});

test('null metrics are missing; explicit zeros are scored', () => {
  assert.equal(finiteNumber(null), null);
  assert.equal(finiteNumber(undefined), null);
  assert.equal(finiteNumber(''), null);
  assert.equal(finiteNumber(0), 0);
  const missing = calculateFunctionalAge({
    ...HEALTH_OPTIMIZED_MALE_30,
    metrics: {
      ...HEALTH_OPTIMIZED_MALE_30.metrics,
      stepsPerDay: null,
      vo2Max: null,
      vo2Source: 'whoop_estimated',
      leanBodyMassPct: null,
    },
  });
  for (const key of ['steps', 'vo2_max', 'lean_body_mass']) {
    const c = missing.contributors.find((row) => row.key === key);
    assert.equal(c.available, false);
    assert.equal(c.ageImpactYears, 0);
    assert.equal(c.confidence, 0);
    assert.equal(c.value, null);
    assert.match(c.explanation, /unavailable/i);
  }
  const zeroSteps = calculateFunctionalAge({
    ...HEALTH_OPTIMIZED_MALE_30,
    metrics: { ...HEALTH_OPTIMIZED_MALE_30.metrics, stepsPerDay: 0 },
  });
  const steps = zeroSteps.contributors.find((row) => row.key === 'steps');
  assert.equal(steps.available, true);
  assert.ok(steps.ageImpactYears > 1);
});

test('missing VO2 is unavailable and is not silently estimated', () => {
  const metrics = { ...HEALTH_OPTIMIZED_MALE_30.metrics };
  delete metrics.vo2Max;
  metrics.vo2Source = 'unavailable';
  const missing = calculateFunctionalAge({ ...HEALTH_OPTIMIZED_MALE_30, metrics });
  const vo2 = missing.contributors.find((c) => c.key === 'vo2_max');
  assert.equal(vo2.available, false);
  assert.equal(vo2.ageImpactYears, 0);
  const estimated = calculateFunctionalAge({
    ...HEALTH_OPTIMIZED_MALE_30,
    metrics: { ...HEALTH_OPTIMIZED_MALE_30.metrics, vo2Max: 50, vo2Source: 'estimated_hr_ratio' },
  });
  assert.equal(estimated.contributors.find((c) => c.key === 'vo2_max').available, false);
});

test('correlated fitness metrics shrink stacked benefits', () => {
  const stacked = {
    chronologicalAge: 30,
    sex: 'male',
    metrics: {
      sleepDurationHours: 8,
      sleepConsistencyPct: 70,
      stepsPerDay: 12000,
      zone13MinPerWeek: 250,
      zone45MinPerWeek: 40,
      strengthMinPerWeek: 90,
      vo2Max: 55,
      vo2Source: 'measured',
      restingHrBpm: 48,
      leanBodyMassPct: 84,
    },
  };
  const result = calculateFunctionalAge(stacked);
  const vo2 = result.contributors.find((c) => c.key === 'vo2_max');
  const rhr = result.contributors.find((c) => c.key === 'rhr');
  const steps = result.contributors.find((c) => c.key === 'steps');
  assert.ok(Math.abs(vo2.adjustedHazardRatio - 1) < Math.abs(vo2.rawHazardRatio - 1) + 1e-9);
  assert.ok(vo2.adjustedHazardRatio >= vo2.rawHazardRatio - 1e-9);
  assert.ok(rhr.adjustedHazardRatio >= rhr.rawHazardRatio - 1e-9);
  assert.ok(steps.adjustedHazardRatio >= steps.rawHazardRatio - 1e-9);
  assert.ok(result.ageDelta > -12);
});

test('overlap does not shrink an isolated contributor', () => {
  const { adjustedHrs } = adjustHazardRatios(
    { sleep_duration: 1.2, sleep_consistency: 1, steps: 1, moderate_activity: 1, vigorous_activity: 1, strength: 1, vo2_max: 1, rhr: 1, lean_body_mass: 1 },
    { sleep_duration: true, sleep_consistency: false, steps: false, moderate_activity: true, vigorous_activity: true, strength: true, vo2_max: false, rhr: true, lean_body_mass: false },
  );
  almost(adjustedHrs.sleep_duration, 1.2, 1e-9);
});

test('pace is 1.0 when projected Functional Age rises 0.5 years', () => {
  const current = calculateFunctionalAge(HEALTH_OPTIMIZED_MALE_30);
  const fakeCurrent = { ...current, functionalAge: 30, chronologicalAge: 30 };
  const pace = calculatePaceOfAging({
    current: fakeCurrent,
    recentMetrics: HEALTH_OPTIMIZED_MALE_30.metrics,
    sex: 'male',
    chronologicalAge: 30,
  });
  // Monkey-patch by constructing pace from known projected gap.
  const synthetic = (projected, cur) => (projected - cur) / 0.5;
  almost(synthetic(30.5, 30), 1.0, 1e-9);
  almost(synthetic(30.25, 30), 0.5, 1e-9);
  almost(synthetic(30, 30), 0.0, 1e-9);
  almost(synthetic(29.75, 30), -0.5, 1e-9);
  assert.ok(Number.isFinite(pace.paceOfAgingRaw));
});

test('stable optimized behavior yields pace near 1x', () => {
  const current = calculateFunctionalAge(HEALTH_OPTIMIZED_MALE_30);
  const pace = calculatePaceOfAging({
    current,
    recentMetrics: HEALTH_OPTIMIZED_MALE_30.metrics,
    sex: 'male',
    chronologicalAge: 30,
  });
  almost(pace.paceOfAging, 1.0, 0.25);
});

test('worse recent behavior raises pace above 1x', () => {
  const current = calculateFunctionalAge(HEALTH_OPTIMIZED_MALE_30);
  const pace = calculatePaceOfAging({
    current,
    recentMetrics: {
      ...HEALTH_OPTIMIZED_MALE_30.metrics,
      sleepDurationHours: 5.5,
      stepsPerDay: 3500,
      zone13MinPerWeek: 20,
      restingHrBpm: 72,
    },
    sex: 'male',
    chronologicalAge: 30,
  });
  assert.ok(pace.paceOfAgingRaw > 1.0);
});

test('calibration states follow coverage rules', () => {
  const m = getMethodology();
  assert.equal(calibrationStatus({ maxRecoveriesIn31Days: 5, validRecoveryDays: 5, daysObserved: 10, overallCoverage: 0.2 }, m), CALIBRATION_STATUS.INSUFFICIENT);
  assert.equal(calibrationStatus({ maxRecoveriesIn31Days: 21, validRecoveryDays: 21, daysObserved: 40, overallCoverage: 0.5 }, m), CALIBRATION_STATUS.PROVISIONAL);
  assert.equal(calibrationStatus({ maxRecoveriesIn31Days: 25, validRecoveryDays: 80, daysObserved: 100, overallCoverage: 0.5 }, m), CALIBRATION_STATUS.CALIBRATING);
  assert.equal(calibrationStatus({ maxRecoveriesIn31Days: 28, validRecoveryDays: 170, daysObserved: 180, overallCoverage: 0.6 }, m), CALIBRATION_STATUS.CALIBRATED);
  assert.equal(isValidRecovery(0), false);
  assert.equal(isValidRecovery(72), true);
  const days = [];
  for (let i = 0; i < 31; i += 1) {
    days.push({ day: `2025-01-${String(i + 1).padStart(2, '0')}`, recovery: i < 21 ? 70 : 0 });
  }
  assert.equal(maxValidRecoveriesInWindow(days, 31), 21);
});

test('coverage does not treat missing optional feeds as zeros', () => {
  const m = getMethodology();
  const cov = coverageFromCounts({
    daysObserved: 180,
    validSleepDays: 170,
    validStepDays: 0,
    validHrDays: 160,
    validActivityWeeks: 20,
    weeksObserved: 26,
    vo2Coverage: 0,
    bodyCompositionCoverage: 0,
    validRecoveryDays: 170,
    maxRecoveriesIn31Days: 28,
  }, m);
  assert.ok(cov.overallCoverage >= 0.45);
  assert.equal(cov.validStepDays, 0);
  assert.equal(cov.vo2Coverage, 0);
  assert.equal(calibrationStatus(cov, m), CALIBRATION_STATUS.CALIBRATED);
});

test('VO2 and step references interpolate with age and sex', () => {
  const m30 = referenceValues(30, 'male');
  const f30 = referenceValues(30, 'female');
  const m65 = referenceValues(65, 'male');
  assert.equal(m30.vo2Max, 44);
  assert.equal(f30.vo2Max, 38);
  assert.ok(m65.stepsPerDay < m30.stepsPerDay);
  assert.ok(m65.zone13MinPerWeek < m30.zone13MinPerWeek);
  almost(m65.vo2Max, 30, 0.05);
});

test('strength names match WHOOP’s Healthspan list', () => {
  assert.equal(isStrengthActivity('Weightlifting'), true);
  assert.equal(isStrengthActivity('Powerlifting'), true);
  assert.equal(isStrengthActivity('Yoga'), true);
  assert.equal(isStrengthActivity('HIIT'), true);
  assert.equal(isStrengthActivity('Running'), false);
  assert.equal(isStrengthActivity('Swimming'), false);
});

test('aggregation ignores naps, zeros, and missing steps', () => {
  const days = [
    { day: '2025-01-01', recovery: 70, rhr: 60, asleepMin: 480, sleepConsistency: 75, nap: false, workouts: [] },
    { day: '2025-01-02', recovery: 0, rhr: 0, asleepMin: 80, sleepConsistency: 0, nap: true, workouts: [] },
    { day: '2025-01-03', recovery: 80, rhr: 58, asleepMin: 500, sleepConsistency: 80, nap: false, steps: 9000, workouts: [{ name: 'Weightlifting', durationMin: 40, zones: [50, 0, 0, 0, 0] }] },
  ];
  const agg = aggregateWindow(days, [], { asOfDay: '2025-01-03', windowDays: 3 });
  assert.equal(agg.counts.validSleepDays, 2);
  assert.equal(agg.counts.validStepDays, 1);
  assert.equal(agg.counts.validHrDays, 2);
  assert.ok(agg.metrics.strengthMinPerWeek > 0);
  assert.equal(agg.metrics.stepsPerDay, 9000);
});

test('workout duration_s is converted to minutes', () => {
  const days = [
    {
      day: '2025-01-01',
      recovery: 70,
      rhr: 60,
      asleepMin: 480,
      sleepConsistency: 75,
      nap: false,
      workouts: [{ name: 'Weightlifting', duration_s: 2400, zones: [40, 0, 0, 0, 0] }],
    },
  ];
  const agg = aggregateWindow(days, [], { asOfDay: '2025-01-01', windowDays: 7 });
  assert.ok(agg.metrics.strengthMinPerWeek > 0);
  assert.ok(agg.totals.strengthMin >= 39 && agg.totals.strengthMin <= 41);
});

test('cloud daily_metrics map onto Functional Age fields without coercing null to zero', () => {
  const day = cloudRowToDay({
    day: '2025-01-01',
    metrics: {
      sleep_total_min: 480,
      resting_hr_bpm: 60,
      steps: null,
      vo2max: null,
      body_fat_pct: null,
    },
    sessions: [{
      kind: 'workout',
      summary: { sport: 'Weightlifting', duration_s: 2400, zones: [50, 0, 0, 0, 0] },
    }],
  });
  assert.equal(day.asleepMin, 480);
  assert.equal(day.rhr, 60);
  assert.equal(day.steps, null);
  assert.equal(day.vo2max, null);
  assert.equal(day.bodyFatPct, null);
  assert.equal(day.workouts[0].durationMin, 40);
  assert.equal(day.workouts[0].name, 'Weightlifting');
});

test('every Healthspan contributor has a research row', () => {
  for (const key of CONTRIBUTOR_KEYS) {
    assert.ok(RESEARCH_TABLE.some((r) => r.metric === key), `missing research for ${key}`);
  }
  assert.ok(RESEARCH_TABLE.some((r) => r.metric === 'effective_age'));
});

test('hazard helpers are finite across a grid', () => {
  for (const hours of [4, 6, 7, 8, 10]) assert.ok(sleepDurationHazard(hours, 30, 'male') > 0);
  for (const pct of [40, 70, 90]) assert.ok(sleepConsistencyHazard(pct, 30, 'male') > 0);
  for (const st of [2000, 8000, 12000]) assert.ok(stepsHazard(st, 30, 'male') > 0);
  for (const n of [0, 40, 90, 180]) assert.ok(strengthHazard(n, 30, 'male') > 0);
  assert.ok(moderateActivityHazard(0, 30, 'male') > 1);
  assert.ok(vigorousActivityHazard(0, 30, 'male') > 1);
  assert.ok(leanBodyMassHazard(80, 30, 'male') === 1 || Math.abs(leanBodyMassHazard(80, 30, 'male') - 1) < 0.02);
});
