# Cloud ingestion coverage

This fork ships **every patient-owned row** NOOP collects to the FRWHOOP durability pipeline:
on-device SQLite → authenticated push → fsync'd NDJSON WAL → B2 archive → verified
`object_manifests` row → Supabase upsert → UI read path. NOOP remains authoritative: the server
never decodes a BLE frame and never recomputes a score.

The matrix below is enforced by `cloud_ingestion_registry.json` (byte-identical Swift/Android copy)
and `swift test` / `./gradlew testFullDebugUnitTest --tests com.noop.push.CloudIngestionRegistryTest`.
A new `WhoopStore` migration that adds a table without updating the registry fails CI.

Wire framing, acknowledgement rules, and the v1.1 stream registry live in
[`PUSH_PROTOCOL.md`](PUSH_PROTOCOL.md).

## Pipeline invariants

1. Ack only after WAL fsync, before B2/Supabase. No partial success.
2. Device deletes only what the ack names. A 4xx, non-JSON 2xx, timeout, or auth failure deletes nothing.
3. Trim the WAL only once the manifest reaches `ready` or `verified`.
4. Retries reuse identical decoded bytes and the same `batchId`.
5. Replay is a pure re-upsert of archived records and is idempotent.
6. Unpair drains the upload outbox before purge — unacked rows are unshipped patient data.

## B2 key scheme

Hourly archives use FRWHOOP's v3 layout from `backend/storage/keys.js`:

```text
v3/{retentionClass}/users/{userId}/devices/{deviceId}/{b2Stream}/{YYYY}/{MM}/{DD}/{HH}/{objectId}.{ext}
```

| Extension | Use |
|---|---|
| `ndjson.gz` | Row streams (`hrSample`, `dailyMetric`, …) |
| `bin.gz` | Packed waveform BLOBs (`ppgWaveformSample`, `v18AuxSample`) |
| `pb.zst` | Pre-decode frame batches (`rawBatch`) |

`object_manifests.object_key` indexes every archive. Binary streams upsert manifest rows only;
row-shaped streams also project into the Supabase tables named below.

## Coverage matrix

### Append streams (NDJSON, cursor by SQLite `rowid`)

| Table | Wire stream | B2 stream | Supabase table | Why |
|---|---|---|---|---|
| `hrSample` | `hrSample` | `hrSample` | `noop_hr_samples` | Measured strap HR — primary intraday physiology. |
| `rrInterval` | `rrInterval` | `rrInterval` | `noop_rr_intervals` | R-R intervals for HRV; rowid cursor survives timestamp backfill. |
| `event` | `event` | `event` | `noop_events` | Decoded strap events from offload. |
| `battery` | `battery` | `battery` | `noop_battery_samples` | SOC / mV / charging telemetry. |
| `spo2Sample` | `spo2Sample` | `spo2Sample` | `noop_spo2_samples` | SpO₂ PPG ADC (red/IR). |
| `skinTempSample` | `skinTempSample` | `skinTempSample` | `noop_skin_temp_samples` | Skin temperature raw ADC. |
| `respSample` | `respSample` | `respSample` | `noop_resp_samples` | Respiration raw ADC. |
| `gravitySample` | `gravitySample` | `gravitySample` | `noop_gravity_samples` | 1 Hz gravity vector + dynamic acceleration. |
| `stepSample` | `stepSample` | `stepSample` | `noop_step_samples` | WHOOP 5 step counter + activity class. |
| `sleepStateSample` | `sleepStateSample` | `sleepStateSample` | `noop_sleep_state_samples` | Per-second band sleep-state (@81); **new Supabase migration**. |
| `ppgHrSample` | `ppgHrSample` | `ppgHrSample` | `noop_ppg_hr_samples` | PPG-derived HR kept separate from measured HR; **new migration**. |
| `appleStepHour` | `appleStepHour` | `appleStepHour` | `noop_apple_step_hours` | Hourly Apple Health step buckets. |
| `ouraRaw` | `ouraRaw` | `ouraRaw` | `noop_oura_raw` | Verbatim Oura API pages (iOS import); **new migration**. |
| `coachMessage` | `coachMessage` | `coachMessage` | `noop_coach_messages` | On-device AI Coach transcript. |

### Binary object streams (gzip/zstd blob + sidecar manifest)

| Table | Wire stream | B2 stream | Ext | Class | Supabase | Why |
|---|---|---|---|---|---|---|
| `ppgWaveformSample` | `ppgWaveformSample` | `ppgWaveformSample` | `bin.gz` | `ppg` | `object_manifests` | Packed 24 Hz PPG waveform BLOBs. |
| `v18AuxSample` | `v18AuxSample` | `v18AuxSample` | `bin.gz` | `diag` | `object_manifests` | Unpinned v18 auxiliary field BLOBs. |
| `rawBatch` | `rawBatch` | `rawBatch` | `pb.zst` | `core` | `object_manifests` | Pre-decode frame batches; durable until ack then pruned locally. |

### Replace-window streams (14-day rolling authoritative window)

| Table | Wire stream | B2 stream | Supabase table | Why |
|---|---|---|---|---|
| `dailyMetric` | `dailyMetric` | `dailyMetric` | `daily_metrics` | NOOP-computed daily scores; upserted, never recomputed server-side. |
| `sleepSession` | `sleepSession` | `sleepSession` | `sessions` (`kind=sleep`) | Sleep sessions with stages JSON verbatim. |
| `workout` | `workout` | `workout` | `sessions` (`kind=workout`) | Workout sessions with zones/route in summary JSON. |
| `journal` | `journal` | `journal` | `noop_journal_entries` | Daily Q&A journal — **not** FRWHOOP flat `events`; **new migration**. |
| `metricSeries` | `metricSeries` | `metricSeries` | `noop_metric_series` | Long-format (day, key) metric explorer cache. |
| `appleDaily` | `appleDaily` | `appleDaily` | `noop_apple_daily` | Apple Health daily aggregates. |
| `scoreInputProvenance` | `scoreInputProvenance` | `scoreInputProvenance` | `noop_score_input_provenance` | Per-metric source device audit trail. |
| `labMarker` | `labMarker` | `labMarker` | `noop_lab_markers` | Lab Book blood panels — **new migration, highest cohort value**. |
| `liveSession` | `liveSession` | `liveSession` | `noop_live_sessions` | Silent-guardian coaching sessions; **new migration**. |

### Local only (never shipped)

| Table | Platform | Why |
|---|---|---|
| `cursors` | iOS | Legacy `highwater:*` / `read:*` bookmarks; replaced by `uploadOutbox` + server WAL. |
| `dayOwnership` | both | Per-day device resolver for multi-strap UI; cloud rows carry `source_device_id`. |
| `pairedDevice` | both | On-device registry; cloud `devices` minted from authenticated ingest metadata. |
| `device` | both | Legacy single-strap row superseded by `pairedDevice`. |
| `dismissedSleep` | Android | UI tombstone; iOS uses UserDefaults. |
| `dismissedWorkout` | Android | UI tombstone; authoritative data is in `workout`. |

### Migration scratch (never a live table)

`rrInterval_new` is a transient rename target during the `v24-rr-seq` migration. It is not in the
live schema and is not listed in the registry.

## Supabase migrations still required

These tables have **no** existing FRWHOOP home and need DDL before ingest can project UI rows:

- `noop_lab_markers`
- `noop_journal_entries`
- `noop_oura_raw`
- `noop_sleep_state_samples`
- `noop_ppg_hr_samples`
- `noop_live_sessions`
- `noop_hr_samples`, `noop_rr_intervals`, and the other `noop_*` append projections above
- `session_list` view (referenced by `frontend/src/lib/cloud/client.js` with no migration in git)

Existing tables reused with NOOP-shaped upserts (no server-side scoring):

- `daily_metrics` ← `dailyMetric`
- `sessions` ← `sleepSession`, `workout`
- `object_manifests` ← all B2 archives

## Security and deletion

- Bearer token in Keychain (`kSecAttrAccessibleAfterFirstUnlock`, mirror `AIKeyStore`).
- TLS-only endpoints in release builds.
- Per-subject delete reaches B2 objects, `object_manifests`, and Supabase rows.
- No PHI in logs.

## Environment wiring (FRWHOOP backend vs NOOP client)

**B2 and Supabase keys stay server-side** in `backend/.env` (or the repo-root `.env` — `storage/config.js` aliases `PROJECT_URL` → `SUPABASE_URL`, `KEY_ID` → `B2_KEY_ID`, etc.). The phone never receives these.

| Variable | Where | Purpose |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `backend/.env` | Server upserts + `object_manifests` |
| `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET`, `B2_S3_ENDPOINT`, `B2_REGION` | `backend/.env` | Hourly archive upload |
| `INGEST_SECRET` | `backend/.env` | Engine RPC shared secret (settings sync, scoring) — **not** NOOP push identity |
| `FRWHOOP_ALLOW_DEV_USER`, `FRWHOOP_LOCAL_USER_ID` | `backend/.env` (dev) | Dev-only: maps `INGEST_SECRET` bearer → fixed user UUID for local push smoke tests |

**NOOP client (Deliverable 3)** stores only:

| Setting | Example | Notes |
|---|---|---|
| Push endpoint | `http://<mac-lan-ip>:8080/api/push` | `GET` capabilities + `POST` batches |
| Bearer token | opaque ingest token from `POST /api/push/tokens` | Mint once while signed into FRWHOOP; Keychain, `kSecAttrAccessibleAfterFirstUnlock` |

Android Experimental push (already in tree): Settings → Self-hosted push → endpoint URL + token. iOS transport (`Strand/Push/`) is still TODO; the backend route is live for `hrSample` first.

### Apply Supabase migration

```bash
supabase db push   # or run supabase/migrations/20260907133000_noop_hr_samples.sql
```

### Smoke test

```bash
cd backend
npm ci
npm test -- tests/ingestTokens.test.js tests/pushIngest.test.js
npm start
# Sign into FRWHOOP, mint: curl -H "Authorization: Bearer <jwt>" -X POST localhost:8080/api/push/tokens -d '{"label":"phone"}'
# Configure NOOP push endpoint to http://localhost:8080/api/push with the returned opaque token
```

### Docker (production-shaped)

TLS terminates at your reverse proxy (Caddy, nginx, Traefik, platform load balancer). The container listens on plain HTTP port 8080.

```bash
# Repo-root .env supplies Supabase/B2 secrets (see backend/.env.example for the full list).
docker compose up --build -d
curl -fsS http://localhost:8080/health
```

| File | Role |
|---|---|
| `Packages/WhoopStore/.../cloud_ingestion_registry.json` | Machine-readable matrix (oracle) |
| `Packages/WhoopStore/.../CloudIngestionRegistry.swift` | Loader + validator |
| `Packages/WhoopStore/Tests/.../CloudIngestionRegistryTests.swift` | GRDB coverage test |
| `android/.../CloudIngestionRegistryTest.kt` | Room/schema-oracle coverage test |
| `docs/PUSH_PROTOCOL.md` | Wire contract v1.1 |
| `backend/storage/keys.js` | B2 stream registry (extended in Deliverable 4) |
