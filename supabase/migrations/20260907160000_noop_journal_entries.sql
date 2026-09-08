-- NOOP push projection: daily Q&A journal entries (authoritative replace-window upsert).

create table if not exists public.noop_journal_entries (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  source_id uuid not null,
  day date not null,
  question text not null,
  answered_yes boolean not null,
  notes text,
  numeric_value double precision,
  batch_id uuid not null,
  replacement_id uuid not null,
  ingested_at timestamptz not null default now(),
  primary key (user_id, device_id, day, question)
);

create index if not exists noop_journal_entries_user_day_idx
  on public.noop_journal_entries (user_id, day desc);

alter table public.noop_journal_entries enable row level security;

create policy "noop_journal_entries_select_own"
  on public.noop_journal_entries for select
  using (auth.uid() = user_id);

create policy "noop_journal_entries_service_write"
  on public.noop_journal_entries for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
