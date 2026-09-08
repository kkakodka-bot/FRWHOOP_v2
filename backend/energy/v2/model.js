/**
 * Energy v2 learned-model runtime.
 *
 * Loads a versioned model artifact (ridge on IMU+HR minute features with a
 * conformal interval layer) and applies it per minute. Deterministic, pure, no
 * I/O in the prediction path: the artifact is passed in or read once by the
 * caller.
 *
 * Artifact contract (written by the training pipeline, see
 * _energy_v2_research/experiments/model_export/):
 * {
 *   artifact_version: 'energy-v2-ridge-1',
 *   feature_version:  'feat-v2-1',
 *   features: ['enmo_mean', ...],          // exact order
 *   standardize: { mean: {..}, std: {..} },// per-feature
 *   coefficients: { enmo_mean: 0.31, ... },
 *   intercept: 1.62,
 *   target: 'met_gross',
 *   clip: { min: 0.8, max: 18 },           // physiological sanity band (gross MET)
 *   conformal: { q: 1.9, level: 0.9, n_calibration: 1200 }, // |residual| quantile
 *   degradation: { feature_groups: { imu: [...], hr: [...], static: [...] } }
 * }
 */

import { clamp } from '../constants.js';

export const ARTIFACT_VERSIONS = ['energy-v2-ridge-1'];
const ARTIFACT_VERSIONS_SUPPORTED = ARTIFACT_VERSIONS;

/**
 * @param {object} artifact  versioned model artifact
 * @returns null when the artifact is unusable; caller must fall back
 */
export function loadV2Model(artifact) {
  if (!artifact || typeof artifact !== 'object') return null;
  if (!ARTIFACT_VERSIONS.includes(artifact.artifact_version)) return null;
  if (!Array.isArray(artifact.features) || artifact.features.length === 0) return null;
  if (!artifact.coefficients || typeof artifact.coefficients !== 'object') return null;
  const coefSum = artifact.features.reduce((a, f) => a + Math.abs(num(artifact.coefficients[f]) ?? 0), 0);
  if (!Number.isFinite(coefSum)) return null;
  const intercept = num(artifact.intercept);
  if (!Number.isFinite(intercept)) return null;
  return artifact;
}

/**
 * Per-minute prediction with graceful degradation.
 *
 * @returns null when the required feature groups are missing (caller falls back
 *   to the v1 physiology estimator for that minute).
 */
export function predictV2(model, features, { correction = null } = {}) {
  if (!model || !features) return null;
  const values = featureValues(model, features);
  if (!values.usable) return null;
  let z = model.intercept;
  for (const [f, v] of Object.entries(values.std)) {
    if (v == null) continue; // missing groups are skipped; their mass is not invented
    z += (model.coefficients[f] ?? 0) * v;
  }
  let met = z;
  if (correction) met = correction(met, values);
  if (model.clip) met = clamp(met, model.clip.min, model.clip.max);
  if (!Number.isFinite(met)) return null;
  const halfWidth = model.conformal ? num(model.conformal.q) ?? null : null;
  return {
    met,
    interval: halfWidth != null ? { level: model.conformal?.level ?? 0.9, met_low: met - halfWidth, met_high: met + halfWidth } : null,
    missing_groups: values.missingGroups,
  };
}

/** Which feature groups are available for this minute (degradation map). */
export function availableFeatureGroups(model, features) {
  if (!model?.degradation?.feature_groups) return { usable: true, missingGroups: [], std: {} };
  const out = { usable: true, missingGroups: [], std: {} };
  for (const [group, feats] of Object.entries(model.degradation.feature_groups)) {
    const present = feats.filter((f) => featureValue(features, f) != null);
    if (present.length === 0) out.missingGroups.push(group);
  }
  return out;
}

function featureValues(model, features) {
  const std = {};
  const missingGroups = [];
  const groups = model.degradation?.feature_groups;
  if (groups) {
    for (const [group, feats] of Object.entries(groups)) {
      const present = feats.filter((f) => featureValue(features, f) != null);
      if (present.length === 0) missingGroups.push(group);
    }
  }
  // If the IMU group is entirely absent the learned model is not usable for
  // this minute: its strongest inputs are gone and falling back is safer than
  // letting HR extrapolate alone.
  if (groups?.imu && missingGroups.includes('imu')) {
    return { usable: false, std, missingGroups };
  }
  for (const f of model.features) {
    const v = featureValue(features, f);
    const m = model.standardize?.mean?.[f] ?? 0;
    const s = model.standardize?.std?.[f] ?? 1;
    std[f] = v == null ? null : (v - m) / (s || 1);
  }
  return { usable: true, std, missingGroups };
}


/**
 * Compose the flat runtime feature vector the artifact expects, from the
 * minute features (energy/v2/features.js) plus resolved physiology.
 *
 * hrr_frac is computed here (not in the extractor) because it needs the
 * subject's resolved resting/maximum HR. Static physiology terms are appended
 * with their own names so the artifact can treat them as the `static` group.
 */
export function composeRuntimeFeatures(features, physiology, { restBias = 0 } = {}) {
  if (!features) return null;
  const cal = (v) => (v == null ? null : Math.max(0, v - restBias));
  const out = {
    motion: cal(features.motion),
    motionMax: cal(features.motionMax),
    motionStd: features.motionStd ?? null,
    motionActiveFraction: features.motionActiveFraction ?? null,
    hr: features.hr ?? null,
    hrMedian: features.hrMedian ?? null,
    hrMin: features.hrMin ?? null,
    hrMax: features.hrMax ?? null,
    hrStd: features.hrStd ?? null,
    hrSlope: features.hrSlope ?? null,
    hrDelta: features.hrDelta ?? null,
    rmssd: features.rmssd ?? null,
    sdnn: features.sdnn ?? null,
    rrArtifactFraction: features.rrArtifactFraction ?? null,
  };
  if (physiology) {
    out.hrr_frac = hrReserveFractionOf(features.hr, physiology);
    out.strapMotion = cal(features.strapMotion);
    out.strapMotionStd = features.strapMotionStd ?? null;
    out.strapCoverage = features.strapCoverage ?? null;
    out.age = physiology.age ?? null;
    out.sex_male = physiology.sex === 'male' ? 1 : physiology.sex === 'female' ? 0 : null;
    out.weightKg = physiology.weightKg ?? null;
    out.leanPct = physiology.leanMassKg != null && physiology.weightKg
      ? (physiology.leanMassKg / physiology.weightKg) * 100
      : null;
    out.restingHr = physiology.restingHr ?? null;
    out.hrMax = physiology.hrMax ?? null;
  }
  return out;
}

function hrReserveFractionOf(hr, physiology) {
  const h = Number(hr);
  if (!Number.isFinite(h) || !physiology?.restingHr || !physiology?.hrReserve) return null;
  return clamp((h - physiology.restingHr) / physiology.hrReserve, -0.2, 1.3);
}

function featureValue(features, name) {
  const v = features?.[name];
  const n = num(v);
  return Number.isFinite(n) ? n : null;
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
