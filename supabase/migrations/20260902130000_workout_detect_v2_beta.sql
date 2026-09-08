-- Workout Detect V2 is canonical for this beta build.
-- Only bump shipped defaults (1.2.0 / 1.3.0). Explicit 2.x-shadow or other
-- versions stay put so a tester rollback remains a one-setting change.

alter table public.user_settings
  alter column auto_workout_detector_version set default '2.2.1-beta';

update public.user_settings
set auto_workout_detector_version = '2.2.1-beta'
where auto_workout_detector_version in ('1.2.0', '1.3.0');

update public.user_settings
set extra_settings = jsonb_set(
  coalesce(extra_settings, '{}'::jsonb),
  '{auto_workout_detector_version}',
  to_jsonb('2.2.1-beta'::text)
)
where extra_settings ? 'auto_workout_detector_version'
  and extra_settings->>'auto_workout_detector_version' in ('1.2.0', '1.3.0');

comment on column public.user_settings.auto_workout_detector_version is
  'Canonical auto-detect version. 2.2.1-beta is the beta default; 1.3.0 rolls back to V1.';
