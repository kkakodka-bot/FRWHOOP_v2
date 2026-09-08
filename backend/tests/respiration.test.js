import test from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS } from '../signal/constants.js';
import { STATUS } from '../signal/envelope.js';
import {
  MIN_CLEAN_BEATS,
  MIN_PEAK_PROMINENCE,
  MOTION_CEILING_G,
  RESP_BAND_HZ,
  WINDOW,
} from '../respiration/constants.js';
import {
  dominantPeak,
  lombScargle,
  respirationFromRrIntervals,
  describeEstimators,
} from '../respiration/estimators.js';
import {
  beatsFromSamples,
  estimateSeries,
  estimateWindow,
  nightlyRespiration,
} from '../respiration/engine.js';

const T0 = Date.parse('2026-08-25T02:00:00Z');
const now = () => new Date(Date.parse('2026-08-25T08:00:00Z'));

/**
 * A tachogram with a known respiratory modulation.
 *
 * Respiratory sinus arrhythmia is generated the way the body does it: the
 * breathing cycle modulates the interval itself, and each beat's time is the
 * previous beat's time plus that interval. Stamping beats on a uniform grid
 * instead would hand the periodogram evenly-sampled data and quietly test a
 * different algorithm than the one that runs in production.
 */
function rsaBeats({
  startMs = T0,
  seconds = 180,
  brpm = 15,
  amplitudeMs = 60,
  baseRrMs = 1000,
  noiseMs = 0,
  seed = 1,
} = {}) {
  const respHz = brpm / 60;
  // Deterministic LCG: a fixed seed keeps a failure reproducible.
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff - 0.5;
  };

  const beats = [];
  let t = startMs;
  while (t - startMs < seconds * 1000) {
    const phase = 2 * Math.PI * respHz * ((t - startMs) / 1000);
    const raw = baseRrMs + amplitudeMs * Math.sin(phase) + (noiseMs ? rand() * 2 * noiseMs : 0);
    // Round the interval BEFORE accumulating. The strap reports integer
    // milliseconds, so a beat's time is the previous time plus the interval it
    // actually reported; accumulating the unrounded value would make the fixture
    // internally inconsistent by ~1 ms and fail its own round-trip.
    const rr = Math.round(raw);
    t += rr;
    beats.push({ ts: t, rrMs: rr });
  }
  return beats;
}

/** Wrap beats into strap-shaped samples carrying up to `perSample` intervals. */
function samplesFromBeats(beats, { perSample = 2, motion = null } = {}) {
  const out = [];
  for (let i = 0; i < beats.length; i += perSample) {
    const group = beats.slice(i, i + perSample);
    if (!group.length) break;
    out.push({
      t: new Date(group[group.length - 1].ts).toISOString(),
      rr_ms: group.map((b) => b.rrMs),
      ...(motion == null ? {} : { motion }),
    });
  }
  return out;
}

function noiseBeats({ startMs = T0, seconds = 180, seed = 7 } = {}) {
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff - 0.5;
  };
  const beats = [];
  let t = startMs;
  while (t - startMs < seconds * 1000) {
    const rr = Math.round(1000 + rand() * 120);
    t += rr;
    beats.push({ ts: t, rrMs: rr });
  }
  return beats;
}

// ---------------------------------------------------------------------------
// Spectral primitives
// ---------------------------------------------------------------------------

test('Lomb-Scargle finds a known frequency in unevenly sampled data', () => {
  const times = [];
  const values = [];
  let t = 0;
  let i = 0;
  while (t < 200) {
    // Deliberately irregular spacing: this is the case an FFT cannot take.
    t += 0.7 + 0.6 * ((i * 7) % 5) / 5;
    times.push(t);
    values.push(Math.sin(2 * Math.PI * 0.25 * t));
    i += 1;
  }
  const spectrum = lombScargle(times, values, { minHz: 0.1, maxHz: 0.5 });
  const peak = dominantPeak(spectrum);
  assert.ok(Math.abs(peak.freqHz - 0.25) < 0.01, `peak at ${peak.freqHz}`);
  assert.ok(peak.prominence > 0.5, 'a pure tone concentrates in-band power');
});

test('Lomb-Scargle refuses input it cannot analyse', () => {
  assert.deepEqual(lombScargle([1, 2], [1, 2], { minHz: 0.1, maxHz: 0.5 }), []);
  const flat = new Array(40).fill(0);
  const times = flat.map((_, i) => i);
  assert.deepEqual(lombScargle(times, flat, { minHz: 0.1, maxHz: 0.5 }), [], 'zero variance has no spectrum');
});

test('a flat spectrum has no dominant peak worth reporting', () => {
  const flat = Array.from({ length: 100 }, (_, i) => ({ freqHz: 0.1 + i * 0.002, power: 1 }));
  const peak = dominantPeak(flat);
  assert.ok(peak.prominence < 0.05, 'the argmax of a flat band is not a peak');
  assert.equal(dominantPeak([]), null);
  assert.equal(dominantPeak([{ freqHz: 0.2, power: 0 }]), null);
});

test('a peak at the band edge is marked as such', () => {
  const spectrum = Array.from({ length: 50 }, (_, i) => ({ freqHz: 0.1 + i * 0.002, power: i === 0 ? 100 : 1 }));
  assert.equal(dominantPeak(spectrum).atEdge, true);
});

// ---------------------------------------------------------------------------
// The RSA estimator
// ---------------------------------------------------------------------------

test('the estimator recovers a known respiratory rate', () => {
  for (const brpm of [8, 12, 15, 20, 24]) {
    const out = respirationFromRrIntervals({ beats: rsaBeats({ brpm }) });
    assert.equal(out.value != null, true, `${brpm} brpm produced no value: ${out.reason}`);
    assert.ok(
      Math.abs(out.value - brpm) < 0.6,
      `expected ~${brpm} brpm, got ${out.value}`,
    );
    assert.ok(out.confidence > 0.5, `confidence ${out.confidence} too low for a clean signal`);
    assert.deepEqual(out.sourceSignals, ['rr_intervals']);
  }
});

test('recovery survives realistic beat-detection noise', () => {
  const out = respirationFromRrIntervals({ beats: rsaBeats({ brpm: 15, noiseMs: 20 }) });
  assert.ok(Math.abs(out.value - 15) < 1, `got ${out.value}`);
});

test('a weak RSA amplitude still resolves but with less confidence', () => {
  const strong = respirationFromRrIntervals({ beats: rsaBeats({ brpm: 15, amplitudeMs: 80 }) });
  const weak = respirationFromRrIntervals({ beats: rsaBeats({ brpm: 15, amplitudeMs: 80, noiseMs: 60 }) });
  assert.ok(weak.confidence < strong.confidence, 'a noisier tachogram must not read as confidently');
});

test('an aperiodic tachogram is refused, not reported as its argmax', () => {
  const out = respirationFromRrIntervals({ beats: noiseBeats() });
  assert.equal(out.value, null);
  assert.match(out.reason, /prominence/);
  assert.ok(out.prominence < MIN_PEAK_PROMINENCE);
});

test('motion above the trust ceiling refuses the window outright', () => {
  const beats = rsaBeats({ brpm: 15 });
  const out = respirationFromRrIntervals({ beats, motion: MOTION_CEILING_G + 0.01 });
  assert.equal(out.value, null);
  assert.match(out.reason, /motion/);
});

test('motion below the ceiling is tolerated but discounts confidence', () => {
  const beats = rsaBeats({ brpm: 15 });
  const still = respirationFromRrIntervals({ beats, motion: 0 });
  const moving = respirationFromRrIntervals({ beats, motion: MOTION_CEILING_G * 0.9 });
  assert.ok(moving.value != null);
  assert.ok(moving.confidence < still.confidence);
});

test('too few beats is refused with a count, not estimated', () => {
  const beats = rsaBeats({ brpm: 15 }).slice(0, MIN_CLEAN_BEATS - 1);
  const out = respirationFromRrIntervals({ beats });
  assert.equal(out.value, null);
  assert.match(out.reason, new RegExp(`need ${MIN_CLEAN_BEATS} beats`));
});

test('a window shorter than the resolution limit is refused', () => {
  // Fast heart rate packs enough beats into too little time: the beat count gate
  // passes and the duration gate must still catch it.
  const beats = rsaBeats({ brpm: 15, seconds: 40, baseRrMs: 500, amplitudeMs: 30 });
  assert.ok(beats.length >= MIN_CLEAN_BEATS, 'fixture must clear the beat-count gate');
  const out = respirationFromRrIntervals({ beats });
  assert.equal(out.value, null);
  assert.match(out.reason, new RegExp(`${WINDOW.minSeconds}s minimum`));
});

test('a tachogram destroyed by artifacts is refused after rejection', () => {
  // Alternating long/short intervals: every interval is a >20% step from its
  // neighbour, so artifact rejection removes nearly all of them.
  const beats = [];
  let t = T0;
  for (let i = 0; i < 200; i += 1) {
    const rr = i % 2 === 0 ? 1400 : 600;
    t += rr;
    beats.push({ ts: t, rrMs: rr });
  }
  const out = respirationFromRrIntervals({ beats });
  assert.equal(out.value, null);
  assert.match(out.reason, /survived artifact rejection/);
});

test('the estimator accepts either beat field name and sorts unordered input', () => {
  const beats = rsaBeats({ brpm: 15 });
  const ordered = respirationFromRrIntervals({ beats });
  const renamed = respirationFromRrIntervals({
    beats: beats.map((b) => ({ ts: b.ts, rr_ms: b.rrMs })).reverse(),
  });
  assert.equal(renamed.value, ordered.value);
});

test('the whole probed band is physiologically plausible, so the gate is a guard not a clamp', () => {
  assert.ok(RESP_BAND_HZ.min * 60 >= LIMITS.respRateMin);
  assert.ok(RESP_BAND_HZ.max * 60 <= LIMITS.respRateMax);
});

test('the fusion reports one live mechanism of four and how to unlock the rest', () => {
  const d = describeEstimators();
  assert.equal(d.total, 4);
  assert.equal(d.availableCount, 1);
  const live = d.estimators.filter((e) => e.available);
  assert.deepEqual(live.map((e) => e.estimator), ['rsa_rr']);
  for (const e of d.estimators.filter((x) => !x.available)) {
    assert.ok(e.missing.length, `${e.estimator} must say what it is missing`);
    assert.ok(e.missing.every((m) => m.signal && m.status));
  }
});

// ---------------------------------------------------------------------------
// Beat reconstruction
// ---------------------------------------------------------------------------

test('intervals are walked backward from their sample timestamp', () => {
  // The strap reports the intervals ENDING at the notification time. Stamping
  // them all at that instant would collapse several beats onto one moment and
  // destroy the timing the periodogram depends on.
  const t = Date.parse('2026-08-25T02:00:10Z');
  const beats = beatsFromSamples([{ t: new Date(t).toISOString(), rr_ms: [800, 900, 1000] }]);
  assert.equal(beats.length, 3);
  assert.deepEqual(beats.map((b) => b.rrMs), [800, 900, 1000]);
  assert.equal(beats[2].ts, t);
  assert.equal(beats[1].ts, t - 1000);
  assert.equal(beats[0].ts, t - 1000 - 900);
});

test('grouped samples reconstruct the original beat series exactly', () => {
  const beats = rsaBeats({ brpm: 15, seconds: 120 });
  for (const perSample of [1, 2, 4]) {
    const rebuilt = beatsFromSamples(samplesFromBeats(beats, { perSample }));
    assert.deepEqual(
      rebuilt.map((b) => [b.ts, b.rrMs]),
      beats.map((b) => [b.ts, b.rrMs]),
      `perSample=${perSample} did not round-trip`,
    );
  }
});

test('samples without usable timestamps or intervals are skipped', () => {
  const beats = beatsFromSamples([
    { t: 'nonsense', rr_ms: [900] },
    { t: '2026-08-25T02:00:00Z', rr_ms: [] },
    { t: '2026-08-25T02:00:00Z' },
    { t: '2026-08-25T02:00:00Z', rr_ms: [900, null] },
  ]);
  assert.equal(beats.length, 1);
});

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

test('a clean window returns a full envelope', () => {
  const samples = samplesFromBeats(rsaBeats({ brpm: 15, seconds: 120 }), { motion: 0.01 });
  const env = estimateWindow({ samples, now });
  assert.equal(env.status, STATUS.OK);
  assert.ok(Math.abs(env.value - 15) < 0.6);
  assert.equal(env.unit, 'brpm');
  assert.ok(env.confidence > 0.4);
  assert.deepEqual(env.sourceSignals, ['rr_intervals']);
  assert.equal(env.algorithmVersion, '1.0.0');
  assert.equal(env.experimental, true, 'one mechanism of four is not a settled measurement');
  assert.equal(env.detail.mechanismsAvailable, 1);
  assert.equal(env.detail.mechanismsTotal, 4);
  assert.ok(env.timestamp);
});

test('a window with no RR intervals is unavailable and names the missing signals', () => {
  const env = estimateWindow({ samples: [{ t: new Date(T0).toISOString(), bpm: 60 }], now });
  assert.equal(env.status, STATUS.UNAVAILABLE);
  assert.equal(env.value, null);
  assert.match(env.reason, /no RR intervals/);
  assert.ok(env.missingSignals?.length);
  assert.ok(env.missingSignals.some((m) => m.signal === 'ppg_waveform'));
});

test('an unusable window carries the estimator reason, not a generic failure', () => {
  const samples = samplesFromBeats(noiseBeats({ seconds: 180 }));
  const env = estimateWindow({ samples, now });
  assert.equal(env.status, STATUS.UNAVAILABLE);
  assert.equal(env.value, null);
  assert.match(env.reason, /prominence/);
});

test('a low-confidence estimate is labelled rather than silently returned as ok', () => {
  const samples = samplesFromBeats(rsaBeats({ brpm: 15, amplitudeMs: 40, noiseMs: 45, seed: 3 }));
  const env = estimateWindow({ samples, now });
  if (env.value != null) {
    assert.equal(
      env.status,
      env.confidence < 0.35 ? STATUS.LOW_CONFIDENCE : STATUS.OK,
      'status must follow confidence',
    );
  }
});

test('the series splits into non-overlapping windows that account for every beat once', () => {
  const beats = rsaBeats({ brpm: 15, seconds: 600 });
  const windows = estimateSeries({ samples: samplesFromBeats(beats), windowSeconds: 120, now });
  assert.ok(windows.length >= 4, `expected several windows, got ${windows.length}`);
  for (const w of windows) {
    assert.ok(w.startTime && w.endTime);
    assert.ok(Date.parse(w.endTime) > Date.parse(w.startTime));
  }
  for (let i = 1; i < windows.length; i += 1) {
    assert.ok(
      Date.parse(windows[i].startTime) >= Date.parse(windows[i - 1].endTime),
      'windows must not overlap',
    );
  }
});

test('an empty series is empty, not a window full of nulls', () => {
  assert.deepEqual(estimateSeries({ samples: [], now }), []);
  assert.deepEqual(estimateSeries({ samples: [{ t: 'bad' }], now }), []);
});

test('a gap in the data does not fabricate windows to span it', () => {
  const first = rsaBeats({ brpm: 15, seconds: 240, startMs: T0 });
  const later = rsaBeats({ brpm: 15, seconds: 240, startMs: T0 + 3_600_000 });
  const windows = estimateSeries({
    samples: [...samplesFromBeats(first), ...samplesFromBeats(later)],
    windowSeconds: 120,
    now,
  });
  // An hour of silence must not become 30 empty windows.
  assert.ok(windows.length <= 6, `got ${windows.length} windows across a one-hour gap`);
});

test('the nightly value is the median of usable windows', () => {
  const samples = samplesFromBeats(rsaBeats({ brpm: 15, seconds: 900 }));
  const night = nightlyRespiration({ samples, now });
  assert.equal(night.status, STATUS.OK);
  assert.ok(Math.abs(night.value - 15) < 0.6);
  assert.ok(night.detail.windowsUsed >= 3);
  assert.ok(night.detail.stability > 0.5, 'a steady night should read as stable');
  assert.equal(night.experimental, true);
});

test('one contaminated window does not drag the nightly value', () => {
  const clean = rsaBeats({ brpm: 15, seconds: 900 });
  const contaminated = [
    ...samplesFromBeats(clean),
    ...samplesFromBeats(rsaBeats({ brpm: 26, seconds: 120, startMs: T0 + 900_000 })),
  ];
  const a = nightlyRespiration({ samples: samplesFromBeats(clean), now });
  const b = nightlyRespiration({ samples: contaminated, now });
  assert.ok(Math.abs(b.value - a.value) < 1, `median moved from ${a.value} to ${b.value}`);
});

test('a night with too few usable windows is unavailable, not a one-window guess', () => {
  const samples = samplesFromBeats(rsaBeats({ brpm: 15, seconds: 130 }));
  const night = nightlyRespiration({ samples, minWindows: 3, now });
  assert.equal(night.status, STATUS.UNAVAILABLE);
  assert.equal(night.value, null);
  assert.match(night.reason, /cleared the confidence gate/);
});

test('a night of pure noise is unavailable', () => {
  const night = nightlyRespiration({ samples: samplesFromBeats(noiseBeats({ seconds: 900 })), now });
  assert.equal(night.status, STATUS.UNAVAILABLE);
  assert.equal(night.value, null);
});

test('the engine is deterministic, so archive reprocessing reproduces the night', () => {
  const samples = samplesFromBeats(rsaBeats({ brpm: 15, seconds: 900 }));
  const a = nightlyRespiration({ samples, now });
  const b = nightlyRespiration({ samples: samples.map((s) => ({ ...s })), now });
  assert.deepEqual(a, b);
});

test('sample order does not change the result', () => {
  const samples = samplesFromBeats(rsaBeats({ brpm: 15, seconds: 600 }));
  const forward = nightlyRespiration({ samples, now });
  const shuffled = nightlyRespiration({ samples: samples.slice().reverse(), now });
  assert.equal(shuffled.value, forward.value);
});

test('every envelope is JSON-serializable for the API', () => {
  const samples = samplesFromBeats(rsaBeats({ brpm: 15, seconds: 600 }));
  for (const env of [...estimateSeries({ samples, now }), nightlyRespiration({ samples, now })]) {
    assert.deepEqual(JSON.parse(JSON.stringify(env)), env);
  }
});
