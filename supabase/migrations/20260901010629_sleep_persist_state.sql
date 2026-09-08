-- Sleep persist states on snapshot availability: complete, provisional, nap, unavailable.

create or replace function public.sleep_day_availability(
  p_user uuid,
  p_start timestamptz,
  p_end timestamptz
) returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with rows as (
    select
      coalesce(s.summary->>'persist_state', case when d.is_nap then 'nap' else 'complete' end) as persist_state,
      'sleep_details'::text as src
    from public.sleep_details d
    left join public.sessions s on s.id = d.session_id
    where d.user_id = p_user
      and p_start is not null
      and p_end is not null
      and (
        (d.original_end_at is not null
          and d.original_end_at >= p_start
          and d.original_end_at < p_end)
        or (d.original_end_at is null
          and d.original_start_at >= p_start
          and d.original_start_at < p_end)
      )
    union all
    select
      coalesce(
        s.summary->>'persist_state',
        case when s.kind = 'nap' or coalesce((s.summary->>'is_nap')::boolean, false) then 'nap' else 'complete' end
      ) as persist_state,
      'sessions'::text as src
    from public.sessions s
    where s.user_id = p_user
      and s.kind in ('sleep', 'nap')
      and not exists (select 1 from public.sleep_details d where d.session_id = s.id)
      and p_start is not null
      and p_end is not null
      and (
        (s.end_at is not null and s.end_at >= p_start and s.end_at < p_end)
        or (s.end_at is null and s.start_at >= p_start and s.start_at < p_end)
      )
  )
  select case
    when not exists (select 1 from rows) then
      jsonb_build_object('status', 'unavailable', 'kind', 'unavailable', 'source', null)
    when exists (select 1 from rows where persist_state = 'complete') then
      jsonb_build_object(
        'status', 'available',
        'kind', 'complete',
        'source', (select src from rows where persist_state = 'complete' order by src = 'sleep_details' desc limit 1)
      )
    when exists (select 1 from rows where persist_state = 'provisional') then
      jsonb_build_object(
        'status', 'provisional',
        'kind', 'provisional',
        'source', (select src from rows where persist_state = 'provisional' limit 1)
      )
    else
      jsonb_build_object(
        'status', 'available',
        'kind', 'nap',
        'source', (select src from rows limit 1)
      )
  end;
$$;

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
        'strain_score_v2', m.strain_score_v2,
        'strain_v2', m.strain_v2,
        'sleep_performance_pct', coalesce(m.sleep_performance_pct, m.rest),
        'hrv_rmssd_ms', m.hrv_rmssd_ms,
        'resting_hr_bpm', m.resting_hr_bpm,
        'avg_hr_bpm', m.avg_hr_bpm,
        'max_hr_bpm', m.max_hr_bpm,
        'resp_rate_bpm', m.resp_rate_bpm,
        'spo2_pct', m.spo2_pct,
        'steps', m.steps,
        'watch_steps', (
          select sum(b.step_count)
          from public.apple_watch_step_buckets b
          where b.user_id = uid
            and b.bucket_size_seconds = 60
            and b.bucket_start >= bounds.day_start_at
            and b.bucket_start < bounds.day_end_at
        ),
        'active_kcal', coalesce(e.active_kcal, m.active_kcal),
        'basal_kcal', coalesce(e.resting_kcal, m.basal_kcal),
        'energy_kcal', coalesce(
          e.total_kcal,
          case
            when coalesce(e.active_kcal, m.active_kcal) is not null
              or coalesce(e.resting_kcal, m.basal_kcal) is not null
            then coalesce(e.active_kcal, m.active_kcal, 0)
               + coalesce(e.resting_kcal, m.basal_kcal, 0)
          end
        ),
        'sleep_total_min', coalesce(m.sleep_total_min, (
          select max(coalesce(
            nullif(s.summary->>'asleep_min', '')::numeric,
            extract(epoch from (s.end_at - s.start_at)) / 60.0
          ))
          from public.sessions s
          where s.user_id = uid
            and s.kind in ('sleep', 'nap')
            and s.end_at is not null
            and s.end_at >= bounds.day_start_at
            and s.end_at < bounds.day_end_at
        )),
        'sleep_in_bed_min', m.sleep_in_bed_min,
        'sleep_need_min', m.sleep_need_min,
        'sleep_efficiency', m.sleep_efficiency,
        'sleep_onset_at', m.sleep_onset_at,
        'wake_onset_at', m.wake_onset_at,
        'timezone_name', coalesce(m.timezone_name, bounds.timezone_name),
        'day_start_at', coalesce(m.day_start_at, bounds.day_start_at),
        'day_end_at', coalesce(m.day_end_at, bounds.day_end_at),
        'algorithm_version', m.algorithm_version,
        'computed_at', m.computed_at,
        'confidence', m.confidence
      )
      from public.daily_metrics m
      left join public.energy_daily e
        on e.user_id = m.user_id and e.day = m.day
      where m.user_id = uid and m.day = p_day and m.record_class = 'user'
    ),
    'sleep', coalesce((
      select jsonb_agg(item order by item->>'original_start_at')
      from (
        select jsonb_build_object(
          'session_id', d.session_id,
          'is_nap', d.is_nap,
          'persist_state', coalesce(sess.summary->>'persist_state', case when d.is_nap then 'nap' else 'complete' end),
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
        ) as item
        from public.sleep_details d
        left join public.sessions sess on sess.id = d.session_id
        where d.user_id = uid
          and (
            (d.original_end_at is not null
              and d.original_end_at >= bounds.day_start_at
              and d.original_end_at < bounds.day_end_at)
            or (d.original_end_at is null
              and d.original_start_at >= bounds.day_start_at
              and d.original_start_at < bounds.day_end_at)
          )
        union all
        select jsonb_build_object(
          'session_id', s.id,
          'is_nap', coalesce((s.summary->>'is_nap')::boolean, s.kind = 'nap'),
          'persist_state', coalesce(
            s.summary->>'persist_state',
            case when s.kind = 'nap' or coalesce((s.summary->>'is_nap')::boolean, false) then 'nap' else 'complete' end
          ),
          'performance_pct', nullif(s.summary->>'performance', '')::numeric,
          'efficiency', nullif(s.summary->>'efficiency', '')::numeric,
          'asleep_min', coalesce(
            nullif(s.summary->>'asleep_min', '')::numeric,
            extract(epoch from (s.end_at - s.start_at)) / 60.0
          ),
          'in_bed_min', coalesce(
            nullif(s.summary->>'in_bed_min', '')::numeric,
            extract(epoch from (s.end_at - s.start_at)) / 60.0
          ),
          'light_min', nullif(s.summary->>'light_min', '')::numeric,
          'deep_min', nullif(s.summary->>'deep_min', '')::numeric,
          'rem_min', nullif(s.summary->>'rem_min', '')::numeric,
          'awake_min', nullif(s.summary->>'awake_min', '')::numeric,
          'need_min', nullif(s.summary->>'need_min', '')::numeric,
          'hypnogram', s.segments,
          'original_start_at', s.start_at,
          'original_end_at', s.end_at
        ) as item
        from public.sessions s
        where s.user_id = uid
          and s.kind in ('sleep', 'nap')
          and not exists (
            select 1 from public.sleep_details d
            where d.session_id = s.id
          )
          and (
            (s.end_at is not null
              and s.end_at >= bounds.day_start_at
              and s.end_at < bounds.day_end_at)
            or (s.end_at is null
              and s.start_at >= bounds.day_start_at
              and s.start_at < bounds.day_end_at)
          )
      ) sleep_rows
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
    'strain_series', coalesce((
      select s.strain_series
      from public.daily_physiology_series s
      where s.user_id = uid and s.day = p_day
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
    ), '[]'::jsonb),
    'availability', jsonb_build_object(
      'hr', jsonb_build_object(
        'status', case
          when coalesce((
            select jsonb_array_length(s.hr_series)
            from public.daily_physiology_series s
            where s.user_id = uid and s.day = p_day
          ), 0) > 0 then 'available' else 'unavailable' end,
        'buckets', coalesce((
          select jsonb_array_length(s.hr_series)
          from public.daily_physiology_series s
          where s.user_id = uid and s.day = p_day
        ), 0),
        'expected_buckets', 288,
        'coverage_pct', round((
          100.0 * coalesce((
            select jsonb_array_length(s.hr_series)
            from public.daily_physiology_series s
            where s.user_id = uid and s.day = p_day
          ), 0) / 288.0
        )::numeric, 1)
      ),
      'steps', jsonb_build_object(
        'status', case
          when (
            select m.steps from public.daily_metrics m
            where m.user_id = uid and m.day = p_day and m.record_class = 'user'
          ) is not null then 'available' else 'unavailable' end,
        'value', (
          select m.steps from public.daily_metrics m
          where m.user_id = uid and m.day = p_day and m.record_class = 'user'
        ),
        'source', case
          when (
            select m.steps from public.daily_metrics m
            where m.user_id = uid and m.day = p_day and m.record_class = 'user'
          ) is not null then 'strap' else null end,
        'watch_steps', (
          select sum(b.step_count)
          from public.apple_watch_step_buckets b
          where b.user_id = uid
            and b.bucket_size_seconds = 60
            and b.bucket_start >= bounds.day_start_at
            and b.bucket_start < bounds.day_end_at
        )
      ),
      'sleep', public.sleep_day_availability(uid, bounds.day_start_at, bounds.day_end_at),
      'rhr', jsonb_build_object(
        'status', case
          when exists (
            select 1 from public.daily_metrics m
            where m.user_id = uid and m.day = p_day and m.record_class = 'user' and m.resting_hr_bpm is not null
          ) then 'available' else 'unavailable' end
      ),
      'hrv', jsonb_build_object(
        'status', case
          when exists (
            select 1 from public.daily_metrics m
            where m.user_id = uid and m.day = p_day and m.record_class = 'user' and m.hrv_rmssd_ms is not null
          ) then 'available' else 'unavailable' end
      ),
      'energy', jsonb_build_object(
        'status', case
          when exists (
            select 1 from public.energy_daily e
            where e.user_id = uid and e.day = p_day and e.total_kcal is not null
          ) or exists (
            select 1 from public.daily_metrics m
            where m.user_id = uid and m.day = p_day and m.record_class = 'user'
              and (m.active_kcal is not null or m.basal_kcal is not null)
          ) then 'available' else 'unavailable' end
      ),
      'strain', jsonb_build_object(
        'status', case
          when exists (
            select 1 from public.daily_metrics m
            where m.user_id = uid and m.day = p_day and m.record_class = 'user'
              and coalesce(m.strain_score, m.effort) is not null
          ) then 'available' else 'unavailable' end
      )
    )
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
    'sleep_total_min', coalesce(d.sleep_total_min, sess.sleep_total_min),
    'sleep_need_min', d.sleep_need_min,
    'steps', d.steps,
    'watch_steps', watch.steps,
    'active_kcal', coalesce(e.active_kcal, d.active_kcal),
    'basal_kcal', coalesce(e.resting_kcal, d.basal_kcal),
    'energy_kcal', coalesce(
      e.total_kcal,
      case
        when coalesce(e.active_kcal, d.active_kcal) is not null
          or coalesce(e.resting_kcal, d.basal_kcal) is not null
        then coalesce(e.active_kcal, d.active_kcal, 0)
           + coalesce(e.resting_kcal, d.basal_kcal, 0)
      end
    ),
    'availability', jsonb_build_object(
      'hr', jsonb_build_object('status', 'unavailable', 'reason', 'range_omit_series'),
      'steps', jsonb_build_object(
        'status', case when d.steps is not null then 'available' else 'unavailable' end,
        'value', d.steps,
        'source', case when d.steps is not null then 'strap' else null end,
        'watch_steps', watch.steps
      ),
      'sleep', public.sleep_day_availability(d.user_id, d.day_start_at, d.day_end_at),
      'rhr', jsonb_build_object(
        'status', case when d.resting_hr_bpm is not null then 'available' else 'unavailable' end,
        'value', d.resting_hr_bpm
      ),
      'hrv', jsonb_build_object(
        'status', case when d.hrv_rmssd_ms is not null then 'available' else 'unavailable' end,
        'value', d.hrv_rmssd_ms
      ),
      'energy', jsonb_build_object(
        'status', case
          when coalesce(e.total_kcal, e.active_kcal, e.resting_kcal, d.active_kcal, d.basal_kcal) is not null
          then 'available' else 'unavailable' end,
        'energy_kcal', coalesce(
          e.total_kcal,
          case
            when coalesce(e.active_kcal, d.active_kcal) is not null
              or coalesce(e.resting_kcal, d.basal_kcal) is not null
            then coalesce(e.active_kcal, d.active_kcal, 0)
               + coalesce(e.resting_kcal, d.basal_kcal, 0)
          end
        ),
        'active_kcal', coalesce(e.active_kcal, d.active_kcal),
        'basal_kcal', coalesce(e.resting_kcal, d.basal_kcal)
      ),
      'strain', jsonb_build_object(
        'status', case
          when coalesce(d.strain_score, d.effort) is not null then 'available' else 'unavailable' end,
        'value', coalesce(d.strain_score, d.effort)
      )
    ),
    'computed_at', d.computed_at,
    'timezone_name', d.timezone_name,
    'day_start_at', d.day_start_at,
    'day_end_at', d.day_end_at
  ) order by d.day desc), '[]'::jsonb)
  from public.daily_metrics d
  left join public.energy_daily e
    on e.user_id = d.user_id and e.day = d.day
  left join lateral (
    select sum(b.step_count) as steps
    from public.apple_watch_step_buckets b
    where b.user_id = d.user_id
      and b.bucket_size_seconds = 60
      and d.day_start_at is not null
      and b.bucket_start >= d.day_start_at
      and b.bucket_start < d.day_end_at
  ) watch on true
  left join lateral (
    select max(coalesce(
      nullif(s.summary->>'asleep_min', '')::numeric,
      extract(epoch from (s.end_at - s.start_at)) / 60.0
    )) as sleep_total_min
    from public.sessions s
    where s.user_id = d.user_id
      and s.kind in ('sleep', 'nap')
      and s.end_at is not null
      and d.day_start_at is not null
      and s.end_at >= d.day_start_at
      and s.end_at < d.day_end_at
  ) sess on true
  where d.user_id = (select auth.uid())
    and d.record_class = 'user'
    and d.day >= p_from
    and d.day <= p_to;
$$;

grant execute on function public.sleep_day_availability(uuid, timestamptz, timestamptz) to authenticated;
revoke all on function public.sleep_day_availability(uuid, timestamptz, timestamptz) from public, anon;

