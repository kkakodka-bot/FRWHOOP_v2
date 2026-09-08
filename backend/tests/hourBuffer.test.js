import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHourBuffer } from '../ingest/hourBuffer.js';

test('hour rollover flushes the previous hour once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-hr-'));
  let now = Date.parse('2026-08-24T17:59:50.000Z');
  const archived = [];
  const buf = createHourBuffer({
    dir,
    userId: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
    chunkMs: 3600_000,
    now: () => new Date(now),
    engine: {
      archiveRawSamples: async (args) => {
        archived.push(args);
        return { id: 'obj', status: 'ready' };
      },
      persistComputed: async () => ({ scored: { day: '2026-08-24' } }),
    },
  });
  buf.append({ datetime: '2026-08-24T17:59:50.000Z', bpm: 60 });
  now = Date.parse('2026-08-24T18:00:01.000Z');
  buf.append({ datetime: '2026-08-24T18:00:01.000Z', bpm: 70 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(archived.length, 1);
  assert.equal(archived[0].samples.length, 1);
  assert.equal(archived[0].samples[0].bpm, 60);
  await buf.flush();
  assert.equal(archived.length, 2);
  assert.equal(archived[0].extras.userId, '7f2c9a10-4b3e-4d8a-9c11-00000000f001');
});

test('duplicate samples in one hour stay one pending object until flush', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-hr-'));
  const buf = createHourBuffer({
    dir,
    userId: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
    chunkMs: 3600_000,
    now: () => new Date('2026-08-24T18:00:05.000Z'),
    engine: { archiveRawSamples: async () => ({ status: 'ready' }), persistComputed: async () => null },
  });
  buf.append({ datetime: '2026-08-24T18:00:00.000Z', bpm: 60 });
  buf.append({ datetime: '2026-08-24T18:00:04.000Z', bpm: 60 });
  assert.equal(buf.pendingCount(), 2);
});

test('iOS live rows stamped with t keep receive time, not upload now()', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-hr-t-'));
  const archived = [];
  const buf = createHourBuffer({
    dir,
    userId: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
    chunkMs: 3600_000,
    now: () => new Date('2026-08-25T16:00:00.000Z'),
    engine: {
      archiveRawSamples: async (args) => {
        archived.push(args);
        return { status: 'ready' };
      },
      persistComputed: async () => null,
    },
  });
  buf.append({ t: '2026-08-25T07:05:00.000Z', bpm: 58, seq: 1 });
  await buf.flush();
  assert.equal(archived[0].samples[0].datetime, '2026-08-25T07:05:00.000Z');
});

test('seq retries do not duplicate the pending hour', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-hr-'));
  const buf = createHourBuffer({
    dir,
    userId: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
    chunkMs: 3600_000,
    now: () => new Date('2026-08-24T18:00:05.000Z'),
    engine: { archiveRawSamples: async () => ({ status: 'ready' }), persistComputed: async () => null },
  });
  buf.append({ datetime: '2026-08-24T18:00:00.000Z', bpm: 60, seq: 9 });
  buf.append({ datetime: '2026-08-24T18:00:00.000Z', bpm: 60, seq: 9 });
  assert.equal(buf.pendingCount(), 1);
});

test('metrics compute in the user evening even when the UTC hour is overnight', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-tz-'));
  // 04:33Z is 21:33 in America/Los_Angeles: waking hours for the user, but
  // inside the 02:00-05:59 skip window if the gate reads the UTC hour.
  const now = Date.parse('2026-08-25T04:33:00.000Z');
  const computed = [];
  const buf = createHourBuffer({
    dir,
    userId: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
    chunkMs: 3600_000,
    timeZone: 'America/Los_Angeles',
    now: () => new Date(now),
    engine: {
      archiveRawSamples: async () => ({ id: 'obj', status: 'ready' }),
      persistComputed: async (args) => {
        computed.push(args);
        return { scored: { day: '2026-08-24' } };
      },
    },
  });
  for (let i = 0; i < 25; i += 1) {
    buf.append({ datetime: new Date(now - (25 - i) * 4000).toISOString(), bpm: 60 + i, seq: i });
  }
  await buf.flush();
  assert.equal(computed.length, 1);
  assert.equal(computed[0].extras.timeZone, 'America/Los_Angeles');
});

test('metrics compute during the user overnight window', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-tz2-'));
  // 11:00Z is 04:00 in America/Los_Angeles. Scoring used to skip 02:00–05:59.
  const now = Date.parse('2026-08-25T11:00:00.000Z');
  const computed = [];
  const archivedDays = [];
  const buf = createHourBuffer({
    dir,
    userId: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
    chunkMs: 3600_000,
    timeZone: 'America/Los_Angeles',
    now: () => new Date(now),
    onSamplesArchived: ({ affectedDays }) => { archivedDays.push(...affectedDays); },
    engine: {
      archiveRawSamples: async () => ({ id: 'obj', status: 'ready' }),
      persistComputed: async (args) => {
        computed.push(args);
        return null;
      },
    },
  });
  for (let i = 0; i < 25; i += 1) {
    buf.append({ datetime: new Date(now - (25 - i) * 4000).toISOString(), bpm: 60 + i, seq: i });
  }
  await buf.flush();
  assert.equal(computed.length, 1);
  assert.ok(archivedDays.length >= 1);
});

test('a strap that goes quiet mid-hour still flushes without a new sample', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-quiet-'));
  let now = Date.parse('2026-08-24T18:00:00.000Z');
  const archived = [];
  const buf = createHourBuffer({
    dir,
    userId: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
    chunkMs: 3600_000,
    now: () => new Date(now),
    engine: {
      archiveRawSamples: async (args) => {
        archived.push(args);
        return { id: 'obj', status: 'ready' };
      },
      persistComputed: async () => null,
    },
  });
  buf.append({ datetime: '2026-08-24T18:00:00.000Z', bpm: 60, seq: 1 });
  assert.equal(archived.length, 0);

  // Not due yet: an early tick must not shred the hour into small objects.
  now += 10 * 60_000;
  await buf.flushIfDue();
  assert.equal(archived.length, 0);
  assert.equal(buf.pendingCount(), 1);

  // The strap never comes back, so only the tick can release the hour.
  now += 55 * 60_000;
  await buf.flushIfDue();
  assert.equal(archived.length, 1);
  assert.equal(archived[0].samples.length, 1);
  assert.equal(buf.pendingCount(), 0);
});

test('opaque frames flush independently of physiology samples', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-fr-'));
  let now = Date.parse('2026-08-24T17:59:50.000Z');
  const samples = [];
  const frames = [];
  const buf = createHourBuffer({
    dir,
    userId: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
    chunkMs: 3600_000,
    now: () => new Date(now),
    engine: {
      archiveRawSamples: async (args) => {
        samples.push(args);
        return { id: 'phys', status: 'ready' };
      },
      archiveRawFrames: async (args) => {
        frames.push(args);
        return { id: 'frames', status: 'ready', object_key: 'v3/core/x/frames' };
      },
      persistComputed: async () => null,
    },
  });
  buf.append({ datetime: '2026-08-24T17:59:50.000Z', bpm: 60 });
  buf.appendFrame({
    hex: 'aa01ff',
    t: '2026-08-24T17:59:51.000Z',
    seq: 1,
    family: 'puffin',
    char: 'FD4B0003',
  });
  now = Date.parse('2026-08-24T18:00:01.000Z');
  buf.appendFrame({
    hex: 'aabbcc',
    t: '2026-08-24T18:00:01.000Z',
    seq: 2,
    family: 'puffin',
    char: 'FD4B0003',
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].frames.length, 1);
  assert.equal(frames[0].frames[0].hex, 'aa01ff');
  assert.equal(samples.length, 0);
  assert.equal(buf.pendingCount(), 1);
  await buf.flush();
  assert.equal(samples.length, 1);
  assert.equal(frames.length, 2);
});


test('WAL keeps the batch until B2 confirms: restart mid-flush recovers without loss', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-crash-'));
  let now = Date.parse('2026-08-24T18:00:00.000Z');
  let engine = {
    archiveRawSamples: async () => { throw new Error('b2 down'); },
    persistComputed: async () => null,
  };
  let buf = createHourBuffer({
    dir,
    userId: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
    chunkMs: 3600_000,
    now: () => new Date(now),
    engine,
  });
  // Force a due flush whose archive fails, like a backend that dies mid-upload.
  for (let i = 0; i < 25; i += 1) {
    buf.append({ datetime: new Date(now - (25 - i) * 4000).toISOString(), bpm: 60 + i, seq: i });
  }
  await assert.rejects(() => buf.flush());
  // The WAL must still hold the batch (it must NOT have been trimmed pre-archive).
  const wal = fs.readFileSync(path.join(dir, '7f2c9a10-4b3e-4d8a-9c11-00000000f001', 'pending-wal.ndjson'), 'utf8');
  assert.ok(wal.split('\n').filter(Boolean).length >= 25, 'WAL must retain the unarchived batch');

  // Simulate a backend restart: a fresh buffer over the same dir recovers them.
  const archived = [];
  engine = {
    archiveRawSamples: async (args) => {
      archived.push(...args.samples);
      return { id: 'obj', status: 'ready' };
    },
    persistComputed: async () => null,
  };
  buf = createHourBuffer({
    dir,
    userId: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
    chunkMs: 3600_000,
    now: () => new Date(now),
    engine,
  });
  assert.equal(buf.pendingCount(), 25);
  await buf.flush();
  assert.equal(archived.length, 25);
  assert.equal(buf.pendingCount(), 0);
});

test('WAL trims only after live replay settles', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-replay-wal-'));
  const userId = '7f2c9a10-4b3e-4d8a-9c11-00000000f001';
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let walDuringReplay = '';
  const buf = createHourBuffer({
    dir,
    userId,
    chunkMs: 3600_000,
    now: () => new Date('2026-08-24T18:00:05.000Z'),
    onSamplesArchived: async () => {
      const wal = path.join(dir, userId.replace(/[^a-zA-Z0-9_-]/g, ''), 'pending-wal.ndjson');
      walDuringReplay = fs.existsSync(wal) ? fs.readFileSync(wal, 'utf8') : '';
      await gate;
    },
    engine: {
      archiveRawSamples: async () => ({ id: 'obj', status: 'ready' }),
      persistComputed: async () => null,
    },
  });
  buf.append({ datetime: '2026-08-24T18:00:00.000Z', bpm: 60, seq: 1 });
  const flushP = buf.flush();
  await new Promise((r) => setTimeout(r, 30));
  assert.match(walDuringReplay, /"bpm":60/, 'WAL must still hold the batch until replay finishes');
  release();
  await flushP;
  const wal = path.join(dir, userId.replace(/[^a-zA-Z0-9_-]/g, ''), 'pending-wal.ndjson');
  const after = fs.existsSync(wal) ? fs.readFileSync(wal, 'utf8') : '';
  assert.equal(after.trim(), '');
});
