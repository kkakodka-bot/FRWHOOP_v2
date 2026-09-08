/** Versioned VO2 Max configuration. Coefficients are cited in docs/vo2-max-methodology.md. */

export const METHODOLOGY_VERSION = 'vo2_v1';
export const MODEL_VERSION = 'vo2_model_v1';
export const FEATURE_VERSION = 'vo2_features_v1';
export const SMOOTHING_VERSION = 'vo2_smooth_v1';

export const TIERS = Object.freeze({
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  PASSIVE: 'PASSIVE',
  GPS_AUGMENTED: 'GPS_AUGMENTED',
  LAB_CALIBRATED: 'LAB_CALIBRATED',
});

export const ELIGIBILITY = Object.freeze({
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  PASSIVE_ELIGIBLE: 'PASSIVE_ELIGIBLE',
  GPS_ELIGIBLE: 'GPS_ELIGIBLE',
  LAB_CALIBRATED: 'LAB_CALIBRATED',
});

export const CONFIDENCE = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
});

const V1 = Object.freeze({
  version: METHODOLOGY_VERSION,
  modelVersion: MODEL_VERSION,
  featureVersion: FEATURE_VERSION,
  smoothingVersion: SMOOTHING_VERSION,
  unit: 'ml/kg/min',
  vo2Clamp: Object.freeze({ min: 15, max: 85 }),
  adultMinAge: 18,
  windows: Object.freeze({
    recoveryDays: 21,
    featureDays: 28,
    featureDaysMax: 42,
    gpsLookbackDays: 90,
  }),
  eligibility: Object.freeze({
    minValidRecoveries: 14,
    recoveryWindowDays: 21,
    gpsMinDurationMin: 15,
    gpsLookbackDays: 90,
    minValidRecovery: 1,
    maxValidRecovery: 100,
  }),
  uth: Object.freeze({
    coefficient: 15.3,
  }),
  tanaka: Object.freeze({
    intercept: 208,
    slope: 0.7,
  }),
  hrMax: Object.freeze({
    minObserved: 110,
    maxObserved: 230,
    spikeCeilingOverTanaka: 10,
    persistDays: 2,
    persistToleranceBpm: 5,
    samplePersistCount: 3,
    samplePersistToleranceBpm: 4,
  }),
  jackson: Object.freeze({
    intercept: 56.363,
    parCoef: 1.921,
    ageCoef: -0.381,
    bmiCoef: -0.754,
    sexCoef: 10.987,
  }),
  passiveBlend: Object.freeze({
    uthWeight: 0.52,
    jacksonWeight: 0.48,
    adjustmentClamp: 4,
    hrvAdjScale: 25,
    hrvAdjClamp: 2,
    expectedHrvIntercept: 80,
    expectedHrvAgeSlope: 0.4,
  }),
  rhr: Object.freeze({ min: 35, max: 110 }),
  hrv: Object.freeze({ min: 10, max: 250 }),
  gps: Object.freeze({
    resampleSec: 5,
    minSegmentSec: 90,
    warmupSec: 90,
    cooldownSec: 90,
    minSpeedMps: 1.6,
    maxSpeedMps: 5.8,
    jumpSpeedMps: 7.5,
    stopSpeedMps: 0.7,
    maxGrade: 0.15,
    minPctHrMax: 0.55,
    maxPctHrMax: 0.95,
    minPctHrr: 0.45,
    maxPctHrr: 0.90,
    maxHrCv: 0.08,
    maxSpeedCv: 0.12,
    summaryQuality: 0.45,
    timeseriesQualityFloor: 0.62,
  }),
  lab: Object.freeze({
    minValue: 20,
    maxValue: 85,
    acceptedModalities: Object.freeze(['gas_exchange_gxt', 'gas_exchange', 'cpet', 'douglas_bag']),
    k0: 0.85,
    halfLifeDays: 180,
  }),
  smoothing: Object.freeze({
    baseGain: 0.35,
    maxWeeklyDeltaPassive: 1.6,
    maxWeeklyDeltaGps: 2.4,
    maxWeeklyDeltaLab: 4.0,
    minGain: 0.12,
    maxGain: 0.85,
  }),
  quality: Object.freeze({
    recoveryTarget: 21,
    workoutTarget: 6,
    gpsSegmentTarget: 4,
  }),
  snapshotCap: 104,
  disclaimer: 'Estimated cardiorespiratory fitness, not a metabolic-cart VO2 Max measurement.',
});

export const METHODOLOGIES = Object.freeze({
  [METHODOLOGY_VERSION]: V1,
});

export function getMethodology(version = METHODOLOGY_VERSION) {
  return METHODOLOGIES[version] || V1;
}
