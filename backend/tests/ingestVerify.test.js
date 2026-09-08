import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { encodeArchive } from '../ingest/archiveFormat.js';
import { createUserRuntimes } from '../identity/userRuntime.js';
import { registerHostRoutes } from '../host/routes.js';
import { loadIngestVerifyReport } from '../metrics/ingestVerify.js';
import { PRODUCT_DAY_STATUS } from '../metrics/continuityAccounting.js';
import { DAY_STATUS } from '../metrics/dayCompleteness.js';
import { dayBounds } from '../time/dayBoundary.js';

const USER = '44444444-4444-4444-8444-444444444444';
const TZ = 'America/Los_Angeles';
const DAY = '2026-08-24';

function makeObjectStore() {
  const blobs = new Map();
  return {
    blobs,
    async putObject(key, body) { blobs.set(key, body); return { etag: '"x"', bytes: body.length }; },
    async head(key) { const b = blobs.get(key); return b ? { exists: true, contentLength: b.length } : null; },
    async getObject(key) { const b = blobs.get(key); return b ? { body: b } : null; },
  };
}

function fullDaySamples(cadenceMs = 60000) {
  const b = dayBounds(DAY, TZ);
  const out = [];
  for (let t = Date.parse(b.day_start_at); t < Date.parse(b.day_end_at); t += cadenceMs) {
    out.push({ datetime: new Date(t).toISOString(), bpm: 55, rr_ms: [], connected: true, src: 'ble_hr' });
  }
  return out;
}

function makeDb(samples, packed) {
  const b = dayBounds(DAY, TZ);
  const manifest = {
    id: 'phys-1',
    user_id: USER,
    object_kind: 'physiology',
    object_key: 'phys-1',
    status: 'verified',
    sha256: packed.sha256,
    start_at: b.day_start_at,
    end_at: b.day_end_at,
    period_day: DAY,
  };
  return {
    configured: false,
    async listPhysiologyManifests() { return [manifest]; },
    async listObjectManifests({ objectKind } = {}) {
      return objectKind === 'physiology' ? [manifest] : [];
    },
    async listIngestGaps() { return []; },
    async loadUserDays() {
      return {
        daily_metrics: [{
          day: DAY,
          computed_at: '2026-08-25T18:00:00.000Z',
          extras: { latest_sensor_at: samples.at(-1)?.datetime },
        }],
        daily_physiology_series: [],
      };
    },
  };
}

test('GET /api/ingest/verify: finished dense type-40 day with empty frontiers is not product complete', async () => {
  const samples = fullDaySamples();
  const packed = encodeArchive(samples);
  const raw = makeObjectStore();
  raw.blobs.set('phys-1', packed.body);
  const db = makeDb(samples, packed);
  const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-verify-'));
  const runtimes = createUserRuntimes({
    engine: {
      archiveRawSamples: async () => ({ id: 'obj', status: 'ready' }),
      persistComputed: async () => null,
      recomputeFromStorage: async () => ({ results: [] }),
    },
    liveDir,
    loadStore: () => ({ prefs: {} }),
    saveStore: () => {},
    loadPersistedDays: async () => ({}),
  });
  const app = express();
  app.use(express.json());
  registerHostRoutes(app, {
    loadStore: () => ({ prefs: {} }),
    saveStore: () => {},
    resolveUser: async () => ({ id: USER, source: 'jwt' }),
    timeZoneOf: () => TZ,
    loadIngestVerify: (userId, dayParam) => loadIngestVerifyReport({
      userId,
      dayParam,
      now: new Date('2026-08-29T15:00:00Z'),
      timeZone: TZ,
      restConfigured: true,
      metricsDb: db,
      getStores: async () => ({ raw }),
      userRuntimes: runtimes,
      overnightFinalizer: { diagnoseDay: async () => ({ state: 'unknown' }) },
      persistSidecars: false,
    }),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ingest/verify?day=${DAY}`, {
      headers: { authorization: 'Bearer t' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, DAY_STATUS.COMPLETE, 'archive gate may be complete');
    assert.notEqual(body.product_status, PRODUCT_DAY_STATUS.COMPLETE);
    assert.equal(body.product_status, PRODUCT_DAY_STATUS.WAITING_FOR_HISTORY);
    assert.equal(body.continuity.strap_history_frontier_ms, null);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
