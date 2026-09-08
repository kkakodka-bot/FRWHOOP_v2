import {
  classifySpo2Byte,
  detectMeasurementWindows,
  classifyDutyCycle,
  unixOf,
  reportsByDeviceFirmwareNight,
  physiologicalNightKey,
  inferSleepEpisodes,
  independentSpo2DeviceCount,
  SLEEP_ASLEEP,
  SPO2_FRAME_OFFSET,
} from './spo2.js';

export const SPECIFICITY_OFFSETS = Array.from({ length: 92 - 74 + 1 }, (_, i) => 74 + i);

export function isOpticalAmpSentinel(ampA, ampB) {
  return ampA === 128 && ampB === 128;
}

export function windowTelemetryRows(observations) {
  const windows = detectMeasurementWindows(observations);
  const byTs = new Map();
  for (const o of observations || []) {
    const t = unixOf(o);
    if (t == null) continue;
    if (!byTs.has(t)) byTs.set(t, []);
    byTs.get(t).push(o);
  }
  const rows = [];
  for (const w of windows) {
    for (let t = w.start_unix; t <= w.end_unix; t += 1) {
      for (const o of byTs.get(t) || []) {
        rows.push({
          timestamp: unixOf(o),
          spo2_raw_byte: o.spo2_raw_byte,
          spo2_state: o.spo2_state,
          spo2_candidate_pct: o.spo2_candidate_pct,
          heart_rate: o.heart_rate ?? null,
          rr_count: o.rr_count ?? null,
          rr_intervals: o.rr_intervals || null,
          sleep_state_raw: o.sleep_state_raw ?? null,
          sleep_state: o.sleep_state ?? null,
          dynamic_acceleration: o.dynamic_acceleration ?? null,
          cardiac_flags: o.cardiac_flags ?? null,
          cardiac_status: o.cardiac_status ?? null,
          optical_baseline_a: o.optical_baseline_a ?? null,
          optical_baseline_b: o.optical_baseline_b ?? null,
          optical_amp_a: o.optical_amp_a ?? null,
          optical_amp_b: o.optical_amp_b ?? null,
          optical_amp_128_128_sentinel: Boolean(o.optical_amp_128_128_sentinel) || isOpticalAmpSentinel(o.optical_amp_a, o.optical_amp_b),
          f32_113: o.f32_113 ?? null,
          firmware: o.firmware ?? null,
          device_id: o.device_id ?? null,
          physical_device_id: o.physical_device_id ?? null,
          source_frame_hash: o.source_frame_hash ?? null,
          source_characteristic: o.source_characteristic ?? o.characteristic ?? null,
          window_start: w.start_unix,
          window_end: w.end_unix,
          window_value: w.window_value,
        });
      }
    }
  }
  return { windows, rows };
}

function numeric(vals) {
  return vals.filter((v) => typeof v === 'number' && Number.isFinite(v));
}

function median(vals) {
  const s = [...vals].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function iqr(vals) {
  const s = [...vals].sort((a, b) => a - b);
  if (s.length < 2) return null;
  const q = (p) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return lo === hi ? s[lo] : s[lo] * (hi - i) + s[hi] * (i - lo);
  };
  return q(0.75) - q(0.25);
}

function mean(vals) {
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

export function fieldByState(rows, field) {
  const out = {};
  for (const state of ['candidate', 'sentinel', 'diagnostic']) {
    const vals = numeric(rows.filter((r) => r.spo2_state === state).map((r) => r[field]));
    const all = rows.filter((r) => r.spo2_state === state);
    out[state] = {
      count: all.length,
      missingness: all.length ? 1 - vals.length / all.length : null,
      median: median(vals),
      iqr: iqr(vals),
      mean: mean(vals),
    };
  }
  const cand = numeric(rows.filter((r) => r.spo2_state === 'candidate').map((r) => r[field]));
  const inv = numeric(rows.filter((r) => r.spo2_state !== 'candidate').map((r) => r[field]));
  const d = (mean(cand) ?? 0) - (mean(inv) ?? 0);
  const pooled = stdev([...cand, ...inv]);
  out.candidate_vs_invalid_diff = cand.length && inv.length ? d : null;
  out.effect_size = pooled ? d / pooled : null;
  return out;
}

function stdev(vals) {
  if (vals.length < 2) return null;
  const m = mean(vals);
  return Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / (vals.length - 1));
}

export function probabilityCandidate(rows, pred) {
  const sub = rows.filter(pred);
  if (!sub.length) return { n: 0, p: null };
  return { n: sub.length, p: sub.filter((r) => r.spo2_state === 'candidate').length / sub.length };
}

export function describeValidityGate(observations) {
  const { windows, rows } = windowTelemetryRows(observations);
  const fields = [
    'heart_rate', 'rr_count', 'dynamic_acceleration', 'cardiac_flags', 'cardiac_status',
    'optical_baseline_a', 'optical_baseline_b', 'optical_amp_a', 'optical_amp_b', 'f32_113',
  ];
  const by_field = {};
  for (const f of fields) by_field[f] = fieldByState(rows, f);
  const motionVals = numeric(rows.map((r) => r.dynamic_acceleration));
  const qs = [0.25, 0.5, 0.75].map((p) => {
    const s = [...motionVals].sort((a, b) => a - b);
    if (!s.length) return null;
    const i = (s.length - 1) * p;
    return s[Math.floor(i)];
  });
  const cond = {
    p_candidate_optical_sentinel: probabilityCandidate(rows, (r) => r.optical_amp_128_128_sentinel),
    p_candidate_not_optical_sentinel: probabilityCandidate(rows, (r) => !r.optical_amp_128_128_sentinel),
    p_candidate_rr_count_0: probabilityCandidate(rows, (r) => r.rr_count === 0),
    p_candidate_asleep: probabilityCandidate(rows, (r) => r.sleep_state === SLEEP_ASLEEP),
    p_candidate_awake: probabilityCandidate(rows, (r) => r.sleep_state != null && r.sleep_state !== SLEEP_ASLEEP),
  };
  if (qs[0] != null) {
    cond.p_candidate_motion_q1 = probabilityCandidate(rows, (r) => r.dynamic_acceleration != null && r.dynamic_acceleration <= qs[0]);
    cond.p_candidate_motion_q4 = probabilityCandidate(rows, (r) => r.dynamic_acceleration != null && r.dynamic_acceleration >= qs[2]);
  }
  const statusVals = numeric(rows.map((r) => r.cardiac_status));
  if (statusVals.length) {
    const mid = median(statusVals);
    cond.p_candidate_status_low = probabilityCandidate(rows, (r) => r.cardiac_status != null && r.cardiac_status < mid);
    cond.p_candidate_status_high = probabilityCandidate(rows, (r) => r.cardiac_status != null && r.cardiac_status >= mid);
  }
  const f113 = numeric(rows.map((r) => r.f32_113));
  if (f113.length) {
    const mid = median(f113);
    cond.p_candidate_f113_low = probabilityCandidate(rows, (r) => r.f32_113 != null && r.f32_113 < mid);
    cond.p_candidate_f113_high = probabilityCandidate(rows, (r) => r.f32_113 != null && r.f32_113 >= mid);
  }
  return { windows: windows.length, n_rows: rows.length, by_field, conditional: cond };
}

export const VALIDITY_FEATURE_NAMES = Object.freeze([
  'optical_amp_128_128_sentinel',
  'cardiac_status',
  'f32_113',
  'dynamic_acceleration',
  'rr_count',
  'sleep_asleep',
  'optical_baseline_a',
  'optical_baseline_b',
  'optical_amp_a',
  'optical_amp_b',
  'cardiac_flags',
  'heart_rate',
]);

const FORBIDDEN_FEATURES = /spo2_raw_byte|spo2_candidate|aux_byte_82|official_spo2|offset_82/;

export function validityFeatureVector(row) {
  return {
    optical_amp_128_128_sentinel: row.optical_amp_128_128_sentinel ? 1 : 0,
    cardiac_status: Number(row.cardiac_status) || 0,
    f32_113: Number(row.f32_113) || 0,
    dynamic_acceleration: Number(row.dynamic_acceleration) || 0,
    rr_count: Number(row.rr_count) || 0,
    sleep_asleep: row.sleep_state === SLEEP_ASLEEP ? 1 : 0,
    optical_baseline_a: Number(row.optical_baseline_a) || 0,
    optical_baseline_b: Number(row.optical_baseline_b) || 0,
    optical_amp_a: Number(row.optical_amp_a) || 0,
    optical_amp_b: Number(row.optical_amp_b) || 0,
    cardiac_flags: Number(row.cardiac_flags) || 0,
    heart_rate: Number(row.heart_rate) || 0,
  };
}

export function assertNoLeakageFeatures(names) {
  for (const n of names) {
    if (FORBIDDEN_FEATURES.test(n)) throw new Error(`leaked feature ${n}`);
  }
  return true;
}

function sigmoid(z) {
  if (z > 20) return 1;
  if (z < -20) return 0;
  return 1 / (1 + Math.exp(-z));
}

export function fitLogistic(rows, { steps = 80, lr = 0.05 } = {}) {
  assertNoLeakageFeatures(VALIDITY_FEATURE_NAMES);
  const X = rows.map(validityFeatureVector);
  const y = rows.map((r) => (r.spo2_state === 'candidate' ? 1 : 0));
  const keys = VALIDITY_FEATURE_NAMES;
  const w = Object.fromEntries(keys.map((k) => [k, 0]));
  let b = 0;
  for (let s = 0; s < steps; s += 1) {
    const dw = Object.fromEntries(keys.map((k) => [k, 0]));
    let db = 0;
    for (let i = 0; i < X.length; i += 1) {
      let z = b;
      for (const k of keys) z += w[k] * X[i][k];
      const err = sigmoid(z) - y[i];
      for (const k of keys) dw[k] += err * X[i][k];
      db += err;
    }
    const n = Math.max(X.length, 1);
    for (const k of keys) w[k] -= lr * dw[k] / n;
    b -= lr * db / n;
  }
  return { weights: w, intercept: b, features: keys };
}

export function predictLogistic(model, row) {
  const x = validityFeatureVector(row);
  let z = model.intercept;
  for (const k of model.features) z += model.weights[k] * x[k];
  return sigmoid(z);
}

function gini(y) {
  if (!y.length) return 0;
  const p = y.filter(Boolean).length / y.length;
  return 2 * p * (1 - p);
}

function bestSplit(rows) {
  let best = null;
  for (const k of VALIDITY_FEATURE_NAMES) {
    const vals = [...new Set(rows.map((r) => validityFeatureVector(r)[k]))].sort((a, b) => a - b);
    for (let i = 1; i < vals.length; i += 1) {
      const thr = (vals[i - 1] + vals[i]) / 2;
      const left = rows.filter((r) => validityFeatureVector(r)[k] <= thr);
      const right = rows.filter((r) => validityFeatureVector(r)[k] > thr);
      if (!left.length || !right.length) continue;
      const yL = left.map((r) => r.spo2_state === 'candidate');
      const yR = right.map((r) => r.spo2_state === 'candidate');
      const gain = gini(rows.map((r) => r.spo2_state === 'candidate'))
        - (left.length * gini(yL) + right.length * gini(yR)) / rows.length;
      if (!best || gain > best.gain) best = { feature: k, threshold: thr, gain, left, right };
    }
  }
  return best;
}

export function fitTree(rows, { maxDepth = 3 } = {}, depth = 0) {
  assertNoLeakageFeatures(VALIDITY_FEATURE_NAMES);
  const p = rows.filter((r) => r.spo2_state === 'candidate').length / Math.max(rows.length, 1);
  if (depth >= maxDepth || rows.length < 8) return { leaf: true, p };
  const split = bestSplit(rows);
  if (!split || split.gain <= 0) return { leaf: true, p };
  return {
    leaf: false,
    feature: split.feature,
    threshold: split.threshold,
    left: fitTree(split.left, { maxDepth }, depth + 1),
    right: fitTree(split.right, { maxDepth }, depth + 1),
  };
}

export function predictTree(tree, row) {
  if (tree.leaf) return tree.p;
  const x = validityFeatureVector(row);
  return x[tree.feature] <= tree.threshold ? predictTree(tree.left, row) : predictTree(tree.right, row);
}

export function classificationMetrics(yTrue, yProb, { threshold = 0.5 } = {}) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (let i = 0; i < yTrue.length; i += 1) {
    const pred = yProb[i] >= threshold;
    if (pred && yTrue[i]) tp += 1;
    else if (pred && !yTrue[i]) fp += 1;
    else if (!pred && !yTrue[i]) tn += 1;
    else fn += 1;
  }
  const prec = tp + fp ? tp / (tp + fp) : null;
  const rec = tp + fn ? tp / (tp + fn) : null;
  const spec = tn + fp ? tn / (tn + fp) : null;
  return {
    precision: prec,
    recall: rec,
    specificity: spec,
    roc_auc: auc(yTrue, yProb),
    pr_auc: prAuc(yTrue, yProb),
    calibration: mean(yProb.map((p, i) => Math.abs(p - (yTrue[i] ? 1 : 0)))),
  };
}

function auc(y, p) {
  const pairs = y.map((yy, i) => ({ y: yy ? 1 : 0, p: p[i] })).sort((a, b) => a.p - b.p);
  let aucv = 0;
  let tp = 0;
  const pos = y.filter(Boolean).length;
  const neg = y.length - pos;
  if (!pos || !neg) return null;
  for (const row of pairs) {
    if (row.y) tp += 1;
    else aucv += tp;
  }
  return aucv / (pos * neg);
}

function prAuc(y, p) {
  const pairs = y.map((yy, i) => ({ y: yy ? 1 : 0, p: p[i] })).sort((a, b) => b.p - a.p);
  let tp = 0;
  let fp = 0;
  const pos = y.filter(Boolean).length;
  if (!pos) return null;
  let prev = 0;
  let area = 0;
  for (const row of pairs) {
    if (row.y) tp += 1;
    else fp += 1;
    const rec = tp / pos;
    const prec = tp / (tp + fp);
    area += (rec - prev) * prec;
    prev = rec;
  }
  return area;
}

export function leaveOneNightValidity(observations, { timeZone = 'UTC' } = {}) {
  const { rows } = windowTelemetryRows(observations);
  const episodes = inferSleepEpisodes(observations);
  const byNight = new Map();
  for (const r of rows) {
    const key = physiologicalNightKey({ sensor_timestamp: r.timestamp, sleep_state: r.sleep_state }, {
      timeZone,
      episodes,
    }) || 'unknown';
    if (!byNight.has(key)) byNight.set(key, []);
    byNight.get(key).push(r);
  }
  const keys = [...byNight.keys()];
  const folds = [];
  for (const held of keys) {
    const train = keys.filter((k) => k !== held).flatMap((k) => byNight.get(k));
    const test = byNight.get(held);
    if (train.length < 10 || test.length < 4) continue;
    const model = fitLogistic(train);
    const y = test.map((r) => r.spo2_state === 'candidate');
    const p = test.map((r) => predictLogistic(model, r));
    folds.push({ night: held, ...classificationMetrics(y, p), coefficients: model.weights });
  }
  return { folds, features: VALIDITY_FEATURE_NAMES };
}

export function classifyConsoleLog(text) {
  const t = String(text || '');
  const low = t.toLowerCase();
  if (/high[- ]freq.*spo2|high frequency spo2/i.test(low)) return 'spo2_high_frequency_mode';
  if (/did not generate a valid spo2|invalid spo2|spo2 fail/i.test(low)) return 'spo2_failure';
  if (/generated a valid spo2/i.test(low)) return 'spo2_success';
  if (/spo2|sigproc|oxygen/.test(low)) return 'spo2_other';
  return null;
}

export function correlateWindowLogs(windows, logs, { padS = 120 } = {}) {
  const indexed = (logs || []).map((log) => ({
    unix: unixOf({ unix: log.unix, sensor_timestamp: log.unix }),
    log: String(log.log || log.text || ''),
    hash: log.frame_hash || log.hash || null,
    cls: classifyConsoleLog(log.log || log.text),
  })).filter((l) => l.unix != null && l.cls);
  return (windows || []).map((w) => {
    const nearby = indexed.filter((l) => l.unix >= w.start_unix - padS && l.unix <= w.end_unix + padS);
    return {
      start: w.start,
      end: w.end,
      window_value: w.window_value,
      candidate_count: w.candidate_count,
      sentinel_count: w.sentinel_count,
      diagnostic_count: w.diagnostic_count,
      nearby_log_events: nearby,
    };
  });
}

export function highFrequencyHypothesis(observations, logs, { timeZone = 'UTC' } = {}) {
  const nights = reportsByDeviceFirmwareNight(observations, { timeZone, by: 'user' });
  const events = (logs || []).map((log) => ({
    unix: unixOf({ unix: log.unix, sensor_timestamp: log.unix }),
    cls: classifyConsoleLog(log.log || log.text),
    log: log.log,
  })).filter((e) => e.unix != null && e.cls === 'spo2_high_frequency_mode');
  return nights.map((night) => {
    const hf = events.filter((e) => {
      const ws = night.windows || [];
      if (!ws.length) return false;
      return e.unix >= ws[0].start_unix - 3600 && e.unix <= (ws.at(-1).end_unix + 3600);
    });
    return {
      night: night.night,
      firmware: night.firmware,
      period_s: night.median_period,
      median_window_length: night.median_window_length,
      observed_windows: night.observed_windows,
      candidate_count: night.candidate_count,
      sentinel_count: night.sentinel_count,
      diagnostic_count: night.diagnostic_count,
      high_frequency_logs: hf.length,
      hypothesis_match: hf.length ? (night.median_period != null && night.median_period <= 800) : null,
      reporting_only: true,
    };
  });
}

export function scanOffsetSpecificity(samples, {
  officialByUnix = null,
  minDistinct = 5,
  minStdev = 0.5,
} = {}) {
  const offsets = SPECIFICITY_OFFSETS;
  const out = [];
  for (const off of offsets) {
    const values = [];
    let asleep = 0;
    let n = 0;
    for (const s of samples || []) {
      const b = s.bytes?.[off] ?? s.frame?.[off];
      if (b == null) continue;
      n += 1;
      const c = classifySpo2Byte(b);
      const asleepFlag = s.sleep_state === SLEEP_ASLEEP;
      if (asleepFlag) asleep += 1;
      if (c.spo2_state === 'candidate') {
        values.push({ t: s.unix, v: c.spo2_candidate_pct, asleep: asleepFlag });
      }
    }
    const inband = values.map((x) => x.v);
    const distinct = new Set(inband).size;
    const sd = stdev(inband);
    const rejected = [];
    if (distinct < minDistinct) rejected.push(`distinct_inband=${distinct}<${minDistinct}`);
    if (sd == null || sd < minStdev) rejected.push(`stdev=${sd}<${minStdev}`);
    let mae = null;
    let r = null;
    if (officialByUnix && inband.length) {
      const pairs = values.map((x) => ({ c: x.v, o: officialByUnix(x.t) })).filter((p) => p.o != null);
      if (pairs.length >= 3) {
        mae = mean(pairs.map((p) => Math.abs(p.c - p.o)));
        r = pearsonLocal(pairs.map((p) => p.c), pairs.map((p) => p.o));
      }
    }
    const duty = classifyDutyCycle(detectMeasurementWindows((samples || []).map((s) => ({
      sensor_timestamp: s.unix,
      spo2_raw_byte: s.bytes?.[off] ?? s.frame?.[off],
      spo2_state: classifySpo2Byte(s.bytes?.[off] ?? s.frame?.[off]).spo2_state,
      spo2_candidate_pct: classifySpo2Byte(s.bytes?.[off] ?? s.frame?.[off]).spo2_candidate_pct,
      sleep_state: s.sleep_state,
    }))), { asleepUnix: (samples || []).filter((s) => s.sleep_state === SLEEP_ASLEEP).map((s) => s.unix) });
    out.push({
      offset: off,
      is_candidate_offset: off === SPO2_FRAME_OFFSET,
      n,
      in_band_fraction: n ? inband.length / n : 0,
      distinct_inband: distinct,
      inband_stdev: sd,
      sleep_only_fraction: values.length ? values.filter((x) => x.asleep).length / values.length : null,
      duty_cycle_strength: duty.classification === 'duty_cycled' ? 1 : 0,
      duty_classification: duty.classification,
      mae_official: mae,
      pearson_official: r,
      rejected,
      plausible: rejected.length === 0,
    });
  }
  return out.sort((a, b) => a.offset - b.offset);
}

function pearsonLocal(xs, ys) {
  if (xs.length < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  if (!dx || !dy) return null;
  return num / Math.sqrt(dx * dy);
}

export function wakeFalsification(observations) {
  const awake = (observations || []).filter((o) => (
    o.spo2_state === 'candidate' && o.sleep_state != null && o.sleep_state !== SLEEP_ASLEEP
  ));
  return { awake_candidate_count: awake.length, examples: awake.slice(0, 5) };
}

export function incompleteNightFalsification(observations, references, { timeZone = 'UTC' } = {}) {
  const nights = reportsByDeviceFirmwareNight(observations, { timeZone, by: 'user' });
  return nights.filter((n) => n.valid_windows > 0).map((n) => {
    const official = (references || []).find((r) => (
      n.windows || []
    ).some((w) => w.start_unix >= r.cycle_start && w.start_unix < r.cycle_end));
    return {
      night: n.night,
      valid_windows: n.valid_windows,
      official_spo2_pct: official?.official_spo2_pct ?? null,
      missing_official: official == null || official.official_spo2_pct == null,
    };
  });
}

export function leaveOneDeviceValidity(observations) {
  const n = independentSpo2DeviceCount(observations);
  if (n < 2) {
    return {
      skipped: true,
      reason: 'independent confirmed WHOOP devices = 0',
      confirmed_device_count: n,
      folds: [],
    };
  }
  const byDev = new Map();
  const { rows } = windowTelemetryRows(observations);
  for (const r of rows) {
    const id = r.physical_device_id;
    if (!id) continue;
    if (!byDev.has(id)) byDev.set(id, []);
    byDev.get(id).push(r);
  }
  const keys = [...byDev.keys()];
  const folds = [];
  for (const held of keys) {
    const train = keys.filter((k) => k !== held).flatMap((k) => byDev.get(k));
    const test = byDev.get(held);
    if (train.length < 10 || test.length < 4) continue;
    const model = fitLogistic(train);
    const y = test.map((r) => r.spo2_state === 'candidate');
    const p = test.map((r) => predictLogistic(model, r));
    folds.push({ device: held, ...classificationMetrics(y, p) });
  }
  return { skipped: false, confirmed_device_count: n, folds };
}
