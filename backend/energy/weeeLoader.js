/**
 * WEEE dataset loader (Phase 9).
 *
 * Parses the WEEE public dataset (CC BY 4.0) into a common per-participant,
 * per-activity-segment dataset usable to train/score a wrist energy model
 * against indirect-calorimetry ground truth.
 *
 * Layout (verified on P01-P17):
 *   dataset/Study_Information.csv  -> activity start times + protocol/Compendium MET labels
 *   dataset/Demographics.csv       -> weight kg, FFM%, age, sex per participant
 *   dataset/PXX/E4/ACC.csv         -> wrist Empatica 3-axis accel (32 Hz)
 *   dataset/PXX/E4/HR.csv          -> wrist HR (1 Hz)
 *   dataset/PXX/VO2/DataAverage.csv-> VO2[mL/kg/min] per second (calorimetry)
 *
 * Training/eval labels are mean VO2 (mL/kg/min) / 3.5 from DataAverage.csv.
 * Study_Information MET_* columns are protocol/Compendium intensity labels,
 * not calorimetry ground truth (they are constant per segment; VO2 is not).
 */
import fs from 'node:fs';
import path from 'node:path';

const STUDY_FIELDS = ['Start_Sit','Start_Stand','Start_Cycle1','Start_Cycle2','Start_Run1','Start_Run2'];

/** The WEEE Study_Information/VO2 RFC timestamps are stored in UTC+8 (the
 *  collection site's zone). JS Date.parse interprets them in the *host* zone to
 *  a wall-clock string that lands 8h ahead of the E4/ACC unix timestamps, which
 *  are true UTC. Subtract 8h to bring them to real UTC so segments and VO2 align
 *  with the ACC timeline. Verified constant across participants (P01-P03; +8h). */
const TZ_OFFSET_MS = 8 * 3600 * 1000;

function parseSiteTime(s) {
  const m = s && Date.parse(s);
  return Number.isFinite(m) ? m - TZ_OFFSET_MS : NaN;
}
const SEGMENTS = [
  ['sit','Sit'], ['stand','Stand'], ['cycle1','Cycle1'], ['cycle2','Cycle2'],
  ['run1','Run1'], ['run2','Run2'],
];

export function loadCsvRows(fp) {
  const txt = fs.readFileSync(fp, 'utf8');
  const lines = txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(',').map((h) => h.trim());
  const rows = lines.slice(1).map((l) => {
    const cells = l.split(',');
    const o = {};
    header.forEach((h, i) => { o[h] = cells[i]?.trim() ?? ''; });
    return o;
  });
  return rows;
}

/** Parse E4 ACC.csv: row1 unix start, row2 rate, then X,Y,Z samples. */
export function loadE4Acc(fp) {
  const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const t0 = parseFloat(lines[0]);
  const rate = parseFloat(lines[1]);
  const n = lines.length - 2;
  const ax = new Array(n), ay = new Array(n), az = new Array(n);
  // Empatica E4 ACC is exported in LSB where ~64 counts = 1 g (resolution
  // 1/64 g/count; the wrist stream is ±2 g over the 8-bit signed range).
  const G = 1 / 64;
  for (let i = 0; i < n; i++) {
    const c = lines[i + 2].split(',').map(parseFloat);
    ax[i] = (c[0] ?? 0) * G; ay[i] = (c[1] ?? 0) * G; az[i] = (c[2] ?? 0) * G;
  }
  return { t0, rate, ax, ay, az, n, scale: 'g', gPerLsb: G };
}

/** Parse E4 HR.csv: row1 unix start, row2 rate, then HR values. */
export function loadE4Hr(fp) {
  const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const t0 = parseFloat(lines[0]);
  const rate = parseFloat(lines[1]);
  const hr = lines.slice(2).map(parseFloat);
  return { t0, rate, hr };
}

/** Parse VO2 DataAverage per-second calorimetry. The final 'Time' column is an
 *  absolute RFC timestamp per row (e.g. '2021-12-03 16:58:51'); parse it so every
 *  VO2 sample gets a real unix-time anchor used to align with E4/ACC and segments. */
export function loadVo2(fp) {
  const rows = loadCsvRows(fp);
  const out = rows.map((r) => {
    const absTime = r.Time || r['Time'];
    return {
      tSec: parseFloat(r['Time[s]'] ?? 0),
      vo2MlPerKgMin: parseFloat(r['VO2[mL/kg/min]']),
      vo2LPerMin: parseFloat(r['VO2[mL/min]']) / 1000,
      hr: parseFloat(r['HR[bpm]']),
      utcMs: absTime ? Date.parse(absTime) - TZ_OFFSET_MS : NaN,
    };
  }).filter((r) => r.vo2MlPerKgMin != null && r.vo2MlPerKgMin > 0 && Number.isFinite(r.utcMs));
  return out;
}

/** Build per-participant segment records from a WEEE root dir. */
export function loadWeeeDataset(rootDir) {
  const study = loadCsvRows(path.join(rootDir, 'Study_Information.csv'));
  const demo = loadCsvRows(path.join(rootDir, 'Demographics.csv'));
  const demoMap = new Map(demo.map((d) => [d.Participant, d]));

  const participants = [];
  const fs2 = fs.promises;
  const dirs = fs.readdirSync(rootDir).filter((d) => /^P\d{2}$/.test(d)).sort();
  for (const pd of dirs) {
    const info = study.find((s) => s.Participant === pd);
    if (!info) continue;
    const dem = demoMap.get(pd) || {};
    const e4Acc = loadE4Acc(path.join(rootDir, pd, 'E4', 'ACC.csv'));
    const e4Hr = loadE4Hr(path.join(rootDir, pd, 'E4', 'HR.csv'));
    const vo2 = loadVo2(path.join(rootDir, pd, 'VO2', 'DataAverage.csv'));

    const segs = [];
    for (const [name, key] of SEGMENTS) {
      const startStr = info[`Start_${key}`];
      if (!startStr) continue;
      const utcMs = parseSiteTime(startStr);
      if (!utcMs) continue;
      const refMet = refMetFor(info, key);
      // activity window: from start to next segment start (or +5 min)
      const idx = SEGMENTS.findIndex(([n]) => n === name);
      const nextStart = idx < SEGMENTS.length - 1 ? parseDateOrNull(info[`Start_${SEGMENTS[idx + 1][1]}`]) : utcMs + 5 * 60 * 1000;
      const endMs = nextStart || utcMs + 5 * 60 * 1000;
      const segVo2 = vo2.filter((v) => v.utcMs >= utcMs && v.utcMs < endMs);
      segs.push({
        participant: pd, activity: name, refMet,
        startMs: utcMs, endMs,
        weightKg: parseFloat(dem.Weight) || null,
        accelStartUnix: e4Acc.t0, accelRate: e4Acc.rate, accelN: e4Acc.n,
        hrStartUnix: e4Hr.t0, hr: e4Hr.hr,
        vo2: segVo2,
        vo2Layout: 'absolute_time',
      });
    }
    participants.push({ participant: pd, dem, segs });
  }
  return { participants, study, demoMap };
}

function parseDateOrNull(s) {
  const m = s && Date.parse(s);
  return Number.isFinite(m) ? m - TZ_OFFSET_MS : null;
}
function refMetFor(info, key) {
  const v = parseFloat(info[`MET_${key}`] ?? '');
  return Number.isFinite(v) ? v : null;
}

export { SEGMENTS };
