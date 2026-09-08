-- Keep HealthKit read consent distinct from write authorization and enforce
-- validation-session event invariants even for direct authenticated writes.

begin;

alter table public.integration_connections
  drop constraint if exists integration_authorization_check;
alter table public.integration_connections
  add constraint integration_authorization_check check (
    authorization_status = any (array[
      'not_requested'::text,
      'denied'::text,
      'authorized'::text,
      'read_requested'::text,
      'unavailable'::text
    ])
  );

create or replace function public.step_validation_events_are_valid(
  p_events timestamptz[],
  p_true_count integer,
  p_start timestamptz,
  p_end timestamptz
)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select case
    when p_events is null then true
    else cardinality(p_events) = p_true_count
      and cardinality(p_events) = (
        select count(distinct event_at)
        from unnest(p_events) as event_at
      )
      and coalesce((
        select bool_and(event_at >= p_start and event_at <= p_end)
        from unnest(p_events) as event_at
      ), true)
  end;
$$;

alter table public.step_validation_sessions
  drop constraint if exists step_validation_sessions_event_integrity_check;
alter table public.step_validation_sessions
  add constraint step_validation_sessions_event_integrity_check check (
    public.step_validation_events_are_valid(
      event_timestamps,
      true_count,
      requested_start,
      requested_end
    )
  );

alter table public.step_validation_sessions
  drop constraint if exists step_validation_sessions_watch_interval_only_check;
alter table public.step_validation_sessions
  add constraint step_validation_sessions_watch_interval_only_check check (
    label_source <> 'apple_watch' or event_timestamps is null
  );

revoke all on function public.step_validation_events_are_valid(
  timestamptz[], integer, timestamptz, timestamptz
) from public, anon;
grant execute on function public.step_validation_events_are_valid(
  timestamptz[], integer, timestamptz, timestamptz
) to authenticated, service_role;

commit;
