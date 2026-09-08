/**
 * Wrist-dataset adapter (Phase 9) — reduces a public wrist dataset to a common
 * representation the energy model + ground-truth layer can score.
 *
 * The adapter is STRUCTURE-TOLERANT: different datasets (WEEE, etc.) lay files
 * out differently, so instead of hard-coding one tree it discovers sensor and
 * ground-truth sources by path/key heuristics and normalizes them to a common
 * per-participant, per-segment record:
 *
 *   { participant, activity, device, sampleRate,
 *     accel: {ax,ay,az}[], gyro?: {gx,gy,gz}[],
 *     gt: { vo2MlPerKgMin | vo2LPerMin | met | kcalPerMin | rer, weightKg } }
 *
 * The energy engine does not need raw WHOOP packets; it needs the *feature*
 * space (HR, scalar motion, RR, sleep, activity label). WEEE provides wrist
 * ACC + BVP (PPG) with VO2 ground truth but no HR column per se (HR is derivable
 * from PPG) — so this module also exposes a minimal PPG->HR primitive so the
 * wrist stream can actually drive the model. The heavy lifting (windowed
 * features, activity) reuses energy/imuFeatures.js and groundTruth.js.
 */

import { extractImuFeatures } from './imuFeatures.js';
import { gtEnergyFromVo2 } from './groundTruth.js';

/**
 * Discover if a path/name hints at a ground-truth or sensor source.
 * Returns a normalized key or null.
 */
export function classifySource(name = '') {
  const n = String(name).toLowerCase();
  if (/vo2|vo_2|metabolic|calori|ee_|ground.?truth|met\./.test(n)) {
    if (/vo2|vo_2/.test(n)) return 'gt_vo2';
    if (/met\b|metabolic/.test(n)) return 'gt_met';
    if (/calori/.test(n)) return 'gt_kcal';
    return 'gt';
  }
  if (/acc|accelerometer|imu/.test(n)) return 'accel';
  if (/gyro|gryo/.test(n)) return 'gyro';
  if (/bvp|ppg|optical|photopleth/.test(n)) return 'ppg';
  if (/hr|heart.?rate/.test(n)) return 'hr';
  if (/bpm|breathing|resp/.test(n)) return 'resp';
  return null;
}

/**
 * Normalize a dense accelerometer array into per-window IMU features.
 * Handles both flat triples [ax,ay,az,...] and columnar objects.
 */
export function windowAccelFeatures({ ax, ay, az, sampleRate = 32, windowSeconds = 5 }) {
  const win = Math.round(sampleRate * windowSeconds);
  const n = Math.min(ax.length, ay.length, az.length);
  if (!n) return [];
  const out = [];
  for (let s = 0; s + win <= n; s += win) {
    const f = extractImuFeatures({
      ax: ax.slice(s, s + win), ay: ay.slice(s, s + win), az: az.slice(s, s + win),
      sampleRate,
    });
    if (f) out.push({ t0: s / sampleRate, features: f });
  }
  return out;
}

/**
 * Build a common segment record from a row of columnar data, normalizing
 * column names loosely. Accepts either {ax,ay,az,...} or numeric arrays.
 */
export function toSegment(row, meta = {}) {
  const accel = pickAccel(row);
  if (!accel) return null;
  const gt = pickGroundTruth(row, meta);
  return {
    participant: meta.participant ?? row.participant ?? row.subject ?? null,
    activity: meta.activity ?? row.activity ?? row.label ?? null,
    device: meta.device ?? row.device ?? null,
    sampleRate: meta.sampleRate ?? row.sampleRate ?? 32,
    accel,
    gyro: pickGyro(row),
    gt,
    weightKg: meta.weightKg ?? row.weightKg ?? row.weight_kg ?? null,
  };
}

function pickAccel(r) {
  const ax = firstNum(r.ax, r.accx, r.x, r.acc_x, r.accX);
  const ay = firstNum(r.ay, r.accy, r.y, r.acc_y, r.accY);
  const az = firstNum(r.az, r.accz, r.z, r.acc_z, r.accZ);
  if (ax != null && ay != null && az != null) return { ax, ay, az };
  // Flat triplets in a single array
  if (Array.isArray(r.accel)) return { ax: r.accel[0], ay: r.accel[1], az: r.accel[2] };
  return null;
}
function pickGyro(r) {
  const gx = firstNum(r.gx, r.gyrx);
  const gy = firstNum(r.gy, r.gyry);
  const gz = firstNum(r.gz, r.gyrz);
  return gx != null && gy != null && gz != null ? { gx, gy, gz } : null;
}
function pickGroundTruth(r, meta) {
  if (r.vo2MlPerKgMin != null || r.vo2LPerMin != null || r.met != null || r.kcalPerMin != null) {
    return {
      vo2MlPerKgMin: firstNum(r.vo2MlPerKgMin, r.vo2_ml_kg_min, r.VO2),
      vo2LPerMin: firstNum(r.vo2LPerMin, r.vo2_l_min),
      vco2LPerMin: firstNum(r.vco2LPerMin, r.vco2),
      rer: firstNum(r.rer),
      met: firstNum(r.met),
      kcalPerMin: firstNum(r.kcalPerMin, r.kcal_min),
    };
  }
  if (meta.gtVo2MlPerKgMin != null) return { vo2MlPerKgMin: meta.gtVo2MlPerKgMin };
  return null;
}
function firstNum(...vals) {
  for (const v of vals) {
    if (v != null && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

export { gtEnergyFromVo2, extractImuFeatures };
