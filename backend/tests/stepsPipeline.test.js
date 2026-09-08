import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetricsEngine, dedupeReplaySamples } from '../metrics/engine.js';
import { carryInCounterForDay } from '../metrics/steps.js';
import { normalizeSample } from '../ingest/archiveFormat.js';

const USER = '22222222-2222-4222-8222-222222222222';

function makeEngine() {
  const dbRows = { daily_metrics: [] };
  const engine = createMetricsEngine({
    cfg: { localUserId: USER, rawStore: 'none', derivedStore: 'none', b2Bucket: 'FRWHOOP', buildHash: 'test' },
    stores: { raw: null, derived: null },
    db: {
      async upsertPayload(payload) {
        if (payload.daily_metrics) dbRows.daily_metrics.push(...payload.daily_metrics);
        return { ok: true };
      },
    },
  });
  return { engine, dbRows };
}

test('persistComputed does not mix yesterday lookback into today steps', async () => {
  const { engine, dbRows } = makeEngine();
  const samples = [];
  for (let i = 0; i < 10; i += 1) {
    samples.push({
      datetime: new Date(Date.UTC(2026, 7, 23, 23, i)).toISOString(),
      bpm: 52,
      step_cumulative: 500 + i,
      steps: 1,
    });
  }
  for (let i = 0; i < 10; i += 1) {
    samples.push({
      datetime: new Date(Date.UTC(2026, 7, 24, 12, i)).toISOString(),
      bpm: 70,
      step_cumulative: 600 + i,
      steps: 2,
    });
  }
  await engine.persistComputed({
    samples,
    extras: { day: '2026-08-24', timeZone: 'UTC' },
  });
  const row = dbRows.daily_metrics.find((r) => r.day === '2026-08-24');
  assert.equal(row.steps, 20);
});

test('real zero is persisted; unavailable omits the scalar', async () => {
  const { engine, dbRows } = makeEngine();
  const samples = [];
  for (let i = 0; i < 8; i += 1) {
    samples.push({
      datetime: new Date(Date.UTC(2026, 7, 24, 12, i)).toISOString(),
      bpm: 60,
      step_cumulative: 40,
      steps: 0,
    });
  }
  await engine.persistComputed({ samples, extras: { day: '2026-08-24', timeZone: 'UTC' } });
  const row = dbRows.daily_metrics.find((r) => r.day === '2026-08-24');
  assert.equal(row.steps, 0);
  assert.equal(row.confidence.steps.status, 'partial');

  const { engine: engine2, dbRows: rows2 } = makeEngine();
  await engine2.persistComputed({
    samples: [{ datetime: '2026-08-24T12:00:00.000Z', bpm: 70 }],
    extras: { day: '2026-08-24', timeZone: 'UTC' },
  });
  const missing = rows2.daily_metrics.find((r) => r.day === '2026-08-24');
  assert.equal(missing.steps, undefined);
  assert.equal(missing.confidence.steps.status, 'unavailable');
});

test('dedupeReplaySamples keeps different counters in the same second', () => {
  const a = { t: '2026-08-24T12:00:00.000Z', bpm: 70, step_cumulative: 10, device_id: 's' };
  const b = { t: '2026-08-24T12:00:00.000Z', bpm: 70, step_cumulative: 14, device_id: 's' };
  const out = dedupeReplaySamples([a, a, b]);
  assert.equal(out.length, 2);
});

test('carryInCounterForDay reads yesterday last counter', () => {
  const samples = [
    { t: '2026-08-23T23:59:00.000Z', step_cumulative: 900 },
    { t: '2026-08-24T00:00:02.000Z', step_cumulative: 910 },
  ];
  assert.equal(carryInCounterForDay(samples, '2026-08-24', 'UTC'), 900);
});

test('normalizeSample keeps numeric sensor_ts', () => {
  const row = normalizeSample({
    t: '2026-08-24T18:00:00.000Z',
    bpm: 60,
    sensor_ts: 1780000000,
    step_cumulative: 12,
  });
  assert.equal(row.sensor_ts, 1780000000);
});
