-- HealthKit interoperability: source links between canonical FRWHOOP events
-- and external Apple Health samples. Does not copy the Health store.
-- Raw WHOOP telemetry stays in B2. Canonical metrics stay on daily_metrics.

begin;

create table if not exists public.source_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  canonical_kind text not null,
  canonical_id uuid,
  external_source text not null,
  external_id text not null,
  sync_identifier text,
  sync_version integer not null default 1,
  match text not null,
  confidence numeric,
  relationship text not null default 'associated',
  payload jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_links_kind_check check (canonical_kind = any (array[
    'workout'::text, 'sleep'::text, 'nap'::text, 'event'::text, 'measurement'::text, 'vital'::text
  ])),
  constraint source_links_match_check check (match = any (array[
    'same_workout'::text, 'likely_same_workout'::text, 'different_workout'::text,
    'same_sleep'::text, 'likely_same_sleep'::text, 'different_sleep'::text, 'uncertain'::text
  ])),
  constraint source_links_rel_check check (relationship = any (array[
    'associated'::text, 'comparison'::text, 'validation'::text, 'fallback'::text,
    'skip_write'::text, 'write'::text, 'enrichment'::text
  ])),
  constraint source_links_version_check check (sync_version >= 1),
  constraint source_links_confidence_check check (
    confidence is null or (confidence >= 0 and confidence <= 1)
  )
);

comment on table public.source_links is
  'Links a canonical FRWHOOP session/event to an external HealthKit object. '
  'Apple-owned samples are never modified; this table only records the relationship.';

create unique index if not exists source_links_external_unique
  on public.source_links (user_id, external_source, external_id);

create index if not exists source_links_canonical_idx
  on public.source_links (user_id, canonical_kind, canonical_id);

create index if not exists source_links_sync_idx
  on public.source_links (user_id, sync_identifier)
  where sync_identifier is not null;

drop trigger if exists source_links_updated_at on public.source_links;
create trigger source_links_updated_at
  before update on public.source_links
  for each row execute function public.set_updated_at();

alter table public.source_links enable row level security;

drop policy if exists source_links_owner_select on public.source_links;
create policy source_links_owner_select on public.source_links
  for select using (auth.uid() = user_id);

drop policy if exists source_links_owner_insert on public.source_links;
create policy source_links_owner_insert on public.source_links
  for insert with check (auth.uid() = user_id);

drop policy if exists source_links_owner_update on public.source_links;
create policy source_links_owner_update on public.source_links
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists source_links_owner_delete on public.source_links;
create policy source_links_owner_delete on public.source_links
  for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.source_links to authenticated;
grant all on public.source_links to service_role;

-- HealthKit sync cursors live on-device (HKQueryAnchor). Integration row holds last success.
comment on column public.integration_connections.meta is
  'Provider metadata. For apple_health: authorization, platform, permission groups, last ingest stats. '
  'Binary HealthKit anchors are not stored here.';

commit;
