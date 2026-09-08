# FRWHOOP packet, byte, and physiology decoding

**Status:** implementation-aligned reference
**Scope:** `whoop/backend` plus the FRWHOOP iOS connector in `frontend/ios`
**Last reviewed:** 2026-08-26

This document describes how FRWHOOP receives WHOOP BLE data, validates and
decodes packets, turns decoded bytes into normalized samples, and calculates:

- live heart rate (HR);
- daily average and maximum HR;
- resting heart rate (RHR);
- the 24-hour HR curve;
- daily steps.

The production path is FRWHOOP. The NOOP protocol package is used as a
reverse-engineering reference for byte maps, but NOOP UI and analytics are not
the source of the FRWHOOP values described here.

## 1. Important conventions

### 1.1 Offset notation

All byte offsets in this document are **absolute offsets from the beginning of
the complete BLE frame**, not offsets from the payload after the envelope.

Ranges use half-open notation:

```text
[start, end) = start is included, end is excluded
```

Examples:

- `u16 LE @57` reads bytes 57 and 58;
- `i16 LE @28` reads bytes 28 and 29 as a signed two's-complement integer;
- `f32 LE @45` reads bytes 45–48 as an IEEE-754 little-endian float;
- a CRC32 at `[length, length + 4)` is not part of the decoded sensor payload.

WHOOP multi-byte numeric fields are little-endian unless explicitly stated
otherwise. Every decoder is bounds-safe: a field that is not fully present is
treated as unavailable rather than read past the frame.

### 1.2 Family names

| FRWHOOP family | Hardware | BLE family indicator | Envelope |
|---|---|---|---|
| `harvard` | WHOOP 4.0 | `6108…` service/characteristic family | WHOOP 4 / Harvard |
| `puffin` | WHOOP 5.0 / MG / Maverick | `FD4B…` service/characteristic family | WHOOP 5 / Puffin |
| `gatt` | Standard Bluetooth profile | `180D/2A37`, `180F/2A19`, etc. | No WHOOP frame envelope |

WHOOP 5.0 and MG use the Puffin/Maverick protocol family. They must not be
decoded by simply applying Harvard offsets plus an assumed shift; the framing,
length field, and header CRC are different.

### 1.3 Validity gates

FRWHOOP preserves raw evidence even when a value is invalid, but invalid
values do not enter the physiology projection or metric calculations.

| Signal | FRWHOOP gate |
|---|---|
| Heart rate | integer BPM in `20…240` |
| R-R interval | integer milliseconds in `200…2500` |
| Complete gravity vector | each axis within `±8 g`, magnitude in `0.5…1.5 g` |
| Per-second step delta | `0…20` steps per second |
| WHOOP 5 cumulative counter | non-negative raw `u16`; rollover handled later |
| Skin temperature | normalized °C, normally `20…45` in the backend archive |

A failed gate means “missing/unusable for this calculation,” not zero.

## 2. End-to-end FRWHOOP data path

```text
WHOOP strap
   │ BLE ATT notifications / GATT 2A37
   ▼
iOS WhoopBleManager
   ├─ identify Harvard/Puffin/GATT characteristic
   ├─ archive every raw notify before parsing
   ├─ reassemble fragments per stream characteristic
   ├─ validate the family-specific envelope and CRCs
   ├─ decode live HR, historical records, metadata, and motion
   └─ append durable SensorQueue rows
          │
          ├─ live samples → POST /api/ble/live → hourBuffer
          ├─ historical samples → POST /api/ble/live → historyBuffer
          └─ opaque frames → frame archive for replay/redecode
                         │
                         ▼
                  normalizeSample()
                         │
                         ├─ B2 physiology projection
                         ├─ daily_physiology_series
                         └─ metrics engine
                              ├─ sleep/RHR/HRV/respiration
                              ├─ average/max HR
                              └─ steps
                                   │
                                   ▼
                         Supabase daily_metrics
                                   │
                                   ▼
                         API snapshot/range → Overview
```

The main implementation points are:

- iOS framing and historical decoding:
  [`WhoopProtocol.swift`](../../frontend/ios/App/App/WhoopProtocol.swift)
- iOS BLE routing and live HR:
  [`WhoopBlePlugin.swift`](../../frontend/ios/App/App/WhoopBlePlugin.swift)
- iOS durable queues:
  [`SensorQueue.swift`](../../frontend/ios/App/App/SensorQueue.swift)
- backend frame validation/reassembly:
  [`framing.js`](../protocol/framing.js)
- backend packet dispatch:
  [`decoder.js`](../protocol/decoder.js)
- WHOOP 5 deep layout decoder:
  [`whoop5.js`](../protocol/whoop5.js)
- sample normalization and archives:
  [`archiveFormat.js`](../ingest/archiveFormat.js)
- metric orchestration:
  [`engine.js`](../metrics/engine.js)

### 2.1 Two separate archive layers

FRWHOOP deliberately keeps two representations:

1. **Frame capture:** opaque ATT notifications stored as lowercase hex. This is
   the re-decode source and preserves bytes that the current decoder does not
   understand.
2. **Physiology projection:** normalized rows containing fields such as `bpm`,
   `rr_ms`, gravity, `steps`, and `step_cumulative`. Product metrics read this
   projection.

An interpreted sidecar field such as `interp.bpm` is not a replacement for the
raw frame. A future decoder must be able to reinterpret the original bytes.

## 3. BLE characteristics and family selection

The iOS connector subscribes to the standard profiles and WHOOP-specific
streams in [`WhoopBlePlugin.swift`](../../frontend/ios/App/App/WhoopBlePlugin.swift).

| Characteristic/service family | Use |
|---|---|
| `61080001…` / `61080002…` | WHOOP 4 Harvard service and command channel |
| `FD4B0001…` / `FD4B0002…` | WHOOP 5/MG Puffin service and command channel |
| `FD4B0003…`, `FD4B0004…`, `FD4B0005…`, `FD4B0007…` | Puffin encrypted data streams |
| `61080003…`, `61080004…`, `61080005…` | Harvard encrypted data streams |
| `180D/2A37` | Standard Bluetooth Heart Rate Measurement |
| `180F/2A19` | Standard battery percentage |
| `180A/2A26` | Firmware revision |
| `180A/2A24` | Model number |

The capture layer records the characteristic UUID and a family value of
`harvard`, `puffin`, or `gatt`. The family is required when the backend
redecodes a WHOOP frame.

## 4. WHOOP frame envelopes

The shared start-of-frame marker is `0xAA`. A BLE notification is not
necessarily a complete frame; a frame can span several notifications and a
notification can contain more than one frame.

### 4.1 WHOOP 4.0 / Harvard envelope

```text
offset:  00    01       03    04                 length       length+4
         ┌─────┬────────┬─────┬──────────────────┬────────────┐
bytes:   │ AA  │ len LE │CRC8 │ inner record     │ CRC32 LE   │
         └─────┴────────┴─────┴──────────────────┴────────────┘
```

| Offset | Size | Meaning |
|---|---:|---|
| `0` | 1 | SOF, always `0xAA` |
| `1…2` | 2 | `length`, unsigned little-endian |
| `3` | 1 | CRC8 of bytes `[1, 3)` |
| `4…length-1` | `length-4` | Inner packet: type, sequence/version, and packet payload |
| `length…length+3` | 4 | CRC32, little-endian |

The Harvard length has this meaning:

```text
length = inner_record_bytes + 4 CRC32 bytes
total_frame_bytes = length + 4 envelope bytes before/around the inner record
```

The CRC32 input is the inner record only:

```text
crc32(frame[4:length]) == u32le(frame, length)
```

The smallest command frame has three inner header bytes
`[type, sequence, command]` plus the four-byte CRC32, so a valid declared
length is at least 7.

### 4.2 WHOOP 5.0 / MG / Puffin envelope

```text
offset:  00  01  02       04       06       08                 declared+4
         ┌───┬───┬────────┬────────┬────────┬──────────────────┬──────────┐
bytes:   │AA │01 │decl LE │ header │ CRC16  │ inner record     │ CRC32 LE │
         └───┴───┴────────┴────────┴────────┴──────────────────┴──────────┘
```

| Offset | Size | Meaning |
|---|---:|---|
| `0` | 1 | SOF, `0xAA` |
| `1` | 1 | Puffin format byte, currently `0x01` |
| `2…3` | 2 | `declaredLength`, unsigned little-endian |
| `4…5` | 2 | Header bytes; current command frames use `00 01` |
| `6…7` | 2 | CRC16-Modbus, little-endian |
| `8…declaredLength+3` | `declaredLength-4` | Inner record, including any alignment padding |
| `declaredLength+4…declaredLength+7` | 4 | CRC32, little-endian |

Puffin length and checksum calculations are:

```text
declaredLength = inner_record_bytes + 4 CRC32 bytes
total_frame_bytes = declaredLength + 8
crc16(frame[0:6]) == u16le(frame, 6)
crc32(frame[8:declaredLength+4]) == u32le(frame, declaredLength+4)
```

Puffin command payloads are padded to a four-byte boundary before the CRC32 is
calculated. Historical records use the same envelope but have layout-specific
payloads.

### 4.3 CRC algorithms

The implementations are in [`crc.js`](../protocol/crc.js) and are mirrored in
[`WhoopProtocol.swift`](../../frontend/ios/App/App/WhoopProtocol.swift).

| Checksum | Used by | Parameters | Covered bytes |
|---|---|---|---|
| CRC8 | Harvard header | polynomial `0x07`, initial `0` | Harvard `[1,3)` |
| CRC16-Modbus | Puffin header | polynomial `0xA001`, initial `0xFFFF` | Puffin `[0,6)` |
| CRC32/zlib | Both payloads | reflected polynomial `0xEDB88320`, initial/final XOR `0xFFFFFFFF` | Inner record only |

CRC16 and CRC32 are written low byte first. A CRC failure never authorizes a
physiological value: the frame is retained with `decode_status: "crc_failed"`
and its raw bytes/hash remain available for investigation.

## 5. Fragment reassembly and validation

### 5.1 iOS receive loop

`WhoopBleManager` maintains one receive buffer per WHOOP stream
characteristic. This is required because fragments from two characteristics
must not be interleaved.

`popFrame()` performs the following:

1. discard bytes before the next `0xAA` SOF;
2. wait until at least four header bytes are available;
3. read the family-specific declared length;
4. reject a corrupt length or any frame over 8192 bytes;
5. wait until the whole declared frame is present;
6. remove exactly one complete frame from the buffer;
7. pass it to `WhoopProtocol.decodeFrame()`.

`decodeFrame()` then requires the complete frame length and both applicable CRC
checks to be valid before exposing packet fields.

### 5.2 Backend reassembly

The backend equivalent is `createReassembler()` in
[`framing.js`](../protocol/framing.js). It returns complete frames plus
accounting for:

- bytes skipped while resynchronizing to SOF;
- malformed SOFs whose declared length exceeds the maximum;
- partial bytes discarded at disconnect/reset.

Those bytes are not silently lost. The iOS raw notify archive is written before
the frame is parsed, and the backend capture archive remains the evidence
source.

### 5.3 Capture-before-parse rule

For each relevant ATT notification, iOS calls `SensorQueue.appendNotify()`
before it attempts to parse the frame. A capture row contains fields like:

```json
{
  "schema": 1,
  "kind": "notify",
  "family": "puffin",
  "char": "FD4B0003-7185-4667-B7A6-36C427CBA76A",
  "hex": "aa0114…",
  "n": 47,
  "decoder": "frwhoop-whoop-ble/3"
}
```

The `hex` value is the original ATT payload, not necessarily a reassembled
frame. Reassembly is performed later by the decoder.

## 6. Packet types and common header offsets

### 6.1 Packet registry

The authoritative FRWHOOP registry is `PACKET_TYPES` in
[`decoder.js`](../protocol/decoder.js).

| Type | Name | Role in FRWHOOP |
|---:|---|---|
| 35 | `COMMAND` | Command request used by the Harvard path and by the current Puffin frame builder; opcode follows type/sequence |
| 36 | `COMMAND_RESPONSE` | Command result and response payload |
| 37 | `PUFFIN_COMMAND` | Puffin command request alias |
| 38 | `PUFFIN_COMMAND_RESPONSE` | Puffin command response alias |
| 40 | `REALTIME_DATA` | Live timestamp, HR, and an RR-count hint |
| 43 | `REALTIME_RAW_DATA` | Variable-size raw IMU or optical stream |
| 47 | `HISTORICAL_DATA` | Historical record; layout is selected by version |
| 48 | `EVENT` | Strap event, including battery events |
| 49 | `METADATA` | Historical transfer start/end/complete bookkeeping |
| 50 | `CONSOLE_LOGS` | Strap diagnostic text |
| 51 | `REALTIME_IMU_DATA_STREAM` | IMU stream classification |
| 52 | `HISTORICAL_IMU_DATA_STREAM` | Historical sensor body; Puffin layouts can use the type-47 decoder |
| 53 | `RELATIVE_PUFFIN_EVENTS` | Relative event stream classification |
| 54 | `PUFFIN_EVENTS_FROM_STRAP` | Strap event stream classification |
| 55 | `RELATIVE_BATTERY_PACK_CONSOLE_LOGS` | Battery-pack log classification |
| 56 | `PUFFIN_METADATA` | Puffin metadata alias |

Unknown packet types remain in the frame archive with their packet type and raw
bytes. They are not converted into guessed physiology.

### 6.2 Shared offsets for realtime packets

These are the common offsets used by the backend `familyOffsets()` helper:

| Field | Harvard | Puffin | Type |
|---|---:|---:|---|
| Packet type | `@4` | `@8` | `u8` |
| Sequence / version | `@5` | `@9` | `u8` |
| Realtime timestamp | `@6` | `@10` | `u32 LE` |
| Realtime subsecond field | `@10` | `@14` | `u16 LE` |
| Live HR | `@12` | `@16` | `u8`, BPM |
| RR-count hint | `@13` | `@17` | `u8` |

The sequence byte is not always a sequence in the application sense. For
`HISTORICAL_DATA` type 47, it is the historical layout version:

```text
Harvard type 47: hist_version = frame[5]
Puffin type 47:  hist_version = frame[9]
```

For command packets, the command opcode is at `@6` for Harvard and `@10` for
Puffin.

### 6.3 Type 40 realtime HR

The production custom WHOOP live stream is packet type 40:

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

The iOS live bridge currently uses the HR byte and applies the `20…240` gate.
The backend JS decoder returns the RR count as `rr_count_hint`; it does not
invent RR intervals from a count alone. The iOS type-40 path calls
`applyHeartRate(bpm)` without RR values, so type-40 live rows normally have an
empty `rr_ms` array unless RR arrives through another source.

### 6.4 Type 43 raw stream layouts

Type 43 is a raw/research stream, not the normal production HR source.
FRWHOOP's backend structural decoder recognizes the following observed
variants.

#### Harvard raw IMU variant (`dataLen = 1917`)

| Field | Offset | Representation |
|---|---:|---|
| HR hint | `@21` | `u8` |
| RR count | `@22` | `u8` |
| RR values | `@23` | up to four `u16 LE` values |
| Accel X/Y/Z | `@89`, `@289`, `@489` | 100 `i16` samples per axis |
| Gyro X/Y/Z | `@692`, `@892`, `@1092` | 100 `i16` samples per axis |
| Unmapped tail | `@1292` to CRC32 | preserved raw |

The backend records scale metadata of `1/4096 g` for accelerometer samples and
`2000/32768 dps` for gyroscope samples.

#### Harvard raw optical variant (`dataLen = 1921`)

| Field | Offset | Representation |
|---|---:|---|
| Optical configuration | `[15,42)` | raw configuration header |
| Optical samples | `@42`, stride 4 | 419 signed 24-bit samples |
| Auxiliary byte | sample offset +3 | raw auxiliary channel |
| Sample rate | — | approximately 437 Hz |

Signed 24-bit values are sign-extended from bit 23.

#### Puffin raw hypothesis

The observed Puffin structural decoder applies the additional four-byte
envelope offset:

| Variant | Fields |
|---|---|
| IMU | HR `@25`, RR count `@26`, RR `@27`, axes at `@93/@293/@493` and `@696/@896/@1096` |
| Optical | configuration `[19,46)`, signed 24-bit samples at `@46`, stride 4 |

The Puffin raw stream is structurally decoded with medium confidence because
the production path does not rely on a fixed Harvard length key for it.

The iOS connector only extracts a motion magnitude from type 43:

```text
magnitude = sqrt(x² + y² + z²)
```

where `x/y/z` are signed milli-g values at Harvard `@12` or Puffin `@16`,
depending on the envelope. Type-40 HR and type-43 motion are separate fields.

## 7. Historical type-47 decoding

Historical records are the main source for steps and historical HR. A type-47
record is selected by its family and `hist_version`; the version is not a
generic firmware version.

### 7.1 High-level implementation coverage

| Family/layout | iOS `HistoricalSample` | Backend JS redecode | Product use |
|---|---|---|---|
| Harvard v24 | HR, RR, gravity | header/version only in generic Harvard branch | historical HR, sleep, RHR |
| Harvard v25 | gravity only | header/version only in generic Harvard branch | gravity/sleep support; no HR from current map |
| Puffin v18 | HR, RR, gravity, dynamic acceleration, steps, skin temp, activity/cadence | deep field map | historical HR, sleep, RHR, steps |
| Puffin v20 | raw-only in current iOS path | five optical blocks decoded | raw optical archive/redecode; no daily HR/steps |
| Puffin v21 | gravity summary from six-axis buffer | six raw channels decoded | gravity/sleep support |
| Puffin v26 | raw-only in current iOS path | 24 signed PPG samples decoded | raw waveform archive; not a production BPM metric |
| Other versions | raw frame retained | `mapped: false`, raw retained | future decoder discovery |

The iOS path is the source of structured history rows uploaded during a normal
phone sync. The backend deep decoder can additionally reinterpret raw captured
Puffin v20/v26 frames during replay/redecode.

### 7.2 Harvard v24: HR/RR/gravity record

Offsets are current iOS frame-absolute offsets:

| Field | Offset | Decode |
|---|---:|---|
| Historical version | `@5` | `u8 = 24` |
| Sensor timestamp | `@11` | `u32 LE`, Unix seconds |
| HR | `@21` | `u8`; zero means unavailable, nonzero must be `20…240` |
| RR count | `@22` | `u8`, maximum 4 |
| RR values | `@23 + 2i` | `u16 LE` milliseconds, each `200…2500` |
| Gravity X/Y/Z | `@40`, `@44`, `@48` | `f32 LE`, validated as a complete ~1 g vector |

The iOS decoder requires a valid timestamp and gravity vector. Invalid
nonzero HR or malformed/out-of-range RR data prevents those values from being
used. Raw bytes remain in the frame capture.

### 7.3 Harvard v25: gravity record

| Field | Offset | Decode |
|---|---:|---|
| Historical version | `@5` | `u8 = 25` |
| Sensor timestamp | `@11` | `u32 LE`, Unix seconds |
| Gravity X/Y/Z | `@73`, `@75`, `@77` | signed `i16 LE` divided by `16384` |

The current FRWHOOP iOS map treats v25 as gravity-only. The bytes between the
timestamp and gravity are not promoted to HR or PPG-derived HR in the normal
metric path. Consequently, a v25 record by itself does not contribute a BPM
sample.

### 7.4 Puffin v18: per-second core-health record

The typical v18 record is a 124-byte Puffin frame. Offsets below are absolute
frame offsets and are the map implemented in
[`whoop5.js`](../protocol/whoop5.js).

| Field | Offset | Representation / interpretation |
|---|---:|---|
| Historical version | `@9` | `u8 = 18` |
| Record index | `@11` | `u32 LE` |
| Sensor timestamp | `@15` | `u32 LE`, Unix seconds |
| Heart rate | `@22` | `u8`, BPM; backend extracts raw, normalization gates it |
| RR count | `@23` | `u8`; at most four intervals are read |
| RR intervals | `@24 + 2i` | `u16 LE` milliseconds |
| Cardiac flags | `@33` | raw `u8` |
| HR quality flags | `@36` | raw `u8` |
| Alternate HR | `@37` | raw `u8` |
| Packed RR | `@38` | raw `u16 LE` |
| Cardiac status | `@40` | raw `u8` |
| Dynamic acceleration | `@41` | `f32 LE`, kept only in `0…8` |
| Gravity X/Y/Z | `@45`, `@49`, `@53` | `f32 LE`, complete vector required by archive gate |
| Step motion counter | `@57` | cumulative `u16 LE`; this is the step input |
| Step cadence | `@59` | raw `u8` cadence-like value |
| Wear/activity byte | `@63` | `0=unclassified/unknown`, `1=walk`, `2=run`; other values invalid |
| Auxiliary temperature 1 | `@69` | signed `i16 LE`; raw scale `/10` for instrumentation |
| Auxiliary temperature 2 | `@71` | signed `i16 LE`; raw scale `/10` for instrumentation |
| Skin temperature raw | `@73` | `u16 LE`; °C is `raw/100`, gated `5…45` in the iOS decoder |
| Status word 0 | `@75` | raw `u16 LE` |
| Status word 1 | `@77` | raw `u16 LE` |
| Status word 2 | `@79` | raw `u16 LE` |
| Sleep/on-wrist byte | `@81` | high nibble sleep state, low bits on-wrist/wake quality |
| Auxiliary byte 82 | `@82` | raw; `70…100` candidate is instrumentation only |
| Optical baseline A/B | `@106`, `@107` | raw `u8` instrumentation |
| Optical amplitude A/B | `@108`, `@109` | raw `u8` instrumentation |
| Unidentified float | `@113` | raw `f32 LE` instrumentation |

The iOS `HistoricalSample` carries these v18 product fields:

```text
bpm              ← @22
rrMs             ← @23 / @24…
gx/gy/gz         ← @45 / @49 / @53
stepCounter      ← @57, unchanged as UInt16
stepCadence      ← @59
activityClass    ← @63, only 0/1/2
skinTempC        ← @73, raw/100 and range-gated
```

The iOS decoder intentionally sends the cumulative counter unchanged. It does
not calculate a delta and it does not sum the counter. The backend owns
rollover handling and aggregation.

`@63` has two names in the reverse-engineered material (`activity_class` and a
wear-quality interpretation). FRWHOOP only uses the known enum values for
`activity_class`; it does not claim more semantics than the observed
`0/1/2` mapping.

### 7.5 Puffin v20: five optical blocks

The backend `decodeV2021(buf, 20)` treats a typical v20 body as 2140 bytes:

```text
blockCount       = 5
blockStart       = 26
blockLength      = 422
headerLength     = 21
channelSlot      = 200 bytes
channelCapacity  = 50 samples
```

For block `b` in `0…4`:

```text
blockStart_b = 26 + b * 422
sampleCount  = u8(blockStart_b)
header       = frame[blockStart_b : blockStart_b + 21]
channel 0    = i32 LE at blockStart_b + 21, stride 4
channel 1    = i32 LE at blockStart_b + 221, stride 4
```

The backend stores these neutrally as
`channel_b{block}_{slot}`. It does not assign wavelengths or medical names to
the channels. The current iOS historical decoder leaves v20 raw-only, so a
normal sync must retain the frame capture for the backend redecode path.

### 7.6 Puffin v21: six-axis IMU buffer

The typical v21 body is 1244 bytes. The backend preserves six arrays of 100
signed little-endian 16-bit values:

| Channel | Start offset | Samples |
|---|---:|---:|
| `accel_x` | `@28` | 100, stride 2 |
| `accel_y` | `@228` | 100, stride 2 |
| `accel_z` | `@428` | 100, stride 2 |
| `gyro_x` | `@640` | 100, stride 2 |
| `gyro_y` | `@840` | 100, stride 2 |
| `gyro_z` | `@1040` | 100, stride 2 |

The iOS decoder computes a gravity summary from the three accelerometer
channels:

```text
mean_axis_g = mean(100 signed i16 samples) / 4096
```

It then applies the complete-vector gate. The backend redecode preserves the
raw arrays; the normal sleep path consumes the validated gravity projection,
not the gyroscope arrays.

### 7.7 Puffin v26: raw optical waveform

The backend map is:

| Field | Offset | Decode |
|---|---:|---|
| Historical version | `@9` | `u8 = 26` |
| Record index | `@11` | `u32 LE` |
| Sensor timestamp | `@15` | `u32 LE`, Unix seconds |
| Burst index | `@21` | raw `u8` when nonzero |
| PPG waveform | `@27` | 24 signed `i16 LE` samples, stride 2, through `@74` |
| Sample count | — | 24 |

The waveform is preserved as `ppg_waveform`. It is not converted to BPM by
FRWHOOP's ordinary `persistComputed()` metric path. A PPG waveform must not be
treated as an already-decoded heart-rate value.

### 7.8 Historical metadata and transfer boundaries

Metadata controls when it is safe to acknowledge and trim historical data.

| Field | Harvard | Puffin |
|---|---:|---:|
| Packet type | `@4` | `@8` |
| Metadata type | `@6` | `@10` |
| Metadata type 1 | start | start |
| Metadata type 2 | end | end |
| Metadata type 3 | complete | complete |
| End Unix timestamp | `@7` | `@11` |
| Trim cursor | `@17` | `@21` |
| Eight-byte end data | `@17…24` | `@21…28` |

Puffin type 56 uses the Puffin metadata offsets as an alias for type 49.

On iOS:

1. a start marker opens a history cycle;
2. historical samples are appended to the durable history NDJSON queue;
3. an end marker is acknowledged only when persistence has not stalled;
4. a complete marker causes the host upload/recompute cycle to finish.

The history command is opcode 22 (`sendHistoricalData`). The history result
acknowledgement is opcode 23 with `[success=1] + endData`.

## 8. Normalized sample contract

`normalizeSample()` in [`archiveFormat.js`](../ingest/archiveFormat.js) is the
boundary between decoded input and backend metrics.

### 8.1 Timestamp selection

The canonical time field is `t`, but incoming rows may use:

```text
t → datetime → at → nowIso
```

The normalized timestamp is ISO-8601 UTC. Historical rows initially use the
strap's sensor timestamp. `historyBuffer` may apply a constant clock
correction when the strap clock is materially different from receive time.

### 8.2 HR and RR normalization

```text
bpm_input = bpm ?? heartRate ?? heart_rate
bpm       = round(bpm_input) if 20 <= bpm_input <= 240, else null

rr_input  = rr_ms or rrIntervals
rr_ms     = round(each value in rr_input)
            keeping only 200 <= value <= 2500
```

Rows are retained when they contain HR/RR, a valid complete gravity vector, a
step signal, or skin temperature. A row without any usable signal is not
entered into the physiology archive.

### 8.3 Core-health fields

| Input field | Normalized field | Meaning |
|---|---|---|
| `steps` | `steps` | explicit per-second delta |
| `step_cumulative`, `stepCounter`, `step_motion_counter` | `step_cumulative` | raw cumulative counter |
| `step_cadence` | `step_cadence` | raw cadence-like byte |
| `activity_class` / `activityClass` | `activity_class` | 0 unclassified, 1 walk, 2 run |
| `skin_temp_c` / `skinTempC` | `skin_temp_c` | degrees Celsius |

`steps` is range-gated to `0…20` and rounded. The cumulative counter is kept
as a counter; it is not converted in `normalizeSample()`.

## 9. Heart-rate calculation

FRWHOOP has several HR values. They are related, but they are not the same
calculation.

### 9.1 Live HR source priority

#### Primary: custom WHOOP type-40 stream

After a complete frame passes envelope and CRC validation:

```text
Harvard live BPM = frame[12]
Puffin live BPM  = frame[16]
```

The iOS bridge accepts the value only when it is in `20…240`, updates the live
UI, and appends a durable live sample.

`customHRStreamLastAt` marks the custom stream as active for five seconds.

#### Fallback: standard BLE `0x2A37`

The standard Heart Rate Measurement parser in
[`WhoopBlePlugin.swift`](../../frontend/ios/App/App/WhoopBlePlugin.swift)
supports the Bluetooth flags:

1. If the payload has one byte, interpret that byte as an 8-bit BPM.
2. Otherwise read flags byte 0.
3. If bit 0 is set, read a little-endian `u16` BPM at bytes 1–2;
   otherwise read an 8-bit BPM at byte 1.
4. If bit 3 is set, skip the two-byte Energy Expended field.
5. If bit 4 is set, read remaining little-endian RR values in units of
   `1/1024` seconds:

```text
rr_ms = round(raw_rr * 1000 / 1024)
```

6. Keep only BPM `20…240` and RR `200…2500 ms`.

The standard characteristic remains subscribed as a fallback. While a custom
type-40 sample is fresh, a `2A37` sample updates the UI but is not persisted
again. This prevents the two sources from doubling bucket averages.

### 9.2 iOS live persistence and deduplication

`applyHeartRate()`:

- rejects BPM outside `20…240`;
- suppresses a same-BPM duplicate arriving within one second;
- appends the accepted row to the crash-safe `SensorQueue`;
- stores live time as the phone receive time;
- retains current motion separately from strap HR;
- updates the UI immediately and emits periodic host uploads.

Live HR rows normally contain:

```json
{
  "bpm": 68,
  "rr_ms": [],
  "connected": true,
  "deviceId": "…",
  "t": "receive-time"
}
```

Historical rows instead use the strap sensor timestamp and can carry gravity,
RR, steps, and skin temperature.

### 9.3 Daily average and maximum HR

In `createMetricsEngine().persistComputed()`:

```text
H = normalized samples whose bpm is an integer in 20…240
avg_hr_bpm = round(sum(H) / count(H))       when H is non-empty
max_hr_bpm = max(H)                         when H is non-empty
```

These values are written to `daily_metrics.avg_hr_bpm` and
`daily_metrics.max_hr_bpm`. They are computed from normalized sample BPM
values, not from the display curve.

The sleep scorer also calculates `overnightHr`, which is the median HR inside
the accepted sleep window. That is different from daily average HR and from
RHR.

## 10. Resting heart rate (RHR)

### 10.1 Sleep window is established first

RHR is not the minimum of every HR sample in a calendar day. FRWHOOP first
finds a sleep session using the hybrid sleep detector in
[`sleepDetection.js`](../metrics/sleepDetection.js).

The primary detector uses gravity stillness and HR confirmation. It also
checks sample coverage, large gaps, off-wrist intervals, and overnight/daytime
guards. A detected session is refined before its physiology is scored.

The detector uses a preliminary five-minute statistic while evaluating
candidate windows:

```text
preliminary_session_resting_hr =
  round(min(mean(HR values in each populated five-minute window)))
```

This preliminary value helps decide whether a quiet period is sleep. It is not
the final persisted RHR formula.

### 10.2 Final session RHR

`scoreSession()` in [`sleep.js`](../metrics/sleep.js) selects valid BPM values
whose timestamps fall inside the final accepted session:

```text
H_sleep = [valid BPM values where start <= sample_time <= end]
overnightHr = round(P50(H_sleep))
restingHr   = round(P10(H_sleep))
```

`P10` is the 10th percentile, not the absolute minimum. The percentile helper
uses linear interpolation:

```text
index = (count - 1) * percentile
```

and interpolates between the surrounding sorted values.

This makes RHR less sensitive to one erroneous low sample while still
representing the low end of the overnight distribution.

The returned values are:

| Returned field | Formula | Product meaning |
|---|---|---|
| `overnightHr` | rounded 50th percentile | median HR during the session |
| `restingHr` | rounded 10th percentile | FRWHOOP resting HR |
| `hrSpark` | every `floor(count/48)`th valid sleep BPM, max 48 | sleep HR sparkline |

When the day has multiple sessions, the main/longest accepted sleep session
provides the primary daily value. Nap sessions can have their own scored
values, but they do not replace the main overnight RHR.

### 10.3 Persistence and fallback behavior

The metric engine writes the final value to:

```text
daily_metrics.resting_hr_bpm
sleep/session rows.resting_hr_bpm
WHOOP day physiological_summary["Resting heart rate (bpm)"]
```

If gravity coverage is insufficient, FRWHOOP has a conservative HR-only
overnight fallback. It is marked low confidence and is not treated as a
normal persistable overnight sleep session. The engine can still retain
available scalar physiology with its low-confidence provenance.

If the FRWHOOP value is absent, the host's HealthKit overlay may fill a Watch
RHR value. It does not overwrite an existing FRWHOOP RHR. This overlay is a
fallback/display merge, not a replacement for the strap calculation.

## 11. The 24-hour HR curve

### 11.1 Definition

In FRWHOOP, “24-hour HR” means a time-of-day curve for a local calendar day.
It is **not** one arithmetic average over all 24 hours.

The day range is local midnight to the next local midnight in the user's IANA
timezone. DST is handled by
[`dayBoundary.js`](../time/dayBoundary.js). Sleep-associated daily metrics use
the local wake date, while intraday buckets use local calendar-day bounds.

### 11.2 Persisted-series path

The metrics engine creates `daily_physiology_series` through
`seriesFromSamples()` in [`buckets.js`](../metrics/buckets.js).

#### Backend five-minute buckets

`bucketsFromSamples()` floors each timestamp to a five-minute UTC epoch bucket.
For valid BPM values, `accumulateBucket()` maintains:

```text
bucket.avg_hr = round((sum of BPM / number of BPM samples) * 10) / 10
bucket.min_hr = minimum BPM
bucket.max_hr = maximum BPM
bucket.n      = valid BPM sample count
```

The series is then filtered to the local day bounds and stored as
`daily_physiology_series.hr_series`:

```json
{
  "t": "2026-08-26T12:00:00.000Z",
  "avg_hr": 71.4,
  "min_hr": 68,
  "max_hr": 75,
  "n": 74
}
```

When the API maps that series to the legacy Overview shape,
`bpmDataFromSeries()` produces:

```text
datetime = series point time
bpm      = avg_hr
sleep_stage = series sleep stage or "none"
```

Those rows become `day.bpm_data`.

#### Live overlay path

For a live in-memory overlay, `downsampleBpmSamples()` in
[`whoopDays.js`](../host/whoopDays.js) uses five-minute local-day buckets. It
keeps the **latest sample in each bucket**, rather than averaging all samples.
This is intentionally a compact live overlay; it is not the same as the
persisted five-minute average.

### 11.3 Frontend display buckets

`hrOverview(day, bucketMin = 10)` in
[`overviewModel.js`](../../frontend/src/features/overview/overviewModel.js)
turns `bpm_data` into a 24-hour display model:

1. Create `1440 / bucketMin` time-of-day buckets. With the default,
   `bucketMin=10`, there are 144 buckets.
2. Parse each row's local minute of day.
3. Ignore rows without a timestamp or BPM.
4. For each display bucket:

```text
display_bpm = round(sum(input row BPM) / number of input rows)
```

5. Leave buckets with no samples as `bpm: null`; gaps are not interpolated.
6. Mark a bucket as sleep when at least 35% of its input rows have a
   non-`none` sleep stage.
7. Compute display min/max from the filled display buckets.
8. Compute `rawMin` and `rawMax` from input rows so a flattened bucket does
   not hide the actual observed extrema.
9. Compute the display `avg` from the filled display bucket values. If no
   display bucket is filled, fall back to the persisted
   `Average HR (bpm)` summary.

The important distinction is:

```text
daily_metrics.avg_hr_bpm = mean of normalized raw BPM samples
hrOverview().avg         = mean of filled display-bucket BPM values
```

They can differ because they use different bucket boundaries and weighting.

### 11.4 24-hour HR example

Suppose a ten-minute display bucket receives three five-minute values:

```text
68, 71, 73
```

The displayed point is:

```text
round((68 + 71 + 73) / 3) = 71 BPM
```

A missing ten-minute interval remains null. It is not filled with the
previous, next, or daily average value.

## 12. Steps calculation

### 12.1 Wire source

The current WHOOP strap step source is the WHOOP 5/MG v18 historical field:

```text
step_motion_counter = u16 little-endian @57
```

It is a cumulative device counter. It increases while motion is counted, holds
when there is no counted motion, and wraps at 65536. It is not a per-second
step total.

The related fields are:

```text
step_cadence  = u8 @59
activity_class = u8 @63: 0 unclassified/unknown, 1 walk, 2 run
```

Cadence and activity class are retained as context. The daily total is
calculated from the counter deltas.

The current Harvard v24/v25 `HistoricalSample` has no step counter field, so a
WHOOP 4 history sync does not produce a strap step total from these maps unless
some other input supplies an explicit `steps` delta.

### 12.2 iOS-to-backend handoff

The iOS historical decoder sends `stepCounter` unchanged. In
`SensorQueue.appendHistorical()` it becomes:

```json
{
  "step_cumulative": 4217,
  "t": "sensor-timestamp",
  "layout": "v18",
  "family": "puffin"
}
```

No delta is calculated on iOS. This keeps the raw counter available for the
backend's day filtering, deduplication, reset handling, and rollover logic.

### 12.3 Input normalization

`archiveFormat.js` accepts either of two step inputs:

1. `steps`: an explicit per-second delta, valid only in `0…20`;
2. `step_cumulative`: the raw non-negative cumulative counter.

When both exist, the explicit delta is authoritative for accumulation. The
cumulative counter is not added a second time.

### 12.4 `stepDeltaFor()` algorithm

The core function is in [`steps.js`](../metrics/steps.js).

#### Explicit delta

```text
if sample.steps is present:
    if 0 <= sample.steps <= 20:
        return sample.steps
    otherwise:
        return 0 and mark refused
```

An out-of-range explicit delta is treated as a unit error or an accumulated
value mislabeled as a one-second delta.

#### Cumulative counter

```text
cur = sample.step_cumulative
prev = previous cumulative counter

if prev is absent:
    delta = 0
else:
    delta = cur - prev

    if delta < 0 and prev >= 65536 - 512:
        # genuine near-end-of-u16 rollover
        delta = cur + (65536 - prev)
    else if delta < 0:
        # likely reset/new history chunk, not a wrap
        delta = 0
        mark reset
```

The 512-count near-end guard prevents a mid-range counter drop from being
interpreted as tens of thousands of steps.

### 12.5 `accumulateSteps()` algorithm

`accumulateSteps()` makes the result deterministic regardless of arrival order:

1. discard rows without a valid timestamp or step signal;
2. sort by timestamp;
3. deduplicate by device second, keeping the first occurrence;
4. calculate explicit deltas or counter differences;
5. use elapsed time to test a cumulative jump:

```text
effective_per_second = delta / elapsed_seconds
```

   A value above 20 steps per elapsed second is refused. A valid multi-second
   jump is still counted in full; it is not discarded merely because the
   samples were several seconds apart.
6. add accepted deltas to the daily total;
7. place positive deltas into a local-hour bucket;
8. return total, hourly values, coverage, refusals, confidence, and input mode.

The accumulator returns these important fields:

| Output | Meaning |
|---|---|
| `total` | daily step total |
| `byHour` | sorted local-hour `{hour, steps, seconds}` rows |
| `coverage_seconds` | number of step-signal seconds considered |
| `refused_deltas` | implausible deltas not added |
| `input_mode` | `delta` if any explicit delta exists, otherwise `cumulative` |
| `status` | `ok`, `partial`, or `unavailable` |
| `confidence` | deterministic 0–1 score based on coverage/refusals |
| `algorithm_version` | `frwhoop-steps-v1` |

### 12.6 Counter examples

#### Normal cumulative counter

```text
time       counter       delta
12:00:00   1000          0       first sample has no predecessor
12:00:01   1001          1
12:00:02   1004          3

daily contribution = 0 + 1 + 3 = 4
```

#### Real u16 rollover

```text
previous counter = 65534
current counter  = 2

delta = 2 + (65536 - 65534) = 4
```

#### Mid-range reset

```text
previous counter = 30000
current counter  = 100

delta is not 35636; it is treated as a reset and contributes 0.
```

#### Explicit delta plus cumulative counter

```text
sample.steps = 2
sample.step_cumulative = 1004

contribution = 2
```

The same sample must not contribute both `2` and a counter difference.

### 12.7 Day boundary and persistence

When `persistComputed()` is called with `extras.day`, it filters step samples to
that user's local date **before** accumulating. This prevents yesterday's last
counter and today's first counter from being compared as if they were adjacent
samples in one day.

The engine then writes:

```text
daily_metrics.steps
daily_metrics.confidence.steps
daily_metrics.provenance.steps
```

with source `whoop_step_counter` and algorithm version
`frwhoop-steps-v1`. If there are no usable step samples, the field is absent
or unavailable; it is not fabricated as zero.

The API day mapper exposes the value as:

```text
physiological_summary.Steps
```

and the frontend reads it through `stepsOf(day)`. HealthKit overlays do not
replace strap steps.

### 12.8 Accuracy qualification

The WHOOP 5 `step_motion_counter` is an approximate motion counter. FRWHOOP's
delta, rollover, deduplication, reset, and plausibility rules prevent common
over-counting failures, but they do not prove that one motion tick equals one
human step. Absolute accuracy requires comparison against a reference device.

Steps are primarily obtained during historical offload. A live disconnect can
delay the current step total until the strap history is successfully flushed.

## 13. Time zones and day attribution

FRWHOOP stores timestamps as UTC instants and uses an IANA timezone for local
aggregation.

### 13.1 Physiological day

[`physiologicalDay()`](../time/dayBoundary.js) chooses:

1. the local date on which the main sleep episode ended (`wakeIso`), when a
   sleep episode exists;
2. otherwise the local date of the request/current time.

This is a wake-date association for sleep metrics.

### 13.2 Intraday ranges

[`dayBounds()`](../time/dayBoundary.js) returns UTC instants for local midnight
to the next local midnight. It is used for:

- `daily_physiology_series`;
- the 24-hour HR curve;
- daily step filtering;
- range/snapshot queries.

FRWHOOP does not use a fixed 16:00-to-16:00 cycle for these backend day
bounds.

## 14. Persistence, recomputation, and provenance

### 14.1 Durable queues

The iOS queues are NDJSON files under the app's Application Support directory:

- live samples: `sensor-queue.ndjson`;
- historical physiology: `historical-physiology.ndjson`;
- raw ATT notifications: `ble-frames.ndjson`.

Each append is fsynced before the phone treats the row as durable. The backend
also uses WAL-backed live and historical buffers. A failed B2 upload does not
trim the corresponding WAL.

### 14.2 Backend outputs

`persistComputed()` uses the same normalized sample set for:

- sleep detection and sleep-session RHR;
- average/max HR;
- step accumulation;
- temperature aggregation;
- daily physiological series.

The usual persistence split is:

| Store | Data |
|---|---|
| B2 `frames` | raw ATT notify capture, for replay/redecode |
| B2 `physiology` | normalized HR/RR/gravity/core-health projection |
| B2 derived object | compressed sleep summary and chart details |
| Supabase `daily_metrics` | compact day values and provenance |
| Supabase `daily_physiology_series` | intraday HR series |
| Supabase sleep/session tables | sleep and session-level values |

### 14.3 Provenance

Computed core-health metrics carry:

```text
source
algorithm_version
input_mode / window
confidence
status
```

Examples:

```text
steps.algorithm_version      = "frwhoop-steps-v1"
steps.source                 = "whoop_step_counter"
daily metric algorithm       = "2.0.2-hybrid-sleep"
```

This allows a value to be distinguished from “no data,” a partial sync, a
low-confidence fallback, and a real measured zero.

## 15. Common mistakes to avoid

1. **Parsing before reassembly.** A notification fragment is not a packet.
2. **Using Harvard offsets on Puffin.** Type 40 HR is `@12` for Harvard and
   `@16` for Puffin.
3. **Using the wrong CRC.** Harvard uses header CRC8; Puffin uses header
   CRC16-Modbus; both use an inner CRC32.
4. **Including CRC bytes in the payload.** The CRC32 trailer is excluded from
   semantic field decoding.
5. **Summing `step_motion_counter`.** It is cumulative; only deltas belong in
   the daily total.
6. **Reading only byte 57 for steps.** The counter is a full little-endian
   `u16` at bytes 57–58.
7. **Treating every negative counter jump as a rollover.** Only a drop from
   near the end of the u16 range is unwrapped.
8. **Calling the curve a 24-hour average.** It is a local time-of-day curve
   with missing buckets preserved as null.
9. **Using display buckets for daily average HR.** `daily_metrics.avg_hr_bpm`
   is computed from normalized BPM samples.
10. **Treating PPG waveform samples as BPM.** Puffin v26 is raw optical data;
    the standard FRWHOOP HR metric path does not consume it as decoded HR.
11. **Replacing strap steps/RHR with HealthKit automatically.** HealthKit is a
    fallback overlay when the FRWHOOP value is missing.
12. **Turning unavailable into zero.** Missing history or a failed validity
    gate must remain unavailable/partial.

## 16. Verification and source map

The implementation is covered by tests including:

- [`tests/steps.test.js`](../tests/steps.test.js): normal deltas, duplicate and
  out-of-order rows, rollover, resets, implausible jumps, hourly buckets, and
  midnight behavior;
- [`tests/engineCoreHealth.test.js`](../tests/engineCoreHealth.test.js):
  steps plus average/max HR persistence and provenance;
- [`tests/host.test.js`](../tests/host.test.js): live HR overlays, 24-hour
  downsampling, HealthKit RHR fallback, and strap-step precedence;
- [`tests/protocol/whoop5Parity.test.js`](../tests/protocol/whoop5Parity.test.js):
  v18, v20, v21, and v26 byte maps;
- [`tests/adversarial/decoderAdversarial.test.js`](../tests/adversarial/decoderAdversarial.test.js):
  CRC failures, frame preservation, and raw waveform recoverability.

Primary source files:

| Concern | Source |
|---|---|
| CRC algorithms | [`protocol/crc.js`](../protocol/crc.js) |
| Frame envelopes/reassembly | [`protocol/framing.js`](../protocol/framing.js) |
| Packet registry/dispatch | [`protocol/decoder.js`](../protocol/decoder.js) |
| Puffin v18/v20/v21/v26 maps | [`protocol/whoop5.js`](../protocol/whoop5.js) |
| iOS family framing/history map | [`frontend/ios/App/App/WhoopProtocol.swift`](../../frontend/ios/App/App/WhoopProtocol.swift) |
| iOS BLE/live HR/history routing | [`frontend/ios/App/App/WhoopBlePlugin.swift`](../../frontend/ios/App/App/WhoopBlePlugin.swift) |
| iOS durable rows/frames | [`frontend/ios/App/App/SensorQueue.swift`](../../frontend/ios/App/App/SensorQueue.swift) |
| Normalized archive contract | [`ingest/archiveFormat.js`](../ingest/archiveFormat.js) |
| Historical WAL and clock correction | [`ingest/historyBuffer.js`](../ingest/historyBuffer.js) |
| Live hourly buffer | [`ingest/hourBuffer.js`](../ingest/hourBuffer.js) |
| RHR/sleep scoring | [`metrics/sleep.js`](../metrics/sleep.js) |
| Sleep window detection | [`metrics/sleepDetection.js`](../metrics/sleepDetection.js) |
| Step accumulation | [`metrics/steps.js`](../metrics/steps.js) |
| HR buckets/series | [`metrics/buckets.js`](../metrics/buckets.js) |
| Metric persistence | [`metrics/engine.js`](../metrics/engine.js) |
| Local day boundaries | [`time/dayBoundary.js`](../time/dayBoundary.js) |
| Overview HR/steps presentation | [`frontend/src/features/overview/overviewModel.js`](../../frontend/src/features/overview/overviewModel.js) |
