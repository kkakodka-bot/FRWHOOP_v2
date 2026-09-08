-- ---------------------------------------------------------------------------
-- day_completeness: the canonical finalize gate for 24h data continuity.
-- One row per user per local day. Written only through the canonical
-- metrics/dayCompleteness.js computation; status 'complete'/'degraded' is the
-- only allowed finalized state, and a finalized day can never contain a
-- recoverable or unclassified gap.
-- ---------------------------------------------------------------------------
create table if not exists public.day_completeness (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  timezone_name text not null default 'UTC',
  status text not null default 'open'
    constraint day_completeness_status_check check (status in ('open','complete','degraded')),
  result jsonb not null default '{}'::jsonb,
  finalized_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create index if not exists day_completeness_updated_idx
  on public.day_completeness (user_id, updated_at desc);

drop trigger if exists day_completeness_updated on public.day_completeness;
create trigger day_completeness_updated
  before update on public.day_completeness
  for each row execute function public.set_updated_at();

alter table public.day_completeness enable row level security;
revoke all on table public.day_completeness from public, anon;
grant select, insert, update, delete on table public.day_completeness to authenticated;
grant all on table public.day_completeness to service_role;

drop policy if exists day_completeness_select_own on public.day_completeness;
drop policy if exists day_completeness_write_own on public.day_completeness;
create policy day_completeness_select_own on public.day_completeness
  for select to authenticated using (user_id = (select auth.uid()));
create policy day_completeness_write_own on public.day_completeness
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

comment on table public.day_completeness is
  'Canonical finalize gate for 24h data continuity. status open = ambiguous or in progress; complete = zero recoverable/unclassified gaps with verified raw archive; degraded = reconciliation finished with known unrecoverable loss. result holds the full computeDayCompleteness record.';

-- ---------------------------------------------------------------------------
-- ingest_gaps: provenance + resolution so backfill can close gaps explicitly.
-- ---------------------------------------------------------------------------
alter table public.ingest_gaps add column if not exists provenance text;
alter table public.ingest_gaps add column if not exists resolved_at timestamptz;
alter table public.ingest_gaps add column if not exists resolution text;

create index if not exists ingest_gaps_open_idx
  on public.ingest_gaps (user_id, start_at)
  where resolved_at is null;

comment on column public.ingest_gaps.provenance is
  'gapProvenance GAP_CLASS or upstream evidence label recorded when the gap was written.';
comment on column public.ingest_gaps.resolved_at is
  'Set when later data (history backfill) covers the interval; resolved gaps are never open loss.';
comment on column public.ingest_gaps.resolution is
  'How the gap closed, e.g. backfilled, strap_trimmed, manual.';
