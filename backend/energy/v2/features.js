/**
 * Energy v2 per-minute feature extraction.
 *
 * Source-aware motion repair (audit 2026-08-27): production "wrist motion" in v1
 * was, in practice, the PHONE accelerometer (|mag-1| at 1 Hz) because the strap
 * type-43 triplet extraction was broken and the raw stream is not enabled. The
 * strap's own gravity-removed motion magnitude (v18 dynamic_acceleration@41,
 * computed on-device) IS available on history rows as `dyn_accel` — this module
 * prefers it and labels the source.
 *
 *   strap motion : `dyn_accel` (1 Hz, gravity-removed by the strap firmware)
 *   phone motion : `mot` / `motion` (1 Hz phone |mag-1.0|, or a legacy scalar)
 *
 * A minute's motion feature prefers the strap channel when present; phone
 * motion is kept separately and never silently mixed.
 *
 * Sleep stage: normalized `stage` when present, else the WHOOP band sleep
 * state. iOS `band_sleep_state` is the already-normalized nibble 0..3.
 * Raw sleep/wear bytes use `sleep_state_byte` or `{ form: 'raw_byte' }` and
 * are shifted `(v >> 4) & 3`. Bare integers default to the nibble; values
 * outside 0..3 stay unknown (never shifted). Only nibble `2` maps to asleep.
 * This module is shadow/off — mapping here does not enable Energy V2.
 *
 * HR/RR/quality semantics match v1 (energy/features.js + signal/quality.js) so
 * v1 remains a reproducible fallback over the same samples.
 */

import {
  EXPECTED_SAMPLES_PER_MINUTE,
  LIMITS,
  clamp,
  num,
} from '../constants.js';
import {
  bucketSamplesByMinute,
  median,
  minuteFloor,
  rrStats,
  scoreQuality,
  stddev,
} from '../../signal/quality.js';

const MINUTE_MS = 60_000;

function nibbleToStage(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 3) return null;
  return n === 2 ? 'asleep' : null;
}

function nibbleFromRawByte(value) {
  const v = Number(value);
  if (!Number.isInteger(v) || v < 0 || v > 255) return null;
  return nibbleToStage((v >> 4) & 3);
}

/**
 * Map band sleep to the Energy V2 asleep classifier.
 *
 * Distinguishable inputs:
 *   - nibble 0..3 (`band_sleep_state` / `bandSleepState` / bare integer)
 *   - raw u8 (`sleep_state_byte` or `{ form: 'raw_byte', value }`)
 * Nibble 2 → `'asleep'`. 0/1/3 and malformed → null (unknown, not a stage).
 */
export function bandSleepStageToStage(input) {
  if (input == null) return null;
  if (typeof input === 'object') {
    if (input.form === 'raw_byte') {
      return nibbleFromRawByte(input.sleep_state_byte ?? input.value ?? input.band_sleep_state);
    }
    const nibble = input.band_sleep_state ?? input.bandSleepState;
    if (nibble != null && nibble !== '') return nibbleToStage(nibble);
    if (input.sleep_state_byte != null && input.sleep_state_byte !== '') {
      return nibbleFromRawByte(input.sleep_state_byte);
    }
    if (input.sleep_state != null && input.sleep_state !== '') return nibbleToStage(input.sleep_state);
    if (input.form === 'nibble') return nibbleToStage(input.value);
    return null;
  }
  return nibbleToStage(input);
}

/** Least-squares slope of hr against time, in bpm per minute. */
function slopePerMinute(points) {
  if (points.length < 3) return null;
  let sx = 0, sy = 0;
  for (const [x, y] of points) { sx += x; sy += y; }
  const mx = sx / points.length;
  const my = sy / points.length;
  let n = 0, d = 0;
  for (const [x, y] of points) { n += (x - mx) * (y - my); d += (x - mx) ** 2; }
  if (d <= 0) return null;
  return (n / d) * MINUTE_MS;
}

function channelStats(values, threshold = 0.06) {
  if (!values.length) return { mean: null, std: null, max: null, activeFraction: null };
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    mean: Math.round(m * 1000) / 1000,
    std: Math.round(stddev(values, m) * 1000) / 1000,
    max: Math.round(Math.max(...values) * 1000) / 1000,
    activeFraction: +(values.filter((v) => v > threshold).length / values.length).toFixed(4),
  };
}

/**
 * Extract v2 features for one minute.
 *
 * @param {number} minuteMs  epoch ms of the minute start
 * @param {Array}  samples   normalized samples in this minute
 * @param {object} prev      previous minute's {features} for slope/delta context
 * @returns null when the minute has neither HR nor any motion channel
 */
export function extractV2MinuteFeatures(minuteMs, samples, prev = null) {
  const hrs = [];
  const hrPoints = [];
  const strapMotion = [];
  const phoneMotion = [];
  const rrAll = [];
  const stages = new Map();
  const activityClassCounts = new Map();
  const stepDeltas = [];
  let lastTs = null;
  let maxGapMs = 0;
  let implausibleJumps = 0;
  let prevHr = null;
  let prevHrTs = null;
  let disconnected = 0;
  let reportedQualitySum = 0;
  let reportedQualityCount = 0;
  let onWristSamples = 0;

  for (const s of samples || []) {
    const ts = num(s.ts) ?? minuteFloor(s.t ?? s.datetime ?? s.at);
    if (ts == null) continue;
    if (lastTs != null) maxGapMs = Math.max(maxGapMs, ts - lastTs);
    lastTs = ts;

    if (s.connected === false) disconnected += 1;

    const q = num(s.q ?? s.quality);
    if (q != null) { reportedQualitySum += clamp(q, 0, 1); reportedQualityCount += 1; }

    const wo = num(s.wrist_on ?? s.wristOn);
    if (wo != null && wo > 0) onWristSamples += 1;

    const bpm = num(s.bpm ?? s.hr ?? s.heartRate);
    if (bpm != null && bpm >= LIMITS.hrMin && bpm <= LIMITS.hrMax) {
      if (prevHr != null && prevHrTs != null && ts - prevHrTs <= 10_000 && Math.abs(bpm - prevHr) > 25) {
        // Optical relock, not a heartbeat. Counted for quality, and EXCLUDED
        // from the model-input HR features: training HR (E4) contains no
        // relocks, so a 183 bpm spike inside a 60 bpm minute would push every
        // learned prediction off-distribution.
        implausibleJumps += 1;
        prevHr = bpm;
        prevHrTs = ts;
        continue;
      }
      hrs.push(bpm);
      hrPoints.push([ts, bpm]);
      prevHr = bpm;
      prevHrTs = ts;
    }

    const dyn = num(s.dyn_accel ?? s.dynAccel);
    if (dyn != null && dyn >= 0 && dyn <= 8) strapMotion.push(dyn);

    const mot = num(s.mot ?? s.motion);
    if (mot != null && mot >= 0 && mot <= LIMITS.motionMax) phoneMotion.push(mot);

    const rr = s.rr_ms ?? s.rrIntervals;
    if (Array.isArray(rr) && rr.length) rrAll.push(...rr);

    const stage = s.stage ?? s.sleep_stage;
    if (stage && stage !== 'none') stages.set(String(stage), (stages.get(String(stage)) || 0) + 1);
    const mapped = bandSleepStageToStage(s);
    if (mapped) stages.set(mapped, (stages.get(mapped) || 0) + 1);

    const ac = num(s.activity_class);
    if (ac != null && Number.isInteger(ac) && ac >= 0 && ac <= 2) {
      activityClassCounts.set(ac, (activityClassCounts.get(ac) || 0) + 1);
    }

    if (s.steps != null && Number.isFinite(Number(s.steps))) stepDeltas.push(Number(s.steps));
  }

  if (!hrs.length && !strapMotion.length && !phoneMotion.length) return null;

  const hrSorted = hrs.slice().sort((a, b) => a - b);
  const hrMean = hrs.length ? hrs.reduce((a, b) => a + b, 0) / hrs.length : null;
  const rr = rrStats(rrAll);

  const strapStats = channelStats(strapMotion);
  const phoneStats = channelStats(phoneMotion);

  const source = strapMotion.length ? 'strap' : (phoneMotion.length ? 'phone' : 'none');
  const motionValues = source === 'strap' ? strapMotion : (source === 'phone' ? phoneMotion : []);
  const motionStats = source === 'strap' ? strapStats : phoneStats;

  let modalStage = null, modalCount = 0;
  for (const [k, v] of stages) if (v > modalCount) { modalStage = k; modalCount = v; }

  let modalActivityClass = null, acCount = 0;
  for (const [k, v] of activityClassCounts) if (v > acCount) { modalActivityClass = k; acCount = v; }

  const hrCoverage = clamp(hrs.length / EXPECTED_SAMPLES_PER_MINUTE, 0, 1);
  const motionCoverage = clamp(motionValues.length / EXPECTED_SAMPLES_PER_MINUTE, 0, 1);
  const strapCoverage = clamp(strapMotion.length / EXPECTED_SAMPLES_PER_MINUTE, 0, 1);
  const lastAgeSec = lastTs == null ? null : Math.max(0, (minuteMs + MINUTE_MS - lastTs) / 1000);
  const features = {
    minuteMs,
    sampleCount: samples?.length || 0,

    hrCount: hrs.length,
    hr: hrMean == null ? null : Math.round(hrMean * 10) / 10,
    hrMedian: median(hrSorted),
    hrMin: hrSorted[0] ?? null,
    hrMax: hrSorted[hrSorted.length - 1] ?? null,
    hrStd: hrMean == null ? null : Math.round(stddev(hrs, hrMean) * 100) / 100,
    hrSlope: slopePerMinute(hrPoints),
    hrDelta: prev?.features?.hr != null && hrMean != null ? hrMean - prev.features.hr : null,

    rrCount: rr.count,
    rmssd: rr.rmssd == null ? null : Math.round(rr.rmssd * 10) / 10,
    sdnn: rr.sdnn == null ? null : Math.round(rr.sdnn * 10) / 10,
    rrArtifactFraction: Math.round(rr.artifactFraction * 100) / 100,

    // ---- motion repair: source-aware channels ----
    motionSource: source,
    motion: motionStats.mean,
    motionMax: motionStats.max,
    motionStd: motionStats.std,
    motionActiveFraction: motionStats.activeFraction,
    strapMotion: strapStats.mean,
    strapMotionStd: strapStats.std,
    strapMotionMax: strapStats.max,
    strapMotionActiveFraction: strapStats.activeFraction,
    strapCoverage: clamp(strapMotion.length / EXPECTED_SAMPLES_PER_MINUTE, 0, 1),
    phoneMotion: phoneStats.mean,
    phoneMotionMax: phoneStats.max,
    phoneMotionActiveFraction: phoneStats.activeFraction,
    phoneCoverage: clamp(phoneMotion.length / EXPECTED_SAMPLES_PER_MINUTE, 0, 1),

    sleepStage: modalStage,
    bandAsleepSamples: stages.get('asleep') ?? 0,
    activityClass: modalActivityClass,
    stepDeltaSum: stepDeltas.length ? Math.round(stepDeltas.reduce((a, b) => a + b, 0) * 100) / 100 : null,
    onWristSamples,

    maxGapSeconds: maxGapMs / 1000,
    lastSampleAgeSeconds: lastAgeSec,
    disconnectedSamples: disconnected,
    reportedQuality: reportedQualityCount ? reportedQualitySum / reportedQualityCount : null,

    hrCoverage,
    motionCoverage,
    strapCoverage,
    implausibleJumps,
  };

  return { features, quality: scoreQuality({ ...features }) };
}

/** Extract v2 features for every minute present in `samples`, in time order. */
export function extractV2SeriesFeatures(samples) {
  const byMinute = bucketSamplesByMinute(samples);
  const minutes = [...byMinute.keys()].sort((a, b) => a - b);
  const out = [];
  let prev = null;
  for (const m of minutes) {
    const row = extractV2MinuteFeatures(m, byMinute.get(m), prev);
    if (!row) continue;
    out.push(row);
    prev = row;
  }
  return out;
}
