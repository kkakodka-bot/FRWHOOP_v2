# SENSOR_BLOCKER_CLASSIFICATION.md

For every WHOOP 5 raw sensor stream that is not yet live at full resolution in FRWHOOP, this records a
precise blocker class. "Unavailable" is never used generically; each entry distinguishes an engineering
gap FRWHOOP can fix from a real firmware refusal.

Blocker vocabulary (from the mission):
ALREADY_AVAILABLE_FRWHOOP_NOT_DECODING · DECODER_INCOMPLETE · RAW_BYTES_AVAILABLE_SEMANTICS_UNKNOWN ·
KNOWN_COMMAND_NOT_IMPLEMENTED · KNOWN_COMMAND_BLOCKED_BY_CLIENT_ALLOWLIST · WRONG_WHOOP5_COMMAND_FRAMING ·
MISSING_FEATURE_FLAGS · MISSING_CONFIGURATION · MISSING_CHARACTERISTIC_SUBSCRIPTION ·
AVAILABLE_ONLY_IN_R22 · AVAILABLE_ONLY_HISTORICALLY · AVAILABLE_LIVE_AT_LOWER_RATE ·
FIRMWARE_ACKNOWLEDGES_BUT_DOES_NOT_STREAM · FIRMWARE_EXPLICITLY_REJECTS · NO_KNOWN_FIRMWARE_INTERFACE ·
PHYSICAL_SENSOR_NOT_PRESENT · UNRESOLVED.

## Accelerometer
| Path | Rawest representation | Highest live rate | Highest historical rate | Blocker (now) | Blocker (after this session) |
|---|---|---|---|---|---|
| Historical v21 IMU | raw i16 counts (100 Hz ×6) | n/a (offload) | 100 Hz | DECODER_INCOMPLETE (was) | **DECODED, full arrays persisted** |
| Live via START_RAW_DATA(81) | raw i16 counts | ~100 Hz (hypothesis) | n/a | KNOWN_COMMAND_NOT_IMPLEMENTED (FRWHOOP client sends no 81) | CLIENT_NOT_REQUESTING_STREAM → HARDWARE_REQUIRED to confirm |

## Gyroscope
| Path | Rawest | Live | Historical | Blocker |
|---|---|---|---|---|
| Historical v21 gyro | raw i16 (100 Hz) | n/a | 100 Hz | **DECODED** (6×100 arrays) |
| Live via TOGGLE_IMU_MODE(106) | raw gyro counts | ? | n/a | FIRMWARE_ACKNOWLEDGES_BUT_DOES_NOT_STREAM (NOOP evidence) but NOOP pairs 106+81 in its live accel path → re-test per firmware; HARDWARE_REQUIRED |
| Live via command 81 (may carry gyro) | raw gyro counts | ? | n/a | CLIENT_NOT_REQUESTING_STREAM; E-81 / E-106 |

## Raw optical / PPG
| Path | Rawest | Live | Historical | Blocker |
|---|---|---|---|---|
| Historical v26 | raw i16 ADC (24 Hz) | n/a | 24 Hz | **DECODED** (full waveform) |
| Historical v20 | raw s20-ish i32 optical blocks | n/a | ~25 Hz / block ×2 channels | **DECODED** (6 channels, wavelength OPEN) |
| Live via START_RAW_DATA(81) (437 Hz) | raw s24 ADC + per-sample aux + config | ~437 Hz (hypothesis) | n/a | KNOWN_COMMAND_NOT_IMPLEMENTED (client) → HARDWARE_REQUIRED to confirm whoop5 offset shift |
| Red/IR/green separation | underlying photodiode bands | ? | ? | RAW_BYTES_AVAILABLE_SEMANTICS_UNKNOWN — only a single AC-coupled channel proven; red/IR not yet identifiable |

## SpO2 inputs (raw red/IR)
| Path | Rawest | Blocker |
|---|---|---|
| v18 @82 spo2_candidate_82 | strap-computed scalar (70-100, sleep) | SPLIT evidence — instrumentation-only, NOT a metric; RAW red/IR inputs UNRESOLVED |
| v20/v26/R22 optical | raw optical samples | RAW_BYTES_AVAILABLE_SEMANTICS_UNKNOWN — wavelength identity OPEN |

## Skin temperature
| Path | Rawest | Blocker |
|---|---|---|
| v18 skin_temp_raw@73 | raw u16 register (/100 °C) | **DECODED**; a rawer/internal ADC may exist → E-TEMP (HARDWARE_REQUIRED) |
| v18 temp_aux_1/2@69/71 | signed i16 /10 °C | **DECODED** |
| charging/internal temp | ? | UNRESOLVED; console/events (TEMPERATURE_LEVEL) → E-TEMP |

## HR / RR
| Path | Rawest | Blocker |
|---|---|---|
| type 40 HR/RR | HR bpm + RR ms | **DECODED** |
| v18 HR/RR | per-second HR + up to 4 RR | **DECODED** |
| RR completeness | full RR stream | UNRESOLVED — needs mode/config + coverage quantification (E-R22, official-app diff), then a real night. |

## Wear / contact
| Path | Rawest | Blocker |
|---|---|---|
| v18 onwrist@81 (b0-1) + motion_wear_quality@63 | flag byte | **DECODED** |
| WRIST_ON/OFF events (9/10) | event | **DECODED** (event+ts) |
| capacitive electrical parameters | ? | NO_KNOWN_FIRMWARE_INTERFACE — only derived flags exposed |

## Motion quality / optical quality
| Path | Rawest | Blocker |
|---|---|---|
| v18 optical_amp_a/b@108/109 | u8 pair; 128 = signal-quality sentinel | **DECODED** |
| v18 hr_quality_flags@36 bit7 | validity bit | **DECODED** |
| richer quality (saturation/perfusion) | ? | AVAILABLE_ONLY_IN_R22 / UNRESOLVED — E-R22 mapping |

## Battery / device
- type 36 GET_BATTERY_LEVEL battery_pct, type 48 EVENT battery soc/mV/charging, type 49 metadata: **DECODED**.
- Extended battery info / fuel gauge resets: NO_KNOWN_FIRMWARE_INTERFACE beyond enumerated names unless a real capture shows otherwise.

## Events & metadata & console
- All known event numbers = **DECODED at event+ts**; payload decoded for BATTERY_LEVEL only. Unknown event
  codes (48-55, 61-62, 64-95, 99) = RAW_BYTES_AVAILABLE_SEMANTICS_UNKNOWN → cluster by context.
- Metadata (trim_cursor, unix, subsec) = **DECODED**.
- Console logs = **DECODED at text level**; grep for mode names → E-CONSOLE.

---

## Rawness taxonomy (how much processing before FRWHOOP sees it)
| Signal | Classification |
|---|---|
| v21 IMU counts | RAW_SENSOR_COUNTS (i16; scale applied at read time) |
| v20 optical blocks | RAW_ADC / RAW_SENSOR_COUNTS (signed containers; units unknown) |
| v26 PPG | RAW_ADC (i16, AC-coupled, no absolute unit) |
| type-43 optical 1921 | RAW_ADC (s24) + per-sample aux |
| v18 skin_temp_raw | RAW_SENSOR_COUNTS → decoded °C = FIRMWARE/raw-derived; prefer raw, also keep °C |
| v18 gravity / dyn_accel | FIRMWARE_FILTERED_SAMPLE (f32 g; the raw accel source is v21) |
| v18 HR / RR | FIRMWARE_METRIC (cardiac) — RR ms is closer to raw than HRV aggregate |
| activity_class / sleep_state | FIRMWARE_CLASSIFICATION |
| FRWHOOP energy/motion score | FRWHOOP_DERIVED_METRIC (derived from IMU/HR) |

FRWHOOP keeps the rawest legitimate representation **and** the calibrated/derived value; none replaces the
other. Full-resolution live-rate and historical-rate figures are consolidated in
`LIVE_VS_HISTORICAL_ACCESS_MATRIX.md`.
