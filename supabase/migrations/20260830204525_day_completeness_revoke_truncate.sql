-- TRUNCATE/REFERENCES/TRIGGER are table-level and bypass row RLS.
-- Authenticated clients may only SELECT day_completeness.

begin;

revoke truncate, references, trigger on table public.day_completeness from authenticated;
grant select on table public.day_completeness to authenticated;

commit;
