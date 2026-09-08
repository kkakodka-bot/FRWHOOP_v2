# FRWHOOP calorie pipeline: packet bytes to kcal

This document describes the current FRWHOOP path from WHOOP BLE bytes to the
calorie values produced by the backend.

It is intentionally limited to energy expenditure. Packet fields that do not
affect the current calorie estimator are identified so that a decoded value is
not mistaken for a calorie input.

## Read this first

1. FRWHOOP does **not** read a calorie number from a WHOOP packet. It estimates
   energy from decoded heart rate, scalar motion, sleep/workout context, and the
   user's physiology.
2. The production sensor total is in **kilocalories (kcal)**, even where the
   frontend label says `Energy burned (cal)`. One displayed unit is a dietary
   kilocalorie, not one small physical calorie.
3. The internal unit is VO₂ in `mL O₂/kg/min`. HR and motion are converted to
   VO₂, fused in VO₂ space, and converted to kcal exactly once.
4. Workout energy is a slice of active energy. It is never added on top of
   daily active energy.
5. The current persisted sensor result excludes thermic effect of food (TEF).
   TEF is a separate daily accounting concern and is not present in the
   `energy_minutes` schema.
6. Bad bytes are not repaired into plausible physiology. A failed CRC, an
   impossible HR, or an invalid motion value is preserved or marked absent;
   it cannot silently manufacture calories.

## 1. End-to-end flow

```text
WHOOP BLE ATT notification
        │
        ├── persist exact notification bytes as Level A hex
        │
        ├── append to the reassembly buffer for that stream characteristic
        │
        ├── locate 0xAA and use the family-specific length field
        │
        ├── emit complete WHOOP 4/5 frame
        │
        ├── verify header CRC and payload CRC32
        │
        ├── decode packet type and useful byte offsets
        │       ├── HR from type 40 or GATT 0x2A37
        │       ├── motion scalar from type 43 and iPhone accelerometer
        │       └── historical HR/RR/gravity/context from type 47
        │
        ├── normalize into timestamped samples
        │
        ├── persist local WAL/day files and hourly B2 archives
        │
        ├── bucket samples into UTC minutes
        │
        ├── calculate minute features and signal quality
        │
        ├── classify the activity
        │
        ├── estimate VO₂ from HR and/or motion
        │
        ├── quality-weight the channels and clamp the result
        │
        ├── convert VO₂ to kcal/min
        │
        ├── split each minute into resting and active kcal
        │
        └── aggregate daily/workout rows and expose the API result
```

The main implementation files are:

| Stage | File | Responsibility |
|---|---|---|
| BLE capture | `frontend/ios/App/App/WhoopBlePlugin.swift` | Receives GATT values, captures raw bytes, extracts live HR/motion |
| Swift protocol | `frontend/ios/App/App/WhoopProtocol.swift` | WHOOP 4/5 framing, CRCs, realtime/history byte maps |
| Durable phone queue | `frontend/ios/App/App/SensorQueue.swift` | Fsyncs samples, history rows, and raw notifications before upload |
| Frame envelope | `backend/protocol/framing.js` | Reassembles fragments and verifies family-specific frames |
| Frame decoder | `backend/protocol/decoder.js` | Classifies packet types and records decode lineage |
| WHOOP 5 decoder | `backend/protocol/whoop5.js` | Decodes WHOOP 5 historical layouts and raw-data structures |
| Normalization | `backend/ingest/archiveFormat.js` | Converts values into the canonical sample/archive schema |
| Live buffer | `backend/ingest/hourBuffer.js` | Deduplicates and archives live samples and frames |
| History buffer | `backend/ingest/historyBuffer.js` | Validates, corrects, and archives backfilled history |
| Energy wiring | `backend/energy/service.js` | Resolves physiology and calls the pure energy engine |
| Minute engine | `backend/energy/engine.js` | Produces minute rows and rollups |
| Physiology | `backend/energy/physiology.js` | RMR, HRmax, VO₂max, flex HR, and conversion |
| Features/quality | `backend/energy/features.js` and `backend/signal/quality.js` | Minute statistics and channel trust |
| Activity class | `backend/energy/activity.js` | Sleep, sedentary, walking, running, cycling, strength, and other classes |
| Estimators | `backend/energy/estimators.js` | HR channel, motion channel, fusion, and plausibility clamps |
| Database | `supabase/migrations/20260825120000_energy_expenditure.sql` | Minute table, rollups, generated total, RLS, and RPCs |

The `noop` codebase is a protocol/reference source. The active phone app is
`frontend/ios`, and the active calorie calculation is the
`backend/energy` path described here.

## 2. Which decoded values can affect calories?

The most important distinction is between a value that is decoded and a value
that is actually consumed by `computeEnergy()`.

| Input | Where it comes from | Used by current energy-v1? | Effect |
|---|---|---:|---|
| Heart rate (`bpm`) | WHOOP type 40, GATT `0x180D/0x2A37`, or history type 47 | Yes | Primary cardiovascular VO₂ channel |
| RR intervals (`rr_ms`) | GATT `0x2A37` or historical records | Indirectly | Signal-quality/diagnostic context; not a direct kcal formula input |
| Live scalar motion (`mot`) | WHOOP type 43 and/or iPhone accelerometer | Yes | Motion VO₂ channel and activity classification |
| `stage` / `sleep_stage` | A normalized sample field when supplied | Yes, if present | Can force the sleep activity class and sleeping baseline |
| Workout session and sport | Existing workout detector/session rows | Yes | Labels minutes and chooses activity-specific model |
| Weight | User profile/context | Yes | Converts VO₂ to kcal and sets RMR |
| Height, age, sex | User profile/context | Yes | RMR and population physiology |
| Resting HR | Preferences/profile | Yes for HR channel | HR reserve, VO₂max fallback, and flex HR |
| VO₂max | User profile or physiology fallback | Yes for HR channel | Upper end of the exercise VO₂ mapping |
| Calibration parameters | `energy_user_calibration` | Yes when active | Bounded user-specific corrections |
| Gravity vector (`gx/gy/gz`) | Historical packets | Not directly by energy-v1 | Preserved for sleep/other metrics; not automatically converted to `mot` |
| Dynamic acceleration (`dyn_accel`) | WHOOP 5 v18 history | Not directly by energy-v1 | Preserved, but `features.js` reads `mot`/`motion` |
| Raw tri-axial IMU arrays | Type 43/v21 raw records | No | Archived/redecoded for future features; no current energy regression |
| Steps/cadence | Historical fields | No | Used by step metrics, not the energy-v1 estimator |
| Skin temperature | Historical fields | No | Used by temperature metrics when available |
| PPG waveform | Raw optical records | No | No PPG calorie estimator is active |
| Battery, events, metadata, command responses | BLE protocol | No | Ingestion/history state only |

### Important current-code caveat

The energy engine consumes `features.motion`, which is extracted from the
normalized `mot` or `motion` scalar. A valid historical gravity vector causes
`normalizeSample()` to keep `gx/gy/gz` separately and set `mot` to `null`.
Likewise, historical `sleep_state` is not automatically renamed to
`stage` by the current native history path.

Therefore, a history row can contain useful HR, gravity, dynamic acceleration,
steps, or sleep-related bytes without all of those values affecting the
current calorie estimate. The row remains available for replay and for other
metrics.

## 3. Byte and number conventions

All protocol offsets in this document are zero-based offsets into the complete
reassembled frame, including the leading `0xAA`.

### 3.1 Hex and endianness

Examples:

```text
u16 little-endian:  b0 | (b1 << 8)
u32 little-endian:  b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)
```

The protocol implementation uses:

- `u8` for unsigned one-byte values;
- `u16le` and `u32le` for unsigned little-endian integers;
- signed `i16` values using two's complement;
- IEEE-754 little-endian `f32` values for several historical sensor fields;
- little-endian CRC trailers.

The decoder must never treat an offset as a semantic value merely because the
bytes fit a convenient range. Each field is gated by its known layout and a
physical plausibility check.

### 3.2 Protocol families

The family is selected from the WHOOP GATT service/characteristic family. It is
not safe to parse a WHOOP 5 frame as a WHOOP 4 frame shifted by four bytes.

| Hardware | Family | Service | Command characteristic | Stream characteristics |
|---|---|---|---|---|
| WHOOP 4.0 | Harvard | `61080001-8D6D-82B8-614A-1C8CB0F8DCC6` | `61080002-...` | `61080003-...`, `04`, `05` |
| WHOOP 5.0 / MG | Puffin | `FD4B0001-CCE1-4033-93CE-002D5875F58A` | `FD4B0002-...` | `FD4B0003-...`, `04`, `05`, `07` |
| Standard BLE HR | GATT | service `180D` | not applicable | measurement characteristic `2A37` |

`WhoopBleManager` sets `familyIsPuffin` from the discovered service. It then
uses the corresponding frame builder and decoder.

## 4. WHOOP frame envelopes

### 4.1 WHOOP 4 / Harvard envelope

```text
offset   size       field
------   ----       --------------------------------------------
0        1          start of frame, always 0xAA
1..2     2          length, u16 little-endian
3        1          CRC-8 over bytes [1..3)
4..      length     inner record, including its CRC32 trailer
length   4          CRC32 over inner record bytes [4..length)
```

The total frame size is:

```text
total_bytes = length + 4
```

The length includes the four-byte CRC32 at the end of the inner record. It does
not include the leading `0xAA`, the two length bytes, or the CRC-8 byte.

For a normal realtime type-40 frame, the inner record begins at offset 4:

```text
frame[4]  = packet type
frame[5]  = sequence or layout version
```

### 4.2 WHOOP 5 / Puffin envelope

```text
offset   size       field
------   ----       --------------------------------------------
0        1          start of frame, always 0xAA
1        1          format byte, currently 0x01
2..3     2          declared length, u16 little-endian
4..5     2          header bytes
6..7     2          CRC16-Modbus over bytes [0..6)
8..      ...        payload/inner record
payload  4          CRC32 over payload bytes [8..payload_end)
```

The declared length is the payload length plus its four-byte CRC32 trailer:

```text
total_bytes = declared_length + 8
payload_end = total_bytes - 4
```

The packet type and sequence/version are therefore shifted:

```text
frame[8]  = packet type
frame[9]  = sequence or layout version
```

The four-byte difference changes the length location, header CRC, payload
start, and payload CRC location. A family-aware parser is mandatory.

### 4.3 CRC algorithms

FRWHOOP uses three CRCs:

| CRC | Used by | Parameters | Covered bytes |
|---|---|---|---|
| CRC-8 | WHOOP 4 header | polynomial `0x07`, initial `0x00` | Harvard length bytes `[1..3)` |
| CRC16-Modbus | WHOOP 5 header | polynomial `0xA001`, initial `0xFFFF` | Puffin header `[0..6)` |
| CRC32 | Both payloads | zlib polynomial `0xEDB88320`, initial `0xFFFFFFFF`, final XOR | Inner/payload bytes before CRC32 trailer |

`verifyFrame()` returns separate header and payload results:

```js
{
  ok: true,
  crc8_ok: true,       // uniform name; also carries Puffin header result
  crc32_ok: true,
  family: "harvard",
  total:  ...
}
```

The decoder behavior on failure is deliberate:

- the frame is classified as `crc_failed`;
- `decoded` is `null`;
- confidence is low;
- raw hex and frame hash remain available;
- no physiological field is allowed to reach the calorie engine from that
  frame.

## 5. Reassembling BLE notifications

BLE notifications are fragments, not guaranteed complete WHOOP frames. The
phone keeps one reassembly buffer per WHOOP stream characteristic:

```text
notification A + notification B + notification C
                         │
                         └── complete frame
```

The iOS and backend reassemblers perform the following operations:

1. Append the notification bytes to the buffer for that characteristic.
2. Search for the next `0xAA` start marker.
3. Count bytes using the family-specific length field.
4. Wait until the complete frame is present.
5. Emit the frame and continue parsing any following frame in the buffer.
6. Record bytes before a start marker as dropped/resynchronization bytes.
7. Reject a declared size above `8192` bytes as a corrupt length and resync.
8. On disconnect, return the incomplete tail for accounting; do not pretend it
   was a valid frame.

`createReassembler()` does not verify CRC itself. It creates complete candidate
frames; `verifyFrame()` and `decodeFrame()` perform integrity validation.

The raw notification archive is written before this parse. Consequently, a
fragment, dropped prefix, incomplete frame, or CRC-failed frame remains
available for forensic review and future decoder changes.

## 6. Packet types relevant to calories

The packet registry includes many WHOOP types, but only a small subset can
provide energy inputs.

| Type | Name | Calorie relevance |
|---:|---|---|
| `40` | `REALTIME_DATA` | Main custom live HR source |
| `43` | `REALTIME_RAW_DATA` | Source for live strap motion; may also contain high-rate raw data |
| `47` | `HISTORICAL_DATA` | Backfilled HR/RR/gravity/context, depending on layout/version |
| `49` | `METADATA` | Historical start/end/complete markers; no kcal value |
| `52` | `HISTORICAL_IMU_DATA_STREAM` | Backend deep-decoder route for a WHOOP 5 history body; no direct current energy input |
| `56` | `PUFFIN_METADATA` | WHOOP 5 metadata alias; no kcal value |
| `2A37` | Standard BLE Heart Rate Measurement | Fallback HR/RR source |
| `48` | `EVENT` | Battery/wear/device events; no direct kcal input |
| `35/36/37/38` | Commands and responses | Controls/readbacks/history; no direct kcal input |

The presence of a packet type is not enough. A packet must pass the family
envelope checks, have a supported layout, and produce valid normalized fields.

## 7. Realtime packet byte maps

### 7.1 Type 40: WHOOP realtime HR

#### Harvard / WHOOP 4

| Frame offset | Size | Interpretation |
|---:|---:|---|
| `4` | 1 | `packet_type = 40` |
| `5` | 1 | sequence |
| `6..9` | 4 | timestamp, `u32le` |
| `10..11` | 2 | subsecond field, `u16le` |
| `12` | 1 | heart rate in BPM |
| `13` | 1 | RR-count hint |

#### Puffin / WHOOP 5

| Frame offset | Size | Interpretation |
|---:|---:|---|
| `8` | 1 | `packet_type = 40` |
| `9` | 1 | sequence |
| `10..13` | 4 | timestamp, `u32le` |
| `14..15` | 2 | subsecond field, `u16le` |
| `16` | 1 | heart rate in BPM |
| `17` | 1 | RR-count hint |

The live Swift path validates the HR byte to `20...240` BPM. The backend
redecode path applies the same range:

```js
const hr = raw >= 20 && raw <= 240 ? raw : null;
```

The custom type-40 packet is the canonical live HR source while it is active.
The standard GATT HR profile remains subscribed as a fallback, but rows are
suppressed while the custom stream is fresh so the same beat is not persisted
twice.

Type 40's RR-count field is only a hint in the current backend decoder. It does
not by itself provide a complete RR array to the energy estimator.

### 7.2 Type 43: realtime raw data and live strap motion

> **AUDIT CORRECTION (2026-08-27, verified against NOOP golden.json real
> captures):** the "millig triplet" below does NOT contain acceleration. Bytes
> 12..17 (Harvard) / 16..21 (Puffin) overlap the type-43 record header
> (cmd/record_hdr/timestamp/subseconds per the NOOP `whoop_protocol.json` map),
> so `milligMagnitude()` computes a magnitude of *timestamp bytes* — a real
> captured frame yields a bogus 7.875 g that passes the 0–8 g gate. The real
> 100 Hz accelerometer samples live at offsets 89/289/489 (i16, 1/4096 g/LSB)
> and DO contain gravity (|a| ≈ 1.0 g at rest). The strap's own gravity-removed
> motion magnitude is `dynamic_acceleration@41` (v18 history, `dyn_accel` in
> normalized samples). Production WHOOP 5 archives contain zero type-43 frames,
> so the live motion channel has in practice been the phone's |mag−1|. Energy
> v2 (energy/v2/features.js) prices strap minutes from `dyn_accel` and routes
> phone/HR-only minutes to the physiological estimator. See
> `_energy_v2_research/audit_gravity_verdict.json` for the evidence chain.

The (broken) live scalar motion extraction reads a three-axis signed
little-endian triplet from the type-43 header:

| Family | Triplet start | Values |
|---|---:|---|
| Harvard / WHOOP 4 | offset `12` | `i16le x`, `i16le y`, `i16le z` |
| Puffin / WHOOP 5 | offset `16` | `i16le x`, `i16le y`, `i16le z` |

Each raw value is interpreted as millig and converted to g:

```text
x_g = i16le(x_offset)     / 1000
y_g = i16le(y_offset + 2) / 1000
z_g = i16le(z_offset + 4) / 1000

strap_motion = sqrt(x_g² + y_g² + z_g²)
```

The result is accepted only when it is between `0` and `8 g`.

Type 43 can also contain high-rate raw arrays. The backend structural decoder
knows these layouts:

| Data | WHOOP 4 offsets | WHOOP 5 offsets | Scale |
|---|---|---|---|
| Accelerometer X/Y/Z | `89`, `289`, `489` | `93`, `293`, `493` | `1/4096 g/LSB` |
| Gyroscope X/Y/Z | `692`, `892`, `1092` | `696`, `896`, `1096` | `2000/32768 dps/LSB` |
| Samples per axis | 100 | 100 | 100 Hz |

Those arrays are preserved for future IMU features and re-decode. The current
energy-v1 estimator does not run a high-rate IMU regression over them. The
calorie path uses the scalar motion value if it is supplied as `motion`/`mot`.

### 7.3 Standard GATT `0x2A37`: HR and RR fallback

The first byte is a flags byte.

| Flag | Mask | Meaning used by parser |
|---|---:|---|
| HR format | `0x01` | `0`: one-byte BPM; `1`: two-byte little-endian BPM |
| Energy-expended field | `0x08` | Skip the following two bytes |
| RR intervals present | `0x10` | Parse remaining two-byte intervals |

Parsing:

```text
if flags & 0x01:
    bpm = u16le(data[1..3])
    next_offset = 3
else:
    bpm = data[1]
    next_offset = 2

if flags & 0x08:
    next_offset += 2

if flags & 0x10:
    while next_offset + 1 < data.length:
        rr_raw = u16le(data[next_offset..next_offset+2])
        rr_ms = round(rr_raw * 1000 / 1024)
        keep only 200 <= rr_ms <= 2500
        next_offset += 2
```

The BLE standard expresses RR in `1/1024` seconds, not milliseconds. The
conversion is therefore required before the value enters the archive.

The parser also supports a one-byte notification containing only BPM. Invalid
values are rejected rather than clamped.

### 7.4 Combining strap and phone motion

The iPhone accelerometer runs at `1 Hz`. Its normalized motion is:

```text
phone_motion = abs(sqrt(phone_x² + phone_y² + phone_z²) - 1.0)
```

The subtraction removes the approximately `1 g` gravity magnitude when the
phone is still.

The live sample's motion is the maximum available signal:

```text
combined_motion =
    max(strap_motion, phone_motion)  when both exist
    strap_motion                    when only strap exists
    phone_motion                    when only phone exists
    null                            when neither exists
```

The maximum is intentional: a quiet wrist does not suppress a moving phone,
and a braced wrist does not suppress strap motion. The value is passed to the
host as `motion`, `strapMotion`, and/or `phoneMotion`; `host/routes.js` reduces
those fields to one scalar.

## 8. Historical packet byte maps

Historical packets are the backfill path. They contain more sensor fields than
the current live calorie model consumes.

### 8.1 History version selection

For historical data, the sequence byte is also the layout version:

```text
WHOOP 4: frame[5] = historical version
WHOOP 5: frame[9] = historical version
```

The generic realtime timestamp offsets must not be applied to every history
layout. Historical records have their own record index and timestamp positions.

### 8.2 WHOOP 5 v18 per-second summary

`whoop5.js` and the Swift decoder use the following frame-absolute offsets for
the 124-byte v18 record:

| Offset | Type | Meaning | Energy-v1 status |
|---:|---|---|---|
| `11..14` | `u32le` | record index | provenance only |
| `15..18` | `u32le` | Unix sensor timestamp | sample time |
| `22` | `u8` | heart rate | yes, if valid |
| `23` | `u8` | RR count | quality/context |
| `24..` | `u16le[]` | up to four RR intervals in ms | quality/context |
| `33` | `u8` | cardiac flags | not used directly |
| `36` | `u8` | HR quality flags | diagnostic input where carried |
| `37` | `u8` | alternate HR | not used by current energy path |
| `38..39` | `u16le` | packed RR field | not used directly |
| `40` | `u8` | cardiac status | not used directly |
| `41..44` | `f32le` | dynamic acceleration | archived, not `mot` |
| `45..48` | `f32le` | gravity X in g | archived separately |
| `49..52` | `f32le` | gravity Y in g | archived separately |
| `53..56` | `f32le` | gravity Z in g | archived separately |
| `57..58` | `u16le` | cumulative step/motion counter | step metric |
| `59` | `u8` | cadence-like value | step/context |
| `63` | `u8` | activity class: `0` still, `1` walk, `2` run | carried, not consumed by energy-v1 |
| `69..70` | `i16le` | auxiliary temperature, `/10` if valid | not energy-v1 |
| `71..72` | `i16le` | auxiliary temperature, `/10` if valid | not energy-v1 |
| `73..74` | `u16le` | skin temperature raw, `/100 °C` | temperature metric |
| `75..80` | `u16le[]` | status words | not energy-v1 |
| `81` | `u8` | sleep state/on-wrist/wake-quality bitfield | preserved by deep decoder; not automatically `stage` |
| `82` | `u8` | SpO₂ candidate byte | instrumentation only |

The v18 decoder performs these gates:

- HR: valid only at `20...240`, with zero used as an off-wrist/absent
  sentinel in the Swift optional parser;
- RR: count no greater than four, values `200...2500 ms` at ingestion;
- dynamic acceleration: finite and `0...8`;
- gravity axes: finite, each within `±8 g`, and resultant magnitude
  `0.5...1.5 g`;
- skin temperature: raw value maps to `5...45 °C` in the native parser;
- activity class: only `0`, `1`, or `2`.

The backend later applies its own archive gates. A decoded field is not
automatically trusted just because the packet layout is recognized.

### 8.3 WHOOP 4 v24 and v25

#### WHOOP 4 v24

| Offset | Type | Meaning |
|---:|---|---|
| `11..14` | `u32le` | sensor timestamp |
| `21` | `u8` | optional HR |
| `22` | `u8` | RR count |
| `23..` | `u16le[]` | RR intervals in ms |
| `40..43` | `f32le` | gravity X |
| `44..47` | `f32le` | gravity Y |
| `48..51` | `f32le` | gravity Z |

#### WHOOP 4 v25

| Offset | Type | Meaning |
|---:|---|---|
| `11..14` | `u32le` | sensor timestamp |
| `73..74` | `i16le` | gravity X, scale `1/16384 g/LSB` |
| `75..76` | `i16le` | gravity Y, scale `1/16384 g/LSB` |
| `77..78` | `i16le` | gravity Z, scale `1/16384 g/LSB` |

The current native Swift decoder supports these layouts for historical
structured rows. Gravity remains a separate vector in the archive; it is not
silently repurposed as a live motion scalar.

### 8.4 WHOOP 5 v21 six-axis history

The v21 layout is a 1244-byte record containing six 100-sample signed
little-endian channels:

```text
accel_x: 100 i16 samples at offset 28
accel_y: 100 i16 samples at offset 228
accel_z: 100 i16 samples at offset 428
gyro_x:  100 i16 samples at offset 640
gyro_y:  100 i16 samples at offset 840
gyro_z:  100 i16 samples at offset 1040
```

The acceleration scale is `1/4096 g/LSB`. The backend deep decoder preserves all
six arrays. The native historical bridge computes or validates a gravity
summary for the structured row, but the current energy engine still consumes
only `mot`/`motion` for its motion channel.

### 8.5 WHOOP 5 v20 and v26

These layouts are useful for protocol re-decode but do not currently feed the
calorie estimator:

- v20 is a 2140-byte multi-block optical buffer with neutral channel names;
- v26 is a high-rate raw optical waveform with 24 little-endian signed samples
  per second;
- type-43 optical variants contain signed-24-bit optical samples at about
  `437 Hz`.

No current FRWHOOP calorie equation consumes raw PPG. HR is taken from the
device-reported HR field or standard GATT HR path.

### 8.6 Metadata packets

Metadata controls history synchronization:

| Family | Meta type offset | Start | End | Complete |
|---|---:|---:|---:|---:|
| Harvard | `6` | `1` | `2` | `3` |
| Puffin | `10` | `1` | `2` | `3` |

For an end marker:

| Family | Unix timestamp | Trim cursor | End-data bytes |
|---|---:|---:|---|
| Harvard | offset `7` | offset `17` | `17..24` |
| Puffin | offset `11` | offset `21` | `21..28` |

The end-data bytes are echoed in the history acknowledgement. These packets
make it possible to request and complete history, but they do not contain a
calorie value.

## 9. Raw capture, normalization, and archival

### 9.1 Level A: exact notification bytes

`SensorQueue.appendNotify()` writes each relevant ATT notification to
`ble-frames.ndjson` before protocol parsing. Each line contains fields such as:

```json
{
  "schema": 1,
  "kind": "notify",
  "seq": 42,
  "t": "2026-08-26T20:00:00.000Z",
  "family": "puffin",
  "char": "FD4B0003-CCE1-4033-93CE-002D5875F58A",
  "hex": "aa...",
  "n": 20,
  "decoder": "frwhoop-whoop-ble/3"
}
```

`hex` contains the complete notification. It is not truncated to a preview.
The notification sequence is a queue identity, not the WHOOP protocol sequence
inside a frame.

The phone fsyncs this row before it allows the stream parser to proceed. If
that write fails, the parser discards the in-progress assembly instead of
letting an unarchived history frame advance the strap cursor.

### 9.2 Level B: reassembled frames

The backend archives reassembled frames separately as:

```text
ndjson_gzip_frames_v1
```

One frame archive row retains:

- complete frame hex;
- family;
- source characteristic;
- timestamps and sequence;
- firmware/model metadata;
- optional interpretation;
- archive schema and decoder version.

The frame archive is the source for later protocol re-decode. It is not mixed
with normalized physiology samples.

### 9.3 Decoded records and lineage

`decodeFrame()` adds:

```text
packet_type
packet_name
version
crc_ok
raw_hex
raw_length
frame_hash
decoder
family
decoded
```

The SHA-256 frame hash and decoder version mean that a newer offset map can be
run against the same bytes without confusing a new interpretation with a new
measurement.

Unknown and CRC-failed frames remain records with raw bytes. They do not become
energy samples.

### 9.4 Canonical physiology samples

The normalized physiology archive is:

```text
gzip(NDJSON)
format: ndjson_gzip_v3
```

The calorie-relevant fields are:

```json
{
  "t": "2026-08-26T20:00:04.000Z",
  "bpm": 92,
  "rr_ms": [652, 660],
  "q": 1,
  "src": "whoop_rt",
  "mot": 0.18,
  "stage": null,
  "family": "puffin",
  "layout": "realtime",
  "decoder": "frwhoop-whoop-ble/3",
  "seq": 1842
}
```

A historical row can instead contain `gx`, `gy`, `gz`, and `dyn_accel`.
`normalizeSample()` keeps gravity separate from `mot` so a static gravity
vector cannot be mistaken for movement intensity.

### 9.5 Durable live path

The live request is `POST /api/ble/live`. The host receives samples, frames,
gaps, and history samples separately:

```text
body.samples          -> live sample queue -> hourBuffer -> physiology archive
body.frames           -> raw frame queue  -> frame archive
body.historySamples   -> historyBuffer    -> physiology archive
body.gaps             -> ingest gap records
```

`hourBuffer.append()` persists the live row with:

```text
datetime, bpm, rr_ms, sleep_stage, motion, battery,
connected, deviceId, firmware, src, seq
```

It rejects a row with neither a finite BPM nor an RR array. This means the
current live energy path normally receives motion alongside a live HR row,
rather than a standalone motion-only row.

## 10. Time, deduplication, and clock correction

### 10.1 Live samples

Live samples are deduplicated using device plus sequence, with timestamp
protection for a device whose counter restarted after reinstall or state loss.
The phone only deletes an acknowledged prefix after the host confirms
persistence.

### 10.2 Historical samples

Historical samples have a separate queue sequence. The history buffer:

1. validates the timestamp and sequence;
2. validates gravity, dynamic acceleration, HR, RR, and other fields;
3. detects strap-clock drift against receipt time;
4. applies a bounded historical clock correction;
5. deduplicates by device/sequence and device/timestamp;
6. fsyncs a WAL row;
7. archives the normalized sample;
8. removes the WAL row only after the archive is confirmed.

### 10.3 Energy minute identity

The energy database key is:

```text
(user_id, minute_at)
```

The engine buckets by UTC minute, then assigns each minute to a local
calendar day using the user's IANA timezone. A late upload or recomputation
upserts the same minute rather than adding a second minute.

## 11. Physiology resolved before calorie calculation

`resolvePhysiology()` runs once for a computation. It uses profile,
preferences, observed history, and optional calibration.

### 11.1 Subject inputs and gates

The sensor/model gates are:

| Quantity | Accepted range |
|---|---:|
| HR | `20...240 BPM` |
| Resting HR | `25...130 BPM` |
| Weight | `25...300 kg` in the model resolver |
| Height | `100...250 cm` |
| Age | `5...110 years` |
| VO₂max | `12...90 mL/kg/min` |
| Motion | `0...16 g-equivalent` |

The host profile endpoint applies narrower user-facing ranges for some fields.
If a required profile field is invalid at model resolution, the resolver uses
an explicit default and adds a note rather than silently using `NaN`.

Current defaults include:

```text
age      = 35
weight   = 75 kg
height   = 172 cm
sex      = unknown midpoint constant
```

An invalid or missing resting HR is not invented. It causes the HR-derived
energy channel to return `null`.

### 11.2 Resting metabolic rate

If lean body mass is valid, Katch–McArdle is preferred:

```text
RMR_kcal_per_day = 370 + 21.6 × lean_mass_kg
```

Otherwise Mifflin–St Jeor is used:

```text
RMR = 10 × weight_kg
    + 6.25 × height_cm
    - 5 × age
    + sex_constant
```

The sex constants are:

```text
male       +5
female   -161
unknown    -78
```

If neither equation can run, the explicit fallback is approximately:

```text
RMR = 24 × weight_kg
```

Calibration may apply a bounded `rmrScale` after the base RMR is selected.
The per-minute resting baseline is:

```text
resting_kcal_per_min = calibrated_RMR_kcal_per_day / 1440
```

Sleeping baseline:

```text
sleep_kcal_per_min = resting_kcal_per_min × 0.95
```

### 11.3 HRmax and VO₂max

HRmax is resolved through the existing HRmax resolver. In the absence of a
measured/overridden value, the age-based fallback is Tanaka:

```text
HRmax = 208 - 0.7 × age
```

VO₂max selection is:

1. user-entered VO₂max, if valid;
2. Uth–Sørensen ratio, if resting HR is available:

   ```text
   VO₂max = 15.3 × HRmax / resting_HR
   ```

3. an explicit sex/age population fallback, clamped to a safe range.

### 11.4 Resting VO₂

The model derives subject-specific resting oxygen uptake from RMR:

```text
resting_VO2 =
    clamp(
      (resting_kcal_per_min / 5.0) × 1000 / weight_kg,
      2.0,
      4.5
    )
```

This is why the model does not use `3.5 mL/kg/min` as every person's
physiological resting floor. `3.5` is retained for conventional displayed MET
conversion and absolute sanity ceilings.

### 11.5 Flex HR

The flex point separates low-level HR variation from the exercise mapping:

```text
HRR     = HRmax - resting_HR
flex_HR = resting_HR + max(20, 0.20 × HRR)
```

Below flex HR, posture, caffeine, stress, and temperature should not be priced
as a linear exercise effort. Above flex HR, the exercise reserve mapping can be
used.

## 12. Per-minute features

`extractSeriesFeatures()` groups samples by:

```text
floor(timestamp_ms / 60_000) × 60_000
```

Each minute is processed independently, in timestamp order.

### 12.1 Feature fields

For each minute, the feature extractor calculates:

| Feature | Meaning |
|---|---|
| `hr` | Mean of valid HR samples |
| `hrMedian` | Median valid HR |
| `hrMin`, `hrMax` | Range of valid HR |
| `hrStd` | HR variability inside the minute |
| `hrSlope` | HR slope in BPM/minute |
| `motion` | Mean valid scalar motion |
| `motionMax` | Maximum scalar motion |
| `motionStd` | Motion variability |
| `motionActiveFraction` | Fraction of motion samples above fidget threshold |
| `rrCount` | Valid RR interval count after artifact rejection |
| `rmssd`, `sdnn` | RR statistics for quality/other physiology |
| `sleepStage` | Modal non-`none` stage string, if supplied |
| `maxGapSeconds` | Largest sample gap in the minute |
| `lastSampleAgeSeconds` | Age of the last sample at minute end |
| `hrCoverage` | Valid HR count divided by 15 |
| `motionCoverage` | Valid motion count divided by 15 |

The backend considers approximately 15 samples per minute fully covered. This
is based on the phone's live upload cadence, not the internal strap sampling
rate.

### 12.2 Validity behavior

Values outside their gates are absent:

```text
HR outside 20...240       -> excluded from HR statistics
motion outside 0...16     -> excluded from motion statistics
RR outside 250...3000     -> rejected by signal-quality statistics
```

The archive normalizer accepts a somewhat wider RR ingestion band
(`200...2500 ms`) so the archive retains valid-looking values for later
processing; `rrStats()` applies the stricter signal-quality gate.

If a minute has neither a valid HR sample nor a valid motion sample, it produces
no feature window and therefore no energy row. The engine does not fill that
minute with a fabricated resting estimate.

### 12.3 RR artifact rejection

RR intervals are processed as follows:

1. reject values outside the RR range;
2. compare each retained interval with the previous retained interval;
3. reject a value if it differs by more than 20%;
4. report the clean count, rejected count, artifact fraction, RMSSD, and SDNN.

RR is not currently used as an independent calorie-rate equation. It helps
explain signal quality and is used by other physiology engines.

## 13. Signal quality and confidence

Quality controls how much an estimator is trusted; it does not alter the raw
feature into a more convenient value.

### 13.1 Channel quality

For HR:

```text
hr_quality = 0.35 + 0.65 × hr_coverage
```

The score is reduced for:

- optical relock jumps above 25 BPM inside 10 seconds;
- HR standard deviation above 18 BPM;
- a reported device quality below `0.6`;
- stale samples beyond the carry threshold;
- missing HR.

For motion:

```text
motion_quality = 0.4 + 0.6 × motion_coverage
```

For RR:

```text
rr_quality =
    clamp(1 - rr_artifact_fraction, 0, 1)
    × clamp(rr_count / 20, 0.3, 1)
```

Overall quality is:

```text
coverage = max(hr_coverage, motion_coverage)

overall =
  clamp(
    0.55 × max(hr_quality, 0.85 × motion_quality)
    + 0.25 × coverage
    + 0.20 × max(hr_quality, rr_quality, motion_quality),
    0,
    1
  )
```

The exact scores are rounded into the persisted row. Quality flags such as
`hr_absent`, `motion_absent`, `hr_jumps`, `hr_unstable`, `rr_artefacts`,
`sample_gap`, and `disconnected` remain attached to the minute for diagnosis.

### 13.2 Model confidence

The final `model_confidence` combines:

```text
45% overall signal quality
25% activity-classifier confidence
20% HR/motion agreement
10% bonus when both channels are available
```

It is constrained to `[0.05, 0.97]`. Confidence is not a guarantee of
accuracy; it is a record of how much usable evidence the model had.

## 14. Activity classification

The classifier is rule-based because the backend receives a scalar motion value,
not a raw multi-axis feature vector.

### 14.1 Motion thresholds

| Name | Threshold |
|---|---:|
| Still | `< 0.02` |
| Fidget | `< 0.06` |
| Ambulatory | `< 0.15` |
| Vigorous | `>= 0.55` |

The scalar is a g-equivalent intensity, not a conventional MET.

### 14.2 Classification priority

The decision order is:

1. strap-reported `stage` plus quiet motion -> `sleep`;
2. a confirmed workout's sport label;
3. an unlabelled workout's HR/motion signature;
4. free-living motion rules with HR-reserve tie breakers;
5. coarse `unknown` when the only channel is insufficient.

Supported activity classes:

```text
sleep
sedentary
standing
walking
running
cycling
strength
workout_other
daily_activity
unknown
```

### 14.3 Sport label mapping

The existing workout record is authoritative for workout membership. Its text
label is mapped by prefix-like regular expressions:

| Label examples | Activity |
|---|---|
| run, jog, treadmill, sprint, trail | `running` |
| cycle, bike, biking, spin, peloton, ergometer | `cycling` |
| lift, weight, strength, resistance, crossfit, powerlift | `strength` |
| walk, hike, ruck, step | `walking` |

The label is used to select the energy model; it does not itself supply a
calorie number.

### 14.4 Free-living rules

Representative rules:

- a quiet wrist with HR reserve above `0.45` becomes `workout_other`, covering
  stationary cycling, rowing, and similar wrist-quiet efforts;
- motion below `0.02` is sedentary when HR reserve is absent or below `0.15`;
- motion between `0.02` and `0.06` is standing/light transition unless the HR
  indicates a clearly elevated effort;
- motion between `0.06` and `0.15` is daily activity;
- motion between `0.15` and `0.55` becomes walking only when sustained for
  most samples; intermittent motion remains daily activity;
- motion at or above `0.55` becomes running when HR reserve is above `0.55`,
  otherwise walking.

These rules prevent both common errors:

- a braced wrist from hiding a hard cycling effort;
- arm-only movement from being priced as whole-body exercise when HR remains
  at rest.

### 14.5 Activity envelopes and channel priors

Each class has a conventional MET envelope and initial HR/motion weights:

| Activity | MET min | MET max | HR prior | Motion prior |
|---|---:|---:|---:|---:|
| sleep | 0.85 | 1.3 | 0.50 | 0.50 |
| sedentary | 1.0 | 1.8 | 0.60 | 0.40 |
| standing | 1.1 | 2.5 | 0.60 | 0.40 |
| walking | 2.0 | 7.0 | 0.60 | 0.40 |
| running | 5.0 | 20.0 | 0.75 | 0.25 |
| cycling | 3.0 | 16.0 | 0.95 | 0.05 |
| strength | 1.5 | 7.0 | 0.45 | 0.55 |
| workout_other | 2.0 | 16.0 | 0.75 | 0.25 |
| daily_activity | 1.0 | 8.0 | 0.60 | 0.40 |
| unknown | 1.0 | 10.0 | 0.70 | 0.30 |

The priors are multiplied by that minute's measured channel quality before
fusion.

## 15. VO₂ estimation

### 15.1 HR channel: below flex HR

The HR channel does not apply the exercise reserve equation to ordinary
resting-range HR changes.

Define:

```text
flex_VO2 = 1.25 × resting_VO2
```

For `HR <= flex_HR`:

```text
t = clamp((HR - resting_HR) / (flex_HR - resting_HR), 0, 1)

VO2_HR =
    resting_VO2 + t × (flex_VO2 - resting_VO2)
```

Thus, a heart rate at rest maps to resting VO₂, while a heart rate at flex maps
to only `1.25 × resting VO₂`.

### 15.2 HR channel: above flex HR

For `HR > flex_HR`:

```text
reserve_above_flex = max(HRmax - flex_HR, 20)

fraction =
    clamp((HR - flex_HR) / reserve_above_flex, 0, 1.15)

excess =
    fraction × max(VO2max - flex_VO2, 5)

VO2_HR =
    flex_VO2 + max(excess, 0)
```

Corrections:

- strength training multiplies the exercise excess by
  `0.60 × strengthCorrection` because pressor response can elevate HR without
  a proportional oxygen cost;
- after 20 contiguous high-effort minutes, the excess is multiplied by
  `clamp(1 - 0.004 × (minutes - 20), 0.9, 1.0)` for cardiovascular drift;
- `hrEfficiency` calibration is applied to the exercise excess;
- a gap or non-effort minute resets the sustained-effort counter.

### 15.3 Motion channel

Motion is mapped to a class-specific piecewise-linear MET table. The
interpolation is flat below the first anchor and above the last anchor.

The current anchors are:

| Activity | Motion-to-MET anchors |
|---|---|
| walking | `(0.05,2.0)`, `(0.15,2.8)`, `(0.25,3.5)`, `(0.40,4.3)`, `(0.60,5.0)`, `(1.00,6.3)` |
| running | `(0.30,6.0)`, `(0.60,8.3)`, `(0.90,9.8)`, `(1.30,11.5)`, `(2.00,14.5)` |
| strength | `(0.02,1.8)`, `(0.10,2.8)`, `(0.25,3.8)`, `(0.50,5.0)`, `(1.00,6.0)` |
| cycling | `(0.02,6.0)`, `(0.20,7.5)`, `(0.60,10.0)` |
| daily activity | `(0.01,1.3)`, `(0.05,1.8)`, `(0.15,2.5)`, `(0.30,3.3)`, `(0.60,4.5)`, `(1.00,5.5)` |
| workout other | `(0.02,3.0)`, `(0.15,4.5)`, `(0.40,6.0)`, `(0.80,8.0)`, `(1.50,11.0)` |
| sedentary | `(0.00,1.0)`, `(0.03,1.3)`, `(0.08,1.6)` |
| standing | `(0.00,1.3)`, `(0.05,1.8)`, `(0.12,2.3)` |
| sleep | `(0.00,0.95)`, `(0.05,1.1)` |

For a motion-derived MET:

```text
VO2_motion = interpolated_MET × 3.5
```

Walking and running can then receive their bounded `walkingEconomy` or
`runningEconomy` calibration multiplier.

The same motion intensity means different things in different classes. For
example, motion `0.1` during cycling can correspond to a hard braced-wrist
effort, while motion `0.1` during walking represents a slow movement. This is
why a single global motion-to-MET curve is not used.

### 15.4 Fusion

Start with activity priors and current-minute quality:

```text
w_hr     = activity_hr_prior     × quality.hr
w_motion = activity_motion_prior × quality.motion
```

If a channel returns `null`, its weight becomes zero.

Then apply the asymmetric failure corrections:

- low motion plus clearly exercising HR -> `w_motion ×= 0.15`;
- strength with HR quality below `0.45` -> `w_hr ×= 0.30`;
- quiet wrist plus modest HR in free living -> cap the HR channel at flex VO₂
  and `w_hr ×= 0.35`;
- trustworthy HR at or below flex -> cap the fused result at
  `1.35 × VO2_HR`, so arm-only movement does not accumulate as exercise.

If both channels remain usable:

```text
VO2_fused =
    (VO2_HR × w_hr + VO2_motion × w_motion)
    / (w_hr + w_motion)
```

If both weights are zero, the minute produces no estimate.

### 15.5 Sleep route

When classification selects `sleep`, the estimator does not let an isolated HR
spike turn sleep into exercise:

```text
VO2_sleep = resting_VO2 × 0.95
```

The minute's resting kcal is also `RMR/1440 × 0.95`, so the active component is
zero unless a different route is selected.

### 15.6 Plausibility clamp

For non-sleep classes, the fused VO₂ is clamped to the activity envelope:

```text
lower = activity_met_min × subject_resting_VO2
upper = activity_met_max × 3.5

VO2_clamped = clamp(VO2_fused, lower, upper)
VO2_final   = max(VO2_clamped, subject_resting_VO2 × 0.95)
```

The floor uses the subject's own resting VO₂. The absolute ceiling uses the
conventional `3.5` MET conversion because it represents an activity capacity
limit.

## 16. VO₂ to calories

This is the only conversion from the internal model to kcal:

```text
kcal_per_min =
    (VO2_mL_per_kg_per_min × weight_kg / 1000)
    × 5.0 kcal_per_litre_O2
```

The factor `5.0 kcal/L O₂` assumes a mixed-substrate RER of approximately
`0.85`. The true value changes with substrate use; FRWHOOP does not currently
measure RER, so the uncertainty is represented in model confidence rather than
inventing a substrate estimate.

Displayed conventional MET is calculated only after VO₂:

```text
display_MET = VO2 / 3.5
```

MET is therefore a display/anchor unit, not an intermediate in the HR
calculation.

### 16.1 Concrete conversion example

For a subject with:

```text
weight       = 78 kg
height       = 180 cm
age          = 32
sex          = male
resting HR   = 52 BPM
```

Mifflin–St Jeor gives:

```text
RMR          = 1750 kcal/day
resting rate = 1.2153 kcal/min
resting VO2  = 3.12 mL/kg/min after the subject-specific calculation
HRmax        = 185.6 BPM by the age fallback
flex HR      = 78.7 BPM
VO2max       = 54.6 mL/kg/min by the Uth fallback
```

At `HR = 150 BPM`, before motion fusion and activity clamping, the HR branch
produces approximately:

```text
VO2_HR          = 37.72 mL/kg/min
total           = 14.71 kcal/min
resting         = 1.22 kcal/min
active          = 13.49 kcal/min
```

The final persisted value can be lower or higher than this branch because the
activity class, motion channel, signal quality, calibration, and class envelope
are applied afterward.

## 17. Minute accounting

`computeEnergyMinutes()` writes one row per estimated minute.

For a non-sleep minute:

```text
resting_kcal = RMR / 1440
```

For a sleep minute:

```text
resting_kcal = RMR / 1440 × 0.95
```

Then:

```text
total_estimated_kcal = kcal_per_min from final VO2
active_kcal          = max(0, total_estimated_kcal - resting_kcal)
```

The persisted minute contains:

```text
minute_at
day
timezone_name
met
resting_kcal
active_kcal
activity_type
activity_confidence
model_confidence
hr
hr_source
motion_intensity
signal_quality
quality_flags
workout_session_id
estimator
algorithm_version
feature_version
model_version
calibration_version
```

The current engine marks `hr_source` as:

```text
measured  when the minute contains valid HR samples
absent    when it does not
```

The database also permits `carried` for other/future producers, but the
current `computeEnergyMinutes()` path does not fabricate a carried sample when
the minute has no HR.

### 17.1 Accounting identity in the production sensor path

The current database migration defines:

```text
energy_minutes.total_kcal = resting_kcal + active_kcal
```

`total_kcal` is a generated Postgres column. The caller cannot send a
conflicting total.

This means:

```text
sensor_total_kcal = resting_kcal + active_kcal
```

It also means active energy is never negative, and no minute can report less
than its resting baseline.

### 17.2 Workout energy is a subset

If a minute falls inside a detected workout:

```text
workout_active_kcal = active_kcal
```

Otherwise:

```text
workout_active_kcal = 0
```

A workout rollup stores both:

```text
net workout kcal   = sum(active_kcal)
gross workout kcal = sum(resting_kcal + active_kcal)
```

The frontend-facing workout number is the net/active value. Adding the workout
number to daily active energy would double count those minutes.

## 18. TEF and the meaning of “total”

There are two related but currently separate accounting concepts.

### 18.1 Current sensor result

The production energy-v1 database path stores:

```text
sensor total = resting + active
```

There is no `tef_kcal` column in `energy_minutes`, and the generated
`total_kcal` column explicitly excludes TEF.

The daily SQL rollup sums those minute totals. The frontend's current
`Energy burned (cal)` value is therefore the sensor-model resting plus active
total, not a nutrition-adjusted TDEE.

### 18.2 Optional accounting extension

`energy/accounting.js` supports a separate canonical accounting shape:

```text
physiological TDEE = resting + active + TEF
```

When nutrition data is complete, TEF can be estimated as ranges of each
macronutrient's kcal:

```text
protein       20–30%
carbohydrate   5–10%
fat            0–3%
```

When only total intake is known, the module has a conservative population prior
around `7...13%` with a `10%` central value. Incomplete logging returns no TEF
estimate rather than implying precision.

This accounting extension is not folded into the current sensor minute rows.
If a future physiological-TDEE display adds TEF, it must add it once at the
daily layer and must not add it to `active_kcal`.

### 18.3 Longitudinal TDEE

`energy/longitudinal.js` is independent of the wearable sensor model. It uses
food intake and body-weight observations in a state-space/Kalman model:

```text
state = [trend_mass, fluid_deviation, tdee]
```

It does not consume sensor calories, preventing circular calibration. Any future
fusion between the sensor and food/weight estimator must account for TEF only
once.

## 19. Daily and workout aggregation

### 19.1 Daily rollup

`aggregateDay()` sums the minute rows:

```text
daily resting_kcal = sum(minute.resting_kcal)
daily active_kcal  = sum(minute.active_kcal)
daily workout_kcal = sum(active_kcal where workout_session_id exists)
daily total_kcal   = daily resting_kcal + daily active_kcal
```

It also records:

```text
average_met
peak_met
high_activity_minutes
moderate_activity_minutes
sedentary_minutes
sleep_minutes
coverage_minutes
gap_minutes
model_confidence
```

Rollups are recomputed from minute rows, never incremented. Re-uploading a
sample, correcting a workout, or re-running a model converges to the same
answer.

### 19.2 Missing minutes

Gaps remain gaps. The engine does not write zero-valued energy rows for an
unobserved period.

The daily result separates:

```text
total_kcal            = measured minute rows only
resting_gap_kcal      = resting-rate projection across missing minutes
projected_total_kcal  = measured total + resting gap only
```

Active energy is never projected into an unmeasured gap.

For “calories so far,” `elapsed_total_kcal` includes resting fill only for
elapsed gaps. It does not include the rest of the future day.

### 19.3 Timezones and daylight saving

Minute timestamps are stored as instants. Day assignment uses the profile's
IANA timezone:

- a spring-forward day has 23 local hours;
- a fall-back day has 25 local hours;
- each observed minute belongs to exactly one local day.

`timezone_name` is stored with the minute and daily rows so historical values
remain interpretable.

### 19.4 Overlapping workouts

A minute can be assigned to only one workout session. If workout spans overlap,
the longest containing span wins deterministically. This prevents a minute from
being counted into two workout totals.

## 20. Persistence and API surface

### 20.1 Postgres minute table

`energy_minutes` is the authoritative derived series:

```text
primary key: (user_id, minute_at)
```

Important columns:

```text
resting_kcal
active_kcal
total_kcal generated as resting_kcal + active_kcal
activity_type
workout_session_id
model_confidence
quality_flags
model_version
feature_version
calibration_version
```

The database checks include:

- resting and active kcal are non-negative;
- active kcal stays within the schema's per-minute bound;
- HR stays in `20...240` when present;
- confidence and signal quality stay in `0...1`;
- activity type is one of the canonical classes.

### 20.2 Daily and workout tables

`energy_daily` is recomputed from `energy_minutes`. Its `workout_kcal` is the
sum of active kcal on workout-tagged minutes and is checked to be no greater
than daily active kcal.

`energy_workouts` is recomputed from the tagged minute rows and stores:

```text
resting_kcal
active_kcal
total_kcal
average_met
peak_met
average_hr
peak_hr
coverage_minutes
confidence
```

### 20.3 Ingestion RPC

The backend sends only minute rows through `engine_ingest_energy()`. The RPC:

1. verifies the backend ingest secret;
2. upserts minute rows;
3. resolves workout session ownership through `sessions`;
4. recomputes affected daily rollups;
5. recomputes affected workout rollups.

The frontend cannot write energy rows directly.

### 20.4 Read API

| Endpoint | Meaning |
|---|---|
| `GET /api/energy/day?day=YYYY-MM-DD` | Daily energy, workouts, 15-minute buckets, live rate |
| `GET /api/energy/range?window=7d\|30d\|3m\|6m\|1y` | Daily energy range |
| `GET /api/energy/workout/:id` | One workout's energy and minute details |

Confirmed values come from Supabase. A current-day or unflushed value can be
returned as `provisional` or `mixed`, but it is computed by the same engine,
not by a simplified phone-only calorie formula.

The live burn-rate result is the average of recent minute totals and is marked:

```text
state = "provisional"
```

## 21. Versioning and recomputation

Every minute carries:

```text
algorithm_version = 1.0.0
feature_version   = feat-1.0.0
model_version     = energy-v1.0.0
calibration_version
```

Raw physiology and raw frames are retained in B2 with manifests, hashes, and
schema versions. Because `computeEnergy()` is pure:

```text
same samples
+ same physiology
+ same workouts
+ same timezone
--------------------------------
= same minute output
```

A historical day can therefore be recomputed after:

- a decoder offset correction;
- a normalization fix;
- an energy model change;
- a new user calibration;
- a late historical upload.

Archives created before the motion/sleep-stage schema addition lack those
fields. A replay of such an archive is honestly HR-only or otherwise
motion-limited, and the limitation is represented in quality/provenance.

## 22. Legacy calorie code versus current energy-v1

The repository still contains evaluation baselines and an older
`estimateCalories()` helper.

The old fixed-MET helper:

```text
sport keyword -> fixed MET
MET           -> 3.5 mL/kg/min
body mass     -> hardcoded 70 kg
```

Its approximate sport values include:

```text
running/HIIT  9.8 MET
swimming      8.0 MET
cycling       7.5 MET
boxing        7.8 MET
walking       3.5 MET
yoga          3.0 MET
other         5.0 MET
```

It does not use per-minute HR, signal quality, subject RMR, or actual user
weight. It is retained for comparison/evaluation and legacy workout records.
It is not the current sensor-derived all-day calorie model described in this
document.

The Keytel HR equation and BMR-multiplier path are also evaluation baselines,
not production output.

## 23. Guarantees and failure behavior

The calorie pipeline is designed around these invariants:

```text
active_kcal >= 0
resting_kcal >= 0
total_kcal = resting_kcal + active_kcal
workout_kcal <= active_kcal
NEAT = active_kcal - workout_active_kcal >= 0
```

Failure behavior:

| Failure | Result |
|---|---|
| Invalid start marker | Frame marked malformed; raw bytes retained |
| Invalid length | Reassembler resyncs; bytes accounted for |
| Header CRC failure | Frame not decoded into physiology |
| Payload CRC32 failure | Frame not decoded into physiology |
| Unknown packet/layout | Raw frame retained; no calorie input |
| HR outside `20...240` | HR treated as absent |
| Motion outside `0...16` | Motion treated as absent |
| No HR and no motion in a minute | No energy row |
| Sparse/disconnected minute | Lower quality and/or gap flags |
| Missing profile RHR | HR channel returns null; motion may still work |
| Missing motion archive field | Recompute can be HR-only |
| Missing nutrition | Sensor total remains resting + active; no invented TEF |

The model does not convert uncertainty into a fake number. A missing signal is
different from a measured zero.

## 24. Current limitations relevant to calories

1. The backend currently receives scalar motion, not a complete raw
   tri-axial/gyroscope feature stream for every minute.
2. Gravity and dynamic acceleration from historical packets are archived but
   are not automatically transformed into the `mot` signal consumed by
   energy-v1.
3. The native historical path does not automatically map every WHOOP sleep
   state byte to the energy classifier's `stage` field.
4. HR-derived VO₂ is estimated from HR reserve and fallback VO₂max; a measured
   VO₂max and measured RMR would be better inputs.
5. Strength HR is physiologically decoupled from oxygen cost and remains the
   weakest class; it receives a pressor correction and tighter envelope.
6. RER is fixed at approximately `0.85`; substrate use is not measured.
7. EPOC is not separately modeled. Post-exercise cost appears only when
   elevated HR is present in subsequent minutes.
8. Sleep uses a flat `0.95 × RMR` rate rather than stage-specific metabolism.
9. Altitude, hydration, temperature load, and other environmental effects are
   not modeled as independent calorie terms.
10. The number is an auditable FRWHOOP estimate, not a claim that the
    proprietary WHOOP calorie algorithm or a metabolic cart was reproduced.

## 25. Source-of-truth files

For implementation changes, update the code and tests alongside this document.

```text
frontend/ios/App/App/WhoopProtocol.swift
frontend/ios/App/App/WhoopBlePlugin.swift
frontend/ios/App/App/SensorQueue.swift

backend/protocol/framing.js
backend/protocol/crc.js
backend/protocol/decoder.js
backend/protocol/whoop5.js

backend/ingest/archiveFormat.js
backend/ingest/hourBuffer.js
backend/ingest/historyBuffer.js
backend/host/routes.js

backend/energy/constants.js
backend/energy/physiology.js
backend/energy/features.js
backend/energy/activity.js
backend/energy/estimators.js
backend/energy/engine.js
backend/energy/service.js
backend/energy/accounting.js
backend/energy/longitudinal.js

backend/tests/energy.test.js
backend/tests/energyE2E.test.js
backend/tests/protocol/framing.test.js
backend/tests/protocol/decoder.test.js
backend/tests/protocol/whoop5Parity.test.js

backend/docs/ENERGY_MODEL.md
backend/docs/ENERGY_ACCOUNTING.md
backend/docs/ENERGY_EXPENDITURE_ARCHITECTURE.md
supabase/migrations/20260825120000_energy_expenditure.sql
```

## 26. Short formula summary

```text
1. Decode and CRC-gate the BLE frame.
2. Extract valid HR and/or scalar motion.
3. Resolve RMR, resting HR, HRmax, VO₂max, flex HR, and body weight.
4. Bucket samples into a minute and score quality.
5. Classify sleep, sedentary, daily activity, walking, running, cycling,
   strength, or another workout class.
6. Estimate VO₂ from flex-HR and/or motion-MET anchors.
7. Fuse channels using activity priors × minute quality.
8. Apply asymmetric wrist/HR corrections and activity plausibility clamps.
9. Convert:

       kcal/min = VO₂ × weight_kg / 1000 × 5.0

10. Split:

       resting_kcal = RMR/1440, or 0.95 × RMR/1440 during sleep
       active_kcal  = max(0, total_kcal - resting_kcal)

11. Define workout kcal as active kcal on workout-tagged minutes.
12. Persist and recompute rollups from minute rows.
13. Keep TEF separate; it is not included in the current sensor total.
```
