-- FRWHOOP Steps V3: Apple Watch reference buckets and durable validation labels.
-- WHOOP strap-derived steps remain canonical; these rows are validation references.

begin;

create table if not exists public.apple_watch_step_buckets (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_fingerprint text not null,
  bucket_start timestamptz not null,
  bucket_size_seconds integer not null,
  bucket_key uuid not null,
  step_count numeric not null,
  allocated boolean not null default true,
  coalesced boolean not null default false,
  allocation_method text not null,
  source_sample_ids text[] not null default '{}',
  device_provenance jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, device_fingerprint, bucket_start, bucket_size_seconds),
  constraint apple_watch_step_buckets_size_check
    check (bucket_size_seconds = any (array[60, 300])),
  constraint apple_watch_step_buckets_count_check check (step_count >= 0),
  constraint apple_watch_step_buckets_method_check
    check (allocation_method = any (array['duration_overlap'::text, 'sum_60s'::text]))
);

create unique index if not exists apple_watch_step_buckets_key_uidx
  on public.apple_watch_step_buckets (user_id, bucket_key);
create index if not exists apple_watch_step_buckets_user_time_idx
  on public.apple_watch_step_buckets (user_id, bucket_start desc);

comment on table public.apple_watch_step_buckets is
  'Non-canonical Apple Watch step references. Raw HealthKit quantity samples are '
  'allocated by absolute interval overlap into 60-second buckets; 300-second rows '
  'are deterministic sums of those 60-second buckets.';

drop trigger if exists apple_watch_step_buckets_updated_at on public.apple_watch_step_buckets;
create trigger apple_watch_step_buckets_updated_at
  before update on public.apple_watch_step_buckets
  for each row execute function public.set_updated_at();

create table if not exists public.step_validation_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  requested_start timestamptz not null,
  requested_end timestamptz not null,
  scenario text not null,
  device jsonb not null default '{}'::jsonb,
  firmware text,
  wrist text not null,
  participant_key text not null,
  raw_imu_refs text[] not null default '{}',
  label_source text not null,
  true_count integer not null,
  event_timestamps timestamptz[],
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint step_validation_sessions_window_check check (requested_end > requested_start),
  constraint step_validation_sessions_wrist_check
    check (wrist = any (array['left'::text, 'right'::text, 'unknown'::text])),
  constraint step_validation_sessions_label_source_check
    check (label_source = any (array[
      'video_manual'::text, 'apple_watch'::text,
      'public_ground_truth'::text, 'synthetic'::text
    ])),
  constraint step_validation_sessions_true_count_check check (true_count >= 0)
);

create index if not exists step_validation_sessions_user_window_idx
  on public.step_validation_sessions (user_id, requested_start, requested_end);
create index if not exists step_validation_sessions_participant_idx
  on public.step_validation_sessions (user_id, participant_key);

comment on table public.step_validation_sessions is
  'Durable Steps V3 validation labels and raw IMU references. Synthetic labels '
  'are retained for experiments; Apple Watch labels are agreement-only.';

drop trigger if exists step_validation_sessions_updated_at on public.step_validation_sessions;
create trigger step_validation_sessions_updated_at
  before update on public.step_validation_sessions
  for each row execute function public.set_updated_at();

alter table public.apple_watch_step_buckets enable row level security;
alter table public.step_validation_sessions enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['apple_watch_step_buckets', 'step_validation_sessions']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
      t || '_select_own', t
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)',
      t || '_insert_own', t
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
      t || '_update_own', t
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)',
      t || '_delete_own', t
    );
  end loop;
end $$;

create or replace view public.step_validation_nonsynthetic
with (security_invoker = true) as
select
  id, user_id, requested_start, requested_end, scenario, device, firmware,
  wrist, participant_key, raw_imu_refs, label_source, true_count,
  event_timestamps, metadata, created_at, updated_at
from public.step_validation_sessions
where label_source <> 'synthetic';

comment on view public.step_validation_nonsynthetic is
  'Security-invoker validation rows excluding synthetic experiments. Apple Watch remains agreement-only.';

create or replace view public.step_validation_ground_truth
with (security_invoker = true) as
select
  id, user_id, requested_start, requested_end, scenario, device, firmware,
  wrist, participant_key, raw_imu_refs, label_source, true_count,
  event_timestamps, metadata, created_at, updated_at
from public.step_validation_sessions
where label_source = any (array['video_manual'::text, 'public_ground_truth'::text]);

comment on view public.step_validation_ground_truth is
  'Accuracy-eligible Steps V3 labels. Apple Watch agreement and synthetic rows are excluded.';

revoke all on table public.apple_watch_step_buckets from public, anon;
revoke all on table public.step_validation_sessions from public, anon;
revoke all on table public.step_validation_nonsynthetic from public, anon;
revoke all on table public.step_validation_ground_truth from public, anon;
grant select, insert, update, delete on public.apple_watch_step_buckets to authenticated;
grant select, insert, update, delete on public.step_validation_sessions to authenticated;
grant select on public.step_validation_nonsynthetic to authenticated;
grant select on public.step_validation_ground_truth to authenticated;
grant all on public.apple_watch_step_buckets to service_role;
grant all on public.step_validation_sessions to service_role;
grant select on public.step_validation_nonsynthetic to service_role;
grant select on public.step_validation_ground_truth to service_role;

revoke all on function public.healthkit_upsert_external(uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
drop function if exists public.healthkit_upsert_external(uuid, jsonb, jsonb, jsonb);

create function public.healthkit_upsert_external(
  p_user_id uuid,
  p_measurements jsonb default '[]'::jsonb,
  p_links jsonb default '[]'::jsonb,
  p_sessions jsonb default '[]'::jsonb,
  p_step_buckets jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb;
  n_meas integer := 0;
  n_links integer := 0;
  n_sess integer := 0;
  n_step_buckets integer := 0;
begin
  if p_user_id is null then
    raise exception 'user_id required' using errcode = '22023';
  end if;

  for r in select value from jsonb_array_elements(coalesce(p_measurements, '[]'::jsonb))
  loop
    if nullif(r->>'external_id', '') is null or nullif(r->>'source_system', '') is null then
      raise exception 'healthkit_measurement_missing_identity' using errcode = '22023';
    end if;
    insert into public.measurements (
      user_id, metric_type, measured_at, value, unit, source, source_system, external_id, quality, metadata
    ) values (
      p_user_id,
      r->>'metric_type',
      (r->>'measured_at')::timestamptz,
      nullif(r->>'value', '')::numeric,
      r->>'unit',
      coalesce(nullif(r->>'source', ''), r->>'source_system'),
      r->>'source_system',
      r->>'external_id',
      nullif(r->>'quality', '')::numeric,
      coalesce(r->'metadata', '{}'::jsonb)
    )
    on conflict (user_id, source_system, external_id) where external_id is not null
    do update set
      metric_type = excluded.metric_type,
      measured_at = excluded.measured_at,
      value = excluded.value,
      unit = excluded.unit,
      source = excluded.source,
      quality = excluded.quality,
      metadata = excluded.metadata,
      updated_at = now();
    n_meas := n_meas + 1;
  end loop;

  for r in select value from jsonb_array_elements(coalesce(p_links, '[]'::jsonb))
  loop
    if nullif(r->>'external_id', '') is null or nullif(r->>'external_source', '') is null then
      raise exception 'healthkit_link_missing_identity' using errcode = '22023';
    end if;
    insert into public.source_links (
      user_id, canonical_kind, canonical_id, external_source, external_id,
      sync_identifier, sync_version, match, confidence, relationship, payload, last_seen_at
    ) values (
      p_user_id,
      coalesce(r->>'canonical_kind', 'measurement'),
      nullif(r->>'canonical_id', '')::uuid,
      r->>'external_source',
      r->>'external_id',
      r->>'sync_identifier',
      coalesce(nullif(r->>'sync_version', '')::integer, 1),
      coalesce(r->>'match', 'uncertain'),
      nullif(r->>'confidence', '')::numeric,
      coalesce(r->>'relationship', 'associated'),
      coalesce(r->'payload', '{}'::jsonb),
      coalesce(nullif(r->>'last_seen_at', '')::timestamptz, now())
    )
    on conflict (user_id, external_source, external_id)
    do update set
      canonical_kind = excluded.canonical_kind,
      canonical_id = excluded.canonical_id,
      sync_identifier = excluded.sync_identifier,
      sync_version = excluded.sync_version,
      match = excluded.match,
      confidence = excluded.confidence,
      relationship = excluded.relationship,
      payload = excluded.payload,
      last_seen_at = excluded.last_seen_at,
      updated_at = now();
    n_links := n_links + 1;
  end loop;

  for r in select value from jsonb_array_elements(coalesce(p_sessions, '[]'::jsonb))
  loop
    if nullif(r->>'external_id', '') is null then
      raise exception 'healthkit_session_missing_external_id' using errcode = '22023';
    end if;
    insert into public.sessions (
      id, user_id, kind, source, external_id, start_at, end_at, summary, segments, quality, algorithm_version
    ) values (
      coalesce(nullif(r->>'id', '')::uuid, gen_random_uuid()),
      p_user_id,
      coalesce(r->>'kind', 'workout'),
      coalesce(r->>'source', 'apple_watch_healthkit'),
      r->>'external_id',
      (r->>'start_at')::timestamptz,
      (r->>'end_at')::timestamptz,
      coalesce(r->'summary', '{}'::jsonb),
      coalesce(r->'segments', '[]'::jsonb),
      coalesce(r->'quality', '{}'::jsonb),
      r->>'algorithm_version'
    )
    on conflict (user_id, source, external_id) where external_id is not null
    do update set
      start_at = case when public.sessions.user_modified then public.sessions.start_at else excluded.start_at end,
      end_at = case when public.sessions.user_modified then public.sessions.end_at else excluded.end_at end,
      summary = excluded.summary,
      segments = excluded.segments,
      quality = excluded.quality,
      algorithm_version = excluded.algorithm_version,
      updated_at = now();
    n_sess := n_sess + 1;
  end loop;

  for r in select value from jsonb_array_elements(coalesce(p_step_buckets, '[]'::jsonb))
  loop
    if nullif(r->>'device_fingerprint', '') is null
       or nullif(r->>'bucket_key', '') is null
       or nullif(r->>'bucket_start', '') is null then
      raise exception 'apple_watch_step_bucket_missing_identity' using errcode = '22023';
    end if;
    insert into public.apple_watch_step_buckets (
      user_id, device_fingerprint, bucket_start, bucket_size_seconds, bucket_key,
      step_count, allocated, coalesced, allocation_method, source_sample_ids,
      device_provenance, metadata
    ) values (
      p_user_id,
      r->>'device_fingerprint',
      (r->>'bucket_start')::timestamptz,
      (r->>'bucket_size_seconds')::integer,
      (r->>'bucket_key')::uuid,
      (r->>'step_count')::numeric,
      coalesce((r->>'allocated')::boolean, true),
      coalesce((r->>'coalesced')::boolean, false),
      r->>'allocation_method',
      array(select jsonb_array_elements_text(coalesce(r->'source_sample_ids', '[]'::jsonb))),
      coalesce(r->'device_provenance', '{}'::jsonb),
      coalesce(r->'metadata', '{}'::jsonb)
    )
    on conflict (user_id, device_fingerprint, bucket_start, bucket_size_seconds)
    do update set
      bucket_key = excluded.bucket_key,
      step_count = (
        select coalesce(sum(value::numeric), 0)
        from jsonb_each_text(
          coalesce(public.apple_watch_step_buckets.metadata->'allocations', '{}'::jsonb)
          || coalesce(excluded.metadata->'allocations', '{}'::jsonb)
        )
      ),
      allocated = public.apple_watch_step_buckets.allocated or excluded.allocated,
      coalesced = public.apple_watch_step_buckets.coalesced or excluded.coalesced,
      allocation_method = excluded.allocation_method,
      source_sample_ids = array(
        select distinct sample_id
        from unnest(
          public.apple_watch_step_buckets.source_sample_ids || excluded.source_sample_ids
        ) as sample_id
        order by sample_id
      ),
      device_provenance = public.apple_watch_step_buckets.device_provenance
        || excluded.device_provenance,
      metadata = jsonb_set(
        public.apple_watch_step_buckets.metadata || excluded.metadata,
        '{allocations}',
        coalesce(public.apple_watch_step_buckets.metadata->'allocations', '{}'::jsonb)
          || coalesce(excluded.metadata->'allocations', '{}'::jsonb),
        true
      ),
      updated_at = now();
    n_step_buckets := n_step_buckets + 1;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'measurements', n_meas,
    'links', n_links,
    'sessions', n_sess,
    'step_buckets', n_step_buckets
  );
end;
$$;

comment on function public.healthkit_upsert_external(uuid, jsonb, jsonb, jsonb, jsonb) is
  'Idempotent HealthKit ingest including non-canonical Apple Watch step reference buckets.';

revoke all on function public.healthkit_upsert_external(uuid, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.healthkit_upsert_external(uuid, jsonb, jsonb, jsonb, jsonb)
  to service_role;

commit;
