/**
 * Energy V3 learned-model runtime (ridge / two-stage).
 *
 * Artifacts are versioned JSON next to this file. Missing groups are not
 * median-filled: the caller falls back to V1. Gyro is a separate model, never
 * a fabricated zero.
 */

import { readFileSync } from 'node:fs';
import { clamp } from '../constants.js';

export const ARTIFACT_VERSION = 'energy-v3-ridge-1';
const ARTIFACT_PATH = new URL('./artifact/energy-v3-runtime.json', import.meta.url);

let cached;

export function loadV3Artifact(parsed) {
  const a = parsed && typeof parsed === 'object' ? parsed : null;
  if (!a || a.artifact_version !== ARTIFACT_VERSION) return null;
  if (!a.models || typeof a.models !== 'object') return null;
  return a;
}

export function loadV3ArtifactCached() {
  if (cached !== undefined) return cached;
  try {
    cached = loadV3Artifact(JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')));
  } catch {
    cached = null;
  }
  return cached;
}

export function __resetV3ArtifactCache() {
  cached = undefined;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function standardized(model, features) {
  const mean = model.standardize?.mean || {};
  const std = model.standardize?.std || {};
  const row = [];
  for (const f of model.features) {
    const x = num(features[f] ?? features.imu?.[f]);
    if (x == null) return null;
    const s = num(std[f]) || 1;
    row.push((x - (num(mean[f]) || 0)) / s);
  }
  return row;
}

export function predictRidge(model, features) {
  if (!model?.features?.length || !Array.isArray(model.coef)) return null;
  const z = standardized(model, features);
  if (!z) return null;
  let y = num(model.intercept) ?? 0;
  for (let i = 0; i < z.length; i++) y += (model.coef[i] ?? 0) * z[i];
  if (model.clip) y = clamp(y, model.clip.min, model.clip.max);
  return Number.isFinite(y) ? y : null;
}

/**
 * Two-stage: linear sedentary classifier, then sedentary or active ridge.
 * Missing classifier features → null (V1 fallback), never a guessed class.
 */
export function predictTwoStage(model, features) {
  if (!model?.classifier || !model?.sedentary || !model?.active) return null;
  const z = standardized(model.classifier, features);
  if (!z) return null;
  let logit = num(model.classifier.intercept) ?? 0;
  for (let i = 0; i < z.length; i++) logit += (model.classifier.coef[i] ?? 0) * z[i];
  const pSed = 1 / (1 + Math.exp(-logit));
  const branch = pSed >= (model.sedentary_threshold ?? 0.5) ? model.sedentary : model.active;
  const met = predictRidge(branch, features);
  if (met == null) return null;
  return { met, p_sedentary: pSed, branch: pSed >= (model.sedentary_threshold ?? 0.5) ? 'sedentary' : 'active' };
}

export function predictFamily(artifact, family, features, { allowGyro = false } = {}) {
  if (!artifact) return null;
  const gyroModel = allowGyro ? artifact.gyro_models?.[family] : null;
  const model = gyroModel || artifact.models?.[family];
  if (!model) return null;
  if (model.kind === 'two_stage' || (model.classifier && model.sedentary && model.active)) {
    const r = predictTwoStage(model, features);
    return r ? { met: r.met, extra: r, used_gyro: Boolean(gyroModel) } : null;
  }
  const met = predictRidge(model, features);
  return met == null ? null : { met, extra: null, used_gyro: Boolean(gyroModel) };
}

export function composeV3Features(imu, seriesFeatures, physiology) {
  const hr = num(seriesFeatures?.hr);
  const hrr = (hr != null && physiology?.restingHr && physiology?.hrReserve)
    ? clamp((hr - physiology.restingHr) / physiology.hrReserve, -0.2, 1.3)
    : null;
  const band = num(imu?.bandpass_motion_auc_20hz ?? imu?.mims_mean);
  return {
    ...imu,
    imu,
    hr,
    hr_mean: hr,
    hrr_frac: hrr,
    hrStd: num(seriesFeatures?.hrStd),
    bandpass_motion_auc_20hz: band,
    mims_mean: band,
  };
}
