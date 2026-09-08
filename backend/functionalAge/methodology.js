/** Versioned Functional Age configuration. Coefficients are cited in docs/FUNCTIONAL_AGE.md. */

export const METHODOLOGY_VERSION = 'functional_age_v1';

export const CONTRIBUTOR_KEYS = Object.freeze([
  'sleep_duration',
  'sleep_consistency',
  'steps',
  'moderate_activity',
  'vigorous_activity',
  'strength',
  'vo2_max',
  'rhr',
  'lean_body_mass',
]);

export const CONTRIBUTOR_META = Object.freeze({
  sleep_duration: { label: 'Sleep duration', unit: 'hours', domain: 'sleep' },
  sleep_consistency: { label: 'Sleep consistency', unit: '%', domain: 'sleep' },
  steps: { label: 'Daily steps', unit: 'steps/day', domain: 'activity' },
  moderate_activity: { label: 'Zone 1–3 activity', unit: 'min/week', domain: 'activity' },
  vigorous_activity: { label: 'Zone 4–5 activity', unit: 'min/week', domain: 'activity' },
  strength: { label: 'Strength activity', unit: 'min/week', domain: 'activity' },
  vo2_max: { label: 'VO2 max', unit: 'ml/kg/min', domain: 'fitness' },
  rhr: { label: 'Resting heart rate', unit: 'bpm', domain: 'fitness' },
  lean_body_mass: { label: 'Lean body mass', unit: '%', domain: 'fitness' },
});

const V1 = Object.freeze({
  version: METHODOLOGY_VERSION,
  gompertzRate: 0.1,
  hrClamp: Object.freeze({ min: 0.5, max: 2.5 }),
  ageImpactClampPerContributor: Object.freeze({ min: -8, max: 10 }),
  functionalAgeDeltaClamp: Object.freeze({ min: -20, max: 20 }),
  windows: Object.freeze({
    historicalDays: 180,
    recentDays: 30,
    paceHorizonYears: 0.5,
  }),
  paceDisplayClamp: Object.freeze({ min: -1, max: 3 }),
  calibration: Object.freeze({
    unlockRecoveries: 21,
    unlockWindowDays: 31,
    provisionalDays: 90,
    calibratedDays: 180,
    calibratedCoverage: 0.45,
    minValidSleepMin: 120,
    maxValidSleepMin: 720,
    minValidRhr: 35,
    maxValidRhr: 110,
    minValidSteps: 200,
    maxValidSteps: 50000,
    minValidVo2: 12,
    maxValidVo2: 85,
    minValidLbm: 40,
    maxValidLbm: 95,
  }),
  sleepDuration: Object.freeze({
    optimalMinHours: 7,
    optimalMaxHours: 9,
    // hours → HR. Source mix: WHOOP (7–9 = 1.0, >9 = 1.0); Itani 2017 RR 1.12 for short sleep.
    points: Object.freeze([
      [4.0, 1.42],
      [5.0, 1.28],
      [6.0, 1.12],
      [7.0, 1.0],
      [9.0, 1.0],
      [12.0, 1.0],
    ]),
  }),
  sleepConsistency: Object.freeze({
    referencePct: 70,
    // ln(HR) per 10 points below reference. Windred 2024 Q5 vs Q1 fully adjusted HR 0.70, re-anchored at 70.
    logHrPer10PtsBelow: 0.08,
    minHr: 0.75,
    maxHr: 1.45,
  }),
  steps: Object.freeze({
    youngTarget: 8000,
    olderTarget: 5600,
    youngAge: 30,
    olderAge: 65,
    // relative-to-target → HR. Paluch 2022 quartiles re-anchored so HR(target)=1.
    relativePoints: Object.freeze([
      [0.0, 2.05],
      [0.25, 1.72],
      [0.44, 1.55],
      [0.65, 1.18],
      [0.725, 1.1],
      [1.0, 1.0],
      [1.36, 0.86],
      [1.6, 0.83],
      [2.2, 0.82],
    ]),
  }),
  moderateActivity: Object.freeze({
    youngTargetMin: 100,
    olderTargetMin: 70,
    youngAge: 30,
    olderAge: 65,
    zeroHr: 1.26,
    saturatingHr: 0.82,
    saturationMin: 400,
  }),
  vigorousActivity: Object.freeze({
    youngTargetMin: 10,
    olderTargetMin: 7,
    youngAge: 30,
    olderAge: 65,
    zeroHr: 1.24,
    saturatingHr: 0.8,
    saturationMin: 55,
    hardCapMin: 90,
  }),
  strength: Object.freeze({
    targetMin: 40,
    zeroHr: 1.18,
    bestHr: 0.95,
    bestMin: 60,
    plateauMin: 120,
  }),
  vo2: Object.freeze({
    metMlKgMin: 3.5,
    hrPerMet: 0.87,
    deltaMetClamp: Object.freeze({ min: -5, max: 4 }),
    // WHOOP white paper Figure 4.
    table: Object.freeze({
      female: Object.freeze([
        [20, 40], [25, 40], [30, 38], [35, 36], [40, 34], [45, 32], [50, 30],
        [55, 29], [60, 27], [65, 26], [70, 25], [75, 23], [80, 22], [85, 21],
        [90, 20], [95, 19], [100, 18],
      ]),
      male: Object.freeze([
        [20, 46], [25, 46], [30, 44], [35, 42], [40, 40], [45, 37], [50, 36],
        [55, 34], [60, 32], [65, 30], [70, 29], [75, 27], [80, 26], [85, 25],
        [90, 23], [95, 22], [100, 21],
      ]),
    }),
    acceptedSources: Object.freeze(['measured', 'user_entered', 'whoop_estimated']),
  }),
  rhr: Object.freeze({
    maleRef: 60,
    femaleRef: 64,
    rrPer10Bpm: 1.09,
    floorBpm: 42,
    ceilingBpm: 100,
  }),
  leanBodyMass: Object.freeze({
    // Age 30 WHOOP published; other ages approximated from sarcopenia / WHOOP "changes with age".
    table: Object.freeze({
      female: Object.freeze([[20, 69], [30, 67], [50, 63], [70, 59], [90, 56]]),
      male: Object.freeze([[20, 82], [30, 80], [50, 76], [70, 72], [90, 68]]),
    }),
    hrPer10PctDeficit: 1.11,
    surplusHrFloor: 0.94,
    surplusScalePct: 8,
  }),
  overlap: Object.freeze({
    groups: Object.freeze([
      Object.freeze({ id: 'sleep', members: Object.freeze(['sleep_duration', 'sleep_consistency']) }),
      Object.freeze({ id: 'activity', members: Object.freeze(['steps', 'moderate_activity', 'vigorous_activity', 'strength']) }),
      Object.freeze({ id: 'fitness', members: Object.freeze(['vo2_max', 'rhr', 'moderate_activity', 'vigorous_activity', 'steps']) }),
      Object.freeze({ id: 'body', members: Object.freeze(['lean_body_mass', 'strength']) }),
    ]),
    uniqueVariance: Object.freeze({
      sleep_duration: 0.88,
      sleep_consistency: 0.88,
      steps: 0.58,
      moderate_activity: 0.52,
      vigorous_activity: 0.55,
      strength: 0.72,
      vo2_max: 0.48,
      rhr: 0.55,
      lean_body_mass: 0.8,
    }),
  }),
  aggregation: Object.freeze({
    trimFraction: 0.1,
    minTrimN: 10,
  }),
});

export const METHODOLOGIES = Object.freeze({
  [METHODOLOGY_VERSION]: V1,
});

export function getMethodology(version = METHODOLOGY_VERSION) {
  const m = METHODOLOGIES[version];
  if (!m) throw new Error(`unknown methodology version: ${version}`);
  return m;
}
