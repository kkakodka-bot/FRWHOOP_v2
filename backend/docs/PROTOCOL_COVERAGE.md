# PROTOCOL COVERAGE — FRWHOOP

Status: **frwhoop-gen5/2** (2026-08-31). Decoder lineage
`frwhoop-js/2 <- noop@2fe3a5c9 + openstrap@c78c1762` (+ judes.club facts; sibling-session corpus
facts from 340,253 CRC-valid puffin frames). Pins: `protocol_sources.lock.json`.
Evidence ledger: `backend/protocol/registry.js`
(94 fields, tiers, conflicts). Byte accounting: `backend/protocol/coverage.js` (per-byte bitmap on
every decoder output). Safety: `backend/protocol/safety.js`.

## What "decode every packet" means here (contract)

1. **Every valid frame is preserved** (Level A notify bytes + Level B reassembled frames,
   immutable) **and classified** (type/version/length/CRC state) even when unmapped.
2. **Byte-accounted**: every decoder emits a per-byte coverage bitmap
   (`envelope / decoded / raw / padding / crc / unknown`), unknown-span list, warnings, confidence.
   A byte is never silently claimed and never silently dropped.
3. **Structurally decoded where evidence exists**; unknown bytes keep neutral names
   (`raw_u8_19`, unused slots, stale regions) and are never given semantics.
4. **Re-decodes are versioned sidecars** keyed by `(frame_hash, decoder_version)`; source bytes are
   never overwritten. (`redecode/sidecar.js`, retention `core`.)

## Framing (unchanged, verified)

| Generation | Service family (UUID) | Envelope | Header CRC | Payload CRC | Notes |
|---|---|---|---|---|---|
| WHOOP 4 (Harvard) | whoop4 `61080001-…` | `AA len16 crc8 [type seq …] crc32` | crc8 poly 0x07 | crc32 zlib LE | type@4, seq@5, ts@6, subsec@10, hr@12, rrCount@13, rr@14 |
| WHOOP 5 / MG (Puffin) | maverick_goose_fd4b `fd4b0001-…` | `AA 01 decl16 hdr16 crc16 [type seq …] crc32` | crc16-Modbus | crc32 zlib LE | type@8, seq@9; CRC32 spans `[8, decl+8−4)` |
| Puffin-1150 | `11500001-…` | detected, NOT connectable, framing unmapped | — | — | presence-only, never commanded |
| Monument | `8a580001-…` | detected, unsupported (likely Castle/Rev2 framing) | — | — | presence-only |
| Symphony | `59830001-…` | detected, unsupported | — | — | presence-only |

Shared gen5 historical header (types 47): `record_class 0x2F @8, hist_version @9, flags @10
(bit7 = 25 Hz optical set / 50 Hz clear; v20 bit0 = IR-fallback), record_index u32 @11, unix u32
@15, subsec u16 Q15 @19 (seconds = value/32768)`.

## Packet-type status table

Legend: **implemented** = field decode + coverage + tests; **candidate** = structural decode with
unpinned semantics; **needs capture** = preserved raw, layout unproven; **blocked** = never sent,
decodes only as archived bytes.

| Type | Name | Status | Decode depth | Confidence | Notes |
|---|---|---|---|---|---|
| 35 COMMAND | classified | envelope + opcode; **writes gated** (safety.js) | high | blocked set: 25,32,36-38,45,99,142-144 |
| 36/38 COMMAND_RESPONSE | implemented | resp_cmd/seq/result; battery 26, data-range 34, hello 145, config read-back 115/116/117/118/121/128 | high | SUCCESS-gated value decode |
| 37 PUFFIN_COMMAND | classified | alias of 35 | high | |
| 40 REALTIME_DATA | **implemented** | ts, subsec (Q15), HR gate 20..240, RR: declared count capped at 4 slots, [200,2500] ms strict validation, order preserved | high | family-aware offsets (W4 @6/10/12/13/14; W5 @10/14/16/17/18) |
| 43 REALTIME_RAW_DATA | **implemented** | W4 1917 IMU (100/axis, scales 1/4096 g, 2000/32768 dps) + 1921 optical (419 s24 @437 Hz); W5 body = the shared v21 IMU shape (one decoder for 43/47/51/52) | high (W5 IMU) / medium (W4 variants) | ECG candidate payloads triaged structurally (Labrador 17-B status header) |
| 47 v18 | **implemented** | full field map (94-registry-field entry), corrected RR/HR gates, Q15 subsec, flags@10, accel conflict tracked | high | conflicts: dynamic-accel semantics, gravity vs accel means, @36 bit7, @63 zero, @106-109 namings |
| 47 v20 | **implemented** | five 422-B blocks: 11-field neutral head (LED driver/current, detector source/range/offset-current), sign-extended 20-bit i32 samples, per-record rate u16 @23, reserved byte; CRC span [8:2136] | medium | detector paths NEVER labelled as wavelengths (OpenStrap block identity = candidate metadata only) |
| 47 v21 | **implemented** | shared IMU buffer: capacity/count/sensor-id/flags per block, EXACTLY countA/countB samples decoded (stale trailing bytes never read), scales 1/4096 g + 2000/32768 dps | high | gravity-shell validator as metadata, not a gate |
| 47 v22 | **implemented** (candidate tier) | exact-length 188 dispatch; tags 1-6 field maps; saturated-delta windows with reconstruction bookkeeping; embedded PIP (tag 5) with its own unix; tag-6 accel; unknown tags → header+tag+raw | medium | R22 = opt-in research telemetry; activation behind developer-mode consent (safety.js) |
| 47 v26 | **implemented** | PIP: 1 absolute 20-bit sample (i32@23) + 24 saturated i16 deltas → 25 reconstructed samples; accel-delta f32@75 (= v18 twin @41); state word @79; primary-flags @81; morphology @82 | medium | supersedes the "24 i16 flat waveform" reading (registry `v26.samples_vs_deltas`) |
| 47 other versions (W4: 5/7/9/12/24/25; W5: unmapped) | classified | version + header, bytes preserved | medium | redecode targets |
| 48 EVENT | **implemented** | unified envelope: event id u16 @10 (ids ≥109 ride the high byte — 340k-frame corpus), ts u32 @12; battery body (rev@20, SoC deci-percent @21, mV @25, charging bit @30); extended-battery mV scan (W4) | high | full 58-entry EventNumber catalog |
| 49 METADATA | **implemented** | meta_type, unix, subsec, trim_cursor | high | |
| 50 CONSOLE_LOGS | **implemented** | record_index u16 @9, unix @12, subsec @16, text @21 (chunk len @18 = 52, channel @20 = 1) | medium | |
| 51 REALTIME_IMU | **implemented** | live 1244-B body = v21 shape (hardware-attested noop #1709: START_RAW_DATA(81) then TOGGLE_IMU_MODE(106)[1,1]; stop 82 + [1,0]); my-whoop varlen kept as labeled hypothesis | medium | gated capture path (safety.js) |
| 52 HISTORICAL_IMU | **implemented** | routes through the shared versioned dispatch (v21 shape); unmapped bodies keep the whoop-vault plausibility note only | medium | |
| 53 RELATIVE_PUFFIN_EVENTS | needs capture | no layout anywhere; preserved raw | low | |
| 54 PUFFIN_EVENTS_FROM_STRAP | implemented (sibling p54/2) | strict record parser + kind payload decoders (k2/9/19/20), tag opaque, replay-only (never live wear evidence) | medium | owned by sibling session |
| 55 RELATIVE_BATTERY_PACK_CONSOLE | needs capture | no layout anywhere; preserved raw | low | |
| 56 PUFFIN_METADATA | **implemented** | alias of 49 | high | |
| MG/Labrador ECG | candidate | payload decode: 17-B status header + numberOfECGSamples + i16/blob; packet TYPE byte unattested (structural triage only) | low | commands 124/125/139; #1727 arg fix; **developer-mode consent required; never a product metric** |
| R22 feature-flag data | candidate | 16-flag enable sequence + read-only enumeration (117/118/115/116/121/128) decoded; **writes behind consent**; `enable_r22_packets` opens the type-47/v22 stream | high (facts) | see WHOOP5_R22_FLAG_REFERENCE.md |

## Historical versions (type 47)

| Version | Status | Evidence |
|---|---|---|
| 18 | **implemented** (frwhoop-gen5/2) | noop @2fe3a5c9 + openstrap @c78c1762 + judes.club + 340k-frame corpus (sibling 01a05630) |
| 20 | **implemented** | noop #423 (29,203-record corpus) + openstrap unit readings |
| 21 | **implemented** | noop #423/#493 (1423 buffers) + openstrap declared counts |
| 22 | **implemented** (candidate tier) | openstrap @c78c1762 only; noop has no v22 |
| 26 | **implemented** (PIP model) | openstrap saturated-delta model + sibling corpus byte-identity checks |
| W4 24/12/5/7/9 | version + header only | whoop4 deep port remains follow-on work |
| v22 tags 7+ / unmapped | preserved raw | honest unknown |

## Corpus census (measured 2026-08-31, `bin/protocol-census.mjs` over the real B2 Level-A corpus)

50,000-frame sample of the fully-cached archive (1945 objects; sibling session's
`/tmp/frwhoop-redecode/frames`), all CRC-valid:

| Metric | Value |
|---|---|
| frames classified | 49,999 (100% of framed rows; 0 crc_failed) |
| payload bytes structurally mapped (decoded + labeled raw) | 1,244,253 |
| unknown bytes | 466,358 (dominated by W4-1917 tail + v18 optical tail + W4 historical versions) |
| decoded bytes | 1,093,342 (+150,911 raw-kept) |
| fields semantically validated | 1,033,902 |
| decode status | decoded 46,641 / partial 10 / classified 3,348 |
| type mix | 47×31,975 (v18 30,931, v26 1,044) · 40×26,105 · 48×22,349 · 50×14,445 · 49×2,861 · 36×1,769 · 54×495 |
| largest distinct unknown spans | 15 distinct; top [23,33) and [26,33) v18 windows (pre-RR-slot fix), now reduced |

v18-negative-skin-temp codes (-1055..-1063 band, ~2,200 occurrences) are classified
`skin_temp_unavailable` (sentinel), not fabricated temperatures. Coverage/pinned expectations:
`tests/protocol/census.test.js` intentionally turns red on any decoder change (contract pinning).

- `backend/bin/protocol-census.mjs` + `backend/protocol/census.js` (aggregation lib): census by
  model, firmware, service family, characteristic, packet type, hist version, body tag, exact
  length; reports frames classified, CRC ok/failed, payload bytes structurally mapped vs unknown,
  fields semantically validated, top unknown spans, decode-status and warning histograms.
- Test suites (`node --test tests/protocol/*.test.js`): framing (CRC/reassembly/truncation),
  parity (real v18/v20/v21/v26 oracle frames), adversarial (boundaries, signedness, byte
  accounting, property/fuzz over mutated frames), registry/coverage/fuzz (bitmap exactness,
  saturated-delta reconstruction, 20-bit sign extension, Q15 header, mutation properties),
  safety (blocked commands, consent, battery floor, bounded duration), sidecars (versioned
  re-decode records), census (grouping/aggregation), puffin54 (sibling-owned), fixtures (OpenStrap
  golden parity for v22 tags + v18/v20/v21/v26).

## Safety (enforced in `backend/protocol/safety.js`)

- **Blocked opcodes** (never writable, never replayable): 25, 32, 36, 37, 38, 45, 99, 142, 143, 144.
- **No opcode sweeps, no automatic destructive commands.** Every command write/replay passes
  `gateCommand()`; verdicts carry a rule id + reason.
- **Developer-mode consent** (persisted, revocable, 24-h re-grant, per-scope) required for:
  raw-data capture (81/82/106), MG ECG (124/125/139), feature-flag writes (120),
  device-config writes (119). Read-only enumeration (117/118/115/116/121/128) needs no consent.
- **Bounded capture**: max duration (consent-capped ≤ 1 h), explicit stop command, auto-stop on
  expiry, battery floor (default 20%) before any capture session.
- R22 raw-data and MG ECG activation are **never** auto-run; the backend never originates writes.

## Coverage accounting format

Every `decodeFrame()` result carries `coverage = { summary, bitmap, unknown, warnings, confidence }`
where summary reports `total_bytes`, `by_class`, `decoded_bytes`, `raw_kept_bytes`,
`payload_bytes_structurally_mapped`, `mapped_pct`, `unknown_pct`, `fully_accounted`. Sidecars carry
the summary per (frame_hash, decoder_version). The registry gates every field: only
`product_eligible` tier may feed health metrics or normal UI — **no field currently holds that
tier** (per-field cross-device validation is the formal promotion path).

## Implemented / candidate / needs capture / blocked

| Bucket | Items |
|---|---|
| **implemented** | framing both families; reassembly + resync accounting; type 40 (HR + 4-slot RR with [200,2500] ms validation + Q15 subsec); type 43 (1917 IMU, 1921 optical, W5 v21-shape shared buffer); type 47 v18/v20/v21/v22/v26 full field maps + coverage; types 48/49/50/56 (unified event envelope, u16 ids, battery body); type 52 routing; type 54 structural + kinds (sibling p54/2); type 51 live-IMU (v21 shape); config read-back (115/116/117/118/121/128); CRC trio; byte-coverage bitmap on every output; re-decode sidecars; census tooling; safety gate |
| **candidate** | v18 dynamic-acceleration + gravity readings (conflict open); hr_quality_flags bit7 (conflict); @106-109 PD/psnr readings (conflict); f32_113 (signal-quality-log-variance vs unknown); v20 LED/ADC unit interpretations; v20 block-identity table (green/red/4th/IR/ambient — NOT used for labels); v22 tag semantics beyond structure; MG ECG payload decode; spo2_candidate_82 (duty-cycled, split evidence); R22 feature-flag vocabulary; status-word bitfields; ev21/22 pack events |
| **needs capture** | v20 wavelength identity (labelled occlusion experiment); types 53/55 layouts; type 52 non-v21 bodies; W4 historical versions 24/12/5/7/9 deep port; Monument/Symphony/puffin-1150 framing; v18 @104 marker + zero-padding semantics beyond observation; sub-70 @82 diagnostic codes; v22 extended-metrics field split; ECG packet TYPE byte |
| **blocked** | opcodes 25, 32, 36, 37, 38, 45, 99, 142, 143, 144 (never sent, never replayed); R22 enable-sequence writes without developer-mode consent; MG ECG activation without consent; live raw-IMU without consent + battery floor + bounded duration; any automatic/destructive command; any unvalidated ECG/SpO₂/morphology/orientation/classifier value feeding product metrics |

## Known honest residuals

1. W4 historical versions (24/12/5/7/9) remain version+header — deep port is follow-on work;
   bytes fully preserved and re-decodable.
2. Type-43 W4 variants keep unmapped gaps ([24:82], [682:685], tail [1292:1917]) and the 1921
   config header [15:42] + per-sample aux byte — all preserved raw with coverage.
3. v20 wavelength identity stays OPEN in both reference projects; FRWHOOP's product paths use
   neutral detector-path names.
4. The v18 acceleration semantic (gravity-removed magnitude vs max-adjacent-delta) and the
   refuted quaternion reading are tracked in registry CONFLICTS; neither feeds a metric.
5. The MG ECG packet TYPE byte is unattested; ECG payloads decode only after structural triage
   and only as candidate-tier instrumentation.
