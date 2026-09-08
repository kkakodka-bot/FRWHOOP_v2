#!/usr/bin/env node
/**
 * Runtime-router evaluation (not oracle-family).
 *
 * The real classifyActivity + routeV3Minute see only signals available at
 * runtime (IMU features, HR, physiology). Criterion activity is never passed
 * as a sport label. Oracle-family MAE from train_eval.py is an estimator
 * upper bound and is not reported here as end-to-end V3.
 *
 * Run after train_eval.py:
 *   node energy/v3/research/evalRuntime.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyActivity } from '../../activity.js';
import { resolvePhysiology } from '../../physiology.js';
import { routeV3Minute } from '../router.js';
import { domainGate } from '../domain.js';
import { loadV3Artifact } from '../models.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(here, 'cache');
const ART = path.join(here, '../artifact');

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

function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const [h, ...lines] = fs.readFileSync(file, 'utf8').trim().split('\n');
  if (!h) return [];
  const cols = parseCsvLine(h);
  return lines.map((line) => {
    const p = parseCsvLine(line);
    const o = {};
    cols.forEach((c, i) => { o[c] = p[i]; });
    return o;
  });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function criterionFamily(row) {
  const f = row.activity_family;
  if (f === 'sedentary' || f === 'standing') return 'imu_sedentary';
  if (f === 'running') return 'hr_imu_locomotion';
  if (f === 'cycling') return 'hr_cycling';
  if (f === 'walking' || f === 'daily_activity' || f === 'strength') return 'v1';
  return 'v1';
}

function physFor(row) {
  const age = num(row.age);
  const year = Number.isFinite(age) ? 2026 - Math.round(age) : null;
  return resolvePhysiology({
    profile: {
      birthYear: year,
      weightKg: num(row.weight_kg),
      heightCm: num(row.height_cm),
      sex: row.sex || null,
    },
    prefs: { restingHr: num(row.resting_hr) },
  });
}

function featuresFor(row) {
  const motion = num(row.dyn_enmo_mean) ?? num(row.enmo_mean);
  return {
    hr: num(row.hr_mean),
    motion,
    motionMax: motion,
    motionStd: num(row.accel_std),
    motionActiveFraction: num(row.movement_intermittency),
    imu: {
      ...row,
      dyn_enmo_mean: num(row.dyn_enmo_mean),
      enmo_mean: num(row.enmo_mean),
      coverage: num(row.coverage) ?? 1,
      bandpass_motion_auc_20hz: num(row.bandpass_motion_auc_20hz) ?? num(row.mims_mean),
      vm_mean: num(row.vm_mean),
    },
  };
}

function qualityFor(row) {
  return {
    hr: num(row.hr_mean) != null ? 0.9 : 0,
    motion: 0.9,
  };
}

function metrics(pairs) {
  if (!pairs.length) {
    return { n: 0, mae: null, rmse: null, mape: null, bias: null };
  }
  const e = pairs.map(([y, yh]) => yh - y);
  const mae = e.reduce((s, v) => s + Math.abs(v), 0) / e.length;
  const rmse = Math.sqrt(e.reduce((s, v) => s + v * v, 0) / e.length);
  const bias = e.reduce((s, v) => s + v, 0) / e.length;
  const mapePairs = pairs.filter(([y]) => Math.abs(y) >= 0.5);
  const mape = mapePairs.length
    ? 100 * mapePairs.reduce((s, [y, yh]) => s + Math.abs(yh - y) / Math.abs(y), 0) / mapePairs.length
    : null;
  return {
    n: pairs.length,
    mae: round(mae, 3),
    rmse: round(rmse, 3),
    mape: mape == null ? null : round(mape, 2),
    bias: round(bias, 3),
  };
}

function round(n, p) {
  return Math.round(n * 10 ** p) / 10 ** p;
}

function confusion(rows) {
  const m = {};
  for (const r of rows) {
    const a = r.criterion_family;
    const b = r.runtime_family;
    m[a] = m[a] || {};
    m[a][b] = (m[a][b] || 0) + 1;
  }
  return m;
}

function riskCoverage(learned) {
  const sorted = learned.slice().sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
  const curve = [];
  const acc = [];
  for (let i = 0; i < sorted.length; i++) {
    acc.push([sorted[i].y, sorted[i].yhat]);
    if (i === sorted.length - 1 || (i + 1) % Math.max(1, Math.floor(sorted.length / 10)) === 0) {
      curve.push({
        coverage: round((i + 1) / sorted.length, 3),
        n: i + 1,
        ...metrics(acc),
      });
    }
  }
  return curve;
}

function main() {
  const weee = readCsv(path.join(CACHE, 'minutes_weee.csv'));
  const habits = readCsv(path.join(CACHE, 'minutes_habits.csv'));
  const minutes = [...weee, ...habits];
  const preds = readCsv(path.join(CACHE, 'lopo_family_preds.csv'));
  const predKey = new Map();
  for (const p of preds) {
    predKey.set(`${p.dataset}|${p.participant}|${p.minute_iso}|${p.oracle_family}`, num(p.oracle_pred));
    predKey.set(`${p.dataset}|${p.participant}|${p.minute_iso}|y`, num(p.y));
  }
  let artifact = null;
  const artPath = path.join(ART, 'energy-v3-runtime.json');
  if (fs.existsSync(artPath)) {
    artifact = loadV3Artifact(JSON.parse(fs.readFileSync(artPath, 'utf8')));
  }

  const routed = [];
  for (const row of minutes) {
    if (row.activity_family === 'strength') continue;
    const phys = physFor(row);
    const feat = featuresFor(row);
    const quality = qualityFor(row);
    const cls = classifyActivity(feat, phys, quality, { workout: null });
    let route = routeV3Minute({
      activity: cls.activity,
      confidence: cls.confidence,
      reason: cls.reason,
      placement: 'wrist',
      imu: feat.imu,
      hr: feat.hr,
      physiology: phys,
      quality,
    });
    const domain = route.use_learned && artifact?.domain
      ? domainGate(feat, artifact.domain, route.input_feature_groups, route.family)
      : { in_support: true, distance: null };
    if (route.use_learned && domain.in_support === false) {
      route = { ...route, family: 'v1_ood', use_learned: false, fallback_reason: 'ood_or_insufficient_domain' };
    }
    const y = num(row.criterion_met) ?? num(row.target_met);
    const oracleFam = criterionFamily(row);
    const oraclePred = predKey.get(`${row.dataset}|${row.participant}|${row.minute_iso}|${oracleFam}`) ?? null;
    let yhat = null;
    if (route.use_learned) {
      yhat = predKey.get(`${row.dataset}|${row.participant}|${row.minute_iso}|${route.family}`) ?? null;
      if (yhat == null) {
        route = { ...route, use_learned: false, fallback_reason: 'no_lopo_pred_for_family', family: 'v1_missing_inputs' };
      }
    }
    routed.push({
      dataset: row.dataset,
      participant: row.participant,
      activity: row.activity,
      activity_family: row.activity_family,
      criterion_family: oracleFam,
      runtime_family: route.use_learned ? route.family : (route.fallback_reason || route.family),
      runtime_activity: cls.activity,
      runtime_reason: cls.reason,
      router_reason: route.router_reason,
      abstained: !route.use_learned,
      y,
      oracle_pred: oraclePred,
      yhat,
      distance: domain.distance,
    });
  }

  const byDs = (ds) => routed.filter((r) => r.dataset === ds);
  function pack(rows, label) {
    const learned = rows.filter((r) => !r.abstained && r.yhat != null && r.y != null);
    const oracle = rows.filter((r) => r.oracle_pred != null && r.y != null);
    const both = rows.filter((r) => r.yhat != null && r.oracle_pred != null && r.y != null && !r.abstained);
    const correctFamily = rows.filter((r) => !r.abstained && r.runtime_family === r.criterion_family).length;
    const routedM = metrics(learned.map((r) => [r.y, r.yhat]));
    const oracleM = metrics(oracle.map((r) => [r.y, r.oracle_pred]));
    const bothRouted = metrics(both.map((r) => [r.y, r.yhat]));
    const bothOracle = metrics(both.map((r) => [r.y, r.oracle_pred]));
    return {
      label,
      n: rows.length,
      n_participants: new Set(rows.map((r) => r.participant)).size,
      coverage: rows.length ? round(learned.length / rows.length, 3) : 0,
      abstention_fallback_rate: rows.length ? round(rows.filter((r) => r.abstained).length / rows.length, 3) : 0,
      correct_family_rate: rows.length ? round(correctFamily / rows.length, 3) : 0,
      confusion: confusion(rows),
      runtime_router: routedM,
      oracle_family: oracleM,
      oracle_vs_routed_delta_mae: (bothRouted.mae != null && bothOracle.mae != null)
        ? round(bothRouted.mae - bothOracle.mae, 3)
        : null,
      on_routed_minutes: { runtime: bothRouted, oracle: bothOracle, n: both.length },
      risk_coverage: riskCoverage(learned),
      note: 'oracle_family is an estimator upper bound. runtime_router is the production decision.',
    };
  }

  const report = {
    eval_kind: 'runtime_router',
    never_report_oracle_as_e2e_v3: true,
    dataset_role: 'development_transfer_not_external_validation',
    weee: pack(byDs('weee'), 'weee'),
    habits: pack(byDs('habits'), 'habits'),
    overall: pack(routed, 'overall'),
  };
  fs.writeFileSync(path.join(CACHE, 'runtime_router_eval.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(ART, 'runtime-router-eval.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    weee_n: report.weee.n,
    weee_coverage: report.weee.coverage,
    weee_routed_mae: report.weee.runtime_router.mae,
    weee_oracle_mae: report.weee.oracle_family.mae,
    weee_delta_mae: report.weee.oracle_vs_routed_delta_mae,
    habits_n: report.habits.n,
    habits_coverage: report.habits.coverage,
    habits_routed_mae: report.habits.runtime_router.mae,
    out: path.join(ART, 'runtime-router-eval.json'),
  }, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
