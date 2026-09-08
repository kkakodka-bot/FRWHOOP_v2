begin;

create or replace function public.engine_patch_daily_extras(
  p_secret text,
  p_user_id uuid,
  p_day date,
  p_patch jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, internal
as $$
declare
  v_row public.daily_metrics;
  v_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
begin
  if v_role <> 'service_role' then
    perform internal.assert_ingest_secret(p_secret);
  end if;
  if p_user_id is null or p_day is null then
    raise exception 'user_id and day required';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'extras patch must be a json object';
  end if;

  update public.daily_metrics
     set extras = coalesce(extras, '{}'::jsonb) || p_patch,
         updated_at = now()
   where user_id = p_user_id
     and day = p_day
     and record_class = 'user'
  returning * into v_row;

  if v_row.user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'daily_metrics_missing');
  end if;
  return jsonb_build_object('ok', true, 'day', v_row.day, 'extras', v_row.extras);
end;
$$;

revoke all on function public.engine_patch_daily_extras(text, uuid, date, jsonb)
  from public, anon, authenticated;
grant execute on function public.engine_patch_daily_extras(text, uuid, date, jsonb)
  to anon, service_role;

commit;
