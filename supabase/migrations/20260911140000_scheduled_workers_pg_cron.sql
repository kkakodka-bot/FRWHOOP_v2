-- Phase 2: schedule Edge worker functions via pg_cron -> pg_net (additive).
-- Workers: retention-sweep, reconcile, account-deletion (supabase/functions/*).
-- Auth: each function accepts `Authorization: Bearer <WORKER_SECRET>` matching the function env
-- secret set with `supabase secrets set WORKER_SECRET=...`. The bearer is stored here in Vault so
-- no secret is committed to this file. Fill the two placeholders once per environment:
--   select vault.update_secret((select id from vault.secrets where name='edge_worker_secret'), '<WORKER_SECRET>');
--   select vault.update_secret((select id from vault.secrets where name='edge_worker_base_url'), '<https://project-ref.supabase.co>');
-- Until then the cron jobs run and resolve an empty secret -> functions return 401 (safe no-op).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Placeholder secrets (empty until ops fills them). Rows exist so the schedule SQL is stable.
select vault.create_secret('', 'edge_worker_secret')
where not exists (select 1 from vault.secrets where name = 'edge_worker_secret');
select vault.create_secret('', 'edge_worker_base_url')
where not exists (select 1 from vault.secrets where name = 'edge_worker_base_url');

-- One common invoker: POST to an edge function with the worker bearer.
create or replace function public.http_post_worker(fn_path text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  base text;
  secret text;
  res bigint;
begin
  select decrypted_secret into base from vault.decrypted_secrets where name = 'edge_worker_base_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'edge_worker_secret';
  if base is null or base = '' or secret is null or secret = '' then
    return 0;
  end if;
  select status into res from net.http_post(
    url := base || fn_path,
    headers := jsonb_build_object('authorization', 'Bearer ' || secret, 'content-type', 'application/json'),
    body := '{}'::jsonb
  );
  return res;
end;
$$;

-- Retention sweep: hourly on the hour. Idempotent: unschedule then schedule.
do $sch$
begin
  begin
    perform cron.unschedule('frwhoop-retention-sweep');
  exception when others then null;  -- job absent on a fresh DB
  end;
  perform cron.schedule('frwhoop-retention-sweep', '0 * * * *',
    $cmd$ select public.http_post_worker('/functions/v1/retention-sweep') $cmd$);
end $sch$;

-- Manifest reconcile: every 6 hours (matches the retired Node interval).
do $sch$
begin
  begin
    perform cron.unschedule('frwhoop-reconcile');
  exception when others then null;
  end;
  perform cron.schedule('frwhoop-reconcile', '0 */6 * * *',
    $cmd$ select public.http_post_worker('/functions/v1/reconcile') $cmd$);
end $sch$;

-- Account deletion: retry runner every 15 minutes; it only acts when a pending/blocked job exists.
do $sch$
begin
  begin
    perform cron.unschedule('frwhoop-account-deletion');
  exception when others then null;
  end;
  perform cron.schedule('frwhoop-account-deletion', '*/15 * * * *',
    $cmd$ select public.http_post_worker('/functions/v1/account-deletion') $cmd$);
end $sch$;
