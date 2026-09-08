/**
 * Honest WEEE evaluation for Energy V3.
 *
 * Labels: gross MET = mean VO2[mL/kg/min] / 3.5 from VO2 Master DataAverage.
 * Study_Information MET_* columns are protocol/Compendium labels and are NOT
 * used as targets.
 *
 * Nested leave-one-participant-out (outer) + lambda grid (inner). P14–P17 are
 * not a frozen holdout: they influenced the research feature list / lag
 * comparison, so they are not reported as untouched test subjects.
 *
 * The shipped V3 engine is V1 physiology with optional wrist 6-axis motion,
 * not this ridge. Ridge numbers are a WEEE E4 research bound only.
 *
 * Run: node energy/v3/evaluateWeee.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadV2Gbm, predictV2Gbm } from '../v2/gbm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '../../../..');
const EPOCHS = path.join(ROOT, '_energy_v2_research/experiments/weee_epochs.csv');
const MINUTES = path.join(ROOT, '_energy_v2_research/experiments/weee_minutes_extractor.csv');
const ARTIFACT = path.join(here, '../v2/artifact/energy-v2-lgb-runtime.json');
const LAMBDAS = [1e-3, 1e-2, 1e-1];
const RICH = ['enmo_mean', 'enmo_mad', 'vm_mean', 'accel_std', 'jerk_mean', 'hr_mean', 'hrr_frac',
  'cadence_cycles_per_min', 'movement_intermittency', 'entropy', 'periodicity_strength'];
const SCALAR = ['enmo_mean', 'hr_mean', 'hrr_frac'];

function parseCsv(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  const [header, ...lines] = text.split('\n');
  const cols = header.split(',');
  return lines.map((line) => {
    const parts = line.split(',');
    const row = {};
    for (let i = 0; i < cols.length; i++) {
      const v = parts[i];
      const n = Number(v);
      row[cols[i]] = v === '' || v == null ? null : (Number.isFinite(n) && v.trim() !== '' ? n : v);
    }
    return row;
  });
}

function mae(pairs) {
  if (!pairs.length) return null;
  return pairs.reduce((s, [y, yhat]) => s + Math.abs(y - yhat), 0) / pairs.length;
}
function rmse(pairs) {
  if (!pairs.length) return null;
  return Math.sqrt(pairs.reduce((s, [y, yhat]) => s + (y - yhat) ** 2, 0) / pairs.length);
}
function bias(pairs) {
  if (!pairs.length) return null;
  return pairs.reduce((s, [y, yhat]) => s + (yhat - y), 0) / pairs.length;
}
function blandAltman(pairs) {
  const diffs = pairs.map(([y, yhat]) => yhat - y);
  const m = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - m) ** 2, 0) / diffs.length);
  return { bias: m, loa_low: m - 1.96 * sd, loa_high: m + 1.96 * sd };
}

function ridgeFit(X, y, lambda = 1e-2) {
  const n = X.length;
  const p = X[0].length;
  const A = X.map((row) => [1, ...row]);
  const cols = p + 1;
  const xtx = Array.from({ length: cols }, () => Array(cols).fill(0));
  const xty = Array(cols).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < cols; j++) {
      xty[j] += A[i][j] * y[i];
      for (let k = 0; k < cols; k++) xtx[j][k] += A[i][j] * A[i][k];
    }
  }
  for (let j = 1; j < cols; j++) xtx[j][j] += lambda;
  return solve(xtx, xty);
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
    [M[i], M[piv]] = [M[piv], M[i]];
    const d = M[i][i] || 1e-12;
    for (let k = i; k <= n; k++) M[i][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r][i];
      for (let k = i; k <= n; k++) M[r][k] -= f * M[i][k];
    }
  }
  return M.map((row) => row[n]);
}

function ridgePredict(w, row) {
  let s = w[0];
  for (let i = 0; i < row.length; i++) s += w[i + 1] * row[i];
  return s;
}

function vec(row, keys) {
  return keys.map((k) => {
    const v = Number(row[k]);
    return Number.isFinite(v) ? v : 0;
  });
}

function round(n, p = 3) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** p) / 10 ** p;
}

function pairRows(rows, pred) {
  const pairs = [];
  const withAct = [];
  const bySub = new Map();
  for (const r of rows) {
    const y = Number(r.target_met ?? r.target_met_minute);
    const yhat = pred(r);
    if (!Number.isFinite(y) || !Number.isFinite(yhat)) continue;
    pairs.push([y, yhat]);
    withAct.push({ activity: r.activity, participant: r.participant, y, yhat });
    if (!bySub.has(r.participant)) bySub.set(r.participant, []);
    bySub.get(r.participant).push([y, yhat]);
  }
  return { pairs, withAct, bySub };
}

function byActivity(withAct) {
  const g = new Map();
  for (const row of withAct) {
    if (!g.has(row.activity)) g.set(row.activity, []);
    g.get(row.activity).push([row.y, row.yhat]);
  }
  const out = {};
  for (const [k, pairs] of [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out[k] = { n: pairs.length, mae: round(mae(pairs)), rmse: round(rmse(pairs)), bias: round(bias(pairs)) };
  }
  return out;
}

function perSubject(bySub) {
  const out = {};
  const maes = [];
  for (const [pid, pairs] of [...bySub.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out[pid] = { n: pairs.length, mae: round(mae(pairs)), rmse: round(rmse(pairs)), bias: round(bias(pairs)) };
    maes.push(mae(pairs));
  }
  const m = maes.reduce((a, b) => a + b, 0) / maes.length;
  const se = Math.sqrt(maes.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(maes.length - 1, 1)) / Math.sqrt(maes.length);
  return { subjects: out, clustered_mae_mean: round(m), clustered_mae_se: round(se) };
}

function score(name, rows, pred) {
  const { pairs, withAct, bySub } = pairRows(rows, pred);
  if (!pairs.length) return { name, n: 0 };
  const ba = blandAltman(pairs);
  const clustered = perSubject(bySub);
  return {
    name, n: pairs.length,
    mae: round(mae(pairs)),
    rmse: round(rmse(pairs)),
    bias: round(bias(pairs)),
    bland_altman: { bias: round(ba.bias), loa95: [round(ba.loa_low), round(ba.loa_high)] },
    by_activity: byActivity(withAct),
    per_subject: clustered.subjects,
    clustered_mae_mean: clustered.clustered_mae_mean,
    clustered_mae_se: clustered.clustered_mae_se,
  };
}

function uniqueParticipants(rows) {
  return [...new Set(rows.map((r) => r.participant))].sort();
}

function fitMatrix(rows, keys) {
  const X = [], y = [];
  for (const r of rows) {
    const t = Number(r.target_met);
    if (!Number.isFinite(t)) continue;
    X.push(vec(r, keys));
    y.push(t);
  }
  return { X, y };
}

function innerLambda(trainRows, keys) {
  const parts = uniqueParticipants(trainRows);
  if (parts.length < 3) return 1e-2;
  let best = LAMBDAS[0], bestMae = Infinity;
  for (const lam of LAMBDAS) {
    const pairs = [];
    for (const held of parts) {
      const innerTrain = trainRows.filter((r) => r.participant !== held);
      const innerTest = trainRows.filter((r) => r.participant === held);
      const { X, y } = fitMatrix(innerTrain, keys);
      if (X.length < keys.length + 2) continue;
      const w = ridgeFit(X, y, lam);
      for (const r of innerTest) {
        const t = Number(r.target_met);
        if (!Number.isFinite(t)) continue;
        pairs.push([t, ridgePredict(w, vec(r, keys))]);
      }
    }
    const m = mae(pairs);
    if (m != null && m < bestMae) { bestMae = m; best = lam; }
  }
  return best;
}

function nestedLoso(epochs, keys, name) {
  const parts = uniqueParticipants(epochs);
  const preds = [];
  const lambdas = {};
  for (const held of parts) {
    const train = epochs.filter((r) => r.participant !== held);
    const test = epochs.filter((r) => r.participant === held);
    const lam = innerLambda(train, keys);
    lambdas[held] = lam;
    const { X, y } = fitMatrix(train, keys);
    if (!X.length) continue;
    const w = ridgeFit(X, y, lam);
    for (const r of test) {
      const t = Number(r.target_met);
      if (!Number.isFinite(t)) continue;
      preds.push({ ...r, _yhat: ridgePredict(w, vec(r, keys)) });
    }
  }
  return { ...score(name, preds, (r) => r._yhat), nested: true, inner_lambda_by_heldout: lambdas };
}

function overlappingWindows(epochs) {
  const byP = new Map();
  for (const r of epochs) {
    if (!byP.has(r.participant)) byP.set(r.participant, []);
    byP.get(r.participant).push(r);
  }
  let overlap = 0;
  for (const rows of byP.values()) {
    const starts = rows.map((r) => Date.parse(r.epoch_start_iso)).filter(Number.isFinite).sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) {
      if (starts[i] < starts[i - 1] + 10_000) overlap += 1;
    }
  }
  return overlap;
}

function main() {
  if (!fs.existsSync(EPOCHS) || !fs.existsSync(MINUTES)) {
    console.log(JSON.stringify({ error: 'weee_csv_missing', EPOCHS, MINUTES }));
    process.exit(0);
  }
  const epochs = parseCsv(EPOCHS);
  const minutes = parseCsv(MINUTES);
  const sitTargets = epochs.filter((r) => r.activity === 'sit' && r.participant === 'P01').map((r) => r.target_met);
  const uniqueSit = new Set(sitTargets.map((v) => Number(v).toFixed(3)));

  let v2 = null;
  try {
    const artifact = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
    const model = loadV2Gbm(artifact);
    v2 = {
      ...score('v2_lgb_all17_fit_not_heldout', minutes, (r) => predictV2Gbm(model, r)?.met ?? null),
      invalid_as_heldout: true,
      artifact_n_participants: artifact.n_participants,
      note: 'Committed LGB was fit on all 17 participants. Do not report as held-out.',
    };
  } catch (err) {
    v2 = { name: 'v2_lgb', error: String(err.message || err) };
  }

  const report = {
    dataset: 'WEEE Empatica E4 + VO2 Master (CC BY 4.0)',
    target: {
      definition: 'gross_MET = mean(VO2_mL_per_kg_min) / 3.5 over the epoch',
      source: 'PXX/VO2/DataAverage.csv',
      not_used: 'Study_Information.csv MET_* protocol/Compendium labels',
      p01_sit_unique_vo2_mets: uniqueSit.size,
      p01_sit_constant_would_be_protocol_label: uniqueSit.size === 1,
    },
    split: 'nested leave-one-participant-out; inner lambda in {0.001,0.01,0.1}',
    p14_p17: 'NOT a valid untouched holdout — feature list and lag comparison used the same table',
    n_epochs: epochs.length,
    n_minutes: minutes.length,
    participants: uniqueParticipants(epochs),
    overlapping_or_shorter_than_10s_epochs: overlappingWindows(epochs),
    placement: 'wrist_only',
    bicep: 'no calorimetry in this dataset — unvalidated',
    shipped_v3: 'Not this ridge. Production V3 is V1 physiology + optional wrist 6-axis ENMO motion.',
    results: [
      nestedLoso(epochs, SCALAR, 'v3_ridge_scalar_enmo_hr_nested_loso'),
      nestedLoso(epochs, RICH, 'v3_ridge_rich_imu_nested_loso'),
      score('v1_prior_epochs', epochs, (r) => Number(r.v1_prior_met)),
      score('v1_prior_minutes', minutes, (r) => Number(r.v1_prior_met)),
      v2,
    ],
    gate: 'KEEP SHADOW',
    blockers: [
      'No WHOOP strap + indirect calorimetry',
      'No bicep + calorimetry',
      'WEEE is E4 32 Hz wrist accel, not WHOOP 100 Hz six-axis',
      'Shipped V3 engine is not the WEEE ridge',
    ],
  };
  console.log(JSON.stringify(report, null, 2));
}

main();
