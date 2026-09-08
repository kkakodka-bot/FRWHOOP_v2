import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCurrencyExperiment } from '../energy/currencyExperiment.mjs';

// Same WEEE dataset gating as tests/ablation.test.js: fetched research data,
// never committed. Skips with a reason on a clean clone.
const here = path.dirname(fileURLToPath(import.meta.url));
const WEEE_PRESENT = fs.existsSync(
  path.resolve(here, '../data/weee/dataset/Study_Information.csv'),
);

test('internal currency (MET/VO2/kcal) is mathematically free: equal MET-eq MAE and R2', { skip: WEEE_PRESENT ? false : 'WEEE dataset not fetched (backend/data/weee/dataset, see backend/energy/weeeLoader.js)' }, () => {
  const r = runCurrencyExperiment({ nRepeats: 5 });
  const met = r.per_currency.met;
  const vo2 = r.per_currency.vo2;
  const kcal = r.per_currency.kcal;
  // VO2 in MET-eq = vo2.mae / 3.5; must match met.mae closely
  const vo2met = vo2.mae / 3.5;
  assert.ok(Math.abs(vo2met - met.mae) < 1e-3, `VO2-eq ${vo2met} vs MET ${met.mae}`);
  // R2 should be essentially identical (scale-invariant)
  assert.ok(Math.abs(vo2.r2 - met.r2) < 1e-6, `R2 ${vo2.r2} vs ${met.r2}`);
  assert.ok(Math.abs(kcal.r2 - met.r2) < 0.02, `kcal R2 ${kcal.r2} vs MET ${met.r2}`);
});
