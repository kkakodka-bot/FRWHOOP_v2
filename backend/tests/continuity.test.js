import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHourBuffer } from '../ingest/hourBuffer.js';
import { createMetricsEngine } from '../metrics/engine.js';
import { encodeArchive } from '../ingest/archiveFormat.js';
import { dayBounds } from '../time/dayBoundary.js';

const USER = '33333333-3333-4333-8333-333333333333';
const TZ = 'America/Los_Angeles';

function makeStore(failPut = false) {
  const blobs = new Map();
  return {
    blobs,
    failPut,
    async putObject(key, body) {
      if (this.failPut) throw new Error('b2_unavailable');
      blobs.set(key, body); return { etag: '"x"', bytes: body.length };
    },
    async head(key) { const b = blobs.get(key); return b ? { exists: true, contentLength: b.length } : null; },
    async getObject(key) { const b = blobs.get(key); return b ? { body: b } : null; },
    async listPrefix(prefix) { return [...blobs.keys()].filter((k) => k.startsWith(prefix)); },
  };
}
function makeEngine({ raw, derived, db }) {
  return createMetricsEngine({ cfg: { localUserId: USER, rawStore: 'b2', derivedStore: 'b2', b2Bucket: 'FRWHOOP', buildHash: 'test' }, stores: { raw, derived }, db });
}
function makeDb() {
  const state = { object_manifests: new Map(), daily_metrics: new Map(), series: new Map(), sessions: [], sleep_details: [] };
  return {
    state,
    async upsertPayload(payload = {}) {
      for (const m of payload.object_manifests || []) state.object_manifests.set(m.id, m);
      for (const d of payload.daily_metrics || []) state.daily_metrics.set(`${d.user_id}|${d.day}`, d);
      for (const s of payload.daily_physiology_series || []) {
        const key = `${s.user_id}|${s.day}`;
        const map = new Map(state.series.get(key)?.hr_series || []);
        for (const pt of s.hr_series || []) map.set(pt.t, pt);
        state.series.set(key, { ...state.series.get(key), user_id: s.user_id, day: s.day, sample_count: Math.max(state.series.get(key)?.sample_count || 0, s.sample_count || map.size), hr_series: map });
      }
      return { ok: true };
    },
    async listPhysiologyManifests() {
      return [...state.object_manifests.values()].filter((m) => m.object_kind === 'physiology' || !m.object_kind);
    },
  };
}

test('duplicate upload is idempotent: same raw batch -> same B2 key, no duplicate object', async () => {
  const raw = makeStore();
  const db = makeDb();
  const engine = makeEngine({ raw, derived: makeStore(), db });
  const batch = [
    { datetime: '2026-08-24T18:00:00.000Z', bpm: 60, rr_ms: [], src: 'ble_hr', seq: 1 },
    { datetime: '2026-08-24T18:00:04.000Z', bpm: 61, rr_ms: [], src: 'ble_hr', seq: 2 },
    { datetime: '2026-08-24T18:00:08.000Z', bpm: 62, rr_ms: [], src: 'ble_hr', seq: 3 },
  ];
  const args = { samples: batch, device: { id: 'strap' }, startAt: batch[0].datetime, endAt: batch[2].datetime };
  const first = await engine.archiveRawSamples(args);
  const second = await engine.archiveRawSamples(args);
  assert.equal(first.status, 'ready');
  // Downstream retry (e.g. WAL re-flush after a crash) must reuse the SAME object key.
  assert.equal(second.object_key, first.object_key, 'retry must reuse the same B2 object key');
  assert.equal(raw.blobs.size, 1, 'exactly one B2 object for one logical batch');
  const manifests = [...db.state.object_manifests.values()];
  assert.equal(manifests.length, 1, 'one manifest row per logical raw object');
});

test('48 continuous hours split into two correct local days', async () => {
  const raw = makeStore();
  const db = makeDb();
  const engine = makeEngine({ raw, derived: makeStore(), db });
  const b = dayBounds('2026-08-24', TZ);
  const day1 = [];
  const day2 = [];
  for (let t = Date.parse(b.day_start_at); t < Date.parse(b.day_end_at); t += 300000) {
    day1.push({ datetime: new Date(t).toISOString(), bpm: 60, rr_ms: [], src: 'ble_hr', seq: day1.length + 1 });
  }
  const b2 = dayBounds('2026-08-25', TZ);
  for (let t = Date.parse(b2.day_start_at); t < Date.parse(b2.day_end_at); t += 300000) {
    day2.push({ datetime: new Date(t).toISOString(), bpm: 61, rr_ms: [], src: 'ble_hr', seq: day1.length + day2.length + 1 });
  }
  await engine.archiveRawSamples({ samples: day1, device: { id: 'strap' }, startAt: day1[0].datetime, endAt: day1.at(-1).datetime, extras: { periodDay: '2026-08-24', timeZone: TZ } });
  await engine.archiveRawSamples({ samples: day2, device: { id: 'strap' }, startAt: day2[0].datetime, endAt: day2.at(-1).datetime, extras: { periodDay: '2026-08-25', timeZone: TZ } });
  const series = [...db.state.series.keys()].sort();
  assert.deepEqual(series, [`${USER}|2026-08-24`, `${USER}|2026-08-25`], 'two days produce two series rows');
  const all = [...db.state.series.values()];
  assert.equal(all[0].hr_series.size, 288);
  assert.equal(all[1].hr_series.size, 288);
});

test('one archive batch that crosses local midnight writes both day series', async () => {
  const raw = makeStore();
  const db = makeDb();
  const engine = makeEngine({ raw, derived: makeStore(), db });
  const batch = [
    { datetime: '2026-08-25T06:50:00.000Z', bpm: 61, rr_ms: [], src: 'ble_hr', seq: 1 },
    { datetime: '2026-08-25T07:10:00.000Z', bpm: 64, rr_ms: [], src: 'ble_hr', seq: 2 },
  ];
  await engine.archiveRawSamples({
    samples: batch,
    device: { id: 'strap' },
    startAt: batch[0].datetime,
    endAt: batch[1].datetime,
    extras: { timeZone: TZ },
  });
  const series = [...db.state.series.keys()].sort();
  assert.deepEqual(series, [`${USER}|2026-08-24`, `${USER}|2026-08-25`]);
  assert.equal([...db.state.series.get(`${USER}|2026-08-24`).hr_series.values()][0].avg_hr, 61);
  assert.equal([...db.state.series.get(`${USER}|2026-08-25`).hr_series.values()][0].avg_hr, 64);
});

test('offline B2: archive fails, nothing is lost or marked ready, retry succeeds', async () => {
  const raw = makeStore(true); // putObject throws (B2 unavailable)
  const db = makeDb();
  const engine = makeEngine({ raw, derived: makeStore(), db });
  const batch = [{ datetime: '2026-08-24T18:00:00.000Z', bpm: 60, rr_ms: [], src: 'ble_hr', seq: 1 }];
  await assert.rejects(
    () => engine.archiveRawSamples({ samples: batch, device: { id: 'strap' }, startAt: batch[0].datetime, endAt: batch[0].datetime }),
    /b2_unavailable|b2_object_missing|b2_size_mismatch/,
  );
  // B2 comes back: same logical batch retries to the same key and lands ready.
  raw.failPut = false;
  const ok = await engine.archiveRawSamples({ samples: batch, device: { id: 'strap' }, startAt: batch[0].datetime, endAt: batch[0].datetime });
  assert.equal(ok.status, 'ready');
  assert.equal(raw.blobs.size, 1);
});

test('corrupt WAL line is skipped on recovery without losing the valid rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-corrupt-'));
  const u = '7f2c9a10-4b3e-4d8a-9c11-00000000f001';
  fs.mkdirSync(path.join(dir, u), { recursive: true });
  fs.writeFileSync(path.join(dir, u, 'pending-wal.ndjson'),
    '{"datetime":"2026-08-24T18:00:00.000Z","bpm":60,"seq":1}\n' +
    'NOT-VALID-JSON-LINE\n' +
    '{"datetime":"2026-08-24T18:00:04.000Z","bpm":61,"seq":2}\n');
  const archivedRows = [];
  const engine = {
    archiveRawSamples: async (args) => {
      archivedRows.push(...args.samples.map((s) => ({ seq: s.seq, bpm: s.bpm })));
      return { id: 'o', status: 'ready' };
    },
  };
  const buf = createHourBuffer({ dir, userId: u, chunkMs: 3_600_000, engine });
  // Exactly the two valid rows must survive recovery and reach the archive
  // intact. (Adversarial-review fix: the old assertions were tautologies and
  // would pass even if recoverWal dropped every valid row.)
  assert.equal(buf.pendingCount(), 2);
  await buf.flush();
  const bySeq = archivedRows.filter((r) => r.seq === 1 || r.seq === 2);
  assert.equal(bySeq.length, 2);
  assert.deepEqual(bySeq.map((r) => r.bpm).sort((a, b) => a - b), [60, 61]);
});

test('recompute finds B2 physiology objects that have no manifest', async () => {
  const raw = makeStore();
  const db = makeDb();
  const engine = makeEngine({ raw, derived: makeStore(), db });
  const encoded = encodeArchive([{
    t: '2026-08-25T03:50:00.000Z',
    bpm: 73,
    src: 'ble_hr',
    seq: 1,
  }]);
  const key = `v3/core/users/${USER}/devices/strap/physiology/2026/08/25/03/orphan.ndjson.gz`;
  raw.blobs.set(key, encoded.body);
  const replay = await engine.recomputeFromStorage({ userId: USER, days: ['2026-08-24'], timeZone: TZ });
  assert.ok(replay.samples >= 1, 'orphan B2 object must be decoded');
  const series = db.state.series.get(`${USER}|2026-08-24`);
  assert.ok(series, 'Aug 24 local series must be written');
  assert.equal([...series.hr_series.values()][0].avg_hr, 73);
});
