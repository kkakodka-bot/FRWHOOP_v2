import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAblationExperiment } from '../energy/ablationExperiment.mjs';

// The WEEE public dataset (CC BY 4.0) is fetched research data, never committed.
// These tests run wherever backend/data/weee/dataset exists (layout documented in
// backend/energy/weeeLoader.js) and skip with a reason on a clean clone.
const here = path.dirname(fileURLToPath(import.meta.url));
const WEEE_PRESENT = fs.existsSync(
  path.resolve(here, '../data/weee/dataset/Study_Information.csv'),
);

test('ablation: IMU beats baseline, HR adds little, no NaN, components finite', { skip: WEEE_PRESENT ? false : 'WEEE dataset not fetched (backend/data/weee/dataset, see backend/energy/weeeLoader.js)' }, () => {
  const r = runAblationExperiment({ nRepeats: 5 });
  const c = r.components;
  // all finite
  for (const k of Object.keys(c)) assert.ok(Number.isFinite(c[k].mae), `${k} mae finite`);
  assert.ok(Number.isFinite(c.baseline.mae));
  assert.ok(Number.isFinite(c.imu.mae));
  // IMU learning is the big win: imu MAE well below baseline
  assert.ok(c.imu.mae < c.baseline.mae * 0.75, `imu ${c.imu.mae} < baseline ${c.baseline.mae}`);
  // HR adds little: imu_hr MAE within 0.15 of imu
  assert.ok(Math.abs(c.imu_hr.mae - c.imu.mae) < 0.15, `imu_hr ${c.imu_hr.mae} ~ imu ${c.imu.mae}`);
  // IMU R2 positive and better than baseline
  assert.ok(c.imu.r2 > c.baseline.r2, 'imu R2 > baseline R2');
  assert.ok(c.loco.mae > c.imu.mae, 'cadence-derived locomotion worse than direct IMU (wrist caution)');
});
