import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import express from 'express';
import { createPushWal } from '../ingest/pushWal.js';
import { createPushIngest } from '../ingest/pushIngest.js';
import { registerPushRoutes } from '../routes/push.js';
import {
  APPEND_STREAM_PROJECTIONS,
  REPLACE_STREAM_PROJECTIONS,
  buildAck,
  parseNdjsonEntity,
  ALL_STREAMS,
  advertisedStreams,
  streamsForVersion,
} from '../ingest/pushRegistry.js';
import { getMemoryReplacementStore, createPushReplacementStaging } from '../ingest/pushReplacementStaging.js';
import { uuidFromParts } from '../storage/keys.js';

const USER = '7f2c9a10-4b3e-4d8a-9c11-00000000f001';
const SOURCE = '3a3486dd-5030-4e17-a00d-a781399890f9';
const DEVICE = 'strap-local-id';
const CLOUD_DEVICE = uuidFromParts([USER, 'noop', DEVICE]);
const BATCH = 'e835f32f-60e7-4c93-90a0-51eb6830119a';

const TS_MIN = 1723939201;
const TS_MAX = 1723939205;
const ARCHIVE_START = new Date(TS_MIN * 1000).toISOString();
const ARCHIVE_END = new Date(TS_MAX * 1000).toISOString();

function encodeBatch(header, recordLines) {
  const lines = [JSON.stringify(header), ...recordLines.map((row) => JSON.stringify(row))];
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

function sampleBatch() {
  const header = {
    type: 'batch',
    protocolVersion: '1.0',
    batchId: BATCH,
    sourceId: SOURCE,
    deviceId: DEVICE,
    stream: 'hrSample',
    delivery: 'append',
    recordCount: 2,
    startCursor: null,
    endCursor: { rowId: 19, keySha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
  };
  return encodeBatch(header, [
    { type: 'record', key: { ts: TS_MIN }, data: { bpm: 61 } },
    { type: 'record', key: { ts: TS_MAX }, data: { bpm: 62 } },
  ]);
}

function makeIngestHarness({ archiveReady = true, stagingNamespace = 'test' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-push-ingest-'));
  const archived = [];
  const upserts = [];
  const deletes = [];
  const tables = new Map();
  const ingest = createPushIngest({
    walFactory: (userId) => createPushWal({ dir, userId }),
    archiveObject: async (args) => {
      archived.push(args);
      return { ready: archiveReady, objectKey: args.key };
    },
    upsertRows: async (table, rows, opts) => {
      upserts.push({ table, rows, onConflict: opts?.onConflict });
      const bucket = tables.get(table) || [];
      for (const row of rows) {
        const idx = bucket.findIndex((existing) => rowKey(table, existing) === rowKey(table, row));
        if (idx >= 0) bucket[idx] = { ...bucket[idx], ...row };
        else bucket.push({ ...row });
      }
      tables.set(table, bucket);
    },
    deleteRows: async (table, filter) => {
      deletes.push({ table, filter });
      const bucket = tables.get(table) || [];
      const next = bucket.filter((row) => !shouldDelete(table, row, filter));
      tables.set(table, next);
    },
    replacementStaging: createPushReplacementStaging({
      store: getMemoryReplacementStore(stagingNamespace),
    }),
  });
  return { dir, archived, upserts, deletes, tables, ingest };
}

function rowKey(table, row) {
  if (table === 'daily_metrics') return `${row.user_id}|${row.day}`;
  if (table === 'noop_journal_entries') return `${row.user_id}|${row.device_id}|${row.day}|${row.question}`;
  if (table === 'sessions') return row.id;
  return JSON.stringify(row);
}

function shouldDelete(table, row, filter) {
  if (table === 'daily_metrics') {
    if (row.user_id !== filter.userId) return false;
    if (row.day < filter.dayGte || row.day >= filter.dayLt) return false;
    const key = String(row.day);
    return !filter.keepKeys.has(key);
  }
  if (table === 'noop_journal_entries') {
    if (row.user_id !== filter.userId || row.device_id !== filter.deviceId) return false;
    if (row.day < filter.dayGte || row.day >= filter.dayLt) return false;
    const key = `${row.day}|${row.question}`;
    return !filter.keepKeys.has(key);
  }
  if (table === 'sessions') {
    if (row.user_id !== filter.userId) return false;
    if (filter.kind && row.kind !== filter.kind && !(filter.kind === 'workout' && row.kind === 'manual_workout')) return false;
    const startTs = Math.floor(new Date(row.start_at).getTime() / 1000);
    if (startTs < filter.startTsGte || startTs >= filter.startTsLt) return false;
    const external = row.external_id || '';
    const key = external.startsWith('sleep:')
      ? external
      : `workout:${filter.stream === 'workout' ? external.split(':')[1] : ''}:${startTs}:${row.summary?.sport}`;
    return !filter.keepKeys.has(key) && !filter.keepKeys.has(external);
  }
  return false;
}

function replaceHeader({
  stream,
  batchId,
  replacementId,
  part = 1,
  parts = 1,
  recordCount = 0,
  window,
}) {
  return {
    type: 'batch',
    protocolVersion: '1.0',
    batchId,
    sourceId: SOURCE,
    deviceId: DEVICE,
    stream,
    delivery: 'replace_window',
    recordCount,
    startCursor: null,
    endCursor: null,
    window,
  };
}

const STREAM_FIXTURES = {
  hrSample: {
    records: [
      { type: 'record', key: { ts: TS_MIN }, data: { bpm: 61 } },
      { type: 'record', key: { ts: TS_MAX }, data: { bpm: 62 } },
    ],
    expectedRows: [
      { ts: TS_MIN, bpm: 61 },
      { ts: TS_MAX, bpm: 62 },
    ],
  },
  rrInterval: {
    records: [
      { type: 'record', key: { ts: TS_MIN, rrMs: 812, seq: 0 }, data: { ord: 1, srcChannel: 2 } },
      { type: 'record', key: { ts: TS_MAX, rrMs: 820, seq: 1 }, data: { tsSuspect: 0 } },
    ],
    expectedRows: [
      { ts: TS_MIN, rrMs: 812, seq: 0, ord: 1, srcChannel: 2 },
      { ts: TS_MAX, rrMs: 820, seq: 1, tsSuspect: 0 },
    ],
  },
  event: {
    records: [
      { type: 'record', key: { ts: TS_MIN, kind: 'alarm' }, data: { payloadJSON: '{"code":1}' } },
      { type: 'record', key: { ts: TS_MAX, kind: 'firmware' }, data: { payloadJSON: '{}' } },
    ],
    expectedRows: [
      { ts: TS_MIN, kind: 'alarm', payloadJSON: '{"code":1}' },
      { ts: TS_MAX, kind: 'firmware', payloadJSON: '{}' },
    ],
  },
  battery: {
    records: [
      { type: 'record', key: { ts: TS_MIN }, data: { soc: 0.74, mv: 3920, charging: false } },
      { type: 'record', key: { ts: TS_MAX }, data: { soc: 0.73 } },
    ],
    expectedRows: [
      { ts: TS_MIN, soc: 0.74, mv: 3920, charging: false },
      { ts: TS_MAX, soc: 0.73 },
    ],
  },
  spo2Sample: {
    records: [
      { type: 'record', key: { ts: TS_MIN }, data: { red: 1200, ir: 980 } },
      { type: 'record', key: { ts: TS_MAX }, data: { red: 1188, ir: 972 } },
    ],
    expectedRows: [
      { ts: TS_MIN, red: 1200, ir: 980 },
      { ts: TS_MAX, red: 1188, ir: 972 },
    ],
  },
  skinTempSample: {
    records: [
      { type: 'record', key: { ts: TS_MIN }, data: { raw: 3012, aux1Raw: 11, aux2Raw: 12 } },
      { type: 'record', key: { ts: TS_MAX }, data: { raw: 3010 } },
    ],
    expectedRows: [
      { ts: TS_MIN, raw: 3012, aux1Raw: 11, aux2Raw: 12 },
      { ts: TS_MAX, raw: 3010 },
    ],
  },
  respSample: {
    records: [
      { type: 'record', key: { ts: TS_MIN }, data: { raw: 440 } },
      { type: 'record', key: { ts: TS_MAX }, data: { raw: 438 } },
    ],
    expectedRows: [
      { ts: TS_MIN, raw: 440 },
      { ts: TS_MAX, raw: 438 },
    ],
  },
  gravitySample: {
    records: [
      { type: 'record', key: { ts: TS_MIN }, data: { x: 0.01, y: -0.98, z: 0.12, dynAccel: 0.04 } },
      { type: 'record', key: { ts: TS_MAX }, data: { x: 0.02, y: -0.97, z: 0.11 } },
    ],
    expectedRows: [
      { ts: TS_MIN, x: 0.01, y: -0.98, z: 0.12, dynAccel: 0.04 },
      { ts: TS_MAX, x: 0.02, y: -0.97, z: 0.11 },
    ],
  },
};

for (const [stream, fixture] of Object.entries(STREAM_FIXTURES)) {
  test(`acceptBatch projects ${stream} rows and archive window from record ts`, async () => {
    const projection = APPEND_STREAM_PROJECTIONS[stream];
    const { archived, upserts, ingest } = makeIngestHarness();
    const batchId = `00000000-0000-4000-8000-${stream.padEnd(12, '0').slice(0, 12)}`;
    const body = encodeBatch({
      type: 'batch',
      protocolVersion: '1.0',
      batchId,
      sourceId: SOURCE,
      deviceId: DEVICE,
      stream,
      delivery: 'append',
      recordCount: fixture.records.length,
      startCursor: null,
      endCursor: null,
    }, fixture.records);

    const ack = await ingest.acceptBatch({ userId: USER, decodedBody: body });
    assert.equal(ack.status, 'accepted');
    assert.equal(ack.stream, stream);
    assert.equal(archived.length, 1);
    assert.equal(archived[0].startAt, ARCHIVE_START);
    assert.equal(archived[0].endAt, ARCHIVE_END);
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].table, projection.table);
    assert.equal(upserts[0].onConflict, projection.onConflict);
    assert.equal(upserts[0].rows.length, fixture.expectedRows.length);
    for (let i = 0; i < fixture.expectedRows.length; i += 1) {
      const row = upserts[0].rows[i];
      assert.equal(row.user_id, USER);
      assert.equal(row.source_id, SOURCE);
      assert.equal(row.batch_id, batchId);
      for (const [key, value] of Object.entries(fixture.expectedRows[i])) {
        assert.deepEqual(row[key], value);
      }
    }
  });
}

function makeHarness({ archiveReady = true, ingestEnabledStreams } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-push-'));
  const archived = [];
  const upserts = [];
  const pushIngest = createPushIngest({
    walFactory: (userId) => createPushWal({ dir, userId }),
    archiveObject: async (args) => {
      archived.push(args);
      return { ready: archiveReady, objectKey: args.key };
    },
    upsertRows: async (table, rows, opts) => {
      upserts.push({ table, rows, onConflict: opts?.onConflict });
    },
  });
  const app = express();
  registerPushRoutes(app, {
    pushIngest,
    resolvePushUser: async () => ({ id: USER, source: 'test' }),
    ingestEnabledStreams,
  });
  return { app, dir, archived, upserts, pushIngest };
}

test('parseNdjsonEntity validates record count', () => {
  const body = sampleBatch();
  const parsed = parseNdjsonEntity(body);
  assert.equal(parsed.records.length, 2);
  const ack = buildAck(parsed.header);
  assert.equal(ack.acceptedRows, 2);
});

test('POST /api/push acks hrSample after WAL + archive + upsert', async () => {
  const { app, archived, upserts } = makeHarness();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  try {
    const body = gzipSync(sampleBatch());
    const res = await fetch(`http://127.0.0.1:${port}/api/push`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-encoding': 'gzip',
        accept: 'application/json',
      },
      body,
    });
    assert.equal(res.status, 200);
    const ack = await res.json();
    assert.equal(ack.status, 'accepted');
    assert.equal(ack.batchId, BATCH);
    assert.equal(ack.stream, 'hrSample');
    assert.equal(ack.acceptedRows, 2);
    assert.equal(archived.length, 1);
    assert.equal(archived[0].stream, 'hrSample');
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].table, 'noop_hr_samples');
    assert.equal(upserts[0].rows.length, 2);
    assert.equal(archived[0].startAt, ARCHIVE_START);
    assert.equal(archived[0].endAt, ARCHIVE_END);

    const replay = await fetch(`http://127.0.0.1:${port}/api/push`, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-encoding': 'gzip' },
      body,
    });
    assert.equal(replay.status, 200);
    const replayAck = await replay.json();
    assert.deepEqual(replayAck, ack);
    assert.equal(archived.length, 1);
  } finally {
    server.close();
  }
});

test('POST /api/push does not ack when archive is not ready', async () => {
  const { app, dir } = makeHarness({ archiveReady: false });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/push`, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-encoding': 'gzip' },
      body: gzipSync(sampleBatch()),
    });
    assert.equal(res.status, 503);
    const wal = createPushWal({ dir, userId: USER });
    const { lines } = wal.recoverWal();
    assert.equal(lines.length, 1);
    assert.equal(wal.getAck(BATCH), null);
  } finally {
    server.close();
  }
});

test('GET /api/push returns capabilities for negotiated version', async () => {
  const { app } = makeHarness();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/push`, {
      headers: {
        authorization: 'Bearer test',
        accept: 'application/json',
        'noop-push-accept-version': '1.1,1.0',
      },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, 'capabilities');
    assert.equal(body.protocolVersion, '1.1');
    assert.ok(body.streams.includes('hrSample'));
  } finally {
    server.close();
  }
});

test('streamsForVersion 1.0 excludes 1.1-only names', () => {
  const v10 = streamsForVersion('1.0');
  const v11Only = [...ALL_STREAMS].filter((s) => !v10.has(s));
  assert.equal(v10.size, 12);
  assert.equal(v11Only.length, ALL_STREAMS.size - 12);
  assert.ok(v10.has('hrSample'));
  assert.ok(!v10.has('stepSample'));
  assert.ok(!v10.has('ppgWaveformSample'));
});

test('GET /api/push with 1.0 never advertises 1.1-only streams even when all are enabled', async () => {
  const { app } = makeHarness({ ingestEnabledStreams: ALL_STREAMS });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/push`, {
      headers: {
        authorization: 'Bearer test',
        accept: 'application/json',
        'noop-push-accept-version': '1.0',
      },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.protocolVersion, '1.0');
    const allowed = streamsForVersion('1.0');
    for (const stream of body.streams) {
      assert.ok(allowed.has(stream), `1.0 client received 1.1-only stream: ${stream}`);
    }
    assert.deepEqual(body.streams, advertisedStreams('1.0', ALL_STREAMS));
  } finally {
    server.close();
  }
});

/**
 * "Enabled" and "advertised at this version" are no longer the same set. `ppgWaveformSample` is
 * enabled here but reaches the receiver through the 1.2 object lane, so a 1.1 sender must not see
 * it: it has no way to deliver an object and would only loop on a refusal.
 */
test('GET /api/push with 1.1 advertises every enabled stream the version can deliver', async () => {
  const enabled = new Set(['hrSample', 'stepSample', 'ppgWaveformSample', 'metricSeries']);
  const { app } = makeHarness({ ingestEnabledStreams: enabled });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/push`, {
      headers: {
        authorization: 'Bearer test',
        accept: 'application/json',
        'noop-push-accept-version': '1.1',
      },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.protocolVersion, '1.1');
    assert.deepEqual(body.streams, advertisedStreams('1.1', enabled));
    assert.deepEqual(body.streams, ['hrSample', 'metricSeries', 'stepSample']);
    assert.equal(body.objectLane, undefined, '1.1 has no object lane to describe');
  } finally {
    server.close();
  }
});

test('replace_window journal applies on completing part and deletes absent rows', async () => {
  const replacementId = '6ae704e9-2595-5a03-85d5-36189a11b05c';
  const batchId = '1969b8fa-7930-5907-9d0c-2c14ef2d8608';
  const window = {
    replacementId,
    selector: 'day',
    startInclusive: '2026-08-17',
    endExclusive: '2026-08-18',
    part: 1,
    parts: 1,
  };
  const { ingest, upserts, deletes, tables } = makeIngestHarness({ stagingNamespace: 'journal-replace' });

  tables.set('noop_journal_entries', [{
    user_id: USER,
    device_id: CLOUD_DEVICE,
    day: '2026-08-17',
    question: 'coffee',
    answered_yes: true,
    notes: 'stale',
  }]);

  const body = encodeBatch(
    replaceHeader({
      stream: 'journal',
      batchId,
      replacementId,
      recordCount: 1,
      window,
    }),
    [{
      type: 'record',
      key: { day: '2026-08-17', question: 'exercise' },
      data: { answeredYes: true, notes: 'fresh', numericValue: null },
    }],
  );

  const ack = await ingest.acceptBatch({ userId: USER, decodedBody: body });
  assert.equal(ack.status, 'accepted');
  assert.equal(ack.endCursor, null);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].table, 'noop_journal_entries');
  assert.equal(upserts[0].rows[0].question, 'exercise');
  assert.equal(deletes.length, 1);
  const remaining = tables.get('noop_journal_entries') || [];
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].question, 'exercise');
});

test('replace_window multipart does not apply until every part is present', async () => {
  const replacementId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const { ingest, upserts, deletes } = makeIngestHarness({ stagingNamespace: 'multipart' });
  const windowBase = {
    replacementId,
    selector: 'day',
    startInclusive: '2026-08-17',
    endExclusive: '2026-08-18',
    parts: 2,
  };

  const part1 = encodeBatch(
    replaceHeader({
      stream: 'journal',
      batchId: '11111111-1111-4111-8111-111111111111',
      replacementId,
      part: 1,
      parts: 2,
      recordCount: 1,
      window: { ...windowBase, part: 1 },
    }),
    [{
      type: 'record',
      key: { day: '2026-08-17', question: 'coffee' },
      data: { answeredYes: true, notes: null, numericValue: null },
    }],
  );

  const ack1 = await ingest.acceptBatch({ userId: USER, decodedBody: part1 });
  assert.equal(ack1.status, 'accepted');
  assert.equal(upserts.length, 0);
  assert.equal(deletes.length, 0);

  const part2 = encodeBatch(
    replaceHeader({
      stream: 'journal',
      batchId: '22222222-2222-4222-8222-222222222222',
      replacementId,
      part: 2,
      parts: 2,
      recordCount: 1,
      window: { ...windowBase, part: 2 },
    }),
    [{
      type: 'record',
      key: { day: '2026-08-17', question: 'exercise' },
      data: { answeredYes: false, notes: null, numericValue: null },
    }],
  );

  const ack2 = await ingest.acceptBatch({ userId: USER, decodedBody: part2 });
  assert.equal(ack2.status, 'accepted');
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].rows.length, 2);
  assert.equal(deletes.length, 1);
});

test('replace_window dailyMetric projects into daily_metrics', async () => {
  const replacementId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  const batchId = 'cccccccc-dddd-eeee-ffff-000000000001';
  const { ingest, upserts } = makeIngestHarness({ stagingNamespace: 'daily-metric' });
  const body = encodeBatch(
    replaceHeader({
      stream: 'dailyMetric',
      batchId,
      replacementId,
      recordCount: 1,
      window: {
        replacementId,
        selector: 'day',
        startInclusive: '2026-08-18',
        endExclusive: '2026-08-19',
        part: 1,
        parts: 1,
      },
    }),
    [{
      type: 'record',
      key: { day: '2026-08-18' },
      data: {
        totalSleepMin: 420,
        efficiency: 91,
        deepMin: 90,
        remMin: 110,
        lightMin: 220,
        disturbances: 2,
        restingHr: 52,
        avgHrv: 55,
        recovery: 72,
        strain: 12.4,
        exerciseCount: 1,
        spo2Pct: null,
        skinTempDevC: null,
        respRateBpm: 14.2,
        steps: 8400,
        activeKcalEst: 420,
        spo2Red: null,
        spo2Ir: null,
      },
    }],
  );

  const ack = await ingest.acceptBatch({ userId: USER, decodedBody: body });
  assert.equal(ack.status, 'accepted');
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].table, REPLACE_STREAM_PROJECTIONS.dailyMetric.table);
  assert.equal(upserts[0].rows[0].day, '2026-08-18');
  assert.equal(upserts[0].rows[0].charge, 72);
  assert.equal(upserts[0].rows[0].sleep_total_min, 420);
});

/**
 * An object-lane stream reaching the inline endpoint must be refused by NAME, because the code is
 * what the sender acts on. Falling through to the delivery switch would return
 * `unsupported_delivery` and send whoever reads it hunting for a malformed header, when the header
 * is fine and the only problem is the door it knocked on.
 */
test('acceptBatch redirects an object-lane stream instead of blaming its header', async () => {
  const { ingest, archived, upserts } = makeIngestHarness();
  const body = encodeBatch(
    {
      type: 'batch',
      protocolVersion: '1.2',
      batchId: BATCH,
      sourceId: SOURCE,
      deviceId: DEVICE,
      stream: 'ppgWaveformSample',
      delivery: 'binary_object',
      recordCount: 1,
      startCursor: null,
      endCursor: { rowId: 5, keySha256: 'c'.repeat(64) },
    },
    [{ type: 'record', key: { ts: TS_MIN }, data: { burstIndex: 1 } }],
  );

  await assert.rejects(
    () => ingest.acceptBatch({ userId: USER, decodedBody: body }),
    (err) => err.code === 'use_object_lane' && err.status === 422,
  );
  assert.deepEqual(archived, [], 'a redirected batch must not be archived by the inline lane');
  assert.deepEqual(upserts, [], 'a redirected batch must not project rows');
});

test('object-lane streams stay out of the inline projection maps', () => {
  for (const stream of ['ppgWaveformSample', 'rawImuSession', 'rawBatch', 'v18AuxSample']) {
    assert.ok(!APPEND_STREAM_PROJECTIONS[stream], `${stream} must not project per-sample rows`);
    assert.ok(!REPLACE_STREAM_PROJECTIONS[stream], `${stream} must not project replace-window rows`);
  }
});
