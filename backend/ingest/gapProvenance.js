/**
 * Classify an HR hole so a chart gap is explainable in one command.
 * One label per gap; first matching rule wins.
 */
export const GAP_CLASSES = [
  'STRAP_OR_BLE_MISSING',
  'IOS_RECEIVED_NOT_PERSISTED',
  'IOS_PERSISTED_NOT_UPLOADED',
  'BACKEND_RECEIVED_NOT_ARCHIVED',
  'B2_HAS_RAW_NOT_NORMALIZED',
  'B2_HAS_NORMALIZED_NOT_SUPABASE',
  'SUPABASE_HAS_DATA_API_DROPPED',
  'API_HAS_DATA_FRONTEND_DROPPED',
  'INTENTIONAL_VALIDITY_FILTER',
  'OFF_WRIST',
  'UNKNOWN',
];

export function coverage(times, startMs, endMs, bucketMs) {
  const expected = Math.max(0, Math.floor((endMs - startMs) / bucketMs));
  const set = new Set();
  for (const t of times) {
    if (t < startMs || t >= endMs) continue;
    set.add(Math.floor((t - startMs) / bucketMs));
  }
  const sorted = [...times].filter((t) => t >= startMs && t < endMs).sort((a, b) => a - b);
  let largestGap = 0;
  let gapStart = null;
  let prev = startMs;
  for (const t of sorted) {
    const g = t - prev;
    if (g > largestGap) {
      largestGap = g;
      gapStart = prev;
    }
    prev = t;
  }
  const tail = endMs - prev;
  if (tail > largestGap) {
    largestGap = tail;
    gapStart = prev;
  }
  return {
    expected,
    covered: set.size,
    pct: expected ? Math.round((1000 * set.size) / expected) / 10 : 0,
    sampleCount: sorted.length,
    first: sorted[0] || null,
    last: sorted.at(-1) || null,
    largestGapSec: Math.round(largestGap / 1000),
    largestGapStart: gapStart,
  };
}

export function gapsOver(times, startMs, endMs, minSec) {
  const sorted = [...times].filter((t) => t >= startMs && t < endMs).sort((a, b) => a - b);
  const out = [];
  let prev = startMs;
  const push = (from, to) => {
    const sec = (to - from) / 1000;
    if (sec >= minSec) out.push({ from, to, sec: Math.round(sec) });
  };
  for (const t of sorted) {
    push(prev, t);
    prev = t;
  }
  push(prev, endMs);
  return out;
}

/**
 * @param {object} ev
 * @param {boolean} ev.offWrist
 * @param {boolean} ev.validityDropped  HR present but filtered (bpm/gravity)
 * @param {boolean} ev.b2NormalizedHr
 * @param {boolean} ev.supabaseHr
 * @param {boolean} ev.apiHr
 * @param {boolean} ev.frontendHr
 * @param {boolean} ev.b2RawType40
 * @param {boolean} ev.b2RawType47
 * @param {boolean} ev.b2RawGatt
 * @param {boolean} ev.b2AnyFrames
 * @param {boolean} ev.backendWal
 * @param {boolean} ev.iosQueue
 * @param {boolean} ev.iosReceived
 */
export function classifyGap(ev = {}) {
  if (ev.offWrist) return 'OFF_WRIST';
  if (ev.validityDropped && !ev.b2NormalizedHr) return 'INTENTIONAL_VALIDITY_FILTER';
  if (ev.apiHr && !ev.frontendHr) return 'API_HAS_DATA_FRONTEND_DROPPED';
  if (ev.supabaseHr && !ev.apiHr) return 'SUPABASE_HAS_DATA_API_DROPPED';
  if (ev.b2NormalizedHr && !ev.supabaseHr) return 'B2_HAS_NORMALIZED_NOT_SUPABASE';
  if ((ev.b2RawType40 || ev.b2RawType47 || ev.b2RawGatt) && !ev.b2NormalizedHr) {
    return 'B2_HAS_RAW_NOT_NORMALIZED';
  }
  if (ev.backendWal && !ev.b2NormalizedHr && !ev.b2AnyFrames) return 'BACKEND_RECEIVED_NOT_ARCHIVED';
  if (ev.iosQueue && !ev.b2NormalizedHr && !ev.b2AnyFrames) return 'IOS_PERSISTED_NOT_UPLOADED';
  if (ev.iosReceived && !ev.iosQueue) return 'IOS_RECEIVED_NOT_PERSISTED';
  if (!ev.b2AnyFrames && !ev.b2NormalizedHr && !ev.iosQueue && !ev.iosReceived) {
    return 'STRAP_OR_BLE_MISSING';
  }
  return 'UNKNOWN';
}

export function utcHourKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:00:00Z`;
}

export function hoursSpanned(fromMs, toMs) {
  const out = [];
  const start = Date.parse(utcHourKey(fromMs));
  for (let t = start; t < toMs; t += 3600000) out.push(utcHourKey(t));
  return out;
}
