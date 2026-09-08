// Live-path integration: frame flush derives + archives the high-value streams
// (imu_raw / events / console_logs / cmd_battery) through engine.archiveDerivedStream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHourBuffer } from '../ingest/hourBuffer.js';
import { decodeFrame } from '../protocol/decoder.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/noop-whoop5-parity.json'), 'utf8'));

function frameRows() {
  const frame = Buffer.from(fx.v21_real.hex, 'hex');
  return [
    { hex: frame.slice(0, 500).toString('hex'), char: 'FD4B0003', family: 'puffin', fw: '50.35.5', t: '2026-08-30T17:59:50.000Z', seq: 1 },
    { hex: frame.slice(500).toString('hex'), char: 'FD4B0003', family: 'puffin', fw: '50.35.5', t: '2026-08-30T17:59:50.010Z', seq: 2 },
  ];
}

test('frame-only flush archives IMU and recomputes from already persisted day samples', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-derived-'));
  const derivedCalls = [];
  const frameCalls = [];
  const computedCalls = [];
  const buf = createHourBuffer({
    dir,
    userId: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
    chunkMs: 3600_000,
    now: () => new Date('2026-08-30T17:59:50.100Z'),
    engine: {
      archiveRawSamples: async () => ({ status: 'ready' }),
      archiveRawFrames: async (args) => {
        frameCalls.push(args);
        return { id: 'frames-obj', status: 'ready' };
      },
      archiveDerivedStream: async (args) => {
        derivedCalls.push(args);
        return { id: 'derived-obj', status: 'ready' };
      },
      persistComputed: async (args) => {
        computedCalls.push(args);
        return { ok: true };
      },
    },
  });

  for (let index = 0; index < 20; index += 1) {
    buf.append({
      datetime: new Date(Date.parse('2026-08-30T17:59:00.000Z') + index * 1000).toISOString(),
      bpm: 60,
    });
  }
  await buf.flush();
  computedCalls.length = 0;
  for (const row of frameRows()) buf.appendFrame(row);
  assert.equal(buf.pendingFrameCount(), 2);
  const flush = await buf.flush();
  assert.ok(flush.frames);
  assert.equal(frameCalls.length, 1, 'Level A frames archived');
  assert.ok(flush.frames.derived, 'derived summary attached');
  assert.equal(flush.frames.derived.imu, 1, 'one v21 IMU record derived');
  const imuCall = derivedCalls.find((c) => c.stream === 'imu_raw');
  const deepImuCall = derivedCalls.find((c) => c.stream === 'whoop5_imu_v21');
  assert.ok(imuCall, 'imu_raw reached the engine');
  assert.ok(deepImuCall, 'whoop5_imu_v21 reached the engine');
  assert.equal(imuCall.records.length, 1);
  const rec = imuCall.records[0];
  assert.equal(rec.kind, 'hist_v21');
  const sensorIso = new Date((Number(rec.sensor_ts) > 1e12 ? rec.sensor_ts : rec.sensor_ts * 1000)).toISOString();
  assert.equal(imuCall.startAt, sensorIso);
  assert.equal(imuCall.extras.periodDay, sensorIso.slice(0, 10));
  assert.equal(frameCalls[0].startAt, sensorIso);
  assert.equal(frameCalls[0].extras.historyBackfill, true);
  assert.equal(rec.accel_x.length, 100);
  assert.equal(rec.gyro_z.length, 100);
  assert.equal(rec.firmware.fw, '50.35.5');
  assert.equal(
    computedCalls.some((call) => call.extras?.imuRecords?.length === 1),
    true,
    'the final derived IMU batch triggers a metric recomputation',
  );
  // record arrays equal the decoder output (raw LSBs end-to-end)
  const frame = Buffer.from(fx.v21_real.hex, 'hex');
  const parsed = decodeFrame(frame, 'puffin').decoded.parsed;
  assert.deepEqual(rec.accel_x, parsed.accel_x);
  assert.deepEqual(rec.accel_y, parsed.accel_y);
  assert.deepEqual(rec.accel_z, parsed.accel_z);
  assert.deepEqual(rec.gyro_x, parsed.gyro_x);
  assert.deepEqual(rec.gyro_y, parsed.gyro_y);
  assert.deepEqual(rec.gyro_z, parsed.gyro_z);
  // WAL trimmed after success
  assert.equal(fs.existsSync(path.join(dir, '7f2c9a10-4b3e-4d8a-9c11-00000000f001', 'derived-wal.ndjson'))
    && fs.readFileSync(path.join(dir, '7f2c9a10-4b3e-4d8a-9c11-00000000f001', 'derived-wal.ndjson'), 'utf8').trim().length > 0, false);
});

test('derived failure keeps the WAL and never fails the frame flush', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-derived2-'));
  let failDerived = true;
  const buf = createHourBuffer({
    dir,
    userId: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
    chunkMs: 3600_000,
    now: () => new Date('2026-08-30T17:59:50.100Z'),
    engine: {
      archiveRawSamples: async () => ({ status: 'ready' }),
      archiveRawFrames: async () => ({ id: 'f', status: 'ready' }),
      archiveDerivedStream: async () => ({ id: 'x', status: 'retrying' }),
    },
  });
  for (const row of frameRows()) buf.appendFrame(row);
  const flush = await buf.flush(); // must NOT throw
  assert.ok(flush.frames?.archived);
  // derived WAL retains the records for retry
  const wal = path.join(dir, '7f2c9a10-4b3e-4d8a-9c11-00000000f001', 'derived-wal.ndjson');
  assert.ok(fs.existsSync(wal), 'derived WAL retained on failure');
  assert.ok(fs.readFileSync(wal, 'utf8').includes('"stream":"imu_raw"'));
});

test('derived flush is recovered from the WAL on the next buffer instance', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-derived3-'));
  const userDir = path.join(dir, '7f2c9a10-4b3e-4d8a-9c11-00000000f001');
  fs.mkdirSync(userDir, { recursive: true });
  const frame = Buffer.from(fx.v21_real.hex, 'hex');
  // Seed a derived WAL row exactly as a failed flush would have left it.
  const rec = {
    stream: 'imu_raw',
    record: {
      schema: 'frwhoop_imu_raw_v1', kind: 'hist_v21', family: 'puffin', layout: 'v21',
      sensor_ts: 1784037165, received_at: '2026-08-30T10:00:00Z',
      samples_per_axis: 100, sample_rate_hz: 100,
      accel: { unit: 'g', scale_g_per_lsb: 1 / 4096 }, gyro: { unit: 'dps', scale_dps_per_lsb: 2000 / 32768 },
      accel_x: [1], accel_y: [2], accel_z: [3], gyro_x: [0], gyro_y: [0], gyro_z: [0],
      envelope: { packet_type: 47, frame_hash: 'h', frame_length: 1244, crc_ok: true },
      firmware: { fw: '50.35.5', model: null }, transport: { char: 'FD4B0003', seq: 1 },
      decoder: { version: 'frwhoop-js/1', lineage: 'x' },
    },
  };
  fs.writeFileSync(path.join(userDir, 'derived-wal.ndjson'), JSON.stringify(rec) + '\n');
  const derivedCalls = [];
  const buf = createHourBuffer({
    dir,
    userId: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
    now: () => new Date('2026-08-30T18:00:00.000Z'),
    engine: {
      archiveRawSamples: async () => ({ status: 'ready' }),
      archiveRawFrames: async () => null,
      archiveDerivedStream: async (args) => { derivedCalls.push(args); return { status: 'ready' }; },
    },
  });
  // a plain flush must drain the recovered WAL
  buf.append({ datetime: '2026-08-30T18:00:00.500Z', bpm: 61 });
  await buf.flush();
  assert.equal(derivedCalls.length, 1);
  assert.equal(derivedCalls[0].stream, 'imu_raw');
});

test('imu_raw archives split onto each sensor day, not the receive hour', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-derived-days-'));
  const userDir = path.join(dir, '7f2c9a10-4b3e-4d8a-9c11-00000000f001');
  fs.mkdirSync(userDir, { recursive: true });
  const stub = (sensor_ts, received_at) => ({
    stream: 'imu_raw',
    record: {
      schema: 'frwhoop_imu_raw_v1', kind: 'hist_v21', family: 'puffin', layout: 'v21',
      sensor_ts, received_at,
      samples_per_axis: 100, sample_rate_hz: 100,
      accel: { unit: 'g', scale_g_per_lsb: 1 / 4096 }, gyro: { unit: 'dps', scale_dps_per_lsb: 2000 / 32768 },
      accel_x: [1], accel_y: [2], accel_z: [3], gyro_x: [0], gyro_y: [0], gyro_z: [0],
      envelope: { packet_type: 47, frame_hash: `h-${sensor_ts}`, frame_length: 1244, crc_ok: true },
      firmware: { fw: '50.35.5', model: null }, transport: { char: 'FD4B0003', seq: 1 },
      decoder: { version: 'frwhoop-js/1', lineage: 'x' },
    },
  });
  const dayA = Math.floor(Date.parse('2026-08-24T04:00:00.000Z') / 1000);
  const dayB = Math.floor(Date.parse('2026-08-30T10:00:00.000Z') / 1000);
  fs.writeFileSync(
    path.join(userDir, 'derived-wal.ndjson'),
    `${JSON.stringify(stub(dayA, '2026-08-31T18:00:00Z'))}\n${JSON.stringify(stub(dayB, '2026-08-31T18:00:01Z'))}\n`,
  );
  const derivedCalls = [];
  const buf = createHourBuffer({
    dir,
    userId: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
    now: () => new Date('2026-08-31T18:00:02.000Z'),
    engine: {
      archiveRawSamples: async () => ({ status: 'ready' }),
      archiveRawFrames: async () => null,
      archiveDerivedStream: async (args) => { derivedCalls.push(args); return { status: 'ready' }; },
    },
  });
  buf.append({ datetime: '2026-08-31T18:00:02.000Z', bpm: 61 });
  await buf.flush();
  assert.equal(derivedCalls.length, 2);
  const days = derivedCalls.map((c) => c.extras.periodDay).sort();
  assert.deepEqual(days, ['2026-08-24', '2026-08-30']);
});
