-- NOOP raw object lane: the device uploads high-rate signal straight to the bucket with a presigned
-- PUT, and this database indexes it. Postgres is deliberately NOT the home of the raw signal.
--
-- Sizing is the whole reason for the split. One patient-day of full-rate capture is ~8.6M IMU
-- samples; as per-sample rows a modest cohort reaches the billions inside a year. The same day is
-- ~15-40 MB of compressed objects in B2. So the rule enforced here is that raw growth in Postgres
-- stays O(objects), never O(samples): one `object_manifests` row and one `noop_signal_windows` row
-- per archived hour, on the order of a hundred rows per patient-day.

-- ---------------------------------------------------------------------------
-- object_manifests: fields the direct lane commits before the upload happens
-- ---------------------------------------------------------------------------

-- Decoded size, so a reader can size its buffer without fetching, and so a compression regression
-- is visible as a ratio rather than inferred.
alter table public.object_manifests
  add column if not exists uncompressed_bytes bigint;

-- Whether `sha256` was verified by this server or merely claimed by the device. The direct lane
-- never sees the bytes, so at completion it can only attest the byte COUNT (from HEAD). Recording
-- the provenance keeps a `ready` row from implying a check nobody ran; `server_verified` is set only
-- after the object is read back and hashed.
alter table public.object_manifests
  add column if not exists sha256_source text;

alter table public.object_manifests
  drop constraint if exists object_manifests_sha256_source_check;
alter table public.object_manifests
  add constraint object_manifests_sha256_source_check
  check (sha256_source is null or sha256_source = any (array['client_claimed'::text, 'server_verified'::text]));

-- Push provenance, so an object traces back to the batch and installation that produced it.
alter table public.object_manifests
  add column if not exists batch_id uuid;
alter table public.object_manifests
  add column if not exists source_id uuid;

-- Digest verification is an out-of-band sweep; this is the queue it reads.
create index if not exists object_manifests_unverified_idx
  on public.object_manifests (user_id, created_at)
  where status in ('ready', 'verified') and sha256_source = 'client_claimed';

-- ---------------------------------------------------------------------------
-- noop_signal_windows: the coverage index event detection queries first
-- ---------------------------------------------------------------------------
-- One row per archived object, keyed to the UTC hour it covers. This is the catalogue: a consumer
-- reads it to learn which hours are actually covered and how well, then fetches only those objects
-- from B2 — so finding the signal never means scanning the signal.
--
-- Coverage is stored as expected/received/missing counts, NOT as a filled series. A gap has to stay
-- legible as absence, because an interpolated stretch is indistinguishable from genuinely quiet
-- data and the difference is unrecoverable once written. `interpolated_records` exists so a reader
-- can assert it is zero, not to license filling.
create table if not exists public.noop_signal_windows (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  stream text not null,
  hour_start bigint not null,
  object_id uuid not null references public.object_manifests(id) on delete cascade,
  object_key text not null,
  start_ts bigint not null,
  end_ts bigint not null,
  expected_records bigint,
  received_records bigint not null default 0,
  missing_records bigint,
  coverage double precision,
  interpolated_records bigint not null default 0,
  compressed_bytes bigint,
  uncompressed_bytes bigint,
  updated_at timestamptz not null default now(),
  primary key (user_id, device_id, stream, hour_start, object_id),
  constraint noop_signal_windows_span_check check (end_ts > start_ts),
  constraint noop_signal_windows_coverage_check
    check (coverage is null or (coverage >= 0 and coverage <= 1))
);

create index if not exists noop_signal_windows_user_hour_idx
  on public.noop_signal_windows (user_id, hour_start desc);

create index if not exists noop_signal_windows_stream_idx
  on public.noop_signal_windows (user_id, stream, hour_start desc);

-- Finding the hours worth training on: well-covered windows, newest first.
create index if not exists noop_signal_windows_covered_idx
  on public.noop_signal_windows (user_id, stream, hour_start desc)
  where coverage >= 0.5;

alter table public.noop_signal_windows enable row level security;

create policy "noop_signal_windows_select_own"
  on public.noop_signal_windows for select
  using (auth.uid() = user_id);

create policy "noop_signal_windows_service_write"
  on public.noop_signal_windows for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

comment on table public.noop_signal_windows is
  'Per-object coverage index over raw signal archived in B2. Counts only; never an interpolated series.';

-- ---------------------------------------------------------------------------
-- noop_event_labels: annotations collected alongside the signal
-- ---------------------------------------------------------------------------
-- Annotation is collection, not analysis: nothing in this repo reads this table to score or detect
-- anything. It exists because a label is only accurate while the event is recent, so the place to
-- capture one is next to the signal as it arrives rather than reconstructed from memory later.
--
-- `source` and `confidence` are separate and both required because a reported event and an
-- instrumented one are different evidence, and collapsing them loses the distinction permanently —
-- whoever uses this corpus needs to be able to select on it.
create table if not exists public.noop_event_labels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid,
  label text not null,
  start_ts bigint not null,
  end_ts bigint,
  source text not null,
  confidence text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint noop_event_labels_span_check check (end_ts is null or end_ts >= start_ts),
  constraint noop_event_labels_source_check check (source = any (array[
    'patient'::text, 'caregiver'::text, 'clinician'::text, 'instrumented'::text, 'device'::text
  ])),
  -- An enumerated ladder rather than free text, so 'probable' and 'confirmed' cannot be used
  -- interchangeably by two annotators and silently merged at query time.
  constraint noop_event_labels_confidence_check check (confidence = any (array[
    'confirmed'::text, 'probable'::text, 'possible'::text, 'ruled_out'::text
  ]))
);

create index if not exists noop_event_labels_user_start_idx
  on public.noop_event_labels (user_id, start_ts desc);

create index if not exists noop_event_labels_label_idx
  on public.noop_event_labels (user_id, label, start_ts desc);

alter table public.noop_event_labels enable row level security;

create policy "noop_event_labels_select_own"
  on public.noop_event_labels for select
  using (auth.uid() = user_id);

create policy "noop_event_labels_write_own"
  on public.noop_event_labels for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "noop_event_labels_service_write"
  on public.noop_event_labels for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

comment on table public.noop_event_labels is
  'Annotated events (incl. seizures). source/confidence distinguish video-EEG confirmation from report.';
