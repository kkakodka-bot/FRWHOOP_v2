/**
 * Energy-model evaluation harness.
 *
 * Compares the candidate model against three baselines on the 179-day WHOOP
 * export in `frontend/src/data/day_wise_whoop_data.json`, which carries
 * per-minute HR, a per-minute activity label, sleep stages, WHOOP's own daily
 * "Energy burned (cal)" and WHOOP's own per-workout calories.
 *
 * WHOOP's numbers are an external *benchmark*, not ground truth. WHOOP does not
 * publish its algorithm and has no calorimetry behind it either, so agreement
 * with WHOOP is evidence of plausibility and of not being wildly miscalibrated —
 * nothing more. Phase 17 ground-truth sources (metabolic cart, published
 * datasets, manually entered VO2) plug in through `referenceDays` /
 * `referenceWorkouts` without touching the metric code below.
 *
 * Two limitations shape how these results must be read, and both are structural
 * rather than fixable here:
 *
 *   1. The export contains no wrist-motion channel. Every number below therefore
 *      exercises the HR channel and the activity-context path with motion
 *      absent. The motion channel and the channel-fusion logic are covered by
 *      unit tests, not by this dataset.
 *   2. The activity labels present are idle, sleep, Weightlifting, Running,
 *      Powerlifting, Swimming and Other. There is no walking or cycling label,
 *      so those estimators are unevaluated against reference data.
 *
 * Run: node energy/evaluate.js [--json] [--limit N]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { computeEnergy } from './service.js';
import { resolvePhysiology } from './physiology.js';
import { extractSeriesFeatures } from './features.js';
import { baselineBmrMultiplier, baselineKeytel, legacyFixedMet } from './baselines.js';
import {
  pearson, spearman, concordance, calibration, blandAltman, medianAbsErr,
  bootstrapCi,
} from './metrics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATASET = path.join(here, '../../frontend/src/data/day_wise_whoop_data.json');

/**
 * Subject assumptions for the export.
 *
 * The export carries no height, weight, sex or age. These are stated explicitly
 * rather than buried as defaults because every absolute kcal number below scales
 * with them: a 10 kg error moves daily resting energy by roughly 100 kcal. The
 * *relative* ranking of candidate against baselines is far less sensitive, which
 * is the comparison this harness exists to make.
 */
export const EVAL_SUBJECT = Object.freeze({
  sex: 'male',
  birthYear: 1996,
  heightCm: 180,
  weightKg: 78,
});

/** Map the export's activity labels onto our canonical classes. */
const LABEL_TO_ACTIVITY = {
  idle: 'rest',
  sleep: 'sleep',
  Weightlifting: 'strength',
  Powerlifting: 'strength',
  Running: 'running',
  Swimming: 'general',
  Activity: 'general',
  Other: 'general',
};

/** Parse the export's `YYYY-MM-DD HH:MM:SS` local-naive stamps against a zone offset. */
function parseStamp(stamp, tzOffset) {
  if (!stamp) return null;
  const iso = `${String(stamp).replace(' ', 'T')}${tzOffset || 'Z'}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function offsetOf(day) {
  const tz = day?.physiological_summary?.['Cycle timezone'];
  const m = /^UTC([+-]\d{2}):?(\d{2})$/.exec(String(tz || ''));
  return m ? `${m[1]}:${m[2]}` : 'Z';
}

/**
 * Turn one export day into engine inputs.
 *
 * Note what is deliberately *not* passed through: the per-minute `activity`
 * label. Handing the model the label it is supposed to infer would make the
 * evaluation meaningless. The label is kept only as the stratification key for
 * per-activity metrics.
 */
export function prepareDay(dayKey, day) {
  const offset = offsetOf(day);
  const samples = [];
  const labels = new Map();

  for (const row of day.bpm_data || []) {
    const t = parseStamp(row.datetime, offset);
    if (!t) continue;
    samples.push({
      t,
      bpm: row.bpm,
      stage: row.sleep_stage && row.sleep_stage !== 'none' ? row.sleep_stage : null,
      rr_ms: [],
    });
    labels.set(t.slice(0, 16), LABEL_TO_ACTIVITY[row.activity] || 'general');
  }

  const workouts = (day.workouts || []).map((w, i) => ({
    // Deterministic pseudo-id: the engine only uses it to group minutes.
    id: `${dayKey}-w${i}`,
    sport: w['Activity name'],
    start: parseStamp(w['Workout start time'], offset),
    end: parseStamp(w['Workout end time'], offset),
    reference_kcal: w['Energy burned (cal)'] ?? null,
    duration_min: w['Duration (min)'] ?? null,
  })).filter((w) => w.start && w.end);

  return {
    day: dayKey,
    samples,
    labels,
    workouts,
    prefs: { restingHr: day.physiological_summary?.['Resting heart rate (bpm)'] ?? null },
    referenceDailyKcal: day.physiological_summary?.['Energy burned (cal)'] ?? null,
  };
}

/** MAE / RMSE / MAPE / bias / R2 over paired (predicted, actual) values. */
export function scorePairs(pairs) {
  const n = pairs.length;
  if (!n) return { n: 0 };
  let absSum = 0;
  let sqSum = 0;
  let biasSum = 0;
  let pctSum = 0;
  let pctN = 0;
  let actualSum = 0;
  for (const [pred, actual] of pairs) {
    absSum += Math.abs(pred - actual);
    sqSum += (pred - actual) ** 2;
    biasSum += pred - actual;
    if (Math.abs(actual) > 1e-6) { pctSum += Math.abs((pred - actual) / actual); pctN += 1; }
    actualSum += actual;
  }
  const meanActual = actualSum / n;
  let ssTot = 0;
  for (const [, actual] of pairs) ssTot += (actual - meanActual) ** 2;

  return {
    n,
    mae: round(absSum / n, 3),
    rmse: round(Math.sqrt(sqSum / n), 3),
    mape: pctN ? round((pctSum / pctN) * 100, 2) : null,
    bias: round(biasSum / n, 3),
    r2: ssTot > 0 ? round(1 - sqSum / ssTot, 4) : null,
    mean_actual: round(meanActual, 2),
  };
}

/**
 * Run every model over the dataset.
 *
 * @param {object} opts
 * @param {string} opts.dataset  path to the export
 * @param {number} opts.limit    cap the number of days (for a fast smoke run)
 */
export function runEvaluation({ dataset = DEFAULT_DATASET, limit = Infinity, subject = EVAL_SUBJECT } = {}) {
  const raw = JSON.parse(fs.readFileSync(dataset, 'utf8'));
  const dayKeys = Object.keys(raw).sort();

  const dailyPairs = { candidate: [], bmr_multiplier: [], keytel: [], fixed_met: [] };
  const workoutPairs = { candidate: [], bmr_multiplier: [], keytel: [], fixed_met: [] };
  // Per-minute totals stratified by the export's own activity label. There is no
  // per-minute reference, so these are distribution summaries, not errors: the
  // question they answer is "is a lifting minute plausible", not "is it right".
  const minuteByActivity = new Map();
  const coverage = { days: 0, minutes: 0, unestimable: 0, skippedDays: 0 };

  let count = 0;
  for (const dayKey of dayKeys) {
    if (count >= limit) break;
    const prepared = prepareDay(dayKey, raw[dayKey]);
    // A day needs near-complete coverage and a resting HR before its total can be
    // compared to a daily reference; a half-logged day is not a model error.
    if (prepared.samples.length < 1200 || prepared.prefs.restingHr == null) {
      coverage.skippedDays += 1;
      continue;
    }
    count += 1;
    coverage.days += 1;

    const result = computeEnergy({
      samples: prepared.samples,
      profile: subject,
      prefs: prepared.prefs,
      workouts: prepared.workouts,
      timeZone: 'UTC',
    });
    coverage.minutes += result.minutes.length;
    coverage.unestimable += result.stats.skipped;

    const physiology = resolvePhysiology({ profile: subject, prefs: prepared.prefs });
    const baselineMinutes = runBaselines(prepared, physiology);

    // --- daily ---
    if (prepared.referenceDailyKcal != null) {
      const actual = prepared.referenceDailyKcal;
      const candTotal = sum(result.minutes, (m) => m.resting_kcal + m.active_kcal);
      dailyPairs.candidate.push([candTotal, actual]);
      dailyPairs.bmr_multiplier.push([sum(baselineMinutes.bmr, (m) => m.total_kcal), actual]);
      dailyPairs.keytel.push([sum(baselineMinutes.keytel, (m) => m.total_kcal), actual]);
      // Baseline 3 has no concept of non-workout energy, so its "day" is the sum
      // of its workout estimates. That is the honest representation of it.
      dailyPairs.fixed_met.push([
        prepared.workouts.reduce((a, w) => a + legacyFixedMet(w.duration_min, w.sport), 0),
        actual,
      ]);
    }

    // --- workouts ---
    for (const w of prepared.workouts) {
      if (w.reference_kcal == null) continue;
      const mins = result.minutes.filter((m) => m.workout_session_id === w.id);
      if (!mins.length) continue;
      const actual = w.reference_kcal;
      workoutPairs.candidate.push([sum(mins, (m) => m.resting_kcal + m.active_kcal), actual]);
      const span = [Date.parse(w.start), Date.parse(w.end)];
      const inSpan = (rows) => rows.filter((r) => r.ms >= span[0] && r.ms < span[1]);
      workoutPairs.bmr_multiplier.push([sum(inSpan(baselineMinutes.bmr), (m) => m.total_kcal), actual]);
      workoutPairs.keytel.push([sum(inSpan(baselineMinutes.keytel), (m) => m.total_kcal), actual]);
      workoutPairs.fixed_met.push([legacyFixedMet(w.duration_min, w.sport), actual]);
    }

    // --- per-minute distributions by reference activity label ---
    for (const m of result.minutes) {
      const label = prepared.labels.get(m.minute_at.slice(0, 16)) || 'general';
      if (!minuteByActivity.has(label)) minuteByActivity.set(label, []);
      minuteByActivity.get(label).push({
        total: m.resting_kcal + m.active_kcal,
        met: m.met,
        confidence: m.model_confidence,
        classified: m.activity_type,
      });
    }
  }

  return {
    dataset: path.basename(dataset),
    subject,
    coverage,
    daily: mapValues(dailyPairs, scorePairs),
    workouts: mapValues(workoutPairs, scorePairs),
    per_activity: summarizeActivities(minuteByActivity),
    classification: confusion(minuteByActivity),
  };
}

/** Baseline per-minute series over the same feature windows the candidate saw. */
function runBaselines(prepared, physiology) {
  const windows = extractSeriesFeatures(prepared.samples);
  const bmr = [];
  const keytel = [];
  for (const { features } of windows) {
    const ms = features.minuteMs;
    const b = baselineBmrMultiplier(features, physiology);
    if (b) bmr.push({ ...b, ms });
    const k = baselineKeytel(features, physiology);
    if (k) keytel.push({ ...k, ms });
  }
  return { bmr, keytel };
}

/**
 * Per-activity plausibility summary.
 *
 * `met_p50` is the number to read: a lifting minute should land in the 3–6 MET
 * band and a sleeping minute below 1.1, regardless of what the daily totals do.
 * A model that gets the day right by averaging a too-high rest against a too-low
 * workout is the failure Phase 16 explicitly rejects, and only this table shows it.
 */
function summarizeActivities(byActivity) {
  const out = {};
  for (const [label, rows] of byActivity) {
    const mets = rows.map((r) => r.met).sort((a, b) => a - b);
    const kcal = rows.map((r) => r.total).sort((a, b) => a - b);
    out[label] = {
      minutes: rows.length,
      met_p10: round(quantile(mets, 0.1), 2),
      met_p50: round(quantile(mets, 0.5), 2),
      met_p90: round(quantile(mets, 0.9), 2),
      kcal_per_min_p50: round(quantile(kcal, 0.5), 3),
      kcal_per_min_p90: round(quantile(kcal, 0.9), 3),
      mean_confidence: round(rows.reduce((a, r) => a + r.confidence, 0) / rows.length, 3),
    };
  }
  return out;
}

/** How often the classifier agreed with the export's own label. */
function confusion(byActivity) {
  const out = {};
  const EQUIV = {
    rest: new Set(['sedentary', 'standing', 'daily_activity']),
    sleep: new Set(['sleep']),
    strength: new Set(['strength']),
    running: new Set(['running']),
    general: new Set(['daily_activity', 'walking', 'workout_other', 'running', 'strength']),
  };
  for (const [label, rows] of byActivity) {
    const counts = new Map();
    let agree = 0;
    for (const r of rows) {
      counts.set(r.classified, (counts.get(r.classified) || 0) + 1);
      if (EQUIV[label]?.has(r.classified)) agree += 1;
    }
    out[label] = {
      minutes: rows.length,
      agreement: round(agree / rows.length, 3),
      top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([k, v]) => `${k}:${round((v / rows.length) * 100, 1)}%`),
    };
  }
  return out;
}

function sum(rows, pick) {
  let a = 0;
  for (const r of rows) a += pick(r) || 0;
  return a;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function mapValues(obj, fn) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}

function round(n, places) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function table(title, rows, columns) {
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  console.log(`\n${title}`);
  console.log(line(columns));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(columns.map((c) => r[c])));
}

export function printReport(report) {
  console.log('FRWHOOP energy model evaluation');
  console.log(`dataset            ${report.dataset}`);
  console.log(`days evaluated     ${report.coverage.days} (skipped ${report.coverage.skippedDays} for coverage or missing resting HR)`);
  console.log(`minutes estimated  ${report.coverage.minutes} (${report.coverage.unestimable} unestimable, left as gaps)`);
  console.log(`subject assumed    ${report.subject.sex}, ${report.subject.weightKg} kg, ${report.subject.heightCm} cm, born ${report.subject.birthYear}`);

  table(
    'Daily total kcal vs WHOOP daily (external benchmark, not ground truth)',
    Object.entries(report.daily).map(([model, s]) => ({ model, ...s })),
    ['model', 'n', 'mae', 'mape', 'rmse', 'bias', 'r2', 'mean_actual'],
  );

  table(
    'Per-workout kcal vs WHOOP workout (external benchmark)',
    Object.entries(report.workouts).map(([model, s]) => ({ model, ...s })),
    ['model', 'n', 'mae', 'mape', 'rmse', 'bias', 'r2', 'mean_actual'],
  );

  table(
    'Candidate per-minute distribution by reference activity label',
    Object.entries(report.per_activity).map(([activity, s]) => ({ activity, ...s })),
    ['activity', 'minutes', 'met_p10', 'met_p50', 'met_p90', 'kcal_per_min_p50', 'kcal_per_min_p90', 'mean_confidence'],
  );

  table(
    'Activity classifier vs reference label',
    Object.entries(report.classification).map(([activity, s]) => ({
      activity, minutes: s.minutes, agreement: s.agreement, predicted: s.top.join(' '),
    })),
    ['activity', 'minutes', 'agreement', 'predicted'],
  );
}

// pathToFileURL, not string concatenation: the repo lives under a path with a
// space in it, which percent-encodes and breaks a naive comparison.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const limitArg = args.indexOf('--limit');
  const report = runEvaluation({
    limit: limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity,
  });
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
}


/** Rich metric set for a model, with bootstrap CI on MAE and bias. */
export function scorePairsRich(pairs) {
  const base = scorePairs(pairs);
  return {
    ...base,
    med_abs_err: medianAbsErr(pairs),
    pearson: roundSafe(pearson(pairs), 4),
    spearman: roundSafe(spearman(pairs), 4),
    concordance: roundSafe(concordance(pairs), 4),
    calibration: calibration(pairs),
    bland_altman: blandAltman(pairs),
    mae_ci: bootstrapCi(pairs, (ps) => ps.reduce((a, p) => a + Math.abs(p[0] - p[1]), 0) / ps.length, { nResample: 500 }),
    bias_ci: bootstrapCi(pairs, (ps) => ps.reduce((a, p) => a + (p[0] - p[1]), 0) / ps.length, { nResample: 500 }),
  };
}
function roundSafe(v, p) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** p;
  return Math.round(v * f) / f;
}
