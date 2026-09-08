/**
 * Compact sleep-sensor representation from v18 samples + B2-derived high-rate
 * records. Waveforms stay in B2; this object is the in-memory V3 input.
 *
 * Canonical stage inputs (WHOOP 5/MG, when present):
 *   v26 PPG, v21 100 Hz IMU, v18 HR/RR/gravity/temp/cadence, type-48 wrist.
 * v18 SpO₂ and disputed wear bits stay instrumentation-only.
 * v20 optical is never a stage input.
 */

import { extractSleepStreams, timestampSeconds } from './sleepDetection.js';
import { ACCEL_SCALE_G_PER_LSB, GYRO_SCALE_DPS_PER_LSB, IMU_SAMPLE_RATE_HZ } from '../protocol/imuArchive.js';
import { V26_SUPPORTED_RATES_HZ } from '../protocol/ppgArchive.js';

export const SLEEP_SENSORS_SCHEMA = 'frwhoop_sleep_sensors_v1';
export const SLEEP_SENSORS_VERSION = 1;

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sampleTs(row) {
  return timestampSeconds(row);
}

function recordTsSec(rec) {
  const raw = finite(rec?.corrected_sensor_ts ?? rec?.sensor_ts ?? rec?.unix ?? rec?.event_ts);
  if (raw == null) return null;
  return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
}

export function wristOffIntervalsFromEvents(events = []) {
  const live = [...events]
    .filter((e) => e && (e.event_name === 'WRIST_OFF' || e.event_name === 'WRIST_ON'
      || e.event_id === 10 || e.event_id === 9)
      && (e.kind == null || e.kind === 'event'))
    .map((e) => ({
      ts: recordTsSec(e),
      off: e.event_name === 'WRIST_OFF' || e.event_id === 10,
    }))
    .filter((e) => e.ts != null)
    .sort((a, b) => a.ts - b.ts || (a.off === b.off ? 0 : (a.off ? -1 : 1)));
  const spans = [];
  let open = null;
  for (const ev of live) {
    if (ev.off) {
      if (open == null) open = ev.ts;
      continue;
    }
    if (open != null) {
      if (ev.ts > open) spans.push({ start: open, end: ev.ts, ambiguous: false });
      open = null;
    }
  }
  if (open != null) {
    spans.push({
      start: open,
      end: Number.POSITIVE_INFINITY,
      ambiguous: true,
      missing_on: true,
    });
  }
  return spans;
}

function mergeIntervals(spans) {
  if (!spans.length) return [];
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out = [{ ...sorted[0] }];
  for (const span of sorted.slice(1)) {
    const last = out.at(-1);
    const lastEnd = Number.isFinite(last.end) ? last.end : Number.POSITIVE_INFINITY;
    const spanEnd = Number.isFinite(span.end) ? span.end : Number.POSITIVE_INFINITY;
    if (span.start <= lastEnd) {
      last.end = Math.max(lastEnd, spanEnd);
      last.ambiguous = Boolean(last.ambiguous || span.ambiguous);
      last.missing_on = Boolean(last.missing_on || span.missing_on);
    } else out.push({ ...span });
  }
  return out;
}

function extractV18Extras(samples = []) {
  const skinTemp = [];
  const dynAccel = [];
  const cadence = [];
  const activity = [];
  const wear = [];
  const spo2 = [];
  for (const row of samples) {
    const ts = sampleTs(row);
    if (ts == null) continue;
    let tempC = finite(row?.skin_temp_c ?? row?.skinTempC ?? row?.skinTemp);
    if (tempC == null) {
      const raw = finite(row?.skin_temp_raw);
      if (raw != null && raw >= 500 && raw <= 4500) tempC = raw / 100;
    }
    if (tempC != null && tempC >= 5 && tempC <= 45) skinTemp.push({ ts, c: tempC });
    const dyn = finite(row?.dyn_accel ?? row?.dynAccel ?? row?.dynamic_acceleration);
    if (dyn != null && dyn >= 0 && dyn <= 16) dynAccel.push({ ts, g: dyn });
    const cad = finite(row?.step_cadence ?? row?.stepCadence);
    if (cad != null && cad >= 0 && cad <= 250) cadence.push({ ts, rpm: cad });
    const ac = finite(row?.activity_class ?? row?.activityClass);
    if (ac != null && Number.isInteger(ac) && ac >= 0 && ac <= 2) activity.push({ ts, class: ac });
    const onwrist = finite(row?.onwrist ?? row?.wrist_on ?? row?.primary_flags_bit8_or_onwrist);
    const fit = finite(row?.wake_quality ?? row?.strap_fit_or_wake_quality);
    const contact = finite(row?.skin_contact ?? row?.skinContact);
    if (onwrist != null || fit != null || contact != null) {
      wear.push({ ts, onwrist, fit, contact, instrumentation_only: true });
    }
    const spo2Pct = finite(row?.spo2_candidate_pct ?? row?.spo2_candidate_82 ?? row?.spo2);
    const spo2State = row?.spo2_state ?? null;
    if (spo2Pct != null || spo2State) spo2.push({ ts, pct: spo2Pct, state: spo2State, instrumentation_only: true });
  }
  return { skinTemp, dynAccel, cadence, activity, wear, spo2 };
}

function recordTsFloat(rec) {
  const raw = finite(rec?.corrected_sensor_ts ?? rec?.sensor_ts ?? rec?.unix ?? rec?.event_ts);
  if (raw == null) return null;
  const sec = raw > 1e12 ? raw / 1000 : raw;
  const sub = finite(rec?.subsec_seconds);
  if (sub != null) return sec + sub;
  const q15 = finite(rec?.subsec);
  if (q15 != null && q15 > 1 && q15 <= 32768) return sec + q15 / 32768;
  if (q15 != null && q15 >= 0 && q15 <= 1) return sec + q15;
  return sec;
}

function compactImu(records = []) {
  const out = [];
  const seen = new Map();
  for (const rec of records) {
    const ts = recordTsFloat(rec);
    if (ts == null) continue;
    const ax = rec.accel_x;
    const ay = rec.accel_y;
    const az = rec.accel_z;
    if (!Array.isArray(ax) || ax.length < 20) continue;
    const layoutRate = rec.layout === 'v21' || rec.kind === 'hist_v21'
      ? IMU_SAMPLE_RATE_HZ
      : null;
    const hz = finite(rec.sample_rate_hz);
    const rate = hz != null && hz > 0 ? hz : layoutRate;
    if (!(rate > 0)) continue;
    const scale = finite(rec.accel?.scale_g_per_lsb) || ACCEL_SCALE_G_PER_LSB;
    const gscale = finite(rec.gyro?.scale_dps_per_lsb) || GYRO_SCALE_DPS_PER_LSB;
    const row = {
      ts,
      hz: rate,
      native_rate_hz: rate,
      ax, ay, az,
      gx: rec.gyro_x || null,
      gy: rec.gyro_y || null,
      gz: rec.gyro_z || null,
      accel_scale: scale,
      gyro_scale: gscale,
      layout: rec.layout || null,
      kind: rec.kind || null,
      device_family: rec.firmware?.model || rec.family || null,
      firmware: rec.firmware?.fw || null,
      decoder_version: rec.decoder?.version || rec.identity?.decoder_version || null,
    };
    const tsKey = `${Math.round(ts * 1000)}:${row.layout || ''}`;
    const prev = seen.get(tsKey);
    if (prev && (prev.ax?.length || 0) >= ax.length) continue;
    seen.set(tsKey, row);
  }
  for (const row of seen.values()) out.push(row);
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function compactPpg(records = []) {
  const out = [];
  const seen = new Map();
  for (const rec of records) {
    if (rec?.canonical_stage_input === false) continue;
    const ts = recordTsFloat(rec);
    if (ts == null) continue;
    const hz = finite(rec.sample_rate_hz);
    if (rec.layout === 'v26' && !V26_SUPPORTED_RATES_HZ.includes(hz)) continue;
    if (!(hz > 0)) continue;
    const trusted = rec.trusted_samples;
    const samples = Array.isArray(trusted) && trusted.length
      ? trusted
      : (rec.reconstruction_ambiguous ? [] : rec.samples);
    if (!Array.isArray(samples) || samples.length < 1) continue;
    const key = `${Math.round(ts * 1000)}:${rec.layout || ''}`;
    const row = {
      ts,
      hz,
      native_rate_hz: hz,
      samples,
      optical_deltas: rec.optical_deltas || null,
      first_sample_adc: rec.first_sample_adc ?? samples[0],
      pip_state_counter: rec.pip_state_counter ?? null,
      trusted_sample_count: samples.length,
      quality_ok: !rec.divergence_proven && !rec.reconstruction_ambiguous,
      reconstruction_ambiguous: Boolean(rec.reconstruction_ambiguous),
      has_saturated_delta: Boolean(rec.has_saturated_delta),
      duration_sec: samples.length / hz,
      layout: rec.layout || null,
      kind: rec.kind || null,
      device_family: rec.firmware?.model || rec.family || null,
      firmware: rec.firmware?.fw || null,
      decoder_version: rec.decoder?.version || rec.identity?.decoder_version || null,
    };
    const prev = seen.get(key);
    if (prev && prev.trusted_sample_count >= row.trusted_sample_count) continue;
    seen.set(key, row);
  }
  for (const row of seen.values()) out.push(row);
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * Build the in-memory V3 sensor pack. High-rate arrays remain here / in B2.
 */
export function extractSleepSensors({
  samples = [],
  imuRecords = [],
  ppgRecords = [],
  events = [],
  wristOff = [],
  placement = 'unknown',
  deviceFamily = null,
  firmware = null,
} = {}) {
  const streams = extractSleepStreams(samples);
  const extras = extractV18Extras(samples);
  const eventOff = wristOffIntervalsFromEvents(events);
  const off = mergeIntervals([
    ...wristOff.filter((s) => s && Number.isFinite(s.start) && (
      (Number.isFinite(s.end) && s.end > s.start)
      || s.missing_on === true
      || s.end === Number.POSITIVE_INFINITY
    )).map((s) => ({
      start: s.start,
      end: Number.isFinite(s.end) ? s.end : Number.POSITIVE_INFINITY,
      ambiguous: Boolean(s.ambiguous || s.missing_on || !Number.isFinite(s.end)),
      missing_on: Boolean(s.missing_on || !Number.isFinite(s.end)),
    })),
    ...eventOff,
  ]);
  const imu = compactImu(imuRecords);
  const ppg = compactPpg(ppgRecords);
  return {
    schema: SLEEP_SENSORS_SCHEMA,
    version: SLEEP_SENSORS_VERSION,
    ...streams,
    skinTemp: extras.skinTemp,
    dynAccel: extras.dynAccel,
    cadence: extras.cadence,
    activity: extras.activity,
    instrumentation: { wear: extras.wear, spo2: extras.spo2 },
    wristOff: off,
    imu,
    ppg,
    placement: placement || 'unknown',
    deviceFamily: deviceFamily || ppg[0]?.device_family || imu[0]?.device_family || null,
    firmware: firmware || ppg[0]?.firmware || imu[0]?.firmware || null,
    coverage: {
      gravity: streams.gravity.length,
      hr: streams.hr.length,
      rr: streams.rr.length,
      ppg: ppg.length,
      imu: imu.length,
      skinTemp: extras.skinTemp.length,
      wristOffSpans: off.length,
    },
  };
}

export function dataBounds(sensors) {
  let minTs = null;
  let maxTs = null;
  const consider = (t) => {
    if (!Number.isFinite(t)) return;
    if (minTs == null || t < minTs) minTs = t;
    if (maxTs == null || t > maxTs) maxTs = t;
  };
  for (const key of ['gravity', 'hr', 'rr', 'skinTemp']) {
    for (const row of sensors[key] || []) consider(row.ts);
  }
  for (const row of sensors.imu || []) consider(row.ts);
  for (const row of sensors.ppg || []) consider(row.ts);
  return { minTs, maxTs };
}

export function epochOverlapsOffWrist(start, end, wristOff = [], { corroboratedAbsent = false } = {}) {
  for (const span of wristOff) {
    const spanEnd = Number.isFinite(span.end) ? span.end : Number.POSITIVE_INFINITY;
    if (!(spanEnd > start && span.start < end)) continue;
    if (span.ambiguous || span.missing_on) {
      if (corroboratedAbsent) return { off: true, ambiguous: true };
      continue;
    }
    return { off: true, ambiguous: false };
  }
  return { off: false, ambiguous: false };
}
