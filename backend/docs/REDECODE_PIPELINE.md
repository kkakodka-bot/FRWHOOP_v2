# REDECODE PIPELINE

A WHOOP packet is immutable evidence; a decoder is a versioned interpretation.
When a new packet/version is reverse-engineered, FRWHOOP should be able to
select the historical raw bytes and re-run a newer decoder over them without
any new collection. This module implements that.

## Modules

| Path | Responsibility |
|---|---|
| `protocol/crc.js` | crc8, crc16-Modbus, crc32 ports (verified against standard check values) |
| `protocol/framing.js` | family-aware frame verification + `WhoopReassembler` (adversarially safe) |
| `protocol/decoder.js` | versioned `decodeFrame` with full lineage; never throws, preserves unknown/malformed bytes |
| `redecode/redecode.js` | `replayNotifies` (Level A → Level B), `compareDecodes`, integrity accounting |
| `redecode/archive.js` | idempotent Level B object write to B2 + manifest commit |
| `bin/redecode.mjs` | CLI |

## Replay levels

1. **Level A → reassembler.** Replays a notify archive through the
   `WhoopReassembler`, handling frames split anywhere, multiple frames per
   callback, partial header/length/CRC, garbage, corrupted lengths, truncated
   sequences, resets, and duplicates.
2. **Reassembled → verify.** Each complete frame is validated with the correct
   family header CRC and payload CRC32.
3. **Verified → Level B.** A Level B record is emitted for every frame —
   including CRC-failed, unknown packet type, malformed, and oversized — so
   nothing is deleted or reinterpreted-in-place.
4. **Level B → decoder.** `decodeFrame` classifies the packet type / version
   and decodes type-40 HR (family-aware offsets), identifies type-43 variants,
   and reads the type-47 version+header. Everything else is `unknown` with
   bytes preserved.

## Selection filters

`replayNotifies` supports:
- time range (`startAt`/`endAt`)
- user/device (via the archive selection at the caller / B2 prefix)
- packet type (`packetTypes`)
- packet/record version (`versions`)
- firmware family (per-connection `family`)
- unknown-only (`unknownOnly`: only packets currently undecodable)

## Idempotency

- Replaying the same Level A input yields the same deterministic `frame_hash`
  set, so redecode output is stable.
- `writeLevelBObject` derives deterministic object keys; a retried redecode
  short-circuits an already-`ready` manifest (`.duplicate === true`), so it
  never duplicates an object. Rows already persisted under the same
  `(frame_hash, decoder)` are not re-emitted as structured metrics.

## Compare old vs new

`compareDecodes(levelA, {decoderA, decoderB})` diffs the two interpretations
and reports frames whose decode status / packet type / HR changed. This is how
a decoder improvement is validated against historical data before a full
recompute.

## Recompute downstream

Structured metric recompute consumes `ready`/`verified` physiology manifests.
After a newer decoder runs and writes new decoded records (Level B /
structured samples), the affected `daily_physiology_series` and
`daily_metrics` are invalidated and rebuilt from the corrected inputs, with
`metric_runs` recording the decoder version.

## CLI

```text
node bin/redecode.mjs <levelA.ndjson[.gz]> [options]
  --family harvard|puffin|auto   generation (default auto-by-char)
  --decoder <version>            decoder version to apply
  --startAt/--endAt <ISO>        time bounds
  --packet-type <n[,n]>          only these packet types
  --version <n[,n]>              only these versions
  --unknown-only                 only currently-undecodable packets
  --out <path>                   write Level B frame records (NDJSON)
  --compare <oldDecoder>         diff current vs an old decoder
  --summary                      full integrity accounting (JSON)
  --observed                     unknown-protocol observation tally
```

Example:

```bash
node bin/redecode.mjs /tmp/levelA.ndjson --summary --out /tmp/levelB.ndjson
node bin/redecode.mjs frames/2026/08/25/02.ndjson.gz --unknown-only --observed
```

## Encodings are separate from interpretation

- `raw_hex` is the immutable payload evidence.
- `interp` / `decoded` are today's interpretation with the decoder version.
- The `frames` stream (Level A) is never treated as a semantic store; re-decoding
  reads raw hex and re-applies the current decoder.
