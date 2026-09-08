// WHOOP 5/MG v18 SpO₂ candidate at frame offset 82 (inner 74).
//
// No conversion formula: in-band bytes 70..100 are the percentage.
// Sentinel and diagnostic values are never reinterpreted as %.
// Canonical spo2_pct is not written here.

import { inferWhoopExternalId, resolvePhysicalWhoopIdentity, isGenericWhoopExternalId } from '../storage/keys.js';
import { physiologicalDay } from '../time/dayBoundary.js';

export const SPO2_FRAME_OFFSET = 82;
export const SPO2_INNER_OFFSET = 74;
export const SPO2_DECODER_VERSION = 'frwhoop-spo2/1';
export const SPO2_SOURCE = 'whoop_v18_byte_82';
export const SLEEP_ASLEEP = 2;
export const CONFIG_KEY_HINT = /spo2|oxygen|sig|sleep|optical|r10|r11|r22/i;
export const LOG_HINT = /spo2|oxygen|sigproc|valid\s*spo2|sleep/i;
/** Contiguous nonzero @82 samples; not the duty-cycle period. */
export const WINDOW_GAP_S = 3;
/** Asleep-run gap before a new sleep episode. */
export const SLEEP_EPISODE_GAP_S = 300;

const STATES = new Set(['unset', 'candidate', 'sentinel', 'diagnostic']);

export function classifySpo2Byte(raw) {
  if (raw == null || raw === '') {
    return { spo2_raw_byte: null, spo2_candidate_pct: null, spo2_state: null, spo2_mode: null };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 255) {
    return { spo2_raw_byte: null, spo2_candidate_pct: null, spo2_state: null, spo2_mode: null };
  }
  const b = n & 0xff;
  if (b === 0) {
    return { spo2_raw_byte: 0, spo2_candidate_pct: null, spo2_state: 'unset', spo2_mode: 'unset' };
  }
  if (b >= 70 && b <= 100) {
    return {
      spo2_raw_byte: b,
      spo2_candidate_pct: b,
      spo2_state: 'candidate',
      spo2_mode: 'in_band_pct',
    };
  }
  if ((b & 0x80) !== 0) {
    return {
      spo2_raw_byte: b,
      spo2_candidate_pct: null,
      spo2_state: 'sentinel',
      spo2_mode: 'saturation_sentinel',
    };
  }
  return {
    spo2_raw_byte: b,
    spo2_candidate_pct: null,
    spo2_state: 'diagnostic',
    spo2_mode: 'diagnostic_code',
  };
}

export function isSpo2State(value) {
  return STATES.has(value);
}

export const NOMINAL_DUTY_WINDOW_S = 30;

export function unixOf(rec) {
  const n = Number(rec?.sensor_timestamp ?? rec?.unix ?? rec?.timestamp);
  return Number.isFinite(n) && n > 1e9 && n < 4e9 ? Math.floor(n) : null;
}

export function v18ValidityFields(parsed) {
  const signedToU8 = (v) => (v == null ? null : (v < 0 ? v + 256 : v));
  const ampA = parsed?.optical_amp_a ?? signedToU8(parsed?.optical_amp_or_psnr?.[0]);
  const ampB = parsed?.optical_amp_b ?? signedToU8(parsed?.optical_amp_or_psnr?.[1]);
  return {
    heart_rate: parsed?.heart_rate ?? null,
    rr_count: parsed?.rr_count ?? (Array.isArray(parsed?.rr_intervals) ? parsed.rr_intervals.length : null),
    rr_intervals: parsed?.rr_intervals || parsed?.rr_intervals_ms || null,
    sleep_state_raw: parsed?.sleep_state_byte ?? null,
    dynamic_acceleration: parsed?.dynamic_acceleration ?? parsed?.dynamic_accel_mag ?? null,
    cardiac_flags: parsed?.cardiac_flags ?? null,
    cardiac_status: parsed?.cardiac_status ?? null,
    optical_baseline_a: parsed?.optical_baseline_a ?? parsed?.optical_baseline_ab?.[0] ?? null,
    optical_baseline_b: parsed?.optical_baseline_b ?? parsed?.optical_baseline_ab?.[1] ?? null,
    optical_amp_a: ampA ?? null,
    optical_amp_b: ampB ?? null,
    optical_amp_128_128_sentinel: ampA === 128 && ampB === 128,
    f32_113: parsed?.unknown_f32_113 ?? parsed?.f32_113 ?? null,
  };
}

export function observationFromV18(parsed, {
  frameHash = null,
  deviceId = null,
  userId = null,
  family = null,
  firmware = null,
  decoderVersion = null,
  layout = 'v18',
  serial = null,
  externalId = null,
  hardwareId = null,
} = {}) {
  if (!parsed || typeof parsed !== 'object') return null;
  const hist = parsed.hist_version ?? parsed.version;
  if (hist != null && Number(hist) !== 18) return null;
  const raw = parsed.spo2_raw_byte ?? parsed.aux_byte_82;
  if (raw == null) return null;
  const c = classifySpo2Byte(raw);
  const unix = unixOf({ sensor_timestamp: parsed.unix, unix: parsed.unix });
  return annotateSpo2Identity({
    spo2_raw_byte: c.spo2_raw_byte,
    spo2_candidate_pct: c.spo2_candidate_pct,
    spo2_state: c.spo2_state,
    sensor_timestamp: unix,
    device_id: deviceId || parsed.device_id || null,
    user_id: userId || parsed.user_id || null,
    device_family: family || parsed.family || 'puffin',
    firmware: firmware || parsed.firmware || parsed.fw || null,
    layout,
    decoder_version: decoderVersion || parsed.decoder || null,
    source_frame_hash: frameHash || parsed.source_frame_hash || null,
    sleep_state: Number.isInteger(Number(parsed.sleep_state)) ? Number(parsed.sleep_state) : null,
    serial: serial || parsed.serial || null,
    external_device_id: externalId || parsed.external_device_id || null,
    hardware_id: hardwareId || parsed.hardware_id || null,
    ...v18ValidityFields(parsed),
  });
}

export function observationFromLevelB(rec) {
  if (!rec || rec.packet_type !== 47) return null;
  const parsed = rec.decoded?.parsed || rec.parsed;
  if (!parsed || (parsed.hist_version != null && Number(parsed.hist_version) !== 18)) return null;
  return observationFromV18(parsed, {
    frameHash: rec.frame_hash,
    deviceId: rec.device_id || rec.decoded?.device_id || null,
    userId: rec.user_id || rec.decoded?.user_id || null,
    family: rec.family,
    firmware: rec.fw || rec.firmware || null,
    decoderVersion: rec.decoder_version || rec.decoder || null,
    layout: 'v18',
    serial: rec.serial || null,
    externalId: rec.external_device_id || rec.externalId || null,
    hardwareId: rec.hardware_id || rec.hardwareId || null,
  });
}

/** Recover firmware only from this capture's connection metadata, never from other nights. */
export function applyConnectionFirmware(observations, firmware) {
  if (!firmware) return observations || [];
  return (observations || []).map((o) => {
    if (o?.firmware) return o;
    return { ...o, firmware, firmware_recovered: true };
  });
}

export function annotateSpo2Identity(obs, extra = {}) {
  if (!obs || typeof obs !== 'object') return obs;
  const userId = extra.userId || obs.user_id || null;
  const sourceDeviceId = extra.sourceDeviceId || obs.device_id || null;
  const serial = extra.serial || obs.serial || null;
  const hardwareId = extra.hardwareId || obs.hardware_id || null;
  const inferred = inferWhoopExternalId(userId, sourceDeviceId);
  const externalId = extra.externalId || obs.external_device_id || inferred || null;
  const identity = resolvePhysicalWhoopIdentity({
    userId,
    sourceDeviceId,
    externalId,
    serial,
    hardwareId,
  });
  let firmware = extra.firmware || obs.firmware || null;
  let firmware_recovered = Boolean(obs.firmware_recovered);
  if (!obs.firmware && extra.firmware) {
    firmware = extra.firmware;
    firmware_recovered = true;
  }
  return {
    ...obs,
    user_id: userId,
    device_id: sourceDeviceId,
    source_device_id: sourceDeviceId,
    external_device_id: externalId,
    hardware_id: hardwareId,
    serial: serial || null,
    physical_device_id: identity.physical_device_id,
    physical_identity_confidence: identity.physical_identity_confidence,
    physical_identity_evidence: identity.physical_identity_evidence,
    firmware,
    firmware_recovered,
  };
}

export function groupingDeviceKey(obs, by = 'physical') {
  if (by === 'user') return obs.user_id || 'unknown';
  if (obs.physical_device_id) return obs.physical_device_id;
  return obs.device_id || obs.source_device_id || 'unknown';
}

export function independentSpo2DeviceCount(observations) {
  const ids = new Set();
  for (const o of observations || []) {
    const row = annotateSpo2Identity(o);
    if (row.physical_identity_confidence === 'confirmed' && row.physical_device_id) {
      ids.add(row.physical_device_id);
    }
  }
  return ids.size;
}

export function deviceAliasRelations(observations) {
  const rows = (observations || []).map((o) => annotateSpo2Identity(o));
  const bySource = new Map();
  for (const o of rows) {
    const id = o.device_id || o.source_device_id;
    if (!id || bySource.has(id)) continue;
    bySource.set(id, o);
  }
  const list = [...bySource.values()];
  const relations = [];
  // ponytail: O(n²) alias pairs; upgrade: join on DIS serial in the device registry.
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (a.physical_device_id && b.physical_device_id && a.physical_device_id === b.physical_device_id) {
        relations.push({
          relation: 'same_physical_device',
          source_device_ids: [a.device_id, b.device_id],
          physical_device_id: a.physical_device_id,
          physical_identity_confidence: 'confirmed',
          physical_identity_evidence: a.physical_identity_evidence,
        });
        continue;
      }
      if (a.physical_identity_confidence === 'confirmed' || b.physical_identity_confidence === 'confirmed') {
        continue;
      }
      const genericA = isGenericWhoopExternalId(a.external_device_id);
      const genericB = isGenericWhoopExternalId(b.external_device_id);
      if (genericA && genericB && a.device_id !== b.device_id) {
        relations.push({
          relation: 'probable_same_device',
          source_device_ids: [a.device_id, b.device_id],
          user_ids: [a.user_id, b.user_id].filter(Boolean),
          physical_device_id: null,
          physical_identity_confidence: 'unknown',
          physical_identity_evidence: 'generic_external_id_alias',
        });
      }
    }
  }
  return relations;
}

export function observationKey(obs) {
  if (obs?.source_frame_hash) return obs.source_frame_hash;
  const ts = unixOf(obs);
  if (ts == null) return null;
  return `${obs.device_id || ''}@${ts}`;
}

/** Merge observations; same source_frame_hash (or device@unix) wins first-seen. */
export function upsertObservations(existing, incoming) {
  const map = new Map();
  for (const obs of existing || []) {
    const key = observationKey(obs);
    if (key) map.set(key, obs);
  }
  let inserted = 0;
  let duplicates = 0;
  for (const obs of incoming || []) {
    const key = observationKey(obs);
    if (!key) continue;
    if (map.has(key)) {
      duplicates += 1;
      continue;
    }
    map.set(key, obs);
    inserted += 1;
  }
  return { observations: [...map.values()], inserted, duplicates };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - i) + sorted[hi] * (i - lo);
}

function meanOf(vals) {
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function burstStats(timestamps) {
  const stamps = [...new Set(timestamps.filter((t) => Number.isFinite(t)))].sort((a, b) => a - b);
  if (!stamps.length) return { burst_lengths: [], time_between_bursts_s: [] };
  const bursts = [[stamps[0]]];
  for (let i = 1; i < stamps.length; i += 1) {
    if (stamps[i] - stamps[i - 1] <= 2) bursts[bursts.length - 1].push(stamps[i]);
    else bursts.push([stamps[i]]);
  }
  const burst_lengths = bursts.map((b) => b.length);
  const time_between_bursts_s = [];
  for (let i = 1; i < bursts.length; i += 1) {
    time_between_bursts_s.push(bursts[i][0] - bursts[i - 1][bursts[i - 1].length - 1]);
  }
  return { burst_lengths, time_between_bursts_s };
}

export function utcNightKey(unix) {
  if (!Number.isFinite(unix)) return null;
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

export function isNonzeroSpo2(obs) {
  return Boolean(obs?.spo2_state) && obs.spo2_state !== 'unset' && Number(obs.spo2_raw_byte) > 0;
}

export function captureSpanUnix(observations) {
  let start = null;
  let end = null;
  for (const o of observations || []) {
    const t = unixOf(o);
    if (t == null) continue;
    if (start == null || t < start) start = t;
    if (end == null || t > end) end = t;
  }
  if (start == null) return { start: null, end: null, duration_s: 0 };
  return { start, end, duration_s: end - start };
}

function sessionBoundsMs(session) {
  const startRaw = Number(session?.start ?? session?.start_at);
  const endRaw = Number(session?.end ?? session?.end_at);
  const start = Number.isFinite(startRaw) ? (startRaw > 1e12 ? startRaw : startRaw * 1000) : null;
  const end = Number.isFinite(endRaw) ? (endRaw > 1e12 ? endRaw : endRaw * 1000) : null;
  return { start, end };
}

export function inferSleepEpisodes(observations) {
  const rows = [...(observations || [])]
    .filter((o) => unixOf(o) != null)
    .sort((a, b) => unixOf(a) - unixOf(b));
  const episodes = [];
  let cur = null;
  for (const o of rows) {
    const t = unixOf(o);
    if (o.sleep_state !== SLEEP_ASLEEP) continue;
    if (!cur || t - cur.end_unix > SLEEP_EPISODE_GAP_S) {
      if (cur) episodes.push(cur);
      cur = { start_unix: t, end_unix: t };
    } else {
      cur.end_unix = t;
    }
  }
  if (cur) episodes.push(cur);
  return episodes;
}

export function physiologicalNightKey(obs, {
  timeZone = 'UTC',
  sleepSessions = null,
  episodes = null,
} = {}) {
  const t = unixOf(obs);
  if (t == null) return null;
  const iso = new Date(t * 1000).toISOString();
  for (const session of sleepSessions || []) {
    const { start, end } = sessionBoundsMs(session);
    if (start == null || end == null) continue;
    if (t * 1000 >= start && t * 1000 <= end) {
      const wakeIso = session.wakeIso || new Date(end).toISOString();
      return physiologicalDay({ wakeIso, timeZone });
    }
  }
  for (const episode of episodes || []) {
    if (t >= episode.start_unix && t <= episode.end_unix) {
      return physiologicalDay({
        wakeIso: new Date(episode.end_unix * 1000).toISOString(),
        timeZone,
      });
    }
  }
  return physiologicalDay({ nowIso: iso, timeZone });
}

function compactWindow(window) {
  const candidates = window.observations.filter((o) => (
    o.spo2_state === 'candidate'
    && o.spo2_candidate_pct >= 70
    && o.spo2_candidate_pct <= 100
  ));
  const vals = candidates.map((o) => o.spo2_candidate_pct);
  return {
    start_unix: window.start_unix,
    end_unix: window.end_unix,
    start: new Date(window.start_unix * 1000).toISOString(),
    end: new Date(window.end_unix * 1000).toISOString(),
    duration_s: window.end_unix - window.start_unix + 1,
    sample_count: window.observations.length,
    candidate_count: candidates.length,
    sentinel_count: window.observations.filter((o) => o.spo2_state === 'sentinel').length,
    diagnostic_count: window.observations.filter((o) => o.spo2_state === 'diagnostic').length,
    window_value: meanOf(vals),
    valid: vals.length > 0,
  };
}

export function detectMeasurementWindows(observations, { gapS = WINDOW_GAP_S } = {}) {
  const nonzero = [...(observations || [])]
    .filter((o) => unixOf(o) != null && isNonzeroSpo2(o))
    .sort((a, b) => unixOf(a) - unixOf(b) || String(a.source_frame_hash || '').localeCompare(b.source_frame_hash || ''));
  const windows = [];
  let cur = null;
  for (const o of nonzero) {
    const t = unixOf(o);
    if (!cur || t - cur.end_unix > gapS) {
      if (cur) windows.push(compactWindow(cur));
      cur = { start_unix: t, end_unix: t, observations: [o] };
    } else {
      cur.end_unix = t;
      cur.observations.push(o);
    }
  }
  if (cur) windows.push(compactWindow(cur));
  return windows;
}

function medianOf(vals) {
  if (!vals.length) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  return percentile(sorted, 0.5);
}

function mad(vals, center) {
  if (!vals.length || center == null) return null;
  return medianOf(vals.map((v) => Math.abs(v - center)));
}

export function expectedWindowStarts({ captureStart, captureEnd, period, phase }) {
  if (!Number.isFinite(period) || period <= 0 || captureEnd == null || captureStart == null) {
    return [];
  }
  const ph = ((Number(phase) % period) + period) % period;
  const mod = ((captureStart % period) + period) % period;
  let t = captureStart + ((ph - mod + period) % period);
  if (t < captureStart) t += period;
  const starts = [];
  while (t <= captureEnd) {
    starts.push(t);
    t += period;
  }
  return starts;
}

export function asleepUnixStamps(observations) {
  const stamps = new Set();
  for (const o of observations || []) {
    if (o?.sleep_state !== SLEEP_ASLEEP) continue;
    const t = unixOf(o);
    if (t != null) stamps.add(t);
  }
  return [...stamps].sort((a, b) => a - b);
}

export function classifyDutyCycle(windows, {
  captureStart = null,
  captureEnd = null,
  priorPeriod = null,
  asleepUnix = null,
} = {}) {
  const observed = windows || [];
  const durations = observed.map((w) => w.duration_s);
  const starts = observed.map((w) => w.start_unix);
  const periods = [];
  for (let i = 1; i < starts.length; i += 1) periods.push(starts[i] - starts[i - 1]);
  const median_window_length = medianOf(durations);
  const median_period = medianOf(periods) || (Number.isFinite(priorPeriod) ? priorPeriod : null);
  const period_jitter = periods.length ? mad(periods, median_period) : null;
  const phase = median_period != null && starts.length
    ? medianOf(starts.map((s) => ((s % median_period) + median_period) % median_period))
    : null;
  const stamps = Array.isArray(asleepUnix)
    ? [...new Set(asleepUnix.filter((t) => Number.isFinite(t)))].sort((a, b) => a - b)
    : [];
  const asleepDiffs = [];
  for (let i = 1; i < stamps.length; i += 1) asleepDiffs.push(stamps[i] - stamps[i - 1]);
  const asleep_record_interval_s = medianOf(asleepDiffs);
  const observed_distinct_asleep_seconds = stamps.length;
  const spanStart = captureStart ?? (starts[0] ?? null);
  const spanEnd = captureEnd ?? (observed.at(-1)?.end_unix ?? null);
  const expectedStarts = expectedWindowStarts({
    captureStart: spanStart,
    captureEnd: spanEnd,
    period: median_period,
    phase,
  });
  const expected_windows = expectedStarts.length || (observed.length ? observed.length : 0);
  const tolerance = median_period != null ? Math.max(30, median_period * 0.25) : null;
  let missing_expected_windows = 0;
  if (tolerance != null) {
    for (const t of expectedStarts) {
      if (!starts.some((s) => Math.abs(s - t) <= tolerance)) missing_expected_windows += 1;
    }
  }
  const valid_windows = observed.filter((w) => w.valid).length;
  const window_coverage_pct = expected_windows
    ? Math.round((10000 * valid_windows) / expected_windows) / 100
    : 0;
  const duration_s = spanStart != null && spanEnd != null ? spanEnd - spanStart : 0;
  const jitterRatio = median_period && period_jitter != null ? period_jitter / median_period : null;
  const equal_window_lengths = durations.length > 0 && durations.every((d) => d === durations[0]);
  const windowBar = median_window_length || NOMINAL_DUTY_WINDOW_S;
  const samplesPerPeriod = median_period && asleep_record_interval_s
    ? median_period / Math.max(asleep_record_interval_s, 1)
    : null;
  const expectedFromAsleep = samplesPerPeriod
    ? Math.floor(observed_distinct_asleep_seconds / samplesPerPeriod)
    : 0;

  let classification = 'insufficient';
  if (!observed.length) {
    if (
      median_period
      && asleep_record_interval_s != null
      && asleep_record_interval_s <= windowBar
      && expectedFromAsleep >= 3
    ) {
      classification = 'feature_absent';
    } else {
      classification = 'insufficient';
    }
  } else if (median_window_length != null && duration_s > 0 && median_window_length / Math.max(duration_s, 1) > 0.5) {
    classification = 'continuous';
  } else if (
    observed.length >= 3
    && median_period
    && median_window_length != null
    && median_period >= 2 * median_window_length
    && (jitterRatio == null || jitterRatio < 0.35)
  ) {
    classification = 'duty_cycled';
  } else if (observed.length >= 3 && (jitterRatio == null || jitterRatio >= 0.35)) {
    classification = 'irregular';
  } else {
    classification = 'insufficient';
  }

  return {
    classification,
    mode: classification,
    expected_windows,
    observed_windows: observed.length,
    valid_windows,
    window_coverage_pct,
    coverage_pct: window_coverage_pct,
    median_window_length,
    window_length_s: median_window_length,
    median_period,
    period_s: median_period,
    period_jitter,
    phase_jitter_s: period_jitter,
    phase,
    phase_s: phase,
    window_count: observed.length,
    missing_expected_windows,
    equal_window_lengths,
    asleep_record_interval_s,
    observed_distinct_asleep_seconds,
  };
}

export function investigateSpo2Schedule(observations) {
  const windows = detectMeasurementWindows(observations);
  const candidates = (observations || []).filter((o) => o.spo2_state === 'candidate');
  const candBursts = burstStats(candidates.map((o) => unixOf(o)).filter((t) => t != null));
  const hashes = (observations || []).map((o) => o.source_frame_hash).filter(Boolean);
  const uniqueHashes = new Set(hashes);
  return {
    nonzero_windows: windows.length,
    median_nonzero_window_s: medianOf(windows.map((w) => w.duration_s)),
    windows_exactly_30s: windows.filter((w) => w.duration_s === 30).length,
    candidate_burst_lengths: candBursts.burst_lengths,
    candidate_bursts_inside_windows: candBursts.burst_lengths.length
      && windows.length
      ? candBursts.burst_lengths.length
      : 0,
    unique_frame_hashes: uniqueHashes.size,
    hash_collisions: hashes.length - uniqueHashes.size,
    explanation: windows.some((w) => w.duration_s === 30)
      ? 'candidate-only clustering split complete 30s nonzero windows; sentinel/diagnostic fill the rest'
      : 'unresolved',
  };
}

export function summarizeSpo2Observations(observations, {
  night = null,
  timeZone = 'UTC',
  sleepSessions = null,
  captureStart = null,
  captureEnd = null,
  priorPeriod = null,
} = {}) {
  const rows = (Array.isArray(observations) ? observations : []).map((o) => annotateSpo2Identity(o));
  const episodes = inferSleepEpisodes(rows);
  const nightOpts = { timeZone, sleepSessions, episodes };
  const scoped = night
    ? rows.filter((r) => physiologicalNightKey(r, nightOpts) === night)
    : rows;
  const candidates = scoped.filter((r) => r.spo2_state === 'candidate' && r.spo2_candidate_pct != null);
  const vals = candidates.map((r) => r.spo2_candidate_pct).sort((a, b) => a - b);
  const timestamps = candidates.map((r) => unixOf(r)).filter((t) => t != null);
  const asleep = candidates.filter((r) => r.sleep_state === SLEEP_ASLEEP).length;
  const awake = candidates.filter((r) => r.sleep_state != null && r.sleep_state !== SLEEP_ASLEEP).length;
  const sentinel = scoped.filter((r) => r.spo2_state === 'sentinel').length;
  const diagnostic = scoped.filter((r) => r.spo2_state === 'diagnostic').length;
  const v18 = scoped.length;
  const coverage = v18 ? candidates.length / v18 : 0;
  const bursts = burstStats(timestamps);
  const firmware = [...new Set(scoped.map((r) => r.firmware).filter(Boolean))];
  const decoder = [...new Set(scoped.map((r) => r.decoder_version).filter(Boolean))];
  const spanRows = scoped.filter((o) => isNonzeroSpo2(o) || o.sleep_state === SLEEP_ASLEEP);
  const span = spanRows.length
    ? captureSpanUnix(spanRows)
    : { start: null, end: null, duration_s: 0 };
  const windows = detectMeasurementWindows(scoped);
  const duty = classifyDutyCycle(windows, {
    captureStart: captureStart ?? span.start,
    captureEnd: captureEnd ?? span.end,
    priorPeriod,
    asleepUnix: asleepUnixStamps(scoped),
  });
  const validWindowValues = windows.filter((w) => w.window_value != null).map((w) => w.window_value);
  const nightValue = meanOf(validWindowValues);
  const source_device_ids = [...new Set(scoped.map((r) => r.device_id).filter(Boolean))];
  const user_ids = [...new Set(scoped.map((r) => r.user_id).filter(Boolean))];
  const confirmedIds = [...new Set(scoped
    .filter((r) => r.physical_identity_confidence === 'confirmed' && r.physical_device_id)
    .map((r) => r.physical_device_id))];
  const evidence = [...new Set(scoped.map((r) => r.physical_identity_evidence).filter(Boolean))];
  const confirmed = confirmedIds.length === 1;
  return {
    total_v18_records: v18,
    candidate_count: candidates.length,
    candidate_coverage_pct: Math.round(coverage * 10000) / 100,
    candidate_values: vals,
    candidate_timestamps: timestamps,
    mean: nightValue,
    candidate_mean: meanOf(vals),
    median: percentile(vals, 0.5),
    minimum: vals.length ? vals[0] : null,
    maximum: vals.length ? vals[vals.length - 1] : null,
    p10: percentile(vals, 0.1),
    p90: percentile(vals, 0.9),
    burst_lengths: bursts.burst_lengths,
    time_between_bursts_s: bursts.time_between_bursts_s,
    candidate_count_while_asleep: asleep,
    candidate_count_while_awake: awake,
    sentinel_count: sentinel,
    diagnostic_count: diagnostic,
    sample_count: candidates.length,
    coverage,
    source: SPO2_SOURCE,
    firmware: firmware[0] || null,
    firmware_seen: firmware,
    decoder_version: decoder[0] || null,
    decoder_versions: decoder,
    confidence: candidates.length ? 'experimental' : 'unavailable',
    status: candidates.length ? 'experimental_candidate' : 'unavailable',
    windows,
    window_values: validWindowValues,
    source_device_ids,
    user_ids,
    physical_device_id: confirmed ? confirmedIds[0] : null,
    physical_device_ids: confirmedIds,
    physical_identity_confidence: confirmed ? 'confirmed' : 'unknown',
    physical_identity_evidence: confirmed ? (evidence[0] || null) : null,
    alias_relations: deviceAliasRelations(scoped),
    independent_physical_device_count: confirmedIds.length,
    spo2_pct: null,
    ...duty,
  };
}

export function reportsByDeviceFirmwareNight(observations, {
  timeZone = 'UTC',
  sleepSessions = null,
  by = 'physical',
} = {}) {
  const rows = (observations || []).map((o) => annotateSpo2Identity(o));
  const episodes = inferSleepEpisodes(rows);
  const groups = new Map();
  for (const obs of rows) {
    const night = physiologicalNightKey(obs, { timeZone, sleepSessions, episodes });
    if (!night) continue;
    const phys = groupingDeviceKey(obs, by);
    const fw = obs.firmware || 'unknown';
    const key = `${phys}|${fw}|${night}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(obs);
  }
  const priorPeriodByPhysFw = new Map();
  for (const [, grouped] of groups) {
    const spanRows = grouped.filter((o) => isNonzeroSpo2(o) || o.sleep_state === SLEEP_ASLEEP);
    const span = spanRows.length
      ? captureSpanUnix(spanRows)
      : { start: null, end: null, duration_s: 0 };
    const duty = classifyDutyCycle(detectMeasurementWindows(grouped), {
      captureStart: span.start,
      captureEnd: span.end,
      asleepUnix: asleepUnixStamps(grouped),
    });
    if (duty.median_period) {
      const phys = groupingDeviceKey(grouped[0], by);
      const fw = grouped[0]?.firmware || 'unknown';
      const k = `${phys}|${fw}`;
      const prev = priorPeriodByPhysFw.get(k) || [];
      prev.push(duty.median_period);
      priorPeriodByPhysFw.set(k, prev);
    }
  }
  return [...groups.entries()].map(([key, grouped]) => {
    const parts = key.split('|');
    const night = parts[2];
    const firmware = parts[1] === 'unknown' ? null : parts[1];
    const phys = groupingDeviceKey(grouped[0], by);
    const prior = medianOf(priorPeriodByPhysFw.get(`${phys}|${parts[1]}`) || []);
    const summary = summarizeSpo2Observations(grouped, {
      timeZone,
      sleepSessions,
      priorPeriod: prior,
    });
    return {
      ...summary,
      device_id: grouped[0]?.device_id || null,
      source_device_id: grouped[0]?.device_id || null,
      physical_device_id: summary.physical_device_id,
      physical_identity_confidence: summary.physical_identity_confidence,
      physical_identity_evidence: summary.physical_identity_evidence,
      source_device_ids: summary.source_device_ids,
      user_id: by === 'user' ? (parts[0] === 'unknown' ? null : parts[0]) : (summary.user_ids[0] || null),
      user_ids: summary.user_ids,
      firmware,
      night,
      frwhoop_physiological_day: night,
    };
  }).sort((a, b) => a.night.localeCompare(b.night)
    || String(a.physical_device_id || '').localeCompare(b.physical_device_id || ''));
}

export function correlateConsoleLogs(observations, logs, { windowS = 30 } = {}) {
  const candidates = (observations || []).filter((o) => o.spo2_state === 'candidate' && unixOf(o) != null);
  const hits = [];
  for (const log of logs || []) {
    const t = unixOf({ sensor_timestamp: log.unix, unix: log.unix });
    const text = String(log.log || log.text || '');
    if (t == null || !text) continue;
    if (!LOG_HINT.test(text)) continue;
    const nearby = candidates.filter((o) => Math.abs(unixOf(o) - t) <= windowS);
    hits.push({
      unix: t,
      log: text.slice(0, 240),
      nearby_candidates: nearby.length,
      nearby_values: nearby.map((o) => o.spo2_candidate_pct),
      nearby_timestamps: nearby.map((o) => unixOf(o)),
    });
  }
  return {
    log_hits: hits.length,
    correlated_candidate_count: hits.reduce((n, h) => n + h.nearby_candidates, 0),
    hits,
  };
}

export function scanConfigReadbacks(records) {
  const out = [];
  for (const rec of records || []) {
    const rb = rec.decoded?.parsed?.config_read_back || rec.parsed?.config_read_back || rec.config_read_back;
    if (!rb) continue;
    const key = String(rb.key || '');
    if (key && CONFIG_KEY_HINT.test(key)) {
      out.push({
        cmd: rb.cmd,
        result: rb.result,
        key,
        value: rb.value,
        frame_hash: rec.frame_hash || null,
        t: rec.t || null,
      });
    }
  }
  return out;
}
