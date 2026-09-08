import test from 'node:test';
import assert from 'node:assert/strict';

import { accumulateSteps, STEPS_ALGORITHM_VERSION } from '../metrics/steps.js';

function sample(iso, { steps, cumulative, seq } = {}) {
  const s = { t: iso };
  if (steps != null) s.steps = steps;
  if (cumulative != null) s.step_cumulative = cumulative;
  if (seq != null) s.seq = seq;
  return s;
}

const TZ = 'America/New_York';

test('daily total from consecutive per-second deltas', () => {
  const samples = [];
  for (let i = 0; i < 60; i++) {
    samples.push(sample(`2026-08-25T12:00:${String(i).padStart(2, '0')}Z`, { steps: 1 }));
  }
  const r = accumulateSteps(samples, { timeZone: TZ });
  assert.equal(r.total, 60);
  // 60s of a 24h day is sparse coverage -> partial, not 'ok'
  assert.equal(r.status, 'partial');
  assert.equal(r.algorithm_version, STEPS_ALGORITHM_VERSION);
  assert.equal(r.input_mode, 'delta');
});

test('no step samples is unavailable, not zero', () => {
  const r = accumulateSteps([], { timeZone: TZ });
  assert.equal(r.status, 'unavailable');
  assert.equal(r.detail, 'no_step_samples');
  assert.equal(r.total, 0);
});

test('duplicate samples (same device second) are never double counted', () => {
  const base = [
    sample('2026-08-25T12:00:00Z', { steps: 1, seq: 1 }),
    sample('2026-08-25T12:00:01Z', { steps: 2, seq: 2 }),
  ];
  const dup = [
    sample('2026-08-25T12:00:00Z', { steps: 1, seq: 1 }),
    sample('2026-08-25T12:00:01Z', { steps: 2, seq: 2 }),
  ];
  const r = accumulateSteps([...base, ...dup], { timeZone: TZ });
  assert.equal(r.total, 3);
});

test('arrival order does not change the total (out-of-order samples)', () => {
  const a = sample('2026-08-25T12:00:00Z', { steps: 1 });
  const b = sample('2026-08-25T12:00:10Z', { steps: 2 });
  const c = sample('2026-08-25T12:00:05Z', { steps: 5 });
  const forward = accumulateSteps([a, b, c], { timeZone: TZ });
  const reverse = accumulateSteps([c, b, a], { timeZone: TZ });
  assert.equal(forward.total, 8);
  assert.equal(reverse.total, 8);
});

test('cumulative counter with u16 rollover is unwrapped', () => {
  const samples = [
    sample('2026-08-25T12:00:00Z', { cumulative: 65534 }),
    sample('2026-08-25T12:00:01Z', { cumulative: 65535 }),
    // wrap: 65535 -> 0 (1 step) then 4 more
    sample('2026-08-25T12:00:02Z', { cumulative: 4 }),
    sample('2026-08-25T12:00:03Z', { cumulative: 6 }),
  ];
  const r = accumulateSteps(samples, { timeZone: TZ });
  // deltas: 1, (4 + (65536-65535)) = 5, 2 => total 8
  assert.equal(r.total, 8);
  assert.equal(r.input_mode, 'cumulative');
});

test('u16 wrap is a wrap, not a mid-range reset', () => {
  const r = accumulateSteps([
    sample('2026-08-25T12:00:00Z', { cumulative: 65500 }),
    sample('2026-08-25T12:00:04Z', { cumulative: 20 }),
  ], { timeZone: TZ });
  assert.equal(r.total, 56);
  assert.equal(r.counter_wraps, 1);
  assert.equal(r.counter_resets, 0);
});

test('mid-range drop counts as a reset, not ~65k steps', () => {
  const r = accumulateSteps([
    sample('2026-08-25T12:00:00Z', { cumulative: 24433 }),
    sample('2026-08-25T12:00:01Z', { cumulative: 141 }),
  ], { timeZone: TZ });
  assert.equal(r.total, 0);
  assert.equal(r.counter_resets, 1);
  assert.equal(r.counter_wraps, 0);
});

test('implausible single-interval delta is refused, not added', () => {
  const samples = [
    sample('2026-08-25T12:00:00Z', { steps: 2 }),
    sample('2026-08-25T12:00:01Z', { steps: 5000 }), // unit error
    sample('2026-08-25T12:00:02Z', { steps: 3 }),
  ];
  const r = accumulateSteps(samples, { timeZone: TZ });
  assert.equal(r.total, 5); // 2 + 3
  assert.ok(r.refused_deltas >= 1);
});

test('explicit delta wins over cumulative when both present', () => {
  const samples = [
    sample('2026-08-25T12:00:00Z', { steps: 1, cumulative: 500 }),
    sample('2026-08-25T12:00:01Z', { steps: 1, cumulative: 501 }),
  ];
  const r = accumulateSteps(samples, { timeZone: TZ });
  assert.equal(r.total, 2);
});

test('two overlapping flushes for the same day do not double count', () => {
  // Simulates readDay returning the full day's samples on every flush: the
  // accumulator is idempotent because it processes the whole set each time.
  const setA = [sample('2026-08-25T12:00:00Z', { steps: 1 }), sample('2026-08-25T12:00:01Z', { steps: 1 })];
  const setB = [sample('2026-08-25T12:00:01Z', { steps: 1 }), sample('2026-08-25T12:00:02Z', { steps: 1 })];
  const separate = accumulateSteps([...setA], { timeZone: TZ }).total
    + accumulateSteps([...setB], { timeZone: TZ }).total;
  const singleDedupe = accumulateSteps([...setA, ...setB], { timeZone: TZ }).total;
  assert.equal(singleDedupe, 3); // seconds 00,01,02 distinct
  assert.ok(singleDedupe <= separate); // no double count
});

test('hourly intraday distribution is bucketed by local hour', () => {
  const samples = [
    // 2026-08-25T10:30Z = 06:30 local (EDT) -> hour 6
    sample('2026-08-25T10:30:00Z', { steps: 1 }),
    // 2026-08-25T13:00Z = 09:00 local -> hour 9
    sample('2026-08-25T13:00:00Z', { steps: 2 }),
  ];
  const r = accumulateSteps(samples, { timeZone: TZ });
  const byHour = Object.fromEntries(r.byHour.map((b) => [b.hour, b.steps]));
  assert.equal(byHour[6], 1);
  assert.equal(byHour[9], 2);
});

test('midnight rollover lands a step in the correct local day bucket', () => {
  // 2026-08-26T03:30Z = 2026-08-25 23:30 local
  const samples = [sample('2026-08-26T03:30:00Z', { steps: 4 })];
  const r = accumulateSteps(samples, { timeZone: TZ });
  assert.equal(r.total, 4);
  assert.equal(r.byHour[0]?.hour, 23);
});

test('null step_cumulative on live HR rows is not counter 0 and is not mixed in', () => {
  const history = [
    sample('2026-08-25T12:00:00Z', { cumulative: 100 }),
    sample('2026-08-25T12:00:01Z', { cumulative: 103 }),
    sample('2026-08-25T12:00:02Z', { cumulative: 107 }),
  ];
  const liveHr = [
    { t: '2026-08-25T12:00:00.500Z', bpm: 70, steps: null, step_cumulative: null },
    { t: '2026-08-25T12:00:01.500Z', bpm: 71, steps: null, step_cumulative: null },
  ];
  const mixed = accumulateSteps([...history, ...liveHr], { timeZone: TZ });
  assert.equal(mixed.total, 7); // 3 + 4
  assert.equal(accumulateSteps(liveHr, { timeZone: TZ }).status, 'unavailable');
});

test('same-second different cumulative counters are both kept', () => {
  const samples = [
    sample('2026-08-25T12:00:00Z', { cumulative: 100, seq: 1 }),
    sample('2026-08-25T12:00:00Z', { cumulative: 104, seq: 2 }),
  ];
  samples[0].device_id = 'strap-a';
  samples[1].device_id = 'strap-a';
  const r = accumulateSteps(samples, { timeZone: TZ });
  assert.equal(r.total, 4);
});

test('two devices in the same second do not merge counters', () => {
  const a = sample('2026-08-25T12:00:00Z', { cumulative: 10 });
  const b = sample('2026-08-25T12:00:01Z', { cumulative: 12 });
  a.device_id = 'strap-a';
  b.device_id = 'strap-a';
  const c = sample('2026-08-25T12:00:00Z', { cumulative: 50 });
  const d = sample('2026-08-25T12:00:01Z', { cumulative: 53 });
  c.device_id = 'strap-b';
  d.device_id = 'strap-b';
  const r = accumulateSteps([a, b, c, d], { timeZone: TZ });
  assert.equal(r.total, 2 + 3);
  assert.equal(r.devices, 2);
});

test('carry-in from the previous day credits a midnight-crossing jump', () => {
  const samples = [
    sample('2026-08-26T04:00:00Z', { cumulative: 110 }), // 00:00 EDT
    sample('2026-08-26T04:00:01Z', { cumulative: 112 }),
  ];
  const none = accumulateSteps(samples, { timeZone: TZ });
  assert.equal(none.total, 2);
  const withCarry = accumulateSteps(samples, { timeZone: TZ, carryInCounter: 100 });
  assert.equal(withCarry.total, 12);
  assert.equal(withCarry.used_carry_in, true);
});

test('datetime-only samples sort and accumulate the same as t', () => {
  const rows = [
    { datetime: '2026-08-25T12:00:02Z', step_cumulative: 12 },
    { datetime: '2026-08-25T12:00:00Z', step_cumulative: 10 },
    { datetime: '2026-08-25T12:00:01Z', step_cumulative: 11 },
  ];
  assert.equal(accumulateSteps(rows, { timeZone: TZ }).total, 2);
});

test('v1 emits deterministic minute deltas without changing its total', () => {
  const result = accumulateSteps([
    sample('2026-08-25T12:00:10Z', { steps: 2 }),
    sample('2026-08-25T12:01:10Z', { steps: 3 }),
  ], { timeZone: TZ });
  assert.equal(result.total, 5);
  assert.deepEqual(result.buckets_60s.map((bucket) => [bucket.start_at, bucket.count]), [
    ['2026-08-25T12:00:00.000Z', 2],
    ['2026-08-25T12:01:00.000Z', 3],
  ]);
  assert.ok(result.buckets_60s.every((bucket) => bucket.source_mode === 'v1_counter_delta'));
});

test('v1 marks coalesced cumulative deltas as fractional minute allocations', () => {
  const result = accumulateSteps([
    sample('2026-08-25T12:00:30Z', { cumulative: 100 }),
    sample('2026-08-25T12:01:30Z', { cumulative: 160 }),
  ], { timeZone: TZ });
  assert.equal(result.total, 60);
  assert.deepEqual(result.buckets_60s.map((bucket) => bucket.count), [30, 30]);
  assert.ok(result.buckets_60s.every((bucket) => bucket.allocated && bucket.coalesced));
});
