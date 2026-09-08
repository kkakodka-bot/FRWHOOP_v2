/**
 * HR V2 daily metrics: average, peak, sleep HR.
 *
 * Definitions chosen per _hr_v2_research/rhr_daily_metrics_definitions.md
 * section 7 (candidate matrices) and benchmarked in compare.js:
 *
 *  Daily average (A2 + A5 reporting): time-weighted integral on a 1-minute
 *  grid / covered time. Sample density cannot change the result (the V1
 *  unweighted mean is count-biased: probe 10x60 + 600x100 -> 97.9).
 *  Coverage gates are REPORTED by default and only enforced by the a5
 *  candidate, so the canonical scalar stays defined whenever data exists.
 *
 *  Daily peak: raw observed max (diagnostic, kept exactly) + temporally
 *  confirmed peak = max over rolling windows (default 60 s, >=80% populated)
 *  of the time-weighted mean of quality-passing observations. No smoothing is
 *  ever applied: genuine near-maxima persist tens of seconds (rhr report 4.2,
 *  PMID 32538301) while single-sample artifacts do not (2x harmonic lock can
 *  add +60..+120 bpm, rhr report 4.1).
 *
 *  Sleep HR: nocturnal time-weighted mean (distinct concept from RHR;
 *  rhr report section 6 - keep separate persisted fields).
 */

import { HR2_CONFIG } from './version.js';
import { trapezoidWeights } from './series.js';

const MINUTE_MS = 60_000;

function round1(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}

/**
 * Per-minute time-weighted means over quality-passing observations.
 * Expects canonical observations sorted by tMs with _quality.
 * @returns {Array<{tMs:number, mean:number, coveredMs:number, n:number}>} minutes with data
 */
export function minuteGridMeans(observations, { qualityFloor, spacingMs } = {}) {
  const floor = qualityFloor ?? HR2_CONFIG.QUALITY_FLOOR;
  const byMinute = new Map();
  for (const o of observations || []) {
    if (o.bpm == null || (o._quality?.score ?? 1) < floor) continue;
    const start = Math.floor(o.tMs / MINUTE_MS) * MINUTE_MS;
    if (!byMinute.has(start)) byMinute.set(start, []);
    byMinute.get(start).push(o);
  }
  // Local sampling spacing: measured median inter-arrival inside each minute
  // (>= 2 samples), else the caller-provided day-level spacing. Coverage per
  // minute is n * spacing, capped at the minute - DENSITY-INVARIANT by
  // construction: a 1 Hz minute and a 1/60 Hz minute of the same underlying
  // profile both claim the same covered time, so sampling density can never
  // weight one minute more than another (adversarial scenario S20; the V1
  // count-weighted mean fails exactly this probe: 10x60 + 600x100 -> 97.9).
  // Coverage model (density-invariant, S20): a populated minute claims the
  // time BETWEEN its evidence, not more. minutes-with-data are ~60 s apart in
  // both a 1 Hz day and a 1-sample-per-minute day, so the inter-MINUTE median
  // spacing is the density-neutral unit of coverage. A minute with n samples
  // claims min(minute, max(n * withinSpacing, interMinuteSpacing)) - a dense
  // minute fills itself, a lone sample claims the gap between its neighbors'
  // evidence, and an empty minute claims nothing.
  const minuteStarts = [...byMinute.keys()].sort((a, b) => a - b);
  const interMinuteSpacing = spacingMs ?? medianGap(minuteStarts) ?? MINUTE_MS;
  const out = [];
  for (const [start, cell] of [...byMinute.entries()].sort((a, b) => a[0] - b[0])) {
    const times = cell.map((o) => o.tMs);
    const weights = trapezoidWeights(times, start, start + MINUTE_MS);
    let wsum = 0;
    let sum = 0;
    for (let i = 0; i < cell.length; i += 1) {
      wsum += weights[i];
      sum += cell[i].bpm * weights[i];
    }
    const mean = wsum > 0 ? sum / wsum : cell[cell.length - 1].bpm;
    const withinSpacing = cell.length >= 2 ? (medianGap(times) ?? interMinuteSpacing) : interMinuteSpacing;
    const coveredMs = Math.min(MINUTE_MS, Math.max(cell.length * withinSpacing, interMinuteSpacing));
    out.push({ tMs: start, mean, coveredMs, n: cell.length });
  }
  return out;
}

/** Median inter-arrival gap in a sorted timestamp list (ms), or null. */
export function medianGap(times) {
  const t = [...(times || [])].sort((a, b) => a - b);
  if (t.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < t.length; i += 1) gaps.push(t[i] - t[i - 1]);
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

/**
 * Daily average HR - time-weighted integral over covered time.
 *
 * @param {Array} observations canonical, sorted, with _quality
 * @param {object} o { qualityFloor, applyCoverageGate }
 * @returns {{value:number|null, coverage_hours:number, n:number, quality_mean:number,
 *            hourly_coverage:Array, gate_ok:boolean, candidates:object, method:string}}
 */
export function dailyAverageHr(observations, o = {}) {
  const floor = o.qualityFloor ?? HR2_CONFIG.QUALITY_FLOOR;
  const minutes = minuteGridMeans(observations, { qualityFloor: floor });
  let wsum = 0;
  let sum = 0;
  let n = 0;
  const hourlyCoveredMs = new Map();
  for (const m of minutes) {
    wsum += m.coveredMs;
    sum += m.mean * m.coveredMs;
    n += m.n;
    const hourStart = Math.floor(m.tMs / (60 * MINUTE_MS)) * (60 * MINUTE_MS);
    hourlyCoveredMs.set(hourStart, (hourlyCoveredMs.get(hourStart) ?? 0) + m.coveredMs);
  }
  let qSum = 0;
  let qCount = 0;
  for (const s of observations || []) {
    if (s.bpm != null && (s._quality?.score ?? 1) >= floor) {
      qSum += s._quality?.score ?? 1;
      qCount += 1;
    }
  }
  const rawValue = wsum > 0 ? round1(sum / wsum) : null;

  // Candidate A1: V1-style unweighted sample mean (comparison only).
  const gated = (observations || []).filter((s) => s.bpm != null && (s._quality?.score ?? 1) >= floor);
  const a1 = gated.length ? round1(gated.reduce((acc, s) => acc + s.bpm, 0) / gated.length) : null;

  // Candidate A3: median of per-minute means.
  const means = minutes.map((m) => m.mean).sort((a, b) => a - b);
  let a3 = null;
  if (means.length) {
    const mid = means.length >> 1;
    a3 = means.length % 2 ? means[mid] : (means[mid] + means[mid - 1]) / 2;
  }

  // Candidate A4: mean of 5-min bucket time-weighted averages (uniform grid proxy).
  const byBucket = new Map();
  for (const m of minutes) {
    const b = Math.floor(m.tMs / (5 * MINUTE_MS)) * (5 * MINUTE_MS);
    let cell = byBucket.get(b);
    if (!cell) {
      cell = { sum: 0, w: 0 };
      byBucket.set(b, cell);
    }
    cell.sum += m.mean * m.coveredMs;
    cell.w += m.coveredMs;
  }
  const bucketMeans = [...byBucket.values()].map((c) => c.sum / c.w);
  const a4 = bucketMeans.length ? round1(bucketMeans.reduce((a, b) => a + b, 0) / bucketMeans.length) : null;

  // Candidate A5 gate: each covered hour >= 10 covered minutes AND the day
  // overall >= 70% covered time (ENGINEERING-DEFAULT; rhr report 7.1 A5).
  const hours = [...hourlyCoveredMs.entries()];
  const hoursOk = hours.length ? hours.every(([, ms]) => ms >= 10 * MINUTE_MS) : false;
  const overallRatio = wsum > 0 ? Math.min(wsum / (24 * 60 * MINUTE_MS), 1) : 0;
  const gateOk = hours.length > 0 && hoursOk && overallRatio >= 0.7;
  const value = o.applyCoverageGate && !gateOk ? null : rawValue;

  return {
    value,
    coverage_hours: Math.round((wsum / 3.6e6) * 100) / 100,
    n,
    quality_mean: qCount ? Math.round((qSum / qCount) * 100) / 100 : null,
    hourly_coverage: hours
      .map(([t, ms]) => ({ t: new Date(t).toISOString(), coverage_min: round1(ms / MINUTE_MS) }))
      .sort((a, b) => a.t.localeCompare(b.t)),
    gate_ok: gateOk,
    candidates: {
      a1_unweighted_mean: a1,
      a2_twa: rawValue,
      a3_median_minute_means: round1(a3),
      a4_bucket_mean: a4,
      a5_gate_passed: gateOk,
    },
    method: 'hr2-daily-avg-twa-1min-v1',
  };
}

/**
 * Daily peak: raw observed max (diagnostic) + temporally confirmed peak.
 *
 * The confirmed peak slides a W-second window across covered time; a window
 * counts when the covered fraction >= PEAK_MIN_POPULATION and its value is the
 * time-weighted mean of passing observations inside the window (weights
 * bucket-local via trapezoid, capped). All PEAK_WINDOWS_S are evaluated and
 * returned for the benchmark; the default window defines the canonical scalar.
 *
 * @param {Array} observations canonical, sorted, with _quality
 * @param {object} o { qualityFloor }
 */
export function dailyPeak(observations, o = {}) {
  const floor = o.qualityFloor ?? HR2_CONFIG.QUALITY_FLOOR;
  const all = (observations || []).filter((s) => s.bpm != null);
  const passing = all.filter((s) => (s._quality?.score ?? 1) >= floor);

  let rawMax = null;
  let rawMaxAt = null;
  for (const s of all) {
    if (rawMax == null || s.bpm > rawMax) {
      rawMax = s.bpm;
      rawMaxAt = s.t;
    }
  }

  const windows = {};
  for (const Ws of HR2_CONFIG.PEAK_WINDOWS_S) {
    const Wms = Ws * 1000;
    let best = null;
    let bestAt = null;
    // Two-pointer slide over the passing stream.
    let lo = 0;
    for (let hi = 0; hi < passing.length; hi += 1) {
      const t0 = passing[hi].tMs - Wms;
      while (lo < hi && passing[lo].tMs < t0) lo += 1;
      const window = passing.slice(lo, hi + 1);
      if (!window.length) continue;
      const times = window.map((s) => s.tMs);
      const wStart = passing[hi].tMs - Wms;
      const wEnd = passing[hi].tMs;
      const weights = trapezoidWeights(times, wStart, wEnd);
      let wsum = 0;
      let sum = 0;
      for (let i = 0; i < window.length; i += 1) {
        wsum += weights[i];
        sum += window[i].bpm * weights[i];
      }
      const population = wsum / Wms;
      if (population < HR2_CONFIG.PEAK_MIN_POPULATION) continue;
      const mean = wsum > 0 ? sum / wsum : window[window.length - 1].bpm;
      if (best == null || mean > best.value) {
        best = { value: round1(mean), window_s: Ws, at: passing[hi].t, population: Math.round(population * 100) / 100 };
      }
    }
    windows[Ws] = best;
  }

  const confirmed = windows[HR2_CONFIG.PEAK_WINDOW_S_DEFAULT] ?? null;
  return {
    raw_max: rawMax,
    raw_max_at: rawMaxAt,
    confirmed: confirmed ? { value: confirmed.value, window_s: confirmed.window_s, at: new Date(confirmed.at).toISOString(), population: confirmed.population } : null,
    all_windows: windows,
    method: 'hr2-peak-rolling-window-v1',
  };
}

/**
 * Sleep HR: time-weighted mean heart rate inside a window (default: the
 * detected sleep session). Distinct persisted concept from RHR.
 *
 * @param {Array} observations canonical, sorted, with _quality
 * @param {object} o { startMs, endMs, qualityFloor }
 */
export function sleepHr(observations, o = {}) {
  const floor = o.qualityFloor ?? HR2_CONFIG.QUALITY_FLOOR;
  const inWindow = (observations || []).filter((s) => (
    s.bpm != null
    && (s._quality?.score ?? 1) >= floor
    && s.tMs >= o.startMs && s.tMs <= o.endMs
  ));
  const nTotal = (observations || []).filter((s) => s.tMs >= o.startMs && s.tMs <= o.endMs).length;
  if (!inWindow.length) {
    return { value: null, coverage_sec: 0, n: 0, method: 'hr2-sleep-hr-twa-v1' };
  }
  const times = inWindow.map((s) => s.tMs);
  const startMs = Math.max(o.startMs, inBucket_floor(inWindow[0].tMs));
  const weights = trapezoidWeights(times, inWindow[0].tMs, inWindow[inWindow.length - 1].tMs + 1);
  let wsum = 0;
  let sum = 0;
  for (let i = 0; i < inWindow.length; i += 1) {
    wsum += weights[i];
    sum += inWindow[i].bpm * weights[i];
  }
  return {
    value: round1(wsum > 0 ? sum / wsum : inWindow[inWindow.length - 1].bpm),
    coverage_sec: Math.round(wsum / 100) / 10,
    n: inWindow.length,
    n_total: nTotal,
    method: 'hr2-sleep-hr-twa-v1',
  };
}

function inBucket_floor(t) {
  return Math.floor(t / MINUTE_MS) * MINUTE_MS;
}
