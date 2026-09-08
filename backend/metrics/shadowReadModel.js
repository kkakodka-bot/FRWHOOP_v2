/**
 * Central shadow/experimental read model.
 *
 * Engines compute and persist. This module only folds already-written
 * extras / confidence / provenance / sleep_details.shadow_v3 into diagnostic
 * rows. It never runs an algorithm and never writes canonical columns.
 */
export const SHADOW_STATUSES = Object.freeze([
  'canonical',
  'shadow',
  'experimental',
  'artifact_missing',
  'input_missing',
  'unavailable',
]);

function finite(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function energyCanonical(metrics = {}) {
  const named = finite(metrics.energy_kcal);
  if (named != null) return named;
  const active = finite(metrics.active_kcal);
  const basal = finite(metrics.basal_kcal);
  if (active == null && basal == null) return null;
  return (active ?? 0) + (basal ?? 0);
}

export function statusFromReason(reason, fallback = 'unavailable') {
  const r = String(reason || '');
  if (!r) return fallback;
  if (/(^|_)artifact|onnx/.test(r)) return 'artifact_missing';
  if (/v20|v21|imu|input|coverage|incomplete|frames/.test(r)) return 'input_missing';
  return 'unavailable';
}

export function compactSleepV3(shadowV3) {
  if (!shadowV3 || typeof shadowV3 !== 'object') return null;
  return {
    mode: shadowV3.mode || null,
    path: shadowV3.path || null,
    fallback: shadowV3.fallback || false,
    fallback_reason: shadowV3.fallback_reason || shadowV3.v3_not_executed_reason || null,
    v3_not_executed_reason: shadowV3.v3_not_executed_reason || shadowV3.fallback_reason || null,
    stager_version: shadowV3.stager_version || shadowV3.provenance?.stager_version || null,
    vs_v2: shadowV3.vs_v2 || shadowV3.vsV2 || null,
    unscored_sec: shadowV3.unscored_sec ?? null,
    modality_coverage: shadowV3.modality_coverage || shadowV3.provenance?.modality_coverage || null,
    calibration_status: shadowV3.calibration_status || shadowV3.provenance?.calibration_status || null,
  };
}

function compactStepsV2(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    total: finite(raw.total),
    status: raw.status || null,
    source_mode: raw.source_mode || null,
    algorithm_version: raw.algorithm_version || null,
    imu_coverage: raw.imu_coverage ?? raw.imu_coverage_seconds ?? null,
    confidence: raw.confidence ?? null,
    fallback: raw.fallback || null,
  };
}

function compactStepsV3(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    total: finite(raw.total),
    status: raw.status || null,
    confidence: raw.confidence ?? null,
    unavailable_reason: raw.unavailable_reason || raw.reason || null,
    coverage: raw.coverage || null,
    algorithm_version: raw.algorithm_version || null,
    artifact_version: raw.artifact_version || null,
    artifact_sha256: raw.artifact_sha256 || null,
  };
}

function candidate({
  id,
  role = 'shadow',
  status,
  canonicalValue = null,
  shadowValue = null,
  algorithm = null,
  version = null,
  coverage = null,
  confidence = null,
  scorability = null,
  artifact = null,
  blocker = null,
}) {
  return {
    id,
    role,
    status,
    canonical_value: canonicalValue,
    shadow_value: shadowValue,
    algorithm,
    version,
    coverage,
    confidence,
    scorability,
    artifact,
    blocker,
  };
}

/**
 * @param {{
 *   metrics?: object,
 *   extras?: object,
 *   confidence?: object,
 *   provenance?: object,
 *   sleep?: object[],
 *   gaps?: object[],
 * }} input  persisted snapshot pieces only
 */
export function buildShadowReadModel({
  metrics = {},
  extras = null,
  confidence = null,
  provenance = null,
  sleep = [],
  gaps = [],
} = {}) {
  const extra = extras || metrics.extras || {};
  const conf = confidence || metrics.confidence || {};
  const prov = provenance || metrics.provenance || extra.provenance || {};
  const stepsV2 = compactStepsV2(extra.steps_v2 || conf.steps?.v2);
  const stepsV3 = compactStepsV3(extra.steps_v3 || conf.steps?.v3);
  const hr2 = extra.hr_v2 || conf.hr_v2 || prov.hr_v2 || null;
  const energyV2 = extra.energy_v2 || extra.energy_v2_shadow || null;
  const energyV2Blocker = extra.energy_v2_blocker || null;
  const energyV3 = extra.energy_v3_shadow || extra.energy_v3 || null;
  const energyV3Blocker = extra.energy_v3_blocker || null;
  const spo2 = extra.spo2_candidate || metrics.spo2_candidate || null;
  const strainV2 = metrics.strain_v2 || extra.strain_v2 || null;
  const sleepRows = Array.isArray(sleep) ? sleep : [];
  const sleepMain = sleepRows.find((s) => s && s.is_nap !== true) || sleepRows[0] || null;
  const sleepV3 = compactSleepV3(sleepMain?.shadow_v3 || extra.sleep_v3);
  const stepsV3Reason = stepsV3?.unavailable_reason || null;
  const sleepReason = sleepV3?.v3_not_executed_reason || sleepV3?.fallback_reason || null;
  const battery = Array.isArray(prov.battery_timeline)
    ? prov.battery_timeline
    : (Array.isArray(metrics.battery_timeline) ? metrics.battery_timeline : []);
  const lastBatt = battery.length ? battery[battery.length - 1] : null;
  const wristGaps = (Array.isArray(gaps) ? gaps : []).filter((g) => /wrist/i.test(String(g.kind || '')));
  const device = extra.device_state && typeof extra.device_state === 'object' ? extra.device_state : {};

  const stepsV3Status = stepsV3Reason
    ? statusFromReason(stepsV3Reason)
    : (stepsV3 && (stepsV3.status === 'ok' || stepsV3.total != null) ? 'shadow' : 'unavailable');
  let sleepStatus = 'unavailable';
  if (sleepV3?.path === 'v3' && !sleepV3.fallback) sleepStatus = 'shadow';
  else if (sleepReason) sleepStatus = statusFromReason(sleepReason);
  else if (sleepV3) sleepStatus = statusFromReason(sleepV3.fallback_reason, 'unavailable');

  const energyV2Status = energyV2Blocker
    ? statusFromReason(energyV2Blocker.reason, 'artifact_missing')
    : (energyV2 ? 'shadow' : 'unavailable');
  const energyV3Status = energyV3Blocker
    ? statusFromReason(energyV3Blocker.reason, 'input_missing')
    : (energyV3 ? 'shadow' : 'unavailable');

  const candidates = [
    candidate({
      id: 'steps_v2',
      status: stepsV2 ? 'shadow' : 'unavailable',
      canonicalValue: finite(metrics.steps),
      shadowValue: finite(stepsV2?.total),
      algorithm: 'frwhoop-steps-v2',
      version: stepsV2?.algorithm_version || 'frwhoop-steps-v2',
      coverage: stepsV2?.imu_coverage ?? null,
      confidence: stepsV2?.confidence ?? null,
      blocker: stepsV2 ? null : 'not_computed',
    }),
    candidate({
      id: 'steps_v3',
      status: stepsV3Status,
      canonicalValue: finite(metrics.steps),
      shadowValue: finite(stepsV3?.total),
      algorithm: 'frwhoop-steps-v3',
      version: stepsV3?.algorithm_version || 'frwhoop-steps-v3-runtime-1',
      coverage: stepsV3?.coverage || null,
      confidence: stepsV3?.confidence ?? null,
      artifact: stepsV3?.artifact_version || (stepsV3Reason && String(stepsV3Reason).startsWith('artifact') ? 'missing' : null),
      blocker: stepsV3Reason,
    }),
    candidate({
      id: 'hr_v2',
      status: hr2 ? 'shadow' : 'unavailable',
      canonicalValue: finite(metrics.avg_hr_bpm),
      shadowValue: finite(hr2?.avg_hr ?? hr2?.avg?.value),
      algorithm: 'frwhoop-hr-v2',
      version: hr2?.algorithm_version || 'frwhoop-hr-v2.0.0',
      coverage: hr2?.coverage_hours ?? hr2?.avg?.coverage_hours ?? null,
      confidence: hr2?.quality_mean ?? hr2?.avg?.quality_mean ?? null,
      blocker: hr2 ? null : 'not_computed',
    }),
    candidate({
      id: 'strain_v2',
      status: finite(metrics.strain_score_v2) != null || strainV2 ? 'shadow' : 'unavailable',
      canonicalValue: finite(metrics.strain_score),
      shadowValue: finite(metrics.strain_score_v2 ?? strainV2?.strain),
      algorithm: 'frwhoop-strain-v2',
      version: strainV2?.algorithmVersion || 'frwhoop-strain-v2.0.0-shadow',
      coverage: strainV2?.coveragePct ?? null,
      scorability: strainV2?.qualityState || null,
      blocker: finite(metrics.strain_score_v2) != null || strainV2 ? null : 'not_computed',
    }),
    candidate({
      id: 'sleep_v3',
      status: sleepStatus,
      canonicalValue: finite(metrics.sleep_total_min ?? sleepMain?.asleep_min),
      shadowValue: sleepV3?.vs_v2 ?? null,
      algorithm: 'sleep_stager_v3',
      version: sleepV3?.stager_version || 'sleep-stager-v3-shadow',
      coverage: sleepV3?.modality_coverage || null,
      scorability: sleepV3?.calibration_status || null,
      artifact: sleepReason && /artifact/.test(sleepReason) ? 'missing' : (sleepV3?.path || null),
      blocker: sleepReason,
    }),
    candidate({
      id: 'energy_v2',
      status: energyV2Status,
      canonicalValue: energyCanonical(metrics),
      shadowValue: finite(energyV2?.cand_total_kcal),
      algorithm: 'frwhoop-energy-v2',
      version: energyV2?.candidate_model_version || energyV2?.model_version || 'energy-v2.0.0',
      artifact: energyV2?.artifact_version || energyV2Blocker?.reason || null,
      blocker: energyV2Blocker?.reason || (energyV2 ? null : 'not_computed'),
    }),
    candidate({
      id: 'energy_v3',
      status: energyV3Status,
      canonicalValue: energyCanonical(metrics),
      shadowValue: finite(energyV3?.cand_total_kcal),
      algorithm: 'frwhoop-energy-v3',
      version: energyV3?.candidate_model_version || 'energy-v3.1.1-unvalidated',
      blocker: energyV3Blocker?.reason || (energyV3 ? null : 'blocked_no_complete_v21'),
    }),
    candidate({
      id: 'spo2_candidate',
      role: 'experimental',
      status: finite(spo2?.spo2_candidate_pct ?? metrics.spo2_candidate_pct) != null
        ? 'experimental'
        : 'unavailable',
      canonicalValue: finite(metrics.spo2_pct),
      shadowValue: finite(spo2?.spo2_candidate_pct ?? metrics.spo2_candidate_pct),
      algorithm: 'frwhoop-spo2-v18-candidate',
      version: spo2?.decoder_version || spo2?.algorithm_version || 'frwhoop-spo2/1',
      coverage: spo2?.coverage || null,
      confidence: spo2?.confidence ?? null,
      blocker: finite(spo2?.spo2_candidate_pct ?? metrics.spo2_candidate_pct) != null
        ? null
        : 'no_candidate',
    }),
  ];

  return {
    candidates,
    device: {
      battery_timeline: battery,
      charging: device.charging ?? lastBatt?.charging ?? null,
      battery_pct: device.battery_pct ?? lastBatt?.pct ?? null,
      on_wrist: device.on_wrist ?? null,
      wrist_gaps: wristGaps.length,
    },
  };
}

export function shadowById(model, id) {
  return (model?.candidates || []).find((row) => row.id === id) || null;
}

export function foldWristState(events = []) {
  let onWrist = null;
  let at = null;
  for (const e of events || []) {
    const id = Number(e?.event_id ?? e?.eventId);
    const name = String(e?.event_name || e?.event_type || '');
    if (id === 9 || /wrist_on/i.test(name) || e?.wrist_on === true) {
      onWrist = true;
      at = e.event_ts ?? e.occurred_at ?? at;
    }
    if (id === 10 || /wrist_off/i.test(name) || e?.wrist_off === true) {
      onWrist = false;
      at = e.event_ts ?? e.occurred_at ?? at;
    }
  }
  return { on_wrist: onWrist, at };
}
