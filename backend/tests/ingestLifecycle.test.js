import assert from 'node:assert/strict';
import test from 'node:test';
import { completeUpload, createManifestStore } from '../storage/manifests.js';
import { reconcileObjects } from '../storage/reconcile.js';
import { createDeletionService } from '../storage/deletion.js';
import { encryptJson, decryptJson } from '../persistence/cryptoSecrets.js';
import { dayBounds, localDateKey, physiologicalDay } from '../time/dayBoundary.js';
import { bucketsFromSamples, bpmDataFromBuckets } from '../metrics/buckets.js';
import { rawObjectKey, rawObjectKeyV3, exportObjectKey, looksLikePii } from '../storage/keys.js';
import { expiresAt, retentionFor } from '../storage/retention.js';

function memRest(rows = []) {
  const table = new Map(rows.map((r) => [r.id, { ...r }]));
  return {
    async upsert(_t, row) {
      const r = Array.isArray(row) ? row[0] : row;
      table.set(r.id, { ...table.get(r.id), ...r });
      return r;
    },
    async select() { return [...table.values()]; },
    async delete() { table.clear(); return []; },
    async request(path, { method, body } = {}) {
      const id = /id=eq\.([^&]+)/.exec(path)?.[1];
      if (method === 'PATCH' && id) {
        table.set(id, { ...table.get(id), ...body });
        return [table.get(id)];
      }
      return [...table.values()];
    },
    async adminDeleteAuthUser() { return { deleted: true }; },
    _table: table,
  };
}

test('complete upload is idempotent and verifies size', async () => {
  const rest = memRest([{
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    object_key: 'v2/users/u/devices/d/raw/hr/2026/08/24/18/a.ndjson.gz',
    status: 'pending',
    compressed_bytes: 4,
    sha256: 'abc',
  }]);
  const manifests = createManifestStore({ rest });
  const store = {
    async head() { return { exists: true, contentLength: 4, etag: '"e"' }; },
  };
  const first = await completeUpload({
    manifests, objectStore: store, objectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  assert.equal(first.ok, true);
  const second = await completeUpload({
    manifests, objectStore: store, objectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  assert.equal(second.duplicate, true);
});

test('checksum/size mismatch marks failed', async () => {
  const rest = memRest([{
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    object_key: 'k',
    status: 'pending',
    compressed_bytes: 10,
  }]);
  const manifests = createManifestStore({ rest });
  const out = await completeUpload({
    manifests,
    objectStore: { async head() { return { exists: true, contentLength: 3 }; } },
    objectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'size_mismatch');
});

test('reconcile finds pending without object and ready without object', async () => {
  const rest = memRest([
    { id: '1', object_key: 'missing', status: 'pending', created_at: '2020-01-01T00:00:00.000Z', user_id: 'u' },
    { id: '2', object_key: 'gone', status: 'ready', user_id: 'u' },
  ]);
  const report = await reconcileObjects({
    rest,
    objectStore: { async head() { return null; } },
    userId: 'u',
    listPrefix: async () => ['orphan-key'],
  });
  assert.ok(report.pending_missing_object >= 1);
  assert.ok(report.ready_missing_object >= 1);
  assert.equal(report.orphan_objects, 1);
});

test('reconcile lists v3 prefixes for orphan census', async () => {
  const prefixes = [];
  const report = await reconcileObjects({
    rest: memRest([]),
    objectStore: { async head() { return null; } },
    userId: 'u',
    listPrefix: async (p) => {
      prefixes.push(p);
      return p.startsWith('v3/') ? ['v3/core/users/u/physiology/x'] : [];
    },
  });
  assert.ok(prefixes.some((p) => p.startsWith('v3/core/')));
  assert.equal(report.listed_objects, 1);
  assert.equal(report.orphan_objects, 1);
});

test('deletion is resumable and deletes b2 before auth', async () => {
  const order = [];
  const rest = {
    async select() { return [{ id: 'm', object_key: 'k', status: 'ready' }]; },
    async upsert(_t, row) { order.push(`job:${row.status}:${row.step}`); return row; },
    async delete(table) { order.push(`sql:${table}`); return []; },
    async adminDeleteAuthUser(id) { order.push(`auth:${id}`); return { deleted: true }; },
  };
  const deletion = createDeletionService({
    rest,
    objectStore: {
      async deletePrefixAllVersions(prefix) {
        order.push(`b2:${prefix}`);
        return { deleted: 1, remaining: 0, failures: [] };
      },
    },
    uuid: () => 'job-1',
  });
  const result = await deletion.run('7f2c9a10-4b3e-4d8a-9c11-00000000f001', {
    existing: {
      id: 'job-1',
      user_id: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
      status: 'pending',
      step: 'record_job',
      state: { failures: [], deleted_keys: [] },
    },
  });
  assert.equal(result.status, 'deleted');
  assert.ok(order.find((s) => s.startsWith('b2:')) );
  assert.ok(order.indexOf('b2:v2/users/7f2c9a10-4b3e-4d8a-9c11-00000000f001/')
    < order.indexOf('auth:7f2c9a10-4b3e-4d8a-9c11-00000000f001'));
});

test('credentials encrypt and never round-trip as plaintext json', () => {
  const secret = 'a'.repeat(64);
  const blob = encryptJson({ refresh_token: 'rt' }, secret);
  assert.match(blob, /^v1:k1:/);
  assert.equal(JSON.stringify(decryptJson(blob, secret)), '{"refresh_token":"rt"}');
});

test('day bounds handle a named timezone', () => {
  const b = dayBounds('2026-03-08', 'America/Chicago');
  assert.equal(b.day, '2026-03-08');
  assert.equal(b.timezone_name, 'America/Chicago');
  assert.equal(localDateKey(b.day_start_at, 'America/Chicago'), '2026-03-08');
  assert.equal(physiologicalDay({ wakeIso: '2026-08-24T11:00:00.000Z', timeZone: 'UTC' }), '2026-08-24');
  const dst = dayBounds('2026-03-08', 'America/Chicago');
  const span = Date.parse(dst.day_end_at) - Date.parse(dst.day_start_at);
  assert.equal(span, 23 * 3600 * 1000);
});

test('buckets are 5 minutes not 1 Hz', () => {
  const samples = [];
  for (let i = 0; i < 60; i += 1) {
    samples.push({ datetime: new Date(Date.UTC(2026, 7, 24, 18, 0, i)).toISOString(), bpm: 60 + (i % 5) });
  }
  const buckets = bucketsFromSamples(samples, 5);
  assert.equal(buckets.length, 1);
  assert.ok(buckets[0].avg_hr);
  const bpm = bpmDataFromBuckets(buckets);
  assert.equal(bpm.length, 1);
});

test('v2 keys contain no PII and group by UTC hour', () => {
  const user = '11111111-1111-4111-8111-111111111111';
  const device = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const objectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const key = rawObjectKey({
    userId: user, deviceId: device, stream: 'hr',
    startAt: '2026-08-24T18:12:00.000Z', objectId,
  });
  assert.equal(key, `v2/users/${user}/devices/${device}/raw/hr/2026/08/24/18/${objectId}.ndjson.gz`);
  assert.equal(looksLikePii(user), false);
  const exp = exportObjectKey({ userId: user, objectId });
  assert.match(exp, /\.json\.gz$/);
});

test('v3 physiology keys start with a B2 retention prefix', () => {
  const user = '11111111-1111-4111-8111-111111111111';
  const device = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const objectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const key = rawObjectKeyV3({
    userId: user, deviceId: device, stream: 'physiology',
    startAt: '2026-08-24T18:12:00.000Z', objectId,
  });
  assert.equal(key, `v3/core/users/${user}/devices/${device}/physiology/2026/08/24/18/${objectId}.ndjson.gz`);
  const ppg = rawObjectKeyV3({
    userId: user, deviceId: device, stream: 'ppg',
    startAt: '2026-08-24T18:12:00.000Z', objectId,
  });
  assert.match(ppg, /^v3\/ppg\//);
});

test('v3 frames keys are core retention and never expire', () => {
  const user = '11111111-1111-4111-8111-111111111111';
  const device = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const objectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const key = rawObjectKeyV3({
    userId: user, deviceId: device, stream: 'frames',
    startAt: '2026-08-24T18:12:00.000Z', objectId,
  });
  assert.equal(key, `v3/core/users/${user}/devices/${device}/frames/2026/08/24/18/${objectId}.ndjson.gz`);
  assert.equal(retentionFor('frames').class, 'core');
  assert.equal(retentionFor('frames').defaultDays, null);
  assert.equal(expiresAt('frames'), null);
  assert.equal(retentionFor('ble').class, 'diagnostic');
  assert.equal(retentionFor('ble').defaultDays, 7);
});
