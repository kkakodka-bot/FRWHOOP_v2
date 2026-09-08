-- Secret-gated RPCs for settings + integration state.
--
-- The backend authenticates with the publishable/anon key plus the
-- server-only INGEST_SECRET. The single secret store is
-- internal.app_secrets (name = 'ingest'), created by
-- 20260824120000_sleep_and_object_storage.sql and seeded out-of-band:
--
--   insert into internal.app_secrets (name, value) values ('ingest', '<INGRESS_SECRET>');
--
-- app_secret_ok also passes the service role, so these functions work
-- identically when called with a service role key. Direct table access for
-- anon/authenticated stays denied by RLS + revoked table privileges.

create or replace function public.app_secret_ok(p_secret text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' then return true; end if;
  perform internal.assert_ingest_secret(p_secret);
  return true;
exception
  when others then return false;
end;
$$;

create or replace function public.app_upsert_settings(p_secret text, p_user_key text, p_settings jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.app_secret_ok(p_secret) then raise exception 'unauthorized'; end if;
  insert into public.user_settings (user_key, settings)
  values (p_user_key, coalesce(p_settings, '{}'::jsonb))
  on conflict (user_key) do update set settings = excluded.settings;
end;
$$;

create or replace function public.app_get_settings(p_secret text, p_user_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare row record;
begin
  if not public.app_secret_ok(p_secret) then raise exception 'unauthorized'; end if;
  select s.settings, s.updated_at into row from public.user_settings s where s.user_key = p_user_key;
  if not found then return null; end if;
  return jsonb_build_object('settings', row.settings, 'updated_at', row.updated_at);
end;
$$;

create or replace function public.app_upsert_integration(p_secret text, p_user_key text, p_provider text, p_status text, p_tokens jsonb, p_meta jsonb, p_connected_at timestamptz)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.app_secret_ok(p_secret) then raise exception 'unauthorized'; end if;
  insert into public.integration_connections (user_key, provider, status, tokens, meta, connected_at)
  values (p_user_key, p_provider, coalesce(p_status, 'disconnected'), coalesce(p_tokens, '{}'::jsonb), coalesce(p_meta, '{}'::jsonb), p_connected_at)
  on conflict (user_key, provider) do update set
    status = excluded.status,
    tokens = excluded.tokens,
    meta = excluded.meta,
    connected_at = excluded.connected_at;
end;
$$;

create or replace function public.app_list_integrations(p_secret text, p_user_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare rows jsonb;
begin
  if not public.app_secret_ok(p_secret) then raise exception 'unauthorized'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'provider', c.provider,
    'status', c.status,
    'tokens', c.tokens,
    'meta', c.meta,
    'connected_at', c.connected_at,
    'updated_at', c.updated_at
  )), '[]'::jsonb) into rows
  from public.integration_connections c where c.user_key = p_user_key;
  return rows;
end;
$$;

create or replace function public.app_delete_integration(p_secret text, p_user_key text, p_provider text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.app_secret_ok(p_secret) then raise exception 'unauthorized'; end if;
  delete from public.integration_connections where user_key = p_user_key and provider = p_provider;
end;
$$;

-- Bulk day upsert used by the coach-history backfill (backend/metrics/backfill.js).
create or replace function public.app_upsert_daily_metrics(p_secret text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  if not public.app_secret_ok(p_secret) then raise exception 'unauthorized'; end if;
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

-- Device registration/heartbeat (strap model, firmware, last seen).
create or replace function public.app_upsert_device(p_secret text, p_user_id uuid, p_external_device_id text, p_nickname text, p_firmware text, p_sync_state jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.app_secret_ok(p_secret) then raise exception 'unauthorized'; end if;
  update public.devices set
    nickname = coalesce(p_nickname, nickname),
    firmware = coalesce(p_firmware, firmware),
    sync_state = coalesce(p_sync_state, sync_state),
    last_seen_at = now(),
    updated_at = now()
  where user_id = p_user_id and source_kind = 'whoop_ble' and external_device_id = p_external_device_id;
  if not found then
    insert into public.devices (user_id, source_kind, external_device_id, device_family, nickname, firmware, is_active, sync_state, last_seen_at, updated_at)
    values (p_user_id, 'whoop_ble', p_external_device_id, 'whoop', p_nickname, p_firmware, true, coalesce(p_sync_state, '{}'::jsonb), now(), now());
  end if;
end;
$$;

grant execute on function public.app_secret_ok(text) to anon, authenticated;
grant execute on function public.app_upsert_settings(text, text, jsonb) to anon, authenticated;
grant execute on function public.app_get_settings(text, text) to anon, authenticated;
grant execute on function public.app_upsert_integration(text, text, text, text, jsonb, jsonb, timestamptz) to anon, authenticated;
grant execute on function public.app_list_integrations(text, text) to anon, authenticated;
grant execute on function public.app_delete_integration(text, text, text) to anon, authenticated;
grant execute on function public.app_upsert_daily_metrics(text, jsonb) to anon, authenticated;
grant execute on function public.app_upsert_device(text, uuid, text, text, text, jsonb) to anon, authenticated;
