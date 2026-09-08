import { localHour, localDateKey } from '../time/dayBoundary.js';

/**
 * Skin-temperature aggregation from normalized per-second WHOOP samples.
 *
 * NOOP decodes `skin_temp_raw` per second and family-calibrates it to degrees
 * Celsius (`skinTempCelsius(raw:family:)`). This module turns those per-second
 * values into the nightly average the dashboard shows, plus (when a baseline is
 * available) the deviation from baseline.
 *
 * Rules:
 *  - Raw temperature samples and the derived baseline/deviation are kept
 *    separate; the baseline is never conflated with a single reading.
 *  - Measurements are taken inside the sleep window when one is supplied
 *    (the nightly average is a *nightly* value), otherwise the full day's
 *    samples are used and the window is recorded as `all_day`.
 *  - No value is fabricated: insufficient samples → status 'insufficient'.
 *  - Confidence reflects sample coverage of the window.
 *
 * The value is *skin temperature*, not body/core temperature. Provenance carries
 * that label so the UI is never allowed to present it as core temperature.
 */

export const TEMP_ALGORITHM_VERSION = 'frwhoop-skin-temp-v1';
const MIN_WINDOW_SAMPLES = 30; // ~30s of valid 1 Hz readings
const BASELINE_DAYS = 7; // days the baseline is allowed to span (informational)
/** Product chart cadence: 5 samples/hour. Archive still keeps 1 Hz v18. */
export const SKIN_TEMP_SERIES_INTERVAL_MIN = 12;
const SKIN_TEMP_MIN_C = 20;
const SKIN_TEMP_MAX_C = 45;

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function rounding(n) { return Math.round(n * 100) / 100; }

export function summarizeTemperature(samples, { timeZone = 'UTC', baselineC = null } = {}) {
  const rows = (Array.isArray(samples) ? samples : []).filter((s) => {
  if (!s || s.skin_temp_c == null) return false;
  const t = s.t ?? s.datetime ?? s.at;
  return t != null && Number.isFinite(Date.parse(t));
});
  if (!rows.length) {
    return { temperature_c: null, nightly_average_c: null, deviation_c: null, baseline_c: baselineC,
      sample_count: 0, coverage_seconds: 0, window: 'none', source: 'whoop_skin_temp',
      algorithm_version: TEMP_ALGORITHM_VERSION, confidence: 0, status: 'unavailable',
      detail: 'no_temperature_samples' };
  }
  // Dedupe by second.
  const seen = new Set();
  const vals = [];
  for (const s of rows) {
    const t = s.t ?? s.datetime ?? s.at;
    const sec = Math.floor(Date.parse(t) / 1000);
    if (!Number.isFinite(sec) || seen.has(sec)) continue;
    seen.add(sec);
    vals.push({ v: Number(s.skin_temp_c), sec, hour: localHour(t, timeZone) });
  }
  if (!vals.length) {
    return { temperature_c: null, nightly_average_c: null, deviation_c: null, baseline_c: baselineC,
      sample_count: 0, coverage_seconds: 0, window: 'none', source: 'whoop_skin_temp',
      algorithm_version: TEMP_ALGORITHM_VERSION, confidence: 0, status: 'insufficient',
      detail: 'no_valid_timestamps' };
  }
  const avg = median(vals.map((v) => v.v));
  const nightVals = vals.filter((v) => v.hour >= 21 || v.hour < 6).map((v) => v.v);
  const nightAvg = nightVals.length >= MIN_WINDOW_SAMPLES ? median(nightVals) : null;
  const primary = nightAvg != null ? nightAvg : avg;
  const deviation = baselineC != null && primary != null
    ? rounding(primary - baselineC)
    : null;
  const coverage = Math.min(1, vals.length / 86400);
  const status = primary == null ? 'insufficient'
    : (coverage < 0.05 ? 'partial' : 'ok');
  return {
    temperature_c: primary != null ? rounding(primary) : null,
    nightly_average_c: nightAvg != null ? rounding(nightAvg) : null,
    deviation_c: deviation,
    baseline_c: baselineC != null ? rounding(baselineC) : null,
    sample_count: vals.length,
    coverage_seconds: vals.length,
    window: nightVals.length >= MIN_WINDOW_SAMPLES ? 'night' : 'all_day',
    source: 'whoop_skin_temp',
    algorithm_version: TEMP_ALGORITHM_VERSION,
    confidence: Math.round(Math.min(1, 0.4 + coverage * 0.6) * 100) / 100,
    status,
  };
}

function sampleTimeMs(sample) {
  return Date.parse(sample?.t ?? sample?.datetime ?? sample?.at ?? '');
}

function sampleSkinTempC(sample) {
  const c = Number(sample?.skin_temp_c ?? sample?.skinTempC ?? sample?.skinTemp);
  if (!Number.isFinite(c) || c < SKIN_TEMP_MIN_C || c > SKIN_TEMP_MAX_C) return null;
  return c;
}

/**
 * Downsample 1 Hz v18 skin temp to 12-minute medians (~5 points/hour).
 * Empty buckets are omitted — never plotted as 0 °C.
 */
export function skinTempSeriesFromSamples(samples, {
  intervalMinutes = SKIN_TEMP_SERIES_INTERVAL_MIN,
  dayStartAt = null,
  dayEndAt = null,
} = {}) {
  const ms = Math.max(1, Number(intervalMinutes) || SKIN_TEMP_SERIES_INTERVAL_MIN) * 60 * 1000;
  const startMs = dayStartAt ? Date.parse(dayStartAt) : NaN;
  const endMs = dayEndAt ? Date.parse(dayEndAt) : NaN;
  const buckets = new Map();
  for (const sample of Array.isArray(samples) ? samples : []) {
    const c = sampleSkinTempC(sample);
    if (c == null) continue;
    const t = sampleTimeMs(sample);
    if (!Number.isFinite(t)) continue;
    if (Number.isFinite(startMs) && t < startMs) continue;
    if (Number.isFinite(endMs) && t >= endMs) continue;
    const aligned = Math.floor(t / ms) * ms;
    const row = buckets.get(aligned);
    if (row) row.push(c);
    else buckets.set(aligned, [c]);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([aligned, vals]) => ({
      t: new Date(aligned).toISOString(),
      c: rounding(median(vals)),
      n: vals.length,
    }));
}
