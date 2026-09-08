/**
 * Raw-stream archival volume estimates (Phase 0).
 *
 * Purpose: size the storage/bandwidth/battery cost of persisting WHOOP 5.0 raw
 * streams BEFORE committing to a layout, per the mission's "measure storage
 * volume, compression ratio, CPU, upload and battery implications before
 * deciding." Pure arithmetic over documented byte widths; the only assumption
 * that materially changes the answer is how many hours of high-rate coverage are
 * captured per day (the `imuHoursPerDay` knob).
 */

const IMU_HZ = 100;
const IMU_AXES = 6;                 // ax,ay,az,gx,gy,gz
const IMU_BYTES_PER_SAMPLE = 2;     // i16
const IMU_BANDWIDTH_BPS = IMU_HZ * IMU_AXES * IMU_BYTES_PER_SAMPLE; // 1200 B/s
const SECONDS_PER_HOUR = 3600;

/** PPG raw-optical estimate (offload buffer): 5 blocks shared; treat ~437 Hz
 *  single-channel as an upper bound following the health-sensor literature. */
const PPG_HZ = 437;
const PPG_BYTES_PER_SAMPLE = 3;     // signed 24-bit
const PPG_BANDWIDTH_BPS = PPG_HZ * PPG_BYTES_PER_SAMPLE; // ~1.3 kB/s

/** RR intervals are tiny: ~1 beat/sec × 2 bytes. */
const RR_BYTES_PER_DAY = 2 * 60 * 60 * 24; // ~172 KB/day raw

/**
 * Estimate daily storage (and per-hour) for a user, raw vs zstd-compressed.
 *
 * @param {object} o
 * @param {number} o.imuHoursPerDay   hours of 100 Hz IMU captured/day (0..24)
 * @param {number} [o.ppgHoursPerDay] hours of raw PPG captured/day
 * @param {number} [o.imuCompression] zstd ratio on columnar i16 (5-15 is realistic)
 * @param {number} [o.ppgCompression]
 * @returns object with raw/compressed MB per day, per session, and MB/s upload
 */
export function estimateRawStorage({
  imuHoursPerDay = 2,
  ppgHoursPerDay = 0,
  imuCompression = 9,
  ppgCompression = 7,
} = {}) {
  const imuSec = imuHoursPerDay * SECONDS_PER_HOUR;
  const ppgSec = ppgHoursPerDay * SECONDS_PER_HOUR;

  const imuRawBytes = IMU_BANDWIDTH_BPS * imuSec;
  const ppgRawBytes = PPG_BANDWIDTH_BPS * ppgSec;

  const imuCompressed = imuRawBytes / imuCompression;
  const ppgCompressed = ppgRawBytes / ppgCompression;

  const totalRawMB = (imuRawBytes + ppgRawBytes + RR_BYTES_PER_DAY) / (1024 ** 2);
  const totalCompressedMB = (imuCompressed + ppgCompressed + RR_BYTES_PER_DAY) / (1024 ** 2);

  // Mobile-upload cost: a typical metered uplink. Convert MB to seconds and a
  // fraction of daily data. (Speed is the caller's knob; here 1 Mbps uplink.)
  const uplinkMbps = 1;
  const uploadSeconds = (totalCompressedMB * 8) / uplinkMbps;
  const fractionOfDay = uploadSeconds / (24 * 3600);

  return {
    imu: {
      hz: IMU_HZ, axes: IMU_AXES, bytesPerSample: IMU_BYTES_PER_SAMPLE,
      hoursPerDay: imuHoursPerDay,
      rawMBPerDay: mb(imuRawBytes), compressedMBPerDay: mb(imuCompressed),
    },
    ppg: {
      hz: PPG_HZ, bytesPerSample: PPG_BYTES_PER_SAMPLE,
      hoursPerDay: ppgHoursPerDay,
      rawMBPerDay: mb(ppgRawBytes), compressedMBPerDay: mb(ppgCompressed),
    },
    rr: { rawBytesPerDay: RR_BYTES_PER_DAY, kbPerDay: RR_BYTES_PER_DAY / 1024 },
    totals: {
      rawMBPerDay: round(totalRawMB, 2), compressedMBPerDay: round(totalCompressedMB, 2),
      uploadSecondsPerDay: round(uploadSeconds, 1), uplinkFractionOfDay: round(fractionOfDay * 100, 3),
    },
  };
}

/** Session (workout/calibration) capture, e.g. the default bounded window. */
export function estimateSessionStorage({
  imuMinutes = 60,
  ppgMinutes = 0,
  imuCompression = 9,
  ppgCompression = 7,
} = {}) {
  const imuRaw = IMU_BANDWIDTH_BPS * imuMinutes * 60;
  const ppgRaw = PPG_BANDWIDTH_BPS * ppgMinutes * 60;
  return {
    imuSessionRawMB: mb(imuRaw),
    imuSessionCompressedMB: mb(imuRaw / imuCompression),
    ppgSessionRawMB: mb(ppgRaw),
    ppgSessionCompressedMB: mb(ppgRaw / ppgCompression),
    totalCompressedSessionMB: round((imuRaw / imuCompression + ppgRaw / ppgCompression) / (1024 ** 2), 3),
  };
}

function mb(bytes) { return round(bytes / (1024 ** 2), 3); }
function round(n, p) { const f = 10 ** p; return Math.round(n * f) / f; }

export { IMU_HZ, IMU_AXES, IMU_BANDWIDTH_BPS, PPG_BANDWIDTH_BPS, RR_BYTES_PER_DAY };
