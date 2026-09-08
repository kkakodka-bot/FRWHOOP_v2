-- NOOP push ingest durability: cross-instance WAL, ack idempotency, and per-user quota.

create table if not exists public.noop_push_wal (
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id uuid not null,
  stream text not null,
  device_id text not null default '',
  source_id uuid,
  record_count integer not null default 0,
  body_sha256 text not null,
  received_at timestamptz not null,
  constraint noop_push_wal_body_sha256_len check (char_length(body_sha256) = 64),
  constraint noop_push_wal_body_sha256_hex check (body_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (user_id, batch_id)
);

create index if not exists noop_push_wal_user_received_idx
  on public.noop_push_wal (user_id, received_at desc);

create table if not exists public.noop_push_acks (
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id uuid not null,
  body_sha256 text not null,
  ack jsonb not null,
  saved_at timestamptz not null default now(),
  constraint noop_push_acks_body_sha256_len check (char_length(body_sha256) = 64),
  constraint noop_push_acks_body_sha256_hex check (body_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (user_id, batch_id)
);

create table if not exists public.noop_push_ingest_quota (
  user_id uuid not null references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  batch_count integer not null default 0,
  byte_count bigint not null default 0,
  primary key (user_id, window_start)
);

alter table public.noop_push_wal enable row level security;
alter table public.noop_push_acks enable row level security;
alter table public.noop_push_ingest_quota enable row level security;

create policy "noop_push_wal_service_all"
  on public.noop_push_wal for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "noop_push_acks_service_all"
  on public.noop_push_acks for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "noop_push_ingest_quota_service_all"
  on public.noop_push_ingest_quota for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Atomically save an ack; rejects body_sha256 mismatch for an existing batch_id.
create or replace function public.noop_push_save_ack(
  p_user_id uuid,
  p_batch_id uuid,
  p_body_sha256 text,
  p_ack jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing text;
begin
  select body_sha256 into v_existing
  from public.noop_push_acks
  where user_id = p_user_id and batch_id = p_batch_id;

  if v_existing is not null and v_existing <> p_body_sha256 then
    raise exception 'batch_id_conflict' using errcode = '23505';
  end if;

  insert into public.noop_push_acks (user_id, batch_id, body_sha256, ack)
  values (p_user_id, p_batch_id, p_body_sha256, p_ack)
  on conflict (user_id, batch_id) do update
    set ack = excluded.ack,
        saved_at = now()
  where public.noop_push_acks.body_sha256 = excluded.body_sha256;
end;
$$;

revoke all on function public.noop_push_save_ack(uuid, uuid, text, jsonb) from public;
grant execute on function public.noop_push_save_ack(uuid, uuid, text, jsonb) to service_role;

-- Reserve ingest quota for one batch; rolls back the increment when limits are exceeded.
create or replace function public.noop_push_consume_ingest_quota(
  p_user_id uuid,
  p_bytes bigint,
  p_max_batches integer,
  p_max_bytes bigint,
  p_window_seconds integer
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz;
  v_batches integer;
  v_bytes bigint;
begin
  if p_max_batches <= 0 or p_max_bytes <= 0 or p_window_seconds <= 0 then
    return;
  end if;

  v_window := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.noop_push_ingest_quota (user_id, window_start, batch_count, byte_count)
  values (p_user_id, v_window, 1, p_bytes)
  on conflict (user_id, window_start) do update
    set batch_count = public.noop_push_ingest_quota.batch_count + 1,
        byte_count = public.noop_push_ingest_quota.byte_count + excluded.byte_count
  returning batch_count, byte_count into v_batches, v_bytes;

  if v_batches > p_max_batches or v_bytes > p_max_bytes then
    update public.noop_push_ingest_quota
    set batch_count = greatest(batch_count - 1, 0),
        byte_count = greatest(byte_count - p_bytes, 0)
    where user_id = p_user_id and window_start = v_window;
    raise exception 'ingest_quota_exceeded' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.noop_push_consume_ingest_quota(uuid, bigint, integer, bigint, integer) from public;
grant execute on function public.noop_push_consume_ingest_quota(uuid, bigint, integer, bigint, integer) to service_role;
