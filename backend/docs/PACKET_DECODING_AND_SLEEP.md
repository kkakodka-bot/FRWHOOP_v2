# FRWHOOP packet decoding, sensor bytes, and sleep analytics

This is the implementation reference for how FRWHOOP turns WHOOP BLE bytes into
sensor samples, sleep sessions, stages, naps, and derived scores.

It covers:

- WHOOP 4.0 and WHOOP 5.0/MG BLE families
- raw-byte capture, frame reassembly, CRC validation, and field decoding
- historical backfill and live heart-rate ingestion
- automatic sleep-period detection
- four-class sleep staging
- nap detection
- overnight physiology, sleep scores, recovery, confidence, and persistence

This document describes FRWHOOP's current code, not WHOOP's private production
algorithms. The sleep and staging algorithms are independent implementations
> **Note.** The sleep/staging/nap/score chapters below are current. The
> decoder-version table and packet-decoding chapters (1–11) predate the
> `frwhoop-gen5/2` decoders — the authoritative decoder lineage and packet
> status now live in [`PROTOCOL_COVERAGE.md`](./PROTOCOL_COVERAGE.md).
based on open research, the NOOP reference implementation, and FRWHOOP's
validated captures. They are not an official WHOOP algorithm reproduction and
are not a medical device.

## Current algorithm and decoder versions

| Area | Current identifier |
|---|---|
| Backend packet decoder | `frwhoop-js/1` |
| WHOOP 5 deep-decoder lineage | `frwhoop-js/1 <- noop@ab0f699e` |
| iOS capture/interpreter | `frwhoop-whoop-ble/3` |
| Sleep score | `2.0.2-hybrid-sleep` |
| Sleep-period detection | `hybrid-hdcza-boundaries-v3` |
| Sleep staging | `noop-sleep-stager-v2-v1` |
| Nap detector | `nap-detector-v1` |
| Step aggregation | `frwhoop-steps-v1` |
| Skin-temperature aggregation | `frwhoop-skin-temp-v1` |

The iOS and Node decoders are separate implementations. Raw bytes, frame
hashes, decoder identifiers, family, layout, and sample timestamps are kept so
their outputs can be compared and re-decoded later.

## End-to-end data flow

```text
WHOOP sensor
    │
    ├─ standard BLE 0x2A37 heart-rate notifications
    ├─ standard BLE 0x2A19 battery reads/notifications
    └─ vendor BLE notifications
           │
           ▼
iOS CoreBluetooth
    │  write Level A raw notification before parsing
    ▼
SensorQueue
    ├─ ble-frames.ndjson              raw ATT notification bytes
    ├─ sensor-queue.ndjson            live HR/RR/motion samples
    ├─ historical-physiology.ndjson  decoded per-second history
    └─ gaps.ndjson                    connection/data-gap ledger
           │
           ▼
LiveUploadSession → POST /api/ble/live
           │
           ▼
backend ingest
    ├─ frame reassembly and validation
    ├─ historyBuffer: sensor-time history queue
    ├─ hourBuffer: raw samples and frame archive queue
    └─ B2 Level B / physiology archives
           │
           ▼
metrics engine
    ├─ normalize and quality-gate signals
    ├─ detect sleep and naps
    ├─ stage 30-second epochs
    ├─ calculate sleep, HRV, respiration, recovery, strain, steps, temperature
    └─ persist metric envelopes and daily series to Supabase
```

The invariant is:

> A byte may be unknown, malformed, or CRC-invalid, but it must not silently
> disappear.

## 1. Vocabulary and byte conventions

### 1.1 Capture levels

| Level | Meaning | Typical storage |
|---|---|---|
| Level A | One raw BLE ATT notification exactly as delivered by CoreBluetooth | `ble-frames.ndjson` and B2 capture archive |
| Level B | A complete protocol frame reconstructed from one or more notifications | B2 frame archive |
| Decoded record | A versioned interpretation of a verified Level B frame | history queue, physiology archive, database |
| Metric projection | Derived sleep, recovery, strain, or daily physiology output | Supabase and API |

Level A is the source of truth for reassembly. Level B is the source of truth
for replaying a complete frame. A decoded record is never a replacement for the
raw evidence.

### 1.2 Integer and floating-point readers

Unless a layout says otherwise, multi-byte values are little-endian.

| Encoding | Bytes | Interpretation |
|---|---:|---|
| `u8` | 1 | unsigned integer, `0..255` |
| `i8` | 1 | signed two's-complement integer |
| `u16 LE` | 2 | `b0 \| (b1 << 8)` |
| `i16 LE` | 2 | read as `u16`, then reinterpret two's-complement |
| `u32 LE` | 4 | unsigned Unix seconds or counter |
| `i32 LE` | 4 | signed two's-complement integer |
| `f32 LE` | 4 | IEEE-754 float, little-endian |
| `s24 LE` | 3 | signed 24-bit two's-complement value |

Signed 24-bit decoding is sign extension:

```text
v = b0 | (b1 << 8) | (b2 << 16)
if b2 & 0x80:
    v = v | 0xFF000000
```

Raw counts are not automatically physical measurements. A field is only
converted when its layout, scale, and validity gates are known.

### 1.3 Time

- Strap timestamps are normally Unix seconds.
- `subseconds` is retained as a separate field.
- Raw sensor timestamps are stored as absolute UTC instants.
- A phone/server receive time is retained separately and is not silently
  substituted for sensor time.
- Historical clock correction is a bounded constant-offset correction, not
  arbitrary re-dating.

## 2. BLE families and GATT topology

### 2.1 WHOOP 4.0 — Harvard

Primary vendor service:

```text
61080001-8d6d-82b8-614a-1c8cb0f8dcc6
```

| Role | Characteristic |
|---|---|
| Command write | `61080002-...` |
| Command-response notify | `61080003-...` |
| Event notify | `61080004-...` |
| Data notify, fragmented | `61080005-...` |

### 2.2 WHOOP 5.0 / MG — Puffin

Primary vendor service:

```text
fd4b0001-cce1-4033-93ce-002d5875f58a
```

| Role | Characteristic |
|---|---|
| Command write | `fd4b0002-...` |
| Notify channel | `fd4b0003-...` |
| Notify channel | `fd4b0004-...` |
| Notify channel | `fd4b0005-...` |
| Notify channel | `fd4b0007-...` |

WHOOP 5.0 and MG share the Puffin framing family. MG hardware capabilities are
separate from the framing decision; hardware identity must not change how a
frame is parsed.

### 2.3 Standard SIG services

Both families may expose:

| Service | Characteristic | Use |
|---|---|---|
| Heart Rate `180D` | Measurement `2A37` | HR and RR intervals |
| Battery `180F` | Battery Level `2A19` | battery percentage |
| Device Information `180A` | model/firmware fields | model and firmware hints |

The standard heart-rate service can work before the vendor channel is bonded.
The vendor stream is still needed for historical data, device events, and
family-specific records.

## 3. Standard heart-rate bytes (`0x2A37`)

The first byte is a flags byte.

| Flag | Mask | Meaning |
|---|---:|---|
| HR format | `0x01` | `0`: one-byte HR; `1`: `u16 LE` HR |
| Sensor contact | `0x02` | retained by the BLE standard but not used as the primary sleep gate |
| Energy expended | `0x08` | skip two bytes when set |
| RR present | `0x10` | remaining pairs are RR intervals |

Parsing:

1. Read `flags`.
2. Read HR at offset `1` as `u8`, or offsets `1..3` as `u16 LE`.
3. If `flags & 0x08`, skip the two-byte energy-expended field.
4. If `flags & 0x10`, read each remaining `u16 LE` RR value.
5. Convert the BLE unit of `1/1024` second to milliseconds:

```text
rr_ms = round(raw_rr * 1000 / 1024)
```

Only HR values from `20..240` bpm and RR values from `200..2500` ms are
accepted into normalized physiology streams. Invalid values are not turned into
zeros.

When custom type-40 HR is actively arriving, iOS treats it as canonical and
does not persist duplicate `2A37` rows. The standard channel remains subscribed
as a fallback.

## 4. Frame envelopes

A complete frame starts with `0xAA`, contains a family-specific header, contains
an inner protocol record, and ends with a CRC32 trailer.

The two families are not interchangeable four-byte shifts. They differ in
length location, header checksum, and trailer arithmetic.

### 4.1 WHOOP 4.0 frame

```text
offset  size  field
------  ----  -----------------------------------------
0       1     SOF = 0xAA
1       2     length u16 LE
3       1     header CRC8
4       ...   inner record
length  4     payload CRC32 u32 LE
```

The length is:

```text
length = inner_record_bytes + 4
total_frame_bytes = length + 4
```

The inner record begins at offset `4`:

```text
[type][seq][command or record-specific byte][payload...]
```

Validation:

```text
crc8_ok  = CRC8(frame[1:3]) == frame[3]
crc32_ok = CRC32(frame[4:length]) == u32le(frame, length)
ok       = crc8_ok && crc32_ok
```

The CRC8 uses polynomial `0x07`, initial value `0x00`.

Common offsets:

| Field | Offset |
|---|---:|
| packet type | `4` |
| envelope sequence/version | `5` |
| command for type 35 | `6` |
| generic realtime timestamp | `6` |
| generic realtime subseconds | `10` |
| generic realtime HR | `12` |
| generic realtime RR-count hint | `13` |

Some irregular packet layouts have their own offsets. A generic offset must not
be applied to every packet type.

### 4.2 WHOOP 5.0 / MG frame

```text
offset  size  field
------  ----  -----------------------------------------
0       1     SOF = 0xAA
1       1     format = 0x01
2       2     declared length u16 LE
4       2     header bytes
6       2     header CRC16-Modbus u16 LE
8       ...   inner record
total-4 4     payload CRC32 u32 LE
```

The declared length is:

```text
declared_length = inner_record_bytes + 4
total_frame_bytes = declared_length + 8
payload_end = total_frame_bytes - 4
```

Validation:

```text
header_crc_ok = CRC16_Modbus(frame[0:6]) == u16le(frame, 6)
crc32_ok      = CRC32(frame[8:payload_end]) == u32le(frame, payload_end)
ok            = header_crc_ok && crc32_ok
```

The CRC16 uses polynomial `0xA001`, initial value `0xFFFF`, reflected
Modbus processing.

The inner record begins at offset `8`:

```text
[type][seq][command or record-specific byte][payload...]
```

Common offsets:

| Field | Offset |
|---|---:|
| packet type | `8` |
| envelope sequence/version | `9` |
| generic realtime timestamp | `10` |
| generic realtime subseconds | `14` |
| generic realtime HR | `16` |
| generic realtime RR-count hint | `17` |

Puffin command payloads are padded to a four-byte inner-record boundary before
the CRC32 is calculated. Padding bytes are not semantic values.

### 4.3 CRC algorithms

| Check | Family | Covered bytes | Polynomial/parameters |
|---|---|---|---|
| CRC8 | WHOOP 4 | two length bytes | `0x07`, init `0x00` |
| CRC16-Modbus | WHOOP 5/MG | first six header bytes | `0xA001`, init `0xFFFF` |
| CRC32 zlib | both | inner payload only | reflected `0xEDB88320`, final XOR |

CRC32 is the payload-integrity gate. A CRC-invalid frame is never allowed to
produce a high-confidence physiological value or advance the historical trim
cursor.

## 5. Fragment reassembly

BLE notifications are MTU-sized fragments. A frame can be split:

- between any two bytes
- across multiple notifications
- with multiple complete frames in one notification
- with leading garbage or a corrupt SOF

There is one reassembly buffer per stream characteristic. Concurrent channels
must not share a buffer because fragments from two channels cannot be
interleaved safely.

The algorithm is:

1. Append the notification bytes to the family/channel buffer.
2. Find the next `0xAA`.
3. Account for and skip bytes before that SOF.
4. Wait until the family-specific length header is available.
5. Calculate the total frame size.
6. Reject an impossible size above `8192` bytes and advance one byte to resync.
7. Wait if the complete frame has not arrived.
8. Emit exactly one complete frame.
9. Repeat in case more frames are buffered.
10. Compact the consumed buffer.

On disconnect, a partial frame is discarded from the reassembly buffer, but the
original notifications remain in Level A. The discarded count is recorded as an
incomplete-frame condition.

The backend implementation is `backend/protocol/framing.js`; the iOS
implementation is the `rxBufs`, `popFrame`, and `ingest` path in
`frontend/ios/App/App/WhoopBlePlugin.swift`.

## 6. Frame verification and decoder contract

`decodeFrame()` is a non-throwing, versioned interpretation layer. It receives a
complete frame and returns raw lineage even when the interpretation fails.

Every result carries, where available:

```text
decode_status
confidence
packet_type
packet_name
version
family
crc_ok / crc8_ok / crc32_ok
raw_hex
raw_length
frame_hash
decoder
decoded
```

### 6.1 Decoder statuses

| Status | Meaning |
|---|---|
| `malformed` | no usable SOF or insufficient structural bytes |
| `crc_failed` | packet was classifiable but failed its envelope check |
| `unknown` | valid frame, packet/version not semantically mapped |
| `classified` | packet family/type is known but fields remain partly opaque |
| `partial` | a recognized structure exists but required fields are absent |
| `decoded` | known fields passed their structural and physiological gates |

Unknown and CRC-failed frames remain evidence. They are never silently converted
to an empty sample.

### 6.2 Frame hash and lineage

The backend computes SHA-256 over the exact frame bytes. A decoded record can
therefore be traced:

```text
raw BLE notification
  → reassembled frame
  → frame_hash
  → decoder version
  → decoded fields
  → normalized physiology sample
  → metric output
```

When a field map improves, the redecode pipeline can replay the same Level A
archive without needing the strap again.

## 7. Packet types

The packet type is at offset `4` for Harvard and offset `8` for Puffin.

| Type | Name | Role |
|---:|---|---|
| 35 | `COMMAND` | outbound command |
| 36 | `COMMAND_RESPONSE` | reply to a command |
| 37 | `PUFFIN_COMMAND` | WHOOP 5 command form |
| 38 | `PUFFIN_COMMAND_RESPONSE` | WHOOP 5 response form |
| 40 | `REALTIME_DATA` | live HR and realtime metadata |
| 43 | `REALTIME_RAW_DATA` | high-rate IMU or optical stream |
| 47 | `HISTORICAL_DATA` | stored per-second or bulk sensor data |
| 48 | `EVENT` | device event |
| 49 | `METADATA` | historical offload control |
| 50 | `CONSOLE_LOGS` | firmware log data |
| 51 | `REALTIME_IMU_DATA_STREAM` | classified, not broadly mapped |
| 52 | `HISTORICAL_IMU_DATA_STREAM` | classified; Puffin can route known layouts |
| 53 | `RELATIVE_PUFFIN_EVENTS` | classified, not broadly mapped |
| 54 | `PUFFIN_EVENTS_FROM_STRAP` | classified, not broadly mapped |
| 55 | `RELATIVE_BATTERY_PACK_CONSOLE_LOGS` | classified, not broadly mapped |
| 56 | `PUFFIN_METADATA` | WHOOP 5 metadata alias |

All packet types are captured and reassembled even when their semantic decoder
is incomplete.

## 8. Realtime packet decoding

### 8.1 Type 40 — `REALTIME_DATA`

The current generic decode extracts:

- sensor timestamp
- subsecond field
- one-byte HR
- RR-count hint

HR is accepted only when it is in `20..240` bpm. The custom type-40 stream is
the preferred live HR source when it is fresh.

The type-40 packet is not assumed to contain a complete RR series. On many
captures the RR-count hint is zero. RR intervals from standard `0x2A37` and
historical records remain important for HRV and respiration.

### 8.2 Type 43 — `REALTIME_RAW_DATA`

Type 43 is variant-dependent and is not decoded by pretending all bytes are one
simple sensor layout.

#### WHOOP 4 variant `1917` — IMU

Known structure:

| Field | Offset |
|---|---:|
| HR | `21` |
| RR count | `22` |
| RR values | `23`, two bytes each |
| accel X, 100 `i16` samples | `89` |
| accel Y, 100 `i16` samples | `289` |
| accel Z, 100 `i16` samples | `489` |
| gyro X, 100 `i16` samples | `692` |
| gyro Y, 100 `i16` samples | `892` |
| gyro Z, 100 `i16` samples | `1092` |
| unmapped tail begins | `1292` |

Known scales:

```text
accel_g = raw_i16 * (1 / 4096)
gyro_dps = raw_i16 * (2000 / 32768)
sample rate = 100 Hz
```

The tail is retained as raw bytes. It is not assigned a medical or optical
meaning.

#### WHOOP 4 variant `1921` — optical

Known structure:

```text
config header: bytes [15:42]
samples: 419 signed-24-bit values
sample stride: 4 bytes
sample start: byte 42
sample rate: approximately 437 Hz
```

The fourth byte in each four-byte slot is retained as an auxiliary byte with
unknown semantics. The waveform is called an optical/raw waveform, not an
official oxygen or diagnostic measurement.

#### WHOOP 5/MG type 43

Puffin has the four-byte envelope shift. FRWHOOP detects the known structure at
the shifted offsets rather than assuming a fixed WHOOP 4 length:

| Field | WHOOP 5/MG offset |
|---|---:|
| HR | `25` |
| RR count | `26` |
| RR values | `27` onward |
| accel X | `93` |
| accel Y | `293` |
| accel Z | `493` |
| gyro X | `696` |
| gyro Y | `896` |
| gyro Z | `1096` |

The output includes a structural variant, offsets, sample counts, scales, and
unmapped tails. It does not assign uncertain channels a medical label.

### 8.3 Raw stream limitations

High-rate IMU and optical arrays are too large and too irregular for the normal
per-second database table. They are archived to B2 and only selected
projections are sent to the metrics layer.

A signal can therefore be:

1. received from the strap,
2. preserved raw,
3. structurally decoded,
4. not yet semantically identified,
5. not used by a production metric.

Those are different states and must not be collapsed into “missing.”

## 9. Historical packet decoding

Type 47 is selected by its envelope sequence byte:

- Harvard: version at frame byte `5`
- Puffin: version at frame byte `9`

### 9.1 WHOOP 5 v18 — per-second summary

The known frame-absolute fields are:

| Field | Offset | Decode |
|---|---:|---|
| record index | `11` | `u32 LE` |
| Unix timestamp | `15` | `u32 LE` |
| heart rate | `22` | `u8`, valid `20..240` or zero/off-wrist |
| RR count | `23` | `u8`, max four used |
| RR intervals | `24` | `u16 LE` milliseconds |
| cardiac flags | `33` | raw `u8` |
| HR quality flags | `36` | raw `u8` |
| alternate HR | `37` | raw `u8` |
| packed RR | `38` | `u16 LE` |
| cardiac status | `40` | raw `u8` |
| dynamic acceleration | `41` | `f32 LE`, accepted `0..8` |
| gravity X/Y/Z | `45/49/53` | `f32 LE`, validated as gravity |
| cumulative step counter | `57` | `u16 LE` |
| cadence-like field | `59` | raw `u8` |
| activity class | `63` | `0` still, `1` walk, `2` run |
| skin temperature raw | `73` | `u16 LE`, Celsius = raw / 100 |
| sleep state byte | `81` | packed state fields |
| auxiliary byte | `82` | raw; SpO2 candidate only |

The v18 sleep-state byte is unpacked as:

```text
sleep_state = (byte >> 4) & 0x03
onwrist      = byte & 0x03
wake_quality = (byte >> 2) & 0x03
```

The byte at offset `82` is retained as `aux_byte_82`. A value in the observed
`70..100` range may be exposed as `spo2_candidate_82`, but it is explicitly
instrumentation, not a validated blood-oxygen measurement.

The v18 gravity vector is accepted only when:

- each axis is finite and within `±8 g`
- vector magnitude is within `0.5..1.5 g`

Skin temperature is accepted only when the converted value is within `5..45 °C`.
It is skin temperature, not core/body temperature.

### 9.2 WHOOP 5 v20 — bulk optical blocks

The known v20 body is approximately `2140` bytes:

```text
5 blocks
block start: 26 + block_index * 422
block header: 21 bytes
two channel slots per block
slot length: 200 bytes
maximum samples per channel: 50
sample width: i32 LE
```

The channel names remain neutral (`channel_b{block}_{slot}`), because
wavelength and physical identity are not pinned by the current decoder.

### 9.3 WHOOP 5 v21 — six-axis bulk IMU

The known v21 body is `1244` bytes:

| Channel | First offset | Samples |
|---|---:|---:|
| accel X | `28` | 100 `i16` |
| accel Y | `228` | 100 `i16` |
| accel Z | `428` | 100 `i16` |
| gyro X | `640` | 100 `i16` |
| gyro Y | `840` | 100 `i16` |
| gyro Z | `1040` | 100 `i16` |

The backend keeps the raw arrays. The iOS historical projection computes the
mean accel axes with:

```text
gravity_g = mean(raw_i16) / 4096
```

and applies the same gravity validity gate before emitting a normalized
historical sample.

### 9.4 WHOOP 5 v26 — raw optical history

Known v26 structure:

```text
record index: u32 at 11
Unix timestamp: u32 at 15
burst index: u8 at 21
24 signed i16 waveform samples at bytes [27:75]
one historical record per second
```

The backend labels this `ppg_waveform` and preserves the raw samples. The
backend's current respiration engine does not silently use these samples as a
second estimator; the PPG-derived estimators are declared but unavailable until
the waveform path is intentionally connected.

### 9.5 WHOOP 4 historical versions

The backend redecode path currently provides version/header interpretation for
the known WHOOP 4 versions (`5`, `7`, `9`, `12`, and `24`) rather than assigning
all of them the WHOOP 5 v18 map.

The current iOS live historical projection has typed handlers for:

- Harvard v24: timestamp, HR, RR, and gravity
- Harvard v25: timestamp and scaled gravity-only records

This difference is intentional: iOS and backend semantic coverage are tracked
separately, while both retain raw bytes.

### 9.6 Type 48 — events

For Puffin:

| Field | Offset |
|---|---:|
| event number | `10` |
| event timestamp | `12`, `u32 LE` |
| battery raw percentage | `21`, for battery events |
| battery millivolts | `25`, for battery events |
| charging flag | `30`, for battery events |

Known event numbers include:

| Number | Event |
|---:|---|
| 3 | battery level |
| 9 | wrist on |
| 10 | wrist off |
| 11/12 | BLE connection up/down |
| 14 | double tap |
| 15 | boot |
| 17 | temperature level |
| 40/41 | optical saturation |
| 42 | accelerometer saturation |
| 46/47 | raw collection on/off |
| 63 | extended battery information |
| 96/97/98 | high-frequency sync prompt/on/off |

Unknown event numbers remain raw.

### 9.7 Type 49/56 — historical metadata

Metadata type is:

| Value | Meaning |
|---:|---|
| 1 | `HISTORY_START` |
| 2 | `HISTORY_END` |
| 3 | `HISTORY_COMPLETE` |

For Puffin, the current metadata decoder reads:

| Field | Offset |
|---|---:|
| metadata type | `10` |
| Unix timestamp | `11` |
| subseconds | `15` |
| trim cursor | `21` |
| eight-byte `end_data` | `21..29` |

Type 56 is the Puffin metadata alias and uses the same metadata interpretation.

### 9.8 Type 36/38 — command responses

For Puffin, the response command is at `10`; the response payload begins at
`11`. The response payload starts with:

```text
payload[0] = response sequence
payload[1] = result
```

| Result | Meaning |
|---:|---|
| 0 | failure |
| 1 | success |
| 2 | pending |
| 3 | unsupported |

Value fields are interpreted only for a successful response. This prevents
padding or failure bytes from being mistaken for battery percentage, clock, or
range data.

Known successful response projections include:

- command `26`: battery percentage
- command `34`: plausible oldest/newest historical timestamps
- command `145`: device name and firmware fields when structurally present
- read-only config probes: echoed key and the value byte after its padded name

### 9.9 Type 50 — console logs

The decoder extracts record index, Unix time, subseconds, and a UTF-8 log body.
The log body is capped at 2048 characters. It is diagnostic text, not a
physiology channel.

## 10. Outbound frames and historical offload

### 10.1 Harvard command frame

The iOS builder forms:

```text
inner = [35, sequence, command] + payload
length = inner.length + 4
frame = [0xAA, length_le, CRC8(length_le)] + inner + CRC32(inner)_le
```

### 10.2 Puffin command frame

The iOS builder forms:

```text
inner = [35, sequence, command] + payload
inner += zero padding until inner.length is divisible by 4
declared = inner.length + 4
header = [0xAA, 0x01, declared_le, 0x00, 0x01]
frame = header + CRC16_Modbus(header)_le + inner + CRC32(inner)_le
```

The static Puffin client hello is a complete frame:

```text
aa 01 08 00 00 01 e6 71 23 01 91 01 36 3e 5c 8d
```

### 10.3 Connect lifecycle

At a high level:

1. Discover the Harvard or Puffin service.
2. Discover command and notify characteristics.
3. Bond using the family-specific benign handshake.
4. Enable the live HR stream.
5. Set/read the strap clock correlation.
6. Request historical data.
7. Repeat historical sync periodically while connected.

The WHOOP 4 path uses a confirmed battery command as the bonding write. The
WHOOP 5 path writes the static Puffin hello. Handshake state is one-shot per
connection; repeatedly sending the handshake during a backfill can interfere
with type-47 streaming.

### 10.4 Historical state machine

The main historical request is command `22` with payload `[0x00]`.

```text
SEND_HISTORICAL_DATA
        │
        ▼
HISTORY_START
        │
        ├─ type-47 historical records
        ├─ HISTORY_END(end_data)
        │       │
        │       ├─ persist decoded records
        │       ├─ persist raw records when enabled
        │       ├─ persist trim cursor
        │       └─ acknowledge with command 23
        │
        └─ HISTORY_COMPLETE
```

The trim acknowledgement is command `23`:

```text
[success = 1] + end_data[8 bytes]
```

The safe-trim invariant is:

```text
decode → durable local insert → durable raw enqueue → durable trim cursor → ack
```

If persistence fails, FRWHOOP does not acknowledge the `HISTORY_END`. The strap
therefore does not trim data that FRWHOOP cannot prove it stored.

## 11. Durable capture and redecode

### 11.1 iOS queue order

For every related notification:

1. CoreBluetooth delivers bytes.
2. `SensorQueue.appendNotify()` writes the full hex payload and metadata.
3. Only after that succeeds does the stream enter reassembly.
4. Complete frames are verified and interpreted.
5. Historical samples and live samples are appended to their own durable queues.
6. The upload session sends pending prefixes to the backend.
7. The queue removes only prefixes explicitly acknowledged by the backend.

The raw notification row includes:

```text
schema, kind, seq, t, family, char, hex, n, decoder
```

`hex` is the complete payload and `n` is the original byte count. It is not
truncated to a debug prefix.

### 11.2 Live upload

`LiveUploadSession` uses a persistent background `URLSession` and a stable
upload task identifier. Payloads are written to Application Support before the
upload starts. Samples, frames, history samples, and gap IDs remain queued until
the backend returns a successful acknowledgement.

The endpoint is:

```text
POST /api/ble/live
```

### 11.3 Backend buffers

| Component | Responsibility |
|---|---|
| `ingest/live.js` | live buffer and flush coordination |
| `ingest/historyBuffer.js` | sensor-time historical queue, dedupe, clock correction |
| `ingest/hourBuffer.js` | raw sample/frame hourly buffering and B2 archive flush |
| `metrics/engine.js` | normalize, compute, and persist derived metrics |
| `redecode/redecode.js` | replay Level A rows through reassembly and decoding |
| `redecode/archive.js` | write Level B reassembled frames |

High-rate arrays remain in B2 archives. Per-second projections used by sleep and
daily metrics are normalized into the metrics pipeline.

### 11.4 Clock correction

The strap RTC can be lost or can drift from the phone. FRWHOOP:

- retains strap time and receive time separately,
- detects duplicates, backward time, and impossible gaps,
- uses a constant offset only when a trustworthy reference exists,
- rejects small offsets as ordinary delayed backfill,
- bounds historical correction to a plausible range,
- does not repair missing samples by interpolation.

The historical helper treats an offset smaller than seven days as ordinary
delayed delivery and rejects offsets beyond twenty years. Callers apply
additional plausibility floors and consistency checks.

### 11.5 Dedupe

Deduplication is based on the appropriate identity:

- raw frames: frame sequence and/or frame hash at the archive layer,
- live samples: local sequence and timestamp guards,
- historical samples: device timestamp and history identity,
- steps and temperature: one value per device second,
- RR intervals: preserve the source row/index relationship during artifact
  filtering.

## 12. Sleep input normalization

`extractSleepStreams()` turns heterogeneous rows into four sorted streams:

```text
gravity: [{ ts, x, y, z }]
hr:      [{ ts, bpm }]
rr:      [{ ts, rrMs }]
bandSleepState: [{ ts, state }]
```

Accepted timestamp fields are `t`, `datetime`, `at`, `ts`, and `timestamp`.
Numeric timestamps larger than `1e12` are treated as milliseconds; other numeric
timestamps are treated as seconds.

Accepted gravity aliases include:

```text
gravity.{x,y,z}
accel.{x,y,z}
accelerometer.{x,y,z}
gx/gy/gz
gravity_x/gravity_y/gravity_z
accel_x/accel_y/accel_z
```

Input gates:

- HR: `20..240` bpm
- RR: `200..2500` ms
- band sleep state: integer `0..3`
- gravity: finite triplet; source decoders additionally apply magnitude gates

The sleep detector does not require every modality on every second. It tracks
coverage and confidence instead of filling absent sensors with defaults.

## 13. Autosleep: automatic sleep-period detection

FRWHOOP autosleep is a layered detector. It does not mean “HR below one fixed
number equals sleep.” The primary evidence is wrist orientation/movement from
gravity, with HR, wear state, time of day, and optional strap sleep-state
information used as confirmation and guards.

The primary detector is implemented in:

```text
backend/metrics/sleepDetection.js
backend/metrics/vanHeesSleep.js
backend/metrics/hdczaSleep.js
```

### 13.1 Coverage classification

Before choosing an algorithm, FRWHOOP calculates:

- gravity sample count,
- unique gravity seconds,
- gravity span,
- largest gravity gap,
- gravity coverage ratio,
- HR span,
- whether gravity covers less than half the HR span,
- whether any gravity gap exceeds twenty minutes.

Gravity coverage is `sufficient` when there are at least three gravity samples
spanning at least sixty minutes. It is `sparse` when the span is too short
relative to HR or a gap exceeds twenty minutes. Only sufficient, non-sparse
gravity is considered `adequate`.

This classification prevents two isolated gravity vectors from being treated as
proof that a person was continuously asleep.

### 13.2 Dense path: van Hees rest bouts

When gravity is dense, FRWHOOP first tries the van Hees-style rest-bout
detector.

#### Step A: resample

Gravity is sorted and placed on a one-Hz grid. Missing seconds are marked
invalid; they are not interpolated.

The available span must be at least five minutes and no more than three days for
the helper. The sleep-session detector later restricts a main candidate to a
maximum sixteen-hour span.

#### Step B: calculate wrist z-angle

For each gravity vector:

```text
z_angle_degrees = atan2(z, sqrt(x² + y²)) * 180 / π
```

The angle is smoothed with a five-second rolling median.

#### Step C: calculate immobility

For each candidate start, inspect the following five minutes:

- maximum smoothed angle change must remain below `5°`,
- the full five-minute window must exist,
- no invalid gravity sample may occur in the window.

This is a sustained inactivity assertion, not a polysomnography sleep label.

#### Step D: bridge and form bouts

Adjacent immobile runs are bridged across gaps shorter than thirty minutes.
Each resulting rest bout includes:

```text
onsetSec
offsetSec
sptSec
confidence
```

A bout must be longer than sixty minutes to be eligible for overnight
acceptance. A maximum sixteen-hour span is enforced.

### 13.3 Gravity fallback: delta stillness

If van Hees does not find a sustained bout, FRWHOOP uses a lower-level
gravity-delta path:

```text
delta = sqrt((x - previous_x)² + (y - previous_y)² + (z - previous_z)²)
still when delta < 0.01 g
```

Stillness is evaluated over a fifteen-minute window. At least seventy percent of
the available transitions must be still. Runs shorter than fifteen minutes can
be merged with neighboring runs. A gap over twenty minutes closes a run unless
the sparse-gravity HR bridge rule applies.

The detector label is:

```text
gravity_delta
```

### 13.4 Sparse gravity fallback

When gravity is sparse, FRWHOOP uses the same general stillness concept but
requires HR support to bridge a large gap. The detector label is:

```text
sparse_gravity_hr_vouched
```

This path is deliberately lower confidence. It can produce a useful session
when the strap delivered intermittent gravity, but it does not claim the same
certainty as continuous gravity.

### 13.5 HR confirmation

The HR baseline used by the main detector is the median HR across the available
HR stream.

For a candidate with at least thirty HR samples:

```text
median(candidate HR) <= baseline * 1.05
```

is required.

If the gravity posture is deeply quiescent for at least twenty judged minutes,
with at least ninety percent of judged minutes under posture variance
`0.05 g²`, the HR multiplier may widen to `1.30`. This prevents a motionless
person with an elevated but steady HR from being rejected solely because of
illness, stress, or an individual baseline.

With fewer than thirty HR samples, HR confirmation does not reject the candidate
by itself; the uncertainty is carried into confidence and coverage.

### 13.6 Wear and off-wrist rejection

Off-wrist evidence comes from:

- explicit wrist-off intervals, and
- long HR gaps when the surrounding HR stream is dense enough to make the gap
  meaningful.

The inferred/explicit off-wrist spans are unioned. A candidate is rejected when
off-wrist time is at least fifty percent of the candidate.

If the entire HR stream is itself too sparse, FRWHOOP avoids interpreting every
missing HR interval as off-wrist. Lack of data is recorded as lack of coverage,
not automatically as non-wear.

### 13.7 Daytime and morning guards

The midpoint of a candidate is converted to local time using the supplied
timezone offset.

Daytime candidates are those whose midpoint is within:

```text
11:00 <= local hour < 20:00
```

A daytime rest period must satisfy:

- at least ninety minutes,
- a finite session resting HR,
- resting HR <= overall baseline × `0.95`.

When a candidate begins within 180 minutes of an overnight chain's previous
end, it is treated as a possible morning sitting/rest period. It must also have
either:

- at least sixty percent strap sleep-state confirmation, or
- resting HR <= baseline × `0.90`.

These guards stop a long quiet daytime meeting, reading session, or morning
pause from being appended to overnight sleep.

### 13.8 Overnight merging

Accepted overnight bouts separated by less than ninety minutes can be merged
when:

- the merged span remains within sixteen hours,
- the combined off-wrist fraction remains below fifty percent.

The merged span represents one in-bed interval. The original bout boundaries
are retained so the gap can be overlaid as wake/WASO rather than silently
converted to light sleep.

### 13.9 Boundary refinement

The hybrid boundary pass tightens onset and wake:

1. Run HDCZA near the candidate with a twelve-minute bridge and twenty-minute
   minimum period.
2. Search up to thirty minutes backward and twenty-five minutes forward.
3. Evaluate two-minute windows every thirty seconds.
4. Require at least `0.55` gravity stillness fraction and HR support.
5. Stop after three consecutive failed windows.
6. Restore the five-minute confirmation tail when gravity exists and HR still
   looks sleep-like.

The five-minute tail matters because van Hees marks a sample immobile only when
the following five minutes remain still, which otherwise clips wake by roughly
five minutes.

Sparse sessions skip boundary refinement because a precise boundary cannot be
honestly recovered from absent gravity.

### 13.10 Main session selection

All accepted sessions are scored, then the longest non-nap session becomes the
main session. The result also contains all other sessions in chronological
order.

Important fields include:

```text
start / end
onsetIso / wakeIso
detector
confidence
fallbackReason
provenance
gravityCoverage
epochCoverage
scorability
```

## 14. No-gravity HR-only fallback

If gravity coverage is insufficient, `scoreSleep()` retains a conservative
legacy HR-only escape hatch. It is not the primary autosleep algorithm.

Requirements:

- at least eight valid HR rows,
- baseline = HR 20th percentile,
- asleep threshold = baseline + 8 bpm,
- asleep threshold held for at least fifteen minutes,
- wake threshold = baseline + 15 bpm held for at least ten minutes,
- total candidate duration at least three hours,
- candidate midpoint not within local daytime `08:00..22:00`.

If no sustained low-HR onset is found, the fallback can start at the first
nighttime row (`21:00..11:00` local), but it still must satisfy the duration and
daytime guards.

If no reported stages exist, fallback staging is a simple HR percentile rule:

```text
HR >= asleep-median + 18 → awake
HR <= HR p20             → deep
HR >= HR p80             → rem
otherwise                → light
```

The fallback is labeled:

```text
detector: legacy_hr_only
fallbackReason: insufficient_gravity_hr_only
confidence: low
gravityAuthoritative: false
```

It is intentionally not persistable as authoritative overnight sleep in the
main Overview path. The system may still use measured values for explicitly
supported low-confidence calculations and diagnostics, but it must not present
HR-only sitting as a normal confirmed sleep session.

## 15. Sleep staging

Sleep stages are computed after a candidate session has been found. Detection
answers “which interval could be sleep?”; staging answers “what was the most
likely state within that interval?”

The stager is:

```text
sleepStagerV2.js
```

It has four internal classes:

```text
deep, rem, light, awake
```

Public API segments normalize `awake` to `wake`.

### 15.1 Epoch size and padded inputs

The stager works in thirty-second epochs.

It pads the sensor windows around the session:

```text
gravity: session ± 330/390 seconds
HR:      session ± 330/390 seconds
RR:      session ± 330/390 seconds
```

Padding supplies context for HR variability, flatness, movement scale, and
respiratory regularity without changing the public session boundary.

### 15.2 Features per epoch

For each thirty-second epoch, FRWHOOP derives:

| Feature | Meaning |
|---|---|
| `hr` | mean per-second HR inside the epoch |
| `hrVar` | HR standard deviation over a roughly 5.5-minute context |
| `hrFlat11` | HR standard deviation over a roughly 12-minute context |
| `jerks` | consecutive gravity-vector differences |
| `jerkMax` | largest gravity difference in the epoch |
| `moveFrac` | fraction of jerks above a recording-specific movement floor |
| `respReg` | RR-derived respiratory regularity |
| `clock` | normalized position in the session |
| `minutesSinceOnset` | provisional time from session start |

The movement floor is adaptive:

```text
jerkScale = median(all epoch jerks)
moveThreshold = jerkScale * 38
moveFrac = fraction(jerk > moveThreshold)
```

A stronger motion gate uses:

```text
jerkMax > jerkScale * 55
```

This lets the stager adapt to a quiet or noisy recording rather than using one
absolute accelerometer threshold for every person and device.

### 15.3 Respiratory regularity for staging

The staging feature is different from the nightly respiration engine.

For staging:

1. Collect RR intervals in a context from ninety seconds before to 120 seconds
   after the epoch.
2. Clamp values to `300..2000` ms for the feature calculation.
3. Linearly interpolate the tachogram at 4 Hz.
4. Measure spectral power in approximately `0.15..0.40 Hz`.
5. Use the largest spectral power divided by total band power as `respReg`.

This is a regularity feature, not a direct respiratory-rate claim.

### 15.4 Adaptive normalization

HR, HR variability, movement, and respiratory regularity are z-normalized within
the session. Missing values contribute a neutral z-score rather than an
invented measurement.

The stager also uses a percentile position for `hrFlat11` to form a deep-sleep
gate.

### 15.5 Emission scores

The raw class scores are log-like heuristic emissions. With `zhr`, `zhrv`,
`zmv`, and `zresp`:

```text
deep  = -1.1*zhrv - 0.5*zmv - deep_gate + log(0.18)
rem   =  0.6*zhrv - 0.6*zmv + 0.4*zhr  + log(0.22)
light =                                  log(0.50)
awake =       zmv + cardiac            + log(0.10)
```

The cardiac term is:

```text
cardiac0 = 0.8*zhrv + 0.4*zhr
cardiac  = min(0, cardiac0) when the epoch is motion-quiescent
           cardiac0 otherwise
```

The deep gate is:

```text
deep_gate = 5 * max(0, percentile(hrFlat11) - 0.25)
```

Other modifiers:

- a high jerk maximum adds `+2` to the awake emission,
- respiratory regularity adds `0.6*zresp` to deep and subtracts it from REM,
- an early-session cycle prior favors deep,
- a later-session cycle prior favors REM,
- REM receives a latency penalty during the first sixty minutes after onset.

The base priors are:

```text
light = 0.50
deep  = 0.18
rem   = 0.22
awake = 0.10
```

These are model priors, not population prevalence claims.

### 15.6 Cycle and REM latency priors

The cycle prior is:

```text
deep = 1.2 * max(0, 1 - clock / 0.55)
rem  = clock - rem_latency_penalty
```

The REM latency penalty is:

```text
3 * min(1, max(0, 1 - minutes_since_onset / 60))
```

The provisional path is used to find a sustained onset. A non-awake run of ten
epochs (five minutes) identifies the first plausible sleep onset, after which
the REM latency modifier is recomputed relative to that onset.

### 15.7 Viterbi smoothing

The final path is the maximum-probability sequence under transition penalties,
not an independent label for each epoch.

Transition probabilities:

| From \ To | Deep | REM | Light | Awake |
|---|---:|---:|---:|---:|
| Deep | 0.86 | 0.007 | 0.126 | 0.007 |
| REM | 0.005 | 0.88 | 0.10 | 0.015 |
| Light | 0.06 | 0.06 | 0.85 | 0.03 |
| Awake | 0.00 | 0.00 | 0.10 | 0.90 |

Zero transitions are floored to `1e-9` before taking logarithms so the
implementation remains numerically defined.

The emitted path is compressed into adjacent public segments:

```text
{ stage: "deep" | "rem" | "light" | "wake", start, end }
```

If no features are available, the session falls back to one `light` segment
rather than inventing detailed stages.

### 15.8 Stage probabilities and coverage

For each epoch, FRWHOOP stores a softmax over the four emissions:

```text
p(stage) = exp(emission(stage) - maxEmission) / sum(exp(...))
```

These probabilities are calibration targets from a heuristic model. They are
not clinically calibrated probabilities.

Epoch input coverage is:

```text
coverage = (HR present + accelerometer present + RR present) / 3
```

Stage confidence:

```text
low    if coverage < 1/3 or max probability < 0.35
high   if coverage >= 2/3 and max probability >= 0.80
medium otherwise
```

The session summary reports:

- epoch count,
- fraction high/medium/low confidence,
- HR coverage,
- RR coverage,
- accelerometer coverage,
- off-wrist duration,
- detector,
- fallback reason,
- model identifier.

### 15.9 Strap-reported sleep state

The v18 `band_sleep_state` is not the primary stage classifier. It is optional
corroboration used mainly by detection guards, such as the morning re-onset
guard and nap evidence.

The four public stages come from the FRWHOOP stager unless a low-confidence
fallback explicitly uses reported stages or HR percentiles.

### 15.10 Merged gaps and disturbances

When multiple rest bouts are merged into one in-bed window, gaps of at least
sixty seconds are explicitly overlaid as `wake` epochs. This preserves wake
after sleep onset instead of letting the stager smooth a bathroom break into
light sleep.

The current `disturbances` field is the number of public awake/wake segments.
It is not a clinical arousal index and should not be interpreted as a count of
every micro-arousal.

## 16. Nap detection

Naps are a separate detection problem. They are not “overnight sleep with a
different label,” and they are not appended to the night.

Implementation:

```text
backend/metrics/napDetection.js
```

### 16.1 Candidate generation

Nap candidates use HDCZA-like wrist inactivity with:

```text
sustained inactivity: 3 minutes
minimum duration:     10 minutes
maximum duration:     180 minutes
bridge gap:           5 minutes
```

The time-of-day prior is soft. A candidate outside the usual nap window is not
automatically discarded solely because of clock time.

### 16.2 Candidate exclusions

A candidate is rejected if:

- it overlaps the main overnight session with a thirty-minute margin,
- it overlaps another excluded scored session with that margin,
- explicit off-wrist time exceeds twenty-five percent,
- the measured stillness fraction is below `0.85`.

Nap off-wrist calculation currently uses explicit wrist-off intervals. It does
not infer non-wear from every absent HR row.

### 16.3 Nap stillness

For a candidate:

1. Calculate the same wrist z-angle used by HDCZA.
2. Smooth it with a ten-sample rolling median.
3. Count adjacent changes below `5°`.
4. Require at least `0.85` of changes to be still.

`NAP_DEFAULTS.stillnessThresholdG` exists as configuration metadata, but the
current nap candidate implementation uses the angle-based `5°` test above.

### 16.4 Daytime HR baseline and dip

The daytime HR baseline is the 40th percentile of HR from local `10:00..21:00`.

With at least three HR samples in the candidate:

```text
hr_dip = median(candidate HR) <= daytime_baseline * 0.97
hr_ratio = median(candidate HR) / daytime_baseline
```

If no baseline or too few HR samples exist, HR dip is unknown rather than false.

### 16.5 Time-of-day prior

The time score is a soft Gaussian-like prior centered near `14:00`:

```text
score = 0.3 + 0.7 * exp(-0.5 * ((hour - 14) / 2.5)²)
```

Outside the preferred range, the score is reduced to `0.2`; it is not a hard
exclusion.

### 16.6 Nap probability

The current probability calculation is:

```text
prob = 0.25
prob += 0.35 * stillness_fraction
prob += 0.25 if HR dip is true
prob -= 0.15 if HR dip is false
prob += 0.15 * time_of_day_score
prob = clamp(prob, 0, 0.98)
```

If at least half of available strap sleep-state samples report state `2`,
probability receives an additional `+0.10`, capped at `0.98`.

### 16.7 Sleep-versus-quiet-rest confidence

The detector also returns a separate confidence that the interval is sleep
rather than quiet wakeful rest:

```text
sleep_conf = 0.25 + 0.40 * stillness_fraction
sleep_conf += 0.30 if HR dip is true
sleep_conf -= 0.20 if HR dip is false
sleep_conf += 0.10 if duration >= 30 minutes
sleep_conf = clamp(sleep_conf, 0.05, 0.99)
```

Band sleep-state corroboration can add `+0.10`, capped at `0.99`.

### 16.8 Nap confidence labels

```text
low    if gravity coverage is absent or HR coverage is absent
high   if all core coverage exists and probability > 0.72
medium otherwise
```

The result contains:

```text
startSec
endSec
durationMin
probability
confidence
sleepVsQuietConfidence
hrRatio
detector = "nap_detector_v1"
```

### 16.9 Nap staging and result shape

Each accepted nap is staged with the same four-class staging pipeline as an
overnight session. It receives:

```text
isNap: true
napProbability
napSleepVsQuietConfidence
stages
hypnogram
epochProbabilities
epochCoverage
scorability
```

If a day has no overnight session but has a valid nap, `scoreSleep()` returns a
nap-only result with:

```text
isNap: true
fallbackReason: "nap_only_day"
```

If a normal overnight exists, it remains the main session with `isNap: false`;
nap sessions are additional chronological sessions. This prevents double
counting a night as both main sleep and a nap.

## 17. Sleep score calculations

`backend/metrics/sleep.js` computes a session after detection and staging.

### 17.1 Time in bed and stage totals

```text
inBedMin = max(1, round((end - start) / 60 seconds))
```

The four stage durations are accumulated from continuous segment boundaries.
Public integer totals use a deterministic largest-remainder allocation so that:

```text
awakeMin + remMin + lightMin + deepMin == inBedMin
```

Asleep time is:

```text
asleepMin = lightMin + deepMin + remMin
```

### 17.2 Sleep efficiency

```text
efficiency = clamp(asleepMin / inBedMin, 0, 1)
```

It is returned as a fraction, not a percentage.

### 17.3 Sleep need

Default baseline need is eight hours:

```text
base = baselineMin or 480
strain_add = clamp(strainYesterday / 21 * 50, 0, 50)
debt_add = clamp(debtMin * 0.4, 0, 90)
needMin = round(clamp(base + strain_add + debt_add, 360, 720))
```

The result is bounded to six through twelve hours. This is FRWHOOP's
transparent heuristic, not WHOOP's private personalized need model.

### 17.4 Sleep performance

```text
performance = clamp(asleepMin / needMin * 100, 0, 100)
```

This is duration against computed need. It is not the separate NOOP Rest score
that may weight deep and REM differently.

### 17.5 Sleep debt

Given historical nights in chronological order:

```text
debt_0 = 0
debt_n = clamp(
  debt_(n-1) * 0.65 + max(0, needMin - asleepMin),
  0,
  240
)
```

Only a shortfall adds debt. Extra sleep does not create a negative debt credit.

### 17.6 Sleep consistency

For at least two valid onset times:

```text
onset_score = clamp(100 - stdev(onset_clock_minutes) / 1.2, 0, 100)
```

The same calculation is made for wake times when at least two are available.
The final consistency is the rounded mean of the available onset and wake
scores. With fewer than two observations for both, consistency is unavailable.

The current helper interprets the supplied ISO strings using the runtime clock
fields; callers should provide values in the intended local timezone.

### 17.7 Resting and overnight HR

Inside the session:

- `overnightHr` is the HR median.
- `restingHr` is the minimum mean HR among five-minute bins.

An HR value that is absent or outside the physiological gate is excluded rather
than treated as zero.

### 17.8 Disturbances and hypnogram

The session output includes:

- compressed stage segments,
- normalized `x0/x1` hypnogram coordinates,
- number of awake segments,
- a downsampled HR sparkline of at most 48 points.

The hypnogram is a visualization projection. The authoritative boundaries remain
the absolute `start` and `end` timestamps.

## 18. Overnight HRV and respiration

These measurements are calculated inside the detected session window and can
feed recovery. They are not required to decide whether a session exists.

### 18.1 HRV

The HRV engine uses RMSSD because it is suitable for short windows and is less
sensitive to slow drift than many alternatives.

For a clean RR series:

```text
RMSSD = sqrt(mean((RR[i] - RR[i-1])²))
```

Current processing:

1. Reconstruct beat timing from RR intervals.
2. Divide the sleep window into five-minute windows.
3. Require at least thirty clean beats per usable window.
4. Reject RR artifacts and windows with artifact fraction above `0.20`.
5. Require at least three usable windows for a nightly result.
6. Take the median of per-window RMSSDs.

The nightly value is not a pooled RMSSD across all beats. A single arousal or
bad segment therefore cannot dominate the whole night.

### 18.2 Respiratory rate

The live backend respiration path currently has one available estimator:
respiratory sinus arrhythmia from RR intervals.

It uses a Lomb-Scargle periodogram because RR tachograms are unevenly sampled:

```text
respiratory band = 0.1..0.5 Hz
breaths/minute = dominant_frequency_hz * 60
```

An estimate requires:

- enough clean beats,
- a sufficiently long window,
- artifact rejection,
- a dominant peak with adequate prominence,
- motion below the trust ceiling.

Three PPG-derived estimators are declared but unavailable until raw PPG reaches
the backend intentionally:

- respiratory-induced intensity variation,
- respiratory-induced amplitude variation,
- respiratory-induced frequency variation.

The system never fabricates those estimators to make fusion appear more
complete.

## 19. Recovery and strain

### 19.1 Recovery score

When inputs and baselines exist, the transparent recovery components are:

| Component | Weight | Direction |
|---|---:|---|
| HRV versus baseline | 0.35 | higher HRV is better |
| resting HR versus baseline | 0.25 | lower RHR is better |
| sleep performance | 0.30 | higher performance is better |
| respiration versus baseline | 0.10 | closer to baseline is better |

Component examples:

```text
HRV score  = clamp(50 + (HRV - baseline) / baseline * 50, 0, 100)
RHR score  = clamp(50 - (RHR - baseline) / baseline * 50, 0, 100)
resp score = clamp(100 - abs(resp - baseline) / baseline * 200, 0, 100)
```

Missing components are omitted and the available weights are renormalized. A
missing HRV value therefore does not become zero recovery.

### 19.2 HR-derived strain

When no explicit strain is provided, `strainFromHr()` uses a transparent HRR
bucket approximation:

```text
HRR% = (bpm - resting_hr) / (max_hr - resting_hr) * 100
```

Intensity weights:

| HRR | Weight |
|---:|---:|
| `>= 90%` | 5 |
| `>= 80%` | 4 |
| `>= 70%` | 3 |
| `>= 60%` | 2 |
| `>= 50%` | 1 |
| `>= 25%` | 0.5 |
| below `25%` | 0 |

Only adjacent samples no more than ten minutes apart contribute duration.
The accumulated TRIMP-like value is mapped to FRWHOOP's `0..21` axis:

```text
strain = clamp(21 * log(trimp + 1) / log(7201), 0, 21)
```

This value can contribute to the next sleep-need calculation.

## 20. Metric envelopes and honesty rules

Where a derived signal is exposed through the signal-quality layer, it uses a
`MetricEnvelope`, not a bare number. The internal `scoreSleep()` result is a
session object with the same provenance/confidence concerns; the API/persistence
layer must preserve those fields when projecting it:

```text
{
  value,
  unit,
  confidence,
  dataQuality,
  inputCoverage,
  algorithm,
  algorithmVersion,
  sourceSignals,
  status,
  reason,
  detail,
  experimental,
  startTime,
  endTime,
  timestamp
}
```

Statuses:

```text
ok
low_confidence
unavailable
```

The envelope distinguishes:

- input quality: how clean/complete the source signal was,
- confidence: how much the algorithm should be trusted,
- coverage: how much of the expected window was present.

For example, a high-quality single respiration estimator has good signal quality
but no cross-estimator agreement bonus. A value from a sparse or off-wrist
session may be real but low confidence.

Values below confidence `0.35` are labeled `low_confidence`. A null value is
always `unavailable`; FRWHOOP does not attach a plausible default to a missing
measurement.

## 21. Physiological day and persistence

Raw timestamps and session boundaries are UTC instants. The physiological day is
the local calendar date on which the main overnight sleep session ended:

```text
physiologicalDay = localDate(wakeIso, userIanaTimezone)
```

When there is no sleep session, the requested/current local calendar date is
used. Daily bounds are local midnight to the next local midnight with DST
handled by the IANA timezone. FRWHOOP does not use a fixed `16:00..16:00`
WHOOP-style cycle for its daily snapshot bounds.

The metrics engine persists:

- sleep session and stage totals,
- onset and wake timestamps,
- detector and staging provenance,
- confidence and fallback reason,
- overnight HR, resting HR, HRV, respiration,
- sleep need, debt, performance, efficiency, consistency,
- recovery and strain,
- daily HR/movement series,
- raw and decoded archive manifests.

## 22. What is known, partial, and intentionally not claimed

### Known and used

- family-specific frame envelopes,
- CRC8, CRC16-Modbus, and CRC32 validation,
- fragmented-frame reassembly,
- live HR and standard BLE RR parsing,
- WHOOP 5 v18 gravity/HR/RR/steps/temperature projections,
- dense and sparse gravity sleep detection,
- four-class heuristic staging,
- dedicated nap detection,
- overnight RMSSD and RR-derived respiration,
- durable history trim ordering,
- raw Level A and Level B lineage.

### Structurally decoded but not fully interpreted

- raw IMU tails,
- neutral optical channels,
- some console/event payloads,
- some WHOOP 4 historical layouts,
- some WHOOP 5/MG capability and diagnostic fields,
- uncertain optical auxiliary bytes,
- the v18 offset-82 oxygen candidate.

### Not claimed

- official WHOOP sleep, recovery, strain, or sleep-need parity,
- clinical sleep staging,
- diagnosis from ECG, PPG, oxygen, HRV, or respiration,
- an oxygen value from a single unexplained byte,
- missing samples repaired by interpolation,
- a daytime quiet period labeled a nap without nap evidence,
- a CRC-invalid frame used for physiological scoring.

## 23. File map

| File | Responsibility |
|---|---|
| `backend/protocol/crc.js` | CRC8, CRC16-Modbus, CRC32, integer readers |
| `backend/protocol/framing.js` | family envelopes, verification, reassembly |
| `backend/protocol/decoder.js` | packet registry, lineage, dispatch, status |
| `backend/protocol/whoop5.js` | WHOOP 5 v18/v20/v21/v26 and irregular packets |
| `backend/metrics/sleepDetection.js` | stream extraction, coverage, autosleep |
| `backend/metrics/vanHeesSleep.js` | dense gravity rest bouts |
| `backend/metrics/hdczaSleep.js` | HDCZA candidate periods and nap boundaries |
| `backend/metrics/sleepStagerV2.js` | features, emissions, Viterbi staging |
| `backend/metrics/napDetection.js` | nap-specific evidence and exclusions |
| `backend/metrics/sleep.js` | sleep totals, need, debt, recovery, strain |
| `backend/metrics/overnight.js` | session-window HRV/respiration provider |
| `backend/metrics/scorability.js` | epoch and session confidence summary |
| `backend/signal/envelope.js` | metric envelope and confidence propagation |
| `backend/hrv/engine.js` | overnight RMSSD |
| `backend/respiration/engine.js` | respiratory-rate orchestration |
| `backend/respiration/estimators.js` | Lomb-Scargle RR estimator and capability reporting |
| `backend/ingest/historyBuffer.js` | historical ingest, dedupe, clock correction |
| `backend/ingest/hourBuffer.js` | raw sample/frame buffering and archive flush |
| `backend/redecode/redecode.js` | Level A replay and comparison |
| `frontend/ios/App/App/WhoopProtocol.swift` | iOS frame builders and historical projection |
| `frontend/ios/App/App/WhoopBlePlugin.swift` | CoreBluetooth, capture, reassembly, routing |
| `frontend/ios/App/App/SensorQueue.swift` | crash-safe raw/sample/history queues |
| `frontend/ios/App/App/LiveUploadSession.swift` | persistent background upload |
| `noop/Packages/StrandAnalytics/...` | independent Swift algorithm reference/parity source |
| `noop/docs/PROTOCOL.md` | reverse-engineering and BLE protocol reference |

## 24. Practical debugging checklist

When a metric or sleep night looks wrong, inspect in this order:

1. Confirm the device family from the GATT service.
2. Inspect the Level A notification archive for missing or truncated bytes.
3. Reassemble by characteristic, not one shared stream.
4. Verify the family-specific length and both applicable CRC checks.
5. Check `decode_status`, `frame_hash`, decoder version, and packet version.
6. Confirm historical timestamps and any bounded clock correction.
7. Check normalized HR/gravity/RR validity gates.
8. Inspect gravity coverage and largest gaps.
9. Inspect detector, fallback reason, off-wrist fraction, and confidence.
10. Inspect epoch coverage and stage probability distribution.
11. Check whether the result is `isNap`, `nap_only_day`, or a main overnight.
12. Confirm that metric envelopes were not flattened into bare numbers by the UI.

If the bytes are present but the semantics are not mapped, the correct outcome
is an honest unknown with preserved evidence and a future redecode path.
