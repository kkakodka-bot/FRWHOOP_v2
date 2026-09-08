/**
 * IMU feature extraction (Phase 3).
 *
 * Consumes raw 6-axis (accelerometer + gyroscope) samples and produces the
 * motion-feature vector the mission specifies. The native NOOP decoder exposes
 * 100 Hz WHOOP 5.0/MG IMU via the offload buffer (Whoop5RawImu.swift) with
 * accel scale 1/4096 g/LSB and gyro scale 2000/32768 deg/s/LSB; those scalings
 * are applied by the decoder, so this module expects physical units:
 *   ax,ay,az in g,  gx,gy,gz in deg/s.
 *
 * Design: pure functions of numeric arrays, built to run either during ingestion
 * (on a bounded window) or asynchronously. Short windows (~5 s) characterize
 * movement; longer windows (~1 min) characterize activity context. Nothing here
 * is WHOOP-specific beyond expecting 3-axis arrays at a known rate, so the same
 * code runs on the WEEE public dataset (Phase 9).
 *
 * Every metric is defined in the docs (ENERGY_MODEL.md §IMU) and each has a test
 * showing it does what it claims (rest vs motion vs a known ring-down).
 */

import { bandpassMotionAucStats } from './v3/preprocess.js';

/** Placement-specific still thresholds (g). Wrist and bicep do not share these. */
export const IMU_STILL_THRESHOLD = Object.freeze({
  wrist: 0.12,
  bicep: 0.18,
});

export const IMU_WINDOW_SECONDS = 60;
export const IMU_SUBWINDOW_SECONDS = 5;

/** Accelerometer ENMO (Euclidean Norm Minus One) per sample, g. */
export function enmoPerSample(ax, ay, az) {
  return Math.sqrt(ax * ax + ay * ay + az * az) - 1;
}

/** Subtract the window-mean gravity vector. Same physics for any placement. */
export function gravityRemoved(ax, ay, az) {
  const n = ax.length;
  if (!n) return { dx: [], dy: [], dz: [], gx: 0, gy: 0, gz: 0 };
  let sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < n; i++) { sx += ax[i]; sy += ay[i]; sz += az[i]; }
  const gx = sx / n, gy = sy / n, gz = sz / n;
  const dx = new Array(n), dy = new Array(n), dz = new Array(n);
  for (let i = 0; i < n; i++) {
    dx[i] = ax[i] - gx;
    dy[i] = ay[i] - gy;
    dz[i] = az[i] - gz;
  }
  return { dx, dy, dz, gx, gy, gz };
}

export function percentile(values, p) {
  if (!values?.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return s[lo];
  return s[lo] * (hi - i) + s[hi] * (i - lo);
}

/** Vector magnitude of acceleration, g. */
export function vectorMagnitude(ax, ay, az) {
  return Math.sqrt(ax * ax + ay * ay + az * az);
}

/** Mean absolute deviation (MAD) of a numeric series. */
export function meanAbsDev(values) {
  const m = mean(values);
  if (m == null) return 0;
  let acc = 0;
  for (const v of values) acc += Math.abs(v - m);
  return acc / values.length;
}

/** Signal magnitude area (one axis' contribution; sum over axes for total). */
export function sma(series) {
  if (!series.length) return 0;
  return series.reduce((a, v) => a + Math.abs(v), 0) / series.length;
}

// ---------------------------------------------------------------------------
// Spectral helpers
// ---------------------------------------------------------------------------

/** Dominant frequency (Hz) and its power via a coarse Goertzel/periodogram. */
export function dominantFrequency(series, sampleRate) {
  const n = series.length;
  if (n < 4 || !sampleRate) return { freq: null, power: null };
  const mean0 = mean(series);
  const seg = series.map((v) => v - mean0);
  // Window properties: Nyquist = sampleRate/2; resolve down to ~0.5 Hz steps.
  const nyq = sampleRate / 2;
  const binHz = 0.5;
  let best = null;
  let bestPow = -1;
  for (let f = 0.5; f <= nyq; f += binHz) {
    // Goertzel single-bin power
    const w = (2 * Math.PI * f) / sampleRate;
    const coeff = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (const v of seg) {
      const s0 = v + coeff * s1 - s2;
      s2 = s1; s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    if (power > bestPow) { bestPow = power; best = f; }
  }
  return best == null ? { freq: null, power: null } : { freq: best, power: bestPow };
}

/** Fraction of total spectral power inside [loHz, hiHz] (cadence band). */
export function bandPowerFraction(series, sampleRate, loHz, hiHz) {
  const n = series.length;
  if (n < 4 || !sampleRate) return null;
  const mean0 = mean(series);
  const seg = series.map((v) => v - mean0);
  const nyq = sampleRate / 2;
  const maxF = Math.min(nyq, 10);
  let band = 0, total = 0;
  for (let f = 0.3; f <= maxF; f += 0.3) {
    const w = (2 * Math.PI * f) / sampleRate;
    const coeff = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (const v of seg) {
      const s0 = v + coeff * s1 - s2;
      s2 = s1; s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    total += power;
    if (f >= loHz && f <= hiHz) band += power;
  }
  return total > 0 ? band / total : null;
}

// ---------------------------------------------------------------------------
// Cadence / periodicity / step
// ---------------------------------------------------------------------------

/**
 * Cadence estimate from the dominant vertical-axis frequency, in steps/min.
 * Strips gravity then finds the dominant frequency in the walking/running band
 * (0.5–4 Hz ≈ 60–240 spm on a doubled-arm-swing assumption is NOT assumed here;
 * we report the raw dominant frequency mapped to cycles/min, i.e. one step per
 * gait cycle captured at the wrist is ~2 steps, so cadence ≈ domFreq*120 is a
 * defensible upper estimate; we report `domFreqHz*60` as cycles-per-min and let
 * callers multiply by the 2x arm-swing factor if they accept it).
 */
export function cadenceSpM(series, sampleRate) {
  const { freq } = dominantFrequency(series, sampleRate);
  if (freq == null) return null;
  // Arm-swing frequency ~ gait-cadence/2 (one arm swing per two steps is not
  // identity; at the wrist both swings are ~one per gait cycle). We report the
  // dominant frequency as cycles/min and, below, the ×2 step estimate.
  return { cyclesPerMin: freq * 60, stepsPerMinUpper: freq * 120 };
}

/** Autocorrelation at a given lag (Pearson between the series and its shift). */
export function autocorr(series, lag) {
  const n = series.length;
  if (n <= lag + 1) return null;
  const a = [], b = [];
  for (let i = 0; i < n - lag; i++) { a.push(series[i]); b.push(series[i + lag]); }
  return pearsonArr(a, b);
}

/** Estimate the dominant period (samples) via autocorrelation peaks. */
export function periodicity(series, sampleRate) {
  const n = series.length;
  if (n < 16) return { periodS: null, strength: null };
  const maxLag = Math.min(Math.floor(n / 2), Math.floor(sampleRate * 2)); // up to 2 s
  let bestLag = null, best = null;
  for (let lag = 1; lag <= maxLag; lag++) {
    const r = autocorr(series, lag);
    if (r != null && (best == null || r > best)) { best = r; bestLag = lag; }
  }
  if (bestLag == null || best < 0.3) return { periodS: null, strength: 0 };
  return { periodS: bestLag / sampleRate, strength: best, freqHz: sampleRate / bestLag };
}

// ---------------------------------------------------------------------------
// Entropy / intermittency / stationarity
// ---------------------------------------------------------------------------

/** Sample entropy: normalized count of distinct adjacent-difference sign runs. */
export function sampleEntropy(series, m = 2, r = null) {
  const n = series.length;
  if (n < 40) return null;
  const rr = r ?? (0.2 * stddevP(series));
  function matches(template, offset) {
    for (let i = 0; i < template.length; i++) {
      if (Math.abs(series[offset + i] - template[i]) > rr) return false;
    }
    return true;
  }
  let B = 0, A = 0;
  for (let i = 0; i < n - m - 1; i++) {
    const tA = series.slice(i, i + m + 1);
    const tB = series.slice(i, i + m);
    for (let j = i + 1; j < n - m; j++) {
      if (matches(tB, j)) B++;
      if (Math.abs(series[j + m] - tA[m]) <= rr && matches(tA.slice(0, m), j)) A++;
    }
  }
  if (B === 0 || A === 0) return null;
  return -Math.log(A / B);
}

/** Fraction of window with acceleration magnitude above a threshold (moving). */
export function movementIntermittency(ax, ay, az, threshold = 0.12) {
  if (!ax.length) return null;
  let moving = 0;
  for (let i = 0; i < ax.length; i++) {
    if (Math.abs(vmSub1(ax[i], ay[i], az[i])) > threshold) moving++;
  }
  return moving / ax.length;
}

const vmSub1 = (a, b, c) => Math.sqrt(a * a + b * b + c * c) - 1;

// ---------------------------------------------------------------------------
// Whole-window aggregate
// ---------------------------------------------------------------------------

/**
 * Extract the full motion-feature vector for one IMU window.
 *
 * @param {object} w
 * @param {Array} w.ax  acceleration x (g)
 * @param {Array} w.ay
 * @param {Array} w.az
 * @param {Array} [w.gx] gyroscope x (deg/s), optional
 * @param {Array} [w.gy]
 * @param {Array} [w.gz]
 * @param {number} w.sampleRate  Hz
 * @returns feature object (see PHYSIO_* fields)
 */
export function extractImuFeatures({
  ax = [], ay = [], az = [], gx, gy, gz, sampleRate = 100,
  placement = 'wrist', expectedSeconds = null,
} = {}) {
  const n = ax.length;
  if (!n || ax.length !== ay.length || ax.length !== az.length) return null;

  const place = placement === 'bicep' ? 'bicep' : 'wrist';
  const stillThr = IMU_STILL_THRESHOLD[place];
  const enmoSeries = ax.map((v, i) => enmoPerSample(v, ay[i], az[i]));
  const vmSeries = ax.map((v, i) => vectorMagnitude(v, ay[i], az[i]));
  const removed = gravityRemoved(ax, ay, az);
  const dynSeries = removed.dx.map((v, i) => vectorMagnitude(v, removed.dy[i], removed.dz[i]));
  // gravity-subtracted vertical (posture proxy): bandpass not applied; use mean of az as gravity approx
  const gzMean = mean(az) ?? 0;

  const gyroMag = (gx && gy && gz)
    ? gx.map((v, i) => Math.sqrt(v * v + (gy[i] || 0) * (gy[i] || 0) + (gz[i] || 0) * (gz[i] || 0)))
    : null;
  const gyroMean = gyroMag ? mean(gyroMag) : null;
  const gyroMax = gyroMag ? Math.max(...gyroMag) : null;

  // dominant frequency on the ENMO (best single periodic signal)
  const dom = dominantFrequency(enmoSeries, sampleRate);
  const cad = cadenceSpM(enmoSeries, sampleRate);
  const per = periodicity(enmoSeries, sampleRate);
  // cadence band: walking/running cadence ~1.5-3 Hz at the wrist
  const cadenceBand = bandPowerFraction(enmoSeries, sampleRate, 1.0, 3.2);

  const jerk = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = ax[i + 1] - ax[i], dy = ay[i + 1] - ay[i], dz = az[i + 1] - az[i];
    jerk.push((dx * dx + dy * dy + dz * dz) / (sampleRate * sampleRate));
  }
  const jerkMean = jerk.length ? mean(jerk) : null;

  const expectedN = expectedSeconds != null && sampleRate
    ? expectedSeconds * sampleRate
    : n;
  const coverage = expectedN > 0 ? Math.min(1, n / expectedN) : 1;
  const sub = subwindowDynamics(dynSeries, sampleRate, IMU_SUBWINDOW_SECONDS);
  const tiltSeries = ax.map((_, i) => clampAngle(az[i]));
  const tiltStd = stddevP(tiltSeries);
  const orientationStability = round(clamp01(1 - tiltStd / 45), 4);
  const band = bandpassMotionAucStats(ax, ay, az, sampleRate);

  return {
    n,
    sampleRate,
    placement: place,
    // magnitude domain
    enmo_mean: round(mean(enmoSeries), 5),
    enmo_mad: round(meanAbsDev(enmoSeries), 5),
    enmo_sma: round(sma(enmoSeries), 5),
    enmo_p10: round(percentile(enmoSeries, 0.1), 5),
    enmo_p50: round(percentile(enmoSeries, 0.5), 5),
    enmo_p90: round(percentile(enmoSeries, 0.9), 5),
    dyn_enmo_mean: round(mean(dynSeries), 5),
    bandpass_motion_auc_20hz: band.bandpass_motion_auc_20hz,
    bandpass_motion_auc_20hz_std: band.bandpass_motion_auc_20hz_std,
    vm_mean: round(mean(vmSeries), 5),
    vm_p10: round(percentile(vmSeries, 0.1), 5),
    vm_p90: round(percentile(vmSeries, 0.9), 5),
    accel_std: round(stddevP(vmSeries), 5),
    // per-axis correlation (gravity-removed standing axes)
    ax_ay_corr: round(pearsonArr(ax, ay) ?? 0, 4),
    ax_az_corr: round(pearsonArr(ax, az) ?? 0, 4),
    ay_az_corr: round(pearsonArr(ay, az) ?? 0, 4),
    // posture proxy: mean z-axis acceleration (gravity alignment)
    gravity_z_mean: round(gzMean, 5),
    tilt_estimate: round(clampAngle(gzMean), 3),
    // gyro
    gyro_mean_dps: gyroMean == null ? null : round(gyroMean, 3),
    gyro_max_dps: gyroMax == null ? null : round(gyroMax, 3),
    gyro_energy: gyroMag ? round(gyroMag.reduce((a, b) => a + b * b, 0) / gyroMag.length, 3) : null,
    // spectral / cadence
    dom_freq_hz: dom.freq == null ? null : round(dom.freq, 3),
    dom_power: dom.power == null ? null : round(dom.power, 3),
    cadence_cycles_per_min: cad?.cyclesPerMin == null ? null : round(cad.cyclesPerMin, 2),
    cadence_band_power_frac: cadenceBand == null ? null : round(cadenceBand, 4),
    period_s: per.periodS == null ? null : round(per.periodS, 4),
    periodicity_strength: per.strength == null ? null : round(per.strength, 4),
    // dynamics
    jerk_mean: jerkMean == null ? null : round(jerkMean, 6),
    entropy: round(sampleEntropy(enmoSeries) ?? 0, 4),
    movement_intermittency: round(movementIntermittency(ax, ay, az, stillThr) ?? 0, 4),
    // peak statistics
    accel_peak: round(Math.max(...vmSeries), 5),
    accel_rms: round(Math.sqrt(mean(vmSeries.map((v) => v * v))), 5),
    orientation_stability: orientationStability,
    coverage: round(coverage, 4),
    sub_enmo_mean: sub.mean,
    sub_enmo_std: sub.std,
  };
}

// ---------------------------------------------------------------------------
// Small numeric helpers (kept local, not exported)
// ---------------------------------------------------------------------------
function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}
function stddevP(arr) {
  const m = mean(arr);
  let s = 0;
  for (const v of arr) s += (v - m) ** 2;
  return Math.sqrt(s / arr.length);
}
function pearsonArr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = a[i] - ma, dy = b[i] - mb;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (!sxx || !syy) return null;
  return sxy / Math.sqrt(sxx * syy);
}
function clampAngle(gzMean) {
  // tilt proxy: arccos of normalized vertical gravity
  const t = Math.acos(Math.max(-1, Math.min(1, gzMean)));
  return t * (180 / Math.PI);
}
function round(n, p) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** p;
  return Math.round((n + Number.EPSILON) * f) / f;
}
function clamp01(v) {
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
function subwindowDynamics(series, sampleRate, subSeconds) {
  const win = Math.max(1, Math.round(sampleRate * subSeconds));
  if (series.length < win) {
    const m = mean(series);
    return { mean: round(m, 5), std: 0 };
  }
  const means = [];
  for (let i = 0; i + win <= series.length; i += win) {
    means.push(mean(series.slice(i, i + win)));
  }
  return { mean: round(mean(means), 5), std: round(stddevP(means), 5) };
}
