import assert from 'node:assert/strict';
import test from 'node:test';
import { createPushArchive } from '../ingest/pushArchive.js';
import {
  pushArchiveSpecForStream,
  rawObjectKeyV3,
  retentionClassForStream,
  retentionClassFromObjectKey,
} from '../storage/keys.js';
import { createManifestStore } from '../storage/manifests.js';

const USER = '11111111-1111-4111-8111-111111111111';
const DEV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OBJ = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const START = '2026-08-24T18:12:00.000Z';

function memRest() {
  const table = new Map();
  return {
    configured: true,
    async upsert(_t, row) {
      const r = Array.isArray(row) ? row[0] : row;
      table.set(r.id, { ...r });
      return r;
    },
    async select(_t, q) {
      const id = /id=eq\.([^&]+)/.exec(q)?.[1];
      if (id) return [table.get(id)].filter(Boolean);
      return [...table.values()];
    },
    async request(path, { method, body } = {}) {
      const id = /id=eq\.([^&]+)/.exec(path)?.[1];
      if (method === 'PATCH' && id) {
        table.set(id, { ...table.get(id), ...body });
        return [table.get(id)];
      }
      return [];
    },
    _table: table,
  };
}

function makeArchiveHarness() {
  const rest = memRest();
  createManifestStore({ rest });
  const blobs = new Map();
  const raw = {
    async putObject(key, body, { contentType }) {
      blobs.set(key, { body, contentType });
      return { etag: '"e"' };
    },
    async head(key) {
      const b = blobs.get(key);
      return b ? { exists: true, contentLength: b.body.length, etag: '"e"' } : null;
    },
  };
  const archive = createPushArchive({
    cfg: { b2KeyId: 'k', b2ApplicationKey: 's', b2Bucket: 'b', rawStore: 'b2' },
    rest,
    stores: { raw },
  });
  return { rest, blobs, archive };
}

/**
 * `ppgWaveformSample` and `rawBatch` are `research`, not `ppg`/`core`: those classes carry a B2
 * lifecycle rule that hides objects after 30 days, which would delete the raw corpus out from under
 * manifests that claim no expiry. `v18AuxSample` stays `diag` — it is an unpinned field dump, not
 * signal anyone will train on, and it should keep expiring.
 */
const RETENTION_CASES = [
  { stream: 'hrSample', cls: 'core' },
  { stream: 'ppgWaveformSample', cls: 'research' },
  { stream: 'rawImuSession', cls: 'research' },
  { stream: 'rawBatch', cls: 'research' },
  { stream: 'v18AuxSample', cls: 'diag' },
];

for (const { stream, cls } of RETENTION_CASES) {
  test(`pushArchive manifest retention_class matches v3 key for ${stream}`, async () => {
    const { rest, archive } = makeArchiveHarness();
    const key = rawObjectKeyV3({
      userId: USER,
      deviceId: DEV,
      stream,
      startAt: START,
      objectId: OBJ,
    });
    assert.equal(retentionClassFromObjectKey(key), cls);

    const result = await archive.archiveObject({
      userId: USER,
      deviceId: DEV,
      stream,
      objectId: OBJ,
      key,
      body: Buffer.from('payload'),
      contentType: 'application/x-ndjson',
      format: 'ndjson_gzip_noop_push_v1',
      compression: 'gzip',
      schemaVersion: 1,
      sha256: 'a'.repeat(64),
      sampleCount: 1,
      startAt: START,
      endAt: START,
      periodDay: '2026-08-24',
    });

    assert.equal(result.ready, true);
    const row = rest._table.get(OBJ);
    assert.equal(row.retention_class, cls);
    assert.equal(row.retention_class, retentionClassForStream(stream));
    assert.equal(row.retention_class, retentionClassFromObjectKey(row.object_key));
  });
}

test('pushArchiveSpecForStream selects binary metadata for bin.gz streams', () => {
  const ppg = pushArchiveSpecForStream('ppgWaveformSample');
  assert.equal(ppg.retentionClass, 'research');
  assert.equal(ppg.format, 'bin_gzip_noop_push_v1');
  assert.equal(ppg.contentType, 'application/octet-stream');
  assert.equal(ppg.compression, 'gzip');

  const ndjson = pushArchiveSpecForStream('hrSample');
  assert.equal(ndjson.retentionClass, 'core');
  assert.equal(ndjson.format, 'ndjson_gzip_noop_push_v1');
  assert.equal(ndjson.contentType, 'application/x-ndjson');
  assert.equal(ndjson.compression, 'gzip');

  const frames = pushArchiveSpecForStream('rawBatch');
  assert.equal(frames.retentionClass, 'research');
  assert.equal(frames.format, 'protobuf_zstd_noop_push_v1');
  assert.equal(frames.compression, 'zstd');
});
