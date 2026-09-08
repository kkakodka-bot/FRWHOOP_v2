
// FRWHOOP versioned semantic protocol registry.
//
// WHAT THIS IS: the single evidence ledger for every WHOOP protocol field this
// repo decodes. Each entry states WHERE a field sits (offset/width/endianness),
// WHAT it is called (neutral names only), HOW SURE we are (evidence tier), WHO
// established it (pinned source + commit), WHICH captures confirm it, HOW it is
// validated, and WHICH semantic conflicts between independent research lines
// remain unresolved. Nothing here feeds a health metric unless its tier is
// `product_eligible` — that gate is enforced by isProductEligible().
//
// LICENSE POLICY (protocol_sources.lock.json is the pin manifest):
//   - ryanbr/noop is PolyForm Noncommercial 1.0.0: protocol FACTS (offsets,
//     widths, CRC params, packet/event/command numbers) are explicitly
//     uncopyrightable and freely reusable per its LICENSE; its IMPLEMENTATION
//     code is NOT copied. FRWHOOP decoders are independent implementations.
//   - OpenStrap/protocol + research are MIT: facts and fixtures may be used
//     with attribution.
//   - b-nnett/goose and johnmiddleton12/wearable have NO license file: facts
//     only, no code reuse.
//   - Asherlc/dofek root is view-only (its whoop-ble/whoop-whoop subdirs are
//     MIT): facts from docs/whoop-ble-protocol.md only.
//   - judes.club article: no license; facts only with attribution.
//
// Every registry entry is immutable-by-convention: a corrected understanding
// adds a NEW entry and supersedes the old one (superseded_by), so old
// re-decode sidecars stay interpretable.

export const REGISTRY_VERSION = 'frwhoop-registry/2';

// Evidence tiers, ordered weakest -> strongest. Only product_eligible may feed
// health metrics or normal UI. Anything else is instrumentation/research only.
export const TIERS = Object.freeze({
  structural: 0,             // envelope/length/tag facts; no semantics claimed
  candidate: 1,              // one source asserts; not independently confirmed
  hardware_attested: 2,      // observed on real hardware by >=1 pinned source
  cross_device_validated: 3, // validated across devices/straps by pinned sources
  product_eligible: 4,       // gated + reviewed; may feed metrics/UI
});

export const TIER_ORDER = Object.freeze(['structural', 'candidate', 'hardware_attested', 'cross_device_validated', 'product_eligible']);

// ---- GATT service families (facts: noop DeviceFamily.swift @2fe3a5c9) ----
export const SERVICE_FAMILIES = Object.freeze({
  whoop4: {
    id: 'whoop4',
    displayName: 'WHOOP 4.0 (Harvard)',
    serviceUUID: '61080001-8d6d-82b8-614a-1c8cb0f8dcc6',
    characteristics: {
      command: '61080002-8d6d-82b8-614a-1c8cb0f8dcc6',
      notify: ['61080003-8d6d-82b8-614a-1c8cb0f8dcc6', '61080004-8d6d-82b8-614a-1c8cb0f8dcc6', '61080005-8d6d-82b8-614a-1c8cb0f8dcc6'],
    },
    envelope: 'harvard',
    connectable: true,
    source: { repo: 'ryanbr/noop', sha: '2fe3a5c9', path: 'Packages/WhoopProtocol/Sources/WhoopProtocol/DeviceFamily.swift' },
  },
  maverick_goose_fd4b: {
    id: 'maverick_goose_fd4b',
    displayName: 'WHOOP 5.0 / MG fd4b (Maverick/Goose "Puffin")',
    serviceUUID: 'fd4b0001-cce1-4033-93ce-002d5875f58a',
    characteristics: {
      command: 'fd4b0002-cce1-4033-93ce-002d5875f58a',
      notify: ['fd4b0003-cce1-4033-93ce-002d5875f58a', 'fd4b0004-cce1-4033-93ce-002d5875f58a', 'fd4b0005-cce1-4033-93ce-002d5875f58a', 'fd4b0007-cce1-4033-93ce-002d5875f58a'],
    },
    envelope: 'puffin',
    connectable: true,
    source: { repo: 'ryanbr/noop', sha: '2fe3a5c9', path: 'Packages/WhoopProtocol/Sources/WhoopProtocol/DeviceFamily.swift' },
  },
  puffin_1150: {
    id: 'puffin_1150',
    displayName: 'WHOOP Puffin service 1150',
    serviceUUID: '11500001-6215-11ee-8c99-0242ac120002',
    characteristics: {
      // characteristic short-UUID pattern 0002/0003/0004/0005/0007 on the
      // 1150 prefix — discovered, NOT connectable, framing unmapped.
      notify: ['11500002-6215-11ee-8c99-0242ac120002', '11500003-6215-11ee-8c99-0242ac120002', '11500004-6215-11ee-8c99-0242ac120002', '11500005-6215-11ee-8c99-0242ac120002', '11500007-6215-11ee-8c99-0242ac120002'],
    },
    connectable: false,
    note: 'detected-but-unsupported family; diagnostic presence only, never connected, never commanded',
    source: { repo: 'ryanbr/noop', sha: '2fe3a5c9', path: 'Packages/WhoopProtocol/Sources/WhoopProtocol/DeviceFamily.swift' },
  },
  monument: {
    id: 'monument',
    displayName: 'WHOOP MONUMENT',
    serviceUUID: '8a580001-2fe8-4796-9267-b87a2b0c8234',
    characteristicPrefix: '8a58', characteristicSuffix: '2fe8-4796-9267-b87a2b0c8234',
    connectable: false,
    note: 'detected but unsupported; likely Castle/Rev2 framing (noop docs/PROTOCOL.md §1). Presence logged only.',
    source: { repo: 'ryanbr/noop', sha: '2fe3a5c9', path: 'Packages/WhoopProtocol/Sources/WhoopProtocol/DeviceFamily.swift' },
  },
  symphony: {
    id: 'symphony',
    displayName: 'WHOOP SYMPHONY',
    serviceUUID: '59830001-5955-419b-bb8d-c8262926af23',
    characteristicPrefix: '5983', characteristicSuffix: '5955-419b-bb8d-c8262926af23',
    connectable: false,
    note: 'detected but unsupported; presence logged only',
    source: { repo: 'ryanbr/noop', sha: '2fe3a5c9', path: 'Packages/WhoopProtocol/Sources/WhoopProtocol/DeviceFamily.swift' },
  },
});

export function familyForServiceUUID(uuid) {
  if (!uuid) return null;
  const u = String(uuid).toLowerCase();
  for (const fam of Object.values(SERVICE_FAMILIES)) {
    if (fam.serviceUUID === u) return fam.id;
  }
  return null;
}

// ---- Packet types (noop whoop_protocol.json enums.PacketType @2fe3a5c9) ----
export const PACKET_TYPES = Object.freeze({
  35: 'COMMAND', 36: 'COMMAND_RESPONSE', 37: 'PUFFIN_COMMAND',
  38: 'PUFFIN_COMMAND_RESPONSE', 40: 'REALTIME_DATA', 43: 'REALTIME_RAW_DATA',
  47: 'HISTORICAL_DATA', 48: 'EVENT', 49: 'METADATA', 50: 'CONSOLE_LOGS',
  51: 'REALTIME_IMU_DATA_STREAM', 52: 'HISTORICAL_IMU_DATA_STREAM',
  53: 'RELATIVE_PUFFIN_EVENTS', 54: 'PUFFIN_EVENTS_FROM_STRAP',
  55: 'RELATIVE_BATTERY_PACK_CONSOLE_LOGS', 56: 'PUFFIN_METADATA',
});

// ---- Event numbers (noop whoop_protocol.json enums.EventNumber @2fe3a5c9) ----
export const EVENT_NUMBERS = Object.freeze({
  0: 'UNDEFINED', 1: 'ERROR', 2: 'CONSOLE_OUTPUT', 3: 'BATTERY_LEVEL',
  4: 'SYSTEM_CONTROL', 5: 'EXTERNAL_5V_ON', 6: 'EXTERNAL_5V_OFF',
  7: 'CHARGING_ON', 8: 'CHARGING_OFF', 9: 'WRIST_ON', 10: 'WRIST_OFF',
  11: 'BLE_CONNECTION_UP', 12: 'BLE_CONNECTION_DOWN', 13: 'RTC_LOST',
  14: 'DOUBLE_TAP', 15: 'BOOT', 16: 'SET_RTC', 17: 'TEMPERATURE_LEVEL',
  18: 'PAIRING_MODE', 19: 'SERIAL_HEAD_CONNECTED', 20: 'SERIAL_HEAD_REMOVED',
  21: 'BATTERY_PACK_CONNECTED', 22: 'BATTERY_PACK_REMOVED', 23: 'BLE_BONDED',
  24: 'BLE_HR_PROFILE_ENABLED', 25: 'BLE_HR_PROFILE_DISABLED',
  26: 'TRIM_ALL_DATA', 27: 'TRIM_ALL_DATA_ENDED', 28: 'FLASH_INIT_COMPLETE',
  29: 'STRAP_CONDITION_REPORT', 30: 'BOOT_REPORT', 31: 'EXIT_VIRGIN_MODE',
  32: 'CAPTOUCH_AUTOTHRESHOLD_ACTION', 33: 'BLE_REALTIME_HR_ON',
  34: 'BLE_REALTIME_HR_OFF', 35: 'ACCELEROMETER_RESET', 36: 'AFE_RESET',
  37: 'SHIP_MODE_ENABLED', 38: 'SHIP_MODE_DISABLED', 39: 'SHIP_MODE_BOOT',
  40: 'CH1_SATURATION_DETECTED', 41: 'CH2_SATURATION_DETECTED',
  42: 'ACCELEROMETER_SATURATION_DETECTED', 43: 'BLE_SYSTEM_RESET',
  44: 'BLE_SYSTEM_ON', 45: 'BLE_SYSTEM_INITIALIZED', 46: 'RAW_DATA_COLLECTION_ON',
  47: 'RAW_DATA_COLLECTION_OFF', 56: 'STRAP_DRIVEN_ALARM_SET',
  57: 'STRAP_DRIVEN_ALARM_EXECUTED', 58: 'APP_DRIVEN_ALARM_EXECUTED',
  59: 'STRAP_DRIVEN_ALARM_DISABLED', 60: 'HAPTICS_FIRED',
  63: 'EXTENDED_BATTERY_INFORMATION', 96: 'HIGH_FREQ_SYNC_PROMPT',
  97: 'HIGH_FREQ_SYNC_ENABLED', 98: 'HIGH_FREQ_SYNC_DISABLED',
  100: 'HAPTICS_TERMINATED',
});

// ---- Evidence sources (pinned; see protocol_sources.lock.json) ----
export const SOURCES = Object.freeze({
  noop: { repo: 'ryanbr/noop', sha: '2fe3a5c92cb46ec338a798c9b7d097022f202814', license: 'PolyForm-Noncommercial-1.0.0', facts_only: true },
  noop_pinned_baseline: { repo: 'ryanbr/noop', sha: 'ab0f699e17bde653e3ef0bf5963e991b3e4a9d3d', license: 'PolyForm-Noncommercial-1.0.0', facts_only: true },
  openstrap_protocol: { repo: 'OpenStrap/protocol', sha: 'c78c176295e3dcbc183bf3309bf94cb251c2c3d1', license: 'MIT' },
  openstrap_research: { repo: 'OpenStrap/research', sha: 'c6be09c4021546e4693dcf74da25d7b793ff8a40', license: 'MIT' },
  goose: { repo: 'b-nnett/goose', sha: 'ba9ae0280c9b5b9a1545baab8e944cb3b7563c62', license: 'NONE', facts_only: true },
  wearable: { repo: 'johnmiddleton12/wearable', sha: '890e0c96beb817ab0cec3aaf7d9a06c530025355', license: 'NONE', facts_only: true },
  dofek: { repo: 'Asherlc/dofek', sha: '057a9bdeaacd3f3afc8adac264be12ee8c48ece0', license: 'VIEW-ONLY (root); MIT subdirs', facts_only: true },
  judes_club: { repo: 'https://judes.club/writing/cracking-the-whoop-5-bluetooth-protocol/', sha: 'fetched-2026-08-31', license: 'NONE', facts_only: true },
});

// ---- Conflicts ledger: claims that disagree between pinned sources. ----
// Status: open | resolved:<winner> | refuted. A decoder exposing a conflicted
// field MUST name the conflict key here; the UI/metrics layer must never pick
// a side on an open conflict.
export const CONFLICTS = Object.freeze({
  'v18.dynamic_acceleration': {
    field: 'v18 f32 @41',
    claims: [
      { source: 'noop', reading: 'gravity-removed acceleration magnitude, gate 0..8 g', evidence: 'physiological cross-validation over 18,650 records' },
      { source: 'openstrap_protocol', reading: 'MAX ADJACENT acceleration-vector-magnitude delta (g), full-scale ±16 g check only; byte-equal to v26 @75 twin', evidence: 'byte-identity with v26/v22-tag5 embedded f32' },
      { source: 'community (judes.club)', reading: 'orientation quaternion (x,y,z,w)', evidence: 'REFUTED by author: |quat| ~ 1 was coincidence; rotation-response testing pinned accelerometer' },
    ],
    status: 'open',
    policy: 'expose value raw + both structural readings; no product metric may gate on either reading until resolved with controlled captures',
  },
  'v18.gravity_vector': {
    field: 'v18 f32 @45/49/53',
    claims: [
      { source: 'noop', reading: 'gravity_x/y/z normalized-ish vector, |g| ≈ 1 g on 100% of 500 records', evidence: 'cross-device validation' },
      { source: 'openstrap_protocol', reading: 'per-axis means of raw accel, NOT normalized; a worn strap in motion legitimately exceeds 1 g; NO gen4 gravity window', evidence: 'byte-level re-verification against real fixtures' },
    ],
    status: 'open',
    policy: 'apply only finiteness + ±16 g full-scale gate; never reject records for leaving the 1 g shell; record |g| as labeled validator metadata',
  },
  'v18.hr_quality_flags.bit7': {
    field: 'v18 u8 @36 bit7',
    claims: [
      { source: 'noop', reading: 'HR/R-R validity bit (rr_count==0 70.3% clear vs 19.8% set)', evidence: '18,650-record census' },
      { source: 'openstrap_protocol', reading: 'NOT an HR-valid flag; tracks heart_rate vs heart_rate_alt agreement; valid HR routinely present with bit clear', evidence: 'their corpus toggles ~50/50 independent of HR presence' },
    ],
    status: 'open',
    policy: 'byte exposed raw; no consumer may gate HR on bit7 until resolved',
  },
  'v18.sleep_state_byte.b0_1': {
    field: 'v18 u8 @81 bits 0-1',
    claims: [
      { source: 'noop', reading: 'onwrist flag' },
      { source: 'openstrap_protocol', reading: 'primary-flags bit-8 snapshot; NOT wear state (wear comes from HELLO/events/type-40 presence)' },
    ],
    status: 'open',
    policy: 'expose nibble raw under both names; deprecated onWrist alias retained but never used for gating',
  },
  'v18.sleep_state_byte.b2_3': {
    field: 'v18 u8 @81 bits 2-3',
    claims: [
      { source: 'noop', reading: 'wake quality (nonzero only in wake)' },
      { source: 'openstrap_protocol', reading: 'passive strap-fit classifier state' },
    ],
    status: 'open',
    policy: 'expose raw nibble only',
  },
  'v18.activity_class.zero': {
    field: 'v18 u8 @63',
    claims: [
      { source: 'noop', reading: '0 = still, 1 = walk, 2 = run (0xFF invalid)' },
      { source: 'openstrap_protocol', reading: '0 = unclassified/unknown (band has not committed), NOT still; 0xFF malformed' },
    ],
    status: 'open',
    policy: 'raw byte stored; known-codes surfaced with "unknown-class" caveat for 0; never count 0 as sedentary',
  },
  'v18.optical_tail_106_109': {
    field: 'v18 u8 pairs @106/107 and @108/109',
    claims: [
      { source: 'noop', reading: 'optical_baseline_a/b (independent u8 channels, 0 = off-wrist) + optical_amp_a/b (tight pair, 128 = record-level sentinel)' },
      { source: 'openstrap_protocol', reading: 'pdMeanB@106 / pdMeanA@107 (detector means) + psnrB/psnrA signed i8 with -128 unavailable sentinel' },
    ],
    status: 'open',
    policy: 'bytes raw; both namings recorded; the 0x80 sentinel-pair behavior is agreed and exposed as is_optical_sentinel',
  },
  'v18.f32_113': {
    field: 'v18 f32 @113',
    claims: [
      { source: 'noop', reading: 'unknown_f32_113 (purpose unknown, observed -5.3..0)' },
      { source: 'openstrap_protocol', reading: 'signal_quality_log_variance' },
    ],
    status: 'open',
    policy: 'value exposed; candidate name recorded; no gating',
  },
  'v20.block_identity': {
    field: 'v20 block index 0..4 → emitter/measure',
    claims: [
      { source: 'noop', reading: 'neutral: five measurement blocks; two slots under one head are detector paths (TIA1/TIA2), NOT two wavelengths; identity OPEN' },
      { source: 'openstrap_protocol', reading: 'block table: 0=green(primary HR), 1=red, 2=fourth channel, 3=IR (fallback flagged by flags bit0), 4=ambient/dark' },
    ],
    status: 'open',
    policy: 'FRWHOOP uses neutral detector-path names in product paths; OpenStrap block identity stored as candidate metadata only. Never label detector paths as wavelengths in metrics.',
  },
  'v20.slot_semantics': {
    field: 'v20 two 200-byte slots per block',
    claims: [
      { source: 'noop', reading: 'two detector paths under ONE shared measurement config (select/range/offset per path)' },
      { source: 'openstrap_protocol', reading: 'stream A = TIA 1, stream B = TIA 2; physical PD routing is dynamic and read from the descriptor' },
    ],
    status: 'compatible',
    policy: 'expose as detector_path_0/1 with per-path source/range/offset metadata',
  },
  'v21.sample_counts': {
    field: 'v21 u16 @24/@630',
    claims: [
      { source: 'noop', reading: 'countA/countB sample counts (=100 on all captured buffers); capacity implicit' },
      { source: 'openstrap_protocol', reading: 'each block prefixed [u16 capacity][u16 count][u8 sensor id][u8 flags]; count is the SECOND word (frame 24/630); 1..100 valid; partly-filled buffers are genuine' },
    ],
    status: 'resolved:declared_counts',
    policy: 'decode exactly countA/countB samples; never read stale trailing bytes; sensor ids 3=accel,5=gyro candidate',
  },
  'v26.samples_vs_deltas': {
    field: 'v26 bytes 27:75',
    claims: [
      { source: 'noop', reading: '24 i16 PPG samples @24 Hz (SUPERSEDED)' },
      { source: 'openstrap_protocol', reading: '24 saturated i16 DELTAS over a 25-sample window whose sample 0 is the i32 @23; rate from flags bit7 (25/50 Hz), counts are not rates' },
    ],
    status: 'resolved:openstrap_saturated_deltas',
    policy: 'deltas kept raw; reconstruction via reconstructSaturatedDeltaWindow() with saturation + range bookkeeping',
  },
});

export function conflictById(id) { return CONFLICTS[id] || null; }

// ---- Field registry ----
// entry = {
//   key, family, characteristic, direction, packetType, histVersion, tag,
//   exactLength, flags, fields: [{name, off, len, dtype, endian, scale, unit,
//   tier, sources: [sourceKey], validators: [], conflicts: [], notes,
//   downstream}], superseded_by
// }
// direction: 'device_to_app' | 'app_to_device'
const now = () => new Date().toISOString();

export const REGISTRY_ENTRIES = [];

function entry(spec) {
  const e = { registered_at: now(), registry_version: REGISTRY_VERSION, ...spec };
  REGISTRY_ENTRIES.push(e);
  return e;
}

const NOOP = 'noop@2fe3a5c9';
const OS = 'openstrap_protocol@c78c1762';

// Shared Gen5 historical header (OpenStrat-pinned; NOOP-agnostic since NOOP
// does not map the flags/subsec slots yet).
entry({
  key: 'puffin/47/header',
  family: 'maverick_goose_fd4b', characteristic: 'fd4b0005-cce1-4033-93ce-002d5875f58a',
  direction: 'device_to_app', packetType: 47, direction_note: 'also 43/52 bodies share this header',
  fields: [
    { name: 'record_class', off: 8, len: 1, dtype: 'u8', tier: 'structural', sources: [NOOP, 'judes_club'], unit: null, note: '0x2F record class for the gen5 biometric family' },
    { name: 'hist_version', off: 9, len: 1, dtype: 'u8', tier: 'structural', sources: [NOOP, 'openstrap_protocol'], unit: null, note: 'layout version selector (18/20/21/22/26)' },
    { name: 'flags', off: 10, len: 1, dtype: 'u8', tier: 'hardware_attested', sources: ['openstrap_protocol'], unit: null, note: 'bit7 = optical front end at 25 Hz (set) vs 50 Hz (clear); v20 bit0 = IR-fallback; NOOP reads this byte as opaque layout_marker', conflicts: ['noop layout_marker vs OpenStrap flags byte — compatible: NOOP observed 0x80/0x81 which are bit7 set (+bit0 on v20)'] },
    { name: 'record_index', off: 11, len: 4, dtype: 'u32le', tier: 'hardware_attested', sources: [NOOP, 'openstrap_protocol'], unit: 'count', note: 'monotonic lifetime counter, not unix; u32 domain (Android sign bug upstream #869)' },
    { name: 'unix', off: 15, len: 4, dtype: 'u32le', tier: 'cross_device_validated', sources: [NOOP, 'openstrap_protocol'], unit: 's', note: 'strap unix seconds' },
    { name: 'subsec_q15', off: 19, len: 2, dtype: 'u16le', tier: 'candidate', sources: ['openstrap_protocol'], unit: '1/32768 s', note: 'Q15 fraction: seconds = value/32768; gen4 R24 exposes the same field; v26 reuses it as segmentId (hundredths packed as k*32768/100)' },
  ],
  derived: [
    { name: 'subsec_seconds', formula: 'subsec_q15 / 32768', unit: 's', tier: 'candidate', sources: ['openstrap_protocol'] },
    { name: 'ppg_sample_rate_hz', formula: 'flags bit7 ? 25 : 50', unit: 'Hz', tier: 'candidate', sources: ['openstrap_protocol'], note: 'the flag-controlled 25/50 Hz optical rate; nothing else on the wire carries the rate' },
  ],
});

// v18 per-second summary (inner 112 B / frame 124 B)
entry({
  key: 'puffin/47/v18', family: 'maverick_goose_fd4b', direction: 'device_to_app',
  packetType: 47, histVersion: 18, exactLength: 124,
  fields: [
    { name: 'heart_rate', off: 22, len: 1, dtype: 'u8', unit: 'bpm', tier: 'cross_device_validated', sources: [NOOP, 'judes_club', 'openstrap_protocol'], validators: ['hr absent = 0; plausible gate 25..230 else null+warning'], note: '0 = band no-reading sentinel' },
    { name: 'rr_count', off: 23, len: 1, dtype: 'u8', unit: null, tier: 'hardware_attested', sources: [NOOP, 'openstrap_protocol'], validators: ['declared count capped at 4 slots; accepted count = validated intervals length'] },
    { name: 'rr_intervals_ms', off: 24, len: 8, dtype: 'i16le[4]', unit: 'ms', tier: 'cross_device_validated', sources: [NOOP, 'openstrap_protocol'], validators: ['each in [200, 2500] ms (openstrap kMinRrMs/kMaxRrMs; noop v>0)', 'wire order preserved (beats in emission order)'] },
    { name: 'cardiac_flags', off: 33, len: 1, dtype: 'u8', tier: 'candidate', sources: [NOOP], note: 'noop #845: beat-detection quality byte, not cardiac' },
    { name: 'hr_quality_flags', off: 36, len: 1, dtype: 'u8', tier: 'hardware_attested', sources: [NOOP, 'openstrap_protocol'], conflicts: ['v18.hr_quality_flags.bit7'] },
    { name: 'heart_rate_alt', off: 37, len: 1, dtype: 'u8', unit: 'bpm', tier: 'hardware_attested', sources: [NOOP, 'judes_club'], note: 'second HR byte (hr_ch_switching flag pairs it with CH switching); noop: duplicate HR 99.6% exact when @36 bit7 set' },
    { name: 'rr_packed', off: 38, len: 2, dtype: 'u16le', tier: 'structural', sources: [NOOP, 'openstrap_protocol'], note: 'raw; meaning unpinned on both' },
    { name: 'cardiac_status', off: 40, len: 1, dtype: 'u8', tier: 'structural', sources: [NOOP, 'openstrap_protocol'], note: 'noop: raw status-like; openstrap: whoop-rs "signal_quality" >=192 gate refuted (96.7% pass, no track)' },
    { name: 'dynamic_acceleration', off: 41, len: 4, dtype: 'f32le', unit: 'g', tier: 'hardware_attested', sources: [NOOP, 'openstrap_protocol'], conflicts: ['v18.dynamic_acceleration'], validators: ['finite; 0..8 g (noop) vs ±16 g full-scale (openstrap) — FRWHOOP applies full-scale only'] },
    { name: 'gravity_or_accel_means', off: 45, len: 12, dtype: 'f32le[3]', unit: 'g', tier: 'cross_device_validated', sources: [NOOP, 'openstrap_protocol'], conflicts: ['v18.gravity_vector'], note: 'noop: gravity_x/y/z; openstrap: per-axis accel means (NOT normalized); judes.club: accelerometer xyz proven by tilt response' },
    { name: 'step_motion_counter', off: 57, len: 2, dtype: 'u16le', tier: 'candidate', sources: [NOOP, 'openstrap_protocol'], note: 'both: behaviour pinned (near-monotonic), producer not; name kept from two independent clients' },
    { name: 'step_cadence', off: 59, len: 1, dtype: 'u8', tier: 'candidate', sources: [NOOP, 'openstrap_protocol'] },
    { name: 'activity_class', off: 63, len: 1, dtype: 'u8', tier: 'candidate', sources: [NOOP, 'openstrap_protocol'], conflicts: ['v18.activity_class.zero'] },
    { name: 'temp_aux_1_raw', off: 69, len: 2, dtype: 'i16le', unit: '0.1 C', tier: 'hardware_attested', sources: [NOOP], validators: ['v/10 in 0..60 C'] },
    { name: 'temp_aux_2_raw', off: 71, len: 2, dtype: 'i16le', unit: '0.1 C', tier: 'hardware_attested', sources: [NOOP] },
    { name: 'skin_temp_raw', off: 73, len: 2, dtype: 'u16le', unit: '0.01 C', tier: 'cross_device_validated', sources: [NOOP], validators: ['C = raw/100 in 5..45 (rejected /128 alternative)'], note: 'openstrap reads i16 (signed); noop u16 — conflict minor, positive domain identical' },
    { name: 'status_word', off: 75, len: 2, dtype: 'u16le', tier: 'structural', sources: [NOOP, 'openstrap_protocol'] },
    { name: 'status_word_1', off: 77, len: 2, dtype: 'u16le', tier: 'structural', sources: [NOOP, 'openstrap_protocol'] },
    { name: 'status_word_2', off: 79, len: 2, dtype: 'u16le', tier: 'structural', sources: [NOOP, 'openstrap_protocol'] },
    { name: 'sleep_state_byte', off: 81, len: 1, dtype: 'u8', tier: 'cross_device_validated', sources: [NOOP, 'openstrap_protocol'], conflicts: ['v18.sleep_state_byte.b0_1', 'v18.sleep_state_byte.b2_3'], note: 'bits 4-5 = sleep-state envelope (wake/still/asleep/up) agreed by both; NOT a hypnogram' },
    { name: 'spo2_candidate_82', off: 82, len: 1, dtype: 'u8', tier: 'candidate', sources: [NOOP], downstream: 'instrumentation_only', note: 'tri-mode 70..100 in-band; duty-cycled (15×30-record windows, period 1200 s); cross-device evidence SPLIT; never a product metric' },
    { name: 'optical_baseline_ab', off: 106, len: 2, dtype: 'u8[2]', tier: 'structural', sources: [NOOP, 'openstrap_protocol'], conflicts: ['v18.optical_tail_106_109'] },
    { name: 'optical_amp_or_psnr', off: 108, len: 2, dtype: 'i8[2]', tier: 'structural', sources: [NOOP, 'openstrap_protocol'], conflicts: ['v18.optical_tail_106_109'], note: '0x80/-128 = paired unavailable sentinel' },
    { name: 'f32_113', off: 113, len: 4, dtype: 'f32le', tier: 'structural', sources: [NOOP, 'openstrap_protocol'], conflicts: ['v18.f32_113'] },
  ],
  rawSpans: [ { from: 19, to: 21, note: 'subsec_q15 u16 (header-decoded; also listed in header entry)' }, { from: 84, to: 105, note: 'mostly zero padding + @104 0x01 marker' }, { from: 110, to: 112, note: 'zero padding' }, { from: 117, to: 119, note: 'zero padding' } ],
  sources: [NOOP, 'openstrap_protocol', 'judes_club'],
});

// v20 optical buffer (frame 2140 B, inner 2128 B, five 422 B blocks from frame 26)
entry({
  key: 'puffin/47/v20', family: 'maverick_goose_fd4b', direction: 'device_to_app',
  packetType: 47, histVersion: 20, exactLength: 2140,
  fields: [
    { name: 'sample_rate_hz', off: 23, len: 2, dtype: 'u16le', unit: 'Hz', tier: 'candidate', sources: ['openstrap_protocol'], validators: ['should equal flags-bit7 derived 25/50'] },
    { name: 'block[i].sample_count', off: 26 + 422, len: 1, dtype: 'u8', per: 'block', stride: 422, count: 5, tier: 'hardware_attested', sources: [NOOP, 'openstrap_protocol'], validators: ['<= 50 slot capacity; >50 treated as empty (openstrap) or record-reject (noop) — FRWHOOP: empty + warning'] },
    { name: 'block[i].led_a_driver_connection', off: 27, len: 1, dtype: 'u8', tier: 'candidate', sources: ['openstrap_protocol'], note: 'noop neutral name source_a' },
    { name: 'block[i].led_a_current_raw', off: 28, len: 2, dtype: 'u16le', unit: '10 uA', tier: 'candidate', sources: ['openstrap_protocol'], note: 'noop neutral name drive_a; observed {1150,1400,1750,2200,2750,3350}' },
    { name: 'block[i].led_b_driver_connection', off: 30, len: 1, dtype: 'u8', tier: 'candidate', sources: ['openstrap_protocol'], note: 'noop neutral name source_b; 4 in every block' },
    { name: 'block[i].led_b_current_raw', off: 31, len: 2, dtype: 'u16le', unit: '10 uA', tier: 'candidate', sources: ['openstrap_protocol'], note: 'noop neutral name drive_b; = 2x drive_a on block 0' },
    { name: 'block[i].detector0_source', off: 33, len: 1, dtype: 'u8', tier: 'candidate', sources: [NOOP, 'openstrap_protocol'], note: 'physical PD routed into TIA1; noop neutral name detector_a_select' },
    { name: 'block[i].detector0_range', off: 34, len: 4, dtype: 'u32le', unit: 'uA (candidate)', tier: 'candidate', sources: [NOOP, 'openstrap_protocol'], note: 'noop: range_a u32; observed 16/32; openstrap: ADC full-scale range in uA' },
    { name: 'block[i].detector0_offset_current', off: 38, len: 2, dtype: 'i16le', unit: '10 nA/LSB', tier: 'candidate', sources: [NOOP, 'openstrap_protocol'], note: 'noop: offset_a; observed multiples of 800; openstrap: signed TIA offset current (0/8000/16000/24000 nA quantized)' },
    { name: 'block[i].detector1_source', off: 40, len: 1, dtype: 'u8', tier: 'candidate', sources: [NOOP, 'openstrap_protocol'] },
    { name: 'block[i].detector1_range', off: 41, len: 4, dtype: 'u32le', unit: 'uA (candidate)', tier: 'candidate', sources: [NOOP, 'openstrap_protocol'] },
    { name: 'block[i].detector1_offset_current', off: 44, len: 2, dtype: 'i16le', unit: '10 nA/LSB', tier: 'candidate', sources: [NOOP, 'openstrap_protocol'] },
    { name: 'block[i].samples0', off: 47, len: 200, dtype: 'i32le[n] sign-extended 20-bit', unit: 'ADC counts', tier: 'hardware_attested', sources: [NOOP, 'openstrap_protocol'], validators: ['domain [-524288, 524287]; 4th byte only 0x00/0xFF in 4,380,450 containers (noop)'] },
    { name: 'block[i].samples1', off: 247, len: 200, dtype: 'i32le[n] sign-extended 20-bit', unit: 'ADC counts', tier: 'hardware_attested', sources: [NOOP, 'openstrap_protocol'], conflicts: ['v20.slot_semantics'] },
    { name: 'block[i].reserved', off: 447, len: 1, dtype: 'u8', tier: 'structural', sources: [NOOP], note: 'zero in 29,203/29,203 records' },
  ],
  derived: [
    { name: 'block_count', value: 5 }, { name: 'channels_per_block', value: 2 },
    { name: 'block_rate_hz', formula: 'sample_count (records are 1 Hz)', unit: 'Hz', note: '25 vs 50 samples per record; cross-check flags bit7' },
  ],
  conflicts: ['v20.block_identity', 'v20.slot_semantics'],
  rawSpans: [],
  note: 'CRC32 input span is [8:2136] (record-class byte start), NOT [26:2136] — noop #423 correction corroborated by digitalerdude v26 CRC analysis',
  sources: [NOOP, 'openstrap_protocol'],
});

// v21 6-axis IMU buffer (frame 1244 B / inner 1232 B) — ONE decoder shared by
// types 43 (live 0x2B), 47 (historical v21) and 52.
entry({
  key: 'puffin/imu_buffer', family: 'maverick_goose_fd4b', direction: 'device_to_app',
  packetType: '43|47|51|52', histVersion: 21, exactLength: 1244,
  fields: [
    { name: 'block_a.capacity', off: 22, len: 2, dtype: 'u16le', tier: 'candidate', sources: ['openstrap_protocol'], note: 'fixed 100' },
    { name: 'block_a.count (countA)', off: 24, len: 2, dtype: 'u16le', tier: 'hardware_attested', sources: [NOOP, 'openstrap_protocol'], validators: ['1..100; decode exactly countA samples — never stale trailing bytes'] },
    { name: 'block_a.sensor_id', off: 26, len: 1, dtype: 'u8', tier: 'candidate', sources: ['openstrap_protocol'], note: '3 = accelerometer' },
    { name: 'block_a.flags', off: 27, len: 1, dtype: 'u8', tier: 'candidate', sources: ['openstrap_protocol'] },
    { name: 'accel_x', off: 28, len: 200, dtype: 'i16le[countA]', unit: 'LSB (1/4096 g)', tier: 'cross_device_validated', sources: [NOOP, 'openstrap_protocol'], validators: ['gravity shell ~1.01 g over 1423 buffers (noop #423)'] },
    { name: 'accel_y', off: 228, len: 200, dtype: 'i16le[countA]', unit: 'LSB', tier: 'cross_device_validated', sources: [NOOP, 'openstrap_protocol'] },
    { name: 'accel_z', off: 428, len: 200, dtype: 'i16le[countA]', unit: 'LSB', tier: 'cross_device_validated', sources: [NOOP, 'openstrap_protocol'] },
    { name: 'block_b.capacity', off: 624, len: 2, dtype: 'u16le', tier: 'candidate', sources: ['openstrap_protocol'] },
    { name: 'block_b.count (countB)', off: 630, len: 2, dtype: 'u16le', tier: 'hardware_attested', sources: [NOOP, 'openstrap_protocol'], validators: ['1..100'] },
    { name: 'block_b.sensor_id', off: 632, len: 1, dtype: 'u8', tier: 'candidate', sources: ['openstrap_protocol'], note: '5 = gyroscope' },
    { name: 'block_b.flags', off: 633, len: 1, dtype: 'u8', tier: 'candidate', sources: ['openstrap_protocol'] },
    { name: 'gyro_x', off: 640, len: 200, dtype: 'i16le[countB]', unit: 'LSB (2000/32768 dps)', tier: 'cross_device_validated', sources: [NOOP, 'openstrap_protocol'] },
    { name: 'gyro_y', off: 840, len: 200, dtype: 'i16le[countB]', unit: 'LSB', tier: 'cross_device_validated', sources: [NOOP, 'openstrap_protocol'] },
    { name: 'gyro_z', off: 1040, len: 200, dtype: 'i16le[countB]', unit: 'LSB', tier: 'cross_device_validated', sources: [NOOP, 'openstrap_protocol'] },
  ],
  conflicts: ['v21.sample_counts'],
  note: 'one buffer, many carriers: 47 historical, 43 live (after START_RAW_DATA(81)+TOGGLE_IMU_MODE(106)[1,1]), 52 when the strap banks it; identical header/offsets/scales in all cases (openstrap; noop #1709 hardware-verified for live)',
  sources: [NOOP, 'openstrap_protocol'],
});

// v22 research/diagnostic record (frame 188 B / inner 176 B; body tag at frame 21)
entry({
  key: 'puffin/47/v22', family: 'maverick_goose_fd4b', direction: 'device_to_app',
  packetType: 47, histVersion: 22, exactLength: 188,
  gated: {
    required_flag: 'enable_r22_packets',
    access: 'developer_mode_consent_required',
    note: 'R22 = opt-in research telemetry opened by the feature-flag sequence; FRWHOOP must never write the flag outside a consented developer-mode capture',
  },
  fields: [
    { name: 'tag', off: 21, len: 1, dtype: 'u8', tier: 'hardware_attested', sources: ['openstrap_protocol'], note: 'body byte 0; EMITTED tag keys the layout (writer can fall back 3->2, 5->4)' },
    { name: 'tag1/2/4 window.first_sample', off: 23, len: 4, dtype: 'i32le sign-extended 20-bit', tier: 'hardware_attested', sources: ['openstrap_protocol'] },
    { name: 'tag1/2/4 window.deltas', off: 27, len: 98, dtype: 'i16le[49] saturated deltas', tier: 'hardware_attested', sources: ['openstrap_protocol'], note: 'rail values ±32767/-32768 end the usable band; slots past it are stale, not zero' },
    { name: 'tag1/2/4 meta.flags_snapshot', off: 118, len: 1, dtype: 'u8', tier: 'candidate', sources: ['openstrap_protocol'] },
    { name: 'tag1/2/4 meta.accel_delta_g', off: 121, len: 4, dtype: 'f32le', unit: 'g', tier: 'hardware_attested', sources: ['openstrap_protocol'], note: 'byte-identical to twin v18 @41' },
    { name: 'tag1/2/4 meta.unnamed_floats', off: 133, len: 12, dtype: 'f32le[3]', tier: 'structural', sources: ['openstrap_protocol'], note: 'deliberately unnamed' },
    { name: 'tag1/2/4 meta.state_word', off: 137, len: 2, dtype: 'u16le', tier: 'candidate', sources: ['openstrap_protocol'], note: '= twin v18 status_word' },
    { name: 'tag1/2/4 meta.primary_flags', off: 143, len: 1, dtype: 'u8', tier: 'candidate', sources: ['openstrap_protocol'] },
    { name: 'tag2/4 extended_metrics_raw', off: 144, len: 11, dtype: 'bytes[11]', tier: 'structural', sources: ['openstrap_protocol'], note: 'location pinned, field split NOT established' },
    { name: 'tag3 windowA', off: 23, len: 52, dtype: 'i32 + i16le[24]', tier: 'hardware_attested', sources: ['openstrap_protocol'], note: 'two 24-slot windows; channels not named' },
    { name: 'tag3 windowB', off: 75, len: 52, dtype: 'i32 + i16le[24]', tier: 'hardware_attested', sources: ['openstrap_protocol'] },
    { name: 'tag3 meta (base+2)', off: 127, len: 0, dtype: null, tier: 'candidate', sources: ['openstrap_protocol'] },
    { name: 'tag5 pip_record_unix', off: 23, len: 4, dtype: 'u32le', unit: 's', tier: 'hardware_attested', sources: ['openstrap_protocol'], note: 'embedded completed-PIP ring second; carrier unix runs tens of seconds AHEAD' },
    { name: 'tag5 embedded pip (v26-shape)', off: 29, len: 54, dtype: 'i32 + i16le[24] + f32 + u16 + u8', tier: 'hardware_attested', sources: ['openstrap_protocol'] },
    { name: 'tag6 accel_raw_x', off: 26, len: 50, dtype: 'i16le[25]', unit: 'LSB (1/4096 g)', tier: 'hardware_attested', sources: ['openstrap_protocol'], note: 'alignment proven by within-axis smoothness' },
    { name: 'tag6 accel_raw_y', off: 76, len: 50, dtype: 'i16le[25]', tier: 'hardware_attested', sources: ['openstrap_protocol'] },
    { name: 'tag6 accel_raw_z', off: 126, len: 50, dtype: 'i16le[25]', tier: 'hardware_attested', sources: ['openstrap_protocol'] },
    { name: 'tag6 tail', off: 176, len: 8, dtype: 'bytes[8]', tier: 'structural', sources: ['openstrap_protocol'], note: 'sign-transition-counter reading REFUTED; raw' },
  ],
  rawSpans: [ { from: 30, to: 31, note: 'inner[14] always 0x00' } ],
  stale_bytes_rule: 'unwritten body regions hold the PREVIOUS packet content, not zeros — typed accessors must be tag-gated',
  note: 'exact-length dispatch (inner 176) before tag trust; unknown tags: header + tag + raw body only',
  sources: ['openstrap_protocol'],
});

// v26 Pulse Information Packet (frame 92 B typical / inner 76 B)
entry({
  key: 'puffin/47/v26', family: 'maverick_goose_fd4b', direction: 'device_to_app',
  packetType: 47, histVersion: 26,
  supersedes: { reading: 'noop "24 i16 PPG samples @27..75"', reason: 'those bytes are saturated deltas; the absolute first sample is the i32 @23' },
  fields: [
    { name: 'pip_state_counter', off: 21, len: 2, dtype: 'u16le', tier: 'hardware_attested', sources: [NOOP, 'openstrap_protocol'], note: 'noop burst_index (same byte); episodes run 40 records at 1 Hz' },
    { name: 'first_sample_adc', off: 23, len: 4, dtype: 'i32le sign-extended 20-bit', unit: 'ADC counts', tier: 'hardware_attested', sources: [NOOP, 'openstrap_protocol'], validators: ['in [-524288, 524287] else corrupt flag (kept raw)'] },
    { name: 'optical_deltas', off: 27, len: 48, dtype: 'i16le[24] saturated', unit: 'ADC counts', tier: 'hardware_attested', sources: ['openstrap_protocol'], note: 'delta i steps sample i -> i+1 of the 25-sample window; reconstruction is approximate by design' },
    { name: 'accel_delta_g', off: 75, len: 4, dtype: 'f32le', unit: 'g', tier: 'hardware_attested', sources: [NOOP, 'openstrap_protocol'], note: 'byte-equal to twin v18 @41 (dynamic_acceleration / max adjacent accel delta)' },
    { name: 'channel_state_word', off: 79, len: 2, dtype: 'u16le', tier: 'candidate', sources: ['openstrap_protocol'], note: '= twin v18 status_word @75' },
    { name: 'primary_flags_snapshot', off: 81, len: 1, dtype: 'u8', tier: 'candidate', sources: [NOOP, 'openstrap_protocol'], note: 'low 2 bits equal twin v18 @81 & 3' },
    { name: 'waveform_morphology', off: 82, len: 1, dtype: 'u8', tier: 'candidate', sources: ['openstrap_protocol'], note: 'binary acceptance result; semantics unpinned; never a product field' },
    { name: 'aligned_tail', off: 83, len: 1, dtype: 'u8', tier: 'structural', sources: ['openstrap_protocol'], note: 'outside the copied 72-byte PIP record' },
  ],
  derived: [
    { name: 'ppg_window', formula: 'reconstructSaturatedDeltaWindow(first_sample_adc, deltas)', samples: 25, tier: 'hardware_attested', sources: ['openstrap_protocol'], note: '25 reconstructed samples; trusted run ends at first saturated delta; out-of-range = proven divergence' },
  ],
  sources: [NOOP, 'openstrap_protocol'],
});

// Type 40 REALTIME_DATA (family-aware)
entry({
  key: 'realtime/40', family: 'whoop4+maverick_goose_fd4b', direction: 'device_to_app',
  packetType: 40,
  fields: [
    { name: 'timestamp', off: 'whoop4:6|puffin:10', len: 4, dtype: 'u32le', unit: 's', tier: 'hardware_attested', sources: [NOOP, 'openstrap_protocol'] },
    { name: 'subseconds', off: 'whoop4:10|puffin:14', len: 2, dtype: 'u16le', unit: '1/32768 s', tier: 'hardware_attested', sources: [NOOP, 'openstrap_protocol'] },
    { name: 'heart_rate', off: 'whoop4:12|puffin:16', len: 1, dtype: 'u8', unit: 'bpm', tier: 'cross_device_validated', sources: [NOOP, 'openstrap_protocol'], validators: ['20..240 (noop realtime gate); 25..230 (openstrap)'] },
    { name: 'rr_count', off: 'whoop4:13|puffin:17', len: 1, dtype: 'u8', tier: 'hardware_attested', sources: [NOOP, 'openstrap_protocol'], validators: ['declared count capped at 4 (0x28 form has exactly four slots bounded by the wearing byte)'] },
    { name: 'rr_intervals_ms', off: 'whoop4:14|puffin:18', len: 8, dtype: 'i16le[4]', unit: 'ms', tier: 'cross_device_validated', sources: [NOOP, 'openstrap_protocol'], validators: ['each in [200, 2500] ms', 'strict bounds: a slot outside range contributes nothing, never a fabricated beat', 'order preserved (emission order)'] },
  ],
  sources: [NOOP, 'openstrap_protocol'],
});

// MG/Labrador ECG payload (candidate; packet type byte unattested)
entry({
  key: 'mg/ecg_labrador', family: 'maverick_goose_fd4b', direction: 'device_to_app',
  packetType: 43, gated: {
    access: 'developer_mode_consent_required',
    commands: { 124: 'TOGGLE_LABRADOR_DATA_GENERATION (stop=1, start=2; 0 REFUSED)', 125: 'TOGGLE_LABRADOR_RAW_SAVE', 139: 'TOGGLE_LABRADOR_FILTERED (gates the stream)' },
    order: '139=1 then 124=2; stop = 124=1; command 0 refused',
    evidence: 'noop @2fe3a5c9 f2476f95 (#1727, one device WS50_r00 fw 50.39.1.0) + #891/#1100',
  },
  fields: [
    { name: 'status_header', off: 0, len: 17, dtype: 'bytes[17]', tier: 'hardware_attested', sources: [NOOP], note: '17-byte status block opens both Labrador packet shapes (wire order)' },
    { name: 'number_of_ecg_samples', off: 15, len: 2, dtype: 'u16le (header rel 15:17)', tier: 'hardware_attested', sources: [NOOP] },
    { name: 'filtered_ecg_data_raw', off: 17, len: -1, dtype: 'i16le[n]', unit: 'raw (no uV conversion)', tier: 'candidate', sources: [NOOP], note: 'live filtered stream ~100 Hz single channel while both clasp electrodes held; n = numberOfECGSamples' },
    { name: 'raw_ecg_blob', off: 17, len: -1, dtype: 'bytes[n*bps]', tier: 'candidate', sources: [NOOP], note: 'persisted raw record; bytes-per-sample = blob_len / numberOfECGSamples' },
  ],
  note: 'ECG-shaped packets are hunted by structural triage; the packet TYPE byte is unattested. Never feeds a product metric.',
  sources: [NOOP],
});

// Blocked-command registry (safety) — see safety.js for enforcement.
export const BLOCKED_COMMANDS = Object.freeze(new Set([25, 32, 36, 37, 38, 45, 99, 142, 143, 144]));

// ---- Access helpers ----
export function findEntries(pred = () => true) { return REGISTRY_ENTRIES.filter(pred); }
export function entryByKey(key) { return REGISTRY_ENTRIES.find((e) => e.key === key) || null; }
export function entriesFor(packetType, { histVersion = null, tag = null } = {}) {
  return REGISTRY_ENTRIES.filter((e) => String(e.packetType).includes(String(packetType))
    && (histVersion == null || e.histVersion === histVersion)
    && (tag == null || (e.fields || []).some((f) => String(f.name).startsWith(`tag${tag}`))));
}
export function isProductEligible(fieldOrEntry) {
  const tier = fieldOrEntry?.tier || fieldOrEntry?.min_tier || null;
  return tier === 'product_eligible';
}
export function tierRank(t) {
  return t in TIERS ? TIERS[t] : -1;
}
export function maxTierOf(entrySpec) {
  let best = 'structural';
  for (const f of entrySpec.fields || []) {
    if (tierRank(f.tier) > tierRank(best)) best = f.tier;
  }
  return best;
}
export function registryStats() {
  const byTier = {};
  let fields = 0;
  for (const e of REGISTRY_ENTRIES) {
    for (const f of e.fields || []) { fields += 1; byTier[f.tier] = (byTier[f.tier] || 0) + 1; }
  }
  return { registry_version: REGISTRY_VERSION, entries: REGISTRY_ENTRIES.length, fields, by_tier: byTier, conflicts_open: Object.entries(CONFLICTS).filter(([, c]) => c.status === 'open').map(([k]) => k) };
}
