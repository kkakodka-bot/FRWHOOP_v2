/**
 * Canonical cross-device IMU preprocess.
 *
 * Physical units in, physical units out: accel in g, gyro in deg/s.
 * Mixed sample rates are never concatenated here. A 20 Hz copy is resampled
 * from a single native rate after anti-alias (bin average). Absent gyro is
 * omitted, never zero-filled.
 */

export const CROSS_DEVICE_HZ = 20;
const G_MS2 = 9.80665;
const RAD2DEG = 180 / Math.PI;

export function axisComplete(ax, ay, az) {
  return Boolean(
    ax?.length
    && ax.length === ay?.length
    && ax.length === az?.length
    && ax.every((v, i) => Number.isFinite(v) && Number.isFinite(ay[i]) && Number.isFinite(az[i])),
  );
}

export function gyroComplete(gx, gy, gz) {
  if (!gx?.length && !gy?.length && !gz?.length) return false;
  return axisComplete(gx, gy, gz);
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Detect m/s² vs g from the gravity shell. */
export function accelToG(ax, ay, az) {
  const vm = ax.map((v, i) => Math.sqrt(v * v + ay[i] * ay[i] + az[i] * az[i]));
  const med = median(vm);
  if (med != null && med > 6 && med < 14) {
    const s = 1 / G_MS2;
    return {
      ax: ax.map((v) => v * s),
      ay: ay.map((v) => v * s),
      az: az.map((v) => v * s),
      units: 'g',
      from: 'm_s2',
    };
  }
  return { ax: ax.slice(), ay: ay.slice(), az: az.slice(), units: 'g', from: 'g' };
}

/** Convert gyro to deg/s. Resting dps and rad/s overlap, so units must be explicit. */
export function gyroToDps(gx, gy, gz, units = 'deg_s') {
  const copy = { gx: gx.slice(), gy: gy.slice(), gz: gz.slice(), units: 'deg_s', from: 'deg_s' };
  const u = String(units || 'deg_s').toLowerCase();
  if (u === 'deg_s' || u === 'dps') return copy;
  if (u !== 'rad_s') return copy;
  return {
    gx: gx.map((v) => v * RAD2DEG),
    gy: gy.map((v) => v * RAD2DEG),
    gz: gz.map((v) => v * RAD2DEG),
    units: 'deg_s',
    from: 'rad_s',
  };
}

/**
 * Anti-alias then resample a copy to `toHz`.
 * Bin-average is the low-pass (Nyquist of the target rate).
 */
export function resampleCopy(series, fromHz, toHz = CROSS_DEVICE_HZ) {
  if (!series?.length || !fromHz || !toHz) return [];
  if (fromHz === toHz) return series.slice();
  const nOut = Math.floor(series.length * toHz / fromHz);
  if (nOut < 2) return [];
  const out = new Array(nOut);
  for (let i = 0; i < nOut; i++) {
    const a = (i * fromHz) / toHz;
    const b = ((i + 1) * fromHz) / toHz;
    const lo = Math.max(0, Math.floor(a));
    const hi = Math.min(series.length, Math.max(lo + 1, Math.ceil(b)));
    let s = 0;
    for (let j = lo; j < hi; j++) s += series[j];
    out[i] = s / (hi - lo);
  }
  return out;
}

function iirHighpass(x, fs, fc) {
  const rc = 1 / (2 * Math.PI * fc);
  const dt = 1 / fs;
  const a = rc / (rc + dt);
  const y = new Array(x.length);
  y[0] = 0;
  for (let i = 1; i < x.length; i++) y[i] = a * (y[i - 1] + x[i] - x[i - 1]);
  return y;
}

function iirLowpass(x, fs, fc) {
  const rc = 1 / (2 * Math.PI * fc);
  const dt = 1 / fs;
  const a = dt / (rc + dt);
  const y = new Array(x.length);
  y[0] = x[0];
  for (let i = 1; i < x.length; i++) y[i] = y[i - 1] + a * (x[i] - y[i - 1]);
  return y;
}

/**
 * MIMS-style human-motion-band magnitude this is NOT.
 * 1-pole HP 0.2 Hz + LP 5 Hz at the 20 Hz feature rate. Not NHANES MIMS
 * (no 100 Hz cubic spline, no 4th-order Butterworth, no per-axis integrated
 * summary, no device-harmonization claim).
 * ponytail: 1-pole IIR stands in for 4th-order Butterworth.
 */
export function bandpassMotionAucSeries(ax, ay, az, sampleRate, { hpHz = 0.2, lpHz = 5 } = {}) {
  if (!ax.length || !sampleRate) return [];
  const nyq = sampleRate / 2;
  const lp = Math.min(lpHz, nyq * 0.9);
  const bx = iirLowpass(iirHighpass(ax, sampleRate, hpHz), sampleRate, lp);
  const by = iirLowpass(iirHighpass(ay, sampleRate, hpHz), sampleRate, lp);
  const bz = iirLowpass(iirHighpass(az, sampleRate, hpHz), sampleRate, lp);
  return bx.map((v, i) => Math.sqrt(v * v + by[i] * by[i] + bz[i] * bz[i]));
}

export function bandpassMotionAucStats(ax, ay, az, sampleRate) {
  const s = bandpassMotionAucSeries(ax, ay, az, sampleRate);
  if (!s.length) {
    return { bandpass_motion_auc_20hz: null, bandpass_motion_auc_20hz_std: null };
  }
  let sum = 0, sum2 = 0;
  for (const v of s) { sum += v; sum2 += v * v; }
  const mean = sum / s.length;
  const std = Math.sqrt(Math.max(0, sum2 / s.length - mean * mean));
  return {
    bandpass_motion_auc_20hz: round(mean, 5),
    bandpass_motion_auc_20hz_std: round(std, 5),
  };
}

function round(n, p) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** p;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/**
 * Harmonize one window. `native` keeps the original rate (WHOOP 100 Hz stays
 * 100 Hz). `cross` is a 20 Hz copy for cross-device features.
 */
export function harmonizeImu({
  ax, ay, az, gx, gy, gz, sampleRate, gyroUnits = 'deg_s',
} = {}) {
  if (!axisComplete(ax, ay, az) || !sampleRate) return null;
  const acc = accelToG(ax, ay, az);
  let gyro = null;
  if (gyroComplete(gx, gy, gz)) gyro = gyroToDps(gx, gy, gz, gyroUnits);
  const native = {
    ax: acc.ax, ay: acc.ay, az: acc.az,
    gx: gyro ? gyro.gx : undefined,
    gy: gyro ? gyro.gy : undefined,
    gz: gyro ? gyro.gz : undefined,
    sampleRate,
    gyroPresent: Boolean(gyro),
    accelUnits: acc.units,
    gyroUnits: gyro ? gyro.units : null,
  };
  const cross = {
    ax: resampleCopy(native.ax, sampleRate, CROSS_DEVICE_HZ),
    ay: resampleCopy(native.ay, sampleRate, CROSS_DEVICE_HZ),
    az: resampleCopy(native.az, sampleRate, CROSS_DEVICE_HZ),
    sampleRate: CROSS_DEVICE_HZ,
    gyroPresent: native.gyroPresent,
    gx: native.gyroPresent ? resampleCopy(native.gx, sampleRate, CROSS_DEVICE_HZ) : undefined,
    gy: native.gyroPresent ? resampleCopy(native.gy, sampleRate, CROSS_DEVICE_HZ) : undefined,
    gz: native.gyroPresent ? resampleCopy(native.gz, sampleRate, CROSS_DEVICE_HZ) : undefined,
  };
  if (cross.ax.length < 20) return null;
  return { native, cross, accelFrom: acc.from, gyroFrom: gyro?.from ?? null };
}
