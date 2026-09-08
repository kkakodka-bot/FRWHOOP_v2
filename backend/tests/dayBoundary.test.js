import assert from 'node:assert/strict';
import test from 'node:test';
import { dayBounds, localDateKey, physiologicalDay } from '../time/dayBoundary.js';

test('Pacific and UTC assign different calendar days near UTC midnight', () => {
  const instant = '2026-08-31T07:30:00.000Z';
  assert.equal(localDateKey(instant, 'UTC'), '2026-08-31');
  assert.equal(localDateKey(instant, 'America/Los_Angeles'), '2026-08-31');
  const late = '2026-09-01T06:30:00.000Z';
  assert.equal(localDateKey(late, 'UTC'), '2026-09-01');
  assert.equal(localDateKey(late, 'America/Los_Angeles'), '2026-08-31');
});

test('day bounds are local midnight instants stored as UTC', () => {
  const pacific = dayBounds('2026-08-31', 'America/Los_Angeles');
  assert.equal(pacific.timezone_name, 'America/Los_Angeles');
  assert.equal(pacific.day_start_at, '2026-08-31T07:00:00.000Z');
  assert.equal(pacific.day_end_at, '2026-09-01T07:00:00.000Z');
  const utc = dayBounds('2026-08-31', 'UTC');
  assert.equal(utc.day_start_at, '2026-08-31T00:00:00.000Z');
  assert.notEqual(pacific.day_start_at, utc.day_start_at);
});

test('physiological day uses wake instant in the profile IANA zone', () => {
  assert.equal(physiologicalDay({
    wakeIso: '2026-08-31T16:42:00.000Z',
    timeZone: 'America/Los_Angeles',
  }), '2026-08-31');
  assert.equal(physiologicalDay({
    wakeIso: '2026-09-01T06:42:00.000Z',
    timeZone: 'America/Los_Angeles',
  }), '2026-08-31');
});
