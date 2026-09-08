-- Stale positive step totals must not survive a recomputation that finds
-- no step samples (status = unavailable). engine_ingest_upsert coalesces
-- null incoming steps onto the existing scalar; this trigger clears the
-- column when the engine explicitly reports unavailable.

create or replace function public.daily_metrics_steps_recompute()
returns trigger
language plpgsql
as $$
begin
  if new.confidence ? 'steps'
     and coalesce(new.confidence->'steps'->>'status', '') = 'unavailable' then
    new.steps := null;
  end if;
  return new;
end;
$$;

drop trigger if exists daily_metrics_steps_recompute on public.daily_metrics;
create trigger daily_metrics_steps_recompute
  before insert or update of steps, confidence
  on public.daily_metrics
  for each row execute function public.daily_metrics_steps_recompute();
