import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  annotateSpo2Identity,
  summarizeSpo2Observations,
  independentSpo2DeviceCount,
  deviceAliasRelations,
  reportsByDeviceFirmwareNight,
} from '../../protocol/spo2.js';
import {
  whoopDeviceId,
  physicalWhoopDeviceId,
  resolvePhysicalWhoopIdentity,
} from '../../storage/keys.js';

const T0 = 1_700_000_000;
const LOCAL = '7f2c9a10-4b3e-4d8a-9c11-00000000f001';
const JWT = '9f33375b-e029-480f-9ebb-a99e5ff22ac9';
const SERIAL_A = '5B00384569';
const SERIAL_B = '5B00384570';

function obs({
  device,
  user,
  serial = null,
  hardwareId = null,
  externalId = null,
  t = T0,
} = {}) {
  return annotateSpo2Identity({
    spo2_raw_byte: 95,
    spo2_candidate_pct: 95,
    spo2_state: 'candidate',
    sensor_timestamp: t,
    device_id: device,
    user_id: user,
    firmware: '50.35.2.0',
    source_frame_hash: `h${t}-${device}`,
    sleep_state: 2,
    serial,
    hardware_id: hardwareId,
    external_device_id: externalId,
  });
}

test('two strap fallbacks with no serial are not one physical device', () => {
  const a = whoopDeviceId(LOCAL, 'strap');
  const b = whoopDeviceId(JWT, 'strap');
  assert.notEqual(a, b);
  const idA = resolvePhysicalWhoopIdentity({
    userId: LOCAL, sourceDeviceId: a, externalId: 'strap',
  });
  const idB = resolvePhysicalWhoopIdentity({
    userId: JWT, sourceDeviceId: b, externalId: 'strap',
  });
  assert.equal(idA.physical_device_id, null);
  assert.equal(idB.physical_device_id, null);
  assert.equal(idA.physical_identity_confidence, 'unknown');
  assert.equal(physicalWhoopDeviceId({ userId: LOCAL, sourceDeviceId: a, externalId: 'strap' }), null);
  const rows = [
    obs({ device: a, user: LOCAL, externalId: 'strap' }),
    obs({ device: b, user: JWT, externalId: 'strap', t: T0 + 1 }),
  ];
  const summary = summarizeSpo2Observations(rows);
  assert.equal(summary.physical_device_id, null);
  assert.equal(summary.physical_identity_confidence, 'unknown');
  assert.equal(summary.source_device_ids.length, 2);
  assert.equal(independentSpo2DeviceCount(rows), 0);
  assert.equal(summary.spo2_pct, null);
});

test('two aliases with the same verified DIS serial are one physical device', () => {
  const a = whoopDeviceId(LOCAL, 'strap');
  const b = whoopDeviceId(JWT, 'strap');
  const idA = resolvePhysicalWhoopIdentity({ serial: SERIAL_A, externalId: 'strap' });
  const idB = resolvePhysicalWhoopIdentity({ serial: SERIAL_A, externalId: 'strap' });
  assert.equal(idA.physical_device_id, idB.physical_device_id);
  assert.ok(idA.physical_device_id);
  assert.equal(idA.physical_identity_evidence, 'dis_serial');
  assert.equal(idA.physical_identity_confidence, 'confirmed');
  const rows = [
    obs({ device: a, user: LOCAL, serial: SERIAL_A, externalId: 'strap' }),
    obs({ device: b, user: JWT, serial: SERIAL_A, externalId: 'strap', t: T0 + 1 }),
  ];
  assert.equal(independentSpo2DeviceCount(rows), 1);
  const relations = deviceAliasRelations(rows);
  assert.equal(relations.length, 1);
  assert.equal(relations[0].relation, 'same_physical_device');
  const summary = summarizeSpo2Observations(rows);
  assert.equal(summary.physical_device_id, idA.physical_device_id);
  assert.equal(summary.physical_identity_confidence, 'confirmed');
});

test('two different verified serials never merge', () => {
  const a = whoopDeviceId(LOCAL, 'strap');
  const b = whoopDeviceId(JWT, 'strap');
  assert.notEqual(
    physicalWhoopDeviceId({ serial: SERIAL_A }),
    physicalWhoopDeviceId({ serial: SERIAL_B }),
  );
  const rows = [
    obs({ device: a, user: LOCAL, serial: SERIAL_A }),
    obs({ device: b, user: JWT, serial: SERIAL_B, t: T0 + 1 }),
  ];
  assert.equal(independentSpo2DeviceCount(rows), 2);
  assert.equal(deviceAliasRelations(rows).length, 0);
  const summary = summarizeSpo2Observations(rows);
  assert.equal(summary.physical_device_id, null);
  assert.deepEqual(summary.physical_device_ids.sort(), [
    physicalWhoopDeviceId({ serial: SERIAL_A }),
    physicalWhoopDeviceId({ serial: SERIAL_B }),
  ].sort());
});

test('missing hardware identity remains unknown', () => {
  const id = resolvePhysicalWhoopIdentity({
    userId: LOCAL,
    sourceDeviceId: whoopDeviceId(LOCAL, 'strap'),
  });
  assert.equal(id.physical_device_id, null);
  assert.equal(id.physical_identity_confidence, 'unknown');
  assert.equal(id.physical_identity_evidence, null);
  const redacted = resolvePhysicalWhoopIdentity({ serial: 'REDACTED' });
  assert.equal(redacted.physical_device_id, null);
  const short = resolvePhysicalWhoopIdentity({ serial: 'abc' });
  assert.equal(short.physical_device_id, null);
});

test('a probable alias cannot count as independent multi-device SpO2 validation', () => {
  const a = whoopDeviceId(LOCAL, 'strap');
  const b = whoopDeviceId(JWT, 'strap');
  const rows = [
    obs({ device: a, user: LOCAL, externalId: 'strap' }),
    obs({ device: b, user: JWT, externalId: 'strap', t: T0 + 1 }),
  ];
  const relations = deviceAliasRelations(rows);
  assert.equal(relations.length, 1);
  assert.equal(relations[0].relation, 'probable_same_device');
  assert.equal(relations[0].physical_device_id, null);
  assert.equal(independentSpo2DeviceCount(rows), 0);
  const nights = reportsByDeviceFirmwareNight(rows, { timeZone: 'UTC' });
  assert.equal(nights.length, 2);
  assert.equal(nights.every((n) => n.physical_identity_confidence !== 'confirmed'), true);
});
