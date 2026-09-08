-- Covering indexes for new FKs and drop the duplicate daily_metrics day index.
-- Expand-only. No data rewrite.

create index if not exists algorithm_results_user_idx
  on public.algorithm_results (user_id, computed_at desc);

create index if not exists algorithm_results_metric_run_idx
  on public.algorithm_results (metric_run_id)
  where metric_run_id is not null;

create index if not exists coach_messages_user_idx
  on public.coach_messages (user_id, created_at desc);

create index if not exists coach_messages_session_idx
  on public.coach_messages (session_id);

create index if not exists user_documents_user_idx
  on public.user_documents (user_id, created_at desc);

create index if not exists measurements_device_idx
  on public.measurements (device_id)
  where device_id is not null;

create index if not exists object_manifests_device_idx
  on public.object_manifests (device_id)
  where device_id is not null;

create index if not exists physiology_buckets_device_idx
  on public.physiology_buckets (device_id)
  where device_id is not null;

create index if not exists metric_runs_device_idx
  on public.metric_runs (device_id)
  where device_id is not null;

drop index if exists public.daily_metrics_user_day_idx;

-- Table is created in 20260824190000. Skip on a greenfield apply where this
-- file runs first; 190000 creates the identity PK itself.
do $$
begin
  if to_regclass('internal.settings_migration_audit') is null then
    return;
  end if;
  alter table internal.settings_migration_audit
    add column if not exists id bigint generated always as identity;
  if not exists (
    select 1 from pg_constraint
    where conname = 'settings_migration_audit_pkey'
  ) then
    begin
      alter table internal.settings_migration_audit
        add constraint settings_migration_audit_pkey primary key (id);
    exception when others then
      null;
    end;
  end if;
end $$;
