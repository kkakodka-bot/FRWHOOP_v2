/**
 * Per-minute feature extraction and signal quality.
 *
 * One pass over the samples in a minute produces both the model inputs and the
 * per-channel quality scores, because they are computed from the same window
 * statistics (sample count, plausibility, jump rate, artifact fraction).
 *
 * Quality is deliberately *not* folded into the features: the estimator needs to
 * see "HR says 150 but I only trust it 0.2" rather than a silently attenuated HR.
 */

import {
  EXPECTED_SAMPLES_PER_MINUTE,
  LIMITS,
  clamp,
  num,
} from './constants.js';
import {
  bucketSamplesByMinute,
  median,
  minuteFloor,
  rrStats,
  scoreQuality,
  stddev,
} from '../signal/quality.js';

// Re-exported so every existing energy call site keeps working while there is
// only ONE definition of these, in signal/. See signal/quality.js.
export {
  bucketSamplesByMinute, minuteFloor, rrStats, scoreQuality,
};

const MINUTE_MS = 60_000;

/** Least-squares slope of hr against time, in bpm per minute. */
function slopePerMinute(points) {
  if (points.length < 3) return null;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of points) { sx += x; sy += y; }
  const mx = sx / points.length;
  const my = sy / points.length;
  let num_ = 0;
  let den = 0;
  for (const [x, y] of points) {
    num_ += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  if (den <= 0) return null;
  return (num_ / den) * MINUTE_MS;
}

/**
 * Extract the feature vector for one minute.
 *
 * @param {number} minuteMs   epoch ms of the minute start (UTC)
 * @param {Array}  samples    samples whose timestamp falls inside the minute
 * @param {object} prev       the previous minute's result, for slope/drift context
 */
export function extractMinuteFeatures(minuteMs, samples, prev = null) {
  const hrs = [];
  const hrPoints = [];
  const motions = [];
  const rrAll = [];
  const stages = new Map();
  let lastTs = null;
  let maxGapMs = 0;
  let implausibleJumps = 0;
  let prevHr = null;
  let prevHrTs = null;
  let disconnected = 0;
  let reportedQualitySum = 0;
  let reportedQualityCount = 0;

  for (const s of samples || []) {
    const ts = num(s.ts) ?? minuteFloor(s.t ?? s.datetime ?? s.at);
    if (ts == null) continue;
    if (lastTs != null) maxGapMs = Math.max(maxGapMs, ts - lastTs);
    lastTs = ts;

    if (s.connected === false) disconnected += 1;

    const q = num(s.q ?? s.quality);
    if (q != null) { reportedQualitySum += clamp(q, 0, 1); reportedQualityCount += 1; }

    const bpm = num(s.bpm ?? s.hr ?? s.heartRate);
    if (bpm != null && bpm >= LIMITS.hrMin && bpm <= LIMITS.hrMax) {
      // A >25 bpm step inside 10 s is not cardiac; it is an optical relock.
      if (prevHr != null && prevHrTs != null && ts - prevHrTs <= 10_000 && Math.abs(bpm - prevHr) > 25) {
        implausibleJumps += 1;
      }
      hrs.push(bpm);
      hrPoints.push([ts, bpm]);
      prevHr = bpm;
      prevHrTs = ts;
    }

    const mot = num(s.mot ?? s.motion);
    if (mot != null && mot >= 0 && mot <= LIMITS.motionMax) motions.push(mot);

    const rr = s.rr_ms ?? s.rrIntervals;
    if (Array.isArray(rr) && rr.length) rrAll.push(...rr);

    const stage = s.stage ?? s.sleep_stage;
    if (stage && stage !== 'none') stages.set(stage, (stages.get(stage) || 0) + 1);
  }

  if (!hrs.length && !motions.length) return null;

  const hrSorted = hrs.slice().sort((a, b) => a - b);
  const hrMean = hrs.length ? hrs.reduce((a, b) => a + b, 0) / hrs.length : null;
  const motMean = motions.length ? motions.reduce((a, b) => a + b, 0) / motions.length : null;
  const rr = rrStats(rrAll);

  let modalStage = null;
  let modalCount = 0;
  for (const [k, v] of stages) if (v > modalCount) { modalStage = k; modalCount = v; }

  const hrCoverage = clamp(hrs.length / EXPECTED_SAMPLES_PER_MINUTE, 0, 1);
  const motionCoverage = clamp(motions.length / EXPECTED_SAMPLES_PER_MINUTE, 0, 1);
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

    motionCount: motions.length,
    motion: motMean == null ? null : Math.round(motMean * 1000) / 1000,
    motionMax: motions.length ? Math.max(...motions) : null,
    motionStd: motMean == null ? null : Math.round(stddev(motions, motMean) * 1000) / 1000,
    // Intermittent effort (lifting sets) shows a high active fraction *and* high
    // variance; steady walking shows a high active fraction and low variance.
    motionActiveFraction: motions.length
      ? motions.filter((m) => m > 0.06).length / motions.length
      : null,

    sleepStage: modalStage,
    maxGapSeconds: maxGapMs / 1000,
    lastSampleAgeSeconds: lastAgeSec,
    disconnectedSamples: disconnected,
    reportedQuality: reportedQualityCount ? reportedQualitySum / reportedQualityCount : null,

    hrCoverage,
    motionCoverage,
    implausibleJumps,
  };

  return { features, quality: scoreQuality(features) };
}

/** Extract features for every minute present in `samples`, in time order. */
export function extractSeriesFeatures(samples) {
  const byMinute = bucketSamplesByMinute(samples);
  const minutes = [...byMinute.keys()].sort((a, b) => a - b);
  const out = [];
  let prev = null;
  for (const m of minutes) {
    const row = extractMinuteFeatures(m, byMinute.get(m), prev);
    if (!row) continue;
    out.push(row);
    prev = row;
  }
  return out;
}
