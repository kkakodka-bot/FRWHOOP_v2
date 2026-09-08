// Validation-only WHOOP cycle pairing. Product storage stays wake-day.
import {
  summarizeSpo2Observations,
  reportsByDeviceFirmwareNight,
  annotateSpo2Identity,
  inferSleepEpisodes,
  physiologicalNightKey,
} from '../protocol/spo2.js';

function toUnix(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const s = value.getTime() / 1000;
    return Number.isFinite(s) ? Math.floor(s) : null;
  }
  const n = Number(value);
  if (Number.isFinite(n)) {
    if (n > 1e12) return Math.floor(n / 1000);
    if (n > 1e9 && n < 4e9) return Math.floor(n);
    return null;
  }
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export function normalizeWhoopCycle(cycle) {
  if (!cycle || typeof cycle !== 'object') return null;
  const start = toUnix(cycle.cycle_start ?? cycle.start ?? cycle.whoop_cycle_start);
  const end = toUnix(cycle.cycle_end ?? cycle.end ?? cycle.whoop_cycle_end);
  if (start == null || end == null || end <= start) return null;
  return {
    whoop_cycle_id: cycle.whoop_cycle_id || cycle.cycle_id || cycle.id || null,
    whoop_cycle_start: start,
    whoop_cycle_end: end,
    whoop_cycle_start_iso: new Date(start * 1000).toISOString(),
    whoop_cycle_end_iso: new Date(end * 1000).toISOString(),
    whoop_blood_oxygen_pct: cycle.blood_oxygen_pct ?? cycle.blood_oxygen ?? null,
  };
}

export function observationInWhoopCycle(obs, cycle) {
  const t = toUnix(obs?.sensor_timestamp ?? obs?.unix ?? obs);
  if (t == null || !cycle) return false;
  return t >= cycle.whoop_cycle_start && t < cycle.whoop_cycle_end;
}

export function whoopCycleForObservation(obs, cycles) {
  const normalized = (cycles || []).map(normalizeWhoopCycle).filter(Boolean);
  for (const cycle of normalized) {
    if (observationInWhoopCycle(obs, cycle)) return cycle;
  }
  return null;
}

export function attachWhoopCycleValidation(observations, cycles) {
  return (observations || []).map((o) => {
    const row = annotateSpo2Identity(o);
    const cycle = whoopCycleForObservation(row, cycles);
    return {
      ...row,
      whoop_cycle_id: cycle?.whoop_cycle_id ?? null,
      whoop_cycle_start: cycle?.whoop_cycle_start_iso ?? null,
      whoop_cycle_end: cycle?.whoop_cycle_end_iso ?? null,
    };
  });
}

function uniqueCycleForObservations(observations, cycles) {
  const ids = new Set();
  let hit = null;
  for (const o of observations || []) {
    const cycle = whoopCycleForObservation(o, cycles);
    if (!cycle) continue;
    const key = cycle.whoop_cycle_id || `${cycle.whoop_cycle_start}:${cycle.whoop_cycle_end}`;
    ids.add(key);
    hit = cycle;
  }
  if (ids.size !== 1) return null;
  return hit;
}

export function compareSpo2CandidateToWhoopCycles({
  observations,
  cycles = [],
  timeZone = 'UTC',
  sleepSessions = null,
  by = 'user',
} = {}) {
  const rows = (observations || []).map((o) => annotateSpo2Identity(o));
  const episodes = inferSleepEpisodes(rows);
  const productNights = reportsByDeviceFirmwareNight(rows, { timeZone, sleepSessions, by });
  const normalizedCycles = (cycles || []).map(normalizeWhoopCycle).filter(Boolean);
  const linkedNights = productNights.map((night) => {
    const nightObs = rows.filter((o) => (
      physiologicalNightKey(o, { timeZone, sleepSessions, episodes }) === night.night
      && (by !== 'user' || !night.user_id || o.user_id === night.user_id)
    ));
    const cycle = uniqueCycleForObservations(nightObs, normalizedCycles);
    return {
      frwhoop_physiological_day: night.night,
      source_device_id: night.source_device_id || night.device_id || null,
      physical_device_id: night.physical_device_id,
      physical_identity_confidence: night.physical_identity_confidence,
      physical_identity_evidence: night.physical_identity_evidence,
      whoop_cycle_id: cycle?.whoop_cycle_id ?? null,
      whoop_cycle_start: cycle?.whoop_cycle_start_iso ?? null,
      whoop_cycle_end: cycle?.whoop_cycle_end_iso ?? null,
      product: {
        mean: night.mean,
        window_values: night.window_values,
        candidate_count: night.candidate_count,
        valid_windows: night.valid_windows,
      },
    };
  });
  const comparisons = normalizedCycles.map((cycle) => {
    const inCycle = rows.filter((o) => observationInWhoopCycle(o, cycle));
    const summary = summarizeSpo2Observations(inCycle);
    const physDays = [...new Set(inCycle.map((o) => physiologicalNightKey(o, {
      timeZone,
      sleepSessions,
      episodes,
    })).filter(Boolean))];
    return {
      whoop_cycle_id: cycle.whoop_cycle_id,
      whoop_cycle_start: cycle.whoop_cycle_start_iso,
      whoop_cycle_end: cycle.whoop_cycle_end_iso,
      whoop_blood_oxygen_pct: cycle.whoop_blood_oxygen_pct,
      frwhoop_physiological_days: physDays,
      frwhoop_window_values: summary.window_values,
      frwhoop_mean_of_window_means: summary.mean,
      frwhoop_candidate_mean: summary.candidate_mean,
      frwhoop_median: summary.median,
      frwhoop_minimum: summary.minimum,
      candidate_count: summary.candidate_count,
      valid_windows: summary.valid_windows,
      source_device_ids: summary.source_device_ids,
      physical_device_id: summary.physical_device_id,
      physical_identity_confidence: summary.physical_identity_confidence,
      physical_identity_evidence: summary.physical_identity_evidence,
    };
  });
  return {
    product_nights: linkedNights,
    whoop_cycle_comparisons: comparisons,
  };
}
