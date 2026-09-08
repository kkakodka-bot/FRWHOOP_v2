import {
  ACCEL_SCALE_G_PER_LSB,
  GYRO_SCALE_DPS_PER_LSB,
  IMU_ARCHIVE_SCHEMA,
} from '../protocol/imuArchive.js';

export function makeImuRecords({ seconds, accelAt, gyroAt, t0 }) {
  const records = [];
  for (let s = 0; s < seconds; s += 1) {
    const ax = []; const ay = []; const az = [];
    const gx = []; const gy = []; const gz = [];
    for (let i = 0; i < 100; i += 1) {
      const t = s + i / 100;
      const a = accelAt(t);
      const g = gyroAt ? gyroAt(t) : { x: 0, y: 0, z: 0 };
      ax.push(Math.round(a.x / ACCEL_SCALE_G_PER_LSB));
      ay.push(Math.round(a.y / ACCEL_SCALE_G_PER_LSB));
      az.push(Math.round(a.z / ACCEL_SCALE_G_PER_LSB));
      gx.push(Math.round(g.x / GYRO_SCALE_DPS_PER_LSB));
      gy.push(Math.round(g.y / GYRO_SCALE_DPS_PER_LSB));
      gz.push(Math.round(g.z / GYRO_SCALE_DPS_PER_LSB));
    }
    records.push({
      schema: IMU_ARCHIVE_SCHEMA,
      kind: 'hist_v21',
      layout: 'v21',
      sensor_ts: t0 + s,
      sample_rate_hz: 100,
      accel_x: ax, accel_y: ay, accel_z: az,
      gyro_x: gx, gyro_y: gy, gyro_z: gz,
      accel: { scale_g_per_lsb: ACCEL_SCALE_G_PER_LSB },
      gyro: { scale_dps_per_lsb: GYRO_SCALE_DPS_PER_LSB },
    });
  }
  return records;
}

export function walkAccel(t, spm, amp = 0.34) {
  const stepHz = spm / 60;
  const phase = 2 * Math.PI * stepHz * t;
  const frac = (t * stepHz) % 1;
  const impulse = Math.exp(-((frac - 0.04) ** 2) / 0.0008);
  return {
    x: 0.12 + 0.10 * Math.sin(phase),
    y: 0.04,
    z: 1.0 + amp * Math.sin(phase) + 0.28 * impulse,
  };
}

export function walkGyro(t, spm) {
  const swingHz = (spm / 60) / 2;
  return { x: 4 * Math.sin(2 * Math.PI * swingHz * t), y: 55 * Math.sin(2 * Math.PI * swingHz * t), z: 3 };
}
