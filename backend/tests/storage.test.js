import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandlers, validateUploadIntent, mergeSession, shouldApplyDaily } from '../storage/handlers.js';
import { objectKey, looksLikePii, isUuid } from '../storage/keys.js';
import { createRateLimiter } from '../storage/rateLimit.js';
import { presign } from '../storage/s3.js';
import {
  dailyMetricRow, sleepSessionRow, workoutSessionRow, eventRow,
  stableUuid, nextRetryAt, nextQueueStatus, sleepEfficiency,
} from '../storage/structuredSync.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const DEV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function memDb() {
  const users = new Map([['token-a', { id: USER_A }], ['token-b', { id: USER_B }]]);
  const devices = [{ id: DEV_A, user_id: USER_A }, { id: DEV_B, user_id: USER_B }];
  const objects = new Map();
  const profiles = new Map();
  let authDeleted = [];
  return {
    authDeleted: () => authDeleted,
    objects,
    async getUser(jwt) { return users.get(jwt) || null; },
    async getDevice(userId, deviceId) { return devices.find((d) => d.id === deviceId && d.user_id === userId) || null; },
    async insertSensorObject(row) { objects.set(row.id, { ...row }); return objects.get(row.id); },
    async findDuplicateObject({ userId, deviceId, kind, sha256, startAt, endAt }) {
      return [...objects.values()].find((o) =>
        o.user_id === userId && o.device_id === deviceId && o.object_kind === kind
        && o.sha256 === sha256 && o.start_at === startAt && o.end_at === endAt) || null;
    },
    async getSensorObject(id) { return objects.get(id) || null; },
    async updateSensorObject(id, patch) {
      const row = { ...objects.get(id), ...patch };
      objects.set(id, row);
      return row;
    },
    async listSensorObjects(userId) { return [...objects.values()].filter((o) => o.user_id === userId); },
    async listExpiredReady(nowIso) {
      return [...objects.values()].filter((o) => o.status === 'ready' && o.expires_at && o.expires_at <= nowIso);
    },
    async markPrivacyDeletionRequested(userId) {
      profiles.set(userId, { deletion_requested: true });
      return true;
    },
    async deleteAuthUser(userId) { authDeleted.push(userId); return { deleted: true }; },
    async loadExportBundle(userId) {
      return {
        profiles: [{ id: userId, display_name: 'A' }],
        devices: devices.filter((d) => d.user_id === userId),
        daily_metrics: [{ user_id: userId, day: '2026-08-19', hrv_rmssd_ms: 40, provenance: { source: 'whoop' } }],
        sessions: [],
        events: [],
        sensor_objects: [...objects.values()].filter((o) => o.user_id === userId),
      };
    },
  };
}

function memS3() {
  const blobs = new Map();
  return {
    blobs,
    put(key, bytes) { blobs.set(key, { bytes }); },
    presignPut(key, expiresSec, now) {
      return { url: `https://s3.test/${key}?exp=${expiresSec}`, expiresAt: new Date(now.getTime() + expiresSec * 1000).toISOString() };
    },
    presignGet(key, expiresSec, now) {
      return { url: `https://s3.test/${key}?get=${expiresSec}`, expiresAt: new Date(now.getTime() + expiresSec * 1000).toISOString() };
    },
    async head(key) {
      const b = blobs.get(key);
      return b ? { exists: true, contentLength: b.bytes } : null;
    },
    async deleteObject(key) {
      const missing = !blobs.has(key);
      blobs.delete(key);
      return { deleted: true, missing };
    },
    async listPrefix(prefix) {
      return [...blobs.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

function api(db, s3, limiter = createRateLimiter({ max: 30 })) {
  const fixed = new Date('2026-08-19T12:00:00Z');
  return createHandlers({ db, s3, rateLimit: limiter, now: () => fixed, uuid: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
}

const intentBody = {
  device_id: DEV_A,
  object_kind: 'canonical',
  start_at: '2026-08-19T00:00:00Z',
  end_at: '2026-08-19T23:59:59Z',
  period_day: '2026-08-19',
  sample_count: 1000,
  compressed_bytes: 2048,
  sha256: 'a'.repeat(64),
  schema_version: 1,
};

test('object keys use uuids and reject PII', () => {
  const key = objectKey({ userId: USER_A, deviceId: DEV_A, kind: 'canonical', day: '2026-08-19', objectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
  assert.match(key, /^v1\/users\/11111111-1111-4111-8111-111111111111\/devices\//);
  assert.equal(looksLikePii('jane@example.com'), true);
  assert.equal(looksLikePii(USER_A), false);
  assert.throws(() => objectKey({ userId: 'jane@example.com', deviceId: DEV_A, kind: 'canonical', day: '2026-08-19', objectId: USER_A }));
});

test('upload intent requires auth and own device', async () => {
  const h = api(memDb(), memS3());
  const noAuth = await h.uploadIntent({ headers: {}, body: intentBody });
  assert.equal(noAuth.status, 401);
  const otherDev = await h.uploadIntent({
    headers: { authorization: 'Bearer token-a' },
    body: { ...intentBody, device_id: DEV_B },
  });
  assert.equal(otherDev.status, 403);
});

test('upload intent issues short-lived server-generated key', async () => {
  const h = api(memDb(), memS3());
  const res = await h.uploadIntent({ headers: { authorization: 'Bearer token-a' }, body: intentBody });
  assert.equal(res.status, 200);
  assert.equal(res.body.object_id, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  assert.match(res.body.upload_url, /exp=900/);
  assert.match(res.body.object_key, /canonical\/2026\/08\/19\//);
  assert.equal(res.body.object_key.includes('@'), false);
});

test('client cannot choose object_key', () => {
  const v = validateUploadIntent({ ...intentBody, object_key: 'v1/users/other/evil' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.includes('object_key'));
});

test('upload complete verifies HEAD size and is idempotent', async () => {
  const db = memDb();
  const s3 = memS3();
  const h = api(db, s3);
  const created = await h.uploadIntent({ headers: { authorization: 'Bearer token-a' }, body: intentBody });
  const missing = await h.uploadComplete({ headers: { authorization: 'Bearer token-a' }, body: { object_id: created.body.object_id } });
  assert.equal(missing.status, 409);
  s3.put(created.body.object_key, 2048);
  const ok = await h.uploadComplete({ headers: { authorization: 'Bearer token-a' }, body: { object_id: created.body.object_id } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'ready');
  const again = await h.uploadComplete({ headers: { authorization: 'Bearer token-a' }, body: { object_id: created.body.object_id } });
  assert.equal(again.status, 200);
  assert.equal(db.objects.size, 1);
});

test('user cannot download another user object', async () => {
  const db = memDb();
  const s3 = memS3();
  const h = api(db, s3);
  const created = await h.uploadIntent({ headers: { authorization: 'Bearer token-a' }, body: intentBody });
  s3.put(created.body.object_key, 2048);
  await h.uploadComplete({ headers: { authorization: 'Bearer token-a' }, body: { object_id: created.body.object_id } });
  const steal = await h.downloadIntent({ headers: { authorization: 'Bearer token-b' }, body: { object_id: created.body.object_id } });
  assert.equal(steal.status, 403);
  const own = await h.downloadIntent({ headers: { authorization: 'Bearer token-a' }, body: { object_id: created.body.object_id } });
  assert.equal(own.status, 200);
  assert.match(own.body.download_url, /get=300/);
});

test('duplicate sha+range reissues pending url and does not clone ready objects', async () => {
  const db = memDb();
  const s3 = memS3();
  const h = api(db, s3);
  const first = await h.uploadIntent({ headers: { authorization: 'Bearer token-a' }, body: intentBody });
  const pending = await h.uploadIntent({ headers: { authorization: 'Bearer token-a' }, body: intentBody });
  assert.equal(pending.body.object_id, first.body.object_id);
  assert.equal(db.objects.size, 1);
  s3.put(first.body.object_key, 2048);
  await h.uploadComplete({ headers: { authorization: 'Bearer token-a' }, body: { object_id: first.body.object_id } });
  const ready = await h.uploadIntent({ headers: { authorization: 'Bearer token-a' }, body: intentBody });
  assert.equal(ready.body.status, 'ready');
  assert.equal(ready.body.duplicate, true);
  assert.equal(db.objects.size, 1);
});

test('account deletion removes B2 objects before auth user', async () => {
  const db = memDb();
  const s3 = memS3();
  const h = api(db, s3);
  const created = await h.uploadIntent({ headers: { authorization: 'Bearer token-a' }, body: intentBody });
  s3.put(created.body.object_key, 2048);
  s3.put(`v1/users/${USER_A}/orphan.bin`, 8);
  const order = [];
  const origDelete = s3.deleteObject.bind(s3);
  s3.deleteObject = async (key) => { order.push(`b2:${key}`); return origDelete(key); };
  const origAuth = db.deleteAuthUser.bind(db);
  db.deleteAuthUser = async (id) => { order.push(`auth:${id}`); return origAuth(id); };
  const res = await h.deleteAccount({ headers: { authorization: 'Bearer token-a' } });
  assert.equal(res.status, 200);
  assert.equal(s3.blobs.size, 0);
  assert.ok(order.indexOf(`auth:${USER_A}`) > order.findIndex((x) => x.startsWith('b2:')));
});

test('expired diagnostic and export objects are deleted', async () => {
  const db = memDb();
  const s3 = memS3();
  const h = api(db, s3);
  await db.insertSensorObject({
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    user_id: USER_A,
    object_key: 'v1/users/11111111-1111-4111-8111-111111111111/exports/2026/08/01/x.json.gz',
    status: 'ready',
    expires_at: '2026-08-10T00:00:00.000Z',
  });
  s3.put('v1/users/11111111-1111-4111-8111-111111111111/exports/2026/08/01/x.json.gz', 12);
  const res = await h.expireObjects();
  assert.equal(res.body.deleted, 1);
  assert.equal(s3.blobs.size, 0);
});

test('export includes provenance and not only profile', async () => {
  const h = api(memDb(), memS3());
  const res = await h.exportAccount({ headers: { authorization: 'Bearer token-a' }, body: {} });
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body.payload_utf8);
  assert.ok(payload.daily_metrics.length);
  assert.equal(payload.provenance[0].provenance.source, 'whoop');
  assert.ok(payload.devices);
});

test('rate limiter blocks burst signing', async () => {
  const limiter = createRateLimiter({ max: 2, windowMs: 60_000 });
  const h = api(memDb(), memS3(), limiter);
  const a = await h.uploadIntent({ headers: { authorization: 'Bearer token-a' }, body: { ...intentBody, sha256: 'b'.repeat(64) } });
  const b = await h.uploadIntent({ headers: { authorization: 'Bearer token-a' }, body: { ...intentBody, sha256: 'c'.repeat(64) } });
  const c = await h.uploadIntent({ headers: { authorization: 'Bearer token-a' }, body: { ...intentBody, sha256: 'd'.repeat(64) } });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(c.status, 429);
});

test('presigned URL carries expiry', () => {
  const now = new Date('2026-08-19T00:00:00Z');
  const signed = presign({
    method: 'PUT',
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    bucket: 'frwhoop-health-dev',
    key: 'v1/users/x/a.pb.zst',
    region: 'us-west-004',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    expiresSec: 900,
    now,
  });
  assert.match(signed.url, /X-Amz-Expires=900/);
  assert.equal(signed.expiresAt, '2026-08-19T00:15:00.000Z');
  assert.equal(signed.url.includes('secret'), false);
});

test('daily metric mapping keeps RMSSD/SDNN distinct and raw optics unlabeled as spo2', () => {
  const row = dailyMetricRow({
    userId: USER_A,
    deviceUuid: DEV_A,
    computedAt: '2026-08-19T08:00:00.000Z',
    metric: {
      day: '2026-08-19',
      recovery: 72,
      strain: 40,
      avgHrv: 55.2,
      avgSdnn: 80.1,
      restingHr: 52,
      spo2Pct: null,
      spo2Red: 1200,
      spo2Ir: 1300,
      efficiency: 0.91,
    },
    provenance: { source: 'whoop', device_family: 'WHOOP 4.0' },
  });
  assert.equal(row.hrv_rmssd_ms, 55.2);
  assert.equal(row.hrv_sdnn_ms, 80.1);
  assert.equal(row.spo2_pct, null);
  assert.equal(row.extras.spo2_red_raw_adc, 1200);
  assert.equal(JSON.stringify(row).includes('spo2_pct":1200'), false);
  assert.equal(row.algorithm_version, '0.1.0');
  assert.equal(row.provenance.source, 'whoop');
});

test('sleep efficiency percent is converted; missing stays null', () => {
  assert.equal(sleepEfficiency(91), 0.91);
  assert.equal(sleepEfficiency(0.91), 0.91);
  assert.equal(sleepEfficiency(null), null);
});

test('session sync is idempotent and user_modified wins', () => {
  const a = sleepSessionRow({
    userId: USER_A,
    session: { deviceId: 'my-whoop', startTs: 1000, endTs: 2000, userEdited: true, startTsAdjusted: 1100, avgHrv: 40 },
  });
  const b = sleepSessionRow({
    userId: USER_A,
    session: { deviceId: 'my-whoop', startTs: 1000, endTs: 2000, userEdited: true, startTsAdjusted: 1100, avgHrv: 40 },
  });
  assert.equal(a.id, b.id);
  assert.equal(a.user_modified, true);
  assert.equal(a.start_at, new Date(1100 * 1000).toISOString());
  const merged = mergeSession(a, {
    ...a,
    start_at: new Date(1000 * 1000).toISOString(),
    end_at: new Date(2500 * 1000).toISOString(),
    user_modified: false,
  });
  assert.equal(merged.start_at, a.start_at);
  assert.equal(merged.user_modified, true);
});

test('event sync is idempotent', () => {
  const a = eventRow({ userId: USER_A, entry: { deviceId: 'd', day: '2026-08-19', question: 'Caffeine', numericValue: 180 } });
  const b = eventRow({ userId: USER_A, entry: { deviceId: 'd', day: '2026-08-19', question: 'Caffeine', numericValue: 180 } });
  assert.equal(a.id, b.id);
  assert.equal(a.event_type, 'caffeine');
  assert.equal(a.numeric_value, 180);
  assert.equal(a.unit, 'mg');
  assert.ok(isUuid(a.id));
});

test('stale daily sync does not overwrite newer computed_at', () => {
  assert.equal(shouldApplyDaily(
    { computed_at: '2026-08-19T01:00:00Z' },
    { computed_at: '2026-08-19T02:00:00Z' },
  ), false);
  assert.equal(shouldApplyDaily(
    { computed_at: '2026-08-19T03:00:00Z' },
    { computed_at: '2026-08-19T02:00:00Z' },
  ), true);
});

test('queue retry is exponential and complete replay is a no-op', () => {
  const t0 = 1_000_000;
  const t1 = nextRetryAt(0, t0, 0);
  const t2 = nextRetryAt(3, t0, 0);
  assert.ok(t2 - t0 > t1 - t0);
  assert.equal(nextQueueStatus({ status: 'complete' }), 'complete');
  assert.equal(nextQueueStatus({ status: 'verifying', completeOk: true }), 'complete');
  assert.equal(nextQueueStatus({ status: 'uploading', uploadOk: true }), 'verifying');
});

test('workout mapper preserves source and does not invent HR', () => {
  const row = workoutSessionRow({
    userId: USER_A,
    workout: { deviceId: 'my-whoop', startTs: 10, endTs: 20, sport: 'run', source: 'apple-health', avgHr: null, maxHr: null },
  });
  assert.equal(row.summary.avg_hr, null);
  assert.equal(row.source, 'apple-health');
});

test('stableUuid is deterministic', () => {
  assert.equal(stableUuid(['a', 'b']), stableUuid(['a', 'b']));
  assert.notEqual(stableUuid(['a', 'b']), stableUuid(['a', 'c']));
});

test('b2 authorize discovery does not return credentials', async () => {
  const { discoverS3Endpoint } = await import('../storage/s3.js');
  let seenUrl = '';
  const out = await discoverS3Endpoint('kid', 'super-secret-application-key', async (url, opts) => {
    seenUrl = url;
    assert.match(opts.headers.authorization, /^Basic /);
    assert.equal(opts.headers.authorization.includes('super-secret-application-key'), false);
    return {
      ok: true,
      json: async () => ({ s3ApiUrl: 'https://s3.us-west-004.backblazeb2.com' }),
    };
  });
  assert.equal(seenUrl, 'https://api.backblazeb2.com/b2api/v2/b2_authorize_account');
  assert.equal(out.region, 'us-west-004');
  assert.equal(JSON.stringify(out).includes('super-secret-application-key'), false);
  assert.equal(JSON.stringify(out).includes('kid'), false);
});
