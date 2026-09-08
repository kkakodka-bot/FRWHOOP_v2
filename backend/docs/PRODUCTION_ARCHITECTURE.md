# FRWHOOP production persistence architecture

Supabase is the canonical query and application database.
Backblaze B2 is the canonical raw-sensor and large-object archive.
The iPhone may cache and queue unsent data.
Backend local disk is cache, WAL retry state, and fixtures only.

```
WHOOP BLE notify
    ↓
iPhone SensorQueue
    ├─ ble-frames.ndjson (opaque ATT payloads, fsync)
    └─ sensor-queue.ndjson (today's HR/RR, fsync)
    ↓
POST /api/ble/live samples[] + frames[] + gaps[]
    → acked_through / frames_acked_through
    ↓
Hourly B2 v3/core archives (independent flushes)
    ├─ physiology/  today's HR/RR projection
    └─ frames/      re-decode source (never expires)
    ↓
object_manifests + daily_physiology_series + ingest_gaps in Supabase
    ↓
Metric engine (physiology only)
    ↓
daily_metrics + sleep_details + sessions
    ↓
Broadcast invalidation → get_day_snapshot / get_days / get_range
    ↓
iPhone UI
```

## 1. Tables and canonical responsibility

| Table | Owns |
|---|---|
| `profiles` | Account profile, onboarding, reported age, body stats |
| `devices` | Wearable identity and sync timestamps |
| `user_settings` | Typed app preferences (one row per auth user) |
| `health_calibrations` | Current BP cuff calibration |
| `integration_connections` | Public connection metadata (no tokens) |
| `internal.integration_secrets` | Encrypted integration credentials (service_role) |
| `internal.integration_credentials` | Alternate ciphertext store from the expand migration |
| `daily_metrics` | One current product projection per user per physiological day |
| `sessions` | Sleep, nap, workout, strength, breathing, manual intervals |
| `sleep_details` | Sleep-specific outputs keyed by `sessions.id` |
| `sleep_nights` | Legacy compatibility table. Writers stopped 2026-08-24. Not dropped. |
| `events` | Journal, check-ins, captures |
| `measurements` | Irregular scalars (weight, VO2, BP, temp, SpO2, waist, …) |
| `physiology_buckets` | DEPRECATED. Writers stopped. Use `daily_physiology_series`. |
| `daily_physiology_series` | One compact 5-minute series row per user per local day |
| `ingest_gaps` | Explicit missing/connection/upload holes |
| `object_manifests` | Canonical B2 object lifecycle |
| `sensor_objects` / `derived_objects` / `live_windows` | Legacy manifests. New writes use `object_manifests`. |
| `metric_runs` | Algorithm provenance |
| `algorithm_results` | Functional Age / VO2 snapshots |
| `coach_sessions` / `coach_messages` / `coach_memories` | Coach durability |
| `user_documents` | Notes and document metadata |
| `user_sync_state` | Compact revision for the client poll |
| `deletion_jobs` | Resumable account deletion |
| `dashboard_days` | Invoker view of user-class daily_metrics |

Fixtures (`record_class = 'fixture'`, including `coach-days-backfill` and `curl-test`) stay in the table but are excluded from dashboard views and live overlays. They are not deleted.

## 2. B2 object classes

See `ARCHIVE_FORMATS.md`. Default: hourly gzip NDJSON for combined physiology under `v3/core/users/{uuid}/…/physiology/…`, plus hourly opaque BLE capture under `…/frames/…`. Combined: 24 physiology + 24 frames + 1 derived ≈ 49 objects/user/day. The 7-day `ble` diagnostic stream is not the historical capture. Retention prefixes match from the start of the key (`v3/ppg/`, `v3/imu/`, `v3/diag/`, `v3/export/`). `v3/core/` has no hide-after-days rule.

## 3. Data ownership matrix

| Feature | Canonical | Cache |
|---|---|---|
| Live HR UI | iPhone BLE | — |
| Opaque BLE capture | B2 `frames` + `object_manifests` | iPhone `ble-frames.ndjson`, hour frames WAL |
| Raw HR/RR projection | B2 `physiology` + `object_manifests` | hour WAL |
| Recovery / strain / sleep scores | `daily_metrics` | `/api/days` |
| Intraday charts | `daily_physiology_series` | sparse `bpm_data` |
| Sleep stages | `sleep_details` | — |
| Workouts | `sessions` | `user-store.json` cache |
| Settings | `user_settings` via RLS | iPhone outbox |
| Profile | `profiles` + `measurements` | cache |
| Journal / check-ins | `events` | cache |
| BP / weight / VO2 | `measurements` + `algorithm_results` | cache |
| ECG | metadata in Postgres + waveform on B2 | cache |
| Strength | `sessions` kind `strength_workout` | cache |
| Integrations | public row + encrypted secret | never tokens on client |
| Coach | `coach_*` tables | local session files as cache |
| Community members | API demo only | not other users' health |

## 4. Migrations

- `20260819190000_frwhoop_base_schema.sql` — empty-project base
- Historical remote versions through `unify_secret_gate`
- `20260824180000_production_persistence.sql` — manifests, measurements, sleep_details, buckets, RLS, snapshots
- `20260824185725_post_persistence_indexes.sql` — FK covering indexes
- `20260824190000_settings_identity_canonical.sql` — typed settings, integration secrets, RPC lockdown

An empty project applies the repository `supabase/migrations/` folder in version order.

## 5. Backend modules

Identity `identity/resolveUser.js`. Day bounds `time/dayBoundary.js`. Hourly ingest `ingest/hourBuffer.js` + `ingest/archiveFormat.js`. Manifests / reconcile / deletion `storage/manifests.js`, `storage/reconcile.js`, `storage/deletion.js`. Canonical app store `persistence/canonicalStore.js`. Compact reads `metrics/snapshot.js`. Settings mapping `settings/typedSettings.js` + `settings/cloudSync.js`.

## 6. Frontend data paths

- Settings: direct Supabase RLS (`frontend/src/lib/settings/runtime.js`) plus Realtime on `user_settings`
- Overview/sleep/strain: `/api/days` every 60s gated by `/api/sync/revision` (not a 20s full history poll)
- Live HR: local BLE overlay
- Compact: `GET /api/days/snapshot` and `GET /api/days/range`
- RPCs `get_day_snapshot`, `get_range`, `get_sync_revision` are SECURITY INVOKER

## 7. Security

- Production requests require a JWT or device token; no silent `local-demo` user
- Privileged `app_*` / `engine_*` execute revoked from `anon` / `authenticated`
- `set_updated_at` uses `search_path = pg_catalog`
- RLS: `(select auth.uid()) = user_id` (or `id` on profiles)
- Integration tokens are not selected by authenticated clients; service_role stores `{v:'enc', cipher}` AES-GCM blobs when `FRWHOOP_CREDENTIALS_KEY` is set
- Leaked-password protection is a Supabase Auth dashboard setting (Pro). SQL cannot enable it.

## 8. Reliability

Ingest: pending manifest → upload → HEAD size + sha256 → `ready`. Reconciliation marks stale pending, missing ready objects (`corrupt`), and unique orphan keys. Retention sweep deletes expired B2 versions and marks manifests `deleted`. Queue file `data/sync-queue.json` is retry state, not the source of truth.

## 9. Account deletion

`POST /api/account/delete` records a `deletion_jobs` row, deletes all B2 object versions under `v1/` and `v2/` user prefixes, deletes Postgres rows, then deletes Auth. Partial failure leaves the job resumable. Auth is never deleted first.

## 10. Tests

`cd backend && node --test tests/*.test.js` — 209 passing, including e2e BLE → verified archive → metric projection → compact day, RLS isolation, ingest lifecycle, deletion order, identity, hour rollover, and scale estimate.

## 11. Remaining limitations

- Parquet/zstd conversion is deferred (see archive formats).
- Device token / `FRWHOOP_ALLOW_DEV_USER` exists for the personal phone → home-server path until every request carries a JWT. `NODE_ENV=production` without JWT or device token returns 401.
- `object_manifests` is canonical; old object tables remain for dual-write.
- SQL `get_day_snapshot` uses naive date timestamps; Node snapshot uses IANA bounds.
- PPG and IMU are not archived because the current WHOOP BLE implementation does not expose them.
- Community members remain demo data.
- Multi-instance metric compute still needs a single writer or lease; outbox + unique keys make retries safe.
- Account deletion against live Auth+B2 should be smoke-tested on a throwaway user before relying on it in production.
- `FRWHOOP_CREDENTIALS_KEY` must be set in production so Strava refresh tokens are encrypted.

## 12. Storage growth (per user)

HR ~1 sample / 4s → ~21,600 samples/day. Hourly objects → **24 HR objects/user/day** (~9,000/year), not 1,440 minute objects. Plus ~1 derived object/day. Postgres: 1 `daily_metrics` + 288 five-minute buckets + ~25 manifests/day. Snapshot ~8 KB; 14-day range ~4 KB. Estimated B2 well under 1 GB/user-month at gzip NDJSON sizes.

## 13. Intentional deviations

1. Gzip NDJSON v2 instead of Parquet now — no parquet dependency; schema is parquet-shaped.
2. Expand/contract: old object tables kept; not a destructive consolidation.
3. Settings are client-owned via RLS; backend still dual-writes typed rows from the canonical store/outbox.
4. Coach fixture history is classified `fixture`, not deleted.
5. Leaked password protection left to the Auth dashboard.
