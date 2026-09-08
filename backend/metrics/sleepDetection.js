import { restBouts } from './vanHeesSleep.js';
import { hdczaSleepPeriods } from './hdczaSleep.js';
import { stageSession, stageEpochsDetailed, features } from './sleepStagerV2.js';
import { sessionScorability } from './scorability.js';
import { stageSessionV3 } from './sleepStagerV3.js';
import { shouldComputeSleepV3 } from './sleepV3Artifact.js';

export const DETECTION_ALGORITHM_VERSION = 'hybrid-hdcza-boundaries-v3';
export const STAGING_ALGORITHM_VERSION = 'noop-sleep-stager-v2-v1';

export const DETECTION_CONSTANTS = Object.freeze({
  gravityStillThresholdG: 0.01,
  stillWindowMin: 15,
  stillFraction: 0.70,
  maxGapMin: 20,
  mergeMin: 15,
  minSleepMin: 60,
  defaultIntervalSec: 60,
  daytimeBandStartHour: 11,
  daytimeBandEndHour: 20,
  nightContinuationGapMin: 90,
  daytimeMinSleepMin: 90,
  daytimeRestingHrMult: 0.95,
  maxMainSleepSpanSec: 16 * 60 * 60,
  morningStillnessWindowMin: 180,
  morningReonsetRestingHrMult: 0.90,
  bandStateAsleep: 2,
  morningReonsetBandAsleepFrac: 0.60,
  hrSleepBaselineMult: 1.05,
  quiescentHrSleepMult: 1.30,
  quiescentPostureVarG2: 0.05,
  quiescentStableFrac: 0.90,
  quiescentMinStableMinutes: 20,
  hrRefineMinSamples: 30,
  offWristHrGapMin: 20,
  maxOffWristSleepFraction: 0.50,
  hrDenseSpacingSec: 600,
  minGravitySamples: 3,
  sparseGravitySpanFrac: 0.5,
  sparseBridgeGapMin: 90,
  // Hybrid boundary refine: HDCZA pinpoints onset; a tight walk recovers the
  // 5-min forward-window that Van Hees clips at offset, without the 30-min
  // HDCZA bridge that collapses wake specificity.
  boundaryLookbackMin: 30,
  boundaryLookaheadMin: 25,
  boundaryWindowSec: 120,
  boundaryFailWindows: 3,
  boundaryStillFraction: 0.55,
  hdczaRefineBridgeGapMin: 12,
  hdczaRefineMinDurationMin: 20,
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function timestampSeconds(row) {
  const raw = row?.t ?? row?.datetime ?? row?.at ?? row?.ts ?? row?.timestamp;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return Math.floor(raw > 1e12 ? raw / 1000 : raw);
  }
  const milliseconds = Date.parse(String(raw || '').replace(' ', 'T'));
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
}

function vectorOf(row) {
  const source = row?.gravity || row?.accel || row?.accelerometer || row;
  const x = finite(source?.x ?? source?.gx ?? source?.gravity_x ?? source?.gravityX ?? source?.accel_x ?? source?.accelX);
  const y = finite(source?.y ?? source?.gy ?? source?.gravity_y ?? source?.gravityY ?? source?.accel_y ?? source?.accelY);
  const z = finite(source?.z ?? source?.gz ?? source?.gravity_z ?? source?.gravityZ ?? source?.accel_z ?? source?.accelZ);
  return x == null || y == null || z == null ? null : { x, y, z };
}

export function extractSleepStreams(samples = []) {
  const gravity = [];
  const hr = [];
  const rr = [];
  const bandSleepState = [];
  for (const row of samples) {
    const ts = timestampSeconds(row);
    if (ts == null) continue;
    const vector = vectorOf(row);
    if (vector) gravity.push({ ts, ...vector });
    const bpm = finite(row?.bpm ?? row?.heartRate);
    if (bpm != null && bpm >= 20 && bpm <= 240) hr.push({ ts, bpm: Math.round(bpm) });
    const intervals = row?.rr_ms ?? row?.rrIntervals ?? row?.rr;
    if (Array.isArray(intervals)) {
      for (const value of intervals) {
        const rrMs = finite(value);
        if (rrMs != null && rrMs >= 200 && rrMs <= 2500) rr.push({ ts, rrMs });
      }
    } else {
      const rrMs = finite(row?.rrMs);
      if (rrMs != null && rrMs >= 200 && rrMs <= 2500) rr.push({ ts, rrMs });
    }
    const state = finite(
      row?.band_sleep_state ?? row?.bandSleepState ?? row?.sleep_state ?? row?.sleepState,
    );
    if (state != null && Number.isInteger(state) && state >= 0 && state <= 3) {
      bandSleepState.push({ ts, state });
    }
  }
  gravity.sort((a, b) => a.ts - b.ts);
  hr.sort((a, b) => a.ts - b.ts);
  rr.sort((a, b) => a.ts - b.ts);
  bandSleepState.sort((a, b) => a.ts - b.ts);
  return { gravity, hr, rr, bandSleepState };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function gravityCoverage(gravity, hr = []) {
  const uniqueSeconds = new Set(gravity.map((row) => row.ts)).size;
  const spanSec = gravity.length >= 2 ? gravity.at(-1).ts - gravity[0].ts + 1 : 0;
  const largestGapSec = gravity.slice(1).reduce(
    (largest, row, index) => Math.max(largest, row.ts - gravity[index].ts),
    0,
  );
  const hrSpanSec = hr.length >= 2 ? hr.at(-1).ts - hr[0].ts : 0;
  const spanSparse = gravity.length >= 2 && hr.length >= 2 && hrSpanSec > 0
    && (gravity.at(-1).ts - gravity[0].ts)
      < DETECTION_CONSTANTS.sparseGravitySpanFrac * hrSpanSec;
  // Backend history can contain gravity-only rows. A large hole is sparse even
  // without companion HR; two far-apart vectors cannot prove continuous rest.
  const sparse = gravity.length >= 2
    && (spanSparse || largestGapSec > DETECTION_CONSTANTS.maxGapMin * 60);
  const sufficient = gravity.length >= DETECTION_CONSTANTS.minGravitySamples
    && spanSec >= DETECTION_CONSTANTS.minSleepMin * 60;
  return {
    sampleCount: gravity.length,
    uniqueSeconds,
    spanSec,
    coverageRatio: spanSec > 0 ? uniqueSeconds / spanSec : 0,
    largestGapSec,
    sparse,
    sufficient,
    adequate: sufficient && !sparse,
  };
}

function gravityDeltas(gravity) {
  return gravity.map((row, index) => {
    if (!index) return 0;
    const previous = gravity[index - 1];
    return Math.sqrt((previous.x - row.x) ** 2 + (previous.y - row.y) ** 2 + (previous.z - row.z) ** 2);
  });
}

function medianIntervalSec(times) {
  const gaps = [];
  for (let i = 1; i < times.length; i += 1) {
    const gap = times[i] - times[i - 1];
    if (gap > 0 && gap < 300) gaps.push(gap);
  }
  return median(gaps) || DETECTION_CONSTANTS.defaultIntervalSec;
}

function classifyStill(gravity) {
  if (gravity.length < 2) return Array(gravity.length).fill(false);
  const deltas = gravityDeltas(gravity);
  const size = Math.max(3, Math.floor(
    DETECTION_CONSTANTS.stillWindowMin * 60 / Math.max(1, medianIntervalSec(gravity.map((g) => g.ts))),
  ));
  const half = Math.floor(size / 2);
  const prefix = [0];
  for (const delta of deltas) {
    prefix.push(prefix.at(-1) + (delta < DETECTION_CONSTANTS.gravityStillThresholdG ? 1 : 0));
  }
  return gravity.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(gravity.length, i + half + 1);
    return (prefix[hi] - prefix[lo]) / (hi - lo) >= DETECTION_CONSTANTS.stillFraction;
  });
}

function hrBandAcross(start, end, hr, baseline) {
  if (!Number.isFinite(baseline)) return false;
  const values = hr.filter((row) => row.ts > start && row.ts <= end).map((row) => row.bpm);
  if (!values.length) return false;
  return values.reduce((sum, value) => sum + value, 0) / values.length
    <= baseline * DETECTION_CONSTANTS.hrSleepBaselineMult;
}

function buildRuns(gravity, flags, sparse, hr, baseline) {
  if (!gravity.length) return [];
  const periods = [];
  let runStart = 0;
  for (let i = 1; i <= gravity.length; i += 1) {
    let close = i === gravity.length;
    if (!close) {
      const changed = flags[i] !== flags[runStart];
      let gapExceeded = gravity[i].ts - gravity[i - 1].ts > DETECTION_CONSTANTS.maxGapMin * 60;
      if (sparse && gapExceeded && !changed && flags[runStart]
        && hrBandAcross(gravity[i - 1].ts, gravity[i].ts, hr, baseline)) {
        gapExceeded = false;
      }
      close = changed || gapExceeded;
    }
    if (close) {
      periods.push({
        stage: flags[runStart] ? 'sleep' : 'active',
        start: gravity[runStart].ts,
        end: gravity[i - 1].ts,
      });
      runStart = i;
    }
  }
  return periods;
}

function mergePeriods(periods) {
  if (!periods.length) return [];
  const pending = periods.map((period) => ({ ...period }));
  const merged = [];
  let i = 0;
  const threshold = DETECTION_CONSTANTS.mergeMin * 60;
  while (i < pending.length) {
    const current = pending[i];
    if (current.end - current.start >= threshold) {
      merged.push(current);
      i += 1;
      continue;
    }
    const hasPrevious = i > 0 && merged.length > 0;
    const hasNext = i + 1 < pending.length;
    const bridgesSame = hasPrevious && hasNext && pending[i - 1].stage === pending[i + 1].stage;
    if (bridgesSame) {
      const previous = merged.pop();
      merged.push({ stage: previous.stage, start: previous.start, end: pending[i + 1].end });
      i += 2;
    } else if (hasNext) {
      pending[i + 1] = { ...pending[i + 1], start: current.start };
      i += 1;
    } else if (hasPrevious) {
      const previous = merged.pop();
      merged.push({ stage: previous.stage, start: previous.start, end: current.end });
      i += 1;
    } else i += 1;
  }
  return merged;
}

function sessionRestingHr(start, end, hr) {
  const segment = hr.filter((row) => row.ts >= start && row.ts <= end);
  if (!segment.length) return null;
  const means = [];
  for (let t = start; t < end; t += 300) {
    const values = segment.filter((row) => row.ts >= t && row.ts < t + 300).map((row) => row.bpm);
    if (values.length) means.push(values.reduce((sum, value) => sum + value, 0) / values.length);
  }
  return means.length ? Math.round(Math.min(...means)) : null;
}

function isDaytime(period, tzOffsetSeconds) {
  const center = period.start + Math.floor((period.end - period.start) / 2);
  const local = ((center + tzOffsetSeconds) % 86_400 + 86_400) % 86_400;
  const hour = Math.floor(local / 3600);
  return hour >= DETECTION_CONSTANTS.daytimeBandStartHour
    && hour < DETECTION_CONSTANTS.daytimeBandEndHour;
}

function isOvernightOnset(start, tzOffsetSeconds) {
  const local = ((start + tzOffsetSeconds) % 86_400 + 86_400) % 86_400;
  const hour = Math.floor(local / 3600);
  return hour < DETECTION_CONSTANTS.daytimeBandStartHour
    || hour >= DETECTION_CONSTANTS.daytimeBandEndHour;
}

export function passesDaytimeGuard(period, restingHr, baseline) {
  return period.end - period.start >= DETECTION_CONSTANTS.daytimeMinSleepMin * 60
    && Number.isFinite(restingHr)
    && Number.isFinite(baseline)
    && restingHr <= baseline * DETECTION_CONSTANTS.daytimeRestingHrMult;
}

export function bandStateConfirmsAsleep(period, bandSleepState = []) {
  const inBlock = bandSleepState.filter(
    (row) => row.ts >= period.start && row.ts <= period.end,
  );
  if (!inBlock.length) return false;
  const asleep = inBlock.filter(
    (row) => row.state === DETECTION_CONSTANTS.bandStateAsleep,
  ).length;
  return asleep / inBlock.length >= DETECTION_CONSTANTS.morningReonsetBandAsleepFrac;
}

export function passesMorningStillnessGuard(
  period,
  restingHr,
  baseline,
  morningWakeEnd,
  bandSleepState = [],
) {
  if (!passesDaytimeGuard(period, restingHr, baseline)) return false;
  const nearWake = Number.isFinite(morningWakeEnd)
    && period.start >= morningWakeEnd
    && period.start - morningWakeEnd <= DETECTION_CONSTANTS.morningStillnessWindowMin * 60;
  if (!nearWake) return true;
  if (bandStateConfirmsAsleep(period, bandSleepState)) return true;
  return restingHr <= baseline * DETECTION_CONSTANTS.morningReonsetRestingHrMult;
}

export function offWristHrGapSpans(period, hr = []) {
  if (!hr.length || period.end <= period.start) return [];
  const sortedAll = [...hr].sort((a, b) => a.ts - b.ts);
  const streamSpan = sortedAll.at(-1).ts - sortedAll[0].ts;
  if (streamSpan >= DETECTION_CONSTANTS.hrDenseSpacingSec
    && hr.length < streamSpan / DETECTION_CONSTANTS.hrDenseSpacingSec) return [];
  const gapSec = DETECTION_CONSTANTS.offWristHrGapMin * 60;
  const segment = sortedAll.filter((row) => row.ts >= period.start && row.ts <= period.end);
  if (!segment.length) {
    return period.end - period.start >= gapSec
      ? [{ start: period.start, end: period.end }]
      : [];
  }
  const spans = [];
  if (segment[0].ts - period.start >= gapSec) {
    spans.push({ start: period.start, end: segment[0].ts });
  }
  for (let i = 1; i < segment.length; i += 1) {
    if (segment[i].ts - segment[i - 1].ts >= gapSec) {
      spans.push({ start: segment[i - 1].ts, end: segment[i].ts });
    }
  }
  if (period.end - segment.at(-1).ts >= gapSec) {
    spans.push({ start: segment.at(-1).ts, end: period.end });
  }
  return spans;
}

export function offWristFraction(period, hr = [], wristOff = []) {
  const duration = period.end - period.start;
  if (duration <= 0) return 0;
  const spans = offWristHrGapSpans(period, hr);
  for (const interval of wristOff) {
    const start = Math.max(interval.start, period.start);
    const end = Math.min(interval.end, period.end);
    if (end > start) spans.push({ start, end });
  }
  if (!spans.length) return 0;
  spans.sort((a, b) => a.start - b.start);
  let covered = 0;
  let currentStart = spans[0].start;
  let currentEnd = spans[0].end;
  for (const span of spans.slice(1)) {
    if (span.start <= currentEnd) currentEnd = Math.max(currentEnd, span.end);
    else {
      covered += currentEnd - currentStart;
      currentStart = span.start;
      currentEnd = span.end;
    }
  }
  covered += currentEnd - currentStart;
  return covered / duration;
}

function postureVariance(samples) {
  if (samples.length < 2) return null;
  const mean = samples.reduce(
    (sum, sample) => [sum[0] + sample.x, sum[1] + sample.y, sum[2] + sample.z],
    [0, 0, 0],
  ).map((sum) => sum / samples.length);
  return samples.reduce(
    (sum, sample) => sum
      + (sample.x - mean[0]) ** 2
      + (sample.y - mean[1]) ** 2
      + (sample.z - mean[2]) ** 2,
    0,
  ) / samples.length;
}

function deeplyQuiescent(period, gravity) {
  const byMinute = new Map();
  for (const sample of gravity) {
    if (sample.ts < period.start || sample.ts >= period.end) continue;
    const minute = Math.floor(sample.ts / 60);
    if (!byMinute.has(minute)) byMinute.set(minute, []);
    byMinute.get(minute).push(sample);
  }
  let judged = 0;
  let stable = 0;
  for (const samples of byMinute.values()) {
    const variance = postureVariance(samples);
    if (variance == null) continue;
    judged += 1;
    if (variance < DETECTION_CONSTANTS.quiescentPostureVarG2) stable += 1;
  }
  return judged >= DETECTION_CONSTANTS.quiescentMinStableMinutes
    && stable / judged >= DETECTION_CONSTANTS.quiescentStableFrac;
}

function confirmWithHr(period, hr, baseline, gravity) {
  if (!Number.isFinite(baseline)) return true;
  const values = hr.filter((row) => row.ts >= period.start && row.ts <= period.end).map((row) => row.bpm);
  if (values.length < DETECTION_CONSTANTS.hrRefineMinSamples) return true;
  const multiplier = deeplyQuiescent(period, gravity)
    ? DETECTION_CONSTANTS.quiescentHrSleepMult
    : DETECTION_CONSTANTS.hrSleepBaselineMult;
  return median(values) <= baseline * multiplier;
}

function stillnessFraction(start, end, gravity) {
  const samples = gravity.filter((row) => row.ts >= start && row.ts < end);
  if (samples.length < 2) return null;
  let still = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const previous = samples[i - 1];
    const row = samples[i];
    const delta = Math.sqrt(
      (previous.x - row.x) ** 2 + (previous.y - row.y) ** 2 + (previous.z - row.z) ** 2,
    );
    if (delta < DETECTION_CONSTANTS.gravityStillThresholdG) still += 1;
  }
  return still / (samples.length - 1);
}

function medianHrBetween(start, end, hr) {
  const values = hr.filter((row) => row.ts >= start && row.ts < end).map((row) => row.bpm);
  return median(values);
}

export function windowLooksLikeSleep(start, end, gravity, hr, baseline) {
  if (end <= start) return false;
  const still = stillnessFraction(start, end, gravity);
  const medHr = medianHrBetween(start, end, hr);
  if (still == null || still < DETECTION_CONSTANTS.boundaryStillFraction) return false;
  if (Number.isFinite(baseline) && medHr != null
    && medHr > baseline * DETECTION_CONSTANTS.hrSleepBaselineMult) return false;
  return true;
}

/**
 * Merge consecutive overnight sleep bouts separated by a plausible WASO
 * (bathroom, brief arousal). Morning naps that fail the daytime/morning
 * guards never reach this function, so they cannot be glued onto the night.
 */
export function mergeCloseSleepPeriods(periods, {
  maxGapSec = DETECTION_CONSTANTS.nightContinuationGapMin * 60,
  maxSpanSec = DETECTION_CONSTANTS.maxMainSleepSpanSec,
  hr = [],
  wristOff = [],
} = {}) {
  const sleep = periods
    .filter((period) => period.stage === 'sleep')
    .sort((a, b) => a.start - b.start)
    .map((period) => ({ ...period }));
  if (sleep.length < 2) return sleep;
  const merged = [];
  for (const period of sleep) {
    const previous = merged.at(-1);
    if (!previous) {
      merged.push({ ...period, parts: [{ start: period.start, end: period.end }] });
      continue;
    }
    const gap = period.start - previous.end;
    const span = period.end - previous.start;
    if (gap < 0 || gap > maxGapSec || span > maxSpanSec) {
      merged.push(period);
      continue;
    }
    const combined = { stage: 'sleep', start: previous.start, end: Math.max(previous.end, period.end) };
    if (offWristFraction(combined, hr, wristOff) >= DETECTION_CONSTANTS.maxOffWristSleepFraction) {
      merged.push(period);
      continue;
    }
    previous.parts = [
      ...(previous.parts || [{ start: previous.start, end: previous.end }]),
      { start: period.start, end: period.end },
    ];
    previous.end = combined.end;
  }
  return merged;
}

function walkSleepBoundary(period, gravity, hr, baseline, direction) {
  const step = 30;
  const windowSec = DETECTION_CONSTANTS.boundaryWindowSec;
  const maxSec = (direction < 0
    ? DETECTION_CONSTANTS.boundaryLookbackMin
    : DETECTION_CONSTANTS.boundaryLookaheadMin) * 60;
  let edge = direction < 0 ? period.start : period.end;
  let fail = 0;
  for (let offset = 0; offset <= maxSec; offset += step) {
    const lo = direction < 0 ? period.start - offset - windowSec : period.end + offset;
    const hi = lo + windowSec;
    if (hi <= lo) continue;
    if (windowLooksLikeSleep(lo, hi, gravity, hr, baseline)) {
      edge = direction < 0 ? lo : hi;
      fail = 0;
    } else {
      fail += 1;
      if (fail >= DETECTION_CONSTANTS.boundaryFailWindows) break;
    }
  }
  return edge;
}

/**
 * Tighten in-bed bounds around a guard-accepted sleep bout.
 * HDCZA (short bridge) nominates an earlier onset; a still+HR walk recovers
 * the Van Hees forward-window clip at wake without bridging into morning sit.
 */
export function refineSleepBoundaries(period, gravity, hr, baseline, { sparse = false } = {}) {
  if (sparse) return { ...period };
  let start = period.start;
  let end = period.end;
  if (gravity.length >= 2) {
    const pad = Math.max(
      DETECTION_CONSTANTS.boundaryLookbackMin,
      DETECTION_CONSTANTS.boundaryLookaheadMin,
    ) * 60;
    const nearby = gravity.filter((row) => row.ts >= start - pad && row.ts <= end + pad);
    const hdcza = hdczaSleepPeriods(nearby, {
      bridgeGapMin: DETECTION_CONSTANTS.hdczaRefineBridgeGapMin,
      minDurationMin: DETECTION_CONSTANTS.hdczaRefineMinDurationMin,
    });
    const overlapping = hdcza.filter((bout) => bout.onsetSec < end && bout.offsetSec > start);
    if (overlapping.length) {
      const earliest = Math.min(...overlapping.map((bout) => bout.onsetSec));
      const latest = Math.max(...overlapping.map((bout) => bout.offsetSec));
      if (earliest < start && earliest >= start - DETECTION_CONSTANTS.boundaryLookbackMin * 60
        && windowLooksLikeSleep(earliest, start, gravity, hr, baseline)) {
        start = earliest;
      }
      if (latest > end && latest <= end + DETECTION_CONSTANTS.boundaryLookaheadMin * 60
        && windowLooksLikeSleep(end, latest, gravity, hr, baseline)) {
        end = latest;
      }
    }
  }
  start = Math.min(start, walkSleepBoundary({ start, end }, gravity, hr, baseline, -1));
  end = Math.max(end, walkSleepBoundary({ start, end }, gravity, hr, baseline, 1));
  // Van Hees / HDCZA mark a sample immobile only if the *next* 5 minutes stay
  // still, so offset is clipped 5 minutes early. Restore that confirm window
  // when it still contains worn, sleep-like HR (do not require the noisy
  // 0.01 g still-fraction, which REM/light micro-motion fails).
  const confirmSec = 5 * 60;
  const tailLo = end;
  const tailHi = end + confirmSec;
  const hasGrav = gravity.some((row) => row.ts >= tailLo && row.ts < tailHi);
  const tailHr = medianHrBetween(tailLo, tailHi, hr);
  const hrOk = !Number.isFinite(baseline) || tailHr == null
    || tailHr <= baseline * DETECTION_CONSTANTS.hrSleepBaselineMult;
  if (hasGrav && hrOk) end = tailHi;
  if (end - start > DETECTION_CONSTANTS.maxMainSleepSpanSec) {
    return { ...period, start: period.start, end: period.end };
  }
  return { ...period, start, end };
}

const WAKE_OVERLAY_EPOCH_SEC = 30;

/**
 * A merged night keeps one in-bed span so onset/wake are the real night, not
 * the longest fragment. Epochs that sat in the gap between the original rest
 * bouts were not sleep — force them to wake (WASO) instead of letting the
 * stager blend them into light/REM.
 */
export function overlayWakeInMergedGaps(stages, start, end, sourceBouts = []) {
  const parts = [...sourceBouts]
    .filter((bout) => bout.end > start && bout.start < end)
    .sort((a, b) => a.start - b.start);
  if (parts.length < 2) return stages;
  const gaps = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    const lo = Math.max(start, parts[i].end);
    const hi = Math.min(end, parts[i + 1].start);
    if (hi - lo >= 60) gaps.push({ start: lo, end: hi });
  }
  if (!gaps.length) return stages;
  const inGap = (t) => gaps.some((gap) => t >= gap.start && t < gap.end);
  const out = [];
  for (let t = start; t < end; t += WAKE_OVERLAY_EPOCH_SEC) {
    const hi = Math.min(end, t + WAKE_OVERLAY_EPOCH_SEC);
    const seg = stages.find((s) => t >= s.start && t < s.end);
    const stage = inGap(t) ? 'wake' : (seg?.stage || 'wake');
    const last = out.at(-1);
    if (last?.stage === stage) last.end = hi;
    else out.push({ start: t, end: hi, stage });
  }
  return out.length ? out : stages;
}

export function detectSleepSessions({
  gravity = [],
  hr = [],
  rr = [],
  wristOff = [],
  bandSleepState = [],
  tzOffsetSeconds = 0,
  samples = [],
  imuRecords = [],
  ppgRecords = [],
  events = [],
  shadowV3 = shouldComputeSleepV3(),
  sleepV3Artifact = null,
  allowSyntheticV3 = false,
  placement = 'unknown',
  deviceFamily = null,
  firmware = null,
  timeZone = null,
} = {}) {
  const grav = [...gravity].sort((a, b) => a.ts - b.ts);
  const hrs = [...hr].sort((a, b) => a.ts - b.ts);
  const rrs = [...rr].sort((a, b) => a.ts - b.ts);
  const coverage = gravityCoverage(grav, hrs);
  if (!coverage.sufficient) return { sessions: [], coverage, fallbackReason: 'insufficient_gravity' };
  const baseline = median(hrs.map((row) => row.bpm));
  const bouts = coverage.sparse ? [] : restBouts(grav);
  const longest = bouts.reduce((best, bout) => (!best || bout.sptSec > best.sptSec ? bout : best), null);
  let periods;
  let detector;
  let fallbackReason = null;
  if (longest && longest.sptSec > DETECTION_CONSTANTS.minSleepMin * 60
    && longest.sptSec <= DETECTION_CONSTANTS.maxMainSleepSpanSec) {
    periods = bouts.map((bout) => ({ stage: 'sleep', start: bout.onsetSec, end: bout.offsetSec }));
    detector = 'van_hees';
  } else {
    periods = mergePeriods(buildRuns(grav, classifyStill(grav), coverage.sparse, hrs, baseline));
    detector = coverage.sparse ? 'sparse_gravity_hr_vouched' : 'gravity_delta';
    fallbackReason = coverage.sparse
      ? 'sparse_gravity_hr_vouched'
      : 'van_hees_no_sustained_bout';
  }

  const accepted = [];
  let previousEnd = null;
  let chainFromOvernight = false;
  for (const period of periods) {
    if (period.stage !== 'sleep') continue;
    const duration = period.end - period.start;
    if (duration <= DETECTION_CONSTANTS.minSleepMin * 60
      || duration > DETECTION_CONSTANTS.maxMainSleepSpanSec
      || !confirmWithHr(period, hrs, baseline, grav)) continue;
    const offWrist = offWristFraction(period, hrs, wristOff);
    if (offWrist >= DETECTION_CONSTANTS.maxOffWristSleepFraction) continue;
    const restingHr = sessionRestingHr(period.start, period.end, hrs);
    const continues = previousEnd != null
      && period.start - previousEnd <= DETECTION_CONSTANTS.nightContinuationGapMin * 60;
    const nightTail = continues && chainFromOvernight;
    const daytime = isDaytime(period, tzOffsetSeconds);
    if (daytime && !nightTail) {
      const morningWakeEnd = chainFromOvernight ? previousEnd : null;
      if (!passesMorningStillnessGuard(
        period,
        restingHr,
        baseline,
        morningWakeEnd,
        bandSleepState,
      )) continue;
    }
    accepted.push({
      stage: 'sleep',
      start: period.start,
      end: period.end,
      detector,
      fallbackReason,
    });
    if (!continues) chainFromOvernight = isOvernightOnset(period.start, tzOffsetSeconds);
    previousEnd = period.end;
  }

  const merged = mergeCloseSleepPeriods(accepted, {
    hr: hrs,
    wristOff,
  });
  const sessions = [];
  for (const bout of merged) {
    const refined = refineSleepBoundaries(bout, grav, hrs, baseline, { sparse: coverage.sparse });
    const duration = refined.end - refined.start;
    if (duration <= DETECTION_CONSTANTS.minSleepMin * 60
      || duration > DETECTION_CONSTANTS.maxMainSleepSpanSec
      || !confirmWithHr(refined, hrs, baseline, grav)) continue;
    if (offWristFraction(refined, hrs, wristOff) >= DETECTION_CONSTANTS.maxOffWristSleepFraction) {
      continue;
    }
    const restingHr = sessionRestingHr(refined.start, refined.end, hrs);
    const feats = features(refined.start, refined.end, grav, hrs, rrs);
    const stages = overlayWakeInMergedGaps(
      stageSession({
        start: refined.start,
        end: refined.end,
        gravity: grav,
        hr: hrs,
        rr: rrs,
      }),
      refined.start,
      refined.end,
      bout.parts || [{ start: bout.start, end: bout.end }],
    );
    const epochDetail = stageEpochsDetailed(feats);
    const offWristMin = offWristFraction(
      { start: refined.start, end: refined.end },
      hrs,
      wristOff,
    ) * (refined.end - refined.start) / 60;
    const session = {
      epochProbabilities: epochDetail.map((e) => ({ start: e.start, stage: e.stage, probs: e.probs })),
      epochCoverage: epochDetail.map((e) => ({
        start: e.start, hr: e.hrPresent, rr: e.rrPresent, acc: e.accPresent, coverage: e.coverage,
      })),
      scorability: sessionScorability({
        epochs: epochDetail,
        offWristDurationMin: Math.round(offWristMin),
        detector,
        fallbackReason,
      }),
      startSec: refined.start,
      endSec: refined.end,
      stages,
      restingHr,
      detector,
      confidence: coverage.sparse ? 'low' : 'high',
      fallbackReason,
      shadowV3: null,
      provenance: {
        detectionAlgorithm: detector,
        detectionVersion: DETECTION_ALGORITHM_VERSION,
        stagingAlgorithm: 'sleep_stager_v2',
        stagingVersion: STAGING_ALGORITHM_VERSION,
        gravityAuthoritative: coverage.adequate,
        fallbackReason,
        boundaryRefined: refined.start !== bout.start || refined.end !== bout.end,
        overnightMerged: merged.length < accepted.length,
        canonicalStager: 'sleep_stager_v2',
      },
    };
    if (shadowV3) {
      try {
        session.shadowV3 = stageSessionV3({
          start: refined.start,
          end: refined.end,
          gravity: grav,
          hr: hrs,
          rr: rrs,
          samples,
          imuRecords,
          ppgRecords,
          events,
          wristOff,
          sourceBouts: bout.parts || [{ start: bout.start, end: bout.end }],
          tzOffsetSeconds,
          timeZone,
          isNap: false,
          artifact: sleepV3Artifact,
          allowSynthetic: allowSyntheticV3,
          placement,
          deviceFamily,
          firmware,
        });
      } catch (err) {
        session.shadowV3 = {
          ok: true,
          fallback: true,
          fallback_reason: 'inference_exception',
          v3_not_executed_reason: 'inference_exception',
          stages: session.stages,
          epochs: [],
          error: String(err?.message || err).slice(0, 200),
        };
      }
    }
    sessions.push(session);
  }
  sessions.sort((a, b) => a.startSec - b.startSec);
  return {
    sessions,
    coverage,
    fallbackReason,
  };
}
