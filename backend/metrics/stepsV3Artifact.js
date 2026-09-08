import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  stepsV3ArtifactSha,
  validateStepsV3Artifact,
} from './stepsV3.js';

export const STEPS_V3_FIXTURE_ARTIFACT_PATH = fileURLToPath(
  new URL('../models/steps_v3/fixture-logistic-v1.json', import.meta.url),
);
export const STEPS_V3_PUBLIC_ARTIFACT_PATH = fileURLToPath(
  new URL('../models/steps_v3/public-v1.json', import.meta.url),
);

let cachedKey = null;
let cachedResult = null;

/**
 * Load and validate one immutable JSON artifact. Production defaults to the
 * checked-in public artifact and may pin an override with FRWHOOP_STEPS_V3_ARTIFACT;
 * tests may opt into the bundled tiny fixture.
 */
export function loadStepsV3Artifact({
  path = process.env.FRWHOOP_STEPS_V3_ARTIFACT || null,
  expectedSha256 = process.env.FRWHOOP_STEPS_V3_ARTIFACT_SHA256 || null,
  allowFixture = process.env.NODE_ENV === 'test',
} = {}) {
  const resolvedPath = path || (allowFixture
    ? STEPS_V3_FIXTURE_ARTIFACT_PATH
    : STEPS_V3_PUBLIC_ARTIFACT_PATH);
  const normalizedExpected = expectedSha256 ? String(expectedSha256).trim().toLowerCase() : null;
  if (!resolvedPath) {
    cachedKey = '<missing>';
    cachedResult = { ok: false, artifact: null, path: null, sha256: null, reason: 'artifact_not_configured' };
    return cachedResult;
  }

  try {
    const text = readFileSync(resolvedPath, 'utf8');
    const contentSha256 = createHash('sha256').update(text).digest('hex');
    const key = `${resolvedPath}:${normalizedExpected || '<self-pinned>'}:${contentSha256}`;
    if (key === cachedKey && cachedResult) return cachedResult;
    const bundled = resolvedPath === STEPS_V3_FIXTURE_ARTIFACT_PATH
      || resolvedPath === STEPS_V3_PUBLIC_ARTIFACT_PATH;
    if (!bundled && !normalizedExpected) {
      cachedKey = key;
      cachedResult = {
        ok: false,
        artifact: null,
        path: resolvedPath,
        sha256: null,
        reason: 'artifact_expected_sha256_required',
      };
      return cachedResult;
    }
    const artifact = JSON.parse(text);
    const validation = validateStepsV3Artifact(artifact);
    const sha256 = validation.ok ? stepsV3ArtifactSha(artifact) : null;
    const hashMatches = !normalizedExpected || sha256 === normalizedExpected;
    cachedKey = key;
    cachedResult = validation.ok && hashMatches
      ? {
        ok: true,
        artifact,
        path: resolvedPath,
        sha256,
        reason: null,
      }
      : {
        ok: false,
        artifact: null,
        path: resolvedPath,
        sha256,
        reason: validation.ok ? 'artifact_sha256_mismatch' : validation.reason,
      };
  } catch (error) {
    cachedKey = null;
    cachedResult = {
      ok: false,
      artifact: null,
      path: resolvedPath,
      sha256: null,
      reason: error?.code === 'ENOENT' ? 'artifact_not_found' : 'artifact_unreadable',
    };
  }
  return cachedResult;
}

export function clearStepsV3ArtifactCache() {
  cachedKey = null;
  cachedResult = null;
}
