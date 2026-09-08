import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { crc16Modbus, crc32 } from '../../protocol/crc.js';
import { verifyFrame } from '../../protocol/framing.js';
import { sha256 } from '../../protocol/decoder.js';
import {
  decodeWhoop5ImuV21, decodeWhoop5PpgV26, decodeWhoop5OpticalV20,
  reconstructV20Header, collectKeys, V20_FORBIDDEN_KEYS,
  ACCEL_SCALE_G_PER_LSB, GYRO_SCALE_DPS_PER_LSB,
  V21_FRAME_LEN, V26_FRAME_LEN, V20_FRAME_LEN,
  DEEP_SENSOR_DECODER_VERSION, gravityShellStats, gyroStats,
} from '../../protocol/deepSensor.js';
import {
  imuV21RecordFromFrame, ppgV26RecordFromFrame, opticalV20RecordFromFrame,
  encodeImuV21Archive, decodeImuV21Archive,
  encodePpgV26Archive, decodePpgV26Archive,
  encodeOpticalV20Archive, decodeOpticalV20Archive,
  dedupeDeepRecords, deepSensorRecordsFromFrame,
} from '../../protocol/deepSensorArchive.js';
import { imuRecordFromFrame } from '../../protocol/imuArchive.js';
import { ppgRecordFromFrame } from '../../protocol/ppgArchive.js';
import { deriveRecords } from '../../redecode/derive.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(fs.readFileSync(path.join(here, '../fixtures/noop-whoop5-parity.json'), 'utf8'));

function bytes(hex) {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function recrcPuffin(src) {
  const f = Array.from(src);
  const declared = f[2] | (f[3] << 8);
  const total = declared + 8;
  const payloadEnd = total - 4;
  const c16 = crc16Modbus(f, 0, 6);
  f[6] = c16 & 0xFF;
  f[7] = (c16 >> 8) & 0xFF;
  const c32 = crc32(f, 8, payloadEnd);
  f[payloadEnd] = c32 & 0xFF;
  f[payloadEnd + 1] = (c32 >> 8) & 0xFF;
  f[payloadEnd + 2] = (c32 >> 16) & 0xFF;
  f[payloadEnd + 3] = (c32 >> 24) & 0xFF;
  return Uint8Array.from(f);
}

function putU16(buf, off, v) {
  buf[off] = v & 0xFF;
  buf[off + 1] = (v >> 8) & 0xFF;
}

const v21 = bytes(fx.v21_real.hex);
const v26 = bytes(fx.v26_real.hex);
const v20 = bytes(fx.v20_real.hex);
const v18 = bytes(fx.v18[0].hex);

test('fixtures are CRC-valid puffin frames at exact contract lengths', () => {
  assert.equal(v21.length, V21_FRAME_LEN);
  assert.equal(v26.length, V26_FRAME_LEN);
  assert.equal(v20.length, V20_FRAME_LEN);
  assert.equal(verifyFrame(v21, 'puffin').ok, true);
  assert.equal(verifyFrame(v26, 'puffin').ok, true);
  assert.equal(verifyFrame(v20, 'puffin').ok, true);
  assert.equal(v21[8], 47); assert.equal(v21[9], 21);
  assert.equal(v26[8], 47); assert.equal(v26[9], 26);
  assert.equal(v20[8], 47); assert.equal(v20[9], 20);
});

// ---- v21 ----

test('v21 rejects non-1244 frame', () => {
  assert.equal(decodeWhoop5ImuV21(v21.slice(0, 1243)).reason, 'not_1244');
  assert.equal(decodeWhoop5ImuV21(v21.slice(0, 244)).reason, 'not_1244');
  const padded = Uint8Array.from([...v21, 0]);
  assert.equal(decodeWhoop5ImuV21(padded).reason, 'not_1244');
});

test('v21 rejects wrong type', () => {
  const f = Array.from(v21);
  f[8] = 40;
  assert.equal(decodeWhoop5ImuV21(recrcPuffin(f)).reason, 'wrong_type');
});

test('v21 rejects wrong version', () => {
  const f = Array.from(v21);
  f[9] = 20;
  assert.equal(decodeWhoop5ImuV21(recrcPuffin(f)).reason, 'wrong_version');
});

test('v21 rejects countA != 100 and countB != 100', () => {
  const a = Array.from(v21);
  putU16(a, 24, 30);
  assert.equal(decodeWhoop5ImuV21(recrcPuffin(a)).reason, 'countA');
  const b = Array.from(v21);
  putU16(b, 630, 12);
  assert.equal(decodeWhoop5ImuV21(recrcPuffin(b)).reason, 'countB');
});

test('v21 extracts exactly 100 samples on all six axes with exact scales', () => {
  const d = decodeWhoop5ImuV21(v21);
  assert.equal(d.ok, true);
  const f = d.frame;
  assert.equal(f.sample_count, 100);
  for (const k of ['accel_x_raw', 'accel_y_raw', 'accel_z_raw', 'gyro_x_raw', 'gyro_y_raw', 'gyro_z_raw']) {
    assert.equal(f[k].length, 100);
  }
  const ax0 = v21[28] | (v21[29] << 8);
  const ax0s = ax0 << 16 >> 16;
  assert.equal(f.accel_x_raw[0], ax0s);
  assert.equal(f.accel_x_g[0], ax0s * ACCEL_SCALE_G_PER_LSB);
  assert.equal(ACCEL_SCALE_G_PER_LSB, 1 / 4096);
  const gx0 = v21[640] | (v21[641] << 8);
  const gx0s = gx0 << 16 >> 16;
  assert.equal(f.gyro_x_raw[0], gx0s);
  assert.equal(f.gyro_x_dps[0], gx0s * GYRO_SCALE_DPS_PER_LSB);
  assert.equal(GYRO_SCALE_DPS_PER_LSB, 2000 / 32768);
  assert.equal(f.source_frame_hash, sha256(v21));
  assert.equal(f.decoder_version, DEEP_SENSOR_DECODER_VERSION);
});

test('v21 does not read past the frame', () => {
  const d = decodeWhoop5ImuV21(v21);
  const lastGyroZOff = 1040 + 99 * 2;
  assert.ok(lastGyroZOff + 2 <= v21.length - 4);
  assert.equal(d.frame.gyro_z_raw[99], (v21[lastGyroZOff] | (v21[lastGyroZOff + 1] << 8)) << 16 >> 16);
});

test('FRWHOOP 09-01 complete v21 fixture gravity shell is near 1 g and gyro is not a zero stream', () => {
  const fixPath = path.join(here, '../../../docs/research/fixtures/deep_records_2026-09-01.json');
  const fix = JSON.parse(fs.readFileSync(fixPath, 'utf8'));
  const buf = Buffer.from(fix.v21_type47_1236.hex, 'hex');
  const d = decodeWhoop5ImuV21(buf);
  assert.equal(d.ok, true);
  const g = gravityShellStats([d.frame]);
  assert.ok(g.n === 100);
  assert.ok(g.median > 0.85 && g.median < 1.15, `median |a|=${g.median}`);
  assert.ok(g.fraction_0_5_to_1_5_g > 0.9);
  const gy = gyroStats([d.frame]);
  assert.equal(gy.garbage_zero_stream, false);
  const d20 = decodeWhoop5OpticalV20(Buffer.from(fix.v20_type47_2132.hex, 'hex'));
  assert.equal(d20.ok, true);
  assert.deepEqual(d20.frame.sample_count_pattern, [25, 0, 0, 25, 25]);
});

// ---- v26 ----

test('v26 exact 88-byte and type/version gates', () => {
  assert.equal(decodeWhoop5PpgV26(v26.slice(0, 87)).reason, 'not_88');
  const t = Array.from(v26); t[8] = 40;
  assert.equal(decodeWhoop5PpgV26(recrcPuffin(t)).reason, 'wrong_type');
  const v = Array.from(v26); v[9] = 18;
  assert.equal(decodeWhoop5PpgV26(recrcPuffin(v)).reason, 'wrong_version');
});

test('v26 extracts exactly 24 signed i16 samples and keeps timestamp + raw metadata', () => {
  const d = decodeWhoop5PpgV26(v26);
  assert.equal(d.ok, true);
  assert.equal(d.frame.samples.length, 24);
  assert.deepEqual(d.frame.samples, fx.v26_real.expect.waveform);
  assert.ok(d.frame.samples.some((s) => s < 0), 'sign handling');
  assert.equal(d.frame.base_ts, fx.v26_real.expect.unix);
  assert.equal(d.frame.raw_byte_12, v26[12]);
  assert.equal(d.frame.raw_19_26.length, 8);
  assert.equal(d.frame.raw_75_83.length, 9);
  assert.equal(d.frame.nominal_sample_rate_hz, 24);
  const keys = collectKeys(d.frame);
  for (const bad of ['red', 'infrared', 'green', 'wavelength', 'spo2']) {
    assert.equal(keys.has(bad), false, `no ${bad} field`);
  }
});

// ---- v20 ----

test('v20 exact 2140-byte gate and five 422-byte blocks', () => {
  assert.equal(decodeWhoop5OpticalV20(v20.slice(0, 2139)).reason, 'not_2140');
  assert.equal(decodeWhoop5OpticalV20(v20.slice(0, 244)).reason, 'not_2140');
  const d = decodeWhoop5OpticalV20(v20);
  assert.equal(d.ok, true);
  assert.equal(d.frame.block_count, 5);
  for (let b = 0; b < 5; b += 1) {
    const block = d.frame[`block_${b}`];
    assert.equal(block.raw_header.length, 21);
    assert.equal(block.unused_a_raw.length + block.channel_a.length * 4, 200);
    assert.equal(block.unused_b_raw.length + block.channel_b.length * 4, 200);
    assert.equal(block.channel_a.length, block.sample_count);
    assert.equal(block.channel_b.length, block.sample_count);
    assert.ok(block.sample_count <= 50);
    assert.deepEqual(reconstructV20Header(block), block.raw_header);
    assert.equal(typeof block.reserved, 'number');
  }
});

test('v20 reads signed Int32 and keeps unused + reserved bytes', () => {
  const d = decodeWhoop5OpticalV20(v20);
  assert.equal(d.frame.block_0.channel_a[0], fx.v20_real.expect.channel_b0_0_first);
  assert.equal(d.frame.block_0.channel_b[0], fx.v20_real.expect.channel_b0_1_first);
  assert.ok(d.frame.block_0.channel_b[0] < 0);
  assert.deepEqual(d.frame.sample_count_pattern, [25, 0, 0, 25, 25]);
  const keys = [...collectKeys(d.frame)].map((k) => k.toLowerCase());
  for (const bad of V20_FORBIDDEN_KEYS) {
    assert.equal(keys.includes(bad), false, `forbidden key ${bad}`);
  }
});

test('v20 sample_count > 50 fails closed', () => {
  const f = Array.from(v20);
  f[26] = 51;
  assert.equal(decodeWhoop5OpticalV20(recrcPuffin(f)).reason, 'sample_count');
});

// ---- replay / identity ----

test('v21 live decode matches archive replay and second replay does not duplicate', () => {
  const direct = decodeWhoop5ImuV21(v21).frame;
  const rec = imuV21RecordFromFrame(v21, { fw: '50.35.5', sourceObjectId: 'obj-a' });
  assert.deepEqual(rec.accel_x_raw, direct.accel_x_raw);
  assert.deepEqual(rec.gyro_z_dps, direct.gyro_z_dps);
  assert.equal(rec.envelope.frame_hash, direct.source_frame_hash);
  const body = encodeImuV21Archive([rec, rec]).body;
  const replayed = decodeImuV21Archive(body);
  assert.equal(replayed.length, 1);
  assert.deepEqual(replayed[0].accel_x_g, rec.accel_x_g);
  assert.equal(replayed[0].identity.derived_id, rec.identity.derived_id);
  assert.equal(dedupeDeepRecords([rec, { ...rec }]).length, 1);
});

test('v26 and v20 archive round-trip; corrupt CRC produces no trusted record', () => {
  const p = ppgV26RecordFromFrame(v26);
  const o = opticalV20RecordFromFrame(v20);
  assert.equal(decodePpgV26Archive(encodePpgV26Archive([p, p]).body).length, 1);
  assert.equal(decodeOpticalV20Archive(encodeOpticalV20Archive([o, o]).body).length, 1);
  const corrupt = Array.from(v21);
  corrupt[40] ^= 0xFF;
  assert.equal(verifyFrame(corrupt, 'puffin').ok, false);
  assert.equal(decodeWhoop5ImuV21(corrupt).ok, false);
  assert.equal(imuV21RecordFromFrame(corrupt), null);
  assert.equal(ppgV26RecordFromFrame(Array.from(v26).map((b, i) => (i === 30 ? b ^ 1 : b))), null);
});

test('imu_raw hist_v21 is enriched with scaled arrays; product PIP ppg_raw is unchanged', () => {
  const imu = imuRecordFromFrame(v21, 'puffin', {});
  assert.equal(imu.accel_x.length, 100);
  assert.equal(imu.accel_x_g.length, 100);
  assert.equal(imu.gyro_x_dps.length, 100);
  assert.equal(imu.sample_time_s.length, 100);
  const pip = ppgRecordFromFrame(v26, 'puffin', {});
  assert.equal(pip.samples.length, 25);
  const deep = ppgV26RecordFromFrame(v26);
  assert.equal(deep.samples.length, 24);
  assert.deepEqual(deep.samples, fx.v26_real.expect.waveform);
});

test('deriveRecords emits dedicated deep streams without dropping PIP/imu_raw', () => {
  const rows = [
    { hex: fx.v21_real.hex, family: 'puffin', char: 'FD4B0003', t: '2026-08-30T10:00:00Z' },
    { hex: fx.v26_real.hex, family: 'puffin', char: 'FD4B0003', t: '2026-08-30T10:00:01Z' },
    { hex: fx.v20_real.hex, family: 'puffin', char: 'FD4B0003', t: '2026-08-30T10:00:02Z' },
    { hex: fx.v18[0].hex, family: 'puffin', char: 'FD4B0003', t: '2026-08-30T10:00:03Z' },
  ];
  const d = deriveRecords(rows, { family: 'puffin' });
  assert.equal(d.imu.length, 1);
  assert.equal(d.ppg.length, 1);
  assert.equal(d.whoop5Imu.length, 1);
  assert.equal(d.whoop5Ppg.length, 1);
  assert.equal(d.whoop5Optical.length, 1);
  assert.equal(d.whoop5Ppg[0].samples.length, 24);
  assert.equal(d.ppg[0].samples.length, 25);
  const again = deepSensorRecordsFromFrame(v18, 'puffin', {});
  assert.equal(again.imu, null);
  assert.equal(again.ppg, null);
  assert.equal(again.optical, null);
});

test('type 43 R21 shares the v21 decoder with compact features and live source', () => {
  const f = Array.from(v21);
  f[8] = 43;
  const live = recrcPuffin(f);
  const d = decodeWhoop5ImuV21(live);
  assert.equal(d.ok, true);
  assert.equal(d.frame.source, 'live');
  assert.equal(d.frame.packet_type, 43);
  assert.equal(d.frame.gyro_scale_status, 'reference_noop_2000dps');
  assert.equal(d.frame.sample_count, 100);
  assert.ok(d.frame.features);
  assert.equal(d.frame.features.sample_count, 100);
  assert.ok(d.frame.features.accel_rms_g > 0.5);
  const rec = imuV21RecordFromFrame(live, {});
  assert.equal(rec.source, 'live');
  assert.equal(rec.envelope.packet_type, 43);
  assert.deepEqual(rec.accel_x_raw, d.frame.accel_x_raw);
});

test('v21 compact features and v26/v20 diagnostics attach without forbidden labels', () => {
  const imu = decodeWhoop5ImuV21(v21);
  assert.equal(imu.ok, true);
  assert.equal(imu.frame.gyro_scale_status, 'reference_noop_2000dps');
  assert.ok(imu.frame.features.enmo_mean >= 0);
  const ppg = decodeWhoop5PpgV26(v26);
  assert.equal(ppg.ok, true);
  assert.equal(ppg.frame.sample_count, 24);
  assert.ok(ppg.frame.features);
  assert.equal(ppg.frame.features.sample_count, 24);
  const keys = collectKeys(ppg.frame);
  for (const bad of ['spo2', 'wavelength']) {
    assert.equal(keys.has(bad), false, bad);
  }
  const opt = decodeWhoop5OpticalV20(v20);
  assert.equal(opt.ok, true);
  assert.ok(opt.frame.v20_block_0);
  assert.ok(opt.frame.features);
  const optKeys = [...collectKeys(opt.frame)].map((k) => k.toLowerCase());
  for (const bad of V20_FORBIDDEN_KEYS) {
    assert.equal(optKeys.includes(bad), false, `forbidden key ${bad}`);
  }
});
