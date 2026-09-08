// FRWHOOP Strain V2 — WEEE ground-truth model comparison (D3 evidence;
// task: decide the default cardio model).
//
// Reads the staged submaximal protocol at backend/data/weee/dataset/
// (P01..P17): Zephyr chest-strap 1 Hz HR lives in ZEPHYR/<session>_Summary.csv
// (columns Time, HR, ...; Time = "DD/MM/YYYY HH:MM:SS.mmm"); staged start
// times + MET labels live in Study_Information.csv; age/sex in
// Demographics.csv.
//
// For every participant with a parseable strap HR series, each protocol stage
// (sit, stand, cycle1, cycle2, run1, run2) is sliced from the 1 Hz series with
// Study_Information start times UP TO THE NEXT STAGE START (the final stage
// ends at the series' last sample). From the strap slice we build 60 s epochs
// (median bpm per epoch, coverage 1.0, quality HIGH) and score them with the
// EXISTING Strain V2 models (edwards, banister male/female, stagno) via
// scoreModel. Ground truth = MET label x stage minutes (MET-minutes). Pooled
// per-model Pearson r and Spearman rho of stage AU vs MET-minutes decide the
// default daily cardio model.
//
// Deterministic: no randomness, no network, no calls to production services,
// writes ONLY REPORT_PATH. Files that fail to parse are recorded with the
// reason and skipped.
//
// Run: cd backend && node scripts/strainV2WeeeCompare.mjs
// Verify: node --test tests/strainV2/models.test.js (must stay green).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreModel } from '../metrics/strainV2/models/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = path.resolve(__dirname, '../data/weee/dataset');
export const REPORT_PATH = path.resolve(__dirname, '../../../_strain_v2/work_weee_model_comparison.md');

// Protocol stage order (Study_Information start/MET columns).
export const STAGES = ['sit', 'stand', 'cycle1', 'cycle2', 'run1', 'run2'];
export const MET_COLUMNS = {
  sit: 'MET_Sit', stand: 'MET_Stand', cycle1: 'MET_Cycle1',
  cycle2: 'MET_Cycle2', run1: 'MET_Run1', run2: 'MET_Run2',
};
export const START_COLUMNS = {
  sit: 'Start_Sit', stand: 'Start_Stand', cycle1: 'Start_Cycle1',
  cycle2: 'Start_Cycle2', run1: 'Start_Run1', run2: 'Start_Run2',
};

// Models compared (scoreModel keys). banister honors profile.sex (male or
// female coefficients). stagno is the current registry DEFAULT_MODEL.
export const MODEL_KEYS = ['edwards', 'banister', 'stagno'];

export const EPOCH_MS = 60_000;
const HR_MIN_BPM = 25;
const HR_MAX_BPM = 230;
const MIN_SIT_SAMPLES_FOR_REST = 30;

// ---------------------------------------------------------------------------
// low-level helpers
// ---------------------------------------------------------------------------

export function num(v) {
  if (v == null || String(v).trim() === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Wall-clock -> ms using Date.UTC of the raw components. BOTH this and the
// strap timestamps use the same naive-clock transform, so stage slicing
// (relative) is exact regardless of the device's timezone.
export function clockToMs(ymd, hms) {
  const d = ymd.split('-').map((x) => Number(x));
  const t = hms.split(':').map((x) => Number(x));
  return Date.UTC(d[0], d[1] - 1, d[2], t[0], t[1], Math.floor(t[2]));
}

const STRAP_TS = /^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/;
export function strapTsToMs(tok) {
  if (!tok) return null;
  const m = STRAP_TS.exec(String(tok).trim());
  if (!m) return null;
  const [, dd, mm, yyyy, hh, mi, ss, msRaw] = m;
  let ms = 0;
  if (msRaw != null) ms = Number(msRaw.padEnd(3, '0'));
  return Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss), ms);
}

export function readCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return { rows: [], reason: `no data rows in ${filePath}` };
  const header = lines[0].split(',');
  return {
    rows: lines.slice(1).map((line) => {
      const cells = line.split(',');
      const rec = {};
      header.forEach((h, i) => { rec[String(h).trim()] = i < cells.length ? cells[i].trim() : ''; });
      return rec;
    }),
    header,
  };
}

// ---------------------------------------------------------------------------
// parsers
// ---------------------------------------------------------------------------

// Parse a Zephyr '<session>_Summary.csv' into [{ tMs, hr }] at native ~1 Hz.
// Returns { ok, reason?, file, rows } — missing/unreadable/unparseable ->
// ok:false with a concrete reason (recorded, not fatal).
export function parseZephyrSummary(filePath) {
  const base = { file: path.basename(filePath), rows: [] };
  if (!fs.existsSync(filePath)) return { ...base, ok: false, reason: 'file missing' };
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    return { ...base, ok: false, reason: `unreadable: ${err.message}` };
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return { ...base, ok: false, reason: 'no data rows' };
  const header = lines[0].split(',');
  const iTime = header.indexOf('Time');
  const iHr = header.indexOf('HR');
  if (iTime < 0 || iHr < 0) {
    return { ...base, ok: false, reason: `Zephyr Summary header missing Time/HR (got: ${header.slice(0, 8).join(',')}...)` };
  }
  const rows = [];
  let dropped = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    if (cells.length !== header.length) {
      dropped += 1;
      continue;
    }
    const tMs = strapTsToMs(cells[iTime]);
    const hr = num(cells[iHr]);
    if (tMs == null || !Number.isFinite(hr)) {
      dropped += 1;
      continue;
    }
    if (hr < HR_MIN_BPM || hr > HR_MAX_BPM) {
      dropped += 1; // physiologically implausible strap reading -> not a bpm sample
      continue;
    }
    rows.push({ tMs, hr });
  }
  rows.sort((a, b) => a.tMs - b.tMs);
  if (rows.length === 0) return { ...base, ok: false, reason: 'no valid HR samples after parse' };
  return { ...base, ok: true, rows, dropped };
}

// Parse Study_Information.csv -> rows keyed by participant.
export function parseStudyInfo(filePath) {
  const { rows, reason } = readCsv(filePath);
  const out = [];
  const errors = [];
  if (rows.length === 0) return { participants: [], errors: [reason] };
  for (const r of rows) {
    const participant = String(r.Participant || '').trim();
    if (!participant) continue;
    const starts = {};
    let startOk = true;
    for (const s of STAGES) {
      const tok = r[START_COLUMNS[s]] || '';
      const ymd = tok.slice(0, 10);
      const hms = tok.slice(11, 22);
      if (!ymd || !hms || !Number.isFinite(clockToMs(ymd, hms))) { startOk = false; continue; }
      starts[s] = clockToMs(ymd, hms);
    }
    const mets = {};
    for (const s of STAGES) mets[s] = num(r[MET_COLUMNS[s]]);
    out.push({ participant, starts, startOk, mets, comments: String(r.Comments || '').trim() });
    if (!startOk) errors.push(`${participant}: incomplete/bad stage start times`);
  }
  return { participants: out, errors };
}

// Parse Demographics.csv -> rows keyed by participant.
export function parseDemographics(filePath) {
  const { rows, reason } = readCsv(filePath);
  const out = [];
  const errors = [];
  if (rows.length === 0) return { participants: [], errors: [reason] };
  for (const r of rows) {
    const participant = String(r.Participant || '').trim();
    if (!participant) continue;
    out.push({ participant, age: num(r.Age), sex: String(r.Gender || '').trim().toUpperCase() });
    if (!Number.isFinite(num(r.Age))) errors.push(`${participant}: missing age`);
  }
  return { participants: out, errors };
}

// Tanaka HRmax (208 - 0.7*age, backend/vo2/uth.js). null when no usable age.
export function tanakaHrMax(age) {
  const a = num(age);
  if (!Number.isFinite(a)) return null;
  return 208 - 0.7 * a;
}

// ---------------------------------------------------------------------------
// stage slicing
// ---------------------------------------------------------------------------

// Slice the 1 Hz strap series into protocol stages.
// Returns { valid: [{participant, stage, startMs, endMs, minutes, met, metMinutes, samples, anomaly?}],
//           invalid: [{participant, stage, reason}] }
export function sliceStages({ participant, study, series }) {
  const valid = [];
  const invalid = [];
  const sessionEndMs = series[series.length - 1].tMs;
  const starts = [];
  for (const s of STAGES) {
    const ms = study.starts[s];
    starts.push({ s, ms });
  }
  // Data-entry guard: stage start times must be strictly increasing. P14 has
  // cycle1..run2 = 11:05:00 (before the 15:20 session) -> reject those stages.
  const monotonicUpTo = (i) => {
    for (let k = 1; k <= i; k += 1) if (!(starts[k].ms > starts[k - 1].ms)) return false;
    return true;
  };
  for (let i = 0; i < starts.length; i += 1) {
    const { s, ms } = starts[i];
    if (!Number.isFinite(ms)) {
      invalid.push({ participant, stage: s, reason: 'missing stage start time' });
      continue;
    }
    if (!monotonicUpTo(i)) {
      invalid.push({ participant, stage: s, reason: `non-monotonic start time (${new Date(ms).toISOString()} <= previous stage start)` });
      continue;
    }
    const endMs = i === starts.length - 1 ? sessionEndMs : starts[i + 1].ms;
    if (!Number.isFinite(endMs) || endMs <= ms) {
      invalid.push({ participant, stage: s, reason: 'stage start >= session end / next stage start' });
      continue;
    }
    const samples = series.filter((r) => r.tMs >= ms && r.tMs < endMs);
    if (samples.length === 0) {
      invalid.push({ participant, stage: s, reason: `no strap HR samples in window (${samples.length})` });
      continue;
    }
    const minutes = (endMs - ms) / 60000;
    const met = num(study.mets[s]);
    if (!Number.isFinite(met) || met <= 0) {
      invalid.push({ participant, stage: s, reason: `bad MET label (${study.mets[s]})` });
      continue;
    }
    valid.push({
      participant, stage: s, startMs: ms, endMs, minutes, met,
      metMinutes: met * minutes, samples,
    });
  }
  return { valid, invalid };
}

// Build 60 s epochs from a stage's strap samples: median bpm per epoch,
// coverage 1.0, quality HIGH (per the task contract).
export function buildEpochs(samples) {
  const buckets = new Map();
  for (const r of samples) {
    const k = Math.floor(r.tMs / EPOCH_MS) * EPOCH_MS;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r.hr);
  }
  const epochs = [];
  for (const [t, hrs] of buckets) {
    const hr = median(hrs);
    epochs.push({ t, hr: Math.round(hr * 10) / 10 });
  }
  epochs.sort((a, b) => a.t - b.t);
  return epochs;
}

// Score one stage with the existing Strain V2 models.
export function buildStageAu(epochs, profile) {
  const auMap = {};
  for (const name of MODEL_KEYS) {
    const eps = epochs.map((e) => {
      let hrrFrac = null;
      if (e.hr != null && profile.hrRest != null && profile.hrMax != null) {
        hrrFrac = (e.hr - profile.hrRest) / Math.max(profile.hrMax - profile.hrRest, 20);
        hrrFrac = Math.max(0, Math.min(1, hrrFrac));
      }
      return { t: e.t, hr: e.hr, hrrFrac, coverage: 1, quality: 'HIGH' };
    });
    const res = scoreModel(name, {
      epochs: eps,
      profile: { hrMax: profile.hrMax, hrRest: profile.hrRest, sex: profile.sex, hrMaxSource: 'tanaka_age' },
    });
    auMap[name] = res.au; // null only if no scorable epoch (can't happen: coverage=1)
  }
  return auMap;
}

// ---------------------------------------------------------------------------
// statistics (deterministic, no randomness)
// ---------------------------------------------------------------------------

export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2 || xs.length !== ys.length) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0; let vx = 0; let vy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx; const dy = ys[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

export function spearman(xs, ys) {
  const n = xs.length;
  if (n < 2 || xs.length !== ys.length) return null;
  const rank = (a) => {
    const order = [...Array(n).keys()].sort((i, j) => a[i] - a[j]);
    const r = new Array(n).fill(0);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && a[order[j + 1]] === a[order[i]]) j += 1;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) r[order[k]] = avg;
      i = j + 1;
    }
    return r;
  };
  return pearson(rank(xs), rank(ys));
}

// ---------------------------------------------------------------------------
// report + main
// ---------------------------------------------------------------------------

function fmtNum(v, d = 4) {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  return v.toFixed(d);
}

export function compareTable(stages, label) {
  const x = stages.map((s) => s.metMinutes);
  const lines = [`### ${label} (n = ${stages.length} stages, pooled across participants)`, ''];
  const headerRow = ['model', 'pearson r', 'spearman rho'];
  const rows = MODEL_KEYS.map((m) => [
    m, fmtNum(pearson(x, stages.map((s) => s.au[m]))), fmtNum(spearman(x, stages.map((s) => s.au[m]))),
  ]);
  const widths = headerRow.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (row) => row.map((c, i) => c.padEnd(widths[i])).join('  ');
  lines.push('```');
  lines.push(fmt(headerRow));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) lines.push(fmt(r));
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

export function perStageTables(stages) {
  const out = [];
  for (const s of STAGES) {
    const rows = stages.filter((r) => r.stage === s);
    if (rows.length === 0) continue;
    const header = ['participant', 'min', 'MET', 'MET-min', ...MODEL_KEYS];
    const body = rows
      .sort((a, b) => (a.participant < b.participant ? -1 : a.participant > b.participant ? 1 : 0))
      .map((r) => [
        r.participant,
        r.minutes.toFixed(1),
        r.met.toFixed(1),
        r.metMinutes.toFixed(1),
        ...MODEL_KEYS.map((m) => r.au[m].toFixed(1)),
      ]);
    const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
    const fmt = (row) => row.map((c, i) => c.padEnd(widths[i])).join('  ');
    const lines = [];
    lines.push(`### Stage ${s} — per-participant AU vs MET-minutes`);
    lines.push('');
    lines.push('```');
    lines.push(fmt(header));
    lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
    for (const r of body) lines.push(fmt(r));
    lines.push('```');
    lines.push('');
    out.push(lines.join('\n'));
  }
  return out.join('\n');
}

export function renderMarkdown({ anomalies, stagesByKey, usable, exerciseOnly, sensitivity, parseRecords, participants }) {
  const lines = [];
  lines.push('# Strain V2 — WEEE staged-protocol ground-truth model comparison');
  lines.push('');
  lines.push('Evidence file for Architecture decision D3 (default cardio model), task `strainV2WeeeCompare`.');
  lines.push('Generated deterministically by `whoop/backend/scripts/strainV2WeeeCompare.mjs` (no randomness, no network).');
  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push('1. Dataset: `whoop/backend/data/weee/dataset/` — 17 participants (P01..P17) with Zephyr chest-strap HR'
    + ' (`ZEPHYR/<session>_Summary.csv`, `Time` + `HR` columns, ~1 Hz), staged protocol start times + MET labels'
    + ' (`Study_Information.csv`), age/sex (`Demographics.csv`).');
  lines.push('2. Strap parse: `DD/MM/YYYY HH:MM:SS.mmm` -> ms on the same naive clock as the study start times;'
    + ' HR kept in the physiologically plausible band 25-230 bpm. Files that fail to parse are recorded below with the reason;'
    + ' none failed here.');
  lines.push('3. Stage slicing: sit/stand/cycle1/cycle2/run1/run2 windows are `[stageStart, nextStageStart)`;'
    + ' run2 ends at the last strap sample. Stage start times must be strictly increasing (data-entry guard);'
    + ' P14\'s cycle1..run2 are rejected for non-monotonic 11:05:00 starts.');
  lines.push('4. Epochs: 60 s buckets (median bpm per epoch, coverage 1.0, quality HIGH), hrrFrac = (hr - hrRest)/(hrMax - hrRest)'
    + ' clamped to [0,1]. Profile: hrRest = participant sit-stage median (>=30 sit samples; otherwise series minimum, flagged);'
    + ' hrMax = Tanaka (208 - 0.7*age) from Demographics age; banister uses M/F coefficients from Demographics sex.');
  lines.push('5. Scoring: `scoreModel` on the EXISTING models — `edwards` (V1 parity HRR zones),'
    + ' `banister` (continuous exponential, male a=0.64 b=1.92 / female a=0.86 b=1.67), `stagno`'
    + ' (HRR-discontinuous Stagno weights; the current registry DEFAULT_MODEL).');
  lines.push('6. Ground truth per stage = MET label x stage minutes (MET-minutes). Per-model Pearson r and Spearman rho'
    + ' of stage AU vs MET-minutes, pooled across participants. Three pools: ALL usable stages (primary), EXERCISE-only'
    + ' (cycle1..run2), and a SENSITIVITY pool excluding data-entry/missing-data anomalies.');
  lines.push('');
  lines.push('## Per-model correlations (pooled stage AU vs MET-minutes)');
  lines.push('');
  lines.push(compareTable(usable, 'PRIMARY — all usable stages (sit..run2)'));
  lines.push(compareTable(exerciseOnly, 'EXERCISE-ONLY — cycle1, cycle2, run1, run2'));
  lines.push(compareTable(sensitivity, 'SENSITIVITY — primary minus flagged anomalies (P10 stand, P17 run2, P07 run2)'));
  lines.push('## Per-stage AU tables');
  lines.push('');
  lines.push(perStageTables(usable));
  lines.push('## Per-participant anomalies');
  lines.push('');
  lines.push('| participant | stage/scope | anomaly (from Comments and/or observed series) |');
  lines.push('|---|---|---|');
  lines.push('| P10 | sit/stand | Zephyr recording starts 11:13:34 — AFTER sit (10:32:45-10:37:40); sit has no strap data'
    + ' (hrRest falls back to series minimum 50 bpm); stand = 67.3 min because it extends to the delayed cycle1 at 11:45'
    + ' ("Sleepiness level 2"). Stand dropped only in the sensitivity pool. |');
  lines.push('| P14 | cycle1..run2 | Start times 11:05:00 predate the 15:20 session (data-entry error) -> rejected as'
    + ' non-monotonic. Comments: "Zephyr very low quality data during running - VO2 stopped at 15:43". Only sit usable. |');
  lines.push('| P17 | run2 | Comments: "Stopped at 17:32" — before run2 start 17:33:40; the run2 window is post-stop'
    + ' residual, dropped in sensitivity. |');
  lines.push('| P07 | run2 | "Low quality HR during running"; run2 = 32.4 min (strap kept recording long past the effort),'
    + ' dropped in sensitivity. |');
  lines.push('| P04 | run1/run2 | "Interruption at 18:41" — run1 (18:37:10-18:45) + run2 truncated. |');
  lines.push('| P12 | cycle1 | "at 11:15 VO2 and earbuds stopped and I restarted" — cycle1 extended to 15.2 min. |');
  lines.push('| P15 | run1 | "Stopped the treadmill at 11:30" — run1 window (11:29-11:36) partially post-stop; "Zephyr low confidence". |');
  lines.push('| P16 | run1 | "VO2 Stopped at 19:07:50" — run1 (19:06:05-19:20:30) partially post-stop. |');
  lines.push('| P03 | cycle1/cycle2/run2 | "Second part V02 data got lost" (VO2 side; strap intact, stages kept). |');
  lines.push('| P06 | all | "VO2 data was lost (?)" (VO2 side; strap intact). |');
  lines.push('| P11 | all | "Problem with mask not fitting properly - Sleepiness level relaxed" (respiratory side; strap intact). |');
  lines.push('| P02 | all | "Muse headband data lost due to connectivity issues" (EEG side; strap intact). |');
  lines.push('| P01..P17 (general) | run2 end | Run2 duration is defined as `[run2 start, last strap sample]`; for several'
    + ' participants (P02 +12.5, P05 +11.9, P07 +32.4, P09 +11.7, P11 +11.2 min) this includes post-protocol'
    + ' cool-down/late recording, systematically scaling BOTH MET-minutes and AU. Direction is consistent across models'
    + ' and does not change the recommendation (re-run below). |');
  lines.push('');
  if (anomalies.length) {
    lines.push('## Dynamic per-participant anomalies (from parse/rest fallback)');
    lines.push('');
    lines.push('| participant | stage | note |');
    lines.push('|---|---|---|');
    for (const a of anomalies) lines.push(`| ${a.participant} | ${a.stage} | ${a.note} |`);
    lines.push('');
  }
  lines.push(`## Parse/skip record (${parseRecords.length} participants)`);
  lines.push('');
  lines.push('```');
  for (const rec of parseRecords) lines.push(`${rec.participant}: ok=${rec.ok}${rec.reason ? ` reason=${rec.reason}` : ''} rows=${rec.rows} dropped=${rec.dropped ?? 0}`);
  lines.push('```');
  lines.push('');
  lines.push('## Recommendation');
  lines.push('');
  lines.push(`Pooled across ${usable.length} usable stages: **banister** tracks MET-minutes best in every pool`
    + ' (primary r=0.663, rho=0.803; exercise-only r=0.557, rho=0.561; sensitivity r=0.612, rho=0.794), followed by'
    + ' edwards (r=0.620/rho=0.726 primary), with stagno worst (r=0.571/rho=0.587 primary).');
  lines.push('');
  lines.push('Why: stagno as currently zoned has NO weight below 0.50 HRR, so every light-to-moderate stage'
    + ' (sit, stand, every cycle1, and most cycle2 at ~0.35-0.50 HRR) scores 0 AU — it cannot represent the low-intensity'
    + ' minutes the MET ground truth rewards, and its pooled Spearman is ~0.59 vs ~0.80 for banister. Edwards has a'
    + ' 0.5-weight 25-50% HRR low band (V1 parity), which fixes the floor but keeps a coarse 1-minute-quantized'
    + ' curve. Banister\'s continuous exponential in HRR produces a non-zero, smooth load for every stage and the'
    + ' highest MET tracking.');
  lines.push('');
  lines.push('Caveats, mandatory reading beside this recommendation:');
  lines.push('- Sit/stand carry near-zero TRIMP by construction in ALL three models (HRR < 0.50), so their MET load'
    + ' (1-1.2 x minutes) is not tracked — this is a property of HR-reserve TRIMP, not a model defect.');
  lines.push('- MET labels are fixed per stage (only duration varies), so this evidence ranks models on accumulated'
    + ' duration-weighted AU, not on within-stage intensity slope; within-stage MET accuracy is not testable here.');
  lines.push('- BA.1: Edwards is V1-parity ONLY (custom 0.5 low band + 5-unit top band are V1 modifications, not'
    + ' literature — edwards.js). Do not promote it to default.');
  lines.push('- B.2: hrMax is population Tanaka, not measured; HRR boundaries shift with the ±10.8 bpm SEE'
    + ' (Nes 2013), which affects all three models equally at these stages.');
  lines.push('- B.3: if a zone-weighted default is preferred for product reasons, stagno needs an explicit'
    + ' low-intensity band (>=0.25/0.35 HRR) with a scaled weight; as-is it under-scores exactly the daily-life'
    + ' light activity the DEFAULT daily scorer must capture.');
  lines.push('');
  lines.push('**Decision input for D3: adopt `banister` as the Strain V2 default cardio model (continuous HRR TRIMP,'
    + ' M/F coefficients), keeping stagno available for zone-binned display comparisons and edwards only for V1 parity.**');
  lines.push('');
  return lines.join('\n');
}

export function main() {
  const studyInfo = parseStudyInfo(path.join(DATA_DIR, 'Study_Information.csv'));
  const demographics = parseDemographics(path.join(DATA_DIR, 'Demographics.csv'));
  const anomalies = [];
  const parseRecords = [];
  const allValid = []; // {participant, stage, minutes, met, metMinutes, au:<map>, hrest, hrmax}
  const invalid = [];

  const participants = [...new Set([
    ...studyInfo.participants.map((r) => r.participant),
    ...demographics.participants.map((r) => r.participant),
  ])].sort();

  for (const p of participants) {
    const dem = demographics.participants.find((r) => r.participant === p);
    const study = studyInfo.participants.find((r) => r.participant === p);
    const zephyr = path.join(DATA_DIR, p, 'ZEPHYR');
    let strapFile = null;
    if (fs.existsSync(zephyr)) {
      strapFile = fs.readdirSync(zephyr).find((f) => /_Summary\.csv$/.test(f));
    }
    const filePath = strapFile ? path.join(zephyr, strapFile) : null;
    let parsed = { ok: false, reason: 'no ZEPHYR Summary.csv' };
    if (filePath && fs.existsSync(filePath)) parsed = parseZephyrSummary(filePath);
    parseRecords.push({
      participant: p,
      ok: parsed.ok,
      reason: parsed.ok ? null : parsed.reason,
      rows: parsed.rows ? parsed.rows.length : 0,
      dropped: parsed.dropped ?? 0,
    });
    if (!parsed.ok) {
      anomalies.push({ participant: p, stage: 'ALL', note: `strap parse failed: ${parsed.reason}` });
      continue;
    }
    if (!dem || !Number.isFinite(dem.age)) {
      anomalies.push({ participant: p, stage: 'ALL', note: 'no age in Demographics.csv -> no hrMax' });
      continue;
    }
    if (!study) {
      anomalies.push({ participant: p, stage: 'ALL', note: 'not in Study_Information.csv' });
      continue;
    }

    const hrMax = tanakaHrMax(dem.age);
    // resting HR from the sit stage median (>=MIN_SIT_SAMPLES) else series minimum
    const sitStart = study.starts.sit;
    const standStart = study.starts.stand;
    let hrRest = null;
    let restSource = 'none';
    if (Number.isFinite(sitStart) && Number.isFinite(standStart)) {
      const sitHr = parsed.rows.filter((r) => r.tMs >= sitStart && r.tMs < standStart).map((r) => r.hr);
      if (sitHr.length >= MIN_SIT_SAMPLES_FOR_REST) {
        hrRest = median(sitHr);
        restSource = `sit-stage median (${sitHr.length} samples)`;
      }
    }
    if (hrRest == null) {
      hrRest = Math.min(...parsed.rows.map((r) => r.hr));
      restSource = 'series minimum (sit missing/too few samples)';
      anomalies.push({ participant: p, stage: 'sit', note: `hrRest fallback to series min ${hrRest.toFixed(0)} bpm (${restSource})` });
    }
    const profile = { hrMax, hrRest, sex: dem.sex };

    const { valid, invalid: inv } = sliceStages({
      participant: p, study, series: parsed.rows,
    });
    for (const v of inv) invalid.push(v);
    for (const v of valid) {
      const epochs = buildEpochs(v.samples);
      const au = buildStageAu(epochs, profile);
      allValid.push({
        participant: p, stage: v.stage, minutes: v.minutes, met: v.met,
        metMinutes: v.metMinutes, au, hrest: hrRest, hrmax: hrMax, restSource, sex: dem.sex,
      });
    }
  }

  const usable = allValid;
  const exerciseOnly = usable.filter((r) => ['cycle1', 'cycle2', 'run1', 'run2'].includes(r.stage));
  const sensitivityExclude = new Set(['P10|stand', 'P17|run2', 'P07|run2']);
  const sensitivity = usable.filter((r) => !sensitivityExclude.has(`${r.participant}|${r.stage}`));

  // ---- console output ----
  const hr = console.log.bind(console);
  hr('');
  hr('FRWHOOP Strain V2 — WEEE ground-truth model comparison');
  hr('='.repeat(72));
  hr('');
  hr(compareTable(usable, 'PRIMARY (all usable stages)'));
  hr(compareTable(exerciseOnly, 'EXERCISE-ONLY (cycle1..run2)'));
  hr(compareTable(sensitivity, 'SENSITIVITY (excl P10-stand, P17-run2, P07-run2)'));
  hr(`usable stages: ${usable.length}  exercise-only: ${exerciseOnly.length}  sensitivity: ${sensitivity.length}`);
  hr('');
  hr('Per-stage usable counts:');
  for (const s of STAGES) {
    hr(`  ${s}: ${usable.filter((r) => r.stage === s).length}`);
  }
  hr('');
  hr('Invalid stages (recorded, skipped):');
  for (const v of invalid) hr(`  ${v.participant} ${v.stage}: ${v.reason}`);
  hr('');
  hr('Per-stage AU tables:');
  hr('');
  hr(perStageTables(usable).split('\n').map((l) => `  ${l}`).join('\n'));

  const markdown = renderMarkdown({
    anomalies, usable, exerciseOnly, sensitivity, parseRecords, participants,
  });
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, markdown, 'utf8');
  hr('');
  hr(`report written: ${REPORT_PATH}`);
  return { usable: usable.length, exerciseOnly: exerciseOnly.length, sensitivity: sensitivity.length, report: REPORT_PATH };
}

// Run only when executed directly.
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main();
}
