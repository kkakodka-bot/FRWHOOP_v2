-- Trigger helpers must not be callable via PostgREST.
-- Table owners still fire BEFORE/AFTER triggers without client EXECUTE.

revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.touch_versioned_row() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;

grant execute on function public.set_updated_at() to postgres, service_role;
grant execute on function public.touch_versioned_row() to postgres, service_role;
grant execute on function public.handle_new_user() to postgres, service_role;
