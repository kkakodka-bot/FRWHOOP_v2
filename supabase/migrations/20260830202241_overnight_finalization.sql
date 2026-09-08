-- Overnight finalization control state lives on day_completeness, not extras-only
-- REST upserts. Continuity status (open/complete/degraded) is unchanged.
-- extras.overnight_finalization is a user-facing mirror via atomic jsonb || patch.

begin;

alter table public.day_completeness
  add column if not exists overnight_state text,
  add column if not exists overnight_reason text,
  add column if not exists input_fingerprint text,
  add column if not exists last_trigger text,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists overnight_finalized_at timestamptz;

alter table public.day_completeness drop constraint if exists day_completeness_overnight_state_check;
alter table public.day_completeness
  add constraint day_completeness_overnight_state_check
  check (overnight_state is null or overnight_state = any (array[
    'waiting_for_history'::text,
    'computing'::text,
    'finalized'::text,
    'calibrating'::text,
    'insufficient_data'::text,
    'error'::text
  ]));

create index if not exists day_completeness_overnight_idx
  on public.day_completeness (user_id, overnight_state, last_attempt_at desc);

comment on column public.day_completeness.overnight_state is
  'Sleep/RHR/HRV/Recovery pipeline state. Distinct from continuity status.';
comment on column public.day_completeness.input_fingerprint is
  'Ready-manifest identity the last overnight attempt used. Unchanged fingerprint skips B2 replay.';

-- hr_stream_stalled is emitted by the phone; coerce-or-accept rather than 400.
alter table public.ingest_gaps drop constraint if exists ingest_gaps_kind_check;
alter table public.ingest_gaps
  add constraint ingest_gaps_kind_check check (kind = any (array[
    'missing_interval'::text, 'connection'::text, 'upload'::text,
    'bluetooth_off'::text, 'not_restored'::text, 'app_killed'::text,
    'suspend'::text, 'hr_stream_stalled'::text
  ]));

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
begin
  perform internal.assert_ingest_secret(p_secret);
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
