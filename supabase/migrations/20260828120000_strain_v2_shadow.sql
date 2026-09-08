-- FRWHOOP Strain V2 (shadow mode) — schema additions
--
-- Strain V2 (see backend/metrics/strainV2/) computes a scientifically layered
-- daily load in parallel with V1. V1 columns/keys are untouched: strain_score,
-- effort, and every existing reader keep their semantics. V2 adds:
--   daily_metrics.strain_score_v2  numeric  -- V2 display score (0-21), NULL when insufficient
--   daily_metrics.strain_v2        jsonb    -- V2 payload: raw AU, sufficiency/provenance envelope
--   daily_physiology_series.strain_series -- REAL per-increment series from the
--     canonical 60 s epoch layer (column pre-existed, was never populated; the
--     5-minute bucket grid matches the existing hr_series projection).
-- No data => NULL + INSUFFICIENT state in strain_v2.quality_state. Never 0.

alter table public.daily_metrics
  add column if not exists strain_score_v2 numeric;

alter table public.daily_metrics
  add column if not exists strain_v2 jsonb;

alter table public.daily_metrics drop constraint if exists daily_metrics_strain_score_v2_check;
alter table public.daily_metrics
  add constraint daily_metrics_strain_score_v2_check
  check (strain_score_v2 is null or (strain_score_v2 >= 0 and strain_score_v2 <= 21));

alter table public.daily_physiology_series drop constraint if exists daily_physiology_series_strain_size_check;
alter table public.daily_physiology_series
  add constraint daily_physiology_series_strain_size_check
  check (pg_column_size(strain_series) <= 262144);

-- Ingest RPC: carry the V2 columns through the same atomic upsert.

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
      user_id, day, source_device_id, charge, effort, rest, readiness_level,
      hrv_rmssd_ms, hrv_sdnn_ms, resting_hr_bpm, avg_hr_bpm, max_hr_bpm,
      resp_rate_bpm, skin_temp_c, skin_temp_dev_c, spo2_pct,
      steps, active_kcal, basal_kcal, vo2max, weight_kg, body_fat_pct, lean_mass_kg,
      sleep_total_min, sleep_in_bed_min, sleep_awake_min, sleep_light_min, sleep_deep_min, sleep_rem_min,
      sleep_efficiency, sleep_need_min, sleep_debt_balance_min, sleep_consistency,
      sleep_onset_at, wake_onset_at, overnight_hr_bpm, disturbances,
      exercise_count, stress_day_mean, high_stress_minutes,
      chart_data, extras, confidence, provenance, algorithm_version, computed_at,
      strain_score_v2, strain_v2
    ) values (
      v_user,
      (r->>'day')::date,
      nullif(r->>'source_device_id', '')::uuid,
      nullif(r->>'charge', '')::numeric,
      nullif(r->>'effort', '')::numeric,
      nullif(r->>'rest', '')::numeric,
      nullif(r->>'readiness_level', ''),
      nullif(r->>'hrv_rmssd_ms', '')::numeric,
      nullif(r->>'hrv_sdnn_ms', '')::numeric,
      nullif(r->>'resting_hr_bpm', '')::numeric,
      nullif(r->>'avg_hr_bpm', '')::numeric,
      nullif(r->>'max_hr_bpm', '')::numeric,
      nullif(r->>'resp_rate_bpm', '')::numeric,
      nullif(r->>'skin_temp_c', '')::numeric,
      nullif(r->>'skin_temp_dev_c', '')::numeric,
      nullif(r->>'spo2_pct', '')::numeric,
      nullif(r->>'steps', '')::bigint,
      nullif(r->>'active_kcal', '')::numeric,
      nullif(r->>'basal_kcal', '')::numeric,
      nullif(r->>'vo2max', '')::numeric,
      nullif(r->>'weight_kg', '')::numeric,
      nullif(r->>'body_fat_pct', '')::numeric,
      nullif(r->>'lean_mass_kg', '')::numeric,
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
      nullif(r->>'exercise_count', '')::integer,
      nullif(r->>'stress_day_mean', '')::numeric,
      nullif(r->>'high_stress_minutes', '')::integer,
      coalesce(r->'chart_data', '{}'::jsonb),
      coalesce(r->'extras', '{}'::jsonb),
      coalesce(r->'confidence', '{}'::jsonb),
      coalesce(r->'provenance', '{}'::jsonb),
      r->>'algorithm_version',
      coalesce(nullif(r->>'computed_at', '')::timestamptz, now()),
      nullif(r->>'strain_score_v2', '')::numeric,
      nullif(r->'strain_v2', 'null'::jsonb)
    )
    on conflict (user_id, day) do update set
      source_device_id = coalesce(excluded.source_device_id, public.daily_metrics.source_device_id),
      charge = coalesce(excluded.charge, public.daily_metrics.charge),
      effort = coalesce(excluded.effort, public.daily_metrics.effort),
      rest = coalesce(excluded.rest, public.daily_metrics.rest),
      readiness_level = coalesce(excluded.readiness_level, public.daily_metrics.readiness_level),
      hrv_rmssd_ms = coalesce(excluded.hrv_rmssd_ms, public.daily_metrics.hrv_rmssd_ms),
      hrv_sdnn_ms = coalesce(excluded.hrv_sdnn_ms, public.daily_metrics.hrv_sdnn_ms),
      resting_hr_bpm = coalesce(excluded.resting_hr_bpm, public.daily_metrics.resting_hr_bpm),
      avg_hr_bpm = coalesce(excluded.avg_hr_bpm, public.daily_metrics.avg_hr_bpm),
      max_hr_bpm = coalesce(excluded.max_hr_bpm, public.daily_metrics.max_hr_bpm),
      resp_rate_bpm = coalesce(excluded.resp_rate_bpm, public.daily_metrics.resp_rate_bpm),
      skin_temp_c = coalesce(excluded.skin_temp_c, public.daily_metrics.skin_temp_c),
      skin_temp_dev_c = coalesce(excluded.skin_temp_dev_c, public.daily_metrics.skin_temp_dev_c),
      spo2_pct = coalesce(excluded.spo2_pct, public.daily_metrics.spo2_pct),
      steps = coalesce(excluded.steps, public.daily_metrics.steps),
      active_kcal = coalesce(excluded.active_kcal, public.daily_metrics.active_kcal),
      basal_kcal = coalesce(excluded.basal_kcal, public.daily_metrics.basal_kcal),
      vo2max = coalesce(excluded.vo2max, public.daily_metrics.vo2max),
      weight_kg = coalesce(excluded.weight_kg, public.daily_metrics.weight_kg),
      body_fat_pct = coalesce(excluded.body_fat_pct, public.daily_metrics.body_fat_pct),
      lean_mass_kg = coalesce(excluded.lean_mass_kg, public.daily_metrics.lean_mass_kg),
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
      exercise_count = coalesce(excluded.exercise_count, public.daily_metrics.exercise_count),
      stress_day_mean = coalesce(excluded.stress_day_mean, public.daily_metrics.stress_day_mean),
      high_stress_minutes = coalesce(excluded.high_stress_minutes, public.daily_metrics.high_stress_minutes),
      chart_data = case when excluded.chart_data <> '{}'::jsonb then excluded.chart_data else public.daily_metrics.chart_data end,
      extras = public.daily_metrics.extras || excluded.extras,
      confidence = public.daily_metrics.confidence || excluded.confidence,
      provenance = public.daily_metrics.provenance || excluded.provenance,
      algorithm_version = excluded.algorithm_version,
      computed_at = excluded.computed_at,
      strain_score_v2 = coalesce(excluded.strain_score_v2, public.daily_metrics.strain_score_v2),
      strain_v2 = coalesce(excluded.strain_v2, public.daily_metrics.strain_v2),
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



-- Read path: expose the V2 score + provenance envelope + real strain series
-- through the startup snapshot. V1 fields keep their exact positions and
-- semantics; V2 fields are additive.
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
    ), '[]'::jsonb)
  );
end;
$$;
