/**
 * Canonical Heart Rate V2 observation.
 *
 * The archive row contract (ingest/archiveFormat.js normalizeSample) is FROZEN;
 * this module is the V2 read-side adapter from any normalized row (day file
 * row, decoded archive row, or live route row) into the observation shape every
 * hr2 module consumes. It never mutates the input and never throws.
 *
 * Key decisions (V2_DESIGN.md section 3):
 *  - BOTH time domains are always carried. `tMs` is the canonical measurement
 *    time (receive-domain, the V1 behavior) until the device-clock
 *    characterization (scripts/clockCharacterize.mjs) proves the strap clock
 *    superior. t_strap is preserved verbatim for that experiment.
 *  - `bpm` is the physiologically gated value (same 20-240 rule as
 *    archiveFormat, applied here defensively because local day-file rows are
 *    written ungated); `bpmRaw` preserves the original finite reading so an
 *    out-of-range artifact remains available as a diagnostic feature instead
 *    of being silently dropped.
 *  - Wear fields (band_sleep_state / skin_contact / wrist_on / wrist_off) are
 *    null-neutral: verified to have NO producer on the iOS side today
 *    (audit_v1_data_path.md finding 9). They must never be read as "off wrist".
 */

const BPM_MIN = 20;
const BPM_MAX = 240;
const RR_MIN_MS = 200;
const RR_MAX_MS = 2500;

/** Closed set of fields a canonical observation carries (schema contract for tests). */
export const CANONICAL_FIELDS = Object.freeze([
  't', 'tMs', 't_strap', 'clock_offset_sec', 'clock_domain',
  'bpm', 'bpmRaw', 'rr_ms',
  'src', 'src_class',
  'device_id', 'firmware', 'layout', 'family', 'decoder', 'seq',
  'connection_epoch', 'rr_continuity',
  'motion', 'gravity', 'dyn_accel',
  'q_reported', 'bat', 'stage',
  'wear', 'activity_class', 'step_cadence', 'skin_temp_c',
]);

/** Deduplication priority (higher wins on cross-source collisions). Design: whoop_history > ble_hr > gatt > healthkit. */
export const SRC_CLASS_PRIORITY = Object.freeze({
  history: 4,
  live: 3,
  gatt: 2,
  healthkit: 1,
  unknown: 0,
});

function finiteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapSrcClass(src) {
  const s = String(src || '').toLowerCase();
  if (s === 'whoop_history' || s === 'history') return 'history';
  if (s === 'ble_hr' || s === 'whoop_rt' || s === 'whoop_type40' || s === 'type40_replay') return 'live';
  if (s === 'gatt' || s === 'gatt_hr') return 'gatt';
  if (s === 'healthkit') return 'healthkit';
  return 'unknown';
}

function clockDomainOf(row) {
  const strapOk = Number.isFinite(Date.parse(row?.t_strap || ''));
  const offset = finiteNumber(row?.clock_offset_sec);
  if (strapOk) return offset != null ? 'strap_corrected' : 'strap_uncorrected';
  return 'receive';
}

/**
 * Convert one normalized row (or raw day-file/live row) into a canonical
 * observation. Returns null for rows with no usable time.
 */
export function toCanonicalObservation(row) {
  if (row == null || typeof row !== 'object') return null;
  const tRaw = row.t ?? row.datetime ?? row.at;
  const tMs = Date.parse(tRaw);
  if (!Number.isFinite(tMs)) return null;

  const bpmCandidate = finiteNumber(row.bpm ?? row.heartRate ?? row.heart_rate);
  const bpmRaw = bpmCandidate;
  const bpm = bpmCandidate != null && bpmCandidate >= BPM_MIN && bpmCandidate <= BPM_MAX ? bpmCandidate : null;

  const rrIn = Array.isArray(row.rr_ms ?? row.rrIntervals) ? (row.rr_ms ?? row.rrIntervals) : [];
  const rr_ms = rrIn
    .map((v) => Math.round(finiteNumber(v)))
    .filter((v) => v != null && v >= RR_MIN_MS && v <= RR_MAX_MS);

  const strapMs = Date.parse(row.t_strap || '');
  const offset = finiteNumber(row.clock_offset_sec);

  const gx = finiteNumber(row.gx);
  const gy = finiteNumber(row.gy);
  const gz = finiteNumber(row.gz);
  const gravity = gx != null && gy != null && gz != null ? { x: gx, y: gy, z: gz } : null;

  return {
    t: new Date(tMs).toISOString(),
    tMs,
    t_strap: Number.isFinite(strapMs) ? new Date(strapMs).toISOString() : null,
    clock_offset_sec: offset,
    clock_domain: clockDomainOf(row),
    bpm,
    bpmRaw,
    rr_ms,
    src: row.src ?? row.source ?? 'ble_hr',
    src_class: mapSrcClass(row.src ?? row.source),
    device_id: row.device_id ?? row.deviceId ?? null,
    firmware: row.firmware ?? row.fw ?? null,
    layout: row.layout ?? null,
    family: row.family ?? null,
    decoder: row.decoder ?? null,
    seq: row.seq != null ? finiteNumber(row.seq) : null,
    connection_epoch: finiteNumber(row.connection_epoch ?? row.connectionEpoch),
    rr_continuity: finiteNumber(row.rr_continuity ?? row.rrContinuity),
    motion: finiteNumber(row.mot ?? row.motion),
    gravity,
    dyn_accel: finiteNumber(row.dyn_accel ?? row.dynAccel),
    q_reported: finiteNumber(row.q ?? row.quality),
    bat: finiteNumber(row.bat ?? row.battery),
    stage: row.stage ?? row.sleep_stage ?? null,
    wear: {
      band_sleep_state: Number.isInteger(Number(row.band_sleep_state ?? row.bandSleepState))
        ? Number(row.band_sleep_state ?? row.bandSleepState)
        : null,
      skin_contact: finiteNumber(row.skin_contact ?? row.skinContact),
      wrist_on: finiteNumber(row.wrist_on ?? row.wristOn),
      wrist_off: finiteNumber(row.wrist_off ?? row.wristOff),
    },
    activity_class: Number.isInteger(Number(row.activity_class)) ? Number(row.activity_class) : null,
    step_cadence: finiteNumber(row.step_cadence),
    skin_temp_c: finiteNumber(row.skin_temp_c),
  };
}

/** Convert a list of raw rows into canonical observations (garbage rows skipped). */
export function observationsFromSamples(rows) {
  const out = [];
  for (const row of rows || []) {
    const obs = toCanonicalObservation(row);
    if (obs) out.push(obs);
  }
  // Canonical order: sensor time ascending; stable for equal timestamps.
  return out.sort((a, b) => (a.tMs - b.tMs));
}
