-- Historical remote migration 20260824172642_engine_rpcs_canonical
-- This file exists so repository migration versions match the deployed
-- Supabase project. It is a no-op: the objects were already applied on
-- production, and a greenfield rebuild should load a schema dump taken
-- from the live project rather than re-running these historical steps.
select 1;
