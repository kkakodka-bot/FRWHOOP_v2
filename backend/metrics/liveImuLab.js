/**
 * Packet-51 / type-43 research capture analysis. Never a production stream.
 * Compact stats only — no raw high-rate arrays persisted here.
 */
import { decodeLive51 } from '../protocol/gen5.js';

function mag3(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function hexToBytes(hex) {
  const s = String(hex || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!s || s.length % 2) return [];
  const out = [];
  for (let i = 0; i < s.length; i += 2) out.push(Number.parseInt(s.slice(i, i + 2), 16));
  return out;
}

export const WRIST51_SCRIPT = Object.freeze([
  { name: 'still', durS: 8 },
  { name: 'wrist_flexion', durS: 8 },
  { name: 'rotation', durS: 8 },
  { name: 'repetitive_curls', durS: 8 },
  { name: 'walking', durS: 8 },
]);

export function analyzeLive51Frames(frames = []) {
  const decoded = [];
  for (const row of frames) {
    const bytes = Array.isArray(row.bytes) ? row.bytes : hexToBytes(row.hex);
    if (!bytes.length) continue;
    const rec = decodeLive51(Buffer.from(bytes));
    decoded.push({ t: row.t ?? null, rec, n: bytes.length });
  }
  const mapped = decoded.filter((d) => d.rec?.mapped);
  if (!frames.length) {
    return {
      frames: 0,
      mapped: 0,
      packet51_unsupported: true,
      reason: 'no_frames',
    };
  }
  if (!mapped.length) {
    return {
      frames: frames.length,
      mapped: 0,
      packet51_unsupported: true,
      reason: 'no_layout_match',
    };
  }
  const first = mapped[0].rec.fields || mapped[0].rec;
  const ax = first.accel_x || first.accelX || [];
  const ay = first.accel_y || first.accelY || [];
  const az = first.accel_z || first.accelZ || [];
  const gx = first.gyro_x || first.gyroX || [];
  const gy = first.gyro_y || first.gyroY || [];
  const gz = first.gyro_z || first.gyroZ || [];
  const shells = [];
  const n = Math.min(ax.length, ay.length, az.length);
  for (let i = 0; i < n; i += 1) shells.push(mag3(ax[i], ay[i], az[i]));
  const gyroN = Math.min(gx.length, gy.length, gz.length);
  let g2 = 0;
  for (let i = 0; i < gyroN; i += 1) g2 += gx[i] ** 2 + gy[i] ** 2 + gz[i] ** 2;
  const ts = mapped.map((d) => d.t).filter((t) => Number.isFinite(t));
  const dt = [];
  for (let i = 1; i < ts.length; i += 1) dt.push(ts[i] - ts[i - 1]);
  const cadenceHz = dt.length ? 1 / (dt.reduce((a, b) => a + b, 0) / dt.length) : null;
  return {
    frames: frames.length,
    mapped: mapped.length,
    packet51_unsupported: false,
    layout: mapped[0].rec.layout || first.layout || null,
    sample_count: n,
    gyro_count: gyroN,
    sample_rate_hz: first.sampleRateHz || first.sample_rate_hz || 100,
    gravity_shell_g: median(shells),
    gyro_present: gyroN > 0,
    gyro_rms: gyroN ? Math.sqrt(g2 / gyroN) : 0,
    axis_rms: {
      x: ax.length ? Math.sqrt(ax.reduce((s, v) => s + v * v, 0) / ax.length) : 0,
      y: ay.length ? Math.sqrt(ay.reduce((s, v) => s + v * v, 0) / ay.length) : 0,
      z: az.length ? Math.sqrt(az.reduce((s, v) => s + v * v, 0) / az.length) : 0,
    },
    packet_cadence_hz: cadenceHz,
    script: WRIST51_SCRIPT,
  };
}

export function analyzeType43Probe({
  frames = 0,
  bytes = 0,
  seconds = 1,
  type40 = 0,
  disconnects = 0,
  errors = 0,
  batteryStart = null,
  batteryEnd = null,
  samplesPerPacket = null,
  gyroPresent = null,
} = {}) {
  const sec = Math.max(0.001, seconds);
  return {
    frames,
    packet_cadence_hz: frames / sec,
    samples_per_packet: samplesPerPacket,
    gyro_present: gyroPresent,
    ble_bytes_per_sec: bytes / sec,
    type40_count: type40,
    type40_continuity: type40 > 0,
    disconnects,
    errors,
    battery_start: batteryStart,
    battery_end: batteryEnd,
    battery_delta: batteryStart != null && batteryEnd != null ? batteryEnd - batteryStart : null,
    disarmed: true,
  };
}
