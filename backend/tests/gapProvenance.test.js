import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyGap, coverage, gapsOver, hoursSpanned } from '../ingest/gapProvenance.js';
import { seriesRowsFromSamples, unionBpmData } from '../metrics/buckets.js';

test('classifyGap prefers the earliest layer that actually failed', () => {
  assert.equal(classifyGap({ offWrist: true }), 'OFF_WRIST');
  assert.equal(classifyGap({ validityDropped: true }), 'INTENTIONAL_VALIDITY_FILTER');
  assert.equal(classifyGap({ apiHr: true, frontendHr: false }), 'API_HAS_DATA_FRONTEND_DROPPED');
  assert.equal(classifyGap({ supabaseHr: true, apiHr: false }), 'SUPABASE_HAS_DATA_API_DROPPED');
  assert.equal(classifyGap({ b2NormalizedHr: true, supabaseHr: false }), 'B2_HAS_NORMALIZED_NOT_SUPABASE');
  assert.equal(classifyGap({ b2RawType40: true, b2NormalizedHr: false }), 'B2_HAS_RAW_NOT_NORMALIZED');
  assert.equal(classifyGap({ iosQueue: true }), 'IOS_PERSISTED_NOT_UPLOADED');
  assert.equal(classifyGap({ iosReceived: true, iosQueue: false }), 'IOS_RECEIVED_NOT_PERSISTED');
  assert.equal(classifyGap({}), 'STRAP_OR_BLE_MISSING');
});

test('coverage leaves empty buckets empty', () => {
  const start = Date.parse('2026-08-27T07:00:00.000Z');
  const end = start + 3600_000;
  const times = [start + 60_000, start + 120_000];
  const cov = coverage(times, start, end, 5 * 60_000);
  assert.equal(cov.covered, 1);
  assert.equal(cov.expected, 12);
  const holes = gapsOver(times, start, end, 10);
  assert.ok(holes.some((g) => g.sec >= 3000));
});

test('hoursSpanned lists every UTC hour the gap touches', () => {
  const hours = hoursSpanned(
    Date.parse('2026-08-27T08:13:00.000Z'),
    Date.parse('2026-08-27T10:01:00.000Z'),
  );
  assert.deepEqual(hours, [
    '2026-08-27T08:00:00Z',
    '2026-08-27T09:00:00Z',
    '2026-08-27T10:00:00Z',
  ]);
});

test('a flush that crosses local midnight writes both day series', () => {
  const tz = 'America/Los_Angeles';
  const samples = [
    { t: '2026-08-25T06:50:00.000Z', bpm: 61 },
    { t: '2026-08-25T07:10:00.000Z', bpm: 64 },
  ];
  const rows = seriesRowsFromSamples(samples, { userId: '11111111-1111-4111-8111-111111111111', timeZone: tz });
  assert.deepEqual(rows.map((r) => r.day), ['2026-08-24', '2026-08-25']);
  assert.equal(rows[0].hr_series.length, 1);
  assert.equal(rows[1].hr_series.length, 1);
  assert.equal(rows[0].hr_series[0].avg_hr, 61);
  assert.equal(rows[1].hr_series[0].avg_hr, 64);
});

test('union prefers whoop_history over a live duplicate bucket', () => {
  const out = unionBpmData(
    [{ datetime: '2026-08-24T12:00:00.000Z', bpm: 90, src: 'whoop_rt', live: true }],
    [{ datetime: '2026-08-24T12:00:00.000Z', bpm: 72, src: 'whoop_history' }],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].bpm, 72);
  assert.equal(out[0].src, 'whoop_history');
});
