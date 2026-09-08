import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { verifyFrame } from '../../protocol/framing.js';
import {
  decodeWhoop5ImuV21, decodeWhoop5PpgV26, decodeWhoop5OpticalV20,
  compactMotionFeatures, V20_FORBIDDEN_KEYS, collectKeys,
  ACCEL_SCALE_G_PER_LSB,
} from '../../protocol/deepSensor.js';
import {
  imuV21RecordFromFrame, ppgV26RecordFromFrame, opticalV20RecordFromFrame,
  encodeImuV21Archive, decodeImuV21Archive,
} from '../../protocol/deepSensorArchive.js';
import { eventRecordFromFrame } from '../../protocol/eventRecords.js';
import { deriveRecords } from '../../redecode/derive.js';
import { normalizeHistoricalSample } from '../../ingest/historyBuffer.js';
import { accumulateSteps } from '../../metrics/steps.js';
import { summarizeTemperature } from '../../metrics/temperature.js';
import { sampleMotion } from '../../metrics/workoutDetector.js';
import { crc16Modbus, crc32 } from '../../protocol/crc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sept1 = JSON.parse(fs.readFileSync(
  path.join(here, '../../../docs/research/fixtures/deep_records_2026-09-01.json'),
  'utf8',
));
const fx = JSON.parse(fs.readFileSync(
  path.join(here, '../fixtures/noop-whoop5-parity.json'),
  'utf8',
));

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

test('Sept 1 v21 |a| is near 0.97 g and compact features feed analytics', () => {
  const buf = Buffer.from(sept1.v21_type47_1236.hex, 'hex');
  assert.equal(buf.length, 1244);
  assert.equal(verifyFrame(buf, 'puffin').ok, true);
  const d = decodeWhoop5ImuV21(buf);
  assert.equal(d.ok, true);
  assert.equal(d.frame.source, 'historical');
  const n = d.frame.sample_count;
  let magSum = 0;
  for (let i = 0; i < n; i += 1) {
    const x = d.frame.accel_x_g[i];
    const y = d.frame.accel_y_g[i];
    const z = d.frame.accel_z_g[i];
    magSum += Math.sqrt(x * x + y * y + z * z);
  }
  const meanMag = magSum / n;
  assert.ok(meanMag > 0.85 && meanMag < 1.15, `mean |a|=${meanMag}`);
  const features = compactMotionFeatures(d.frame);
  assert.ok(features);
  assert.equal(features.sample_count, 100);
  assert.ok(features.enmo_mean >= 0);
  const rec = imuV21RecordFromFrame(buf, {});
  assert.equal(rec.accel_x_raw.length, 100);
  const round = decodeImuV21Archive(encodeImuV21Archive([rec]).body);
  assert.equal(round.length, 1);
  assert.deepEqual(round[0].accel_x_raw, rec.accel_x_raw);
  const motion = sampleMotion({ enmo_mean: features.enmo_mean });
  assert.equal(motion, features.enmo_mean);
});

test('Sept 1 type 43 R21 shares v21 decoder as live', () => {
  const buf = Buffer.from(sept1.type43_r21_1236.hex, 'hex');
  assert.equal(buf.length, 1244);
  assert.equal(buf[8], 43);
  assert.equal(verifyFrame(buf, 'puffin').ok, true);
  const d = decodeWhoop5ImuV21(buf);
  assert.equal(d.ok, true);
  assert.equal(d.frame.source, 'live');
  assert.equal(d.frame.packet_type, 43);
  assert.equal(d.frame.gyro_scale_status, 'reference_noop_2000dps');
  assert.equal(d.frame.features.sample_count, 100);
  const rec = imuV21RecordFromFrame(buf, {});
  assert.equal(rec.source, 'live');
  assert.equal(rec.envelope.packet_type, 43);
});

test('v26 24-sample waveform has features and no spo2/wavelength', () => {
  const buf = Buffer.from(fx.v26_real.hex, 'hex');
  const d = decodeWhoop5PpgV26(buf);
  assert.equal(d.ok, true);
  assert.equal(d.frame.sample_count, 24);
  assert.ok(d.frame.features);
  const rec = ppgV26RecordFromFrame(buf);
  assert.equal(rec.samples.length, 24);
  const keys = collectKeys(rec);
  for (const bad of ['spo2', 'wavelength']) {
    assert.equal([...keys].some((k) => k.toLowerCase() === bad), false, bad);
  }
});

test('v20 stays channel_a/channel_b with v20_block aliases', () => {
  const buf = Buffer.from(sept1.v20_type47_2132.hex, 'hex');
  const d = decodeWhoop5OpticalV20(buf);
  assert.equal(d.ok, true);
  assert.ok(d.frame.v20_block_0);
  assert.ok(d.frame.features);
  const rec = opticalV20RecordFromFrame(buf);
  const keys = [...collectKeys(rec)].map((k) => k.toLowerCase());
  for (const bad of V20_FORBIDDEN_KEYS) {
    assert.equal(keys.includes(bad), false, bad);
  }
});

test('CRC-corrupt v21 produces no trusted physiology', () => {
  const good = Buffer.from(sept1.v21_type47_1236.hex, 'hex');
  const bad = Buffer.from(good);
  bad[40] ^= 0xFF;
  assert.equal(verifyFrame(bad, 'puffin').ok, false);
  assert.equal(decodeWhoop5ImuV21(bad).ok, false);
  const derived = deriveRecords(
    [{ hex: bad.toString('hex'), family: 'puffin', t: '2026-09-01T12:00:00Z' }],
    { family: 'puffin' },
  );
  assert.equal(derived.imu.length, 0);
  assert.equal(derived.whoop5Imu.length, 0);
  assert.ok(derived.session.crc_invalid_frames >= 1);
});

test('v18 steps and skin temp survive normalize → reducers', () => {
  const expect = fx.v18[0].expect;
  const t0 = '2026-09-01T12:00:00.000Z';
  const t1 = '2026-09-01T12:00:01.000Z';
  const a = normalizeHistoricalSample({
    t: t0, seq: 1, bpm: expect.heart_rate,
    step_cumulative: expect.step_motion_counter,
    skin_temp_c: expect.skin_temp_raw / 100,
    skin_temp_raw: expect.skin_temp_raw,
    layout: 'v18', family: 'puffin', decoder: 'test',
  });
  const b = normalizeHistoricalSample({
    t: t1, seq: 2, bpm: expect.heart_rate,
    step_cumulative: expect.step_motion_counter + 8,
    skin_temp_c: expect.skin_temp_raw / 100,
    layout: 'v18', family: 'puffin', decoder: 'test',
  });
  assert.ok(a && b);
  assert.equal(a.step_cumulative, 50);
  const steps = accumulateSteps([a, b], { timeZone: 'UTC' });
  assert.equal(steps.total, 8);
  const temp = summarizeTemperature([a, b], { timeZone: 'UTC' });
  assert.ok(temp.sample_count >= 1);
});

test('event 3 battery counter is on the event record', () => {
  const ev = new Uint8Array(44); ev[0] = 0xAA; ev[8] = 48; ev[10] = 3;
  const dv = new DataView(ev.buffer);
  dv.setUint32(12, 1784054004, true);
  dv.setUint16(21, 780, true);
  dv.setUint16(25, 3900, true);
  dv.setUint16(27, 11, true);
  ev[30] = 0;
  const rec = eventRecordFromFrame(ev, 'puffin', {});
  assert.equal(rec.battery_pct, 78);
  assert.equal(rec.battery_counter, 11);
});

test('accel scale is 1/4096 g and gyro dps stays a reference', () => {
  assert.equal(ACCEL_SCALE_G_PER_LSB, 1 / 4096);
  const buf = Buffer.from(sept1.v21_type47_1236.hex, 'hex');
  const d = decodeWhoop5ImuV21(buf);
  assert.equal(d.frame.gyro_scale_status, 'reference_noop_2000dps');
});
