-- Sleep V3 shadow persistence. Canonical hypnogram remains V2 until promotion.
-- ADDITIVE ONLY.

ALTER TABLE public.sleep_details
  ADD COLUMN IF NOT EXISTS shadow_v3 jsonb,
  ADD COLUMN IF NOT EXISTS unscored_min integer;

COMMENT ON COLUMN public.sleep_details.shadow_v3 IS
  'sleep_stager_v3 shadow/beta candidate: path, fallback, stages, uncalibrated scores, vs_v2 disagreement, modality coverage. Never the canonical UI result until an explicit registry promotion. Rollback FRWHOOP_SLEEP_V3=off stops selecting this column.';

COMMENT ON COLUMN public.sleep_details.unscored_min IS
  'Minutes of V3-unscored epochs (off-wrist, gaps, nap detailed-stage abstention). Not folded into Light.';
