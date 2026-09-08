/**
 * WHOOP sensor capability map — what FRWHOOP actually receives, not what the
 * hardware can theoretically produce.
 *
 * Every entry was verified against the code that decodes it. A signal is
 * `available` ONLY when a decoder in this repository writes it into a normalized
 * sensor record today. Anything reachable in principle but not currently
 * requested from the strap is `reachable`, with the exact unlock recorded, so a
 * downstream engine reports "unavailable" instead of inventing a number.
 *
 * This file is the reason the temperature and PPG engines are not shipped as
 * working features: the inputs are not on the wire. Editing an entry to
 * `available` without also landing the decoder is the one change that would make
 * every confidence score in the system a lie.
 *
 * Evidence key:
 *   plugin  frontend/ios/App/App/WhoopBlePlugin.swift
 *   proto   frontend/ios/App/App/WhoopProtocol.swift
 *   buffer  backend/ingest/hourBuffer.js
 *   archive backend/ingest/archiveFormat.js
 *   noop    ../../noop/Packages/WhoopProtocol/... (a SEPARATE application; its
 *           decoders are not in FRWHOOP's ingest path)
 */

/** A signal FRWHOOP decodes and stores today. */
export const AVAILABLE = 'available';
/**
 * A signal the strap emits and whose bytes FRWHOOP's protocol tables describe,
 * but which nothing currently requests or decodes into a sensor record.
 */
export const REACHABLE = 'reachable';
/** No known path to this signal on this hardware. */
export const ABSENT = 'absent';

/**
 * Wrist motion arrives as a scalar magnitude, and mostly from the PHONE.
 *
 * `WhoopProtocol.milligMagnitude` collapses a triplet to `|v|` and returns one
 * number, so tri-axial orientation is gone before ingest sees it. The strap
 * branch additionally reads offsets (12 harvard / 16 puffin) that the protocol
 * table assigns to `timestamp`/`unknown_hdr`, not to acceleration — see
 * `MOTION_SOURCE_CAVEAT`. In practice `strapMotion` stays null because nothing
 * enables the raw stream, so the number the analytics layer sees is the phone
 * accelerometer at 1 Hz.
 */
export const MOTION_SOURCE_CAVEAT = Object.freeze({
  scalarOnly: true,
  primarySource: 'phone_coremotion_1hz',
  strapParseSuspect: true,
  detail: 'REALTIME_RAW type 43 accel begins at frame offset 89 with scale 1/4096 g; '
    + 'the live parse reads offset 12/16 with a /1000 millig scale, which is header bytes. '
    + 'Gated to 0-8 g so it usually yields null, and the raw stream is never enabled.',
});

/**
 * The capability map. `unit` is the unit AS RECEIVED — several strap channels are
 * raw ADC counts with no verified transfer function, which is why they are not
 * presented as physical quantities anywhere.
 */
export const SENSORS = Object.freeze({
  heart_rate: {
    status: AVAILABLE,
    unit: 'bpm',
    rateHz: 0.25,
    field: 'bpm',
    origin: 'hardware',
    evidence: 'plugin:1311-1320 (0xAA REALTIME type 40 u8) + GATT 0x2A37',
    note: 'Device-reported. Live posts are throttled to >=1.8 s apart, so the '
      + 'effective cadence is ~4 s, not the strap\'s internal 1 Hz.',
  },
  rr_intervals: {
    status: AVAILABLE,
    unit: 'ms',
    rateHz: null,
    field: 'rr_ms',
    origin: 'hardware',
    evidence: 'plugin:1689 (GATT HRS flags bit 0x10); archive:51-55 gates 200-2500 ms',
    note: 'Present only while the standard Heart Rate Service is the live source. '
      + 'On firmware where 0x2A37 stays silent, HR arrives over the proprietary '
      + 'stream and RR is absent for that whole session.',
  },
  motion_magnitude: {
    status: AVAILABLE,
    unit: 'g',
    rateHz: 1,
    field: 'motion',
    origin: 'derived',
    evidence: 'proto:106-108 (phone), proto:125-148 (strap); plugin:1615-1618',
    caveat: MOTION_SOURCE_CAVEAT,
  },
  battery: {
    status: AVAILABLE,
    unit: 'percent',
    rateHz: null,
    field: 'battery',
    origin: 'hardware',
    evidence: 'plugin:852-854 (GATT battery characteristic)',
  },
  wear_state: {
    status: REACHABLE,
    unit: 'enum',
    field: null,
    origin: 'hardware',
    unlock: 'historical_offload',
    evidence: 'noop Streams.swift:300-308 — @81 flag byte, bits 0-1 onwrist',
    note: 'FRWHOOP infers contact loss only indirectly, from HR dropout and the '
      + '`connected` flag. The strap\'s own on-wrist bit is not requested.',
  },
  charging_state: {
    status: REACHABLE,
    unit: 'bool',
    field: null,
    origin: 'hardware',
    unlock: 'historical_offload',
    evidence: 'noop Streams.swift:87-95 — BatterySample.charging, BATTERY_LEVEL event only',
  },
  skin_temperature: {
    status: REACHABLE,
    unit: 'raw_adc',
    rateHz: 1,
    field: null,
    origin: 'hardware',
    unlock: 'historical_offload',
    evidence: 'whoop_protocol.json HISTORICAL_DATA type 47 v24 skin_temp_raw@72 (u16)',
    note: 'Peripheral skin/device contact temperature, NOT core body temperature. '
      + 'WHOOP 5 maps raw/100 to degrees C; WHOOP 4 has only a provisional '
      + 'single-point anchor (noop Streams.swift:169-192), so absolute values are '
      + 'not defensible and only deviation-from-own-baseline is.',
  },
  respiratory_rate: {
    status: REACHABLE,
    unit: 'raw_adc',
    rateHz: 1,
    field: null,
    origin: 'hardware',
    unlock: 'historical_offload',
    evidence: 'whoop_protocol.json HISTORICAL_DATA type 47 v24 resp_rate_raw@80 (u16)',
    note: 'Raw ADC with no verified transfer function to breaths per minute. '
      + 'Treat as an uncalibrated device channel, not a respiratory rate.',
  },
  ppg_waveform: {
    status: REACHABLE,
    unit: 'adc_counts',
    rateHz: 437,
    field: null,
    origin: 'hardware',
    unlock: 'raw_stream_enable',
    evidence: 'whoop_protocol.json REALTIME_RAW type 43 variant 1921: ppg_off=42, '
      + 'stride 4, signed 24-bit LE, ~419 samples/packet',
    note: 'A SINGLE AC-coupled channel, not red/IR/green interleaved. Continuous '
      + '437 Hz streaming has a real battery cost on both strap and phone, so this '
      + 'is a duty-cycled capture, not an always-on stream.',
  },
  accelerometer_xyz: {
    status: REACHABLE,
    unit: 'g',
    rateHz: 100,
    field: null,
    origin: 'hardware',
    unlock: 'raw_stream_enable',
    evidence: 'whoop_protocol.json REALTIME_RAW type 43 variant 1917: accelX@89 / '
      + 'Y@289 / Z@489, int16 LE, scale 1/4096 g, 100 samples per axis per packet',
  },
  gyroscope_xyz: {
    status: REACHABLE,
    unit: 'deg/s',
    rateHz: 100,
    field: null,
    origin: 'hardware',
    unlock: 'raw_stream_enable',
    evidence: 'whoop_protocol.json REALTIME_RAW type 43 variant 1917: gyroX@692 / '
      + 'Y@892 / Z@1092, scale 2000/32768 deg/s',
  },
  spo2: {
    status: REACHABLE,
    unit: 'raw_adc',
    rateHz: 1,
    field: null,
    origin: 'hardware',
    unlock: 'historical_offload',
    evidence: 'whoop_protocol.json type 47 v24 spo2_red@68 / spo2_ir@70 (u16 each)',
    note: 'Raw red/IR counts, not a saturation percentage.',
  },
  sleep_stage: {
    status: AVAILABLE,
    unit: 'enum',
    field: 'sleep_stage',
    origin: 'derived',
    evidence: 'buffer:296 carries the field; metrics/sleep.js:151-157 derives stages from HR',
    note: 'FRWHOOP derives stages from heart rate. The strap\'s own band state is '
      + 'a separate, unrequested signal (see wear_state).',
  },
  ecg: {
    status: ABSENT,
    unit: null,
    field: null,
    origin: 'hardware',
    evidence: 'noop Whoop5Ecg.swift exists but is an on-demand WHOOP 5/MG capture, '
      + 'not a continuous stream, and FRWHOOP issues no ECG command',
  },
  electrodermal_activity: {
    status: ABSENT,
    unit: null,
    field: null,
    origin: 'hardware',
    evidence: 'no EDA channel in any decoded WHOOP packet layout',
    note: 'Load-bearing for the autonomic-load design: WESAD-family stress models '
      + 'lean heavily on EDA, so their reported accuracy does not transfer here.',
  },
  ambient_temperature: {
    status: ABSENT,
    unit: null,
    field: null,
    origin: 'hardware',
    evidence: 'no ambient channel; the v18 aux thermal channels are unpinned and '
      + 'nothing asserts what they measure (noop Streams.swift:110-119)',
    note: 'Thermoregulation models (JOS-3 and similar) require ambient temperature, '
      + 'humidity and air velocity. None are obtainable, so heat-strain modelling '
      + 'is not buildable from this hardware alone.',
  },
});

/** How a `reachable` signal would be unlocked, and what it costs. */
export const UNLOCKS = Object.freeze({
  historical_offload: {
    summary: 'Request the 14-day biometric store (HISTORICAL_DATA type 47).',
    requires: 'High-frequency-sync handshake plus a valid device RTC, then decode '
      + 'the versioned per-second records. NOOP implements this; FRWHOOP does not.',
    unlocksSignals: ['skin_temperature', 'respiratory_rate', 'spo2', 'wear_state', 'charging_state'],
    risk: 'Touches BLE command flow and offload acking. The strap TRIMS banked '
      + 'history once an offload is acked, so a decoder bug loses data permanently.',
    ratePerSignalHz: 1,
  },
  raw_stream_enable: {
    summary: 'Enable REALTIME_RAW_DATA (type 43) streaming.',
    requires: 'Send the raw-data enable command and subscribe. FRWHOOP explicitly '
      + 'sends no such command today (proto:138-139).',
    unlocksSignals: ['ppg_waveform', 'accelerometer_xyz', 'gyroscope_xyz'],
    risk: 'Battery. 437 Hz PPG plus 6 axes at 100 Hz is a large continuous uplink; '
      + 'it must be duty-cycled and must not block the HR path.',
    ratePerSignalHz: null,
  },
});

/** Signal names by status, for tests and for the capability endpoint. */
export function signalsByStatus(status) {
  return Object.entries(SENSORS)
    .filter(([, s]) => s.status === status)
    .map(([name]) => name)
    .sort();
}

/** True when every named signal is decoded into a sensor record today. */
export function hasSignals(...names) {
  return names.flat().every((n) => SENSORS[n]?.status === AVAILABLE);
}

/**
 * Which of `names` are missing, and why.
 *
 * Engines call this before computing anything so an unavailable metric carries
 * the reason and the unlock rather than a bare null.
 */
export function missingSignals(...names) {
  return names.flat()
    .filter((n) => SENSORS[n]?.status !== AVAILABLE)
    .map((n) => {
      const s = SENSORS[n];
      if (!s) return { signal: n, status: 'unknown', reason: 'not in capability map' };
      return {
        signal: n,
        status: s.status,
        reason: s.note || s.evidence || null,
        unlock: s.unlock ? { id: s.unlock, ...UNLOCKS[s.unlock] } : null,
      };
    });
}

/** Serializable summary for the capability endpoint and the audit report. */
export function capabilityReport() {
  return {
    available: signalsByStatus(AVAILABLE),
    reachable: signalsByStatus(REACHABLE),
    absent: signalsByStatus(ABSENT),
    unlocks: UNLOCKS,
    sensors: SENSORS,
  };
}
