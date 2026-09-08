-- Patch engine_replace_sleep_day to persist V3 shadow + probability columns.
-- Function body is the 20260830230000 replacement plus additive columns.
-- Grants remain service_role-only (see 20260901012423).

create or replace function public.engine_replace_sleep_day(
  p_secret text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, internal
as $$
declare
  v_user uuid;
  v_day date;
  v_tz text;
  v_device uuid;
  v_source text;
  v_expected_ids uuid[] := '{}'::uuid[];
  v_incoming_id uuid;
  v_target_id uuid;
  v_external_id text;
  v_kind text;
  v_start timestamptz;
  v_end timestamptz;
  v_user_modified boolean;
  v_session_payload jsonb;
  v_main jsonb;
  v_main_session uuid;
  v_deleted integer := 0;
  v_upserted integer := 0;
  r jsonb;
begin
  perform internal.assert_ingest_secret(p_secret);

  v_user := nullif(p_payload->>'user_id', '')::uuid;
  if v_user is null then
    raise exception 'user_id required';
  end if;
  if not (p_payload ? 'sleep_details') then
    raise exception 'sleep_details must be present (use [] for an empty replacement)';
  end if;

  select nullif(m->>'day', '')::date,
         coalesce(nullif(m->>'timezone_name', ''), public.profile_timezone(v_user)),
         nullif(m->>'source_device_id', '')::uuid
    into v_day, v_tz, v_device
  from jsonb_array_elements(coalesce(p_payload->'daily_metrics', '[]'::jsonb)) m
  limit 1;

  v_tz := coalesce(v_tz, public.profile_timezone(v_user), 'UTC');
  v_device := coalesce(
    v_device,
    nullif(p_payload->'device'->>'id', '')::uuid,
    (
      select nullif(s->>'device_id', '')::uuid
      from jsonb_array_elements(coalesce(p_payload->'sessions', '[]'::jsonb)) s
      where coalesce(s->>'kind', '') in ('sleep', 'nap')
      limit 1
    )
  );
  v_source := coalesce(
    nullif(p_payload->>'sleep_source', ''),
    (
      select nullif(s->>'source', '')
      from jsonb_array_elements(coalesce(p_payload->'sessions', '[]'::jsonb)) s
      where coalesce(s->>'kind', '') in ('sleep', 'nap')
      limit 1
    ),
    'frwhoop'
  );

  if v_day is null then
    select public.local_calendar_date(
             nullif(s->>'end_at', '')::timestamptz,
             v_tz
           )
      into v_day
    from jsonb_array_elements(coalesce(p_payload->'sessions', '[]'::jsonb)) s
    where coalesce(s->>'kind', '') in ('sleep', 'nap')
    limit 1;
  end if;
  if v_day is null then
    raise exception 'physiological day required';
  end if;
  if v_device is null then
    raise exception 'sleep device required';
  end if;
  -- The replacement RPC is intentionally safe to call before the generic
  -- ingest RPC. Ensure a first-seen device exists in this same transaction so
  -- session and daily-metric foreign keys cannot leave a partial sleep write.
  if p_payload ? 'device' and jsonb_typeof(p_payload->'device') = 'object' then
    insert into public.devices (
      id, user_id, source_kind, external_device_id, device_family, firmware, last_seen_at
    )
    values (
      v_device,
      v_user,
      coalesce(p_payload->'device'->>'source_kind', 'whoop'),
      p_payload->'device'->>'external_device_id',
      p_payload->'device'->>'device_family',
      p_payload->'device'->>'firmware',
      now()
    )
    on conflict (user_id, source_kind, external_device_id)
      where external_device_id is not null
    do update set
      firmware = coalesce(excluded.firmware, public.devices.firmware),
      device_family = coalesce(excluded.device_family, public.devices.device_family),
      last_seen_at = now(),
      updated_at = now()
    returning id into v_device;
  end if;
  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_payload->'daily_metrics', '[]'::jsonb)) m
    where nullif(m->>'day', '')::date is distinct from v_day
  ) then
    raise exception 'sleep replacement accepts one physiological day';
  end if;

  -- Serialize retries and concurrent late-data recomputations for the same
  -- projection. The lock is transaction-scoped and releases on commit/rollback.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'gravity-sleep:' || v_user::text || ':' || v_device::text || ':' || v_day::text,
      0
    )
  );
  perform 1
  from public.daily_metrics m
  where m.user_id = v_user and m.day = v_day
  for update;

  -- Upsert algorithm-owned sessions first. Matching by external_id preserves a
  -- corrected row even when a new algorithm build supplied a different UUID.
  for r in
    select value
    from jsonb_array_elements(coalesce(p_payload->'sessions', '[]'::jsonb))
    where coalesce(value->>'kind', '') in ('sleep', 'nap')
  loop
    if nullif(r->>'user_id', '')::uuid is distinct from v_user then
      raise exception 'session user_id does not match payload user_id';
    end if;

    v_incoming_id := coalesce(nullif(r->>'id', '')::uuid, gen_random_uuid());
    v_external_id := nullif(r->>'external_id', '');
    v_kind := case when coalesce(r->>'kind', 'sleep') = 'nap' then 'nap' else 'sleep' end;
    v_start := nullif(r->>'start_at', '')::timestamptz;
    v_end := nullif(r->>'end_at', '')::timestamptz;
    if v_start is null or v_end is null or v_end <= v_start then
      raise exception 'valid sleep session boundaries required';
    end if;

    select s.id
      into v_target_id
    from public.sessions s
    where s.user_id = v_user
      and (
        s.id = v_incoming_id
        or (
          v_external_id is not null
          and s.source = coalesce(nullif(r->>'source', ''), v_source)
          and s.external_id = v_external_id
        )
      )
    order by (s.id = v_incoming_id) desc
    limit 1;
    v_target_id := coalesce(v_target_id, v_incoming_id);

    insert into public.sessions as s (
      id, user_id, device_id, kind, source, external_id, start_at, end_at,
      timezone_offset_seconds, summary, segments, quality, algorithm_version
    )
    values (
      v_target_id,
      v_user,
      v_device,
      v_kind,
      coalesce(nullif(r->>'source', ''), v_source),
      v_external_id,
      v_start,
      v_end,
      nullif(r->>'timezone_offset_seconds', '')::integer,
      coalesce(r->'summary', '{}'::jsonb),
      coalesce(r->'segments', '[]'::jsonb),
      coalesce(r->'quality', '{}'::jsonb),
      r->>'algorithm_version'
    )
    on conflict (id) do update set
      device_id = coalesce(excluded.device_id, s.device_id),
      kind = excluded.kind,
      start_at = case when s.user_modified then s.start_at else excluded.start_at end,
      end_at = case when s.user_modified then s.end_at else excluded.end_at end,
      summary = excluded.summary,
      segments = excluded.segments,
      quality = excluded.quality,
      algorithm_version = excluded.algorithm_version,
      updated_at = now();

    v_expected_ids := array_append(v_expected_ids, v_target_id);
  end loop;

  -- sleep_details is canonical. It is handled here for the secret-gated RPC
  -- deployment; service-role deployments may continue direct table upserts or
  -- call this RPC to get replacement semantics.
  for r in
    select value
    from jsonb_array_elements(coalesce(p_payload->'sleep_details', '[]'::jsonb))
  loop
    if nullif(r->>'user_id', '')::uuid is distinct from v_user then
      raise exception 'sleep_details user_id does not match payload user_id';
    end if;

    v_incoming_id := nullif(r->>'session_id', '')::uuid;
    if v_incoming_id is null then
      raise exception 'sleep_details session_id required';
    end if;

    select value
      into v_session_payload
    from jsonb_array_elements(coalesce(p_payload->'sessions', '[]'::jsonb))
    where nullif(value->>'id', '')::uuid = v_incoming_id
    limit 1;
    v_external_id := nullif(v_session_payload->>'external_id', '');

    select s.id, s.start_at, s.end_at, s.user_modified
      into v_target_id, v_start, v_end, v_user_modified
    from public.sessions s
    where s.user_id = v_user
      and (
        s.id = v_incoming_id
        or (
          v_external_id is not null
          and s.source = coalesce(nullif(v_session_payload->>'source', ''), v_source)
          and s.external_id = v_external_id
        )
      )
    order by (s.id = v_incoming_id) desc
    limit 1;

    -- Allow callers to omit the duplicate sessions array: details carry enough
    -- original-boundary data to create the canonical session.
    if v_target_id is null then
      v_start := nullif(r->>'original_start_at', '')::timestamptz;
      v_end := nullif(r->>'original_end_at', '')::timestamptz;
      if v_start is null or v_end is null or v_end <= v_start then
        raise exception 'sleep_details require a matching session or original boundaries';
      end if;
      v_target_id := v_incoming_id;
      insert into public.sessions (
        id, user_id, device_id, kind, source, external_id, start_at, end_at,
        summary, segments, algorithm_version
      )
      values (
        v_target_id, v_user, v_device,
        case when coalesce((r->>'is_nap')::boolean, false) then 'nap' else 'sleep' end,
        v_source, null, v_start, v_end, '{}'::jsonb,
        coalesce(r->'hypnogram', '[]'::jsonb), r->>'algorithm_version'
      );
      v_user_modified := false;
    end if;

    insert into public.sleep_details as d (
      session_id, user_id, is_nap, in_bed_min, asleep_min, awake_min,
      light_min, deep_min, rem_min, efficiency, performance_pct, need_min,
      debt_min, consistency_pct, overnight_hr_bpm, resting_hr_bpm,
      hrv_rmssd_ms, resp_rate_bpm, disturbances, recovery_pct,
      original_start_at, original_end_at, user_start_at, user_end_at,
      stages, hypnogram, derived_object_id, algorithm_version, computed_at,
      epoch_probabilities, epoch_coverage, scorability,
      detector_version, stager_version, shadow_v3, unscored_min
    )
    values (
      v_target_id,
      v_user,
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
      nullif(r->>'original_start_at', '')::timestamptz,
      nullif(r->>'original_end_at', '')::timestamptz,
      case when v_user_modified then v_start else nullif(r->>'user_start_at', '')::timestamptz end,
      case when v_user_modified then v_end else nullif(r->>'user_end_at', '')::timestamptz end,
      coalesce(r->'stages', '[]'::jsonb),
      coalesce(r->'hypnogram', '[]'::jsonb),
      nullif(r->>'derived_object_id', '')::uuid,
      r->>'algorithm_version',
      coalesce(nullif(r->>'computed_at', '')::timestamptz, now()),
      r->'epoch_probabilities',
      r->'epoch_coverage',
      r->'scorability',
      nullif(r->>'detector_version', ''),
      nullif(r->>'stager_version', ''),
      r->'shadow_v3',
      nullif(r->>'unscored_min', '')::integer
    )
    on conflict (session_id) do update set
      user_id = excluded.user_id,
      is_nap = excluded.is_nap,
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
      hrv_rmssd_ms = excluded.hrv_rmssd_ms,
      resp_rate_bpm = excluded.resp_rate_bpm,
      disturbances = excluded.disturbances,
      recovery_pct = excluded.recovery_pct,
      original_start_at = excluded.original_start_at,
      original_end_at = excluded.original_end_at,
      user_start_at = case
        when v_user_modified then coalesce(d.user_start_at, excluded.user_start_at)
        else excluded.user_start_at
      end,
      user_end_at = case
        when v_user_modified then coalesce(d.user_end_at, excluded.user_end_at)
        else excluded.user_end_at
      end,
      stages = excluded.stages,
      hypnogram = excluded.hypnogram,
      derived_object_id = excluded.derived_object_id,
      algorithm_version = excluded.algorithm_version,
      computed_at = excluded.computed_at,
      epoch_probabilities = excluded.epoch_probabilities,
      epoch_coverage = excluded.epoch_coverage,
      scorability = excluded.scorability,
      detector_version = excluded.detector_version,
      stager_version = excluded.stager_version,
      shadow_v3 = excluded.shadow_v3,
      unscored_min = excluded.unscored_min,
      updated_at = now();

    if not (v_target_id = any(v_expected_ids)) then
      v_expected_ids := array_append(v_expected_ids, v_target_id);
    end if;
    v_upserted := v_upserted + 1;
  end loop;

  -- Remove projections no longer produced by the algorithm. Ownership is the
  -- ENGINE day encoded in the row's external_id (sleep:<device>:<day>:<slot>);
  -- the local end date is only the fallback for rows without one. Keying on
  -- the local end date deleted rows owned by a NEIGHBOR day whenever a night
  -- ended at/after local midnight or an episode ended before it.
  with stale as (
    select s.id
    from public.sessions s
    left join public.sleep_details d on d.session_id = s.id
    where s.user_id = v_user
      and s.device_id = v_device
      and s.source = v_source
      and s.kind in ('sleep', 'nap')
      and s.algorithm_version is not null
      and not s.user_modified
      and public.sleep_projection_day(
            s.external_id,
            coalesce(d.original_end_at, s.end_at),
            v_tz
          ) = v_day
      and not (s.id = any(v_expected_ids))
  ), removed as (
    delete from public.sessions s
    using stale
    where s.id = stale.id
    returning 1
  )
  select count(*) into v_deleted from removed;

  -- The daily headline belongs to the main overnight sleep only. Naps never
  -- replace it. An explicit empty/non-main replacement clears stale sleep fields.
  select value
    into v_main
  from jsonb_array_elements(coalesce(p_payload->'sleep_details', '[]'::jsonb))
  where not coalesce((value->>'is_nap')::boolean, false)
  order by coalesce(
    nullif(value->>'asleep_min', '')::numeric,
    nullif(value->>'in_bed_min', '')::numeric,
    0
  ) desc
  limit 1;

  if v_main is null then
    update public.daily_metrics
    set rest = null,
        sleep_performance_pct = null,
        sleep_total_min = null,
        sleep_in_bed_min = null,
        sleep_awake_min = null,
        sleep_light_min = null,
        sleep_deep_min = null,
        sleep_rem_min = null,
        sleep_efficiency = null,
        sleep_need_min = null,
        sleep_debt_balance_min = null,
        sleep_consistency = null,
        sleep_onset_at = null,
        wake_onset_at = null,
        overnight_hr_bpm = null,
        disturbances = null,
        updated_at = now()
    where user_id = v_user and day = v_day;
  else
    v_incoming_id := nullif(v_main->>'session_id', '')::uuid;
    select value
      into v_session_payload
    from jsonb_array_elements(coalesce(p_payload->'sessions', '[]'::jsonb))
    where nullif(value->>'id', '')::uuid = v_incoming_id
    limit 1;
    v_external_id := nullif(v_session_payload->>'external_id', '');

    select s.id, s.start_at, s.end_at
      into v_main_session, v_start, v_end
    from public.sessions s
    where s.user_id = v_user
      and (
        s.id = v_incoming_id
        or (
          v_external_id is not null
          and s.source = coalesce(nullif(v_session_payload->>'source', ''), v_source)
          and s.external_id = v_external_id
        )
      )
    order by (s.id = v_incoming_id) desc
    limit 1;

    insert into public.daily_metrics as m (
      user_id, day, source_device_id, rest, sleep_performance_pct,
      sleep_total_min, sleep_in_bed_min, sleep_awake_min, sleep_light_min,
      sleep_deep_min, sleep_rem_min, sleep_efficiency, sleep_need_min,
      sleep_debt_balance_min, sleep_consistency, sleep_onset_at, wake_onset_at,
      overnight_hr_bpm, disturbances, timezone_name, day_start_at, day_end_at,
      record_class, algorithm_version, computed_at
    )
    values (
      v_user,
      v_day,
      v_device,
      nullif(v_main->>'performance_pct', '')::numeric,
      nullif(v_main->>'performance_pct', '')::numeric,
      nullif(v_main->>'asleep_min', '')::numeric,
      nullif(v_main->>'in_bed_min', '')::numeric,
      nullif(v_main->>'awake_min', '')::numeric,
      nullif(v_main->>'light_min', '')::numeric,
      nullif(v_main->>'deep_min', '')::numeric,
      nullif(v_main->>'rem_min', '')::numeric,
      nullif(v_main->>'efficiency', '')::numeric,
      nullif(v_main->>'need_min', '')::numeric,
      nullif(v_main->>'debt_min', '')::numeric,
      nullif(v_main->>'consistency_pct', '')::numeric,
      coalesce(v_start, nullif(v_main->>'original_start_at', '')::timestamptz),
      coalesce(v_end, nullif(v_main->>'original_end_at', '')::timestamptz),
      nullif(v_main->>'overnight_hr_bpm', '')::numeric,
      nullif(v_main->>'disturbances', '')::integer,
      v_tz,
      (v_day::timestamp at time zone v_tz),
      ((v_day + 1)::timestamp at time zone v_tz),
      'user',
      coalesce(nullif(v_main->>'algorithm_version', ''), 'gravity-sleep'),
      coalesce(nullif(v_main->>'computed_at', '')::timestamptz, now())
    )
    on conflict (user_id, day) do update set
      source_device_id = coalesce(excluded.source_device_id, m.source_device_id),
      rest = excluded.rest,
      sleep_performance_pct = excluded.sleep_performance_pct,
      sleep_total_min = excluded.sleep_total_min,
      sleep_in_bed_min = excluded.sleep_in_bed_min,
      sleep_awake_min = excluded.sleep_awake_min,
      sleep_light_min = excluded.sleep_light_min,
      sleep_deep_min = excluded.sleep_deep_min,
      sleep_rem_min = excluded.sleep_rem_min,
      sleep_efficiency = excluded.sleep_efficiency,
      sleep_need_min = excluded.sleep_need_min,
      sleep_debt_balance_min = excluded.sleep_debt_balance_min,
      sleep_consistency = excluded.sleep_consistency,
      sleep_onset_at = excluded.sleep_onset_at,
      wake_onset_at = excluded.wake_onset_at,
      overnight_hr_bpm = excluded.overnight_hr_bpm,
      disturbances = excluded.disturbances,
      timezone_name = coalesce(m.timezone_name, excluded.timezone_name),
      day_start_at = coalesce(m.day_start_at, excluded.day_start_at),
      day_end_at = coalesce(m.day_end_at, excluded.day_end_at),
      algorithm_version = excluded.algorithm_version,
      computed_at = excluded.computed_at,
      updated_at = now();
  end if;

  return jsonb_build_object(
    'ok', true,
    'user_id', v_user,
    'day', v_day,
    'device_id', v_device,
    'sleep_details', v_upserted,
    'stale_sessions_deleted', v_deleted
  );
end;
$$;


revoke all on function public.engine_replace_sleep_day(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.engine_replace_sleep_day(text, jsonb)
  to service_role;
