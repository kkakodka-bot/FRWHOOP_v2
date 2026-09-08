-- Canonical IANA day bounds for SQL RPCs, daily physiology series,
-- ingest gap accounting, private Broadcast invalidation, and key versions.
-- Expand-only. Does not drop user health rows.

-- ---------------------------------------------------------------------------
-- Day-boundary contract (must match backend/time/dayBoundary.js)
-- Local midnight → next local midnight in the IANA zone. DST 23/25h.
-- ---------------------------------------------------------------------------
create or replace function public.day_bounds(p_day date, p_tz text)
returns table (
  day date,
  timezone_name text,
  day_start_at timestamptz,
  day_end_at timestamptz,
  timezone_offset_seconds integer
)
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  tz text := coalesce(nullif(btrim(p_tz), ''), 'UTC');
  start_at timestamptz;
  end_at timestamptz;
begin
  begin
    start_at := (p_day::timestamp at time zone tz);
    end_at := ((p_day + 1)::timestamp at time zone tz);
  exception when others then
    tz := 'UTC';
    start_at := (p_day::timestamp at time zone tz);
    end_at := ((p_day + 1)::timestamp at time zone tz);
  end;
  return query select
    p_day,
    tz,
    start_at,
    end_at,
    (extract(epoch from (p_day::timestamp - (start_at at time zone 'UTC'))))::integer;
end;
$$;

create or replace function public.local_calendar_date(p_at timestamptz, p_tz text)
returns date
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  tz text := coalesce(nullif(btrim(p_tz), ''), 'UTC');
begin
  if p_at is null then
    return null;
  end if;
  begin
    return (p_at at time zone tz)::date;
  exception when others then
    return (p_at at time zone 'UTC')::date;
  end;
end;
$$;

create or replace function public.profile_timezone(p_user_id uuid)
returns text
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select nullif(btrim(p.timezone), '') from public.profiles p where p.id = p_user_id),
    'UTC'
  );
$$;

revoke all on function public.day_bounds(date, text) from public, anon;
revoke all on function public.local_calendar_date(timestamptz, text) from public, anon;
revoke all on function public.profile_timezone(uuid) from public, anon;
grant execute on function public.day_bounds(date, text) to authenticated, service_role;
grant execute on function public.local_calendar_date(timestamptz, text) to authenticated, service_role;
grant execute on function public.profile_timezone(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- daily_physiology_series: one row per user per local day (not 288 bucket rows)
-- ---------------------------------------------------------------------------
create table if not exists public.daily_physiology_series (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  timezone_name text not null default 'UTC',
  day_start_at timestamptz not null,
  day_end_at timestamptz not null,
  bucket_minutes integer not null default 5,
  hr_series jsonb not null default '[]'::jsonb,
  stress_series jsonb not null default '[]'::jsonb,
  strain_series jsonb not null default '[]'::jsonb,
  movement_series jsonb not null default '[]'::jsonb,
  quality_series jsonb not null default '[]'::jsonb,
  sample_count integer not null default 0,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, day),
  constraint daily_physiology_series_bucket_check check (bucket_minutes = 5),
  constraint daily_physiology_series_hr_size_check check (pg_column_size(hr_series) <= 262144)
);

create index if not exists daily_physiology_series_updated_idx
  on public.daily_physiology_series (user_id, updated_at desc);

drop trigger if exists daily_physiology_series_updated on public.daily_physiology_series;
create trigger daily_physiology_series_updated
  before update on public.daily_physiology_series
  for each row execute function public.set_updated_at();

alter table public.daily_physiology_series enable row level security;
revoke all on table public.daily_physiology_series from public, anon;
grant select, insert, update, delete on table public.daily_physiology_series to authenticated;
grant all on table public.daily_physiology_series to service_role;

drop policy if exists daily_physiology_series_select_own on public.daily_physiology_series;
drop policy if exists daily_physiology_series_write_own on public.daily_physiology_series;
create policy daily_physiology_series_select_own on public.daily_physiology_series
  for select to authenticated using (user_id = (select auth.uid()));
create policy daily_physiology_series_write_own on public.daily_physiology_series
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

comment on table public.daily_physiology_series is
  'Product projection: compact 5-minute series for one local day. Raw samples live in B2.';
comment on table public.physiology_buckets is
  'DEPRECATED. Writers stopped 2026-08-24. Use daily_physiology_series. Kept for deletion/rollback.';

-- ---------------------------------------------------------------------------
-- ingest_gaps: explicit missing intervals for recovery/sleep
-- ---------------------------------------------------------------------------
create table if not exists public.ingest_gaps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid,
  kind text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  expected_samples integer,
  received_samples integer not null default 0,
  sample_seq_start bigint,
  sample_seq_end bigint,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ingest_gaps_kind_check check (kind = any (array[
    'missing_interval'::text, 'connection'::text, 'upload'::text,
    'bluetooth_off'::text, 'not_restored'::text, 'app_killed'::text, 'suspend'::text
  ])),
  constraint ingest_gaps_window_check check (end_at >= start_at)
);

create index if not exists ingest_gaps_user_time_idx
  on public.ingest_gaps (user_id, start_at desc);

alter table public.ingest_gaps enable row level security;
revoke all on table public.ingest_gaps from public, anon;
grant select, insert on table public.ingest_gaps to authenticated;
grant all on table public.ingest_gaps to service_role;

drop policy if exists ingest_gaps_select_own on public.ingest_gaps;
drop policy if exists ingest_gaps_insert_own on public.ingest_gaps;
create policy ingest_gaps_select_own on public.ingest_gaps
  for select to authenticated using (user_id = (select auth.uid()));
create policy ingest_gaps_insert_own on public.ingest_gaps
  for insert to authenticated with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Snapshot / range RPCs use IANA bounds, not naive date::timestamp
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
  tz text;
  bounds record;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  tz := public.profile_timezone(uid);
  select * into bounds from public.day_bounds(p_day, tz);
  return jsonb_build_object(
    'day', p_day,
    'timezone_name', bounds.timezone_name,
    'day_start_at', bounds.day_start_at,
    'day_end_at', bounds.day_end_at,
    'timezone_offset_seconds', bounds.timezone_offset_seconds,
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
        'timezone_name', coalesce(m.timezone_name, bounds.timezone_name),
        'day_start_at', coalesce(m.day_start_at, bounds.day_start_at),
        'day_end_at', coalesce(m.day_end_at, bounds.day_end_at),
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
        and public.local_calendar_date(coalesce(d.original_end_at, d.original_start_at), tz) = p_day
    ), '[]'::jsonb),
    'sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'kind', s.kind, 'source', s.source,
        'start_at', s.start_at, 'end_at', s.end_at,
        'summary', s.summary, 'user_modified', s.user_modified
      ) order by s.start_at)
      from public.sessions s
      where s.user_id = uid
        and s.start_at < bounds.day_end_at
        and coalesce(s.end_at, s.start_at) > bounds.day_start_at
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'event_type', e.event_type, 'occurred_at', e.occurred_at,
        'text_value', e.text_value, 'numeric_value', e.numeric_value, 'payload', e.payload
      ) order by e.occurred_at)
      from public.events e
      where e.user_id = uid
        and e.occurred_at >= bounds.day_start_at
        and e.occurred_at < bounds.day_end_at
    ), '[]'::jsonb),
    'chart', coalesce((
      select s.hr_series
      from public.daily_physiology_series s
      where s.user_id = uid and s.day = p_day
    ), '[]'::jsonb),
    'gaps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', g.id, 'kind', g.kind, 'start_at', g.start_at, 'end_at', g.end_at,
        'expected_samples', g.expected_samples, 'received_samples', g.received_samples
      ) order by g.start_at)
      from public.ingest_gaps g
      where g.user_id = uid
        and g.start_at < bounds.day_end_at
        and g.end_at > bounds.day_start_at
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
    'timezone_name', d.timezone_name,
    'day_start_at', d.day_start_at,
    'day_end_at', d.day_end_at
  ) order by d.day desc), '[]'::jsonb)
  from public.daily_metrics d
  where d.user_id = (select auth.uid())
    and d.record_class = 'user'
    and d.day >= p_from
    and d.day <= p_to;
$$;

create or replace function public.get_days(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  uid uuid := (select auth.uid());
  lo date;
  hi date;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  lo := p_from;
  hi := least(p_to, p_from + 366);
  return coalesce((
    select jsonb_agg(public.get_day_snapshot(d::date) order by d)
    from generate_series(lo, hi, interval '1 day') as g(d)
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.get_days(date, date) to authenticated, service_role;
grant execute on function public.get_day_snapshot(date) to authenticated, service_role;
grant execute on function public.get_range(date, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Private Broadcast invalidation (not Postgres Changes)
-- ---------------------------------------------------------------------------
create or replace function internal.emit_user_invalidation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, realtime
as $$
declare
  uid uuid;
  kind text;
  day_val text;
begin
  uid := coalesce(NEW.user_id, OLD.user_id);
  if uid is null then
    return coalesce(NEW, OLD);
  end if;
  kind := case tg_table_name
    when 'user_settings' then 'settings_updated'
    when 'integration_connections' then 'settings_updated'
    when 'daily_metrics' then 'metrics_updated'
    when 'daily_physiology_series' then 'metrics_updated'
    when 'sleep_details' then 'sleep_updated'
    when 'sessions' then 'workout_updated'
    else 'metrics_updated'
  end;
  begin
    if tg_op = 'DELETE' then
      day_val := to_jsonb(OLD)->>'day';
    else
      day_val := to_jsonb(NEW)->>'day';
    end if;
    perform realtime.send(
      jsonb_build_object('kind', kind, 'day', day_val),
      kind,
      'user:' || uid::text,
      true
    );
  exception when others then
    null;
  end;
  return coalesce(NEW, OLD);
end;
$$;

drop trigger if exists user_settings_invalidate on public.user_settings;
create trigger user_settings_invalidate
  after insert or update or delete on public.user_settings
  for each row execute function internal.emit_user_invalidation();

drop trigger if exists integration_connections_invalidate on public.integration_connections;
create trigger integration_connections_invalidate
  after insert or update or delete on public.integration_connections
  for each row execute function internal.emit_user_invalidation();

drop trigger if exists daily_metrics_invalidate on public.daily_metrics;
create trigger daily_metrics_invalidate
  after insert or update on public.daily_metrics
  for each row execute function internal.emit_user_invalidation();

drop trigger if exists sleep_details_invalidate on public.sleep_details;
create trigger sleep_details_invalidate
  after insert or update on public.sleep_details
  for each row execute function internal.emit_user_invalidation();

drop trigger if exists sessions_invalidate on public.sessions;
create trigger sessions_invalidate
  after insert or update on public.sessions
  for each row execute function internal.emit_user_invalidation();

drop trigger if exists daily_physiology_series_invalidate on public.daily_physiology_series;
create trigger daily_physiology_series_invalidate
  after insert or update on public.daily_physiology_series
  for each row execute function internal.emit_user_invalidation();

do $$
begin
  alter publication supabase_realtime drop table public.user_settings;
exception when undefined_object then
  null;
when undefined_table then
  null;
end $$;

do $$
begin
  alter publication supabase_realtime drop table public.integration_connections;
exception when undefined_object then
  null;
when undefined_table then
  null;
end $$;

do $$
begin
  alter table realtime.messages enable row level security;
  grant select on table realtime.messages to authenticated;
  drop policy if exists realtime_select_own_user_topic on realtime.messages;
  create policy realtime_select_own_user_topic on realtime.messages
    for select to authenticated
    using (
      topic = 'user:' || (select auth.uid())::text
    );
exception when undefined_table then
  null;
when insufficient_privilege then
  null;
end $$;

-- ---------------------------------------------------------------------------
-- Credential key versions
-- ---------------------------------------------------------------------------
alter table internal.integration_secrets
  add column if not exists key_version integer not null default 1;

create or replace function public.engine_put_integration_secret(
  p_user_id uuid, p_provider text, p_tokens jsonb
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
  if p_tokens is null or p_tokens = '{}'::jsonb or coalesce(p_tokens->>'v', '') = 'missing_key' then
    raise exception 'encrypted credentials required';
  end if;
  insert into internal.integration_secrets (user_id, provider, tokens, key_version)
  values (
    p_user_id,
    p_provider,
    p_tokens,
    coalesce(nullif(p_tokens->>'key_version', '')::integer, 1)
  )
  on conflict (user_id, provider) do update
    set tokens = excluded.tokens,
        key_version = excluded.key_version,
        updated_at = now();
end;
$$;

revoke all on function public.engine_put_integration_secret(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.engine_put_integration_secret(uuid, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Legacy tables: validate then freeze writes from authenticated
-- Row counts at cutover: sleep_nights=sleep_details (2=2, same session ids),
-- sensor_objects=object_manifests raw (33=33), derived_objects=derived manifests (13=13).
-- ---------------------------------------------------------------------------
revoke insert, update, delete on table public.sleep_nights from authenticated;
revoke insert, update, delete on table public.sensor_objects from authenticated;
revoke insert, update, delete on table public.derived_objects from authenticated;
revoke insert, update, delete on table public.physiology_buckets from authenticated;
grant select on table public.sleep_nights to authenticated;
grant select on table public.sensor_objects to authenticated;
grant select on table public.derived_objects to authenticated;
grant select on table public.physiology_buckets to authenticated;

comment on table public.sleep_nights is
  'LEGACY READ-ONLY. Equivalence vs sleep_details verified 2026-08-24. Do not dual-write.';
comment on table public.sensor_objects is
  'LEGACY READ-ONLY. Equivalence vs object_manifests raw verified 2026-08-24. Do not dual-write.';
comment on table public.derived_objects is
  'LEGACY READ-ONLY. Equivalence vs object_manifests derived verified 2026-08-24. Do not dual-write.';
