# WHOOP5_PROTOCOL_NOTES.md — critical wire facts for implementing WHOOP5 commands

Derived from NOOP @ ab0f699e source + docs (WHOOP5_DEEP_DATA.md, Whoop5Config.swift, Framing). These are
the facts FRWHOOP must honor to correctly ask the strap for more (and more raw) data. Each is the cure
for a `WRONG_WHOOP5_COMMAND_FRAMING` blocker.

## Frame / command framing
- Puffin envelope: `[0xAA][0x01][declLen u16 LE][0x0100][crc16-Modbus(6 header bytes)][inner][crc32 LE]`.
- **b3 (4th inner byte)** selects the command class: `0x01` for GET_HELLO / SET_CONFIG, `0x00` for
  GET_DATA_RANGE / SEND_HISTORICAL. NOOP carries `b3` as the first payload byte of the command.
- **Write WITH RESPONSE** only — the strap silently drops write-no-response on the command characteristic.

## R22 feature-flag enable (SET_FF_VALUE = 120 = SET_CONFIG 0x78)
- One write per flag; 40-byte body = flag name ASCII NUL-padded to 32 + value byte (ASCII '1'/'2') at
  offset 32 + 7 zero bytes.
- 16 flags; `enable_r22_packets='2'` is the master that opens the live type-0x2F (=47 HISTORICAL_DATA)
  high-rate stream. Flags 1-15 from judes.club; flag 16 `enable_sig12` from a real HCI capture (#103).
- Writes are on-wrist gated (bonded AND worn) on 5/MG. macOS CoreBluetooth can't do the authenticated
  SMP bond → no R22 write path on Mac.
- Reversible (rewrites flag to off), but NOOP has no read-before-write snapshot → re-apply baseline.

## Raw accel / raw optical (START_RAW_DATA 81)
- NOOP's live raw-accel capture sends `START_RAW_DATA(81)` payload [0x01] AND `TOGGLE_IMU_MODE(106)`
  payload [0x01] for a bounded window, then `STOP_RAW_DATA(82)` ([0x01]).
- The type-43 variant is selected by recorded data length (whoop4: 1917 = IMU 100Hz×6 axes i16;
  1921 = optical 437Hz, 419 × s24 + aux byte). whoop5 offset-shift (+4) is a structural hypothesis pending
  a real whoop5 raw flood. See protocol/whoop5.js `decodeRealtimeRaw43`.

## Decoding facts
- Baseline: v18/v20/v21/v26 historical records and the type-40/43/48/49/50 decoders are now ported
  byte-for-byte in FRWHOOP protocol/whoop5.js (lineage frwhoop-js/1 <- noop@ab0f699e).
