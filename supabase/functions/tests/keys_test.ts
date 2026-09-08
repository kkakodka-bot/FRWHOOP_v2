// Deno mirror of the key-scheme cases from backend/tests/rawObjectHousing.test.js.
import assert from 'node:assert/strict';
import {
  noopDeviceId,
  parseRawObjectKeyV3,
  rawObjectKeyV3,
  retentionClassFromObjectKey,
} from '../_shared/keys.ts';
import { expiresAt } from '../_shared/retention.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const STRAP = 'strap-local-01';

Deno.test('keys: rawObjectKeyV3 and parseRawObjectKeyV3 are inverses across the object lane', () => {
  const device = noopDeviceId(USER, STRAP);
  for (const stream of ['ppgWaveformSample', 'rawImuSession', 'rawBatch', 'v18AuxSample']) {
    for (const iso of ['2026-01-01T00:00:00.000Z', '2026-09-07T18:45:30.500Z', '2026-12-31T23:59:59.999Z']) {
      const objectId = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0';
      const key = rawObjectKeyV3({ userId: USER, deviceId: device, stream, startAt: iso, objectId });
      const parsed = parseRawObjectKeyV3(key);
      assert.ok(parsed, `${stream} @ ${iso} did not parse`);
      assert.equal(parsed.userId, USER);
      assert.equal(parsed.deviceId, device);
      assert.equal(parsed.stream, stream);
      assert.equal(parsed.objectId, objectId);
      assert.equal(parsed.retentionClass, retentionClassFromObjectKey(key));
      assert.equal(rawObjectKeyV3({ ...parsed }), key, 'rebuild from parse must reproduce the key');
    }
  }
});

Deno.test('keys: a malformed or cross-class key parses to null instead of a wrong attribution', () => {
  const device = noopDeviceId(USER, STRAP);
  const good = rawObjectKeyV3({
    userId: USER,
    deviceId: device,
    stream: 'rawImuSession',
    startAt: '2026-09-07T18:00:00.000Z',
    objectId: 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0',
  });
  assert.ok(parseRawObjectKeyV3(good));
  // Class segment moved to another class: must not silently accept.
  assert.equal(parseRawObjectKeyV3(good.replace('v3/research/', 'v3/core/')), null);
  // Wrong extension for the stream.
  assert.equal(parseRawObjectKeyV3(good.replace('.bin.zst', '.ndjson.gz')), null);
  assert.equal(parseRawObjectKeyV3('v3/research/users/not-a-uuid/devices/x/s/2026/09/07/18/y.bin.zst'), null);
  assert.equal(parseRawObjectKeyV3(''), null);
  assert.equal(parseRawObjectKeyV3(`${good}/extra`), null);
});

Deno.test('retention: research objects never expire', () => {
  for (const stream of ['ppgWaveformSample', 'rawImuSession', 'rawBatch']) {
    assert.equal(
      expiresAt(stream, new Date('2026-09-07T18:00:00.000Z')),
      null,
      `${stream} must not carry an expiry`,
    );
  }
  // The diagnostic stream is deliberately still bounded — it is not corpus.
  assert.ok(expiresAt('v18AuxSample', new Date('2026-09-07T18:00:00.000Z')) != null);
});
