-- Repair the authenticated read path for the canonical day RPCs.
--
-- public.get_days / public.get_day_snapshot are SECURITY INVOKER and read
-- public.daily_metrics, public.sleep_details, public.sessions and
-- public.events. Those tables have RLS enabled but, until this migration,
-- carried no authenticated SELECT policy and no SELECT grant, so the
-- frontend's primary direct-to-Supabase day reads failed with permission
-- denied and the app silently fell back to the service-role /api/days proxy.
--
-- Read-only, owner-scoped: an authenticated user may read only rows whose
-- user_id is their own auth.uid(). No writes, no service-role weakening.

-- SELECT grants for the four tables the day RPCs read.
grant select on public.daily_metrics to authenticated;
grant select on public.sleep_details to authenticated;
grant select on public.sessions to authenticated;
grant select on public.events to authenticated;

-- Owner-scoped SELECT policies (idempotent; drop-then-create matches the
-- style of 20260824190000_settings_identity_canonical.sql).
drop policy if exists daily_metrics_select_own on public.daily_metrics;
create policy daily_metrics_select_own on public.daily_metrics
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists sleep_details_select_own on public.sleep_details;
create policy sleep_details_select_own on public.sleep_details
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists sessions_select_own on public.sessions;
create policy sessions_select_own on public.sessions
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists events_select_own on public.events;
create policy events_select_own on public.events
  for select to authenticated
  using ((select auth.uid()) = user_id);
