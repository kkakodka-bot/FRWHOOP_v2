# BLE STORAGE FAILURE MODES

Every failure mode below has a behavior and (where implemented) a test. None
may silently lose WHOOP bytes.

## Local (iOS) / backend local store

| Failure | Behavior |
|---|---|
| `SensorQueue.append` write fails | returns nil; caller must not ack; for whoop-stream notifies `historyPersistStalled=true` blocks the trim ack |
| `appendNotify` write fails | `rawPersisted=false`; the iOS `ingest()` path is skipped so a partial frame never reaches HISTORY_END; the notify is not acked |
| App killed between raw save and decode | Level A bytes are already fsynced; reassembly is replayable |
| App killed between B2 upload and manifest commit | object exists in B2 with a `pending` manifest; `reconcile.js` marks it `ready` on the next pass (size/checksum verified) |
| App killed between manifest commit and local delete | local outbox ack is re-sent; duplicate upload short-circuits at the manifest (`ready`) — idempotent |
| Backend hour WAL rewrite fails | `flushFrames`/`flushSamples` re-push the batch and retry; physiology and frames are independent |
| Local disk full | append returns nil → not acked → not trimmed; drops are observable, never silent (see DATA_INTEGRITY_INVARIANTS) |

Backend WAL files are retry state only and fsynced (`historyBuffer` writes via
`writeDurable`). On recovery, `recoverWal` / `recoverFramesWal` / `recover`
re-admit pending rows before any ack is sent.

## Bluetooth / transport

| Failure | Behavior |
|---|---|
| Frame split at any byte | reassembler joins; Level A has both halves |
| Multiple frames in one callback | all emitted in order |
| Partial header / length / CRC | waits, then on retransmit reassembles |
| Garbage before SOF | skipped, bytes accounted as `resync_dropped_bytes`, kept in Level A |
| 0xAA injected inside payload | length-driven framing ignores it |
| Corrupted length | capped at `MAX_FRAME_BYTES`; drops that SOF, resyncs, bytes kept |
| Truncated sequence | incomplete frame discarded but accounted + bytes kept in Level A |
| Disconnect mid-frame | `reset()` accounts the incomplete frame; Level A has the bytes |
| Reconnect | new reassembler; earlier bytes still in Level A |
| Duplicate delivery | preserved as physical frames; dedup is downstream |
| Very large frame | within the 8192 cap reassembles; oversized preserved in Level A |
| WHOOP4 vs WHOOP5 | family-aware framing, verified not-a-4-byte-offset |
| Unknown future frame | reassembled + retained (tests lock this in) |

## Cloud

| Failure | Behavior |
|---|---|
| B2 500 / timeout | hour buffer re-queues batch; WAL retained; retried |
| B2 checksum / size mismatch | `completeUpload` marks manifest `failed`; `reconcile.js` flags `checksum_mismatch` / `size_mismatch` |
| B2 duplicate upload | idempotent object key + manifest short-circuit |
| Supabase timeout / transaction failure | outbox retries; no ack until durable |
| Supabase outage | local outbox accumulates; no data loss |
| Stale pending manifest | `reconcile.js` marks `failed` after 1 h if no object |

## Historical trim safety

The step order that protects against data loss:

1. strap sends HISTORY_END (candidate trim point)
2. iOS requires durable local persistence of the window bytes
3. only then is the trim ack sent to the strap
4. B2 upload happens asynchronously from the durable local outbox
5. if durable persistence fails at any point, no trim ack → WHOOP retransmits

`historyPersistStalled` is cleared at the next HISTORY metadata `.start` and
drives whether HISTORY_END ack is emitted.

## Tested failure modes (see tests/)

- `tests/protocol/framing.test.js` — split-at-every-byte, multi-frame,
  partial header/length/CRC, garbage, corrupted length, truncated sequence,
  disconnect+reconnect, duplicate delivery, very large frame, WHOOP4/5, unknown
  future variant.
- `tests/redecode/redecode.test.js` — clean-stream `dropped_records===0`,
  duplicates counted, time-range drop reasons, incomplete-stream accounting,
  mixed-generation replay, unknown-only selection, compare.
- `tests/redecode/archive.test.js` — idempotent Level B write, B2 object +
  manifest lifecycle, PII-free keys.
- `tests/lossless.test.js` — oversized payload preserved in full.
