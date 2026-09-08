import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPushWal, getMemoryPushWalStore } from '../ingest/pushWal.js';
import { createPushIngest } from '../ingest/pushIngest.js';
import { PushProtocolError } from '../ingest/pushRegistry.js';

const USER = '7f2c9a10-4b3e-4d8a-9c11-00000000f001';
const SOURCE = '3a3486dd-5030-4e17-a00d-a781399890f9';
const DEVICE = 'strap-local-id';

function encodeBatch(batchId, bodyRecords) {
  const header = {
    type: 'batch',
    protocolVersion: '1.0',
    batchId,
    sourceId: SOURCE,
    deviceId: DEVICE,
    stream: 'hrSample',
    delivery: 'append',
    recordCount: bodyRecords.length,
    startCursor: null,
    endCursor: null,
  };
  const lines = [JSON.stringify(header), ...bodyRecords.map((row) => JSON.stringify(row))];
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

function makeSharedIngest(namespace) {
  const store = getMemoryPushWalStore(namespace);
  const archived = [];
  const ingest = createPushIngest({
    walFactory: (userId) => createPushWal({ userId, store }),
    walStore: store,
    archiveObject: async (args) => {
      archived.push(args);
      return { ready: true, objectKey: args.key };
    },
    upsertRows: async () => {},
  });
  return { store, archived, ingest };
}

test('two ingest instances sharing one store replay the same ack without double archive', async () => {
  const namespace = `cross-instance-${Date.now()}`;
  const batchId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const body = encodeBatch(batchId, [
    { type: 'record', key: { ts: 1723939201 }, data: { bpm: 61 } },
  ]);
  const a = makeSharedIngest(namespace);
  const b = makeSharedIngest(namespace);

  const ackA = await a.ingest.acceptBatch({ userId: USER, decodedBody: body });
  const ackB = await b.ingest.acceptBatch({ userId: USER, decodedBody: body });

  assert.deepEqual(ackB, ackA);
  assert.equal(a.archived.length, 1);
  assert.equal(b.archived.length, 0);
});

test('two ingest instances detect batch_id_conflict across stores', async () => {
  const namespace = `cross-instance-conflict-${Date.now()}`;
  const batchId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const bodyA = encodeBatch(batchId, [
    { type: 'record', key: { ts: 1723939201 }, data: { bpm: 61 } },
  ]);
  const bodyB = encodeBatch(batchId, [
    { type: 'record', key: { ts: 1723939202 }, data: { bpm: 62 } },
  ]);
  const a = makeSharedIngest(namespace);
  const b = makeSharedIngest(namespace);

  await a.ingest.acceptBatch({ userId: USER, decodedBody: bodyA });
  await assert.rejects(
    () => b.ingest.acceptBatch({ userId: USER, decodedBody: bodyB }),
    (err) => err instanceof PushProtocolError && err.message === 'batch_id_conflict' && err.status === 409,
  );
});

test('ingest quota exhaustion returns 429', async () => {
  const namespace = `quota-${Date.now()}`;
  const store = getMemoryPushWalStore(namespace);
  const ingest = createPushIngest({
    walFactory: (userId) => createPushWal({ userId, store }),
    walStore: store,
    quotaConfig: { maxBatches: 1, maxBytes: 10_000, windowSec: 3600 },
    archiveObject: async () => ({ ready: true }),
    upsertRows: async () => {},
  });

  const batchOne = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const batchTwo = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const bodyOne = encodeBatch(batchOne, [{ type: 'record', key: { ts: 1 }, data: { bpm: 60 } }]);
  const bodyTwo = encodeBatch(batchTwo, [{ type: 'record', key: { ts: 2 }, data: { bpm: 61 } }]);

  await ingest.acceptBatch({ userId: USER, decodedBody: bodyOne });
  await assert.rejects(
    () => ingest.acceptBatch({ userId: USER, decodedBody: bodyTwo }),
    (err) => err instanceof PushProtocolError && err.message === 'ingest_quota_exceeded' && err.status === 429,
  );
});

test('noop push wal migration defines wal, ack, quota tables and rpcs', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(
    path.join(here, '../../supabase/migrations/20260907150000_noop_push_wal.sql'),
    'utf8',
  );
  assert.match(sql, /create table if not exists public\.noop_push_wal/);
  assert.match(sql, /primary key \(user_id, batch_id\)/);
  assert.match(sql, /create table if not exists public\.noop_push_acks/);
  assert.match(sql, /create table if not exists public\.noop_push_ingest_quota/);
  assert.match(sql, /function public\.noop_push_save_ack/);
  assert.match(sql, /function public\.noop_push_consume_ingest_quota/);
  assert.match(sql, /batch_id_conflict/);
  assert.match(sql, /ingest_quota_exceeded/);
});
