/**
 * Glue between the pure engine and the rest of the backend.
 *
 * The engine knows nothing about stores, users or HTTP. This module resolves
 * physiology from the profile, runs the engine, and shapes the result for
 * `db.upsertPayload` (which routes it to `engine_ingest_energy`).
 */

import { readFileSync } from 'node:fs';
import { computeEnergyMinutes, aggregateDay, aggregateWorkouts, currentBurnRate } from './engine.js';
import { resolvePhysiology } from './physiology.js';
import { MODEL_VERSION } from './constants.js';
import { computeEnergyMinutesV2, aggregateDayV2, isUsableV2Model, MODEL_VERSION_V2 } from './v2/engine2.js';
import { computeEnergyMinutesV3, aggregateDayV3, MODEL_VERSION_V3 } from './v3/engine3.js';
import { resolvePhysiologyV2 } from './v2/restingHr.js';
import { loadV2Model } from './v2/model.js';
import { loadV2Gbm } from './v2/gbm.js';
import { runShadow } from './shadow.js';

// ---------------------------------------------------------------------------
// Energy v2 integration (feature-flagged).
//
// Modes (env ENERGY_MODEL_V2, default 'off'):
//   off    - v1 only, byte-identical to the historical behavior.
//   shadow - v1 stays authoritative; the v2 estimate is computed side by side
//            and returned in `result.shadow` (never written as minute rows).
//   on     - v2 minutes are authoritative; v1 remains loadable for rollback.
//
// The v2 model artifact is a versioned JSON committed next to the engine
// (energy/v2/artifact/). Row provenance carries model_version so replay can
// regenerate historical outputs with the matching artifact.
function loadV2GbmArtifact(parsed) {
  const m = loadV2Gbm(parsed);
  return m && m.trees && m.trees.length
    ? { ...m, model_version: parsed.artifact_version, conformal: parsed.conformal ?? m.conformal, degradation: parsed.degradation, artifact_version: parsed.artifact_version, feature_version: parsed.feature_version }
    : null;
}

function loadV2RidgeArtifact(parsed) {
  const m = loadV2Model(parsed);
  return m ? { ...m, model_version: parsed.artifact_version, artifact_version: parsed.artifact_version, feature_version: parsed.feature_version } : null;
}

const V2_LGB_ARTIFACT_PATH = new URL('./v2/artifact/energy-v2-lgb-runtime.json', import.meta.url);
const V2_RIDGE_ARTIFACT_PATH = new URL('./v2/artifact/energy-v2-ridge-runtime.json', import.meta.url);

let v2ArtifactCache;
/**
 * Lazily loaded, cached per process. Primary = the LightGBM runtime artifact
 * (significantly better than ridge on the deployable feature set, p=0.037,
 * and more robust to missing HR); ridge is the fallback artifact.
 * null when both are absent/invalid (caller must run the v1 estimator).
 */
export function loadV2ArtifactCached() {
  if (v2ArtifactCache !== undefined) return v2ArtifactCache;
  for (const [path, loader] of [
    [V2_LGB_ARTIFACT_PATH, loadV2GbmArtifact],
    [V2_RIDGE_ARTIFACT_PATH, loadV2RidgeArtifact],
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      const model = loader(parsed);
      if (model) { v2ArtifactCache = model; break; }
    } catch { /* try the next artifact */ }
  }
  if (v2ArtifactCache === undefined) v2ArtifactCache = null;
  return v2ArtifactCache;
}

/** Test hook: null the cached artifact so 'on' mode degrades to v1. */
export function __resetV2ArtifactCache() {
  v2ArtifactCache = undefined;
}

export function v2ModeOf(env = process.env) {
  const v = String(env.ENERGY_MODEL_V2 || 'off').toLowerCase();
  return ['off', 'shadow', 'on'].includes(v) ? v : 'off';
}

export function v3ModeOf(env = process.env) {
  const v = String(env.ENERGY_MODEL_V3 || 'off').toLowerCase();
  return ['off', 'shadow', 'on'].includes(v) ? v : 'off';
}

/** Workout records, in whichever of the several in-repo shapes we were handed. */
function normalizeWorkouts(workouts) {
  return (workouts || []).map((w) => ({
    id: w.id ?? w.session_id ?? null,
    sport: w.sport ?? w.name ?? w.summary?.sport ?? w['Activity name'] ?? null,
    start: w.start ?? w.start_at ?? w['Workout start time'] ?? null,
    end: w.end ?? w.end_at ?? w['Workout end time'] ?? null,
  })).filter((w) => w.start);
}

/**
 * @returns {{physiology, minutes, daily, workouts, rows, live}} `rows` is the
 * DB-shaped minute array; `minutes` keeps the debug payload for tests and logs.
 */
export function computeEnergy({
  samples,
  profile = {},
  prefs = {},
  days = [],
  workouts = [],
  timeZone = 'UTC',
  calibration = null,
  userId = null,
  now = Date.now(),
} = {}) {
  const physiology = resolvePhysiology({ profile, prefs, days, calibration });
  const normalized = normalizeWorkouts(workouts);
  const { minutes, stats } = computeEnergyMinutes({ samples, physiology, workouts: normalized, timeZone });

  return {
    physiology,
    stats,
    minutes,
    daily: aggregateDay(minutes, { now }) || [],
    workouts: aggregateWorkouts(minutes, normalized),
    live: currentBurnRate(minutes, { now }),
    // Only the minute rows are written; daily and workout rollups are recomputed
    // in Postgres from those rows so there is exactly one authoritative path.
    rows: userId ? minutes.map(({ debug, ...row }) => ({ ...row, user_id: userId })) : [],
  };
}

/**
 * Compute energy with the configured model version (v2 feature flag).
 *
 * Mirrors computeEnergy() argument-for-argument; adds `mode` and `artifact`
 * overrides for tests. In 'off' mode this is exactly computeEnergy().
 */
export function computeEnergyV2({
  samples,
  profile = {},
  prefs = {},
  days = [],
  workouts = [],
  timeZone = 'UTC',
  calibration = null,
  userId = null,
  now = Date.now(),
  mode = v2ModeOf(),
  artifact,
} = {}) {
  // v2 layering: when the profile lacks a resting HR, derive one from observed
  // history (the learned model's hrr_frac feature depends on it).
  const physiologyV2 = resolvePhysiologyV2({ profile, prefs, days, calibration });
  const physiology = physiologyV2.physiology;
  const normalized = normalizeWorkouts(workouts);
  const v1 = computeEnergyMinutes({ samples, physiology, workouts: normalized, timeZone });
  // An explicitly-passed artifact (even null) wins; absent -> load the committed one.
  const model = artifact !== undefined ? artifact : loadV2ArtifactCached();

  if (mode === 'off' || !model) {
    return shapeResult({ physiology, minutes: v1.minutes, stats: v1.stats, normalized, userId, now });
  }

  if (!isUsableV2Model(model)) {
    return shapeResult({ physiology, minutes: v1.minutes, stats: v1.stats, normalized, userId, now });
  }
  const v2 = computeEnergyMinutesV2({ samples, physiology, workouts: normalized, timeZone, model });

  if (mode === 'shadow') {
    const shadow = runShadow({
      production: () => ({ minutes: v1.minutes, stats: v1.stats }),
      candidate: () => ({ minutes: v2.minutes, stats: v2.stats }),
      inputs: { samples },
      modelVersion: v1.minutes[0]?.model_version ?? MODEL_VERSION,
      candidateVersion: v2.minutes[0]?.model_version ?? MODEL_VERSION_V2,
    });
    const shaped = shapeResult({ physiology, minutes: v1.minutes, stats: v1.stats, normalized, userId, now });
    shaped.shadow = {
      candidate_model_version: shadow.candidate_version,
      prod_total_kcal: shadow.comparison.prod_total_kcal,
      cand_total_kcal: shadow.comparison.cand_total_kcal,
      delta_total_kcal: Math.round((shadow.comparison.cand_total_kcal - shadow.comparison.prod_total_kcal) * 100) / 100,
      inputs_hash: shadow.inputs_hash,
      produced_at: shadow.produced_at,
    };
    return shaped;
  }

  // mode === 'on': v2 minutes are authoritative; v1 stays loadable for rollback.
  return {
    physiology,
    stats: v2.stats,
    minutes: v2.minutes,
    daily: aggregateDayV2(v2.minutes, { now }) || [],
    workouts: aggregateWorkouts(v2.minutes, normalized),
    live: currentBurnRate(v2.minutes, { now }),
    // The `uncertainty` column is additive and not part of the minute-table
    // schema; drop it from the persisted rows (it stays in `minutes` for APIs).
    rows: userId ? v2.minutes.map(({ uncertainty, ...row }) => ({ ...row, user_id: userId })) : [],
  };
}

/**
 * Energy V3 (placement-aware 6-axis IMU). Default off; shadow first.
 * `on` is implemented but must not be enabled without calorimetry gates.
 */
export function computeEnergyV3({
  samples,
  profile = {},
  prefs = {},
  days = [],
  workouts = [],
  timeZone = 'UTC',
  calibration = null,
  userId = null,
  now = Date.now(),
  mode = v3ModeOf(),
  imuRecords = [],
  wearLocationEvents = prefs.wearLocationEvents || [],
  imuEvidence = null,
} = {}) {
  const v1 = computeEnergy({
    samples, profile, prefs, days, workouts, timeZone, calibration, userId, now,
  });
  if (mode === 'off') return v1;

  const physiology = v1.physiology;
  const normalized = normalizeWorkouts(workouts);
  let v3;
  try {
    v3 = computeEnergyMinutesV3({
      samples,
      physiology,
      workouts: normalized,
      timeZone,
      imuRecords,
      wearLocationEvents,
    });
  } catch (err) {
    if (mode === 'shadow') {
      v1.shadow = {
        candidate_model_version: MODEL_VERSION_V3,
        error: 'v3_exception',
        message: String(err?.message || err).slice(0, 240),
      };
      return v1;
    }
    throw err;
  }

  if (mode === 'shadow') {
    const shadow = runShadow({
      production: () => ({ minutes: v1.minutes, stats: v1.stats }),
      candidate: () => ({ minutes: v3.minutes, stats: v3.stats }),
      inputs: { samples },
      modelVersion: v1.minutes[0]?.model_version ?? MODEL_VERSION,
      candidateVersion: v3.minutes[0]?.model_version ?? MODEL_VERSION_V3,
    });
    v1.shadow = {
      candidate_model_version: shadow.candidate_version,
      prod_total_kcal: shadow.comparison.prod_total_kcal,
      cand_total_kcal: shadow.comparison.cand_total_kcal,
      delta_total_kcal: Math.round((shadow.comparison.cand_total_kcal - shadow.comparison.prod_total_kcal) * 100) / 100,
      inputs_hash: shadow.inputs_hash,
      produced_at: shadow.produced_at,
      estimator_counts: v3.stats.estimator_counts,
      imu_evidence: imuEvidence,
    };
    return v1;
  }

  return {
    physiology,
    stats: v3.stats,
    minutes: v3.minutes,
    daily: aggregateDayV3(v3.minutes, { now }) || [],
    workouts: aggregateWorkouts(v3.minutes, normalized),
    live: currentBurnRate(v3.minutes, { now }),
    rows: userId ? v3.minutes.map(({ debug, ...row }) => ({ ...row, user_id: userId })) : [],
  };
}

function shapeResult({ physiology, minutes, stats, normalized, userId, now }) {
  return {
    physiology,
    stats,
    minutes,
    daily: aggregateDay(minutes, { now }) || [],
    workouts: aggregateWorkouts(minutes, normalized),
    live: currentBurnRate(minutes, { now }),
    rows: userId ? minutes.map(({ debug, ...row }) => ({ ...row, user_id: userId })) : [],
  };
}

/**
 * Payload fragment for `db.upsertPayload`. Empty object when there is nothing to
 * write, so callers can spread it unconditionally.
 */
export function energyPayload(result) {
  if (!result?.rows?.length) return {};
  return { energy_minutes: result.rows };
}

export { MODEL_VERSION, MODEL_VERSION_V2, MODEL_VERSION_V3 };
