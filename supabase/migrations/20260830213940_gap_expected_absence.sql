-- Expected absence is confirmed nonwear/charging, not data loss.
-- Additive: do not rewrite prior resolution or kind checks in place.

begin;

alter table public.ingest_gaps drop constraint if exists ingest_gaps_resolution_check;
alter table public.ingest_gaps
  add constraint ingest_gaps_resolution_check
  check (resolution is null or resolution = any (array[
    'backfilled'::text,
    'unrecoverable'::text,
    'expected_absence'::text,
    'strap_trimmed'::text,
    'manual'::text
  ]));

alter table public.ingest_gaps drop constraint if exists ingest_gaps_kind_check;
alter table public.ingest_gaps
  add constraint ingest_gaps_kind_check check (kind = any (array[
    'missing_interval'::text, 'connection'::text, 'upload'::text,
    'bluetooth_off'::text, 'not_restored'::text, 'app_killed'::text,
    'suspend'::text, 'hr_stream_stalled'::text,
    'off_wrist'::text, 'wrist_off'::text, 'charging'::text
  ]));

comment on column public.ingest_gaps.resolution is
  'Monotonic close-out: unresolved -> backfilled | expected_absence | unrecoverable. Never reopens.';

commit;
