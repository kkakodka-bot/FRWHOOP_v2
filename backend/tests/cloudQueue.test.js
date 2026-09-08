import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSyncQueue, mergeIngestPayloads } from '../cloud/syncQueue.js';
import { coachRowToDailyMetric, buildBackfillRows } from '../metrics/backfill.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-q-')), 'queue.json');
}

test('queue persists ops to disk and restores them on restart', async () => {
  const file = tmpFile();
  const q1 = createSyncQueue({ filePath: file, executor: { configured: () => false, exec: async () => {} } });
  q1.enqueue({ type: 'ingest', payload: { user_id: 'u1', daily_metrics: [{ day: '2026-08-24' }] } });
  q1.enqueue({ type: 'integration.upsert', userId: 'u1', provider: 'apple_health', row: { status: 'connected' } });
  q1.stop();

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.pending.length, 2);

  const executed = [];
  const q2 = createSyncQueue({
    filePath: file,
    executor: { configured: () => true, exec: async (op) => executed.push(op.type) },
  });
  q2.start();
  await q2.flush();
  q2.stop();
  assert.deepEqual(executed.sort(), ['ingest', 'integration.upsert']);
  assert.equal(q2.status().pending, 0);
  assert.ok(q2.status().lastOkAt);
});

test('legacy settings ops on disk are dropped on load', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    pending: [
      { type: 'settings', settings: { units: 'metric' }, seq: 1 },
      { type: 'ingest', payload: { user_id: 'u', object_manifests: [{ id: 'm' }], sleep_details: [] }, seq: 2 },
    ],
  }));
  const q = createSyncQueue({ filePath: file, executor: { configured: () => false, exec: async () => {} } });
  q.start();
  assert.equal(q._pending().length, 1);
  assert.equal(q._pending()[0].type, 'ingest');
  assert.equal(q._pending()[0].__key, 'ingest:u:unknown');
  assert.equal(Object.prototype.hasOwnProperty.call(q._pending()[0].payload, 'sleep_details'), false);
  q.stop();
});

test('settings ops are not queued; ingest ops are scoped per user', () => {
  const q = createSyncQueue({ filePath: tmpFile(), executor: { configured: () => false, exec: async () => {} } });
  assert.equal(q.enqueue({ type: 'settings', settings: { a: 1 } }), false);
  q.enqueue({ type: 'ingest', payload: { user_id: 'a', daily_metrics: [{ day: '2026-08-23', charge: 1 }] } });
  q.enqueue({ type: 'ingest', payload: { user_id: 'b', daily_metrics: [{ day: '2026-08-23', charge: 2 }] } });
  q.enqueue({ type: 'ingest', payload: { user_id: 'a', daily_metrics: [{ day: '2026-08-24', charge: 3 }] } });
  const pending = q._pending();
  assert.equal(pending.length, 2);
  assert.equal(pending.some((o) => o.type === 'settings'), false);
  const a = pending.find((o) => o.payload?.user_id === 'a');
  assert.equal(a.payload.daily_metrics.length, 2);
  q.stop();
});

test('ingest ops for distinct devices keep their device declarations', () => {
  const q = createSyncQueue({ filePath: tmpFile(), executor: { configured: () => false, exec: async () => {} } });
  q.enqueue({ type: 'ingest', payload: { user_id: 'u', device: { id: 'live' }, daily_metrics: [] } });
  q.enqueue({ type: 'ingest', payload: { user_id: 'u', device: { id: 'history' }, object_manifests: [{ id: 'm' }] } });
  assert.deepEqual(q._pending().map((op) => op.payload.device.id).sort(), ['history', 'live']);
  q.stop();
});

test('daily_metrics rows merge by day per user', () => {
  const q = createSyncQueue({ filePath: tmpFile(), executor: { configured: () => false, exec: async () => {} } });
  q.enqueue({ type: 'daily_metrics', userId: 'u', rows: [{ day: '2026-08-23', charge: 50 }, { day: '2026-08-24', charge: 60 }] });
  q.enqueue({ type: 'daily_metrics', userId: 'u', rows: [{ day: '2026-08-24', charge: 71 }] });
  const pending = q._pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].rows.length, 2);
  assert.equal(pending[0].rows.find((r) => r.day === '2026-08-24').charge, 71);
  q.stop();
});

test('integration delete supersedes a pending upsert for the same provider', () => {
  const q = createSyncQueue({ filePath: tmpFile(), executor: { configured: () => false, exec: async () => {} } });
  q.enqueue({ type: 'integration.upsert', provider: 'strava', row: { status: 'connected' } });
  q.enqueue({ type: 'integration.delete', provider: 'strava' });
  const pending = q._pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].type, 'integration.delete');
  q.stop();
});

test('failed ops stay queued with backoff and retry successfully later', async () => {
  let now = 1_000_000;
  let failures = 2;
  const executed = [];
  const q = createSyncQueue({
    filePath: tmpFile(),
    now: () => now,
    executor: {
      configured: () => true,
      exec: async (op) => {
        if (failures > 0) { failures -= 1; throw new Error('boom'); }
        executed.push(op.type);
      },
    },
  });
  q.enqueue({ type: 'ingest', payload: { user_id: 'u', daily_metrics: [{ day: 'x' }] } });
  await q.flush();
  assert.equal(q.status().pending, 1);
  assert.equal(q.status().lastError.message, 'boom');
  assert.equal(q.status().totals.failed, 1);

  await q.flush(); // still within backoff window -> no retry yet
  assert.equal(q.status().totals.failed, 1);

  now += 3_000; // past the 2s first backoff
  await q.flush();
  assert.equal(q.status().totals.failed, 2);

  now += 6_000; // past the 5s second backoff
  await q.flush();
  assert.deepEqual(executed, ['ingest']);
  assert.equal(q.status().pending, 0);
  assert.equal(q.status().lastError, null);
  q.stop();
});

test('fresh data retries a previously failed merged op immediately', async () => {
  let fail = true;
  const q = createSyncQueue({
    filePath: tmpFile(),
    executor: {
      configured: () => true,
      exec: async () => {
        if (fail) throw new Error('schema unavailable');
      },
    },
  });
  q.enqueue({ type: 'ingest', payload: { user_id: 'u', daily_metrics: [{ day: '2026-08-25' }] } });
  await q.flush();
  fail = false;
  q.enqueue({ type: 'ingest', payload: { user_id: 'u', daily_metrics: [{ day: '2026-08-25', steps: 10 }] } });
  await q.flush();
  assert.equal(q.status().pending, 0);
  q.stop();
});

test('queue does not flush when the executor is unconfigured', async () => {
  const q = createSyncQueue({ filePath: tmpFile(), executor: { configured: () => false, exec: async () => { throw new Error('should not run'); } } });
  q.enqueue({ type: 'ingest', payload: { user_id: 'u' } });
  await q.flush();
  assert.equal(q.status().pending, 1);
  q.stop();
});

test('mergeIngestPayloads dedupes table rows and caps telemetry', () => {
  const a = {
    user_id: 'u',
    device: { id: 'd1' },
    daily_metrics: [{ day: '2026-08-23', charge: 1 }],
    sleep_nights: [{ id: 'n1', asleep_min: 400 }],
    live_windows: [{ start_at: 'a' }],
  };
  const b = {
    user_id: 'u',
    daily_metrics: [{ day: '2026-08-23', charge: 2 }],
    sleep_nights: [{ id: 'n1', asleep_min: 420 }, { id: 'n2', asleep_min: 300 }],
    metric_runs: [{ algorithm: 'sleep_v1' }],
  };
  const merged = mergeIngestPayloads(a, b);
  assert.equal(merged.daily_metrics.length, 1);
  assert.equal(merged.daily_metrics[0].charge, 2);
  assert.equal(merged.sleep_nights.length, 2);
  assert.equal(merged.sleep_nights.find((n) => n.id === 'n1').asleep_min, 420);
  assert.equal(merged.live_windows.length, 1);
  assert.equal(merged.metric_runs.length, 1);
  assert.equal(merged.device.id, 'd1');
  assert.equal(Object.prototype.hasOwnProperty.call(merged, 'sleep_details'), false);
  // An empty replacement is scoped to the days the clearing payload actually
  // recomputed; unattributable rows survive (the clear cannot prove they
  // belong to a cleared day).
  const cleared = mergeIngestPayloads(
    { sleep_details: [{ session_id: 's1', asleep_min: 45 }] },
    { sleep_details: [] },
  );
  assert.deepEqual(cleared.sleep_details, [{ session_id: 's1', asleep_min: 45 }]);
  // With day attribution the clear removes exactly the recomputed day's rows.
  const scoped = mergeIngestPayloads(
    {
      sessions: [{ id: 's1', kind: 'sleep', external_id: 'sleep:d1:2026-08-24:main' }],
      sleep_details: [
        { session_id: 's1', asleep_min: 45 },
        { session_id: 's2', asleep_min: 60 },
      ],
    },
    {
      daily_metrics: [{ user_id: 'u', day: '2026-08-24', record_class: 'user' }],
      sleep_details: [],
    },
  );
  assert.deepEqual(scoped.sleep_details, [{ session_id: 's2', asleep_min: 60 }]);
  assert.deepEqual(scoped.sleep_replace_days, ['2026-08-24']);
  const overnightThenLive = mergeIngestPayloads(
    {
      user_id: 'u',
      device: { id: 'd1' },
      daily_metrics: [{ user_id: 'u', day: '2026-08-28', recovery_score: 44 }],
      sessions: [{ id: 's-n', kind: 'sleep', external_id: 'sleep:d1:2026-08-28:main' }],
      sleep_details: [{ session_id: 's-n', original_end_at: '2026-08-28T14:00:00Z' }],
    },
    {
      user_id: 'u',
      device: { id: 'd1' },
      daily_metrics: [{ user_id: 'u', day: '2026-08-29', strain_score: 6.7 }],
    },
  );
  assert.deepEqual(overnightThenLive.sleep_replace_days, ['2026-08-28']);
  assert.equal(Object.prototype.hasOwnProperty.call(overnightThenLive, 'sleep_details'), true);
});

test('workout ledger events queued one at a time all survive the merge', () => {
  const q = createSyncQueue({ filePath: tmpFile(), executor: { configured: () => false, exec: async () => {} } });
  const ledger = [
    'workout_candidate_started',
    'workout_confirmed',
    'haptic_attempted',
    'workout_mode_started',
    'workout_ended_manually',
    'workout_persisted',
  ];
  ledger.forEach((event_type, i) => {
    q.enqueue({
      type: 'ingest',
      payload: { user_id: 'u', events: [{ id: `e${i}`, user_id: 'u', event_type }] },
    });
  });
  const pending = q._pending();
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].payload.events.map((e) => e.event_type), ledger);
  q.stop();
});

test('coachRowToDailyMetric maps coach history rows and treats 0 as missing', () => {
  const row = coachRowToDailyMetric({
    day: '2025-06-03', recovery: 78, strain: 0, hrv: 70, rhr: 55, resp: 13.1,
    spo2: 95.88, skinTemp: 33.9, calories: 0, avgHr: 0, maxHr: 0,
    sleepPerformance: 73, sleepEfficiency: 89, sleepConsistency: 69,
    asleepMin: 324, inBedMin: 363, lightMin: 151, deepMin: 98, remMin: 75,
    awakeMin: 39, sleepNeedMin: 532, sleepDebtMin: 58,
    sleepOnset: '2025-06-03 02:33:38', wakeOnset: '2025-06-03 08:40:52',
    nap: false, workouts: [],
  }, '7f2c9a10-4b3e-4d8a-9c11-00000000f001');
  assert.equal(row.day, '2025-06-03');
  assert.equal(row.charge, 78);
  assert.equal(row.effort, 0); // strain 0 is a real rest day
  assert.equal(row.active_kcal, null); // calories 0 means missing
  assert.equal(row.avg_hr_bpm, null);
  assert.equal(row.sleep_efficiency, 0.89); // stored as a fraction
  assert.equal(row.sleep_onset_at, '2025-06-03T02:33:38Z');
  assert.equal(row.extras.sleep_onset_raw, '2025-06-03 02:33:38');
  assert.equal(row.provenance.source, 'coach-days-backfill');

  assert.equal(coachRowToDailyMetric({ recovery: 50 }, 'u'), null); // no day
  assert.equal(coachRowToDailyMetric({ day: '2025-06-03' }, null), null); // no user
});

test('buildBackfillRows reads the real coach index', () => {
  const rows = buildBackfillRows('7f2c9a10-4b3e-4d8a-9c11-00000000f001');
  assert.ok(rows.length >= 180);
  assert.ok(rows.every((r) => r.user_id === '7f2c9a10-4b3e-4d8a-9c11-00000000f001'));
  assert.ok(rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day)));
});

test('start redrives a dead-lettered ingest op without a new merge', async () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    pending: [{
      type: 'ingest',
      payload: {
        user_id: 'u',
        device: { id: 'd' },
        daily_metrics: [{ day: '2026-08-28', recovery_score: 44 }],
      },
      __key: 'ingest:u:d',
      seq: 1,
      deadLetter: true,
      deadLetterReason: 'P0001',
      nextAt: Number.MAX_SAFE_INTEGER,
    }],
  }));
  const executed = [];
  const q = createSyncQueue({
    filePath: file,
    executor: { configured: () => true, exec: async (op) => executed.push(op.payload.daily_metrics[0].day) },
  });
  q.start();
  await q.flush();
  q.stop();
  assert.deepEqual(executed, ['2026-08-28']);
  assert.equal(q.status().deadLetters, 0);
  assert.equal(q.status().pending, 0);
});

test('a failing ingest does not head-of-line block a later user workout ingest', async () => {
  const executed = [];
  const q = createSyncQueue({
    filePath: tmpFile(),
    persist: false,
    executor: {
      configured: () => true,
      exec: async (op) => {
        if (op.payload?.user_id === 'a') throw new Error('poison ingest a');
        executed.push(op.payload.user_id);
      },
    },
  });
  q.enqueue({ type: 'ingest', payload: { user_id: 'a', sessions: [{ id: 'sa' }] } });
  q.enqueue({ type: 'ingest', payload: { user_id: 'b', sessions: [{ id: 'sb' }] } });
  await q.flush();
  q.stop();
  assert.deepEqual(executed, ['b']);
  assert.equal(q.status().pending, 1);
  assert.equal(q.status().pendingErrors[0].key, 'ingest:a:unknown');
  assert.ok(Number(q.status().totals.failed) >= 1);
});
