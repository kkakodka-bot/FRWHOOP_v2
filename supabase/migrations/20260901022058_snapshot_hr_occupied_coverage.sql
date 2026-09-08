-- Live get_day_snapshot. Edit this file, not older copies.
-- Hosted applied the helper first (20260901022006), then this RPC.

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
            select public.hr_series_occupied_buckets(s.hr_series)
            from public.daily_physiology_series s
            where s.user_id = uid and s.day = p_day
          ), 0) > 0 then 'available' else 'unavailable' end,
        'buckets', coalesce((
          select public.hr_series_occupied_buckets(s.hr_series)
          from public.daily_physiology_series s
          where s.user_id = uid and s.day = p_day
        ), 0),
        'expected_buckets', 288,
        'coverage_pct', round((
          100.0 * coalesce((
            select public.hr_series_occupied_buckets(s.hr_series)
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

grant execute on function public.get_day_snapshot(date) to authenticated, service_role;
revoke all on function public.get_day_snapshot(date) from public, anon;
