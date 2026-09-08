# Backend documentation

Specs owned by the Node service. The developer index is [`../../docs/README.md`](../../docs/README.md).
This page only classifies files in this directory so they are not treated as
equal sources of truth.

## Canonical current (read these)

| File | Role |
| --- | --- |
| [PRODUCTION_ARCHITECTURE.md](PRODUCTION_ARCHITECTURE.md) | Persistence/ownership architecture |
| [SUPABASE_DATA_MODEL.md](SUPABASE_DATA_MODEL.md) | Database summary |
| [ARCHIVE_FORMATS.md](ARCHIVE_FORMATS.md) | B2 capture vs projection formats |
| [RAW_CAPTURE_ARCHITECTURE.md](RAW_CAPTURE_ARCHITECTURE.md) | Level-A archive + WAL |
| [REDECODE_PIPELINE.md](REDECODE_PIPELINE.md) | Decoder versioning and replay |
| [HEALTHKIT.md](HEALTHKIT.md) | HealthKit policy |
| [DATA_INTEGRITY_INVARIANTS.md](DATA_INTEGRITY_INVARIANTS.md) | Invariants |
| [DAY_BOUNDARY.md](DAY_BOUNDARY.md) | Day contract |
| [ENERGY_ACCOUNTING.md](ENERGY_ACCOUNTING.md) | Energy vocabulary enforced in code |
| [CALORIE_PIPELINE.md](CALORIE_PIPELINE.md) | Current bytes → kcal path |
| [FRWHOOP_PACKET_DECODING_AND_METRICS.md](FRWHOOP_PACKET_DECODING_AND_METRICS.md) | Decoder field map |
| [WHOOP5_PROTOCOL_NOTES.md](WHOOP5_PROTOCOL_NOTES.md) | Gen5 command facts |
| [WHOOP5_R22_FLAG_REFERENCE.md](WHOOP5_R22_FLAG_REFERENCE.md) | Feature-flag inventory |

[B2_ARCHIVE_FORMAT.md](B2_ARCHIVE_FORMAT.md) is an index that defers to
`ARCHIVE_FORMATS.md` plus the Level-B note. Do not treat it as a second schema.

## Product algorithms (status in each file)

| File | Notes |
| --- | --- |
| [PACKET_DECODING_AND_SLEEP.md](PACKET_DECODING_AND_SLEEP.md) | Sleep-oriented packet/byte notes (companion to the field map above) |
| [FRWHOOP_STRAIN_DECODING_AND_ALGORITHM.md](FRWHOOP_STRAIN_DECODING_AND_ALGORITHM.md) | Strain decode + score |
| [STRAIN_V2.md](STRAIN_V2.md) | Shadow |
| [ENERGY_MODEL.md](ENERGY_MODEL.md) / [ENERGY_EXPENDITURE_ARCHITECTURE.md](ENERGY_EXPENDITURE_ARCHITECTURE.md) / [ENERGY_EVALUATION.md](ENERGY_EVALUATION.md) | Supporting energy docs; accounting + calorie pipeline are canonical |
| [ENERGY_V2.md](ENERGY_V2.md) | Shadow learned layer |
| [ENERGY_V3.md](ENERGY_V3.md) | Off until v21 frames exist |
| [FUNCTIONAL_AGE.md](FUNCTIONAL_AGE.md) | Functional age |
| [vo2-max-methodology.md](vo2-max-methodology.md) | VO₂ max |
| [SENSOR_ANALYTICS_ARCHITECTURE.md](SENSOR_ANALYTICS_ARCHITECTURE.md) | Sensor analytics overview |

## Coach / eval

| File | Notes |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Coach request path |
| [EVALUATION.md](EVALUATION.md) | Eval harness |

## Protocol research (not product ingest)

| File | Notes |
| --- | --- |
| [PROTOCOL_COVERAGE.md](PROTOCOL_COVERAGE.md) | Coverage census |
| [PROTOCOL_NAME_LEADS.md](PROTOCOL_NAME_LEADS.md) | Name/access hypotheses |
| [PACKET51_56_AND_SERVICES.md](PACKET51_56_AND_SERVICES.md) | Packet 51–56 hypotheses |
| [LIVE_VS_HISTORICAL_ACCESS_MATRIX.md](LIVE_VS_HISTORICAL_ACCESS_MATRIX.md) | Live vs historical rates |
| [WHOOP5_SENSOR_HARDWARE_MATRIX.md](WHOOP5_SENSOR_HARDWARE_MATRIX.md) | Hardware baseline |
| [SENSOR_BLOCKER_CLASSIFICATION.md](SENSOR_BLOCKER_CLASSIFICATION.md) | Blockers |
| [STATE_DIFFERENCE_MODEL.md](STATE_DIFFERENCE_MODEL.md) | Official app vs FRWHOOP connect |
| [WHOOP5_HARDWARE_EXPERIMENT_QUEUE.md](WHOOP5_HARDWARE_EXPERIMENT_QUEUE.md) | Experiment queue |
| [FRWHOOP_PROTOCOLLAB.md](FRWHOOP_PROTOCOLLAB.md) | Bounded experiment harness |
| [POLAR_H10_EVAL_PROCEDURE.md](POLAR_H10_EVAL_PROCEDURE.md) | HR ground-truth procedure |
| [BLE_STORAGE_FAILURE_MODES.md](BLE_STORAGE_FAILURE_MODES.md) | Archive failure modes |

## Historical / phase notes (keep; do not treat as current contract)

| File | Notes |
| --- | --- |
| [RAW_SIGNAL_ARCHIVAL.md](RAW_SIGNAL_ARCHIVAL.md) | Phase-0 high-rate archival proposal (PPG/IMU/ECG). Product ingest does not currently consume those streams. |
| [DEVICE_SOAK.md](DEVICE_SOAK.md) / [WORKOUT_MODE_QA.md](WORKOUT_MODE_QA.md) | Operational QA notes |
