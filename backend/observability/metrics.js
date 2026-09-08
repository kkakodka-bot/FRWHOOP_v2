/**
 * Process-local counters. Never log tokens, secrets, or raw health payloads.
 */

const counters = Object.create(null);
const timings = Object.create(null);
let lastReject = null;

export const LIVE_INGEST_KEYS = Object.freeze([
  'raw_type40_seen',
  'type40_frame_reassembled',
  'type40_crc_valid',
  'type40_hr_decoded',
  'applyHeartRate_called',
  'live_sample_durable',
  'live_sample_uploaded',
  'live_sample_backend_accepted',
  'detector_sample_ingested',
  'detector_sample_rejected',
]);

function bucket(name) {
  if (!counters[name]) counters[name] = 0;
  return name;
}

export function inc(name, n = 1) {
  bucket(name);
  counters[name] += n;
}

export function noteReject(reason) {
  lastReject = reason
    ? { reason: String(reason), at: new Date().toISOString() }
    : lastReject;
}

export function liveIngestView() {
  const c = {};
  for (const k of LIVE_INGEST_KEYS) c[k] = counters[k] || 0;
  return { counters: c, last_reject: lastReject };
}

export function observeMs(name, ms) {
  if (!timings[name]) timings[name] = { count: 0, totalMs: 0, maxMs: 0 };
  const t = timings[name];
  t.count += 1;
  t.totalMs += ms;
  if (ms > t.maxMs) t.maxMs = ms;
}

export async function timed(name, fn) {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    observeMs(name, Date.now() - t0);
  }
}

export function snapshot() {
  const latency = {};
  for (const [k, v] of Object.entries(timings)) {
    latency[k] = {
      count: v.count,
      avgMs: v.count ? Math.round(v.totalMs / v.count) : 0,
      maxMs: v.maxMs,
    };
  }
  return { counters: { ...counters }, latency };
}

export function resetMetrics() {
  for (const k of Object.keys(counters)) delete counters[k];
  for (const k of Object.keys(timings)) delete timings[k];
  lastReject = null;
}

export function safeError(err) {
  return String(err?.message || err || 'error').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 200);
}
