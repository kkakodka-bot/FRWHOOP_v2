-- Long-lived opaque NOOP push ingest tokens (hashed at rest; plaintext shown once at mint).
create table if not exists public.noop_ingest_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null,
  label text not null default '',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  constraint noop_ingest_tokens_token_hash_len check (char_length(token_hash) = 64),
  constraint noop_ingest_tokens_token_hash_hex check (token_hash ~ '^[0-9a-f]{64}$')
);

create unique index if not exists noop_ingest_tokens_token_hash_uidx
  on public.noop_ingest_tokens (token_hash);

create index if not exists noop_ingest_tokens_user_created_idx
  on public.noop_ingest_tokens (user_id, created_at desc);

alter table public.noop_ingest_tokens enable row level security;

create policy "noop_ingest_tokens_select_own"
  on public.noop_ingest_tokens for select
  using (auth.uid() = user_id);

create policy "noop_ingest_tokens_insert_own"
  on public.noop_ingest_tokens for insert
  with check (auth.uid() = user_id);

create policy "noop_ingest_tokens_update_own"
  on public.noop_ingest_tokens for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "noop_ingest_tokens_service_all"
  on public.noop_ingest_tokens for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
