-- NOOP push projection: measured heart rate samples (authoritative upsert, no server scoring).
create table if not exists public.noop_hr_samples (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  source_id uuid not null,
  ts bigint not null,
  bpm integer not null,
  batch_id uuid not null,
  ingested_at timestamptz not null default now(),
  primary key (user_id, device_id, ts)
);

create index if not exists noop_hr_samples_user_ts_idx
  on public.noop_hr_samples (user_id, ts desc);

alter table public.noop_hr_samples enable row level security;

create policy "noop_hr_samples_select_own"
  on public.noop_hr_samples for select
  using (auth.uid() = user_id);

create policy "noop_hr_samples_service_write"
  on public.noop_hr_samples for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
