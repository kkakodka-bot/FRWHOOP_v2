# DATA INTEGRITY INVARIANTS

These are executable invariants, not aspirations. `redecode/redecode.js` tracks
them, and `tests/redecode/redecode.test.js` asserts the critical ones.

## The core invariant

> **If we understand a signal today, decode it. If we do not, preserve it
> exactly so a future decoder can reinterpret the historical archive.
> Unknown means archived, not discarded. A failed CRC or parse is retained,
> not deleted.**

## Per-collection accounting counters

For every replay / collection session:

| Counter | Meaning | Default invariant |
|---|---|---|
| `notifications_received` | ATT notifies fed in | ≥ reassembled |
| `bytes_received` | exact bytes fed | matches archive |
| `reassembled_frames` | complete frames emitted by the reassembler | — |
| `crc_valid_frames` | header + payload CRC passed | — |
| `crc_invalid_frames` | any CRC failed (bytes retained) | retained |
| `known_packet_types` | packet type in the registry | — |
| `unknown_packet_types` | packet type not in the registry | retained |
| `decoded_frames` | decode_status = decoded | — |
| `partially_decoded_frames` | decode_status = partial | retained raw |
| `classified_frames` | decode_status = classified | — |
| `undecoded_frames` | decode_status = unknown/malformed | retained raw |
| `duplicate_frames` | physical repeated occurrence of same frame hash | counted, archive keeps occurrences |
| `dropped_records` | records intentionally not archived | **normally 0**; each carries a reason |
| `dropped_reasons` | why any record was dropped | explicit, never silent |
| `resync_dropped_bytes` | bytes the reassembler skipped to resync (kept in Level A) | accounted |
| `incomplete_frame_discards` | partial frame at disconnect / end of stream | accounted; bytes kept in Level A |
| `parser_exceptions` | decode threw (should not happen; decode is total) | 0 |
| `b2_records_uploaded` / `b2_objects_verified` / `supabase_manifests_committed` | later pipeline stages | reconciled |

On a clean stream `dropped_records === 0` (asserted in tests). A non-zero
`dropped_records` must be explainable via `dropped_reasons`.

## Layer ownership

| Layer | Canonical source | Dedup rule |
|---|---|---|
| Level A notify archive | B2 `frames` stream | no dedup — physical occurrences preserved |
| Level B frame archive | B2 `frames_reassembled` stream | transport-faithful; re-archive idempotent |
| Decoded structured records | B2 physiology + Supabase | idempotent by `(frame_hash, decoder)` |
| Derived metrics | Supabase `daily_metrics` / `daily_physiology_series` | recompute idempotent, records `metric_runs` decoder |

## Layered verification

- Each B2 object records `sha256` (compressed bytes), `compressed_bytes`,
  `schema_version`, and a `pending → uploading → uploaded → ready/verified`
  status. `storage/completeUpload` and `storage/reconcile.js` verify size /
  presence / checksum and surface orphans, mismatches, and stale pendings.
- Level B objects verify the compressed `sha256` and size before the manifest
  is `ready`.

## What is a drop and what is not

- A frame whose reassembly is incomplete at a disconnect is **not** a loss:
  its bytes remain in the Level A archive and are accounted by
  `incomplete_frame_discards`.
- A byte a reassembler skips to resync on garbage is **not** a loss: it remains
  in Level A and is counted by `resync_dropped_bytes`.
- An **intentional** drop must write to `dropped_reasons` with an observable
  cause (e.g. `out_of_selected_range` when a redecode job selects a window). It
  is never the primary path.

## Unknown-protocol observations

`replayNotifies` aggregates newly-observed signatures keyed by
`(family, firmware, characteristic, packet_type, packet_version, frame_length,
parse_status)` with `first_seen`, `last_seen`, `occurrence_count`, and a
representative `frame_hash`. This makes new firmware formats visible without
scanning B2 by hand. It is a summary index, never the canonical raw archive.
