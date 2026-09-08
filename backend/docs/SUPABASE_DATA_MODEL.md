# SUPABASE DATA MODEL

The canonical application/query database. Full ownership matrix in
**PRODUCTION_ARCHITECTURE.md**; this page is the summary + the raw-object
manifest contract.

## Responsibility split

- **Supabase Postgres**: fast structured query, manifests, app state, derived
  metrics, provenance, sync state, quality. It is NOT a raw packet dump.
- **Backblaze B2**: canonical raw/sensor archive. Dense high-rate arrays
  (100 Hz IMU, dense PPG) stay on B2, never expanded into Postgres rows.
- **iPhone**: BLE collector + durable store-and-forward outbox.

## Key tables

| Table | Owns |
|---|---|
| `object_manifests` | B2 object lifecycle + integrity (id, key, sha256, sizes, status) |
| `daily_physiology_series` | compact per-day physiological series (5-min) |
| `daily_metrics` | current product projection per user/day |
| `sleep_details` / `sessions` | sleep / workout boundaries and outputs |
| `ingest_gaps` | explicit missing/connection/upload holes |
| `metric_runs` | algorithm + decoder provenance |
| `profiles` / `devices` / `user_settings` | identity and state |

## Raw-object manifest (object_manifests) contract

Records `object_id, user_id, device_id, bucket, object_key, format/schema
version, stream kind, start/end time, upload time, byte size, uncompressed
size, record count, packet/version summary where available, compression,
sha256, upload verification status, decode/decoder version, created time`.
Bodies never live in the manifest.

## Query path

Frontend dashboard reads compact Postgres projections (`get_day_snapshot`,
`get_days`, `get_range`, `get_sync_revision`). Dense research windows are
retrieved through the manifest index → signed B2 URLs, not raw rows.

## Opaque IDs

Keys and tables use opaque UUIDs. Raw discovery is never keyed on a direct
identifier. No user can discover another user's object key; the backend signs
short-lived URLs scoped to the owner.
