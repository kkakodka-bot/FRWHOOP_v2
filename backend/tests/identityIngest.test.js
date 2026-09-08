import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { registerHostRoutes, normalizeHostStore } from '../host/routes.js';
import { createUserRuntimes } from '../identity/userRuntime.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

test('JWT live posts isolate buffers and days live snapshots', async () => {
  const archived = [];
  const persisted = [];
  const engine = {
    archiveRawSamples: async (args) => {
      archived.push(args.extras?.userId);
      return { id: 'obj', status: 'ready' };
    },
    persistComputed: async (args) => {
      persisted.push(args.extras?.userId);
      return { scored: { day: '2026-08-24' } };
    },
  };
  // Own directory per run: the shared backend/data/live WAL would otherwise be
  // replayed into the next run and inflate the pending counts asserted below.
  const runtimes = createUserRuntimes({
    engine,
    liveDir: fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-live-')),
    cfg: { hrChunkMs: 3600_000 },
    loadStore: () => ({ activities: [], prefs: {}, bleLive: null }),
    saveStore: () => {},
    loadPersistedDays: async (uid) => (uid === A ? { '2026-08-24': { owner: A } } : { '2026-08-23': { owner: B } }),
  });
  let store = normalizeHostStore({ prefs: {} });
  const app = express();
  app.use(express.json());
  registerHostRoutes(app, {
    loadStore: () => store,
    saveStore: (next) => { store = next; },
    resolveUser: async (req) => {
      const auth = req.headers.authorization || '';
      if (auth === 'Bearer token-a') return { id: A, source: 'jwt' };
      if (auth === 'Bearer token-b') return { id: B, source: 'jwt' };
      const err = new Error('authentication required');
      err.status = 401;
      throw err;
    },
    onLiveSampleForUser: (userId, sample) => runtimes.append(userId, sample),
    onLiveFramesForUser: (userId, frame) => runtimes.appendFrames(userId, frame),
    onHistorySamplesForUser: (userId, samples, options) => runtimes.appendHistory(userId, samples, options),
    onLiveStatusForUser: (userId, live) => runtimes.setLive(userId, live),
    onLiveGapsForUser: (userId, gaps) => runtimes.appendGaps(userId, gaps),
    loadLiveForUser: (userId) => runtimes.liveOf(userId),
    loadPersistedDays: async (userId) => (
      userId === A ? { '2026-08-24': { owner: A } } : { '2026-08-23': { owner: B } }
    ),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const json = async (path, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    const denied = await json('/api/ble/live', { method: 'POST', body: { heartRate: 90, connected: true } });
    assert.equal(denied.status, 401);
    store.bleLive = { heartRate: 55, connected: true, at: '2026-08-31T12:00:00Z' };
    const leaked = await json('/api/ble/live');
    assert.equal(leaked.status, 401);
    assert.notEqual(leaked.body.heartRate, 55);

    const t0 = new Date(Date.now() - 12_000).toISOString();
    const t1 = new Date(Date.now() - 8_000).toISOString();
    const t2 = new Date(Date.now() - 4_000).toISOString();
    const t3 = new Date(Date.now() - 1_000).toISOString();

    const aPost = await json('/api/ble/live', {
      method: 'POST',
      headers: { authorization: 'Bearer token-a' },
      body: { heartRate: 64, connected: true, at: t0 },
    });
    assert.equal(aPost.status, 200);
    assert.equal(aPost.body.userId, A);
    assert.equal(aPost.body.heartRate, 64);

    const bPost = await json('/api/ble/live', {
      method: 'POST',
      headers: { authorization: 'Bearer token-b' },
      body: { heartRate: 148, connected: true, at: t1 },
    });
    assert.equal(bPost.status, 200);
    assert.equal(bPost.body.userId, B);

    const aLive = await json('/api/ble/live', { headers: { authorization: 'Bearer token-a' } });
    const bLive = await json('/api/ble/live', { headers: { authorization: 'Bearer token-b' } });
    assert.equal(aLive.body.heartRate, 64);
    assert.equal(bLive.body.heartRate, 148);

    const aDays = await json('/api/days', { headers: { authorization: 'Bearer token-a' } });
    const bDays = await json('/api/days', { headers: { authorization: 'Bearer token-b' } });
    assert.equal(aDays.body.userId, A);
    assert.equal(aDays.body.live.heartRate, 64);
    assert.equal(bDays.body.live.heartRate, 148);
    assert.ok(aDays.body.days['2026-08-24']);
    assert.ok(!aDays.body.days['2026-08-23']);
    assert.ok(bDays.body.days['2026-08-23']);

    const gapped = await json('/api/ble/live', {
      method: 'POST',
      headers: { authorization: 'Bearer token-a' },
      body: {
        connected: true,
        heartRate: 72,
        samples: [],
        gaps: [{
          kind: 'connection',
          start_at: new Date(Date.now() - 60_000).toISOString(),
          end_at: t0,
          expected_samples: 15,
          received_samples: 0,
        }],
      },
    });
    assert.ok(gapped.body.persisted === 0 || gapped.body.persisted === 1);
    assert.ok(runtimes.bufferOf(A).gapCount() >= 1);

    const ack = await json('/api/ble/live', {
      method: 'POST',
      headers: { authorization: 'Bearer token-a' },
      body: {
        connected: true,
        heartRate: 72,
        samples: [
          { seq: 12, heartRate: 70, datetime: t2 },
          { seq: 13, heartRate: 71, datetime: t3 },
        ],
      },
    });
    assert.equal(ack.body.acked_through, 13);
    assert.equal(ack.body.persisted, 2);

    const livePendingBeforeHistory = runtimes.bufferOf(A).pendingCount();
    const liveGapsBeforeHistory = runtimes.bufferOf(A).gapCount();
    const history = await json('/api/ble/live', {
      method: 'POST',
      headers: { authorization: 'Bearer token-a' },
      body: {
        connected: true,
        heartRate: 72,
        samples: [],
        phoneMotion: 8,
        historySamples: [
          {
            seq: 30,
            t: '2026-08-22T23:59:56.000Z',
            bpm: 52,
            source: 'whoop_history',
            layout: 'history-v1',
            family: 'puffin',
            decoder: 'ios/3',
          },
          {
            seq: 31,
            t: '2026-08-23T00:00:00.000Z',
            gx: 0.1,
            gy: -0.9,
            gz: 0.2,
            dyn_accel: 0.04,
            phoneMotion: 7,
          },
          { seq: 32, t: '2026-08-23T00:00:04.000Z', gx: 0.1, gy: 0.2 },
          { seq: 33, t: '2026-08-23T00:00:08.000Z', rr_ms: [980] },
        ],
      },
    });
    assert.equal(history.status, 200);
    assert.equal(history.body.history_persisted, 3);
    assert.equal(history.body.history_durable, 3);
    assert.equal(history.body.history_rejected, 1);
    assert.equal(history.body.history_acked_through, 31);
    assert.deepEqual(history.body.history_affected_days, ['2026-08-22', '2026-08-23']);
    assert.equal(runtimes.bufferOf(A).pendingCount(), livePendingBeforeHistory);
    assert.equal(runtimes.bufferOf(A).gapCount(), liveGapsBeforeHistory);
    assert.equal(runtimes.historyBufferOf(A).pendingCount(), 3);

    const frames = await json('/api/ble/live', {
      method: 'POST',
      headers: { authorization: 'Bearer token-a' },
      body: {
        connected: true,
        heartRate: 72,
        samples: [],
        frames: [
          { seq: 1, hex: 'aa0114000001', t: t2, family: 'puffin', char: 'FD4B0003-0000-1000-8000-00805F9B34FB', n: 6, fw: '50.35.0' },
          { seq: 2, hex: 'aa01ff', t: t3, family: 'puffin', char: 'FD4B0002-0000-1000-8000-00805F9B34FB', n: 3 },
        ],
      },
    });
    assert.equal(frames.body.frames_acked_through, 2);
    assert.equal(frames.body.frames_persisted, 2);
    assert.equal(frames.body.persisted, 0);
    assert.equal(runtimes.bufferOf(A).pendingFrameCount(), 2);

    const hold = await json('/api/ble/live', {
      method: 'POST',
      headers: { authorization: 'Bearer token-a' },
      body: { connected: true, heartRate: 80, samples: [] },
    });
    assert.equal(hold.body.heartRate, 80);
    assert.equal(hold.body.acked_through, null);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test('device token does not overlay another account onto a signed-in JWT user', async () => {
  const jwtUser = '11111111-1111-4111-8111-111111111111';
  const strapUser = '7f2c9a10-4b3e-4d8a-9c11-00000000f001';
  let store = normalizeHostStore({ prefs: {} });
  const app = express();
  app.use(express.json());
  registerHostRoutes(app, {
    loadStore: () => store,
    saveStore: (next) => { store = next; },
    deviceToken: 'secret',
    resolveUser: async (req) => {
      const auth = req.headers.authorization || '';
      if (auth === 'Bearer token-jwt') return { id: jwtUser, source: 'jwt' };
      const err = new Error('authentication required');
      err.status = 401;
      throw err;
    },
    loadLiveForUser: (userId) => (userId === strapUser ? { heartRate: 71, connected: true } : { heartRate: 64, connected: true }),
    loadPersistedDays: async (userId) => (
      userId === jwtUser
        ? { '2026-08-25': { physiological_summary: { 'Heart rate variability (ms)': 64.1 } } }
        : { '2026-08-25': { physiological_summary: { 'Day Strain': 2.9, 'Energy burned (cal)': 62 } } }
    ),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  try {
    const merged = await fetch(`http://127.0.0.1:${port}/api/days`, {
      headers: {
        authorization: 'Bearer token-jwt',
        'x-frwhoop-device-token': 'secret',
      },
    });
    const body = await merged.json();
    assert.equal(body.userId, jwtUser);
    assert.equal(body.days['2026-08-25'].physiological_summary['Heart rate variability (ms)'], 64.1);
    assert.equal(body.days['2026-08-25'].physiological_summary['Day Strain'], undefined);
    assert.equal(body.live.heartRate, 64);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
