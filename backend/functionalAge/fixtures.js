/** White paper Table 2 profiles. Expected WHOOP Age is published as an approximate delta, not an exact target. */

export const US_MALE_30 = {
  id: 'us_male_30',
  chronologicalAge: 30,
  sex: 'male',
  metrics: {
    sleepDurationHours: 6.35,
    sleepConsistencyPct: 65,
    stepsPerDay: 5200,
    zone13MinPerWeek: 69,
    zone45MinPerWeek: 0,
    strengthMinPerWeek: 0,
    vo2Max: 42.4,
    vo2Source: 'measured',
    restingHrBpm: 67,
    leanBodyMassPct: 73.9,
  },
  expectedAgeDelta: 6,
  expectedBand: [3.5, 9],
};

export const WHOOP_MALE_30 = {
  id: 'whoop_male_30',
  chronologicalAge: 30,
  sex: 'male',
  metrics: {
    sleepDurationHours: 7.0,
    sleepConsistencyPct: 67,
    stepsPerDay: 10900,
    zone13MinPerWeek: 141,
    zone45MinPerWeek: 6,
    strengthMinPerWeek: 46,
    vo2Max: 46.8,
    vo2Source: 'measured',
    restingHrBpm: 58,
    leanBodyMassPct: 81,
  },
  expectedAgeDelta: -1.6,
  expectedBand: [-3.8, 0.4],
};

export const US_FEMALE_30 = {
  id: 'us_female_30',
  chronologicalAge: 30,
  sex: 'female',
  metrics: {
    sleepDurationHours: 6.35,
    sleepConsistencyPct: 65,
    stepsPerDay: 5000,
    zone13MinPerWeek: 46,
    zone45MinPerWeek: 0,
    strengthMinPerWeek: 0,
    vo2Max: 30.2,
    vo2Source: 'measured',
    restingHrBpm: 72,
    leanBodyMassPct: 62.2,
  },
  expectedAgeDelta: 7.5,
  expectedBand: [4.5, 11],
};

export const WHOOP_FEMALE_30 = {
  id: 'whoop_female_30',
  chronologicalAge: 30,
  sex: 'female',
  metrics: {
    sleepDurationHours: 7.3,
    sleepConsistencyPct: 68,
    stepsPerDay: 11500,
    zone13MinPerWeek: 124,
    zone45MinPerWeek: 7,
    strengthMinPerWeek: 56,
    vo2Max: 40.0,
    vo2Source: 'measured',
    restingHrBpm: 63,
    leanBodyMassPct: 73,
  },
  expectedAgeDelta: -1.6,
  expectedBand: [-3.8, 0.4],
};

export const HEALTH_OPTIMIZED_MALE_30 = {
  chronologicalAge: 30,
  sex: 'male',
  metrics: {
    sleepDurationHours: 8,
    sleepConsistencyPct: 70,
    stepsPerDay: 8000,
    zone13MinPerWeek: 100,
    zone45MinPerWeek: 10,
    strengthMinPerWeek: 40,
    vo2Max: 44,
    vo2Source: 'measured',
    restingHrBpm: 60,
    leanBodyMassPct: 80,
  },
};

export const HEALTH_OPTIMIZED_FEMALE_30 = {
  chronologicalAge: 30,
  sex: 'female',
  metrics: {
    sleepDurationHours: 8,
    sleepConsistencyPct: 70,
    stepsPerDay: 8000,
    zone13MinPerWeek: 100,
    zone45MinPerWeek: 10,
    strengthMinPerWeek: 40,
    vo2Max: 38,
    vo2Source: 'measured',
    restingHrBpm: 64,
    leanBodyMassPct: 67,
  },
};

export const PUBLISHED_PROFILES = [US_MALE_30, WHOOP_MALE_30, US_FEMALE_30, WHOOP_FEMALE_30];
