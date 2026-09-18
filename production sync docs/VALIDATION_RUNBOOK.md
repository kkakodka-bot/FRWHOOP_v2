# Validation and rollout gates

Status: candidate implementation in progress. Nothing in this document authorizes deployment,
production writes, phone installation/reinstallation, data restore or deletion. Obtain separate
approval for those operations. Keep original DB/WAL/SHM, preference and pending-file backups before
any approved device migration. Do not attach private health payloads or credentials to public reports.

## Capture a comparable run

Pin the worktree and full commit, app version/build, Release configuration, SDK/Xcode, device model/OS,
account namespace hash, source-device hash, timezone and actual refresh rate. Record the effective
endpoint, network policy, Low Power Mode, thermal state, charging/signal conditions and history size.
Do not compare a different branch or installed binary and call it evidence for this candidate.

For each canary retain one opaque record/job correlation through these distinct observations:
local commit, strap ACK submission/completion, intake acceptance, verified archive receipt, indexed
input revision, immutable score revision and the displayed revision. A local commit can authorize
strap ACK; upload acceptance is not permission to prune the sole archive source. Keep UTC timestamps
and the result-day timezone. The first missing transition is the stalled boundary; a green dashboard
does not establish all-stream durability.

## Physical iOS procedure (unexecuted)

1. With separate installation approval, build and install the exact Release candidate on a physical
   60 Hz iPhone and a ProMotion iPhone. Preserve existing containers. A simulator or unsigned build
   is not physical-device evidence.
2. Capture baseline and candidate runs under matched conditions. Use Instruments Time Profiler,
   Hangs, Animation Hitches/SwiftUI and energy tooling. Record tool/OS versions and the metric's scope
   and denominator. Measure actual refresh rate; the device's advertised maximum is insufficient.
3. Repeat cache-only launches and warm Today/Sleep/detail navigation. Retain enough independent runs
   for p95; report OS launch separately from first usable cached content. Gates: warm content <=100 ms,
   cold cached dashboard <=1 s; no network dependency for valid cache.
4. Scroll and tap during BLE backlog, immutable upload preparation, network recovery, cache hydration
   and result replacement. Inspect every reproducible main-thread stall >=250 ms. Deadlines are
   16.67 ms at 60 Hz and 8.33 ms at actual 120 Hz, with rendering-pipeline headroom.
5. Use Apple's aggregate all-animation Hitches metric: <=10 ms/s is good; >10 through 25 warning;
   >25 through 50 critical; >50 immediate attention. The old fixed 33 ms callback counter and
   MetricKit's scroll-only hitch ratio cannot certify this gate. [Apple guidance](https://developer.apple.com/documentation/xcode/understanding-hitches-in-your-app).
6. Exercise at least a 72-hour ordinary backlog, low storage without deleting pending records, Wi-Fi
   interruption, Wi-Fi-only versus explicitly enabled cellular, expired login and upload URL,
   normal backgrounding, OS termination/restoration, reboot/first unlock, Low Power Mode and thermal
   constraints. Record pending/retained bytes and monotonically advancing acknowledged jobs.
7. Run two-hour locked reconnect and overnight-through-wake tests. Force quit is separate: record
   the paused interval and catch-up after reopening, not an uninterrupted-capture claim.
8. Switch A to B during cache load, token refresh, byte upload and receipt settlement. Confirm immediate
   removal from app/widget presentation and no cross-account upload. Retain A's pending bytes. A
   disconnected watch cannot be remotely cleared immediately; verify delivery of the latest empty
   context when it reconnects and keep this platform limit explicit.

MetricKit diagnostics are opportunistic, local and bounded under the app cache directory
`SyncPerformanceEvidence` (16 files, 8 MiB aggregate, 2 MiB per payload). Missing payloads are not a pass.
Export them only with explicit user approval. A `ProductionSync` signpost shows a software stage,
not proof of server durability or an actual rendered frame without the corresponding trace.

## Staging and production evidence (unexecuted)

Use synthetic accounts on a separately approved staging environment first. Migrate additive receiver
compatibility before the scorer, then the app cache/readback contract, then individual validated
metric activation. Never rewrite deployed migration identifiers. Verify user UUIDs/device mappings
before managed-to-self-hosted migration; database restore alone does not move Edge functions or B2
bytes. Reauthentication is required if signing keys change. Quarantine ambiguous legacy ownership.

Record applied migration ledger, Edge revision, scorer commit and immutable image digest. Sample the
heartbeat twice and require advancement. Use a normal user JWT for the canary and RLS checks, not
service role or a fleet token. Confirm a fresh upload advances input/result/display revisions. Repeat
more than 100 updates, duplicates, two workers/lease expiry, late evening corrections, two-device
processing order, index failure and derived-archive failure with recovery without a new phone upload.

`infra/vps/scripts/phase3-acceptance-checks.sh --preflight` fails before remote access when evidence
is missing. `--local` runs native local checks but exits 3 (`NOT_READY`) because remote/device gates
were not run. The default remote mode is read-only; it verifies an existing canary revision and an
advancing heartbeat. The phase-1 restore drill and phase-2 conformance script still perform writes
and require explicit opt-in flags plus separate operator approval. Do not execute them during this task.

The evidence validator requires a schema-1 JSON manifest with exact build/server metadata, advancing
heartbeats, owner/record-correlated canary stages, input/result/displayed revisions, physical 60/120 Hz
performance, latency, energy, RLS and all lifecycle scenario outcomes. Every artifact reference must
resolve inside the evidence folder and match its SHA-256. See `verify-sync-evidence.test.mjs` for
the data shape only: its synthetic fixture is never acceptable device or production evidence.
Validation checks internal consistency and bytes, not artifact authenticity or reviewer approval.
The applied migration list must include the complete additive production-sync chain, IDs
`20260918010000` through `20260918080000` in increments of `10000`. The first two migrations alone
do not supply the lease review repairs, projection debt, historical inputs, scalar projections,
auxiliary identity or PPG contributor-selection contract. This is a required evidence check, not
permission to apply migrations and not proof that the recorded ledger was collected from the target.

## Rollback and recovery

Keep the prior compatible binary, receiver and scorer image. Stop activation or move the controlled
algorithm pointer only after confirming client compatibility; do not clear caches or launch an
unbounded local rescore. Retain immutable prior result revisions and raw receipt associations.
Disable a failing worker while preserving its queue; a lease expires and can be safely reclaimed.
Archive debt retries independently. Retain current/previous account pending files in their original
namespaces and require reauthentication as that owner to resume. Never move them into a new account.

Do not roll back by dropping new tables, resetting a phone database, replaying all users or deleting
unsent data. Explicit deletion and verified legacy-data recovery require separate reviewed procedures.
Report source readiness, deployment readiness, runtime correctness and physiological accuracy separately.
