# WHOOP 5.0 raw-signal archival contract (Phase 0)

## What the NOOP layer can decode (verified against this repo's code)

The native NOOP WHOOP-protocol package decodes, for WHOOP 5.0/MG:

- **100 Hz 6-axis IMU** (`Whoop5RawImu.swift`): accel 1/4096 g/LSB, gyro
  2000/32768 dps/LSB, 100 accel + 100 gyro samples per 1-s offload buffer. The
  *live* 100 Hz stream is firmware-refused; the connect-time **historical offload
  buffer** is the obtainable path. Validated on real captures: accel magnitude ~1 g
  shell, gyro correlates 0.79 with accel motion.
- **Raw PPG optical buffers** (`Whoop5RawOptical.swift`): 5 configurable detector
  blocks (source/drive/range/offset), calibrated units unknown.
- **ECG** (`Whoop5Ecg.swift`), **RR intervals**, **HR**, **skin temperature**,
  **battery**, **body-location** and feature-flag probes.

These are decoded in the native Strand app, which has **no server uploader**. The
FRWHOOP backend receives only the Capacitor live 4 s HR + scalar-motion path today.
Phase 0 archival is the work of pushing the above into B2.

## Proposed B2 streams

Reusing the existing key builder (`storage/keys.js`), which already defines
`rawObjectKey` kinds `imu`, `ppg`, `derived` with binary retention classes:

| Stream | Key kind | Suggested content | Retention |
|---|---|---|---|
| `imu_raw` | `imu` | 6-axis, 100 Hz, columnar i16 raw (as stored by `Whoop5RawImu.rawColumns`) | imu |
| `rri_raw` | `rr` / physiology | RR intervals, ms, with stable sort order | core |
| `ppg_raw` | `ppg` | raw optical AC-coupled window | ppg |
| `sensor_quality` | `derived` | per-window HR/PPG/IMU/wear quality flags | core |
| `derived_motion_features` | `derived` | the feature vector from `energy/imuFeatures.js` (ENMO, SMA, cadence, tilt, entropy, …) | core |

`Supabase` keeps compact derived features + queryable outputs; B2 keeps the raw
bytes so future models replay without recollect. `object_manifests` already records
sha256 + counts per object; we add an explicit `sample_count` and `window_count`
per manifest row.

## Idempotency and dedup

`imu_raw` uses the 1-s base timestamp as the row key; `rri_raw` uses beat ts; both
are keyed `(user, device, stream, hour)` with deterministic object IDs so a retried
upload overwrites, not duplicates. The existing sync queue provides retry/offline
semantics without double counting — this matches the energy engine's idempotent
ingest.

## Timestamp synchronization

Every raw row carries `strap_ts` (strap unix seconds) AND `wall_ts` (wall clock),
plus the drift offset `wall_ts - strap_ts` at capture, so clock drift is audit-able
rather than silently corrected. `Whood5RawImu.baseTs` gives the strap's 1-s frame
stamp; `ts(of:)` spreads samples across the frame.

## Data-quality accounting

Each bucket records counts: `expected_vs_received` per channel, duplicate/out-of-
order/gap counts, BLE-disconnect minutes, off-wrist minutes (from wear/contact or
gravity), warmup windows, and whether interpolation (if any) was applied. The
energy estimate must not silently interpolate substantial missing data — gaps stay
absent unless explicitly projected as resting.

## Storage / compression sizing (see rawStreamVolume.js estimate)

At 100 Hz × 6 axes × 2 bytes = 1200 B/s per user fully covered, ~4.3 MB/h,
~104 MB/day/user if stored uncompressed i16. Binary zstd on columnar i16 with
quiescent stretches typically compresses 5–15×, so realistic daily is ~7–20 MB
compressed for continuous 100 Hz coverage, dominated by sleep/rest periods. A
**battery/bandwidth budget** must cap hours: storing raw IMU for the entire day is
likely prohibitive on mobile upload; a defensible default is `derived_motion_features`
+ `rri_raw` continuously (small) and `imu_raw`/`ppg_raw` only in **bounded windows**
(workouts + calibration protocols, OFF by default), so the raw high-rate streams are
captured *when the expensive inference would happen* without streaming 100 Hz all day.
These estimates must be re-measured on real captures during Phase 0 validation; they
are inputs to the decision, not the decision.
