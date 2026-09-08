import { createHash } from 'node:crypto';
import {
  classifySpo2Byte,
  summarizeSpo2Observations,
  annotateSpo2Identity,
  inferSleepEpisodes,
  physiologicalNightKey,
  SPO2_SOURCE,
  SPO2_DECODER_VERSION,
} from '../protocol/spo2.js';

export { SPO2_SOURCE, SPO2_DECODER_VERSION };

function unixOfSample(sample) {
  const ts = Number(sample?.sensor_ts);
  if (Number.isFinite(ts) && ts > 1e9 && ts < 4e9) return Math.floor(ts);
  const t = Date.parse(sample?.t ?? sample?.datetime ?? sample?.at ?? '');
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export function observationsFromSamples(samples) {
  const out = [];
  for (const sample of Array.isArray(samples) ? samples : []) {
    const classified = classifySpo2Byte(sample?.spo2_raw_byte ?? sample?.aux_byte_82);
    const state = sample?.spo2_state || classified.spo2_state;
    if (!state) continue;
    const pct = state === 'candidate'
      ? (sample?.spo2_candidate_pct ?? classified.spo2_candidate_pct)
      : null;
    out.push(annotateSpo2Identity({
      spo2_raw_byte: classified.spo2_raw_byte,
      spo2_candidate_pct: state === 'candidate' && pct >= 70 && pct <= 100 ? pct : null,
      spo2_state: state,
      sensor_timestamp: unixOfSample(sample),
      device_id: sample?.device_id || null,
      user_id: sample?.user_id || null,
      device_family: sample?.family || null,
      firmware: sample?.firmware || null,
      layout: sample?.layout || 'v18',
      decoder_version: sample?.decoder || null,
      source_frame_hash: sample?.source_frame_hash || null,
      sleep_state: Number.isInteger(Number(sample?.band_sleep_state ?? sample?.sleep_state))
        ? Number(sample.band_sleep_state ?? sample.sleep_state)
        : null,
      serial: sample?.serial || null,
      external_device_id: sample?.external_device_id || null,
      hardware_id: sample?.hardware_id || null,
    }));
  }
  return out;
}

export function overlaySpo2OnSamples(samples, observations) {
  if (!observations?.length) return samples || [];
  const byTs = new Map();
  for (const o of observations) {
    const t = Number(o?.sensor_timestamp);
    if (!Number.isFinite(t)) continue;
    if (!byTs.has(t)) byTs.set(t, o);
  }
  return (samples || []).map((sample) => {
    const t = unixOfSample(sample);
    const o = t != null ? byTs.get(t) : null;
    if (!o || sample.spo2_raw_byte != null) return sample;
    return {
      ...sample,
      spo2_raw_byte: o.spo2_raw_byte,
      spo2_state: o.spo2_state,
      spo2_candidate_pct: o.spo2_candidate_pct,
      source_frame_hash: sample.source_frame_hash || o.source_frame_hash,
      firmware: sample.firmware || o.firmware,
    };
  });
}

export function summarizeSpo2Candidate(samples, {
  day = null,
  timeZone = 'UTC',
  sleepSessions = null,
} = {}) {
  let observations = observationsFromSamples(samples);
  if (day) {
    const episodes = inferSleepEpisodes(observations);
    observations = observations.filter((o) => physiologicalNightKey(o, {
      timeZone,
      sleepSessions,
      episodes,
    }) === day);
  }
  const summary = summarizeSpo2Observations(observations, {
    timeZone,
    sleepSessions,
  });
  return {
    ...summary,
    algorithm_version: SPO2_DECODER_VERSION,
    source: SPO2_SOURCE,
    spo2_candidate_pct: summary.mean != null ? Math.round(summary.mean * 100) / 100 : null,
    spo2_pct: null,
    series: spo2CandidateSeriesFromObservations(observations),
  };
}

export function shouldPersistSpo2Candidate(summary) {
  return Boolean(summary?.candidate_count || summary?.observed_windows);
}

export function spo2CandidateInputHash(observations) {
  const keys = (observations || [])
    .map((o) => o.source_frame_hash || `${o.device_id || ''}@${o.sensor_timestamp}`)
    .filter(Boolean)
    .sort();
  return createHash('sha256').update(keys.join('\n')).digest('hex');
}

export function extrasFromSpo2Summary(summary, series) {
  return {
    spo2_candidate: {
      sample_count: summary.sample_count,
      coverage: summary.coverage,
      source: summary.source,
      firmware: summary.firmware,
      decoder_version: summary.decoder_version,
      confidence: summary.confidence,
      status: summary.status,
      mean: summary.mean,
      median: summary.median,
      minimum: summary.minimum,
      maximum: summary.maximum,
      p10: summary.p10,
      p90: summary.p90,
      asleep: summary.candidate_count_while_asleep,
      awake: summary.candidate_count_while_awake,
      sentinel_count: summary.sentinel_count,
      diagnostic_count: summary.diagnostic_count,
      spo2_candidate_pct: summary.spo2_candidate_pct ?? (summary.mean != null
        ? Math.round(summary.mean * 100) / 100
        : null),
      spo2_pct: null,
      classification: summary.classification,
      expected_windows: summary.expected_windows,
      observed_windows: summary.observed_windows,
      valid_windows: summary.valid_windows,
      window_coverage_pct: summary.window_coverage_pct,
      median_window_length: summary.median_window_length,
      median_period: summary.median_period,
      period_jitter: summary.period_jitter,
      windows: (summary.windows || []).map((w) => ({
        start: w.start,
        end: w.end,
        duration_s: w.duration_s,
        window_value: w.window_value,
        candidate_count: w.candidate_count,
        sentinel_count: w.sentinel_count,
        diagnostic_count: w.diagnostic_count,
      })),
      source_device_id: (summary.source_device_ids || [])[0] || null,
      source_device_ids: summary.source_device_ids,
      physical_device_id: summary.physical_device_id,
      physical_identity_confidence: summary.physical_identity_confidence || 'unknown',
      physical_identity_evidence: summary.physical_identity_evidence || null,
      independent_physical_device_count: summary.independent_physical_device_count ?? 0,
      input_hash: summary.input_hash || null,
    },
    spo2_candidate_series: series || [],
  };
}

/** Timestamped candidate points only. Missing stays absent — never 0. */
export function spo2CandidateSeriesFromSamples(samples) {
  return spo2CandidateSeriesFromObservations(observationsFromSamples(samples));
}

export function spo2CandidateSeriesFromObservations(observations) {
  return (observations || [])
    .filter((o) => o.spo2_state === 'candidate' && o.spo2_candidate_pct != null && o.sensor_timestamp != null)
    .map((o) => ({
      t: new Date(o.sensor_timestamp * 1000).toISOString(),
      pct: o.spo2_candidate_pct,
      sleep_state: o.sleep_state,
      source_frame_hash: o.source_frame_hash,
      spo2_raw_byte: o.spo2_raw_byte,
      spo2_state: o.spo2_state,
    }))
    .sort((a, b) => a.t.localeCompare(b.t));
}
