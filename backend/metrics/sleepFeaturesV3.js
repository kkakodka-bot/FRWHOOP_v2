/**
 * 30-second multimodal sleep features for sleep_stager_v3.
 *
 * Waveforms are time-placed with explicit native_rate_hz → target_rate_hz
 * box-mean resampling. Missing PPG or IMU never becomes silent zero physiology.
 * v18 SpO₂ and disputed wear bits are not features.
 */

import { createHash } from 'node:crypto';
import { scorePpgQuality } from '../signal/quality.js';
import { rrStats } from '../signal/quality.js';
import { dataBounds, epochOverlapsOffWrist } from './sleepSensors.js';

export const FEATURE_SCHEMA_VERSION = 'sleep-v3-features-2';
export const EPOCH_SEC = 30;
export const PPG_MODEL_HZ = 25;
export const PPG_SAMPLES = EPOCH_SEC * PPG_MODEL_HZ;
export const IMU_NATIVE_HZ = 100;
export const RESAMPLING_METHOD = 'box_mean_time_grid';
export const FORBIDDEN_V3_FEATURES = Object.freeze([
  'wear', 'spo2', 'spo2_candidate', 'onwrist', 'on_wrist', 'skin_contact',
  'skinContact', 'strap_fit', 'wake_quality',
]);
export const COMPACT_FEATURE_NAMES = Object.freeze([
  'hr_mean', 'hr_std', 'hr_trend',
  'ibi_n', 'ibi_coverage', 'rmssd', 'sdnn', 'ihr_mean',
  'enmo_mean', 'enmo_std', 'jerk_rms', 'gyro_rms',
  'ppg_quality', 'ppg_coverage', 'ppg_concentration',
  'temp_dev', 'clock_sin', 'clock_cos', 'frac_through',
  'resp_reg', 'dyn_accel',
]);

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mean(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function stdev(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length);
}

function median(values) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function mad(values, med) {
  const xs = values.filter((v) => Number.isFinite(v)).map((v) => Math.abs(v - med));
  return median(xs);
}

function clip(xs, lo, hi) {
  return xs.map((v) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : v));
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

export function preprocessingContract() {
  return {
    feature_schema_version: FEATURE_SCHEMA_VERSION,
    epoch_sec: EPOCH_SEC,
    ppg_target_hz: PPG_MODEL_HZ,
    ppg_samples: PPG_SAMPLES,
    imu_native_hz: IMU_NATIVE_HZ,
    resampling_method: RESAMPLING_METHOD,
    normalize: 'robust_mad_1.4826_clip_8',
    clip: 8,
    dc_remove: 'epoch_median',
    compact_feature_names: [...COMPACT_FEATURE_NAMES],
    stage_label_order: ['wake', 'light', 'deep', 'rem'],
    missing_representation: 'null',
    forbidden_features: [...FORBIDDEN_V3_FEATURES],
  };
}

export function preprocessingContractSha256() {
  return createHash('sha256').update(canonicalJson(preprocessingContract())).digest('hex');
}

export function assertNoForbiddenV3Features(names = COMPACT_FEATURE_NAMES) {
  const hit = [...names].filter((n) => FORBIDDEN_V3_FEATURES.includes(n));
  if (hit.length) {
    const err = new Error(`forbidden_v3_features:${hit.join(',')}`);
    err.code = 'forbidden_v3_features';
    throw err;
  }
  return true;
}

export function expandCandidateWindow(start, end, bounds = {}, padSec = 45 * 60) {
  const minTs = bounds.minTs == null ? start - padSec : bounds.minTs;
  const maxTs = bounds.maxTs == null ? end + padSec : bounds.maxTs;
  return {
    start: Math.max(minTs, start - padSec),
    end: Math.min(maxTs, end + padSec),
  };
}

export function epochStarts(start, end) {
  if (!(end > start)) return [];
  const first = Math.ceil(start / EPOCH_SEC) * EPOCH_SEC;
  const out = [];
  for (let t = first; t < end; t += EPOCH_SEC) out.push(t);
  return out;
}

function rowsOverlap(rows, lo, hi, durationOf) {
  return (rows || []).filter((row) => {
    const dur = durationOf(row);
    return row.ts < hi && (row.ts + dur) > lo;
  });
}

function rowsIn(rows, lo, hi) {
  return (rows || []).filter((row) => row.ts >= lo && row.ts < hi);
}

/**
 * Place native samples onto a target-rate time grid.
 * native_hz > target_hz: box-mean of samples falling in each target bin (anti-alias).
 * Gaps stay null. Never stretch a short window across wall-clock holes.
 */
export function resampleToTargetGrid(records, {
  epochStart, epochEnd, targetHz = PPG_MODEL_HZ,
} = {}) {
  const nOut = Math.round((epochEnd - epochStart) * targetHz);
  const sum = Array(nOut).fill(0);
  const cnt = Array(nOut).fill(0);
  let native = null;
  for (const rec of records || []) {
    const hz = rec.native_rate_hz || rec.hz;
    if (!(hz > 0)) continue;
    native = native ?? hz;
    const samples = rec.samples || [];
    for (let i = 0; i < samples.length; i += 1) {
      const v = finite(samples[i]);
      if (v == null) continue;
      const t = rec.ts + i / hz;
      if (t < epochStart || t >= epochEnd) continue;
      const k = Math.floor((t - epochStart) * targetHz);
      if (k < 0 || k >= nOut) continue;
      sum[k] += v;
      cnt[k] += 1;
    }
  }
  const values = Array(nOut);
  let present = 0;
  for (let k = 0; k < nOut; k += 1) {
    if (cnt[k]) {
      values[k] = sum[k] / cnt[k];
      present += 1;
    } else values[k] = null;
  }
  return {
    values,
    native_rate_hz: native,
    target_rate_hz: targetHz,
    method: RESAMPLING_METHOD,
    present,
    expected: nOut,
    missing_fraction: nOut ? 1 - present / nOut : 1,
  };
}

function robustNormalize(samples) {
  const present = samples.filter((v) => Number.isFinite(v));
  if (!present.length) return { values: samples, ok: false };
  const med = median(present);
  const scale = mad(present, med);
  const denom = scale != null && scale > 1e-6 ? 1.4826 * scale : (stdev(present) || 1);
  const values = samples.map((v) => (Number.isFinite(v) ? (v - med) / denom : null));
  return { values: clip(values, -8, 8), ok: true, median: med, scale: denom };
}

function concatImu(imu, lo, hi) {
  const rows = rowsOverlap(imu, lo, hi, (row) => (row.ax?.length || 0) / (row.hz || IMU_NATIVE_HZ));
  if (!rows.length) return null;
  const ax = [];
  const ay = [];
  const az = [];
  const gx = [];
  const gy = [];
  const gz = [];
  let gyro = false;
  for (const row of rows) {
    const n = row.ax.length;
    const s = row.accel_scale;
    const gs = row.gyro_scale;
    for (let i = 0; i < n; i += 1) {
      ax.push(row.ax[i] * s);
      ay.push(row.ay[i] * s);
      az.push(row.az[i] * s);
      if (row.gx && row.gy && row.gz && row.gx.length === n) {
        gx.push(row.gx[i] * gs);
        gy.push(row.gy[i] * gs);
        gz.push(row.gz[i] * gs);
        gyro = true;
      }
    }
  }
  return {
    ax, ay, az,
    gx: gyro ? gx : null, gy: gyro ? gy : null, gz: gyro ? gz : null,
    n: ax.length,
    native_rate_hz: rows[0]?.hz || IMU_NATIVE_HZ,
  };
}

function enmoAndJerk(imu) {
  if (!imu?.n) return { enmo: [], jerk: [], gyroRms: null };
  const enmo = [];
  const jerk = [];
  let prev = null;
  let g2 = 0;
  let gn = 0;
  for (let i = 0; i < imu.n; i += 1) {
    const mag = Math.sqrt(imu.ax[i] ** 2 + imu.ay[i] ** 2 + imu.az[i] ** 2);
    enmo.push(Math.max(0, mag - 1));
    if (prev != null) jerk.push(Math.abs(mag - prev));
    prev = mag;
    if (imu.gx) {
      g2 += imu.gx[i] ** 2 + imu.gy[i] ** 2 + imu.gz[i] ** 2;
      gn += 1;
    }
  }
  return {
    enmo,
    jerk,
    gyroRms: gn ? Math.sqrt(g2 / gn) : null,
  };
}

function ibiStats(rr, lo, hi) {
  const beats = rowsIn(rr, lo, hi).map((r) => r.rrMs).filter((v) => v >= 300 && v <= 2000);
  const stats = rrStats(beats);
  const n = beats.length;
  const coverage = Math.min(1, n / 20);
  const artifactFrac = stats.artifactFraction ?? 0;
  if (n < 2) {
    return {
      ibi: beats, n, coverage, rmssd: null, sdnn: null, ihr: null, mask: n > 0 ? 0.25 : 0,
      artifact_fraction: 0, irregularity: 0,
    };
  }
  const sdnn = stdev(beats);
  let ssd = 0;
  for (let i = 1; i < n; i += 1) ssd += (beats[i] - beats[i - 1]) ** 2;
  const rmssd = Math.sqrt(ssd / (n - 1));
  const ihr = 60000 / (mean(beats) || 1000);
  return {
    ibi: beats, n, coverage, rmssd, sdnn, ihr, mask: coverage,
    artifact_fraction: artifactFrac, irregularity: artifactFrac,
  };
}

function respRegularityLite(beats) {
  if (beats.length < 12) return null;
  const y = beats.slice();
  const m = mean(y);
  let varY = 0;
  for (const v of y) varY += (v - m) ** 2;
  return varY === 0 ? 0 : 1 / (1 + Math.sqrt(varY / y.length) / 80);
}

function localClock(epochMid, tzOffsetSeconds) {
  const local = ((epochMid + tzOffsetSeconds) % 86_400 + 86_400) % 86_400;
  const frac = local / 86_400;
  return { sin: Math.sin(2 * Math.PI * frac), cos: Math.cos(2 * Math.PI * frac), frac };
}

function tzOffsetAt(timeZone, epochMid, fallback = 0) {
  if (!timeZone || timeZone === 'UTC') return fallback;
  try {
    const atMs = epochMid * 1000;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(atMs));
    const get = (type) => Number(parts.find((part) => part.type === type)?.value);
    const localAsUtc = Date.UTC(
      get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'),
    );
    return Math.round((localAsUtc - atMs) / 1000);
  } catch {
    return fallback;
  }
}

/**
 * Build one 30 s epoch. Waveform arrays use null for missing samples, never 0.
 */
export function buildEpoch(epochStart, sensors, {
  windowStart,
  windowEnd,
  tzOffsetSeconds = 0,
  timeZone = null,
  nightTempMedian = null,
  historyOnsetFrac = null,
} = {}) {
  const lo = epochStart;
  const hi = epochStart + EPOCH_SEC;
  const mid = lo + EPOCH_SEC / 2;
  const ppgRows = rowsOverlap(
    sensors.ppg, lo, hi,
    (row) => row.duration_sec || ((row.samples?.length || 0) / (row.hz || PPG_MODEL_HZ)),
  );
  const imu = concatImu(sensors.imu, lo, hi);
  const hrs = rowsIn(sensors.hr, lo, hi).map((r) => r.bpm);
  const grav = rowsIn(sensors.gravity, lo, hi);
  const hrPresent = hrs.length > 0;
  const imuPresent = Boolean(imu?.n >= IMU_NATIVE_HZ);
  const gravPresent = grav.length >= 2;
  const ppgGrid = resampleToTargetGrid(ppgRows, {
    epochStart: lo, epochEnd: hi, targetHz: PPG_MODEL_HZ,
  });
  const satN = ppgRows.filter((r) => r.has_saturated_delta || r.reconstruction_ambiguous).length;
  const ppgSatFrac = ppgRows.length ? satN / ppgRows.length : 0;
  const corroboratedAbsent = !hrPresent && !imuPresent && ppgGrid.present < 8 && !gravPresent;
  const offHit = epochOverlapsOffWrist(lo, hi, sensors.wristOff, { corroboratedAbsent });
  const offWrist = Boolean(offHit.off);
  const hrMean = mean(hrs);
  const hrStd = stdev(hrs);
  const hrTrend = hrs.length >= 4
    ? mean(hrs.slice(Math.floor(hrs.length / 2))) - mean(hrs.slice(0, Math.floor(hrs.length / 2)))
    : null;
  const cardiac = ibiStats(sensors.rr, lo - 15, hi + 15);
  const motion = enmoAndJerk(imu);
  const dc = median(ppgGrid.values);
  const detrended = ppgGrid.values.map((v) => (Number.isFinite(v) && dc != null ? v - dc : null));
  const ppgNorm = robustNormalize(detrended);
  const ppgPresent = ppgNorm.ok && ppgGrid.present >= 8 && ppgSatFrac < 1;
  const presentSamples = ppgGrid.values.filter((v) => v != null);
  const ppgQ = ppgPresent
    ? scorePpgQuality({
      samples: presentSamples,
      rateHz: PPG_MODEL_HZ,
      adcRange: 524287,
      expected: PPG_SAMPLES,
    })
    : { ppg: 0, coverage: 0, overall: 0, flags: ['ppg_absent'], pulsatility: null };

  const temps = rowsIn(sensors.skinTemp, lo, hi).map((r) => r.c);
  const tempMean = mean(temps);
  const tempDev = tempMean != null && nightTempMedian != null ? tempMean - nightTempMedian : null;
  const tzOff = timeZone ? tzOffsetAt(timeZone, mid, tzOffsetSeconds) : tzOffsetSeconds;
  const clock = localClock(mid, tzOff);
  const span = Math.max(1, windowEnd - windowStart);
  const dyn = mean(rowsIn(sensors.dynAccel, lo, hi).map((r) => r.g));
  const sufficient = !offWrist && (ppgPresent || imuPresent || hrPresent || gravPresent);
  const motionContamination = Number.isFinite(mean(motion.enmo)) ? Math.min(1, mean(motion.enmo) / 0.15) : 0;
  const morphologyOod = Boolean(ppgQ.flags?.includes('ppg_flatline') || ppgQ.flags?.includes('ppg_clipping'))
    || (ppgPresent && (ppgQ.overall || 0) < 0.2);

  const compact = {
    hr_mean: hrMean,
    hr_std: hrStd,
    hr_trend: hrTrend,
    ibi_n: cardiac.n,
    ibi_coverage: cardiac.coverage,
    rmssd: cardiac.rmssd,
    sdnn: cardiac.sdnn,
    ihr_mean: cardiac.ihr,
    enmo_mean: mean(motion.enmo),
    enmo_std: stdev(motion.enmo),
    jerk_rms: motion.jerk.length ? Math.sqrt(mean(motion.jerk.map((v) => v * v)) || 0) : null,
    gyro_rms: motion.gyroRms,
    ppg_quality: ppgPresent ? ppgQ.overall : null,
    ppg_coverage: ppgPresent ? ppgQ.coverage : 0,
    ppg_concentration: ppgPresent ? (ppgQ.pulsatility ?? null) : null,
    temp_dev: tempDev,
    clock_sin: clock.sin,
    clock_cos: clock.cos,
    frac_through: (mid - windowStart) / span,
    resp_reg: respRegularityLite(cardiac.ibi),
    dyn_accel: dyn,
    history_onset_frac: historyOnsetFrac,
  };

  return {
    start: lo,
    end: hi,
    offWrist,
    offWristAmbiguous: Boolean(offHit.ambiguous),
    sufficient,
    domain: {
      device_family: sensors.deviceFamily || 'unknown',
      firmware: sensors.firmware || 'unknown',
      signal_layout: ppgRows[0]?.layout || sensors.imu?.[0]?.layout || 'none',
      native_rate_hz: ppgRows[0]?.hz || null,
      placement: sensors.placement || 'unknown',
      decoder_version: ppgRows[0]?.decoder_version || sensors.imu?.[0]?.decoder_version || null,
    },
    masks: {
      ppg: ppgPresent ? 1 : 0,
      imu: imuPresent ? 1 : 0,
      cardiac: cardiac.mask,
      hr: hrPresent ? 1 : 0,
      gravity: gravPresent ? 1 : 0,
      temp: tempMean != null ? 1 : 0,
    },
    quality: {
      ppg: ppgQ,
      ppg_flags: ppgQ.flags,
      imu_samples: imu?.n || 0,
      off_wrist: offWrist,
      ibi_irregularity: cardiac.irregularity,
      rr_artifact_fraction: cardiac.artifact_fraction,
      ppg_sqi: ppgPresent ? ppgQ.overall : 0,
      ppg_saturation_fraction: ppgSatFrac,
      ppg_missing_fraction: ppgGrid.missing_fraction,
      motion_contamination: motionContamination,
      morphology_ood: morphologyOod,
    },
    ppg: ppgPresent ? ppgNorm.values : Array(PPG_SAMPLES).fill(null),
    ppg_resample: {
      native_rate_hz: ppgGrid.native_rate_hz,
      target_rate_hz: ppgGrid.target_rate_hz,
      method: ppgGrid.method,
    },
    imu: imuPresent ? { ax: imu.ax, ay: imu.ay, az: imu.az, gx: imu.gx, gy: imu.gy, gz: imu.gz } : null,
    compact,
  };
}

export function compactVector(compact) {
  return COMPACT_FEATURE_NAMES.map((name) => {
    const v = compact[name];
    return Number.isFinite(v) ? v : 0;
  });
}

export function compactPresentMask(compact) {
  return COMPACT_FEATURE_NAMES.map((name) => (Number.isFinite(compact[name]) ? 1 : 0));
}

export function buildEpochFeatures(sensors, start, end, opts = {}) {
  assertNoForbiddenV3Features();
  const nightTempMedian = median((sensors.skinTemp || []).map((r) => r.c));
  const starts = epochStarts(start, end);
  return starts.map((epoch) => buildEpoch(epoch, sensors, {
    windowStart: start,
    windowEnd: end,
    tzOffsetSeconds: opts.tzOffsetSeconds || 0,
    timeZone: opts.timeZone || null,
    nightTempMedian,
    historyOnsetFrac: opts.historyOnsetFrac ?? null,
  }));
}

export function sensorsBounds(sensors) {
  return dataBounds(sensors);
}

export function epochTensor(epoch) {
  return {
    start: epoch.start,
    compact: compactVector(epoch.compact),
    compact_present: compactPresentMask(epoch.compact),
    ppg: epoch.ppg,
    masks: epoch.masks,
    quality: {
      ibi_irregularity: epoch.quality.ibi_irregularity,
      rr_artifact_fraction: epoch.quality.rr_artifact_fraction,
      ppg_sqi: epoch.quality.ppg_sqi,
      ppg_saturation_fraction: epoch.quality.ppg_saturation_fraction,
      ppg_missing_fraction: epoch.quality.ppg_missing_fraction,
      motion_contamination: epoch.quality.motion_contamination,
      morphology_ood: epoch.quality.morphology_ood,
    },
    domain: epoch.domain,
  };
}
