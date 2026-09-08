# State-Difference Model: officially-configured WHOOP vs a freshly-connected FRWHOOP strap

**Purpose.** Model, dimension by dimension, the *settable/programmable state* an **officially paired and
configured** WHOOP 5.0/MG (and WHOOP 4.0) enters, versus the state a **freshly-connected FRWHOOP** strap is
left in. The gap between the two is what withholds the richer sensor output. Each difference is labelled
**VERIFIED** (from source / real captures) or **INFERRED** (named-but-unmeasured, guessed body, or
cross-namespace convention).

**Baseline commit:** NOOP `ab0f699e`; FRWHOOP `whoop` (iOS bridge `WhoopBlePlugin.swift` /
`WhoopProtocol.swift`, backend `backend/protocol/whoop5.js`).

> **Top line.** The single highest-value state difference is the **R22 feature-flag state**: the official
> app writes a persistent **16-flag `SET_FF_VALUE` (120) burst** (`enable_r22_packets` + 15 siblings) right
> after the hello handshake, which opens the **type-0x2F** high-rate biometric stream and the deep
> `v20/v21/v26` type-47 records. **FRWHOOP writes none of it on connect** — the sequence exists only in its
> debug-gated `protocol_lab "r22"` phase. That one omission is what keeps WHOOP 5 recovery/strain/sleep
> physics off the wire for FRWHOOP.

---

## 1. Inverse, essential framing: what a *freshly-connected* (pre-configure) 5.0 gives any client

A WHOOP 5.0/MG hands a client that **only subscribes to the notify channels and does nothing else** just:
- **Live heart rate** over the standard `2A37` profile (works **unbonded**) — **VERIFIED**.
- The **type-43 / R22 deep streams stay withheld** until the feature flags are set — **VERIFIED**
  (`WHOOP5_DEEP_DATA.md`; "The blocker is not that NOOP isn't listening — the strap simply doesn't *start*
  the deep streams for a session that hasn't set the flags.").
- **No scores.** Recovery/strain/sleep *scores* are WHOOP-cloud computed and never reproducible from the
  wire — **VERIFIED** (`WHOOP5_DEEP_DATA.md`).

Everything "extra" downstream of that is a **config difference** catalogued below.

---

## 2. Dimension-by-dimension state model

| # | Dimension | Official app (configured) | FRWHOOP (fresh connect) | Difference | Status |
|---|---|---|---|---|---|
| 1 | **Feature flags (R22)** | Writes **16 persistent `SET_FF_VALUE`(120)** flags after hello: `enable_r22_packets`(+v2/v3/v4/v5/v6/v8), `make_hrfm_visible`, `disable_pip_r26_packets`, `wear_detect_bias`, `hr_ch_switching`, `ir_hw_switching`, `enable_passive_strap_fit_gen5`, `enable_sig11_during_sleep`, `dorset_inhibit_wpt`, `enable_sig12`. **VERIFIED** (judes.club decrypted capture + #103/#423 on-strap capture) | **None** on connect. The identical 16-flag array exists in `WhoopProtocol.swift` but is sent only in the manual `runProtocolLab(phase:"r22")` debug path. **VERIFIED** | **HIGHEST-VALUE DIFFERENCE.** R22 deep streams (`0x2F`, `v20/v21/v26`) stay off | **VERIFIED** on both sides |
| 2 | **Device-config values** | Writes device-config keys via `SET_DEVICE_CONFIG_VALUE`(119): e.g. `whoop_live_hr_in_adv_ind_pkt='1'` (Broadcast HR), `enable_raw_data_w_ecg` (MG ECG raw gate). **VERIFIED** (Broadcast HR on real HW + Garmin Edge 840; ECG key written+read #891) | **No device-config writes** — `setBroadcastHr` / 119 writes not implemented in the iOS bridge. **VERIFIED** | Broadcast-HR (0x180D advertising) + MG ECG raw gate absent | VERIFIED |
| 3 | **Subscribed characteristics** | Subscribes to the data/notify channels and, after config, the deep streams | Subscribes to WHOOP 5 `fd4b0003/4/5/7` + `2A37`; WHOOP 4 `61080003/4/5` + `2A37` (+ `2A19`, DIS). **VERIFIED** (`isWhoopStream`/`didDiscoverCharacteristicsFor`) | **Same subscription surface** — both listen on all 4 data channels. So the gap is *not* "isn't listening"; it's that the strap doesn't *emit* until flags are set | VERIFIED (no diff) |
| 4 | **Command sequence / timing** | hello → **R22 16-flag burst** (each with-response, ~tens of ms apart) → data-range → history | WHOOP 5: hello (`CLIENT_HELLO`/0x91) → `SET_CLOCK`(10) → `TOGGLE_REALTIME_HR`(3). WHOOP 4 adds `GET_HELLO_HARVARD`(35), `GET_CLOCK`(11)×2, `LINK_VALID`(1), cmd 14. **VERIFIED** (`armLiveHeartRate`) | Official runs the 16-flag burst; FRWHOOP never does. FRWHOOP also skips `GET_DATA_RANGE`(34), and (4.0) never sends `SEND_R10_R11_REALTIME`(63 `[0x00]`) to stop the raw flood / **does not** `EXIT_HIGH_FREQ_SYNC` defensively | VERIFIED |
| 5 | **Historical mode** | Full type-47 offload with chunk ack; uses high-freq mode (PLAIN SEND still works) | Requests `SEND_HISTORICAL_DATA`(22)+ack(23) on a **15-min timer**. **VERIFIED** (`scheduleHistorySync`/`requestHistoricalData`/`ackHistoricalData`) | **Parity on the 22/23 loop** — but without R22 flags the 5.0 records are only baseline `v18`; the deep `v20/v21/v26` come only with flags. Also NOOP *defensively* sends `EXIT_HIGH_FREQ_SYNC`(97) on connect; FRWHOOP does **not** enter or exit high-freq | Partial (VERIFIED) |
| 6 | **Optical mode** | R22 flags `enable_r22(_v*)_packets` select the R22 optical data-product channel set (`0x2F`; `v1–v8`) | No R22 flags → optical stays baseline single-channel; FRWHOOP captures type-43 raw and v26/v20 **raw-only** on-device (decoded in backend) | R22 optical selector unset | VERIFIED |
| 7 | **IMU mode** | NOOP/official can toggle `TOGGLE_IMU_MODE`(106) / `TOGGLE_IMU_MODE_HISTORICAL`(105) | FRWHOOP sends these **only** in `protocol_lab "cmd105"/"cmd106"` phases, never on connect. **VERIFIED**. (Note: 5.0 firmware **refuses** 106 live stream anyway; 105 may increase banked IMU coverage) | IMU streaming/banking mode left default | VERIFIED |
| 8 | **Research mode** | NOOP exposes experimental research toggles (enableRawCapture, PPG sub-lag, R22 disable, ECG probes) | FRWHOOP exposes a debug `protocol_lab` set (`cmd81`, `r22`, `cmd105`, `cmd106`) that is **manual, gated, not auto-run** | **Both** keep research off by default; identical posture | VERIFIED |
| 9 | **R22 mode** | **ON** (official) | **OFF** by default; available only via manual lab `r22` phase | The core unlock is present-but-disabled in FRWHOOP | VERIFIED |
| 10 | **Broadcast settings** | Can set `whoop_live_hr_in_adv_ind_pkt='1'` → 0x180D HR advertising (pairable by Garmin/Zwift) | Not implemented in iOS (`setBroadcastHr` absent); `PuffinExperiment.broadcastHrKey` is a **NOOP** concept, no FRWHOOP equivalent | Broadcast-HR advertising unavailable | VERIFIED |
| 11 | **Packet frequency** (what the strap *emits*) | R22 high-rate realtime `0x2F` + deep type-47 `v20/v21/v26`; 1 Hz HR fallback | Baseline only: 1 Hz HR (`2A37`) + 15-min `v18` history; **no high-rate realtime**; deep `v20/v21/v26` withheld | Frequency gap is *derived from* flags, not independently settable | INFERRED (consequence of #1) |
| 12 | **Console output (type 50)** | Both capture/interpret strap console logs | FRWHOOP archives `CONSOLE_LOGS` type-50 raw to Level A/B. **VERIFIED** (`PROTOCOL_COVERAGE.md`) | **No diff** — both persist type-50 | VERIFIED (no diff) |

---

## 3. Smallest known-safe set of config differences that likely produces richer sensor output

This is the concrete FRWHOOP roadmap. Ordered by (a) confidence of effect, (b) expected data return, and
(c) minimal change. Every write is reversible; the strap's R22 path is on-wrist gated, so run while worn.

### Step 1 — Wire the R22 feature-flag burst on connect (highest value). 
- **What:** after the puffin hello + `SET_CLOCK`, write the 16-flag `enableR22Sequence` (`SET_FF_VALUE`/120,
  with-response, ~50–80 ms apart), on-wrist. **Already implemented** as `enableR22Sequence` +
  `setFfPayload` in `WhoopProtocol.swift` — only the *call site* is missing (today it's debug-lab-only).
- **Returns:** the **type-0x2F** high-rate biometric stream and the deep **`v20` (≈25 Hz optical),
  `v21` (100 Hz 6-axis IMU), `v26` (24 Hz PPG)** type-47 records — which the FRWHOOP backend `whoop5.js`
  **already decodes at full NOOP parity**. Minimal work, maximal new data.
- **Safety:** opt-in toggle (NOOP precedent #174), reversible via the documented `disableR22Sequence`
  (off byte `'0'` is **INFERRED**, not measured — read back with `GET_FF_VALUE`/128 to confirm, as
  `R22DisableReport` does). This is the same thing the official app does on every connect.
- **Status:** VERIFIED that the sequence works; SAFE because it only changes which data the strap emits.

### Step 2 — Stop the raw type-43 flood + refresh data range (parity + battery). 
- **What:** on connect send `SEND_R10_R11_REALTIME`(63) `[0x00]` (the *real* type-43 switch — `STOP_RAW_DATA`
  (82) does not affect it) and `GET_DATA_RANGE`(34), and defensively `EXIT_HIGH_FREQ_SYNC`(97). 
- **Returns:** predictable ~2/s → 0/s (verified on-device), less BLE airtime / battery / flash, and a liveness
  watchdog signal. Also prevents the raw flood from starving the history offload.
- **Status:** VERIFIED (NOOP handshake).

### Step 3 — Expose bounded live raw capture for research (4.0). 
- **What:** promote the `cmd81`/`cmd106` lab phase to a real opt-in "capture raw accel" feature that sends
  `START_RAW_DATA`(81)+`TOGGLE_IMU_MODE`(106), records, then `STOP_RAW_DATA` — NOOP's `captureRawAccel`.
- **Returns:** bounded **100 Hz 6-axis IMU** live on WHOOP 4.0. On WHOOP 5.0 the live path stays refused
  (firmware); use `v21` history instead.
- **Status:** VERIFIED mechanism (NOOP); the 5.0 live refusal is VERIFIED physical/firmware.

### Step 4 — Optional: device-config hooks. 
- **What (optional):** implement `SET_DEVICE_CONFIG_VALUE`(119) for `whoop_live_hr_in_adv_ind_pkt` (Broadcast
  HR) and, on an MG, `enable_raw_data_w_ecg` for the ECG raw gate. 
- **Returns:** Garmin/Zwift-pairable HR advertising; MG ECG *gate* (note #891: gate open ≠ ECG data without a
  validated turn-on sequence).
- **Status:** Broadcast HR VERIFIED; ECG verb mapping INFERRED, silent-on-MG null result.

---

## 4. What stays unchanged / out of reach regardless of config

- **No cloud scores** (recovery/strain/sleep) — WHOOP-cloud computed, never on the wire. **VERIFIED.**
- **No 5.0 dual-wavelength SpO₂ / blood-pressure on the wire** — 26-way time-multiplex, single channel;
  the 5.0 SpO₂ is the on-device sleep-only `@82` candidate (split evidence). **VERIFIED.**
- **No live 100 Hz IMU on 5.0** — firmware acks `TOGGLE_IMU_MODE` and never streams; the v21 **historical**
  offload is the supported 5.0 IMU path. **VERIFIED.**
- **`v20` wavelength identity** and **MG ECG opcode mapping** remain **open** pending labelled / HCI captures
  (HARDWARE_REQUIRED).

---

## 5. Verification legend for the roadmap

| Claim | Basis |
|---|---|
| VERIFIED | Real strap capture / byte-for-byte golden frame (NOOP fixtures, #103, #423, #845, judes.club) or on-device round-trip |
| INFERRED | Named opcode/verb, guessed body, or cross-namespace convention (feature-flag OFF byte `'0'`, ECG opcode mapping) |
| HARDWARE_REQUIRED | Needs a physical strap / official-app HCI differential capture that this software-only sandbox cannot produce |

*Independent interoperability for the user's own device; not affiliated with WHOOP, not a medical device.*
