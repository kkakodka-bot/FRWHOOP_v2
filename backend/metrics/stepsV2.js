/**
 * frwhoop_steps_v2 — wrist IMU gait pedometer.
 *
 * Concepts (not copied from NOOP/Goose): Analog Devices AN2554 (orientation-
 * independent acceleration, gravity removal, gait-band filtering, peak
 * detection) and OxWearables/OpenStrap-style bout gating (do not credit
 * isolated peaks; require a run of regular steps, then retroactively count
 * the opening candidates).
 *
 * Input: WHOOP 5/MG historical v21 or type-43 six-axis records at ~100 Hz
 * (`frwhoop_imu_raw_v1`). Raw arrays stay in LSB; scales are metadata.
 *
 * v18 `activity_class`, cadence, and `step_motion_counter` are supporting
 * evidence only. The cumulative counter is the fallback when high-resolution
 * IMU coverage is absent (lower confidence, explicit provenance).
 *
 * Apple Health / CMPedometer / phone steps are never added to the total.
 *
 * Canonical daily_metrics.steps stays on v1 until v2 beats it on held-out
 * labeled walks. Default mode is shadow.
 */

import {
  ACCEL_SCALE_G_PER_LSB,
  GYRO_SCALE_DPS_PER_LSB,
  IMU_SAMPLE_RATE_HZ,
  IMU_ARCHIVE_SCHEMA,
} from '../protocol/imuArchive.js';
import {
  accumulateSteps,
  STEPS_ALGORITHM_VERSION,
  presentNumber,
} from './steps.js';

export const STEPS_V2_VERSION = 'frwhoop-steps-v2';
export const STEPS_V2_BOUT_GATE = 8;

const FS = IMU_SAMPLE_RATE_HZ;
const DT = 1 / FS;
const HP_FC = 0.45;       // gravity / orientation drift
const LP_FC = 3.6;        // walking ~1.6–2.2 Hz; running up to ~3.5
const MIN_INTERVAL_S = 0.28;  // ~214 spm
const MAX_INTERVAL_S = 1.20;  // ~50 spm
const MIN_PEAK_G = 0.055;
const BOUT_N = STEPS_V2_BOUT_GATE;
const INTERVAL_CV_MAX = 0.32;
const PEAK_CV_MAX = 0.50;
const PEAK_RATIO_LO = 0.42;
const PEAK_RATIO_HI = 2.4;
const MAX_HALF_WIDTH_S = 0.34; // sinusoid arm-swings are wider
const MIN_JERK_G_S = 4.5;
const IMU_MIN_SECONDS = 8;
const BRUSH_HZ = 3.8;
const SLEEP_DYN_G = 0.045;

function stepsV2ModeFromEnv(env = process.env) {
  const raw = String(env?.FRWHOOP_STEPS_V2 || 'shadow').trim().toLowerCase();
  if (raw === 'off' || raw === 'v1') return 'off';
  // Legacy "canonical"/"v2" values are deliberately demoted. Promotion
  // requires an evidence-reviewed code change, never an environment toggle.
  return 'shadow';
}

export function stepsV2Mode(env) {
  return stepsV2ModeFromEnv(env);
}

function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (const v of arr) s += (v - m) ** 2;
  return Math.sqrt(s / arr.length);
}

function iirHighPass(x, fc = HP_FC, dt = DT) {
  const rc = 1 / (2 * Math.PI * fc);
  const a = rc / (rc + dt);
  const y = new Float64Array(x.length);
  if (!x.length) return y;
  let prevX = x[0];
  let prevY = 0;
  for (let i = 0; i < x.length; i += 1) {
    y[i] = a * (prevY + x[i] - prevX);
    prevX = x[i];
    prevY = y[i];
  }
  return y;
}

function iirLowPass(x, fc = LP_FC, dt = DT) {
  const rc = 1 / (2 * Math.PI * fc);
  const a = dt / (rc + dt);
  const y = new Float64Array(x.length);
  if (!x.length) return y;
  y[0] = x[0];
  for (let i = 1; i < x.length; i += 1) {
    y[i] = y[i - 1] + a * (x[i] - y[i - 1]);
  }
  return y;
}

function bandpass(x) {
  return iirLowPass(iirHighPass(x));
}

function svm3(x, y, z, scale) {
  const n = Math.min(x.length, y.length, z.length);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const ax = x[i] * scale;
    const ay = y[i] * scale;
    const az = z[i] * scale;
    out[i] = Math.sqrt(ax * ax + ay * ay + az * az);
  }
  return out;
}

function recordTimeMs(rec) {
  const corrected = rec?.corrected_sensor_ts ?? rec?.corrected_timestamp;
  if (Number.isFinite(Number(corrected))) {
    const n = Number(corrected);
    return n > 1e12 ? n : n * 1000;
  }
  const ts = rec?.sensor_ts ?? rec?.unix ?? rec?.timestamp;
  if (Number.isFinite(Number(ts))) {
    const n = Number(ts);
    const base = n > 1e12 ? n : n * 1000;
    const subsec = presentNumber(rec?.subsec ?? rec?.subseconds);
    return base + (n <= 1e12 && subsec != null && subsec >= 0 && subsec < 32768
      ? subsec / 32768 * 1000
      : 0);
  }
  const iso = rec?.received_at;
  const parsed = Date.parse(iso || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function recordHasGyro(rec) {
  const n = rec?.accel_x?.length || 0;
  return Array.isArray(rec?.gyro_x) && rec.gyro_x.length === n
    && Array.isArray(rec?.gyro_y) && rec.gyro_y.length === n
    && Array.isArray(rec?.gyro_z) && rec.gyro_z.length === n;
}

function rateOf(rec) {
  const r = Number(rec?.sample_rate_hz);
  if (Number.isFinite(r) && r > 1 && r <= 400) return r;
  return FS;
}

function scaleOf(rec) {
  const a = rec?.accel?.scale_g_per_lsb;
  const g = rec?.gyro?.scale_dps_per_lsb;
  return {
    accel: Number.isFinite(Number(a)) ? Number(a) : ACCEL_SCALE_G_PER_LSB,
    gyro: Number.isFinite(Number(g)) ? Number(g) : GYRO_SCALE_DPS_PER_LSB,
  };
}

/**
 * Concatenate 1 Hz IMU records into contiguous 100 Hz segments.
 * A gap > 1.5 s starts a new segment so bout state cannot jump a dropout.
 */
export function imuRecordsToSegments(records = [], { startMs = null, endMs = null } = {}) {
  const rows = (records || [])
    .filter((r) => r && (r.schema == null || r.schema === IMU_ARCHIVE_SCHEMA))
    .filter((r) => Array.isArray(r.accel_x) && Array.isArray(r.accel_y) && Array.isArray(r.accel_z)
      && r.accel_x.length >= 20
      && r.accel_y.length === r.accel_x.length
      && r.accel_z.length === r.accel_x.length)
    .map((r) => ({ rec: r, t0: recordTimeMs(r) }))
    .filter((r) => Number.isFinite(r.t0))
    .sort((a, b) => a.t0 - b.t0 || 0);

  const seen = new Set();
  const uniq = [];
  for (const row of rows) {
    const key = `${row.t0}:${row.rec.accel_x?.length || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (startMs != null && row.t0 + 1000 < startMs) continue;
    if (endMs != null && row.t0 >= endMs) continue;
    uniq.push(row);
  }

  const segments = [];
  let cur = null;
  for (const { rec, t0 } of uniq) {
    const n = rec.accel_x.length;
    const sc = scaleOf(rec);
    const fs = rateOf(rec);
    const hasGyro = recordHasGyro(rec);
    if (!cur || t0 - cur.endMs > 1500 || cur.fs !== fs) {
      if (cur) segments.push(cur);
      cur = {
        t0,
        endMs: t0 + (n / fs) * 1000,
        ax: [], ay: [], az: [], gx: [], gy: [], gz: [],
        fs,
        gyroPresent: hasGyro,
        accelScale: sc.accel,
        gyroScale: sc.gyro,
        layouts: new Set([rec.layout || rec.kind || 'unknown']),
      };
    }
    for (let i = 0; i < n; i += 1) {
      cur.ax.push(rec.accel_x[i]);
      cur.ay.push(rec.accel_y[i]);
      cur.az.push(rec.accel_z[i]);
      cur.gx.push(hasGyro ? rec.gyro_x[i] : 0);
      cur.gy.push(hasGyro ? rec.gyro_y[i] : 0);
      cur.gz.push(hasGyro ? rec.gyro_z[i] : 0);
    }
    cur.gyroPresent = cur.gyroPresent && hasGyro;
    cur.endMs = t0 + (n / fs) * 1000;
    cur.layouts.add(rec.layout || rec.kind || 'unknown');
  }
  if (cur) segments.push(cur);
  return segments;
}

function adaptiveThreshold(signal, i, win) {
  const lo = Math.max(0, i - win);
  const hi = Math.min(signal.length, i + win);
  let s = 0;
  let s2 = 0;
  const n = hi - lo;
  for (let k = lo; k < hi; k += 1) {
    const v = Math.abs(signal[k]);
    s += v;
    s2 += v * v;
  }
  const m = n ? s / n : 0;
  const sd = n ? Math.sqrt(Math.max(0, s2 / n - m * m)) : 0;
  return Math.max(MIN_PEAK_G, m * 0.85 + sd * 0.55);
}

function halfWidth(signal, i) {
  const peak = signal[i];
  const half = peak * 0.5;
  let L = i;
  while (L > 0 && signal[L] > half) L -= 1;
  let R = i;
  while (R < signal.length - 1 && signal[R] > half) R += 1;
  return (R - L) * DT;
}

function detectPeaks(signal) {
  const peaks = [];
  const refractory = Math.round(MIN_INTERVAL_S * FS);
  let last = -refractory;
  const win = Math.round(1.2 * FS);
  for (let i = 2; i < signal.length - 2; i += 1) {
    if (i - last < refractory) continue;
    const y = signal[i];
    if (y <= signal[i - 1] || y < signal[i + 1]) continue;
    if (y <= signal[i - 2] || y <= signal[i + 2]) continue;
    const thr = adaptiveThreshold(signal, i, win);
    if (y < thr) continue;
    peaks.push({
      i,
      amp: y,
      width: halfWidth(signal, i),
      jerk: i > 0 ? Math.abs(signal[i] - signal[i - 1]) * FS : 0,
    });
    last = i;
  }
  return peaks;
}

function cv(values) {
  const m = mean(values);
  if (!(m > 0)) return 1;
  return stdev(values) / m;
}

function dominantPeriodS(series, fs, minS, maxS) {
  const n = series.length;
  if (n < fs * 2) return null;
  const minLag = Math.max(1, Math.round(minS * fs));
  const maxLag = Math.min(Math.floor(n / 2), Math.round(maxS * fs));
  const m = mean(series);
  let bestLag = 0;
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let num = 0;
    let denA = 0;
    let denB = 0;
    const lim = n - lag;
    for (let i = 0; i < lim; i += 1) {
      const a = series[i] - m;
      const b = series[i + lag] - m;
      num += a * b;
      denA += a * a;
      denB += b * b;
    }
    const den = Math.sqrt(denA * denB);
    if (!(den > 0)) continue;
    const r = num / den;
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  if (best < 0.25 || !bestLag) return null;
  return { periodS: bestLag / fs, strength: best, freqHz: fs / bestLag };
}

function classifyReject({ intervals, amps, widths, jerks, gyro, dynMean, freqHz }) {
  if (dynMean < SLEEP_DYN_G && mean(amps) < 0.08) return 'sleep_movement';
  if (freqHz != null && freqHz >= BRUSH_HZ) return 'repetitive_hand';
  if (mean(widths) > MAX_HALF_WIDTH_S && mean(jerks) < MIN_JERK_G_S) {
    return gyro && gyro.freqHz != null && gyro.freqHz < 1.6 ? 'stationary_arm_swing' : 'non_gait_oscillation';
  }
  if (cv(intervals) > 0.55 && mean(amps) < 0.14) return 'busy_hands';
  if (intervals.length <= 2 && mean(amps) > 0.25) return 'lifting';
  if (gyro && gyro.freqHz != null && gyro.freqHz > 2.8 && mean(amps) < 0.12) return 'driving_vibration';
  if (gyro && mean(widths) > 0.28 && gyro.strength > 0.6 && mean(jerks) < MIN_JERK_G_S) {
    return 'cycling_or_smooth_oscillation';
  }
  return 'isolated_or_irregular';
}

function boutRegular(peaks) {
  if (peaks.length < BOUT_N) return false;
  const slice = peaks.slice(-BOUT_N);
  const intervals = [];
  const amps = [];
  const widths = [];
  const jerks = [];
  for (let i = 1; i < slice.length; i += 1) {
    const dt = (slice[i].i - slice[i - 1].i) * DT;
    if (dt < MIN_INTERVAL_S || dt > MAX_INTERVAL_S) return false;
    intervals.push(dt);
    const ratio = slice[i].amp / Math.max(1e-6, slice[i - 1].amp);
    if (ratio < PEAK_RATIO_LO || ratio > PEAK_RATIO_HI) return false;
  }
  for (const p of slice) {
    amps.push(p.amp);
    widths.push(p.width);
    jerks.push(p.jerk);
  }
  if (cv(intervals) > INTERVAL_CV_MAX) return false;
  if (cv(amps) > PEAK_CV_MAX) return false;
  if (mean(widths) > MAX_HALF_WIDTH_S) return false;
  if (mean(jerks) < MIN_JERK_G_S && mean(amps) < 0.18) return false;
  return true;
}

function eventBuckets(events, bucketSeconds = 60) {
  const widthMs = bucketSeconds * 1000;
  const buckets = new Map();
  for (const event of events || []) {
    const startMs = Math.floor(event.timestamp_ms / widthMs) * widthMs;
    buckets.set(startMs, (buckets.get(startMs) || 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([startMs, count]) => ({
      start_at: new Date(startMs).toISOString(),
      count,
      allocated: false,
      coalesced: false,
      source_mode: 'v2_imu_event',
    }));
}

function countSegment(seg) {
  const svm = svm3(seg.ax, seg.ay, seg.az, seg.accelScale);
  const dyn = bandpass(svm);
  const gyroMag = svm3(seg.gx, seg.gy, seg.gz, seg.gyroScale);
  const gyroBp = bandpass(gyroMag);
  const peaks = detectPeaks(dyn);
  const gyroDom = dominantPeriodS(Array.from(gyroBp), FS, 0.3, 2.0);
  const accelDom = dominantPeriodS(Array.from(dyn), FS, MIN_INTERVAL_S, MAX_INTERVAL_S);
  const fastDom = dominantPeriodS(Array.from(dyn), FS, 0.12, 0.28);

  if (fastDom && fastDom.freqHz >= BRUSH_HZ && fastDom.strength >= 0.45) {
    const gaitStr = accelDom?.strength ?? 0;
    if (fastDom.strength >= 0.85 || fastDom.strength >= gaitStr * 0.9) {
      return {
        steps: 0,
        events: [],
        peaks: peaks.length,
        rejected: { repetitive_hand: peaks.length || 1 },
        gyro_agree: false,
        imu_seconds: svm.length / FS,
        dominant_hz: fastDom.freqHz,
      };
    }
  }

  const dynAbsMean = mean(Array.from(dyn).map(Math.abs));
  if (dynAbsMean < SLEEP_DYN_G && peaks.length < BOUT_N) {
    return {
      steps: 0,
      events: [],
      peaks: peaks.length,
      rejected: { sleep_movement: Math.max(peaks.length, 1) },
      gyro_agree: false,
      imu_seconds: svm.length / FS,
      dominant_hz: accelDom?.freqHz ?? null,
    };
  }

  let credited = 0;
  const creditedEvents = [];
  let inBout = false;
  let creditedCount = 0;
  const rejected = { isolated_or_irregular: 0, sleep_movement: 0, repetitive_hand: 0,
    stationary_arm_swing: 0, busy_hands: 0, lifting: 0, driving_vibration: 0,
    cycling_or_smooth_oscillation: 0, non_gait_oscillation: 0 };
  const open = [];

  const rejectPeaks = (peaksToReject) => {
    if (!peaksToReject.length) return;
    const intervals = [];
    for (let i = 1; i < peaksToReject.length; i += 1) {
      intervals.push((peaksToReject[i].i - peaksToReject[i - 1].i) * DT);
    }
    const reason = classifyReject({
      intervals,
      amps: peaksToReject.map((p) => p.amp),
      widths: peaksToReject.map((p) => p.width),
      jerks: peaksToReject.map((p) => p.jerk),
      gyro: gyroDom,
      dynMean: dynAbsMean,
      freqHz: accelDom?.freqHz,
    });
    rejected[reason] = (rejected[reason] || 0) + peaksToReject.length;
  };

  const closeBout = () => {
    rejectPeaks(open.slice(creditedCount));
    open.length = 0;
    creditedCount = 0;
    inBout = false;
  };

  for (const peak of peaks) {
    if (!open.length) {
      open.push(peak);
      continue;
    }
    const dt = (peak.i - open[open.length - 1].i) * DT;
    if (dt < MIN_INTERVAL_S || dt > MAX_INTERVAL_S) {
      closeBout();
      open.push(peak);
      continue;
    }
    open.push(peak);
    if (!inBout && boutRegular(open)) {
      inBout = true;
      credited += BOUT_N;
      creditedEvents.push(...open.slice(-BOUT_N));
      creditedCount = open.length;
    } else if (inBout) {
      if (boutRegular(open.slice(-BOUT_N))) {
        credited += 1;
        creditedEvents.push(peak);
        creditedCount = open.length;
      } else {
        closeBout();
      }
    }
  }
  closeBout();

  // Gyro periodicity is supporting evidence, not a hard gate: mismatch on a
  // credited bout is recorded, not subtracted (wrist gyro can be quiet while
  // carrying objects).
  const gyroAgree = gyroDom && accelDom
    ? Math.min(
      Math.abs(gyroDom.periodS - accelDom.periodS) / accelDom.periodS,
      Math.abs(gyroDom.periodS - accelDom.periodS * 2) / (accelDom.periodS * 2),
    ) < 0.3
    : null;

  return {
    steps: credited,
    events: creditedEvents.map((peak) => {
      const timestampMs = seg.t0 + peak.i * DT * 1000;
      return {
        timestamp_ms: Math.round(timestampMs),
        timestamp: new Date(timestampMs).toISOString(),
      };
    }),
    peaks: peaks.length,
    rejected,
    gyro_agree: gyroAgree,
    imu_seconds: svm.length / FS,
    dominant_hz: accelDom?.freqHz ?? null,
  };
}

function emptyV2({ v1, reason, imuSeconds = 0 }) {
  return {
    total: v1?.status === 'unavailable' ? 0 : (v1?.total ?? 0),
    algorithm_version: STEPS_V2_VERSION,
    source_mode: 'cumulative_fallback',
    fallback: true,
    fallback_reason: reason,
    imu_coverage_seconds: imuSeconds,
    imu_coverage: 0,
    confidence: Math.min(0.45, v1?.confidence ?? 0),
    status: v1?.status || 'unavailable',
    rejected: {},
    v1_total: v1?.total ?? 0,
    v1_algorithm_version: v1?.algorithm_version || STEPS_ALGORITHM_VERSION,
    gyro_used: false,
    layouts: [],
    events: [],
    buckets_60s: v1?.buckets_60s || [],
    bucket_mode: 'cumulative_fallback',
  };
}

/**
 * Compute v2 steps for one local day.
 * @param {object} args
 * @param {object[]} args.imuRecords  frwhoop_imu_raw_v1 rows
 * @param {object[]} args.samples     day-scoped physiology samples (v18 support + fallback)
 * @param {object} [args.v1]          accumulateSteps result for the same day
 * @param {number} [args.dayStartMs]
 * @param {number} [args.dayEndMs]
 */
export function computeStepsV2({
  imuRecords = [],
  samples = [],
  v1 = null,
  dayStartMs = null,
  dayEndMs = null,
  timeZone = 'UTC',
} = {}) {
  const v1Result = v1 || accumulateSteps(samples, { timeZone });
  const segments = imuRecordsToSegments(imuRecords, { startMs: dayStartMs, endMs: dayEndMs });
  const imuSeconds = segments.reduce((s, seg) => s + seg.ax.length / FS, 0);
  const layouts = [...new Set(segments.flatMap((seg) => [...seg.layouts]))];

  if (imuSeconds < IMU_MIN_SECONDS) {
    return emptyV2({
      v1: v1Result,
      reason: imuSeconds <= 0 ? 'no_imu_records' : 'imu_coverage_below_minimum',
      imuSeconds,
    });
  }

  const rejected = {};
  let imuSteps = 0;
  const events = [];
  let gyroUsed = false;
  for (const seg of segments) {
    const part = countSegment(seg);
    imuSteps += part.steps;
    events.push(...part.events);
    if (part.gyro_agree != null) gyroUsed = true;
    for (const [k, n] of Object.entries(part.rejected)) {
      rejected[k] = (rejected[k] || 0) + n;
    }
  }

  const span = (dayEndMs != null && dayStartMs != null)
    ? Math.max(1, (dayEndMs - dayStartMs) / 1000)
    : Math.max(imuSeconds, 1);
  const coverage = Math.min(1, imuSeconds / span);
  // A short IMU slice of a calendar day is not a daily total. Keep the gait
  // count in diagnostics and fall back to the v1 proxy for the reported total.
  if (coverage < 0.05 && span > 30 * 60) {
    const fb = emptyV2({
      v1: v1Result,
      reason: 'imu_does_not_cover_day',
      imuSeconds,
    });
    fb.imu_slice_steps = Math.round(imuSteps);
    fb.imu_slice_events = events;
    fb.imu_slice_buckets_60s = eventBuckets(events);
    fb.layouts = layouts;
    fb.rejected = rejected;
    fb.gyro_used = gyroUsed;
    return fb;
  }
  const confidence = Math.max(0.35, Math.min(0.92, 0.45 + coverage * 0.4 + (gyroUsed ? 0.05 : 0)));
  const status = coverage < 0.15 ? 'partial' : 'ok';

  return {
    total: Math.round(imuSteps),
    algorithm_version: STEPS_V2_VERSION,
    source_mode: 'imu_gait',
    fallback: false,
    fallback_reason: null,
    imu_coverage_seconds: Math.round(imuSeconds * 10) / 10,
    imu_coverage: Math.round(coverage * 1000) / 1000,
    confidence: Math.round(confidence * 100) / 100,
    status,
    rejected,
    v1_total: v1Result.total,
    v1_algorithm_version: v1Result.algorithm_version,
    gyro_used: gyroUsed,
    layouts,
    bout_gate: BOUT_N,
    events,
    buckets_60s: eventBuckets(events),
    bucket_mode: 'imu_event',
  };
}

export function stepsV2Provenance(v2) {
  if (!v2) return null;
  return {
    algorithm_version: v2.algorithm_version,
    status: v2.status,
    confidence: v2.confidence,
    source_mode: v2.source_mode,
    fallback: Boolean(v2.fallback),
    fallback_reason: v2.fallback_reason,
    imu_coverage_seconds: v2.imu_coverage_seconds,
    imu_coverage: v2.imu_coverage,
    gyro_used: v2.gyro_used,
    layouts: v2.layouts,
    bout_gate: v2.bout_gate || BOUT_N,
    rejected: v2.rejected,
    event_count: v2.events?.length || 0,
    bucket_mode: v2.bucket_mode || null,
    v1_total: v2.v1_total,
    v1_algorithm_version: v2.v1_algorithm_version,
  };
}

export function shadowCompare(v1, v2) {
  const a = Number(v1?.total);
  const b = Number(v2?.total);
  const both = Number.isFinite(a) && Number.isFinite(b);
  const delta = both ? b - a : null;
  const rel = both && a !== 0 ? delta / a : (both && b === 0 && a === 0 ? 0 : null);
  return {
    v1_total: Number.isFinite(a) ? a : null,
    v2_total: Number.isFinite(b) ? b : null,
    signed_delta: delta,
    relative_delta: rel == null ? null : Math.round(rel * 1000) / 1000,
    v2_source_mode: v2?.source_mode || null,
    v2_fallback: Boolean(v2?.fallback),
  };
}

/** Compatibility helper; every configuration value now preserves V1 canonical. */
export function resolveCanonicalSteps(v1, _v2, _mode = stepsV2Mode()) {
  return { total: v1?.total ?? 0, source: v1, canonical: 'v1' };
}

export const _internal = {
  bandpass, detectPeaks, boutRegular, eventBuckets, svm3, iirHighPass, iirLowPass, dominantPeriodS,
};
