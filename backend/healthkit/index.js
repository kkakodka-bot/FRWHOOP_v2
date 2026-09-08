export {
  SOURCES,
  SOURCE_POLICY,
  PERMISSION_GROUPS,
  HEALTHKIT_SOURCES,
  classifySource,
  arbitrate,
  policyFor,
  isHealthKitSource,
  isCanonicalSource,
} from './policy.js';

export {
  intervalIoU,
  intervalOf,
  overlapMs,
  classifyWorkoutMatch,
  classifySleepMatch,
  pairIntervals,
  workoutRelationship,
  sleepRelationship,
  DEFAULT_WORKOUT_THRESHOLDS,
  DEFAULT_SLEEP_THRESHOLDS,
} from './reconcile.js';

export {
  ingestHealthKit,
  normalizeMeasurement,
  applyCanonicalDay,
  buildExportPlan,
  syncIdentifier,
  nextSyncVersion,
  primaryWorkouts,
  primarySleep,
  sampleQuality,
  rejectSample,
  validateAppleWatchStepSample,
  appleWatchDeviceFingerprint,
  buildAppleWatchStepBuckets,
  mergeAppleWatchStepBucket,
} from './ingest.js';

export {
  persistHealthKitResult,
  HealthKitPersistError,
  assertDurableIdentities,
  assertDurableStepBuckets,
} from './persist.js';
