-- HealthKit ingest identity: explicit source_system + external_id uniqueness
-- that an RPC can target. PostgREST cannot ON CONFLICT a partial unique index,
-- so REST upserts on (user_id, source, external_id) silently failed.
--
-- Unique is (user_id, source_system, external_id): HealthKit UUIDs are
-- per-device store, not globally unique across FRWHOOP users.

begin;

alter table public.measurements
  add column if not exists source_system text;

update public.measurements
   set source_system = coalesce(nullif(source_system, ''), nullif(source, ''), 'manual')
 where source_system is null or source_system = '';

alter table public.measurements
  alter column source_system set default 'manual';

comment on column public.measurements.source_system is
  'Stable identity namespace for external_id (whoop_ble, apple_watch_healthkit, '
  'iphone_healthkit, third_party_healthkit, manual, frwhoop, frwhoop_derived). '
  'HealthKit ingest requires this plus external_id.';

-- Collapse any accidental duplicates before the unique index.
delete from public.measurements a
 using public.measurements b
 where a.external_id is not null
   and a.user_id = b.user_id
   and a.source_system = b.source_system
   and a.external_id = b.external_id
   and a.ctid < b.ctid;

create unique index if not exists measurements_source_system_external_uidx
  on public.measurements (user_id, source_system, external_id)
  where external_id is not null;

drop index if exists public.measurements_external_unique;

alter table public.measurements
  drop constraint if exists measurements_identity_check;
alter table public.measurements
  add constraint measurements_identity_check
  check (external_id is null or source_system is not null);

create or replace function public.healthkit_upsert_external(
  p_user_id uuid,
  p_measurements jsonb default '[]'::jsonb,
  p_links jsonb default '[]'::jsonb,
  p_sessions jsonb default '[]'::jsonb
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

  return jsonb_build_object(
    'ok', true,
    'measurements', n_meas,
    'links', n_links,
    'sessions', n_sess
  );
end;
$$;

comment on function public.healthkit_upsert_external(uuid, jsonb, jsonb, jsonb) is
  'Idempotent HealthKit ingest. Partial unique indexes cannot be targeted by PostgREST; this RPC uses ON CONFLICT ... WHERE. Fails closed on missing identity.';

revoke all on function public.healthkit_upsert_external(uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.healthkit_upsert_external(uuid, jsonb, jsonb, jsonb)
  to service_role;

commit;
