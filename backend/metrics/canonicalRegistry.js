/**
 * One product-metric contract. Status is the only promotion switch:
 *   canonical — Overview / snapshot / daily_metrics read this
 *   shadow    — computed and persisted beside canonical; never the UI number
 *   disabled  — not run
 *
 * V3/V2 engines stay shadow or disabled until an explicit registry edit.
 * Environment flags may enable shadow compute; they must not silently
 * replace the canonical column.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STEPS_ALGORITHM_VERSION } from './steps.js';
import { STEPS_V3_PUBLIC_ARTIFACT_PATH } from './stepsV3Artifact.js';
import { ALGORITHM_VERSION as SLEEP_VERSION } from './sleep.js';
import { sleepV3Mode } from './sleepV3Artifact.js';
import { MODEL_VERSION as ENERGY_V1 } from '../energy/constants.js';
import { hr2Mode, HR2_ALGORITHM_VERSION } from '../hr2/version.js';

const ENERGY_V2_ARTIFACT_PATH = fileURLToPath(
  new URL('../energy/v2/artifact/energy-v2-lgb-runtime.json', import.meta.url),
);

function envFlag(name, allowed, fallback = 'off', env = process.env) {
  const v = String((env || process.env)[name] || fallback).toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

export const HR_EXPECTED_BUCKETS = 288;

/** Env may enable shadow compute. Promotion to canonical is a registry edit. */
function shadowStatus(mode, { on = ['shadow', 'on', 'dual', 'v2'] } = {}) {
  if (on.includes(mode)) return 'shadow';
  return 'disabled';
}

/** Live registry. Call each time: tests flip env without re-importing. */
export function metricRegistry(env = process.env) {
  const hr2 = hr2Mode(env);
  const strain2 = envFlag('FRWHOOP_STRAIN_V2', ['off', 'shadow'], 'off', env);
  const energy3 = envFlag('ENERGY_MODEL_V3', ['off', 'shadow', 'on'], 'off', env);
  const steps2 = 'shadow';
  return {
    hr: {
      id: 'hr',
      status: 'canonical',
      algorithm: 'frwhoop-hr-v1',
      version: 'frwhoop-hr-v1',
      requiredArtifact: null,
      sourceFields: ['bpm', 'heartRate', 'hr'],
      persist: { table: 'daily_physiology_series', column: 'hr_series' },
      ui: 'Average HR (bpm)',
      snapshot: ['metrics.avg_hr_bpm', 'chart.avg_hr'],
    },
    hr_v2: {
      id: 'hr_v2',
      status: shadowStatus(hr2, { on: ['dual', 'v2'] }),
      algorithm: 'frwhoop-hr-v2',
      version: HR2_ALGORITHM_VERSION,
      requiredArtifact: null,
      sourceFields: ['bpm', 'rr_ms'],
      persist: { table: 'daily_metrics', column: 'extras.hr_v2' },
      ui: null,
      snapshot: ['metrics.shadows', 'metrics.confidence.hr_v2'],
    },
    steps: {
      id: 'steps',
      status: 'canonical',
      algorithm: 'frwhoop-steps-v1',
      version: STEPS_ALGORITHM_VERSION,
      requiredArtifact: null,
      sourceFields: ['steps', 'step_cumulative'],
      persist: { table: 'daily_metrics', column: 'steps' },
      ui: 'Steps',
      snapshot: ['metrics.steps'],
    },
    steps_v2: {
      id: 'steps_v2',
      status: steps2 === 'off' ? 'disabled' : 'shadow',
      algorithm: 'frwhoop-steps-v2',
      version: 'frwhoop-steps-v2',
      requiredArtifact: null,
      sourceFields: ['imuRecords', 'steps', 'step_cumulative'],
      persist: { table: 'daily_metrics', column: 'extras.steps_v2' },
      ui: null,
      snapshot: ['metrics.shadows', 'metrics.confidence.steps.v2'],
    },
    steps_v3: {
      id: 'steps_v3',
      status: 'shadow',
      algorithm: 'frwhoop-steps-v3',
      version: 'frwhoop-steps-v3-runtime-1',
      requiredArtifact: {
        path: STEPS_V3_PUBLIC_ARTIFACT_PATH,
        schema: 'frwhoop_steps_public_model_v3',
      },
      sourceFields: ['imuRecords'],
      persist: { table: 'daily_metrics', column: 'extras.steps_v3' },
      ui: null,
      snapshot: ['metrics.shadows', 'metrics.confidence.steps.v3'],
    },
    strain: {
      id: 'strain',
      status: 'canonical',
      algorithm: 'frwhoop-strain-v1',
      version: SLEEP_VERSION,
      requiredArtifact: null,
      sourceFields: ['bpm'],
      persist: {
        table: 'daily_metrics',
        column: 'strain_score',
        series: 'daily_physiology_series.strain_series',
      },
      ui: 'Day Strain',
      snapshot: ['metrics.strain_score', 'strain_series'],
    },
    strain_v2: {
      id: 'strain_v2',
      status: strain2 === 'shadow' ? 'shadow' : 'disabled',
      algorithm: 'frwhoop-strain-v2',
      version: 'frwhoop-strain-v2.0.0-shadow',
      requiredArtifact: null,
      sourceFields: ['bpm'],
      persist: { table: 'daily_metrics', column: 'strain_score_v2' },
      ui: null,
      snapshot: ['metrics.strain_score_v2', 'metrics.shadows'],
    },
    energy: {
      id: 'energy',
      status: 'canonical',
      algorithm: 'frwhoop-energy-v1',
      version: ENERGY_V1,
      requiredArtifact: null,
      sourceFields: ['bpm', 'mot', 'motion'],
      persist: { table: 'daily_metrics', columns: ['active_kcal', 'basal_kcal'] },
      ui: 'Energy burned (cal)',
      snapshot: ['metrics.active_kcal', 'metrics.basal_kcal', 'metrics.energy_kcal'],
    },
    energy_v2: {
      id: 'energy_v2',
      status: energyV2ComputeMode(env) === 'shadow' ? 'shadow' : 'disabled',
      algorithm: 'frwhoop-energy-v2',
      version: 'energy-v2.0.0',
      requiredArtifact: {
        path: ENERGY_V2_ARTIFACT_PATH,
        schema: 'energy-v2-lgb-runtime',
      },
      sourceFields: ['bpm', 'mot', 'motion'],
      persist: { table: 'daily_metrics', column: 'extras.energy_v2' },
      ui: null,
      snapshot: ['metrics.shadows.candidates'],
    },
    energy_v3: {
      id: 'energy_v3',
      status: shadowStatus(energy3),
      algorithm: 'frwhoop-energy-v3',
      version: 'energy-v3.1.1-unvalidated',
      requiredArtifact: null,
      sourceFields: ['bpm', 'imuRecords'],
      persist: { table: 'energy_daily', column: 'shadow' },
      ui: null,
      snapshot: ['metrics.confidence.energy_v3'],
    },
    sleep: {
      id: 'sleep',
      status: 'canonical',
      algorithm: 'hybrid-sleep',
      version: SLEEP_VERSION,
      requiredArtifact: null,
      sourceFields: ['bpm', 'gx', 'gy', 'gz', 'rr_ms', 'sleep_stage'],
      persist: {
        table: 'sleep_details',
        also: ['sessions', 'daily_metrics.sleep_*', 'hypnogram'],
      },
      ui: 'Asleep duration (min)',
      snapshot: ['sleep', 'metrics.sleep_total_min'],
    },
    sleep_v3: {
      id: 'sleep_v3',
      status: sleepV3Mode(env) === 'off' ? 'disabled' : 'shadow',
      algorithm: 'sleep_stager_v3',
      version: 'sleep-stager-v3-shadow',
      requiredArtifact: null,
      sourceFields: ['imuRecords', 'ppgRecords', 'rr_ms'],
      persist: { table: 'sleep_details', column: 'shadow_v3' },
      ui: null,
      snapshot: ['sleep.shadow_v3', 'metrics.shadows'],
    },
    rhr: {
      id: 'rhr',
      status: 'canonical',
      algorithm: 'hybrid-sleep',
      version: SLEEP_VERSION,
      requiredArtifact: null,
      sourceFields: ['bpm', 'gx', 'gy', 'gz'],
      persist: { table: 'daily_metrics', column: 'resting_hr_bpm' },
      ui: 'Resting heart rate (bpm)',
      snapshot: ['metrics.resting_hr_bpm'],
    },
    hrv: {
      id: 'hrv',
      status: 'canonical',
      algorithm: 'hybrid-sleep',
      version: SLEEP_VERSION,
      requiredArtifact: null,
      sourceFields: ['rr_ms'],
      persist: { table: 'daily_metrics', column: 'hrv_rmssd_ms' },
      ui: 'Heart rate variability (ms)',
      snapshot: ['metrics.hrv_rmssd_ms'],
    },
    skin_temp: {
      id: 'skin_temp',
      status: 'canonical',
      algorithm: 'frwhoop-skin-temp-v1',
      version: 'frwhoop-skin-temp-v1',
      requiredArtifact: null,
      sourceFields: ['skin_temp_c'],
      persist: {
        table: 'daily_metrics',
        column: 'skin_temp_c',
        series: 'daily_physiology_series.skin_temp_series',
      },
      ui: 'Skin temp (celsius)',
      snapshot: ['metrics.skin_temp_c', 'skin_temp_series'],
    },
    spo2_candidate: {
      id: 'spo2_candidate',
      status: 'shadow',
      algorithm: 'frwhoop-spo2-v18-candidate',
      version: 'frwhoop-spo2/1',
      requiredArtifact: null,
      sourceFields: ['spo2_candidate_pct', 'spo2_raw_byte'],
      persist: { table: 'daily_metrics', column: 'extras.spo2_candidate' },
      ui: null,
      snapshot: ['metrics.spo2_candidate_pct', 'metrics.shadows'],
    },
  };
}

export function metricEntry(id, env = process.env) {
  return metricRegistry(env)[id] || null;
}

export function metricStatus(id, env = process.env) {
  return metricEntry(id, env)?.status || 'disabled';
}

export function isMetricEnabled(id, env = process.env) {
  const status = metricStatus(id, env);
  return status === 'canonical' || status === 'shadow';
}

/** Shadow compute only. Env `on` never replaces V1 product columns. */
export function energyV2ComputeMode(env = process.env) {
  const v = String(env.ENERGY_MODEL_V2 || 'off').toLowerCase();
  return v === 'shadow' || v === 'on' ? 'shadow' : 'off';
}

/** Shadow compute only. Env `on` never replaces V1 product columns. */
export function energyV3ComputeMode(env = process.env) {
  return metricStatus('energy_v3', env) === 'shadow' ? 'shadow' : 'off';
}

export function canonicalIds(env = process.env) {
  return Object.values(metricRegistry(env)).filter((m) => m.status === 'canonical').map((m) => m.id);
}

/**
 * Missing artifacts for enabled (canonical|shadow) metrics.
 * Canonical missing artifacts throw. Shadow missing artifacts are returned
 * so the writer can record a failed metric_run instead of a silent extras blob.
 */
export function inspectRequiredArtifacts(env = process.env) {
  const failures = [];
  for (const metric of Object.values(metricRegistry(env))) {
    if (metric.status === 'disabled' || !metric.requiredArtifact) continue;
    const path = metric.requiredArtifact.path;
    if (!path || !existsSync(path)) {
      const failure = {
        id: metric.id,
        status: metric.status,
        reason: 'artifact_missing',
        path: path || null,
      };
      if (metric.status === 'canonical') {
        const err = new Error(`canonical_artifact_missing:${metric.id}`);
        err.code = 'canonical_artifact_missing';
        err.metric = metric.id;
        err.path = path;
        throw err;
      }
      failures.push(failure);
    }
  }
  return failures;
}

function finite(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Canonical energy: named total, else active + basal. 0 is a real value. */
export function resolveEnergyKcal(metrics = {}) {
  const named = finite(metrics.energy_kcal);
  if (named != null) return named;
  const active = finite(metrics.active_kcal);
  const basal = finite(metrics.basal_kcal);
  if (active == null && basal == null) return null;
  return (active ?? 0) + (basal ?? 0);
}

/** Canonical Steps: strap V1 only. Watch stays on watch_steps. */
export function resolveSteps(metrics = {}) {
  return finite(metrics.steps);
}

function statusOf(value, reason = null) {
  if (value == null) return { status: 'unavailable', reason };
  return { status: 'available', reason: null };
}

function sleepKindOf({ metrics = {}, sleep = [], sessions = [] } = {}) {
  const rows = Array.isArray(sleep) ? sleep : [];
  const sessionRows = (sessions || []).filter((s) => /^(sleep|nap)$/i.test(String(s.kind || '')));
  const states = [
    ...rows.map((row) => row?.persist_state || (row?.is_nap ? 'nap' : 'complete')),
    ...(!rows.length ? sessionRows.map((s) => s?.summary?.persist_state
      || (/nap/i.test(String(s.kind || '')) ? 'nap' : 'complete')) : []),
  ].filter(Boolean);
  const source = rows.length ? 'sleep_details' : (sessionRows.length ? 'sessions' : null);
  if (states.includes('complete')) {
    return { status: 'available', kind: 'complete', source };
  }
  if (states.includes('provisional')) {
    return { status: 'provisional', kind: 'provisional', source };
  }
  if (states.includes('nap')) {
    return { status: 'available', kind: 'nap', source };
  }
  const minutes = finite(metrics.sleep_total_min);
  if (minutes != null) {
    return { status: 'available', kind: 'complete', source: 'daily_metrics' };
  }
  return { status: 'unavailable', kind: 'unavailable', source: null, reason: 'no_sleep_row' };
}

/**
 * Snapshot availability: null means unavailable; numeric 0 is a real value.
 * coverage_pct is 0–100 of expected 5-minute HR buckets when a chart exists.
 */
export function buildAvailability({
  metrics = {},
  chart = [],
  sleep = [],
  sessions = [],
  strainSeries = [],
  skinTempSeries = [],
} = {}) {
  const hrPoints = (Array.isArray(chart) ? chart : [])
    .filter((p) => finite(p?.avg_hr ?? p?.bpm) != null);
  const hrBuckets = hrPoints.length;
  const steps = resolveSteps(metrics);
  const watchSteps = finite(metrics.watch_steps);
  const stepsReason = metrics.confidence?.steps?.status === 'unavailable'
    ? (metrics.confidence?.steps?.unavailable_reason || metrics.confidence?.steps?.status)
    : (steps == null ? 'not_computed' : null);
  const asleep = finite(metrics.sleep_total_min)
    ?? finite(sleep?.[0]?.asleep_min)
    ?? finite(sleep?.[0]?.in_bed_min);
  const sleepAvail = sleepKindOf({ metrics, sleep, sessions });
  const active = finite(metrics.active_kcal);
  const basal = finite(metrics.basal_kcal);
  const energy = resolveEnergyKcal(metrics);
  const strain = finite(metrics.strain_score);
  const rhr = finite(metrics.resting_hr_bpm);
  const hrv = finite(metrics.hrv_rmssd_ms);
  const strainPoints = Array.isArray(strainSeries) ? strainSeries.length : 0;
  return {
    hr: {
      ...statusOf(hrBuckets || null, hrBuckets ? null : 'no_hr_series'),
      coverage_pct: Math.round((1000 * hrBuckets) / HR_EXPECTED_BUCKETS) / 10,
      buckets: hrBuckets,
      expected_buckets: HR_EXPECTED_BUCKETS,
    },
    steps: {
      ...statusOf(steps, stepsReason),
      value: steps,
      source: steps != null ? 'strap' : null,
      watch_steps: watchSteps,
    },
    sleep: {
      ...sleepAvail,
      value: asleep,
    },
    rhr: { ...statusOf(rhr, rhr == null ? 'not_computed' : null), value: rhr },
    hrv: { ...statusOf(hrv, hrv == null ? 'not_computed' : null), value: hrv },
    energy: {
      ...statusOf(energy, energy == null ? 'not_computed' : null),
      active_kcal: active,
      basal_kcal: basal,
      energy_kcal: energy,
    },
    strain: {
      ...statusOf(strain, strain == null ? 'not_computed' : null),
      value: strain,
      series_buckets: strainPoints,
    },
    skin_temp: {
      ...statusOf(finite(metrics.skin_temp_c), metrics.skin_temp_c == null ? 'not_computed' : null),
      value: finite(metrics.skin_temp_c),
      series_buckets: (Array.isArray(skinTempSeries) && skinTempSeries.length
        ? skinTempSeries
        : (Array.isArray(metrics.skin_temp_series) ? metrics.skin_temp_series : [])).length,
    },
  };
}

/** Numeric snapshot values: 0 is valid; only null/NaN means unavailable. */
export function presentMetric(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extrasColumn(column) {
  return typeof column === 'string' && column.startsWith('extras.')
    ? column.slice('extras.'.length)
    : null;
}

/**
 * V1/shadow destinations for a registry entry. Compute still lives in the
 * engine; this is the only place that names the table/column that gets written.
 */
export function persistDestinations(env = process.env) {
  return Object.values(metricRegistry(env))
    .filter((metric) => metric.persist?.table)
    .map((metric) => ({
      id: metric.id,
      status: metric.status,
      table: metric.persist.table,
      column: metric.persist.column || null,
      columns: metric.persist.columns
        || (metric.persist.column ? [metric.persist.column] : []),
      extrasKey: extrasColumn(metric.persist.column),
    }));
}

/**
 * Apply registry-owned daily_metrics columns. `values` is keyed by metric id.
 * `undefined` leaves the field off the row (same as today's omit-on-unavailable).
 */
export function applyDailyMetricsPersist(row = {}, values = {}, env = process.env) {
  const next = { ...row };
  for (const dest of persistDestinations(env)) {
    if (dest.table !== 'daily_metrics') continue;
    if (dest.status === 'disabled') continue;
    if (dest.extrasKey) continue;
    const value = values[dest.id];
    if (value === undefined) continue;
    if (dest.columns.length > 1 && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const col of dest.columns) {
        if (value[col] !== undefined) next[col] = value[col];
      }
      continue;
    }
    if (dest.column) next[dest.column] = value;
  }
  return next;
}
