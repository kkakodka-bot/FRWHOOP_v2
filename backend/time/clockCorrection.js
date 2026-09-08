
/**
 * Strap clock hygiene for the sleep pipeline.
 *
 * A WHOOP strap timestamps its own samples with an on-device RTC that is set
 * from the phone once at connect. It is subject to constant offset from the set
 * moment, slow drift, timezone/DST changes, and (occasionally) outright jumps or
 * repeated packets. We never silently shift a sample across a calendar day on a
 * hunch: because sleep is bucketed into local days, a wrong clock means a whole
 * night can land on the wrong date.
 *
 * This module is deliberately small and dependency-free. It provides:
 *   - relative anomaly detection (duplicates, backward time, impossible gaps)
 *   - a constant-offset correction when a trustworthy reference clock is
 *     available (phone/server receive time)
 *   - a drift estimate when a monotonic sequence counter is available
 *   - a conservative monotonic sanitization that drops only provably-bad samples
 *
 * It does NOT invent samples to "heal" gaps. Correcting a single beat is a
 * physiology decision (see signal/rrArtifact.js); repairing sensor absence is a
 * data-budget decision (see signal/quality.js), not a clock decision.
 */

export function median(values) {
  const v = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Detect monotonicity anomalies and impossible gaps in a strap timestamp series. */
export function analyzeTimestamps(ts, { expectedIntervalSec = null, gapFactor = 5 } = {}) {
  const t = (ts || []).map(Number);
  const out = { duplicateCount: 0, backwardCount: 0, gaps: [], expectedIntervalSec };
  const diffs = [];
  for (let i = 1; i < t.length; i += 1) {
    const d = t[i] - t[i - 1];
    if (!Number.isFinite(d)) continue;
    if (d === 0) out.duplicateCount += 1;
    else if (d < 0) out.backwardCount += 1;
    else diffs.push(d);
  }
  const interval = expectedIntervalSec ?? median(diffs);
  out.expectedIntervalSec = interval == null ? null : Math.round(interval);
  if (interval && interval > 0) {
    const threshold = interval * gapFactor;
    for (let i = 1; i < t.length; i += 1) {
      const d = t[i] - t[i - 1];
      if (d > threshold) out.gaps.push({ from: t[i - 1], to: t[i], gapSec: d });
    }
  }
  return out;
}

/** 7 days: delayed offload of a correct RTC stays put; a months-wrong RTC is shifted. */
export const HISTORICAL_CLOCK_MIN_ABS_OFFSET_MS = 7 * 86_400_000;
/**
 * WHOOP did not exist before 2015, so a strap clock reading earlier than this is
 * a lost/epoch RTC rather than sensor time.
 */
export const HISTORICAL_CLOCK_FLOOR_MS = Date.parse('2015-01-01T00:00:00.000Z');
/**
 * Slack allowed on a strap clock running ahead of the receive clock. Flash
 * cannot hold samples from the future, so anything beyond this is provably a
 * bad RTC; the tolerance only absorbs ordinary set-time skew.
 */
export const HISTORICAL_CLOCK_FUTURE_SKEW_MS = 86_400_000;
/**
 * Upper bound for a correctable constant offset: 20 years. WHOOP 5 banks
 * type-47 flash with a lost RTC (SET_CLOCK does not redate already-stored
 * records), so a genuinely multi-year-old strap clock is a documented failure
 * mode, not garbage. The corrected result is additionally floored to 2015 by
 * the caller, so an implausibly ancient epoch (1970) still cannot invent dates.
 */
export const HISTORICAL_CLOCK_MAX_ABS_OFFSET_MS = 20 * 365 * 86_400_000;

/**
 * Constant offset for historical ingest when the strap RTC is provably wrong
 * (WHOOP 5 will bank type-47 with a lost clock; SET_CLOCK does not redate
 * already-stored flash). Use the newest bad strap time vs receive time so an
 * older sample in the same dump stays the same relative age.
 *
 * Age alone is NOT evidence of a bad clock: a strap legitimately banks weeks or
 * months of flash while unsynced, and shifting that dump forward would stamp
 * real history onto the present — corrupting today's metrics with samples that
 * never happened today. Only two cases are provably wrong and shifted:
 *   - a clock ahead of the receive clock (flash cannot hold the future)
 *   - a clock reading before 2015 (epoch/lost RTC)
 * Returns 0 for a plausible past clock, which the caller then leaves untouched.
 */
export function historicalClockOffsetMs(newestStrapMs, receivedMs) {
  const strap = Number(newestStrapMs);
  const recv = Number(receivedMs);
  if (!Number.isFinite(strap) || !Number.isFinite(recv)) return 0;
  const off = recv - strap;
  if (Math.abs(off) > HISTORICAL_CLOCK_MAX_ABS_OFFSET_MS) return 0;
  const ahead = off <= -HISTORICAL_CLOCK_FUTURE_SKEW_MS;
  const preHistoric = strap < HISTORICAL_CLOCK_FLOOR_MS;
  if (!ahead && !preHistoric) return 0;
  return Math.round(off);
}

/**
 * Correct a strap clock using a trustworthy reference clock (phone/server
 * receive time). Returns a constant offset plus the corrected series.
 * NEVER applied blindly in production: callers must bound the offset and reject
 * implausible values (e.g., offset > 24h or wildly non-constant) before using.
 * @param {number[]} strapTs  strap seconds
 * @param {number[]} refTs    reference seconds, same length & order
 */
export function correctWithReference(strapTs, refTs, { maxAbsOffsetSec = 86400 } = {}) {
  const offsets = [];
  const len = Math.min(strapTs?.length || 0, refTs?.length || 0);
  for (let i = 0; i < len; i += 1) {
    const off = Number(refTs[i]) - Number(strapTs[i]);
    if (Number.isFinite(off)) offsets.push(off);
  }
  const offset = median(offsets);
  if (offset == null || Math.abs(offset) > maxAbsOffsetSec) {
    return { corrected: [...(strapTs || [])], constantOffsetSec: null, offsetStdSec: null, accepted: false };
  }
  const sd = Math.sqrt(offsets.reduce((s, o) => s + (o - offset) ** 2, 0) / Math.max(1, offsets.length - 1));
  return {
    corrected: (strapTs || []).map((x) => (Number.isFinite(Number(x)) ? Number(x) + offset : x)),
    constantOffsetSec: Math.round(offset),
    offsetStdSec: Math.round(sd * 100) / 100,
    accepted: sd < Math.max(2, Math.abs(offset) * 0.1 + 2),
    sampleCount: offsets.length,
  };
}

/**
 * Estimate clock drift (seconds per second) from a monotonic sequence counter
 * vs the strap timestamp span. slope > 1 means strap time runs fast vs the
 * counter; offset ignored (only slope is meaningful).
 */
export function estimateDrift(strapTs, seq) {
  const t = (strapTs || []).map(Number);
  const s = (seq || []).map(Number);
  const pts = [];
  for (let i = 0; i < Math.min(t.length, s.length); i += 1) {
    if (Number.isFinite(t[i]) && Number.isFinite(s[i])) pts.push([t[i], s[i]]);
  }
  if (pts.length < 3) return { driftPpm: null, correlation: null };
  // linear fit of seq vs strap time
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  let num = 0, den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  if (!den) return { driftPpm: null, correlation: null };
  const slope = num / den; // seq-units per second
  // if seq increments ~1 per sample and samples are ~1Hz, slope ~ sample rate
  const driftPpm = ((1 / Math.max(1e-9, slope)) - 1) * 1e6;
  return { driftPpm: Math.round(driftPpm), correlation: Math.round(num / Math.sqrt(den * (pts.reduce((a, p) => a + (p[1] - my) ** 2, 0))) * 1000) / 1000 };
}

/**
 * Conservative monotonic sanitization: drop duplicated and backward timestamps,
 * preserving the first occurrence of each equal value and dropping points that
 * go backward. Returns an index mask (true = keep).
 */
export function monotonicMask(ts) {
  const t = (ts || []).map(Number);
  const keep = Array(t.length).fill(true);
  let last = -Infinity;
  for (let i = 0; i < t.length; i += 1) {
    if (!Number.isFinite(t[i])) { keep[i] = false; continue; }
    if (t[i] < last) { keep[i] = false; continue; }
    if (t[i] === last) { keep[i] = false; continue; } // duplicate (keep first)
    last = t[i];
  }
  return keep;
}
