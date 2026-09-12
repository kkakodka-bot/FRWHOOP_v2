-- Reconcile can exceed pg_net's default 5s timeout; raise worker POST budget to 120s.

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
  select net.http_post(
    url := base || fn_path,
    headers := jsonb_build_object('authorization', 'Bearer ' || secret, 'content-type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) into res;
  return res;
end;
$$;
