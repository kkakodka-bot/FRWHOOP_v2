-- NOOP push projections still missing as of 2026-09-11 (additive; expand/contract).
-- Streams sleepStateSample / ppgHrSample / ouraRaw / labMarker / liveSession are named in
-- supabase/functions/_shared/registry.ts but had no projection tables, so a client pushing one
-- of these streams would fail the upsert. Additive tables only; nothing is altered or dropped.

-- sleepStateSample: per-second band sleep-state (@81 high nibble), one row per strap-second.
create table if not exists public.noop_sleep_state_samples (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  source_id uuid not null,
  ts bigint not null,
  state integer not null,
  raw_byte integer,
  batch_id uuid not null,
  ingested_at timestamptz not null default now(),
  primary key (user_id, device_id, ts)
);

create index if not exists noop_sleep_state_samples_user_ts_idx
  on public.noop_sleep_state_samples (user_id, ts desc);

alter table public.noop_sleep_state_samples enable row level security;

create policy "noop_sleep_state_samples_select_own"
  on public.noop_sleep_state_samples for select
  using (auth.uid() = user_id);

create policy "noop_sleep_state_samples_service_write"
  on public.noop_sleep_state_samples for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ppgHrSample: PPG-derived HR kept separate from measured HR.
create table if not exists public.noop_ppg_hr_samples (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  source_id uuid not null,
  ts bigint not null,
  bpm integer not null,
  conf double precision,
  batch_id uuid not null,
  ingested_at timestamptz not null default now(),
  primary key (user_id, device_id, ts)
);

create index if not exists noop_ppg_hr_samples_user_ts_idx
  on public.noop_ppg_hr_samples (user_id, ts desc);

alter table public.noop_ppg_hr_samples enable row level security;

create policy "noop_ppg_hr_samples_select_own"
  on public.noop_ppg_hr_samples for select
  using (auth.uid() = user_id);

create policy "noop_ppg_hr_samples_service_write"
  on public.noop_ppg_hr_samples for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ouraRaw: verbatim Oura API pages from the iOS import, keyed by the page's own id.
create table if not exists public.noop_oura_raw (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  source_id uuid not null,
  page_key text not null,
  ts bigint,
  payload jsonb not null,
  batch_id uuid not null,
  ingested_at timestamptz not null default now(),
  primary key (user_id, device_id, page_key)
);

create index if not exists noop_oura_raw_user_ts_idx
  on public.noop_oura_raw (user_id, ts desc);

alter table public.noop_oura_raw enable row level security;

create policy "noop_oura_raw_select_own"
  on public.noop_oura_raw for select
  using (auth.uid() = user_id);

create policy "noop_oura_raw_service_write"
  on public.noop_oura_raw for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- labMarker: Lab Book blood panels; replace-window per day (14-day rolling window).
create table if not exists public.noop_lab_markers (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  source_id uuid not null,
  day date not null,
  panel jsonb not null,
  batch_id uuid not null,
  replacement_id uuid not null,
  ingested_at timestamptz not null default now(),
  primary key (user_id, device_id, day)
);

create index if not exists noop_lab_markers_user_day_idx
  on public.noop_lab_markers (user_id, day desc);

alter table public.noop_lab_markers enable row level security;

create policy "noop_lab_markers_select_own"
  on public.noop_lab_markers for select
  using (auth.uid() = user_id);

create policy "noop_lab_markers_service_write"
  on public.noop_lab_markers for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- liveSession: silent-guardian coaching sessions; replace-window keyed by session id.
create table if not exists public.noop_live_sessions (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  source_id uuid not null,
  session_id uuid not null,
  started_at timestamptz,
  ended_at timestamptz,
  payload jsonb not null,
  batch_id uuid not null,
  replacement_id uuid not null,
  ingested_at timestamptz not null default now(),
  primary key (user_id, device_id, session_id)
);

create index if not exists noop_live_sessions_user_started_idx
  on public.noop_live_sessions (user_id, started_at desc);

alter table public.noop_live_sessions enable row level security;

create policy "noop_live_sessions_select_own"
  on public.noop_live_sessions for select
  using (auth.uid() = user_id);

create policy "noop_live_sessions_service_write"
  on public.noop_live_sessions for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
