/**
 * Extract 60 s research minutes from WEEE and HAbitsLab in-lab.
 *
 * Labels: WEEE = VO2/3.5; HAbits = MetCart only. Vendor calories refused.
 * IMU goes through the same 20 Hz harmonize path as production V3.
 *
 * Run: node energy/v3/research/extractMinutes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWeeeDataset, loadE4Acc, loadE4Hr } from '../../weeeLoader.js';
import { extractImuFeatures } from '../../imuFeatures.js';
import { CROSS_DEVICE_HZ, harmonizeImu } from '../preprocess.js';
import { refuseVendorLabel, weeeRoot, habitsRoot } from '../datasets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(here, 'cache');
const IMU_KEYS = [
  'enmo_mean', 'enmo_mad', 'dyn_enmo_mean', 'bandpass_motion_auc_20hz', 'bandpass_motion_auc_20hz_std', 'vm_mean',
  'accel_std', 'jerk_mean', 'movement_intermittency', 'cadence_band_power_frac',
  'periodicity_strength', 'cadence_cycles_per_min', 'dom_freq_hz', 'entropy',
  'gyro_mean_dps', 'gyro_energy', 'gravity_z_mean', 'ax_ay_corr', 'ax_az_corr',
  'tilt_estimate', 'coverage',
];

function meanN(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(','));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

function imuRow(harm, extra) {
  if (!harm) return null;
  const f = extractImuFeatures({
    ...harm.cross,
    sampleRate: CROSS_DEVICE_HZ,
    expectedSeconds: 60,
  });
  if (!f) return null;
  const out = { ...extra };
  for (const k of IMU_KEYS) out[k] = f[k] ?? '';
  out.gyro_present = f.gyro_mean_dps != null ? 1 : 0;
  out.sample_rate_native = harm.native.sampleRate;
  out.feature_hz = CROSS_DEVICE_HZ;
  return out;
}

function mapWeeeActivity(a) {
  if (a === 'sit') return 'sedentary';
  if (a === 'stand') return 'standing';
  if (a === 'cycle1' || a === 'cycle2') return 'cycling';
  if (a === 'run1' || a === 'run2') return 'running';
  return a;
}

/** Predefined physical/sensor QC. Never uses prediction residuals. */
export function sensorQcReason(row) {
  const vm = Number(row.vm_mean);
  const dyn = Number(row.dyn_enmo_mean);
  if (!Number.isFinite(vm) || vm < 0.7 || vm > 2.5) return 'sensor_qc_vm_outside_0.7_2.5';
  if (Number.isFinite(dyn) && (dyn < 0 || dyn > 5)) return 'sensor_qc_dyn_enmo_outside_0_5';
  return null;
}

function ledgerRow({ dataset, participant, activity, candidate, included, reason }) {
  return {
    dataset,
    participant,
    activity,
    candidate_minutes: candidate,
    included_minutes: included,
    excluded_minutes: Math.max(0, candidate - included),
    exclusion_reason: reason,
  };
}

export function extractWeeeMinutes(root = weeeRoot()) {
  refuseVendorLabel('vo2_master_ok');
  const { participants } = loadWeeeDataset(root);
  const rows = [];
  const ledger = [];
  const dropped = [];
  for (const p of participants) {
    const dem = p.dem;
    const weight = parseFloat(dem.Weight);
    const height = parseFloat(dem.Height);
    const age = parseInt(dem.Age, 10);
    const sex = String(dem.Gender || '').trim().toUpperCase().startsWith('M') ? 'male' : 'female';
    const acc = loadE4Acc(path.join(root, p.participant, 'E4', 'ACC.csv'));
    const hr = loadE4Hr(path.join(root, p.participant, 'E4', 'HR.csv'));
    const hrAt = (ms) => {
      const i = Math.round(ms / 1000 - hr.t0);
      const v = hr.hr[i];
      return Number.isFinite(v) && v >= 20 && v <= 240 ? v : null;
    };
    const sit = p.segs.find((s) => s.activity === 'sit');
    let restingHr = null;
    if (sit) {
      const hs = [];
      for (let t = sit.startMs; t < sit.endMs; t += 1000) {
        const v = hrAt(t);
        if (v != null) hs.push(v);
      }
      if (hs.length > 10) {
        hs.sort((a, b) => a - b);
        restingHr = hs[Math.floor(hs.length * 0.2)];
      }
    }
    const hrMax = 208 - 0.7 * age;

    for (const seg of p.segs) {
      const protocolMin = Math.max(0, Math.floor((seg.endMs - seg.startMs) / 60_000));
      const reasons = { vo2_short_segment: 0, acc_overrun: 0, vo2_sparse_minute: 0, imu_fail: 0 };
      let included = 0;
      const boutRows = [];
      if (!seg.vo2 || seg.vo2.length < 30) {
        ledger.push({
          dataset: 'weee',
          participant: p.participant,
          activity: seg.activity,
          candidate_minutes: protocolMin,
          included_minutes: 0,
          excluded_minutes: protocolMin,
          exclusion_reason: 'vo2_segment_lt_30_samples',
        });
        continue;
      }
      const vo2BySec = new Map(seg.vo2.map((v) => [Math.floor(v.utcMs / 1000), v.vo2MlPerKgMin]));
      const t0 = Math.ceil(seg.startMs / 60_000) * 60_000;
      for (let minuteMs = t0; minuteMs + 60_000 <= seg.endMs; minuteMs += 60_000) {
        const i0 = Math.max(0, Math.round((minuteMs / 1000 - acc.t0) * acc.rate));
        const n = Math.round(acc.rate * 60);
        if (i0 + n > acc.n) {
          reasons.acc_overrun += 1;
          continue;
        }
        const harm = harmonizeImu({
          ax: acc.ax.slice(i0, i0 + n),
          ay: acc.ay.slice(i0, i0 + n),
          az: acc.az.slice(i0, i0 + n),
          sampleRate: acc.rate,
        });
        const vo2s = [];
        const hrs = [];
        for (let s = 0; s < 60; s++) {
          const vo2 = vo2BySec.get(Math.floor(minuteMs / 1000) + s);
          if (vo2 != null && vo2 > 0) vo2s.push(vo2);
          const h = hrAt(minuteMs + s * 1000);
          if (h != null) hrs.push(h);
        }
        if (vo2s.length < 20) {
          reasons.vo2_sparse_minute += 1;
          continue;
        }
        const vo2Mean = meanN(vo2s);
        const target = vo2Mean / 3.5;
        const hrMean = meanN(hrs);
        const row = imuRow(harm, {
          dataset: 'weee',
          participant: p.participant,
          activity: seg.activity,
          activity_family: mapWeeeActivity(seg.activity),
          minute_iso: new Date(minuteMs).toISOString(),
          weight_kg: weight,
          height_cm: height,
          age,
          sex,
          resting_hr: restingHr,
          hr_mean: hrMean,
          hrr_frac: (hrMean != null && restingHr != null)
            ? (hrMean - restingHr) / Math.max(hrMax - restingHr, 20)
            : '',
          criterion_vo2_ml_kg_min: round(vo2Mean, 5),
          criterion_met: round(target, 5),
          target_met: round(target, 5),
          label_source: 'vo2_ml_per_kg_min_over_3.5',
          steady_state: 0,
        });
        if (!row) {
          reasons.imu_fail += 1;
          continue;
        }
        const qc = sensorQcReason(row);
        if (qc) {
          reasons[qc] = (reasons[qc] || 0) + 1;
          dropped.push({ ...row, exclusion_reason: qc });
          continue;
        }
        boutRows.push(row);
        included += 1;
      }
      const longExercise = ['cycle1', 'cycle2', 'run1', 'run2'].includes(seg.activity) && boutRows.length >= 4;
      if (longExercise) {
        for (let i = Math.max(0, boutRows.length - 3); i < boutRows.length; i++) {
          boutRows[i].steady_state = 1;
        }
      }
      rows.push(...boutRows);
      ledger.push(ledgerRow({
        dataset: 'weee',
        participant: p.participant,
        activity: seg.activity,
        candidate: protocolMin,
        included,
        reason: Object.entries(reasons)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k}=${n}`)
          .join(';') || 'none',
      }));
    }
  }
  return { rows, ledger, dropped };
}

function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseNumericCsv(fp, tNames, xNames, yNames, zNames) {
  const text = fs.readFileSync(fp, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return null;
  const header = lines[0].split(',').map((h) => h.trim());
  const idx = (names) => header.findIndex((h) => names.some((n) => h.toLowerCase() === n.toLowerCase()));
  const ti = idx(tNames), xi = idx(xNames), yi = idx(yNames), zi = idx(zNames);
  if (xi < 0 || yi < 0 || zi < 0) return null;
  const t = [], x = [], y = [], z = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (ti >= 0) t.push(Number(c[ti]));
    x.push(Number(c[xi]));
    y.push(Number(c[yi]));
    z.push(Number(c[zi]));
  }
  return { t, x, y, z };
}

function bisectTime(t, ms) {
  let lo = 0, hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * HAbits in-lab minutes from MetCart index + 20 Hz resampled wrist IMU.
 * Google Fit / Actigraph / Ainsworth columns are never read as labels.
 */
export function extractHabitsMinutes(root = habitsRoot()) {
  const indexPath = path.join(OUT_DIR, 'habits_index.csv');
  if (!fs.existsSync(root) || !fs.existsSync(indexPath)) return { rows: [], ledger: [], dropped: [] };
  const idx = fs.readFileSync(indexPath, 'utf8').trim().split('\n');
  const cols = parseCsvLine(idx[0]);
  const minutes = idx.slice(1).map((line) => {
    const p = parseCsvLine(line);
    const o = {};
    cols.forEach((c, i) => { o[c] = p[i]; });
    return o;
  });
  const cache = new Map();
  function loadPid(pid) {
    if (cache.has(pid)) return cache.get(pid);
    const accPath = path.join(root, pid, 'Wrist Data/Clean/Resampled/Accelerometer/acc_resample.csv');
    const gyroPath = path.join(root, pid, 'Wrist Data/Clean/Resampled/Gyroscope/gyro_resample.csv');
    const acc = fs.existsSync(accPath) ? parseNumericCsv(accPath, ['Time'], ['accX'], ['accY'], ['accZ']) : null;
    const gyro = fs.existsSync(gyroPath)
      ? parseNumericCsv(gyroPath, ['Time'], ['rotX'], ['rotY'], ['rotZ', 'rotZosboxe'])
      : null;
    const rec = { acc, gyro };
    cache.set(pid, rec);
    return rec;
  }
  const rows = [];
  const ledger = [];
  const dropped = [];
  for (const m of minutes) {
    const pid = m.participant;
    const t0 = Number(m.start_ms);
    const target = Number(m.criterion_met ?? m.target_met);
    if (!Number.isFinite(t0) || !Number.isFinite(target)) {
      ledger.push({
        dataset: 'habits', participant: m.participant, activity: m.activity,
        candidate_minutes: 1, included_minutes: 0, excluded_minutes: 1,
        exclusion_reason: 'index_missing_target_or_time',
      });
      continue;
    }
    const { acc, gyro } = loadPid(pid);
    if (!acc?.t?.length) {
      ledger.push({
        dataset: 'habits', participant: pid, activity: m.activity,
        candidate_minutes: 1, included_minutes: 0, excluded_minutes: 1,
        exclusion_reason: 'release_missing_acc_resample',
      });
      continue;
    }
    const i0 = bisectTime(acc.t, t0);
    const n = 20 * 60;
    if (i0 < 0 || i0 + n > acc.x.length) {
      ledger.push({
        dataset: 'habits', participant: pid, activity: m.activity,
        candidate_minutes: 1, included_minutes: 0, excluded_minutes: 1,
        exclusion_reason: 'imu_window_outside_acc_resample',
      });
      continue;
    }
    const ax = acc.x.slice(i0, i0 + n);
    const ay = acc.y.slice(i0, i0 + n);
    const az = acc.z.slice(i0, i0 + n);
    let gx, gy, gz;
    if (gyro?.t?.length) {
      const g0 = bisectTime(gyro.t, t0);
      if (g0 >= 0 && g0 + n <= gyro.x.length) {
        gx = gyro.x.slice(g0, g0 + n);
        gy = gyro.y.slice(g0, g0 + n);
        gz = gyro.z.slice(g0, g0 + n);
      }
    }
    const harm = harmonizeImu({ ax, ay, az, gx, gy, gz, sampleRate: 20, gyroUnits: 'rad_s' });
    const row = imuRow(harm, {
      dataset: 'habits',
      participant: pid,
      activity: m.activity,
      activity_family: m.activity_family,
      minute_iso: new Date(t0).toISOString(),
      weight_kg: '',
      height_cm: '',
      age: '',
      sex: '',
      resting_hr: '',
      hr_mean: '',
      hrr_frac: '',
      criterion_vo2_ml_kg_min: m.criterion_vo2_ml_kg_min || '',
      criterion_met: Number.isFinite(Number(m.criterion_met)) ? round(Number(m.criterion_met), 5) : round(target, 5),
      target_met: Number.isFinite(Number(m.criterion_met)) ? round(Number(m.criterion_met), 5) : round(target, 5),
      cart_mets_rounded: m.cart_mets_rounded || '',
      label_source: m.label_source || 'vo2_ml_kg_min_over_3.5_from_metcart_60s',
    });
    if (!row) {
      ledger.push(ledgerRow({
        dataset: 'habits', participant: pid, activity: m.activity,
        candidate: 1, included: 0, reason: 'imu_fail',
      }));
      continue;
    }
    const qc = sensorQcReason(row);
    if (qc) {
      dropped.push({ ...row, exclusion_reason: qc });
      ledger.push(ledgerRow({
        dataset: 'habits', participant: pid, activity: m.activity,
        candidate: 1, included: 0, reason: qc,
      }));
      continue;
    }
    rows.push(row);
  }
  return { rows, ledger, dropped };
}

function round(n, p) {
  return Math.round(n * 10 ** p) / 10 ** p;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const weee = fs.existsSync(weeeRoot()) ? extractWeeeMinutes() : { rows: [], ledger: [], dropped: [] };
  const habits = extractHabitsMinutes();
  if (weee.rows.length) writeCsv(path.join(OUT_DIR, 'minutes_weee.csv'), weee.rows);
  if (habits.rows.length) writeCsv(path.join(OUT_DIR, 'minutes_habits.csv'), habits.rows);
  const dropped = [...(weee.dropped || []), ...(habits.dropped || [])];
  if (dropped.length) writeCsv(path.join(OUT_DIR, 'minutes_qc_dropped.csv'), dropped);
  const indexLedgerPath = path.join(OUT_DIR, 'habits_index_ledger.csv');
  let indexLedger = [];
  if (fs.existsSync(indexLedgerPath)) {
    const lines = fs.readFileSync(indexLedgerPath, 'utf8').trim().split('\n');
    const cols = parseCsvLine(lines[0]);
    indexLedger = lines.slice(1).map((line) => {
      const p = parseCsvLine(line);
      const o = {};
      cols.forEach((c, i) => { o[c] = p[i]; });
      o.candidate_minutes = Number(o.candidate_minutes);
      o.included_minutes = Number(o.included_minutes);
      o.excluded_minutes = Number(o.excluded_minutes);
      return o;
    });
  }
  const combined = [
    ...weee.ledger,
    ...indexLedger,
    ...habits.ledger,
  ];
  if (combined.length) writeCsv(path.join(OUT_DIR, 'exclusion_ledger.csv'), combined);
  console.log(JSON.stringify({
    weee_n: weee.rows.length,
    weee_participants: [...new Set(weee.rows.map((r) => r.participant))].length,
    habits_n: habits.rows.length,
    habits_participants: [...new Set(habits.rows.map((r) => r.participant))].length,
    qc_dropped: dropped.length,
    ledger_n: combined.length,
    out: OUT_DIR,
  }, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
