import { loadDayIndex } from '../coach/days.js';
import { dayBounds, localDateKey } from '../time/dayBoundary.js';
import { recoveryScore, sleepPerformance, strainFromHr } from '../metrics/sleep.js';
import { unionBpmData } from '../metrics/buckets.js';

const ZONE_KEYS = [
  'HR Zone 1 %',
  'HR Zone 2 %',
  'HR Zone 3 %',
  'HR Zone 4 %',
  'HR Zone 5 %',
];

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Coach index row → frontend WHOOP day record (no bpm_data; local fixture keeps that). */
export function coachRowToWhoopDay(row) {
  if (!row) return null;
  const phys = {
    'Recovery score %': num(row.recovery),
    'Resting heart rate (bpm)': num(row.rhr),
    'Heart rate variability (ms)': num(row.hrv),
    'Skin temp (celsius)': num(row.skinTemp),
    'Blood oxygen %': num(row.spo2),
    'Day Strain': num(row.strain),
    'Energy burned (cal)': num(row.calories),
    'Max HR (bpm)': num(row.maxHr),
    'Average HR (bpm)': num(row.avgHr),
    'Sleep onset': row.sleepOnset || null,
    'Wake onset': row.wakeOnset || null,
    'Sleep performance %': num(row.sleepPerformance),
    'Respiratory rate (rpm)': num(row.resp),
    'Asleep duration (min)': num(row.asleepMin),
    'In bed duration (min)': num(row.inBedMin),
    'Light sleep duration (min)': num(row.lightMin),
    'Deep (SWS) duration (min)': num(row.deepMin),
    'REM duration (min)': num(row.remMin),
    'Awake duration (min)': num(row.awakeMin),
    'Sleep need (min)': num(row.sleepNeedMin),
    'Sleep debt (min)': num(row.sleepDebtMin),
    'Sleep efficiency %': num(row.sleepEfficiency),
    'Sleep consistency %': num(row.sleepConsistency),
    Steps: num(row.steps),
    'VO2 Max': num(row.vo2max ?? row.vo2Max),
    'Body fat %': num(row.bodyFatPct),
  };
  const sleep = {
    'Sleep onset': row.sleepOnset || null,
    'Wake onset': row.wakeOnset || null,
    'Sleep performance %': num(row.sleepPerformance),
    'Respiratory rate (rpm)': num(row.resp),
    'Asleep duration (min)': num(row.asleepMin),
    'In bed duration (min)': num(row.inBedMin),
    'Light sleep duration (min)': num(row.lightMin),
    'Deep (SWS) duration (min)': num(row.deepMin),
    'REM duration (min)': num(row.remMin),
    'Awake duration (min)': num(row.awakeMin),
    'Sleep need (min)': num(row.sleepNeedMin),
    'Sleep debt (min)': num(row.sleepDebtMin),
    'Sleep efficiency %': num(row.sleepEfficiency),
    'Sleep consistency %': num(row.sleepConsistency),
    Nap: Boolean(row.nap),
  };
  const workouts = (Array.isArray(row.workouts) ? row.workouts : []).map((w) => {
    const zones = Array.isArray(w.zones) ? w.zones : [0, 0, 0, 0, 0];
    const gpsEnabled = Boolean(w.gpsEnabled ?? w.gps_enabled ?? w['GPS enabled']);
    const distanceM = num(w.distanceM ?? w.distance_m ?? w['Distance (meters)']);
    const altitudeGainM = num(w.altitudeGainM ?? w.altitude_gain_m ?? w['Altitude gain (meters)']);
    const mapped = {
      'Workout start time': w.start || null,
      'Workout end time': w.end || null,
      'Duration (min)': num(w.durationMin),
      'Activity name': w.name || 'Activity',
      'Activity Strain': num(w.strain),
      'Energy burned (cal)': num(w.calories),
      'Max HR (bpm)': num(w.maxHr),
      'Average HR (bpm)': num(w.avgHr),
      'GPS enabled': gpsEnabled,
      'Distance (meters)': distanceM,
      'Altitude gain (meters)': altitudeGainM,
      name: w.name || 'Activity',
      durationMin: num(w.durationMin),
      strain: num(w.strain),
      gpsEnabled,
      distanceM,
      altitudeGainM,
    };
    if (Array.isArray(w.samples)) mapped.samples = w.samples;
    ZONE_KEYS.forEach((key, i) => {
      mapped[key] = num(zones[i]) || 0;
    });
    return mapped;
  });
  return {
    physiological_summary: phys,
    sleep_summary: sleep,
    workouts,
  };
}

export function daysMapFromIndex(index = loadDayIndex()) {
  const days = {};
  for (const row of index.days || []) {
    if (!row?.day) continue;
    days[row.day] = coachRowToWhoopDay(row);
  }
  return days;
}

export function loadWhoopDays() {
  return {};
}

export function todayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function mergeBpmSamples(days, samples) {
  if (!Array.isArray(samples) || !samples.length) return days;
  const next = { ...days };
  for (const sample of samples) {
    const bpm = Number(sample.bpm ?? sample.heartRate);
    if (!Number.isFinite(bpm)) continue;
    const at = sample.datetime || sample.at || new Date().toISOString();
    const key = String(at).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    const prev = next[key] || {};
    const rows = Array.isArray(prev.bpm_data) ? prev.bpm_data.slice() : [];
    rows.push({ datetime: at, bpm, sleep_stage: sample.sleep_stage || undefined });
    next[key] = {
      ...prev,
      bpm_data: rows.slice(-30000),
      physiological_summary: { ...(prev.physiological_summary || {}) },
    };
  }
  return next;
}

export function mergeLiveIntoDays(days, live) {
  if (!live) return days;
  // Never dump the live buffer into Overview — that was a multi-MB /api/days payload.
  if (live.heartRate == null || !Number.isFinite(Number(live.heartRate))) return days;
  return mergeBpmSamples(days, [{ datetime: live.at || new Date().toISOString(), bpm: Number(live.heartRate) }]);
}

function localMinuteOfDay(at, timeZone) {
  const day = localDateKey(at, timeZone);
  if (!day) return null;
  try {
    const start = Date.parse(dayBounds(day, timeZone).day_start_at);
    const t = Date.parse(at);
    if (!Number.isFinite(start) || !Number.isFinite(t)) return null;
    return Math.max(0, Math.min(1439, Math.floor((t - start) / 60000)));
  } catch {
    return null;
  }
}

/** 5-minute HR buckets so Overview has a 24h curve without shipping the raw live buffer. */
export function downsampleBpmSamples(samples, { bucketMin = 5, timeZone = 'UTC' } = {}) {
  const buckets = new Map();
  for (const sample of samples || []) {
    const bpm = Number(sample.bpm ?? sample.heartRate);
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 240) continue;
    const at = sample.datetime || sample.at || sample.t;
    if (!at) continue;
    const day = localDateKey(at, timeZone);
    if (!day) continue;
    const mins = localMinuteOfDay(at, timeZone);
    if (mins == null) continue;
    const bucket = Math.floor(mins / bucketMin);
    const key = `${day}|${bucket}`;
    const prev = buckets.get(key);
    const t = Date.parse(at);
    if (prev && Number.isFinite(t) && t < Date.parse(prev.datetime)) continue;
    buckets.set(key, {
      datetime: typeof at === 'string' ? at : new Date(t).toISOString(),
      bpm: Math.round(bpm),
      sleep_stage: sample.sleep_stage || undefined,
    });
  }
  const byDay = {};
  for (const [key, point] of buckets) {
    const day = key.slice(0, 10);
    (byDay[day] ||= []).push(point);
  }
  for (const rows of Object.values(byDay)) {
    rows.sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
  }
  return byDay;
}

export function mergeLiveSeriesIntoDays(days, samples, timeZone = 'UTC') {
  const byDay = downsampleBpmSamples(samples, { timeZone });
  let next = days || {};
  for (const [day, rows] of Object.entries(byDay)) {
    if (!rows.length) continue;
    next = overlayPersistedDays(next, { [day]: { bpm_data: rows } });
  }
  return next;
}

function finiteHr(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 20 && n <= 240 ? n : null;
}

/** HealthKit cache (Watch RHR, fallback sleep). Watch steps stay off Steps. */
export function overlayHealthKitStore(days, healthkit = {}, timeZone = 'UTC') {
  const extrasDays = { ...(healthkit.days || {}) };
  for (const m of healthkit.measurements || []) {
    if (m?.metric_type !== 'resting_heart_rate') continue;
    const day = localDateKey(m.metadata?.end_time || m.measured_at || m.metadata?.start_time, timeZone)
      || String(m.metadata?.end_time || m.measured_at || '').slice(0, 10);
    const bpm = finiteHr(m.value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || bpm == null) continue;
    extrasDays[day] = { ...(extrasDays[day] || { day }), resting_hr: bpm };
  }
  const overlays = {};
  for (const [day, extras] of Object.entries(extrasDays)) {
    if (!extras || typeof extras !== 'object') continue;
    const prev = days?.[day]?.physiological_summary || {};
    const phys = {};
    if (prev['Resting heart rate (bpm)'] == null && finiteHr(extras.resting_hr) != null) {
      phys['Resting heart rate (bpm)'] = Math.round(Number(extras.resting_hr));
    }
    if (prev['Heart rate variability (ms)'] == null && Number(extras.hrv_sdnn) > 0) {
      phys['Heart rate variability (ms)'] = Number(extras.hrv_sdnn);
    }
    if (prev['Respiratory rate (rpm)'] == null && Number(extras.resp_rate) > 0) {
      phys['Respiratory rate (rpm)'] = Number(extras.resp_rate);
    }
    if (Object.keys(phys).length) overlays[day] = { physiological_summary: phys };
  }
  const byWake = {};
  for (const session of healthkit.sessions || []) {
    if (!/sleep/i.test(String(session.kind || ''))) continue;
    const start = session.start_at || session.summary?.start;
    const end = session.end_at || session.summary?.end;
    const wake = localDateKey(end || start, timeZone);
    if (!wake) continue;
    const stated = Number(session.summary?.asleep_min);
    const elapsed = (Date.parse(end) - Date.parse(start)) / 60000;
    const min = Number.isFinite(stated) && stated > 0 ? stated : elapsed;
    if (!Number.isFinite(min) || min < 30) continue;
    const prev = byWake[wake];
    if (!prev || min > prev.min) byWake[wake] = { min, start, end };
  }
  for (const [day, night] of Object.entries(byWake)) {
    const prev = days?.[day]?.physiological_summary || {};
    if (prev['Asleep duration (min)'] != null) continue;
    const phys = {
      'Asleep duration (min)': Math.round(night.min),
      'In bed duration (min)': Math.round(night.min),
      'Sleep onset': night.start || null,
      'Wake onset': night.end || null,
    };
    overlays[day] = {
      ...(overlays[day] || {}),
      physiological_summary: { ...(overlays[day]?.physiological_summary || {}), ...phys },
      sleep_summary: { ...(overlays[day]?.sleep_summary || {}), ...phys, Nap: false },
    };
  }
  return overlayPersistedDays(days, overlays);
}

function median(values) {
  const list = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/**
 * Fill Overview recovery/strain when the engine row is missing a headline.
 * Overnight WHOOP samples often never land (HR-only night not persistable, or
 * a gap in the live file). The vitals already on the day are enough to score
 * the scalar. Upgrade: history backfill so persistComputed owns both numbers.
 */
export function fillHeadlineScores(days = {}) {
  const rows = Object.values(days || {});
  const hrvBase = median(rows.map((d) => Number(d?.physiological_summary?.['Heart rate variability (ms)'])));
  const rhrBase = median(rows.map((d) => Number(d?.physiological_summary?.['Resting heart rate (bpm)'])));
  const respBase = median(rows.map((d) => Number(d?.physiological_summary?.['Respiratory rate (rpm)'])));
  const next = { ...days };
  for (const [key, day] of Object.entries(days || {})) {
    if (!day || typeof day !== 'object') continue;
    const phys = { ...(day.physiological_summary || {}) };
    const sleep = { ...(day.sleep_summary || {}) };
    const series = Array.isArray(day.bpm_data) ? day.bpm_data : [];
    let changed = false;
    // Watch sleep alone must not invent a recovery ring for empty weekdays.
    if (phys['Recovery score %'] == null && series.length >= 2) {
      const asleep = Number(phys['Asleep duration (min)'] ?? sleep['Asleep duration (min)']);
      const need = Number(phys['Sleep need (min)'] ?? sleep['Sleep need (min)']) || 480;
      if (Number.isFinite(asleep) && asleep >= 180) {
        const rec = recoveryScore({
          hrv: phys['Heart rate variability (ms)'],
          hrvBaseline: hrvBase,
          rhr: phys['Resting heart rate (bpm)'],
          rhrBaseline: rhrBase,
          sleepPerf: sleepPerformance(asleep, need),
          resp: phys['Respiratory rate (rpm)'],
          respBaseline: respBase,
        });
        if (rec != null) {
          phys['Recovery score %'] = rec;
          sleep['Recovery score %'] = rec;
          changed = true;
        }
      }
    }
    const existingStrain = phys['Day Strain'];
    if (existingStrain == null && series.length >= 2) {
      const strain = strainFromHr(series, phys['Resting heart rate (bpm)']);
      if (strain != null) {
        phys['Day Strain'] = strain;
        sleep['Day Strain'] = strain;
        changed = true;
      }
    }
    if (changed) next[key] = { ...day, physiological_summary: phys, sleep_summary: sleep };
  }
  return next;
}

/** Keep earlier numbers when a later overlay sends explicit nulls. First write of a missing key stays null. */
export function mergeDefined(base = {}, patch = {}) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value != null) out[key] = value;
    else if (!(key in out)) out[key] = null;
  }
  return out;
}

function longerSeries(left, right) {
  return unionBpmData(left, right);
}

export function overlayPersistedDays(days, persisted) {
  if (!persisted || typeof persisted !== 'object') return days;
  const next = { ...days };
  for (const [key, patch] of Object.entries(persisted)) {
    if (!patch || typeof patch !== 'object') continue;
    const prev = next[key] || {};
    next[key] = {
      ...prev,
      ...patch,
      physiological_summary: mergeDefined(prev.physiological_summary, patch.physiological_summary),
      sleep_summary: mergeDefined(prev.sleep_summary, patch.sleep_summary),
      workouts: Array.isArray(patch.workouts) && patch.workouts.length ? patch.workouts : (prev.workouts || []),
      bpm_data: longerSeries(prev.bpm_data, patch.bpm_data),
      strain_series: (patch.strain_series?.length ? patch.strain_series : prev.strain_series) || [],
      skin_temp_series: (patch.skin_temp_series?.length ? patch.skin_temp_series : prev.skin_temp_series) || [],
      spo2_candidate_series: (patch.spo2_candidate_series?.length ? patch.spo2_candidate_series : prev.spo2_candidate_series) || [],
      spo2_candidate_pct: patch.spo2_candidate_pct ?? prev.spo2_candidate_pct ?? null,
      spo2_source: patch.spo2_source || prev.spo2_source || null,
      strain_v2: (patch.strain_v2 && typeof patch.strain_v2 === 'object') ? patch.strain_v2 : (prev.strain_v2 || null),
      availability: patch.availability || prev.availability || null,
    };
  }
  return next;
}
