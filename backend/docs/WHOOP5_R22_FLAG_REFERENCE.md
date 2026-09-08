# WHOOP5_R22_FLAG_REFERENCE.md — canonical feature-flag + device-config inventory

Baseline NOOP @ ab0f699e; FRWHOOP port lineage `frwhoop-js/1 <- noop@ab0f699e`. Every value is read from
NOOP source or a NOOP hardware probe result. Names are hypotheses until runtime validates them; FRWHOOP
must never enable an unknown flag.

## 1. Exact official-app R22 enable sequence (16 writes, SET_FF_VALUE = 120 = SET_CONFIG 0x78)
Body = ASCII flag name NUL-padded to 32 bytes + value byte (ASCII '1'=0x31 / '2'=0x32) at offset 32 + 7
zeros. Written WITH-RESPONSE, ~80 ms apart, on-wrist + bonded. `enable_r22_packets` is the master that
opens the live type-0x2F (= 47 HISTORICAL_DATA) high-rate stream.

| # | Flag | Value | Evidence |
|---|---|---|---|
| 1 | `enable_r22_packets` | '2' | master; opens type-0x2F stream; judes.club + real captures |
| 2 | `enable_r22_v2_packets` | '2' | judes.club |
| 3 | `enable_r22_v3_packets` | '2' | judes.club |
| 4 | `enable_r22_v4_packets` | '1' | judes.club |
| 5 | `enable_r22_v5_packets` | '2' | judes.club |
| 6 | `enable_r22_v6_packets` | '2' | judes.club |
| 7 | `enable_r22_v8_packets` | '2' | judes.club (note: v7 absent) |
| 8 | `make_hrfm_visible` | '2' | judes.club |
| 9 | `disable_pip_r26_packets` | '2' | judes.club |
| 10 | `wear_detect_bias` | '2' | judes.club |
| 11 | `hr_ch_switching` | '2' | HR channel switching (optical-mux related) |
| 12 | `ir_hw_switching` | '2' | **IR hardware switching — SpO2-relevant lead** |
| 13 | `enable_passive_strap_fit_gen5` | '1' | judes.club |
| 14 | `enable_sig11_during_sleep` | '2' | undocumented sig-flag series |
| 15 | `dorset_inhibit_wpt` | '2' | judes.club |
| 16 | `enable_sig12` | '1' (corrected from '2') | real on-strap iOS HCI capture during a live workout (#103/#423) |

FRWHOOP sends **none** of these today (client only sends puffinHello GET_HELLO + HR subscribe).

## 2. Read-only feature-flag + device-config enumeration (hardware evidence)
- `START_FF_KEY_EXCHANGE(117)` + `SEND_NEXT_FF(118)` — feature-flag discovery.
- `GET_FF_VALUE(128)` — read a flag value. **VERIFIED ANSWERED on hardware**: served `enable_r22_packets =
  '2' (0x32)` and a value for `hr_ch_switching` — so 128 is a working read path on the strap.
- `START_DEVICE_CONFIG_KEY_EXCHANGE(115)` + `SEND_NEXT_DEVICE_CONFIG(116)` — device-config discovery.
- `GET_DEVICE_CONFIG_VALUE(121)` — **VERIFIED UNSUPPORTED on the tested strap** (no reply/unsupported).
- Known-good device-config key (from the Broadcast-HR feature #181): `whoop_live_hr_in_adv_ind_pkt`
  (written via SET_DEVICE_CONFIG_VALUE 0x77). Other known device-config keys NOOP has enumerated:
  `cont_collection_mode`, `enable_raw_data_w_ecg` (MG ECG gate), `enable_rfid`,
  `max_collection_backlog`, `sigproc_wear_detect`, `whoop_live_2_hrm_devices`.

## 3. Oxygen / SpO2 candidate keys (GUESSES — never observed on a wire)
NOOP's read probe tries these in the device-config namespace; `enable_spo2` returned **FAILURE(0)** on
the tested strap (so that device/firmware did not serve an oxygen device-config gate):
`enable_spo2`, `enable_spo2_packets`, `spo2_enable`, `enable_blood_oxygen`, `blood_oxygen_enable`,
`enable_pulse_ox`, `enable_oxygen_packets`, `spo2_subscription_enabled`.
These must be re-probed per firmware (E-FF-READ / E-DC-READ). A positive answer to any is a direct
firmware-named path to oxygen data.

## 4. SpO2-relevant decoding leads
- v18 `@82` `spo2_candidate_82` (70–100 in sleep): instrumentation-only; split cross-device evidence.
- `ir_hw_switching` flag: IR hardware switching — potentially exposes an IR illumination path; correlate
  the v20/v26 optical channels after flipping this flag (guarded experiment).
- `hr_ch_switching`: HR optical channel multiplexing — may change which optical channel carries HR.
- v20 five-block optical buffer is the best current raw-optical surface; wavelength identity OPEN.

## 5. FRWHOOP integration status
- v18/v20/v21/v26 decoders: ported (protocol/whoop5.js).
- typ-43 IMU(1917)/optical(1921): ported.
- Feature-flag / device-config read-back parsing: NOT yet ported into FRWHOOP — the R22 writes and the
  117/118/115/116/121/128 probes are the next client-implementation work (hardware on-wrist required to
  exercise them on 5.0).
