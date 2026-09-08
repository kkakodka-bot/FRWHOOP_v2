-- Canonical Settings identity, typed schema, RLS, and privileged-RPC lockdown.
-- Upgrade-safe against the live FRWHOOP project. Does not drop health data.

create schema if not exists internal;
revoke all on schema internal from public, anon, authenticated;

-- ── Helpers ────────────────────────────────────────────────────────────────

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.touch_versioned_row()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.user_id := auth.uid();
    end if;
    new.version := coalesce(new.version, 1);
  elsif tg_op = 'UPDATE' then
    if auth.uid() is not null then
      new.user_id := old.user_id;
    end if;
    new.version := coalesce(old.version, 0) + 1;
  end if;
  return new;
end;
$$;

create or replace function internal.parse_wall_time(label text)
returns time
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare t time;
begin
  if label is null or btrim(label) = '' or lower(btrim(label)) in ('off', 'none') then
    return null;
  end if;
  begin
    t := to_timestamp(btrim(label), 'HH12:MI AM')::time;
    return t;
  exception when others then
    null;
  end;
  begin
    t := btrim(label)::time;
    return t;
  exception when others then
    return null;
  end;
end;
$$;

create or replace function internal.snap_goal(value numeric, lo integer, hi integer, step integer)
returns integer
language sql
immutable
set search_path = pg_catalog
as $$
  select least(hi, greatest(lo, (round(coalesce(value, lo)::numeric / step) * step)::integer));
$$;

-- ── Profiles: lifecycle + reported age ─────────────────────────────────────

alter table public.profiles
  add column if not exists onboarded boolean not null default false,
  add column if not exists onboarded_at timestamptz,
  add column if not exists onboarding_goal text,
  add column if not exists reported_age_years integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_reported_age_years_check'
  ) then
    alter table public.profiles
      add constraint profiles_reported_age_years_check
      check (reported_age_years is null or (reported_age_years >= 18 and reported_age_years <= 90));
  end if;
end $$;

-- ── Devices: explicit WHOOP sync timestamps ────────────────────────────────

alter table public.devices
  add column if not exists last_sync_attempt_at timestamptz,
  add column if not exists last_sync_status text,
  add column if not exists last_sync_error text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'devices_last_sync_status_check'
  ) then
    alter table public.devices
      add constraint devices_last_sync_status_check
      check (
        last_sync_status is null
        or last_sync_status = any (array['ok'::text, 'error'::text, 'pending'::text])
      );
  end if;
end $$;

-- ── New user_settings (typed) ──────────────────────────────────────────────

create table if not exists public.user_settings_v2 (
  user_id uuid primary key references auth.users(id) on delete cascade,
  notifications_enabled boolean not null default true,
  haptic_alerts_enabled boolean not null default true,
  auto_workout_detect boolean not null default true,
  units text not null default 'imperial',
  activity_goal text not null default 'moderate',
  calories_goal integer not null default 2400,
  steps_goal integer not null default 10000,
  bedtime_reminder_enabled boolean not null default true,
  bedtime_reminder_time time not null default '22:30',
  sleep_mode text not null default 'PEAK',
  wake_time time,
  recovery_goal integer not null default 66,
  sleep_schedule smallint[] not null default '{0,1,2,3,4}'::smallint[],
  alarm_enabled boolean not null default false,
  haptic_alarm boolean not null default true,
  smart_wake boolean not null default true,
  hibernation boolean not null default false,
  stress_show_sleep boolean not null default true,
  stress_alerts boolean not null default false,
  extra_settings jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_settings_units_check check (units = any (array['imperial'::text, 'metric'::text])),
  constraint user_settings_activity_goal_check check (activity_goal = any (array['low'::text, 'moderate'::text, 'high'::text, 'peak'::text])),
  constraint user_settings_calories_goal_check check (calories_goal >= 1500 and calories_goal <= 5000 and calories_goal % 50 = 0),
  constraint user_settings_steps_goal_check check (steps_goal >= 4000 and steps_goal <= 25000 and steps_goal % 500 = 0),
  constraint user_settings_sleep_mode_check check (sleep_mode = any (array['PEAK'::text, 'PERFORM'::text, 'GET_BY'::text])),
  constraint user_settings_recovery_goal_check check (recovery_goal >= 0 and recovery_goal <= 100),
  constraint user_settings_sleep_schedule_check check (sleep_schedule <@ array[0,1,2,3,4,5,6]::smallint[]),
  constraint user_settings_bedtime_check check (bedtime_reminder_enabled = false or bedtime_reminder_time is not null),
  constraint user_settings_extra_size_check check (pg_column_size(extra_settings) <= 16384)
);

comment on table public.user_settings_v2 is 'Typed per-user application preferences. Canonical Settings store. One row per auth user.';

create table if not exists public.health_calibrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  systolic numeric,
  diastolic numeric,
  measured_on date,
  source text not null default 'manual',
  provenance jsonb not null default '{}'::jsonb,
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint health_calibrations_kind_check check (kind = any (array['blood_pressure'::text])),
  constraint health_calibrations_bp_check check (
    kind <> 'blood_pressure'
    or (
      systolic is not null and diastolic is not null
      and systolic > diastolic
      and systolic between 70 and 250
      and diastolic between 40 and 150
    )
  )
);

create index if not exists health_calibrations_user_kind_idx
  on public.health_calibrations (user_id, kind, created_at desc);

create unique index if not exists health_calibrations_current_kind_idx
  on public.health_calibrations (user_id, kind)
  where is_current;

create table if not exists internal.settings_migration_audit (
  id bigint generated always as identity primary key,
  user_key text,
  user_id uuid,
  unknown_keys text[],
  mapped boolean not null default false,
  detail jsonb not null default '{}'::jsonb,
  migrated_at timestamptz not null default now()
);

revoke all on table internal.settings_migration_audit from public, anon, authenticated;

do $$
declare
  rec record;
  blob jsonb;
  unknown text[] := '{}';
  uid uuid;
  bedtime_label text;
  bedtime_enabled boolean;
  bedtime_time time;
  activity text;
  extra jsonb;
  known text[] := array[
    'notificationsApp','hapticAlerts','autoWorkoutDetect','units','activityGoal',
    'caloriesGoal','stepsGoal','bedtimeReminder','sleepMode','wakeTime','recoveryGoal',
    'sleepSchedule','alarmEnabled','hapticAlarm','smartWake','hibernation',
    'stressShowSleep','stressAlerts','targetBedtime',
    'onboarded','onboardedAt','onboardingGoal','chronoAge',
    'hasWhoopDevice','paired','pairedDeviceId','pairedName',
    'appleHealth','strava','membershipPlan','membershipUntil','lastSyncAt',
    'bpBaselineSys','bpBaselineDia','bpCuffDate','connected'
  ];
  k text;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_settings' and column_name = 'user_key'
  ) then
    for rec in select user_key, settings, created_at, updated_at from public.user_settings
    loop
      blob := coalesce(rec.settings, '{}'::jsonb);
      unknown := '{}';
      for k in select jsonb_object_keys(blob)
      loop
        if not (k = any (known)) then
          unknown := array_append(unknown, k);
        end if;
      end loop;

      uid := null;
      begin
        uid := rec.user_key::uuid;
      exception when others then
        uid := null;
      end;
      if uid is not null and not exists (select 1 from auth.users u where u.id = uid) then
        uid := null;
      end if;

      insert into internal.settings_migration_audit (user_key, user_id, unknown_keys, mapped, detail)
      values (rec.user_key, uid, unknown, uid is not null, jsonb_build_object('keys', (select jsonb_agg(x) from jsonb_object_keys(blob) x)));

      if uid is null then
        continue;
      end if;

      activity := lower(coalesce(blob->>'activityGoal', 'moderate'));
      if activity not in ('low','moderate','high','peak') then
        activity := 'moderate';
      end if;

      bedtime_label := blob->>'bedtimeReminder';
      bedtime_enabled := not (bedtime_label is not null and lower(bedtime_label) in ('off','none'));
      bedtime_time := coalesce(internal.parse_wall_time(bedtime_label), time '22:30');
      if not bedtime_enabled then
        bedtime_time := time '22:30';
      end if;

      extra := '{}'::jsonb;
      if blob ? 'targetBedtime' then
        extra := extra || jsonb_build_object('target_bedtime', blob->>'targetBedtime');
      end if;
      if array_length(unknown, 1) is not null then
        extra := extra || jsonb_build_object('legacy_unknown', blob - known);
      end if;

      insert into public.user_settings_v2 (
        user_id, notifications_enabled, haptic_alerts_enabled, auto_workout_detect,
        units, activity_goal, calories_goal, steps_goal,
        bedtime_reminder_enabled, bedtime_reminder_time,
        sleep_mode, wake_time, recovery_goal, sleep_schedule,
        alarm_enabled, haptic_alarm, smart_wake, hibernation,
        stress_show_sleep, stress_alerts, extra_settings, version, created_at, updated_at
      ) values (
        uid,
        coalesce((blob->>'notificationsApp')::boolean, true),
        coalesce((blob->>'hapticAlerts')::boolean, true),
        coalesce((blob->>'autoWorkoutDetect')::boolean, true),
        case when blob->>'units' in ('imperial','metric') then blob->>'units' else 'imperial' end,
        activity,
        internal.snap_goal(nullif(blob->>'caloriesGoal','')::numeric, 1500, 5000, 50),
        internal.snap_goal(nullif(blob->>'stepsGoal','')::numeric, 4000, 25000, 500),
        bedtime_enabled,
        bedtime_time,
        case when blob->>'sleepMode' in ('PEAK','PERFORM','GET_BY') then blob->>'sleepMode' else 'PEAK' end,
        internal.parse_wall_time(blob->>'wakeTime'),
        least(100, greatest(0, coalesce(nullif(blob->>'recoveryGoal','')::integer, 66))),
        coalesce(
          (
            select array_agg(v::smallint)
            from jsonb_array_elements_text(coalesce(blob->'sleepSchedule', '[]'::jsonb)) with ordinality as t(v, ord)
            where v ~ '^[0-6]$'
          ),
          '{0,1,2,3,4}'::smallint[]
        ),
        coalesce((blob->>'alarmEnabled')::boolean, false),
        coalesce((blob->>'hapticAlarm')::boolean, true),
        coalesce((blob->>'smartWake')::boolean, true),
        coalesce((blob->>'hibernation')::boolean, false),
        coalesce((blob->>'stressShowSleep')::boolean, true),
        coalesce((blob->>'stressAlerts')::boolean, false),
        extra,
        1,
        coalesce(rec.created_at, now()),
        coalesce(rec.updated_at, now())
      )
      on conflict (user_id) do nothing;

      update public.profiles set
        onboarded = coalesce((blob->>'onboarded')::boolean, onboarded),
        onboarded_at = coalesce(nullif(blob->>'onboardedAt','')::timestamptz, onboarded_at),
        onboarding_goal = coalesce(blob->>'onboardingGoal', onboarding_goal),
        reported_age_years = case
          when nullif(blob->>'chronoAge','')::integer between 18 and 90 then (blob->>'chronoAge')::integer
          else reported_age_years
        end
      where id = uid;

      if blob ? 'bpBaselineSys' and blob ? 'bpBaselineDia' then
        insert into public.health_calibrations (
          user_id, kind, systolic, diastolic, measured_on, source, provenance, is_current
        ) values (
          uid,
          'blood_pressure',
          nullif(blob->>'bpBaselineSys','')::numeric,
          nullif(blob->>'bpBaselineDia','')::numeric,
          coalesce(nullif(blob->>'bpCuffDate','')::date, current_date),
          'legacy_settings',
          jsonb_build_object('migrated_from', 'user_settings.settings'),
          true
        )
        on conflict (user_id, kind) where is_current do nothing;
      end if;
    end loop;
  end if;
end $$;

-- Replace the old blob table with the typed table.
drop trigger if exists user_settings_updated_at on public.user_settings;
drop table if exists public.user_settings;
alter table public.user_settings_v2 rename to user_settings;

drop trigger if exists user_settings_touch on public.user_settings;
create trigger user_settings_touch
  before insert or update on public.user_settings
  for each row execute function public.touch_versioned_row();

alter table public.user_settings enable row level security;
alter table public.user_settings force row level security;

drop policy if exists user_settings_select_own on public.user_settings;
create policy user_settings_select_own on public.user_settings
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists user_settings_insert_own on public.user_settings;
create policy user_settings_insert_own on public.user_settings
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists user_settings_update_own on public.user_settings;
create policy user_settings_update_own on public.user_settings
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table public.user_settings from public, anon, authenticated;
grant select, insert, update on table public.user_settings to authenticated;
grant all on table public.user_settings to service_role;

revoke all on table public.profiles from public, anon;
grant select, insert, update on table public.profiles to authenticated;
grant all on table public.profiles to service_role;

revoke all on table public.devices from public, anon;
grant select, insert, update on table public.devices to authenticated;
grant all on table public.devices to service_role;

create unique index if not exists devices_external_unique
  on public.devices (user_id, source_kind, external_device_id)
  where external_device_id is not null;

-- ── Integrations ───────────────────────────────────────────────────────────

create table if not exists internal.integration_secrets (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  tokens jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table internal.integration_secrets enable row level security;
revoke all on table internal.integration_secrets from public, anon, authenticated;
grant all on table internal.integration_secrets to service_role;

create table if not exists public.integration_connections_v2 (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  enabled boolean not null default false,
  authorization_status text not null default 'not_requested',
  connection_status text not null default 'disconnected',
  last_sync_attempt_at timestamptz,
  last_sync_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  meta jsonb not null default '{}'::jsonb,
  connected_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider),
  constraint integration_provider_check check (provider = any (array['apple_health'::text, 'strava'::text])),
  constraint integration_authorization_check check (authorization_status = any (array[
    'not_requested'::text, 'denied'::text, 'authorized'::text, 'unavailable'::text
  ])),
  constraint integration_connection_check check (connection_status = any (array[
    'disconnected'::text, 'connected'::text, 'syncing'::text, 'error'::text
  ])),
  constraint integration_meta_size_check check (pg_column_size(meta) <= 16384)
);

do $$
declare rec record; uid uuid; authz text; enabled boolean;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'integration_connections' and column_name = 'user_key'
  ) then
    for rec in select * from public.integration_connections
    loop
      begin uid := rec.user_key::uuid; exception when others then uid := null; end;
      if uid is null or not exists (select 1 from auth.users u where u.id = uid) then
        continue;
      end if;
      if rec.tokens is not null and rec.tokens <> '{}'::jsonb then
        insert into internal.integration_secrets (user_id, provider, tokens)
        values (uid, rec.provider, rec.tokens)
        on conflict (user_id, provider) do update set tokens = excluded.tokens, updated_at = now();
      end if;
      authz := coalesce(rec.meta->>'authorization', case when rec.status = 'connected' then 'authorized' else 'not_requested' end);
      if authz not in ('not_requested','denied','authorized','unavailable') then
        authz := 'not_requested';
      end if;
      enabled := rec.status = 'connected';
      insert into public.integration_connections_v2 (
        user_id, provider, enabled, authorization_status, connection_status,
        last_sync_status, last_sync_error, meta, connected_at, created_at, updated_at
      ) values (
        uid,
        rec.provider,
        enabled,
        authz,
        'disconnected',
        case when rec.provider = 'apple_health' then 'not_implemented' else null end,
        case when rec.provider = 'apple_health' then 'Authorization is stored; HealthKit metrics are not ingested yet.' else null end,
        coalesce(rec.meta, '{}'::jsonb),
        rec.connected_at,
        coalesce(rec.updated_at, now()),
        coalesce(rec.updated_at, now())
      )
      on conflict (user_id, provider) do nothing;
    end loop;
  end if;
end $$;

drop trigger if exists integration_connections_updated_at on public.integration_connections;
drop table if exists public.integration_connections;
alter table public.integration_connections_v2 rename to integration_connections;

drop trigger if exists integration_connections_touch on public.integration_connections;
create trigger integration_connections_touch
  before insert or update on public.integration_connections
  for each row execute function public.touch_versioned_row();

alter table public.integration_connections enable row level security;
alter table public.integration_connections force row level security;

drop policy if exists integration_connections_select_own on public.integration_connections;
create policy integration_connections_select_own on public.integration_connections
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists integration_connections_insert_own on public.integration_connections;
create policy integration_connections_insert_own on public.integration_connections
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists integration_connections_update_own on public.integration_connections;
create policy integration_connections_update_own on public.integration_connections
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table public.integration_connections from public, anon, authenticated;
grant select, insert, update on table public.integration_connections to authenticated;
grant all on table public.integration_connections to service_role;

-- ── Health calibrations RLS ────────────────────────────────────────────────

drop trigger if exists health_calibrations_updated_at on public.health_calibrations;
create trigger health_calibrations_updated_at
  before update on public.health_calibrations
  for each row execute function public.set_updated_at();

alter table public.health_calibrations enable row level security;
alter table public.health_calibrations force row level security;

drop policy if exists health_calibrations_select_own on public.health_calibrations;
create policy health_calibrations_select_own on public.health_calibrations
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists health_calibrations_insert_own on public.health_calibrations;
create policy health_calibrations_insert_own on public.health_calibrations
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists health_calibrations_update_own on public.health_calibrations;
create policy health_calibrations_update_own on public.health_calibrations
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists health_calibrations_delete_own on public.health_calibrations;
create policy health_calibrations_delete_own on public.health_calibrations
  for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.health_calibrations from public, anon, authenticated;
grant select, insert, update, delete on table public.health_calibrations to authenticated;
grant all on table public.health_calibrations to service_role;

-- ── Account provisioning ───────────────────────────────────────────────────

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', ''))
  on conflict (id) do nothing;
  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- Existing users without a settings row receive defaults.
insert into public.user_settings (user_id)
select u.id from auth.users u
on conflict (user_id) do nothing;

-- ── Realtime ───────────────────────────────────────────────────────────────

do $$
begin
  begin
    alter publication supabase_realtime add table only public.user_settings;
  exception when duplicate_object then
    null;
  end;
  begin
    alter publication supabase_realtime add table only public.integration_connections;
  exception when duplicate_object then
    null;
  end;
end $$;

-- ── Drop privileged Settings RPCs; lock remaining ingest RPCs ──────────────

drop function if exists public.app_upsert_settings(text, text, jsonb);
drop function if exists public.app_get_settings(text, text);
drop function if exists public.app_upsert_integration(text, text, text, text, jsonb, jsonb, timestamptz);
drop function if exists public.app_list_integrations(text, text);
drop function if exists public.app_delete_integration(text, text, text);
drop function if exists public.app_secret_ok(text);

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'app_upsert_daily_metrics',
        'app_upsert_device',
        'engine_ingest_upsert',
        'engine_ingest_extras',
        'engine_load_user_days'
      )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    execute format('alter function %s set search_path = pg_catalog, public', r.sig);
  end loop;
end $$;
alter function public.handle_new_user() set search_path = '';

create or replace function public.engine_put_integration_secret(
  p_user_id uuid,
  p_provider text,
  p_tokens jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, internal, public
as $$
begin
  if p_user_id is null or p_provider is null then
    raise exception 'user and provider required';
  end if;
  insert into internal.integration_secrets (user_id, provider, tokens)
  values (p_user_id, p_provider, coalesce(p_tokens, '{}'::jsonb))
  on conflict (user_id, provider) do update
    set tokens = excluded.tokens, updated_at = now();
end;
$$;

create or replace function public.engine_get_integration_secret(p_user_id uuid, p_provider text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, internal, public
as $$
declare out jsonb;
begin
  select tokens into out
  from internal.integration_secrets
  where user_id = p_user_id and provider = p_provider;
  return coalesce(out, '{}'::jsonb);
end;
$$;

create or replace function public.engine_delete_integration_secret(p_user_id uuid, p_provider text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, internal, public
as $$
begin
  delete from internal.integration_secrets
  where user_id = p_user_id and provider = p_provider;
end;
$$;

revoke all on function public.engine_put_integration_secret(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.engine_get_integration_secret(uuid, text) from public, anon, authenticated;
revoke all on function public.engine_delete_integration_secret(uuid, text) from public, anon, authenticated;
grant execute on function public.engine_put_integration_secret(uuid, text, jsonb) to service_role;
grant execute on function public.engine_get_integration_secret(uuid, text) to service_role;
grant execute on function public.engine_delete_integration_secret(uuid, text) to service_role;
