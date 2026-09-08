-- Energy expenditure (calorie) system.
--
-- Contract, enforced by the schema rather than by convention:
--   total    = resting + active            (generated column, cannot drift)
--   workout  ⊂ active                      (workout kcal is the active kcal of
--                                           minutes tagged with a session id, so
--                                           it can never be double counted)
--   daily    = aggregate(energy_minutes)   (energy_rollup_day recomputes from the
--                                           minute table; there are no incremental
--                                           counters to corrupt)
--
-- energy_minutes is the single authoritative series. Raw sensor data stays in B2;
-- this table holds one row per wall-clock minute of coverage, which is ~1440
-- rows/day/user worst case, not raw sample rate.

begin;

-- ---------------------------------------------------------------------------
-- Model + calibration registries
-- ---------------------------------------------------------------------------

create table if not exists public.energy_model_versions (
  version text primary key,
  kind text not null default 'global',
  algorithm_version text not null,
  feature_version text not null,
  description text,
  config jsonb not null default '{}'::jsonb,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  constraint energy_model_versions_kind_check
    check (kind = any (array['global'::text, 'calibration'::text, 'baseline'::text]))
);

comment on table public.energy_model_versions is
  'Registry of energy models. Every energy row references a version here so a '
  'historical estimate can be reproduced or compared after an algorithm change.';

-- Only one global model may be active at a time; staged migration flips this.
create unique index if not exists energy_model_versions_active_global_idx
  on public.energy_model_versions (kind)
  where is_active and kind = 'global';

create table if not exists public.energy_user_calibration (
  user_id uuid not null references auth.users(id) on delete cascade,
  version integer not null,
  status text not null default 'shadow',
  global_model_version text references public.energy_model_versions(version),
  params jsonb not null default '{}'::jsonb,
  calibration_confidence numeric(4,3) not null default 0,
  training_days integer not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  retired_at timestamptz,
  primary key (user_id, version),
  constraint energy_user_calibration_status_check
    check (status = any (array['shadow'::text, 'active'::text, 'retired'::text])),
  constraint energy_user_calibration_confidence_check
    check (calibration_confidence >= 0 and calibration_confidence <= 1),
  constraint energy_user_calibration_days_check check (training_days >= 0)
);

comment on table public.energy_user_calibration is
  'Per-user calibration layer on top of a global model. Versioned and additive: '
  'a new row is inserted and activated, the previous row is retired, and the '
  'global model is never mutated. Reversible by reactivating an earlier version.';

-- At most one active calibration per user, so estimation never has to pick.
create unique index if not exists energy_user_calibration_active_idx
  on public.energy_user_calibration (user_id)
  where status = 'active';

-- ---------------------------------------------------------------------------
-- Per-minute canonical series
-- ---------------------------------------------------------------------------

create table if not exists public.energy_minutes (
  user_id uuid not null references auth.users(id) on delete cascade,
  minute_at timestamptz not null,
  day date not null,
  timezone_name text not null default 'UTC',

  met numeric(6,3),
  resting_kcal numeric(8,4) not null default 0,
  active_kcal numeric(8,4) not null default 0,
  total_kcal numeric(8,4) generated always as (resting_kcal + active_kcal) stored,

  activity_type text not null default 'unknown',
  activity_confidence numeric(4,3),
  model_confidence numeric(4,3),

  hr numeric(5,1),
  hr_source text,
  motion_intensity numeric(7,4),
  signal_quality numeric(4,3),
  -- Why this minute's confidence is what it is: 'hr_jumps', 'motion_absent',
  -- 'rr_artefacts', etc. Kept so a bad estimate can be explained after the fact
  -- without re-reading B2.
  quality_flags text[] not null default '{}',

  workout_session_id uuid references public.sessions(id) on delete set null,
  estimator text,
  model_version text references public.energy_model_versions(version),
  feature_version text,
  calibration_version integer,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (user_id, minute_at),

  constraint energy_minutes_met_check check (met is null or (met >= 0 and met <= 30)),
  constraint energy_minutes_resting_check check (resting_kcal >= 0 and resting_kcal <= 10),
  constraint energy_minutes_active_check check (active_kcal >= 0 and active_kcal <= 40),
  constraint energy_minutes_hr_check check (hr is null or (hr >= 20 and hr <= 240)),
  constraint energy_minutes_conf_check
    check (model_confidence is null or (model_confidence >= 0 and model_confidence <= 1)),
  constraint energy_minutes_quality_check
    check (signal_quality is null or (signal_quality >= 0 and signal_quality <= 1)),
  constraint energy_minutes_activity_check check (activity_type = any (array[
    'sleep'::text, 'sedentary'::text, 'standing'::text, 'walking'::text,
    'running'::text, 'cycling'::text, 'strength'::text, 'workout_other'::text,
    'daily_activity'::text, 'unknown'::text
  ])),
  constraint energy_minutes_hr_source_check check (hr_source is null or hr_source = any (array[
    'measured'::text, 'carried'::text, 'absent'::text
  ]))
);

comment on table public.energy_minutes is
  'Authoritative per-minute energy expenditure. One row per minute of sensor '
  'coverage; gaps are absent rows, never zero-filled. Raw sensor data lives in B2.';
comment on column public.energy_minutes.total_kcal is
  'Generated: resting_kcal + active_kcal. Never written directly.';
comment on column public.energy_minutes.workout_session_id is
  'Set when this minute falls inside an identified workout. Workout energy is the '
  'active_kcal of these minutes, so it is a strict subset of active energy.';
comment on column public.energy_minutes.hr_source is
  'measured = HR sampled this minute; carried = last-known HR reused inside the '
  'staleness window with reduced confidence; absent = estimated without HR.';

create index if not exists energy_minutes_user_day_idx
  on public.energy_minutes (user_id, day, minute_at);
create index if not exists energy_minutes_workout_idx
  on public.energy_minutes (workout_session_id)
  where workout_session_id is not null;

-- ---------------------------------------------------------------------------
-- Daily rollup (derived from energy_minutes, never incremented)
-- ---------------------------------------------------------------------------

create table if not exists public.energy_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  timezone_name text not null default 'UTC',

  resting_kcal numeric(10,2) not null default 0,
  active_kcal numeric(10,2) not null default 0,
  workout_kcal numeric(10,2) not null default 0,
  total_kcal numeric(10,2) not null default 0,

  average_met numeric(6,3),
  peak_met numeric(6,3),
  high_activity_minutes integer not null default 0,
  moderate_activity_minutes integer not null default 0,
  sedentary_minutes integer not null default 0,
  sleep_minutes integer not null default 0,

  coverage_minutes integer not null default 0,
  expected_minutes integer not null default 1440,
  gap_minutes integer not null default 0,
  -- Resting metabolism continues while the strap is off, so projecting it across
  -- a coverage gap is defensible. Projecting *active* energy would not be, and is
  -- never done. total_kcal stays measurement-only; this column is the only place
  -- an unmeasured minute contributes anything, and it is named for it.
  resting_gap_kcal numeric(10,2) not null default 0,
  projected_total_kcal numeric(10,2) not null default 0,
  model_confidence numeric(4,3),

  model_version text references public.energy_model_versions(version),
  feature_version text,
  calibration_version integer,
  computed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (user_id, day),
  constraint energy_daily_workout_subset_check check (workout_kcal <= active_kcal + 0.5),
  constraint energy_daily_coverage_check
    check (coverage_minutes >= 0 and coverage_minutes <= 1500)
);

comment on table public.energy_daily is
  'Daily energy rollup. Always recomputed from energy_minutes by '
  'energy_rollup_day(); no incremental counters. workout_kcal <= active_kcal is '
  'enforced because workout energy is a subset of active energy.';
comment on column public.energy_daily.coverage_minutes is
  'Minutes with an energy estimate. A partial day is reported as partial rather '
  'than extrapolated to 1440.';

create index if not exists energy_daily_user_day_idx
  on public.energy_daily (user_id, day desc);

-- ---------------------------------------------------------------------------
-- Workout rollup
-- ---------------------------------------------------------------------------

create table if not exists public.energy_workouts (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  duration_s integer not null,
  activity_type text not null default 'workout_other',

  resting_kcal numeric(10,2) not null default 0,
  active_kcal numeric(10,2) not null default 0,
  total_kcal numeric(10,2) not null default 0,

  average_met numeric(6,3),
  peak_met numeric(6,3),
  average_hr numeric(5,1),
  peak_hr numeric(5,1),
  coverage_minutes integer not null default 0,
  confidence numeric(4,3),

  model_version text references public.energy_model_versions(version),
  calibration_version integer,
  computed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint energy_workouts_range_check check (end_at > start_at),
  constraint energy_workouts_duration_check check (duration_s > 0 and duration_s <= 86400)
);

comment on table public.energy_workouts is
  'Per-workout energy, keyed to the existing sessions row. active_kcal here is '
  'the same money as the workout-tagged minutes in energy_minutes.';

create index if not exists energy_workouts_user_day_idx
  on public.energy_workouts (user_id, day desc);

-- ---------------------------------------------------------------------------
-- Timestamps
-- ---------------------------------------------------------------------------

drop trigger if exists energy_minutes_touch on public.energy_minutes;
create trigger energy_minutes_touch before update on public.energy_minutes
  for each row execute function public.set_updated_at();

drop trigger if exists energy_daily_touch on public.energy_daily;
create trigger energy_daily_touch before update on public.energy_daily
  for each row execute function public.set_updated_at();

drop trigger if exists energy_workouts_touch on public.energy_workouts;
create trigger energy_workouts_touch before update on public.energy_workouts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Rollup: daily and workout aggregates recomputed from the minute table
-- ---------------------------------------------------------------------------

create or replace function public.energy_rollup_day(p_user_id uuid, p_day date)
returns public.energy_daily
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.energy_daily;
  v_has boolean;
begin
  select exists (
    select 1 from public.energy_minutes m
    where m.user_id = p_user_id and m.day = p_day
  ) into v_has;

  if not v_has then
    delete from public.energy_daily d where d.user_id = p_user_id and d.day = p_day;
    return null;
  end if;

  insert into public.energy_daily as d (
    user_id, day, timezone_name,
    resting_kcal, active_kcal, workout_kcal, total_kcal,
    average_met, peak_met,
    high_activity_minutes, moderate_activity_minutes, sedentary_minutes, sleep_minutes,
    coverage_minutes, expected_minutes, gap_minutes, resting_gap_kcal, projected_total_kcal,
    model_confidence,
    model_version, feature_version, calibration_version, computed_at
  )
  select
    p_user_id,
    p_day,
    coalesce(max(m.timezone_name), 'UTC'),
    round(sum(m.resting_kcal)::numeric, 2),
    round(sum(m.active_kcal)::numeric, 2),
    -- Subset of active, not an independent total.
    round(coalesce(sum(m.active_kcal) filter (where m.workout_session_id is not null), 0)::numeric, 2),
    round(sum(m.total_kcal)::numeric, 2),
    round(avg(m.met)::numeric, 3),
    round(max(m.met)::numeric, 3),
    count(*) filter (where m.met >= 6),
    count(*) filter (where m.met >= 3 and m.met < 6),
    count(*) filter (where m.activity_type in ('sedentary', 'standing')),
    count(*) filter (where m.activity_type = 'sleep'),
    count(*),
    1440,
    greatest(1440 - count(*), 0),
    round((avg(m.resting_kcal) * greatest(1440 - count(*), 0))::numeric, 2),
    round((sum(m.total_kcal) + avg(m.resting_kcal) * greatest(1440 - count(*), 0))::numeric, 2),
    round(avg(m.model_confidence)::numeric, 3),
    (array_agg(m.model_version order by m.minute_at desc))[1],
    (array_agg(m.feature_version order by m.minute_at desc))[1],
    (array_agg(m.calibration_version order by m.minute_at desc))[1],
    now()
  from public.energy_minutes m
  where m.user_id = p_user_id and m.day = p_day
  on conflict (user_id, day) do update set
    timezone_name = excluded.timezone_name,
    resting_kcal = excluded.resting_kcal,
    active_kcal = excluded.active_kcal,
    workout_kcal = excluded.workout_kcal,
    total_kcal = excluded.total_kcal,
    average_met = excluded.average_met,
    peak_met = excluded.peak_met,
    high_activity_minutes = excluded.high_activity_minutes,
    moderate_activity_minutes = excluded.moderate_activity_minutes,
    sedentary_minutes = excluded.sedentary_minutes,
    sleep_minutes = excluded.sleep_minutes,
    coverage_minutes = excluded.coverage_minutes,
    expected_minutes = excluded.expected_minutes,
    gap_minutes = excluded.gap_minutes,
    resting_gap_kcal = excluded.resting_gap_kcal,
    projected_total_kcal = excluded.projected_total_kcal,
    model_confidence = excluded.model_confidence,
    model_version = excluded.model_version,
    feature_version = excluded.feature_version,
    calibration_version = excluded.calibration_version,
    computed_at = excluded.computed_at,
    updated_at = now()
  returning d.* into v_row;

  -- Mirror the headline numbers into daily_metrics so the existing dashboard
  -- view, get_day_snapshot, and the client's 'Energy burned (cal)' field all
  -- resolve without a second read path. daily_metrics.active_kcal keeps its
  -- existing meaning (active only); basal_kcal carries resting.
  update public.daily_metrics dm
     set active_kcal = v_row.active_kcal,
         basal_kcal = v_row.resting_kcal,
         updated_at = now()
   where dm.user_id = p_user_id and dm.day = p_day;

  return v_row;
end;
$$;

comment on function public.energy_rollup_day(uuid, date) is
  'Recomputes energy_daily for one user-day from energy_minutes and mirrors the '
  'headline kcal into daily_metrics. Idempotent: safe to call repeatedly and after '
  'late-arriving sensor data.';

create or replace function public.energy_rollup_workout(p_session_id uuid)
returns public.energy_workouts
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_session public.sessions;
  v_row public.energy_workouts;
  v_has boolean;
begin
  select * into v_session from public.sessions s where s.id = p_session_id;
  if v_session.id is null then
    return null;
  end if;

  select exists (
    select 1 from public.energy_minutes m where m.workout_session_id = p_session_id
  ) into v_has;

  if not v_has then
    delete from public.energy_workouts w where w.session_id = p_session_id;
    return null;
  end if;

  insert into public.energy_workouts as w (
    session_id, user_id, day, start_at, end_at, duration_s, activity_type,
    resting_kcal, active_kcal, total_kcal,
    average_met, peak_met, average_hr, peak_hr,
    coverage_minutes, confidence,
    model_version, calibration_version, computed_at
  )
  select
    p_session_id,
    v_session.user_id,
    coalesce(min(m.day), public.local_calendar_date(v_session.start_at, coalesce(max(m.timezone_name), 'UTC'))),
    v_session.start_at,
    v_session.end_at,
    greatest(1, extract(epoch from (v_session.end_at - v_session.start_at))::integer),
    coalesce(
      (select m2.activity_type
         from public.energy_minutes m2
        where m2.workout_session_id = p_session_id
          and m2.activity_type not in ('unknown', 'sedentary', 'sleep')
        group by m2.activity_type
        order by count(*) desc, m2.activity_type
        limit 1),
      'workout_other'
    ),
    round(sum(m.resting_kcal)::numeric, 2),
    round(sum(m.active_kcal)::numeric, 2),
    round(sum(m.total_kcal)::numeric, 2),
    round(avg(m.met)::numeric, 3),
    round(max(m.met)::numeric, 3),
    round(avg(m.hr)::numeric, 1),
    round(max(m.hr)::numeric, 1),
    count(*),
    round(avg(m.model_confidence)::numeric, 3),
    (array_agg(m.model_version order by m.minute_at desc))[1],
    (array_agg(m.calibration_version order by m.minute_at desc))[1],
    now()
  from public.energy_minutes m
  where m.workout_session_id = p_session_id
  on conflict (session_id) do update set
    user_id = excluded.user_id,
    day = excluded.day,
    start_at = excluded.start_at,
    end_at = excluded.end_at,
    duration_s = excluded.duration_s,
    activity_type = excluded.activity_type,
    resting_kcal = excluded.resting_kcal,
    active_kcal = excluded.active_kcal,
    total_kcal = excluded.total_kcal,
    average_met = excluded.average_met,
    peak_met = excluded.peak_met,
    average_hr = excluded.average_hr,
    peak_hr = excluded.peak_hr,
    coverage_minutes = excluded.coverage_minutes,
    confidence = excluded.confidence,
    model_version = excluded.model_version,
    calibration_version = excluded.calibration_version,
    computed_at = excluded.computed_at,
    updated_at = now()
  returning w.* into v_row;

  return v_row;
end;
$$;

comment on function public.energy_rollup_workout(uuid) is
  'Recomputes energy_workouts for one session from its tagged energy_minutes. '
  'Handles corrected workout boundaries because the minute tags are rewritten first.';

-- ---------------------------------------------------------------------------
-- Read surface for the client (SECURITY INVOKER, RLS applies)
-- ---------------------------------------------------------------------------

create or replace function public.get_energy_day(p_day date)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'day', p_day,
    'daily', (
      select to_jsonb(d) from public.energy_daily d
       where d.user_id = auth.uid() and d.day = p_day
    ),
    'workouts', coalesce((
      select jsonb_agg(to_jsonb(w) order by w.start_at)
        from public.energy_workouts w
       where w.user_id = auth.uid() and w.day = p_day
    ), '[]'::jsonb),
    -- 15-minute buckets: a full 1440-row minute series is never worth shipping
    -- to a phone for a chart that is a few hundred pixels wide.
    'buckets', coalesce((
      select jsonb_agg(b order by b.t)
        from (
          select
            to_char(date_trunc('hour', m.minute_at)
                    + floor(extract(minute from m.minute_at) / 15) * interval '15 min',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"') as t,
            round(sum(m.total_kcal)::numeric, 2) as total_kcal,
            round(sum(m.active_kcal)::numeric, 2) as active_kcal,
            round(avg(m.met)::numeric, 2) as met,
            round(avg(m.model_confidence)::numeric, 2) as confidence,
            count(*) as n
          from public.energy_minutes m
          where m.user_id = auth.uid() and m.day = p_day
          group by 1
        ) b
    ), '[]'::jsonb)
  );
$$;

create or replace function public.get_energy_range(p_from date, p_to date)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'days', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.day)
        from public.energy_daily d
       where d.user_id = auth.uid()
         and d.day >= p_from
         and d.day <= least(p_to, p_from + 366)
    ), '[]'::jsonb)
  );
$$;

create or replace function public.get_energy_workout(p_session_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'workout', (
      select to_jsonb(w) from public.energy_workouts w
       where w.session_id = p_session_id and w.user_id = auth.uid()
    ),
    'minutes', coalesce((
      select jsonb_agg(jsonb_build_object(
               't', to_char(m.minute_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'met', m.met,
               'active_kcal', m.active_kcal,
               'total_kcal', m.total_kcal,
               'hr', m.hr,
               'confidence', m.model_confidence
             ) order by m.minute_at)
        from public.energy_minutes m
       where m.workout_session_id = p_session_id and m.user_id = auth.uid()
    ), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- Secret-gated ingestion RPC (parity with engine_ingest_*)
-- ---------------------------------------------------------------------------

create or replace function public.engine_ingest_energy(p_secret text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, internal
as $$
declare
  v_minutes integer := 0;
  v_days text[] := '{}';
  v_workouts uuid[] := '{}';
  v_user uuid;
  v_day date;
  v_session uuid;
begin
  perform internal.assert_ingest_secret(p_secret);

  insert into public.energy_minutes (
    user_id, minute_at, day, timezone_name, met, resting_kcal, active_kcal,
    activity_type, activity_confidence, model_confidence, hr, hr_source,
    motion_intensity, signal_quality, quality_flags, workout_session_id, estimator,
    model_version, feature_version, calibration_version
  )
  select
    (r->>'user_id')::uuid,
    (r->>'minute_at')::timestamptz,
    (r->>'day')::date,
    coalesce(r->>'timezone_name', 'UTC'),
    nullif(r->>'met', '')::numeric,
    coalesce(nullif(r->>'resting_kcal', '')::numeric, 0),
    coalesce(nullif(r->>'active_kcal', '')::numeric, 0),
    coalesce(nullif(r->>'activity_type', ''), 'unknown'),
    nullif(r->>'activity_confidence', '')::numeric,
    nullif(r->>'model_confidence', '')::numeric,
    nullif(r->>'hr', '')::numeric,
    nullif(r->>'hr_source', ''),
    nullif(r->>'motion_intensity', '')::numeric,
    nullif(r->>'signal_quality', '')::numeric,
    coalesce(
      (select array_agg(f#>>'{}') from jsonb_array_elements(
         case when jsonb_typeof(r->'quality_flags') = 'array' then r->'quality_flags' else '[]'::jsonb end
       ) f),
      '{}'::text[]
    ),
    -- Resolved through sessions rather than trusted: this both drops a tag whose
    -- session does not exist (manually created activities never get a sessions
    -- row, and a raw insert would fail the whole batch on the foreign key) and
    -- prevents a caller from attributing its minutes to another user's session.
    (select s.id from public.sessions s
      where s.id = nullif(r->>'workout_session_id', '')::uuid
        and s.user_id = (r->>'user_id')::uuid),
    nullif(r->>'estimator', ''),
    nullif(r->>'model_version', ''),
    nullif(r->>'feature_version', ''),
    nullif(r->>'calibration_version', '')::integer
  from jsonb_array_elements(coalesce(p_payload->'energy_minutes', '[]'::jsonb)) r
  on conflict (user_id, minute_at) do update set
    day = excluded.day,
    timezone_name = excluded.timezone_name,
    met = excluded.met,
    resting_kcal = excluded.resting_kcal,
    active_kcal = excluded.active_kcal,
    activity_type = excluded.activity_type,
    activity_confidence = excluded.activity_confidence,
    model_confidence = excluded.model_confidence,
    hr = excluded.hr,
    hr_source = excluded.hr_source,
    motion_intensity = excluded.motion_intensity,
    signal_quality = excluded.signal_quality,
    quality_flags = excluded.quality_flags,
    workout_session_id = excluded.workout_session_id,
    estimator = excluded.estimator,
    model_version = excluded.model_version,
    feature_version = excluded.feature_version,
    calibration_version = excluded.calibration_version,
    updated_at = now();

  select count(*) into v_minutes
    from jsonb_array_elements(coalesce(p_payload->'energy_minutes', '[]'::jsonb));

  insert into public.energy_user_calibration (
    user_id, version, status, global_model_version, params,
    calibration_confidence, training_days, notes, activated_at
  )
  select
    (r->>'user_id')::uuid,
    (r->>'version')::integer,
    coalesce(nullif(r->>'status', ''), 'shadow'),
    nullif(r->>'global_model_version', ''),
    coalesce(r->'params', '{}'::jsonb),
    coalesce(nullif(r->>'calibration_confidence', '')::numeric, 0),
    coalesce(nullif(r->>'training_days', '')::integer, 0),
    nullif(r->>'notes', ''),
    nullif(r->>'activated_at', '')::timestamptz
  from jsonb_array_elements(coalesce(p_payload->'energy_user_calibration', '[]'::jsonb)) r
  on conflict (user_id, version) do update set
    status = excluded.status,
    global_model_version = excluded.global_model_version,
    params = excluded.params,
    calibration_confidence = excluded.calibration_confidence,
    training_days = excluded.training_days,
    notes = excluded.notes,
    activated_at = excluded.activated_at;

  -- Roll up only what this batch touched. Aggregates are derived, so calling
  -- them here keeps daily/workout consistent with minutes in one transaction.
  for v_user, v_day in
    select distinct (r->>'user_id')::uuid, (r->>'day')::date
      from jsonb_array_elements(coalesce(p_payload->'energy_minutes', '[]'::jsonb)) r
  loop
    perform public.energy_rollup_day(v_user, v_day);
    v_days := v_days || (v_day::text);
  end loop;

  for v_session in
    select distinct (r->>'workout_session_id')::uuid
      from jsonb_array_elements(coalesce(p_payload->'energy_minutes', '[]'::jsonb)) r
     where nullif(r->>'workout_session_id', '') is not null
  loop
    perform public.energy_rollup_workout(v_session);
    v_workouts := v_workouts || v_session;
  end loop;

  return jsonb_build_object(
    'minutes', v_minutes,
    'days', to_jsonb(v_days),
    'workouts', to_jsonb(v_workouts)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS: users read their own energy; only the backend writes it
-- ---------------------------------------------------------------------------

alter table public.energy_minutes enable row level security;
alter table public.energy_daily enable row level security;
alter table public.energy_workouts enable row level security;
alter table public.energy_user_calibration enable row level security;
alter table public.energy_model_versions enable row level security;

drop policy if exists energy_minutes_select_own on public.energy_minutes;
create policy energy_minutes_select_own on public.energy_minutes
  for select to authenticated using (user_id = auth.uid());

drop policy if exists energy_daily_select_own on public.energy_daily;
create policy energy_daily_select_own on public.energy_daily
  for select to authenticated using (user_id = auth.uid());

drop policy if exists energy_workouts_select_own on public.energy_workouts;
create policy energy_workouts_select_own on public.energy_workouts
  for select to authenticated using (user_id = auth.uid());

drop policy if exists energy_calibration_select_own on public.energy_user_calibration;
create policy energy_calibration_select_own on public.energy_user_calibration
  for select to authenticated using (user_id = auth.uid());

-- Model registry is not user data; it is readable so the client can label a
-- version, and it contains no secrets.
drop policy if exists energy_model_versions_select on public.energy_model_versions;
create policy energy_model_versions_select on public.energy_model_versions
  for select to authenticated using (true);

revoke all on public.energy_minutes from anon, authenticated;
revoke all on public.energy_daily from anon, authenticated;
revoke all on public.energy_workouts from anon, authenticated;
revoke all on public.energy_user_calibration from anon, authenticated;
revoke all on public.energy_model_versions from anon, authenticated;

grant select on public.energy_minutes to authenticated;
grant select on public.energy_daily to authenticated;
grant select on public.energy_workouts to authenticated;
grant select on public.energy_user_calibration to authenticated;
grant select on public.energy_model_versions to authenticated;

grant all on public.energy_minutes to service_role;
grant all on public.energy_daily to service_role;
grant all on public.energy_workouts to service_role;
grant all on public.energy_user_calibration to service_role;
grant all on public.energy_model_versions to service_role;

-- Read RPCs are user-facing; write/rollup RPCs are backend-only.
revoke all on function public.get_energy_day(date) from public, anon;
revoke all on function public.get_energy_range(date, date) from public, anon;
revoke all on function public.get_energy_workout(uuid) from public, anon;
grant execute on function public.get_energy_day(date) to authenticated;
grant execute on function public.get_energy_range(date, date) to authenticated;
grant execute on function public.get_energy_workout(uuid) to authenticated;

revoke all on function public.energy_rollup_day(uuid, date) from public, anon, authenticated;
revoke all on function public.energy_rollup_workout(uuid) from public, anon, authenticated;
revoke all on function public.engine_ingest_energy(text, jsonb) from public, anon, authenticated;
grant execute on function public.energy_rollup_day(uuid, date) to service_role;
grant execute on function public.energy_rollup_workout(uuid) to service_role;
grant execute on function public.engine_ingest_energy(text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Seed the shipped model + the evaluation baselines
-- ---------------------------------------------------------------------------

insert into public.energy_model_versions
  (version, kind, algorithm_version, feature_version, description, is_active, config)
values
  ('energy-v1.0.0', 'global', '1.0.0', 'feat-1.0.0',
   'Activity-gated HR-reserve energy model. RMR-anchored METs, %HRR->%VO2R '
   'mapping, motion-gated fallback, confidence-weighted fusion.', true,
   '{"estimators":["sleep","sedentary","walking","running","cycling","strength","daily_activity"]}'::jsonb),
  ('baseline-bmr-multiplier-v1', 'baseline', '1.0.0', 'feat-1.0.0',
   'Baseline 1: Mifflin-St Jeor RMR x activity multiplier.', false, '{}'::jsonb),
  ('baseline-keytel-v1', 'baseline', '1.0.0', 'feat-1.0.0',
   'Baseline 2: Keytel et al. 2005 HR-based kcal equation.', false, '{}'::jsonb),
  ('baseline-fixed-met-v1', 'baseline', '1.0.0', 'feat-1.0.0',
   'Baseline 3: whoordan-class fixed-MET-by-sport at population body mass, '
   'matching the legacy in-repo estimateCalories().', false, '{}'::jsonb)
on conflict (version) do update set
  description = excluded.description,
  algorithm_version = excluded.algorithm_version,
  feature_version = excluded.feature_version,
  config = excluded.config;

commit;
