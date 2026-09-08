# HealthKit architecture

FRWHOOP uses HealthKit as an interoperability layer. It is never the canonical store for WHOOP telemetry or FRWHOOP-derived scores.

```text
WHOOP BLE
  → iPhone app (NOOP decode)
  → FRWHOOP backend metric engine
  → Backblaze B2 (raw streams)
  → Supabase (derived metrics, sessions, manifests)

Apple Watch / iPhone / other Health apps
  → HealthKit
  → HealthKitPlugin.swift (read with provenance, idempotent write)
  → POST /api/healthkit/ingest
  → source arbitration + workout/sleep reconciliation
  → measurements, sessions, source_links, daily_metrics.extras.healthkit
```

## Canonical data ownership

| Layer | What | Canonical store |
|---|---|---|
| 1 | Raw WHOOP PPG, IMU, BLE packets, signal quality, algorithm features | Backblaze B2 |
| 2 | Normalized observations (WHOOP, HealthKit, manual) with provenance | Supabase `measurements`, `sessions` |
| 3 | FRWHOOP derived metrics and canonical events (recovery, strain, sleep, calories, workouts) | Supabase `daily_metrics`, `sessions` (source `frwhoop` / `whoop_ble`) |

HealthKit samples are Layer 2. They never overwrite Layer 1 and they do not become Layer 3 unless no FRWHOOP record exists (Watch-only fallback).

## Readable HealthKit types

Grouped permission categories (one system sheet; FRWHOOP still functions if some are denied). Types are only those FRWHOOP currently uses:

- **Heart** — heart rate, HRV SDNN, resting HR, walking HR, SpO₂, respiratory rate
- **Fitness** — steps, walk/run distance, cycling distance, active/basal energy, VO2 max, workouts, workout routes
- **Sleep** — sleep analysis
- **Body** — weight, height, body fat, lean mass, BMI, body temperature
- **Nutrition** — dietary energy, protein, carbs, fat

Not requested: walking speed/step length, Apple exercise time, wrist temperature, water, caffeine.

Read authorization is not queryable on iOS. Empty results are not treated as “denied.” Locked-device empty results are **not** treated as “no data” — see Background. Write (share) status is observable and is what `getStatus` reports.

## Ownership

FRWHOOP (`com.rahulvijayan.frwhoop`) has **one** HealthKit owner: `HealthKitPlugin.swift`.

Strand/NOOP (`HealthKitBridge.swift` in `noop/StrandiOS`) is a **different binary**. It is not compiled into the FRWHOOP Xcode target (`frontend/src/lib/healthkitOwner.check.js` asserts this). Do not merge the two observers/writers into one process.

## Writable HealthKit types

FRWHOOP writes **user-meaningful derived records** only:

- workouts (when no matching Apple workout exists)
- sleep sessions (FRWHOOP hypnogram)
- resting HR, HRV SDNN, respiratory rate (daily vitals)

Not written: raw PPG, IMU, gyroscope, high-frequency HR, raw temperature, BLE packets, signal quality, internal features. Those stay in B2.

Wrist temperature (`.appleSleepingWristTemperature`) is never requested for share; Apple reserves it and asking crashes the process.

## Provenance

Every ingested sample keeps:

`original_sample_id`, quantity type, start/end, value, unit, source app, bundle id, device, model, source revision, metadata, ingestion time, quality (stored separately; values are never confidence-adjusted).

Source taxonomy: `whoop_ble`, `apple_watch_healthkit`, `iphone_healthkit`, `third_party_healthkit`, `manual`, `frwhoop_derived`.

Apple Watch and iPhone daily statistics are queried **per HKSource**. They are never averaged with WHOOP.

## Source arbitration

Central policy: `backend/healthkit/policy.js` (`SOURCE_POLICY`). Screens must not pick a source. `arbitrate(metric, candidates)` returns one winner plus `comparison`. Fusion is `null` everywhere; no naive averaging.

| Metric | Primary | HealthKit role |
|---|---|---|
| Heart rate | WHOOP / FRWHOOP | validation, gap fill |
| HRV | FRWHOOP RMSSD | comparison only (not interchangeable with Apple SDNN) |
| Resting HR | FRWHOOP | comparison |
| GPS / distance | Apple Watch / iPhone when a route exists | primary |
| Steps | HealthKit (Watch+iPhone already de-duped by Apple) | never sum with WHOOP |
| Skin temp | WHOOP | comparison |
| Sleep | FRWHOOP sleep engine | validation / fallback / calibration |
| Calories | FRWHOOP energy engine | validation only; never summed |
| Workouts | FRWHOOP state machine | reconcile / enrich / fallback |
| Weight / height | HealthKit | primary |
| Nutrition | HealthKit if present; never overwrite a manual day | primary_if_present |

## Workout reconciliation

`classifyWorkoutMatch` uses interval IoU, start delta, duration overlap, sport, HR, distance. Configurable thresholds in `DEFAULT_WORKOUT_THRESHOLDS`.

Returns `same_workout` | `likely_same_workout` | `different_workout` | `uncertain` plus confidence.

FRWHOOP never deletes or mutates Apple-owned samples. On `same_workout` / `likely_same_workout` it **does not write** another HealthKit workout; it stores a `source_links` row (`skip_write` / `associate`) and keeps the FRWHOOP session as the primary UI row.

Watch-only workouts are stored as sessions with `summary.role = canonical_fallback`.

## Sleep reconciliation

Same overlap logic (`DEFAULT_SLEEP_THRESHOLDS`). Overlapping Apple sleep is stored as `external_comparison` and is not added to FRWHOOP sleep minutes. Apple sleep is comparison / validation / fallback, never a silent overwrite of FRWHOOP raw sleep inputs.

## Energy double-counting protection

`combineActiveEnergy` in `energy/accounting.js` refuses to sum overlapping intervals from different sources or duplicate intervals from the same source. Non-overlapping same-source intervals may be aggregated by that dedicated function only.

Canonical `energy_minutes` remain FRWHOOP-only. Apple active energy is comparison data in `extras.healthkit`.

## Sync and idempotency

Writes use `HKMetadataKeySyncIdentifier` + `HKMetadataKeySyncVersion`.

Identifier: `frwhoop:{kind}:{canonical_uuid}` (example `frwhoop:workout:<uuid>`).

If a canonical record changes (user-edited bounds, recomputed calories), the version increments. Writes query existing FRWHOOP-sourced objects by `HKMetadataKeySyncIdentifier` first: same or newer version is skipped; an older version is deleted (our source only) then rewritten. `HKWorkoutBuilder` does not reliably replace via SyncIdentifier the way `HKHealthStore.save` does, so the query-before-write path is required.

Inbound identity is explicit:

```text
UNIQUE (user_id, source_system, external_id) WHERE external_id IS NOT NULL
```

`source_system` is the classified taxonomy (`apple_watch_healthkit`, …). HealthKit UUIDs are per-device store, so uniqueness includes `user_id`. Persistence goes through `healthkit_upsert_external` (PostgREST cannot `ON CONFLICT` a partial unique index). The HTTP ingest returns **503** if that RPC fails. Local `store.healthkit` is a cache, not an acknowledgement. The client does not mark import-complete or advance last-sync until the server returns `ok`.

## Background ingestion

`HealthKitPlugin` keeps `HKObserverQuery` + hourly `enableBackgroundDelivery` for workouts, sleep, HRV, RHR, steps, active energy. JS `startHealthKitBridge` listens for `delta` and runs an incremental sync. Hourly delivery is not a wall-clock timer; observers signal that something changed, then incremental queries determine what.

HealthKit data is encrypted while the device is locked (`HKError.errorDatabaseInaccessible`). A locked read returns `{ ok: false, locked: true, error: 'protected_data_unavailable' }` — never empty arrays treated as success. Sync retries after unlock.

- First launch after grant: historical import (~180 local days)
- Later: short window (3 days) plus observer-driven catch-up
- Import-complete is set only after a durable ingest ACK
- App reinstall: historical import runs again; HealthKit UUIDs are stable so upserts are idempotent
- Permission revoke: queries return empty; FRWHOOP rows are not deleted
- WHOOP BLE and the metric engine do not depend on HealthKit

Entitlements on the signed FRWHOOP target must include `com.apple.developer.healthkit` and `com.apple.developer.healthkit.background-delivery`. Verify with `codesign -d --entitlements :-` on the installed `.app`, not a generic simulator `xcodebuild`.

## Database

Reuses `sessions`, `measurements`, `daily_metrics.extras`, `body_weight_measurements`, `nutrition_days`, `integration_connections`.

Adds `source_links` (canonical id ↔ HealthKit UUID, match, confidence, relationship, sync identifier/version). Does **not** copy the entire Apple Health database.

`daily_metrics` columns for charge/HRV/RHR/sleep/calories stay FRWHOOP. HealthKit comparison lives in `extras.healthkit`. Steps/weight/VO2 may fill empty canonical columns when policy prefers HealthKit.

## UI

Primary screens show one arbitrated value. Overlapping Apple workouts are filtered (`summary.role` external/comparison). Source metadata is available on the day snapshot (`metrics.sources`, `metrics.healthkit`) for drill-down. Settings → Health Integrations describes the policy in one line. Settings → Troubleshooting → Run Diagnostics shows Apple Health observer/ingest/lock stats and a destructive workout V1→V2 identity test.

## Failure modes

- HealthKit unavailable (iPad / web): UI says available in the iPhone app; WHOOP continues.
- Partial grant: each write path checks its own share status; reads of denied types look empty.
- Locked phone: ingest is not marked complete; retry after unlock.
- Persist failure: HTTP 503, import-complete not set, last ingest error recorded. Never silently keep only a local copy.
- Entitlement-stripped sideload: native `getStatus` still reports availability; authorization will fail closed.
- Engine recompute after HealthKit ingest: extras merge keeps `healthkit`; FRWHOOP scores win on the next persist.
- Timezone/DST: matching uses epoch milliseconds, not civil-clock equality.

## Hardware validation (required before production)

Simulator and backend tests are not enough. Run a signed iPhone + Apple Watch + WHOOP build:

| Scenario | Expected |
|---|---|
| WHOOP only | FRWHOOP metrics work; HealthKit comparison empty or sparse |
| Apple Watch only | HealthKit fallback for steps/GPS/weight; workouts as `canonical_fallback` |
| WHOOP + Watch | arbitration, no duplicates, no summed calories/steps/sleep |
| Neither (temporarily) | historical FRWHOOP days still render |

Also: HR, HRV, steps, calories, sleep, workouts, GPS, weight, background ingest, locked phone, app termination, reconnects, midnight rollover. Overnight sleep and Watch workouts completed while FRWHOOP is not open. Settings → Diagnostics for observer/ingest timestamps.

Fusion (`WHOOP HR + Apple HR`) stays `null` until this survives several days on hardware.

## Files

- `frontend/ios/App/App/HealthKitPlugin.swift` — HealthKit I/O (FRWHOOP owner)
- `frontend/src/lib/appleHealth.js` — Capacitor bridge + sync loop
- `backend/healthkit/policy.js` — sources, permissions, arbitration
- `backend/healthkit/reconcile.js` — workout/sleep matching
- `backend/healthkit/ingest.js` — normalize, ingest, export plan
- `backend/healthkit/persist.js` — fail-closed RPC persist
- `backend/healthkit/routes.js` — `/api/healthkit/*`
- `backend/energy/accounting.js` — `combineActiveEnergy`
- `supabase/migrations/20260825190000_healthkit_source_links.sql`
- `supabase/migrations/20260825200000_healthkit_external_identity.sql`
