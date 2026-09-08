/**
 * HR V2 evaluation infrastructure — tests.
 * Run:  node --test tests/hrV2.eval.test.js
 * Covers: reference parsing (messy CSV/JSON/RR), alignment with injected
 * offset+drift, hand-computed metric arithmetic, MAPE guard, coverage /
 * abstention, transition lag, person-level split disjointness+determinism.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseReference, detectFormat, parseTimestamp, fixedOffsetMs,
  REFERENCE_FORMATS,
} from '../hr2/eval/reference.js';
import { alignReference, gridHrSeries } from '../hr2/eval/align.js';
import { comparisonMetrics, stratify, pearson, linCcc } from '../hr2/eval/metrics.js';
import { personSplit } from '../hr2/eval/split.js';

const T0 = Date.UTC(2026, 7, 25, 12, 0, 0); // 2026-08-25T12:00:00Z
const MINUTE = 60000;

// ---------------------------------------------------------------------------
// reference.js — messy CSV (quotes, dups, out-of-order, gaps)
// ---------------------------------------------------------------------------

test('CSV: headers matched tolerantly, dup/out-of-order/gap handled', () => {
  const csv = [
    '"Polar Flow - Session export"',
    '"Activity","Rest"',
    '"Local time","Heart rate"',
    '12:00:01,61',   // out of order vs first data row
    '12:00:00,60',
    '12:00:02,62',
    '12:00:02,63',   // duplicate timestamp with different value
    '12:00:05,65',   // gap after 12:00:02
  ].join('\n');
  const ref = parseReference(csv, { date: '2026-08-25' });
  assert.equal(ref.ok, true);
  assert.equal(ref.source, 'polar_h10');
  assert.equal(ref.meta.format, REFERENCE_FORMATS.CSV);
  assert.equal(ref.startedAt, T0);
  assert.equal(ref.samples.length, 4);
  // sorted ascending, deterministic
  assert.deepEqual(ref.samples.map((s) => s.t), [T0, T0 + 1000, T0 + 2000, T0 + 5000]);
  assert.equal(ref.samples[0].hr, 60);
  assert.equal(ref.samples[2].hr, 62); // first occurrence wins on dup
  assert.deepEqual(ref.samples.map((s) => s.hr), [60, 61, 62, 65]);
});

test('CSV: ISO timestamp column + naive timestamp treated as UTC by default', () => {
  const csv = 'time,hr\n2026-08-25T12:00:00Z,70\n2026-08-25 12:00:10,71\n';
  const ref = parseReference(csv);
  assert.equal(ref.ok, true);
  assert.equal(ref.samples[0].t, Date.UTC(2026, 7, 25, 12, 0, 0));
  // naive rows get Z appended (UTC) unless timeZone is given
  assert.equal(ref.samples[1].t, Date.UTC(2026, 7, 25, 12, 0, 10));
});

test('CSV: no header row is reported, not thrown', () => {
  const ref = parseReference('foo,bar\n1,2\n');
  assert.equal(ref.ok, false);
  assert.ok(ref.samples.length === 0);
});

// ---------------------------------------------------------------------------
// reference.js — JSON + timestamps
// ---------------------------------------------------------------------------

test('JSON: samples with iso/epoch timestamps and rr_ms', () => {
  const json = {
    source: 'h10-session',
    samples: [
      { t: '2026-08-25T12:00:00Z', hr: 60, rr_ms: 1000 },
      { t: T0 + 60000, hr: 61 },
      { t: '2026-08-25T12:00:00.000Z', hr: 62 }, // dup of first
    ],
  };
  const ref = parseReference(json);
  assert.equal(ref.ok, true);
  assert.equal(ref.samples.length, 2);
  assert.equal(ref.samples[0].hr, 60);
  assert.equal(ref.samples[0].rr_ms, 1000);
  assert.equal(ref.samples[1].t, T0 + 60000);
});

test('JSON: string body parses; missing samples -> ok:false', () => {
  assert.equal(parseReference('{"foo":1}').ok, false);
  const viaString = parseReference(JSON.stringify({ samples: [{ t: T0, hr: 55 }] }));
  assert.equal(viaString.ok, true);
  assert.equal(viaString.samples[0].hr, 55);
});

test('parseTimestamp: fixed-offset timezone applied deterministically', () => {
  // naive 10:00 with +02:00 == 08:00 UTC
  assert.equal(parseTimestamp('2026-08-25T10:00:00', { timeZone: '+02:00' }),
    Date.UTC(2026, 7, 25, 8, 0, 0));
  assert.equal(parseTimestamp('2026-08-25T10:00:00', { timeZone: 'UTC' }),
    Date.UTC(2026, 7, 25, 10, 0, 0));
  assert.equal(fixedOffsetMs('+02:00'), 2 * 3600 * 1000);
  assert.equal(fixedOffsetMs('-05:30'), -((5 * 3600 + 30 * 60) * 1000));
  assert.equal(fixedOffsetMs('UTC'), 0);
});

test('detectFormat: csv / json / rr_txt / unknown', () => {
  assert.equal(detectFormat('a,b\n1,2'), REFERENCE_FORMATS.CSV);
  assert.equal(detectFormat({ samples: [] }), REFERENCE_FORMATS.JSON);
  assert.equal(detectFormat('1000\n1020\n'), REFERENCE_FORMATS.RR_TXT);
  assert.equal(detectFormat(''), null);
});

// ---------------------------------------------------------------------------
// reference.js — RR txt
// ---------------------------------------------------------------------------

test('RR txt: cumulative timestamps from start param, derived HR', () => {
  const txt = ['# start: 2026-08-25T12:00:00Z', '1000', '500', '1000'].join('\n');
  const ref = parseReference(txt);
  assert.equal(ref.ok, true);
  assert.equal(ref.meta.derived_hr_from_rr, true);
  assert.equal(ref.samples.length, 3);
  assert.equal(ref.samples[0].t, T0 + 1000);
  assert.equal(ref.samples[0].rr_ms, 1000);
  assert.equal(ref.samples[0].hr, 60);
  assert.equal(ref.samples[1].t, T0 + 1500);
  assert.equal(ref.samples[1].rr_ms, 500);
  assert.equal(ref.samples[1].hr, 120);
  assert.equal(ref.samples[2].t, T0 + 2500);
});

test('RR txt: start time from options.startTime (ISO string)', () => {
  const txt = '812\n801\n799\n';
  const ref = parseReference(txt, { startTime: '2026-08-25T12:00:00Z' });
  assert.equal(ref.ok, true);
  assert.equal(ref.samples[0].t, T0 + 812);
  assert.equal(ref.samples[1].t, T0 + 812 + 801);
});

test('RR txt: missing start time -> ok:false, documented reason', () => {
  const ref = parseReference('1000\n1000\n');
  assert.equal(ref.ok, false);
  assert.equal(ref.reason, 'rr_txt_missing_start');
});

test('RR txt: values <200 interpreted as seconds with warning', () => {
  const ref = parseReference('0.8\n1.0\n', { startTime: '2026-08-25T12:00:00Z' });
  assert.equal(ref.ok, true);
  assert.equal(ref.samples[0].rr_ms, 800);
  assert.ok(ref.meta.warnings.some((w) => w.includes('seconds')));
});

// ---------------------------------------------------------------------------
// align.js — synthetic reference with KNOWN injected offset/drift
// ---------------------------------------------------------------------------

function synthProfile(seconds, startMs) {
  // deterministic HR profile with clear structure for cross-correlation:
  // slow oscillation + two activity plateaus.
  const s = [];
  for (let t = 0; t < seconds; t += 1) {
    let hr = 60 + 10 * Math.sin(t / 40);
    if (t >= 300 && t < 600) hr += 30;
    if (t >= 900 && t < 1200) hr += 20;
    s.push({ t: startMs + t * 1000, hr });
  }
  return s;
}

/** Build observation samples = reference HR re-timed by offset + linear drift. */
function retime(refSamples, { offsetMs = 0, driftPpm = 0 } = {}) {
  const t0 = refSamples[0].t;
  const drift = driftPpm * 1e-6; // ms per ms
  return refSamples.map((s) => ({
    t: s.t + offsetMs + Math.round((s.t - t0) * drift),
    hr: s.hr,
  }));
}

test('align: recovers pure constant offset within 1.5 s', () => {
  const refSamples = synthProfile(1800, T0);
  const ref = parseReference({ samples: refSamples });
  const obs = retime(refSamples, { offsetMs: 37000 });
  const r = alignReference(ref, obs, { maxOffsetSec: 120 });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.offset_ms - 37000) <= 1500,
    `offset ${r.offset_ms} ~ 37000`);
  assert.ok(Math.abs(r.drift_ppm) <= 50, `drift ${r.drift_ppm} ~ 0`);
  assert.ok(r.n_pairs >= 1000);
});

test('align: recovers offset AND drift (200 ppm) within tolerance', () => {
  const refSamples = synthProfile(1800, T0);
  const ref = parseReference({ samples: refSamples });
  const obs = retime(refSamples, { offsetMs: 37000, driftPpm: 200 });
  const r = alignReference(ref, obs, { maxOffsetSec: 120 });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.offset_ms - 37000) <= 1500,
    `offset ${r.offset_ms} ~ 37000`);
  assert.ok(Math.abs(r.drift_ppm - 200) <= 50,
    `drift ${r.drift_ppm} ~ 200`);
});

test('align: constant offset at a negative lag', () => {
  const refSamples = synthProfile(1800, T0);
  const ref = parseReference({ samples: refSamples });
  const obs = retime(refSamples, { offsetMs: -45000 }); // obs leads ref
  const r = alignReference(ref, obs, { maxOffsetSec: 120 });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.offset_ms - (-45000)) <= 1500,
    `offset ${r.offset_ms} ~ -45000`);
});

test('align: insufficient data -> ok:false with reason', () => {
  const ref = parseReference({ samples: [{ t: T0, hr: 60 }] });
  const r = alignReference(ref, [{ t: T0, bpm: 61 }]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'insufficient_data');
});

test('gridHrSeries: 1 Hz mean binning, null for gaps', () => {
  const g = gridHrSeries([{ t: T0, hr: 60 }, { t: T0 + 500, hr: 62 }, { t: T0 + 3000, hr: 70 }]);
  assert.equal(g.startMs, T0);
  assert.equal(g.values[0], 61); // mean of 60 & 62
  assert.equal(g.values[1], null);
  assert.equal(g.values.length, 4); // seconds 0..3
  assert.equal(g.values[3], 70);
});

// ---------------------------------------------------------------------------
// metrics.js — hand-computed toy example (arithmetic written out)
// ---------------------------------------------------------------------------

test('metrics: hand-computed MAE/RMSE/MAPE/bias/LoA/CCC/Pearson/within', () => {
  const pairs = [
    { t: 0, ref_bpm: 60, est_bpm: 62 },
    { t: 1000, ref_bpm: 70, est_bpm: 71 },
    { t: 2000, ref_bpm: 80, est_bpm: 79 },
    { t: 3000, ref_bpm: 90, est_bpm: 92 },
    { t: 4000, ref_bpm: 100, est_bpm: 106 },
  ];
  const m = comparisonMetrics(pairs, { round: 3 });

  // err = [2, 1, -1, 2, 6]; abs = [2,1,1,2,6]
  // MAE = (2+1+1+2+6)/5 = 12/5 = 2.4
  assert.equal(m.mae, 2.4);
  // bias = (2+1-1+2+6)/5 = 10/5 = 2.0
  assert.equal(m.bias, 2);
  // RMSE = sqrt((4+1+1+4+36)/5) = sqrt(9.2) = 3.033
  assert.equal(m.rmse, 3.033);
  // MAPE = 100 * mean(|e|/ref):
  //   (2/60 + 1/70 + 1/80 + 2/90 + 6/100)/5 * 100 = 2.847
  assert.equal(m.mape, 2.847);
  assert.equal(m.mape_skipped, 0);
  // LoA = bias ± 1.96·SD(diffs); SD(diffs, sample) = sqrt(26/4) = 2.5495
  //   lo = 2 - 1.96*2.5495 = -2.997 ; hi = 6.997
  assert.equal(m.loa.lo, -2.997);
  assert.equal(m.loa.hi, 6.997);
  // within b3: |e|<=3 → 4/5 = 0.8 ; b5 → 4/5 = 0.8 ; b10/b20 → 1
  assert.equal(m.within.b3, 0.8);
  assert.equal(m.within.b5, 0.8);
  assert.equal(m.within.b10, 1);
  assert.equal(m.within.b20, 1);
  assert.equal(m.large_error_rate, 0);
  // Pearson (population sums): sxy=1090, sxx=1000, syy=1206
  //   r = 1090/sqrt(1000*1206) = 0.99254 → 0.993 (round 3)
  assert.equal(m.pearson, 0.993);
  // CCC (Lin, population sums): 2*1090 / (1000+1206+5*2²) = 2180/2226 = 0.9793
  assert.equal(m.ccc, 0.979);
  // coverage with totalExpected defaulting to pairs.length
  assert.equal(m.coverage, 1);
  assert.equal(m.abstention_rate, 0);
  assert.equal(m.mean_ref, 80);
  assert.equal(m.mean_est, 82);
});

test('metrics: MAPE guard skips ref<=0 and reports skipped count', () => {
  const pairs = [
    { t: 0, ref_bpm: 60, est_bpm: 61 },
    { t: 1000, ref_bpm: 0, est_bpm: 5 },   // degenerate ref -> skipped for MAPE
    { t: 2000, ref_bpm: 0, est_bpm: 0 },   // degenerate ref -> skipped for MAPE
  ];
  const m = comparisonMetrics(pairs, { round: 3 });
  assert.equal(m.n, 3);                    // both still count toward errors
  assert.equal(m.mape_skipped, 2);
  assert.equal(m.mape, 1.667);             // only ref=60 pair
});

test('metrics: abstained estimates reduce coverage and raise abstention', () => {
  const pairs = [
    { t: 0, ref_bpm: 60, est_bpm: 61 },
    { t: 1000, ref_bpm: 60, est_bpm: null }, // abstained
    { t: 2000, ref_bpm: 60, est_bpm: null }, // abstained
  ];
  const m = comparisonMetrics(pairs);
  assert.equal(m.n, 1);
  assert.equal(m.abstained, 2);
  assert.equal(m.coverage, 0.33);           // 1/3, default round=2
  assert.equal(m.abstention_rate, 0.67);
});

test('metrics: quality floor treats low-quality pairs as abstained', () => {
  const pairs = [
    { t: 0, ref_bpm: 60, est_bpm: 61, quality: 0.9 },
    { t: 1000, ref_bpm: 60, est_bpm: 80, quality: 0.2 }, // below floor
  ];
  const m = comparisonMetrics(pairs, { qualityFloor: 0.5 });
  assert.equal(m.n, 1);
  assert.equal(m.abstained, 1);
});

test('metrics: large-error rate counts |err| > 20', () => {
  const pairs = Array.from({ length: 100 }, (_, i) => ({
    t: i * 1000, ref_bpm: 100,
    est_bpm: i === 7 || i === 93 ? 140 : 101, // two large errors
  }));
  const m = comparisonMetrics(pairs);
  assert.equal(m.large_error_n, 2);
  assert.equal(m.large_error_rate, 0.02);
  assert.equal(m.within.b20, 0.98);
});

test('metrics: transition lag detected on a delayed step', () => {
  // reference: 60 bpm, then 120 step for 20 s, back to 60
  // estimate: the same series delayed by 3 s (est(t) = ref(t-3))
  const pairs = [];
  for (let t = 0; t < 60; t += 1) {
    const ref = t >= 20 && t < 40 ? 120 : 60;
    const est = (() => {
      if (t - 3 >= 0) return t - 3 >= 20 && t - 3 < 40 ? 120 : 60;
      return 60;
    })();
    pairs.push({ t: T0 + t * 1000, ref_bpm: ref, est_bpm: est });
  }
  const m = comparisonMetrics(pairs);
  assert.ok(m.transition_steps >= 1);
  assert.equal(m.transition_lag_s, 3); // est lags ref by 3 s
});

test('metrics: stratify by activity and by quality buckets', () => {
  const pairs = [
    { t: 0, ref_bpm: 60, est_bpm: 61, activity: 'rest', quality: 0.9 },
    { t: 1000, ref_bpm: 80, est_bpm: 81, activity: 'run', quality: 0.6 },
    { t: 2000, ref_bpm: 85, est_bpm: 84, activity: 'run', quality: 0.3 },
    { t: 3000, ref_bpm: 62, est_bpm: 65, activity: undefined, quality: null },
  ];
  const byAct = stratify(pairs, 'activity');
  assert.deepEqual(byAct.map((g) => g.key), ['rest', 'run', 'unknown']);
  const rest = byAct.find((g) => g.key === 'rest');
  assert.equal(rest.count, 1);
  assert.equal(rest.metrics.mae, 1);
  const byQ = stratify(pairs, 'quality');
  const keys = Object.fromEntries(byQ.map((g) => [g.key, g.count]));
  assert.equal(keys.high, 1);
  assert.equal(keys.med, 1);
  assert.equal(keys.low, 1);
  assert.equal(keys.unknown, 1);
});

// ---------------------------------------------------------------------------
// split.js — person-level disjointness + determinism
// ---------------------------------------------------------------------------

function buildItems(users, perUser) {
  const out = [];
  for (let u = 0; u < users; u += 1) {
    for (let i = 0; i < perUser; i += 1) {
      out.push({ id: `item-${u}-${i}`, user_id: `user-${u}` });
    }
  }
  return out;
}

test('personSplit: disjoint persons, exact fraction, input-order independent', () => {
  const items = buildItems(10, 10);
  const fwd = personSplit(items, { by: 'user_id', testFraction: 0.3, seed: 42 });
  const rev = personSplit([...items].reverse(), { by: 'user_id', testFraction: 0.3, seed: 42 });

  // exact count: 10 persons * 0.3 = 3 held out
  assert.equal(fwd.meta.persons.test, 3);
  assert.equal(fwd.meta.persons.train, 7);

  // disjoint person ids between train and test (no subject leakage)
  const trainKeys = new Set(fwd.meta.trainKeys);
  const testKeys = new Set(fwd.meta.testKeys);
  for (const k of testKeys) assert.ok(!trainKeys.has(k), `${k} leaked into both`);

  // all items appear exactly once across train/test
  assert.equal(fwd.train.length + fwd.test.length, items.length);
  assert.equal(fwd.meta.testKeys.length * 10, fwd.test.length);

  // determinism: same seed + different input order -> same assignment
  assert.deepEqual(fwd.meta.testKeys, rev.meta.testKeys);
  assert.deepEqual(fwd.meta.trainKeys, rev.meta.trainKeys);
  assert.equal(fwd.test.length, rev.test.length);
});

test('personSplit: different seed changes (not guaranteed, but with 30+ keys overwhelmingly likely) the holdout', () => {
  const items = buildItems(30, 5);
  const a = personSplit(items, { seed: 1 });
  const b = personSplit(items, { seed: 2 });
  // at most a rare collision; assert the assignments are not equal for seeds 1,2
  assert.notDeepEqual(a.meta.testKeys, b.meta.testKeys);
});

test('personSplit: missing key throws with a clear message', () => {
  assert.throws(() => personSplit([{ id: 1 }], { by: 'user_id' }), /missing person key/);
  assert.throws(() => personSplit(buildItems(3, 2), { testFraction: 0 }), /testFraction/);
});
