import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  sleepV3ArtifactSha,
  validateSleepV3Artifact,
} from './sleepStagerV3.js';
import { onnxFileSha256 } from './sleepV3Onnx.js';

let cachedKey = null;
let cachedResult = null;

export function sleepV3Mode(env = process.env) {
  const raw = String(env?.FRWHOOP_SLEEP_V3 || 'shadow').trim().toLowerCase();
  if (raw === 'off' || raw === 'v2' || raw === 'false' || raw === '0') return 'off';
  if (raw === 'beta') return 'beta';
  return 'shadow';
}

export function sleepV3BetaAllowlist(env = process.env) {
  return String(env?.FRWHOOP_SLEEP_V3_BETA_USERS || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function sleepV3UserEnrolled(userId, env = process.env) {
  if (sleepV3Mode(env) !== 'beta') return false;
  const list = sleepV3BetaAllowlist(env);
  if (!list.length || userId == null) return false;
  return list.includes(String(userId));
}

export function shouldComputeSleepV3(env = process.env) {
  return sleepV3Mode(env) !== 'off';
}

/** V3 never replaces V2 columns. Beta only selects the candidate for enrolled testers. */
export function shouldSurfaceSleepV3({ userId, artifactOk } = {}, env = process.env) {
  return sleepV3Mode(env) === 'beta'
    && sleepV3UserEnrolled(userId, env)
    && artifactOk === true;
}

/**
 * Optional production artifact. There is no bundled public V3 model until a
 * participant-held-out PSG run wins. Unset path → V2 fallback in shadow.
 */
export function loadSleepV3Artifact({
  path = process.env.FRWHOOP_SLEEP_V3_ARTIFACT || null,
  expectedSha256 = process.env.FRWHOOP_SLEEP_V3_ARTIFACT_SHA256 || null,
  allowSynthetic = false,
} = {}) {
  if (!path) {
    cachedKey = '<missing>';
    cachedResult = {
      ok: false, artifact: null, path: null, sha256: null,
      reason: 'artifact_missing',
    };
    return cachedResult;
  }
  try {
    const text = readFileSync(path, 'utf8');
    const contentSha256 = createHash('sha256').update(text).digest('hex');
    const key = `${path}:${expectedSha256 || '<self-pinned>'}:${contentSha256}`;
    if (key === cachedKey && cachedResult) return cachedResult;
    const artifact = JSON.parse(text);
    if (artifact?.model?.type === 'onnx' && artifact.model.path) {
      const modelSha = onnxFileSha256(artifact.model.path);
      if (artifact.model.sha256 && modelSha !== String(artifact.model.sha256).toLowerCase()) {
        cachedKey = key;
        cachedResult = {
          ok: false, artifact: null, path, sha256: null, reason: 'model_sha256_mismatch',
        };
        return cachedResult;
      }
    }
    const validation = validateSleepV3Artifact(artifact, { allowSynthetic });
    const sha256 = validation.ok ? sleepV3ArtifactSha(artifact) : null;
    const want = expectedSha256 ? String(expectedSha256).trim().toLowerCase() : null;
    const hashMatches = !want || sha256 === want;
    cachedKey = key;
    cachedResult = validation.ok && hashMatches
      ? { ok: true, artifact, path, sha256, reason: null }
      : {
        ok: false, artifact: null, path, sha256,
        reason: validation.ok ? 'artifact_sha256_mismatch' : validation.reason,
      };
  } catch (error) {
    cachedKey = null;
    cachedResult = {
      ok: false, artifact: null, path, sha256: null,
      reason: error?.code === 'ENOENT' ? 'artifact_not_found' : 'artifact_unreadable',
    };
  }
  return cachedResult;
}

export function clearSleepV3ArtifactCache() {
  cachedKey = null;
  cachedResult = null;
}
