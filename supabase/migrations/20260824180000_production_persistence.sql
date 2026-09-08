-- Production persistence architecture: identity, object manifests, measurements,
-- sleep_details, physiology buckets, RLS, privileged RPC lockdown, day snapshots.
-- Expand-only. Does not drop user data. Fixture rows are classified, not deleted.

create schema if not exists internal;
revoke all on schema internal from public, anon, authenticated;

create table if not exists internal.app_secrets (
  name text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
revoke all on table internal.app_secrets from public, anon, authenticated;

create or replace function internal.assert_ingest_secret(p_secret text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, internal
as $$
declare expected text;
begin
  if auth.role() = 'service_role' then
    return;
  end if;
  select s.value into expected from internal.app_secrets s where s.name = 'ingest';
  if expected is null or p_secret is null or p_secret is distinct from expected then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
end;
$$;
revoke all on function internal.assert_ingest_secret(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Triggers / search_path
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  insert into public.user_settings (user_id, user_key, settings)
  values (new.id, new.id::text, '{}'::jsonb)
  on conflict do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- daily_metrics projection aliases + day semantics + fixture class
-- ---------------------------------------------------------------------------
alter table public.daily_metrics add column if not exists recovery_score numeric;
alter table public.daily_metrics add column if not exists strain_score numeric;
alter table public.daily_metrics add column if not exists sleep_performance_pct numeric;
alter table public.daily_metrics add column if not exists day_start_at timestamptz;
alter table public.daily_metrics add column if not exists day_end_at timestamptz;
alter table public.daily_metrics add column if not exists timezone_name text;
alter table public.daily_metrics add column if not exists timezone_offset_seconds integer;
alter table public.daily_metrics add column if not exists record_class text not null default 'user';
alter table public.daily_metrics add column if not exists latest_metric_run_id uuid;
-- Sleep projection columns lived in a historical no-op migration. Expand-only
-- so a greenfield project can create dashboard_days and ingest RPCs.
alter table public.daily_metrics add column if not exists sleep_in_bed_min numeric;
alter table public.daily_metrics add column if not exists sleep_awake_min numeric;
alter table public.daily_metrics add column if not exists sleep_need_min numeric;
alter table public.daily_metrics add column if not exists sleep_consistency numeric;
alter table public.daily_metrics add column if not exists sleep_onset_at timestamptz;
alter table public.daily_metrics add column if not exists wake_onset_at timestamptz;
alter table public.daily_metrics add column if not exists overnight_hr_bpm numeric;
alter table public.daily_metrics add column if not exists disturbances integer;

update public.daily_metrics
set recovery_score = charge
where recovery_score is null and charge is not null;

update public.daily_metrics
set sleep_performance_pct = rest
where sleep_performance_pct is null and rest is not null;

update public.daily_metrics
set strain_score = effort
where strain_score is null and effort is not null and effort >= 0 and effort <= 21;

update public.daily_metrics
set record_class = 'fixture'
where record_class = 'user'
  and (
    coalesce(provenance->>'source', '') in ('coach-days-backfill', 'curl-test')
    or coalesce(algorithm_version, '') in ('curl-test', 'coach-days-backfill')
  );

alter table public.daily_metrics drop constraint if exists daily_metrics_record_class_check;
alter table public.daily_metrics
  add constraint daily_metrics_record_class_check
  check (record_class = any (array['user'::text, 'fixture'::text, 'synthetic'::text]));

alter table public.daily_metrics drop constraint if exists daily_metrics_recovery_score_check;
alter table public.daily_metrics
  add constraint daily_metrics_recovery_score_check
  check (recovery_score is null or (recovery_score >= 0 and recovery_score <= 100));

alter table public.daily_metrics drop constraint if exists daily_metrics_sleep_performance_pct_check;
alter table public.daily_metrics
  add constraint daily_metrics_sleep_performance_pct_check
  check (sleep_performance_pct is null or (sleep_performance_pct >= 0 and sleep_performance_pct <= 100));

alter table public.daily_metrics drop constraint if exists daily_metrics_strain_score_check;
alter table public.daily_metrics
  add constraint daily_metrics_strain_score_check
  check (strain_score is null or (strain_score >= 0 and strain_score <= 21));

do $$
begin
  alter table public.daily_metrics drop constraint if exists daily_metrics_effort_check;
  if exists (
    select 1 from public.daily_metrics
    where effort is not null and (effort < 0 or effort > 21)
  ) then
    -- Keep effort unconstrained so historical out-of-range rows are not rewritten.
    null;
  else
    alter table public.daily_metrics
      add constraint daily_metrics_effort_check
      check (effort is null or (effort >= 0 and effort <= 21));
  end if;
end $$;

create or replace function public.sync_daily_metric_aliases()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.recovery_score is null and new.charge is not null then
    new.recovery_score := new.charge;
  elsif new.charge is null and new.recovery_score is not null then
    new.charge := new.recovery_score;
  end if;
  if new.sleep_performance_pct is null and new.rest is not null then
    new.sleep_performance_pct := new.rest;
  elsif new.rest is null and new.sleep_performance_pct is not null then
    new.rest := new.sleep_performance_pct;
  end if;
  if new.strain_score is null and new.effort is not null and new.effort >= 0 and new.effort <= 21 then
    new.strain_score := new.effort;
  elsif new.effort is null and new.strain_score is not null then
    new.effort := new.strain_score;
  end if;
  return new;
end;
$$;

drop trigger if exists daily_metrics_alias_sync on public.daily_metrics;
create trigger daily_metrics_alias_sync
  before insert or update on public.daily_metrics
  for each row execute function public.sync_daily_metric_aliases();

-- ---------------------------------------------------------------------------
-- sessions: strength workouts
-- ---------------------------------------------------------------------------
alter table public.sessions drop constraint if exists sessions_kind_check;
alter table public.sessions
  add constraint sessions_kind_check
  check (kind = any (array[
    'sleep'::text, 'nap'::text, 'workout'::text, 'manual_workout'::text,
    'strength_workout'::text, 'breathing'::text, 'other'::text
  ]));

-- ---------------------------------------------------------------------------
-- sleep_details (1:1 with sessions). sleep_nights kept as compatibility.
-- ---------------------------------------------------------------------------
create table if not exists public.sleep_details (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  is_nap boolean not null default false,
  in_bed_min numeric,
  asleep_min numeric,
  awake_min numeric,
  light_min numeric,
  deep_min numeric,
  rem_min numeric,
  efficiency numeric,
  performance_pct numeric,
  need_min numeric,
  debt_min numeric,
  consistency_pct numeric,
  overnight_hr_bpm numeric,
  resting_hr_bpm numeric,
  hrv_rmssd_ms numeric,
  resp_rate_bpm numeric,
  disturbances integer,
  recovery_pct numeric,
  original_start_at timestamptz,
  original_end_at timestamptz,
  user_start_at timestamptz,
  user_end_at timestamptz,
  stages jsonb not null default '[]'::jsonb,
  hypnogram jsonb not null default '[]'::jsonb,
  derived_object_id uuid,
  algorithm_version text,
  computed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sleep_details_efficiency_check check (efficiency is null or (efficiency >= 0 and efficiency <= 1)),
  constraint sleep_details_performance_check check (performance_pct is null or (performance_pct >= 0 and performance_pct <= 100))
);

create index if not exists sleep_details_user_idx on public.sleep_details (user_id, original_end_at desc);

-- ---------------------------------------------------------------------------
-- measurements
-- ---------------------------------------------------------------------------
create table if not exists public.measurements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  metric_type text not null,
  measured_at timestamptz not null,
  value numeric,
  unit text,
  source text not null default 'manual',
  external_id text,
  quality numeric,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists measurements_external_unique
  on public.measurements (user_id, source, external_id)
  where external_id is not null;

create index if not exists measurements_user_type_time_idx
  on public.measurements (user_id, metric_type, measured_at desc);

-- ---------------------------------------------------------------------------
-- physiology_buckets (5-minute intraday projection)
-- ---------------------------------------------------------------------------
create table if not exists public.physiology_buckets (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  bucket_start timestamptz not null,
  bucket_minutes integer not null default 5,
  avg_hr numeric,
  min_hr numeric,
  max_hr numeric,
  sample_count integer not null default 0,
  strain_increment numeric,
  quality numeric,
  sleep_minutes numeric,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, bucket_start, bucket_minutes)
);

create index if not exists physiology_buckets_user_time_idx
  on public.physiology_buckets (user_id, bucket_start desc);

-- ---------------------------------------------------------------------------
-- object_manifests (canonical object metadata)
-- ---------------------------------------------------------------------------
create table if not exists public.object_manifests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  object_class text not null default 'raw',
  object_kind text not null,
  provider text not null default 'b2',
  bucket text,
  object_key text not null unique,
  start_at timestamptz,
  end_at timestamptz,
  period_day date,
  sample_count bigint,
  sample_rate_hz numeric,
  compressed_bytes bigint,
  content_type text,
  format text,
  compression text,
  schema_version integer,
  sha256 text,
  etag text,
  algorithm_version text,
  status text not null default 'pending',
  retention_class text not null default 'core',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  uploaded_at timestamptz,
  verified_at timestamptz,
  constraint object_manifests_status_check check (status = any (array[
    'pending'::text, 'uploading'::text, 'uploaded'::text, 'verified'::text, 'ready'::text,
    'expired'::text, 'deleting'::text, 'deleted'::text, 'corrupt'::text, 'failed'::text
  ])),
  constraint object_manifests_class_check check (object_class = any (array[
    'raw'::text, 'derived'::text, 'export'::text, 'document'::text, 'waveform'::text
  ]))
);

create index if not exists object_manifests_user_kind_day_idx
  on public.object_manifests (user_id, object_kind, period_day, status);

create index if not exists object_manifests_pending_idx
  on public.object_manifests (status, created_at)
  where status in ('pending', 'uploading', 'uploaded');

-- Compatibility tables that historical no-op migrations used to create on
-- production. CREATE IF NOT EXISTS so a clean project can reach this file.
create table if not exists public.derived_objects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  object_kind text not null,
  object_key text not null unique,
  store text not null default 'b2',
  bucket text,
  period_day date,
  compressed_bytes bigint,
  content_type text,
  sha256 text,
  algorithm_version text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.metric_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  period_day date,
  algorithm text not null,
  version text,
  status text not null default 'complete',
  input_refs jsonb not null default '{}'::jsonb,
  output_refs jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.sleep_nights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  is_nap boolean not null default false,
  in_bed_min numeric,
  asleep_min numeric,
  awake_min numeric,
  light_min numeric,
  deep_min numeric,
  rem_min numeric,
  efficiency numeric,
  performance_pct numeric,
  need_min numeric,
  debt_min numeric,
  consistency_pct numeric,
  overnight_hr_bpm numeric,
  resting_hr_bpm numeric,
  hrv_rmssd_ms numeric,
  resp_rate_bpm numeric,
  disturbances integer,
  recovery_pct numeric,
  stages jsonb not null default '{}'::jsonb,
  hypnogram jsonb,
  algorithm_version text,
  computed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.sleep_nights add column if not exists period_day date;
alter table public.sleep_nights add column if not exists derived_object_key text;
create unique index if not exists sleep_nights_user_start_uidx
  on public.sleep_nights (user_id, start_at);

create table if not exists public.live_windows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  period_day date,
  start_at timestamptz not null,
  end_at timestamptz not null,
  sample_count bigint,
  raw_object_id uuid references public.sensor_objects(id) on delete set null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_settings (
  user_key text primary key,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.integration_connections (
  user_key text not null,
  provider text not null,
  status text not null default 'disconnected',
  tokens jsonb not null default '{}'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  connected_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_key, provider)
);

-- Widen legacy object tables so dual-write still works.
alter table public.sensor_objects drop constraint if exists sensor_objects_status_check;
alter table public.sensor_objects
  add constraint sensor_objects_status_check
  check (status = any (array[
    'pending'::text, 'uploading'::text, 'uploaded'::text, 'verified'::text, 'ready'::text,
    'expired'::text, 'deleting'::text, 'deleted'::text, 'corrupt'::text, 'failed'::text
  ]));

alter table public.sensor_objects drop constraint if exists sensor_objects_kind_check;
alter table public.sensor_objects
  add constraint sensor_objects_kind_check
  check (object_kind = any (array[
    'canonical'::text, 'ppg'::text, 'imu'::text, 'diagnostic'::text, 'export'::text,
    'live_hr'::text, 'hr'::text, 'rr'::text, 'hr_rr'::text, 'ble'::text, 'ecg'::text
  ]));

alter table public.derived_objects drop constraint if exists derived_objects_status_check;
alter table public.derived_objects
  add constraint derived_objects_status_check
  check (status = any (array[
    'pending'::text, 'uploading'::text, 'uploaded'::text, 'verified'::text, 'ready'::text,
    'expired'::text, 'deleting'::text, 'deleted'::text, 'corrupt'::text, 'failed'::text
  ]));

-- ---------------------------------------------------------------------------
-- metric_runs provenance
-- ---------------------------------------------------------------------------
alter table public.metric_runs add column if not exists algorithm_name text;
alter table public.metric_runs add column if not exists code_build_hash text;
alter table public.metric_runs add column if not exists config_hash text;
alter table public.metric_runs add column if not exists device_id uuid references public.devices(id) on delete set null;
alter table public.metric_runs add column if not exists input_start_at timestamptz;
alter table public.metric_runs add column if not exists input_end_at timestamptz;
alter table public.metric_runs add column if not exists input_schema_versions jsonb not null default '{}'::jsonb;
alter table public.metric_runs add column if not exists quality jsonb not null default '{}'::jsonb;

update public.metric_runs set algorithm_name = algorithm where algorithm_name is null;

create index if not exists metric_runs_user_period_idx
  on public.metric_runs (user_id, period_day, started_at desc);

-- ---------------------------------------------------------------------------
-- Identity: user_settings / integrations
-- ---------------------------------------------------------------------------
alter table public.user_settings add column if not exists user_id uuid;
alter table public.user_settings add column if not exists created_at timestamptz not null default now();

update public.user_settings
set user_id = user_key::uuid
where user_id is null
  and user_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

alter table public.integration_connections add column if not exists user_id uuid;
alter table public.integration_connections add column if not exists credentials_present boolean not null default false;
alter table public.integration_connections add column if not exists credentials_cipher text;
alter table public.integration_connections add column if not exists created_at timestamptz not null default now();

update public.integration_connections
set user_id = user_key::uuid
where user_id is null
  and user_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

update public.integration_connections
set credentials_present = true
where coalesce(tokens, '{}'::jsonb) <> '{}'::jsonb;

create unique index if not exists user_settings_user_id_uidx
  on public.user_settings (user_id)
  where user_id is not null;

create unique index if not exists integration_connections_user_provider_uidx
  on public.integration_connections (user_id, provider)
  where user_id is not null;

do $$
begin
  if not exists (
    select 1 from public.user_settings where user_id is null
  ) then
    begin
      alter table public.user_settings
        add constraint user_settings_user_id_fkey
        foreign key (user_id) references auth.users(id) on delete cascade;
    exception when duplicate_object then null;
    end;
  end if;
  if not exists (
    select 1 from public.integration_connections where user_id is null
  ) then
    begin
      alter table public.integration_connections
        add constraint integration_connections_user_id_fkey
        foreign key (user_id) references auth.users(id) on delete cascade;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

create table if not exists internal.integration_credentials (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  ciphertext text not null,
  key_version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

revoke all on table internal.integration_credentials from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Coach + documents + algorithm results + deletion + sync
-- ---------------------------------------------------------------------------
create table if not exists public.coach_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id text not null,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, session_id)
);

create table if not exists public.coach_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references public.coach_sessions(id) on delete cascade,
  role text not null,
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.coach_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  records jsonb not null default '[]'::jsonb,
  relations jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create table if not exists public.user_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  kind text not null default 'note',
  object_id uuid,
  text text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.algorithm_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  algorithm text not null,
  version text,
  result jsonb not null default '{}'::jsonb,
  metric_run_id uuid references public.metric_runs(id) on delete set null,
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.user_sync_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0,
  last_metrics_at timestamptz,
  last_sleep_at timestamptz,
  last_session_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  status text not null default 'pending',
  step text,
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists deletion_jobs_user_idx on public.deletion_jobs (user_id, created_at desc);

create or replace function public.bump_user_revision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare uid uuid;
begin
  uid := coalesce(new.user_id, old.user_id);
  if tg_table_name = 'profiles' then
    uid := coalesce(new.id, old.id);
  end if;
  if uid is null then return coalesce(new, old); end if;
  insert into public.user_sync_state (user_id, revision, updated_at)
  values (uid, 1, now())
  on conflict (user_id) do update
    set revision = public.user_sync_state.revision + 1,
        updated_at = now(),
        last_metrics_at = case when tg_table_name = 'daily_metrics' then now() else public.user_sync_state.last_metrics_at end,
        last_sleep_at = case when tg_table_name in ('sleep_details', 'sleep_nights') then now() else public.user_sync_state.last_sleep_at end,
        last_session_at = case when tg_table_name = 'sessions' then now() else public.user_sync_state.last_session_at end;
  return coalesce(new, old);
end;
$$;

drop trigger if exists daily_metrics_revision on public.daily_metrics;
create trigger daily_metrics_revision after insert or update or delete on public.daily_metrics
  for each row execute function public.bump_user_revision();
drop trigger if exists sessions_revision on public.sessions;
create trigger sessions_revision after insert or update or delete on public.sessions
  for each row execute function public.bump_user_revision();
drop trigger if exists events_revision on public.events;
create trigger events_revision after insert or update or delete on public.events
  for each row execute function public.bump_user_revision();
drop trigger if exists sleep_details_revision on public.sleep_details;
create trigger sleep_details_revision after insert or update or delete on public.sleep_details
  for each row execute function public.bump_user_revision();

-- ---------------------------------------------------------------------------
-- Backfill manifests + sleep_details
-- ---------------------------------------------------------------------------
insert into public.object_manifests (
  id, user_id, device_id, object_class, object_kind, provider, bucket, object_key,
  start_at, end_at, period_day, sample_count, compressed_bytes, content_type, format,
  compression, schema_version, sha256, status, retention_class, expires_at, created_at, updated_at
)
select
  s.id, s.user_id, s.device_id, 'raw', s.object_kind, coalesce(s.store, 'b2'), null, s.object_key,
  s.start_at, s.end_at, s.period_day, s.sample_count, s.compressed_bytes, s.content_type, s.format,
  s.compression, s.schema_version, s.sha256,
  case when s.store = 's3' then 'failed' else s.status end,
  s.retention_class, s.expires_at, s.created_at, s.updated_at
from public.sensor_objects s
on conflict (object_key) do nothing;

insert into public.object_manifests (
  id, user_id, object_class, object_kind, provider, bucket, object_key,
  period_day, compressed_bytes, content_type, sha256, algorithm_version, status, created_at, updated_at
)
select
  d.id, d.user_id, 'derived', d.object_kind, coalesce(d.store, 'b2'), d.bucket, d.object_key,
  d.period_day, d.compressed_bytes, d.content_type, d.sha256, d.algorithm_version,
  case when d.store = 's3' then 'failed' else d.status end,
  d.created_at, d.updated_at
from public.derived_objects d
on conflict (object_key) do nothing;

insert into public.sessions (
  id, user_id, device_id, kind, source, external_id, start_at, end_at, summary, algorithm_version, created_at, updated_at
)
select
  n.id, n.user_id, n.device_id,
  case when n.is_nap then 'nap' else 'sleep' end,
  'frwhoop',
  'sleep:' || n.id::text,
  n.start_at, n.end_at,
  jsonb_build_object(
    'performance_pct', n.performance_pct,
    'efficiency', n.efficiency,
    'asleep_min', n.asleep_min,
    'in_bed_min', n.in_bed_min
  ),
  n.algorithm_version, n.created_at, n.updated_at
from public.sleep_nights n
on conflict (id) do nothing;

insert into public.sleep_details (
  session_id, user_id, is_nap, in_bed_min, asleep_min, awake_min, light_min, deep_min, rem_min,
  efficiency, performance_pct, need_min, debt_min, consistency_pct, overnight_hr_bpm, resting_hr_bpm,
  hrv_rmssd_ms, resp_rate_bpm, disturbances, recovery_pct, original_start_at, original_end_at,
  stages, hypnogram, algorithm_version, computed_at, created_at, updated_at
)
select
  n.id, n.user_id, n.is_nap, n.in_bed_min, n.asleep_min, n.awake_min, n.light_min, n.deep_min, n.rem_min,
  n.efficiency, n.performance_pct, n.need_min, n.debt_min, n.consistency_pct, n.overnight_hr_bpm, n.resting_hr_bpm,
  n.hrv_rmssd_ms, n.resp_rate_bpm, n.disturbances, n.recovery_pct, n.start_at, n.end_at,
  n.stages, n.hypnogram, n.algorithm_version, n.computed_at, n.created_at, n.updated_at
from public.sleep_nights n
on conflict (session_id) do nothing;

-- ---------------------------------------------------------------------------
-- Indexes for hot paths
-- ---------------------------------------------------------------------------
create index if not exists daily_metrics_user_day_idx on public.daily_metrics (user_id, day desc);
create index if not exists daily_metrics_user_class_idx on public.daily_metrics (user_id, record_class, day desc);
create index if not exists sessions_user_start_idx on public.sessions (user_id, start_at desc);
create index if not exists events_user_time_idx on public.events (user_id, occurred_at desc);
create index if not exists devices_user_external_idx on public.devices (user_id, source_kind, external_device_id);
create unique index if not exists devices_external_unique
  on public.devices (user_id, source_kind, external_device_id)
  where external_device_id is not null;
create unique index if not exists sessions_external_unique
  on public.sessions (user_id, source, external_id)
  where external_id is not null;

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
drop function if exists public.get_frwhoop_range(date, date);
drop view if exists public.dashboard_days;
create view public.dashboard_days
with (security_invoker = true) as
select
  user_id, day, source_device_id,
  coalesce(recovery_score, charge) as recovery_score,
  coalesce(strain_score, effort) as strain_score,
  coalesce(sleep_performance_pct, rest) as sleep_performance_pct,
  charge, effort, rest, readiness_level,
  hrv_rmssd_ms, hrv_sdnn_ms, resting_hr_bpm, avg_hr_bpm,
  resp_rate_bpm, skin_temp_dev_c, spo2_pct, steps, active_kcal,
  sleep_total_min, sleep_deep_min, sleep_rem_min, sleep_light_min,
  sleep_in_bed_min, sleep_awake_min, sleep_need_min, sleep_consistency,
  sleep_efficiency, sleep_onset_at, wake_onset_at, overnight_hr_bpm, disturbances,
  exercise_count, provenance, algorithm_version, computed_at, updated_at,
  timezone_name, day_start_at, day_end_at, record_class
from public.daily_metrics
where record_class = 'user';

grant select on public.dashboard_days to authenticated, service_role;

create or replace view public.archive_list
with (security_invoker = true) as
select id, user_id, device_id, object_kind, start_at, end_at, period_day,
       sample_count, compressed_bytes, format, compression, sha256, schema_version,
       retention_class, expires_at, status, created_at
from public.object_manifests
where status in ('ready', 'verified');

-- ---------------------------------------------------------------------------
-- Compact query surfaces (SECURITY INVOKER + RLS)
-- ---------------------------------------------------------------------------
create or replace function public.get_day_snapshot(p_day date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'day', p_day,
    'metrics', (
      select jsonb_build_object(
        'day', m.day,
        'recovery_score', coalesce(m.recovery_score, m.charge),
        'strain_score', coalesce(m.strain_score, m.effort),
        'sleep_performance_pct', coalesce(m.sleep_performance_pct, m.rest),
        'hrv_rmssd_ms', m.hrv_rmssd_ms,
        'resting_hr_bpm', m.resting_hr_bpm,
        'avg_hr_bpm', m.avg_hr_bpm,
        'max_hr_bpm', m.max_hr_bpm,
        'resp_rate_bpm', m.resp_rate_bpm,
        'spo2_pct', m.spo2_pct,
        'steps', m.steps,
        'active_kcal', m.active_kcal,
        'sleep_total_min', m.sleep_total_min,
        'sleep_in_bed_min', m.sleep_in_bed_min,
        'sleep_need_min', m.sleep_need_min,
        'sleep_efficiency', m.sleep_efficiency,
        'sleep_onset_at', m.sleep_onset_at,
        'wake_onset_at', m.wake_onset_at,
        'timezone_name', m.timezone_name,
        'day_start_at', m.day_start_at,
        'day_end_at', m.day_end_at,
        'algorithm_version', m.algorithm_version,
        'computed_at', m.computed_at
      )
      from public.daily_metrics m
      where m.user_id = uid and m.day = p_day and m.record_class = 'user'
    ),
    'sleep', coalesce((
      select jsonb_agg(jsonb_build_object(
        'session_id', d.session_id,
        'is_nap', d.is_nap,
        'performance_pct', d.performance_pct,
        'efficiency', d.efficiency,
        'asleep_min', d.asleep_min,
        'in_bed_min', d.in_bed_min,
        'light_min', d.light_min,
        'deep_min', d.deep_min,
        'rem_min', d.rem_min,
        'awake_min', d.awake_min,
        'need_min', d.need_min,
        'hypnogram', d.hypnogram,
        'original_start_at', d.original_start_at,
        'original_end_at', d.original_end_at
      ) order by d.original_start_at)
      from public.sleep_details d
      where d.user_id = uid
        and (d.original_end_at::date = p_day or exists (
          select 1 from public.sessions s
          where s.id = d.session_id and s.start_at::date <= p_day and s.end_at::date >= p_day
        ))
    ), '[]'::jsonb),
    'sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'kind', s.kind, 'source', s.source,
        'start_at', s.start_at, 'end_at', s.end_at,
        'summary', s.summary, 'user_modified', s.user_modified
      ) order by s.start_at)
      from public.sessions s
      where s.user_id = uid
        and s.start_at < ((p_day + 1)::timestamp)
        and s.end_at > (p_day::timestamp)
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'event_type', e.event_type, 'occurred_at', e.occurred_at,
        'text_value', e.text_value, 'numeric_value', e.numeric_value, 'payload', e.payload
      ) order by e.occurred_at)
      from public.events e
      where e.user_id = uid
        and e.occurred_at >= (p_day::timestamp)
        and e.occurred_at < ((p_day + 1)::timestamp)
    ), '[]'::jsonb),
    'chart', coalesce((
      select jsonb_agg(jsonb_build_object(
        't', b.bucket_start, 'avg_hr', b.avg_hr, 'min_hr', b.min_hr,
        'max_hr', b.max_hr, 'n', b.sample_count
      ) order by b.bucket_start)
      from public.physiology_buckets b
      where b.user_id = uid
        and b.bucket_start >= (p_day::timestamp)
        and b.bucket_start < ((p_day + 1)::timestamp)
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.get_range(p_from date, p_to date)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'day', d.day,
    'recovery_score', coalesce(d.recovery_score, d.charge),
    'strain_score', coalesce(d.strain_score, d.effort),
    'sleep_performance_pct', coalesce(d.sleep_performance_pct, d.rest),
    'hrv_rmssd_ms', d.hrv_rmssd_ms,
    'resting_hr_bpm', d.resting_hr_bpm,
    'avg_hr_bpm', d.avg_hr_bpm,
    'sleep_total_min', d.sleep_total_min,
    'sleep_need_min', d.sleep_need_min,
    'steps', d.steps,
    'active_kcal', d.active_kcal,
    'computed_at', d.computed_at,
    'timezone_name', d.timezone_name
  ) order by d.day desc), '[]'::jsonb)
  from public.daily_metrics d
  where d.user_id = (select auth.uid())
    and d.record_class = 'user'
    and d.day >= p_from
    and d.day <= p_to;
$$;

create or replace function public.get_sync_revision()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select jsonb_build_object('revision', revision, 'updated_at', updated_at)
     from public.user_sync_state where user_id = (select auth.uid())),
    jsonb_build_object('revision', 0, 'updated_at', null)
  );
$$;

-- Keep old names as wrappers.
create or replace function public.get_frwhoop_day(for_day date)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select public.get_day_snapshot(for_day);
$$;

create or replace function public.get_frwhoop_range(from_day date, to_day date)
returns setof public.dashboard_days
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select *
  from public.dashboard_days
  where user_id = (select auth.uid())
    and day >= from_day
    and day <= to_day
  order by day desc
  limit 366;
$$;

grant execute on function public.get_day_snapshot(date) to authenticated, service_role;
grant execute on function public.get_range(date, date) to authenticated, service_role;
grant execute on function public.get_sync_revision() to authenticated, service_role;
grant execute on function public.get_frwhoop_day(date) to authenticated, service_role;
grant execute on function public.get_frwhoop_range(date, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.daily_metrics enable row level security;
alter table public.sessions enable row level security;
alter table public.events enable row level security;
alter table public.sensor_objects enable row level security;
alter table public.sleep_nights enable row level security;
alter table public.derived_objects enable row level security;
alter table public.live_windows enable row level security;
alter table public.metric_runs enable row level security;
alter table public.user_settings enable row level security;
alter table public.integration_connections enable row level security;
alter table public.sleep_details enable row level security;
alter table public.measurements enable row level security;
alter table public.physiology_buckets enable row level security;
alter table public.object_manifests enable row level security;
alter table public.coach_sessions enable row level security;
alter table public.coach_messages enable row level security;
alter table public.coach_memories enable row level security;
alter table public.user_documents enable row level security;
alter table public.algorithm_results enable row level security;
alter table public.user_sync_state enable row level security;
alter table public.deletion_jobs enable row level security;

-- Recreate own-row policies using (select auth.uid()) = user_id
do $$
declare
  t text;
begin
  foreach t in array array[
    'devices','daily_metrics','sessions','events','sensor_objects','sleep_nights',
    'derived_objects','live_windows','metric_runs','sleep_details','measurements',
    'physiology_buckets','object_manifests','coach_sessions','coach_messages',
    'coach_memories','user_documents','algorithm_results','user_sync_state'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
      t || '_select_own', t
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)',
      t || '_insert_own', t
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
      t || '_update_own', t
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)',
      t || '_delete_own', t
    );
  end loop;
end $$;

-- Object and run tables: authenticated may read their own rows, not insert archives.
drop policy if exists object_manifests_insert_own on public.object_manifests;
drop policy if exists object_manifests_update_own on public.object_manifests;
drop policy if exists object_manifests_delete_own on public.object_manifests;
drop policy if exists sensor_objects_insert_own on public.sensor_objects;
drop policy if exists sensor_objects_update_own on public.sensor_objects;
drop policy if exists sensor_objects_delete_own on public.sensor_objects;
drop policy if exists derived_objects_insert_own on public.derived_objects;
drop policy if exists derived_objects_update_own on public.derived_objects;
drop policy if exists derived_objects_delete_own on public.derived_objects;
drop policy if exists live_windows_insert_own on public.live_windows;
drop policy if exists live_windows_update_own on public.live_windows;
drop policy if exists live_windows_delete_own on public.live_windows;
drop policy if exists metric_runs_insert_own on public.metric_runs;
drop policy if exists metric_runs_update_own on public.metric_runs;
drop policy if exists metric_runs_delete_own on public.metric_runs;

drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_select_own on public.profiles for select to authenticated
  using ((select auth.uid()) = id);
create policy profiles_insert_own on public.profiles for insert to authenticated
  with check ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

drop policy if exists user_settings_select_own on public.user_settings;
drop policy if exists user_settings_insert_own on public.user_settings;
drop policy if exists user_settings_update_own on public.user_settings;
create policy user_settings_select_own on public.user_settings for select to authenticated
  using ((select auth.uid()) = user_id);
create policy user_settings_insert_own on public.user_settings for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy user_settings_update_own on public.user_settings for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists integration_connections_select_own on public.integration_connections;
create policy integration_connections_select_own on public.integration_connections
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists deletion_jobs_select_own on public.deletion_jobs;
create policy deletion_jobs_select_own on public.deletion_jobs for select to authenticated
  using ((select auth.uid()) = user_id);

-- Authenticated must not read token columns.
revoke all on table public.integration_connections from anon, authenticated, public;
grant select (user_id, user_key, provider, status, meta, connected_at, updated_at, credentials_present)
  on public.integration_connections to authenticated;

revoke all on table public.deletion_jobs from anon, authenticated;
grant select on public.deletion_jobs to authenticated;

-- ---------------------------------------------------------------------------
-- Privileged functions: revoke from anon/authenticated. Keep for service_role.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like any (array['app_%', 'engine_%'])
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

revoke all on function internal.assert_ingest_secret(text) from public, anon, authenticated;
grant execute on function internal.assert_ingest_secret(text) to service_role;

revoke all on function public.bump_user_revision() from public, anon, authenticated;
grant execute on function public.bump_user_revision() to postgres, service_role;

-- app_* settings functions now also write user_id when the key is a uuid.
create or replace function public.app_upsert_settings(p_secret text, p_user_key text, p_settings jsonb)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, internal
as $$
declare uid uuid;
begin
  perform internal.assert_ingest_secret(p_secret);
  uid := case
    when p_user_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then p_user_key::uuid
    when p_user_key in ('local-demo', 'local')
      then '7f2c9a10-4b3e-4d8a-9c11-00000000f001'::uuid
    else null
  end;
  insert into public.user_settings (user_key, user_id, settings)
  values (p_user_key, uid, coalesce(p_settings, '{}'::jsonb))
  on conflict (user_key) do update set settings = excluded.settings, user_id = coalesce(excluded.user_id, public.user_settings.user_id);
end;
$$;

revoke all on function public.app_upsert_settings(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.app_upsert_settings(text, text, jsonb) to service_role;

comment on table public.object_manifests is 'Canonical B2/object metadata. Metric engines consume ready/verified rows only.';
comment on table public.measurements is 'Irregular timestamped physiological or manual measurements. Not a substitute for daily_metrics.';
comment on table public.sleep_details is 'Sleep-specific outputs keyed by sessions.id. Session identity lives on sessions.';
comment on table public.physiology_buckets is '5-minute intraday projection for charts. Not raw samples.';
comment on table public.daily_metrics is 'One current product projection per user per local physiological day.';

grant select, insert, update, delete on table
  public.sleep_details,
  public.measurements,
  public.physiology_buckets,
  public.coach_sessions,
  public.coach_messages,
  public.coach_memories,
  public.user_documents,
  public.algorithm_results,
  public.user_sync_state
  to authenticated;

grant all on table
  public.sleep_details,
  public.measurements,
  public.physiology_buckets,
  public.coach_sessions,
  public.coach_messages,
  public.coach_memories,
  public.user_documents,
  public.algorithm_results,
  public.user_sync_state,
  public.object_manifests,
  public.deletion_jobs
  to service_role;

grant select on table public.object_manifests to authenticated;
grant select on table public.deletion_jobs to authenticated;
grant all on table internal.integration_credentials to service_role;

do $$
begin
  begin
    alter publication supabase_realtime add table only public.user_sync_state;
  exception when duplicate_object then
    null;
  end;
end $$;
