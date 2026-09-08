-- Additive harden of DayCompleteness: service-role is the only writer of the
-- gate, gap resolution is monotonic, and authenticated clients may only read.

begin;

revoke insert, update, delete on table public.day_completeness from authenticated;
grant select on table public.day_completeness to authenticated;
drop policy if exists day_completeness_write_own on public.day_completeness;

alter table public.ingest_gaps drop constraint if exists ingest_gaps_resolution_check;
alter table public.ingest_gaps
  add constraint ingest_gaps_resolution_check
  check (resolution is null or resolution = any (array[
    'backfilled'::text,
    'unrecoverable'::text,
    'strap_trimmed'::text,
    'manual'::text
  ]));

comment on column public.ingest_gaps.resolution is
  'Monotonic close-out: unresolved -> backfilled | unrecoverable. Never reopens.';

create or replace function public.engine_resolve_ingest_gaps(
  p_secret text,
  p_user_id uuid,
  p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, internal
as $$
declare
  v_n integer := 0;
  v_row jsonb;
begin
  perform internal.assert_ingest_secret(p_secret);
  if p_user_id is null then
    raise exception 'user_id required';
  end if;
  for v_row in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    update public.ingest_gaps
       set resolved_at = coalesce(resolved_at, coalesce((v_row->>'resolved_at')::timestamptz, now())),
           resolution = coalesce(resolution, nullif(v_row->>'resolution', '')),
           meta = coalesce(meta, '{}'::jsonb) || coalesce(v_row->'meta', '{}'::jsonb)
     where id = (v_row->>'id')::uuid
       and user_id = p_user_id
       and resolved_at is null;
    if found then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

revoke all on function public.engine_resolve_ingest_gaps(text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.engine_resolve_ingest_gaps(text, uuid, jsonb)
  to anon, service_role;

commit;
