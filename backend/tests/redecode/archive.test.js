// Level B archive writer: B2 object + manifest idempotency and integrity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeLevelBObject } from '../../redecode/archive.js';
import { harvardRT } from '../fixtures/whoopFrames.mjs';

function fakeStores() {
  const objects = new Map(); // key -> Buffer
  return {
    raw: {
      async putObject(key, body) {
        objects.set(key, Buffer.from(body));
        return { etag: 'etag-' + Buffer.from(body).length };
      },
      async head(key) {
        const b = objects.get(key);
        return b ? { exists: true, contentLength: b.length } : null;
      },
      async getObject(key) {
        const b = objects.get(key);
        return b ? { body: b } : null;
      },
      _objects: objects,
    },
  };
}

function fakeManifestStore() {
  const rows = new Map();
  return {
    async insertPending(row) { rows.set(row.id, { ...row }); return row; },
    async get(id) { return rows.get(id) || null; },
    async mark(id, patch) {
      const r = { ...(rows.get(id) || {}), ...patch };
      rows.set(id, r);
      return [r];
    },
    _rows: rows,
  };
}

function levelBRecords() {
  const f = harvardRT(1, 1700000000, 500, 65, 2);
  const hex = [...f].map((b) => b.toString(16).padStart(2, '0')).join('');
  return [{ kind: 'frame', family: 'harvard', frame_hex: hex, packet_type: 40, decoder: 'frwhoop-js/1', frame_hash: 'a'.repeat(64), t: '2026-08-25T02:00:00Z' }];
}

const userId = '11111111-1111-5111-8111-111111111111';
const deviceId = '22222222-2222-5222-8222-222222222222';

test('Level B object writes to B2 and commits manifest', async () => {
  const stores = fakeStores();
  const manifests = fakeManifestStore();
  const out = await writeLevelBObject({
    stores, manifests, userId, deviceId,
    levelB: levelBRecords(), startAt: '2026-08-25T02:00:00Z', endAt: '2026-08-25T02:00:01Z',
    objectId: '33333333-3333-5333-8333-333333333333',
  });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'ready');
  assert.ok(out.objectKey.includes('frames_reassembled'));
  assert.ok(out.objectKey.includes(userId));
  assert.ok(!out.objectKey.includes('a@example.com'));
  const manifest = await manifests.get(out.objectId);
  assert.equal(manifest.status, 'ready');
  assert.ok(manifest.sha256);
  assert.equal(manifest.sample_count, 1);
});

test('Level B write is idempotent (same objectId short-circuits to ready)', async () => {
  const stores = fakeStores();
  const manifests = fakeManifestStore();
  const opts = {
    stores, manifests, userId, deviceId,
    levelB: levelBRecords(), startAt: '2026-08-25T02:00:00Z', endAt: '2026-08-25T02:00:01Z',
    objectId: '44444444-4444-5444-8444-444444444444',
  };
  const a = await writeLevelBObject(opts);
  const b = await writeLevelBObject(opts);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.duplicate, true);
  assert.equal(manifests._rows.size, 1);
});

test('Level B object key contains no PII', async () => {
  const stores = fakeStores();
  const manifests = fakeManifestStore();
  const out = await writeLevelBObject({
    stores, manifests, userId, deviceId,
    levelB: levelBRecords(), startAt: '2026-08-25T02:00:00Z', endAt: '2026-08-25T02:00:01Z',
    objectId: '55555555-5555-5555-8555-555555555555',
  });
  assert.ok(!/whoop|serial|@|phone/i.test(out.objectKey));
  assert.ok(out.objectKey.split('/').every((seg) => /^[a-zA-Z0-9_.-]+$/.test(seg)));
});
