/**
 * Structured overnight-finalization event log.
 *
 * One JSON line per event, with counts, ids, timestamps, reasons, and the
 * DAILY AGGREGATE scalars the finalization contract requires (RHR, HRV,
 * recovery — one number per user-day). Never raw packet bodies, raw samples,
 * or per-beat health payloads. Pairs with observability/metrics.js counters so
 * `/api/observability` shows rates while a single trace shows the full path.
 */
import { inc } from './metrics.js';

const REDACT = (value) => {
  if (value == null) return value;
  if (typeof value === 'string') {
    return /Bearer\s+\S+/i.test(value) ? value.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]') : value;
  }
  return value;
};

const ALLOWED = new Set([
  'event', 'ts', 'user_id', 'day', 'wake_day', 'device_id', 'trigger', 'cycle_id',
  'state', 'reason_code', 'reason', 'manifest_count', 'object_ids', 'object_id',
  'latest_sensor_at', 'sample_count', 'hr_count', 'hr_coverage_pct', 'rr_sample_count',
  'rr_windows_total', 'rr_windows_used', 'rr_artifact_fraction', 'gravity_coverage',
  'sleep_start_at', 'sleep_end_at', 'sleep_detected', 'sleep_detector', 'fallback_reason',
  'rhr_bpm', 'hrv_ms', 'recovery_pct', 'baseline_maturity', 'algorithm_version',
  'duration_ms', 'stage', 'detail', 'from', 'to', 'attempt', 'fingerprint',
  'deduplicated', 'corrected_count', 'history_complete', 'flushed', 'affected_days',
  'status', 'error', 'readback', 'persisted', 'windows_total', 'windows_used',
  'input_start_at', 'input_end_at', 'pending', 'chunks', 'ok',
  'pg_code', 'retry_class', 'sleep_detected',
]);

export function logOvernightEvent(event, fields = {}) {
  const row = { event, ts: new Date().toISOString() };
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null) continue;
    if (!ALLOWED.has(key)) continue;
    row[key] = REDACT(value);
  }
  inc(`overnight_${event.replace(/\./g, '_')}`);
  const line = JSON.stringify(row);
  try {
    console.log(`[overnight] ${line}`);
  } catch { /* logging must never break the pipeline */ }
  return row;
}
