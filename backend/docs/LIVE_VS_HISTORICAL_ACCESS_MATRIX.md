# LIVE vs HISTORICAL Sensor-Rate Accessibility Matrix — WHOOP 5.0 / MG and WHOOP 4.0

**Purpose.** For every sensor/stream the strap exposes, this matrix records the *physical sampling
capability*, the *highest live (realtime) BLE rate discovered*, the *highest historical (offloaded) rate
discovered*, and the exact command / feature-flag / config / packet requirements to obtain each, plus the
known decoder (NOOP vs FRWHOOP) and the precisely-classified remaining blocker.

**Sources (read at baseline `ab0f699e`).**
- NOOP `docs/PROTOCOL.md`, `docs/BLE_REVERSE_ENGINEERING.md`, `docs/WHOOP5_DEEP_DATA.md`
- NOOP source `Packages/WhoopProtocol/Sources/WhoopProtocol/` — `Whoop5Config.swift`,
  `Whoop5RawImu.swift`, `Whoop5RawOptical.swift`, `Whoop5Ecg.swift`, `Interpreter.swift`, `PostHooks.swift`
- NOOP `Strand/BLE/` — `BLEManager.swift`, `Commands.swift`, `PuffinExperiment.swift`
- FRWHOOP `frontend/ios/App/App/WhoopBlePlugin.swift`, `WhoopProtocol.swift`
- FRWHOOP backend `backend/protocol/whoop5.js`

**Labelling.** **VERIFIED** = observed on a real strap and/or reproduced byte-for-byte from a documented
capture (NOOP golden fixtures / #423 / #845 / #103). **INFERRED** = a named-but-unmeasured verb, a guessed
body, or a convention transferred from another namespace. Where a rate is only physically attested on one
generation, that is stated explicitly — WHOOP 4.0 and WHOOP 5.0/MG differ materially.

> **Reader's top line (see §9).** The single highest *live* sensor rate is achievable **only on WHOOP 4.0**
> via the raw type-43 stream: **≈437 Hz single-channel optical PPG** and **100 Hz 6-axis IMU**, both
> continuous at ~2 packets/s. On **WHOOP 5.0/MG** the live raw path is **firmware-refused**
> (`TOGGLE_IMU_MODE`/106 acks but never streams); the high-rate data that *is* obtainable on 5.0 comes from
> the **historical** offload (`v21` = 100 Hz 6-axis IMU, `v20` ≈25 Hz optical, `v26` = 24 Hz PPG), which is
> exactly why the R22 deep-data unlock (`enable_r22_packets` + 15 siblings) matters.

---

## 1. Command / flag / config glossary (shared by all rows)

| Item | Opcode / key | Purpose | Status |
|---|---|---|---|
| `SET_FF_VALUE` (feature-flag write) | 120 (0x78) | write ONE R22 feature flag; 40-byte body | **VERIFIED** (judes.club + on-strap capture) |
| `GET_FF_VALUE` (feature-flag read) | 128 (0x80) | read a flag value | **VERIFIED** (clean read-backs on 5/MG) |
| R22 deep-data sequence | 16× `SET_FF_VALUE` (`enable_r22_packets` etc.) | opens the **type-0x2F** biometric stream + deep type-47 records | **VERIFIED** (sequence & order) |
| `SEND_HISTORICAL_DATA` | 22 | begin type-47 offload | **VERIFIED** |
| `HISTORICAL_DATA_RESULT` (ack) | 23 | ack a HISTORY_END chunk, advance trim cursor | **VERIFIED** (required on 5/MG or offload stalls) |
| `SET_CLOCK` | 10 (4.0) / 146 (5/MG high space); FRWHOOP writes 10 on 5.0 | correct strap RTC → unlocks type-47 + realtime | **VERIFIED** |
| `GET_CLOCK` | 11 / 147 | read RTC → ClockRef correlation | 4.0 **VERIFIED**; 5.0 **not served** (not needed) |
| `GET_DATA_RANGE` | 34 | refresh strap's stored record range | **VERIFIED** (4.0); used for liveness/churn |
| `TOGGLE_REALTIME_HR` | 3 | start/stop type-40 live HR | **VERIFIED** |
| `SEND_R10_R11_REALTIME` | 63 | the **real** switch for the type-43 raw flood (`[0x00]` off / `[0x01]` on) | **VERIFIED** (on-device: 2.1/s→0/s, persists across reconnect) |
| `START_RAW_DATA` / `STOP_RAW_DATA` | 81 / 82 | raw-data collection toggle (on-demand IMU) | **VERIFIED** as verbs; 82 does **not** stop type-43 |
| `TOGGLE_IMU_MODE` (stream) | 106 | live IMU stream mode | **5.0 FIRMWARE-REFUSED** (acks SUCCESS, never streams) |
| `TOGGLE_IMU_MODE_HISTORICAL` | 105 | historical IMU bank mode | named in `CommandNumber`; net effect on 5.0 not confirmed |
| `ENABLE_OPTICAL_DATA` | 107 | optical (PPG) data enable | in `CommandNumber`; not established as served |
| `SET_DEVICE_CONFIG_VALUE` | 119 (0x77) | write ONE device-config key (e.g. Broadcast HR) | **VERIFIED** (Broadcast HR on real HW, Garmin Edge 840) |
| `GET_DEVICE_CONFIG_VALUE` | 121 | read a device-config key | **VERIFIED answered on 5/MG** for `enable_raw_data_w_ecg` |
| Broadcast HR key | `whoop_live_hr_in_adv_ind_pkt` (`'1'`) | advertise HR as standard 0x180D sensor | **VERIFIED** |
| ECG device-config key (MG) | `enable_raw_data_w_ecg` | raw ECG gate | **VERIFIED written/read**; #891 null result |
| ECG Labrador verbs (MG) | 123 `SELECT_WRIST`, 124 `TOGGLE_LABRADOR_DATA_GENERATION`, 125 `TOGGLE_LABRADOR_RAW_SAVE`, 139 `TOGGLE_LABRADOR_FILTERED` | MG ECG stream | **INFERRED mapping** (4 codes / 5 names); accepted on real MG, no data emitted |

> **FRWHOOP coverage today (VERIFIED from `WhoopBlePlugin.swift`).** On connect FRWHOOP sends only the
> puffin `CLIENT_HELLO` (GET_HELLO 0x91), then for WHOOP 5 `SET_CLOCK`(10) + `TOGGLE_REALTIME_HR`(3), then
> requests history (`SEND_HISTORICAL_DATA` 22 + ack 23) on a 15-min timer. It sends **none** of the R22
> feature flags, **never** sends `SEND_R10_R11_REALTIME`(63), `START/STOP_RAW_DATA`(81/82),
> `TOGGLE_IMU_MODE`(106), `TOGGLE_IMU_MODE_HISTORICAL`(105), `GET_DATA_RANGE`(34), or any device-config
> write (119). The R22 burst and 105/106/81 probes exist only in the manual, debug-gated
> `runProtocolLab(phase:)` path. Decoders: the iOS plugin decodes `v18`/`v21` historical + type-40 HR live;
> the backend `whoop5.js` has full NOOP-parity for `v18/v20/v21/v26`.

---

## 2. The matrix

Legend — **Live** = streamed to the client in (near) real time over BLE. **Hist** = offloaded type-47
record. Rate columns give the *highest documented*; "n/a" = no live/historical path found.

| Sensor / stream | Physical sampling capability | Highest **live** BLE rate | Highest **historical** rate | Command required | Feature flags required | Device-config required | Packet type (version) | Known decoder | Remaining blocker (class) |
|---|---|---|---|---|---|---|---|---|---|
| **Accelerometer (3-axis)** | 100 Hz, i16 `1/4096` g/LSB (gravity-shell verified) | **4.0:** type-43 IMU, 100 samples/axis @ ~100 Hz, ~2 pkts/s continuous (**VERIFIED**). **5.0:** live raw stream **firmware-refused** (`TOGGLE_IMU_MODE`/106 acks, never streams — **VERIFIED**) | `v21` type-47: 100 Hz i16 accel (3 ch) per 1-s record (**VERIFIED**, 1423 buffers); `v18`: `gravity_*` f32 g 1 Hz | Live: `SEND_R10_R11_REALTIME`(63 [0x01]) or `START_RAW_DATA`(81)+`TOGGLE_IMU_MODE`(106); Hist: `SEND_HISTORICAL_DATA`(22)+ack(23). FRWHOOP sends **none** of 63/81/106. | `enable_r22_packets`(+v-series) — `v21` rides the R22 deep-buffer path | none known | `43` (imu, 1917 B); `47` (`v21`, `v18`); type `51` REALTIME_IMU_DATA_STREAM unmapped | NOOP `Whoop5RawImu.swift` / `decodeWhoop5HistoricalV2021`; FRWHOOP `whoop5.js` v21 + iOS `motionFromRealtime`(type-43 only) | **5.0 live IMU unavailable on-wire (FIRMWARE_ACK_BUT_NO_STREAM)**; FRWHOOP doesn't request live raw (CLIENT_NOT_REQUESTING); type-51 unmapped (UNKNOWN) |
| **Gyroscope (3-axis)** | 100 Hz, i16 `2000/32768`°/s/LSB (±2000 dps) (**VERIFIED** 720° rotations) | **4.0:** type-43 IMU gyro x/y/z @ ~100 Hz (**VERIFIED**). **5.0:** firmware-refused | `v21` type-47: 100 Hz i16 gyro (3 ch) per 1-s record (**VERIFIED**) | as accel row | as accel row | none | `43` (imu); `47` (`v21`) | NOOP `Whoop5RawImu` (gyro io/pu, 2000/32768); FRWHOOP v21 | **5.0 live gyro unavailable (firmware)**; FRWHOOP not requesting live raw; note `v18` carries **no gyro** (only gravity + dynamic-acc) |
| **Raw optical / PPG waveform** | 4.0 single AC-coupled green waveform @ **~437 Hz** (~419 `s24` samples, stride 4) (**VERIFIED**); 5.0 multichannel optical `v20` @ ~25 Hz and `v26` @ **24 Hz** (**VERIFIED**) | **4.0:** type-43 optical variant, ~437 Hz continuous at ~2 pkts/s (**VERIFIED**). **5.0:** no live raw optical; the R22 **type-0x2F** realtime biometric stream is the high-rate optical/HR/motion path (opened by flags) | `v26` type-47: 24 Hz PPG (24× LE-i16/s, HR-locked, single channel); `v20` type-47: ~25 Hz signed-20-bit optical / active blocks (`[25,0,0,25,25]` sample counts) (**VERIFIED**) | Live raw: `SEND_R10_R11_REALTIME`(63)/`START_RAW_DATA`(81); R22 realtime: 16× `SET_FF_VALUE`(120); Hist: `SEND_HISTORICAL_DATA`(22)+ack. FRWHOOP: none of these on connect. | `enable_r22_packets`… (R22 set) | none | `43` (optical, 1921 B); `47` (`v26`, `v20`);
R22 realtime `0x2F` class (`recordClass = 0x2F` shared by v20/v21/v26) | NOOP `Whoop5RawOptical` (v20), v26 waveform decoder; FRWHOOP `whoop5.js` v20/v26; iOS captures these **raw-only** (v20/v26 not decoded on-device) | **R22 flags unset for FRWHOOP** (CLIENT_NOT_WRITING_FLAGS); **wavelength identity OPEN** — v20 channels unlabelled, no labelled/moving capture (UNKNOWN); 5.0 live raw refused (FIRMWARE) |
| **Red / IR optical** | 4.0 `v24` banks raw **red `spo2_red`@68 / IR `spo2_ir`@70** ADC (**VERIFIED**); 5.0 `v18` **dropped** these channels — 5.0 optical is **single-channel, 26-way time-multiplexed** (never simultaneous red+IR) (**VERIFIED**) | **none** on 5.0 (single channel, HR only); no live red/IR anywhere | 4.0 `v24`: red/IR raw ADC @ 1 Hz (**VERIFIED**); 5.0: none (SpO₂ computed **on-device**, sleep-only, `v18 @82` candidate) | 4.0 hist: `SEND_HISTORICAL_DATA`(22); 5.0: no SpO₂ read opcode exists (see §3) | R22 set (to open deep records) | none | `47` (`v24` 4.0; `v18 @82` 5.0 candidate) | NOOP v24 `spo2_red/ir`; `@82` = `spo2_candidate_82` (instrumentation-only, never `spo2Pct`); FRWHOOP whoop5.js keeps @82 raw-instrumentation | **5.0 has no simultaneous red+IR on the wire** (STRUCTURAL) — SpO₂ promotion blocked on cross-device contradiction (#103); FRWHOOP cannot derive SpO₂ (%) on 5.0 (no red/IR), 4.0 `spo2_red/ir` not exposed |
| **Skin temperature** | digital sensor; `v18 @73` u16 raw, °C = raw/100, median ≈34 °C worn; two aux thermal channels `@69/@71` (**VERIFIED** on two straps) | no dedicated live temp stream; only `TEMPERATURE_LEVEL`(17) events; R22 realtime may carry it | `v18` `skin_temp_raw`@73 (+`temp_aux_1/2`@69/@71) @ 1 Hz; 4.0 `v24` `skin_temp_raw`@72 | Hist: `SEND_HISTORICAL_DATA`(22)+ack; event is strap-pushed | R22 set (for deep records) | none | `47` (`v18`, `v24`); `EVENT`(48) type 17 | NOOP `skin_temp_raw`/`skinTempCelsius`; FRWHOOP iOS `puffinSkinTempC` (@73, /100, gated 5–45 °C); backend whoop5.js | **No high-rate live temp** (PHYSICAL — strap samples 1 Hz); FRWHOOP works via history — no hard blocker |
| **Heart Rate (HR)** | PPG-derived, 1 Hz summary (**VERIFIED** matches 2A37 exactly at 96/96 samples) | **2A37** standard HR ~1 Hz (**VERIFIED**, works **unbonded** on both generations); type-40 ~1 Hz; R22 high-rate realtime | `v18` `heart_rate`@22 @ 1 Hz; `v24` @21 | Live: none for 2A37; `TOGGLE_REALTIME_HR`(3) for type-40; Hist: `SEND_HISTORICAL_DATA`(22) | R22 (for high-rate) | none (Broadcast HR optional via 119) | `2A37`; `40`; `47` (`v18`,`v24`); R22 `0x2F` | NOOP `StandardHeartRate`/v18; FRWHOOP iOS + whoop5.js | **None — this is the working baseline** (FRWHOOP shows live HR today) |
| **R-R intervals (RR)** | beat-to-beat, 1/1024 s → ms (**VERIFIED**) | **2A37** R-R (ms) — the **reliable** source; type-40 usually `rr_count=0` (**VERIFIED**) | `v18` `rr[i]` u16 ms (count@23); `v24` `rr` | Live: 2A37 subscribe (unbonded); type-40 via cmd 3; Hist: cmd 22+ack | R22 (for depth) | none | `2A37`; `40`; `47` (`v18`,`v24`) | NOOP + FRWHOOP | **None live; FRWHOOP relies on 2A37** — for 24/7 dense RR use `keepRealtimeForData`/continuous-HRV opt-in (PuffinExperiment) |
| **SpO₂ inputs** | 4.0 raw red/IR (above); 5.0 on-device strap-computed % at `v18 @82`, sleep-only, **duty-cycled** (non-`0` in only 2.4 % of 18,650 records, in runs of exactly 30 records same phase, ~1200 s period) (**VERIFIED**) | **none** (no live SpO₂ path; no SpO₂ read opcode exists) | 4.0 `v24` raw red/IR 1 Hz; 5.0 `@82` scalar (sleep windows only) | Hist: cmd 22+ack (5.0); no SpO₂ command exists | R22 set + optionally `spo2CandidateDisplay` opt-in | none | `47` (`v24` 4.0 red/IR; `v18 @82` candidate) | NOOP: `spo2_candidate_82` instrumentation + `validate_spo2_candidate.py` harness; FRWHOOP whoop5.js raw @82 | **5.0 SpO₂ promotion blocked on split cross-device evidence** (#103: 8-night corr +0.99 but 2-night reversal on the source device) — RESEARCH, not decrypt; property absent when capture misaligned to duty phase (watch out for flat-`0x00` misread) |
| **Wear / contact** | capacitive; `v18 @81` b0-1 on-wrist; off-wrist = HR 0, optical baseline 0 (**VERIFIED**) | `WRIST_ON`(9)/`WRIST_OFF`(10) events (**VERIFIED**); `@81` onwrist in each history record | `v18` `@81` low-nibble `onwrist` + `sleep_state`(bits 4-5); 4.0 `v24` `skin_contact`@55 (0=off-wrist) | none needed — strap-pushed events + per-record byte | R22 set to tune (`wear_detect_bias`, `enable_passive_strap_fit_gen5`) | none | `EVENT`(48) 9/10; `47` (`v18`,`v24`) | NOOP `worn`; FRWHOOP uses events | **None — R22 stream itself is on-wrist gated** (only set flags while worn) |
| **Battery / charge** | fuel gauge; single-byte percent + extended (mV) | **2A19** standard %, read on demand; type-48 `BATTERY_LEVEL` event (SoC %/mV/charging) ~every 8 min (**VERIFIED**) | n/a (not a history stream) | `GET_BATTERY_LEVEL`(26) confirmed write (also the 4.0 bond trick); `GET_EXTENDED_BATTERY_INFO`(98); events strap-pushed | none | none | `2A19`; `EVENT`(48) type 3/63; `COMMAND_RESPONSE`(36/38) | NOOP + FRWHOOP (2A19 + battery event) | **None** |
| **Motion quality / activity class** | on-device; `v18 @63` `motion_wear_quality` {0,1,2} = activity class (0 still/1 walk/2 run); `dynamic_acceleration` f32 (gated 0–8 g); `step_motion_counter`@57 (cumulative u16, **steps = wrap-aware diff, not sum**); `step_cadence`@59 (**VERIFIED**) | 4.0: type-43 IMU 100 Hz (motion-rich); 5.0: no live raw motion (firmware-refused) | `v18` motion fields @ 1 Hz; `v21` 100 Hz IMU (the richest motion source) | Hist: cmd 22+ack; live raw: 63/81/106 | `make_hrfm_visible`, `wear_detect_bias`, `enable_passive_strap_fit_gen5` | none | `43`; `47` (`v18`,`v21`) | NOOP `step_motion_counter`/`dynamic_acceleration`/`activity_class`; FRWHOOP iOS `puffinActivityClass`/`puffinStepCounter`/`puffinStepCadence` → backend delta/rollover normalizes steps | **@63 semantics not fully pinned** (observation-framed); 5.0 live motion unavailable (FIRMWARE) — use v21 historical; step over-count if summed naively (FRWHOOP correctly sends raw counter + backend delta-normalizes) |
| **ECG "Labrador" (MG only)** | MG ECG electrodes (standard 5.0 **does not** carry them); FILTERED live + RAW persisted streams; on-device rhythm classifier | FILTERED live stream (display-ready) — if the turn-on sequence works; **RAW** stream persisted for offload | RAW stream persisted on strap → offload | 123/124/125/139 (`SELECT_WRIST` → filtered on → raw save on → generation start) | none known | `enable_raw_data_w_ecg` (`'1'` via 119) — #891 wrote+read it, still zero packets | unmapped packet type (no capture; NOOP hunts empirically) | NOOP `Whoop5Ecg.swift` + `Whoop5EcgProbe.swift` (verdicts), FRWHOOP: **not implemented** | **5 codes / 4 opcodes mapping unconfirmed (INFERRED)**; on a real MG all four ack SUCCESS but emit **no data** in 30 s — null result with live open explanations (banked-to-flash vs no-start-verb vs entitlement gate vs open electrode circuit); FRWHOOP has no MG path |

---

## 3. Cross-cutting blockers, classified precisely

| Blocker class | Where | Evidence | Can FRWHOOP fix it? |
|---|---|---|---|
| **CLIENT_NOT_WRITING_FLAGS** (R22 gate) | whole deep-data family on 5.0 | `enable_r22_packets` is the master flag; FRWHOOP sends **no** `SET_FF_VALUE` on connect | **Yes — lowest-hanging fruit.** The 16-flag sequence is already in `WhoopProtocol.swift`; wire it on connect behind opt-in (NOOP precedence #174/#103). |
| **CLIENT_NOT_REQUESTING_STREAM** (raw type-43) | 4.0 raw IMU/optical; on-demand IMU | FRWHOOP never sends 63/81/106 | **Yes — trivial commands.** At minimum send `SEND_R10_R11_REALTIME(63)[0x00]` on connect to stop the flood (parity + battery), and 81/106 for bounded raw capture. |
| **FIRMWARE_ACK_NOR_STREAM** | 5.0 live raw IMU/gyro/optical | cmd 106 acks SUCCESS and never emits; NOOP + community agree | **No — physical/firmware.** Route around via **historical** `v21` (100 Hz IMU) / `v26` (24 Hz PPG) / `v20` (~25 Hz optical). |
| **STRUCTURAL: no simultaneous red+IR on 5.0** | 5.0 SpO₂ / blood-pressure | 26-way time-multiplex, single channel | **No** for on-device dual-wavelength; use 4.0 `v24` red/IR or the 5.0 `@82` on-device candidate. |
| **RESEARCH (split evidence)** | 5.0 `@82` SpO₂ candidate | 8-night corr +0.99 vs 2-night reversal on source device (#103) | **Conditional** — run `validate_spo2_candidate.py` on ≥2 devices that PASS; promote only then. |
| **UNKNOWN: wavelength identity** | `v20` optical blocks | no labelled/moving capture; structure confirmed, sensor identity OPEN | **HARDWARE_REQUIRED** controlled occlusion/motion capture. |
| **INFERRED mapping** | MG ECG family | 4 codes/5 names; opcodes accepted but silent on real MG | **HARDWARE_REQUIRED** HCI differential capture of official app. |

---

## 4. One-line per-sensor actionable answer (FRWHOOP)

- **Accel/Gyro (live, 4.0):** send `START_RAW_DATA`(81)+`TOGGLE_IMU_MODE`(106) for a bounded 100 Hz 6-axis window — already a `cmd81`/`cmd106` lab phase; promote to a real (opt-in) feature.
- **Accel/Gyro (live, 5.0):** impossible (firmware). Use historical `v21` (100 Hz, NOOP-parity decoder already in `whoop5.js`).
- **Optical PPG (live, 4.0):** 437 Hz via type-43; **5.0:** R22 realtime `0x2F` after the 16-flag burst.
- **Optical PPG (historical):** `v26` 24 Hz / `v20` ~25 Hz — **decoded** by FRWHOOP backend; push `enable_r22_packets` to actually receive them.
- **Red/IR + SpO₂:** 4.0 `v24` gives raw red/IR; 5.0 only the on-device sleep-only `@82` candidate — no code change unlocks SpO₂, only a multi-device validation program.
- **Skin temp / HR / RR / wear / battery:** already reachable via history + events; no blocker.

---

*Reverse-engineering credit: `johnmiddleton12/my-whoop` (WHOOP 4.0), `b-nnett/goose` (WHOOP 5.0),
judes.club + Asherlc/dofek (R22), and community BTSnoop/HCI captures (#103, #423, #845). Independent
interoperability for the user's own device; not affiliated with WHOOP, not a medical device.*
