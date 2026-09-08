import { physiologicalDay } from '../time/dayBoundary.js';
import {
  DETECTION_ALGORITHM_VERSION,
  STAGING_ALGORITHM_VERSION,
  detectSleepSessions,
  extractSleepStreams,
} from './sleepDetection.js';
import { detectNaps } from './napDetection.js';
import { stageSession } from './sleepStagerV2.js';
import { stageSessionV3 } from './sleepStagerV3.js';
import { shouldComputeSleepV3 } from './sleepV3Artifact.js';

/** Sleep, recovery, and strain algorithms. Numbers the Sleep tab and Overview consume. */

export const ALGORITHM_VERSION = '2.0.3-hr-only-onset';

const BASE_SLEEP_NEED_MIN = 480;
const ASLEEP_HOLD_MS = 15 * 60_000;
const WAKE_HOLD_MS = 10 * 60_000;
/** HR-only fallback must look like a real night, not evening sitting. */
const HR_ONLY_MIN_SLEEP_MS = 3 * 60 * 60_000;
const HR_ONLY_DAYTIME_START_HOUR = 8;
const HR_ONLY_DAYTIME_END_HOUR = 22;

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function mean(values) {
  const list = values.filter(Number.isFinite);
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
}

function percentile(values, p) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const idx = clamp((list.length - 1) * p, 0, list.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return list[lo];
  return list[lo] + (list[hi] - list[lo]) * (idx - lo);
}

function stdev(values) {
  const list = values.filter(Number.isFinite);
  if (list.length < 2) return 0;
  const m = mean(list);
  return Math.sqrt(mean(list.map((v) => (v - m) ** 2)));
}

function sampleTime(row) {
  // `t` is first because it is the archive's own field name and what the sleep
  // DETECTOR reads (sleepDetection.js). Omitting it here meant a caller passing
  // archive-shaped samples straight to scoreSleep got a detected night whose
  // in-window statistics were all computed from an empty set: null resting HR,
  // empty HR spark, and no RR intervals to measure. persistComputed happened to
  // mask it by copying `t` into `datetime` first.
  const iso = row?.t || row?.datetime || row?.at || row?.ts;
  if (!iso) return null;
  const t = Date.parse(String(iso).replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

function sampleBpm(row) {
  const n = num(row?.bpm ?? row?.heartRate);
  return n != null && n >= 20 && n <= 240 ? n : null;
}

export function sleepEfficiency(asleepMin, inBedMin) {
  const asleep = num(asleepMin);
  const inBed = num(inBedMin);
  if (asleep == null || inBed == null || inBed <= 0) return null;
  return clamp(asleep / inBed, 0, 1);
}

export function sleepPerformance(asleepMin, needMin) {
  const asleep = num(asleepMin);
  const need = num(needMin);
  if (asleep == null || need == null || need <= 0) return null;
  return clamp((asleep / need) * 100, 0, 100);
}

export function sleepNeedMin({ baselineMin = BASE_SLEEP_NEED_MIN, strainYesterday = 0, debtMin = 0 } = {}) {
  const base = num(baselineMin) ?? BASE_SLEEP_NEED_MIN;
  const strainAdd = clamp((num(strainYesterday) || 0) / 21 * 50, 0, 50);
  const debtAdd = clamp((num(debtMin) || 0) * 0.4, 0, 90);
  return Math.round(clamp(base + strainAdd + debtAdd, 360, 720));
}

export function sleepDebtMin(history = []) {
  let debt = 0;
  for (const night of history) {
    const need = num(night.needMin ?? night.sleep_need_min) ?? BASE_SLEEP_NEED_MIN;
    const asleep = num(night.asleepMin ?? night.sleep_total_min) ?? 0;
    debt = clamp(debt * 0.65 + Math.max(0, need - asleep), 0, 240);
  }
  return Math.round(debt);
}

export function sleepConsistencyPct(onsets = [], wakes = []) {
  const onsetMin = onsets.map(clockMinutes).filter(Number.isFinite);
  const wakeMin = wakes.map(clockMinutes).filter(Number.isFinite);
  const parts = [];
  if (onsetMin.length >= 2) parts.push(clamp(100 - stdev(onsetMin) / 1.2, 0, 100));
  if (wakeMin.length >= 2) parts.push(clamp(100 - stdev(wakeMin) / 1.2, 0, 100));
  if (!parts.length) return null;
  return Math.round(mean(parts));
}

function clockMinutes(iso) {
  const t = Date.parse(String(iso || '').replace(' ', 'T'));
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
}

export function recoveryScore({
  hrv,
  hrvBaseline,
  rhr,
  rhrBaseline,
  sleepPerf,
  resp,
  respBaseline,
} = {}) {
  const parts = [];
  const weights = [];
  if (num(hrv) != null && num(hrvBaseline) > 0) {
    parts.push(clamp(50 + ((hrv - hrvBaseline) / hrvBaseline) * 50, 0, 100));
    weights.push(0.35);
  }
  if (num(rhr) != null && num(rhrBaseline) > 0) {
    parts.push(clamp(50 - ((rhr - rhrBaseline) / rhrBaseline) * 50, 0, 100));
    weights.push(0.25);
  }
  if (num(sleepPerf) != null) {
    parts.push(clamp(sleepPerf, 0, 100));
    weights.push(0.30);
  }
  if (num(resp) != null && num(respBaseline) > 0) {
    parts.push(clamp(100 - (Math.abs(resp - respBaseline) / respBaseline) * 200, 0, 100));
    weights.push(0.10);
  }
  if (!parts.length) return null;
  const wsum = weights.reduce((a, b) => a + b, 0);
  return Math.round(parts.reduce((s, v, i) => s + v * weights[i], 0) / wsum);
}

function strainTimedRows(samples) {
  const timed = (samples || []).map((row) => ({
    bpm: sampleBpm(row),
    t: Date.parse(row?.t ?? row?.datetime ?? row?.at ?? ''),
  })).filter((row) => row.bpm != null && Number.isFinite(row.t)).sort((a, b) => a.t - b.t);
  return [...new Map(timed.map((row) => [row.t, row])).values()];
}

function strainWeight(bpm, rest, reserve) {
  const pct = ((bpm - rest) / reserve) * 100;
  return pct >= 90 ? 5
    : pct >= 80 ? 4
    : pct >= 70 ? 3
    : pct >= 60 ? 2
    : pct >= 50 ? 1
    : pct >= 25 ? 0.5
    : 0;
}

function strainSampleMinutes(rows, i, previousMinutes) {
  const deltaMs = rows[i + 1]?.t - rows[i].t;
  // 10 min covers the 5-minute Overview/live buckets; hour-scale gaps stay 0.
  return Number.isFinite(deltaMs) && deltaMs > 0 && deltaMs <= 600_000
    ? deltaMs / 60_000
    : (rows[i + 1] ? 0 : previousMinutes);
}

export function strainFromHr(samples, rhr = 55, maxHr = 190) {
  const rest = num(rhr) || 55;
  const reserve = Math.max((num(maxHr) || 190) - rest, 1);
  const rows = strainTimedRows(samples);
  if (!rows.length) return 0;

  let trimp = 0;
  let previousMinutes = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const minutes = strainSampleMinutes(rows, i, previousMinutes);
    previousMinutes = minutes;
    trimp += strainWeight(rows[i].bpm, rest, reserve) * minutes;
  }
  // Same Edwards TRIMP curve as the native scorer, kept on this app's 0–21 axis.
  return Math.round(clamp(21 * Math.log(trimp + 1) / Math.log(7201), 0, 21) * 10) / 10;
}

/** 5-minute V1 strain increments (same Edwards weights as strainFromHr). */
export function strainSeriesFromHr(samples, rhr = 55, maxHr = 190, bucketMs = 5 * 60_000) {
  const rest = num(rhr) || 55;
  const reserve = Math.max((num(maxHr) || 190) - rest, 1);
  const rows = strainTimedRows(samples);
  if (!rows.length) return [];
  const buckets = new Map();
  let previousMinutes = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const minutes = strainSampleMinutes(rows, i, previousMinutes);
    previousMinutes = minutes;
    const au = strainWeight(rows[i].bpm, rest, reserve) * minutes;
    if (!au) continue;
    const start = Math.floor(rows[i].t / bucketMs) * bucketMs;
    const key = new Date(start).toISOString();
    const prev = buckets.get(key) || { bucket_start: key, bucket_minutes: bucketMs / 60_000, au: 0, n: 0 };
    prev.au += au;
    prev.n += 1;
    buckets.set(key, prev);
  }
  return [...buckets.values()]
    .map((row) => ({ ...row, au: Math.round(row.au * 1000) / 1000 }))
    .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start));
}

function stageFromHr(bpm, asleepMedian, p20, p80) {
  if (!Number.isFinite(bpm) || !Number.isFinite(asleepMedian)) return 'light';
  if (bpm >= asleepMedian + 18) return 'awake';
  if (Number.isFinite(p20) && bpm <= p20) return 'deep';
  if (Number.isFinite(p80) && bpm >= p80) return 'rem';
  return 'light';
}

export function compressStages(samples, startMs, endMs) {
  const segs = [];
  for (const row of samples || []) {
    const t = sampleTime(row);
    const stage = row?.sleep_stage ?? row?.stage;
    if (!stage || stage === 'none' || t == null || t < startMs || t > endMs) continue;
    const last = segs[segs.length - 1];
    if (last && last.stage === stage) last.end = t;
    else segs.push({ stage, start: t, end: t });
  }
  for (const seg of segs) {
    if (seg.end <= seg.start) seg.end = Math.min(endMs, seg.start + 60_000);
  }
  return segs;
}

export function detectSleepWindow(samples, { now = Date.now() } = {}) {
  const rows = (samples || [])
    .map((row) => ({ t: sampleTime(row), bpm: sampleBpm(row), raw: row }))
    .filter((r) => r.t != null && r.bpm != null)
    .sort((a, b) => a.t - b.t);
  if (rows.length < 8) return null;

  const bpms = rows.map((r) => r.bpm);
  const baseline = percentile(bpms, 0.2);
  if (baseline == null) return null;
  const asleepCut = baseline + 8;
  const wakeCut = baseline + 15;

  let onset = null;
  let held = 0;
  let holdStart = null;
  for (const row of rows) {
    if (row.bpm <= asleepCut) {
      if (holdStart == null) holdStart = row.t;
      held = row.t - holdStart;
      if (held >= ASLEEP_HOLD_MS && onset == null) onset = holdStart;
    } else {
      holdStart = null;
      held = 0;
    }
  }
  if (onset == null) {
    const night = rows.filter((r) => {
      const h = new Date(r.t).getHours();
      return h >= 21 || h < 11;
    });
    if (night.length < 8) return null;
    onset = night[0].t;
  }

  let wake = rows[rows.length - 1].t;
  holdStart = null;
  for (const row of rows) {
    if (row.t < onset + ASLEEP_HOLD_MS) continue;
    if (row.bpm >= wakeCut) {
      if (holdStart == null) holdStart = row.t;
      if (row.t - holdStart >= WAKE_HOLD_MS) {
        wake = holdStart;
        break;
      }
    } else {
      holdStart = null;
    }
  }
  if (wake <= onset) wake = Math.min(now, onset + 60 * 60_000);
  return { start: onset, end: wake };
}

function minutesOf(ms) {
  return Math.max(0, Math.round(ms / 60_000));
}

function timeZoneOffsetSeconds(timeZone, atMs) {
  if (!timeZone || timeZone === 'UTC') return 0;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(atMs));
    const get = (type) => Number(parts.find((part) => part.type === type)?.value);
    const localAsUtc = Date.UTC(
      get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'),
    );
    return Math.round((localAsUtc - atMs) / 1000);
  } catch {
    return 0;
  }
}

function instantSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value > 1e12 ? value / 1000 : value);
  }
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
}

function wristOffIntervals(extras) {
  const rows = extras.wristOff || extras.wristOffIntervals || [];
  return rows.map((row) => {
    const start = instantSeconds(row?.start ?? row?.start_at);
    const rawEnd = row?.end ?? row?.end_at;
    const missingOn = row?.missing_on === true
      || rawEnd === Infinity
      || rawEnd === Number.POSITIVE_INFINITY;
    const end = missingOn ? Number.POSITIVE_INFINITY : instantSeconds(rawEnd);
    return {
      start,
      end,
      ambiguous: Boolean(row?.ambiguous || missingOn),
      missing_on: missingOn,
    };
  }).filter((row) => row.start != null && row.end != null && row.end > row.start);
}

function normalizeApiStage(stage) {
  const value = String(stage || '').toLowerCase();
  if (value === 'wake') return 'awake';
  return ['awake', 'light', 'deep', 'rem'].includes(value) ? value : 'light';
}

function roundedStageTotals(durationMs, targetMinutes) {
  const order = ['awake', 'rem', 'light', 'deep'];
  const exact = Object.fromEntries(order.map((stage) => [stage, durationMs[stage] / 60_000]));
  const totals = Object.fromEntries(order.map((stage) => [stage, Math.floor(exact[stage])]));
  let remainder = targetMinutes - order.reduce((sum, stage) => sum + totals[stage], 0);
  const ranked = [...order].sort((a, b) => (
    (exact[b] - Math.floor(exact[b])) - (exact[a] - Math.floor(exact[a]))
    || order.indexOf(a) - order.indexOf(b)
  ));
  for (let i = 0; i < remainder; i += 1) totals[ranked[i % ranked.length]] += 1;
  return totals;
}

function isDaytimeWindow(startMs, _endMs, tzOffsetSeconds) {
  // Gate on sleep *onset* local hour, not window center. A long overnight span
  // can straddle daytime hours while still starting at night; center-based
  // rejection blocked legitimate HR-only recovery for Pacific-time users.
  const onsetSec = Math.floor(startMs / 1000) + tzOffsetSeconds;
  const localSec = ((onsetSec % 86_400) + 86_400) % 86_400;
  const hour = Math.floor(localSec / 3600);
  return hour >= HR_ONLY_DAYTIME_START_HOUR && hour < HR_ONLY_DAYTIME_END_HOUR;
}

/**
 * Sleep persist states. Complete overnight is the only Overview-canonical
 * night. HR-only is provisional (visible, not a hypnogram replacement).
 */
export function sleepPersistState(night) {
  if (!night?.ok) return 'unavailable';
  if (night.isNap || night.fallbackReason === 'nap_only_day') return 'nap';
  if (night.detector === 'legacy_hr_only' || night.fallbackReason === 'insufficient_gravity_hr_only') {
    return 'provisional';
  }
  return 'complete';
}

/** Live GATT HR without strap gravity may persist a conservative overnight when IMU is absent. */
export function isPersistableOvernight(night) {
  const state = sleepPersistState(night);
  if (state === 'complete' || state === 'nap') return true;
  // HR-only is explicitly low-confidence but still yields measured RHR/HRV/Recovery
  // when RR coverage exists. Without gravity we keep waiting_for_history only when
  // detection itself failed (night.ok === false).
  if (state === 'provisional' && night?.ok) return true;
  return false;
}

function scoreSession({
  samples,
  start,
  end,
  stageSegments,
  history,
  strainYesterday,
  extras,
  confidence,
  fallbackReason,
  detector,
  provenance,
  epochProbabilities = null,
  epochCoverage = null,
  scorability = null,
  shadowV3 = null,
  unscoredMin = 0,
}) {
  const inWindow = (samples || []).filter((row) => {
    const t = sampleTime(row);
    return t != null && t >= start && t <= end;
  });
  const asleepBpms = inWindow.map(sampleBpm).filter(Number.isFinite);
  const medianHr = percentile(asleepBpms, 0.5);
  const rhr = percentile(asleepBpms, 0.1);
  const orderedStages = [...stageSegments].sort((a, b) => a.start - b.start);
  const stages = orderedStages.map((segment, index) => ({
    stage: normalizeApiStage(segment.stage),
    start: index === 0 ? start : segment.start,
    end: index === orderedStages.length - 1 ? end : orderedStages[index + 1].start,
  })).filter((segment) => segment.end > segment.start);
  const durationMs = { awake: 0, rem: 0, light: 0, deep: 0 };
  for (const segment of stages) durationMs[segment.stage] += segment.end - segment.start;
  const inBedMin = Math.max(1, minutesOf(end - start));
  // Allocate rounded minutes with a deterministic largest-remainder pass. The
  // four public totals therefore always reconcile exactly to time in bed.
  const totals = roundedStageTotals(durationMs, inBedMin);
  const asleepMin = totals.light + totals.deep + totals.rem;
  const debtMin = sleepDebtMin(history);
  const needMin = sleepNeedMin({ strainYesterday, debtMin });
  const efficiency = sleepEfficiency(asleepMin, inBedMin);
  const performance = sleepPerformance(asleepMin, needMin);
  const consistency = sleepConsistencyPct(
    [...history.map((h) => h.onsetIso).filter(Boolean), new Date(start).toISOString()],
    [...history.map((h) => h.wakeIso).filter(Boolean), new Date(end).toISOString()],
  );
  // Measured inside THIS session's window, which is why it cannot be passed in
  // from outside: the window is only known here. `extras.overnight` is optional,
  // and without it the caller's own hrv/resp values are used exactly as before.
  const overnight = typeof extras.overnight === 'function'
    ? extras.overnight({ samples: inWindow, start, end })
    : null;
  // An explicitly supplied value WINS over the measurement. It is an override,
  // and the caller that sets it knows something we do not: a historical import
  // carries WHOOP's own HRV, computed on-device from the full-rate beat series,
  // which is more authoritative than our reconstruction from throttled RR
  // notifications. The provider fills the gap; it does not overrule the source.
  const hrv = extras.hrv ?? overnight?.hrv ?? null;
  const respForRecovery = extras.resp ?? overnight?.resp ?? null;
  const respForRecord = extras.resp ?? overnight?.respMeasured ?? overnight?.resp ?? null;
  const recovery = recoveryScore({
    hrv,
    hrvBaseline: overnight?.hrvBaseline ?? extras.hrvBaseline,
    rhr,
    rhrBaseline: extras.rhrBaseline || rhr,
    sleepPerf: performance,
    resp: respForRecovery,
    respBaseline: overnight?.respBaseline ?? extras.respBaseline,
  });
  const span = end - start || 1;
  const hypnogram = stages.map((segment) => ({
    stage: segment.stage,
    x0: clamp((segment.start - start) / span, 0, 1),
    x1: clamp((segment.end - start) / span, 0, 1),
  })).filter((segment) => segment.x1 > segment.x0);
  const step = Math.max(1, Math.floor(asleepBpms.length / 48));
  return {
    ok: true,
    algorithmVersion: ALGORITHM_VERSION,
    start,
    end,
    onsetIso: new Date(start).toISOString(),
    wakeIso: new Date(end).toISOString(),
    inBedMin,
    asleepMin,
    awakeMin: totals.awake,
    lightMin: totals.light,
    deepMin: totals.deep,
    remMin: totals.rem,
    efficiency,
    performance,
    needMin,
    debtMin,
    consistency,
    overnightHr: Number.isFinite(medianHr) ? Math.round(medianHr) : null,
    restingHr: Number.isFinite(rhr) ? Math.round(rhr) : null,
    hrv: hrv ?? null,
    resp: respForRecord ?? null,
    recovery,
    disturbances: stages.filter((stage) => stage.stage === 'awake').length,
    stages,
    hypnogram,
    epochProbabilities,
    epochCoverage,
    scorability,
    shadowV3,
    unscoredMin,
    hrSpark: asleepBpms.filter((_, index) => index % step === 0).slice(0, 48),
    sampleCount: inWindow.length,
    confidence,
    fallbackReason,
    detector,
    provenance: {
      source: 'frwhoop_node',
      algorithm: 'sleep_noop_v2',
      algorithmVersion: ALGORITHM_VERSION,
      detectionVersion: DETECTION_ALGORITHM_VERSION,
      stagingVersion: STAGING_ALGORITHM_VERSION,
      confidence,
      fallbackReason,
      ...provenance,
    },
  };
}

export function scoreSleep({ samples = [], history = [], strainYesterday = 0, extras = {} } = {}) {
  const streams = extractSleepStreams(samples);
  const referenceMs = streams.hr.length ? streams.hr.at(-1).ts * 1000 : Date.now();
  const computeV3 = extras.shadowV3 === true
    || (extras.shadowV3 !== false && shouldComputeSleepV3());
  const detected = detectSleepSessions({
    ...streams,
    wristOff: wristOffIntervals(extras),
    tzOffsetSeconds: extras.tzOffsetSeconds
      ?? timeZoneOffsetSeconds(extras.timeZone || 'UTC', referenceMs),
    samples,
    imuRecords: extras.imuRecords || [],
    ppgRecords: extras.ppgRecords || [],
    events: extras.events || extras.eventRecords || [],
    shadowV3: computeV3,
    sleepV3Artifact: extras.sleepV3Artifact || null,
    allowSyntheticV3: extras.allowSyntheticV3 === true,
    placement: extras.placement || extras.wearLocation || 'unknown',
    deviceFamily: extras.deviceFamily || extras.device?.device_family || extras.device?.family || null,
    firmware: extras.firmware || extras.device?.firmware || null,
    timeZone: extras.timeZone || null,
  });
  let scoredSessions = detected.sessions.map((session) => scoreSession({
    samples,
    start: session.startSec * 1000,
    end: session.endSec * 1000,
    stageSegments: session.stages.map((segment) => ({
      ...segment,
      start: segment.start * 1000,
      end: segment.end * 1000,
    })),
    history,
    strainYesterday,
    extras,
    confidence: session.confidence,
    fallbackReason: session.fallbackReason,
    detector: session.detector,
    provenance: session.provenance,
    epochProbabilities: session.epochProbabilities || null,
    epochCoverage: session.epochCoverage || null,
    scorability: session.scorability || null,
    shadowV3: session.shadowV3 || null,
    unscoredMin: Math.round((session.shadowV3?.unscored_sec || 0) / 60),
  }));

  // The legacy HR detector remains only as an explicitly low-confidence escape
  // hatch when gravity cannot establish a one-hour analysis span.
  if (!detected.coverage.sufficient) {
    const window = detectSleepWindow(samples);
    const tzOffsetSeconds = extras.tzOffsetSeconds
      ?? timeZoneOffsetSeconds(extras.timeZone || 'UTC', referenceMs);
    // No-gravity fallback is intentionally conservative: it can recover one
    // low-confidence overnight sleep, but it never invents daytime naps.
    if (window && (window.end - window.start) >= HR_ONLY_MIN_SLEEP_MS
        && !isDaytimeWindow(window.start, window.end, tzOffsetSeconds)) {
      const inWindow = samples.filter((row) => {
        const time = sampleTime(row);
        return time != null && time >= window.start && time <= window.end;
      });
      let stages = compressStages(inWindow, window.start, window.end);
      let stagingAlgorithm = 'reported_sleep_stage';
      if (!stages.length) {
        stagingAlgorithm = 'legacy_hr_percentile';
        const bpms = inWindow.map(sampleBpm).filter(Number.isFinite);
        const medianHr = percentile(bpms, 0.5);
        const p20 = percentile(bpms, 0.2);
        const p80 = percentile(bpms, 0.8);
        stages = inWindow.map((row) => ({
          t: sampleTime(row),
          stage: stageFromHr(sampleBpm(row), medianHr, p20, p80),
        })).filter((row) => row.t != null).reduce((segments, row) => {
          const last = segments.at(-1);
          if (last?.stage === row.stage) last.end = row.t;
          else segments.push({ stage: row.stage, start: row.t, end: row.t });
          return segments;
        }, []);
        for (const segment of stages) {
          if (segment.end <= segment.start) segment.end = Math.min(window.end, segment.start + 60_000);
        }
      }
      scoredSessions = [scoreSession({
        samples,
        start: window.start,
        end: window.end,
        stageSegments: stages,
        history,
        strainYesterday,
        extras,
        confidence: 'low',
        fallbackReason: 'insufficient_gravity_hr_only',
        detector: 'legacy_hr_only',
        provenance: {
          detectionAlgorithm: 'legacy_hr_only',
          stagingAlgorithm,
          gravityAuthoritative: false,
        },
      })];
    }
  }
  // ------------------------------------------------------------------
  // Dedicated nap detection. Naps are treated as their own detection problem,
  // separate from the overnight detector. Overlap/margin exclusion against the
  // main sleep window prevents double-counting a night as a nap. On a nap-only
  // day (no detected overnight) a real nap still produces a usable result.
  // ------------------------------------------------------------------
  function buildNapSessions(mainWindow) {
    let out = [];
    try {
      const napCands = detectNaps({
        gravity: streams.gravity,
        hr: streams.hr,
        wristOff: wristOffIntervals(extras),
        bandSleepState: streams.bandSleepState,
        mainSleep: mainWindow,
        excludeWindows: scoredSessions.map((sess) => ({ startSec: sess.start / 1000, endSec: sess.end / 1000 })),
        tzOffsetSeconds: extras.tzOffsetSeconds
          ?? timeZoneOffsetSeconds(extras.timeZone || 'UTC', referenceMs),
      });
      out = napCands.map((nap) => {
        const shadowV3 = !computeV3 ? null : (() => {
          try {
            return stageSessionV3({
              start: nap.startSec,
              end: nap.endSec,
              gravity: streams.gravity,
              hr: streams.hr,
              rr: streams.rr,
              samples,
              imuRecords: extras.imuRecords || [],
              ppgRecords: extras.ppgRecords || [],
              events: extras.events || extras.eventRecords || [],
              wristOff: wristOffIntervals(extras),
              tzOffsetSeconds: extras.tzOffsetSeconds
                ?? timeZoneOffsetSeconds(extras.timeZone || 'UTC', referenceMs),
              timeZone: extras.timeZone || null,
              isNap: true,
              artifact: extras.sleepV3Artifact || null,
              allowSynthetic: extras.allowSyntheticV3 === true,
              placement: extras.placement || extras.wearLocation || 'unknown',
              deviceFamily: extras.deviceFamily || extras.device?.device_family || null,
              firmware: extras.firmware || extras.device?.firmware || null,
            });
          } catch (err) {
            return {
              ok: true,
              fallback: true,
              fallback_reason: 'inference_exception',
              v3_not_executed_reason: 'inference_exception',
              stages: [],
              error: String(err?.message || err).slice(0, 200),
            };
          }
        })();
        const session = scoreSession({
          samples,
          start: nap.startSec * 1000,
          end: nap.endSec * 1000,
          stageSegments: stageSession({
            start: nap.startSec,
            end: nap.endSec,
            gravity: streams.gravity,
            hr: streams.hr,
            rr: streams.rr,
          }).map((segment) => ({ ...segment, start: segment.start * 1000, end: segment.end * 1000 })),
          history,
          strainYesterday,
          extras,
          confidence: nap.confidence,
          fallbackReason: 'nap_detector',
          detector: nap.detector,
          provenance: {
            detectionAlgorithm: nap.detector,
            detectionVersion: 'nap-detector-v1',
            stagingAlgorithm: 'sleep_stager_v2',
            stagingVersion: STAGING_ALGORITHM_VERSION,
            napProbability: nap.probability,
            napSleepVsQuietConfidence: nap.sleepVsQuietConfidence,
            gravityAuthoritative: streams.gravity.length > 0,
            canonicalStager: 'sleep_stager_v2',
          },
          shadowV3,
          unscoredMin: Math.round((shadowV3?.unscored_sec || 0) / 60),
        });
        session.isNap = true;
        session.napProbability = nap.probability;
        session.napSleepVsQuietConfidence = nap.sleepVsQuietConfidence;
        return session;
      });
    } catch (err) { console.error('nap_detection_error', err?.message || err); }
    return out;
  }

  let main = scoredSessions.reduce(
    (best, session) => (!best || session.end - session.start > best.end - best.start ? session : best),
    null,
  );

  const napSessions = buildNapSessions(main
    ? { startSec: main.start / 1000, endSec: main.end / 1000 }
    : null);

  if (!scoredSessions.length) {
    if (!napSessions.length) {
      return {
        ok: false,
        reason: detected.coverage.sufficient
          ? 'no_sleep_sessions_detected'
          : 'insufficient_overnight_samples',
        sessions: [],
        gravityCoverage: detected.coverage,
        fallbackReason: detected.fallbackReason,
      };
    }
    // nap-only day
    main = napSessions.reduce(
      (best, s) => (!best || s.end - s.start > best.end - best.start ? s : best),
      null,
    );
    const all = [...napSessions];
    all.sort((a, b) => a.start - b.start);
    return {
      ...main,
      isNap: true,
      sessions: all,
      gravityCoverage: detected.coverage,
      fallbackReason: 'nap_only_day',
    };
  }

  for (const session of scoredSessions) session.isNap = false;
  for (const nap of napSessions) scoredSessions.push(nap);
  scoredSessions.sort((a, b) => a.start - b.start);
  for (const session of scoredSessions) {
    if (session !== main) session.isNap = session.isNap || session.start >= main.end;
    else session.isNap = false;
  }
  return {
    ...main,
    isNap: false,
    sessions: scoredSessions,
    gravityCoverage: detected.coverage,
    fallbackReason: main.fallbackReason || detected.fallbackReason,
  };
}

export function scoreDay({ samples = [], sleep = null, history = [], extras = {} } = {}) {
  const night = sleep?.ok ? sleep : scoreSleep({ samples, history, strainYesterday: extras.strainYesterday, extras });
  const strain = extras.strain != null ? num(extras.strain) : strainFromHr(samples, night?.restingHr || extras.rhr);
  const dayKey = extras.day || physiologicalDay({
    wakeIso: night?.wakeIso,
    nowIso: extras.nowIso,
    timeZone: extras.timeZone || 'UTC',
  });
  return {
    day: dayKey,
    sleep: night?.ok ? night : null,
    strain: strain || 0,
    recovery: night?.recovery ?? null,
    restingHr: night?.restingHr ?? extras.rhr ?? null,
    // Measured from the night when a provider supplied one, which is the only
    // path that has ever populated these. `extras` remains the fallback so
    // callers that supply their own values (replay, tests) are unaffected.
    hrv: night?.hrv ?? extras.hrv ?? null,
    resp: night?.resp ?? extras.resp ?? null,
    algorithmVersion: ALGORITHM_VERSION,
    computedAt: new Date().toISOString(),
  };
}

export {
  BASE_SLEEP_NEED_MIN,
  clamp,
  mean,
  percentile,
};
