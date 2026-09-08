# WHOOP 5.0 Sensor Hardware Matrix — physical sensor baseline

**Scope.** This matrix documents the *physical sensing subsystems* of the **standard WHOOP 5.0 strap**
(NOT WHOOP MG). It is an evidence-only build from the in-repo NOOP WHOOP-protocol code and the NOOP /
FRWHOOP design docs. Every confidence class is backed by a cited `file:line`; nothing is inferred from the
WHOOP marketing datasheet. Fields whose physical identity requires more hardware work are marked honestly.

**NOOP compilation baseline.** `ab0f699e` ("Decode the v20 optical record's eleven config fields, and
CRC-gate it (#423)") — verified as the NOOP HEAD by `git -C noop log -1` in this working copy. All file:line
citations below are against that commit. Commit `ab0f699e` itself was `Whoop5RawOptical.swift` (+211),
`Whoop5RawOptical` oracle/validation, and the Swift/Kotlin mirrors.

**WHOOP MG ECG is out of scope.** The standard WHOOP 5.0 does **not** carry the MG's ECG electrodes
(`Whoop5Ecg.swift:5-6` — "The WHOOP MG carries ECG electrodes in its conductive clasp (a plain WHOOP 5.0
does not)"). ECG is therefore *excluded* from this 5.0 baseline (see "Explicitly absent", below).

---

## 1. Confidence classes

| Class | Meaning |
|---|---|
| **PHYSICALLY_VERIFIED** | A real WHOOP 5.0 capture validated the physical phenomenon (gravity shell, HR-locked pulse, physiological °C, monotonic step counter), or an on-strap event/command round-trip confirmed it. |
| **STRUCTURALLY_VERIFIED** | The field/offset layout was decoded and validated over a large real-capture corpus, but its physical identity, units, or register semantics are not fully established. |
| **STRONG_CANDIDATE** | Evidence indicates a physical subsystem but it is not yet physically verified (e.g. split/interrupted evidence). |
| **WEAK_CANDIDATE** | Some evidence exists; not established. |
| **UNKNOWN** | No evidence, or the physical identity cannot be determined from current captures. |

---

## 2. Master sensor matrix

Columns: subsystem | hardware-verified? | what it measures | sample rate / resolution |
firmware representation (v18/v20/v21/v26/R22) | FRWHOOP persistence path | confidence class.

| # | Subsystem | Hardware-verified? | What it measures | Sample rate / resolution | Firmware repr | FRWHOOP persistence path | Confidence |
|---|---|---|---|---|---|---|---|
| 1 | **Optical PPG (photoplethysmography)** | Yes — HR-locked pulse on real captures | Blood-volume pulse waveform; drives HR + R-R | **v26:** 24 Hz, 24× LE-i16 ADC counts/sec; **v20:** ~25 Hz (25× signed-20-bit/slot); 1 Hz record cadence | v18 (optical tail `@106/107/108/109`), v20 (5 optical blocks), v26 (24 Hz waveform), R22 type-0x2F realtime | Today: live HR/RR via `POST /api/ble/live` → B2; proposed `ppg_raw` B2 stream (`RAW_SIGNAL_ARCHIVAL.md:30`); Level A raw `ble-frames.ndjson` → B2 `frames/` | **PHYSICALLY_VERIFIED** |
| 2 | **Optical front-end control / signal conditioning** | Structurally — configs read from 29,203 real records | Per-measurement-block emitter selection, LED drive current, detector range (gain), offset, detector routing | Config fields only (no sample rate): 21-byte block head | v20 (5× 422-byte blocks) | Proposed `ppg_raw` + `sensor_quality` (quality/wear flags); Level A raw bytes → B2 `frames/` | **STRUCTURALLY_VERIFIED** (physical register/unit identity **UNKNOWN**) |
| 3 | **Accelerometer (3-axis)** | Yes — gravity shell on real 5.0 | Linear acceleration in g | 100 Hz, 100× i16 per 1-s buffer, `1/4096` g/LSB | v21 (`accel_*` @28/228/428), v18 (`gravity_*` f32 g, `dynamic_acceleration`) | Proposed `imu_raw` B2 stream (`RAW_SIGNAL_ARCHIVAL.md:28`); Level A/B B2 | **PHYSICALLY_VERIFIED** |
| 4 | **Gyroscope (3-axis)** | Yes — near-zero at rest, correlates 0.79 with accel motion | Angular rate | 100 Hz, 100× i16 per buffer, `2000/32768` (°/s)/LSB = ±2000 dps | v21 (`gyro_*` @640/840/1040); together v21 = 6-axis IMU | Proposed `imu_raw` B2 stream; Level A/B B2 | **PHYSICALLY_VERIFIED** |
| 5 | **Skin temperature** | Yes — raw register → physiological °C on two straps | Skin temperature | v18 `skin_temp_raw` @73 u16 ADC; °C = raw/100; median ~34 °C worn; two aux thermal channels @69/@71 | v18 (`skin_temp_raw`, `temp_aux_1/2`); event `TEMPERATURE_LEVEL`(17) | `daily_metrics.skin_temp_c` column exists but is **not** populated by the live path (`SENSOR_ANALYTICS_ARCHITECTURE.md:93`); reachable via historical offload (:77) | **PHYSICALLY_VERIFIED** |
| 6 | **Capacitive / wear detection** | Wear/double-tap observed on hardware; "capacitive" is the project label | Wrist on/off, double-tap, skin contact | Event-driven (no steady rate) | v18 (`onwrist` b0-1 of `@81`, `motion_wear_quality` @63); events `WRIST_ON`(9)/`WRIST_OFF`(10)/`DOUBLE_TAP`(14) | Live `sleep_stage`/motion in `/api/ble/live`; proposed `sensor_quality` (wear flags) | **STRUCTURALLY_VERIFIED** (wear physically observed; capacitive modality is inference) |
| 7 | **Battery telemetry** | Yes — on-strap SoC/mV/charging | State-of-charge, mV, charging flag | Standard `2A19` + ~every 8 min `BATTERY_LEVEL` event | Event `BATTERY_LEVEL`(3); `EXTENDED_BATTERY_INFORMATION`(63); `GET_BATTERY_PACK_INFO`(151) | Live `battery` in `/api/ble/live`; B2 physiology | **PHYSICALLY_VERIFIED** |
| 8 | **Charging telemetry** | Yes — on-strap charge events | Charging on/off, external 5V | Event-driven | Events `CHARGING_ON`(7)/`CHARGING_OFF`(8)/`EXTERNAL_5V_OFF`(6) | B2 physiology; live path battery field | **PHYSICALLY_VERIFIED** |
| 9 | **Haptic state / motor** | Yes — command + event round-trip | Single haptic actuator state | Event/command (RUN/STOP), patterns | `RUN_HAPTICS_PATTERN`(79)/`STOP_HAPTICS`(122); events `HAPTICS_FIRED`(60)/`HAPTICS_TERMINATED`(100) | Classified / Level A+B B2; not exposed as a metric | **PHYSICALLY_VERIFIED** |
| 10 | **Body-location / device-status diagnostics** | Layout from real-capture static analysis; location semantics open | Body location, confidence, status | READ-only command response | `GET_BODY_LOCATION_AND_STATUS`(84 / 0x54) | Classified / Level A+B B2 | **STRUCTURALLY_VERIFIED** |
| 11 | **Step counter / cadence / activity class** | Structure verified; absolute accuracy not ground-truth checked | Cumulative steps, cadence byte, coarse activity class (still/walk/run) | Per-second (v18) | v18 `step_motion_counter` @57, `step_cadence` @59, `activity_class` @63 | Derived features / `derived_motion_features` stream | **STRUCTURALLY_VERIFIED** |
| 12 | **HR + R-R (cardiac)** | Yes — cross-checked vs live `2A37` | Heart rate, R-R intervals | 1 Hz (per-second summary); R-R in ms | v18 `heart_rate`@22, `hr_quality_flags`@36, `rr[]`@24; live `2A37` | Live `POST /api/ble/live` (`bpm`/`rr_ms`); B2 physiology + `rri_raw` | **PHYSICALLY_VERIFIED** |

---

## 3. Per-subsystem evidence (cited)

### 3.1 Optical PPG (row 1) — PHYSICALLY_VERIFIED
- **v26 = 24 Hz HR-locked waveform.** `Interpreter.swift:614-625` — v26 is a 24 Hz optical-PPG buffer: 24
  little-endian i16 samples at bytes `[27:75]`, one record per second; verified *not* to be IMU/motion by
  autocorrelation (lag 14 = 102.9 bpm vs a v18-measured 101.7 bpm), trough-detection (563 ms inter-beat ≈
  106 bpm), HR-locked even when still, amplitude not motion-driven. Field: `ppg_waveform` @27, "optical PPG
  @24 Hz, LE-i16 ADC counts" (`Interpreter.swift:652-654`).
- **v20 = configurable optical blocks.** `WHOOP5_DEEP_DATA.md:92-94` — v20 (2,140 B) is five repeated
  optical-measurement blocks; v26 carries the 24-sample PPG waveform. `Interpreter.swift:668-688` describes
  v20 as five 422-byte optical blocks, active blocks holding two 25-sample i32 channels (~25 Hz).
- **Optical tail in v18.** v18 carries optical/perfusion channels `optical_baseline_a/b` @106/107 and
  `optical_amp_a/b` @108/109 (`Interpreter.swift:571-596`) — amplitude-like channels that tracked *motion*,
  not HR, with a 128 signal-quality sentinel.
- **Drives HR/R-R and sleep gating on the 5.0.** FRWHOOP `PROTOCOL_COVERAGE.md` marks type-47 ("14-day
  biometric store") decoded/persisted for hr/rr/gravity; `SENSOR_ANALYTICS_ARCHITECTURE.md` capability table
  lists HR/RR live.

### 3.2 Optical front-end control / signal conditioning (row 2) — STRUCTURALLY_VERIFIED
- The v20 record is a *programmable* optical front-end, not a fixed waveform. `Whoop5RawOptical.swift:19-25`
  ("every offset … measured from NOOP's own BLE captures: 29,203 records, fw 50.40.1.0; a validator runs 54
  structural assertions over all 29,203 and accounts for 2140/2140 bytes").
- Each of the 5 blocks has a 21-byte head fully accounted for by eleven fields: `sample_count`, `source_a/b`
  (emitter selectors {1,2,3,4}), `drive_a/b` (LED drive; `driveB == 2*driveA`), `detector_a/b_select`
  (detector routing), `range_a/b` (gain: 32 or 16), `offset_a/b` (multiples of 800)
  (`Whoop5RawOptical.swift:12-17`, `33-46`, `56-79`).
- **Physical identity is deliberately *not* asserted.** `Whoop5RawOptical.swift:27-31` — "`drive*` is named
  only because … its units are not established; `source*` values {1,2,3,4} select something, but what each
  selects is unknown, and NOTHING in the corpus identifies an emission band. The two slots under one head …
  must not be labelled as two wavelengths." `WHOOP5_OPTICAL_EXPERIMENT.md:20` — "It intentionally does not
  call a block red, infrared, green, or ambient."
- **ADC domain is hardware-pinned.** Signed 20-bit; max over 730,075 samples exactly `2^19-1`, a saturation
  rail never exceeded (`Whoop5RawOptical.swift:182-186`, `279-285`).

### 3.3 Accelerometer (row 3) — PHYSICALLY_VERIFIED
- `Whoop5RawImu.swift:18` — 100× i16 accel at `@28/@228/@428`, scale `1/4096` g/LSB.
- Validation: `Whoop5RawImu.swift:22-24` — "VALIDATED on 1423 buffers from a real 5.0 (fw 50.40.1.0): accel
  magnitude is a 1.01 g gravity shell (100 % of samples within ±15 % of the median…)." Index-level gravity
  also in v18 (`gravity_x/y/z` f32 g @45/49/53, `Interpreter.swift:445-448`) cross-checked to `|gravity|≈1 g`
  on 100% of 500 records (`Interpreter.swift:364-366`).
- **100 Hz on the 5.0 is via the offload buffer, not the live stream.** `Whoop5RawImu.swift:11-13` — the
  live raw-IMU stream is firmware-refused (`TOGGLE_IMU_MODE`/cmd 106 acks but never streams), but the
  connect-time offload buffer carries full accel **and** gyro, so 100 Hz 6-axis IMU is obtainable via the
  historical path.

### 3.4 Gyroscope (row 4) — PHYSICALLY_VERIFIED
- `Whoop5RawImu.swift:20` — 100× i16 gyro at `@640/@840/@1040`, scale `2000/32768` (°/s)/LSB = ±2000 dps.
- Validation: `Whoop5RawImu.swift:22-24` — gyro "sits near zero at rest, spikes in motion, and correlates
  0.79 with accel motion." v21 decode notes the same: three accel channels sphere-fit to a ~1 g gravity shell
  (median |a|=1.006 g, 100/100 in-shell) — a gravity vector a PPG channel cannot produce
  (`Interpreter.swift:701-704`).

### 3.5 Skin temperature (row 5) — PHYSICALLY_VERIFIED
- v18 `skin_temp_raw` @73 u16; °C = raw/100 yields physiological worn temps (median ~34 °C across two straps;
  30.6 °C worn / 22.5 °C ambient off-wrist), with an on-wrist warming curve
  (`Interpreter.swift:487-500`). Two auxiliary thermal channels `temp_aux_1/2` @69/@71 (°C = value/10, corr
  ~0.92 / ~0.97 vs skin_temp) (`Interpreter.swift:476-486`).
- Event `TEMPERATURE_LEVEL`(17) surfaces the strap's own thermal event (`whoop_protocol.json:15`).
- FRWHOOP status: skin temp is **reachable, historical offload only — not decoded live**;
  `daily_metrics.skin_temp_c` exists but is never populated by the live path
  (`SENSOR_ANALYTICS_ARCHITECTURE.md:77,93`).

### 3.6 Capacitive / wear detection (row 6) — STRUCTURALLY_VERIFIED
- Events `WRIST_ON`(9)/`WRIST_OFF`(10)/`DOUBLE_TAP`(14) (`whoop_protocol.json:13-15`); the project labels
  double-tap "capacitive" (`BLE_REVERSE_ENGINEERING.md`, §7 sensor inventory).
- v18 carries `onwrist` (b0-1 of `@81`), `motion_wear_quality` @63 ("0=still/good, 1, 2=poor contact"), and a
  `sleep_state` byte (`Interpreter.swift:466-468, 514-530`). `enable_passive_strap_fit_gen5` and
  `wear_detect_bias` flags tune wear behaviour (`Whoop5Config.swift:71,68`).
- **Capacitive modality is an inference**, not a measured electrode count/electrical parameter, so the class
  stays STRUCTURALLY_VERIFIED pending hardware probing.

### 3.7 Battery & charging telemetry (rows 7-8) — PHYSICALLY_VERIFIED
- Standard `2A19` battery, the bond/hello path uses a benign `GET_BATTERY_LEVEL` write
  (`BLE_REVERSE_ENGINEERING.md` §1); `BATTERY_LEVEL`(3) carries SoC/mV/charging ~every 8 min with a real RTC
  timestamp (`Streams.swift:763,782`; `whoop_protocol.json:11`).
- Charging events `CHARGING_ON`(7)/`CHARGING_OFF`(8)/`EXTERNAL_5V_OFF`(6) (`whoop_protocol.json:13`).

### 3.8 Haptic state (row 9) — PHYSICALLY_VERIFIED
- Commands `RUN_HAPTICS_PATTERN`(79)/`STOP_HAPTICS`(122) and events `HAPTICS_FIRED`(60)/`HAPTICS_TERMINATED`
  (100) (`whoop_protocol.json:29,31,46,54`). The haptic motor is the strap's only feedback channel
  ("No microphone, no speaker, no GPS, no display — all feedback … via the single haptic motor",
  `BLE_REVERSE_ENGINEERING.md` §7).

### 3.9 Body-location / diagnostics (row 10) — STRUCTURALLY_VERIFIED
- `GET_BODY_LOCATION_AND_STATUS`(84/0x54) read-only probe returns location/enum + confidence + status
  (`BodyLocationProbe.swift:3-18`); on 5/MG replies carry an explicit result code @12 (FAILURE/SUCCESS/
  PENDING/UNSUPPORTED) (`BodyLocationProbe.swift:31-40`). Location semantics are kept raw — not established.

### 3.10 Step counter / cardiac (rows 11-12) — STRUCTURALLY_VERIFIED / PHYSICALLY_VERIFIED
- v18: `step_motion_counter` @57 (monotonic across a stream, no midnight reset), `step_cadence` @59,
  `activity_class` @63 (0 still / 1 walk / 2 run) (`Interpreter.swift:456-474`).
- v18 cardiac fields are cross-checked against live `2A37` HR (`Interpreter.swift:364-366`); HR @22 bpm,
  R-R @24 ms, `hr_quality_flags`@36 bit7 = HR/R-R valid (`Interpreter.swift:402-431`).

---

## 4. Explicitly absent / excluded on WHOOP 5.0

| Channel | Status on WHOOP 5.0 | Evidence |
|---|---|---|
| **ECG (Labrador)** | **Excluded — MG only.** Plain WHOOP 5.0 has no ECG electrodes. | `Whoop5Ecg.swift:5-6`; out of scope for this 5.0 baseline |
| **EDA** | Absent — no channel in any decoded layout | `SENSOR_ANALYTICS_ARCHITECTURE.md:84` |
| **Ambient temperature** | Absent — no channel in any decoded layout | `SENSOR_ANALYTICS_ARCHITECTURE.md:84` (only skin + aux-skin channels exist) |
| **Raw SpO₂ red/IR pair** | Not present on 5.0 v18 (v18 dropped the WHOOP 4.0 v24 `spo2_red@68`/`spo2_ir@70` channels) | `WHOOP5_DEEP_DATA.md` "Why SpO₂ … aren't available on 5.0" |
| **Blood pressure** | Not a decode target; no hidden BP scalar identified | `WHOOP5_DEEP_DATA.md` (BP section) |
| **High-rate realtime raw flood** | Live `TOGGLE_IMU_MODE`/`TOGGLE_OPTICAL_MODE` streams are firmware-refused on 5.0; raw high-rate data is only in the offload buffer | `Whoop5RawImu.swift:11-13` |

---

## 5. Subsystems/fields that MUST STAY **UNKNOWN** pending hardware

1. **v20 optical wavelength identity — UNKNOWN.** Which block maps to red / infrared / green is not
   determinable from the current corpus; blocks share one config and must not be labelled as two wavelengths
   (`Whoop5RawOptical.swift:27-31`; `Interpreter.swift:685-688,737-739`; `WHOOP5_OPTICAL_EXPERIMENT.md:20,114`). The passive controlled
   optical experiment (`WHOOP5_OPTICAL_EXPERIMENT.md`) is the required next step; **SpO₂/calibration work is
   gated on it** (`WHOOP5_OPTICAL_EXPERIMENT.md:114-116`).
2. **Optical front-end register / silicon identity — UNKNOWN.** `source_*` selector meanings, `drive_*`
   units, `range`/`offset` physical semantics are name-neutral and unpacked (`Whoop5RawOptical.swift:27-31`).
   A controlled one-variable intervention or a confirmed register map is required
   (`WHOOP5_OPTICAL_EXPERIMENT.md`, "Evidence rules").
3. **SpO₂ % — STRONG_CANDIDATE → effectively UNKNOWN for product use.** v18 `spo2_candidate_82` has **split
   evidence** (8-night val corr +0.99 vs two contradictory nights on the #103 device); it ships only as
   instrumentation, is duty-cycled (~30 s per window at `unix % 1200`, 2.4 % of 18,650 records nonzero), and
   **must never** back a shipped SpO₂ metric or feed a downstream gate until the cross-device contradiction is
   resolved (`Interpreter.swift:532-553`; `WHOOP5_DEEP_DATA.md` "@82 validation checklist").
4. **Capacitive sensing parameters — UNKNOWN.** Wear/double-tap events are observed, but electrode count,
   drive scheme, and electrical characteristics are unmeasured; "capacitive" is a labelled inference.
5. **Sample-rate parity across v18/v20/v21 against a real clock — partially UNKNOWN.** v20's ~25 Hz and
   v26's 24 Hz are derived from per-record sample counts at a 1 Hz record cadence; absolute on-strap sample
   clock accuracy and block 1/2 activation (always `[25,0,0,25,25]` in the corpus) are unproven
   (`Whoop5RawOptical.swift:33-46`; `WHOOP5_OPTICAL_EXPERIMENT.md:11`).
6. **`unknown_f32_113`, `aux_byte_82` tail fields, status words — UNKNOWN.** v18 @113 float (range ~−5.3…0),
   @75/@77/@79 status words, and the 83–119 padding are raw/unpinned (`Interpreter.swift:501-512,597-610`).

---

## 6. FRWHOOP persistence path (context for the matrix column)

- **Today the backend only receives the Capacitor live 4 s HR + scalar-motion path**; the native WHOOP 5.0
  deep decode (IMU/optical/skin-temp) has no server uploader yet
  (`RAW_SIGNAL_ARCHIVAL.md:7-18`).
- **Level A lossless archive exists** for every BLE notify byte → iOS `ble-frames.ndjson` (fsync before
  parse) → B2 `v3/core/.../frames/` (`ndjson_gzip_frames_v1`); Level B reassembled frames → B2
  `frames_reassembled` (`RAW_CAPTURE_ARCHITECTURE.md`, levels A/B). Any real 5.0 sensor bytes are therefore
  *recoverable* by writing a backend decoder without touching iOS.
- **Live metric path:** `POST /api/ble/live` `{datetime, bpm, rr_ms, motion, battery, sleep_stage}` → hourly
  B2 + `object_manifests` → metrics → `daily_metrics` (`SENSOR_ANALYTICS_ARCHITECTURE.md` §1).
- **Proposed Phase-0 raw streams** (key kinds from `storage/keys.js`): `imu_raw` (6-axis 100 Hz columnar
  i16, = `Whoop5RawImu.rawColumns`), `rri_raw`, `ppg_raw`, `sensor_quality`, `derived_motion_features`
  (`RAW_SIGNAL_ARCHIVAL.md:24-34`). Each raw row carries `strap_ts` + `wall_ts` (+ drift) for clock-drift
  auditing (`RAW_SIGNAL_ARCHIVAL.md`, "Timestamp synchronization").
- **Battery/bandwidth constraint:** continuous 100 Hz raw is ~104 MB/day/user uncompressed; the design
  default keeps `rri_raw`/`derived_motion_features` continuous and bounds `imu_raw`/`ppg_raw` to workouts +
  calibration windows (`RAW_SIGNAL_ARCHIVAL.md:62-71`).

---

## 7. Source index (paths relative to this repository, plus local `noop/`)

- `noop/Packages/WhoopProtocol/Sources/WhoopProtocol/Whoop5RawImu.swift`
- `noop/Packages/WhoopProtocol/Sources/WhoopProtocol/Whoop5RawOptical.swift`
- `noop/Packages/WhoopProtocol/Sources/WhoopProtocol/Whoop5Config.swift`
- `noop/Packages/WhoopProtocol/Sources/WhoopProtocol/Interpreter.swift`
- `noop/Packages/WhoopProtocol/Sources/WhoopProtocol/Whoop5Ecg.swift`
- `noop/Packages/WhoopProtocol/Sources/WhoopProtocol/BodyLocationProbe.swift`
- `noop/Packages/WhoopProtocol/Sources/WhoopProtocol/Streams.swift`
- `noop/Packages/WhoopProtocol/Sources/WhoopProtocol/Resources/whoop_protocol.json`
- `noop/docs/WHOOP5_DEEP_DATA.md`
- `noop/docs/WHOOP5_OPTICAL_EXPERIMENT.md`
- `noop/docs/BLE_REVERSE_ENGINEERING.md`
- `backend/docs/SENSOR_ANALYTICS_ARCHITECTURE.md`
- `backend/docs/RAW_SIGNAL_ARCHIVAL.md`
- `backend/docs/RAW_CAPTURE_ARCHITECTURE.md`
- `backend/docs/PROTOCOL_COVERAGE.md`
