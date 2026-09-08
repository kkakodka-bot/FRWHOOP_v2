/**
 * Sleep stager V3 Node adapter.
 *
 * Canonical production result remains V2 until a participant-held-out PSG
 * model is promoted. This module:
 *   - builds V3 epoch features from B2-derived sensors
 *   - runs a validated ONNX artifact when one exists
 *   - otherwise returns a byte-compatible V2 fallback with path recorded
 *   - never applies V2's hard REM-latency / cycle / transition rules on the
 *     V3 path
 *   - never treats feature_rules / feature_mlp as the production neural V3
 */

import { createHash } from 'node:crypto';
import { stageSession, STAGE_NAMES as V2_STAGE_NAMES } from './sleepStagerV2.js';
import { extractSleepSensors, dataBounds } from './sleepSensors.js';
import {
  FEATURE_SCHEMA_VERSION,
  EPOCH_SEC,
  COMPACT_FEATURE_NAMES,
  FORBIDDEN_V3_FEATURES,
  expandCandidateWindow,
  buildEpochFeatures,
  compactVector,
  compactPresentMask,
  preprocessingContract,
  preprocessingContractSha256,
  assertNoForbiddenV3Features,
} from './sleepFeaturesV3.js';
import { runSleepV3Onnx } from './sleepV3Onnx.js';

export const STAGER_FAMILY = 'sleep_stager_v3';
export const ARTIFACT_SCHEMA = 'frwhoop_sleep_v3_artifact_v1';
export const V3_CONTEXT_PAD_SEC = 45 * 60;
export const NAP_ARCHITECTURE_MAX_SEC = 3 * 3600;
export const STAGES = Object.freeze(['wake', 'light', 'deep', 'rem']);
export const INTERNAL_UNSCORED = 'unscored';
export const PROB_SUM_ATOL = 1e-5;

const PATHS = Object.freeze({
  full: 'v3_full',
  reduced: 'v3_reduced',
  v2: 'sleep_stager_v2',
  hrLegacy: 'legacy_hr_only',
  unavailable: 'model_unavailable',
});

const PRODUCTION_MODEL_TYPES = Object.freeze(['onnx']);
const SYNTHETIC_MODEL_TYPES = Object.freeze(['feature_mlp', 'feature_rules']);

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function softmax(logits, temperature = 1) {
  const t = Math.max(1e-3, Number(temperature) || 1);
  const scaled = logits.map((v) => v / t);
  const max = Math.max(...scaled);
  const exps = scaled.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum);
}

function probsObject(arr) {
  if (!arr) return null;
  return {
    wake: arr[0], light: arr[1], deep: arr[2], rem: arr[3],
    awake: arr[0],
  };
}

export function sleepV3ArtifactSha(artifact) {
  if (!artifact || typeof artifact !== 'object') return null;
  const { artifact_sha256: _claimed, created_at_utc: _ts, ...payload } = artifact;
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fail(reason) {
  return { ok: false, reason };
}

function listHas(allowed, value) {
  if (allowed == null || allowed === '*') return true;
  const list = Array.isArray(allowed) ? allowed : [allowed];
  if (list.includes('*') || list.includes('placement_agnostic')) return true;
  return list.includes(value);
}

function rateAllowed(allowed, hz) {
  if (allowed == null || allowed === '*') return true;
  const list = Array.isArray(allowed) ? allowed : [allowed];
  if (list.includes('*')) return true;
  if (hz == null) return list.includes(null) || list.includes('none');
  return list.includes(hz);
}

export function domainSupported(domain, artifact, { needsPpg = false } = {}) {
  const domains = artifact?.supported_domains;
  if (!Array.isArray(domains) || !domains.length) return fail('artifact_domains_missing');
  const placement = domain?.placement || 'unknown';
  if (placement === 'unknown'
    && !domains.some((d) => listHas(d.placement, 'unknown') || listHas(d.placement, 'placement_agnostic'))) {
    return fail('unknown_placement');
  }
  for (const d of domains) {
    const layoutOk = !needsPpg || listHas(d.signal_layout, domain.signal_layout);
    const familyOk = listHas(d.device_family, domain.device_family || 'unknown');
    const placeOk = listHas(d.placement, placement);
    const rateOk = !needsPpg || rateAllowed(d.native_rate_hz, domain.native_rate_hz);
    if (layoutOk && familyOk && placeOk && rateOk) return { ok: true };
  }
  return fail('unsupported_domain');
}

export function validateSleepV3Artifact(artifact, { allowSynthetic = false } = {}) {
  if (!artifact || typeof artifact !== 'object') return fail('artifact_missing');
  if (artifact.schema !== ARTIFACT_SCHEMA) return fail('artifact_schema_unsupported');
  if (typeof artifact.artifact_version !== 'string' || !artifact.artifact_version.trim()) {
    return fail('artifact_version_missing');
  }
  if (artifact.feature_schema_version !== FEATURE_SCHEMA_VERSION) {
    return fail('feature_schema_mismatch');
  }
  if (!['shadow', 'ready'].includes(artifact.status)) return fail('artifact_not_ready');
  if (artifact.canonical === true) return fail('artifact_must_not_self_promote');
  if (artifact.trained_on === 'synthetic' && !allowSynthetic) {
    return fail('synthetic_not_production');
  }
  if (artifact.trained_on === 'v2_labels') return fail('v2_labels_forbidden_as_truth');
  const compact = artifact.compact_feature_names || artifact.model?.features;
  if (Array.isArray(compact)) {
    const hit = compact.filter((n) => FORBIDDEN_V3_FEATURES.includes(n));
    if (hit.length) return fail('forbidden_v3_features');
  }
  try { assertNoForbiddenV3Features(); } catch { return fail('forbidden_v3_features'); }
  const wantPre = artifact.preprocessing_sha256;
  if (wantPre && wantPre !== preprocessingContractSha256()) {
    return fail('preprocessing_sha256_mismatch');
  }
  if (!wantPre && !allowSynthetic) return fail('preprocessing_sha256_missing');
  if (!artifact.modality_tiers || typeof artifact.modality_tiers !== 'object') {
    return fail('modality_tiers_missing');
  }
  if (!Array.isArray(artifact.supported_domains) || !artifact.supported_domains.length) {
    return fail('artifact_domains_missing');
  }
  const model = artifact.model;
  const allowedTypes = allowSynthetic
    ? [...PRODUCTION_MODEL_TYPES, ...SYNTHETIC_MODEL_TYPES]
    : PRODUCTION_MODEL_TYPES;
  if (!model || !allowedTypes.includes(model.type)) {
    if (model?.type === 'feature_rules' || model?.type === 'feature_mlp') {
      return fail('feature_rules_not_neural_v3');
    }
    if (model?.type === 'multimodal_cnn') return fail('multimodal_cnn_node_unsupported');
    return fail('artifact_model_unsupported');
  }
  if (model.type === 'onnx' && !model.path && !artifact.onnx_path) {
    return fail('onnx_path_missing');
  }
  if (model.type === 'feature_mlp') {
    if (!Array.isArray(model.features) || !model.features.length) return fail('mlp_features_missing');
    if (!Array.isArray(model.weights) || finite(model.bias?.[0]) == null) return fail('mlp_weights_invalid');
  }
  if (artifact.artifact_sha256 && sleepV3ArtifactSha(artifact) !== String(artifact.artifact_sha256).toLowerCase()) {
    return fail('artifact_sha256_mismatch');
  }
  const stages = artifact.stage_label_order || artifact.stages;
  if (stages && JSON.stringify(stages) !== JSON.stringify([...STAGES])) {
    return fail('stage_label_order_mismatch');
  }
  return { ok: true, artifact };
}

function modalitySet(epochs) {
  let ppg = 0;
  let imu = 0;
  let cardiac = 0;
  let n = epochs.length || 1;
  let ood = 0;
  let irreg = 0;
  for (const e of epochs) {
    if (e.masks.ppg) ppg += 1;
    if (e.masks.imu) imu += 1;
    if (e.masks.cardiac > 0.3 || e.masks.hr) cardiac += 1;
    if (e.quality?.morphology_ood) ood += 1;
    if ((e.quality?.ibi_irregularity || 0) > 0.45) irreg += 1;
  }
  return {
    ppg: ppg / n,
    imu: imu / n,
    cardiac: cardiac / n,
    morphology_ood_fraction: ood / n,
    irregular_ibi_fraction: irreg / n,
  };
}

function qualityRouting(epochs) {
  if (!epochs.length) return { dropPpg: true, dropCardiac: true };
  const sqi = epochs.map((e) => e.quality?.ppg_sqi).filter((v) => Number.isFinite(v));
  const miss = epochs.map((e) => e.quality?.ppg_missing_fraction).filter((v) => Number.isFinite(v));
  const sat = epochs.map((e) => e.quality?.ppg_saturation_fraction).filter((v) => Number.isFinite(v));
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 1);
  const dropPpg = mean(sqi) < 0.2 || mean(miss) > 0.5 || mean(sat) > 0.25
    || epochs.filter((e) => e.quality?.morphology_ood).length / epochs.length > 0.4;
  const dropCardiac = epochs.filter((e) => (e.masks?.cardiac || 0) > 0.3
    && (e.quality?.ibi_irregularity || 0) > 0.45).length
    / epochs.length > 0.4;
  return { dropPpg, dropCardiac };
}

function pickTier(coverage, quality, artifact) {
  const tiers = artifact.modality_tiers;
  const order = ['A', 'C', 'B', 'D'];
  for (const name of order) {
    const req = tiers[name];
    if (!req) continue;
    if (quality.dropPpg && (req.ppg || 0) > 0) continue;
    if (quality.dropCardiac && (req.cardiac || 0) > 0) continue;
    if ((req.ppg || 0) <= coverage.ppg
      && (req.imu || 0) <= coverage.imu
      && (req.cardiac || 0) <= coverage.cardiac) {
      return {
        ok: true,
        tier: name,
        path: name === 'A' ? PATHS.full : PATHS.reduced,
        needsPpg: (req.ppg || 0) > 0,
      };
    }
  }
  return { ok: false, reason: 'insufficient_v3_modalities' };
}

function mlpLogits(vector, present, model) {
  const names = model.features;
  const x = names.map((name, i) => {
    const idx = COMPACT_FEATURE_NAMES.indexOf(name);
    const v = idx >= 0 ? vector[idx] : 0;
    const m = present[idx] === 1;
    const mean = Number(model.mean?.[i]) || 0;
    const scale = Number(model.scale?.[i]) || 1;
    return m ? (v - mean) / (scale || 1) : 0;
  });
  const weights = model.weights;
  const bias = model.bias || [0, 0, 0, 0];
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c += 1) {
    let s = Number(bias[c]) || 0;
    const w = weights[c] || [];
    for (let i = 0; i < x.length; i += 1) s += (Number(w[i]) || 0) * x[i];
    out[c] = s;
  }
  return out;
}

function rulesLogits(epoch) {
  const c = epoch.compact;
  const move = finite(c.enmo_mean) ?? finite(c.jerk_rms) ?? 0;
  const hr = finite(c.hr_mean);
  const hrv = finite(c.rmssd);
  const wake = 1.5 * move;
  const deep = -1.2 * move + (hrv != null ? -0.01 * (hrv - 40) : 0) + (hr != null ? -0.02 * (hr - 52) : 0);
  const rem = -0.4 * move + (hrv != null ? 0.015 * (hrv - 30) : 0);
  const light = 0.2;
  return [wake, light, deep, rem];
}

function viterbiLearned(emissions, transition) {
  if (!emissions.length) return [];
  const logT = transition.map((row) => row.map((p) => Math.log(Math.max(p, 1e-9))));
  let values = emissions[0].slice();
  const back = [];
  for (let t = 1; t < emissions.length; t += 1) {
    const next = [0, 0, 0, 0];
    const ptr = [0, 0, 0, 0];
    for (let to = 0; to < 4; to += 1) {
      let best = values[0] + logT[0][to];
      let arg = 0;
      for (let from = 1; from < 4; from += 1) {
        const v = values[from] + logT[from][to];
        if (v > best) { best = v; arg = from; }
      }
      next[to] = best + emissions[t][to];
      ptr[to] = arg;
    }
    values = next;
    back.push(ptr);
  }
  let last = 0;
  for (let i = 1; i < 4; i += 1) if (values[i] > values[last]) last = i;
  const path = [last];
  for (let i = back.length - 1; i >= 0; i -= 1) {
    last = back[i][last];
    path.push(last);
  }
  return path.reverse();
}

function inferEpochs(epochs, artifact) {
  const model = artifact.model;
  const calibrated = artifact.calibration?.status === 'calibrated';
  const temperature = calibrated ? (finite(artifact.calibration?.temperature) || 1) : 1;
  const emissions = [];
  const probs = [];
  if (model.type === 'onnx') {
    const packed = epochs.map((epoch) => ({
      compact: compactVector(epoch.compact),
      present: compactPresentMask(epoch.compact),
    }));
    const inf = runSleepV3Onnx(packed, artifact);
    if (!inf.ok) return inf;
    for (let i = 0; i < epochs.length; i += 1) {
      emissions.push(inf.logits[i]);
      probs.push(inf.probabilities[i]);
    }
  } else {
    for (const epoch of epochs) {
      let logits;
      if (model.type === 'feature_mlp') {
        logits = mlpLogits(compactVector(epoch.compact), compactPresentMask(epoch.compact), model);
      } else if (model.type === 'feature_rules') {
        logits = rulesLogits(epoch);
      } else {
        return { ok: false, reason: 'artifact_model_unsupported' };
      }
      emissions.push(logits);
      probs.push(softmax(logits, temperature));
    }
  }
  let labels;
  if (Array.isArray(artifact.transition) && artifact.transition.length === 4) {
    labels = viterbiLearned(emissions, artifact.transition);
  } else {
    labels = emissions.map((row) => row.indexOf(Math.max(...row)));
  }
  return { ok: true, labels, probs, logits: emissions, temperature, calibrated };
}

function segmentsFromEpochs(epochs, labels, windowStart, windowEnd) {
  const segs = [];
  for (let i = 0; i < epochs.length; i += 1) {
    const stage = labels[i];
    const start = i === 0 ? windowStart : epochs[i].start;
    const end = i === epochs.length - 1 ? windowEnd : epochs[i + 1].start;
    const last = segs.at(-1);
    if (last?.stage === stage) last.end = end;
    else segs.push({ start, end, stage });
  }
  return segs;
}

function v2Segments(args) {
  return stageSession({
    start: args.start,
    end: args.end,
    gravity: args.gravity,
    hr: args.hr,
    rr: args.rr,
  });
}

function strongMovement(epoch) {
  const j = epoch.compact.jerk_rms;
  const e = epoch.compact.enmo_mean;
  return (Number.isFinite(j) && j > 0.08) || (Number.isFinite(e) && e > 0.05);
}

export function overlayWakeIfEvidenced(stages, start, end, sourceBouts, epochs) {
  const parts = [...(sourceBouts || [])]
    .filter((b) => b.end > start && b.start < end)
    .sort((a, b) => a.start - b.start);
  if (parts.length < 2) return stages;
  const byStart = new Map(epochs.map((e) => [e.start, e]));
  const out = [];
  for (const seg of stages) out.push({ ...seg });
  for (let i = 0; i < parts.length - 1; i += 1) {
    const lo = Math.max(start, parts[i].end);
    const hi = Math.min(end, parts[i + 1].start);
    if (hi - lo < 60) continue;
    for (let t = Math.ceil(lo / EPOCH_SEC) * EPOCH_SEC; t < hi; t += EPOCH_SEC) {
      const ep = byStart.get(t);
      const force = ep && (ep.offWrist || strongMovement(ep));
      if (!force) continue;
      const stage = ep.offWrist ? INTERNAL_UNSCORED : 'wake';
      out.push({ start: t, end: Math.min(hi, t + EPOCH_SEC), stage, _overlay: true });
    }
  }
  if (!out.some((s) => s._overlay)) return stages;
  out.sort((a, b) => a.start - b.start || (a._overlay ? 1 : -1));
  const merged = [];
  for (const seg of out) {
    const last = merged.at(-1);
    const stage = seg.stage;
    const a = { start: seg.start, end: seg.end, stage };
    if (!merged.length) { merged.push(a); continue; }
    if (seg._overlay) {
      if (a.start < last.end) last.end = a.start;
      if (last.end <= last.start) merged.pop();
      const prev = merged.at(-1);
      if (prev?.stage === stage && prev.end === a.start) prev.end = a.end;
      else merged.push(a);
      continue;
    }
    if (last.stage === stage && last.end === a.start) last.end = a.end;
    else if (a.start >= last.end) merged.push(a);
  }
  return merged.filter((s) => s.end > s.start);
}

function applyOffWristUnscored(labels, epochs) {
  return labels.map((stage, i) => (epochs[i].offWrist || !epochs[i].sufficient
    ? INTERNAL_UNSCORED
    : stage));
}

function confusion(a, b) {
  const names = [...STAGES, INTERNAL_UNSCORED];
  const matrix = Object.fromEntries(names.map((r) => [r, Object.fromEntries(names.map((c) => [c, 0]))]));
  const n = Math.min(a.length, b.length);
  let agree = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] === 'awake' ? 'wake' : a[i];
    const y = b[i] === 'awake' ? 'wake' : b[i];
    if (matrix[x] && matrix[x][y] != null) matrix[x][y] += 1;
    if (x === y) agree += 1;
  }
  return { matrix, agreement: n ? agree / n : null, n };
}

function labelAt(segments, t) {
  const seg = segments.find((s) => t >= s.start && t < s.end);
  const stage = seg?.stage || INTERNAL_UNSCORED;
  return stage === 'awake' ? 'wake' : stage;
}

function sessionDomain(epochs, sensors, extras = {}) {
  const withPpg = epochs.find((e) => e.domain?.native_rate_hz);
  const d = withPpg?.domain || epochs[0]?.domain || {};
  return {
    device_family: extras.deviceFamily || sensors.deviceFamily || d.device_family || 'unknown',
    firmware: extras.firmware || sensors.firmware || d.firmware || 'unknown',
    signal_layout: d.signal_layout || sensors.ppg?.[0]?.layout || 'none',
    native_rate_hz: d.native_rate_hz || sensors.ppg?.[0]?.hz || null,
    placement: extras.placement || extras.wearLocation || sensors.placement || 'unknown',
    decoder_version: d.decoder_version || sensors.ppg?.[0]?.decoder_version || null,
  };
}

function entropy(probs) {
  if (!probs) return null;
  let h = 0;
  for (const p of probs) {
    if (p > 0) h -= p * Math.log(p);
  }
  return h;
}

function v2FallbackResult({
  v2, reason, provenanceBase, path = PATHS.v2,
}) {
  return {
    ok: true,
    path,
    fallback: true,
    fallback_reason: reason,
    v3_not_executed_reason: reason,
    stages: v2,
    epochs: [],
    epochProbabilities: null,
    vsV2: null,
    telemetry: { fallback_reason: reason },
    provenance: {
      ...provenanceBase,
      stager_version: `sleep-stager-v3-fallback-${reason || 'unavailable'}`,
      used: path,
      calibration_status: 'uncalibrated',
    },
  };
}

function minuteDiff(v2Labels, v3Labels) {
  const names = [...STAGES, INTERNAL_UNSCORED];
  const diff = Object.fromEntries(names.map((s) => [s, 0]));
  const n = Math.min(v2Labels.length, v3Labels.length);
  for (let i = 0; i < n; i += 1) {
    diff[v3Labels[i]] = (diff[v3Labels[i]] || 0) + 0.5;
    diff[v2Labels[i]] = (diff[v2Labels[i]] || 0) - 0.5;
  }
  return diff;
}

export function stageSessionV3({
  start,
  end,
  gravity = [],
  hr = [],
  rr = [],
  samples = [],
  imuRecords = [],
  ppgRecords = [],
  events = [],
  wristOff = [],
  sourceBouts = [],
  tzOffsetSeconds = 0,
  timeZone = null,
  isNap = false,
  artifact = null,
  allowSynthetic = false,
  expand = true,
  placement = 'unknown',
  deviceFamily = null,
  firmware = null,
} = {}) {
  const t0 = Date.now();
  const v2 = v2Segments({ start, end, gravity, hr, rr });
  const mem = typeof process !== 'undefined' && process.memoryUsage ? process.memoryUsage().heapUsed : null;
  const provenanceBase = {
    stager_family: STAGER_FAMILY,
    feature_schema_version: FEATURE_SCHEMA_VERSION,
    preprocessing_sha256: preprocessingContractSha256(),
    decoder_lineage: ppgRecords[0]?.decoder?.lineage || imuRecords[0]?.decoder?.lineage || null,
    modality_coverage: null,
    candidate_window: null,
    detector_window: { start, end },
    nap_reduced_confidence: false,
    calibration_version: artifact?.calibration?.version || null,
    calibration_status: artifact?.calibration?.status || 'uncalibrated',
    model_version: artifact?.artifact_version || null,
  };

  let validated;
  try {
    validated = validateSleepV3Artifact(artifact, { allowSynthetic });
  } catch (error) {
    return v2FallbackResult({
      v2, reason: 'inference_exception', provenanceBase,
    });
  }
  if (!validated.ok) {
    return v2FallbackResult({ v2, reason: validated.reason, provenanceBase });
  }

  try {
    const sensors = extractSleepSensors({
      samples, imuRecords, ppgRecords, events, wristOff, placement, deviceFamily, firmware,
    });
    if (!sensors.gravity.length && gravity.length) sensors.gravity = gravity;
    if (!sensors.hr.length && hr.length) sensors.hr = hr;
    if (!sensors.rr.length && rr.length) sensors.rr = rr;

    const bounds = dataBounds(sensors);
    const window = expand
      ? expandCandidateWindow(start, end, bounds, V3_CONTEXT_PAD_SEC)
      : { start, end };
    const epochs = buildEpochFeatures(sensors, window.start, window.end, {
      tzOffsetSeconds, timeZone,
    });
    const coverage = modalitySet(epochs);
    const napSession = isNap && (end - start) < NAP_ARCHITECTURE_MAX_SEC
      && artifact?.nap_validated !== true;
    provenanceBase.modality_coverage = coverage;
    provenanceBase.candidate_window = window;
    provenanceBase.nap_reduced_confidence = napSession;

    const quality = qualityRouting(epochs);
    const tier = pickTier(coverage, quality, artifact);
    if (!tier.ok) {
      return v2FallbackResult({ v2, reason: tier.reason, provenanceBase });
    }

    const domain = sessionDomain(epochs, sensors, { placement, deviceFamily, firmware, wearLocation: placement });
    const layouts = [...new Set((sensors.ppg || []).map((p) => p.layout).filter(Boolean))];
    if (layouts.includes('v26') && layouts.includes('whoop4-1921')) {
      return v2FallbackResult({ v2, reason: 'mixed_ppg_layouts', provenanceBase });
    }
    const domainOk = domainSupported(domain, artifact, { needsPpg: tier.needsPpg });
    if (!domainOk.ok) {
      return v2FallbackResult({ v2, reason: domainOk.reason, provenanceBase });
    }

    const inferred = inferEpochs(epochs, artifact);
    if (!inferred.ok) {
      return v2FallbackResult({ v2, reason: inferred.reason, provenanceBase });
    }

    let named = inferred.labels.map((i) => STAGES[i] || INTERNAL_UNSCORED);
    if (napSession) {
      named = named.map((stage) => (stage === 'wake' ? 'wake' : INTERNAL_UNSCORED));
    }
    const masked = applyOffWristUnscored(named, epochs);
    let stages = segmentsFromEpochs(epochs, masked, window.start, window.end);
    stages = overlayWakeIfEvidenced(stages, window.start, window.end, sourceBouts, epochs);

    const v2Labels = epochs.map((e) => labelAt(v2, e.start + 15));
    const v3Labels = epochs.map((e) => labelAt(stages, e.start + 15));
    const vs = confusion(v2Labels, v3Labels);
    const entropies = inferred.probs.map((p) => entropy(p)).filter((v) => v != null);
    const peakMem = typeof process !== 'undefined' && process.memoryUsage
      ? process.memoryUsage().heapUsed
      : null;

    const epochRows = epochs.map((e, i) => {
      const unscored = masked[i] === INTERNAL_UNSCORED;
      return {
        start: e.start,
        stage: masked[i],
        probs: unscored ? null : probsObject(inferred.probs[i]),
        masks: e.masks,
        quality: {
          flags: e.quality.ppg_flags,
          off_wrist: e.offWrist,
          ibi_irregularity: e.quality.ibi_irregularity,
          rr_artifact_fraction: e.quality.rr_artifact_fraction,
          ppg_sqi: e.quality.ppg_sqi,
          ppg_saturation_fraction: e.quality.ppg_saturation_fraction,
          ppg_missing_fraction: e.quality.ppg_missing_fraction,
          motion_contamination: e.quality.motion_contamination,
          morphology_ood: e.quality.morphology_ood,
        },
        coverage: (e.masks.ppg + e.masks.imu + (e.masks.hr ? 1 : 0)) / 3,
        domain: e.domain,
      };
    });

    return {
      ok: true,
      path: tier.path,
      fallback: false,
      fallback_reason: null,
      v3_not_executed_reason: null,
      stages,
      epochs: epochRows,
      epochProbabilities: epochRows.map((e) => ({
        start: e.start, stage: e.stage, probs: e.probs,
      })),
      vsV2: vs.matrix,
      unscored_sec: epochs.filter((_, i) => masked[i] === INTERNAL_UNSCORED).length * EPOCH_SEC,
      telemetry: {
        candidate_window_sec: window.end - window.start,
        v3_version: artifact.artifact_version,
        artifact_hash: artifact.artifact_sha256 || sleepV3ArtifactSha(artifact),
        preprocessing_hash: preprocessingContractSha256(),
        device_family: domain.device_family,
        firmware: domain.firmware,
        placement: domain.placement,
        ppg_layout: domain.signal_layout,
        ppg_rate_hz: domain.native_rate_hz,
        ppg_coverage: coverage.ppg,
        imu_coverage: coverage.imu,
        rr_hr_coverage: coverage.cardiac,
        off_wrist_min: Math.round(epochs.filter((e) => e.offWrist).length * EPOCH_SEC / 60),
        unscored_min: Math.round(epochs.filter((_, i) => masked[i] === INTERNAL_UNSCORED).length * EPOCH_SEC / 60),
        selected_modality_tier: tier.tier,
        fallback_reason: null,
        inference_ms: Date.now() - t0,
        peak_memory_bytes: peakMem != null && mem != null ? Math.max(peakMem, mem) : peakMem,
        v2_v3_epoch_agreement: vs.agreement,
        v2_v3_stage_minute_diff: minuteDiff(v2Labels, v3Labels),
        probability_entropy_mean: entropies.length ? entropies.reduce((a, b) => a + b, 0) / entropies.length : null,
        low_quality_ood_fraction: coverage.morphology_ood_fraction,
      },
      provenance: {
        ...provenanceBase,
        stager_version: `sleep-stager-v3-${artifact.artifact_version}`,
        used: tier.path,
        modality_tier: tier.tier,
        domain,
        calibration_temperature: inferred.temperature,
        calibration_status: inferred.calibrated ? 'calibrated' : 'uncalibrated',
        nap_stage_policy: napSession ? 'wake_or_unscored' : 'four_stage',
      },
    };
  } catch (error) {
    return v2FallbackResult({
      v2,
      reason: 'inference_exception',
      provenanceBase: {
        ...provenanceBase,
        inference_error: String(error?.message || error).slice(0, 200),
      },
    });
  }
}

export function toySleepV3Artifact() {
  const artifact = {
    schema: ARTIFACT_SCHEMA,
    schema_version: 1,
    artifact_version: 'toy-test-1',
    feature_schema_version: FEATURE_SCHEMA_VERSION,
    status: 'shadow',
    canonical: false,
    trained_on: 'synthetic',
    nap_validated: false,
    preprocessing_sha256: preprocessingContractSha256(),
    preprocessing: preprocessingContract(),
    compact_feature_names: [...COMPACT_FEATURE_NAMES],
    stage_label_order: [...STAGES],
    modality_tiers: {
      A: { ppg: 0.5, imu: 0.5, cardiac: 0.5 },
      B: { imu: 0.3, cardiac: 0.3 },
      C: { ppg: 0.3, cardiac: 0.3 },
      D: { cardiac: 0.3 },
    },
    supported_domains: [{
      device_family: ['whoop5', 'whoop_mg', 'unknown', '*'],
      signal_layout: ['v26', 'none', '*'],
      placement: ['wrist', 'unknown', 'placement_agnostic'],
      native_rate_hz: [25, 50, null, '*'],
    }],
    calibration: { version: 'none', temperature: 1, status: 'uncalibrated' },
    model: { type: 'feature_rules', rule: 'motion_wake_else_light' },
  };
  return { ...artifact, artifact_sha256: sleepV3ArtifactSha(artifact) };
}

export {
  V2_STAGE_NAMES,
  PATHS,
  preprocessingContract,
  preprocessingContractSha256,
};
