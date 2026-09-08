import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCanonicalMigrationFiles, CANONICAL_MIGRATIONS_DIR } from '../metrics/schemaReadiness.js';

const whoop = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function read(rel) {
  return fs.readFileSync(path.join(whoop, rel), 'utf8');
}

test('live get_day_snapshot ships shadows, spo2 candidate, and sleep.shadow_v3', () => {
  const owners = listCanonicalMigrationFiles().filter((name) => {
    const sql = fs.readFileSync(path.join(CANONICAL_MIGRATIONS_DIR, name), 'utf8');
    return /create or replace function public\.get_day_snapshot\s*\(/i.test(sql);
  });
  const latest = owners.sort().at(-1);
  const sql = fs.readFileSync(path.join(CANONICAL_MIGRATIONS_DIR, latest), 'utf8');
  assert.match(sql, /'shadows', m\.extras->'shadows'/);
  assert.match(sql, /spo2_candidate_pct/);
  assert.match(sql, /shadow_v3/);
  assert.match(sql, /battery_timeline/);
  assert.match(sql, /hr_v2/);
  assert.match(sql, /'shadows', d\.extras->'shadows'/);
  assert.doesNotMatch(sql, /spo2_pct',\s*m\.extras/);
});

test('engine persists extras.hr_v2 and energy_v2; V3 needs complete v21', () => {
  const engine = read('backend/metrics/engine.js');
  assert.match(engine, /extras\.hr_v2|hr_v2: \{/);
  assert.match(engine, /energy_v2: energy\.shadow|energy_v2: energy\?\.shadow/);
  assert.match(engine, /hasCompleteV21Imu/);
  assert.match(engine, /v21_frames_incomplete/);
  assert.match(engine, /computeEnergyV2/);
  assert.doesNotMatch(engine, /avg_hr_bpm:\s*hr2/);
  assert.match(engine, /daily_metrics\.steps is always the V1/);
});

test('snapshot and WhoopDay map shadows without replacing canonical strain/steps', () => {
  const snap = read('backend/metrics/snapshot.js');
  assert.match(snap, /buildShadowReadModel/);
  assert.match(snap, /compactSleepV3/);
  const whoop = read('frontend/src/lib/daySnapshotModel.js');
  assert.match(whoop, /shadows:/);
  assert.match(whoop, /'Day Strain': presentMetric\(m\.strain_score\)/);
  assert.match(whoop, /Steps: presentMetric\(m\.steps\)/);
  assert.match(whoop, /'Blood oxygen %': presentMetric\(m\.spo2_pct\)/);
});

test('App does not mount the 2024 WHOOP export fixture as production data', () => {
  const app = read('frontend/src/App.jsx');
  assert.doesNotMatch(app, /day_wise_whoop_data/);
  const store = read('frontend/src/data/whoopDataStore.js');
  assert.doesNotMatch(store, /day_wise_whoop_data/);
  const overview = read('frontend/src/features/overview/overviewModel.js');
  assert.doesNotMatch(overview, /day_wise_whoop_data/);
});

test('registry does not promote shadow engines because wiring exists', () => {
  const reg = read('backend/metrics/canonicalRegistry.js');
  assert.match(reg, /status: 'canonical'/);
  assert.match(reg, /energy_v2:/);
  assert.doesNotMatch(reg, /hr_v2:[^}]*status: 'canonical'/s);
  assert.doesNotMatch(reg, /strain_v2:[^}]*status: 'canonical'/s);
  assert.doesNotMatch(reg, /steps_v3:[^}]*status: 'canonical'/s);
  assert.doesNotMatch(reg, /energy_v3:[^}]*status: 'canonical'/s);
});
