import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AVAILABLE,
  REACHABLE,
  SENSORS,
  UNLOCKS,
  capabilityReport,
  hasSignals,
  missingSignals,
  signalsByStatus,
} from '../signal/capability.js';
import { LIMITS } from '../signal/constants.js';
import {
  STATUS,
  fuse,
  metric,
  propagate,
  unavailable,
} from '../signal/envelope.js';
import {
  rrStats,
  scorePpgQuality,
  scoreQuality,
  scoreTemperatureQuality,
} from '../signal/quality.js';

// ---------------------------------------------------------------------------
// Capability map
// ---------------------------------------------------------------------------

test('every capability entry declares a status and its evidence', () => {
  for (const [name, s] of Object.entries(SENSORS)) {
    assert.ok(['available', 'reachable', 'absent'].includes(s.status), `${name} status`);
    assert.ok(s.evidence, `${name} must cite the code or protocol table that proves its status`);
  }
});

test('every reachable signal names an unlock that exists', () => {
  for (const name of signalsByStatus(REACHABLE)) {
    const unlock = SENSORS[name].unlock;
    assert.ok(unlock, `${name} is reachable so it must say how`);
    assert.ok(UNLOCKS[unlock], `${name} references unknown unlock ${unlock}`);
    assert.ok(UNLOCKS[unlock].unlocksSignals.includes(name), `${unlock} must list ${name}`);
  }
});

test('the signals FRWHOOP actually receives are HR, RR, motion, battery and derived stage', () => {
  // A guard, not a description. If a decoder lands and this list grows, the
  // engines gated on it must be revisited in the same change.
  assert.deepEqual(signalsByStatus(AVAILABLE), [
    'battery', 'heart_rate', 'motion_magnitude', 'rr_intervals', 'sleep_stage',
  ]);
});

test('temperature and PPG are not available, so nothing may claim them', () => {
  assert.equal(hasSignals('skin_temperature'), false);
  assert.equal(hasSignals('ppg_waveform'), false);
  assert.equal(hasSignals('heart_rate', 'rr_intervals'), true);
});

test('missingSignals explains what is missing and how to unlock it', () => {
  const [miss] = missingSignals('ppg_waveform');
  assert.equal(miss.signal, 'ppg_waveform');
  assert.equal(miss.status, REACHABLE);
  assert.equal(miss.unlock.id, 'raw_stream_enable');
  assert.match(miss.unlock.risk, /[Bb]attery/);
});

test('an unknown signal name is reported, not silently treated as present', () => {
  const [miss] = missingSignals('blood_glucose');
  assert.equal(miss.status, 'unknown');
  assert.equal(hasSignals('blood_glucose'), false);
});

test('the capability report is JSON-serializable for the API', () => {
  const report = capabilityReport();
  assert.deepEqual(JSON.parse(JSON.stringify(report)).available, report.available);
});

// ---------------------------------------------------------------------------
// Metric envelope
// ---------------------------------------------------------------------------

test('a metric carries the provenance needed to reproduce it', () => {
  const m = metric({
    value: 15.2,
    unit: 'brpm',
    confidence: 0.8,
    dataQuality: 0.9,
    inputCoverage: 1,
    algorithm: 'respiration_fusion',
    algorithmVersion: '1.0.0',
    sourceSignals: ['rr_intervals'],
  });
  assert.equal(m.status, STATUS.OK);
  assert.equal(m.algorithm, 'respiration_fusion');
  assert.equal(m.algorithmVersion, '1.0.0');
  assert.deepEqual(m.sourceSignals, ['rr_intervals']);
  assert.ok(m.timestamp);
});

test('a metric without an algorithm version is refused at construction', () => {
  assert.throws(() => metric({ value: 1, algorithm: 'x' }), /algorithmVersion/);
});

test('a null value is unavailable even when a confidence was supplied', () => {
  const m = metric({
    value: null, confidence: 0.9, algorithm: 'a', algorithmVersion: '1',
  });
  assert.equal(m.status, STATUS.UNAVAILABLE);
  assert.equal(m.confidence, null, 'a confidence attached to no value is meaningless');
  assert.ok(m.reason);
});

test('a real but weakly-supported value is labelled, not hidden', () => {
  const m = metric({
    value: 15, confidence: 0.1, algorithm: 'a', algorithmVersion: '1',
  });
  assert.equal(m.status, STATUS.LOW_CONFIDENCE);
  assert.equal(m.value, 15, 'the evidence is kept; only the label changes');
});

test('confidence is never reported as certainty', () => {
  const m = metric({ value: 1, confidence: 1, algorithm: 'a', algorithmVersion: '1' });
  assert.ok(m.confidence < 1);
});

test('an unavailable metric carries the unlock path for its missing inputs', () => {
  const m = unavailable({
    algorithm: 'temperature_deviation',
    algorithmVersion: '1.0.0',
    unit: 'C',
    missing: missingSignals('skin_temperature'),
  });
  assert.equal(m.value, null);
  assert.equal(m.status, STATUS.UNAVAILABLE);
  assert.equal(m.missingSignals[0].signal, 'skin_temperature');
  assert.match(m.reason, /skin_temperature/);
});

test('propagated confidence follows the weakest input, not the average', () => {
  // Averaging would let one clean channel launder three broken ones.
  assert.equal(propagate([0.9, 0.9, 0.2]), 0.2);
  assert.ok(propagate([0.9, 0.9], { penalty: 0.5 }) < 0.9);
  assert.equal(propagate([]), null);
});

// ---------------------------------------------------------------------------
// Fusion
// ---------------------------------------------------------------------------

test('fusion weights by confidence times quality', () => {
  const f = fuse([
    { estimator: 'a', value: 10, confidence: 0.9, quality: 1 },
    { estimator: 'b', value: 20, confidence: 0.1, quality: 1 },
  ], { spreadTolerance: 2 });
  assert.ok(f.value < 12, `expected the confident estimator to dominate, got ${f.value}`);
});

test('a confident estimator on a garbage signal does not dominate', () => {
  const f = fuse([
    { estimator: 'clean', value: 10, confidence: 0.5, quality: 1 },
    { estimator: 'garbage', value: 30, confidence: 0.95, quality: 0.02 },
  ], { spreadTolerance: 2 });
  assert.ok(f.value < 12, `quality must gate confidence, got ${f.value}`);
});

test('disagreeing estimators lower confidence even when each is confident', () => {
  const agree = fuse([
    { estimator: 'a', value: 15, confidence: 0.9, quality: 1 },
    { estimator: 'b', value: 15.2, confidence: 0.9, quality: 1 },
  ], { spreadTolerance: 2 });
  const disagree = fuse([
    { estimator: 'a', value: 12, confidence: 0.9, quality: 1 },
    { estimator: 'b', value: 24, confidence: 0.9, quality: 1 },
  ], { spreadTolerance: 2 });
  assert.ok(agree.confidence > disagree.confidence);
  assert.ok(agree.agreement > 0.9);
  assert.equal(disagree.agreement, 0);
});

test('a lone estimator never earns the corroboration bonus', () => {
  const solo = fuse([{ estimator: 'a', value: 15, confidence: 0.9, quality: 1 }]);
  const pair = fuse([
    { estimator: 'a', value: 15, confidence: 0.9, quality: 1 },
    { estimator: 'b', value: 15, confidence: 0.9, quality: 1 },
  ], { spreadTolerance: 2 });
  assert.equal(solo.agreement, 0.5);
  assert.ok(pair.confidence > solo.confidence, 'two mechanisms agreeing is more evidence than one');
});

test('fusion reports how many mechanisms it actually had', () => {
  const f = fuse([
    { estimator: 'a', value: 15, confidence: 0.9, quality: 1 },
    { estimator: 'b', value: null, confidence: 0.9, quality: 1 },
    { estimator: 'c', value: 15, confidence: 0, quality: 1 },
  ]);
  assert.equal(f.usedCount, 1);
  assert.equal(f.offeredCount, 3);
});

test('fusion of nothing usable is null, never a default', () => {
  assert.equal(fuse([]), null);
  assert.equal(fuse([{ value: null, confidence: 0.9 }]), null);
  assert.equal(fuse([{ value: 15, confidence: 0 }]), null);
});

// ---------------------------------------------------------------------------
// HR / RR / motion quality
// ---------------------------------------------------------------------------

test('RR artifact rejection excludes ectopic beats and reports the fraction', () => {
  const stats = rrStats([1000, 1010, 1005, 500, 1000, 1008]);
  assert.ok(stats.rejected >= 1);
  assert.ok(stats.artifactFraction > 0);
  assert.ok(stats.rmssd > 0);
});

test('kept indices re-pair intervals with their own timestamps', () => {
  const input = [1000, 1000, 400, 1000];
  const stats = rrStats(input);
  for (let i = 0; i < stats.keptIndices.length; i += 1) {
    assert.equal(input[stats.keptIndices[i]], stats.clean[i]);
  }
});

test('out-of-range RR intervals are dropped, not clamped into range', () => {
  const stats = rrStats([50, 5000, 1000, 1005]);
  assert.ok(!stats.clean.includes(50));
  assert.ok(!stats.clean.includes(5000));
  assert.ok(stats.clean.every((v) => v >= LIMITS.rrMinMs && v <= LIMITS.rrMaxMs));
});

test('a missing HR channel is flagged rather than scored as zero-but-fine', () => {
  const q = scoreQuality({
    hrCount: 0, hrCoverage: 0, motionCount: 10, motionCoverage: 1, rrCount: 0,
    rrArtifactFraction: 0, implausibleJumps: 0, maxGapSeconds: 0, disconnectedSamples: 0,
  });
  assert.equal(q.hr, 0);
  assert.ok(q.flags.includes('hr_absent'));
  assert.ok(q.overall > 0, 'a motion-only minute is still a usable minute');
});

test('a disconnect and a long gap both surface as flags', () => {
  const q = scoreQuality({
    hrCount: 5, hrCoverage: 0.3, motionCount: 5, motionCoverage: 0.3, rrCount: 0,
    rrArtifactFraction: 0, implausibleJumps: 0, maxGapSeconds: 90, disconnectedSamples: 3,
  });
  assert.ok(q.flags.includes('sample_gap'));
  assert.ok(q.flags.includes('disconnected'));
});

// ---------------------------------------------------------------------------
// Temperature quality
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-08-24T02:00:00Z');

function tempSamples({ n = 60, start = T0, tempC = 33.5, stepMs = 60_000, drift = 0 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    ts: start + i * stepMs,
    tempC: typeof tempC === 'function' ? tempC(i) : tempC + drift * i,
  }));
}

test('an absent temperature channel scores zero and says so', () => {
  const q = scoreTemperatureQuality({ samples: [] });
  assert.equal(q.temperature, 0);
  assert.ok(q.flags.includes('temp_absent'));
});

test('charging invalidates temperature outright', () => {
  const q = scoreTemperatureQuality({
    samples: tempSamples({ tempC: (i) => 33.5 + 0.001 * i }), expected: 60, charging: true,
  });
  assert.equal(q.temperature, 0, 'a charging device heats itself; nothing measured is skin');
  assert.ok(q.flags.includes('charging'));
});

test('a removed device invalidates temperature outright', () => {
  const q = scoreTemperatureQuality({
    samples: tempSamples({ tempC: (i) => 33.5 + 0.001 * i }), expected: 60, worn: false,
  });
  assert.equal(q.temperature, 0);
  assert.ok(q.flags.includes('not_worn'));
});

test('temperature outside the worn band is excluded rather than clamped', () => {
  const q = scoreTemperatureQuality({
    samples: [...tempSamples({ n: 30 }), ...tempSamples({ n: 30, start: T0 + 30 * 60_000, tempC: 8 })],
    expected: 60,
  });
  assert.ok(q.flags.includes('temp_out_of_band'));
  assert.equal(q.usableSamples, 30);
  assert.equal(q.outOfBand, 30);
});

test('a physically impossible temperature step is flagged, not smoothed', () => {
  const q = scoreTemperatureQuality({
    samples: [
      { ts: T0, tempC: 33.0 },
      { ts: T0 + 60_000, tempC: 36.0 },
      { ts: T0 + 120_000, tempC: 33.1 },
    ],
    expected: 3,
  });
  assert.ok(q.flags.includes('temp_implausible_slew'));
  assert.ok(q.slewViolations >= 2);
});

test('a stuck thermistor is not mistaken for a stable one', () => {
  const q = scoreTemperatureQuality({ samples: tempSamples({ tempC: 33.5 }), expected: 60 });
  assert.ok(q.flags.includes('temp_flatline'));
  assert.ok(q.temperature < 0.4);
});

test('the first minutes after the strap goes on are discounted', () => {
  const jitter = (i) => 33.5 + (i % 3) * 0.02;
  const settled = scoreTemperatureQuality({
    samples: tempSamples({ tempC: jitter }), expected: 60, minutesSinceDon: 120,
  });
  const warming = scoreTemperatureQuality({
    samples: tempSamples({ tempC: jitter }), expected: 60, minutesSinceDon: 2,
  });
  assert.ok(warming.temperature < settled.temperature);
  assert.ok(warming.flags.includes('temp_stabilizing'));
});

test('motion contaminates contact temperature', () => {
  const jitter = (i) => 33.5 + (i % 3) * 0.02;
  const still = scoreTemperatureQuality({ samples: tempSamples({ tempC: jitter }), expected: 60, motion: 0.01 });
  const moving = scoreTemperatureQuality({ samples: tempSamples({ tempC: jitter }), expected: 60, motion: 0.5 });
  assert.ok(moving.temperature < still.temperature);
  assert.ok(moving.flags.includes('temp_motion_contaminated'));
});

// ---------------------------------------------------------------------------
// PPG quality (synthetic; no production input yet)
// ---------------------------------------------------------------------------

const PPG_RATE = 437;

function ppgWave({ n = PPG_RATE * 4, pulseHz = 1.2, amp = 1000, noise = 0, seed = 1 } = {}) {
  // Deterministic pseudo-noise so the test is reproducible.
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
  return Array.from({ length: n }, (_, i) => {
    const t = i / PPG_RATE;
    return amp * Math.sin(2 * Math.PI * pulseHz * t) + noise * rand();
  });
}

test('a clean pulsatile PPG window scores well and finds the pulse band', () => {
  const q = scorePpgQuality({ samples: ppgWave(), rateHz: PPG_RATE, expected: PPG_RATE * 4 });
  assert.ok(q.ppg > 0.5, `expected a clean waveform to score above 0.5, got ${q.ppg}`);
  assert.ok(q.pulsatility > 0.15);
  assert.ok(!q.flags.includes('ppg_no_pulse_band'));
});

test('a flatlined PPG scores zero', () => {
  const q = scorePpgQuality({ samples: new Array(PPG_RATE).fill(0), rateHz: PPG_RATE });
  assert.equal(q.ppg, 0);
  assert.ok(q.flags.includes('ppg_flatline'));
});

test('a clipped PPG is detected even though it still looks pulsatile', () => {
  const rail = 2 ** 23;
  const clipped = ppgWave({ amp: rail * 2 }).map((v) => Math.max(-rail, Math.min(rail, v)));
  const q = scorePpgQuality({ samples: clipped, rateHz: PPG_RATE, expected: PPG_RATE * 4 });
  assert.ok(q.flags.includes('ppg_clipping'));
  assert.ok(q.clipFraction > 0);
});

test('broadband noise with no pulse band is rejected', () => {
  const q = scorePpgQuality({
    samples: ppgWave({ amp: 0, noise: 1000 }), rateHz: PPG_RATE, expected: PPG_RATE * 4,
  });
  assert.ok(q.flags.includes('ppg_no_pulse_band'), `flags were ${q.flags.join(',')}`);
  assert.ok(q.ppg < 0.5);
});

test('missing PPG samples reduce coverage', () => {
  const q = scorePpgQuality({ samples: ppgWave({ n: 400 }), rateHz: PPG_RATE, expected: PPG_RATE * 4 });
  assert.ok(q.coverage < 0.9);
  assert.ok(q.flags.includes('ppg_missing_samples'));
});

test('too few PPG samples is absent, not a low score on a real reading', () => {
  const q = scorePpgQuality({ samples: [1, 2, 3], rateHz: PPG_RATE });
  assert.equal(q.ppg, 0);
  assert.ok(q.flags.includes('ppg_absent'));
});
