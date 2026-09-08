-- FRWHOOP base schema. Idempotent so an empty Supabase project can be
-- reconstructed from repository migrations. Safe on existing projects
-- (CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;

create schema if not exists internal;
revoke all on schema internal from public;
revoke all on schema internal from anon, authenticated;

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

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_path text,
  date_of_birth date,
  sex_model text,
  height_cm numeric,
  weight_kg numeric,
  waist_cm numeric,
  timezone text not null default 'UTC',
  units jsonb not null default '{}'::jsonb,
  preferences jsonb not null default '{}'::jsonb,
  consents jsonb not null default '{}'::jsonb,
  privacy_state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_kind text not null,
  external_device_id text,
  device_family text,
  firmware text,
  nickname text,
  is_active boolean not null default true,
  calibration jsonb not null default '{}'::jsonb,
  sync_state jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.daily_metrics (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  source_device_id uuid references public.devices(id) on delete set null,
  charge numeric,
  effort numeric,
  rest numeric,
  readiness_level text,
  hrv_rmssd_ms numeric,
  hrv_sdnn_ms numeric,
  resting_hr_bpm numeric,
  avg_hr_bpm numeric,
  max_hr_bpm numeric,
  resp_rate_bpm numeric,
  skin_temp_c numeric,
  skin_temp_dev_c numeric,
  spo2_pct numeric,
  steps bigint,
  active_kcal numeric,
  basal_kcal numeric,
  vo2max numeric,
  weight_kg numeric,
  body_fat_pct numeric,
  lean_mass_kg numeric,
  sleep_total_min numeric,
  sleep_deep_min numeric,
  sleep_rem_min numeric,
  sleep_light_min numeric,
  sleep_efficiency numeric,
  exercise_count integer,
  stress_day_mean numeric,
  high_stress_minutes integer,
  sleep_debt_balance_min numeric,
  chart_data jsonb not null default '{}'::jsonb,
  extras jsonb not null default '{}'::jsonb,
  confidence jsonb not null default '{}'::jsonb,
  provenance jsonb not null default '{}'::jsonb,
  algorithm_version text not null default 'unknown',
  computed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  kind text not null,
  source text not null default 'frwhoop',
  external_id text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  timezone_offset_seconds integer,
  summary jsonb not null default '{}'::jsonb,
  segments jsonb not null default '[]'::jsonb,
  quality jsonb not null default '{}'::jsonb,
  user_modified boolean not null default false,
  algorithm_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sessions_range_check check (end_at > start_at)
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  occurred_at timestamptz not null,
  source text not null default 'manual',
  numeric_value numeric,
  text_value text,
  unit text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sensor_objects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  object_kind text not null,
  object_key text not null unique,
  start_at timestamptz not null,
  end_at timestamptz not null,
  period_day date,
  sample_count bigint,
  compressed_bytes bigint,
  content_type text not null default 'application/octet-stream',
  format text not null default 'ndjson_gzip_v2',
  compression text not null default 'gzip',
  sha256 text,
  schema_version integer not null default 2,
  retention_class text not null default 'core',
  expires_at timestamptz,
  status text not null default 'pending',
  store text not null default 'b2',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.daily_metrics enable row level security;
alter table public.sessions enable row level security;
alter table public.events enable row level security;
alter table public.sensor_objects enable row level security;
