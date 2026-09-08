# WHOOP5_HARDWARE_EXPERIMENT_QUEUE.md

A structured queue of physical experiments that require a real WHOOP 5.0 strap. Each entry is a
known-safe probe derived from current upstream (ryanbr/noop @ ab0f699e) evidence + static analysis.
Nothing here touches firmware, DFU, auth/crypto bypass, or destructive commands. Every experiment
archives Level A BLE, reassembled frames, command/response, console logs, and device metadata.

Rules: run in an isolated ProtocolLab session; enable a bounded capture; capture baseline first; do
one configuration change; capture; restore; compare. Never enable an unknown feature flag — research
it first via the read-only enumeration (117/118, 115/116).

---

## E-81 — Live raw accelerometer via START_RAW_DATA (command 81)
- Hypothesis: WHOOP 5, when sent `START_RAW_DATA(81)` with payload `[0x01]`, emits a live realtime
  raw-accelerometer stream (NOOP evidence: `BLEManager.captureRawAccel` pairs 81 + 106 for a bounded
  window; Asherlc/dofek documents a type-0x2B raw packet).
- Expected packet change: a type-43 / type-0x2B realtime flood appears (live, unprompted).
- Command/config: `START_RAW_DATA(81)` payload `[0x01]`; optionally `TOGGLE_IMU_MODE(106)` payload
  `[0x01]` as NOOP pairs them.
- Required starting state: freshly connected strap, historical offload complete (so it can't conflict),
  Level A capture running.
- Required physical action: none to trigger; then stationary / axis rotations / deliberate motion to
  drive the stream and validate axes/scale.
- Data to capture: full packet census before/during/after; every characteristic; frame sizes; samples
  per frame; timestamps.
- Success: 6-axis IMU (or ≥3-axis accel) decoded at its claimed rate; accel magnitude sphere-fits ~1 g
  stationary; axis polarity matches physical rotations.
- Failure: command ack but no stream → classify `FIRMWARE_ACKNOWLEDGES_BUT_DOES_NOT_STREAM`.
- Cleanup: `STOP_RAW_DATA(82)`, confirm historical offload still works, measure battery/airtime.
- Safety: low; reversible command, bounded on NOOP's evidence.

## E-106 — Live IMU mode (command 106)
- Hypothesis: `TOGGLE_IMU_MODE(106)` alone may only ack without streaming (NOOP history); combined with
  81 it is part of NOOP's live raw-accel path. Reproduce cleanly once per firmware.
- Expected packet change: see E-81; note whether a full 6-axis live stream appears.
- Command/config: `TOGGLE_IMU_MODE(106)` payload `[0x01]`.
- Starting state: baseline census first.
- Physical action: rotations (90/180/360) to reveal gyro if present.
- Success: a live IMU/gyro stream appears and decodes.
- Failure: `ACKNOWLEDGED_NO_STREAM` — record it; do NOT retry repeatedly.
- Cleanup: none needed if no stream; else restore prior mode.
- Note: the historical v21 already proves gyro samples are generated; the target is how firmware banks
  or emits them.

## E-105 — Historical IMU mode (command 105)
- Hypothesis: `TOGGLE_IMU_MODE_HISTORICAL(105)` changes what the strap banks to its internal history,
  potentially increasing v20/v21 IMU coverage.
- Expected packet change: on next history request, different version mix / frame sizes / counts
  (more v21, more gyro coverage).
- Command/config: `TOGGLE_IMU_MODE_HISTORICAL(105)` (known-safe, reversible).
- Starting state: baseline historical packet inventory before enable.
- Physical action: a prescribed movement sequence (walk, run, rotations, stationary) before banking.
- Data: versions emitted, frame sizes, v20/v21 behavior, packet-52 behavior, sampling duration/sec.
- Success: increased banked 6-axis coverage.
- Cleanup: disable/restore; measure flash + battery.
- Safety: low–med; known-safe reversible op.

## E-OPT-437 — Raw 437 Hz optical (the priority target)
- Hypothesis: WHOOP 5 can emit the raw optical waveform at ~437 Hz (type-43 variant per NOOP
  whoop_protocol.json, WHOOP4 offsets; whoop5 +4-shift hypothesis), carrying a single AC-coupled PPG
  channel with per-sample aux (byte[3]) and optical config header (drive/source/range/offset/detector).
- Expected packet change: a dense type-43 optical stream (~419 samples/pkt @ ~437 Hz).
- Command/config: `START_RAW_DATA(81)`; possibly an optical-mode gate (ENABLE_OPTICAL_DATA 107 /
  TOGGLE_OPTICAL_MODE 108) or an R22/feature-flag combination — test each independently.
- Required starting state: fresh connection, Level A capture.
- Physical action: finger/ambient/off-wrist, then scope occlusion; record so optical channels can be
  separated from motion.
- Data: all bytes; confirm 419 samples, s24 LE, aux byte[3], config header [15:42]-whoop4 / +4-whoop5.
- Success: decode a stable ~437 Hz single channel whose autocorrelation peaks at HR (as NOOP verified
  on v26); red/IR/ambient NOT yet separable — do NOT name wavelengths.
- Cleanup: STOP_RAW_DATA(82); restore optical mode.
- Safety: low; read-mostly capture of a firmware-provided stream.

## E-R22 — R22 unlock + live type-47 enrichment
- Hypothesis: the official-app unlock is a 16-write `SET_FF_VALUE(120)`/`SET_CONFIG(0x78)` feature-flag
  burst (flags 1-16; body = ASCII NUL-pad32 name + ASCII '1'/'2' value@32 + 7 zeros; enable_r22_packets='2'
  is the master). CRITICAL: the resulting "type-0x2F" stream IS type 0x2F = 47 = HISTORICAL_DATA emitted
  LIVE at high rate (v18/v20/v21/v26) — NOT a new packet type. So R22 enriches the exact records FRWHOOP
  already decodes at full resolution. First test whether a clocked 5/MG already returns deep history
  through the plain get_data_range/send_historical_data loop (goose #24 shows a Gen5 doing so with NO
  config write) — R22 may be belt-and-suspenders.
- Command/config: replicate the 16-write burst byte-for-byte (golden frame pinned in NOOP
  Whoop5ConfigTests), one flag at a time for attribution.
- Starting state: fresh connection.
- Physical action: stationary, rotations, then sleep to drive optical/RR/SpO2-relevant fields.
- Data: every type-0x2F field vs the offline map; correlate with v18/v20/v21/v26 and the app.
- Success: map which flag/combination opens each new packet/field; identify raw optical, optical
  quality, perfusion, motion quality, cardiac intervals, saturation.
- Cleanup: rewrite flags to off ('0'); note no read-before-write snapshot exists → re-apply baseline.
- Safety: reversible feature flags; research first; do not enable unknown flags.

## E-FF-READ — Read-only feature-flag enumeration (117/118)
- Hypothesis: WHOOP 5 answers `START_FF_KEY_EXCHANGE(117)` + `SEND_NEXT_FF(118)` and reports its own
  feature-flag names (VERIFIED answered on 5/MG per NOOP).
- Command/config: 117 then repeated 118; read-only.
- Starting state: any.
- Data: full flag-name list by firmware version + 128 GET_FF_VALUE read-backs.
- Success: enumerate every flag name; diff against NOOP known + official-app writes + R22 flags.
- Cleanup: none (read-only).
- Safety: low; read-only.

## E-DC-READ — Read-only device-config enumeration (115/116/121)
- Hypothesis: `START_DEVICE_CONFIG_KEY_EXCHANGE(115)`/`SEND_NEXT_DEVICE_CONFIG(116)` + `GET_DEVICE_CONFIG_VALUE(121)`
  serve clean read-backs on WHOOP 5 (VERIFIED on 5/MG).
- Command/config: 115/116 enumeration then 121 GET per key (keys incl. enable_raw_data_w_ecg,
  whoop_live_hr_in_adv_ind_pkt).
- Data: config keys/values by firmware; correlate with official-app connection + R22 enable + sleep/
  workout/charging states.
- Cleanup: none.
- Safety: low; read-only; do not write.

## E-OPTICAL-MODE — Optical-mode / optical-data toggles (107/108)
- Hypothesis: `ENABLE_OPTICAL_DATA(107)` / `TOGGLE_OPTICAL_MODE(108)` alter the optical stream
  (multichannel, red/IR/green, channel count) or its sample rate.
- Command/config: test each flag independently, bounded.
- Data: packet census + optical packet shapes before/after.
- Success: a new optical stream/channel count appears; identify channel set.
- Cleanup: restore.
- Safety: low–med; reversible toggles.

## E-SCALED-OPTICAL — v20 channel identity (labelled optical capture)
- Hypothesis: v20's six active channels (blocks 0/3/4) are optical measurement pairs; wavelength
  identity is OPEN. A labelled occlusion/motion capture separates them from motion and finds the red/IR
  pair.
- Physical action: opaque occlusion of the optical window while stationary; on/off wrist; ambient
  changes; known cadence.
- Data: synchronized v18/v20/v21/v26 + physical label (see SENSOR_GROUND_TRUTH).
- Success: classify channel blocks (PHYSICALLY_VERIFIED red/IR/green/ambient) or bound them as
  detector/readout pairs with configuration.
- Cleanup: none.
- Safety: low.

## E-SPO2 — Nightly SpO2 validation (split evidence)
- Hypothesis: v18 @82 (`spo2_candidate_82`, 70-100 during sleep) is a strap-computed SpO2 % — evidence
  is split across devices; validation may also reveal raw red/IR inputs in v20/v26/R22.
- Plan: collect Level A raw + official exported nightly SpO2 across several nights (multiple straps/
  firmwares); test which wire value(s) predict the official aggregate WITHOUT overfitting one device.
- Success: settle whether @82 is SpO2; identify red/IR raw channels if present.
- Failure: if the firmware doesn't emit enough optical info to compute SpO2, state that clearly.
- Cleanup: none.

## E-TEMP — temperature rawest representation
- Hypothesis: skin_temp_raw@73 (u16 /100->°C) is the raw register; aux temp channels @69/@71 are
  signed-10ths; check for an even rawer internal/ADC value and charging-temperature change.
- Physical action: warm/cool the strap; on/off wrist; charging.
- Data: v18 temp fields + events TEMPERATURE_LEVEL + any console temp lines across states.
- Success: pin the least-processed representation and confirm aux/internal/ambient channels.
- Cleanup: none.

## E-CONSOLE — console-log mining
- Hypothesis: type-50 console logs narrate sensor pipeline state ("SENSORS: AFE configuration changed",
  "SIGPROC: generated a valid SPO2 during sleep") that reveals modes/streams.
- Plan: capture console logs around every experiment; index by keyword (IMU/accel/gyro/optical/PPG/LED/
  R22/sensor/research/raw/stream/save/flash/temp/cap/contact/quality/saturation/sleep/sync/feature/config).
- Success: correlate new log lines with commands and stream transitions to find hidden modes.
- Cleanup: none. Console logs are research-only; never expose to normal users.

## E-WHOOP5-T43 — confirm whoop5 type-43 offset shift
- Hypothesis: whoop5 emits type-43 with the same layout +4 (type at 8). The FRWHOOP decoder already
  decodes it structurally; a real whoop5 raw flood confirms the length key and the +4 shift.
- Plan: E-81 capture, then check whether the decoder's whoop5 [+4] hypothesis reproduces a valid
  gravity shell / 100-sample channels. Adjust offsets from evidence if needed.
- Safety: low.

Run these in priority order: E-R22, E-OPT-437, E-81, E-FF-READ, E-DC-READ, E-105, E-106, then the
identity/labelled captures (E-SCALED-OPTICAL, E-SPO2, E-TEMP, E-CONSOLE, E-WHOOP5-T43).

## Wire facts that block command implementation (WRONG_WHOOP5_COMMAND_FRAMING class)
- **b3 (4th inner byte)** of the puffin command matters: GET_HELLO / SET_CONFIG want `0x01`;
  GET_DATA_RANGE / SEND_HISTORICAL want `0x00`. NOOP carries `b3` as the first payload byte.
- **Write WITH RESPONSE** is mandatory — write-no-response is silently dropped by the strap.
- R22/feature-flag body: ASCII flag-name NUL-padded to 32 bytes + value byte ('1'/'2') at offset 32 +
  7 zero bytes (40 bytes total).
- R22 writes are on-wrist gated (bonded AND worn on 5/MG); macOS CoreBluetooth cannot complete the
  authenticated SMP bond for the command characteristic (write path unavailable on Mac).
