-- Remote Workout Mode feature flags as first-class user_settings columns.
-- Dual-read with extra_settings keys of the same names. Strap buzz defaults OFF (shadow).

alter table public.user_settings
  add column if not exists auto_workout_haptics_enabled boolean not null default false,
  add column if not exists auto_workout_motion_required boolean not null default false,
  add column if not exists auto_workout_min_confidence text not null default 'standard',
  add column if not exists auto_workout_detector_version text not null default '1.2.0',
  add column if not exists auto_workout_rollout_percentage integer not null default 100;

alter table public.user_settings
  drop constraint if exists user_settings_auto_workout_min_confidence_check;
alter table public.user_settings
  add constraint user_settings_auto_workout_min_confidence_check
  check (auto_workout_min_confidence = any (array['standard'::text, 'high'::text]));

alter table public.user_settings
  drop constraint if exists user_settings_auto_workout_rollout_check;
alter table public.user_settings
  add constraint user_settings_auto_workout_rollout_check
  check (auto_workout_rollout_percentage >= 0 and auto_workout_rollout_percentage <= 100);

update public.user_settings
set
  auto_workout_haptics_enabled = case
    when extra_settings->>'auto_workout_haptics_enabled' in ('true', 't', '1') then true
    else auto_workout_haptics_enabled
  end,
  auto_workout_motion_required = case
    when extra_settings->>'auto_workout_motion_required' in ('true', 't', '1') then true
    else auto_workout_motion_required
  end,
  auto_workout_min_confidence = case
    when extra_settings->>'auto_workout_min_confidence' = 'high' then 'high'
    else auto_workout_min_confidence
  end,
  auto_workout_detector_version = coalesce(
    nullif(extra_settings->>'auto_workout_detector_version', ''),
    auto_workout_detector_version
  ),
  auto_workout_rollout_percentage = case
    when extra_settings->>'auto_workout_rollout_percentage' ~ '^[0-9]+$'
    then least(100, greatest(0, (extra_settings->>'auto_workout_rollout_percentage')::integer))
    else auto_workout_rollout_percentage
  end
where extra_settings is not null
  and extra_settings <> '{}'::jsonb;

comment on column public.user_settings.auto_workout_haptics_enabled is
  'Strap buzz on auto-detect. Default false until physical WHOOP hardware QA.';
comment on column public.user_settings.auto_workout_motion_required is
  'When true, high-confidence confirm requires accelerometer evidence.';
comment on column public.user_settings.auto_workout_min_confidence is
  'standard | high. Kill/rollout gate for auto-detect confirm path.';
comment on column public.user_settings.auto_workout_detector_version is
  'Pinned detector version the client last acknowledged.';
comment on column public.user_settings.auto_workout_rollout_percentage is
  '0–100 remote rollout. 0 is a kill switch for auto-detect.';
