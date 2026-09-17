# FRWHOOP Scoring Service (Phase 3)

Standalone JVM service that runs the extracted Android analytics Kotlin twin (`com.noop.analytics`).
Scores HRV/RR + sleep on arrival and writes canonical rows via `engine_ingest_scored` under
`algorithm_version = frwhoop-server-1`.

## Layout

| Module | Role |
|---|---|
| `analytics-kernel` | Scoped Kotlin twin — sources are BYTE-VERBATIM copies from `android/app/src/main/java` (synced by Gradle). Oracle tests run unmodified. |
| `service` | Durable work-queue poller + `AnalyticsEngine.analyzeDay` + `engine_ingest_scored` writer. |

## Build

```bash
cd scoring-service
export JAVA_HOME="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home"
./gradlew :analytics-kernel:test          # parity oracle (alias: :analytics-kernel:parityGate)
./gradlew :service:test :service:installDist
```

## Run locally

```bash
export DATABASE_URL='postgresql://postgres:…@localhost:5432/postgres'
export INGEST_SECRET='…'
export SUPABASE_URL='https://api.example.com'
export SUPABASE_SERVICE_ROLE_KEY='…'
./service/build/install/service/bin/service
```

Replay one day (bypasses the work queue; writes directly):

```bash
export REPLAY_USER_ID='…'
export REPLAY_DEVICE_ID='…'   # required when the user has more than one device
export REPLAY_DAY='2026-09-15'
./service/build/install/service/bin/service --replay-day
```

If the user has exactly one registered device, `REPLAY_DEVICE_ID` may be omitted.

## Durable state (Postgres)

All progress survives container restarts (`kill -9` → clean resume):

| Table | Purpose |
|---|---|
| `scoring_work_items` | One row per (user, device, local day); PK `(user_id, device_id, day)` |
| `scorer_state` | Singleton `discovery_watermark` — advanced after each discovery upsert |
| `scoring_service_heartbeats` | Singleton liveness row (`last_poll_at`, `last_score_at`) |
| `server_daily_scores` | Shadow daily scores keyed by `algorithm_version` |
| `server_sleep_nights` | Shadow sleep nights keyed by `algorithm_version` |

The scorer **never** writes `daily_metrics` or `sleep_nights` (device-pushed tables).

## Docker (VPS)

Build from **repo root** (kernel syncs from `../android`):

```bash
docker build -t frwhoop/scoring-service:latest -f scoring-service/Dockerfile .
```

See `infra/vps/templates/docker-compose.scoring-override.yml`.

## Scoped kernel (Locked #3)

Server computes: RR/HRV pipeline + sleep staging/score. Charge/Effort/Rest are computed internally
by `AnalyticsEngine` but **not written** to Postgres — only HRV + sleep columns are emitted via
`engine_ingest_scored`.

## Input sources

HR/RR/resp/gravity/events are read from Postgres `noop_*` projection tables (populated by the push
receiver). B2 raw-object fetch is not required for the locked HRV+sleep scope.

## Derived artifact lane (Phase 5)

After each successful `engine_ingest_scored` write, the service archives the in-memory bundle to
the **same B2 bucket** as raw objects:

```text
v3/derived/users/{userId}/days/{YYYY-MM-DD}/frwhoop-server-1.json.zst
```

Requires the same B2 env as Edge (`B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME`, …) — the
VPS compose override loads `/opt/frwhoop/b2.env`. Postgres scores commit even when B2 fails;
`scoring_work_items.derived_artifact_error` records the last archive failure for ops.
