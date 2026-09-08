import {
  summarizeSpo2Observations,
  reportsByDeviceFirmwareNight,
  annotateSpo2Identity,
  inferSleepEpisodes,
  physiologicalNightKey,
  detectMeasurementWindows,
  independentSpo2DeviceCount,
  deviceAliasRelations,
  unixOf,
} from '../protocol/spo2.js';
import { observationInWhoopCycle } from './spo2WhoopCycle.js';
import { toWhoopSpo2Reference } from './spo2Reference.js';

function mean(vals) {
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function median(vals) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stdev(vals) {
  if (vals.length < 2) return null;
  const m = mean(vals);
  return Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / (vals.length - 1));
}

export function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

export function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rank = (arr) => {
    const order = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const r = Array(arr.length);
    for (let i = 0; i < order.length; i += 1) r[order[i].i] = i + 1;
    return r;
  };
  return pearson(rank(xs), rank(ys));
}

export function blandAltman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return { bias: null, loa_low: null, loa_high: null };
  const diffs = xs.map((x, i) => x - ys[i]);
  const bias = mean(diffs);
  const sd = stdev(diffs);
  return {
    bias,
    loa_low: bias - 1.96 * sd,
    loa_high: bias + 1.96 * sd,
  };
}

export function errorStats(candidate, official) {
  const pairs = [];
  for (let i = 0; i < candidate.length; i += 1) {
    if (candidate[i] == null || official[i] == null) continue;
    pairs.push({ c: candidate[i], o: official[i] });
  }
  if (!pairs.length) {
    return { n: 0, mae: null, median_ae: null, bias: null, rmse: null, pearson: null, spearman: null, slope: null, intercept: null, bland_altman: blandAltman([], []) };
  }
  const c = pairs.map((p) => p.c);
  const o = pairs.map((p) => p.o);
  const err = pairs.map((p) => p.c - p.o);
  const abs = err.map(Math.abs);
  const mx = mean(o);
  const my = mean(c);
  const varx = o.reduce((a, v) => a + (v - mx) ** 2, 0);
  const slope = varx ? o.reduce((a, v, i) => a + (v - mx) * (c[i] - my), 0) / varx : null;
  return {
    n: pairs.length,
    mae: mean(abs),
    median_ae: median(abs),
    bias: mean(err),
    rmse: Math.sqrt(mean(err.map((e) => e * e))),
    pearson: pearson(c, o),
    spearman: spearman(c, o),
    slope,
    intercept: slope == null ? null : my - slope * mx,
    bland_altman: blandAltman(c, o),
  };
}

export function cyclesContaining(obs, references) {
  const hits = [];
  for (const ref of references || []) {
    const cycle = {
      whoop_cycle_start: ref.cycle_start,
      whoop_cycle_end: ref.cycle_end,
    };
    if (observationInWhoopCycle(obs, cycle)) hits.push(ref);
  }
  return hits;
}

export function pairObservationToWhoopCycles(obs, references, { timeZone = 'UTC', sleepSessions = null, episodes = null } = {}) {
  const row = annotateSpo2Identity(obs);
  const hits = cyclesContaining(row, references);
  const phys = physiologicalNightKey(row, { timeZone, sleepSessions, episodes });
  return {
    ...row,
    frwhoop_physiological_day: phys,
    whoop_cycle_id: hits.length === 1 ? hits[0].cycle_id : null,
    whoop_cycle_start: hits.length === 1 ? hits[0].cycle_start_iso : null,
    whoop_cycle_end: hits.length === 1 ? hits[0].cycle_end_iso : null,
    official_spo2_pct: hits.length === 1 ? hits[0].official_spo2_pct : null,
    matching_cycle_count: hits.length,
    pairing: hits.length === 0 ? 'no_matching_whoop_cycle' : (hits.length > 1 ? 'overlapping_cycles' : 'matched'),
  };
}

export function candidateAggregates(observations) {
  const summary = summarizeSpo2Observations(observations);
  const windowMeans = (summary.windows || []).filter((w) => w.window_value != null).map((w) => w.window_value);
  const seconds = (observations || [])
    .filter((o) => o.spo2_state === 'candidate' && o.spo2_candidate_pct >= 70 && o.spo2_candidate_pct <= 100)
    .map((o) => o.spo2_candidate_pct);
  return {
    A: mean(windowMeans),
    B: median(windowMeans),
    C: median(seconds),
    D: mean(seconds),
    E: windowMeans.length ? Math.min(...windowMeans) : null,
    F: windowMeans.length ? Math.max(...windowMeans) : null,
    window_values: windowMeans,
    summary,
  };
}

function nearestDateMatchForbidden(obs, references) {
  const t = unixOf(obs);
  if (t == null) return false;
  const day = new Date(t * 1000).toISOString().slice(0, 10);
  const byDate = (references || []).filter((r) => (
    r.cycle_start_iso?.slice(0, 10) === day || r.cycle_end_iso?.slice(0, 10) === day
  ));
  const intersecting = cyclesContaining(obs, references);
  return byDate.length > 0 && intersecting.length === 0;
}

export function compareOfficialSpo2({
  observations,
  references = [],
  timeZone = 'UTC',
  sleepSessions = null,
  minValidWindows = 1,
} = {}) {
  const rows = (observations || []).map((o) => annotateSpo2Identity(o));
  const episodes = inferSleepEpisodes(rows);
  const refs = (references || []).map((r) => (r.cycle_start && r.cycle_end ? r : toWhoopSpo2Reference(r))).filter(Boolean);
  const productNights = reportsByDeviceFirmwareNight(rows, { timeZone, sleepSessions, by: 'user' });
  const issues = [];
  const cycleRows = refs.map((ref) => {
    const inCycle = rows.filter((o) => observationInWhoopCycle(o, {
      whoop_cycle_start: ref.cycle_start,
      whoop_cycle_end: ref.cycle_end,
    }));
    const windows = detectMeasurementWindows(inCycle);
    const outside = windows.filter((w) => w.start_unix < ref.cycle_start || w.end_unix >= ref.cycle_end);
    const agg = candidateAggregates(inCycle);
    const coverageOk = agg.summary.valid_windows >= minValidWindows;
    if (!inCycle.length) issues.push({ kind: 'official_cycle_no_candidate_coverage', cycle_id: ref.cycle_id });
    if (outside.length) issues.push({ kind: 'candidate_window_outside_matched_cycle', cycle_id: ref.cycle_id });
    const physDays = [...new Set(inCycle.map((o) => physiologicalNightKey(o, { timeZone, sleepSessions, episodes })).filter(Boolean))];
    const official = ref.official_spo2_pct;
    const err = (v) => (v == null || official == null ? null : v - official);
    return {
      cycle_id: ref.cycle_id,
      whoop_cycle_start: ref.cycle_start_iso,
      whoop_cycle_end: ref.cycle_end_iso,
      physical_device_id: agg.summary.physical_device_id,
      source_device_ids: agg.summary.source_device_ids,
      firmware: agg.summary.firmware,
      candidate_windows_expected: agg.summary.expected_windows,
      candidate_windows_observed: agg.summary.observed_windows,
      candidate_windows_valid: agg.summary.valid_windows,
      window_coverage_pct: agg.summary.window_coverage_pct,
      official_spo2_pct: official,
      score_state: ref.score_state,
      frwhoop_physiological_days: physDays,
      candidate_mean_window_means: agg.A,
      candidate_median_window_means: agg.B,
      candidate_median_seconds: agg.C,
      candidate_mean_seconds: agg.D,
      candidate_min_window: agg.E,
      candidate_max_window: agg.F,
      error_A: err(agg.A),
      error_B: err(agg.B),
      error_C: err(agg.C),
      error_D: err(agg.D),
      sufficient: coverageOk && official != null,
    };
  });

  for (const night of productNights) {
    if (!night.candidate_count) continue;
    const nightObs = rows.filter((o) => physiologicalNightKey(o, { timeZone, sleepSessions, episodes }) === night.night);
    const ids = new Set();
    for (const o of nightObs) {
      const hits = cyclesContaining(o, refs);
      if (hits.length > 1) issues.push({ kind: 'overlapping_cycles', night: night.night });
      hits.forEach((h) => ids.add(h.cycle_id));
    }
    if (ids.size === 0) issues.push({ kind: 'candidate_night_no_official_spo2', night: night.night });
    if (ids.size > 1) issues.push({ kind: 'cycle_boundary_disagreement', night: night.night, cycles: [...ids] });
  }

  const forced = rows.some((o) => nearestDateMatchForbidden(o, refs));
  if (forced) issues.push({ kind: 'date_only_overlap_not_used' });

  const scored = cycleRows.filter((r) => r.sufficient);
  const formulas = ['A', 'B', 'C', 'D'];
  const keys = {
    A: 'candidate_mean_window_means',
    B: 'candidate_median_window_means',
    C: 'candidate_median_seconds',
    D: 'candidate_mean_seconds',
  };
  const discovery = [];
  const holdout = [];
  const nights = scored.map((r) => r.frwhoop_physiological_days[0] || r.cycle_id);
  const uniqNights = [...new Set(nights)];
  if (uniqNights.length >= 4) {
    const cut = Math.ceil(uniqNights.length * 0.6);
    const disc = new Set(uniqNights.slice(0, cut));
    for (const row of scored) {
      const n = row.frwhoop_physiological_days[0] || row.cycle_id;
      (disc.has(n) ? discovery : holdout).push(row);
    }
  }
  const statsFor = (subset) => {
    const out = {};
    for (const f of formulas) {
      out[f] = errorStats(subset.map((r) => r[keys[f]]), subset.map((r) => r.official_spo2_pct));
    }
    return out;
  };
  const loo = scored.length >= 3 ? scored.map((_, i) => {
    const train = scored.filter((__, j) => j !== i);
    const test = [scored[i]];
    return { held_out: scored[i].cycle_id, stats: statsFor(test), train_n: train.length };
  }) : [];

  const confirmed = independentSpo2DeviceCount(rows);
  const relations = deviceAliasRelations(rows);
  const probable = relations.filter((r) => r.relation === 'probable_same_device').length;
  const unknown = new Set(rows.map((r) => r.device_id).filter(Boolean)).size;

  return {
    product_nights: productNights.map((n) => ({
      frwhoop_physiological_day: n.night,
      mean_of_window_means: n.mean,
      candidate_count: n.candidate_count,
      valid_windows: n.valid_windows,
      firmware: n.firmware,
      source_device_id: n.source_device_id,
      physical_device_id: n.physical_device_id,
      physical_identity_confidence: n.physical_identity_confidence,
    })),
    cycles: cycleRows,
    issues,
    stats_all: statsFor(scored),
    stats_discovery: discovery.length ? statsFor(discovery) : null,
    stats_holdout: holdout.length ? statsFor(holdout) : null,
    leave_one_night_out: loo,
    n_cycles: scored.length,
    n_cycles_with_official: refs.filter((r) => r.official_spo2_pct != null).length,
    n_references: refs.length,
    confirmed_device_count: confirmed,
    probable_device_count: probable ? 1 : 0,
    unknown_device_count: confirmed ? 0 : unknown,
    n_devices: confirmed,
    n_firmwares: new Set(scored.map((r) => r.firmware).filter(Boolean)).size,
    spo2_pct: null,
  };
}

export function deviceCensus(observations) {
  const rows = (observations || []).map((o) => annotateSpo2Identity(o));
  return {
    confirmed_device_count: independentSpo2DeviceCount(rows),
    probable_device_count: deviceAliasRelations(rows).some((r) => r.relation === 'probable_same_device') ? 1 : 0,
    unknown_device_count: independentSpo2DeviceCount(rows) ? 0 : new Set(rows.map((r) => r.device_id).filter(Boolean)).size,
    n_devices: independentSpo2DeviceCount(rows),
    alias_relations: deviceAliasRelations(rows),
  };
}

export function pulseOxWindowValues(windows, pulseSamples, { minSamples = 5, lagS = 0 } = {}) {
  return (windows || []).map((w) => {
    const start = w.start_unix + lagS;
    const end = w.end_unix + lagS;
    const inside = pulseSamples.filter((s) => s.timestamp >= start && s.timestamp <= end);
    const ok = inside.length >= minSamples;
    return {
      start: w.start,
      end: w.end,
      window_value: w.window_value,
      reference_window_value: ok ? median(inside.map((s) => s.spo2_pct)) : null,
      reference_n: inside.length,
      accepted: ok,
      lag_s: lagS,
    };
  });
}

export function chooseLagOnDiscovery(windows, pulseSamples, { lags = range(-120, 120, 10), minSamples = 5, discoveryIdx = null } = {}) {
  const disc = discoveryIdx || windows.map((_, i) => i).filter((i) => i < Math.ceil(windows.length * 0.6));
  const discWindows = disc.map((i) => windows[i]);
  let best = { lag_s: 0, mae: Infinity };
  for (const lag of lags) {
    const rows = pulseOxWindowValues(discWindows, pulseSamples, { minSamples, lagS: lag }).filter((r) => r.reference_window_value != null && r.window_value != null);
    if (rows.length < 2) continue;
    const mae = mean(rows.map((r) => Math.abs(r.window_value - r.reference_window_value)));
    if (mae < best.mae) best = { lag_s: lag, mae };
  }
  return best;
}

function range(lo, hi, step) {
  const out = [];
  for (let v = lo; v <= hi; v += step) out.push(v);
  return out;
}

export function evaluatePulseOx({ windows, pulseSamples, frozenLagS, minSamples = 5 }) {
  const zero = pulseOxWindowValues(windows, pulseSamples, { minSamples, lagS: 0 });
  const lagged = pulseOxWindowValues(windows, pulseSamples, { minSamples, lagS: frozenLagS });
  const stats = (rows) => errorStats(
    rows.filter((r) => r.window_value != null && r.reference_window_value != null).map((r) => r.window_value),
    rows.filter((r) => r.window_value != null && r.reference_window_value != null).map((r) => r.reference_window_value),
  );
  return {
    frozen_lag_s: frozenLagS,
    zero_lag: stats(zero),
    lagged: stats(lagged),
    coverage: windows.length ? lagged.filter((r) => r.accepted).length / windows.length : 0,
    reference_rejection_rate: windows.length ? lagged.filter((r) => !r.accepted).length / windows.length : null,
    whoop_candidate_rejection_rate: windows.length ? windows.filter((w) => w.window_value == null).length / windows.length : null,
  };
}

export function finalEvidenceStatus({
  confirmed_device_count = 0,
  n_cycles = 0,
  pulse_ox_n = 0,
  official_mae = null,
} = {}) {
  if (confirmed_device_count >= 2 && pulse_ox_n >= 8) return 'MULTI_DEVICE_SUPPORTED';
  if (pulse_ox_n >= 8) return 'EXTERNAL_REFERENCE_SUPPORTED';
  if (n_cycles >= 1 && official_mae != null) return 'REFERENCE_CORRELATED';
  return 'DECODE_ONLY';
}
