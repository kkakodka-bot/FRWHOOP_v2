// Tests for the derived high-value record streams:
//   imuArchive (six-axis IMU raw records + physics validation)
//   eventRecords (type-48 events / console logs / cmd battery)
//   redecode/derive (Level A -> records, census, CRC gating)
// Fixtures: real captured WHOOP5 v21 frame + real type-48 event from
// tests/fixtures/noop-whoop5-parity.json (NOOP @ ab0f699e provenance).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { imuRecordFromFrame, encodeImuArchive, imuPhysicsStats,
         IMU_ARCHIVE_SCHEMA, ACCEL_SCALE_G_PER_LSB, GYRO_SCALE_DPS_PER_LSB } from '../../protocol/imuArchive.js';
import { eventRecordFromFrame, consoleRecordFromFrame, cmdBatteryRecordFromFrame,
         recordsFromFrame, EVENT_NUMBER_NAMES, encodeEventArchive, decodeEventArchive } from '../../protocol/eventRecords.js';
import { deriveRecords } from '../../redecode/derive.js';
import { decodeFrame } from '../../protocol/decoder.js';
import { crc16Modbus, crc32 } from '../../protocol/crc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(path.join(here, '../fixtures/noop-whoop5-parity.json'), 'utf8'));

test('real v21 frame derives a full six-axis IMU record with physics evidence', () => {
  const frame = Buffer.from(fx.v21_real.hex, 'hex');
  const rec = imuRecordFromFrame(frame, 'puffin', { fw: '50.35.5', char: 'FD4B0003', seq: 7, receivedAt: '2026-08-30T10:00:00Z' });
  assert.ok(rec, 'record produced');
  assert.equal(rec.schema, IMU_ARCHIVE_SCHEMA);
  assert.equal(rec.kind, 'hist_v21');
  assert.equal(rec.layout, 'v21');
  assert.equal(rec.samples_per_axis, 100);
  assert.equal(rec.sample_rate_hz, 100);
  assert.equal(rec.sample_rate_provenance, 'inferred_from_100_samples_per_1s_record');
  assert.equal(rec.sample_timestamps, 'not_on_wire');
  assert.equal(rec.sample_index_start, 0);
  assert.equal(rec.accel_x.length, 100);
  assert.equal(rec.accel_y.length, 100);
  assert.equal(rec.accel_z.length, 100);
  assert.equal(rec.gyro_x.length, 100);
  assert.equal(rec.gyro_y.length, 100);
  assert.equal(rec.gyro_z.length, 100);
  assert.equal(rec.accel.scale_g_per_lsb, ACCEL_SCALE_G_PER_LSB);
  assert.equal(rec.gyro.unit, 'dps');
  // provenance
  assert.equal(rec.firmware.fw, '50.35.5');
  assert.equal(rec.transport.char, 'FD4B0003');
  assert.equal(rec.transport.seq, 7);
  assert.ok(rec.envelope.frame_hash && rec.envelope.frame_hash.length === 64);
  assert.equal(rec.envelope.crc_ok, true);
  assert.ok(rec.decoder.lineage.includes('noop@'));
  // mission physics rule: gravity shell + near-zero gyro on the real capture
  assert.equal(rec.physics.gravity_shell_ok, true);
  assert.ok(Math.abs(rec.physics.accel_mag_mean_g - 1) < 0.02);
  assert.ok(Math.abs(rec.physics.gyro_mean_dps[0]) < 8);
});

test('imu record is rejected for frames without an interpretable IMU body', () => {
  const frame = Buffer.from(fx.regression_corpus.type48.hex, 'hex'); // harvard type 48
  assert.equal(imuRecordFromFrame(frame, 'puffin', {}), null);
  const v18 = fx.v18?.[0]?.hex ? Buffer.from(fx.v18[0].hex, 'hex') : null;
  if (v18) {
    const rec = imuRecordFromFrame(v18, 'puffin', {});
    assert.equal(rec, null, 'v18 per-second summary is not an IMU record');
  }
});

test('accel arrays are raw LSBs; scale metadata is separate, never applied', () => {
  const frame = Buffer.from(fx.v21_real.hex, 'hex');
  const rec = imuRecordFromFrame(frame, 'puffin', {});
  const deep = decodeFrame(frame, 'puffin');
  assert.deepEqual(rec.accel_x, deep.decoded.parsed.accel_x);
  assert.ok(Number.isInteger(rec.accel_x[0]));
  assert.ok(rec.physics.accel_mean_g.every((v) => Math.abs(v) <= 2.5));
});

test('physics helper: rotation shows as signed gyro response, stillness as shell', () => {
  const frame = Buffer.from(fx.v21_real.hex, 'hex');
  const rec = imuRecordFromFrame(frame, 'puffin', {});
  // Synthetic rotation: set gyro_x to a constant 4096 LSB (~250 dps), keep accel
  const rotated = { ...rec, gyro_x: rec.gyro_x.map(() => 4096), gyro_y: rec.gyro_y.map(() => 0), gyro_z: rec.gyro_z.map(() => 0) };
  const stats = imuPhysicsStats(rotated);
  assert.ok(Math.abs(stats.gyro_mean_dps[0] - 250) < 1, `gyro_x mean ~250 dps, got ${stats.gyro_mean_dps[0]}`);
  assert.ok(Math.abs(stats.gyro_mean_dps[1]) < 0.001);
  assert.equal(stats.gravity_shell_ok, true, 'gravity shell unchanged by gyro-only rotation');
});

test('encodeImuArchive produces gzip ndjson with the schema rows', () => {
  const frame = Buffer.from(fx.v21_real.hex, 'hex');
  const rec = imuRecordFromFrame(frame, 'puffin', {});
  const enc = encodeImuArchive([rec]);
  assert.equal(enc.sample_count, 1);
  assert.equal(enc.format, 'ndjson_gzip_imu_v1');
  const parsed = JSON.parse(gunzipSync(enc.body).toString('utf8').trim());
  assert.equal(parsed.schema, IMU_ARCHIVE_SCHEMA);
  assert.equal(parsed.accel_x.length, 100);
  assert.deepEqual(parsed.accel_x, rec.accel_x);
  assert.deepEqual(parsed.accel_y, rec.accel_y);
  assert.deepEqual(parsed.accel_z, rec.accel_z);
  assert.deepEqual(parsed.gyro_x, rec.gyro_x);
  assert.deepEqual(parsed.gyro_y, rec.gyro_y);
  assert.deepEqual(parsed.gyro_z, rec.gyro_z);
});

test('type-48 event record: real RAW_DATA_COLLECTION_ON frame decodes name + raw payload', () => {
  const frame = Buffer.from(fx.regression_corpus.type48.hex, 'hex');
  const rec = eventRecordFromFrame(frame, 'harvard', { fw: '52.x', frameHash: 'deadbeef' });
  assert.ok(rec);
  assert.equal(rec.event_id, 46);
  assert.equal(rec.event_name, 'RAW_DATA_COLLECTION_ON');
  assert.equal(rec.event_ts, 1736365593);
  assert.equal(rec.battery_pct, null, 'no fabricated battery for a non-battery event');
  assert.equal(rec.payload_hex, null, 'header-only event has no payload bytes');
  assert.equal(rec.envelope.frame_hash, 'deadbeef');
});

test('type-48 BATTERY_LEVEL decodes the battery series (puffin + harvard layouts)', () => {
  // puffin: ev@10, ts@12, soc u16@21 (/10), mV@25, charging@30
  const ev = new Uint8Array(44); ev[0] = 0xAA; ev[8] = 48; ev[10] = 3;
  const dv = new DataView(ev.buffer);
  dv.setUint32(12, 1784054004, true);
  dv.setUint16(21, 780, true);   // 78.0 %
  dv.setUint16(25, 3900, true);
  ev[30] = 1;
  const rec = eventRecordFromFrame(ev, 'puffin', {});
  assert.equal(rec.event_name, 'BATTERY_LEVEL');
  assert.equal(rec.battery_pct, 78);
  assert.equal(rec.battery_mV, 3900);
  assert.equal(rec.battery_charging, 1);
  dv.setUint16(27, 9, true);
  const recCounter = eventRecordFromFrame(ev, 'puffin', {});
  assert.equal(recCounter.battery_counter, 9);

  // harvard: ev@6, ts@8, soc u16@17, mV@21, charging@26 (NOOP PostHooks 4.0)
  const ev4 = new Uint8Array(44); ev4[0] = 0xAA; ev4[4] = 48; ev4[6] = 3;
  const dv4 = new DataView(ev4.buffer);
  dv4.setUint32(8, 1784054004, true);
  dv4.setUint16(17, 655, true);  // 65.5 %
  dv4.setUint16(21, 3712, true);
  ev4[26] = 0;
  const rec4 = eventRecordFromFrame(ev4, 'harvard', {});
  assert.equal(rec4.battery_pct, 65.5);
  assert.equal(rec4.battery_mV, 3712);
  assert.equal(rec4.battery_charging, 0);
});

test('console record captures the strap diagnostic line with provenance', () => {
  const cl = new Uint8Array(80);
  const dv = new DataView(cl.buffer);
  cl[0] = 0xAA;
  cl[8] = 50;
  dv.setUint16(9, 7, true);          // record index
  dv.setUint32(12, 1784054004, true);
  dv.setUint16(16, 250, true);       // subsec
  dv.setUint16(18, 52, true);        // chunk len
  cl[20] = 1;                        // channel
  const msg = Buffer.from('19, 146552119: BLE: History burst success. Trim: 130692');
  cl.set(msg, 21);
  const rec = consoleRecordFromFrame(cl, 'puffin', { fw: '50.35.5' });
  assert.equal(rec.schema, 'frwhoop_console_v1');
  assert.equal(rec.record_index, 7);
  assert.ok(rec.log.includes('History burst success'));
  assert.ok(rec.log.includes('130692'));
});

test('cmd battery record from GET_BATTERY_LEVEL command response', () => {
  const cr = new Uint8Array(32); cr[0] = 0xAA; cr[8] = 36; cr[10] = 26; cr[11] = 5; cr[12] = 1; cr[13] = 47;
  const rec = cmdBatteryRecordFromFrame(cr, 'puffin', {});
  assert.ok(rec, 'battery pct present -> record');
  assert.equal(rec.battery_pct, 47);
  // non-battery command responses produce nothing
  const cr2 = new Uint8Array(32); cr2[0] = 0xAA; cr2[8] = 36; cr2[10] = 34; cr2[12] = 1;
  assert.equal(cmdBatteryRecordFromFrame(cr2, 'puffin', {}), null);
});

test('deriveRecords: split Level A notifies -> IMU + event + census, CRC-gated', () => {
  const frame = Buffer.from(fx.v21_real.hex, 'hex');
  const rows = [
    { hex: frame.slice(0, 500).toString('hex'), char: 'FD4B0003', family: 'puffin', fw: '50.35.5', t: '2026-08-30T10:00:00Z', seq: 1 },
    { hex: frame.slice(500).toString('hex'), char: 'FD4B0003', family: 'puffin', fw: '50.35.5', t: '2026-08-30T10:00:00.01Z', seq: 2 },
  ];
  const out = deriveRecords(rows);
  assert.equal(out.imu.length, 1);
  assert.equal(out.imu[0].kind, 'hist_v21');
  assert.equal(out.session.frames, 1);
  assert.equal(out.session.crc_valid_frames, 1);
  assert.equal(out.session.packet_census['47'], 1);
  assert.equal(out.session.imu_kinds.hist_v21, 1);
  assert.ok(out.session.event_names && Object.keys(out.session.event_names).length === 0);
  // provenance consistency: record hash equals decodeFrame's hash of same bytes
  const rec = out.imu[0];
  assert.equal(rec.envelope.frame_hash, decodeFrame(frame, 'puffin').frame_hash);
});

test('deriveRecords skips crc-invalid frames from records but counts them', () => {
  const frame = Buffer.from(fx.v21_real.hex, 'hex');
  // corrupt the crc32 tail
  const bad = Buffer.from(frame);
  bad[bad.length - 1] ^= 0xFF;
  const rows = [{ hex: bad.toString('hex'), char: 'FD4B0003', family: 'puffin', fw: 'x', t: '2026-08-30T10:00:00Z', seq: 1 }];
  const out = deriveRecords(rows);
  assert.equal(out.imu.length, 0);
  assert.equal(out.session.crc_invalid_frames, 1);
});

test('deriveRecords: event frame from the regression corpus yields a named event', () => {
  const ev = Buffer.from(fx.regression_corpus.type48.hex, 'hex');
  const rows = [{ hex: ev.toString('hex'), char: '61080003', family: 'harvard', fw: '52.x', t: '2026-08-30T10:00:01Z', seq: 3 }];
  const out = deriveRecords(rows);
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].event_name, 'RAW_DATA_COLLECTION_ON');
  assert.equal(out.session.event_names.RAW_DATA_COLLECTION_ON, 1);
});

test('event archive roundtrips type-48 records for replay', () => {
  const ev = Buffer.from(fx.regression_corpus.type48.hex, 'hex');
  const rec = eventRecordFromFrame(ev, 'harvard', { fw: '52.x', char: '61080003' });
  const packed = encodeEventArchive([rec]);
  const back = decodeEventArchive(packed.body);
  assert.equal(back.length, 1);
  assert.equal(back[0].event_name, rec.event_name);
  assert.equal(back[0].event_id, rec.event_id);
  assert.equal(back[0].schema, rec.schema);
});

test('EVENT_NUMBER_NAMES covers wrist + battery + device events', () => {
  assert.equal(EVENT_NUMBER_NAMES[9], 'WRIST_ON');
  assert.equal(EVENT_NUMBER_NAMES[10], 'WRIST_OFF');
  assert.equal(EVENT_NUMBER_NAMES[3], 'BATTERY_LEVEL');
  assert.equal(EVENT_NUMBER_NAMES[17], 'TEMPERATURE_LEVEL');
});

test('type-48 event 29 is a structural sync-hint candidate, not physiology', () => {
  const ev = new Uint8Array(44); ev[0] = 0xAA; ev[8] = 48; ev[10] = 29;
  const dv = new DataView(ev.buffer);
  dv.setUint32(12, 1784054004, true);
  ev[20] = 1;
  dv.setUint32(21, 12345, true);
  dv.setUint16(25, 93, true);
  ev[27] = 0x0b;
  ev[28] = 1;
  const rec = eventRecordFromFrame(ev, 'puffin', {});
  assert.equal(rec.event_id, 29);
  assert.equal(rec.event_name, 'STRAP_CONDITION_REPORT');
  assert.equal(rec.battery_pct, null);
  assert.equal(rec.event_body.semantic_status, 'candidate_unpromoted');
  assert.equal(rec.event_body.product_use, 'sync_hint_only');
});

test('type-48 event 63 i16x3 is not labeled accelerometer', () => {
  const ev = new Uint8Array(44); ev[0] = 0xAA; ev[8] = 48; ev[10] = 63;
  const dv = new DataView(ev.buffer);
  dv.setUint32(12, 1784054004, true);
  ev[20] = 1;
  dv.setInt16(22, 100, true);
  dv.setInt16(24, -20, true);
  dv.setInt16(26, 5, true);
  const rec = eventRecordFromFrame(ev, 'puffin', {});
  assert.equal(rec.event_id, 63);
  assert.equal(rec.event_name, 'EXTENDED_BATTERY_INFORMATION');
  assert.equal(rec.event_body.not_accelerometer, true);
  assert.equal(rec.event_body.semantic_status, 'candidate_unpromoted');
  assert.equal(rec.event_body.i16x3_raw.length, 3);
});

function withPacketType(hex, type) {
  const f = Buffer.from(hex, 'hex');
  f[8] = type;
  const declared = f.length - 8;
  f[2] = declared & 0xFF;
  f[3] = (declared >> 8) & 0xFF;
  const h = crc16Modbus(Array.from(f.slice(0, 6)));
  f[6] = h & 0xFF;
  f[7] = (h >> 8) & 0xFF;
  const pe = f.length - 4;
  const c = crc32(Array.from(f.slice(8, pe)));
  f[pe] = c & 0xFF;
  f[pe + 1] = (c >> 8) & 0xFF;
  f[pe + 2] = (c >> 16) & 0xFF;
  f[pe + 3] = (c >> 24) & 0xFF;
  return f;
}

test('type 51 v21-shaped live frame archives six 100-sample arrays, labeled hypothesis', () => {
  const f51 = withPacketType(fx.v21_real.hex, 51);
  const rec = imuRecordFromFrame(f51, 'puffin', { char: 'FD4B0003', receivedAt: '2026-08-30T10:00:00Z' });
  assert.ok(rec, 'type 51 must not be dropped from imu_raw');
  assert.equal(rec.kind, 'rt51_imu');
  assert.equal(rec.layout, 'whoop5-live51-v21-shape');
  assert.equal(rec.envelope.packet_type, 51);
  assert.equal(rec.envelope.packet_name, 'REALTIME_IMU_DATA_STREAM');
  assert.equal(rec.sample_timestamps, 'not_on_wire');
  for (const k of ['accel_x', 'accel_y', 'accel_z', 'gyro_x', 'gyro_y', 'gyro_z']) {
    assert.equal(rec[k].length, 100, k);
  }
  const v21 = imuRecordFromFrame(Buffer.from(fx.v21_real.hex, 'hex'), 'puffin', {});
  assert.deepEqual(rec.accel_x, v21.accel_x);
  assert.deepEqual(rec.gyro_z, v21.gyro_z);
});

test('observed WHOOP5 type 43 v21-shaped frame decodes and archives six raw arrays', () => {
  const f43 = withPacketType(fx.v21_real.hex, 43);
  const deep = decodeFrame(f43, 'puffin');
  assert.equal(deep.decode_status, 'decoded');
  assert.equal(deep.decoded.kind, 'imu');
  assert.equal(deep.decoded.layout, 'whoop5-v21-shape');
  assert.equal(deep.decoded.variant, '1244(v21-shape-observed)');
  assert.equal(deep.decoded.heart_rate, null, 'observed layout must not invent HR');
  assert.equal(deep.decoded.sample_timestamps, 'not_on_wire');
  for (const key of ['accel_x', 'accel_y', 'accel_z', 'gyro_x', 'gyro_y', 'gyro_z']) {
    assert.equal(deep.decoded[key].length, 100, key);
  }
  const rec = imuRecordFromFrame(f43, 'puffin', { char: 'FD4B0005', seq: 42 });
  assert.ok(rec);
  assert.equal(rec.kind, 'rt43_imu');
  assert.equal(rec.layout, 'v21');
  assert.equal(rec.envelope.packet_name, 'REALTIME_RAW_DATA');
  assert.ok(rec.features && rec.features.enmo_mean != null);
  assert.equal(rec.gyro.scale_status, 'reference_noop_2000dps');
  assert.equal(rec.decoder.deep_sensor, 'frwhoop-deep-sensor/2');
  assert.equal(rec.timestamp_verified, true);
  assert.equal(rec.clock_verified, false);
  const live = imuRecordFromFrame(f43, 'puffin', {
    char: 'FD4B0005',
    seq: 43,
    receivedAt: new Date(rec.sensor_ts * 1000).toISOString(),
  });
  assert.equal(live.timestamp_verified, true);
  assert.equal(live.clock_verified, true);
  assert.equal(live.clock_provenance.reference_source, 'live_receive_time_within_5m');
  for (const key of ['accel_x', 'accel_y', 'accel_z', 'gyro_x', 'gyro_y', 'gyro_z']) {
    assert.deepEqual(rec[key], deep.decoded[key], key);
  }
});

test('type 52 v21-shaped historical IMU stream archives six 100-sample arrays', () => {
  const f52 = withPacketType(fx.v21_real.hex, 52);
  const rec = imuRecordFromFrame(f52, 'puffin', {});
  assert.ok(rec);
  assert.equal(rec.kind, 'hist52_v21');
  assert.equal(rec.envelope.packet_type, 52);
  assert.equal(rec.accel_x.length, 100);
  assert.equal(rec.gyro_y.length, 100);
});

test('unknown packet type is counted and produces no IMU record', () => {
  const unk = withPacketType(fx.v21_real.hex, 99);
  assert.equal(imuRecordFromFrame(unk, 'puffin', {}), null);
  const out = deriveRecords([{ hex: unk.toString('hex'), family: 'puffin', char: 'FD4B0003' }]);
  assert.equal(out.imu.length, 0);
  assert.equal(out.session.packet_census['99'], 1);
  assert.equal(out.session.crc_valid_frames, 1);
});

test('B2 gzip ndjson roundtrip preserves ordered raw LSB arrays', () => {
  const rec = imuRecordFromFrame(Buffer.from(fx.v21_real.hex, 'hex'), 'puffin', {});
  const body = encodeImuArchive([rec]).body;
  const row = JSON.parse(gunzipSync(body).toString('utf8').trim());
  assert.equal(row.accel_x.length, 100);
  assert.equal(row.accel_x[0], rec.accel_x[0]);
  assert.equal(row.accel_x[99], rec.accel_x[99]);
  assert.deepEqual(row.accel_x, rec.accel_x);
  assert.deepEqual(row.gyro_z, rec.gyro_z);
  assert.equal(row.sample_timestamps, 'not_on_wire');
});

test('redecode of the same Level A bytes yields equivalent IMU output', () => {
  const frame = Buffer.from(fx.v21_real.hex, 'hex');
  const rows = [
    { hex: frame.slice(0, 500).toString('hex'), family: 'puffin', char: 'FD4B0003', t: '2026-08-30T10:00:00Z' },
    { hex: frame.slice(500).toString('hex'), family: 'puffin', char: 'FD4B0003', t: '2026-08-30T10:00:00.01Z' },
  ];
  const a = deriveRecords(rows);
  const b = deriveRecords(rows);
  assert.equal(a.imu.length, 1);
  assert.equal(b.imu.length, 1);
  assert.deepEqual(a.imu[0].accel_x, b.imu[0].accel_x);
  assert.deepEqual(a.imu[0].gyro_z, b.imu[0].gyro_z);
  assert.equal(a.imu[0].envelope.frame_hash, b.imu[0].envelope.frame_hash);
  assert.equal(a.imu[0].envelope.frame_hash, decodeFrame(frame, 'puffin').frame_hash);
  assert.ok(a.imu[0].identity?.derived_id);
  assert.equal(a.imu[0].identity.source_frame_hash, a.imu[0].envelope.frame_hash);
  assert.equal(a.imu[0].identity.layout, 'v21');
  assert.equal(a.imu[0].identity.derived_id, b.imu[0].identity.derived_id);
  assert.equal(a.imu[0].accel.scale_g_per_lsb, ACCEL_SCALE_G_PER_LSB);
  assert.equal(a.imu[0].gyro.scale_dps_per_lsb, GYRO_SCALE_DPS_PER_LSB);
});

test('split-frame leftovers survive across deriveRecords calls when reset is false', () => {
  const frame = Buffer.from(fx.v21_real.hex, 'hex');
  const reassemblers = { harvard: null, puffin: null };
  const first = deriveRecords(
    [{ hex: frame.slice(0, 500).toString('hex'), family: 'puffin', char: 'FD4B0003' }],
    { reassemblers, reset: false },
  );
  assert.equal(first.imu.length, 0);
  const second = deriveRecords(
    [{ hex: frame.slice(500).toString('hex'), family: 'puffin', char: 'FD4B0003' }],
    { reassemblers, reset: false },
  );
  assert.equal(second.imu.length, 1);
  assert.equal(second.imu[0].accel_x.length, 100);
  assert.equal(second.imu[0].envelope.frame_hash, decodeFrame(frame, 'puffin').frame_hash);
});
