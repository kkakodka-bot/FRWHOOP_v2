/**
 * Fail loud when required schema is behind. Never silently disable
 * persistence: a missing table/RPC/migration is an error, not a partial mode.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function resolveCanonicalMigrationsDir() {
  if (process.env.FRWHOOP_MIGRATIONS_DIR) return path.resolve(process.env.FRWHOOP_MIGRATIONS_DIR);
  const repo = path.resolve(here, '../../supabase/migrations');
  if (fs.existsSync(repo)) return repo;
  return path.resolve(here, '../migrations');
}

export const CANONICAL_MIGRATIONS_DIR = resolveCanonicalMigrationsDir();
export const OBSOLETE_MIGRATIONS_DIR = path.resolve(here, '../../../supabase/migrations');
export const OBSOLETE_QUARANTINE_MARKER = path.resolve(here, '../../../supabase/QUARANTINED.md');

const REQUIRED = [
  { table: 'profiles', columns: ['id', 'timezone'] },
  { table: 'daily_metrics', columns: ['user_id', 'day', 'timezone_name', 'day_start_at', 'day_end_at'] },
  { table: 'sessions', columns: ['id', 'user_id', 'kind', 'start_at', 'end_at'] },
  { table: 'sleep_details', columns: ['session_id', 'user_id', 'shadow_v3', 'unscored_min'] },
  { table: 'daily_physiology_series', columns: ['user_id', 'day', 'timezone_name', 'hr_series', 'skin_temp_series'] },
  { table: 'object_manifests', columns: ['id', 'user_id', 'object_key', 'object_kind', 'status', 'start_at', 'end_at', 'sha256'] },
  { table: 'day_completeness', columns: ['user_id', 'day', 'status', 'result', 'finalized_at', 'timezone_name', 'overnight_state', 'overnight_reason', 'input_fingerprint', 'last_trigger', 'last_attempt_at', 'overnight_finalized_at'] },
  { table: 'ingest_gaps', columns: ['id', 'user_id', 'kind', 'start_at', 'end_at', 'provenance', 'resolved_at', 'resolution', 'meta'] },
  { table: 'metric_runs', columns: ['id', 'user_id', 'period_day', 'algorithm', 'status'] },
  { table: 'user_sync_state', columns: ['user_id', 'revision'] },
];

const REQUIRED_RPCS = [
  { name: 'engine_ingest_upsert', body: { p_secret: '', p_payload: {} } },
  { name: 'engine_ingest_energy', body: { p_secret: '', p_payload: {} } },
  { name: 'engine_replace_sleep_day', body: { p_secret: '', p_payload: {} } },
  { name: 'engine_resolve_ingest_gaps', body: { p_secret: '', p_user_id: '00000000-0000-0000-0000-000000000000', p_rows: [] } },
  { name: 'engine_patch_daily_extras', body: { p_secret: '', p_user_id: '00000000-0000-0000-0000-000000000000', p_day: '1970-01-01', p_patch: {} } },
  { name: 'engine_read_day_snapshot', body: { p_secret: '', p_user_id: '00000000-0000-0000-0000-000000000000', p_day: '1970-01-01' } },
  { name: 'get_day_snapshot', body: { p_day: '1970-01-01' } },
  { name: 'get_range', body: { p_from: '1970-01-01', p_to: '1970-01-01' } },
  { name: 'get_sync_revision', body: {} },
  { name: 'profile_timezone', body: { p_user_id: '00000000-0000-0000-0000-000000000000' } },
  { name: 'day_bounds', body: { p_day: '1970-01-01', p_tz: 'UTC' } },
];

const REQUIRED_MIGRATION_FILES = [
  '20260819190000_frwhoop_base_schema.sql',
  '20260824180000_production_persistence.sql',
  '20260824220000_canonical_day_series_broadcast.sql',
  '20260824230000_greenfield_engine_rpcs.sql',
  '20260830280000_steps_v3_reference_hardening.sql',
  '20260831024452_steps_v3_reference_hardening.sql',
  '20260831030000_steps_v3_reference_hardening.sql',
  '20260901002700_canonical_snapshot_availability.sql',
  '20260901004753_snapshot_energy_steps_contract.sql',
  '20260901010629_sleep_persist_state.sql',
  '20260901010751_sleep_persist_state_rpcs.sql',
  '20260901012423_database_security_hardening.sql',
  '20260901022006_snapshot_hr_occupied_buckets.sql',
  '20260901022058_snapshot_hr_occupied_coverage.sql',
  '20260901204500_skin_temp_display.sql',
  '20260902010000_sleep_stager_v3_shadow.sql',
  '20260902120000_sleep_stager_v3_shadow_rpc.sql',
  '20260902140000_snapshot_persisted_metrics.sql',
  '20260902220000_shadow_read_model_snapshot.sql',
];

export function listCanonicalMigrationFiles(dir = CANONICAL_MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
}

export function assertCanonicalMigrationLineage({
  dir = CANONICAL_MIGRATIONS_DIR,
  obsoleteDir = OBSOLETE_MIGRATIONS_DIR,
  quarantineMarker = OBSOLETE_QUARANTINE_MARKER,
} = {}) {
  const files = listCanonicalMigrationFiles(dir);
  if (!files.length) {
    const err = new Error(`canonical_migrations_missing: ${dir}`);
    err.code = 'canonical_migrations_missing';
    throw err;
  }
  const missingRequired = REQUIRED_MIGRATION_FILES.filter((name) => !files.includes(name));
  if (missingRequired.length) {
    const err = new Error(`canonical_migrations_incomplete: ${missingRequired.join(', ')}`);
    err.code = 'canonical_migrations_incomplete';
    err.missing = missingRequired;
    throw err;
  }
  const versions = files.map((name) => name.split('_')[0]);
  const dupes = versions.filter((v, i) => versions.indexOf(v) !== i);
  if (dupes.length) {
    const err = new Error(`canonical_migrations_duplicate_versions: ${[...new Set(dupes)].join(', ')}`);
    err.code = 'canonical_migrations_duplicate_versions';
    throw err;
  }
  if (fs.existsSync(obsoleteDir) && !fs.existsSync(quarantineMarker)) {
    const err = new Error(`obsolete_migration_root_not_quarantined: ${obsoleteDir}`);
    err.code = 'obsolete_migration_root_not_quarantined';
    throw err;
  }
  return { ok: true, files, dir };
}

export async function probeContinuitySchema({ rest } = {}) {
  const missing = [];
  if (typeof rest !== 'function') {
    const err = new Error('continuity_schema_behind: service_role_unconfigured');
    err.code = 'continuity_schema_behind';
    err.missing = ['rest'];
    throw err;
  }
  for (const { table, columns } of REQUIRED) {
    const select = columns.join(',');
    let res;
    try {
      res = await rest(table, { query: `select=${select}&limit=0` });
    } catch (err) {
      missing.push(`${table}: ${String(err?.message || err).slice(0, 80)}`);
      continue;
    }
    if (!res?.ok) {
      const text = typeof res?.text === 'function' ? await res.text().catch(() => '') : '';
      missing.push(`${table} (${res?.status || 'no-status'}) ${String(text).slice(0, 80)}`);
    }
  }
  for (const { name, body } of REQUIRED_RPCS) {
    try {
      const res = await rest(`rpc/${name}`, { method: 'POST', body });
      if (res?.status === 404) missing.push(`rpc ${name} (404)`);
    } catch (err) {
      const status = err?.status || 0;
      if (status === 404 || String(err?.message || '').includes('(404)')) {
        missing.push(`rpc ${name} (404)`);
      }
    }
  }
  if (missing.length) {
    const err = new Error(`continuity_schema_behind: ${missing.join('; ')}`);
    err.code = 'continuity_schema_behind';
    err.missing = missing;
    throw err;
  }
  return { ok: true, missing: [] };
}

export async function assertContinuitySchema(db) {
  if (!db?.configured) {
    const err = new Error('continuity_schema_behind: metrics_db_unconfigured');
    err.code = 'continuity_schema_behind';
    throw err;
  }
  if (typeof db.probeContinuitySchema === 'function') {
    return db.probeContinuitySchema();
  }
  const err = new Error('continuity_schema_behind: probe_unavailable');
  err.code = 'continuity_schema_behind';
  throw err;
}
