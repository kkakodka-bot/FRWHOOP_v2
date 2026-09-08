import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID, createHash } from 'node:crypto';
import { storageConfig } from '../storage/config.js';
import { derivedObjectKeyV2, rawObjectKeyV3, uuidFromParts, isUuid } from '../storage/keys.js';
import { getStores } from '../storage/stores.js';
import { scoreDay, ALGORITHM_VERSION, isPersistableOvernight, sleepPersistState, strainSeriesFromHr } from './sleep.js';
import { decodeArchive, encodeArchive, encodeFrameArchive, ARCHIVE_SCHEMA_VERSION, sha256Hex, decodeFieldCensus } from '../ingest/archiveFormat.js';
import { decodeImuArchive, dedupeImuRecords } from '../protocol/imuArchive.js';
import { decodePpgArchive, dedupePpgRecords } from '../protocol/ppgArchive.js';
import { decodeEventArchive } from '../protocol/eventRecords.js';
import { foldBatteryTimeline, noteConsumption } from '../protocol/consumption.js';
import { expiresAt } from '../storage/retention.js';
import { seriesFromSamples, seriesRowsFromSamples, bpmDataFromSeries, unionBpmData } from './buckets.js';
import { dayBounds, localDateKey, physiologicalDay } from '../time/dayBoundary.js';
import { inc } from '../observability/metrics.js';
import { computeEnergy, computeEnergyV2, computeEnergyV3, energyPayload, MODEL_VERSION } from '../energy/service.js';
import { selectImuForEnergyV3, hasCompleteV21Imu } from '../energy/v3/imuEvidence.js';
import { createOvernightProvider } from './overnight.js';
import { accumulateSteps, carryInCounterForDay } from './steps.js';
import {
  computeStepsV2,
  stepsV2Mode,
  stepsV2Provenance,
  shadowCompare,
} from './stepsV2.js';
import {
  computeStepsV3,
  stepsV3Provenance,
  unavailableStepsV3,
} from './stepsV3.js';
import { loadStepsV3Artifact } from './stepsV3Artifact.js';
import { loadSleepV3Artifact, shouldComputeSleepV3, sleepV3Mode } from './sleepV3Artifact.js';
import { summarizeTemperature } from './temperature.js';
import { summarizeSpo2Candidate, spo2CandidateSeriesFromSamples, overlaySpo2OnSamples, extrasFromSpo2Summary, shouldPersistSpo2Candidate } from './spo2.js';
import {
  HISTORICAL_CLOCK_MIN_ABS_OFFSET_MS,
  HISTORICAL_CLOCK_MAX_ABS_OFFSET_MS,
  historicalClockOffsetMs,
} from '../time/clockCorrection.js';
import { computeHr2Day, computeHr2PartialBucket } from '../hr2/pipeline.js';
import { hr2Mode, HR2_ALGORITHM_VERSION as HR2_VERSION } from '../hr2/version.js';
import { computeStrainV2, provenancePayload as strainV2Provenance, strainV2Mode } from './strainV2/score.js';
import { computeDayCompleteness, gapCoveredBySamples, resolveGapThreshold, parseSampleTime, toDayCompletenessWire } from './dayCompleteness.js';
import { loadVerifiedPhysiologyObject, loadCanonicalWindowEvidence, manifestOverlapsWindow } from './dayEvidence.js';
import { persistSidecarsFromFrames } from '../redecode/sidecar.js';
import { inspectRequiredArtifacts, metricStatus, energyV2ComputeMode, energyV3ComputeMode, buildAvailability, presentMetric, resolveEnergyKcal, resolveSteps, applyDailyMetricsPersist } from './canonicalRegistry.js';
import { buildShadowReadModel, foldWristState } from './shadowReadModel.js';

function jsonGzip(obj) {
  return gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'));
}

function dayKeyOf(iso) {
  return String(iso || '').slice(0, 10);
}

function enumerateDays(fromDay, toDay) {
  if (!fromDay) return [];
  const out = [];
  let t = Date.parse(`${fromDay}T12:00:00.000Z`);
  const end = Date.parse(`${(toDay || fromDay)}T12:00:00.000Z`);
  if (!Number.isFinite(t) || !Number.isFinite(end) || t > end) return [];
  while (t <= end) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86400000;
  }
  return out;
}

/**
 * Physiology objects can land in B2 without an object_manifests row (archive
 * wrote the file, then the manifest upsert failed). Replay must still find them.
 */
export async function extraPhysiologyKeys(raw, userId, days, timeZone = 'UTC', siblingUserId = null) {
  if (typeof raw?.listPrefix !== 'function' || !userId || !days?.length) return [];
  const keys = [];
  const ids = [...new Set([userId, siblingUserId].filter(Boolean))];
  for (const id of ids) {
    for (const prefix of [`v3/core/users/${id}/`, `v2/users/${id}/`]) {
      try {
        keys.push(...await raw.listPrefix(prefix));
      } catch { /* listing is best-effort */ }
    }
  }
  const windows = days.map((day) => {
    const b = dayBounds(day, timeZone);
    return [Date.parse(b.day_start_at) - 12 * 3600000, Date.parse(b.day_end_at)];
  });
  return [...new Set(keys)].filter((key) => {
    if (!/\/(physiology|hr|live_hr)\//.test(key)) return false;
    const m = /\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\//.exec(key);
    if (!m) return false;
    const hour = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]));
    return windows.some(([lo, hi]) => hour >= lo && hour < hi);
  });
}

/** Prefix-discovery for derived high-rate objects overlapping the requested local days. */
export async function extraDerivedKeys(raw, userId, days, timeZone = 'UTC', siblingUserId = null, stream = 'imu_raw') {
  if (typeof raw?.listPrefix !== 'function' || !userId || !days?.length) return [];
  const keys = [];
  const ids = [...new Set([userId, siblingUserId].filter(Boolean))];
  for (const id of ids) {
    for (const prefix of [`v3/core/users/${id}/`, `v2/users/${id}/`]) {
      try {
        keys.push(...await raw.listPrefix(prefix));
      } catch { /* listing is best-effort */ }
    }
  }
  const windows = days.map((day) => {
    const b = dayBounds(day, timeZone);
    return [Date.parse(b.day_start_at) - 12 * 3600000, Date.parse(b.day_end_at)];
  });
  const token = `/${stream}/`;
  return [...new Set(keys)].filter((key) => {
    if (!key.includes(token)) return false;
    const m = /\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\//.exec(key);
    if (!m) return false;
    const hour = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]));
    return windows.some(([lo, hi]) => hour >= lo && hour < hi);
  });
}

export async function extraImuKeys(raw, userId, days, timeZone = 'UTC', siblingUserId = null) {
  return extraDerivedKeys(raw, userId, days, timeZone, siblingUserId, 'imu_raw');
}

export async function extraPpgKeys(raw, userId, days, timeZone = 'UTC', siblingUserId = null) {
  return extraDerivedKeys(raw, userId, days, timeZone, siblingUserId, 'ppg_raw');
}

export async function extraWhoop5ImuKeys(raw, userId, days, timeZone = 'UTC', siblingUserId = null) {
  return extraDerivedKeys(raw, userId, days, timeZone, siblingUserId, 'whoop5_imu_v21');
}

export async function extraWhoop5PpgKeys(raw, userId, days, timeZone = 'UTC', siblingUserId = null) {
  return extraDerivedKeys(raw, userId, days, timeZone, siblingUserId, 'whoop5_ppg_v26');
}

export async function extraOpticalV20Keys(raw, userId, days, timeZone = 'UTC', siblingUserId = null) {
  return extraDerivedKeys(raw, userId, days, timeZone, siblingUserId, 'whoop5_optical_v20');
}

export async function extraEventKeys(raw, userId, days, timeZone = 'UTC', siblingUserId = null) {
  return extraDerivedKeys(raw, userId, days, timeZone, siblingUserId, 'events');
}

function imuSensorTimeMs(record) {
  const raw = Number(record?.sensor_ts ?? record?.unix ?? record?.timestamp ?? record?.event_ts);
  if (!Number.isFinite(raw)) return null;
  const base = raw > 1e12 ? raw : raw * 1000;
  const subsec = Number(record?.subsec ?? record?.subseconds);
  return base + (raw <= 1e12 && Number.isFinite(subsec) && subsec >= 0 && subsec < 32768
    ? subsec / 32768 * 1000
    : 0);
}

function imuRecordTimeMs(record) {
  for (const value of [
    record?.corrected_at,
    record?.corrected_timestamp,
    record?.corrected_sensor_ts,
    record?.event_ts,
    record?.event_at,
    record?.t,
    record?.datetime,
  ]) {
    const numeric = Number(value);
    if (value != null && value !== '' && Number.isFinite(numeric)) {
      return numeric > 1e12 ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(value || '');
    if (Number.isFinite(parsed)) return parsed;
  }
  const sensorMs = imuSensorTimeMs(record);
  const offset = Number(record?.clock_offset_sec);
  return Number.isFinite(sensorMs) && record?.clock_offset_sec != null
    && record.clock_offset_sec !== '' && Number.isFinite(offset)
    ? sensorMs + offset * 1000
    : sensorMs;
}

function imuRecordOverlaps(record, startMs, endMs) {
  const t0 = imuRecordTimeMs(record);
  if (!Number.isFinite(t0)) return false;
  const rate = Number(record?.sample_rate_hz);
  const hz = Number.isFinite(rate) && rate > 0 ? rate : 100;
  const durationMs = (record?.accel_x?.length || record?.samples?.length || 0) / hz * 1000;
  return t0 + durationMs > startMs && t0 < endMs;
}

/** Apply the same conservative, provably-wrong RTC correction used by replay. */
export function correctImuHistoricalClock(records = []) {
  const hasCorrectedTime = (record) => record?.corrected_sensor_ts != null
    && record.corrected_sensor_ts !== ''
    && Number.isFinite(Number(record.corrected_sensor_ts));
  const candidates = records
    .filter((record) => !hasCorrectedTime(record))
    .map((record) => ({
      record,
      sensorMs: imuSensorTimeMs(record),
      receivedMs: Date.parse(record?.received_at || ''),
    }))
    .filter((row) => Number.isFinite(row.sensorMs) && Number.isFinite(row.receivedMs));
  if (!candidates.length) return records;
  const newest = candidates.reduce(
    (best, row) => (row.sensorMs > best.sensorMs ? row : best),
    candidates[0],
  );
  const offsetMs = historicalClockOffsetMs(newest.sensorMs, newest.receivedMs);
  if (!offsetMs) return records;
  return records.map((record) => {
    if (hasCorrectedTime(record)) return record;
    const sensorMs = imuSensorTimeMs(record);
    if (!Number.isFinite(sensorMs)) return record;
    return {
      ...record,
      corrected_sensor_ts: sensorMs + offsetMs,
      clock_offset_sec: offsetMs / 1000,
      clock_correction: 'historical_provably_wrong_rtc',
      clock_verified: false,
      clock_provenance: {
        ...(record?.clock_provenance || {}),
        corrected: true,
        correction_source: 'newest_bad_rtc_to_object_receive_time',
        correction_offset_ms: offsetMs,
        accuracy_eligible: false,
      },
    };
  });
}

export async function loadImuRecordsForWindow({
  db, raw, userId, fromDay, toDay, timeZone = 'UTC', extraKeys = [],
  objectKind = 'imu_raw',
  decode = decodeImuArchive,
  correctClock = true,
} = {}) {
  const records = [];
  const seen = new Set();
  const integrity = {
    expected_manifest_objects: 0,
    loaded_manifest_objects: 0,
    verified_manifest_objects: 0,
    unverified_manifest_objects: 0,
    prefix_only_objects: 0,
    failures: [],
    manifest_listing_available: false,
    complete: true,
  };
  let listed = [];
  if (db && typeof db.listObjectManifests === 'function') {
    try {
      listed = await db.listObjectManifests({
        userId, fromDay, toDay, timeZone, objectKind,
      });
      integrity.manifest_listing_available = true;
    } catch (err) {
      listed = [];
      integrity.failures.push({
        object_key: null,
        reason: err?.code === 'service_role_required' ? 'service_role_required' : 'manifest_listing_failed',
      });
    }
  }
  integrity.expected_manifest_objects = new Set(
    (listed || []).map((row) => row?.object_key).filter(Boolean),
  ).size;
  for (const row of listed || []) {
    if (!row?.object_key || seen.has(row.object_key)) continue;
    seen.add(row.object_key);
    try {
      const obj = await raw.getObject(row.object_key);
      if (!obj?.body) {
        integrity.failures.push({ object_key: row.object_key, reason: 'object_body_missing' });
        continue;
      }
      let manifestVerified = false;
      if (row.sha256) {
        const sha = sha256Hex(Buffer.from(obj.body));
        if (sha !== row.sha256) {
          integrity.failures.push({
            object_key: row.object_key,
            reason: 'sha256_mismatch',
            expected_sha256: row.sha256,
            loaded_sha256: sha,
          });
          continue;
        }
        manifestVerified = true;
      }
      const decoded = correctClock
        ? correctImuHistoricalClock(decode(obj.body))
        : decode(obj.body);
      integrity.loaded_manifest_objects += 1;
      if (manifestVerified) integrity.verified_manifest_objects += 1;
      else integrity.unverified_manifest_objects += 1;
      records.push(...decoded.map((record) => ({
        ...record,
        ...(manifestVerified ? {
          _manifest_verified: true,
          _manifest_sha256: row.sha256,
        } : { _manifest_verified: false }),
        _manifest_object_key: row.object_key,
      })));
    } catch (error) {
      integrity.failures.push({
        object_key: row.object_key,
        reason: 'object_unreadable_or_decode_failed',
        detail: String(error?.message || error).slice(0, 200),
      });
    }
  }
  for (const key of extraKeys || []) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    try {
      const obj = await raw.getObject(key);
      if (obj?.body) {
        integrity.prefix_only_objects += 1;
        const prefixDecoded = correctClock
          ? correctImuHistoricalClock(decode(obj.body))
          : decode(obj.body);
        records.push(...prefixDecoded.map((record) => ({
          ...record,
          _manifest_verified: false,
          _manifest_object_key: key,
          _manifest_discovery: 'prefix_unverified',
        })));
      }
    } catch (error) {
      integrity.failures.push({
        object_key: key,
        reason: 'prefix_object_unreadable_or_decode_failed',
        detail: String(error?.message || error).slice(0, 200),
      });
    }
  }
  integrity.complete = integrity.failures.length === 0
    && integrity.manifest_listing_available
    && integrity.loaded_manifest_objects === integrity.expected_manifest_objects
    && integrity.unverified_manifest_objects === 0
    && integrity.prefix_only_objects === 0;
  return { records, integrity };
}

export async function loadPpgRecordsForWindow(opts = {}) {
  return loadImuRecordsForWindow({
    ...opts,
    objectKind: 'ppg_raw',
    decode: decodePpgArchive,
  });
}

export async function loadEventRecordsForWindow(opts = {}) {
  return loadImuRecordsForWindow({
    ...opts,
    objectKind: 'events',
    decode: decodeEventArchive,
    correctClock: false,
  });
}

/**
 * Main (longest) overnight sleep session in ms epochs, for the hr2 RHR
 * candidates. Sessions come from the sleep scorer with ms start/end.
 */
function mainSleepWindow(sessions = []) {
  const usable = (sessions || []).filter((s) => {
    const start = Number(s?.start);
    const end = Number(s?.end);
    return Number.isFinite(end) && Number.isFinite(start) && end > start && s?.isNap !== true && s?.kind !== 'nap';
  });
  if (!usable.length) return null;
  const main = usable.reduce((best, s) => (Number(s.end) - Number(s.start) > Number(best.end) - Number(best.start) ? s : best));
  return { startMs: Number(main.start), endMs: Number(main.end) };
}

function replaySampleKey(sample) {
  const time = sample?.t || sample?.datetime || sample?.at || sample?.ts || '';
  const gravity = sample?.gravity || sample?.accel || {};
  return JSON.stringify([
    sample?.device_id || sample?.deviceId || null,
    sample?.sensor_ts ?? null,
    time,
    sample?.seq ?? null,
    sample?.bpm ?? sample?.heartRate ?? null,
    sample?.rr_ms ?? sample?.rrIntervals ?? [],
    sample?.steps ?? null,
    sample?.step_cumulative ?? sample?.stepCounter ?? null,
    gravity.x ?? sample?.gx ?? sample?.x ?? null,
    gravity.y ?? sample?.gy ?? sample?.y ?? null,
    gravity.z ?? sample?.gz ?? sample?.z ?? null,
  ]);
}

export function dedupeReplaySamples(samples = []) {
  const seen = new Set();
  return samples.filter((sample) => {
    const key = replaySampleKey(sample);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => {
    const ta = Date.parse(a?.t || a?.datetime || a?.at || a?.ts || 0);
    const tb = Date.parse(b?.t || b?.datetime || b?.at || b?.ts || 0);
    return ta - tb;
  });
}

export function correctReplayHistoricalClock(samples = []) {
  // Rows that already carry an explicit correction (ingest-time anchor, or the
  // phone's live-evidence anchor) are TRUSTED as-is: their `t` is already wall
  // time. Including them in the offset computation would mix two clock domains
  // and double-shift them (corrected rows sit ~days ahead of uncorrected ones,
  // so `newestRecorded` would pick a corrected row and the whole batch — the
  // corrected rows included — would be shifted again).
  const uncorrected = samples.filter((sample) => Number.isFinite(Date.parse(sample?.t_strap || ''))
    && Number.isFinite(Date.parse(sample?.t || sample?.datetime || sample?.at || ''))
    && !(Number.isFinite(Number(sample?.clock_offset_sec)) && sample.clock_offset_sec !== 0));
  if (!uncorrected.length) return samples;
  const newestStrap = Math.max(...uncorrected.map((sample) => Date.parse(sample.t_strap)));
  const newestRecorded = Math.max(...uncorrected.map(
    (sample) => Date.parse(sample.t || sample.datetime || sample.at),
  ));
  // Replay-specific offset rule. At replay time BOTH clock domains are known:
  // `t_strap` is the raw strap stamp and `t` is the time the pipeline already
  // accepted (phone receive/corrected wall time). The ingest-time rule
  // (`historicalClockOffsetMs`) refuses to shift a merely-past strap clock
  // because at ingest a months-old stamp may be genuine banked history. At
  // REPLAY that ambiguity is resolved by the recorded `t`:
  //   - genuine late-drained backlog → the phone dated rows at their strap
  //     stamps, so t ≈ t_strap and offset ≈ 0 → untouched;
  //   - a strap clock provably incoherent with the recorded domain (≥ 7 d
  //     apart) → anchor the newest strap stamp at the newest recorded time
  //     and preserve the strap-age structure between records, so a clock that
  //     jumped between batches cannot collapse 25 days of real age onto one
  //     minute, nor teleport a night onto the drain window.
  //
  // The corrected-row skip above also fixes the MIXED batch case: a drain that
  // engaged the anchor mid-flight holds some strap-dated and some
  // anchor-corrected rows. The offset is computed from the UNCORRECTED subset
  // only (their `t` is still the honest receive-time record), and only
  // uncorrected rows are re-stamped.
  const offset = newestRecorded - newestStrap;
  const applyCorrection = Math.abs(offset) >= HISTORICAL_CLOCK_MIN_ABS_OFFSET_MS
    && Math.abs(offset) <= HISTORICAL_CLOCK_MAX_ABS_OFFSET_MS;
  if (!applyCorrection) return samples;
  return samples.map((sample) => {
    if (Number.isFinite(Number(sample?.clock_offset_sec)) && sample.clock_offset_sec !== 0) {
      return sample;   // already corrected — never double-shift
    }
    const strap = Date.parse(sample?.t_strap || '');
    if (!Number.isFinite(strap)) return sample;
    const t = new Date(strap + offset).toISOString();
    return { ...sample, t, datetime: t, clock_offset_sec: Math.round(offset / 1000) };
  });
}

/** Fraction of replay samples outside a day window; logs offset distribution when >90% miss. */
export function replayWindowCoverage(samples = [], { lo, hi } = {}) {
  if (!Array.isArray(samples) || !samples.length || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { total: 0, in_window: 0, out_window: 0, fraction_outside: 0 };
  }
  let inWindow = 0;
  for (const sample of samples) {
    const t = Date.parse(sample?.t || sample?.datetime || sample?.at || '');
    if (Number.isFinite(t) && t >= lo && t < hi) inWindow += 1;
  }
  const out = samples.length - inWindow;
  return {
    total: samples.length,
    in_window: inWindow,
    out_window: out,
    fraction_outside: samples.length ? out / samples.length : 0,
  };
}

export function guardReplayWindowCoverage(samples = [], { lo, hi, label = 'replay' } = {}) {
  const coverage = replayWindowCoverage(samples, { lo, hi });
  if (coverage.total > 0 && coverage.fraction_outside >= 0.9) {
    inc('replay_window_samples_outside');
    const offsets = samples
      .map((sample) => {
        const strap = Date.parse(sample?.t_strap || '');
        const wall = Date.parse(sample?.t || sample?.datetime || sample?.at || '');
        return Number.isFinite(strap) && Number.isFinite(wall) ? wall - strap : null;
      })
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const median = offsets.length ? offsets[Math.floor(offsets.length / 2)] : null;
    console.warn(
      `${label}_window_guard: ${coverage.out_window}/${coverage.total} samples outside `
      + `[${new Date(lo).toISOString()}, ${new Date(hi).toISOString()}); median_offset_ms=${median}`,
    );
  }
  return coverage;
}

export function sleepToWhoopDay(night) {
  if (!night) return null;
  const sleep = {
    'Sleep onset': night.onsetIso || night.sleep_onset_at || null,
    'Wake onset': night.wakeIso || night.wake_onset_at || null,
    'Sleep performance %': night.performance ?? night.performance_pct ?? null,
    'Asleep duration (min)': night.asleepMin ?? night.asleep_min ?? null,
    'In bed duration (min)': night.inBedMin ?? night.in_bed_min ?? null,
    'Light sleep duration (min)': night.lightMin ?? night.light_min ?? null,
    'Deep (SWS) duration (min)': night.deepMin ?? night.deep_min ?? null,
    'REM duration (min)': night.remMin ?? night.rem_min ?? null,
    'Awake duration (min)': night.awakeMin ?? night.awake_min ?? null,
    'Sleep need (min)': night.needMin ?? night.need_min ?? null,
    'Sleep debt (min)': night.debtMin ?? night.debt_min ?? null,
    'Sleep efficiency %': night.efficiency != null
      ? (Number(night.efficiency) <= 1 ? Number(night.efficiency) * 100 : Number(night.efficiency))
      : (night.efficiency_pct ?? null),
    'Sleep consistency %': night.consistency ?? night.consistency_pct ?? null,
    Nap: Boolean(night.is_nap ?? night.isNap),
  };
  if (night.resp_rate_bpm != null) sleep['Respiratory rate (rpm)'] = night.resp_rate_bpm;
  const phys = { ...sleep };
  if (night.recovery != null || night.recovery_pct != null) {
    phys['Recovery score %'] = night.recovery ?? night.recovery_pct;
  }
  if (night.overnightHr != null || night.overnight_hr_bpm != null) {
    phys['Resting heart rate (bpm)'] = night.restingHr ?? night.resting_hr_bpm ?? night.overnightHr ?? night.overnight_hr_bpm;
  }
  if (night.hrv_rmssd_ms != null) phys['Heart rate variability (ms)'] = night.hrv_rmssd_ms;
  return {
    sleep_summary: sleep,
    physiological_summary: phys,
    sleep_hypnogram: Array.isArray(night.hypnogram) ? night.hypnogram : (Array.isArray(night.stages) ? night.stages : []),
  };
}

export function dailyToWhoopDay(row) {
  if (!row) return null;
  const healthkit = row.extras?.healthkit || {};
  const energy = resolveEnergyKcal({
    energy_kcal: row.energy_kcal,
    active_kcal: row.active_kcal,
    basal_kcal: row.basal_kcal,
  });
  const steps = resolveSteps(row);
  const efficiencyPct = row.sleep_efficiency == null
    ? null
    : (Number(row.sleep_efficiency) <= 1 ? Number(row.sleep_efficiency) * 100 : Number(row.sleep_efficiency));
  const phys = {
    'Recovery score %': presentMetric(row.recovery_score ?? row.charge),
    'Day Strain': presentMetric(row.strain_score ?? row.effort),
    'Day Strain V2': presentMetric(row.strain_score_v2),
    'Heart rate variability (ms)': presentMetric(row.hrv_rmssd_ms ?? healthkit.hrv_sdnn),
    'Resting heart rate (bpm)': presentMetric(row.resting_hr_bpm),
    'Average HR (bpm)': presentMetric(row.avg_hr_bpm),
    'Max HR (bpm)': presentMetric(row.max_hr_bpm),
    'Respiratory rate (rpm)': presentMetric(
      row.resp_rate_bpm
      ?? healthkit.resp_rate
      ?? row.extras?.respiration?.value,
    ),
    'Sleep performance %': presentMetric(row.sleep_performance_pct ?? row.rest),
    'Asleep duration (min)': presentMetric(row.sleep_total_min),
    'In bed duration (min)': presentMetric(row.sleep_in_bed_min),
    'Light sleep duration (min)': presentMetric(row.sleep_light_min),
    'Deep (SWS) duration (min)': presentMetric(row.sleep_deep_min),
    'REM duration (min)': presentMetric(row.sleep_rem_min),
    'Awake duration (min)': presentMetric(row.sleep_awake_min),
    'Sleep need (min)': presentMetric(row.sleep_need_min),
    'Sleep debt (min)': presentMetric(row.sleep_debt_balance_min),
    'Sleep efficiency %': efficiencyPct,
    'Sleep consistency %': presentMetric(row.sleep_consistency),
    'Sleep onset': row.sleep_onset_at || null,
    'Wake onset': row.wake_onset_at || null,
    Steps: steps == null ? null : Math.round(steps),
    'Energy burned (cal)': energy,
    // Skin temperature + blood oxygen were silently dropped from backend-fed
    // days (they were only present in the coach fixture). Expose the values so
    // the frontend can render them; they are distinct from a missing value.
    'Skin temp (celsius)': presentMetric(row.skin_temp_c),
    'Blood oxygen %': presentMetric(row.spo2_pct),
    'Skin temp deviation (celsius)': presentMetric(row.skin_temp_dev_c),
    'VO2 Max': presentMetric(row.vo2max ?? healthkit.vo2max),
  };
  const skinTempSeries = Array.isArray(row.extras?.skin_temp_series)
    ? row.extras.skin_temp_series
    : (Array.isArray(row.skin_temp_series) ? row.skin_temp_series : []);
  const spo2Candidate = row.extras?.spo2_candidate || null;
  const spo2CandidatePct = presentMetric(
    spo2Candidate?.spo2_candidate_pct ?? row.extras?.spo2_candidate_pct ?? row.spo2_candidate_pct,
  );
  const spo2CandidateSeries = Array.isArray(row.spo2_candidate_series) && row.spo2_candidate_series.length
    ? row.spo2_candidate_series
    : (Array.isArray(row.extras?.spo2_candidate_series) ? row.extras.spo2_candidate_series : []);
  const strainV2 = row.strain_v2 && typeof row.strain_v2 === 'object' && !Array.isArray(row.strain_v2)
    ? row.strain_v2
    : null;
  return {
    physiological_summary: phys,
    sleep_summary: { ...phys, Nap: false },
    skin_temp_series: skinTempSeries,
    spo2_candidate_pct: spo2CandidatePct,
    spo2_candidate_series: spo2CandidateSeries,
    spo2_source: row.spo2_pct != null
      ? 'validated'
      : (row.spo2_source || (spo2CandidatePct != null ? 'whoop_v18_candidate' : null)),
    strain_v2: strainV2,
    strain_score_v2: presentMetric(row.strain_score_v2),
    // Explicit overnight-finalization state. Never let the UI's only signal
    // be an empty Recovery card: the day says exactly where it stands.
    finalization: row.extras?.overnight_finalization || null,
    availability: row.availability || buildAvailability({
      metrics: {
        ...row,
        steps,
        energy_kcal: energy,
        strain_score: row.strain_score ?? row.effort,
      },
    }),
  };
}

export function mergeWorkoutLists(a, b) {
  const rows = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
  const seen = new Set();
  const out = [];
  for (const w of rows) {
    if (!w || typeof w !== 'object') continue;
    const key = w.id || w['Workout start time'] || w.start || JSON.stringify(w).slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

export function sessionToWhoopWorkout(session) {
  if (!session) return null;
  const summary = session.summary && typeof session.summary === 'object' ? session.summary : {};
  const zones = Array.isArray(session.segments) && session.segments.length
    ? session.segments
    : (Array.isArray(summary.zones) ? summary.zones : [0, 0, 0, 0, 0]);
  const durationMin = summary.duration_min
    ?? (summary.duration_s != null ? Number(summary.duration_s) / 60 : null);
  return {
    id: session.id,
    'Workout start time': session.start_at,
    'Workout end time': session.end_at,
    'Duration (min)': durationMin,
    'Activity name': summary.sport === 'detected' ? 'Detected Workout' : (summary.sport || 'Workout'),
    'Activity Strain': summary.strain ?? null,
    'Energy burned (cal)': summary.calories_kcal ?? summary.calories ?? null,
    'Max HR (bpm)': summary.peak_hr ?? summary.maxHr ?? null,
    'Average HR (bpm)': summary.avg_hr ?? summary.avgHr ?? null,
    'HR Zone 1 %': Number(zones[0]) || 0,
    'HR Zone 2 %': Number(zones[1]) || 0,
    'HR Zone 3 %': Number(zones[2]) || 0,
    'HR Zone 4 %': Number(zones[3]) || 0,
    'HR Zone 5 %': Number(zones[4]) || 0,
    source: /auto/.test(String(session.source || '')) ? 'auto' : (session.source || 'whoop'),
  };
}

function mergeDefined(base = {}, patch = {}) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value != null) out[key] = value;
    else if (!(key in out)) out[key] = null;
  }
  return out;
}

export function mergeWhoopDays(base = {}, overlays = []) {
  const out = { ...base };
  for (const { day, patch } of overlays) {
    if (!day || !patch) continue;
    const prev = out[day] || {};
    out[day] = {
      ...prev,
      ...patch,
      physiological_summary: mergeDefined(prev.physiological_summary, patch.physiological_summary),
      sleep_summary: mergeDefined(prev.sleep_summary, patch.sleep_summary),
      workouts: mergeWorkoutLists(prev.workouts, patch.workouts),
      bpm_data: unionBpmData(prev.bpm_data, patch.bpm_data),
      sleep_hypnogram: (patch.sleep_hypnogram?.length ? patch.sleep_hypnogram : prev.sleep_hypnogram) || [],
      strain_series: (patch.strain_series?.length ? patch.strain_series : prev.strain_series) || [],
      skin_temp_series: (patch.skin_temp_series?.length ? patch.skin_temp_series : prev.skin_temp_series) || [],
      spo2_candidate_series: (patch.spo2_candidate_series?.length ? patch.spo2_candidate_series : prev.spo2_candidate_series) || [],
      spo2_candidate_pct: patch.spo2_candidate_pct ?? prev.spo2_candidate_pct ?? null,
      spo2_source: patch.spo2_source || prev.spo2_source || null,
      strain_v2: (patch.strain_v2 && typeof patch.strain_v2 === 'object') ? patch.strain_v2 : (prev.strain_v2 || null),
      strain_score_v2: patch.strain_score_v2 ?? prev.strain_score_v2 ?? null,
      availability: patch.availability || prev.availability || null,
      // Newest non-null finalization state wins; a patch that does not carry
      // one must not erase an earlier explicit state.
      finalization: patch.finalization ?? prev.finalization ?? null,
    };
  }
  return out;
}

export function createMetricsEngine({
  cfg = storageConfig(),
  stores,
  db,
  now = () => new Date(),
  uuid = randomUUID,
  /**
   * Supplies the subject profile and workout list the energy model needs. Left
   * unset in tests and in any deployment without a profile store, in which case
   * energy is simply not computed rather than computed from defaults.
   */
  energyContext = null,
  /**
   * Optional validated artifact injection for deterministic tests. Production
   * leaves this undefined and uses the cached JSON artifact loader.
   */
  stepsV3Artifact = undefined,
} = {}) {
  async function resolveStores() {
    return stores || getStores(cfg);
  }

  function userId() {
    const id = cfg.localUserId;
    if (!isUuid(id)) throw new Error('FRWHOOP_LOCAL_USER_ID must be a uuid');
    return id;
  }

  async function resolveDerivedRecordsForPersist(extras, persistDay, tz, {
    passedKey, integrityKey, extraKeysFn, loadFn,
  }) {
    const passed = Array.isArray(extras?.[passedKey]) ? extras[passedKey] : [];
    const provided = { records: passed, integrity: extras?.[integrityKey] || null };
    if (!persistDay) return provided;
    try {
      const { raw } = await resolveStores();
      if (!raw) return provided;
      let uid = extras?.userId;
      if (!uid) {
        try { uid = userId(); } catch { return provided; }
      }
      const extraKeys = await extraKeysFn(raw, uid, [persistDay], tz, null);
      const loaded = await loadFn({
        db, raw, userId: uid, fromDay: persistDay, toDay: persistDay, timeZone: tz, extraKeys,
      });
      if (!loaded.records.length) return { records: passed, integrity: loaded.integrity };
      if (!passed.length) return loaded;
      return { records: loaded.records.concat(passed), integrity: loaded.integrity };
    } catch {
      return provided;
    }
  }

  async function resolveImuRecordsForPersist(extras, persistDay, tz) {
    return resolveDerivedRecordsForPersist(extras, persistDay, tz, {
      passedKey: 'imuRecords',
      integrityKey: 'imuLoadIntegrity',
      extraKeysFn: extraImuKeys,
      loadFn: loadImuRecordsForWindow,
    });
  }

  async function resolvePpgRecordsForPersist(extras, persistDay, tz) {
    return resolveDerivedRecordsForPersist(extras, persistDay, tz, {
      passedKey: 'ppgRecords',
      integrityKey: 'ppgLoadIntegrity',
      extraKeysFn: extraPpgKeys,
      loadFn: loadPpgRecordsForWindow,
    });
  }

  async function resolveEventRecordsForPersist(extras, persistDay, tz) {
    return resolveDerivedRecordsForPersist(extras, persistDay, tz, {
      passedKey: 'events',
      integrityKey: 'eventLoadIntegrity',
      extraKeysFn: extraEventKeys,
      loadFn: loadEventRecordsForWindow,
    });
  }

  return {
    userId,

    async persistComputed({ samples, device, extras = {}, history = [] }) {
      const normalizedSamples = (samples || []).map((sample) => {
        const t = sample?.t || sample?.datetime || sample?.at;
        if (!t) return sample;
        return {
          ...sample,
          t: sample.t || t,
          datetime: sample.datetime || t,
        };
      });
      const decoderVersions = extras.decoderVersions?.length
        ? extras.decoderVersions
        : [...new Set(normalizedSamples.map((sample) => sample?.decoder).filter(Boolean))];
      const inputLayouts = extras.inputLayouts?.length
        ? extras.inputLayouts
        : [...new Set(normalizedSamples.map((sample) => sample?.layout).filter(Boolean))];
      // Built per call, not per engine: it memoizes one day's windows and must
      // not carry them into the next flush.
      const overnight = createOvernightProvider({ baselines: extras.baselines || null, now });
      const aggregateTz = extras.timeZone || 'UTC';
      const lastSample = normalizedSamples.at(-1);
      const persistDayGuess = extras.day || extras.periodDay || (lastSample
        ? localDateKey(lastSample.t || lastSample.datetime || lastSample.at, aggregateTz)
        : null);
      const imuEvidenceEarly = await resolveImuRecordsForPersist(extras, persistDayGuess, aggregateTz);
      const ppgEvidence = await resolvePpgRecordsForPersist(extras, persistDayGuess, aggregateTz);
      const eventEvidence = await resolveEventRecordsForPersist(extras, persistDayGuess, aggregateTz);
      const computeV3 = extras.shadowV3 !== false && shouldComputeSleepV3();
      const sleepV3Load = extras.sleepV3Artifact !== undefined
        ? { artifact: extras.sleepV3Artifact || null, ok: Boolean(extras.sleepV3Artifact), reason: extras.sleepV3Artifact ? null : 'artifact_missing' }
        : (computeV3 ? loadSleepV3Artifact() : { artifact: null, ok: false, reason: 'v3_off' });
      const scored = scoreDay({
        samples: normalizedSamples,
        history,
        extras: {
          ...extras,
          overnight,
          imuRecords: dedupeImuRecords(imuEvidenceEarly.records),
          imuLoadIntegrity: imuEvidenceEarly.integrity,
          ppgRecords: dedupePpgRecords(ppgEvidence.records),
          ppgLoadIntegrity: ppgEvidence.integrity,
          events: eventEvidence.records,
          eventLoadIntegrity: eventEvidence.integrity,
          sleepV3Artifact: sleepV3Load.artifact,
          shadowV3: computeV3,
          placement: extras.placement || extras.wearLocation || extras.device?.wear_location || 'unknown',
          deviceFamily: extras.deviceFamily || extras.device?.device_family || extras.device?.family || null,
          firmware: extras.firmware || extras.device?.firmware || extras.device?.fw || null,
        },
      });
      const overnightSummary = overnight.summary();
      const day = scored.day;

      // Core-health aggregates from the same flushed sample set the sleep scorer
      // used. They are idempotent (rewriting the same window rewrites the same
      // totals) and carry full provenance. Live HR/HRV/resp computation already
      // lives in scoreDay; steps + temperature + avg/max HR are computed here.
      // Sleep scoring uses a 12h lookback. Steps are calendar-day only — mixing
      // yesterday's last counter with today's first unwraps as a u16 wrap.
      const persistDay = extras.day || scored.day;
      const stepSamples = normalizedSamples.filter(
        (s) => localDateKey(s.t || s.datetime || s.at, aggregateTz) === persistDay,
      );
      const imuEvidence = persistDay && persistDay !== persistDayGuess
        ? await resolveImuRecordsForPersist(extras, persistDay, aggregateTz)
        : imuEvidenceEarly;
      const imuRecords = dedupeImuRecords(imuEvidence.records);
      const energyImu = selectImuForEnergyV3(imuRecords, { finalized: Boolean(extras.replay) });
      const carryIn = extras.carryInCounter != null
        ? extras.carryInCounter
        : carryInCounterForDay(normalizedSamples, persistDay, aggregateTz);
      const steps = accumulateSteps(stepSamples, {
        timeZone: aggregateTz,
        carryInCounter: carryIn,
      });
      let stepsV2 = null;
      if (stepsV2Mode() !== 'off') {
        try {
          const stepBounds = dayBounds(persistDay, aggregateTz);
          stepsV2 = computeStepsV2({
            imuRecords,
            samples: stepSamples,
            v1: steps,
            dayStartMs: Date.parse(stepBounds.day_start_at),
            dayEndMs: Date.parse(stepBounds.day_end_at),
            timeZone: aggregateTz,
          });
        } catch (err) {
          inc('steps_v2_compute_failures');
          console.error(`steps_v2_failed day=${persistDay}:`, err?.message || err);
          stepsV2 = null;
        }
      }
      let stepsV3 = null;
      try {
        const stepBounds = dayBounds(persistDay, aggregateTz);
        const loadedArtifact = stepsV3Artifact === undefined
          ? loadStepsV3Artifact()
          : (stepsV3Artifact
            ? { ok: true, artifact: stepsV3Artifact, reason: null }
            : { ok: false, artifact: null, reason: 'artifact_missing' });
        stepsV3 = computeStepsV3({
          imuRecords,
          samples: stepSamples,
          artifact: loadedArtifact.artifact,
          artifactError: loadedArtifact.reason,
          dayStartMs: Date.parse(stepBounds.day_start_at),
          dayEndMs: Date.parse(stepBounds.day_end_at),
          loadIntegrity: imuEvidence.integrity,
        });
      } catch (err) {
        // V3 is shadow-only. No artifact or inference failure may affect V1.
        inc('steps_v3_compute_failures');
        console.error(`steps_v3_failed day=${persistDay}:`, err?.message || err);
        stepsV3 = unavailableStepsV3('runtime_failure');
      }
      if (stepsV3?.unavailable_reason && String(stepsV3.unavailable_reason).startsWith('artifact')) {
        console.error(`steps_v3_artifact_failed day=${persistDay}: ${stepsV3.unavailable_reason}`);
      }
      // Hard invariant: daily_metrics.steps is always the V1 accumulator when present.
      // Fall back to V2/V3 IMU inference when the strap counter never arrived.
      const stepsResolved = (() => {
        if (steps?.status !== 'unavailable' && Number.isFinite(steps?.total)) {
          return { total: steps.total, source: steps, canonical: 'v1', steps_source: 'v1_counter' };
        }
        if (stepsV3 != null && Number.isFinite(stepsV3?.total) && stepsV3.total > 0 && stepsV3?.status !== 'unavailable') {
          return { total: stepsV3.total, source: stepsV3, canonical: 'v3', steps_source: 'v3_imu' };
        }
        if (stepsV2 != null && Number.isFinite(stepsV2?.total) && stepsV2.total > 0 && stepsV2?.status !== 'unavailable' && stepsV2?.fallback !== true) {
          return { total: stepsV2.total, source: stepsV2, canonical: 'v2', steps_source: 'v2_imu' };
        }
        return {
          total: null,
          source: steps,
          canonical: 'v1',
          steps_source: steps?.detail || stepsV3?.unavailable_reason || stepsV2?.fallback_reason || 'no_step_samples',
          unavailable: true,
        };
      })();
      const temp = summarizeTemperature(normalizedSamples, {
        timeZone: aggregateTz,
        baselineC: (extras.baselines && typeof extras.baselines.skinTempC === 'number')
          ? extras.baselines.skinTempC
          : null,
      });
      if (steps.total != null) noteConsumption('protocol_consumed_steps', 1);
      if (temp.sample_count) noteConsumption('protocol_consumed_temperature', 1);
      noteConsumption('protocol_consumed_sleep', 1);
      noteConsumption('protocol_consumed_imu_features', imuRecords.length);
      const spo2Samples = overlaySpo2OnSamples(normalizedSamples, extras.spo2Observations);
      const spo2Candidate = summarizeSpo2Candidate(spo2Samples, {
        day: persistDay,
        timeZone: aggregateTz,
        sleepSessions: scored.sleep?.sessions,
      });
      const spo2CandidateSeries = spo2Candidate.series || spo2CandidateSeriesFromSamples(spo2Samples);
      const hrValues = normalizedSamples
        .map((s) => (Number.isFinite(s.bpm) && s.bpm >= 20 && s.bpm <= 240 ? s.bpm : null))
        .filter((v) => v != null);
      const avgHr = hrValues.length
        ? Math.round(hrValues.reduce((a, b) => a + b, 0) / hrValues.length)
        : null;
      let maxHr = null;
      for (const v of hrValues) {
        if (maxHr == null || v > maxHr) maxHr = v;
      }

      // ------------------------------------------------------------------
      // Clock context is needed by both V2 pipelines (hr2 + strainV2 shadow):
      const tz = extras.timeZone || 'UTC';
      // HR V2 runs only when the registry marks it shadow. Product columns stay V1.
      let hr2 = null;
      const hrMode = hr2Mode();
      if (metricStatus('hr_v2') !== 'disabled') {
        try {
          const bounds = dayBounds(scored.day, tz);
          // Main overnight sleep window for the RHR candidates: the longest
          // non-nap session the sleep scorer produced, when one exists.
          const sessions = scored.sleep?.sessions || [];
          const main = sessions
            .filter((s) => s && s.isNap !== true && Number.isFinite(Number(s.start)) && Number.isFinite(Number(s.end)))
            .sort((a, b) => (Number(b.end) - Number(b.start)) - (Number(a.end) - Number(a.start)))[0] ?? null;
          hr2 = computeHr2Day(normalizedSamples, {
            day: scored.day,
            timeZone: tz,
            dayStartMs: Date.parse(bounds.day_start_at),
            dayEndMs: Date.parse(bounds.day_end_at),
            sleepWindow: mainSleepWindow(sessions),
          });
        } catch (err) {
          // A V2 failure must never break the V1 write path.
          inc('hr2_pipeline_failures');
          console.error(`hr2_pipeline_failed day=${scored.day}:`, err?.message || err);
          hr2 = null;
        }
      }

      // ------------------------------------------------------------------
      // Strain V2 shadow (FRWHOOP_STRAIN_V2=shadow). Additive by contract:
      // V1 strain_score/effort keys are never touched; V2 lands in
      // strain_score_v2/strain_v2 columns and the strain_series projection.
      // Layers: profile (HRmax/RHR/thresholds provenance) -> canonical 60 s
      // epochs -> cardio model (default per replay evidence) -> display.
      // ------------------------------------------------------------------
      let strainV2 = null;
      if (metricStatus('strain_v2') === 'shadow') {
        try {
          const v2Bounds = dayBounds(scored.day, tz);
          let v2Ctx = null;
          if (energyContext) {
            try { v2Ctx = await energyContext(extras.userId || userId()); } catch { v2Ctx = null; }
          }
          const dayStartMs = Date.parse(v2Bounds.day_start_at);
          const dayEndMs = Date.parse(v2Bounds.day_end_at);
          const dayWorkouts = (v2Ctx?.workouts || []).map((w) => ({
            id: w.id,
            name: w.sport,
            start: w.start,
            end: w.end,
          }));
          strainV2 = computeStrainV2({
            samples: normalizedSamples,
            profile: v2Ctx?.profile ?? {},
            prefs: v2Ctx?.prefs ?? {},
            days: v2Ctx?.days ?? [],
            currentDay: day,
            acuteRestingHr: Number.isFinite(Number(scored.restingHr)) ? Number(scored.restingHr) : null,
            activities: dayWorkouts,
            opts: { dayStartMs, dayEndMs },
          });
          inc('strain_v2_days_computed');
        } catch (err) {
          // A V2 failure must never break the V1 write path.
          inc('strain_v2_compute_failures');
          console.error(`strain_v2_failed day=${scored.day}:`, err?.message || err);
          strainV2 = null;
        }
      }

      const uid = extras.userId || userId();
      const deviceId = extras.deviceId || uuidFromParts([uid, 'whoop', String(device?.externalId || device?.id || 'strap')]);
      const objectId = uuidFromParts([uid, 'derived', 'sleep', day, ALGORITHM_VERSION]);
      const scoredNight = scored.sleep;
      try {
        const artifactFailures = inspectRequiredArtifacts();
        for (const failure of artifactFailures) {
          console.error(`metric_artifact_failed ${failure.id}: ${failure.reason} path=${failure.path || ''}`);
        }
      } catch (err) {
        if (err?.code === 'canonical_artifact_missing') throw err;
        throw err;
      }
      const persistSleep = isPersistableOvernight(scoredNight);
      const sleepState = sleepPersistState(scoredNight);
      const persistProvisional = sleepState === 'provisional';
      const night = persistSleep || persistProvisional ? scoredNight : null;
      const sleepSessions = persistSleep || persistProvisional
        ? (scoredNight?.sessions?.length ? scoredNight.sessions : (scoredNight ? [scoredNight] : []))
        : (scoredNight?.sessions || []).filter((session) => session.isNap);
      const derivedKey = derivedObjectKeyV2({ userId: uid, kind: 'sleep', day, objectId });
      const blob = jsonGzip({
        algorithm_version: ALGORITHM_VERSION,
        computed_at: scored.computedAt,
        day,
        sleep: night,
        daily: {
          recovery: persistSleep ? scored.recovery : null,
          strain: scored.strain,
          resting_hr: persistSleep ? scored.restingHr : null,
          hrv: persistSleep ? scored.hrv : null,
          resp: persistSleep ? scored.resp : null,
          strain_v2: strainV2 ? strainV2Provenance(strainV2) : null,
        },
        // The full envelopes, including the windows that were rejected and why.
        // They go in the blob rather than in Postgres because they are diagnostic
        // detail: the scalar and its confidence are what the app reads, and this
        // is what a reviewer needs to explain the scalar.
        overnight_physiology: overnightSummary,
        hypnogram: night?.hypnogram || [],
        sessions: sleepSessions,
        hr_spark: night?.hrSpark || [],
        input_provenance: {
          object_ids: extras.inputObjectIds || [],
          decoder_versions: decoderVersions,
          layouts: inputLayouts,
          gravity_coverage: night?.gravityCoverage || null,
          fallback_reason: night?.fallbackReason || null,
        },
      });
      const sha = createHash('sha256').update(blob).digest('hex');

      const { derived } = await resolveStores();
      if (derived) {
        try {
          await derived.putObject(derivedKey, blob, { contentType: 'application/gzip' });
        } catch (err) {
          // Product columns live in Postgres. A B2 blip must not drop the day.
          console.error(`derived_put_failed day=${day}: ${err?.cause?.code || err?.message || err}`);
        }
      }

      const bounds = dayBounds(day, tz);
      const dailyRow = {
        user_id: uid,
        day,
        source_device_id: deviceId,
        effort: scored.strain,
        ...(strainV2 != null ? { strain_v2: strainV2Provenance(strainV2) } : {}),
        avg_hr_bpm: avgHr,
        max_hr_bpm: maxHr,
        ...(temp.sample_count ? { skin_temp_c: temp.temperature_c, skin_temp_dev_c: temp.deviation_c } : {}),
        confidence: {
          steps: {
            confidence: steps.confidence,
            status: steps.status,
            coverage_seconds: steps.coverage_seconds,
            canonical: stepsResolved.canonical,
            ...(stepsV2 ? {
              v2: {
                total: stepsV2.total,
                status: stepsV2.status,
                source_mode: stepsV2.source_mode,
                fallback: stepsV2.fallback,
                imu_coverage: stepsV2.imu_coverage,
                imu_coverage_seconds: stepsV2.imu_coverage_seconds,
              },
            } : {}),
            v3: {
              total: stepsV3?.total ?? null,
              confidence: stepsV3?.confidence ?? 0,
              status: stepsV3?.status || 'unavailable',
              unavailable_reason: stepsV3?.unavailable_reason || null,
              coverage: stepsV3?.coverage || null,
            },
          },
          skin_temp: temp.sample_count ? { confidence: temp.confidence, status: temp.status, sample_count: temp.sample_count } : null,
          spo2_candidate: shouldPersistSpo2Candidate(spo2Candidate) ? {
            confidence: spo2Candidate.confidence,
            status: spo2Candidate.status,
            sample_count: spo2Candidate.sample_count,
            coverage: spo2Candidate.coverage,
            classification: spo2Candidate.classification,
          } : null,
          sleep: { persist_state: sleepState },
          ...(hr2 != null ? { hr_v2: {
            avg: { value: hr2.scalars.avg_hr.value, coverage_hours: hr2.scalars.avg_hr.coverage_hours, quality_mean: hr2.scalars.avg_hr.quality_mean, calibrated: false },
            peak_confirmed: hr2.scalars.peak.confirmed,
            resting: hr2.scalars.resting_hr ? { ...hr2.scalars.resting_hr, calibrated: false, heuristic: true } : null,
          } } : {}),
        },
        provenance: {
          source: persistSleep ? 'frwhoop-live' : (extras.replay ? 'frwhoop-replay' : 'frwhoop-live'),
          ...(persistSleep ? { store: cfg.derivedStore, object_key: derivedKey } : {}),
          steps: {
            source: steps.source,
            algorithm_version: steps.algorithm_version,
            input_mode: steps.input_mode,
            canonical: stepsResolved.canonical,
            used_carry_in: Boolean(steps.used_carry_in),
            ...(stepsV2 ? {
              v2: stepsV2Provenance(stepsV2),
              shadow: shadowCompare(steps, stepsV2),
            } : {}),
            v3: stepsV3Provenance(stepsV3),
          },
          skin_temp: temp.sample_count ? { source: temp.source, algorithm_version: temp.algorithm_version, window: temp.window } : null,
          spo2_candidate: shouldPersistSpo2Candidate(spo2Candidate) ? {
            source: spo2Candidate.source,
            algorithm_version: spo2Candidate.algorithm_version,
            firmware: spo2Candidate.firmware,
            decoder_version: spo2Candidate.decoder_version,
            source_device_id: (spo2Candidate.source_device_ids || [])[0] || null,
            source_device_ids: spo2Candidate.source_device_ids,
            physical_device_id: spo2Candidate.physical_device_id,
            physical_identity_confidence: spo2Candidate.physical_identity_confidence || 'unknown',
            physical_identity_evidence: spo2Candidate.physical_identity_evidence || null,
          } : null,
          battery_timeline: foldBatteryTimeline(
            eventEvidence.records,
            extras.cmdBattery || extras.cmd_battery || [],
          ),
          ...(hr2 != null ? { hr_v2: {
            mode: hrMode === 'v2' ? 'dual' : hrMode,
            algorithm_version: HR2_VERSION,
            inputs: hr2.input,
            suppressed_count: hr2.suppressed.length,
          } } : {}),
        },
        algorithm_version: ALGORITHM_VERSION,
        computed_at: scored.computedAt,
        timezone_name: tz,
        day_start_at: bounds.day_start_at,
        day_end_at: bounds.day_end_at,
        timezone_offset_seconds: bounds.timezone_offset_seconds,
        record_class: 'user',
        ...(persistSleep ? {
          recovery_score: scored.recovery,
          sleep_performance_pct: night.performance,
          charge: scored.recovery,
          rest: night.performance,
          resp_rate_bpm: scored.resp,
          sleep_total_min: night.asleepMin,
          sleep_in_bed_min: night.inBedMin,
          sleep_awake_min: night.awakeMin,
          sleep_light_min: night.lightMin,
          sleep_deep_min: night.deepMin,
          sleep_rem_min: night.remMin,
          sleep_efficiency: night.efficiency,
          sleep_need_min: night.needMin,
          sleep_debt_balance_min: night.debtMin,
          sleep_consistency: night.consistency,
          sleep_onset_at: night.onsetIso,
          wake_onset_at: night.wakeIso,
          overnight_hr_bpm: night.overnightHr,
          disturbances: night.disturbances,
          chart_data: { hr_spark: night.hrSpark, hypnogram: night.hypnogram },
        } : {
          // HR-only nights are not persistable sleep, but the recovery scalar
          // is still measured. Dropping it left Overview blank after a scored night.
          ...(Number.isFinite(Number(scored.recovery)) ? {
            recovery_score: scored.recovery,
            charge: scored.recovery,
          } : {}),
          ...(Number.isFinite(Number(scored.resp)) ? { resp_rate_bpm: scored.resp } : {}),
        }),
      };

      const orderedSleep = [...sleepSessions].sort((a, b) => a.start - b.start);
      let napOrdinal = 0;
      const persistedSleep = orderedSleep.map((session) => {
        const isNap = Boolean(session.isNap);
        const slot = isNap ? `nap:${napOrdinal++}` : 'main';
        const externalId = `sleep:${deviceId}:${day}:${slot}`;
        const id = uuidFromParts([uid, 'frwhoop', externalId]);
        return {
          session,
          id,
          externalId,
          sleepRow: {
            id,
            user_id: uid,
            device_id: deviceId,
            period_day: day,
            start_at: session.onsetIso,
            end_at: session.wakeIso,
            is_nap: isNap,
            in_bed_min: session.inBedMin,
            asleep_min: session.asleepMin,
            awake_min: session.awakeMin,
            light_min: session.lightMin,
            deep_min: session.deepMin,
            rem_min: session.remMin,
            efficiency: session.efficiency,
            performance_pct: session.performance,
            need_min: session.needMin,
            debt_min: session.debtMin,
            consistency_pct: session.consistency,
            overnight_hr_bpm: session.overnightHr,
            resting_hr_bpm: session.restingHr,
            disturbances: session.disturbances,
            recovery_pct: session.recovery,
            stages: session.stages,
            hypnogram: session.hypnogram,
            derived_object_key: derivedKey,
            algorithm_version: ALGORITHM_VERSION,
            computed_at: scored.computedAt,
          },
          sessionRow: {
            id,
            user_id: uid,
            device_id: deviceId,
            kind: isNap ? 'nap' : 'sleep',
            source: 'frwhoop',
            external_id: externalId,
            start_at: session.onsetIso,
            end_at: session.wakeIso,
            user_modified: false,
            summary: {
              efficiency: session.efficiency,
              performance: session.performance,
              asleep_min: session.asleepMin,
              in_bed_min: session.inBedMin,
              need_min: session.needMin,
              is_nap: isNap,
              detected_start_at: session.onsetIso,
              detected_end_at: session.wakeIso,
              confidence: session.confidence,
              fallback_reason: session.fallbackReason,
              detector: session.detector,
              persist_state: isNap ? 'nap' : sleepState,
            },
            segments: session.hypnogram,
            algorithm_version: ALGORITHM_VERSION,
          },
          sleepDetails: {
            session_id: id,
            user_id: uid,
            is_nap: isNap,
            in_bed_min: session.inBedMin,
            asleep_min: session.asleepMin,
            awake_min: session.awakeMin,
            light_min: session.lightMin,
            deep_min: session.deepMin,
            rem_min: session.remMin,
            efficiency: session.efficiency,
            performance_pct: session.performance,
            need_min: session.needMin,
            debt_min: session.debtMin,
            consistency_pct: session.consistency,
            overnight_hr_bpm: session.overnightHr,
            resting_hr_bpm: session.restingHr,
            disturbances: session.disturbances,
            recovery_pct: session.recovery,
            original_start_at: session.onsetIso,
            original_end_at: session.wakeIso,
            hypnogram: session.hypnogram,
            stages: session.stages,
            epoch_probabilities: session.epochProbabilities || null,
            epoch_coverage: session.epochCoverage || null,
            scorability: session.scorability || null,
            detector_version: session.provenance?.detectionVersion || null,
            stager_version: session.provenance?.stagingVersion || null,
            shadow_v3: session.shadowV3 ? {
              mode: sleepV3Mode(),
              path: session.shadowV3.path,
              fallback: session.shadowV3.fallback,
              fallback_reason: session.shadowV3.fallback_reason,
              v3_not_executed_reason: session.shadowV3.v3_not_executed_reason || session.shadowV3.fallback_reason || null,
              stager_version: session.shadowV3.provenance?.stager_version || null,
              feature_schema_version: session.shadowV3.provenance?.feature_schema_version || null,
              preprocessing_sha256: session.shadowV3.provenance?.preprocessing_sha256 || null,
              calibration_version: session.shadowV3.provenance?.calibration_version || null,
              calibration_status: session.shadowV3.provenance?.calibration_status || 'uncalibrated',
              modality_coverage: session.shadowV3.provenance?.modality_coverage || null,
              modality_tier: session.shadowV3.provenance?.modality_tier || null,
              domain: session.shadowV3.provenance?.domain || null,
              vs_v2: session.shadowV3.vsV2 || null,
              stages: session.shadowV3.stages || null,
              epoch_probabilities: session.shadowV3.epochProbabilities || null,
              unscored_sec: session.shadowV3.unscored_sec || 0,
              telemetry: session.shadowV3.telemetry || null,
            } : (computeV3 ? null : { mode: 'off', v3_not_executed_reason: 'v3_off' }),
            derived_object_id: objectId,
            algorithm_version: ALGORITHM_VERSION,
            computed_at: scored.computedAt,
          },
        };
      });
      const sleepRows = persistedSleep.map((row) => row.sleepRow);
      const sessionRows = persistedSleep.map((row) => row.sessionRow);
      const sleepDetails = persistedSleep.map((row) => row.sleepDetails);
      const sleepRow = sleepState === 'complete'
        ? (sleepRows.find((row) => !row.is_nap) || null)
        : null;

      const derivedManifest = {
        id: objectId,
        user_id: uid,
        object_class: 'derived',
        object_kind: 'sleep_summary',
        provider: cfg.derivedStore,
        object_key: derivedKey,
        bucket: cfg.b2Bucket,
        period_day: day,
        compressed_bytes: blob.length,
        content_type: 'application/gzip',
        format: 'json_gzip_v1',
        compression: 'gzip',
        schema_version: ARCHIVE_SCHEMA_VERSION,
        sha256: sha,
        status: 'ready',
        algorithm_version: ALGORITHM_VERSION,
        uploaded_at: scored.computedAt,
        verified_at: scored.computedAt,
      };

      const seriesRow = seriesFromSamples(normalizedSamples, { userId: uid, day, timeZone: tz });
      seriesRow.strain_series = strainSeriesFromHr(
        normalizedSamples.filter((s) => localDateKey(s.t || s.datetime || s.at, tz) === day),
        persistSleep ? scored.restingHr : 55,
      );

      // Energy runs on the same flushed sample set the sleep scorer just used, so
      // it inherits the existing idempotency: reprocessing the same window
      // rewrites the same primary keys instead of accumulating.
      let energy = null;
      if (energyContext) {
        try {
          const ctx = await energyContext(uid);
          const energyArgs = {
            samples: normalizedSamples,
            userId: uid,
            timeZone: tz,
            profile: ctx?.profile,
            prefs: ctx?.prefs,
            days: ctx?.days,
            workouts: ctx?.workouts,
            calibration: ctx?.calibration,
            imuRecords: energyImu.records,
            wearLocationEvents: ctx?.prefs?.wearLocationEvents || ctx?.wearLocationEvents || [],
            imuEvidence: energyImu.evidence,
          };
          const v2Mode = energyV2ComputeMode();
          const v3Mode = energyV3ComputeMode();
          const v21Ready = hasCompleteV21Imu(energyImu.records);
          energy = v2Mode === 'shadow'
            ? computeEnergyV2({ ...energyArgs, mode: 'shadow' })
            : computeEnergy(energyArgs);
          if (v2Mode === 'shadow' && energy && !energy.shadow) {
            energy.v2_blocker = { status: 'artifact_missing', reason: 'artifact_missing' };
          }
          if (v3Mode === 'shadow') {
            if (v21Ready) {
              const v3 = computeEnergyV3({ ...energyArgs, mode: 'shadow' });
              energy.v3_shadow = v3.shadow || null;
            } else {
              energy.v3_blocker = {
                status: 'input_missing',
                reason: 'v21_frames_incomplete',
                complete_v21_frames: 0,
              };
            }
          }
          inc('energy_minutes_computed', energy.minutes.length);
          if (energy.stats.skipped) inc('energy_minutes_unestimable', energy.stats.skipped);
        } catch (err) {
          // Energy is additive: a failure here must not cost us the sleep score.
          inc('energy_compute_failures');
          energy = null;
        }
      }

      const dayEnergy = energy?.daily?.find((row) => row.day === day) || energy?.daily?.[0] || null;
      let stepsV3DecisionManifest = null;
      let stepsV3DecisionArchiveError = null;
      if (stepsV3 && stepsV3.status !== 'unavailable'
          && (stepsV3.events?.length || stepsV3.candidate_events?.length
            || stepsV3.gait_windows?.length)) {
        try {
          const { raw } = await resolveStores();
          if (!raw) throw new Error('raw_object_store_unavailable');
          const stepBounds = dayBounds(persistDay, aggregateTz);
          const decisionRecord = {
            schema: 'frwhoop_steps_v3_decisions_v1',
            day: persistDay,
            algorithm_version: stepsV3.algorithm_version,
            artifact_version: stepsV3.artifact_version,
            artifact_sha256: stepsV3.artifact_sha256,
            events: stepsV3.events || [],
            gait_windows: stepsV3.gait_windows || [],
            candidate_events: stepsV3.candidate_events || [],
            rejected_candidates: stepsV3.rejected_candidates || [],
            accepted_gait_intervals: stepsV3.accepted_gait_intervals || [],
            coverage: stepsV3.coverage,
            clock: stepsV3.clock,
            manifest_sha256: stepsV3.manifest_sha256,
            received_at: stepBounds.day_end_at,
          };
          decisionRecord.envelope = {
            frame_hash: createHash('sha256')
              .update(JSON.stringify(decisionRecord))
              .digest('hex'),
          };
          stepsV3DecisionManifest = await this.archiveDerivedStream({
            records: [decisionRecord],
            stream: 'steps_v3_decisions',
            format: 'ndjson_gzip_steps_v3_decisions_v1',
            schemaVersion: 1,
            device,
            startAt: stepBounds.day_start_at,
            endAt: stepBounds.day_end_at,
            extras: {
              userId: uid,
              timeZone: tz,
              periodDay: persistDay,
            },
          });
        } catch (error) {
          inc('steps_v3_decision_archive_failures');
          stepsV3DecisionArchiveError = String(error?.message || error).slice(0, 200);
        }
      }
      const stepsV3Extras = {
        ...stepsV3,
        event_count: stepsV3?.events?.length || 0,
        gait_window_count: stepsV3?.gait_windows?.length || 0,
        candidate_event_count: stepsV3?.candidate_events?.length || 0,
        rejected_candidate_count: stepsV3?.rejected_candidates?.length || 0,
        decision_artifact: stepsV3DecisionManifest ? {
          id: stepsV3DecisionManifest.id,
          object_key: stepsV3DecisionManifest.object_key,
          sha256: stepsV3DecisionManifest.sha256,
          status: stepsV3DecisionManifest.status,
          schema: 'frwhoop_steps_v3_decisions_v1',
        } : null,
        decision_archive_error: stepsV3DecisionArchiveError,
      };
      // Exact decisions are persisted in the hash-addressed decision artifact;
      // daily JSON keeps the compact buckets, counts, and artifact reference.
      delete stepsV3Extras.events;
      delete stepsV3Extras.gait_windows;
      delete stepsV3Extras.candidate_events;
      delete stepsV3Extras.rejected_candidates;
      dailyRow.extras = {
        ...(dailyRow.extras || {}),
        steps_v1: {
          algorithm_version: steps.algorithm_version,
        status: steps.status,
        detail: steps.detail || null,
        confidence: steps.confidence,
        coverage_seconds: steps.coverage_seconds || 0,
        input_mode: steps.input_mode || null,
          event_buckets_60s: steps.buckets_60s || [],
          bucket_mode: 'counter_delta',
        },
        steps_source: stepsResolved.steps_source,
        steps_v3: stepsV3Extras,
        sleep_state: sleepState,
        latest_sensor_at: (() => {
          let latest = 0;
          for (const sample of normalizedSamples) {
            const t = Date.parse(sample?.t || sample?.datetime || sample?.at || '');
            if (Number.isFinite(t) && t > latest) latest = t;
          }
          return latest ? new Date(latest).toISOString() : null;
        })(),
        ...(strainV2 ? { strain_v2_series: strainV2.strainSeries || [] } : {}),
        ...(seriesRow?.skin_temp_series?.length ? { skin_temp_series: seriesRow.skin_temp_series } : {}),
        ...(shouldPersistSpo2Candidate(spo2Candidate)
          ? extrasFromSpo2Summary(spo2Candidate, spo2CandidateSeries)
          : {}),
        ...(overnightSummary?.respiration ? { respiration: overnightSummary.respiration } : {}),
      };
      if (stepsV2) {
        dailyRow.extras = {
          ...(dailyRow.extras || {}),
          steps_v2: {
            ...stepsV2Provenance(stepsV2),
            event_buckets_60s: stepsV2.buckets_60s || [],
          },
          steps_shadow: shadowCompare(steps, stepsV2),
        };
      }
      if (hr2) {
        dailyRow.extras = {
          ...(dailyRow.extras || {}),
          hr_v2: {
            algorithm_version: HR2_VERSION,
            mode: hrMode === 'v2' ? 'dual' : hrMode,
            avg_hr: hr2.scalars.avg_hr.value,
            coverage_hours: hr2.scalars.avg_hr.coverage_hours,
            peak_confirmed: hr2.scalars.peak.confirmed?.value ?? null,
            resting_hr: hr2.scalars.resting_hr?.value ?? null,
            quality_mean: hr2.scalars.avg_hr.quality_mean,
            input: hr2.input,
          },
        };
      }
      const wrist = foldWristState(eventEvidence.records);
      const timeline = dailyRow.provenance?.battery_timeline || [];
      const lastBatt = timeline.length ? timeline[timeline.length - 1] : null;
      dailyRow.extras = {
        ...(dailyRow.extras || {}),
        device_state: {
          charging: lastBatt?.charging ?? null,
          battery_pct: lastBatt?.pct ?? null,
          on_wrist: wrist.on_wrist,
          wrist_at: wrist.at,
        },
      };
      if (dayEnergy && (dayEnergy.active_kcal != null || dayEnergy.resting_kcal != null)) {
        dailyRow.extras = {
          ...(dailyRow.extras || {}),
          energy_elapsed_kcal: dayEnergy.elapsed_total_kcal,
          energy_projected_kcal: dayEnergy.projected_total_kcal,
          ...(energy?.shadow ? { energy_v2: energy.shadow } : {}),
          ...(energy?.v2_blocker ? { energy_v2_blocker: energy.v2_blocker } : {}),
          ...(energy?.v3_shadow ? { energy_v3_shadow: energy.v3_shadow } : {}),
          ...(energy?.v3_blocker ? { energy_v3_blocker: energy.v3_blocker } : {}),
        };
      } else if (energy?.v2_blocker || energy?.v3_blocker || energy?.shadow) {
        dailyRow.extras = {
          ...(dailyRow.extras || {}),
          ...(energy?.shadow ? { energy_v2: energy.shadow } : {}),
          ...(energy?.v2_blocker ? { energy_v2_blocker: energy.v2_blocker } : {}),
          ...(energy?.v3_shadow ? { energy_v3_shadow: energy.v3_shadow } : {}),
          ...(energy?.v3_blocker ? { energy_v3_blocker: energy.v3_blocker } : {}),
        };
      }
      Object.assign(dailyRow, applyDailyMetricsPersist({}, {
        strain: scored.strain,
        ...(stepsResolved.total != null && !stepsResolved.unavailable ? { steps: stepsResolved.total } : {}),
        ...(Number.isFinite(Number(scored.restingHr)) ? { rhr: scored.restingHr } : {}),
        ...(Number.isFinite(Number(scored.hrv)) ? { hrv: scored.hrv } : {}),
        ...(strainV2 != null ? { strain_v2: strainV2.strain } : {}),
        ...(dayEnergy && (dayEnergy.active_kcal != null || dayEnergy.resting_kcal != null)
          ? { energy: { active_kcal: dayEnergy.active_kcal, basal_kcal: dayEnergy.resting_kcal } }
          : {}),
      }));
      if (stepsResolved.total != null && !stepsResolved.unavailable) {
        dailyRow.steps = stepsResolved.total;
      }
      dailyRow.extras = {
        ...(dailyRow.extras || {}),
        shadows: buildShadowReadModel({
          metrics: dailyRow,
          extras: dailyRow.extras,
          confidence: dailyRow.confidence,
          provenance: dailyRow.provenance,
          sleep: sleepDetails,
        }),
      };

      if (db) {
        const replaceSleep = sleepState === 'complete';
        const artifactFailures = inspectRequiredArtifacts();
        const artifactRuns = artifactFailures.map((failure) => ({
          id: uuidFromParts([uid, 'metric-run', failure.id, day, 'artifact']),
          user_id: uid,
          period_day: day,
          algorithm: failure.id,
          version: metricStatus(failure.id),
          status: 'failed',
          error: `${failure.reason}:${failure.path || ''}`,
          input_refs: { reason: failure.reason, path: failure.path || null },
          output_refs: { canonical: false },
        }));
        await db.upsertPayload({
          ...energyPayload(energy),
          user_id: uid,
          device: {
            id: deviceId,
            source_kind: 'whoop',
            external_device_id: String(device?.externalId || device?.id || 'strap'),
            device_family: device?.name || 'WHOOP',
            firmware: device?.firmware || null,
          },
          daily_metrics: [dailyRow],
          ...(sleepDetails.length ? { sleep_details: sleepDetails } : {}),
          ...(replaceSleep ? {} : { sleep_replace_days: [] }),
          sessions: sessionRows,
          object_manifests: [derivedManifest],
          daily_physiology_series: [seriesRow],
          metric_runs: [{
            id: uuidFromParts([uid, 'metric-run', 'sleep-noop-v2', day, ALGORITHM_VERSION]),
            user_id: uid,
            period_day: day,
            algorithm: 'sleep_noop_v2',
            algorithm_name: 'sleep_noop_v2',
            version: ALGORITHM_VERSION,
            code_build_hash: cfg.buildHash || 'dev',
            config_hash: createHash('sha256').update(JSON.stringify({
              algorithm: ALGORITHM_VERSION,
              extras: { timeZone: tz },
            })).digest('hex').slice(0, 16),
            device_id: deviceId,
            status: persistSleep ? 'complete' : 'partial',
            input_refs: {
              sample_count: samples?.length || 0,
              object_ids: extras.inputObjectIds || [],
              decoder_versions: decoderVersions,
              layouts: inputLayouts,
              gravity_coverage: scoredNight?.gravityCoverage || null,
              fallback_reason: scoredNight?.fallbackReason || null,
            },
            input_start_at: normalizedSamples[0]?.datetime || null,
            input_end_at: normalizedSamples.at(-1)?.datetime || null,
            input_schema_versions: { archive: ARCHIVE_SCHEMA_VERSION, algorithm: ALGORITHM_VERSION },
            output_refs: {
              derived_object_key: derivedKey,
              sleep: Boolean(sleepRow),
              session_ids: sessionRows.map((row) => row.id),
              session_count: sessionRows.length,
              nap_count: sessionRows.filter((row) => row.kind === 'nap').length,
              manifest_id: objectId,
              stale_cleanup: replaceSleep ? 'rpc' : 'unsupported',
              energy_minutes: energy?.rows?.length || 0,
              energy_model_version: energy ? MODEL_VERSION : null,
              hrv: overnightSummary?.hrv
                ? {
                  value: overnightSummary.hrv.value,
                  confidence: overnightSummary.hrv.confidence,
                  status: overnightSummary.hrv.status,
                  version: overnightSummary.hrv.algorithm_version,
                }
                : null,
              respiration: overnightSummary?.respiration
                ? {
                  value: overnightSummary.respiration.value,
                  confidence: overnightSummary.respiration.confidence,
                  status: overnightSummary.respiration.status,
                  version: overnightSummary.respiration.algorithm_version,
                }
                : null,
              // A value measured but withheld from recovery for low confidence is
              // recorded here: without it, a night where HRV was measured and
              // ignored is indistinguishable from one where it was never measured.
              withheld_from_recovery: overnightSummary?.withheld || null,
              steps: steps?.total != null ? {
                total: stepsResolved.total,
                confidence: steps.confidence,
                status: steps.status,
                algorithm_version: steps.algorithm_version,
                input_mode: steps.input_mode,
                canonical: stepsResolved.canonical,
                event_buckets_60s: steps.buckets_60s || [],
                v2: stepsV2 ? {
                  ...stepsV2Provenance(stepsV2),
                  event_buckets_60s: stepsV2.buckets_60s || [],
                } : null,
                v3: stepsV3 ? {
                  total: stepsV3.total,
                  status: stepsV3.status,
                  confidence: stepsV3.confidence,
                  artifact_version: stepsV3.artifact_version,
                  artifact_sha256: stepsV3.artifact_sha256,
                  coverage: stepsV3.coverage,
                  event_buckets_60s: stepsV3.buckets_60s,
                  unavailable_reason: stepsV3.unavailable_reason,
                } : null,
              } : null,
              skin_temp: temp?.sample_count ? {
                temperature_c: temp.temperature_c,
                deviation_c: temp.deviation_c,
                confidence: temp.confidence,
                status: temp.status,
                algorithm_version: temp.algorithm_version,
              } : null,
              spo2_candidate: shouldPersistSpo2Candidate(spo2Candidate) ? {
                spo2_candidate_pct: spo2Candidate.spo2_candidate_pct,
                sample_count: spo2Candidate.sample_count,
                coverage: spo2Candidate.coverage,
                status: spo2Candidate.status,
                classification: spo2Candidate.classification,
                spo2_pct: null,
              } : null,
              avg_hr_bpm: avgHr,
              max_hr_bpm: maxHr,
              ...(hr2 != null ? { hr_v2: {
                algorithm_version: HR2_VERSION,
                mode: hrMode,
                avg: hr2.scalars.avg_hr.value,
                peak_raw: hr2.scalars.peak.raw_max,
                peak_confirmed: hr2.scalars.peak.confirmed ? hr2.scalars.peak.confirmed.value : null,
                resting_promoted: hr2.scalars.resting_hr ? hr2.scalars.resting_hr.value : null,
              } } : {}),
            },
            started_at: scored.computedAt,
            finished_at: scored.computedAt,
          }, {
          id: uuidFromParts([uid, 'metric-run', 'strain-v2', day, 'frwhoop-strain-v2.0.0-shadow']),
          user_id: uid,
          period_day: day,
          algorithm: 'strain_v2',
          algorithm_name: 'strain_v2',
          version: strainV2 ? 'frwhoop-strain-v2.0.0-shadow' : 'skipped',
          code_build_hash: cfg.buildHash || 'dev',
          config_hash: createHash('sha256').update(JSON.stringify({
            algorithm: 'strain_v2',
            mode: strainV2Mode(),
          })).digest('hex').slice(0, 16),
          device_id: deviceId,
          status: strainV2 != null ? 'complete' : 'partial',
          input_refs: {
            sample_count: samples?.length || 0,
          },
          output_refs: strainV2 != null ? {
            quality_state: strainV2.qualityState,
            au: strainV2.au,
            coverage_pct: strainV2.coveragePct,
          } : {},
        }, {
          id: uuidFromParts([
            uid,
            'metric-run',
            'steps-v3',
            day,
            stepsV3?.artifact_version || 'unavailable',
          ]),
          user_id: uid,
          period_day: day,
          algorithm: 'steps_v3',
          algorithm_name: 'steps_v3',
          version: stepsV3?.algorithm_version || 'unavailable',
          code_build_hash: cfg.buildHash || 'dev',
          config_hash: createHash('sha256').update(JSON.stringify({
            algorithm: stepsV3?.algorithm_version,
            artifact_sha256: stepsV3?.artifact_sha256,
          })).digest('hex').slice(0, 16),
          device_id: deviceId,
          status: stepsV3?.status === 'ok'
            ? 'complete'
            : (String(stepsV3?.unavailable_reason || '').startsWith('artifact') ? 'failed' : 'partial'),
          input_refs: {
            imu_records: imuRecords.length,
            sample_count: stepSamples.length,
            manifest_sha256: stepsV3?.manifest_sha256 || [],
            clock: stepsV3?.clock || null,
          },
          output_refs: {
            total: stepsV3?.total ?? null,
            canonical: false,
            status: stepsV3?.status || 'unavailable',
            confidence: stepsV3?.confidence ?? 0,
            artifact_version: stepsV3?.artifact_version || null,
            artifact_sha256: stepsV3?.artifact_sha256 || null,
            coverage: stepsV3?.coverage || null,
            event_buckets_60s: stepsV3?.buckets_60s || [],
            unavailable_reason: stepsV3?.unavailable_reason || null,
          },
          error: String(stepsV3?.unavailable_reason || '').startsWith('artifact')
            ? stepsV3.unavailable_reason
            : null,
        }, ...artifactRuns.filter((row) => row.algorithm !== 'steps_v3')]
        });
      }

      return {
        scored,
        dailyRow,
        sleepRow,
        sleepRows,
        sessionRows,
        sleepDetails,
        derivedKey,
        energy,
        overnight: overnightSummary,
        stepsV2,
        stepsV3,
      };
    },

    async archiveRawSamples({ samples, device, day, startAt, endAt, extras = {} }) {
      if (!samples?.length) return null;
      const uid = extras.userId || userId();
      const deviceId = uuidFromParts([uid, 'whoop', String(device?.externalId || device?.deviceId || device?.id || 'strap')]);
      // Deterministic object id from the archived content: retrying the same
      // batch (crash between B2 put and WAL removal, or an unclean replay)
      // yields the SAME key and manifest row instead of a duplicate object.
      // The id hashes each row's RAW STRAP timestamp (pre clock-correction) and
      // values, then sorts the per-row hashes: the id is stable across clock
      // drift between append and re-send and across row order, so a re-flush of
      // the same rows cannot mint a second object.
      const rowHashes = samples.map((s) => createHash('sha256').update(JSON.stringify([
        s.t_strap || s.t || s.datetime || s.at || '',
        s.seq ?? null,
        s.bpm ?? null,
        Array.isArray(s.rr_ms) ? s.rr_ms : s.rr_ms ?? null,
        s.device_id ?? null,
        s.gx ?? null, s.gy ?? null, s.gz ?? null, s.dyn_accel ?? null,
        s.steps ?? null, s.step_cumulative ?? null, s.step_cadence ?? null,
        s.activity_class ?? null, s.skin_temp_c ?? null, s.q ?? null, s.src ?? null,
        s.spo2_raw_byte ?? null, s.spo2_candidate_pct ?? null, s.spo2_state ?? null, s.source_frame_hash ?? null,
      ])).digest('hex')).sort();
      const contentId = createHash('sha256').update(rowHashes.join('') + '|' + (device?.externalId || device?.deviceId || 'strap')).digest('hex');
      const objectId = uuidFromParts([extras.userId || userId(), 'raw', String(device?.externalId || device?.deviceId || 'strap'), contentId]);
      const start = startAt || samples[0]?.datetime || now().toISOString();
      const end = endAt || samples[samples.length - 1]?.datetime || now().toISOString();
      const periodDay = extras.periodDay
        || physiologicalDay({ nowIso: end, timeZone: extras.timeZone || 'UTC' });
      const encoded = encodeArchive(samples);
      const stream = 'physiology';
      const key = rawObjectKeyV3({
        userId: uid,
        deviceId,
        stream,
        startAt: start,
        objectId,
      });
      const { raw } = await resolveStores();
      let etag = null;
      if (raw) {
        const put = await raw.putObject(key, encoded.body, { contentType: encoded.content_type });
        etag = put?.etag || null;
        const head = await raw.head(key);
        if (!head?.exists) {
          inc('object_verification_failures');
          throw new Error('b2_object_missing_after_put');
        }
        if (head.contentLength != null && Number(head.contentLength) !== encoded.compressed_bytes) {
          inc('object_verification_failures');
          throw new Error('b2_size_mismatch');
        }
        // Content verification: HEAD+size alone accepts a same-length corrupt
        // or partial write. Re-read the object and require the sha256 to match
        // the exact bytes that were PUT before the manifest may be 'ready'.
        const stored = await raw.getObject(key);
        if (!stored?.body) {
          inc('object_verification_failures');
          throw new Error('b2_object_unreadable_after_put');
        }
        if (sha256Hex(Buffer.from(stored.body)) !== encoded.sha256) {
          inc('object_verification_failures');
          throw new Error('b2_sha256_mismatch');
        }
      }
      // Observability: a raw B2 object was durably written (bypassed the phone).
      inc('b2_objects_created');
      inc('raw_samples_uploaded', encoded.sample_count || samples.length);
      const exp = expiresAt(stream, now(), cfg);
      const row = {
        id: objectId,
        user_id: uid,
        device_id: deviceId,
        object_class: 'raw',
        object_kind: stream,
        provider: cfg.rawStore,
        object_key: key,
        bucket: cfg.b2Bucket,
        start_at: start,
        end_at: end,
        period_day: periodDay,
        sample_count: encoded.sample_count,
        compressed_bytes: encoded.compressed_bytes,
        content_type: encoded.content_type,
        format: encoded.format,
        compression: encoded.compression,
        schema_version: encoded.schema_version,
        sha256: encoded.sha256,
        etag,
        retention_class: 'core',
        expires_at: exp,
        status: raw ? 'ready' : 'pending',
        uploaded_at: raw ? now().toISOString() : null,
        verified_at: raw ? now().toISOString() : null,
      };
      if (db) {
        await db.upsertPayload({
          user_id: uid,
          device: {
            id: deviceId,
            source_kind: 'whoop',
            external_device_id: String(device?.externalId || device?.deviceId || device?.id || 'strap'),
            device_family: device?.name || 'WHOOP',
            firmware: device?.firmware || null,
          },
          object_manifests: [row],
          live_windows: [{
            user_id: uid,
            device_id: deviceId,
            period_day: periodDay,
            start_at: row.start_at,
            end_at: row.end_at,
            sample_count: row.sample_count,
            raw_object_id: objectId,
            status: row.status,
          }],
          daily_physiology_series: seriesRowsFromSamples(samples, {
            userId: uid,
            timeZone: extras.timeZone || 'UTC',
          }),
          ingest_gaps: (extras.ingestGaps || []).map((g) => ({
            ...g,
            // Deterministic id per gap window: a re-flushed batch (crash
            // between B2 put and WAL trim) must not mint a second gap row.
            id: g.id || uuidFromParts([uid, 'gap', String(g.kind || 'missing_interval'), String(g.start_at || ''), String(g.end_at || '')]),
            user_id: uid,
            device_id: deviceId,
          })),
        });
      }
      return row;
    },

    async archiveRawFrames({ frames, device, day, startAt, endAt, extras = {} }) {
      if (!frames?.length) return null;
      const encoded = encodeFrameArchive(frames);
      if (!encoded.sample_count) return null;
      const uid = extras.userId || userId();
      const deviceId = uuidFromParts([uid, 'whoop', String(device?.externalId || device?.deviceId || device?.id || 'strap')]);
      // Deterministic object id, matching the samples path: per-frame hashes
      // over the raw frame bytes, sorted, so the id is order-stable.
      const frameHashes = frames.map((f) => createHash('sha256').update(JSON.stringify([
        f.t || f.datetime || '', f.seq ?? null, f.hex ?? null, f.char ?? null,
      ])).digest('hex')).sort();
      const contentId = createHash('sha256').update(frameHashes.join('') + '|' + (device?.externalId || device?.deviceId || 'strap')).digest('hex');
      const objectId = uuidFromParts([uid, 'rawframes', String(device?.externalId || device?.deviceId || 'strap'), contentId]);
      const start = startAt || frames[0]?.t || frames[0]?.datetime || now().toISOString();
      const end = endAt || frames[frames.length - 1]?.t || frames[frames.length - 1]?.datetime || now().toISOString();
      const periodDay = extras.periodDay
        || physiologicalDay({ nowIso: end, timeZone: extras.timeZone || 'UTC' });
      const stream = 'frames';
      const key = rawObjectKeyV3({
        userId: uid,
        deviceId,
        stream,
        startAt: start,
        objectId,
      });
      const { raw } = await resolveStores();
      let etag = null;
      if (raw) {
        const put = await raw.putObject(key, encoded.body, { contentType: encoded.content_type });
        etag = put?.etag || null;
        const head = await raw.head(key);
        if (!head?.exists) {
          inc('object_verification_failures');
          throw new Error('b2_object_missing_after_put');
        }
        if (head.contentLength != null && Number(head.contentLength) !== encoded.compressed_bytes) {
          inc('object_verification_failures');
          throw new Error('b2_size_mismatch');
        }
        // Content verification: HEAD+size alone accepts a same-length corrupt
        // or partial write. Re-read the object and require the sha256 to match
        // the exact bytes that were PUT before the manifest may be 'ready'.
        const stored = await raw.getObject(key);
        if (!stored?.body) {
          inc('object_verification_failures');
          throw new Error('b2_object_unreadable_after_put');
        }
        if (sha256Hex(Buffer.from(stored.body)) !== encoded.sha256) {
          inc('object_verification_failures');
          throw new Error('b2_sha256_mismatch');
        }
      }
      inc('b2_frames_objects_created');
      inc('raw_frames_uploaded', frames.length);
      const row = {
        id: objectId,
        user_id: uid,
        device_id: deviceId,
        object_class: 'raw',
        object_kind: stream,
        provider: cfg.rawStore,
        object_key: key,
        bucket: cfg.b2Bucket,
        start_at: start,
        end_at: end,
        period_day: periodDay,
        sample_count: encoded.sample_count,
        compressed_bytes: encoded.compressed_bytes,
        content_type: encoded.content_type,
        format: encoded.format,
        compression: encoded.compression,
        schema_version: encoded.schema_version,
        sha256: encoded.sha256,
        etag,
        retention_class: 'core',
        expires_at: expiresAt(stream, now(), cfg),
        status: raw ? 'ready' : 'pending',
        uploaded_at: raw ? now().toISOString() : null,
        verified_at: raw ? now().toISOString() : null,
      };
      if (db) {
        await db.upsertPayload({
          user_id: uid,
          device: {
            id: deviceId,
            source_kind: 'whoop',
            external_device_id: String(device?.externalId || device?.deviceId || device?.id || 'strap'),
            device_family: device?.name || 'WHOOP',
            firmware: device?.firmware || null,
          },
          object_manifests: [row],
        });
      }
      try {
        await persistSidecarsFromFrames(frames, {
          stores: { raw, cfg },
          userId: uid,
          deviceId,
          startAt: start,
          endAt: end,
          firmware: device?.firmware || null,
          timeZone: extras.timeZone || 'UTC',
        });
      } catch { /* sidecars are derived; Level A is already durable */ }
      return row;
    },

    /**
     * Archive one derived high-value stream (imu_raw / events / console_logs /
     * cmd_battery) to B2. Records are already-decoded structs produced by
     * redecode/derive.js; they carry their own frame-hash + decoder lineage.
     * Same B2 + manifest + verification contract as archiveRawFrames, with
     * core retention: these are irreplaceable observations.
     */
    async archiveDerivedStream({ records, stream, format, schemaVersion, device, startAt, endAt, extras = {} }) {
      if (!records?.length) return null;
      const rows = records;
      const ndjson = `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
      const body = gzipSync(Buffer.from(ndjson, 'utf8'));
      const sha = sha256Hex(body);
      const uid = extras.userId || userId();
      const deviceId = uuidFromParts([uid, 'whoop', String(device?.externalId || device?.deviceId || device?.id || 'strap')]);
      const recordHashes = rows.map((r) => r?.envelope?.frame_hash || '').sort();
      const contentId = createHash('sha256').update(recordHashes.join('') + '|' + stream + '|' + String(device?.externalId || device?.deviceId || 'strap')).digest('hex');
      const objectId = uuidFromParts([uid, stream, String(device?.externalId || device?.deviceId || 'strap'), contentId]);
      const start = startAt || rows[0]?.received_at || rows[0]?.event_ts && new Date(Number(rows[0].event_ts) * 1000).toISOString() || now().toISOString();
      const end = endAt || rows[rows.length - 1]?.received_at || start;
      const periodDay = extras.periodDay || physiologicalDay({ nowIso: end, timeZone: extras.timeZone || 'UTC' });
      const key = rawObjectKeyV3({ userId: uid, deviceId, stream, startAt: start, objectId });
      const { raw } = await resolveStores();
      let etag = null;
      if (raw) {
        const put = await raw.putObject(key, body, { contentType: 'application/x-ndjson' });
        etag = put?.etag || null;
        const head = await raw.head(key);
        if (!head?.exists) { inc('object_verification_failures'); throw new Error('b2_object_missing_after_put'); }
        if (head.contentLength != null && Number(head.contentLength) !== body.length) {
          inc('object_verification_failures'); throw new Error('b2_size_mismatch');
        }
        const stored = await raw.getObject(key);
        if (!stored?.body) { inc('object_verification_failures'); throw new Error('b2_object_unreadable_after_put'); }
        if (sha256Hex(Buffer.from(stored.body)) !== sha) { inc('object_verification_failures'); throw new Error('b2_sha256_mismatch'); }
      }
      inc(`b2_${stream}_objects_created`);
      const row = {
        id: objectId,
        user_id: uid,
        device_id: deviceId,
        object_class: 'raw',
        object_kind: stream,
        provider: cfg.rawStore,
        object_key: key,
        bucket: cfg.b2Bucket,
        start_at: start,
        end_at: end,
        period_day: periodDay,
        sample_count: rows.length,
        compressed_bytes: body.length,
        content_type: 'application/x-ndjson',
        format,
        compression: 'gzip',
        schema_version: schemaVersion,
        sha256: sha,
        etag,
        retention_class: 'core',
        expires_at: expiresAt(stream, now(), cfg),
        status: raw ? 'ready' : 'pending',
        uploaded_at: raw ? now().toISOString() : null,
        verified_at: raw ? now().toISOString() : null,
      };
      if (db) {
        await db.upsertPayload({
          user_id: uid,
          device: {
            id: deviceId,
            source_kind: 'whoop',
            external_device_id: String(device?.externalId || device?.deviceId || device?.id || 'strap'),
            device_family: device?.name || 'WHOOP',
            firmware: device?.firmware || null,
          },
          object_manifests: [row],
        });
      }
      return row;
    },

    /**
     * Actual SHA256 verification of the raw archive objects for one day.
     * The verify endpoint uses this so completeness never rests on the
     * manifest status column. Absent/unreadable objects are omitted from the
     * verified map; a total failure surfaces as unavailableReason.
     */
    async verifyDayArchives({ userId: requestedUserId, day, timeZone = 'UTC', manifests = [] } = {}) {
      const { raw } = await resolveStores();
      if (!raw) return { verifiedByObjectKey: {}, unavailableReason: 'raw_object_store_unavailable' };
      const verified = {};
      let failures = 0;
      let total = 0;
      const verifiedAt = now().toISOString();
      for (const row of manifests) {
        if (!row?.object_key) continue;
        total += 1;
        const loaded = await loadVerifiedPhysiologyObject(raw, row);
        if (!loaded.ok) {
          failures += 1;
          continue;
        }
        verified[row.object_key] = { sha256: loaded.sha256, verified_at: verifiedAt };
      }
      return {
        verifiedByObjectKey: verified,
        unavailableReason: total > 0 && failures === total ? 'raw_archive_unreadable' : null,
      };
    },

    async recomputeFromStorage({
      userId: requestedUserId,
      device = {},
      days = [],
      fromDay,
      toDay,
      timeZone = 'UTC',
      history = [],
    } = {}) {
      if (!db || typeof db.listPhysiologyManifests !== 'function') {
        throw new Error('physiology_manifest_replay_unavailable');
      }
      const uid = requestedUserId || userId();
      const replayDays = days.length ? days : enumerateDays(fromDay, toDay);
      const { raw } = await resolveStores();
      if (!raw) throw new Error('raw_object_store_unavailable');
      const from = replayDays[0] || fromDay;
      const to = replayDays.at(-1) || toDay || from;
      if (!from) return { days: [], manifests: 0, samples: 0, results: [], error: null };

      const extraListed = await extraPhysiologyKeys(raw, uid, replayDays.length ? replayDays : [from], timeZone, null);
      const extraImuListed = await extraImuKeys(raw, uid, replayDays.length ? replayDays : [from], timeZone, null);
      const extraPpgListed = await extraPpgKeys(raw, uid, replayDays.length ? replayDays : [from], timeZone, null);
      const extraEventListed = await extraEventKeys(raw, uid, replayDays.length ? replayDays : [from], timeZone, null);
      const evidence = await loadCanonicalWindowEvidence({
        db,
        raw,
        userId: uid,
        fromDay: from,
        toDay: to,
        timeZone,
        extraKeys: extraListed,
      });
      if (evidence.blocked) {
        throw new Error('raw_object_store_unavailable');
      }
      const ready = evidence.manifestRows || [];
      const verifiedByObjectKey = evidence.verifiedByObjectKey || {};
      const corruptKeys = (evidence.failures || []).map((row) => row.object_key).filter(Boolean);
      const decoded = evidence.samples || [];
      const samples = dedupeReplaySamples(correctReplayHistoricalClock(decoded));
      if (from && samples.length) {
        const bounds = dayBounds(from, timeZone);
        const lo = Date.parse(bounds.day_start_at) - 12 * 3_600_000;
        const hi = Date.parse(bounds.day_end_at);
        guardReplayWindowCoverage(samples, { lo, hi, label: `recompute:${uid}:${from}` });
        const census = decodeFieldCensus(samples);
        if (census.samples && !census.gravity && census.bpm) inc('decode_gravity_absent');
      }
      const imuEvidence = await loadImuRecordsForWindow({
        db,
        raw,
        userId: uid,
        fromDay: from,
        toDay: to,
        timeZone,
        extraKeys: extraImuListed,
      });
      const imuRecords = imuEvidence.records;
      const ppgEvidence = await loadPpgRecordsForWindow({
        db,
        raw,
        userId: uid,
        fromDay: from,
        toDay: to,
        timeZone,
        extraKeys: extraPpgListed,
      });
      const ppgRecords = dedupePpgRecords(ppgEvidence.records);
      const eventEvidence = await loadEventRecordsForWindow({
        db,
        raw,
        userId: uid,
        fromDay: from,
        toDay: to,
        timeZone,
        extraKeys: extraEventListed,
      });
      const eventRecords = eventEvidence.records;
      const correctedDays = samples.filter((sample) => sample?.t_strap && sample?.clock_offset_sec)
        .map((sample) => localDateKey(sample.t, timeZone)).filter(Boolean);
      const requested = days.length
        ? days
        : ready.map((row) => row.period_day).filter(Boolean);
      const targetDays = [...new Set([...requested, ...correctedDays, ...replayDays])].sort();
      if (!targetDays.length && fromDay) targetDays.push(fromDay);
      const overlappingIds = new Set(ready.map((row) => row.id).filter(Boolean));
      const rangeFrontiers = {
        historyOldest: device?.data_range_oldest || device?.history?.data_range_oldest || null,
        strapTrimmedThrough: device?.data_range_oldest || device?.history?.data_range_oldest || null,
        rangeProbedAt: device?.data_range_at || device?.history?.data_range_at || null,
        rangeTrustworthy: device?.range_trustworthy === true || device?.history?.range_trustworthy === true,
      };

      let gapRows = evidence.gapRows || [];
      // Resolve with the same cadence-aware threshold the gate uses, so a
      // repaired gap closes exactly when the gate stops seeing it.
      const replayThreshold = resolveGapThreshold(
        samples.map(parseSampleTime).filter(Number.isFinite).sort((a, b) => a - b),
        null,
      );
      for (const row of gapRows) {
        if (row?.resolved_at) continue;
        if (gapCoveredBySamples(row, samples, { gapMs: replayThreshold })) {
          row.resolved_at = now().toISOString();
          row.resolution = 'backfilled';
          row.meta = { ...(row.meta || {}), resolution_evidence: { kind: 'samples_cover_interval' } };
        }
      }
      if (typeof db?.resolveIngestGaps === 'function') {
        const resolvedRows = gapRows
          .filter((row) => row?.resolved_at && row.resolution === 'backfilled' && row.id)
          .map((row) => ({
            id: row.id,
            resolved_at: row.resolved_at,
            resolution: row.resolution,
            meta: row.meta,
          }));
        if (resolvedRows.length) {
          try { await db.resolveIngestGaps(uid, resolvedRows); inc('ingest_gaps_backfill_resolved', resolvedRows.length); }
          catch { /* best-effort; the next replay resolves again */ }
        }
      }

      const results = [];
      const dayCompletenessResults = [];
      for (const day of targetDays) {
        const bounds = dayBounds(day, timeZone);
        const dayStartMs = Date.parse(bounds.day_start_at);
        const dayEndMs = Date.parse(bounds.day_end_at);
        const lo = Date.parse(bounds.day_start_at) - 12 * 60 * 60_000;
        const hi = Date.parse(bounds.day_end_at);
        const dayImuRecords = imuRecords.filter(
          (record) => imuRecordOverlaps(record, dayStartMs, dayEndMs),
        );
        const dayPpgRecords = ppgRecords.filter(
          (record) => imuRecordOverlaps(record, dayStartMs, dayEndMs),
        );
        const dayEventRecords = eventRecords.filter(
          (record) => imuRecordOverlaps(record, dayStartMs, dayEndMs),
        );
        const windowSamples = samples.filter((sample) => {
          const time = Date.parse(sample?.t || sample?.datetime || sample?.at || '');
          return Number.isFinite(time) && time >= lo && time < hi;
        });
        // Finalization observability: what actually entered this day's window,
        // independent of whether the scorer produced a session.
        const windowStats = {
          day,
          sample_count: windowSamples.length,
          hr_count: windowSamples.filter((s) => Number.isFinite(Number(s?.bpm))).length,
          rr_sample_count: windowSamples.filter((s) => Array.isArray(s?.rr_ms) && s.rr_ms.length).length,
          latest_sensor_at: (() => {
            const latest = windowSamples.reduce((acc, s) => {
              const t = Date.parse(s?.t || s?.datetime || s?.at || '');
              return Number.isFinite(t) && t > acc ? t : acc;
            }, 0);
            return latest ? new Date(latest).toISOString() : null;
          })(),
          manifest_ids: [],
          decoded: samples.length,
          deduplicated: decoded.length - samples.length,
          window_start_at: new Date(lo).toISOString(),
          window_end_at: new Date(hi).toISOString(),
        };
        const overlapping = ready.filter((manifest) => manifestOverlapsWindow(
          manifest,
          lo,
          hi,
        ));
        windowStats.manifest_ids = overlapping.map((row) => row.id).filter(Boolean);
        let computed = null;
        if (windowSamples.length) {
          computed = await this.persistComputed({
          samples: windowSamples,
          device: {
            ...device,
            id: device.id || overlapping.find((row) => row.device_id)?.device_id,
          },
          history,
          extras: {
            userId: uid,
            day,
            timeZone,
            inputObjectIds: overlapping.map((row) => row.id).filter(Boolean),
            decoderVersions: [...new Set(overlapping.map(
              (row) => row.decoder_version || row.decoder || `archive-schema-${row.schema_version || ARCHIVE_SCHEMA_VERSION}`,
            ))],
            inputLayouts: [...new Set(overlapping.map(
              (row) => row.layout || row.format || 'unknown',
            ))],
            replay: true,
            imuRecords: dayImuRecords,
            imuLoadIntegrity: imuEvidence.integrity,
            ppgRecords: dayPpgRecords,
            ppgLoadIntegrity: ppgEvidence.integrity,
            events: dayEventRecords,
            eventLoadIntegrity: eventEvidence.integrity,
          },
        });
          const sessions = (computed?.scored?.sleep?.sessions || [])
            .filter((s) => !s?.isNap && Number.isFinite(Number(s?.start)) && Number.isFinite(Number(s?.end)));
          const main = sessions.length
            ? sessions.reduce((best, s) => (Number(s.end) - Number(s.start) > Number(best.end) - Number(best.start) ? s : best))
            : null;
          const sleepHrCount = main
            ? windowSamples.filter((s) => {
              const t = Date.parse(s?.t || s?.datetime || s?.at || '');
              return Number.isFinite(t) && Number.isFinite(Number(s?.bpm)) && t >= Number(main.start) && t <= Number(main.end);
            }).length
            : null;
          computed.windowStats = {
            ...windowStats,
            sleep_hr_count: sleepHrCount,
            sleep_window: main ? { start: new Date(Number(main.start)).toISOString(), end: new Date(Number(main.end)).toISOString() } : null,
          };
          results.push(computed);
        } else {
          results.push({
            day,
            skipped: true,
            windowStats,
            overlapping: overlappingIds.size,
          });
        }

        try {
          const dayLo = Date.parse(bounds.day_start_at);
          const dayHi = Date.parse(bounds.day_end_at);
          const daySamples = samples.filter((sample) => {
            const time = Date.parse(sample?.t || sample?.datetime || sample?.at || '');
            return Number.isFinite(time) && time >= dayLo && time < dayHi;
          });
          const dayGapRows = gapRows.filter((g) => {
            const gs = Date.parse(g?.start_at);
            const ge = Date.parse(g?.end_at);
            return Number.isFinite(gs) && Number.isFinite(ge) && ge > dayLo && gs < dayHi;
          });
          const dayCorrupt = overlapping.some((row) => corruptKeys.includes(row.object_key));
          const unavailableReason = dayCorrupt && overlapping.length
            && overlapping.every((row) => !verifiedByObjectKey[row.object_key])
            ? 'raw_archive_unreadable'
            : null;
          const gate = computeDayCompleteness({
            day,
            timeZone,
            samples: daySamples,
            gapRows: dayGapRows,
            manifestRows: overlapping,
            verification: { verifiedByObjectKey, unavailableReason },
            frontiers: {
              recomputedThrough: now().toISOString(),
              lastSuccessfulOffload: overlapping
                .map((row) => row.uploaded_at || row.verified_at)
                .filter(Boolean)
                .sort()
                .at(-1) || null,
              ...rangeFrontiers,
            },
            dayFinishedAt: dayHi < now().getTime() ? now().toISOString() : null,
          });
          if (typeof db?.resolveIngestGaps === 'function') {
            const unrec = dayGapRows.filter((g) => {
              if (g?.resolved_at || !g?.id) return false;
              return (gate.gaps?.unrecoverable || []).some((u) => u.start_at === g.start_at && u.end_at === g.end_at);
            }).map((g) => ({
              id: g.id,
              resolved_at: now().toISOString(),
              resolution: 'unrecoverable',
              meta: {
                ...(g.meta || {}),
                resolution_evidence: {
                  history_oldest: rangeFrontiers.historyOldest,
                  range_probed_at: rangeFrontiers.rangeProbedAt,
                  range_trustworthy: rangeFrontiers.rangeTrustworthy,
                },
              },
            }));
            if (unrec.length) {
              try { await db.resolveIngestGaps(uid, unrec); } catch { /* next pass retries */ }
            }
          }
          const finalizedAt = gate.status !== 'open' && gate.day_finished ? now().toISOString() : null;
          if (finalizedAt) {
            gate.finalized = true;
            gate.finalized_at = finalizedAt;
          }
          if (typeof db?.getDayCompleteness === 'function' && typeof db?.invalidateDayCompleteness === 'function') {
            const prev = await db.getDayCompleteness(uid, day);
            if (prev?.finalized_at && (prev.status !== gate.status || dayCorrupt)) {
              await db.invalidateDayCompleteness(uid, [day]);
              inc('day_completeness_invalidated', 1);
            }
          }
          if (typeof db?.upsertDayCompleteness === 'function') {
            await db.upsertDayCompleteness(uid, {
              day,
              timezone_name: timeZone,
              status: gate.status,
              result: gate,
              finalized_at: finalizedAt,
            });
            inc('day_completeness_gate_writes', 1);
          }
          dayCompletenessResults.push({
            ...toDayCompletenessWire(gate),
            hr_coverage_pct: gate.hr_coverage.coverage_pct,
            open_gaps: gate.gaps.counts.live,
            unclassified_ms: gate.gaps.unclassified_ms,
          });
        } catch (err) {
          console.error(`day_gate_failed ${day}:`, err?.message || err);
        }
      }
      return {
        days: targetDays,
        manifests: ready.length,
        samples: samples.length,
        deduplicated: decoded.length - samples.length,
        results,
        dayCompleteness: dayCompletenessResults,
        error: results.length || !samples.length ? null : 'replay_no_day_data',
      };
    },

    async loadPersistedBundle(uidArg, range = {}) {
      if (!db) return { days: {}, snapshots: {} };
      const uid = uidArg || userId();
      const payload = await db.loadUserDays(uid, range.fromDay || null, range.toDay || null);
      const { snapshotsFromPersistedPayload, whoopDaysFromSnapshots } = await import('./snapshot.js');
      const snapshots = snapshotsFromPersistedPayload(payload);
      return { snapshots, days: whoopDaysFromSnapshots(snapshots) };
    },

    async loadPersistedDays(uidArg, range = {}) {
      return (await this.loadPersistedBundle(uidArg, range)).days;
    },

    async readDerived(key) {
      const { derived } = await resolveStores();
      if (!derived) return null;
      const obj = await derived.getObject(key);
      if (!obj) return null;
      try {
        return JSON.parse(gunzipSync(obj.body).toString('utf8'));
      } catch {
        return JSON.parse(obj.body.toString('utf8'));
      }
    },
  };
}
