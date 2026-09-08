import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { registerHostRoutes, normalizeHostStore } from '../host/routes.js';
import { createUserRuntimes } from '../identity/userRuntime.js';
import { resetMetrics, liveIngestView } from '../observability/metrics.js';
import { puffinRT, notifyOf } from './fixtures/whoopFrames.mjs';
import { createReassembler } from '../protocol/framing.js';
import { decodeFrame } from '../protocol/decoder.js';

const A = '11111111-1111-4111-8111-111111111111';

async function liveServer() {
  resetMetrics();
  const runtimes = createUserRuntimes({
    engine: {
      archiveRawSamples: async () => ({ id: 'obj', status: 'ready' }),
      persistComputed: async () => ({ scored: { day: '2026-08-26' } }),
    },
    liveDir: fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-t40-')),
    cfg: { hrChunkMs: 3600_000 },
    loadStore: () => ({ activities: [], prefs: {}, bleLive: null }),
    saveStore: () => {},
    loadPersistedDays: async () => ({}),
  });
  let store = normalizeHostStore({ prefs: {} });
  const ingested = [];
  const det = runtimes.detectorOf(A);
  const inner = det.ingest.bind(det);
  det.ingest = (sample) => {
    ingested.push(sample);
    return inner(sample);
  };
  const app = express();
  app.use(express.json());
  registerHostRoutes(app, {
    loadStore: () => store,
    saveStore: (next) => { store = next; },
    resolveUser: async (req) => {
      if (req.headers.authorization === 'Bearer token-a') return { id: A, source: 'jwt' };
      const err = new Error('authentication required');
      err.status = 401;
      throw err;
    },
    onLiveSampleForUser: (userId, sample) => runtimes.append(userId, sample),
    onLiveFramesForUser: (userId, frame) => runtimes.appendFrames(userId, frame),
    onLiveStatusForUser: (userId, live) => runtimes.setLive(userId, live),
    loadLiveForUser: (userId) => runtimes.liveOf(userId),
    detectionStateForUser: (userId, opts) => runtimes.detectorOf(userId)?.state(opts),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const json = async (urlPath, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-a' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { server, json, ingested, runtimes };
}

test('durable queue row reaches /api/ble/live and detector.ingest', async () => {
  const { server, json, ingested, runtimes } = await liveServer();
  try {
    const t = new Date().toISOString();
    const ack = await json('/api/ble/live', {
      connected: true,
      heartRate: 88,
      samples: [{ seq: 7, datetime: t, bpm: 88, src: 'whoop_rt' }],
    });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.acked_through, 7);
    assert.equal(ack.body.persisted, 1);
    assert.equal(ack.body.live_ingest.counters.live_sample_backend_accepted, 1);
    assert.equal(ack.body.live_ingest.counters.detector_sample_ingested, 1);
    assert.equal(ingested.length, 1);
    assert.equal(ingested[0].bpm, 88);
    assert.equal(runtimes.bufferOf(A).pendingCount(), 1);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test('duplicate seq does not create a second detector sample', async () => {
  const { server, json, ingested } = await liveServer();
  try {
    const t = new Date().toISOString();
    const row = { seq: 3, datetime: t, bpm: 90, src: 'whoop_rt', deviceId: 'strap' };
    await json('/api/ble/live', { connected: true, heartRate: 90, samples: [row] });
    const again = await json('/api/ble/live', {
      connected: true,
      heartRate: 90,
      samples: [{ ...row, src: 'gatt_hr' }],
    });
    assert.equal(ingested.length, 1);
    assert.equal(again.body.live_ingest.counters.detector_sample_rejected, 1);
    assert.equal(again.body.live_ingest.last_reject.reason, 'duplicate_seq');
    assert.equal(liveIngestView().counters.detector_sample_ingested, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test('valid puffin type-40 notify is a complete envelope the live reassembler emits', () => {
  const t40 = puffinRT(1, 1_782_000_000, 0, 77, 0);
  const rec = decodeFrame(t40, 'puffin');
  assert.equal(rec.packet_type, 40);
  assert.equal(rec.decoded.hr, 77);
  const r = createReassembler({ family: 'puffin' });
  const out = r.feed(t40);
  assert.equal(out.frames.length, 1);
  assert.equal(out.frames[0][16], 77);
  const row = notifyOf(t40, { family: 'puffin', t: '2026-08-26T05:02:00.000Z' });
  assert.equal(row.hex.length / 2, t40.length);
});
