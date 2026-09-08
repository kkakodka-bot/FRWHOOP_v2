# FRWHOOP_PROTOCOLLAB.md — the existing bounded WHOOP5 experiment harness

FRWHOOP already ships a bounded, debug-gated WHOOP 5 experiment harness
(`frontend/ios/App/App/WhoopBlePlugin.swift`, `runProtocolLab(phase:)`). This is the seed of the
mission's "ProtocolLab" facility (Phase 28). It is evidence that FRWHOOP's live command path *can* write
to the WHOOP 5 command characteristic from a bonded strap on iOS.

## Phases implemented (one-shot, bounded, record-before/after)
| Phase | Commands sent | Window (before→after) | Notes |
|---|---|---|---|
| `baseline` | none (census only) | 8 s | measures the packet census before any write |
| `cmd81` | `START_RAW_DATA(81)` payload `[0x01]` | 8→15 s | alive raw-accel trigger |
| `r22` | all 16 `SET_FF_VALUE(120)` flags (enableR22Sequence) | 8→20 s | the official-app unlock burst |
| `cmd105` | `TOGGLE_IMU_MODE_HISTORICAL(105)` `[0x01]` + `SEND_HISTORICAL_DATA(22)` `[0]` | 8→15 s | historical-IMU mode + history request |
| `cmd106` | `TOGGLE_IMU_MODE(106)` `[0x01]` | 8→15 s | live-IMU mode; **sent at most once per process**; firmware silence recorded, not retried |

Guard rails built in:
- requires a **bonded** WHOOP 5/MG and `.connected` state;
- runs on a serial `queue` with a `labBusy` latch (no concurrent experiments);
- records a **lab census before and after** each phase: packet-type histogram, historical-version
  histogram, type-43 count, and command-response list (cmd + result);
- `cmd106` is deduplicated per process (send once, record result, never retry).

## What the census captures (`labCensus`)
`packet_types`, `hist_versions`, `type43` (count), `cmd_responses` (`[{cmd, result}]`). This is exactly
the before/after differential the mission requires for classifying each stream's blocker.

## Gap between the lab and production on-wrist data
- The lab is **not** wired into the normal connect / history-sync flow. A normal FRWHOOP connect still
  sends only `GET_HELLO` and runs the 15-min v18 history loop; it does **not** send the R22 flags or the
  raw/IMU commands.
- So the highest-value next step is **opt-in wiring of the R22 16-flag burst (plus history-enable) into
  the standard connected path**, so every session captures the deep v18/v20/v21/v26 records that
  FRWHOOP's backend `protocol/whoop5.js` already decodes at full NOOP parity.

## Proposed ProtocolLab extensions (all known-safe, reversible)
1. Add `E-OPT-437` (START_RAW_DATA expecting a 437 Hz optical flood) with an optical-config census.
2. Add `E-FF-READ` (117/118) + `E-DC-READ` (115/116/121) read-only enumeration phases, parsing replies
   with `protocol/whoop5.js decodeConfigReadBack`.
3. Add skip/cleanup for R22 (re-write flags to off) and a battery/airtime measurement after each phase.
4. Persist every phase's Level A bytes + census to B2 so successors can reason from real evidence.
5. Label each phase with the physical action expected (stationary / rotations / occlusion / on-off
   wrist) so the sensor-identity experiments (v20 wavelengths, SpO2, temperature) can be replayed.

See `WHOOP5_HARDWARE_EXPERIMENT_QUEUE.md` for the full per-experiment run books.
