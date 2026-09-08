-- Startup read optimization: make the day RPCs history-independent.
--
-- Baseline evidence (_perf/evidence/EVIDENCE_LOG.md): public.get_day_snapshot
-- served an unindexable wake-day predicate
--   local_calendar_date(coalesce(d.original_end_at, d.original_start_at), tz) = p_day
-- which scans every sleep_details row for the user on every call, so per-call
-- cost grows with history (measured 2.8ms at 7 nights -> 8.1ms at 3000 nights on
-- the perf stack, and it is the hottest read path in the app).
--
-- The functional predicate is EXACTLY equivalent to a timestamptz range
-- predicate over the same day_bounds(p_day, tz) window (verified on all seeded
-- nights: 0 mismatches both directions), so it can be rewritten as an
-- index-backed range scan on sleep_details_user_idx (user_id, original_end_at).
-- Rows with a NULL original_end_at fall back to original_start_at via OR.
--
-- Read-only, no grants changed, no RLS changes.

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
        -- Wake-day membership as an index-backed range predicate: the night is
        -- assigned to the local calendar date of its wake moment, so the wake
        -- instant must lie inside the IANA day window. Bounded scan; cost no
        -- longer depends on how many nights the user has.
        and (
          (d.original_end_at is not null
            and d.original_end_at >= bounds.day_start_at
            and d.original_end_at < bounds.day_end_at)
          or (d.original_end_at is null
            and d.original_start_at >= bounds.day_start_at
            and d.original_start_at < bounds.day_end_at)
        )
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

-- engine_load_user_days: replace unindexable ::date casts with range
-- predicates (semantics preserved: UTC-date filtering as before).
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
    'daily_metrics', coalesce((select jsonb_agg(to_jsonb(m) order by m.day)
      from public.daily_metrics m
      where m.user_id = p_user_id and (p_from is null or m.day >= p_from) and (p_to is null or m.day <= p_to)), '[]'::jsonb),
    'sleep_nights', coalesce((select jsonb_agg(to_jsonb(n) order by n.start_at)
      from public.sleep_nights n
      where n.user_id = p_user_id and (p_from is null or n.period_day >= p_from) and (p_to is null or n.period_day <= p_to)), '[]'::jsonb),
    'sessions', coalesce((select jsonb_agg(to_jsonb(s) order by s.start_at)
      from public.sessions s
      where s.user_id = p_user_id
        and (p_from is null or s.start_at >= p_from::timestamptz)
        and (p_to is null or s.start_at < (p_to + 1)::timestamptz)), '[]'::jsonb)
  );
end;
$$;

-- Sleep-night lookup by period (engine_load_user_days range scans).
create index if not exists sleep_nights_user_period_idx
  on public.sleep_nights (user_id, period_day);

-- Sync-correctness: daily_physiology_series is the chart projection and has
-- no revision bump trigger, so a chart-only update (live HR catch-up) would
-- never move user_sync_state.revision and a revision-gated client would never
-- refetch it. The trigger fires per flushed series upsert (bounded: at most a
-- few per minute per wearing user), not per sample.
drop trigger if exists daily_physiology_series_revision on public.daily_physiology_series;
create trigger daily_physiology_series_revision
  after insert or update on public.daily_physiology_series
  for each row execute function public.bump_user_revision();
