# FRWHOOP strain: BLE packet decoding and scoring algorithm

**Status:** implementation-aligned reference
**Scope:** FRWHOOP iOS BLE ingestion, `whoop/backend`, and frontend strain display
**Reviewed:** 2026-08-27

This document follows the strain signal from raw WHOOP BLE bytes to the number
shown in FRWHOOP. It explains:

- which packets and byte fields can become heart-rate samples;
- how WHOOP 4.0/Harvard and WHOOP 5.0/MG/Puffin frames are reassembled and
  validated;
- how historical records become normalized HR samples;
- the exact backend daily-strain formula;
- the separate formulas used for manually logged and auto-detected workouts;
- how the frontend derives live and chart-only strain values;
- what is persisted, replayed, rejected, or intentionally left unknown.

The implementation described here is FRWHOOP's own transparent approximation.
It is not WHOOP's private production algorithm, is not machine learning, and is
not a medical measurement.

## 1. The short answer

FRWHOOP's canonical daily strain is a deterministic, heart-rate-derived,
Edwards-style TRIMP-like score:

```text
HRR% = (BPM - resting_HR) / (max_HR - resting_HR) × 100

TRIMP = Σ(duration_minutes × intensity_weight(HRR%))

daily_strain =
  clamp(21 × ln(TRIMP + 1) / ln(7201), 0, 21)
```

The current backend implementation is `strainFromHr()` in
`backend/metrics/sleep.js`.

The most important distinction is that the system contains several strain-like
values:

1. **Daily strain:** calculated from the day's valid timestamped HR samples.
2. **Auto-detected workout strain:** a duration/average-HR estimate attached to
   a detected workout session.
3. **Manual activity strain:** a sport-weighted estimate for an activity entered
   through `/api/activities`.
4. **Frontend instantaneous/chart strain:** display approximations used to paint
   a live marker or intraday curve.

These values use related logarithmic ideas but are not interchangeable.

## 2. Which decoded bytes affect strain?

### 2.1 Direct inputs to canonical daily strain

The daily scorer needs:

- a valid heart rate, `20…240` BPM;
- a parseable timestamp for every sample;
- a resting-heart-rate value, normally derived from the scored overnight
  window, with a default of `55` BPM;
- a maximum-heart-rate value, defaulting to `190` BPM in the current backend
  function.

The daily strain function does **not** directly consume:

- RR intervals;
- gravity or accelerometer values;
- dynamic acceleration;
- steps;
- skin temperature;
- activity class;
- packet type by itself;
- workout name or sport.

Those signals may help other analyzers, such as sleep detection, HRV,
respiration, steps, temperature, or workout detection. They do not add an
independent term to `strainFromHr()`.

### 2.2 Packet sources that can supply HR

The normal HR projection can receive BPM from:

- WHOOP custom `REALTIME_DATA` type `40`;
- standard Bluetooth Heart Rate Measurement `180D/2A37`;
- historical WHOOP 4 Harvard type-47 version 24 records;
- historical WHOOP 5/MG Puffin type-47 version 18 records;
- normalized/replayed records that originated from those sources.

The following are not normal direct BPM sources in the FRWHOOP path:

- Harvard v25 historical records, which are gravity-only;
- Puffin v20 optical bulk records;
- Puffin v21 six-axis bulk records;
- Puffin v26 raw PPG waveform records;
- type-43 raw IMU/optical streams.

Some raw records expose an HR hint or optical waveform. A hint or waveform is
not automatically promoted to canonical BPM. FRWHOOP only scores values that
have passed an explicit HR interpretation and validity gate.

## 3. End-to-end path

```text
WHOOP strap
  │
  ├─ vendor ATT notifications
  │    ├─ Harvard / WHOOP 4.0 (`6108…`)
  │    └─ Puffin / WHOOP 5.0 and MG (`FD4B…`)
  │
  └─ standard GATT notifications (`180D/2A37`)
       │
       ▼
iOS WhoopBleManager
  ├─ capture raw notification before interpretation
  ├─ maintain one reassembly buffer per vendor stream
  ├─ validate envelope lengths and CRCs
  ├─ decode type-40 live HR and historical type-47 records
  └─ write crash-safe SensorQueue rows
       │
       ├─ live HR → sensor-queue.ndjson
       ├─ historical HR → historical-physiology.ndjson
       └─ opaque ATT bytes → ble-frames.ndjson
              │
              ▼
POST /api/ble/live
  ├─ hourBuffer: live samples and opaque frame archive
  └─ historyBuffer: sensor-time historical samples
       │
       ▼
normalizeSample()
  ├─ BPM/RR/quality/time validity gates
  └─ normalized physiology archive
       │
       ▼
createMetricsEngine().persistComputed()
  └─ scoreDay()
       └─ strainFromHr()
            └─ daily strain on the 0–21 axis
       │
       ├─ B2 derived object
       ├─ Supabase daily_metrics
       └─ daily_physiology_series
              │
              ▼
API snapshot → frontend
  ├─ canonical Day Strain value
  ├─ frontend live/chart approximations
  └─ target bands and labels
```

The principal source files are:

- iOS frame and history decoding:
  `frontend/ios/App/App/WhoopProtocol.swift`
- iOS BLE routing and HR priority:
  `frontend/ios/App/App/WhoopBlePlugin.swift`
- iOS durable queues:
  `frontend/ios/App/App/SensorQueue.swift`
- backend framing and CRC verification:
  `backend/protocol/framing.js`
- backend packet dispatch:
  `backend/protocol/decoder.js`
- WHOOP 5 deep layout maps:
  `backend/protocol/whoop5.js`
- normalization and archives:
  `backend/ingest/archiveFormat.js`
- live and historical buffering:
  `backend/ingest/hourBuffer.js` and
  `backend/ingest/historyBuffer.js`
- daily metrics orchestration:
  `backend/metrics/engine.js`
- daily strain:
  `backend/metrics/sleep.js`
- workout-session strain:
  `backend/metrics/workoutSession.js`

## 4. BLE family selection and byte conventions

All offsets below are absolute offsets from the beginning of a complete frame.
They are not offsets from the semantic payload.

Unless a layout says otherwise, multi-byte values are little-endian:

```text
u16 LE = byte[off] | (byte[off + 1] << 8)
u32 LE = byte[off]
         | (byte[off + 1] << 8)
         | (byte[off + 2] << 16)
         | (byte[off + 3] << 24)
```

The vendor family is selected from the characteristic:

- `6108…` identifies the Harvard/WHOOP 4 family.
- `FD4B…` identifies the Puffin/WHOOP 5/MG family.
- `180D/2A37` is the standard Bluetooth HR characteristic and has no WHOOP
  vendor envelope.

WHOOP 5.0 and MG must be parsed as Puffin. Applying Harvard offsets with a
four-byte shift is not sufficient because the length field, header checksum,
and trailer positions differ.

## 5. Standard GATT heart-rate bytes

The standard `0x2A37` measurement is parsed by
`WhoopBlePlugin.parseHeartRate()`.

The first byte is a flags byte:

- bit `0x01`: HR is a `u16 LE` at bytes `1…2`; otherwise it is a `u8` at byte
  `1`;
- bit `0x08`: skip a two-byte energy-expended field after the HR value;
- bit `0x10`: remaining two-byte values are RR intervals;
- bits `0x02`/`0x04`: sensor-contact information exists, but it is not used
  as a primary strain input.

RR values use Bluetooth units of `1/1024` second:

```text
rr_ms = round(raw_rr × 1000 / 1024)
```

After parsing, FRWHOOP accepts:

- HR from `20…240` BPM;
- RR intervals from `200…2500` ms.

Invalid values are omitted, not converted into zero.

The parser also has a legacy compatibility fallback for malformed multi-byte
measurements: if the parsed BPM is outside range but the flags byte itself is
in `20…240`, the flags byte can be used as a one-byte BPM. Normal
`0x2A37` packets do not rely on this path; backend normalization applies the
same physiological BPM gate again.

When custom type-40 HR is fresh, iOS treats it as canonical and does not
persist duplicate `2A37` HR rows. Standard GATT remains the fallback.

The custom type-40 path normally supplies only BPM. It calls
`applyHeartRate(bpm)` without RR intervals, so custom live rows normally have
an empty `rr_ms` array. This is sufficient for daily strain because daily
strain uses BPM and timestamps, not RR.

## 6. WHOOP vendor frame envelopes

Every complete vendor frame begins with `0xAA`. A CoreBluetooth notification is
not necessarily a complete frame: one frame may span notifications, and one
notification may contain more than one frame.

### 6.1 Harvard / WHOOP 4.0 envelope

```text
offset:  00    01       03    04                 length       length+4
         ┌─────┬────────┬─────┬──────────────────┬────────────┐
bytes:   │ AA  │ len LE │CRC8 │ inner record     │ CRC32 LE   │
         └─────┴────────┴─────┴──────────────────┴────────────┘
```

The fields are:

- byte `0`: SOF `0xAA`;
- bytes `1…2`: declared `length`, `u16 LE`;
- byte `3`: CRC8 of bytes `[1,3)`;
- bytes `4…length-1`: inner record;
- bytes `length…length+3`: CRC32 of the inner record, stored LE.

The length arithmetic is:

```text
length = inner_record_bytes + 4
total_frame_bytes = length + 4
```

Validation is:

```text
crc8(frame[1:3]) == frame[3]
crc32(frame[4:length]) == u32le(frame, length)
```

The Harvard header CRC8 uses polynomial `0x07` and initial value `0`.

### 6.2 Puffin / WHOOP 5.0 and MG envelope

```text
offset:  00  01  02       04       06       08                 declared+4
         ┌───┬───┬────────┬────────┬────────┬──────────────────┬──────────┐
bytes:   │AA │01 │decl LE │ header │ CRC16  │ inner record     │ CRC32 LE │
         └───┴───┴────────┴────────┴────────┴──────────────────┴──────────┘
```

The fields are:

- byte `0`: SOF `0xAA`;
- byte `1`: Puffin format byte `0x01`;
- bytes `2…3`: `declaredLength`, `u16 LE`;
- bytes `4…5`: header bytes, normally `00 01` for current command frames;
- bytes `6…7`: CRC16-Modbus of bytes `[0,6)`, stored LE;
- bytes `8…declaredLength+3`: inner record, including alignment padding;
- bytes `declaredLength+4…declaredLength+7`: CRC32 of the inner record, stored
  LE.

The length and validation arithmetic is:

```text
declaredLength = inner_record_bytes + 4
total_frame_bytes = declaredLength + 8
payload_end = total_frame_bytes - 4

crc16_modbus(frame[0:6]) == u16le(frame, 6)
crc32(frame[8:payload_end]) == u32le(frame, payload_end)
```

Puffin command payloads are padded to an inner-record boundary before CRC32 is
calculated. Padding is not a physiological value.

The Puffin header CRC16 uses reflected Modbus processing, polynomial `0xA001`,
and initial value `0xFFFF`.

### 6.3 CRC32 common to both families

Both families use the reflected CRC32 polynomial `0xEDB88320`, with initial and
final XOR `0xFFFFFFFF`. The CRC32 covers only the inner record, never the
envelope header and never the CRC32 bytes themselves.

A CRC failure prevents the frame from authorizing a physiological sample. The
raw bytes remain captured with a failure status for later investigation.

## 7. Fragment reassembly

### 7.1 iOS reassembly

`WhoopBleManager` maintains `rxBufs[characteristic]`, one buffer per vendor
stream characteristic. This prevents fragments from separate encrypted
channels from being interleaved.

`popFrame()`:

1. finds the next `0xAA`;
2. discards leading bytes before that SOF;
3. waits until the four-byte family header is present;
4. reads the Harvard or Puffin length;
5. rejects impossible lengths and frames above `8192` bytes;
6. waits until the declared complete frame is present;
7. removes exactly one frame;
8. lets the loop process another complete frame if one is already buffered.

After framing, `WhoopProtocol.decodeFrame()` checks exact length and CRCs before
exposing packet fields.

The iOS receive path also caps an individual reassembly buffer at `16384`
bytes. A buffer that grows beyond this limit is cleared to avoid an unbounded
stalled stream.

### 7.2 Backend reassembly and redecode

The backend implementation is `createReassembler()` in
`backend/protocol/framing.js`. It tracks:

- complete frames emitted;
- bytes skipped while resynchronizing to SOF;
- malformed/oversized length attempts;
- partial bytes discarded at reset.

The explicit replay path in `backend/redecode/redecode.js` is:

```text
Level A notify archive
  → family-aware reassembler
  → envelope verification
  → Level B complete frame
  → versioned packet decoder
```

The live `hourBuffer` archives opaque notifications as raw frame records. The
redecode path can later turn those notification records into complete verified
frames. The ordinary metrics replay in `metrics/engine.js` currently replays
normalized physiology archives; it does not silently infer BPM from an
unmapped raw optical waveform.

### 7.3 Capture-before-parse

For every related ATT notification, iOS calls
`SensorQueue.appendNotify()` before parsing. A capture row contains:

```json
{
  "schema": 1,
  "kind": "notify",
  "family": "puffin",
  "char": "FD4B0003-…",
  "hex": "aa0114…",
  "n": 47,
  "decoder": "frwhoop-whoop-ble/3"
}
```

`hex` is the complete original notification payload. It may be only a
fragment, not a reassembled frame. Optional `interp` fields are a record of
the current interpretation and are not a substitute for raw bytes.

## 8. Common packet offsets

The semantic inner record begins at:

- Harvard byte `4`;
- Puffin byte `8`.

For common realtime packets:

```text
field                    Harvard       Puffin
packet type               @4            @8
sequence/version          @5            @9
timestamp, u32 LE         @6            @10
subsecond, u16 LE         @10           @14
live HR, u8               @12           @16
RR-count hint             @13           @17
```

The byte called `sequence` is a historical layout version for type `47`; it is
not always an application sequence number.

For command packets, the opcode is at `@6` for Harvard and `@10` for Puffin.

## 9. Type-40 realtime HR decoding

The type-40 layout is:

```text
Harvard:
  type       @4 = 40
  timestamp  @6  u32 LE
  subsecond  @10 u16 LE
  HR         @12 u8
  RR count   @13 u8

Puffin:
  type       @8 = 40
  timestamp  @10 u32 LE
  subsecond  @14 u16 LE
  HR         @16 u8
  RR count   @17 u8
```

The iOS bridge checks the HR byte with the `20…240` gate, then calls
`applyHeartRate()`.

The backend generic decoder returns `rr_count_hint`, but does not fabricate RR
intervals from the count. A count says how many values may exist; it is not
itself an interval series.

One implementation detail matters for daily strain: type-40 live samples are
persisted with the phone receive time created by `SensorQueue.append()`.
Historical type-47 samples carry a strap timestamp. The scorer only sees the
normalized timestamp that survives this ingestion boundary.

## 10. Historical type-47 records relevant to strain

Historical data is important because it fills gaps in live HR and supplies
strap-timestamped samples during backfill.

### 10.1 Harvard v24

The current iOS map uses:

```text
historical version     @5      u8 = 24
sensor timestamp       @11     u32 LE, Unix seconds
heart rate             @21     u8; zero = unavailable
RR count               @22     u8; maximum 4
RR intervals           @23+2i  u16 LE milliseconds
gravity X/Y/Z          @40/44/48 f32 LE
```

The decoder accepts a nonzero HR only in `20…240`, accepts RR values only in
`200…2500` ms, and requires a valid complete gravity vector:

- each axis is within `±8 g`;
- vector magnitude is within `0.5…1.5 g`.

V24 HR can therefore become a normalized sample and contribute to daily
strain. V24 RR and gravity do not create extra strain terms.

### 10.2 Harvard v25

The current map uses:

```text
historical version     @5      u8 = 25
sensor timestamp       @11     u32 LE
gravity X/Y/Z          @73/75/77 signed i16 LE / 16384
```

This is gravity-only in the normal FRWHOOP iOS path. It does not produce a BPM
sample and therefore does not directly contribute to strain.

### 10.3 Puffin v18

The typical v18 record is a per-second core-health record. Relevant fields are:

```text
historical version     @9      u8 = 18
record index           @11     u32 LE
sensor timestamp       @15     u32 LE, Unix seconds
heart rate             @22     u8, BPM
RR count               @23     u8
RR intervals           @24+2i  u16 LE milliseconds
dynamic acceleration   @41     f32 LE, retained only in 0…8
gravity X/Y/Z          @45/49/53 f32 LE
step counter           @57     u16 LE cumulative
step cadence           @59     u8
activity class         @63     0=unclassified/unknown, 1=walk, 2=run
skin temperature       @73     u16 LE / 100 °C
sleep/on-wrist byte    @81     packed status
```

The historical sample carries optional BPM, RR, gravity, motion, steps,
activity, cadence, and temperature. The backend then applies its own
normalization gates. A value that fails a gate is absent from the normalized
projection.

The v18 BPM at `@22`, when valid, can contribute to daily strain. The activity
class at `@63` is not passed as a sport multiplier to `strainFromHr()`.

### 10.4 Puffin v20, v21, and v26

These layouts are preserved because they may contain valuable raw sensor data,
but they are not direct canonical HR inputs:

- **v20:** five bulk optical blocks; channels remain neutrally named and are not
  converted to BPM.
- **v21:** six arrays of 100 signed `i16` samples for accelerometer/gyro
  channels; gravity may support motion or sleep analysis, not daily BPM strain.
- **v26:** 24 signed `i16` PPG samples at absolute offsets `@27…@74`; this is
  raw waveform data, not an FRWHOOP BPM metric.

The safe rule is: raw PPG is not HR until a versioned decoder explicitly
defines and validates the conversion. FRWHOOP does not guess that conversion.

### 10.5 Metadata and transfer packets

Metadata type `49` and Puffin alias type `56` describe historical transfer
boundaries. They do not contribute physiological samples:

- metadata subtype `1`: transfer start;
- metadata subtype `2`: transfer end and trim cursor;
- metadata subtype `3`: transfer complete.

The phone acknowledges the end packet only after the required historical rows
were durably persisted. These packets control backfill reliability, not strain
intensity.

## 11. Normalized sample boundary

`normalizeSample()` in `ingest/archiveFormat.js` converts decoded or live
objects into the product projection. The strain-relevant fields are:

```json
{
  "t": "2026-08-27T12:00:00.000Z",
  "bpm": 160,
  "rr_ms": [],
  "src": "ble_hr",
  "family": "puffin",
  "layout": "v18",
  "decoder": "frwhoop-whoop-ble/3",
  "seq": 123
}
```

The BPM normalization rule is:

```text
20 ≤ BPM ≤ 240 → rounded integer BPM
otherwise      → null
```

Timestamps are converted to ISO UTC. RR values are rounded and filtered to
`200…2500` ms. A normalized archive row is retained when it has at least one
usable physiological signal, such as BPM, RR, gravity, steps, or temperature.

For live HR, `hourBuffer.append()` drops a row that has neither a finite BPM
nor an RR array. Historical rows are handled independently by
`historyBuffer.appendBatch()` and are retained only when their timestamp,
sequence, and supplied signal fields pass validation.

### 11.1 Historical clock correction

Backfill rows have a strap timestamp and a phone/server receive context.
`historyBuffer` applies a bounded constant offset when a strap clock is clearly
far from the receive clock. It:

- retains the original strap timestamp as `t_strap`;
- writes corrected `t` and `datetime`;
- records `clock_offset_sec`;
- prevents implausible pre-2015 WHOOP dates from becoming metric days.

The metrics engine also corrects historical timestamps during replay, then
deduplicates and sorts the resulting rows before scoring.

### 11.2 No interpolation

Missing HR samples are not filled with synthetic BPM. A gap is a gap. This is
important because strain is time-integrated: inventing high HR during a
disconnect would invent strain.

## 12. Canonical daily strain algorithm

### 12.1 Source and call path

The call path is:

```text
createMetricsEngine().persistComputed()
  → scoreDay()
      → scoreSleep() when needed
      → strainFromHr(samples, resting_HR)
```

`persistComputed()` first ensures every sample has both `t` and `datetime`
aliases when a time is available. It then sends the same normalized sample set
to the sleep/metrics scorer, archive builder, HR summary, and daily series
builder.

### 12.2 Explicit override

`scoreDay()` gives an explicit `extras.strain` value priority:

```javascript
const strain = extras.strain != null
  ? num(extras.strain)
  : strainFromHr(samples, night?.restingHr || extras.rhr)
```

If there is no explicit override, the HR algorithm runs. The final returned
field is `strain || 0`, so a day with no usable HR becomes daily strain `0`.

As currently wired, `scoreDay()` supplies the resting HR positionally but does
not supply an `extras.maxHr` value. Therefore the normal daily call uses
`strainFromHr()`'s default `maxHr = 190`. Direct callers and tests may pass a
different max HR to `strainFromHr(samples, rhr, maxHr)`.

### 12.3 Input cleanup

`strainFromHr()` performs its own HR-specific preparation:

1. read BPM from `row.bpm` or `row.heartRate`;
2. accept only `20…240`;
3. read time from `row.t`, `row.datetime`, or `row.at`;
4. discard rows with an invalid time;
5. sort by timestamp;
6. deduplicate rows with the same timestamp, retaining one row.

It does not use packet count as elapsed time.

### 12.4 Resting HR and HR reserve

The default values are:

```text
resting HR = 55 BPM
maximum HR = 190 BPM
HR reserve = max(maximum HR - resting HR, 1)
```

For each BPM sample:

```text
HRR% = (BPM - resting HR) / HR reserve × 100
```

The formula is a Karvonen-style heart-rate-reserve normalization. It is
clamped only by the piecewise weight thresholds; the implementation does not
need a separately clamped percentage because values above 100 naturally fall
into the top weight and values below zero fall into weight zero.

### 12.5 Intensity weights

The current FRWHOOP backend uses these weights:

- `HRR% >= 90`: weight `5`;
- `HRR% >= 80`: weight `4`;
- `HRR% >= 70`: weight `3`;
- `HRR% >= 60`: weight `2`;
- `HRR% >= 50`: weight `1`;
- `25 <= HRR% < 50`: weight `0.5`;
- `HRR% < 25`: weight `0`.

The `0.5` walking band is an FRWHOOP implementation choice. It allows
moderate activity below the first full Edwards zone to contribute a small
amount of cardiovascular load.

### 12.6 Duration weighting

For a sorted sample `i`, the credited duration is normally the time until the
next sample:

```text
delta_ms = timestamp[i + 1] - timestamp[i]
duration_minutes = delta_ms / 60,000
```

The implementation only credits that interval when:

- `delta_ms > 0`; and
- `delta_ms <= 600,000` (10 minutes).

If the next sample is missing or the gap is larger than 10 minutes:

- the sample before the gap contributes zero duration;
- the final sample reuses the immediately previous computed duration;
- if that previous duration was zero, the final sample also contributes zero.

This prevents one high-HR sample from receiving credit for an hour-scale
disconnect. The cap also matches the five-minute chart/live-bucket design.

### 12.7 TRIMP-like accumulation

Each sample contributes:

```text
sample_load = duration_minutes × intensity_weight
TRIMP = Σ sample_load
```

The result is a dimensionless implementation score with the behavior of a
zone-weighted TRIMP, not a claim that it is the official WHOOP internal TRIMP.

### 12.8 Logarithmic mapping to 0–21

The final map is:

```text
strain = clamp(21 × ln(TRIMP + 1) / ln(7201), 0, 21)
```

FRWHOOP rounds the result to one decimal place:

```javascript
Math.round(
  clamp(21 * Math.log(trimp + 1) / Math.log(7201), 0, 21) * 10
) / 10
```

The denominator is chosen from the Edwards ceiling:

```text
zone-5 weight × 24 hours
  = 5 × 1,440 minutes
  = 7,200 TRIMP units

7,200 + 1 = 7,201
```

Thus `TRIMP = 7200` maps to exactly `21`. The logarithm compresses large
differences in accumulated load and makes the upper end increasingly difficult
to reach.

### 12.9 Worked examples

With `resting HR = 55` and `max HR = 190`, the reserve is `135 BPM`:

```text
95 BPM:
  HRR% = (95 - 55) / 135 × 100 = 29.6%
  weight = 0.5

160 BPM:
  HRR% = (160 - 55) / 135 × 100 = 77.8%
  weight = 3

180 BPM:
  HRR% = (180 - 55) / 135 × 100 = 92.6%
  weight = 5
```

If HR is a steady `160 BPM` for one hour and samples are spaced normally:

```text
TRIMP = 60 minutes × 3 = 180
strain ≈ 21 × ln(181) / ln(7201) ≈ 12.3
```

If two otherwise identical samples are one hour apart, the gap exceeds the
10-minute cap. The first sample receives no interval credit and the second
sample reuses that zero duration, so the pair contributes zero.

## 13. How daily strain is persisted

### 13.1 Live samples

`POST /api/ble/live` receives the iOS durable queue contents. For an
authenticated user:

1. live status is updated;
2. opaque frames are handed to `hourBuffer.appendFrame()`;
3. live samples are handed to `hourBuffer.append()`;
4. samples are written to a local day file and WAL;
5. hourly batches are archived;
6. when the scoring window is eligible, `persistComputed()` rewrites the
   derived metrics.

The phone receives acknowledgements only for data that was actually accepted
and durably stored. A mid-batch failure stops the contiguous prefix
acknowledgement so an unpersisted sample cannot be deleted from the phone.

### 13.2 Historical samples

Historical `type-47` samples travel in `historySamples`:

1. `historyBuffer.appendBatch()` validates each row;
2. rows are deduplicated by sequence and device/timestamp identity;
3. large strap/server clock offsets are corrected;
4. rows are written to a sensor-time WAL;
5. rows are archived by hour to the raw physiology store;
6. affected days are recomputed after archive success.

This matters for strain because a historical HR backfill can change the
day-level TRIMP. The affected day is scored again from the complete available
sample set rather than incrementing the old strain number.

### 13.3 Raw and derived storage

The system keeps separate representations:

- **Opaque frames:** gzip-compressed NDJSON containing notification hex and
  capture lineage. These support future protocol redecoding.
- **Physiology archive:** gzip-compressed NDJSON containing normalized BPM/RR
  and other accepted signals. This is the direct metric input.
- **Derived object:** gzip-compressed JSON containing the scored daily object,
  sleep data, HR spark data, input provenance, and algorithm version.
- **Supabase `daily_metrics`:** the scalar daily row.
- **Supabase `daily_physiology_series`:** five-minute HR/movement chart data.

`persistComputed()` writes both:

```text
daily_metrics.strain_score = scored.strain
daily_metrics.effort       = scored.strain
```

The two database fields are aliases for the same current FRWHOOP daily value.

The physiological series currently stores HR buckets and leaves
`strain_series` empty. Daily strain is calculated from normalized samples, not
by summing a persisted `strain_increment` field.

### 13.4 Replay and idempotency

`recomputeFromStorage()`:

1. loads ready physiology manifests;
2. downloads and decodes the normalized archives;
3. corrects historical clock offsets;
4. deduplicates rows;
5. selects a local-calendar scoring window;
6. calls `persistComputed()` again;
7. upserts the same day keys and derived references.

Repeated replay does not add yesterday's score to today's score. It recomputes
the function of the sample set.

Raw frame archives are retained for protocol redecode. A new raw-frame decoder
does not automatically turn an unknown PPG layout into BPM or alter daily
strain until a versioned interpretation is deliberately wired into the
physiology projection.

## 14. Sleep need feedback

Strain is also used downstream by the sleep-need heuristic. This is not an
additional term in strain; it is feedback from yesterday's strain into the next
need estimate:

```text
strain_add = clamp(strainYesterday / 21 × 50, 0, 50)
debt_add   = clamp(debtMin × 0.4, 0, 90)

needMin = round(clamp(
  baselineMin + strain_add + debt_add,
  360,
  720
))
```

The default baseline is `480` minutes. The result is bounded to six through
twelve hours.

## 15. Auto-detected workout strain

### 15.1 Detection is separate from scoring

`createWorkoutDetector()` is a deterministic state machine:

```text
IDLE → POSSIBLE → LIKELY → CONFIRMED
```

It uses HR onset, sustained elevation, resting HR, optional HRmax, motion,
walking evidence, and strength-like HR pulses to decide whether a workout
exists and how it should be classified.

Motion helps detect and classify the workout. Motion is not multiplied directly
into the canonical daily `strainFromHr()` score.

### 15.2 Formula

Auto-detected workout sessions use
`estimateDetectedStrain()` in `metrics/workoutSession.js`:

```text
hrr = max((maxHr or 190) - (restingHr or 60), 1)

intensity = clamp(
  0.35 + ((avgHr - restingHr) / hrr) × 1.2,
  0.3,
  1.0
)

hrFactor = clamp((avgHr - 70) / 70, 0.4, 1.4)

raw = max(0, duration_minutes) × intensity × hrFactor

workout_strain =
  round1(21 × ln(1 + raw) / ln(181))
```

The formula returns `0` when average HR or positive duration is unavailable.
The denominator is `1 + 180`, not `7201`, because this is a compact
activity-level estimate rather than the daily time-integrated TRIMP path.

`applySessionPhysiology()` recalculates this value as an active session
accumulates. When the session ends, the workout-detection service calculates
the same estimate for the persisted workout activity.

### 15.3 No automatic daily addition

The current daily score is calculated from HR samples. The detected workout's
`strain` is a session-level `Activity Strain` value. The code does not add the
workout estimate to `scored.strain` as a second independent load.

This avoids automatically double-counting the same exercise when its HR is
already present in the day's samples. A consumer should not sum daily strain
and the activity strain field unless it is intentionally building a separate
report.

## 16. Manually logged activity strain

The backend route `/api/activities` uses a third estimator,
`estimateActivityStrain()` in `backend/index.js`.

It applies a name-based sport factor:

```text
run / hiit / box → 1.00
swim / cycl      → 0.85
walk / yoga      → 0.35
other            → 0.22
```

Then:

```text
hrFactor = avgHr
  ? clamp((avgHr - 70) / 70, 0.4, 1.4)
  : 1

raw = max(0, duration_minutes) × sport_factor × hrFactor

activity_strain =
  round1(21 × ln(1 + raw) / ln(181))
```

This estimator does not use HR reserve, resting HR, maximum HR, RR, or zone
time. It is a pragmatic activity-entry estimate and is not the canonical
daily algorithm.

The frontend has a matching `estimateActivityStrain()` in
`frontend/src/lib/whoopMetrics.js`. The live activity screen can use it
before a backend activity row exists. The backend remains the persistence
authority for `/api/activities`.

## 17. Frontend strain values and visualizations

### 17.1 Canonical daily value

The backend snapshot maps:

```text
Day Strain = row.strain_score ?? row.effort
```

The Overview tile formats it as a one-decimal value with `/21`.

### 17.2 `instantStrain()`

The frontend helper `instantStrain(hr, rhr)` is a display-only estimate:

```text
excess = max(0, HR - RHR)
instant = round1(21 × ln(1 + excess) / ln(111))
```

It is useful for painting a current HR marker. It is not the backend daily
TRIMP result and does not account for duration.

### 17.3 `strainCurve()`

The Overview curve buckets the day's HR rows into ten-minute buckets. For each
bucket with data it blends the average and maximum HR:

```text
blend = (bucket_average_HR + bucket_max_HR) / 2
span = max(max_HR - resting_HR, 40)
fraction = clamp((blend - resting_HR) / span, 0, 1)

point = 21 × fraction^1.8
```

This lets a short intense period make a visible peak while quiet periods stay
near zero. It is a visualization heuristic, not the daily scorer.

### 17.4 `cumulativeStrain()`

The frontend first sums the display curve's raw points, then scales the curve
so its final value matches the canonical daily total:

```text
scale = daily_strain / sum(display_curve_points)
cumulative_point = running_sum(display_curve_points) × scale
```

This makes the chart end at the persisted daily number without pretending that
the display curve itself is the algorithm that produced that number.

### 17.5 Bands and target

`strainBand()` uses the 0–21 axis:

- below `6`: light;
- `6…<10`: moderate;
- `10…<14`: strenuous;
- `14…<18`: high;
- `18…21`: all out.

`strainState()` turns those bands into labels such as `LIGHT`,
`MODERATE`, `HIGH STRAIN`, and `ALL OUT`.

`suggestedDayStrain(recovery)` is a recovery-dependent target suggestion. It
is not measured strain and should not be used to reverse-engineer the daily
score.

### 17.6 The 0–24 visual track

`Overview.jsx` renders the range bar on a visual `0…24` track while the value
itself is the FRWHOOP `0…21` score and is labelled `/21`. The extra visual
headroom is presentation space; it does not change the backend maximum.

## 18. Error handling and data integrity

### 18.1 Transport and frame errors

The system distinguishes:

- malformed or too-short frame;
- impossible declared length;
- partial frame at disconnect/end of replay;
- header CRC failure;
- payload CRC32 failure;
- valid but unknown packet type;
- valid packet with unknown layout/version;
- structurally decoded but incomplete record.

An invalid frame is not allowed to produce a high-confidence physiological
sample. The raw notification and frame hash remain available in the capture
archive.

### 18.2 Physiological errors

The normalization boundary rejects or nulls:

- BPM outside `20…240`;
- RR outside `200…2500` ms;
- invalid timestamps;
- malformed RR counts;
- impossible gravity vectors;
- invalid cumulative/step values;
- invalid skin temperature.

Null means “not available for this calculation.” It does not mean zero
physiological activity.

### 18.3 Duplicates and gaps

Deduplication occurs at multiple boundaries:

- iOS suppresses duplicate standard-GATT HR while custom type-40 is active;
- iOS suppresses same-BPM persistence within a one-second race window;
- live rows use device-scoped sequence/timestamp watermarks;
- historical rows use sequence and device/timestamp identity;
- daily strain deduplicates equal timestamps before integration;
- replay deduplicates normalized rows before recomputation.

The scorer integrates elapsed time, not packet count. A duplicate burst cannot
multiply strain, and a long disconnect cannot silently become high-intensity
duration.

### 18.4 Empty and insufficient data

Current FRWHOOP backend behavior is:

```text
no valid HR rows → strainFromHr() returns 0
scoreDay()        → returns strain 0
```

This is different from the NOOP native scorer described below, which can return
`nil` under its data-sufficiency gate. The FRWHOOP Node backend currently uses
zero for an unscored/empty daily HR projection and does not expose a separate
daily strain confidence object from `scoreDay()`.

## 19. FRWHOOP versus the NOOP reference scorer

The `noop` tree is a protocol and analytics reference, not the source of the
FRWHOOP production value in this document.

`noop/Packages/StrandAnalytics/Sources/StrandAnalytics/StrainScorer.swift`
implements a related but distinct scorer:

- Edwards zone-weighted TRIMP by default;
- optional Banister exponential TRIMP;
- per-sample duration inferred from each timestamp gap;
- two-minute gap cap;
- minimum dense/sparse data gates;
- Tanaka HRmax when a profile age is available;
- output rescaled to `0…100` for NOOP's Charge/Effort/Rest redesign.

The NOOP scorer preserves `D = 7201`, but multiplies the logarithmic result by
`100` instead of `21`. Its code comments explicitly describe the historical
`0…21` axis and the later `0…100` output scale.

The current FRWHOOP backend is different:

- `backend/metrics/sleep.js`;
- output `0…21`;
- default RHR `55`, default max HR `190`;
- ten-minute duration gap cap;
- a `0.5` weight for `25…<50% HRR`;
- no NOOP-style minimum reading gate in `strainFromHr()`;
- daily `scoreDay()` call does not pass a max-HR override.

Therefore a NOOP `Effort = 44.3` and an FRWHOOP `Strain = 9.3` are not values
that can be compared as if they share an axis. The two implementations may
share open-method concepts, but they are different products and different
output contracts.

### HRmax estimation in the reference implementation

The NOOP scorer contains a personalized HRmax helper, but the normal FRWHOOP
Node daily call does not invoke it. FRWHOOP's current daily default is the
explicit `maxHr = 190` in `strainFromHr()`. The auto-detected workout estimator
also defaults to `190` when its session has no max-HR value.

For completeness, the NOOP helper selects HRmax as follows:

```text
Tanaka(age) = 208 − 0.7 × age

if at least 600 HR samples exist:
  observed = interpolated 99.5th percentile of the sorted HR history
  if Tanaka exists:
    HRmax = max(observed, Tanaka)
  else:
    HRmax = observed

if fewer than 600 samples:
  HRmax = Tanaka(age), when age exists
  otherwise HRmax is unknown
```

The helper labels the source as `observed`, `tanaka`, or `unknown`. The same
file also exposes classic `220 − age` as a last-resort default; with its
default age of 30, that produces `190`. FRWHOOP's Node implementation currently
uses the numeric default directly rather than dynamically selecting among these
sources.

## 20. Verification cases

The backend tests pin the most important strain invariants:

- `backend/tests/metrics.sleep.test.js`
  - integrates elapsed time rather than packet count;
  - gives duplicate timestamp rows the same result as the original series;
  - gives a one-hour gap no duration credit;
  - lets five-minute walking samples contribute nonzero strain.
- `backend/tests/workoutSession.test.js`
  - verifies that detected workout estimates are positive for valid sessions.
- `noop/Packages/StrandAnalytics/Tests/StrandAnalyticsTests/StrainScorerTests.swift`
  - tests the distinct NOOP scorer and its 0–100 contract.

Useful properties to preserve when changing the implementation:

1. More time at the same HR must not lower strain.
2. Higher HR at the same duration must not lower strain.
3. Duplicating a timestamp must not add time.
4. A gap above the duration cap must not receive invented credit.
5. An invalid BPM must not become a low or high physiological value.
6. A CRC-invalid frame must not create a scored HR sample.
7. Replaying the same archive must rewrite the same daily result, not add to it.
8. A raw PPG/IMU waveform must remain raw until a validated BPM decoder exists.

## 21. Source map

For the complete protocol and non-strain physiology reference, see
`backend/docs/FRWHOOP_PACKET_DECODING_AND_METRICS.md` and
`backend/docs/PACKET_DECODING_AND_SLEEP.md`.

Strain-specific source map:

- `backend/metrics/sleep.js`
  - `strainFromHr()`
  - `scoreDay()`
  - `sleepNeedMin()`
  - `ALGORITHM_VERSION`
- `backend/metrics/engine.js`
  - `persistComputed()`
  - `archiveRawSamples()`
  - `archiveRawFrames()`
  - `recomputeFromStorage()`
  - `dailyRow.strain_score` and `dailyRow.effort`
- `backend/metrics/workoutSession.js`
  - `estimateDetectedStrain()`
  - `applySessionPhysiology()`
- `backend/metrics/workoutDetector.js`
  - workout onset, confirmation, sport classification, and thresholds
- `backend/index.js`
  - manual `estimateActivityStrain()`
  - `/api/activities`
- `backend/ingest/archiveFormat.js`
  - `normalizeSample()`
  - BPM/RR validity gates
- `backend/protocol/framing.js`
  - Harvard/Puffin envelope verification
  - CRC checks
  - fragment reassembly
- `backend/protocol/decoder.js`
  - packet registry and versioned dispatch
- `backend/protocol/whoop5.js`
  - Puffin v18/v20/v21/v26 maps
- `backend/redecode/redecode.js`
  - raw-notification replay and lineage
- `frontend/ios/App/App/WhoopProtocol.swift`
  - iOS CRCs, frame validation, type-40 and historical maps
- `frontend/ios/App/App/WhoopBlePlugin.swift`
  - custom/GATT HR priority and live routing
- `frontend/ios/App/App/SensorQueue.swift`
  - durable live, historical, and raw-frame queues
- `frontend/src/features/overview/overviewModel.js`
  - `instantStrain()`, `strainCurve()`, `cumulativeStrain()`
- `frontend/src/lib/whoopMetrics.js`
  - `STRAIN_MAX`, bands, labels, target suggestion, manual activity estimate
- `frontend/src/features/overview/Overview.jsx`
- `/21` tile and 0–24 visual range bar
