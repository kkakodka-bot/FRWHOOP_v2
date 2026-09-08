-- Greenfield ingest RPCs. Historical no-op migrations left these functions
-- missing on a clean project. CREATE OR REPLACE is a no-op on production if
-- bodies already match. Privileged: service_role only.

create unique index if not exists devices_external_unique
  on public.devices (user_id, source_kind, external_device_id)
  where external_device_id is not null;

create unique index if not exists sessions_external_unique
  on public.sessions (user_id, source, external_id)
  where external_id is not null;

create or replace function internal.assert_ingest_secret(p_secret text)
returns void
language plpgsql
security definer
set search_path = internal
as $$
declare expected text;
begin
  if auth.role() = 'service_role' then return; end if;
  select s.value into expected from internal.app_secrets s where s.name = 'ingest';
  if expected is null or p_secret is null or p_secret is distinct from expected then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
end;
$$;
revoke all on function internal.assert_ingest_secret(text) from public;

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
      chart_data, extras, confidence, provenance, algorithm_version, computed_at
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
      coalesce(nullif(r->>'computed_at', '')::timestamptz, now())
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

revoke all on function public.engine_ingest_upsert(text, jsonb) from public, anon, authenticated;
revoke all on function public.engine_ingest_extras(text, jsonb) from public, anon, authenticated;
revoke all on function public.engine_load_user_days(text, uuid, date, date) from public, anon, authenticated;
grant execute on function public.engine_ingest_upsert(text, jsonb) to service_role;
grant execute on function public.engine_ingest_extras(text, jsonb) to service_role;
grant execute on function public.engine_load_user_days(text, uuid, date, date) to service_role;

create or replace function public.app_upsert_daily_metrics(p_secret text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, internal
as $$
declare n integer;
begin
  perform internal.assert_ingest_secret(p_secret);
  with data as (
    select * from jsonb_populate_recordset(null::public.daily_metrics, p_rows)
  ), upserted as (
    insert into public.daily_metrics (
      user_id, day, charge, effort, rest, readiness_level,
      hrv_rmssd_ms, hrv_sdnn_ms, resting_hr_bpm, avg_hr_bpm, max_hr_bpm,
      resp_rate_bpm, skin_temp_c, skin_temp_dev_c, spo2_pct,
      steps, active_kcal, basal_kcal, sleep_total_min, sleep_deep_min,
      sleep_rem_min, sleep_light_min, sleep_in_bed_min, sleep_awake_min,
      sleep_efficiency, sleep_need_min, sleep_consistency,
      sleep_onset_at, wake_onset_at, overnight_hr_bpm, disturbances,
      exercise_count, chart_data, extras, confidence, provenance,
      algorithm_version, computed_at, updated_at
    )
    select
      user_id, day, charge, effort, rest, readiness_level,
      hrv_rmssd_ms, hrv_sdnn_ms, resting_hr_bpm, avg_hr_bpm, max_hr_bpm,
      resp_rate_bpm, skin_temp_c, skin_temp_dev_c, spo2_pct,
      steps, active_kcal, basal_kcal, sleep_total_min, sleep_deep_min,
      sleep_rem_min, sleep_light_min, sleep_in_bed_min, sleep_awake_min,
      sleep_efficiency, sleep_need_min, sleep_consistency,
      sleep_onset_at, wake_onset_at, overnight_hr_bpm, disturbances,
      exercise_count,
      coalesce(chart_data, '{}'::jsonb), coalesce(extras, '{}'::jsonb),
      coalesce(confidence, '{}'::jsonb), coalesce(provenance, '{}'::jsonb),
      coalesce(algorithm_version, '0.1.0'), coalesce(computed_at, now()), now()
    from data
    on conflict (user_id, day) do update set
      charge = excluded.charge, effort = excluded.effort, rest = excluded.rest,
      readiness_level = excluded.readiness_level,
      hrv_rmssd_ms = excluded.hrv_rmssd_ms, hrv_sdnn_ms = excluded.hrv_sdnn_ms,
      resting_hr_bpm = excluded.resting_hr_bpm, avg_hr_bpm = excluded.avg_hr_bpm,
      max_hr_bpm = excluded.max_hr_bpm, resp_rate_bpm = excluded.resp_rate_bpm,
      skin_temp_c = excluded.skin_temp_c, skin_temp_dev_c = excluded.skin_temp_dev_c,
      spo2_pct = excluded.spo2_pct, steps = excluded.steps,
      active_kcal = excluded.active_kcal, basal_kcal = excluded.basal_kcal,
      sleep_total_min = excluded.sleep_total_min, sleep_deep_min = excluded.sleep_deep_min,
      sleep_rem_min = excluded.sleep_rem_min, sleep_light_min = excluded.sleep_light_min,
      sleep_in_bed_min = excluded.sleep_in_bed_min, sleep_awake_min = excluded.sleep_awake_min,
      sleep_efficiency = excluded.sleep_efficiency, sleep_need_min = excluded.sleep_need_min,
      sleep_consistency = excluded.sleep_consistency, sleep_onset_at = excluded.sleep_onset_at,
      wake_onset_at = excluded.wake_onset_at, overnight_hr_bpm = excluded.overnight_hr_bpm,
      disturbances = excluded.disturbances, exercise_count = excluded.exercise_count,
      chart_data = excluded.chart_data, extras = excluded.extras,
      confidence = excluded.confidence, provenance = excluded.provenance,
      algorithm_version = excluded.algorithm_version, computed_at = excluded.computed_at,
      updated_at = now()
    returning 1
  )
  select count(*) into n from upserted;
  return n;
end;
$$;

create or replace function public.app_upsert_device(
  p_secret text, p_user_id uuid, p_external_device_id text,
  p_nickname text, p_firmware text, p_sync_state jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, internal
as $$
begin
  perform internal.assert_ingest_secret(p_secret);
  update public.devices set
    nickname = coalesce(p_nickname, nickname),
    firmware = coalesce(p_firmware, firmware),
    sync_state = coalesce(p_sync_state, sync_state),
    last_seen_at = now(),
    updated_at = now()
  where user_id = p_user_id and source_kind = 'whoop_ble' and external_device_id = p_external_device_id;
  if not found then
    insert into public.devices (
      user_id, source_kind, external_device_id, device_family, nickname, firmware,
      is_active, sync_state, last_seen_at, updated_at
    )
    values (
      p_user_id, 'whoop_ble', p_external_device_id, 'whoop', p_nickname, p_firmware,
      true, coalesce(p_sync_state, '{}'::jsonb), now(), now()
    );
  end if;
end;
$$;

revoke all on function public.app_upsert_daily_metrics(text, jsonb) from public, anon, authenticated;
revoke all on function public.app_upsert_device(text, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.app_upsert_daily_metrics(text, jsonb) to service_role;
grant execute on function public.app_upsert_device(text, uuid, text, text, text, jsonb) to service_role;
