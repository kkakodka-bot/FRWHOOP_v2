# Device soak verification

Unit tests do not prove a wearable ingest pipeline. This checklist is the
verification surface for a 24–72 hour wear. Do not mark soak complete from
tests alone.

## What to watch

Use `GET /api/ingest/verify` (device token or user JWT) and the iPhone BLE
snapshot `ingest` object.

| Signal | Healthy | Investigate |
|---|---|---|
| `received_buffered` vs wall-clock expected (~15 samples/min) | within ~10% over hours | missing_interval gaps |
| `pending_flush` | drops to 0 after each hour | upload gap / B2 failure |
| `manifests.count` | ~1 physiology object per elapsed UTC hour | upload gap |
| `series.sample_count` | non-zero after first hour flush | engine not processing |
| `gaps.kinds` | empty or explained (BT off, commute) | unexplained connection holes |
| `coverage.complete` | true for awake wear | sleep/recovery must not treat holes as rest |
| iPhone `ingest.pending_samples` | 0 after `acked_through` | local queue not deleting |

## Gap kinds

- `missing_interval` — sample hole ≥ 10s while the strap was believed connected
- `connection` — Core Bluetooth disconnect
- `bluetooth_off` — iPhone Bluetooth powered off
- `not_restored` — app relaunched and Core Bluetooth restore returned no peripheral
- `upload` — hour archive failed or was retried
- `app_killed` / `suspend` — reserved for explicit OS lifecycle marks

## Soak steps

1. Pair the strap. Confirm live HR on Overview and `ingest.received_samples` climbing.
2. Force-quit the app. Confirm samples still append (`SensorQueue` NDJSON) and restore reconnects, or a `not_restored` / `connection` gap is recorded.
3. Toggle Bluetooth off for 2+ minutes, then on. Confirm a `bluetooth_off` gap and resume.
4. Leave the phone overnight. Next morning check `get_day_snapshot` for the wake date, sleep attribution, and that `ingest_gaps` during sleep are visible.
5. Confirm B2 `object_manifests` for each UTC hour (`v3/core/.../physiology/...`) and one `daily_physiology_series` row for the local day.
6. Confirm settings/metrics/sleep/workout screens refresh from Broadcast invalidation plus compact RPC fetch, not streamed payloads.

A soak is only complete when these steps have been run on a physical iPhone
with a worn strap for at least 24 hours and the verify payload is archived.
