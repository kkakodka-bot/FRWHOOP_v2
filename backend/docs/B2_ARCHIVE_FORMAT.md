# B2 ARCHIVE FORMAT

Canonical long-term format detail lives in **ARCHIVE_FORMATS.md** (schema,
versioned key layout, streams, integrity). This page is the index + the Level B
addition.

## Key layout (v3)

```
v3/{class}/users/{user_id}/devices/{device_id}/{stream}/YYYY/MM/DD/HH/{object_id}.{ext}
```

`class` is the retention prefix (`core|ppg|imu|diag|export`) so lifecycle rules
can target it. `user_id` / `device_id` / `object_id` are opaque UUIDs; keys and
metadata never contain email, name, serial, or phone.

| stream | class | format | content |
|---|---|---|---|
| `frames` | core | `ndjson_gzip_frames_v1` | Level A: one ATT notify payload + metadata per line |
| `frames_reassembled` | core | `ndjson_gzip_frames_v1` (frame-level) | Level B: complete frames + crc/parse/lineage |
| `physiology` | core | `ndjson_gzip_v3` | daily HR/RR/gravity projection |
| `ble` | diag | gzip | 7-day diagnostic dump (not historical capture) |
| `ppg` / `imu` | ppg/imu | — | reserved high-rate streams |

## Compression

Real gzip over NDJSON. Human-debuggable and streamable; documented + versioned
(`schema_version`). Crypto digests (sha256 of compressed bytes) + sizes are
recorded per object. A future Parquet+zstd conversion is planned for the
physiology projection only; do not discard `hex` capture.

## Integrity + lifecycle

- One immutable object per `(user, device, stream, hour)`; never overwritten.
- `sha256` (compressed) + `compressed_bytes` verified before `ready`.
- Core class objects never expire; `diag`/`export` 7 days; `ppg`/`imu`
  14–30 days if added. Raw user history must never be caught by a generic
  delete rule — lifecycle is prefix-scoped to the retention class.
- Incomplete multipart/temp staging is cleaned by `b2Lifecycle.js`.
- Do not use object listing as a database; Supabase `object_manifests` is the
  index.
