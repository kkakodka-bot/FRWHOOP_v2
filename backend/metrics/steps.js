import { localHour, localDateKey } from '../time/dayBoundary.js';

/**
 * Step accumulation from normalized per-second WHOOP historical samples.
 *
 * v1 (`frwhoop-steps-v1`) converts the WHOOP 5 v18 `step_motion_counter`
 * (and optional per-second deltas) into a wrap-aware daily total. That
 * counter is a motion/step *proxy*, not validated as WHOOP's official Steps
 * output. Canonical daily_metrics.steps stays on v1 until v2 beats it on
 * held-out labeled IMU data. See `stepsV2.js`.
 *
 * Pipeline rules:
 *  - `steps` (per-second delta) wins over `step_cumulative` on the same row.
 *  - u16 wrap is unwrapped; a mid-range drop is a stream reset (delta 0).
 *  - Dedupe is device + sensor second + counter, so two different counters
 *    in the same wall second are both kept.
 *  - `carryInCounter` (yesterday's last counter) attributes a midnight-crossing
 *    jump to the new day instead of treating the first sample as a baseline.
 *  - Output is deterministic and independent of sample arrival order.
 */

export const STEPS_ALGORITHM_VERSION = 'frwhoop-steps-v1';
export const STEP_COUNTER_ROLLOVER = 65536; // WHOOP5 u16 step_motion_counter
const MAX_DELTA_PER_SECOND = 20; // far above running cadence (~5/s)

export function sampleTime(s) {
  return Date.parse(s?.t ?? s?.datetime ?? s?.at ?? '');
}

/** Present numeric field. `Number(null)` is 0; live HR rows store `step_cumulative: null`. */
export function presentNumber(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function hasStepSignal(sample) {
  return presentNumber(sample?.steps) != null || presentNumber(sample?.step_cumulative) != null;
}

export function sampleDeviceId(sample) {
  return String(sample?.device_id || sample?.deviceId || 'strap');
}

/**
 * Prefer the strap's numeric sensor timestamp when present so two counters
 * that share a rounded wall ISO still stay distinct.
 */
export function sampleSensorSec(sample) {
  const ts = presentNumber(sample?.sensor_ts);
  if (ts != null && ts > 1e9 && ts < 4e9) return Math.floor(ts);
  const t = sampleTime(sample);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export function stepDeltaFor(sample, prev) {
  // Explicit per-second delta wins when present and valid.
  const explicit = presentNumber(sample?.steps);
  if (explicit != null) {
    if (explicit >= 0 && explicit <= MAX_DELTA_PER_SECOND) return { delta: explicit, from: 'delta' };
    // An out-of-range explicit delta is a unit error. Do not poison the total.
    return { delta: 0, from: 'delta', refused: true };
  }
  // Fall back to cumulative-counter differencing with rollover.
  const cur = presentNumber(sample?.step_cumulative);
  if (cur == null || cur < 0) return null;
  if (prev == null) return { delta: 0, from: 'cumulative', reset: false };
  let d = cur - prev;
    if (d < 0) {
      // Real u16 wrap is from near 65535. A drop from mid-range is a new history
      // chunk or device reset — unwrapping it invents tens of thousands of steps.
      if (prev < STEP_COUNTER_ROLLOVER - 512) {
        return { delta: 0, from: 'cumulative', reset: true };
      }
      d = cur + (STEP_COUNTER_ROLLOVER - prev);
      return { delta: Math.round(d), from: 'cumulative', wrap: true };
    }
    if (d < 0) return { delta: 0, from: 'cumulative', refused: true };
    return { delta: Math.round(d), from: 'cumulative' };
}

function sortKey(sample) {
  const t = sampleTime(sample);
  const sensor = sampleSensorSec(sample) ?? 0;
  const seq = presentNumber(sample?.seq) ?? 0;
  const counter = presentNumber(sample?.step_cumulative) ?? 0;
  return [t, sensor, seq, counter];
}

function cmpSort(a, b) {
  const aa = sortKey(a);
  const bb = sortKey(b);
  for (let i = 0; i < aa.length; i += 1) {
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  }
  return 0;
}

function addMinuteDelta(byMinute, bucketMs, count, { allocated, coalesced }) {
  if (!(count > 0) || !Number.isFinite(bucketMs)) return;
  const bucket = byMinute.get(bucketMs) || {
    start_at: new Date(bucketMs).toISOString(),
    count: 0,
    allocated: false,
    coalesced: false,
  };
  bucket.count += count;
  bucket.allocated ||= allocated;
  bucket.coalesced ||= coalesced;
  byMinute.set(bucketMs, bucket);
}

function allocateMinuteDelta(byMinute, {
  delta, atMs, previousAtMs, from,
}) {
  if (!(delta > 0) || !Number.isFinite(atMs)) return;
  const canAllocate = from === 'cumulative'
    && Number.isFinite(previousAtMs)
    && atMs > previousAtMs + 1000;
  if (!canAllocate) {
    addMinuteDelta(byMinute, Math.floor(atMs / 60000) * 60000, delta, {
      allocated: false,
      coalesced: false,
    });
    return;
  }
  const durationMs = atMs - previousAtMs;
  const first = Math.floor(previousAtMs / 60000) * 60000;
  const last = Math.floor((atMs - 1) / 60000) * 60000;
  for (let bucketMs = first; bucketMs <= last; bucketMs += 60000) {
    const overlapMs = Math.max(
      0,
      Math.min(atMs, bucketMs + 60000) - Math.max(previousAtMs, bucketMs),
    );
    addMinuteDelta(byMinute, bucketMs, delta * overlapMs / durationMs, {
      allocated: true,
      coalesced: true,
    });
  }
}

/**
 * Keep every distinct (device, sensor-second, counter) observation.
 * Explicit-delta-only rows in the same second collapse to the first row
 * unless their deltas differ — different counters always survive.
 */
export function dedupeStepSamples(samples = []) {
  const groups = new Map();
  for (const s of samples) {
    const sec = sampleSensorSec(s);
    if (sec == null) continue;
    const device = sampleDeviceId(s);
    const key = `${device}:${sec}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const out = [];
  for (const rows of groups.values()) {
    const withCounter = rows.filter((s) => presentNumber(s.step_cumulative) != null);
    if (withCounter.length) {
      const seen = new Set();
      const uniq = [];
      for (const s of withCounter.sort(cmpSort)) {
        const c = presentNumber(s.step_cumulative);
        if (seen.has(c)) continue;
        seen.add(c);
        uniq.push(s);
      }
      out.push(...uniq);
      continue;
    }
    const seenDelta = new Set();
    for (const s of rows.sort(cmpSort)) {
      const d = presentNumber(s.steps);
      const mark = d == null ? 'none' : d;
      if (seenDelta.has(mark)) continue;
      seenDelta.add(mark);
      out.push(s);
    }
  }
  return out.sort(cmpSort);
}

/**
 * Last cumulative counter strictly before `day` in `samples`, used as the
 * midnight carry-in so a walk across local midnight is not dropped.
 */
export function carryInCounterForDay(samples, day, timeZone = 'UTC') {
  if (!day) return null;
  let best = null;
  let bestT = -Infinity;
  for (const s of samples || []) {
    const t = sampleTime(s);
    if (!Number.isFinite(t)) continue;
    const d = localDateKey(s.t || s.datetime || s.at, timeZone);
    if (d >= day) continue;
    const c = presentNumber(s.step_cumulative);
    if (c == null) continue;
    if (t >= bestT) {
      bestT = t;
      best = c;
    }
  }
  return best;
}

function accumulateDevice(rows, { timeZone, carryInCounter }) {
  const byHour = new Map();
  const byMinute = new Map();
  let total = 0;
  let refused = 0;
  let countedSeconds = 0;
  let prevCounter = carryInCounter;
  let prevSec = null;
  let previousAtMs = null;
  let usedCarryIn = carryInCounter != null;
  let wraps = 0;
  let resets = 0;
  for (const s of rows) {
    let delta = 0;
    const r = stepDeltaFor(s, prevCounter);
    if (r && r.reset) resets += 1;
    if (r && r.wrap) wraps += 1;
    if (r && r.delta) {
      const gapSeconds = prevSec == null ? 1 : Math.max(1, Math.round((s._sec - prevSec)));
      const perSecond = r.delta / gapSeconds;
      if (perSecond > MAX_DELTA_PER_SECOND) {
        refused += 1;
        delta = 0;
      } else {
        delta = r.delta;
      }
    }
    if (r && r.refused) refused += 1;
    total += delta;
    const atMs = sampleTime(s);
    allocateMinuteDelta(byMinute, {
      delta,
      atMs,
      previousAtMs,
      from: r?.from,
    });
    if (delta > 0 || r || presentNumber(s.steps) != null || presentNumber(s.step_cumulative) != null) {
      countedSeconds += 1;
    }
    const counter = presentNumber(s.step_cumulative);
    if (counter != null) {
      prevCounter = counter;
    } else if (r && r.from === 'cumulative' && prevCounter != null) {
      prevCounter += delta;
    }
    if (delta > 0 || presentNumber(s.steps) != null) {
      const h = localHour(s.t ?? s.datetime ?? s.at, timeZone);
      if (Number.isFinite(h)) {
        const bucket = byHour.get(h) || { steps: 0, seconds: 0 };
        bucket.steps += delta;
        bucket.seconds += 1;
        byHour.set(h, bucket);
      }
    }
    prevSec = s._sec;
    previousAtMs = atMs;
  }
  return {
    total, refused, countedSeconds, byHour, byMinute, usedCarryIn, wraps, resets,
  };
}

export function accumulateSteps(samples, {
  timeZone = 'UTC',
  carryInCounter = null,
} = {}) {
  const rows = (Array.isArray(samples) ? samples : [])
    .filter((s) => s && Number.isFinite(sampleTime(s)) && hasStepSignal(s));
  if (!rows.length) {
    return {
      total: 0, byHour: [], coverage_seconds: 0, source: 'whoop_v18_step_counter',
      buckets_60s: [],
      algorithm_version: STEPS_ALGORITHM_VERSION, confidence: 0,
      status: 'unavailable', detail: 'no_step_samples',
      used_carry_in: false,
    };
  }

  const uniq = dedupeStepSamples(rows).map((s) => ({ ...s, _sec: sampleSensorSec(s) }))
    .filter((s) => s._sec != null);
  if (!uniq.length) {
    return {
      total: 0, byHour: [], coverage_seconds: 0,
      buckets_60s: [],
      source: 'whoop_v18_step_counter', algorithm_version: STEPS_ALGORITHM_VERSION,
      confidence: 0, status: 'unavailable', detail: 'no_valid_timestamps',
      used_carry_in: false,
    };
  }

  const byDevice = new Map();
  for (const s of uniq) {
    const id = sampleDeviceId(s);
    if (!byDevice.has(id)) byDevice.set(id, []);
    byDevice.get(id).push(s);
  }

  const byHour = new Map();
  const byMinute = new Map();
  let total = 0;
  let refused = 0;
  let countedSeconds = 0;
  let usedCarryIn = false;
  let wraps = 0;
  let resets = 0;
  for (const deviceRows of byDevice.values()) {
    deviceRows.sort(cmpSort);
    const part = accumulateDevice(deviceRows, { timeZone, carryInCounter });
    total += part.total;
    refused += part.refused;
    countedSeconds += part.countedSeconds;
    usedCarryIn = usedCarryIn || part.usedCarryIn;
    wraps += part.wraps || 0;
    resets += part.resets || 0;
    for (const [hour, v] of part.byHour) {
      const bucket = byHour.get(hour) || { steps: 0, seconds: 0 };
      bucket.steps += v.steps;
      bucket.seconds += v.seconds;
      byHour.set(hour, bucket);
    }
    for (const [bucketMs, value] of part.byMinute) {
      const bucket = byMinute.get(bucketMs) || {
        start_at: value.start_at,
        count: 0,
        allocated: false,
        coalesced: false,
      };
      bucket.count += value.count;
      bucket.allocated ||= value.allocated;
      bucket.coalesced ||= value.coalesced;
      byMinute.set(bucketMs, bucket);
    }
  }

  const byHourArr = [...byHour.entries()]
    .map(([hour, v]) => ({ hour, steps: Math.round(v.steps), seconds: v.seconds }))
    .sort((a, b) => a.hour - b.hour);
  const buckets60s = [...byMinute.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, bucket]) => ({
      ...bucket,
      count: Math.round(bucket.count * 1e9) / 1e9,
      source_mode: 'v1_counter_delta',
    }));
  const coverage = Math.min(1, countedSeconds / Math.max(1, 86400));
  const confidence = refused === 0 && coverage > 0
    ? Math.min(1, 0.5 + coverage * 0.5)
    : Math.max(0, 0.5 - refused / Math.max(1, countedSeconds));
  const status = total === 0 && coverage === 0 ? 'unavailable'
    : (refused > 0 || coverage < 0.2 ? 'partial' : 'ok');

  return {
    total: Math.round(total),
    byHour: byHourArr,
    buckets_60s: buckets60s,
    coverage_seconds: countedSeconds,
    refused_deltas: refused,
    counter_wraps: wraps,
    counter_resets: resets,
    source: 'whoop_v18_step_counter',
    algorithm_version: STEPS_ALGORITHM_VERSION,
    confidence: Math.round(confidence * 100) / 100,
    status,
    input_mode: uniq.some((s) => presentNumber(s.steps) != null) ? 'delta' : 'cumulative',
    used_carry_in: usedCarryIn,
    missing_predecessor: !usedCarryIn && !uniq.some((s) => presentNumber(s.steps) != null),
    devices: byDevice.size,
  };
}
