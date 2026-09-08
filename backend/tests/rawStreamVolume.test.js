import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateRawStorage, estimateSessionStorage,
  IMU_BANDWIDTH_BPS, RR_BYTES_PER_DAY,
} from '../energy/rawStreamVolume.js';

test('imu bandwidth is 100 Hz * 6 axes * 2 bytes = 1200 B/s', () => {
  assert.equal(IMU_BANDWIDTH_BPS, 1200);
});

test('24h full IMU coverage is ~99 MB/day raw, ~11 MB compressed (zstd 9x)', () => {
  const e = estimateRawStorage({ imuHoursPerDay: 24 });
  assert.ok(e.imu.rawMBPerDay > 95 && e.imu.rawMBPerDay < 105, `raw ${e.imu.rawMBPerDay}`);
  assert.ok(e.imu.compressedMBPerDay > 8 && e.imu.compressedMBPerDay < 16, `cmp ${e.imu.compressedMBPerDay}`);
});

test('bounded window capture (45 min) is ~0.34 MB compressed per session', () => {
  const e = estimateSessionStorage({ imuMinutes: 45 });
  assert.ok(e.totalCompressedSessionMB > 0.2 && e.totalCompressedSessionMB < 0.5,
    `session ${e.totalCompressedSessionMB}`);
});

test('RR intervals are tiny (~169 KB/day) regardless of IMU hours', () => {
  assert.equal(RR_BYTES_PER_DAY, 172800);
});

test('doubling IMU coverage adds almost exactly one day-equivalent of IMU bytes', () => {
  // RR bytes are a small constant; the difference between 1h and 2h of IMU is
  // exactly 1 hour of IMU at constant compression.
  const a = estimateRawStorage({ imuHoursPerDay: 1 });
  const b = estimateRawStorage({ imuHoursPerDay: 2 });
  const hourImuCmpMB = (IMU_BANDWIDTH_BPS * 3600 / 9) / (1024 ** 2); // ~0.458 MB
  assert.ok(Math.abs((b.totals.compressedMBPerDay - a.totals.compressedMBPerDay) - hourImuCmpMB) < 0.01,
    `diff ${b.totals.compressedMBPerDay - a.totals.compressedMBPerDay} vs ${hourImuCmpMB}`);
});
