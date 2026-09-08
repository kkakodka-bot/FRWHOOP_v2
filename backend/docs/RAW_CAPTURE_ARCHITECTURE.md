# RAW CAPTURE ARCHITECTURE

## Invariant

**WHOOP BLE bytes received by the application must never silently disappear.**
This document describes the two capture levels and their durable, append-only
storage.

```
WHOOP strap
  → BLE notify/indicate (CoreBluetooth)
  → Level A notify archive  (ble-frames.ndjson, fsync before parse)
  → live reassembly (iOS)  → decoded HR/RR/history
  → POST /api/ble/live  samples[] + frames[] + gaps[] + historySamples[]
  → backend hour buffers (physiology WAL + frames WAL, independent)
  → B2  v3/core/.../physiology/  and  v3/core/.../frames/
  → object_manifests  (sha256, size, status lifecycle)
  → metric engine → daily_metrics / sleep_details / sessions / daily_physiology_series
  → get_day_snapshot / get_days / get_range  → frontend
```

## Level A — BLE notification archive (the re-decode source)

Every relevant ATT notification is written exactly as delivered by
CoreBluetooth **before** protocol parsing or reassembly modifies it. This is
the archive that lets a future reassembler/decoder be re-run years later.

Primary writer: iOS `SensorQueue.appendNotify(_:…)` → `ble-frames.ndjson`
(Application Support, appended with fsync on its own serial IO queue — never
the main actor). Each line:

```json
{"schema":1,"kind":"notify","seq":12,"t":"2026-08-25T02:00:00.000Z",
 "family":"puffin","char":"FD4B0003-…","hex":"aa0114…","n":47,
 "fw":"50.35.x","model":"WHOOP 5.0 / MG","decoder":"frwhoop-whoop-ble/1"}
```

- **Lossless**: `hex` is a single ATT payload and is never truncated. `n` is
  the original byte count. (Changed in this mission: the prior 8192-byte cap
  could, in principle, slice an oversized delivery.) `tests/lossless.test.js`
  locks this in.
- **Metadata keeps replay context**: opaque device id (the BLE peripheral
  identifier) lives in the connection, plus family, characteristic UUID,
  receive timestamps, per-connection ordinal (`seq`), app/firmware/collector
  versions, and today's `interp` sidecar. `firmware` and `model` are recorded
  when known.
- Characteristic relevance: WHOOP streams (`61080003/4/5`, `FD4B0003/4/5/7`),
  HR `2A37`, battery `2A19`, firmware `2A26`, model `2A24` are archived.
- The backend archives Level A as hourly gzip NDJSON under
  `v3/core/users/{user}/devices/{device}/frames/…` (format
  `ndjson_gzip_frames_v1`).

## Level B — reassembled protocol frame archive

Complete WHOOP protocol frames, after fragment reassembly, are archived
separately from the decoder so a newer decoder can reinterpret them.

- **At collection time (iOS)**: reassembly (`ingest`/`popFrame`) is performed
  to drive the live HR/history path. Because Level A already preserves every
  notify byte, Level B for historical data is reconstructable on demand.
- **At replay time (backend, this mission)**: the redecode pipeline
  (`protocol/framing.js` `WhoopReassembler` + `redecode/redecode.js`) re-feeds
  Level A notifies, verifies each frame (family-aware CRC), and emits Level B
  frame records with full lineage:
  frame_hex, frame_length, declared_length, packet_type, packet_name, version,
  crc8_ok, crc32_ok, crc_ok, decode_status, decoder, frame_hash, t (receive),
  seq, char, source_notify_seq.
- Level B objects persist to B2 as a distinct immutable `frames_reassembled`
  stream (`redecode/archive.js` `writeLevelBObject`), with SHA-256 + size
  verification and idempotent manifest commit. See REDECODE_PIPELINE.md.

## Stores and durability

| Concern | Design |
|---|---|
| Survives app restart / kill / OS kill | append-only NDJSON in Application Support, fsynced per append |
| Survives B2 / Supabase / network outage | durable local outbox (`sensor-queue`, `ble-frames`, `historical-physiology`); backend hour WALs are retry state |
| Survives Bluetooth reconnect | partial-frame bytes stay in Level A; reassembler resets and accounts the incomplete frame |
| No main-thread disk IO | all `SensorQueue` IO on the `frwhoop.sensor-queue` serial queue; backend buffers off the request path |
| No rewrite of an ever-growing JSON doc | append-oriented; ack prunes acknowledged prefixes |
| Duplicate uploads / retry storms | seq-based acks (`acked_through`, `frames_acked_through`, `history_acked_through`) + recent-seq dedupe |
| High-rate responsiveness | hourly independent flushes for physiology vs frames (a frames failure never re-queues physiology) |

## Historical trim safety

A history chunk may only be acknowledged after durable local persistence. iOS
tracks `historyPersistStalled`; it is set when a raw notify or a historical
sample fails to persist durably, and the strap trim ack (`HISTORY_END`
acknowledgement) is **not** sent while stalled. The backend only reports
`history_acked_through` for rows that reached durable history WAL fsync
(`historyBuffer.appendBatch`). If durable persistence fails, the trim is not
acknowledged and WHOOP retransmits. See BLE_STORAGE_FAILURE_MODES.md for the
tested failure modes.
