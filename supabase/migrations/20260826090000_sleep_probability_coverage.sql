
-- Phase 12/14/22: persist per-epoch uncertainty + input coverage so the sleep
-- result is auditable and the UI can render confidence, not just a hard label.
-- ADDITIVE ONLY. Existing readers ignore new columns.

ALTER TABLE public.sleep_details
  ADD COLUMN IF NOT EXISTS epoch_probabilities jsonb,   -- [{start, stage, probs:{awake,light,deep,rem}}]
  ADD COLUMN IF NOT EXISTS epoch_coverage jsonb,        -- [{start, hr, rr, acc, coverage}] per 30s epoch
  ADD COLUMN IF NOT EXISTS scorability jsonb,           -- {epochCount,pctHighConfidence,hrCoverage,rrCoverage,accCoverage,offWristDurationMin,model,fallbackReason,detector,fallback}
  ADD COLUMN IF NOT EXISTS detector_version text,
  ADD COLUMN IF NOT EXISTS stager_version text;

-- Optional session-level aggregate so queries don't need to parse jsonb.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS sleep_high_conf_pct double precision,
  ADD COLUMN IF NOT EXISTS sleep_low_conf_pct double precision,
  ADD COLUMN IF NOT EXISTS ppg_coverage double precision,
  ADD COLUMN IF NOT EXISTS rr_coverage double precision,
  ADD COLUMN IF NOT EXISTS acc_coverage double precision,
  ADD COLUMN IF NOT EXISTS off_wrist_min integer,
  ADD COLUMN IF NOT EXISTS reduced_confidence boolean;

CREATE INDEX IF NOT EXISTS idx_sleep_details_scorability
  ON public.sleep_details ((scorability IS NOT NULL));
