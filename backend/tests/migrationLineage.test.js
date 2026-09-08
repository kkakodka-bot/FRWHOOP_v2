import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCanonicalMigrationLineage,
  CANONICAL_MIGRATIONS_DIR,
  OBSOLETE_MIGRATIONS_DIR,
  OBSOLETE_QUARANTINE_MARKER,
  listCanonicalMigrationFiles,
} from '../metrics/schemaReadiness.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('canonical migrations live under supabase/migrations', () => {
  const files = listCanonicalMigrationFiles();
  assert.ok(files.includes('20260819190000_frwhoop_base_schema.sql'));
  assert.ok(files.includes('20260824180000_production_persistence.sql'));
  assert.ok(files.includes('20260830280000_steps_v3_reference_hardening.sql'));
  assert.ok(files.includes('20260831024452_steps_v3_reference_hardening.sql'));
  assert.ok(files.includes('20260831030000_steps_v3_reference_hardening.sql'));
  assert.ok(files.includes('20260831224500_day_snapshot_available_sources.sql'));
  assert.ok(files.includes('20260901002700_canonical_snapshot_availability.sql'));
  assert.ok(files.includes('20260901004753_snapshot_energy_steps_contract.sql'));
  assert.ok(files.includes('20260901010629_sleep_persist_state.sql'));
  assert.ok(files.includes('20260901010751_sleep_persist_state_rpcs.sql'));
  assert.ok(files.includes('20260901012423_database_security_hardening.sql'));
  assert.ok(files.includes('20260901022006_snapshot_hr_occupied_buckets.sql'));
  assert.ok(files.includes('20260901022058_snapshot_hr_occupied_coverage.sql'));
  assert.ok(files.includes('20260901204500_skin_temp_display.sql'));
  assert.ok(files.includes('20260902010000_sleep_stager_v3_shadow.sql'));
  assert.ok(files.includes('20260902120000_sleep_stager_v3_shadow_rpc.sql'));
  assert.ok(files.includes('20260902140000_snapshot_persisted_metrics.sql'));
  assert.ok(files.includes('20260902220000_shadow_read_model_snapshot.sql'));
  const snapshotSql = fs.readFileSync(
    path.join(CANONICAL_MIGRATIONS_DIR, '20260831224500_day_snapshot_available_sources.sql'),
    'utf8',
  );
  const availabilitySql = fs.readFileSync(
    path.join(CANONICAL_MIGRATIONS_DIR, '20260901002700_canonical_snapshot_availability.sql'),
    'utf8',
  );
  assert.doesNotMatch(availabilitySql, /sleep_details d\s+where d\.user_id = uid and d\.day = p_day/);
  assert.match(availabilitySql, /d\.original_end_at >= bounds\.day_start_at/);
  assert.match(snapshotSql, /apple_watch_step_buckets/);
  assert.match(snapshotSql, /energy_daily/);
  assert.match(snapshotSql, /kind in \('sleep', 'nap'\)/);
  assert.match(snapshotSql, /basal_kcal/);
  assert.match(CANONICAL_MIGRATIONS_DIR.replace(/\\/g, '/'), /supabase\/migrations$|\/migrations$/);
  const lineage = assertCanonicalMigrationLineage();
  assert.equal(lineage.ok, true);
  const contractSql = fs.readFileSync(
    path.join(CANONICAL_MIGRATIONS_DIR, '20260901004753_snapshot_energy_steps_contract.sql'),
    'utf8',
  );
  assert.match(contractSql, /'steps', m\.steps,/);
  assert.doesNotMatch(contractSql, /'steps', coalesce\(m\.steps/);
  assert.doesNotMatch(contractSql, /'steps', coalesce\(d\.steps/);
  assert.match(contractSql, /coalesce\(\s*e\.total_kcal/);
  assert.match(contractSql, /'source', case when d\.steps is not null then 'strap'/);
});

test('live get_day_snapshot is the newest copy and counts occupied HR buckets', () => {
  const owners = listCanonicalMigrationFiles().filter((name) => {
    const sql = fs.readFileSync(path.join(CANONICAL_MIGRATIONS_DIR, name), 'utf8');
    return /create or replace function public\.get_day_snapshot\s*\(/i.test(sql);
  });
  assert.ok(owners.length > 1, 'historical copies stay for greenfield apply order');
  const latest = owners.sort().at(-1);
  const sql = fs.readFileSync(path.join(CANONICAL_MIGRATIONS_DIR, latest), 'utf8');
  assert.match(sql, /hr_series_occupied_buckets/, `edit ${latest}, not an older get_day_snapshot copy`);
  assert.match(sql, /skin_temp_c/, `edit ${latest}: snapshot must expose skin_temp_c`);
  assert.match(sql, /skin_temp_series/, `edit ${latest}: snapshot must expose 12-min skin_temp_series`);
  assert.match(sql, /sleep_debt_balance_min/, `edit ${latest}: snapshot must expose persisted sleep debt`);
  assert.match(sql, /sleep_consistency/, `edit ${latest}: snapshot must expose sleep consistency`);
  assert.match(sql, /vo2max/, `edit ${latest}: snapshot must expose vo2max`);
  assert.match(sql, /spo2_candidate_pct/, `edit ${latest}: snapshot must expose experimental SpO2 candidate`);
  assert.match(sql, /strain_score_v2/, `edit ${latest}: snapshot must expose shadow strain V2`);
  assert.doesNotMatch(sql, /jsonb_array_length\(s\.hr_series\)/);
  const rangeFn = sql.slice(sql.search(/create or replace function public\.get_range/i));
  assert.match(rangeFn, /sleep_debt_balance_min/);
  assert.match(rangeFn, /sleep_consistency/);
  assert.match(rangeFn, /vo2max/);
  assert.match(rangeFn, /strain_score_v2/);
  assert.match(rangeFn, /spo2_candidate_pct/);
  assert.match(rangeFn, /'shadows', d\.extras->'shadows'/);
  assert.doesNotMatch(rangeFn, /strain_series/);
  assert.doesNotMatch(rangeFn, /spo2_candidate_series/);
  assert.doesNotMatch(rangeFn, /hypnogram/);
});

test('obsolete competing root must be quarantined when present', () => {
  if (!fs.existsSync(OBSOLETE_MIGRATIONS_DIR)) {
    assert.ok(true, 'obsolete root absent on this checkout');
    return;
  }
  assert.equal(fs.existsSync(OBSOLETE_QUARANTINE_MARKER), true);
});

test('empty migration dir fails lineage validation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-mig-'));
  assert.throws(
    () => assertCanonicalMigrationLineage({ dir, obsoleteDir: path.join(dir, 'nope') }),
    (err) => err.code === 'canonical_migrations_missing',
  );
});
