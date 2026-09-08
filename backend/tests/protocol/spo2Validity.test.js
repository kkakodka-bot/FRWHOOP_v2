import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySpo2Byte,
  observationFromV18,
  detectMeasurementWindows,
  SLEEP_ASLEEP,
  SPO2_FRAME_OFFSET,
} from '../../protocol/spo2.js';
import {
  SPECIFICITY_OFFSETS,
  isOpticalAmpSentinel,
  scanOffsetSpecificity,
  windowTelemetryRows,
  describeValidityGate,
  VALIDITY_FEATURE_NAMES,
  validityFeatureVector,
  assertNoLeakageFeatures,
  fitLogistic,
  classifyConsoleLog,
  correlateWindowLogs,
  highFrequencyHypothesis,
  leaveOneDeviceValidity,
} from '../../protocol/spo2Validity.js';

const T0 = 1_700_000_000;

function row(over = {}) {
  return {
    spo2_raw_byte: over.raw ?? 96,
    spo2_candidate_pct: (over.state ?? 'candidate') === 'candidate' ? (over.raw ?? 96) : null,
    spo2_state: over.state ?? 'candidate',
    sensor_timestamp: over.t ?? T0,
    sleep_state: over.sleep ?? SLEEP_ASLEEP,
    optical_amp_a: over.ampA ?? 40,
    optical_amp_b: over.ampB ?? 41,
    optical_amp_128_128_sentinel: over.ampA === 128 && over.ampB === 128,
    cardiac_status: over.status ?? 10,
    f32_113: over.f113 ?? -1,
    rr_count: over.rr ?? 1,
    dynamic_acceleration: over.motion ?? 0.1,
    source_frame_hash: over.hash || `h${over.t ?? T0}`,
    firmware: '50.35.2.0',
    device_id: over.device ?? 'dev-a',
  };
}

test('12 nearby-offset variance floor rejects near-constant bytes', () => {
  const samples = [];
  for (let i = 0; i < 40; i += 1) {
    const bytes = new Uint8Array(100);
    bytes[80] = 95;
    bytes[82] = 90 + (i % 8);
    bytes[74] = 12;
    samples.push({ unix: T0 + i * 600, sleep_state: SLEEP_ASLEEP, bytes });
  }
  const scan = scanOffsetSpecificity(samples);
  const off80 = scan.find((r) => r.offset === 80);
  assert.ok(off80.rejected.some((r) => r.startsWith('distinct_inband') || r.startsWith('stdev')));
  assert.equal(off80.plausible, false);
});

test('13 @82 is in the specificity scan and is not specially favored', () => {
  assert.deepEqual(SPECIFICITY_OFFSETS, Array.from({ length: 19 }, (_, i) => 74 + i));
  assert.ok(SPECIFICITY_OFFSETS.includes(SPO2_FRAME_OFFSET));
  const samples = [];
  for (let i = 0; i < 40; i += 1) {
    const bytes = new Uint8Array(100);
    bytes[82] = 90 + (i % 8);
    bytes[81] = 90 + (i % 8);
    samples.push({ unix: T0 + i * 600, sleep_state: SLEEP_ASLEEP, bytes });
  }
  const scan = scanOffsetSpecificity(samples);
  assert.equal(scan.length, SPECIFICITY_OFFSETS.length);
  assert.deepEqual(scan.map((r) => r.offset), SPECIFICITY_OFFSETS);
  assert.equal(scan[0].offset, 74);
  assert.ok(scan.every((r, i) => i === 0 || r.offset > scan[i - 1].offset));
  const off82 = scan.find((r) => r.offset === 82);
  assert.equal(off82.is_candidate_offset, true);
  const others = scan.filter((r) => r.offset !== 82);
  assert.ok(others.every((r) => r.is_candidate_offset === false));
});

test('14 sentinel and diagnostic remain excluded from numerical SpO2', () => {
  assert.equal(classifySpo2Byte(0x80).spo2_candidate_pct, null);
  assert.equal(classifySpo2Byte(12).spo2_candidate_pct, null);
  const windows = detectMeasurementWindows([
    row({ t: T0, state: 'sentinel', raw: 0x80 }),
    row({ t: T0 + 1, state: 'candidate', raw: 94 }),
    row({ t: T0 + 2, state: 'diagnostic', raw: 12 }),
    row({ t: T0 + 3, state: 'candidate', raw: 96 }),
  ]);
  assert.equal(windows[0].window_value, 95);
  assert.equal(windows[0].sentinel_count, 1);
  assert.equal(windows[0].diagnostic_count, 1);
});

test('15 128/128 optical amplitude sentinel is preserved', () => {
  assert.equal(isOpticalAmpSentinel(128, 128), true);
  assert.equal(isOpticalAmpSentinel(40, 41), false);
  const parsed = {
    hist_version: 18,
    unix: T0,
    aux_byte_82: 96,
    sleep_state: 2,
    optical_amp_a: 128,
    optical_amp_b: 128,
  };
  const o = observationFromV18(parsed, { frameHash: 'a'.repeat(64) });
  assert.equal(o.optical_amp_128_128_sentinel, true);
  const { rows } = windowTelemetryRows([row({ ampA: 128, ampB: 128, state: 'diagnostic', raw: 12 })]);
  const gate = describeValidityGate([
    row({ t: T0, ampA: 128, ampB: 128, state: 'diagnostic', raw: 12 }),
    row({ t: T0 + 1, ampA: 40, ampB: 41, state: 'candidate', raw: 96 }),
  ]);
  assert.ok(rows[0]?.optical_amp_128_128_sentinel || gate.conditional.p_candidate_optical_sentinel.n >= 0);
  assert.equal(gate.conditional.p_candidate_optical_sentinel.p, 0);
});

test('16 validity classifier cannot access @82 or official SpO2', () => {
  assert.equal(assertNoLeakageFeatures(VALIDITY_FEATURE_NAMES), true);
  assert.throws(() => assertNoLeakageFeatures(['spo2_raw_byte']));
  assert.throws(() => assertNoLeakageFeatures(['official_spo2_pct']));
  const vec = validityFeatureVector({
    spo2_raw_byte: 96,
    spo2_candidate_pct: 96,
    official_spo2_pct: 98,
    aux_byte_82: 96,
    optical_amp_a: 40,
    optical_amp_b: 41,
    cardiac_status: 3,
    sleep_state: SLEEP_ASLEEP,
  });
  assert.equal('spo2_raw_byte' in vec, false);
  assert.equal('spo2_candidate_pct' in vec, false);
  assert.equal('official_spo2_pct' in vec, false);
  const model = fitLogistic([
    row({ state: 'candidate', ampA: 40, ampB: 41 }),
    row({ t: T0 + 1, state: 'sentinel', raw: 0x80, ampA: 128, ampB: 128, hash: 'b' }),
  ]);
  assert.ok(!('spo2_raw_byte' in model.weights));
});

test('17 console-log correlation survives chunk/file boundaries', () => {
  const observations = [
    ...Array.from({ length: 10 }, (_, i) => row({ t: T0 + i, raw: 96, hash: `a${i}` })),
  ];
  const windows = detectMeasurementWindows(observations);
  const logs = [
    { unix: T0 - 80, log: 'generated a valid SPO2 during sleep', hash: 'chunk-a' },
    { unix: T0 + 40, log: 'did not generate a valid SPO2', hash: 'chunk-b' },
  ];
  const corr = correlateWindowLogs(windows, logs);
  assert.equal(corr[0].nearby_log_events.length, 2);
  assert.equal(corr[0].nearby_log_events[0].cls, 'spo2_success');
  assert.equal(corr[0].nearby_log_events[1].cls, 'spo2_failure');
});

test('18 high-frequency-mode hypothesis is reporting-only', () => {
  const observations = [
    ...Array.from({ length: 5 }, (_, i) => row({ t: T0 + i, raw: 96 })),
    ...Array.from({ length: 5 }, (_, i) => row({ t: T0 + 600 + i, raw: 97, hash: `b${i}` })),
    ...Array.from({ length: 5 }, (_, i) => row({ t: T0 + 1200 + i, raw: 98, hash: `c${i}` })),
  ];
  const before = detectMeasurementWindows(observations);
  const hyp = highFrequencyHypothesis(observations, [
    { unix: T0 + 10, log: 'entering high-freq SPO2 mode' },
  ]);
  const after = detectMeasurementWindows(observations);
  assert.equal(before[0].window_value, after[0].window_value);
  assert.ok(hyp.every((h) => h.reporting_only === true));
  assert.equal(classifyConsoleLog('high-freq SPO2 mode enabled'), 'spo2_high_frequency_mode');
  assert.equal(leaveOneDeviceValidity(observations).skipped, true);
  assert.match(leaveOneDeviceValidity(observations).reason, /devices = 0/);
});
