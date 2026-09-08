# PACKET 51–56 & ADDITIONAL WHOOP SERVICES — structural-decode hypothesis

**Mission:** WHOOP5 sensor-access — audit the named-but-undecoded packet types (51–56) and the
additional WHOOP services / characteristics, then give FRWHOOP a `STRUCTURAL DECODE HYPOTHESIS` for
each that can be implemented immediately — even before the physical identity of the field is known.

**Baseline commit:** `ab0f699e` (NOOP HEAD, "Decode the v20 optical record's eleven config fields, and
CRC-gate it (#423)"); FRWHOOP whoop repo at the current working tree.

**Primary sources (all cited relative to this repository, plus local `noop/`):**
- `noop/Packages/WhoopProtocol/Sources/WhoopProtocol/Resources/whoop_protocol.json` — `enums.PacketType`
  (35–56), `EventNumber`, `CommandNumber`, `MetadataType`, `CommandResult`; packet-body layouts exist for
  36/40/43/47/48/49/50 **only**. There is **no body layout** in the JSON for **51–56** (nor 35/37/38).
- `noop/docs/PROTOCOL.md`, `noop/docs/BLE_REVERSE_ENGINEERING.md`, `noop/docs/WHOOP5_DEEP_DATA.md`.
- `noop/Packages/WhoopProtocol/Sources/WhoopProtocol/Streams.swift` (`unhandledPacketTypes`),
  `HistoricalStreams.swift` (`expectedUnhandledHistoricalTypes = {METADATA, CONSOLE_LOGS}`),
  `Framing.swift`, `Interpreter.swift`, `DeviceFamily.swift`.
- Android twin `noop/android/app/src/main/java/com/noop/protocol/Enums.kt`,
  `.../History`/`Framing.kt`, `noop/android/app/.../ble/WhoopBleClient.kt` (`isOffloadFrame`),
  and the census tests (`UnhandledPacketTypeTests.swift`,
  `HistoricalStreamsUnhandledTypeTest.kt`).
- FRWHOOP: `backend/protocol/{decoder.js,whoop5.js,framing.js}` (backend decode),
  `frontend/ios/App/App/{WhoopBlePlugin.swift,WhoopProtocol.swift}` (native BLE/GATT + live decode),
  and existing analysis in `backend/docs/` (`UNKNOWN_PACKET_CENSUS.md`, `PROTOCOL_COVERAGE.md`,
  `WHOOP5_HARDWARE_LAB.md`, `WHOOP5_MAX_SENSOR_ACCESS_REPORT.md`, `LIVE_VS_HISTORICAL_ACCESS_MATRIX.md`,
  `WHOOP5_SENSOR_HARDWARE_MATRIX.md`).

**Confidence classes used below (deliberately aligned with the existing repo vocabulary):**
- **VERIFIED** — a layout is implemented and validated on real hardware/captures in NOOP and/or FRWHOOP.
  Field offsets are facts, not guesses.
- **STRUCTURAL (HYPOTHESIS)** — the envelope/framing and the *shape* (type byte, version byte, channel
  layout, +4 offset rule) are well-founded and safe to implement; the semantic identity or exact
  per-record offset of a field is not yet pinned by a capture.
- **NAME-ONLY (no implementable structure)** — no real capture, no layout evidence; only the enum name
  and the generic envelope make it to code. Do **not** invent field offsets.

**Rule of the project (honest, bytes-preserved):** FRWHOOP already archives **every** WHOOP notify byte
at Level A (`ble-frames.ndjson` → B2) and reassembles every frame at Level B regardless of type
(`PROTOCOL_COVERAGE.md`). So every type below is *received, archived, parsed*; the rows differ only in
**decode** depth. The structural hypotheses in §2 are what let FRWHOOP assign a *skeleton* decode
(fields/offsets that are safe to claim) while keeping anything unknown raw. No field is "decoded" unless
the offset is anchored to the framing or to a real capture.

---

## 0. Transport recap — the two rules every 5/MG structural idea builds on

**Rule 1 — the inner-record offset.** A WHOOP 5.0/MG ("puffin") frame's inner record sits at **offset 8**
(not 4):

```
[0]=0xAA  [1]=0x01  [2..3]=declLen u16LE  [4..5]=0x0100  [6..7]=CRC16-Modbus(hdr)
inner @8 :  [8]=type  [9]=seq/version  [10]=cmd  [11..]=payload   crc32-LE trailer
```

WHOOP 4.0: `[4]=type  [5]=seq/version  [6]=cmd  [7..]=payload`.

**Rule 2 — the +4 rule.** Almost every 5/MG field/record is the WHOOP 4.0 layout shifted +4 (event
`EVENT`@10, `COMMAND_RESPONSE` resp_cmd@10, `METADATA` meta_type@10, `HISTORICAL_DATA` version@9 on 5.0 vs
@5 on 4.0). This is the single most reliable bridge for structural hypotheses about the 5/MG names
(types 51–56 are all 5/MG puffin types). It is applied *as a hypothesis* below, never asserted as a fact
for an undecoded type.

**Rule 3 — 5.0 inner `b3` (payload[0]) class select.** Command bodies start with a class byte: `0x01`
for hello/config (GET_HELLO 145, SET_FF/120, config 115–121), `0x00` for data commands
(GET_DATA_RANGE 34, SEND_HISTORICAL 22). Outbound we frame commands ourselves; inbound the value
matters when decoding `COMMAND_RESPONSE` bodies.

---

## 1. Packet-type census quick view (51–56)

FRWHOOP backend `decoder.js` `PACKET_TYPES` mirrors the JSON enum exactly. Summary:

| Type | Name | Family | FRWHOOP decode today | NOOP decode today | Layout in JSON? |
|-----:|------|--------|----------------------|-------------------|-----------------|
| 51 | `REALTIME_IMU_DATA_STREAM` | 5/MG | classified | classified (name only) | **no** |
| 52 | `HISTORICAL_IMU_DATA_STREAM` | 5/MG | classified | classified; `isOffloadFrame` true on 5/MG | **no** |
| 53 | `RELATIVE_PUFFIN_EVENTS` | 5/MG | classified | classified; tallied as `type53`/unhandled | **no** |
| 54 | `PUFFIN_EVENTS_FROM_STRAP` | 5/MG | classified | classified; real bulk captures (unclassified payload) | **no** |
| 55 | `RELATIVE_BATTERY_PACK_CONSOLE_LOGS` | 5/MG | classified | classified | **no** |
| 56 | `PUFFIN_METADATA` | 5/MG | classified → **aliased to METADATA and decoded** | aliased → `METADATA` and **decoded** | alias only (49 body) |

---

## 2. Per-packet structural decode hypothesis

### 2.1 Type 56 — `PUFFIN_METADATA` — **VERIFIED (implement today, already done)**

- **Who references it:** `PROTOCOL.md` §2.3/§3 (`56 PUFFIN_METADATA` aliased → `METADATA`),
  `DeviceFamily.swift` `canonicalTypeName`, backend `decoder.js` `PACKET_TYPES` 56, Android
  `Enums.kt` `PUFFIN_METADATA(56)`, `WhoopBleClient.kt` `isOffloadFrame` (`case 47,48,49,50,56`),
  `Whoop5OffloadTest.kt`, `WhoopBleClient.kt:942`.
- **Current decode:** NOOP and FRWHOOP **both** canonicalize 56 → `METADATA` (49) on 5/MG and already
  decode its body. It is the 5/MG offload's `HISTORY_END`/`HISTORY_COMPLETE` marker (type 49 on 4.0).
- **Layout evidence:** the 5.0 `METADATA` body is hardware-verified in NOOP (`BLE_REVERSE_ENGINEERING.md`
  §5: "on WHOOP 5 the metadata fields sit at the 4.0 offsets +4: `meta_type` at 10, `trim_cursor` at 21,
  `end_data` = `frame[21:29]`").
- **STRUCTURAL DECODE — VERIFIED (5/MG, full frame offsets):**

| Frame off | Field | Type | Notes |
|----------:|-------|------|-------|
| 8 | `type` | u8 | `56` |
| 9 | `seq` | u8 | envelope seq |
| 10 | `meta_type` | u8 | `MetadataType`: 1 START / 2 END / 3 COMPLETE |
| 11 | `unix` | u32 LE | record time (real seconds) |
| 15 | `subsec` | u16 LE | sub-seconds |
| 17 | `unk0` | u32 LE | unmapped (carry raw) |
| 21 | `trim_cursor` | u32 LE | ack this to advance the strap trim |
| 21..29 | `end_data` | 8 B | echoed back in `HISTORICAL_DATA_RESULT`(23) to ack |

**Action:** already wired. Keep it. **Implement-now = nothing new**; it is the reference the other 5/MG
names should be compared against.

---

### 2.2 Type 54 — `PUFFIN_EVENTS_FROM_STRAP` — **STRUCTURAL (HYPOTHESIS), partial observation; build the container skeleton now**

- **Who references it:** `PROTOCOL.md` §3 (WHOOP 5.0), `Enums.kt` `PUFFIN_EVENTS_FROM_STRAP(54)`,
  `HistoricalStreamsUnhandledTypeTest.kt` (tallied as unhandled), `CHANGELOG.md:2323` — "his captures show
  **bulk type-54 = PUFFIN_EVENTS_FROM_STRAP** … still unclassified payload-wise". Backend `decoder.js`
  classifies it; iOS does not decode it.
- **Current decode:** NOOP classified (name only; appears in `unhandledPacketTypes` census on a 4.0
  render). FRWHOOP classified. Real captures exist but the payload was not decoded by their author.
- **Layout evidence:** the name + community "bulk type-54" observation say it is the **5/MG strap-event
  channel**, carrying strap-originated events in bulk. The closest fully-decoded analog is type 48 `EVENT`,
  whose 5.0 layout is verified in NOOP: `event`@10, `event_timestamp` u32@12, a u16 **payload length**@18,
  per-event body @20 (`BLE_REVERSE_ENGINEERING.md`, "WHOOP 5.0 EVENT (type 48)").
- **STRUCTURAL DECODE — HYPOTHESIS (5/MG full-frame offsets):**

```
[8]=type 54   [9]=seq   [10]=cmd   [11]=payload...
payload: header { count u16 LE = N } then N × event element {
  event u8              (EventNumber)
  ts    u32 LE          (absolute unix, like EVENT)
  len   u16 LE          (per-event body length)
  body  [...len]        (carry raw)
}
```

  The phrase "bulk" + the `length`-prefixed shape of the decoded EVENT payload are the only structural
  anchors; the **element count/header offset are hypothetical**. Both projects should: (a) confirm 54
  arrives in the *history* funnel (it is **not** in `isOffloadFrame`'s truthy set today, so decide
  explicitly whether to ack it — treat as a live event channel, not an ack'd history body, unless a
  capture says otherwise); (b) implement the container skeleton with fail-closed bounds (cap N, per-element
  bounds, CRC-gate) and keep every body byte raw.
- **Confidence:** STRUCTURAL skeleton only. The element layout `{event,ts,len,body}` is inferred from the
  decoded 48 EVENT, **not** confirmed for 54. HYPOTHESIS.

---

### 2.3 Type 52 — `HISTORICAL_IMU_DATA_STREAM` — **STRUCTURAL (HYPOTHESIS), has the strongest "real" signal; wire the history funnel now**

- **Who references it:** `PROTOCOL.md` §3; backend `decoder.js`; `Enums.kt` `HISTORICAL_IMU_DATA_STREAM(52)`;
  `WhoopBleClient.kt` **`isOffloadFrame` returns `true` for 52 on WHOOP5** with the comment: "a genuine
  5/MG history BODY type (**observed in bulk in real ACK-enabled hardware captures**, #78 fork). 5/MG-only;
  never seen from a WHOOP 4." Also `Streams.swift`/`HistoricalStreams.swift` census treats it as the
  canonical named-but-unhandled example; `UnhandledPacketTypeTests`.
- **Current decode:** NOOP classified (counted in `unhandledPacketTypes`). FRWHOOP classified. **No field
  layout in the JSON.**
- **Layout evidence:** observed "in bulk in real ACK-enabled hardware captures" means it arrived inside a
  `SEND_HISTORICAL_DATA` offload and was **acked in real sessions** (ack-enabled captures). It is therefore
  a **history body type** like type-47, riding the same chunk/trim/ack machinery — that is firm. Its body
  (which raw IMU layout) is unproven; the tracked 5/MG IMU record is type-47 **version 21** (1244 B,
  6×100 i16 accel+gyro, `Whoop5RawImu.swift` — gravity-shell-validated). 52 is a *separate type byte* that
  likely carries a version-keyed raw-IMU body.
- **STRUCTURAL DECODE — HYPOTHESIS (5/MG full-frame offsets):**

```
[8]=type 52           [9]=seq/version  [10]=cmd (22/23 context)
[11]=class? (unknown)  [11..]=body     body-tied to the version byte @9
```

  Strong, low-risk structural claims (safe to implement **now**, before physical identity):
  1. **Treat 52 as a 5/MG history body in the offload funnel** — include it in the same framing as 47:
     the version byte's frame slot is `[9]` (the same `seq` slot type-47 uses), and it must be
     chunk/trim/ack'd like 47 (`HISTORY_END`→`HISTORICAL_DATA_RESULT`(23)).
  2. **Key the body decode on version@[9]** exactly like 47 (v18/20/21/26 discrimination), so the same
     version-keyed channel tables can be reused if a 52 capture later proves identical to a 47 version.
  3. Keep the body bytes raw (Level A/B already captured) — do **not** claim IMU field offsets inside the
     52 body, because none is evidenced. The *skeleton* (type@8, version@9, ack via 23) IS the implementable
     structural decode.
- **Confidence:** envelope/funnel = STRUCTURAL, anchored to `isOffloadFrame`/real ack captures. Any *field*
  offsets inside the body = NAME-ONLY (do not invent). HYPOTHESIS for the body.

---

### 2.4 Type 51 — `REALTIME_IMU_DATA_STREAM` — **NAME-ONLY (no implementable structure beyond the funnel)**

- **Who references it:** `PROTOCOL.md` §3, backend `decoder.js`, `Enums.kt` `REALTIME_IMU_DATA_STREAM(51)`.
- **Current decode:** classified (name only) on both platforms.
- **Layout evidence:** none in-repo. Naming says "realtime IMU", the live-stream sibling of the type-43
  `REALTIME_RAW_DATA` + the historical 52. **On 5.0 the live IMU stream is firmware-refused**
  (`TOGGLE_IMU_MODE`/106 acks, never streams — `Whoop5RawImu.swift:11-13`, `LIVE_VS_HISTORICAL_ACCESS_MATRIX`),
  so if 51 is the live IMU frame it is expected to be rare/absent on 5.0.
- **STRUCTURAL DECODE — HYPOTHESIS (minimal, safe):** treat as a **live** (non-ack) realtime type like
  43/40: `[8]=type 51  [9]=seq  [10]=cmd(0)  [11..]=payload`, no history ack. It is **not** in
  `isOffloadFrame`'s truthy set, so keep it out of the history watchdog. Do **not** claim any IMU field
  offset. Register it in the realtime classifier so a real 51 frame renders a name and gets archived, and
  stays out of the offload trim path.
- **Confidence:** NAME-ONLY for the body; the "live, not ack'd" routing is a lightweight structural choice,
  not a verified fact. No offsets.

---

### 2.5 Type 53 — `RELATIVE_PUFFIN_EVENTS` — **NAME-ONLY**

- **Who references it:** `PROTOCOL.md` §3, backend `decoder.js`, `Enums.kt` `RELATIVE_PUFFIN_EVENTS(53)`.
- **Current decode:** classified (name only); on a 4.0 render it arrives as `"type53"` and is tallied by the
  census; NFWHOOP treats it as a named-but-unhandled type.
- **Layout evidence:** none. No capture, no JSON body, no community decode.
- **Structural reading (and only that):** the `RELATIVE_` prefix (shared with 55) most plausibly means the
  event records carry **relative/delta timestamps** instead of absolute unix — the strap asserting a
  timebase it can compute locally without a settled clock. That mirrors the pattern that the *absolute*
  strap-event type (48/54) already carries `event_timestamp` u32, so the "relative" variant would carry a
  delta/epoch-relative counter. **This is an interpretation of the name, not evidence.**
- **STRUCTURAL DECODE — HYPOTHESIS (minimal, safe):** treat as a live event channel (like 48), keep out of
  the history ack path; `[8]=type 53 [9]=seq [10]=cmd [11..]=payload`; archive whole body raw. Optionally
  mirror the 54 container shape (`{count, elements{event, relTs, len, body}}`) *only* as a documented guess,
  gated off by default. Do not ship any field as decoded.
- **Confidence:** NAME-ONLY. The relative-timestamp reading and any container layout are unverified guesses.

---

### 2.6 Type 55 — `RELATIVE_BATTERY_PACK_CONSOLE_LOGS` — **NAME-ONLY**

- **Who references it:** `PROTOCOL.md` §3, backend `decoder.js`, `Enums.kt`
  `RELATIVE_BATTERY_PACK_CONSOLE_LOGS(55)`.
- **Current decode:** classified (name only) on both platforms.
- **Layout evidence:** none for the packet body. The *subject* has real evidence though: the WHOOP
  **Wireless PowerPack** (the battery-pack radio) was hardware-identified in
  `WHOOP5_HARDWARE_LAB.md` — model `WBB5BP0312236`, serial `B5BP0312236`, fw `3.30.5.0`, GATT
  `0x180F, 0x180A` + pack service `11500001-6215-11ee-8c99-0242ac120002`, and it advertises standard
  battery/device-info. So "battery pack console logs" plausibly reports the pack's own firmware console
  over the strap link (the pack has no `FD4B` service; it is a separate radio).
- **Structural reading:** the `RELATIVE_` prefix again suggests relative timestamps; body shape would mimic
  type 50 `CONSOLE_LOGS` (firmware text; on 5/MG NOOP decodes UTF-8 @21, 2 KB cap — `CHANGELOG.md:2318`),
  but for the pack. **Both the timestamp mode and the byte offsets are guesses.**
- **STRUCTURAL DECODE — HYPOTHESIS (minimal, safe):** classify as a console/log channel (like 50) so it
  never feeds a metric and never ack's history; `[8]=type 55 [9]=seq [10]=cmd [11..]=payload`; archive whole
  body raw. Optionally expose a JSON `log_text` field mirroring 50's decode *only if* a capture confirms the
  UTF-8 offset for 55; otherwise keep raw. Log a count in `unhandledPacketTypes` so it stays observable.
- **Confidence:** NAME-ONLY. No offsets, no confirmed timestamp mode.

---

## 3. Additional WHOOP services & characteristics

### 3.1 The WHOOP 5/MG `fd4b0001-…` family

| Char | Role | Props | NOOP | FRWHOOP | Evidence |
|---|---|---|---|---|---|
| `fd4b0001-…` | primary service | (service) | discovered | discovered | `DeviceFamily` / `WhoopBlePlugin` |
| `fd4b0002-…` | command write | **write WITH RESPONSE** (write-no-response dropped) | writes commands + CLIENT_HELLO | writes commands + `puffinHello` | `PROTOCOL.md`; `WhoopBlePlugin` |
| `fd4b0003/4/5-…` | notify | notify/indicate | subscribes all | subscribes all (`isWhoopStream`) | `PROTOCOL.md`, `WhoopBlePlugin` |
| `fd4b0006-…` | **undocumented** | unknown (never discovered/probed) | not referenced | not referenced | `UNKNOWN_PACKET_CENSUS.md` — **no documented role** |
| `fd4b0007-…` | notify (5/MG extra data char) | notify/indicate | subscribes | subscribes (`isWhoopStream`) | `PROTOCOL.md` §1; `WhoopBlePlugin` |

> **Key structural fact:** the 5/MG family's fifth data channel is **`…0007`, not `…0006`**. `fd4b0006`
> has **no documented purpose** in any NOOP/FRWHOOP doc — it is the one fd4b characteristic that is neither
> written nor subscribed. It is a prime **discovery target**: probe its properties (read/write/notify) and,
> if it notifies, whether the official app sends anything on it (the 5/MG command timeline ships R22 deep
> buffers over `…0007` per `UNKNOWN_PACKET_CENSUS.md` §3.2). Until probed, treat it as unknown, never assume
> it is the "5th data char" (that is `…0007`).

### 3.2 Diagnostic-only WHOOP service families (detected, unsupported)

Same `0001`(service)+`0002/0003/0004/0005/0007`(characteristic) pattern. Neither NOOP nor FRWHOOP connects,
discovers chars, or sends commands to them — they only log the advertisement.

| Label | Service UUID | Status / notes | Evidence |
|---|---|---|---|
| `puffin1150` ("battery pack") | `11500001-6215-11ee-8c99-0242ac120002` | detected, unsupported | **Hardware-identified as the Wireless PowerPack** (`WHOOP5_HARDWARE_LAB.md`: model WBB5BP0312236, pack service `11500001…`, no `FD4B`). Distinct from the fd4b "puffin" label. |
| `monument` | `8a580001-2fe8-4796-9267-b87a2b0c8234` | detected, unsupported; likely Castle/Rev2 framing | `PROTOCOL.md` §1 |
| `symphony` | `59830001-5955-419b-bb8d-c8262926af23` | detected, unsupported; likely Castle/Rev2 framing | `PROTOCOL.md` §1 |

> **Structural observations:**
> - The **`11500001` service is almost certainly the battery-pack transport.** The pack is a real, observed
>   device with that exact service UUID. Type 55 (`RELATIVE_BATTERY_PACK_CONSOLE_LOGS`) is the natural
>   payload carrier for the pack's console over the strap link. If a pack ever binds to the strap's BLE,
>   expect 55 to carry pack text. This ties a *service* to a *packet type* structurally.
> - `monument` and `symphony` are 5/MG-era alternates (bot/wearable generations — "likely Castle/Rev2
>   framing") with **no** observed capture in this tree. They share the `0001…/0002…/0007…` pattern,
>   so a future device implementing either is expected to reuse the puffin envelope. **Do not** spend
>   decode effort on them until a real capture exists.
> - **`fd4b0006`** is the one documented-but-roleless characteristic in the active 5/MG family; prioritize
>   probing it over monument/symphony (those need hardware that isn't in the corpus).

---

## 4. The command timeline (connection → hello → config → stream enables → history request/ack)

Two views: what the reference client (NOOP *and* the official WHOOP app) sends, and what FRWHOOP sends today.

### 4.1 Reference timeline (NOOP / official WHOOP 5/MG)

1. **Connect / bond.** WHOOP 5/MG: write the static 16-byte `CLIENT_HELLO` frame to `FD4B0002`
   (type-35 `GET_HELLO`/0x91) immediately after discovery — no separate bond trick on 5.0 (4.0 uses a
   benign `GET_BATTERY_LEVEL` confirmed write to trigger just-works bonding).
2. **One-shot connect handshake** (guarded so it does not re-fire mid-offload):
   - `GET_HELLO` (145 / 0x91) + advertising name — version/identity hello.
   - `SET_CLOCK` (10, and 146 in the 5/MG high space) — strap RTC = UTC (8-byte
     `[secs u32][subsecs u32]`); wrong length is acked but not latched → RTC "lost" → strap refuses to
     serve history.
   - `GET_CLOCK` (11 / 147) — read RTC for a ClockRef correlation (5.0 doesn't strictly need it; its
     realtime/historical frames carry real unix).
   - `GET_DATA_RANGE` (34) — read the stored record window (liveness watchdog).
3. **Stop the raw flood:** `SEND_R10_R11_REALTIME` (63) `[0x00]` — turns off the ~2/s type-43 raw flood.
4. **Stream enables:**
   - `TOGGLE_REALTIME_HR` (3) — start type-40 live HR (and/or the standard `0x2A37` HR profile).
   - **R22 deep-data burst:** 16× `SET_FF_VALUE` (120 / `SET_CONFIG` 0x78), official order, `enable_r22_packets`
     last; opens the type-0x2F (=47) high-rate biometric stream and the deep type-47 records (v20/v21/v26).
     The official app sends this every connect; NOOP sends it only from an opt-in experimental path.
   - On-demand raw: `START_RAW_DATA` (81) + `TOGGLE_IMU_MODE` (106, live; **firmware-refused on 5.0**) /
     `TOGGLE_IMU_MODE_HISTORICAL` (105, banked history IMU).
5. **History request/ack** (periodic, ~15 min, and on connect):
   - `SEND_HISTORICAL_DATA` (22) → strap streams type-47 (+ possibly type-52 IMU history bodies), bracketed
     by `METADATA` (49) / **`PUFFIN_METADATA` (56)** `HISTORY_START`/`END`/`COMPLETE`.
   - On each `HISTORY_END`, echo back the 8-byte `end_data` (`trim u32` + next u32) in
     `HISTORICAL_DATA_RESULT` (23, confirmed write) — **required on 5.0 or the offload stalls** (known from
     real captures; see `BLE_REVERSE_ENGINEERING.md` §5 and `Whoop5OffloadTest`).

### 4.2 FRWHOOP's current timeline (`WhoopBlePlugin.swift`)

1. Write `puffinHello` (the 16-byte CLIENT_HELLO / GET_HELLO 0x91) to `FD4B0002` on first command write
   (family → puffin).
2. `armLiveHeartRate` (once): for puffin — `SET_CLOCK`(10, 8-byte) then `TOGGLE_REALTIME_HR`(3). Live HR
   rides the subscribed `0x2A37` standard profile.
3. Backfill on a 15-min timer + on connect: `SEND_HISTORICAL_DATA` (22) + per-`HISTORY_END`
   `HISTORICAL_DATA_RESULT` (23) ack.
4. `runProtocolLab(phase:)` — manual, debug-gated only: `baseline`, `cmd81` (START/STOP_RAW_DATA 81/82),
   `r22` (16× SET_FF_VALUE 120), `cmd105` (TOGGLE_IMU_MODE_HISTORICAL 105 + SEND_HISTORICAL 22), `cmd106`
   (TOGGLE_IMU_MODE 106, once).

**FRWHOOP does NOT send (verified from `LIVE_VS_HISTORICAL_ACCESS_MATRIX.md` §1):** `GET_DATA_RANGE`(34),
`GET_CLOCK`(11), `SEND_R10_R11_REALTIME`(63), `START/STOP_RAW_DATA`(81/82, outside lab), `TOGGLE_IMU_MODE`
(106, outside lab), `TOGGLE_IMU_MODE_HISTORICAL`(105, outside lab), any R22 `SET_FF_VALUE`(120) burst
(outside lab), device-config writes (119), feature-flag/config reads (115–118/121/128), and the ECMG
verbs (123–125/139).

**Timeline link to the undecoded types:**
- **56** is step-5's 5/MG metadata marker — already decoded.
- **52** is step-5's "other" history body — because FRWHOOP already ack's history, any 52 frames in a real
  offload are already being acked without being counted as unhandled? **No**: `isOffloadFrame` returns true
  for 52 on 5/MG, but `extractHistoricalStreams` has no 52 branch, so today it lands in
  `unhandledPacketTypes` (a census line), not a decode. Wire the 52 funnel (version@9 + history ack + raw
  archive) to close that.
- **51/53/55** are not part of FRWHOOP's current timeline — they would only appear if the strap emits them
  unsolicited (e.g. a pack connected → 55), and are currently just enumerated/archived.

---

## 5. What FRWHOOP can implement immediately (before physical identity is known)

| Priority | Type | Implementable now (structural) | Keep raw / not to decode yet |
|----|-----|-------------------------------|------------------------------|
| P0 | **56** `PUFFIN_METADATA` | **VERIFIED** — body already decoded (meta_type@10, unix@11, subsec@15, unk0@17, trim_cursor@21, end_data@21:29). No work. | none |
| P1 | **52** `HISTORICAL_IMU_DATA_STREAM` | Route as a **5/MG history body**: version@[9], ack via 23, keep in offload funnel, count in census. | body field offsets (no capture) |
| P2 | **54** `PUFFIN_EVENTS_FROM_STRAP` | Container skeleton `{count, elements{event,ts,len,body}}` modeled on decoded EVENT(48) — fail-closed, gated. Decide live-vs-ack routing (default: live event, not history). | element offsets (unproven) |
| P3 | **51** `REALTIME_IMU_DATA_STREAM` | Live (non-ack) realtime classifier, name-only, archive raw. | any IMU field offset |
| P3 | **53** `RELATIVE_PUFFIN_EVENTS` | Live event class, name-only, archive raw. | relative-timestamp reading + layout |
| P3 | **55** `RELATIVE_BATTERY_PACK_CONSOLE_LOGS` | Console/log class (like 50), name-only, archive raw; tie to the `11500001` PowerPack service. | UTF-8 @21 offset + relative timestamp mode |
| P3 | **`fd4b0006` char** | Probe/discover properties + whether the official app uses it (real capture). | — |
| P4 | **monument / symphony** | Enumerate when advertised; reuse puffin envelope if a device appears. | full framing (no hardware in corpus) |

**Bottom line for the parent:** of the six named-but-undecoded types, **56 is fully VERIFIED and already
decoded**; **52 has enough *structural* evidence (a real ack'd history-body type, observed in bulk, with a
version slot and an ack requirement) to implement the funnel immediately**; **54 has a name + real bulk
captures + a strong +4/envelope analog to build a safe container skeleton**; and **51, 53, 55 remain
effectively NAME-ONLY** (with 55's *subject*, the battery pack / 11500001 service, hardware-identified).
No in-repo capture pins a field offset inside 51/52/53/55 bodies — those must stay raw until a real frame
is decoded.

---

*This is an interoperability project for the user's own device and data; not affiliated with WHOOP; not a
medical device. Anything above marked HYPOTHESIS is a safe-to-implement structural skeleton, never a
claimed measurement.*
