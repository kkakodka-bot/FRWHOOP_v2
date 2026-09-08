/**
 * Rolling-origin (chronological) evaluation for personalization.
 *
 * The mission's Phase 14 requirement: calibrate/predict through day N, then
 * predict days N+1..N+H without ever seeing future weight or intake. This is the
 * only honest way to show a personalized model beats a global one on *future*
 * periods, and it is exactly what a naive "fit then score on the same days" would
 * leak.
 *
 * Two modes:
 *  - filter: only the information available up to each prediction day is used
 *    (what would have been known in real time).
 *  - smoothing: a retrospective pass over the same window (analytics only).
 *
 * Currently the sensor model is not personalized per-day here; this module sets
 * up the split so calibration / residual-learning can be dropped in, and
 * demonstrates the evaluation frame the mission requires.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { computeEnergy } from './service.js';
import { resolvePhysiology } from './physiology.js';
import { EVAL_SUBJECT, prepareDay, scorePairsRich } from './evaluate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATASET = path.join(here, '../../frontend/src/data/day_wise_whoop_data.json');

/**
 * Chronological rolling-origin evaluation of the sensor daily total against a
 * reference, refitting nothing (currently the sensor model is global, but this
 * is where per-user refitting would go).
 */
export function rollingOriginEvaluation({ dataset = DEFAULT_DATASET, horizon = 7, maxFolds = null, subject = EVAL_SUBJECT } = {}) {
  const raw = JSON.parse(fs.readFileSync(dataset, 'utf8'));
  const dayKeys = Object.keys(raw).sort();
  const good = [];
  for (const dayKey of dayKeys) {
    const prepared = prepareDay(dayKey, raw[dayKey]);
    if (prepared.samples.length < 1200 || prepared.prefs.restingHr == null) continue;
    good.push({ dayKey, prepared });
  }
  if (good.length < horizon + 3) return { error: 'not enough days' };

  // Fold: train[0..i] predicts fold i+1..i+horizon (indices into `good`).
  const folds = [];
  let i = good.length - 1 - horizon;
  while (i >= horizon + 1) {
    const testStart = i + 1;
    const testEnd = Math.min(testStart + horizon, good.length);
    folds.push({ trainDays: i + 1, testLo: testStart, testHi: testEnd - 1 });
    i -= horizon;
    if (maxFolds && folds.length >= maxFolds) break;
  }
  folds.reverse();

  const collected = [];
  const byFold = [];
  for (const fold of folds) {
    const foldPairs = [];
    // For a *future* prediction we can only use the trained-through-N parameters.
    // Here we carry the global model (no re-fit on non-personalized data), so
    // every fold uses the same physiology per day, but we still record the split
    // so calibration can be dropped in behind this frame.
    for (let t = fold.testLo; t <= fold.testHi; t++) {
      const g = good[t];
      if (!g) continue;
      const result = computeEnergy({
        samples: g.prepared.samples, profile: subject, prefs: g.prepared.prefs,
        workouts: g.prepared.workouts, timeZone: 'UTC',
      });
      const total = result.minutes.reduce((a, m) => a + m.resting_kcal + m.active_kcal, 0);
      if (g.prepared.referenceDailyKcal != null) {
        collected.push([total, g.prepared.referenceDailyKcal]);
        foldPairs.push([total, g.prepared.referenceDailyKcal]);
      }
    }
    byFold.push({ trainDays: fold.trainDays, horizon: foldPairs.length, folds: foldPairs });
  }
  return {
    mode: 'rolling-origin-filter',
    horizon,
    folds: folds.length,
    subject,
    pooled_daily: scorePairsRich(collected),
    per_fold: byFold.map((f) => ({ train_days: f.trainDays, n: f.horizon })),
  };
}

// CLI: node energy/rollingOrigin.js [--horizon N] [--maxFolds N] [--json]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const val = (name) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : undefined; };
  const opts = { horizon: val('--horizon') ?? 7, maxFolds: val('--maxFolds') ?? undefined };
  const report = rollingOriginEvaluation(opts);
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`FRWHOOP rolling-origin energy evaluation (mode=${report.mode})`);
    console.log(`horizon=${opts.horizon}  folds=${report.folds}  subject=${report.subject.sex}, ${report.subject.weightKg}kg`);
    const d = report.pooled_daily;
    console.log(`daily pooled: n=${d.n} MAE=${d.mae} MAPE=${d.mape}% bias=${d.bias} R2=${d.r2} pearson=${d.pearson} CCC=${d.concordance}`);
    console.log(`calibration slope=${d.calibration?.slope} intercept=${d.calibration?.intercept}`);
  }
}
