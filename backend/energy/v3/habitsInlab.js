/**
 * HAbitsLab in-lab external-validation harness (Zenodo 14858226).
 *
 * Optional local extract for scoring. Research training lives in
 * energy/v3/research/ (MetCart labels only).
 * Ground truth is metabolic-cart MET, never Compendium/Ainsworth labels.
 * The free-living / in-wild portion is not cart ground truth and is refused.
 *
 * Expected local root (not downloaded by this module):
 *   HABITS_INLAB_ROOT or backend/data/habits/inlab
 * Zip: https://zenodo.org/records/14858226  ("Phase 2 - Data.zip", CC BY 4.0)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMU_ARCHIVE_SCHEMA, ACCEL_SCALE_G_PER_LSB, GYRO_SCALE_DPS_PER_LSB } from '../../protocol/imuArchive.js';
import { computeEnergyMinutesV3 } from './engine3.js';
import { resolvePhysiology } from '../physiology.js';

export const HABITS_ZENODO = '14858226';
export const HABITS_DOI = '10.5281/zenodo.14858226';
export const HABITS_HZ = 20;
export const HABITS_N_PARTICIPANTS = 26;
export const HABITS_INLAB_ACTIVITIES = Object.freeze([
  'Rest',
  'Typing on a computer while seated',
  'Walking 2 mph on treadmill',
  'Walking 3.5 mph on treadmill',
  'Standing while fidgeting',
  'Squats (shoulder length legs, get down to 90 degree angle)',
  'Reading a book or magazine while reclining',
  'Sweeping slowly',
  'Push-ups against the wall',
  'Running 4 mph on a treadmill',
  'Lying down while doing nothing',
]);

const here = path.dirname(fileURLToPath(import.meta.url));

export function habitsInlabRoot(env = process.env) {
  if (env.HABITS_INLAB_ROOT) return env.HABITS_INLAB_ROOT;
  return path.join(here, '../../data/habits/inlab');
}

export function isCartGroundTruthColumn(name) {
  const n = String(name || '').toLowerCase().replace(/\s+/g, '');
  if (n.includes('ainsworth') || n.includes('compendium')) return false;
  return n.includes('metcart') || n === 'met(metcart)' || n.includes('metaboliccart');
}

export function refuseNonCartLabel(row) {
  if (row?.source === 'ainsworth' || row?.source === 'compendium' || row?.source === 'in_wild') {
    throw new Error(`habits_gt_refused:${row.source}`);
  }
  if (row?.met_ainsworth != null && row?.met_cart == null) {
    throw new Error('habits_gt_refused:ainsworth_without_cart');
  }
  return Number(row.met_cart);
}

/** Pack 20 Hz wrist acc+gyro (g, deg/s) into 1 s WHOOP-shaped IMU records. */
export function wristHzToImuRecords(rows, { t0Ms, hz = HABITS_HZ } = {}) {
  const n = rows.length;
  const recs = [];
  const perSec = Math.round(hz);
  for (let s = 0; s + perSec <= n; s += perSec) {
    const accel_x = [], accel_y = [], accel_z = [];
    const gyro_x = [], gyro_y = [], gyro_z = [];
    for (let i = 0; i < perSec; i++) {
      const r = rows[s + i];
      accel_x.push(Math.round(Number(r.accX ?? r.ax) / ACCEL_SCALE_G_PER_LSB));
      accel_y.push(Math.round(Number(r.accY ?? r.ay) / ACCEL_SCALE_G_PER_LSB));
      accel_z.push(Math.round(Number(r.accZ ?? r.az) / ACCEL_SCALE_G_PER_LSB));
      gyro_x.push(Math.round(Number(r.rotX ?? r.gx ?? 0) / GYRO_SCALE_DPS_PER_LSB));
      gyro_y.push(Math.round(Number(r.rotY ?? r.gy ?? 0) / GYRO_SCALE_DPS_PER_LSB));
      gyro_z.push(Math.round(Number(r.rotZ ?? r.gz ?? 0) / GYRO_SCALE_DPS_PER_LSB));
    }
    recs.push({
      schema: IMU_ARCHIVE_SCHEMA,
      sensor_ts: (t0Ms + (s / hz) * 1000) / 1000,
      sample_rate_hz: hz,
      accel_x, accel_y, accel_z, gyro_x, gyro_y, gyro_z,
      accel: { scale_g_per_lsb: ACCEL_SCALE_G_PER_LSB },
      gyro: { scale_dps_per_lsb: GYRO_SCALE_DPS_PER_LSB },
    });
  }
  return recs;
}

export function scoreFrozenMinute({ samples, imuRecords, physiology, metCart }) {
  const gt = refuseNonCartLabel({ met_cart: metCart, source: 'metcart' });
  const { minutes } = computeEnergyMinutesV3({ samples, physiology, imuRecords, timeZone: 'UTC' });
  if (!minutes.length || !Number.isFinite(gt)) return null;
  const yhat = minutes[0].met;
  return { y: gt, yhat, estimator: minutes[0].estimator };
}

export function discoverInlab(root = habitsInlabRoot()) {
  if (!root || !fs.existsSync(root)) {
    return { ok: false, skipped: true, reason: 'habits_inlab_missing', root, zenodo: HABITS_ZENODO, doi: HABITS_DOI };
  }
  return {
    ok: true,
    skipped: false,
    root,
    zenodo: HABITS_ZENODO,
    doi: HABITS_DOI,
    note: 'Use MET(MetCart) only. Do not train or tune V3 on this set.',
    n_participants_expected: HABITS_N_PARTICIPANTS,
    hz: HABITS_HZ,
    activities: HABITS_INLAB_ACTIVITIES,
  };
}

export function defaultPhysiology() {
  return resolvePhysiology({
    profile: { birthYear: 1990, weightKg: 70, heightCm: 170, sex: 'female' },
    prefs: { restingHr: 60 },
  });
}
