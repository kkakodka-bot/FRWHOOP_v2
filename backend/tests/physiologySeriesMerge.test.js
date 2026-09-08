import assert from 'node:assert/strict';
import test from 'node:test';
import { createMetricsDb } from '../metrics/repository.js';

const USER = '11111111-1111-4111-8111-111111111111';
const DAY = '2026-08-27';

function response(body = null) {
  return {
    ok: true,
    status: 200,
    async text() { return body == null ? '' : JSON.stringify(body); },
    async json() { return body ?? []; },
  };
}

function point(t, n) {
  return { t, avg_hr: 70, min_hr: 60, max_hr: 80, n };
}

/**
 * A day's curve is assembled from many partial upserts: live ticks while the app
 * is open plus one series per archived history object. Each carries only its own
 * sample_count, so the stored count has to come from the merged curve.
 */
async function upsertSeries({ existing, incoming }) {
  const writes = [];
  const db = createMetricsDb({
    cfg: {
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'service-key',
      ingestSecret: 'secret',
    },
    fetchImpl: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (url.includes('daily_physiology_series')) {
        if ((options.method || 'GET') === 'GET') return response(existing ? [existing] : []);
        writes.push(body);
      }
      return response([]);
    },
  });
  await db.upsertPayload({ user_id: USER, daily_physiology_series: [incoming] });
  assert.equal(writes.length, 1);
  return writes[0];
}

test('merged physiology series counts samples across every partial batch', async () => {
  const written = await upsertSeries({
    existing: {
      user_id: USER,
      day: DAY,
      version: 3,
      sample_count: 100,
      hr_series: [point('2026-08-27T01:00:00.000Z', 60), point('2026-08-27T01:05:00.000Z', 40)],
    },
    incoming: {
      user_id: USER,
      day: DAY,
      sample_count: 90,
      hr_series: [point('2026-08-27T20:00:00.000Z', 50), point('2026-08-27T20:05:00.000Z', 40)],
    },
  });
  assert.equal(written.hr_series.length, 4);
  // 60 + 40 + 50 + 40. A max would have reported 100: the largest batch, not the day.
  assert.equal(written.sample_count, 190);
  assert.equal(written.version, 4);
});

test('re-upserting the same physiology batch does not inflate the count', async () => {
  const hrSeries = [point('2026-08-27T01:00:00.000Z', 60), point('2026-08-27T01:05:00.000Z', 40)];
  const written = await upsertSeries({
    existing: {
      user_id: USER, day: DAY, version: 1, sample_count: 100, hr_series: hrSeries,
    },
    incoming: {
      user_id: USER, day: DAY, sample_count: 100, hr_series: hrSeries,
    },
  });
  assert.equal(written.hr_series.length, 2);
  assert.equal(written.sample_count, 100);
});

test('a series whose points carry no per-bucket count keeps the previous max', async () => {
  const written = await upsertSeries({
    existing: {
      user_id: USER,
      day: DAY,
      version: 1,
      sample_count: 240,
      hr_series: [{ t: '2026-08-27T01:00:00.000Z', avg_hr: 70 }],
    },
    incoming: {
      user_id: USER,
      day: DAY,
      sample_count: 30,
      hr_series: [{ t: '2026-08-27T02:00:00.000Z', avg_hr: 72 }],
    },
  });
  assert.equal(written.sample_count, 240);
});

test('first write for a day stores its own count untouched', async () => {
  const written = await upsertSeries({
    existing: null,
    incoming: {
      user_id: USER,
      day: DAY,
      sample_count: 55,
      hr_series: [point('2026-08-27T01:00:00.000Z', 55)],
    },
  });
  assert.equal(written.sample_count, 55);
  assert.equal(written.version, undefined);
});
