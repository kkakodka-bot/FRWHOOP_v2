-- Weight, nutrition, and longitudinal energy-balance (TDEE) subsystem.
--
-- Adds the data model needed to run the independent energy-balance TDEE
-- estimator from food intake + body weight, and to support future personal
-- calibration. Kept deliberately non-fragmented: one weight table, one nutrition
-- table (macros inline), one energy-balance-estimate table, and thin
-- provenance columns on each. Raw high-frequency sensor data stays in B2; these
-- tables hold compact, queryable inputs and outputs.
--
-- Accounting: the longitudinal filter produces a *physiological TDEE* estimate
-- that already includes TEF. It is stored separately from the sensor model and
-- is fed in only as a slow, weak reference (never as the evaluation target of
-- the same filter). See docs/ENERGY_ACCOUNTING.md.

begin;

-- ---------------------------------------------------------------------------
-- Body weight measurements
-- ---------------------------------------------------------------------------
create table if not exists public.body_weight_measurements (
  user_id uuid not null references auth.users(id) on delete cascade,
  measured_at timestamptz not null,
  weight_kg numeric(6,3) not null,
  source text not null default 'manual',           -- manual | scale_api | import
  quality text not null default 'ok',              -- ok | doubtful | rejected
  note text,
  created_at timestamptz not null default now(),
  primary key (user_id, measured_at),
  constraint body_weight_measurements_kg_check
    check (weight_kg > 20 and weight_kg < 350),
  constraint body_weight_measurements_quality_check
    check (quality = any (array['ok'::text, 'doubtful'::text, 'rejected'::text]))
);

comment on table public.body_weight_measurements is
  'Morning scale readings, the measurement input to the energy-balance TDEE '
  'filter. quality gates let a rejected reading be excluded without deleting it.';

create index if not exists body_weight_measurements_user_time_idx
  on public.body_weight_measurements (user_id, measured_at);

-- ---------------------------------------------------------------------------
-- Nutrition days (macros inline; no per-meal fragmentation needed yet)
-- ---------------------------------------------------------------------------
create table if not exists public.nutrition_days (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  timezone_name text not null default 'UTC',
  intake_kcal numeric(9,1) not null,
  protein_kcal numeric(9,1),
  carbs_kcal numeric(9,1),
  fat_kcal numeric(9,1),
  macros_complete boolean not null default false,
  missing_meals integer not null default 0 check (missing_meals >= 0),
  logging_quality text not null default 'full',    -- full | partial | none
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, day),
  constraint nutrition_days_intake_check check (intake_kcal >= 0),
  constraint nutrition_days_logging_check
    check (logging_quality = any (array['full'::text, 'partial'::text, 'none'::text]))
);

comment on table public.nutrition_days is
  'One row per user-day of logged intake. macros_complete and missing_meals '
  'drive strict completeness gating: partial logging is excluded from '
  'energy-balance calibration because missing intake looks like low expenditure.';

create index if not exists nutrition_days_user_day_idx
  on public.nutrition_days (user_id, day desc);

-- ---------------------------------------------------------------------------
-- Longitudinal energy-balance (TDEE) estimates
-- ---------------------------------------------------------------------------
create table if not exists public.energy_balance_estimates (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  mode text not null default 'filter',             -- filter | smoothing
  tdee_kcal numeric(9,2) not null,
  tdee_sd_kcal numeric(9,2),
  trend_kg numeric(6,3),
  fluid_kg numeric(6,3),
  energy_density_kcal_per_kg numeric(8,1) not null default 7700,
  data_completeness text not null default 'partial',
  quality_reasons text[] not null default '{}',
  model_version text references public.energy_model_versions(version),
  parameters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, day, mode, model_version),
  constraint energy_balance_estimates_tdee_check check (tdee_kcal > 0),
  constraint energy_balance_estimates_tdeesd_check
    check (tdee_sd_kcal is null or (tdee_sd_kcal >= 0 and tdee_sd_kcal <= 4000))
);

comment on table public.energy_balance_estimates is
  'Per-day posterior from the longitudinal food+weight TDEE filter. Every row '
  'records model_version, the input window, data completeness, the posterior '
  'estimate, its uncertainty, and the parameters used, so any historical estimate '
  'is reproducible. This is the independent shadow estimator: it never consumes '
  'the sensor calorie value.';

create index if not exists energy_balance_estimates_user_day_idx
  on public.energy_balance_estimates (user_id, day desc);

-- ---------------------------------------------------------------------------
-- RLS: users can read their own; nothing unauthenticated.
-- ---------------------------------------------------------------------------
alter table public.body_weight_measurements enable row level security;
alter table public.nutrition_days enable row level security;
alter table public.energy_balance_estimates enable row level security;

drop policy if exists body_weight_measurements_owner_select on public.body_weight_measurements;
create policy body_weight_measurements_owner_select on public.body_weight_measurements
  for select using (auth.uid() = user_id);
drop policy if exists body_weight_measurements_owner_insert on public.body_weight_measurements;
create policy body_weight_measurements_owner_insert on public.body_weight_measurements
  for insert with check (auth.uid() = user_id);
drop policy if exists body_weight_measurements_owner_update on public.body_weight_measurements;
create policy body_weight_measurements_owner_update on public.body_weight_measurements
  for update using (auth.uid() = user_id);
drop policy if exists body_weight_measurements_owner_delete on public.body_weight_measurements;
create policy body_weight_measurements_owner_delete on public.body_weight_measurements
  for delete using (auth.uid() = user_id);

drop policy if exists nutrition_days_owner_select on public.nutrition_days;
create policy nutrition_days_owner_select on public.nutrition_days
  for select using (auth.uid() = user_id);
drop policy if exists nutrition_days_owner_insert on public.nutrition_days;
create policy nutrition_days_owner_insert on public.nutrition_days
  for insert with check (auth.uid() = user_id);
drop policy if exists nutrition_days_owner_update on public.nutrition_days;
create policy nutrition_days_owner_update on public.nutrition_days
  for update using (auth.uid() = user_id);
drop policy if exists nutrition_days_owner_delete on public.nutrition_days;
create policy nutrition_days_owner_delete on public.nutrition_days
  for delete using (auth.uid() = user_id);

drop policy if exists energy_balance_estimates_owner_select on public.energy_balance_estimates;
create policy energy_balance_estimates_owner_select on public.energy_balance_estimates
  for select using (auth.uid() = user_id);
drop policy if exists energy_balance_estimates_owner_insert on public.energy_balance_estimates;
create policy energy_balance_estimates_owner_insert on public.energy_balance_estimates
  for insert with check (auth.uid() = user_id);
drop policy if exists energy_balance_estimates_owner_update on public.energy_balance_estimates;
create policy energy_balance_estimates_owner_update on public.energy_balance_estimates
  for update using (auth.uid() = user_id);
drop policy if exists energy_balance_estimates_owner_delete on public.energy_balance_estimates;
create policy energy_balance_estimates_owner_delete on public.energy_balance_estimates
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Timestamps
-- ---------------------------------------------------------------------------
drop trigger if exists nutrition_days_touch on public.nutrition_days;
create trigger nutrition_days_touch before update on public.nutrition_days
  for each row execute function public.set_updated_at();

commit;
