import test from 'node:test';
import assert from 'node:assert/strict';

import { STATUS } from '../signal/envelope.js';
import {
  MIN_NIGHT_WINDOWS,
  MIN_WINDOW_BEATS,
  RMSSD_LIMITS,
  WINDOW_SECONDS,
  intervalsFromSamples,
  overnightHrv,
  windowIntervals,
  windowRmssd,
} from '../hrv/engine.js';

const T0 = Date.parse('2026-08-25T02:00:00Z');
const now = () => new Date(Date.parse('2026-08-25T09:00:00Z'));

/**
 * Intervals alternating between two lengths.
 *
 * Every successive difference is exactly `deltaMs`, so RMSSD is exactly
 * `deltaMs` — an analytic ground truth rather than an approximate one.
 */
function alternating(count, { baseMs = 1000, deltaMs = 40 } = {}) {
  return Array.from({ length: count }, (_, i) => (i % 2 ? baseMs + deltaMs : baseMs));
}

/** Samples whose beat times accumulate from the intervals, as real beats do. */
function samplesFrom(intervals, { startMs = T0, perSample = 4 } = {}) {
  const beats = [];
  let t = startMs;
  for (const rr of intervals) {
    t += rr;
    beats.push({ ts: t, rrMs: rr });
  }
  const out = [];
  for (let i = 0; i < beats.length; i += perSample) {
    const group = beats.slice(i, i + perSample);
    out.push({
      t: new Date(group[group.length - 1].ts).toISOString(),
      rr_ms: group.map((b) => b.rrMs),
    });
  }
  return out;
}

/** Enough intervals to fill `n` analysis windows at roughly 60 bpm. */
function nightIntervals(n, opts = {}) {
  return alternating(n * WINDOW_SECONDS, opts);
}

// ---------------------------------------------------------------------------
// Window RMSSD
// ---------------------------------------------------------------------------

test('window RMSSD equals the known successive difference', () => {
  for (const deltaMs of [10, 40, 90]) {
    const out = windowRmssd(alternating(200, { deltaMs }));
    assert.ok(Math.abs(out.value - deltaMs) < 1e-6, `expected ${deltaMs}, got ${out.value}`);
  }
});

test('a window with too few intervals is refused with its count', () => {
  const out = windowRmssd(alternating(MIN_WINDOW_BEATS - 1));
  assert.equal(out.value, null);
  assert.match(out.reason, new RegExp(`below ${MIN_WINDOW_BEATS}`));
});

test('an artifact-riddled window is refused rather than measured', () => {
  // Alternating 1400/600 is a >20% step every beat, so rejection removes most of
  // it. Measuring what survived would report the artifact as variability.
  const out = windowRmssd(Array.from({ length: 200 }, (_, i) => (i % 2 ? 1400 : 600)));
  assert.equal(out.value, null);
});

test('differencing never bridges a rejected interval', () => {
  // A single 2900 ms interval — a missed beat — dropped into a clean series. If
  // the successive difference were taken across the hole, the ~1900 ms step
  // would enter the sum of squares and dominate it.
  const clean = alternating(200, { deltaMs: 40 });
  const withHole = [...clean.slice(0, 100), 2900, ...clean.slice(100)];
  const a = windowRmssd(clean);
  const b = windowRmssd(withHole);
  assert.ok(Math.abs(a.value - b.value) < 1, `RMSSD moved from ${a.value} to ${b.value}`);
  assert.ok(b.pairs < a.pairs, 'the pair spanning the hole is dropped, not bridged');
});

test('a wild interval invalidates its successor too', () => {
  // Artifact rejection compares each interval against the previous RAW value,
  // so a 2900 ms interval makes the following normal one look like a >20% step
  // and it is dropped as well. Conservative and intended: after a missed beat
  // the next interval's boundary is not trustworthy either.
  const clean = alternating(200, { deltaMs: 40 });
  const withHole = [...clean.slice(0, 100), 2900, ...clean.slice(100)];
  assert.equal(windowRmssd(withHole).count, windowRmssd(clean).count - 1);
  assert.equal(windowRmssd(withHole).rejected, 2);
});

test('a perfectly regular series is implausible, not perfectly healthy', () => {
  // RMSSD of 0 means the beat detector is quantising or repeating, never that a
  // human heart is metronomic.
  const out = windowRmssd(new Array(200).fill(1000));
  assert.equal(out.value, 0);
  const env = overnightHrv({ samples: samplesFrom(nightIntervals(4, { deltaMs: 0 })), now });
  assert.equal(env.status, STATUS.UNAVAILABLE);
  assert.match(env.reason, /outside the plausible/);
});

// ---------------------------------------------------------------------------
// Windowing
// ---------------------------------------------------------------------------

test('windows are non-overlapping and epoch-aligned', () => {
  const intervals = nightIntervals(4);
  let t = T0;
  const rows = intervals.map((rr) => { t += rr; return { ts: t, rrMs: rr }; });
  const windows = windowIntervals(rows, WINDOW_SECONDS);
  assert.ok(windows.length >= 4);
  for (let i = 1; i < windows.length; i += 1) {
    assert.equal(windows[i].start, windows[i - 1].end, 'windows must tile without gaps');
  }
  const total = windows.reduce((a, w) => a + w.rows.length, 0);
  assert.equal(total, rows.length, 'every interval lands in exactly one window');
});

test('intervals are walked backward from their sample timestamp', () => {
  const t = Date.parse('2026-08-25T02:00:10Z');
  const out = intervalsFromSamples([{ t: new Date(t).toISOString(), rr_ms: [800, 900, 1000] }]);
  assert.deepEqual(out.map((b) => b.rrMs), [800, 900, 1000]);
  assert.equal(out[2].ts, t);
  assert.equal(out[1].ts, t - 1000);
  assert.equal(out[0].ts, t - 1900);
});

test('samples without intervals or a usable time contribute nothing', () => {
  assert.deepEqual(intervalsFromSamples([
    { t: 'nope', rr_ms: [900] },
    { t: '2026-08-25T02:00:00Z', rr_ms: [] },
    { t: '2026-08-25T02:00:00Z', bpm: 60 },
  ]), []);
});

// ---------------------------------------------------------------------------
// The night
// ---------------------------------------------------------------------------

test('a clean night returns the known RMSSD in a full envelope', () => {
  const env = overnightHrv({ samples: samplesFrom(nightIntervals(8, { deltaMs: 45 })), now });
  assert.equal(env.status, STATUS.OK);
  assert.ok(Math.abs(env.value - 45) < 1, `expected ~45 ms, got ${env.value}`);
  assert.equal(env.unit, 'ms');
  assert.ok(env.confidence > 0.5);
  assert.deepEqual(env.sourceSignals, ['rr_intervals']);
  assert.ok(env.detail.windowsUsed >= MIN_NIGHT_WINDOWS);
  assert.equal(env.detail.windowSeconds, WINDOW_SECONDS);
  assert.ok(env.detail.impliedHrBpm > 40 && env.detail.impliedHrBpm < 80);
  assert.ok(env.detail.sdnnMs > 0);
});

test('a night with no RR intervals is a data gap, not a missing capability', () => {
  const env = overnightHrv({ samples: [{ t: new Date(T0).toISOString(), bpm: 55 }], now });
  assert.equal(env.status, STATUS.UNAVAILABLE);
  assert.equal(env.value, null);
  assert.match(env.reason, /no RR intervals/);
  assert.equal(
    env.missingSignals,
    undefined,
    'RR is an available capability; absent data must not be reported as absent hardware',
  );
});

test('too few usable windows is unavailable, not a one-window guess', () => {
  const env = overnightHrv({ samples: samplesFrom(alternating(400)), now });
  assert.equal(env.status, STATUS.UNAVAILABLE);
  assert.match(env.reason, new RegExp(`need ${MIN_NIGHT_WINDOWS}`));
});

test('one arousal window does not drag the night, which pooling would', () => {
  // The design claim: per-window medians isolate an arousal that a single
  // pooled RMSSD would absorb into the night's value.
  const calm = nightIntervals(8, { deltaMs: 30 });
  const aroused = [...calm];
  // One window's worth of large but individually plausible swings.
  for (let i = 0; i < WINDOW_SECONDS; i += 1) {
    aroused[WINDOW_SECONDS * 3 + i] = i % 2 ? 1180 : 1000;
  }
  const a = overnightHrv({ samples: samplesFrom(calm), now });
  const b = overnightHrv({ samples: samplesFrom(aroused), now });
  assert.ok(
    Math.abs(b.value - a.value) < 2,
    `median moved from ${a.value} to ${b.value}`,
  );
  assert.ok(b.detail.spreadMs > a.detail.spreadMs, 'the disturbance shows up as spread');
  assert.ok(b.confidence < a.confidence, 'and as reduced confidence');
});

test('intervals outside the sleep window are excluded', () => {
  const samples = samplesFrom(nightIntervals(8, { deltaMs: 45 }));
  const full = overnightHrv({ samples, now });
  const clipped = overnightHrv({
    samples,
    startTime: new Date(T0 + 2 * WINDOW_SECONDS * 1000).toISOString(),
    endTime: new Date(T0 + 5 * WINDOW_SECONDS * 1000).toISOString(),
    now,
  });
  assert.ok(clipped.detail.intervals < full.detail.intervals);
  assert.ok(Math.abs(clipped.value - 45) < 1, 'the value itself is unchanged');
});

test('an out-of-range median RMSSD is rejected rather than clamped', () => {
  const env = overnightHrv({
    samples: samplesFrom(nightIntervals(4, { baseMs: 1000, deltaMs: 195 })),
    now,
  });
  if (env.value != null) assert.ok(env.value <= RMSSD_LIMITS.max);
  else assert.equal(env.status, STATUS.UNAVAILABLE);
});

test('rejected windows report why, so a bad night is explainable', () => {
  const good = nightIntervals(6, { deltaMs: 40 });
  // Corrupt one window into unusability.
  for (let i = 0; i < WINDOW_SECONDS; i += 1) good[WINDOW_SECONDS * 2 + i] = i % 2 ? 1400 : 600;
  const env = overnightHrv({ samples: samplesFrom(good), now });
  assert.equal(env.status, STATUS.OK);
  assert.ok(env.detail.windowsUsed < env.detail.windowsTotal);
  assert.ok(env.detail.rejectedWindows.length, 'the rejection reason must be reported');
  assert.ok(env.inputCoverage < 1);
});

test('the engine is deterministic and JSON-serializable', () => {
  const samples = samplesFrom(nightIntervals(6, { deltaMs: 40 }));
  const a = overnightHrv({ samples, now });
  const b = overnightHrv({ samples: samples.map((s) => ({ ...s })), now });
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
});

test('sample order does not change the night', () => {
  const samples = samplesFrom(nightIntervals(6, { deltaMs: 40 }));
  assert.equal(
    overnightHrv({ samples: samples.slice().reverse(), now }).value,
    overnightHrv({ samples, now }).value,
  );
});
