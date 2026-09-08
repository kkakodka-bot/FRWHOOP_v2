# FRWHOOP archive formats

Raw sensor and large-object archives live in Backblaze B2. Postgres stores
only object manifests, not the bodies.

There are two layers. They are not interchangeable.

1. **Capture (`frames`)** — opaque BLE ATT notifies as received. This is the
   re-decode source. If a later decoder maps an unknown byte, these objects
   can be replayed without recapturing from the strap.
2. **Projection (`physiology`)** — today's HR / RR and strap-gravity
   interpretation. Product charts and metrics read this. It cannot reconstruct
   unknown bytes.

Do not put long-term packets on stream `ble`. That stream is a 7-day
diagnostic class under `v3/diag/`. Capture uses `frames` under `v3/core/`.

## Versioned key layout

```
v3/{core|ppg|imu|diag|export}/users/{user_id}/devices/{device_id}/{stream}/YYYY/MM/DD/HH/{object_id}.ext
v2/users/{user_id}/devices/{device_id}/raw/{stream}/YYYY/MM/DD/HH/{object_id}.ndjson.gz
v2/users/{user_id}/derived/{kind}/YYYY/MM/DD/{object_id}.json.gz
v2/users/{user_id}/exports/YYYY/MM/DD/{object_id}.json.gz
```

`user_id` and `device_id` are UUIDs. Keys never contain email, name, or phone.

Legacy `v1/` prefixes remain readable. New writes use `v3/`.

## Streams

| stream | contents | default chunk | retention |
|---|---|---|---|
| `frames` | opaque ATT notify payloads + metadata | 1 hour | core, never expires |
| `physiology` | normalized heart rate + RR + strap gravity | 1 hour | long term (`FRWHOOP_RETENTION_HR_DAYS`, default none) |
| `hr` / `rr` / `hr_rr` | legacy split streams | 1 hour | long term |
| `live_hr` | legacy live HR objects | replaced by hourly `physiology` | classified on ingest |
| `ecg` | ECG waveform bodies | per capture | long term metadata in Postgres |
| `ble` | short-lived BLE diagnostic dump | 15–30 min if enabled | **7 days** — not the historical capture |
| `ppg` | not implemented; WHOOP BLE path does not expose PPG | — | 14–30 days if added |
| `imu` | not implemented; WHOOP BLE path does not expose IMU | — | 14–30 days if added |

Chunk duration is `FRWHOOP_HR_CHUNK_MS` (default 3600000).

Scale: 24 physiology + 24 frames + 1 derived ≈ 49 B2 objects/user/day.

## Capture schema `ndjson_gzip_frames_v1`

Each line is one ATT notify (or GATT read that produced a value). The gzip
wrapper is real gzip. Framing (`0xAA` + length) is **not** applied before
archive: a notify may be a fragment. Reassembly is a decoder concern.

Required fields:

```json
{
  "schema": 1,
  "kind": "notify",
  "t": "2026-08-25T02:00:00.000Z",
  "seq": 12,
  "family": "puffin",
  "char": "FD4B0003-7185-4667-B7A6-36C427CBA76A",
  "hex": "aa0114…",
  "n": 47,
  "decoder": "frwhoop-whoop-ble/1"
}
```

Optional:

- `fw` — strap firmware string at receive time
- `model` — `WHOOP 4.0` / `WHOOP 5.0 / MG` / raw model characteristic
- `truncated` — true if the payload exceeded 8192 bytes and `hex` is a prefix.
  `n` remains the original ATT length.
- `interp` — today's decode (`bpm`, `rr_ms`, …). Sidecar only. Never the
  source of truth for a later reprocess.

`family` is `puffin` (FD4B…), `harvard` (6108…), or `gatt` (2A37 / 2A19 / …).
`hex` is lowercase, no separators. `decoder` names the software that produced
`interp`; bump it when the live parser changes. Raw `hex` does not depend on
it.

Existing physiology objects written before this stream **cannot** be turned
back into unknown bytes. Only new `frames` objects can.

## Projection schema `ndjson_gzip_v3` (gzip NDJSON)

Each line is one JSON object. The gzip wrapper is real gzip. This is **not**
a gzipped JSON array (the old contract labeled NDJSON while storing an array).

```json
{"t":"2026-08-24T18:04:01.200Z","bpm":68,"rr_ms":[812],"device_id":"<uuid>","q":1,"src":"ble_hr","gx":null,"gy":null,"gz":null,"dyn_accel":null,"layout":null,"family":null,"decoder":null,"seq":12}
```

- `t` — UTC timestamp
- `bpm` — heart rate when present
- `rr_ms` — beat-to-beat intervals
- `q` — quality flag (1 = ok)
- `gx`, `gy`, `gz` — complete strap gravity vector in g; partial or invalid
  vectors are rejected
- `dyn_accel` — strap-derived dynamic acceleration, only alongside gravity
- `layout`, `family`, `decoder`, `seq` — decode provenance and source sequence

Rows are retained when they have HR/RR **or** a valid complete gravity vector.
Phone motion is not copied into gravity rows. Opaque packet capture remains a
separate stream.

Decoders accept legacy gzip JSON arrays and v2 NDJSON unchanged.

Historical backfill uses a separate fsynced backend WAL. It is grouped by the
sample's sensor UTC hour/day before entering the same `physiology` B2 archive
flow. Live gap tracking never reads this backfill queue.

## Integrity

New production archives set:

- `sha256` of the compressed bytes
- `compressed_bytes`
- `etag` from B2 when present
- `schema_version`
- `status` lifecycle: `pending` → `uploading` → `uploaded` → `verified`/`ready`

Metric computation consumes `ready` or `verified` **physiology** manifests
only. Frame objects are not inputs to today's metric engine.

## Why not Parquet yet

Parquet + Zstandard is the intended long-term analytical format for the
physiology projection. Node currently has no first-party parquet/zstd
dependency in this repo. `archive_v2` uses the same columnar fields so a
future converter can emit `.parquet` beside the NDJSON without rewriting
identity or timestamps.

Capture stays NDJSON+hex so a grep against WHOOPDBG logs stays possible.
A later converter can emit raw binary beside it; do not discard `hex`.

## Exports

Export object keys end in `.json.gz`. MIME type is `application/gzip`. The
bytes are gzip-compressed JSON. They are not ZIP files.


## Core-health projection columns (frwhoop-steps-v1 / frwhoop-skin-temp-v1)

The `physiology` stream (`ndjson_gzip_v3`) carries, in addition to HR/RR/gravity,
the core-health signals the backend derives into daily metrics:

| column | meaning | units | validity |
|---|---|---|---|
| `steps` | per-second step DELTA (steps in that second) | count | 0–20/s |
| `step_cumulative` | raw monotonic device step counter (WHOOP5 `step_motion_counter`) | count | ≥ 0 |
| `step_cadence` | cadence-like byte | raw u8 | integer |
| `activity_class` | 0=unclassified/unknown, 1=walk, 2=run | enum | 0–2 |
| `skin_temp_c` | per-second skin temperature | degrees Celsius | 5–45 |

Anytime a delta and a cumulative counter are both present, the delta wins and the
cumulative is used only as a cross-check. Cumulative counters are unwrapped across
the u16 rollover (65536) by `metrics/steps.js`. Per-second deltas outside running
cadence (> 20/s) are refused rather than added to the total.

**Provenance is never optional**: `daily_metrics.steps` and `.skin_temp_c` come
with `source`, `algorithm_version` (`frwhoop-steps-v1` / `frwhoop-skin-temp-v1`),
and a `confidence`/`status` in the row's `confidence` and `provenance` JSONB. A
`status` of `unavailable` means no data reached the pipeline — never a fabricated 0.

`skin_temp_c` is **skin** temperature, not core/body temperature. The baseline and
`skin_temp_dev_c` (deviation) are derived separately in `metrics/temperature.js`
(nightly median; deviation = nightly − baseline). A missing baseline means
`skin_temp_dev_c` is null, not 0.
