-- Live get_day_snapshot. Edit this file, not older copies.
-- HR coverage counts occupied buckets (finite avg_hr/bpm), matching JS buildAvailability.

create or replace function public.hr_series_occupied_buckets(p_series jsonb)
returns integer
language sql
immutable
set search_path = pg_catalog, public
as $$
  select count(*)::int
  from jsonb_array_elements(coalesce(p_series, '[]'::jsonb)) elem
  where jsonb_typeof(coalesce(
    nullif(elem->'avg_hr', 'null'::jsonb),
    nullif(elem->'bpm', 'null'::jsonb)
  )) = 'number';
$$;

grant execute on function public.hr_series_occupied_buckets(jsonb) to authenticated, service_role;
revoke all on function public.hr_series_occupied_buckets(jsonb) from public, anon;
