import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadWeeeDataset } from '../energy/weeeLoader.js';
import { buildWeeeDataset } from '../energy/weeeExperiments.js';
import { ridgeFit, ridgePredict } from '../energy/weeeExperiment.mjs';
import { energyEquivalentKcalPerL, gtEnergyFromVo2 } from '../energy/groundTruth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../data/weee/dataset');

// Same WEEE dataset gating as tests/ablation.test.js: fetched research data
// (CC BY 4.0), never committed. Skips with a reason on a clean clone.
const WEEE_PRESENT = fs.existsSync(path.resolve(here, '../data/weee/dataset/Study_Information.csv'));
const SKIP_REASON = WEEE_PRESENT ? false : 'WEEE dataset not fetched (backend/data/weee/dataset, see backend/energy/weeeLoader.js)';

test('WEEE loader parses participants, demographics and 6 segments each with VO2', { skip: SKIP_REASON }, () => {
  const ds = loadWeeeDataset(ROOT);
  assert.ok(ds.participants.length >= 15, `participants ${ds.participants.length}`);
  const p0 = ds.participants[0];
  assert.ok(p0.segs.length === 6, `P01 segments ${p0.segs.length}`);
  assert.ok(p0.dem.Weight && parseFloat(p0.dem.Weight) > 30, 'has weight');
  for (const s of p0.segs) {
    assert.ok(s.vo2 && s.vo2.length > 0, `segment ${s.activity} has VO2`);
    assert.ok(Number.isFinite(s.metGt) || s.metGt == null, 'metGt parse');
  }
});

test('WEEE buildWeeeDataset yields per-activity ground-truth MET that rises with intensity', { skip: SKIP_REASON }, () => {
  const rows = buildWeeeDataset(ROOT);
  assert.ok(rows.length >= 80, `rows ${rows.length}`);
  const mean = (a) => {
    const v = rows.filter((d) => d.activity === a).map((d) => d.metGt);
    return v.length ? v.reduce((x, y) => x + y, 0) / v.length : 0;
  };
  const sit = mean('sit'), run = mean('run2');
  assert.ok(run > sit, `run2 ${run} should exceed sit ${sit}`);
  // wrist motion (enmo) rises for running vs cycling/sit (confirmed in data)
  const enmo = (a) => {
    const v = rows.filter((d) => d.activity === a);
    return v.length ? v.reduce((x, d) => x + d.agg.enmo_mean, 0) / v.length : 0;
  };
  assert.ok(enmo('run2') > enmo('sit'), `run enmo ${enmo('run2')} > sit ${enmo('sit')}`);
});

test('ridge with intercept reproduces y = 2x + 1 exactly', { skip: SKIP_REASON }, () => {
  const X = [[1],[2],[3],[4],[5]];
  const y = [3,5,7,9,11];
  const fit = ridgeFit(X, y, 0.0001);
  const pred = X.map((x) => ridgePredict(fit, x));
  pred.forEach((p, i) => assert.ok(Math.abs(p - y[i]) < 1e-3, `pred ${p} vs ${y[i]}`));
});

test('ground-truth VO2 to MET/kcal uses the RER-dependent energy equivalent', { skip: SKIP_REASON }, () => {
  assert.ok(energyEquivalentKcalPerL(1.0) > energyEquivalentKcalPerL(0.7));
  const e = gtEnergyFromVo2({ vo2MlPerKgMin: 3.5, weightKg: 70 });
  assert.equal(e.met, 1);
});
