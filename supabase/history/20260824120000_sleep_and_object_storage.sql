-- Sleep + dual-store production schema.
-- Raw archives live in Backblaze (or AWS raw fallback). Derived JSON lives in AWS S3.
-- Queryable metrics live in Postgres for the app, coach, and algorithms.

create schema if not exists internal;
revoke all on schema internal from public;
revoke all on schema internal from anon, authenticated;

create table if not exists internal.app_secrets (
  name text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create or replace function internal.assert_ingest_secret(p_secret text)
returns void
language plpgsql
security definer
set search_path = internal
as $$
declare expected text;
begin
  select s.value into expected from internal.app_secrets s where s.name = 'ingest';
  if expected is null or p_secret is null or p_secret is distinct from expected then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
end;
$$;
revoke all on function internal.assert_ingest_secret(text) from public;

alter table public.daily_metrics add column if not exists sleep_in_bed_min numeric;
alter table public.daily_metrics add column if not exists sleep_awake_min numeric;
alter table public.daily_metrics add column if not exists sleep_need_min numeric;
alter table public.daily_metrics add column if not exists sleep_consistency numeric;
alter table public.daily_metrics add column if not exists sleep_onset_at timestamptz;
alter table public.daily_metrics add column if not exists wake_onset_at timestamptz;
alter table public.daily_metrics add column if not exists overnight_hr_bpm numeric;
alter table public.daily_metrics add column if not exists disturbances integer;

alter table public.sensor_objects add column if not exists store text not null default 'b2';

alter table public.sensor_objects drop constraint if exists sensor_objects_kind_check;
alter table public.sensor_objects
  add constraint sensor_objects_kind_check
  check (object_kind = any (array['canonical'::text, 'ppg'::text, 'imu'::text, 'diagnostic'::text, 'export'::text, 'live_hr'::text]));

create table if not exists public.sleep_nights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  period_day date not null,
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
  stages jsonb not null default '[]'::jsonb,
  hypnogram jsonb not null default '[]'::jsonb,
  derived_object_key text,
  algorithm_version text,
  computed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sleep_nights_range_check check (end_at > start_at),
  constraint sleep_nights_efficiency_check check (efficiency is null or (efficiency >= 0 and efficiency <= 1)),
  constraint sleep_nights_performance_check check (performance_pct is null or (performance_pct >= 0 and performance_pct <= 100))
);

create unique index if not exists sleep_nights_user_start_idx on public.sleep_nights (user_id, start_at);
create index if not exists sleep_nights_user_day_idx on public.sleep_nights (user_id, period_day desc);
create index if not exists sleep_nights_device_id_idx on public.sleep_nights (device_id);

create table if not exists public.derived_objects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  object_kind text not null,
  object_key text not null unique,
  store text not null default 's3',
  bucket text,
  period_day date,
  compressed_bytes bigint,
  content_type text not null default 'application/gzip',
  sha256 text,
  algorithm_version text,
  status text not null default 'ready',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint derived_objects_kind_check check (object_kind = any (array['sleep_summary'::text, 'daily_metrics'::text, 'hypnogram'::text, 'hr_series'::text, 'export'::text])),
  constraint derived_objects_status_check check (status = any (array['pending'::text, 'ready'::text, 'failed'::text, 'deleting'::text]))
);

create index if not exists derived_objects_user_day_idx on public.derived_objects (user_id, period_day, object_kind);

create table if not exists public.live_windows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  period_day date not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  sample_count bigint,
  raw_object_id uuid references public.sensor_objects(id) on delete set null,
  status text not null default 'ready',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists live_windows_user_day_idx on public.live_windows (user_id, period_day desc);
create index if not exists live_windows_device_id_idx on public.live_windows (device_id);
create index if not exists live_windows_raw_object_id_idx on public.live_windows (raw_object_id);

create table if not exists public.metric_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  period_day date,
  algorithm text not null default 'sleep_v1',
  version text,
  status text not null default 'complete',
  input_refs jsonb not null default '{}'::jsonb,
  output_refs jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists metric_runs_user_day_idx on public.metric_runs (user_id, period_day desc);

drop trigger if exists sleep_nights_updated_at on public.sleep_nights;
create trigger sleep_nights_updated_at before update on public.sleep_nights
  for each row execute function set_updated_at();

drop trigger if exists derived_objects_updated_at on public.derived_objects;
create trigger derived_objects_updated_at before update on public.derived_objects
  for each row execute function set_updated_at();

drop trigger if exists live_windows_updated_at on public.live_windows;
create trigger live_windows_updated_at before update on public.live_windows
  for each row execute function set_updated_at();

alter table public.sleep_nights enable row level security;
alter table public.derived_objects enable row level security;
alter table public.live_windows enable row level security;
alter table public.metric_runs enable row level security;

drop policy if exists sleep_nights_select_own on public.sleep_nights;
create policy sleep_nights_select_own on public.sleep_nights for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists sleep_nights_insert_own on public.sleep_nights;
create policy sleep_nights_insert_own on public.sleep_nights for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists sleep_nights_update_own on public.sleep_nights;
create policy sleep_nights_update_own on public.sleep_nights for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists derived_objects_select_own on public.derived_objects;
create policy derived_objects_select_own on public.derived_objects for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists live_windows_select_own on public.live_windows;
create policy live_windows_select_own on public.live_windows for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists metric_runs_select_own on public.metric_runs;
create policy metric_runs_select_own on public.metric_runs for select to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update on public.sleep_nights to authenticated;
grant select, insert, update, delete on public.sleep_nights to service_role;
grant select on public.derived_objects to authenticated;
grant select, insert, update, delete on public.derived_objects to service_role;
grant select on public.live_windows to authenticated;
grant select, insert, update, delete on public.live_windows to service_role;
grant select on public.metric_runs to authenticated;
grant select, insert, update, delete on public.metric_runs to service_role;

drop view if exists public.dashboard_days cascade;

create view public.dashboard_days
  with (security_invoker = true)
as
  select
    user_id, day, source_device_id, charge, effort, rest, readiness_level,
    hrv_rmssd_ms, hrv_sdnn_ms, resting_hr_bpm, avg_hr_bpm, resp_rate_bpm,
    skin_temp_dev_c, spo2_pct, steps, active_kcal,
    sleep_total_min, sleep_deep_min, sleep_rem_min, sleep_light_min,
    sleep_in_bed_min, sleep_awake_min, sleep_need_min, sleep_consistency,
    sleep_efficiency, sleep_onset_at, wake_onset_at, overnight_hr_bpm, disturbances,
    exercise_count, provenance, algorithm_version, computed_at, updated_at
  from public.daily_metrics;

grant select on public.dashboard_days to authenticated, service_role;

create or replace function public.get_frwhoop_range(from_day date, to_day date)
returns setof public.dashboard_days
language sql
stable
set search_path to ''
as $function$
  select *
  from public.dashboard_days
  where user_id = (select auth.uid())
    and day >= from_day
    and day <= to_day
  order by day desc
  limit 366;
$function$;

grant execute on function public.get_frwhoop_range(date, date) to authenticated, service_role;

create or replace function public.get_frwhoop_day(for_day date)
returns jsonb
language sql
stable
set search_path to ''
as $function$
  select jsonb_build_object(
    'day', for_day,
    'metrics', (
      select to_jsonb(m)
      from public.daily_metrics m
      where m.user_id = (select auth.uid())
        and m.day = for_day
    ),
    'sleep_nights', coalesce((
      select jsonb_agg((to_jsonb(n) - 'stages') order by n.start_at)
      from public.sleep_nights n
      where n.user_id = (select auth.uid())
        and n.period_day = for_day
    ), '[]'::jsonb),
    'sessions', coalesce((
      select jsonb_agg((to_jsonb(s) - 'segments') order by s.start_at)
      from public.sessions s
      where s.user_id = (select auth.uid())
        and s.start_at < ((for_day + 1)::timestamp at time zone 'utc')
        and s.end_at > (for_day::timestamp at time zone 'utc')
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.occurred_at)
      from public.events e
      where e.user_id = (select auth.uid())
        and e.occurred_at >= (for_day::timestamp at time zone 'utc')
        and e.occurred_at < ((for_day + 1)::timestamp at time zone 'utc')
    ), '[]'::jsonb),
    'archives', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id,
        'object_kind', o.object_kind,
        'period_day', o.period_day,
        'sample_count', o.sample_count,
        'compressed_bytes', o.compressed_bytes,
        'status', o.status,
        'store', o.store
      ) order by o.start_at)
      from public.sensor_objects o
      where o.user_id = (select auth.uid())
        and o.period_day = for_day
        and o.status = 'ready'
    ), '[]'::jsonb)
  );
$function$;

create or replace function public.engine_ingest_upsert(p_secret text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
  r jsonb;
begin
  perform internal.assert_ingest_secret(p_secret);
  v_user := nullif(p_payload->>'user_id', '')::uuid;
  if v_user is null then
    raise exception 'user_id required';
  end if;

  if p_payload ? 'device' and jsonb_typeof(p_payload->'device') = 'object' then
    insert into public.devices (id, user_id, source_kind, external_device_id, device_family, firmware, last_seen_at)
    values (
      coalesce(nullif(p_payload->'device'->>'id', '')::uuid, gen_random_uuid()),
      v_user,
      coalesce(p_payload->'device'->>'source_kind', 'whoop'),
      p_payload->'device'->>'external_device_id',
      p_payload->'device'->>'device_family',
      p_payload->'device'->>'firmware',
      now()
    )
    on conflict (user_id, source_kind, external_device_id) where external_device_id is not null
    do update set
      firmware = coalesce(excluded.firmware, public.devices.firmware),
      device_family = coalesce(excluded.device_family, public.devices.device_family),
      last_seen_at = now(),
      updated_at = now();
  end if;

  for r in select value from jsonb_array_elements(coalesce(p_payload->'daily_metrics', '[]'::jsonb))
  loop
    insert into public.daily_metrics (
      user_id, day, source_device_id, charge, effort, rest,
      hrv_rmssd_ms, resting_hr_bpm, resp_rate_bpm,
      sleep_total_min, sleep_in_bed_min, sleep_awake_min, sleep_light_min, sleep_deep_min, sleep_rem_min,
      sleep_efficiency, sleep_need_min, sleep_debt_balance_min, sleep_consistency,
      sleep_onset_at, wake_onset_at, overnight_hr_bpm, disturbances,
      chart_data, extras, provenance, algorithm_version, computed_at
    ) values (
      v_user,
      (r->>'day')::date,
      nullif(r->>'source_device_id', '')::uuid,
      nullif(r->>'charge', '')::numeric,
      nullif(r->>'effort', '')::numeric,
      nullif(r->>'rest', '')::numeric,
      nullif(r->>'hrv_rmssd_ms', '')::numeric,
      nullif(r->>'resting_hr_bpm', '')::numeric,
      nullif(r->>'resp_rate_bpm', '')::numeric,
      nullif(r->>'sleep_total_min', '')::numeric,
      nullif(r->>'sleep_in_bed_min', '')::numeric,
      nullif(r->>'sleep_awake_min', '')::numeric,
      nullif(r->>'sleep_light_min', '')::numeric,
      nullif(r->>'sleep_deep_min', '')::numeric,
      nullif(r->>'sleep_rem_min', '')::numeric,
      nullif(r->>'sleep_efficiency', '')::numeric,
      nullif(r->>'sleep_need_min', '')::numeric,
      nullif(r->>'sleep_debt_balance_min', '')::numeric,
      nullif(r->>'sleep_consistency', '')::numeric,
      nullif(r->>'sleep_onset_at', '')::timestamptz,
      nullif(r->>'wake_onset_at', '')::timestamptz,
      nullif(r->>'overnight_hr_bpm', '')::numeric,
      nullif(r->>'disturbances', '')::integer,
      coalesce(r->'chart_data', '{}'::jsonb),
      coalesce(r->'extras', '{}'::jsonb),
      coalesce(r->'provenance', '{}'::jsonb),
      r->>'algorithm_version',
      coalesce(nullif(r->>'computed_at', '')::timestamptz, now())
    )
    on conflict (user_id, day) do update set
      source_device_id = coalesce(excluded.source_device_id, public.daily_metrics.source_device_id),
      charge = coalesce(excluded.charge, public.daily_metrics.charge),
      effort = coalesce(excluded.effort, public.daily_metrics.effort),
      rest = coalesce(excluded.rest, public.daily_metrics.rest),
      hrv_rmssd_ms = coalesce(excluded.hrv_rmssd_ms, public.daily_metrics.hrv_rmssd_ms),
      resting_hr_bpm = coalesce(excluded.resting_hr_bpm, public.daily_metrics.resting_hr_bpm),
      resp_rate_bpm = coalesce(excluded.resp_rate_bpm, public.daily_metrics.resp_rate_bpm),
      sleep_total_min = coalesce(excluded.sleep_total_min, public.daily_metrics.sleep_total_min),
      sleep_in_bed_min = coalesce(excluded.sleep_in_bed_min, public.daily_metrics.sleep_in_bed_min),
      sleep_awake_min = coalesce(excluded.sleep_awake_min, public.daily_metrics.sleep_awake_min),
      sleep_light_min = coalesce(excluded.sleep_light_min, public.daily_metrics.sleep_light_min),
      sleep_deep_min = coalesce(excluded.sleep_deep_min, public.daily_metrics.sleep_deep_min),
      sleep_rem_min = coalesce(excluded.sleep_rem_min, public.daily_metrics.sleep_rem_min),
      sleep_efficiency = coalesce(excluded.sleep_efficiency, public.daily_metrics.sleep_efficiency),
      sleep_need_min = coalesce(excluded.sleep_need_min, public.daily_metrics.sleep_need_min),
      sleep_debt_balance_min = coalesce(excluded.sleep_debt_balance_min, public.daily_metrics.sleep_debt_balance_min),
      sleep_consistency = coalesce(excluded.sleep_consistency, public.daily_metrics.sleep_consistency),
      sleep_onset_at = coalesce(excluded.sleep_onset_at, public.daily_metrics.sleep_onset_at),
      wake_onset_at = coalesce(excluded.wake_onset_at, public.daily_metrics.wake_onset_at),
      overnight_hr_bpm = coalesce(excluded.overnight_hr_bpm, public.daily_metrics.overnight_hr_bpm),
      disturbances = coalesce(excluded.disturbances, public.daily_metrics.disturbances),
      chart_data = excluded.chart_data,
      extras = excluded.extras,
      provenance = excluded.provenance,
      algorithm_version = excluded.algorithm_version,
      computed_at = excluded.computed_at,
      updated_at = now();
  end loop;

  for r in select value from jsonb_array_elements(coalesce(p_payload->'sleep_nights', '[]'::jsonb))
  loop
    insert into public.sleep_nights (
      id, user_id, device_id, period_day, start_at, end_at, is_nap,
      in_bed_min, asleep_min, awake_min, light_min, deep_min, rem_min,
      efficiency, performance_pct, need_min, debt_min, consistency_pct,
      overnight_hr_bpm, resting_hr_bpm, hrv_rmssd_ms, resp_rate_bpm, disturbances, recovery_pct,
      stages, hypnogram, derived_object_key, algorithm_version, computed_at
    ) values (
      coalesce(nullif(r->>'id', '')::uuid, gen_random_uuid()),
      v_user,
      nullif(r->>'device_id', '')::uuid,
      (r->>'period_day')::date,
      (r->>'start_at')::timestamptz,
      (r->>'end_at')::timestamptz,
      coalesce((r->>'is_nap')::boolean, false),
      nullif(r->>'in_bed_min', '')::numeric,
      nullif(r->>'asleep_min', '')::numeric,
      nullif(r->>'awake_min', '')::numeric,
      nullif(r->>'light_min', '')::numeric,
      nullif(r->>'deep_min', '')::numeric,
      nullif(r->>'rem_min', '')::numeric,
      nullif(r->>'efficiency', '')::numeric,
      nullif(r->>'performance_pct', '')::numeric,
      nullif(r->>'need_min', '')::numeric,
      nullif(r->>'debt_min', '')::numeric,
      nullif(r->>'consistency_pct', '')::numeric,
      nullif(r->>'overnight_hr_bpm', '')::numeric,
      nullif(r->>'resting_hr_bpm', '')::numeric,
      nullif(r->>'hrv_rmssd_ms', '')::numeric,
      nullif(r->>'resp_rate_bpm', '')::numeric,
      nullif(r->>'disturbances', '')::integer,
      nullif(r->>'recovery_pct', '')::numeric,
      coalesce(r->'stages', '[]'::jsonb),
      coalesce(r->'hypnogram', '[]'::jsonb),
      r->>'derived_object_key',
      r->>'algorithm_version',
      coalesce(nullif(r->>'computed_at', '')::timestamptz, now())
    )
    on conflict (user_id, start_at) do update set
      end_at = excluded.end_at,
      in_bed_min = excluded.in_bed_min,
      asleep_min = excluded.asleep_min,
      awake_min = excluded.awake_min,
      light_min = excluded.light_min,
      deep_min = excluded.deep_min,
      rem_min = excluded.rem_min,
      efficiency = excluded.efficiency,
      performance_pct = excluded.performance_pct,
      need_min = excluded.need_min,
      debt_min = excluded.debt_min,
      consistency_pct = excluded.consistency_pct,
      overnight_hr_bpm = excluded.overnight_hr_bpm,
      resting_hr_bpm = excluded.resting_hr_bpm,
      disturbances = excluded.disturbances,
      recovery_pct = excluded.recovery_pct,
      stages = excluded.stages,
      hypnogram = excluded.hypnogram,
      derived_object_key = excluded.derived_object_key,
      algorithm_version = excluded.algorithm_version,
      computed_at = excluded.computed_at,
      updated_at = now();
  end loop;

  for r in select value from jsonb_array_elements(coalesce(p_payload->'sessions', '[]'::jsonb))
  loop
    insert into public.sessions (
      id, user_id, device_id, kind, source, external_id, start_at, end_at, summary, segments, algorithm_version
    ) values (
      coalesce(nullif(r->>'id', '')::uuid, gen_random_uuid()),
      v_user,
      nullif(r->>'device_id', '')::uuid,
      coalesce(r->>'kind', 'sleep'),
      coalesce(r->>'source', 'frwhoop'),
      r->>'external_id',
      (r->>'start_at')::timestamptz,
      (r->>'end_at')::timestamptz,
      coalesce(r->'summary', '{}'::jsonb),
      coalesce(r->'segments', '[]'::jsonb),
      r->>'algorithm_version'
    )
    on conflict (user_id, source, external_id) where external_id is not null
    do update set
      start_at = case when public.sessions.user_modified then public.sessions.start_at else excluded.start_at end,
      end_at = case when public.sessions.user_modified then public.sessions.end_at else excluded.end_at end,
      summary = excluded.summary,
      segments = excluded.segments,
      algorithm_version = excluded.algorithm_version,
      updated_at = now();
  end loop;

  for r in select value from jsonb_array_elements(coalesce(p_payload->'sensor_objects', '[]'::jsonb))
  loop
    insert into public.sensor_objects (
      id, user_id, device_id, object_kind, object_key, store, start_at, end_at, period_day,
      sample_count, compressed_bytes, content_type, format, compression, schema_version, retention_class, status
    ) values (
      coalesce(nullif(r->>'id', '')::uuid, gen_random_uuid()),
      v_user,
      nullif(r->>'device_id', '')::uuid,
      r->>'object_kind',
      r->>'object_key',
      coalesce(r->>'store', 's3'),
      coalesce(nullif(r->>'start_at', '')::timestamptz, now()),
      coalesce(nullif(r->>'end_at', '')::timestamptz, now()),
      nullif(r->>'period_day', '')::date,
      nullif(r->>'sample_count', '')::bigint,
      nullif(r->>'compressed_bytes', '')::bigint,
      coalesce(r->>'content_type', 'application/octet-stream'),
      coalesce(r->>'format', 'ndjson_gzip_v1'),
      coalesce(r->>'compression', 'gzip'),
      coalesce(nullif(r->>'schema_version', '')::integer, 1),
      coalesce(r->>'retention_class', 'ppg'),
      coalesce(r->>'status', 'ready')
    )
    on conflict (object_key) do update set
      status = excluded.status,
      sample_count = excluded.sample_count,
      compressed_bytes = excluded.compressed_bytes,
      updated_at = now();
  end loop;

  for r in select value from jsonb_array_elements(coalesce(p_payload->'derived_objects', '[]'::jsonb))
  loop
    insert into public.derived_objects (
      id, user_id, object_kind, object_key, store, bucket, period_day, compressed_bytes, content_type, algorithm_version, status
    ) values (
      coalesce(nullif(r->>'id', '')::uuid, gen_random_uuid()),
      v_user,
      r->>'object_kind',
      r->>'object_key',
      coalesce(r->>'store', 's3'),
      r->>'bucket',
      nullif(r->>'period_day', '')::date,
      nullif(r->>'compressed_bytes', '')::bigint,
      coalesce(r->>'content_type', 'application/gzip'),
      r->>'algorithm_version',
      coalesce(r->>'status', 'ready')
    )
    on conflict (object_key) do update set
      status = excluded.status,
      compressed_bytes = excluded.compressed_bytes,
      updated_at = now();
  end loop;

  return jsonb_build_object('ok', true, 'user_id', v_user);
end;
$$;

create or replace function public.engine_load_user_days(p_secret text, p_user_id uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  perform internal.assert_ingest_secret(p_secret);
  return jsonb_build_object(
    'daily_metrics', coalesce((
      select jsonb_agg(to_jsonb(m) order by m.day)
      from public.daily_metrics m
      where m.user_id = p_user_id
        and (p_from is null or m.day >= p_from)
        and (p_to is null or m.day <= p_to)
    ), '[]'::jsonb),
    'sleep_nights', coalesce((
      select jsonb_agg(to_jsonb(n) order by n.start_at)
      from public.sleep_nights n
      where n.user_id = p_user_id
        and (p_from is null or n.period_day >= p_from)
        and (p_to is null or n.period_day <= p_to)
    ), '[]'::jsonb),
    'sessions', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.start_at)
      from public.sessions s
      where s.user_id = p_user_id
        and (p_from is null or s.start_at::date >= p_from)
        and (p_to is null or s.start_at::date <= p_to)
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.engine_ingest_upsert(text, jsonb) from public;
revoke all on function public.engine_load_user_days(text, uuid, date, date) from public;
grant execute on function public.engine_ingest_upsert(text, jsonb) to anon, authenticated, service_role;
grant execute on function public.engine_load_user_days(text, uuid, date, date) to anon, authenticated, service_role;
grant execute on function public.get_frwhoop_day(date) to authenticated, service_role;

create or replace function public.engine_ingest_extras(p_secret text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
  r jsonb;
begin
  perform internal.assert_ingest_secret(p_secret);
  v_user := nullif(p_payload->>'user_id', '')::uuid;
  if v_user is null then
    raise exception 'user_id required';
  end if;

  for r in select value from jsonb_array_elements(coalesce(p_payload->'live_windows', '[]'::jsonb))
  loop
    insert into public.live_windows (
      id, user_id, device_id, period_day, start_at, end_at, sample_count, raw_object_id, status
    ) values (
      coalesce(nullif(r->>'id', '')::uuid, gen_random_uuid()),
      v_user,
      nullif(r->>'device_id', '')::uuid,
      (r->>'period_day')::date,
      (r->>'start_at')::timestamptz,
      (r->>'end_at')::timestamptz,
      nullif(r->>'sample_count', '')::bigint,
      nullif(r->>'raw_object_id', '')::uuid,
      coalesce(r->>'status', 'ready')
    )
    on conflict (id) do update set
      end_at = excluded.end_at,
      sample_count = excluded.sample_count,
      raw_object_id = coalesce(excluded.raw_object_id, public.live_windows.raw_object_id),
      status = excluded.status,
      updated_at = now();
  end loop;

  for r in select value from jsonb_array_elements(coalesce(p_payload->'metric_runs', '[]'::jsonb))
  loop
    insert into public.metric_runs (
      id, user_id, period_day, algorithm, version, status, input_refs, output_refs, error, started_at, finished_at
    ) values (
      coalesce(nullif(r->>'id', '')::uuid, gen_random_uuid()),
      v_user,
      nullif(r->>'period_day', '')::date,
      coalesce(r->>'algorithm', 'sleep_v1'),
      r->>'version',
      coalesce(r->>'status', 'complete'),
      coalesce(r->'input_refs', '{}'::jsonb),
      coalesce(r->'output_refs', '{}'::jsonb),
      r->>'error',
      coalesce(nullif(r->>'started_at', '')::timestamptz, now()),
      coalesce(nullif(r->>'finished_at', '')::timestamptz, now())
    )
    on conflict (id) do update set
      status = excluded.status,
      output_refs = excluded.output_refs,
      error = excluded.error,
      finished_at = excluded.finished_at;
  end loop;

  return jsonb_build_object('ok', true, 'user_id', v_user);
end;
$$;

revoke all on function public.engine_ingest_extras(text, jsonb) from public;
grant execute on function public.engine_ingest_extras(text, jsonb) to anon, authenticated, service_role;

alter table internal.app_secrets enable row level security;
revoke all on table internal.app_secrets from public, anon, authenticated;
