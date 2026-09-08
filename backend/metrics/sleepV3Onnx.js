/**
 * Deterministic ONNX inference for sleep_stager_v3.
 *
 * Production nights spawn a short-lived Node runner so scoreSleep stays
 * synchronous (same contract as V2). Upgrade path: keep a pooled
 * InferenceSession in-process once a trained artifact actually ships.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(here, 'sleepV3OnnxRunner.mjs');

export const ONNX_LOGIT_ATOL = 1e-4;
export const ONNX_PROB_ATOL = 1e-5;

export function onnxFileSha256(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function runSleepV3Onnx(epochs, artifact) {
  const model = artifact?.model;
  if (!model || model.type !== 'onnx') return { ok: false, reason: 'onnx_model_missing' };
  const modelPath = model.path || artifact.onnx_path;
  if (!modelPath || !existsSync(modelPath)) return { ok: false, reason: 'onnx_artifact_missing' };
  const want = model.sha256 || artifact.model_sha256;
  if (want) {
    const got = onnxFileSha256(modelPath);
    if (got !== String(want).toLowerCase()) return { ok: false, reason: 'model_sha256_mismatch' };
  }
  const payload = {
    input_name: model.input_name || 'compact',
    output_name: model.output_name || 'logits',
    compact: epochs.map((e) => e.compactVector || e.compact),
    present: epochs.map((e) => e.compactPresent || e.present),
  };
  const spawned = spawnSync(process.execPath, [RUNNER, modelPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (spawned.status !== 0) {
    const err = String(spawned.stderr || spawned.stdout || '').slice(0, 400);
    if (/Cannot find package 'onnxruntime-node'|ERR_MODULE_NOT_FOUND/i.test(err)) {
      return { ok: false, reason: 'onnxruntime_unavailable' };
    }
    return { ok: false, reason: 'onnx_inference_exception', detail: err };
  }
  try {
    const out = JSON.parse(spawned.stdout);
    if (!out?.ok) return { ok: false, reason: out?.reason || 'onnx_inference_failed' };
    return {
      ok: true,
      logits: out.logits,
      probabilities: out.probabilities,
      argmax: out.argmax,
    };
  } catch {
    return { ok: false, reason: 'onnx_output_unreadable' };
  }
}
