-- Settings + integration connection tables for the FRWHOOP app.
-- Server-only access: RLS enabled with no public policies. The backend
-- reaches them either with the service role key (bypasses RLS) or via the
-- secret-gated app_* RPCs (see 20260824140000_app_settings_rpcs.sql).

create table if not exists public.user_settings (
  user_key text primary key,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.user_settings is 'App settings/preferences blob per user key. Server-only (RLS: no public policies).';

create table if not exists public.integration_connections (
  user_key text not null,
  provider text not null,
  status text not null default 'disconnected',
  tokens jsonb not null default '{}'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  connected_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_key, provider)
);

comment on table public.integration_connections is 'Health/app integration state incl. OAuth tokens. Server-only (RLS: no public policies).';

alter table public.user_settings enable row level security;
alter table public.integration_connections enable row level security;

-- updated_at maintenance (set_updated_at() is created by the base schema).
drop trigger if exists user_settings_updated_at on public.user_settings;
create trigger user_settings_updated_at before update on public.user_settings
  for each row execute function set_updated_at();

drop trigger if exists integration_connections_updated_at on public.integration_connections;
create trigger integration_connections_updated_at before update on public.integration_connections
  for each row execute function set_updated_at();
