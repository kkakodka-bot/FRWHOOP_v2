import { createHash, randomUUID } from 'node:crypto';

export const ALGORITHM_VERSION = '0.1.0';

export function stableUuid(parts) {
  const hex = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function sleepEfficiency(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 1) return n / 100;
  return n;
}

/** Never label raw optical ADC as SpO2 percentage. Missing stays null. */
export function dailyMetricRow({ userId, deviceUuid, metric, provenance, rest, computedAt, algorithmVersion = ALGORITHM_VERSION }) {
  const extras = {};
  if (metric.spo2Red != null) extras.spo2_red_raw_adc = metric.spo2Red;
  if (metric.spo2Ir != null) extras.spo2_ir_raw_adc = metric.spo2Ir;
  return {
    user_id: userId,
    day: metric.day,
    source_device_id: deviceUuid || null,
    charge: metric.recovery ?? null,
    effort: metric.strain ?? null,
    rest: rest ?? null,
    hrv_rmssd_ms: metric.avgHrv ?? null,
    hrv_sdnn_ms: metric.avgSdnn ?? null,
    resting_hr_bpm: metric.restingHr ?? null,
    resp_rate_bpm: metric.respRateBpm ?? null,
    skin_temp_dev_c: metric.skinTempDevC ?? null,
    spo2_pct: metric.spo2Pct ?? null,
    steps: metric.steps ?? null,
    active_kcal: metric.activeKcalEst ?? null,
    sleep_total_min: metric.totalSleepMin ?? null,
    sleep_deep_min: metric.deepMin ?? null,
    sleep_rem_min: metric.remMin ?? null,
    sleep_light_min: metric.lightMin ?? null,
    sleep_efficiency: sleepEfficiency(metric.efficiency),
    exercise_count: metric.exerciseCount ?? null,
    chart_data: {},
    extras,
    confidence: {},
    provenance: provenance || { source: 'frwhoop-derived', device_id: metric.deviceId || null },
    algorithm_version: algorithmVersion,
    computed_at: computedAt,
  };
}

export function sleepSessionRow({ userId, deviceUuid, session, algorithmVersion = ALGORITHM_VERSION }) {
  const start = session.startTsAdjusted ?? session.effectiveStartTs ?? session.startTs;
  const end = session.endTs;
  let segments = [];
  if (session.stagesJSON) {
    try { segments = JSON.parse(session.stagesJSON); } catch { segments = []; }
  }
  return {
    id: stableUuid([userId, session.deviceId || '', 'sleep', String(session.startTs)]),
    user_id: userId,
    device_id: deviceUuid || null,
    kind: 'sleep',
    source: session.source || 'frwhoop',
    external_id: `sleep:${session.deviceId}:${session.startTs}`,
    start_at: new Date(start * 1000).toISOString(),
    end_at: new Date(end * 1000).toISOString(),
    summary: {
      efficiency: session.efficiency ?? null,
      resting_hr: session.restingHr ?? null,
      avg_hrv_rmssd: session.avgHrv ?? null,
    },
    segments,
    quality: {},
    user_modified: Boolean(session.userEdited),
    algorithm_version: algorithmVersion,
  };
}

export function workoutSessionRow({ userId, deviceUuid, workout, algorithmVersion = ALGORITHM_VERSION }) {
  const manual = String(workout.source || '').toLowerCase().includes('manual');
  let zones = [];
  if (workout.zonesJSON) {
    try { zones = JSON.parse(workout.zonesJSON); } catch { zones = []; }
  }
  return {
    id: stableUuid([userId, workout.deviceId || '', 'workout', String(workout.startTs), workout.sport || '']),
    user_id: userId,
    device_id: deviceUuid || null,
    kind: manual ? 'manual_workout' : 'workout',
    source: workout.source || 'frwhoop',
    external_id: `workout:${workout.deviceId}:${workout.startTs}:${workout.sport}`,
    start_at: new Date(workout.startTs * 1000).toISOString(),
    end_at: new Date(workout.endTs * 1000).toISOString(),
    summary: {
      sport: workout.sport,
      duration_s: workout.durationS ?? null,
      avg_hr: workout.avgHr ?? null,
      peak_hr: workout.maxHr ?? null,
      strain: workout.strain ?? null,
      calories_kcal: workout.energyKcal ?? null,
    },
    segments: Array.isArray(zones) ? zones : [],
    quality: {},
    user_modified: Boolean(workout.userEdited),
    algorithm_version: algorithmVersion,
  };
}

export function eventRow({ userId, entry }) {
  const q = String(entry.question || '').toLowerCase();
  let eventType = 'journal';
  let unit = null;
  if (q.includes('caffeine')) { eventType = 'caffeine'; unit = 'mg'; }
  else if (q.includes('hydrat') || q.includes('water')) { eventType = 'hydration'; unit = 'ml'; }
  else if (q.includes('mood')) eventType = 'mood';
  else if (q.includes('cycle')) eventType = 'cycle_start';
  const occurred = `${entry.day}T12:00:00.000Z`;
  return {
    id: stableUuid([userId, entry.deviceId || '', entry.day, entry.question || '']),
    user_id: userId,
    event_type: eventType,
    occurred_at: occurred,
    source: 'manual',
    numeric_value: entry.numericValue ?? null,
    text_value: entry.notes || (eventType === 'journal' ? entry.question : null),
    unit,
    payload: { question: entry.question, answered_yes: entry.answeredYes },
  };
}

export function nextRetryAt(attemptCount, nowMs = Date.now(), jitter = Math.random()) {
  const cap = 60 * 60;
  const base = Math.min(2 ** Math.max(0, attemptCount), cap);
  const delay = base * (0.5 + jitter * 0.5);
  return nowMs + delay * 1000;
}

export const QUEUE_STATES = Object.freeze(['queued', 'signing', 'uploading', 'verifying', 'complete', 'failed']);

export function nextQueueStatus({ status, uploadOk, completeOk, expired }) {
  if (status === 'complete') return 'complete';
  if (status === 'verifying' && completeOk) return 'complete';
  if (status === 'uploading' && uploadOk) return 'verifying';
  if (status === 'signing' && !expired) return 'uploading';
  if (status === 'queued') return 'signing';
  return status;
}

export function newId() {
  return randomUUID();
}
