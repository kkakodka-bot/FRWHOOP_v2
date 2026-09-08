/**
 * Energy V3 minute features: V2 HR/RR/scalar motion plus 6-axis IMU,
 * placement, optional GPS/power, and RR-derived respiration when quality allows.
 */

import { bucketSamplesByMinute, scoreQuality } from '../../signal/quality.js';
import { extractV2SeriesFeatures } from '../v2/features.js';
import { extractMinuteImuFeatures } from './windows.js';
import { resolveWearLocation, normalizeWearLocation } from './placement.js';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function minuteGps(samples) {
  let speed = null, grade = null, power = null;
  for (const s of samples || []) {
    const sp = num(s.speed_mps ?? s.speedMs ?? s.speed);
    if (sp != null && sp >= 0 && sp <= 20) speed = sp;
    const g = num(s.grade ?? s.grade_frac);
    if (g != null && g >= -0.4 && g <= 0.4) grade = g;
    const p = num(s.power_w ?? s.powerW);
    if (p != null && p >= 0 && p <= 2000) power = p;
  }
  return { speedMs: speed, grade, powerW: power };
}

function meanRrBpm(samples) {
  const rr = [];
  for (const s of samples || []) {
    const list = s.rr_ms ?? s.rrIntervals;
    if (!Array.isArray(list)) continue;
    for (const v of list) {
      const n = Number(v);
      if (n >= 300 && n <= 2000) rr.push(n);
    }
  }
  if (rr.length < 8) return null;
  const mean = rr.reduce((a, b) => a + b, 0) / rr.length;
  return Math.round((60000 / mean) * 10) / 10;
}

export function extractV3SeriesFeatures(samples, {
  imuRecords = [],
  wearLocationEvents = [],
} = {}) {
  const byMinute = bucketSamplesByMinute(samples);
  const base = extractV2SeriesFeatures(samples);
  const out = [];
  let previousMinuteMs = null;
  let since = 0;
  for (const minute of base) {
    const contiguous = previousMinuteMs != null
      && minute.features.minuteMs - previousMinuteMs === 60_000;
    since = contiguous ? since + 1 : 0;
    const minuteSamples = byMinute.get(minute.features.minuteMs) || [];
    const stamped = minuteSamples.find((s) => normalizeWearLocation(s?.wear_location ?? s?.wearLocation));
    const placement = resolveWearLocation({
      sample: stamped || minuteSamples[0] || null,
      events: wearLocationEvents,
      t: new Date(minute.features.minuteMs).toISOString(),
    });
    const imu = extractMinuteImuFeatures(imuRecords, minute.features.minuteMs, {
      placement: placement.location,
    });
    const gps = minuteGps(minuteSamples);
    const resp = meanRrBpm(minuteSamples);
    const respOk = minute.features.rrArtifactFraction != null
      && minute.features.rrArtifactFraction <= 0.3;
    const features = {
      ...minute.features,
      wear_location: placement.location,
      wear_location_source: placement.source,
      imu,
      imuCoverage: imu?.coverage ?? 0,
      speedMs: gps.speedMs,
      grade: gps.grade,
      powerW: gps.powerW,
      resp_rate_bpm: respOk ? resp : null,
      minutesSinceActivityChange: since,
    };
    if (imu && (imu.coverage == null || imu.coverage >= 0.25)) {
      features.motionCount = Math.max(features.motionCount || 0, imu.n);
      features.motionCoverage = Math.max(features.motionCoverage || 0, imu.coverage);
    }
    out.push({
      ...minute,
      features,
      quality: imu ? scoreQuality(features) : minute.quality,
    });
    previousMinuteMs = minute.features.minuteMs;
  }
  return out;
}
