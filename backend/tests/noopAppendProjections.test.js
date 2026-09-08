import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const sql = readFileSync(
  new URL('../../supabase/migrations/20260907133100_noop_append_stream_projections.sql', import.meta.url),
  'utf8',
);

const tables = [
  {
    table: 'noop_rr_intervals',
    pk: 'primary key (user_id, device_id, ts, "rrMs", seq)',
    index: 'noop_rr_intervals_user_ts_idx',
    selectPolicy: 'noop_rr_intervals_select_own',
    writePolicy: 'noop_rr_intervals_service_write',
    columns: ['ord', 'srcChannel', 'tsSuspect'],
  },
  {
    table: 'noop_events',
    pk: 'primary key (user_id, device_id, ts, kind)',
    index: 'noop_events_user_ts_idx',
    selectPolicy: 'noop_events_select_own',
    writePolicy: 'noop_events_service_write',
    columns: ['payloadJSON'],
  },
  {
    table: 'noop_battery_samples',
    pk: 'primary key (user_id, device_id, ts)',
    index: 'noop_battery_samples_user_ts_idx',
    selectPolicy: 'noop_battery_samples_select_own',
    writePolicy: 'noop_battery_samples_service_write',
    columns: ['soc', 'mv', 'charging'],
  },
  {
    table: 'noop_spo2_samples',
    pk: 'primary key (user_id, device_id, ts)',
    index: 'noop_spo2_samples_user_ts_idx',
    selectPolicy: 'noop_spo2_samples_select_own',
    writePolicy: 'noop_spo2_samples_service_write',
    columns: ['red', 'ir'],
  },
  {
    table: 'noop_skin_temp_samples',
    pk: 'primary key (user_id, device_id, ts)',
    index: 'noop_skin_temp_samples_user_ts_idx',
    selectPolicy: 'noop_skin_temp_samples_select_own',
    writePolicy: 'noop_skin_temp_samples_service_write',
    columns: ['raw', 'aux1Raw', 'aux2Raw'],
  },
  {
    table: 'noop_resp_samples',
    pk: 'primary key (user_id, device_id, ts)',
    index: 'noop_resp_samples_user_ts_idx',
    selectPolicy: 'noop_resp_samples_select_own',
    writePolicy: 'noop_resp_samples_service_write',
    columns: ['raw'],
  },
  {
    table: 'noop_gravity_samples',
    pk: 'primary key (user_id, device_id, ts)',
    index: 'noop_gravity_samples_user_ts_idx',
    selectPolicy: 'noop_gravity_samples_select_own',
    writePolicy: 'noop_gravity_samples_service_write',
    columns: ['x', 'y', 'z', 'dynAccel'],
  },
];

for (const spec of tables) {
  test(`noop append projection ${spec.table} matches wire keys and RLS template`, () => {
    assert.match(sql, new RegExp(`create table if not exists public\\.${spec.table}`));
    assert.match(sql, new RegExp(spec.pk.replace(/[()"]/g, (c) => `\\${c}`)));
    assert.match(sql, new RegExp(`create index if not exists ${spec.index}`));
    assert.match(sql, new RegExp(`${spec.index}[\\s\\S]*?\\(user_id, ts desc\\)`));
    assert.match(sql, new RegExp(`alter table public\\.${spec.table} enable row level security`));
    assert.match(sql, new RegExp(`create policy "${spec.selectPolicy}"`));
    assert.match(sql, new RegExp(`create policy "${spec.writePolicy}"`));
    assert.match(sql, /auth\.uid\(\) = user_id/);
    assert.match(sql, /auth\.role\(\) = 'service_role'/);
    const block = sql.slice(
      sql.indexOf(`public.${spec.table}`),
      sql.indexOf(`create index if not exists ${spec.index}`),
    );
    for (const column of ['user_id', 'device_id', 'source_id', 'ts', 'batch_id', 'ingested_at', ...spec.columns]) {
      assert.match(block, new RegExp(`"${column}"|\\b${column}\\b`));
    }
    assert.match(block, /references auth\.users\(id\) on delete cascade/);
  });
}

test('noop append projections migration path is canonical', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationPath = path.resolve(here, '../../supabase/migrations/20260907133100_noop_append_stream_projections.sql');
  assert.ok(migrationPath.endsWith(`${path.sep}supabase${path.sep}migrations${path.sep}20260907133100_noop_append_stream_projections.sql`));
});
