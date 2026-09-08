-- NOOP push replace_window staging, durable across edge-function isolates.
-- The Node backend stages multi-part replacement windows in process memory; the Supabase Edge
-- Function port cannot (isolates are stateless), so parts land here until the window completes.

create table if not exists public.noop_push_staging_parts (
  user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null,
  replacement_id text not null,
  window_identity text not null,
  part integer not null,
  parts_total integer not null,
  batch_id text not null,
  body_sha256 text not null,
  records jsonb not null,
  created_at timestamptz not null default now(),
  constraint noop_push_staging_parts_body_sha256_len check (char_length(body_sha256) = 64),
  constraint noop_push_staging_parts_body_sha256_hex check (body_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (user_id, scope, replacement_id, part)
);

alter table public.noop_push_staging_parts enable row level security;

create policy "noop_push_staging_parts_service_all"
  on public.noop_push_staging_parts for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
