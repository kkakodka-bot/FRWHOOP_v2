-- Restrict engine ingest to service_role, pin search_path, and deny
-- client access to internal secret tables. Leaked-password protection is
-- an Auth setting (config.toml password_hibp_enabled), not SQL.

begin;

revoke all on function public.engine_ingest_upsert(text, jsonb)
  from public, anon, authenticated;
revoke all on function public.engine_ingest_extras(text, jsonb)
  from public, anon, authenticated;
revoke all on function public.engine_load_user_days(text, uuid, date, date)
  from public, anon, authenticated;
revoke all on function public.engine_patch_daily_extras(text, uuid, date, jsonb)
  from public, anon, authenticated;
revoke all on function public.engine_replace_sleep_day(text, jsonb)
  from public, anon, authenticated;
revoke all on function public.engine_resolve_ingest_gaps(text, uuid, jsonb)
  from public, anon, authenticated;

grant execute on function public.engine_ingest_upsert(text, jsonb) to service_role;
grant execute on function public.engine_ingest_extras(text, jsonb) to service_role;
grant execute on function public.engine_load_user_days(text, uuid, date, date) to service_role;
grant execute on function public.engine_patch_daily_extras(text, uuid, date, jsonb) to service_role;
grant execute on function public.engine_replace_sleep_day(text, jsonb) to service_role;
grant execute on function public.engine_resolve_ingest_gaps(text, uuid, jsonb) to service_role;

alter function public.engine_ingest_upsert(text, jsonb)
  set search_path = pg_catalog, public, internal;
alter function public.engine_load_user_days(text, uuid, date, date)
  set search_path = pg_catalog, public, internal;

create or replace function public.sleep_projection_day(
  p_external_id text,
  p_end timestamptz,
  p_tz text
)
returns date
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case
    when p_external_id is not null
      and p_external_id ~ '^sleep:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89ab][0-9a-fA-F]{3}-[0-9a-fA-F]{12}:\d{4}-\d{2}-\d{2}:'
      then substring(p_external_id from 44 for 10)::date
    else public.local_calendar_date(p_end, p_tz)
  end
$$;

revoke all on function public.sleep_projection_day(text, timestamptz, text)
  from public, anon, authenticated;

create or replace function public.daily_metrics_steps_recompute()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.confidence ? 'steps'
     and coalesce(new.confidence->'steps'->>'status', '') = 'unavailable' then
    new.steps := null;
  end if;
  return new;
end;
$$;

alter table if exists internal.integration_credentials enable row level security;
alter table if exists internal.settings_migration_audit enable row level security;

drop policy if exists app_secrets_deny_clients on internal.app_secrets;
create policy app_secrets_deny_clients on internal.app_secrets
  for all to anon, authenticated
  using (false)
  with check (false);

drop policy if exists integration_secrets_deny_clients on internal.integration_secrets;
create policy integration_secrets_deny_clients on internal.integration_secrets
  for all to anon, authenticated
  using (false)
  with check (false);

drop policy if exists integration_credentials_deny_clients on internal.integration_credentials;
create policy integration_credentials_deny_clients on internal.integration_credentials
  for all to anon, authenticated
  using (false)
  with check (false);

drop policy if exists settings_migration_audit_deny_clients on internal.settings_migration_audit;
create policy settings_migration_audit_deny_clients on internal.settings_migration_audit
  for all to anon, authenticated
  using (false)
  with check (false);

revoke all on function internal.emit_user_invalidation() from public, anon, authenticated;

create or replace function public.engine_read_day_snapshot(
  p_secret text,
  p_user_id uuid,
  p_day date
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, internal
as $$
begin
  perform internal.assert_ingest_secret(p_secret);
  if p_user_id is null or p_day is null then
    raise exception 'user_id and day required';
  end if;
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user_id::text, 'role', 'authenticated')::text,
    true
  );
  return public.get_day_snapshot(p_day);
end;
$$;

revoke all on function public.engine_read_day_snapshot(text, uuid, date)
  from public, anon, authenticated;
grant execute on function public.engine_read_day_snapshot(text, uuid, date)
  to service_role;

commit;
