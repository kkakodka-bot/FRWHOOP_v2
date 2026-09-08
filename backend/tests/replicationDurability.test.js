import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createHourBuffer } from '../ingest/hourBuffer.js';
import { createHistoryBuffer } from '../ingest/historyBuffer.js';
import { batchIdFromPayload, createBatchAckStore, resolveBatchId } from '../ingest/phoneBatch.js';
import { createUserRuntimes } from '../identity/userRuntime.js';
import { createMetricsDb } from '../metrics/repository.js';
import { normalizeHostStore, registerHostRoutes } from '../host/routes.js';

const USER = '9f33375b-e029-480f-9ebb-a99e5ff22ac9';

function isoAt(startMs, i, stepMs) {
  return new Date(startMs + i * stepMs).toISOString();
}

test('batch identity is deterministic and bound to the payload', () => {
  const body = {
    samples: [{ seq: 1 }, { seq: 250 }],
    frames: [{ seq: 10 }, { seq: 89 }],
    historySamples: [{ seq: 500 }, { seq: 749 }],
  };
  const id = batchIdFromPayload(body);
  assert.equal(id, batchIdFromPayload(body));
  assert.match(id, /live:1-250:2/);
  assert.equal(resolveBatchId({ 'idempotency-key': id }, body), id);
  assert.equal(resolveBatchId({}, { ...body, batch_id: id }), id);
  assert.equal(resolveBatchId({ 'idempotency-key': id }, {}), '', 'mismatched key must not replay');
  assert.equal(resolveBatchId({}, body), '', 'do not invent an id for headerless test posts');
  assert.notEqual(batchIdFromPayload({ samples: [{ seq: 251 }] }), id);
});

test('batch ACK store survives process restart and does not duplicate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-batch-'));
  const file = path.join(dir, 'batch-acks.json');
  const first = createBatchAckStore(file);
  first.remember('v1:live:1-2:2:frames:0:hist:0', { acked_through: 2, persisted: 2 });
  const second = createBatchAckStore(file);
  assert.equal(second.replay('v1:live:1-2:2:frames:0:hist:0').acked_through, 2);
  assert.equal(second.replay('missing'), null);
});

test('listObjectManifests fails loud without service role (no empty no-op)', async () => {
  const db = createMetricsDb({
    cfg: { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon', ingestSecret: 's' },
    fetchImpl: async () => {
      throw new Error('must not call rest');
    },
  });
  await assert.rejects(
    () => db.listObjectManifests({ userId: USER, fromDay: '2026-08-31', toDay: '2026-09-01' }),
    (err) => err.code === 'service_role_required',
  );
  await assert.rejects(
    () => db.listIngestGaps(USER, '2026-08-31T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
    (err) => err.code === 'service_role_required',
  );
  await assert.rejects(
    () => db.invalidateDayCompleteness(USER, ['2026-08-31']),
    (err) => err.code === 'service_role_required',
  );
  await assert.rejects(
    () => db.getDayCompleteness(USER, '2026-08-31'),
    (err) => err.code === 'service_role_required',
  );
  await assert.rejects(
    () => db.upsertDayCompleteness(USER, { day: '2026-08-31', status: 'open' }),
    (err) => err.code === 'service_role_required',
  );
});

/**
 * Phone records locally for 6h while the Mac is down, then the host drains
 * the outbox. Restart mid-drain + B2/Supabase faults must not lose or
 * duplicate rows. WAL is the ACK point; B2 is async and content-addressed.
 */
test('6h phone outbox drains after backend restore without dupes or loss', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-repl-'));
  const start = Date.parse('2026-08-31T12:00:00.000Z');
  // 6h of phone-side collection while the Mac is down. Rows stay in one hour
  // bucket so append() does not fire an async hour-rollover flush mid-setup.
  const liveN = 240;
  const histN = 90;
  const frameN = 40;
  const step = 10_000;
  const phoneLive = Array.from({ length: liveN }, (_, i) => ({
    seq: i + 1,
    bpm: 60 + (i % 7),
    datetime: isoAt(start, i, step),
    deviceId: 'strap1',
    src: 'whoop_rt',
  }));
  const phoneHistory = Array.from({ length: histN }, (_, i) => ({
    seq: 10_000 + i,
    t: isoAt(start - 86400000, i, 4000),
    t_strap: isoAt(start - 86400000, i, 4000),
    sensor_ts: Math.floor((start - 86400000) / 1000) + i * 4,
    bpm: 52,
    gx: 0.1,
    gy: 0.9,
    gz: 0.1,
    src: 'whoop_history',
    deviceId: 'strap1',
    layout: 'history-v18',
    family: 'puffin',
    decoder: 'ios/3',
  }));
  const phoneFrames = Array.from({ length: frameN }, (_, i) => ({
    seq: 100 + i,
    t: isoAt(start, i, step),
    hex: `aa01${String(i).padStart(2, '0')}`,
    family: 'puffin',
    char: 'FD4B0003',
    deviceId: 'strap1',
  }));

  const objectIds = [];
  const archivedSeqs = new Set();
  const archivedHist = new Set();
  const archivedFrames = new Set();
  let b2Down = true;
  let supabaseDown = false;
  let upserts = 0;
  const engine = {
    async archiveRawSamples({ samples }) {
      if (b2Down) throw new Error('b2 down');
      if (supabaseDown) throw new Error('supabase_outage');
      upserts += 1;
      const id = `phys:${samples.map((s) => s.seq).join(',')}`;
      objectIds.push(id);
      for (const row of samples) {
        const seq = Number(row.seq);
        if (seq >= 10_000) archivedHist.add(seq);
        else archivedSeqs.add(seq);
      }
      return { id, status: 'ready' };
    },
    async archiveRawFrames({ frames }) {
      if (b2Down) throw new Error('b2 down');
      const id = `frames:${frames.map((f) => f.seq).join(',')}`;
      objectIds.push(id);
      for (const row of frames) archivedFrames.add(Number(row.seq));
      return { id, status: 'ready' };
    },
    async persistComputed() { return null; },
  };

  // Pin now() inside the sample hour so wall-clock age cannot auto-flush
  // mid-setup (due() compares first.datetime against now).
  const clock = () => new Date('2026-08-31T12:45:00.000Z');
  const bufferOpts = {
    dir, userId: USER, chunkMs: 24 * 3600_000, maxSamples: 10_000, engine, now: clock,
  };
  let buf = createHourBuffer(bufferOpts);
  let hist = createHistoryBuffer({ dir, userId: USER, engine, maxBatchSamples: 2000, flushMs: 0 });

  // 1-2. Backend offline: phone outbox grows, nothing is appended.
  assert.equal(buf.pendingCount(), 0);

  // 3. Restore: drain the 6h backlog in bounded batches (phone POST size).
  const BATCH = 50;
  function drainLive(target, rows) {
    for (let i = 0; i < rows.length; i += BATCH) {
      for (const row of rows.slice(i, i + BATCH)) target.append(row);
    }
  }
  drainLive(buf, phoneLive);
  assert.equal(buf.pendingCount(), liveN, 'WAL must hold the whole phone backlog');
  await assert.rejects(() => buf.flush(), /b2 down/);
  assert.equal(buf.pendingCount(), liveN, 'B2 outage must not trim the WAL');

  // 4. Restart backend mid-drain (new buffers over the same dir).
  buf = createHourBuffer(bufferOpts);
  hist = createHistoryBuffer({ dir, userId: USER, engine, maxBatchSamples: 2000, flushMs: 0 });
  assert.equal(buf.pendingCount(), liveN, 'restart must recover the WAL');

  // 5. B2 up, then a supabase fault, then success.
  b2Down = false;
  supabaseDown = true;
  await assert.rejects(() => buf.flush(), /supabase_outage/);
  assert.equal(buf.pendingCount(), liveN);
  supabaseDown = false;
  await buf.flush();
  assert.equal(buf.pendingCount(), 0);
  assert.equal(archivedSeqs.size, liveN, 'every live seq must archive once');

  const histResult = hist.appendBatch(phoneHistory);
  assert.equal(histResult.durable, histN);
  assert.equal(histResult.ackedThrough, 10_000 + histN - 1);
  hist = createHistoryBuffer({ dir, userId: USER, engine, maxBatchSamples: 2000, flushMs: 0 });
  const histDup = hist.appendBatch(phoneHistory);
  assert.equal(hist.pendingCount(), histN, 'restart must not duplicate history WAL rows');
  assert.equal(histDup.accepted, 0);
  await hist.flush();
  assert.equal(archivedHist.size, histN);

  for (const row of phoneFrames) buf.appendFrame(row);
  assert.equal(buf.pendingFrameCount(), frameN);
  buf = createHourBuffer(bufferOpts);
  assert.equal(buf.pendingFrameCount(), frameN, 'restart must recover the frames WAL');
  for (const row of phoneFrames) buf.appendFrame(row);
  assert.equal(buf.pendingFrameCount(), frameN, 're-sent frames must not duplicate the WAL');
  await buf.flush();
  assert.equal(archivedFrames.size, frameN);

  // Duplicate POST of the same live prefix: seq watermark, no second object.
  const objectsBefore = objectIds.length;
  buf = createHourBuffer(bufferOpts);
  drainLive(buf, phoneLive);
  assert.equal(buf.pendingCount(), 0, 're-sent flushed rows must not re-queue');
  await buf.flush();
  assert.equal(objectIds.length, objectsBefore, 'duplicate drain must not mint B2 objects');

  const uniqueObjects = new Set(objectIds);
  assert.equal(uniqueObjects.size, objectIds.length, 'archive ids must not repeat');
  assert.equal(archivedSeqs.size + archivedHist.size + archivedFrames.size, liveN + histN + frameN);
});

test('HTTP drain: identical batch_id replays ACK without a second WAL row', async () => {
  const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-http-'));
  const archived = [];
  const engine = {
    archiveRawSamples: async ({ samples }) => {
      archived.push(samples.map((s) => s.seq));
      return { id: 'obj', status: 'ready' };
    },
    persistComputed: async () => null,
    recomputeFromStorage: async () => ({ results: [] }),
  };
  const runtimes = createUserRuntimes({
    engine,
    liveDir,
    cfg: { hrChunkMs: 7 * 24 * 3600_000 },
    loadStore: () => ({ activities: [], prefs: {}, bleLive: null }),
    saveStore: () => {},
    loadPersistedDays: async () => ({}),
  });
  let store = normalizeHostStore({ prefs: {} });
  const app = express();
  app.use(express.json());
  registerHostRoutes(app, {
    loadStore: () => store,
    saveStore: (next) => { store = next; },
    resolveUser: async () => ({ id: USER, source: 'jwt' }),
    onLiveSampleForUser: (userId, sample) => runtimes.append(userId, sample),
    replayBatchAckForUser: (userId, batchId) => runtimes.replayBatchAck(userId, batchId),
    rememberBatchAckForUser: (userId, batchId, ack) => runtimes.rememberBatchAck(userId, batchId, ack),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const body = {
    connected: true,
    batch_id: 'v1:live:1-2:2:frames:0:hist:0',
    samples: [
      { seq: 1, bpm: 70, datetime: '2026-09-01T18:00:00.000Z', deviceId: 'strap1' },
      { seq: 2, bpm: 71, datetime: '2026-09-01T18:00:04.000Z', deviceId: 'strap1' },
    ],
  };
  try {
    const post = async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/ble/live`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer t',
          'idempotency-key': body.batch_id,
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const first = await post();
    assert.equal(first.status, 200);
    assert.equal(first.body.acked_through, 2);
    assert.equal(first.body.batch_id, body.batch_id);
    assert.equal(runtimes.bufferOf(USER).pendingCount(), 2);
    const second = await post();
    assert.equal(second.status, 200);
    assert.equal(second.body.acked_through, 2);
    assert.equal(runtimes.bufferOf(USER).pendingCount(), 2, 'replay must not append a second copy');
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test('stolen batch_id with a different payload appends instead of replaying the cached ACK', async () => {
  const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-batch-steal-'));
  const runtimes = createUserRuntimes({
    engine: {
      archiveRawSamples: async () => ({ id: 'obj', status: 'ready' }),
      persistComputed: async () => null,
      recomputeFromStorage: async () => ({ results: [] }),
    },
    liveDir,
    cfg: { hrChunkMs: 7 * 24 * 3600_000 },
    loadStore: () => ({ activities: [], prefs: {}, bleLive: null }),
    saveStore: () => {},
    loadPersistedDays: async () => ({}),
  });
  let store = normalizeHostStore({ prefs: {} });
  const app = express();
  app.use(express.json());
  registerHostRoutes(app, {
    loadStore: () => store,
    saveStore: (next) => { store = next; },
    resolveUser: async () => ({ id: USER, source: 'jwt' }),
    onLiveSampleForUser: (userId, sample) => runtimes.append(userId, sample),
    replayBatchAckForUser: (userId, batchId) => runtimes.replayBatchAck(userId, batchId),
    rememberBatchAckForUser: (userId, batchId, ack) => runtimes.rememberBatchAck(userId, batchId, ack),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const first = {
    connected: true,
    batch_id: 'v1:live:1-2:2:frames:0:hist:0',
    samples: [
      { seq: 1, bpm: 70, datetime: '2026-09-01T18:00:00.000Z', deviceId: 'strap1' },
      { seq: 2, bpm: 71, datetime: '2026-09-01T18:00:04.000Z', deviceId: 'strap1' },
    ],
  };
  const stolen = {
    connected: true,
    batch_id: first.batch_id,
    samples: [
      { seq: 10, bpm: 80, datetime: '2026-09-01T18:01:00.000Z', deviceId: 'strap1' },
      { seq: 11, bpm: 81, datetime: '2026-09-01T18:01:04.000Z', deviceId: 'strap1' },
    ],
  };
  try {
    const post = async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/ble/live`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer t',
          'idempotency-key': body.batch_id,
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const a = await post(first);
    assert.equal(a.status, 200);
    assert.equal(a.body.acked_through, 2);
    const b = await post(stolen);
    assert.equal(b.status, 200);
    assert.notEqual(b.body.acked_through, 2, 'conflicting payload must not reuse the cached ACK');
    assert.equal(b.body.acked_through, 11);
    assert.equal(runtimes.bufferOf(USER).pendingCount(), 4);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
