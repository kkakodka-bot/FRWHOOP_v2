// Protocol consumption registry — every HIGH-confidence decoded field must
// declare a downstream disposition. "Decoder exists" is not a consumer.
//
// Dispositions:
//   canonical_metric_input  — feeds a versioned product metric reducer
//   analytics_input         — feeds sleep/workout/energy/quality engines
//   device_state            — strap/device status (battery, wear, charging)
//   control_plane           — sync/transport/offload (not a health metric)
//   research_archive        — B2/full arrays; not a physiology label
//   candidate_unpromoted    — structurally parsed; withheld from canonical health
//   intentionally_ignored   — decoded and explicitly unused

import { inc } from '../observability/metrics.js';

export const CONSUMPTION_REGISTRY_VERSION = 'frwhoop-consumption/1';

export const DISPOSITIONS = Object.freeze([
  'canonical_metric_input',
  'analytics_input',
  'device_state',
  'control_plane',
  'research_archive',
  'candidate_unpromoted',
  'intentionally_ignored',
]);

export const CONFIDENCE = Object.freeze({
  HIGH: 'HIGH',
  CANDIDATE: 'CANDIDATE',
  UNKNOWN: 'UNKNOWN',
});

function f(spec) {
  return Object.freeze({
    consumers: [],
    ...spec,
  });
}

/** One row per decoded field/layout that FRWHOOP currently knows. */
export const PROTOCOL_CONSUMPTION = Object.freeze([
  f({
    id: 'type40.hr', packet: 40, layout: 'realtime',
    confidence: CONFIDENCE.HIGH, disposition: 'canonical_metric_input',
    ios: 'WhoopProtocol.decodePuffinRealtime40', queue: 'SensorQueue.append (live)',
    backend: 'bpm', b2: 'physiology ndjson', supabase: 'daily_physiology_series / daily_metrics',
    analytics: 'hr/hrv/strain/sleep', frontend: 'day snapshot bpm_data',
  }),
  f({
    id: 'type40.rr', packet: 40, layout: 'realtime',
    confidence: CONFIDENCE.HIGH, disposition: 'canonical_metric_input',
    ios: 'decodePuffinRealtime40', queue: 'live rr_ms',
    backend: 'rr_ms', b2: 'physiology ndjson', supabase: 'HRV path',
    analytics: 'hrv (RR only, never from HR)', frontend: 'recovery/HRV',
  }),
  f({
    id: 'type47.v18.timestamp', packet: 47, layout: 'v18',
    confidence: CONFIDENCE.HIGH, disposition: 'canonical_metric_input',
    ios: 'HistoricalSample.sensorTimestamp', queue: 'sensor_ts',
    backend: 'sensor_ts / t', b2: 'physiology', supabase: 'series keys',
    analytics: 'all timed reducers', frontend: 'day charts',
  }),
  f({
    id: 'type47.v18.record_index', packet: 47, layout: 'v18',
    confidence: CONFIDENCE.HIGH, disposition: 'control_plane',
    ios: 'HistoricalSample.recordIndex', queue: 'record_index',
    backend: 'record_index', b2: 'physiology', supabase: null,
    analytics: 'drain/order diagnostics', frontend: null,
  }),
  f({
    id: 'type47.v18.hr', packet: 47, layout: 'v18',
    confidence: CONFIDENCE.HIGH, disposition: 'canonical_metric_input',
    ios: 'HistoricalSample.bpm', queue: 'bpm',
    backend: 'bpm', b2: 'physiology', supabase: 'daily_metrics.avg_hr_bpm',
    analytics: 'hr/sleep/strain', frontend: 'bpm_data',
  }),
  f({
    id: 'type47.v18.rr', packet: 47, layout: 'v18',
    confidence: CONFIDENCE.HIGH, disposition: 'canonical_metric_input',
    ios: 'rrMs', queue: 'rr_ms', backend: 'rr_ms', b2: 'physiology',
    supabase: 'HRV', analytics: 'hrv', frontend: 'recovery',
  }),
  f({
    id: 'type47.v18.dynamic_acceleration', packet: 47, layout: 'v18',
    confidence: CONFIDENCE.HIGH, disposition: 'analytics_input',
    ios: 'dynamicAcceleration', queue: 'dyn_accel',
    backend: 'dyn_accel', b2: 'physiology', supabase: null,
    analytics: 'workoutDetector / sleepFeaturesV3 / energy', frontend: 'workout/sleep via backend',
  }),
  f({
    id: 'type47.v18.gravity', packet: 47, layout: 'v18',
    confidence: CONFIDENCE.HIGH, disposition: 'analytics_input',
    ios: 'gx/gy/gz', queue: 'gx/gy/gz', backend: 'gx/gy/gz', b2: 'physiology',
    supabase: null, analytics: 'sleep stillness / energy', frontend: null,
  }),
  f({
    id: 'type47.v18.step_cumulative', packet: 47, layout: 'v18',
    confidence: CONFIDENCE.HIGH, disposition: 'canonical_metric_input',
    ios: 'stepCounter', queue: 'step_cumulative',
    backend: 'step_cumulative', b2: 'physiology', supabase: 'daily_metrics.steps',
    analytics: 'steps v1 reducer (canonical); v2/v3 shadow', frontend: 'overview steps',
  }),
  f({
    id: 'type47.v18.cadence', packet: 47, layout: 'v18',
    confidence: CONFIDENCE.HIGH, disposition: 'analytics_input',
    ios: 'stepCadence', queue: 'step_cadence',
    backend: 'step_cadence', b2: 'physiology', supabase: null,
    analytics: 'stepsV3 / workoutDetectV2 / sleepSensors', frontend: null,
  }),
  f({
    id: 'type47.v18.activity_class', packet: 47, layout: 'v18',
    confidence: CONFIDENCE.HIGH, disposition: 'analytics_input',
    ios: 'activityClass', queue: 'activity_class',
    backend: 'activity_class', b2: 'physiology', supabase: null,
    analytics: 'stepsV3Calibration / sleepSensors', frontend: null,
  }),
  f({
    id: 'type47.v18.skin_temp', packet: 47, layout: 'v18',
    confidence: CONFIDENCE.HIGH, disposition: 'canonical_metric_input',
    ios: 'skinTempC / skinTempRaw', queue: 'skin_temp_c',
    backend: 'skin_temp_c', b2: 'physiology', supabase: 'daily_metrics.skin_temp_c',
    analytics: 'temperature.js', frontend: 'skin temp',
  }),
  f({
    id: 'type47.v18.band_sleep_state', packet: 47, layout: 'v18',
    confidence: CONFIDENCE.HIGH, disposition: 'analytics_input',
    ios: 'bandSleepState', queue: 'band_sleep_state',
    backend: 'band_sleep_state', b2: 'physiology', supabase: null,
    analytics: 'sleepDetection (not a sleep-stage label)', frontend: 'sleep quality via backend',
  }),
  f({
    id: 'type47.v18.onwrist_bits', packet: 47, layout: 'v18',
    confidence: CONFIDENCE.CANDIDATE, disposition: 'intentionally_ignored',
    ios: 'onWrist always nil', queue: null,
    backend: 'raw sleep_state_byte in gen5 only', b2: 'Level A',
    supabase: null, analytics: null, frontend: null,
    note: 'v18 @81 bits 0-1 contested; wear comes from type-48 events 9/10',
  }),
  f({
    id: 'type47.v18.byte82_spo2', packet: 47, layout: 'v18',
    confidence: CONFIDENCE.CANDIDATE, disposition: 'candidate_unpromoted',
    ios: 'spo2_state/raw only', queue: 'spo2_*',
    backend: 'spo2_candidate shadow', b2: 'physiology', supabase: 'shadow only',
    analytics: 'spo2 candidate, never SpO2%', frontend: null,
  }),
  f({
    id: 'type47.v21.accel_xyz', packet: 47, layout: 'v21',
    confidence: CONFIDENCE.HIGH, disposition: 'research_archive',
    ios: 'Level A frames; compact features on HistoricalSample',
    queue: 'ble-frames.ndjson + compact IMU fields',
    backend: 'accel_*_raw in imu_raw + whoop5_imu_v21',
    b2: 'imu_raw / whoop5_imu_v21', supabase: 'manifest only',
    analytics: 'compact features → sleep/energy/stepsV2 shadow', frontend: null,
  }),
  f({
    id: 'type47.v21.gyro_xyz_raw', packet: 47, layout: 'v21',
    confidence: CONFIDENCE.HIGH, disposition: 'research_archive',
    ios: 'gyro RMS raw on compact sample', queue: 'gyro_rms_raw',
    backend: 'gyro_*_raw', b2: 'imu_raw / whoop5_imu_v21', supabase: 'manifest',
    analytics: 'gyro RMS (raw LSB); dps scale is reference-only', frontend: null,
    note: 'gyro °/s scale is REFERENCE_CORROBORATED (NOOP 2000/32768), not physically pinned on this strap',
  }),
  f({
    id: 'type47.v21.compact_motion', packet: 47, layout: 'v21',
    confidence: CONFIDENCE.HIGH, disposition: 'analytics_input',
    ios: 'enmo/accel_rms/stillness', queue: 'enmo_mean / accel_rms_g / stillness_fraction',
    backend: 'features on imu records + physiology compact fields',
    b2: 'imu record.features', supabase: null,
    analytics: 'sleepFeaturesV3 / energy v3 shadow / workout dyn_accel for v21-only seconds',
    frontend: 'sleep/workout via backend',
  }),
  f({
    id: 'type47.v21.accel_scale', packet: 47, layout: 'v21',
    confidence: CONFIDENCE.HIGH, disposition: 'analytics_input',
    ios: '1/4096 g/LSB', queue: null, backend: 'ACCEL_SCALE_G_PER_LSB',
    b2: 'record.accel.scale', supabase: null, analytics: 'ENMO/VM', frontend: null,
  }),
  f({
    id: 'type47.v26.waveform', packet: 47, layout: 'v26',
    confidence: CONFIDENCE.HIGH, disposition: 'research_archive',
    ios: 'Level A only (raw-only on phone)', queue: 'ble-frames.ndjson',
    backend: 'whoop5_ppg_v26.samples (24 i16)', b2: 'whoop5_ppg_v26 + ppg_raw PIP',
    supabase: 'manifest', analytics: 'ppg waveform features / signal quality',
    frontend: null, note: 'never SpO2; no wavelength identity',
  }),
  f({
    id: 'type47.v26.ppg_features', packet: 47, layout: 'v26',
    confidence: CONFIDENCE.HIGH, disposition: 'analytics_input',
    ios: null, queue: null, backend: 'features on ppg v26 records',
    b2: 'whoop5_ppg_v26.features', supabase: null,
    analytics: 'signal-quality / research layer', frontend: null,
  }),
  f({
    id: 'type47.v20.blocks', packet: 47, layout: 'v20',
    confidence: CONFIDENCE.HIGH, disposition: 'research_archive',
    ios: 'Level A only', queue: 'ble-frames.ndjson',
    backend: 'whoop5_optical_v20 block_0..4 channel_a/b',
    b2: 'whoop5_optical_v20', supabase: 'manifest',
    analytics: 'coverage/amplitude diagnostics only', frontend: null,
    note: 'neutral v20_block_* / channel_*; no wavelength, no SpO2',
  }),
  f({
    id: 'type43.r21_imu', packet: 43, layout: 'v21-shape',
    confidence: CONFIDENCE.HIGH, disposition: 'research_archive',
    ios: 'shared v21 IMU decoder; compact features; not cmd-63 flood',
    queue: 'ble-frames + compact historical row (drain-time only)',
    backend: 'same decodeWhoop5ImuV21 as type 47', b2: 'imu_raw + whoop5_imu_v21',
    supabase: 'manifest', analytics: 'same compact motion as v21', frontend: null,
    note: 'identified by 1244 B + countA/countB, not seq byte == 21',
  }),
  f({
    id: 'type43.harvard_1917', packet: 43, layout: 'whoop4-1917',
    confidence: CONFIDENCE.HIGH, disposition: 'research_archive',
    ios: 'motionFromRealtime compact millig only', queue: 'ble-frames',
    backend: 'imu_raw rt43_imu', b2: 'imu_raw', supabase: 'manifest',
    analytics: 'stepsV2/energy when present', frontend: null,
  }),
  f({
    id: 'type43.harvard_1921', packet: 43, layout: 'whoop4-1921',
    confidence: CONFIDENCE.HIGH, disposition: 'research_archive',
    ios: null, queue: 'ble-frames', backend: 'ppg_raw', b2: 'ppg_raw',
    supabase: 'manifest', analytics: 'PPG research', frontend: null,
  }),
  f({
    id: 'type48.event3_battery', packet: 48, layout: 'event/3',
    confidence: CONFIDENCE.HIGH, disposition: 'device_state',
    ios: 'EventSample → battery % + SensorQueue event', queue: 'gaps/live battery + frames',
    backend: 'events.battery_pct/mV/counter', b2: 'events', supabase: 'extras.battery_timeline',
    analytics: 'battery timeline (not health)', frontend: 'existing battery indicator',
  }),
  f({
    id: 'type48.event9_wrist_on', packet: 48, layout: 'event/9',
    confidence: CONFIDENCE.HIGH, disposition: 'device_state',
    ios: 'endGap wrist_off', queue: 'gaps.ndjson',
    backend: 'events WRIST_ON', b2: 'events', supabase: null,
    analytics: 'sleepSensors wristOffIntervals', frontend: 'wear quality via sleep',
  }),
  f({
    id: 'type48.event10_wrist_off', packet: 48, layout: 'event/10',
    confidence: CONFIDENCE.HIGH, disposition: 'device_state',
    ios: 'beginGap wrist_off', queue: 'gaps.ndjson',
    backend: 'events WRIST_OFF', b2: 'events', supabase: 'ingest_gaps',
    analytics: 'sleep/nonwear/dayCompleteness', frontend: 'coverage/quality',
  }),
  f({
    id: 'type48.event7_8_charging', packet: 48, layout: 'event/7-8',
    confidence: CONFIDENCE.HIGH, disposition: 'device_state',
    ios: 'EventSample.charging', queue: 'frames + local flag',
    backend: 'event_name CHARGING_*', b2: 'events', supabase: null,
    analytics: 'dayCompleteness nonwear/charging; skin temp charging gate', frontend: null,
  }),
  f({
    id: 'type48.event14_double_tap', packet: 48, layout: 'event/14',
    confidence: CONFIDENCE.HIGH, disposition: 'device_state',
    ios: 'EventSample.doubleTap (logged)', queue: 'frames',
    backend: 'DOUBLE_TAP', b2: 'events', supabase: null,
    analytics: null, frontend: null, note: 'no product haptic side effect from this event',
  }),
  f({
    id: 'type48.event29_110', packet: 48, layout: 'event/29+110',
    confidence: CONFIDENCE.CANDIDATE, disposition: 'candidate_unpromoted',
    ios: 'sync hint only (any type 48 catch-up)', queue: 'frames',
    backend: 'structural event_body', b2: 'events', supabase: null,
    analytics: null, frontend: null, note: 'rate-limited new-data hint; not a health metric',
  }),
  f({
    id: 'type48.event63_i16x3', packet: 48, layout: 'event/63',
    confidence: CONFIDENCE.CANDIDATE, disposition: 'candidate_unpromoted',
    ios: null, queue: 'frames', backend: 'i16x3_raw body', b2: 'events',
    supabase: null, analytics: null, frontend: null,
    note: 'NOT accelerometer; conflicting evidence',
  }),
  f({
    id: 'type49.metadata', packet: 49, layout: 'HISTORY_*',
    confidence: CONFIDENCE.HIGH, disposition: 'control_plane',
    ios: 'HistoricalMetadata start/end/complete', queue: 'ACK after durable append',
    backend: 'trim cursor', b2: 'frames', supabase: null,
    analytics: null, frontend: null,
  }),
  f({
    id: 'type50.console', packet: 50, layout: 'console',
    confidence: CONFIDENCE.HIGH, disposition: 'research_archive',
    ios: 'logged around ACK', queue: 'ble-frames',
    backend: 'console_logs', b2: 'console_logs', supabase: null,
    analytics: null, frontend: null,
  }),
  f({
    id: 'type54.puffin_events', packet: 54, layout: 'kinds 2/9/19/20',
    confidence: CONFIDENCE.HIGH, disposition: 'research_archive',
    ios: 'no live side effects', queue: 'ble-frames',
    backend: 'puffin_event_54', b2: 'events', supabase: null,
    analytics: 'never live wrist/sleep', frontend: null,
  }),
  f({
    id: 'cmd22_23_history', packet: 36, layout: 'cmd 22/23',
    confidence: CONFIDENCE.HIGH, disposition: 'control_plane',
    ios: 'SEND_HISTORICAL_DATA + ACK after durable append',
    queue: 'history NDJSON', backend: 'historyBuffer', b2: 'physiology',
    supabase: 'recompute days', analytics: null, frontend: null,
    note: 'plain cmd-22 is the fast path; no 10 rec/s cap; do not chase cmd 96',
  }),
  f({
    id: 'cmd20_abort', packet: 35, layout: 'cmd 20',
    confidence: CONFIDENCE.HIGH, disposition: 'control_plane',
    ios: 'available graceful drain exit', queue: null, backend: null, b2: null,
    supabase: null, analytics: null, frontend: null,
  }),
  f({
    id: 'cmd96_enter_hfs', packet: 35, layout: 'cmd 96',
    confidence: CONFIDENCE.HIGH, disposition: 'intentionally_ignored',
    ios: 'never sent', queue: null, backend: null, b2: null,
    supabase: null, analytics: null, frontend: null,
    note: 'never observed; not a bulk-sync path',
  }),
  f({
    id: 'cmd97_exit_hfs', packet: 35, layout: 'cmd 97',
    confidence: CONFIDENCE.HIGH, disposition: 'control_plane',
    ios: 'EXIT_HIGH_FREQ_SYNC payload [0] on first arm', queue: null,
    backend: null, b2: null, supabase: null, analytics: null, frontend: null,
    note: 'production payload is [0] only; num_rec mapping is research-only',
  }),
  f({
    id: 'cmd97_num_rec_payload', packet: 35, layout: 'cmd 97 payload N≠0',
    confidence: CONFIDENCE.CANDIDATE, disposition: 'candidate_unpromoted',
    ios: 'not sent', queue: null, backend: null, b2: null,
    supabase: null, analytics: null, frontend: null,
  }),
  f({
    id: 'event98_hfs_disabled', packet: 48, layout: 'event/98',
    confidence: CONFIDENCE.HIGH, disposition: 'control_plane',
    ios: 'archived type 48', queue: 'frames', backend: 'events', b2: 'events',
    supabase: null, analytics: null, frontend: null,
  }),
  f({
    id: 'cmd26_battery_poll', packet: 36, layout: 'cmd 26',
    confidence: CONFIDENCE.HIGH, disposition: 'device_state',
    ios: 'GATT 2A19 + cmd 26', queue: 'live battery',
    backend: 'cmd_battery', b2: 'cmd_battery', supabase: 'extras.battery_timeline',
    analytics: null, frontend: 'battery indicator',
  }),
  f({
    id: 'cmd34_data_range', packet: 36, layout: 'cmd 34',
    confidence: CONFIDENCE.HIGH, disposition: 'control_plane',
    ios: 'GET_DATA_RANGE → pages behind / strap ahead', queue: null,
    backend: null, b2: 'frames', supabase: null,
    analytics: 'drain scheduling (not a health metric)', frontend: null,
  }),
  f({
    id: 'wut_cursors', packet: 36, layout: 'W/U/T pages',
    confidence: CONFIDENCE.HIGH, disposition: 'control_plane',
    ios: 'DataRangePages', queue: null, backend: null, b2: null,
    supabase: null, analytics: 'sync diagnostics', frontend: null,
    note: 'logical history page units, not fixed flash bytes',
  }),
  f({
    id: 'type51_live_imu', packet: 51, layout: 'v21-shape',
    confidence: CONFIDENCE.CANDIDATE, disposition: 'research_archive',
    ios: 'motionFromLive51 gated lab', queue: 'ble-frames',
    backend: 'imu_raw rt51', b2: 'imu_raw', supabase: 'manifest',
    analytics: 'gated', frontend: null,
  }),
  f({
    id: 'type52_hist_imu', packet: 52, layout: 'v21-shape',
    confidence: CONFIDENCE.CANDIDATE, disposition: 'research_archive',
    ios: null, queue: 'ble-frames', backend: 'imu_raw hist52_v21',
    b2: 'imu_raw', supabase: 'manifest', analytics: 'same IMU path if v21', frontend: null,
  }),
  f({
    id: 'type53_55_relative', packet: 53, layout: 'relative',
    confidence: CONFIDENCE.UNKNOWN, disposition: 'research_archive',
    ios: null, queue: 'ble-frames', backend: 'structural envelope',
    b2: 'frames/events', supabase: null, analytics: null, frontend: null,
  }),
  f({
    id: 'crc_invalid_frames', packet: null, layout: 'any',
    confidence: CONFIDENCE.HIGH, disposition: 'research_archive',
    ios: 'archived, no HistoricalSample', queue: 'ble-frames',
    backend: 'crc_failed, no physiology', b2: 'Level A', supabase: null,
    analytics: 'must not alter canonical metrics', frontend: null,
  }),
]);

export function highConfidenceFields() {
  return PROTOCOL_CONSUMPTION.filter((row) => row.confidence === CONFIDENCE.HIGH);
}

export function missingDisposition(rows = PROTOCOL_CONSUMPTION) {
  return rows.filter((row) => !DISPOSITIONS.includes(row.disposition));
}

export function implicitHighFields(rows = PROTOCOL_CONSUMPTION) {
  return rows.filter((row) => row.confidence === CONFIDENCE.HIGH && !row.disposition);
}

const CONSUMPTION_COUNTERS = Object.freeze([
  'protocol_frames_by_type',
  'protocol_decoded_ok',
  'protocol_decode_fail',
  'protocol_normalized_records',
  'protocol_persisted_records',
  'protocol_research_archived',
  'protocol_candidates_withheld',
  'protocol_unsupported_layouts',
  'protocol_consumed_steps',
  'protocol_consumed_temperature',
  'protocol_consumed_sleep',
  'protocol_consumed_workout',
  'protocol_consumed_energy',
  'protocol_consumed_battery',
  'protocol_consumed_wear',
  'protocol_consumed_imu_features',
  'protocol_consumed_ppg_features',
]);

export { CONSUMPTION_COUNTERS };

export function noteConsumption(name, n = 1) {
  inc(name, n);
}

export function noteDeriveSession(session = {}) {
  noteConsumption('protocol_decoded_ok', session.crc_valid_frames || 0);
  noteConsumption('protocol_decode_fail', session.crc_invalid_frames || 0);
  noteConsumption('protocol_normalized_records',
    (session.imu_records || 0) + (session.ppg_records || 0) + (session.events || 0)
    + (session.whoop5_imu_v21 || 0) + (session.whoop5_ppg_v26 || 0) + (session.whoop5_optical_v20 || 0));
  noteConsumption('protocol_research_archived',
    (session.whoop5_imu_v21 || 0) + (session.whoop5_ppg_v26 || 0) + (session.whoop5_optical_v20 || 0)
    + (session.console_logs || 0));
  const names = session.event_names || {};
  noteConsumption('protocol_consumed_battery', names.BATTERY_LEVEL || 0);
  noteConsumption('protocol_consumed_wear', (names.WRIST_ON || 0) + (names.WRIST_OFF || 0));
  const withheld = (names.STRAP_CONDITION_REPORT || 0) + (names.EVENT_29 || 0)
    + (names.EXTENDED_BATTERY_INFORMATION || 0);
  noteConsumption('protocol_candidates_withheld', withheld);
  noteConsumption('protocol_consumed_imu_features', session.whoop5_imu_v21 || session.imu_records || 0);
  noteConsumption('protocol_consumed_ppg_features', session.whoop5_ppg_v26 || 0);
}

export function foldBatteryTimeline(events = [], cmdBattery = []) {
  const out = [];
  for (const e of events || []) {
    if (e?.event_id !== 3 && e?.event_name !== 'BATTERY_LEVEL') continue;
    if (e.battery_pct == null) continue;
    out.push({
      t: e.event_ts ?? e.received_at ?? null,
      pct: e.battery_pct,
      mv: e.battery_mV ?? null,
      counter: e.battery_counter ?? e.event_body?.counter ?? null,
      charging: e.battery_charging ?? null,
      source: 'event_3',
      frame_hash: e.envelope?.frame_hash ?? null,
    });
  }
  for (const e of cmdBattery || []) {
    if (e?.battery_pct == null) continue;
    out.push({
      t: e.received_at ?? null,
      pct: e.battery_pct,
      mv: null,
      counter: null,
      charging: null,
      source: 'cmd_26',
      frame_hash: e.envelope?.frame_hash ?? null,
    });
  }
  out.sort((a, b) => String(a.t).localeCompare(String(b.t)));
  return out;
}
