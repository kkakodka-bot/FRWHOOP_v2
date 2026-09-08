import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createHourBuffer } from '../ingest/hourBuffer.js';
import { normalizeHostStore, registerHostRoutes } from '../host/routes.js';

const USER = '7c1e0000-0000-4000-8000-00000000f001';

// P1 ack-correctness: the live route must ack only a contiguous accepted
// prefix. A mid-batch persist failure (seq 2 throws, seq 3 succeeds) must NOT
// advance acked_through past seq 1, or the phone deletes a row we never stored.
test('/api/ble/live acks a contiguous accepted prefix only', async () => {
  let store = normalizeHostStore({ prefs: {} });
  const app = express();
  app.use(express.json());
  registerHostRoutes(app, {
    loadStore: () => store,
    saveStore: (next) => { store = next; },
    resolveUser: async (req) => {
      if (req.headers.authorization === 'Bearer token-a') return { id: USER, source: 'jwt' };
      const err = new Error('authentication required');
      err.status = 401;
      throw err;
    },
    onLiveSampleForUser: (userId, sample) => {
      if (Number(sample?.seq) === 2) throw new Error('simulated_persist_failure');
    },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ble/live`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-a' },
      body: JSON.stringify({
        connected: true,
        deviceId: 'strap1',
        samples: [
          { seq: 1, bpm: 60, datetime: new Date().toISOString() },
          { seq: 2, bpm: 61, datetime: new Date().toISOString() },
          { seq: 3, bpm: 62, datetime: new Date().toISOString() },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    // acked_through must stop at the contiguous accepted prefix (seq 1),
    // even though seq 3 was persisted. The phone will re-send 2 and 3.
    assert.equal(body.acked_through, 1);

  } finally { server.close(); }
});

// P1 ack-correctness: a WAL write failure must surface as a non-accepted
// sample (no ack), not a swallowed "cache only" success. This faults the
// actual appendWal open (WAL path is a directory) rather than the mkdir
// precondition, so it exercises the durability gate itself.
test('hourBuffer.append throws when the WAL write fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-walfail-'));
  const dir = path.join(root, 'live');
  const buffer = createHourBuffer({ dir, userId: USER, engine: {} });
  fs.mkdirSync(path.join(dir, USER, 'pending-wal.ndjson'), { recursive: true }); // WAL path is now a directory
  assert.throws(
    () => buffer.append({ datetime: new Date().toISOString(), bpm: 60, rr_ms: [], seq: 1, deviceId: 'strap1' }),
    (err) => err && (err.code === 'EISDIR' || err.code === 'ENOTDIR' || err.code === 'EEXIST')
  );
});

// P2 durability: live dedupe must survive a backend restart via the durable
// per-device watermark, and re-sends of flushed rows must be rejected.
test('live seq dedupe survives a backend restart (durable watermark)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-wm-'));
  const flushed = [];
  const engine = {
    async archiveRawSamples(args) {
      flushed.push(args.samples.map((s) => s.seq));
      return { id: 'o1', status: 'ready' };
    },
  };
  const mk = () => createHourBuffer({ dir, userId: USER, chunkMs: 3600_000, maxSamples: 1000, engine });
  const first = mk();
  const base = Date.now() - 12_000;
  const iso = (i) => new Date(base + i * 4_000).toISOString();
  const rows = [
    { datetime: iso(0), bpm: 60, rr_ms: [], src: 'ble_hr', seq: 1, deviceId: 'strap1' },
    { datetime: iso(1), bpm: 61, rr_ms: [], src: 'ble_hr', seq: 2, deviceId: 'strap1' },
    { datetime: iso(2), bpm: 62, rr_ms: [], src: 'ble_hr', seq: 3, deviceId: 'strap1' },
  ];
  for (const row of rows) first.append(row);
  await first.flush();
  assert.deepEqual(flushed.flat().sort((a, b) => a - b), [1, 2, 3]);

  // New buffer = simulated backend restart: in-memory recentSeq is empty but
  // the fsynced watermark must still reject the re-sent rows.
  const second = mk();
  const r1 = second.append(rows[0]);
  const r2 = second.append(rows[1]);
  const r3 = second.append(rows[2]);
  assert.ok(r1, 'row object still returned');
  assert.equal(r1.seq, 1);
  assert.equal(second.pendingCount(), 0, 're-sent flushed rows must not be re-queued');
  await second.flush();
  assert.equal(flushed.length, 1, 'no second archive of deduped rows');

  // New higher seq still passes the watermark and is queued.
  const later = second.append({ datetime: iso(3), bpm: 63, rr_ms: [], seq: 4, deviceId: 'strap1' });
  assert.equal(later.seq, 4);
  assert.equal(second.pendingCount(), 1);
});

// Reinstall guard: a phone whose seq counter restarted (UserDefaults wiped)
// sends LOW seqs with FRESH timestamps. These are new rows, not re-sends, and
// the durable watermark must not drop them.
test('watermark does not drop rows from a restarted phone seq counter', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-reinstall-'));
  let flushed = 0;
  const engine = { archiveRawSamples: async () => { flushed += 1; return { id: 'o', status: 'ready' }; } };
  const base = Date.now() - 30_000;
  const first = createHourBuffer({ dir, userId: USER, chunkMs: 3_600_000, maxSamples: 1000, engine });
  first.append({ datetime: new Date(base).toISOString(), bpm: 60, rr_ms: [], seq: 1, deviceId: 'strap1' });
  first.append({ datetime: new Date(base + 4_000).toISOString(), bpm: 61, rr_ms: [], seq: 2, deviceId: 'strap1' });
  await first.flush();
  assert.equal(first.pendingCount(), 0);

  // Phone reinstalled: seqs restart at 1 but timestamps are NEW.
  const second = createHourBuffer({ dir, userId: USER, chunkMs: 3_600_000, maxSamples: 1000, engine });
  second.append({ datetime: new Date().toISOString(), bpm: 70, rr_ms: [], seq: 1, deviceId: 'strap1' });
  assert.equal(second.pendingCount(), 1, 'fresh-timestamp low-seq row must be accepted');
});
