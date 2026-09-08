-- Harden the already-deployed Steps V3 reference schema:
--   * incremental HealthKit payloads merge immutable sample allocations;
--   * only manual/video and public labels are accuracy ground truth.

begin;

create or replace function public.merge_apple_watch_step_bucket()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  merged_allocations jsonb;
begin
  merged_allocations :=
    coalesce(old.metadata->'allocations', '{}'::jsonb)
    || coalesce(new.metadata->'allocations', '{}'::jsonb);

  new.source_sample_ids := array(
    select distinct sample_id
    from unnest(old.source_sample_ids || new.source_sample_ids) as sample_id
    order by sample_id
  );
  new.allocated := old.allocated or new.allocated;
  new.coalesced := old.coalesced or new.coalesced;
  new.device_provenance := old.device_provenance || new.device_provenance;
  new.metadata := jsonb_set(
    old.metadata || new.metadata,
    '{allocations}',
    merged_allocations,
    true
  );
  if merged_allocations <> '{}'::jsonb then
    new.step_count := (
      select coalesce(sum(value::numeric), 0)
      from jsonb_each_text(merged_allocations)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists apple_watch_step_buckets_merge_allocations
  on public.apple_watch_step_buckets;
create trigger apple_watch_step_buckets_merge_allocations
  before update on public.apple_watch_step_buckets
  for each row execute function public.merge_apple_watch_step_bucket();

drop view if exists public.step_validation_real_labels;

create or replace view public.step_validation_nonsynthetic
with (security_invoker = true) as
select
  id, user_id, requested_start, requested_end, scenario, device, firmware,
  wrist, participant_key, raw_imu_refs, label_source, true_count,
  event_timestamps, metadata, created_at, updated_at
from public.step_validation_sessions
where label_source <> 'synthetic';

create or replace view public.step_validation_ground_truth
with (security_invoker = true) as
select
  id, user_id, requested_start, requested_end, scenario, device, firmware,
  wrist, participant_key, raw_imu_refs, label_source, true_count,
  event_timestamps, metadata, created_at, updated_at
from public.step_validation_sessions
where label_source = any (array['video_manual'::text, 'public_ground_truth'::text]);

comment on view public.step_validation_nonsynthetic is
  'Nonsynthetic Steps V3 validation rows. Apple Watch remains agreement-only.';
comment on view public.step_validation_ground_truth is
  'Accuracy-eligible Steps V3 labels. Apple Watch and synthetic rows are excluded.';

revoke all on table public.step_validation_nonsynthetic from public, anon;
revoke all on table public.step_validation_ground_truth from public, anon;
grant select on public.step_validation_nonsynthetic to authenticated, service_role;
grant select on public.step_validation_ground_truth to authenticated, service_role;

revoke all on function public.merge_apple_watch_step_bucket() from public, anon, authenticated;
grant execute on function public.merge_apple_watch_step_bucket() to service_role;

commit;
