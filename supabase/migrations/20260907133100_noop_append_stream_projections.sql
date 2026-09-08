-- NOOP push projections: append streams shipped by the client but not yet ingested server-side.
-- Authoritative upsert targets; no BLE decode and no server-side scoring.

-- rrInterval: natural key (ts, rrMs, seq) — equal intervals in one second need seq in the PK.
create table if not exists public.noop_rr_intervals (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  source_id uuid not null,
  ts bigint not null,
  "rrMs" integer not null,
  seq integer not null,
  ord integer,
  "srcChannel" integer,
  "tsSuspect" integer,
  batch_id uuid not null,
  ingested_at timestamptz not null default now(),
  primary key (user_id, device_id, ts, "rrMs", seq)
);

create index if not exists noop_rr_intervals_user_ts_idx
  on public.noop_rr_intervals (user_id, ts desc);

alter table public.noop_rr_intervals enable row level security;

create policy "noop_rr_intervals_select_own"
  on public.noop_rr_intervals for select
  using (auth.uid() = user_id);

create policy "noop_rr_intervals_service_write"
  on public.noop_rr_intervals for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- event: natural key (ts, kind).
create table if not exists public.noop_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  source_id uuid not null,
  ts bigint not null,
  kind text not null,
  "payloadJSON" text not null,
  batch_id uuid not null,
  ingested_at timestamptz not null default now(),
  primary key (user_id, device_id, ts, kind)
);

create index if not exists noop_events_user_ts_idx
  on public.noop_events (user_id, ts desc);

alter table public.noop_events enable row level security;

create policy "noop_events_select_own"
  on public.noop_events for select
  using (auth.uid() = user_id);

create policy "noop_events_service_write"
  on public.noop_events for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- battery: natural key (ts).
create table if not exists public.noop_battery_samples (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  source_id uuid not null,
  ts bigint not null,
  soc double precision,
  mv integer,
  charging boolean,
  batch_id uuid not null,
  ingested_at timestamptz not null default now(),
  primary key (user_id, device_id, ts)
);

create index if not exists noop_battery_samples_user_ts_idx
  on public.noop_battery_samples (user_id, ts desc);

alter table public.noop_battery_samples enable row level security;

create policy "noop_battery_samples_select_own"
  on public.noop_battery_samples for select
  using (auth.uid() = user_id);

create policy "noop_battery_samples_service_write"
  on public.noop_battery_samples for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- spo2Sample: natural key (ts).
create table if not exists public.noop_spo2_samples (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  source_id uuid not null,
  ts bigint not null,
  red integer not null,
  ir integer not null,
  batch_id uuid not null,
  ingested_at timestamptz not null default now(),
  primary key (user_id, device_id, ts)
);

create index if not exists noop_spo2_samples_user_ts_idx
  on public.noop_spo2_samples (user_id, ts desc);

alter table public.noop_spo2_samples enable row level security;

create policy "noop_spo2_samples_select_own"
  on public.noop_spo2_samples for select
  using (auth.uid() = user_id);

create policy "noop_spo2_samples_service_write"
  on public.noop_spo2_samples for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- skinTempSample: natural key (ts).
create table if not exists public.noop_skin_temp_samples (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  source_id uuid not null,
  ts bigint not null,
  raw integer not null,
  "aux1Raw" integer,
  "aux2Raw" integer,
  batch_id uuid not null,
  ingested_at timestamptz not null default now(),
  primary key (user_id, device_id, ts)
);

create index if not exists noop_skin_temp_samples_user_ts_idx
  on public.noop_skin_temp_samples (user_id, ts desc);

alter table public.noop_skin_temp_samples enable row level security;

create policy "noop_skin_temp_samples_select_own"
  on public.noop_skin_temp_samples for select
  using (auth.uid() = user_id);

create policy "noop_skin_temp_samples_service_write"
  on public.noop_skin_temp_samples for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- respSample: natural key (ts).
create table if not exists public.noop_resp_samples (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  source_id uuid not null,
  ts bigint not null,
  raw integer not null,
  batch_id uuid not null,
  ingested_at timestamptz not null default now(),
  primary key (user_id, device_id, ts)
);

create index if not exists noop_resp_samples_user_ts_idx
  on public.noop_resp_samples (user_id, ts desc);

alter table public.noop_resp_samples enable row level security;

create policy "noop_resp_samples_select_own"
  on public.noop_resp_samples for select
  using (auth.uid() = user_id);

create policy "noop_resp_samples_service_write"
  on public.noop_resp_samples for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- gravitySample: natural key (ts).
create table if not exists public.noop_gravity_samples (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  source_id uuid not null,
  ts bigint not null,
  x double precision not null,
  y double precision not null,
  z double precision not null,
  "dynAccel" double precision,
  batch_id uuid not null,
  ingested_at timestamptz not null default now(),
  primary key (user_id, device_id, ts)
);

create index if not exists noop_gravity_samples_user_ts_idx
  on public.noop_gravity_samples (user_id, ts desc);

alter table public.noop_gravity_samples enable row level security;

create policy "noop_gravity_samples_select_own"
  on public.noop_gravity_samples for select
  using (auth.uid() = user_id);

create policy "noop_gravity_samples_service_write"
  on public.noop_gravity_samples for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
