# PROTOCOL_NAME_LEADS — WHOOP 5.0/MG sensor-access research-hypothesis inventory

**Purpose.** A structured inventory of informative **internal protocol names, enum cases, feature/
device-config keys, command opcodes, packet types, record-layout identifiers, and firmware console
strings** that are *hypotheses* about WHOOP 5.0 / MG sensor access. This is a research catalog, not a
semantics claim: **every entry is a hypothesis until validated.** Names are treated as evidence about
what the firmware *might* gate or expose, never as proof of what a field measures.

**Baseline.** NOOP commit **`ab0f699e`** (verified as `noop` HEAD; `git -C noop rev-parse HEAD`
=`ab0f699e17bde653e3ef0bf5963e991b3e4a9d3d`). FRWHOOP backend `whoop` HEAD `6b81bee6`. Compiled
baseline and all `file:line` citations below are against these commits.

**Sources mined (per mission).** `noop/` paths are a local sibling reference
tree, not part of a FRWHOOP clone.

- `noop/Packages/WhoopProtocol/Sources/WhoopProtocol/*.swift` + shared schema
  `Resources/whoop_protocol.json`
- `noop/android/app/src/main/java/com/noop/` (`protocol/Enums.kt`, `protocol/Whoop5Config.kt`,
  `protocol/Whoop5RawImu.kt`, `protocol/DeviceConfigWriteGate.kt`, `ble/WhoopBleClient.kt`, …)
- `noop/Strand/BLE/`, `noop/Strand/Collect/`
- `backend/protocol/` (`framing.js`, `decoder.js`, `whoop5.js`)
- Corroborating in-repo notes: `noop/docs/PROTOCOL.md`, `backend/docs/*.md`

## Confidence / mapping legend

| Tag | Meaning |
|---|---|
| **DECODED_FRWHOOP** | Identifier is **mapped AND decodable** through FRWHOOP (NOOP decoder or `backend/protocol/whoop5.js`) and its payload is persisted. |
| **PARTIAL** | Identifier is decoded but only some fields / only the historical path; a live or related stream is not. |
| **NAMED_ONLY** | Identifier exists in a schema / enum / label table or comment but has **no payload decoder and no send/probe path**. |
| **WIRED** | NOOP actually constructs/sends this command (auto or gated probe/experiment). |
| **NEW_HYPOTHESIS** | A lead that is **not yet integrated** into FRWHOOP behavior (no decoder, send, probe, or mapping). |
| **RUNTIME_EVIDENCE** | Whether on-wire/on-strap evidence exists (decoded captures, read-backs, ACKs, refusals). |

---

## A. Feature-flag namespace — `SET_FF_VALUE` / `0x78` (the R22 deep-stream unlock)

The WHOOP 5.0/MG withholds its deep biometric streams (type-0x2F records) until a burst of persistent
feature-flag values is written. Source: `Whoop5Config.swift:11-96`, Kotlin `Whoop5Config.kt`. These
keys are **WIRED** (NOOP's "deep-data" opt-in writes them, #174) and the write→read-back is confirmed
on real hardware. Effects of most keys are **unmeasured** — that is where the unlocks live.

| Key (exact token) | File:line | Gates / names | Mapped in FRWHOOP | Notes |
|---|---|---|---|---|
| `enable_r22_packets` (value `'2'`) | `Whoop5Config.swift:59` | The **master** flag — opens type-0x2F deep biometric stream (optical/HR/motion) | PARTIAL (historical 0x2F decoded; **live** type-0x2F not decoded as R22) | RUNTIME: enable run + read-back confirmed on real 5/MG |
| `enable_r22_v2_packets` `'2'` | `:60` | tune sub-stream variant | PARTIAL | unknown effect |
| `enable_r22_v3_packets` `'2'` | `:61` | tune sub-stream variant | PARTIAL | unknown effect |
| `enable_r22_v4_packets` `'1'` | `:62` | tune sub-stream variant (note `'1'` not `'2'`) | PARTIAL | unknown effect; value differs from siblings |
| `enable_r22_v5_packets` `'2'` | `:63` | tune sub-stream variant | PARTIAL | unknown effect |
| `enable_r22_v6_packets` `'2'` | `:64` | tune sub-stream variant | PARTIAL | unknown effect |
| `enable_r22_v8_packets` `'2'` | `:65` | tune sub-stream variant (note: **no v7** — v8 only) | PARTIAL | the v7 name is absent — a naming gap worth probing |
| `make_hrfm_visible` `'2'` | `:66` | HR feed / high-rate HR (**hrfm** = high-rate freq?) visible to client | NAMED_ONLY | `hrfm` resurfaced in `WhoopBleClient` strings (`make_hrfm_visible`); unmeasured |
| `disable_pip_r26_packets` `'2'` | `:67` | Suppression of **PIP R26** packets (a *disable*-named key written `'2'`) | NAMED_ONLY | not a boolean; R26 = another deep packet family, see §D |
| `wear_detect_bias` `'2'` | `:68` | wear detection tuning | NAMED_ONLY | |
| `hr_ch_switching` `'2'` | `:69` | optical **HR channel switching** | NAMED_ONLY | implies multi-channel optical front end |
| `ir_hw_switching` `'2'` | `:70` | **IR hardware switching** — implies IR/red/green channel routing | NAMED_ONLY | strong optical-sub-channel hypothesis |
| `enable_passive_strap_fit_gen5` `'1'` | `:71` | passive strap-fit / wear confidence (gen5) | NAMED_ONLY | |
| `enable_sig11_during_sleep` `'2'` | `:72` | a **signal index 11** gated to sleep | NAMED_ONLY | sig-index family, see §I |
| `dorset_inhibit_wpt` `'2'` | `:73` | "**dorset**" codename; inhibit WPT? | NAMED_ONLY | obscure; likely firmware/region codename |
| `enable_sig12` `'1'` | `:74` | a **signal index 12** sub-stream | PARTIAL | RUNTIME: real capture (#423) corrected value `'2'`→`'1'`; **probe key** for disable path (`R22Disable.swift:200`) |

`Whoop5Config.featureFlagOffValue = 0x30` (`Whoop5Config.swift:94-150`) and `disableR22Sequence`
(`:152-163`) define the off/undo path; the tri-state `'0'/'1'/'2'` semantics are explicitly
**unestablished** (`Whoop5Config.swift:102-131`).

## B. Device-config namespace — `SET_DEVICE_CONFIG_VALUE` / `0x77`, read `GET_DEVICE_CONFIG_VALUE` / `0x79`

All seven **enumerated device-config keys** the strap itself serves (`DeviceConfigWriteGate.swift:110-118`),
plus the discovery key. These are the only keys FRWHOOP has ever seen the strap enumerate — every one is a
candidate for deeper sensor control.

| Key (exact token) | File:line | Gates / names | Mapped in FRWHOOP | Notes |
|---|---|---|---|---|
| `whoop_live_hr_in_adv_ind_pkt` | `DeviceConfigWriteGate.swift:94` (`broadcastHrKey`), `:116` | Broadcast-HR over the standard 0x180D adv-ind packet | **WIRED** + DECODED (write+read-back, #181/#1061) | RUNTIME verified on Garmin Edge 840; the only known-good device-config verb/key |
| `enable_raw_data_w_ecg` | `DeviceConfigWriteGate.swift:89` (`ecgRawDataKey`) | **"raw data"** gated w/ ECG — a raw-data device-config key | **WIRED** (MG ECG gate, #891) | RUNTIME: reads `'0'` when ECG not running; pairs "raw data" with ECG — implies a raw-data namespace beyond ECG |
| `sigproc_wear_detect` | `DeviceConfigWriteGate.swift:101,111` | **signal-processing wear detect** | NAMED_ONLY (listed, never written) | in `outOfScopeKeys` + `enumeratedKeys` |
| `enable_rfid` | `:102,112` | RFID enable — a non-optical radio | NAMED_ONLY | high-confidence separate subsystem |
| `max_collection_backlog` | `:103,113` | collection backlog cap (reads `"0.0"`) | NAMED_ONLY | not even a flag-shaped value |
| `cont_collection_mode` | `:104,114` | **continuous collection mode** | NAMED_ONLY | implies a continuous raw-collection mode |
| `whoop_live_2_hrm_devices` | `:105,115` | live-HR to a **second** device | NAMED_ONLY | multi-recipient HR broadcast |

## C. SpO2 candidate keys — **NEW_HYPOTHESIS** (constructed guesses, never observed)

`DeviceConfigReadProbe.oxygenCandidateKeys` (`DeviceConfigReadProbe.swift:127-136`) plus the 
**explicit guess that the `enable_sig11…/enable_sig12` series continues as `enable_sig13`**
(`DeviceConfigReadProbe.swift:124-126`). These are *guesses built from naming conventions*; the file says
so (`:118-123`). No wire/capture/table has ever shown them. The 8 candidates:

`enable_spo2`, `enable_spo2_packets`, `spo2_enable`, `enable_blood_oxygen`, `blood_oxygen_enable`,
`enable_pulse_ox`, `enable_oxygen_packets`, `spo2_subscription_enabled`.

- Each is a read-only probe **step** (`DeviceConfigReadProbe` walks them via `GET_FF_VALUE`/`GET_DEVICE_CONFIG_VALUE`).
- **RUNTIME_EVIDENCE for SpO2 existing at all (not these keys):** firmware console string
  `"SIGPROC: generated a valid SPO2 during sleep"` (`Interpreter.swift:878`), decoded v18 fields
  `spo2_red`, `spo2_ir` (`HistoricalStreams.swift:253-254`), `spo2_candidate_82` (`Interpreter.swift:550`,
  a gated 70-100 view of raw byte @82), and Oura-side `spo2_ibi_and_amplitude_event` (Oura only, not WHOOP).
- **`enable_sig13`** — explicit **new** guess continuing the sig11/sig12 series (`DeviceConfigReadProbe.swift:125-126`).

## D. Command opcodes (sensor-related) — most **NAMED_ONLY / NEW_HYPOTHESIS**

Full opcode→name table: `whoop_protocol.json` `enums.CommandNumber`; Android mirror
`Enums.kt:299-375` (object `CommandNames`). Sensor-relevant ones that FRWHOOP does **not** drive (or
drives only as a refused probe), each a candidate to probe for raw/optical/IMU access:

| Opcode | Name | File:line (schema) | Gates / names | FRWHOOP status | Runtime evidence |
|---|---|---|---|---|---|
| 131 | `SET_RESEARCH_PACKET` | `whoop_protocol.json` CN; `Enums.kt:368` | **"research packet"** — a proprietary/custom data channel | **NEW_HYPOTHESIS** (named only, no send/decoder) | none |
| 132 | `GET_RESEARCH_PACKET` | `Enums.kt:369` | read the research packet | **NEW_HYPOTHESIS** | none |
| 107 | `ENABLE_OPTICAL_DATA` | `Enums.kt:354`; `PROTOCOL.md:421` | enable optical (PPG) data stream | **NEW_HYPOTHESIS** | none |
| 108 | `TOGGLE_OPTICAL_MODE` | `Enums.kt:355` | toggle an optical mode | **NEW_HYPOTHESIS** | none |
| 105 | `TOGGLE_IMU_MODE_HISTORICAL` | `Enums.kt:352`; `PROTOCOL.md:420` | IMU stream mode (historical) | NAMED_ONLY | none seen |
| 106 | `TOGGLE_IMU_MODE` | `Enums.kt:353`; `Whoop5RawImu.swift:11` | **live** IMU stream mode (alias `IMU_SET_DATA_STREAM`, `PROTOCOL.md:474`) | PARTIAL — wired as refused probe | **RUNTIME: acks but never streams (firmware-refused)** — IMU only obtainable historically |
| 81/82 | `START_RAW_DATA` / `STOP_RAW_DATA` | `Enums.kt:343-344`; `PROTOCOL.md:415` | raw-data collection toggle | **NEW_HYPOTHESIS** (not sent by NOOP) | none |
| 63 | `SEND_R10_R11_REALTIME` | `Enums.kt:334`; `PROTOCOL.md:407` | **"the real type-43 raw-stream switch"** (R10/R11 raw realtime) | **NEW_HYPOTHESIS** | none in NOOP (type-43 raw noted, not driven) |
| 61/62 | `SET_AFE_PARAMETERS` / `GET_AFE_PARAMETERS` | `Enums.kt:332-333`; `PROTOCOL.md:445-446` | **optical AFE** parameters (PPG front end) | **NEW_HYPOTHESIS** | none |
| 39/40 | `SET_LED_DRIVE` / `GET_LED_DRIVE` | `Enums.kt:322-323`; `PROTOCOL.md:404` | optical **LED drive** ("research") | **NEW_HYPOTHESIS** | none |
| 41/42 | `SET_TIA_GAIN` / `GET_TIA_GAIN` | `Enums.kt:324-325`; `PROTOCOL.md:405` | transimpedance-**amp gain** ("research") | **NEW_HYPOTHESIS** | none |
| 43/44 | `SET_BIAS_OFFSET` / `GET_BIAS_OFFSET` | `Enums.kt:326-327`; `PROTOCOL.md:406` | optical **bias offset** ("research") | **NEW_HYPOTHESIS** | none |
| 100 | `CALIBRATE_CAPSENSE` | `Enums.kt:351`; `PROTOCOL.md:419` | recalibrate **capacitive touch** | **NEW_HYPOTHESIS** | none |
| 16 | `TOGGLE_R7_DATA_COLLECTION` | `Enums.kt:307` | **R7** data-variant toggle | **NEW_HYPOTHESIS** | none |
| 14 | `TOGGLE_GENERIC_HR_PROFILE` | `Enums.kt:306` | generic HR profile (0x180D?) toggle | NEW_HYPOTHESIS | none |
| 96/97 | `ENTER_HIGH_FREQ_SYNC` / `EXIT_HIGH_FREQ_SYNC` | `Enums.kt:347-348`; `PROTOCOL.md:417` | high-frequency offload mode | PARTIAL — only `EXIT` sent defensively | none for enter |
| 52/53 | `SET_DP_TYPE` / `FORCE_DP_TYPE` | `Enums.kt:330-331` | **DP type** (data-product type?) | NEW_HYPOTHESIS | none |
| 123 | `SELECT_WRIST` | `Enums.kt:364`; `Whoop5Ecg.swift:261` | wrist selection (MG ECG) | NAMED_ONLY (ECG probe only) | accepted on MG |
| 124 | `TOGGLE_LABRADOR_DATA_GENERATION` | `Whoop5Ecg.swift:264`; `Enums.kt:365` | ECG **data generation** | WIRED (gated MG ECG probe) | accepted+SUCCESS on MG, no ECG data (null) |
| 125 | `TOGGLE_LABRADOR_RAW_SAVE` | `Whoop5Ecg.swift:267`; `Enums.kt:366` | ECG **raw-save** | WIRED (gated) | accepted+SUCCESS, no data |
| 139 | `TOGGLE_LABRADOR_FILTERED` | `Whoop5Ecg.swift:270`; `Enums.kt:370` | ECG **filtered** stream | WIRED (gated) | accepted+SUCCESS, no data |

**Name↔code caveat for the ECG family.** `PROTOCOL.md:452-460` flags the four Labrador codes
(123/124/125/139) as an **unconfirmed** mapping ("four codes for five names"; earlier names
`ECG_MAIN_CONTROL/ECG_SEND_RAW/ECG_SAVE_RAW/ECG_SAVE_FILTERED/ECG_SELECT_WRIST` don't all have codes,
and the 5/MG remaps opcodes into a high space). `PROTOCOL.md:474-475` additionally names
`IMU_SET_DATA_STREAM` (code 106, shared with `TOGGLE_IMU_MODE`) and a `UART_DISABLE` (0x61–0x69) as
**unconfirmed** — both are NEW hypotheses here.

## E. Packet types (on-wire record classes)

| Token | Value | File:line | What it is | FRWHOOP status |
|---|---|---|---|---|
| `REALTIME_RAW_DATA` | 43 | `whoop_protocol.json` PT; `Enums.kt:25-26` | realtime raw stream (R10/R11 target of cmd 63) | NAMED_ONLY / PARTIAL — identified, 4.0 1917B decoder exists, 5.0 not driven |
| `REALTIME_IMU_DATA_STREAM` | 51 | `Enums.kt:27` | realtime IMU stream | NAMED_ONLY |
| `HISTORICAL_IMU_DATA_STREAM` | 52 | `Enums.kt:28`; `HistoricalStreams.swift:14` | historical IMU stream (v21 1244B buffer) | DECODED via historical offload |
| 0x2F (recordClass) | — | `Whoop5RawOptical.swift:186` (`recordClass = 0x2F`) | the **deep/R22** record class shared by v18/v20/v26 | PARTIAL — historical decoded; node claims live 0x2F is offload, not live R22 (`WhoopBleClient.kt` string, §H) |
| `CONSOLE_LOGS` | 50 | `Enums.kt:12` | strap plaintext diagnostics channel (type-50) | DECODED (`Interpreter.swift:873-901`) — primary source of firmware strings |

## F. Historical record layouts (type-47 `hist_version`) — all DECODED_FRWHOOP

| Layout | File:line | What it carries | FRWHOOP backend |
|---|---|---|---|
| v18 (124 B) | `Interpreter.swift:560-604`; `whoop5.js:46-106` | per-second summary: HR, R-R, gravity, steps, skin_temp, 2 aux temps, **optical_amp_a/b, optical_baseline_a/b, spo2_candidate_82** | decoded in `whoop5.js` |
| v20 (2140 B) | `Whoop5RawOptical.swift` (whole); `whoop5.js:130-136` | 5× optical blocks w/ 11-field config head (`source_a/b, drive_a/b, detector_a/b_select, range_a/b, offset_a/b, sample_count`) | decoded `whoop5.js` |
| v21 (1244 B) | `Whoop5RawImu.swift`; `whoop5.js:366-370` | 6-axis IMU, 100 Hz (ax/ay/az/gx/gy/gz i16) | decoded `whoop5.js` |
| v26 (raw PPG) | `Interpreter.swift:625-654`; `whoop5.js:113-125` | 24 Hz raw optical PPG waveform (`ppg_waveform`, `ppg_sample_count`) | decoded `whoop5.js` |

`Interpreter.swift:334` lists the `hist_version` values that have a real field map. Unknown
`hist_version`s are archived raw (`HistoricalStreams.swift:69`) — a discovery path.

## G. Decoded optical/temperature/motion field names (v18 semantic hypotheses)

From `Interpreter.swift` (all **DECODED_FRWHOOP**, all explicitly "raw, not pinned" in the notes):

| Field | File:line | Hypothesis |
|---|---|---|
| `optical_amp_a` / `optical_amp_b` | `Interpreter.swift:590,594` | two paired optical channels; 128 = record-level signal-quality sentinel (`Streams.swift:379`) |
| `optical_baseline_a/b` | `Interpreter.swift:571` | optical/ADC baseline channels |
| `skin_temp_raw` | `Interpreter.swift:497`,`Streams.swift:135` | skin-temperature ADC, °C = raw/100 |
| `temp_aux_1_raw` / `temp_aux_2_raw` | `Interpreter.swift:481,485` | two secondary thermal channels (corr 0.92/0.97) |
| `spo2_red` / `spo2_ir` | `HistoricalStreams.swift:253-254` | red/IR channels for SpO2 |
| `spo2_candidate_82` | `Interpreter.swift:550` | SpO2 candidate, gated 70-100 |
| `motion_wear_quality` | `Interpreter.swift:467` | 0=still/good,1,2=poor contact |
| `wake_quality` | `Interpreter.swift:522` | wake quality bits |
| `resp_rate_raw` | `HistoricalStreams.swift:286` | respiratory-rate raw |
| `ppg_waveform` / `ppg_green_ac` / `ppg_mean` | `Interpreter.swift:652`; `PostHooks.swift:291-298` | green-AC PPG waveform, mean |
| `optical_phase` (kind) | `OpticalExperimentAnalysis.swift:205,237` | optical-phase experiment role |

## H. Firmware console strings (type-50) — diagnostics that name subsystems

`Interpreter.swift:873-901` decodes the strap's plaintext console (key `log`). Strings already seen
that name sensor subsystems and anchor the deep-data work (`Interpreter.swift:877-879`):
- `"SENSORS: AFE configuration changed"` — names the **AFE (analog front end)**; matches cmd 61/62.
- `"SIGPROC: generated a valid SPO2 during sleep"` — **on-strap SpO2** exists during sleep.

App-layer strings that name deep/raw concepts (`WhoopBleClient.kt` / Strand):
- `"Deep-data: type-0x2F received outside our offload … not a live R22 stream (#494)"` — R22 = live deep type-0x2F.
- `"R10/R11 Realtime (raw stream)"`, `"R22"`, `"Set Config (R22 feature flag)"`, `"Set Device Config (broadcast HR)"`,
  `"Enhanced Extended Battery"` etc.

## I. Signal-index family (`sig11` / `sig12` / `sig13`…) — NEW_HYPOTHESIS continuity

- `enable_sig11_during_sleep` (`Whoop5Config.swift:72`) — signal **11**, sleep-gated.
- `enable_sig12` (`Whoop5Config.swift:74`) — signal **12**, confirmed real write, RUNTIME capture.
- Explicit comment: the series is "the undocumented `enable_sig11…`/`enable_sig12` series continued",
  suggesting **`enable_sig13`…** as the next probe target (`DeviceConfigReadProbe.swift:124-126`).

The `sigN` feature flags are the single most direct lead family for *additional* high-rate sub-streams:
each apparently gates one labelled firmware signal stream.

---

## Ranked top-10 most-promising leads

Ranking weighs **(a) likelihood of unlocking more sensor data** and **(b) runtime evidence**.

| # | Lead | Token | Why promising | FRWHOOP status | Runtime evidence |
|---|---|---|---|---|---|
| 1 | R22 master + sig flags | `enable_r22_packets`, `enable_sig12`, `enable_sig11_during_sleep` (→ `enable_sig13`…) | Directly gate type-0x2F deep biometric + a named signal-index family; multi-stream sub-variants (v2…v8) | PARTIAL (historical 0x2F decoded; live not) | Strong: real write + read-back + capture-corrected value |
| 2 | SpO2 candidate keys | `enable_spo2`, `enable_spo2_packets`, `spo2_subscription_enabled`, `enable_blood_oxygen`, … | Would unlock a whole SpO2 stream; firmware *proves* SpO2 exists during sleep | NEW_HYPOTHESIS (read-only probe steps) | Indirect firmware string + `spo2_red/ir`, `spo2_candidate_82`; keys themselves never observed |
| 3 | `enable_raw_data_w_ecg` | device-config key | "**raw data**" paired with ECG — opens a raw-data device-config namespace | WIRED (MG ECG gate) | Read `'0'`/`'1'` round-trips on real MG |
| 4 | RESEARCH packet commands | `SET_RESEARCH_PACKET`/`GET_RESEARCH_PACKET` (131/132) | Named "research packet" — a purpose-built custom data channel | NEW_HYPOTHESIS (named only) | none |
| 5 | IMU toggles | `TOGGLE_IMU_MODE_HISTORICAL`(105) / `TOGGLE_IMU_MODE`(106) | Historical 100 Hz 6-axis IMU already decoded; live stream may be enabled if a corrected verb/flag is found | PARTIAL | Live cmd 106 ACKs but refuses to stream; historical v21 buffer validated on 1423 records |
| 6 | Optical-mode commands | `ENABLE_OPTICAL_DATA`(107) / `TOGGLE_OPTICAL_MODE`(108) | Direct optical (PPG) stream enable — highest-leverage raw optical unlock | NEW_HYPOTHESIS | none |
| 7 | Optical front-end register controls | `SET_AFE_PARAMETERS`(61), `SET_LED_DRIVE`(39), `SET_TIA_GAIN`(41), `SET_BIAS_OFFSET`(43) | Named "research" + directly tune the optical chain; "AFE" confirmed by console string | NEW_HYPOTHESIS | "AFE configuration changed" console string |
| 8 | v26 raw PPG waveform | 24 Hz i16 ADC (`ppg_waveform`) | Highest sample-rate raw optical already decoded; proves the deep optical path works end-to-end | DECODED_FRWHOOP | decoded + validated on real captures |
| 9 | v21 6-axis IMU buffer | 1244 B, 100 Hz | Full 6-axis accel+gyro obtainable via historical path — real motion data | DECODED_FRWHOOP | validated on 1423 buffers (gravity shell, gyro=0 at rest) |
| 10 | Continuous collection / secondary device keys | `cont_collection_mode`, `whoop_live_2_hrm_devices`, `enable_rfid` | Enumerated-but-unwritten device-config keys hint at more continuous/raw channels | NAMED_ONLY | keys themselves observed in enumeration walk |

**Also watch (honorable mentions):** `disable_pip_r26_packets` → the **R26 PIP** packet family
(`Whoop5Config.swift:67`), `IMU_SET_DATA_STREAM`/`UART_DISABLE` (`PROTOCOL.md:474-475`),
`CALIBRATE_CAPSENSE`/`CAPTOUCH_AUTOTHRESHOLD_ACTION` (capacitive/skin-contact), `ENTER_HIGH_FREQ_SYNC`(96),
and the `enable_r22_*` missing-`v7` naming gap.

---

**Integrity note.** This document records *names and hypotheses only*. Nothing here asserts a physical
identity, wavelength, unit, or register semantic for any token; each requires the run-books already
defined in `WHOOP5_HARDWARE_EXPERIMENT_QUEUE.md`
(`HARDWARE_REQUIRED` experiments) to validate. No semantics were invented during mining.
