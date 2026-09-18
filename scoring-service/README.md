# FRWHOOP scoring service

W3 uses transactionally enqueued work, unique renewable leases, immutable per-device snapshots,
and independent archive jobs. Apply the additive migration
`20260918010000_production_scoring_durability.sql` and review repair
`20260918030000_production_scoring_review_repairs.sql` before starting this worker.
Existing RPC signatures remain available. The legacy `engine_ingest_scored` compatibility wrapper
serializes with v2 publication and ignores v2-owned keys (including pending keys and sleep start-key
conflicts). Its private implementation is not executable by service/app roles. The v2 worker always
publishes through its lease/input-generation fence.

Readback integration: [SNAPSHOT_V2_CONTRACT.md](SNAPSHOT_V2_CONTRACT.md).

## Native verification

From this directory, with Java 17:

```sh
./gradlew :analytics-kernel:test :service:test :service:installDist --no-daemon
```

The service suite starts a NEW disposable PostgreSQL cluster bound only to 127.0.0.1.
It never uses DATABASE_URL. Set `W3_TEST_PG_BIN` to a PostgreSQL binary directory
(default `/opt/homebrew/opt/postgresql@18/bin`) and optionally `W3_TEST_ARTIFACTS`
to retain its cluster/logs. Migration edits are test-task inputs. Auth plumbing is a minimal
local fixture; queue/results/projection migrations execute on real PostgreSQL.

The kernel is reserved for W4. Its native suite is a regression gate, not proof of end-to-end
Swift input/visible-result parity; fixture-dependent skipped tests are not passes.

## Runtime

`DATABASE_URL` is required. B2 configuration remains optional; without it, immutable archive
debt stays pending in PostgreSQL. The old INGEST_SECRET, SUPABASE_URL and service-role HTTP key
are no longer consumed by the v2 production entrypoint.

`SCORING_ALGORITHM_VERSION` defaults to `frwhoop-server-1`. Registration schedules existing
history in bounded ranges but does not activate a new readback version.
`SCORING_POLL_SECONDS` defaults to 8 and must be 1–3600.

Each pass repairs a bounded legacy batch, expands a bounded invalidation batch, reconciles missing
enabled-version/day pairs (including first inputs committed after registration), claims only
one immediately runnable score, and attempts one independent archive job. Long compute/PUT
operations renew their own lease. Retry delay grows exponentially to one hour; scoring enters
inspectable dead letter after 8 consecutive failures, archives after 12. New score generations
reset score failure debt. Archives never require rescoring.

`--replay-day` / Gradle `replayDay` requires REPLAY_USER_ID, REPLAY_DAY and REPLAY_DEVICE_ID
(device may be omitted only for a single-device user). It enqueues a new generation and runs
one bounded normal worker pass. It is NOT a synchronous completion guarantee: inspect the
queue/read RPC for the requested revision; normal workers finish remaining debt.

## Repair and observability

Service-role-only operations:

- `repair_legacy_scoring_v2(limit)`: resumable, idempotent import of old work, prioritizing
  stranded attempts >= 8; applies to every enabled version.
- `reconcile_scoring_versions_v2(limit)`: repeatable anti-join repair across known work days and
  enabled algorithms, at most 1,000 inserted pairs per call. Existing revisions and leases are
  unchanged. Worker maintenance invokes this every pass; no additional phone upload is needed.
- `reconcile_scoring_days_v2(user,device,from,through,limit)`: explicit audited date scope,
  at most 31 days/call. Scans actual input presence, inserts only missing jobs and returns
  nextDay/done/repaired. It never dirties existing results. Repeat calls are idempotent.
- `invalidate_scoring_history_v2(user,device,from,through,reason)`: durable ranges for known
  corrections to existing history; expansion is bounded. W4 must define historical horizons.
- `retry_scoring_archive_v2(resultRevision)`: retry the same committed bytes after fixing
  the failure cause. Cannot steal an active lease or resubmit a completed archive.
- `scoring_queue_metrics_v2`: queue/archive/invalidation ages, failures, backlog, claim/renewal
  counts and last-duration mean; heartbeat meta records the metrics each pass.

Projection/index triggers cover inserts, corrections and deletions, excluding identical
transport-metadata retries. The input window is [wake-day start minus 30h, day end]; input changes
invalidate their local dates plus two wake days. Large spans and profile/version changes use
durable range cursors. Scheduling favors least-recently-served users, current days and old backlog.
Representative fleet-scale latency/load validation is still a rollout gate.

## Snapshot/archive boundary

Snapshots are keyed by owner/device/day/algorithm/input revision; server result revisions are
monotonic. Snapshot insertion, archive debt, queue settlement and selected-source legacy
replacement commit together. Source choice is explicit preference or lowest owned device UUID,
never completion order. Snapshot UPDATE is rejected.

Archive bytes are committed PostgreSQL JSONB UTF-8, uncompressed, under:

```text
v3/derived/users/{user}/devices/{device}/days/{day}/{algorithm}/revisions/{revision}.json
```

Retries use identical bytes and keys. The signed PUT binds the payload checksum; database
settlement validates hash/size against the immutable snapshot and fences the manifest write.
Local tests use a fault-injected object client, not production B2.

## W4 boundary

Reader fixes include repeatable-read input consistency, window-local unknown-family evidence,
canonical RR-channel filtering,
suspect/SpO2-IBI exclusion and full calendar-day reads. Writer uses grouped main-night selection,
stable sleep IDs, complete stage arrays and authoritative nulls.

Historical baselines/checkpoints, learned sleep need/debt/consistency, deterministic edits,
all remaining visible metrics/additional streams, HR-only orchestration and true DST semantics
inside the kernel remain W4. Current results explicitly report partial coverage; no physiology
or cutover readiness is inferred from W3 green tests. No analytics-kernel source was edited.

## Packaging

Build Docker from the repository root so the kernel can sync its Android twin:

```sh
docker build -t frwhoop/scoring-service:latest -f scoring-service/Dockerfile .
```
