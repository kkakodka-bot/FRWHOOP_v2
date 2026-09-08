/**
 * Canonical 60 s IMU windows from type-43/v21 records.
 *
 * Native-rate series stay native (WHOOP 100 Hz is not downsampled in place).
 * Cross-device features come from an anti-aliased 20 Hz copy. Mixed rates are
 * not concatenated: only the dominant-rate segments contribute.
 */

import { imuRecordsToSegments } from '../../metrics/stepsV2.js';
import { extractImuFeatures, IMU_WINDOW_SECONDS } from '../imuFeatures.js';
import { CROSS_DEVICE_HZ, harmonizeImu } from './preprocess.js';

const MINUTE_MS = IMU_WINDOW_SECONDS * 1000;

function scalePush(seg, i, ax, ay, az, gx, gy, gz) {
  ax.push(seg.ax[i] * seg.accelScale);
  ay.push(seg.ay[i] * seg.accelScale);
  az.push(seg.az[i] * seg.accelScale);
  if (!seg.gyroPresent) return;
  gx.push(seg.gx[i] * seg.gyroScale);
  gy.push(seg.gy[i] * seg.gyroScale);
  gz.push(seg.gz[i] * seg.gyroScale);
}

export function dominantRate(segs) {
  const counts = new Map();
  for (const seg of segs) {
    const fs = seg.fs || 100;
    counts.set(fs, (counts.get(fs) || 0) + seg.ax.length);
  }
  let sampleRate = 100;
  let best = 0;
  for (const [fs, n] of counts) {
    if (n >= best) {
      best = n;
      sampleRate = fs;
    }
  }
  return sampleRate;
}

/**
 * Six-axis features for one minute. Null when coverage is too thin to trust.
 */
export function extractMinuteImuFeatures(imuRecords, minuteMs, { placement = 'wrist' } = {}) {
  const segs = imuRecordsToSegments(imuRecords, {
    startMs: minuteMs - 250,
    endMs: minuteMs + MINUTE_MS + 250,
  });
  if (!segs.length) return null;
  const sampleRate = dominantRate(segs);
  const ax = [], ay = [], az = [], gx = [], gy = [], gz = [];
  let gyroPresent = true;
  let anyGyroSeg = false;
  for (const seg of segs) {
    const fs = seg.fs || 100;
    if (fs !== sampleRate) continue;
    if (seg.gyroPresent) anyGyroSeg = true;
    else gyroPresent = false;
    for (let i = 0; i < seg.ax.length; i++) {
      const t = seg.t0 + (i / fs) * 1000;
      if (t < minuteMs || t >= minuteMs + MINUTE_MS) continue;
      if (seg.ax[i] == null || seg.ay[i] == null || seg.az[i] == null) continue;
      if (seg.gyroPresent && (seg.gx[i] == null || seg.gy[i] == null || seg.gz[i] == null)) continue;
      scalePush(seg, i, ax, ay, az, gx, gy, gz);
    }
  }
  if (ax.length < 20) return null;
  gyroPresent = gyroPresent && anyGyroSeg;
  const harm = harmonizeImu({
    ax, ay, az,
    gx: gyroPresent ? gx : undefined,
    gy: gyroPresent ? gy : undefined,
    gz: gyroPresent ? gz : undefined,
    sampleRate,
  });
  if (!harm) return null;
  const cross = extractImuFeatures({
    ...harm.cross,
    sampleRate: CROSS_DEVICE_HZ,
    placement,
    expectedSeconds: IMU_WINDOW_SECONDS,
  });
  if (!cross) return null;
  const native = extractImuFeatures({
    ...harm.native,
    sampleRate: harm.native.sampleRate,
    placement,
    expectedSeconds: IMU_WINDOW_SECONDS,
  });
  return {
    ...cross,
    native_sample_rate: harm.native.sampleRate,
    native_n: harm.native.ax.length,
    native_enmo_mean: native?.enmo_mean ?? null,
    native_gyro_mean_dps: native?.gyro_mean_dps ?? null,
    accel_units: harm.native.accelUnits,
    gyro_units: harm.native.gyroUnits,
    gyro_present: harm.native.gyroPresent,
    feature_hz: CROSS_DEVICE_HZ,
  };
}
