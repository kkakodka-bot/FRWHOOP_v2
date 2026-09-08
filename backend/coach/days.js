import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultIndexPath = path.join(here, '../data/coach-days.json');

let cache = null;

export function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

/** Same bands as whoopMetrics.suggestedDayStrain. Coaching context only. */
export function suggestedDayStrain(recovery) {
  const r = Math.max(0, Math.min(100, Number(recovery) || 0));
  if (r < 34) return round1(4 + (r / 34) * 5);
  if (r < 67) return round1(9 + ((r - 34) / 33) * 3);
  return round1(10.5 + ((r - 67) / 33) * 4.6);
}

export function addDays(isoDay, delta) {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function clampRange(fromDay, toDay, maxDays = 90) {
  if (!fromDay && !toDay) return { fromDay: null, toDay: null };
  let from = fromDay;
  let to = toDay;
  if (from && to && from > to) [from, to] = [to, from];
  if (from && to) {
    const span = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
    if (span > maxDays) from = addDays(to, -(maxDays - 1));
  }
  return { fromDay: from, toDay: to };
}

export function loadDayIndex(indexPath = defaultIndexPath) {
  if (cache && indexPath === defaultIndexPath) return cache;
  const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const days = Array.isArray(raw) ? raw : raw.days;
  if (!Array.isArray(days)) throw new Error('coach day index missing days');
  const byDay = new Map(days.map((row) => [row.day, row]));
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const index = {
    days: sorted,
    byDay,
    firstDay: sorted[0]?.day || null,
    lastDay: sorted[sorted.length - 1]?.day || null,
  };
  if (indexPath === defaultIndexPath) cache = index;
  return index;
}

export function resetDayIndexCache() {
  cache = null;
}

export function sliceDays(index, { fromDay, toDay, limit = 14, before } = {}) {
  let rows = index.days;
  if (fromDay) rows = rows.filter((r) => r.day >= fromDay);
  if (toDay) rows = rows.filter((r) => r.day <= toDay);
  if (before) rows = rows.filter((r) => r.day < before);
  rows = [...rows].sort((a, b) => b.day.localeCompare(a.day));
  return rows.slice(0, Math.max(1, Math.min(366, Number(limit) || 14)));
}

export function getDay(index, day) {
  if (!day) return index.days[index.days.length - 1] || null;
  return index.byDay.get(day) || null;
}

export function cloudRowToDay(row) {
  if (!row) return null;
  const day = row.day || row.metrics?.day;
  const m = row.metrics || row;
  return {
    day,
    recovery: num(m.charge ?? m.recovery),
    strain: num(m.effort ?? m.strain),
    hrv: num(m.hrv_rmssd_ms ?? m.hrv),
    rhr: num(m.resting_hr_bpm ?? m.rhr),
    resp: num(m.resp_rate_bpm ?? m.resp),
    spo2: num(m.spo2_pct ?? m.spo2),
    calories: num(m.active_kcal ?? m.calories),
    avgHr: num(m.avg_hr_bpm ?? m.avgHr),
    sleepPerformance: num(m.rest ?? m.sleepPerformance),
    sleepEfficiency: num(m.sleep_efficiency ?? m.sleepEfficiency),
    asleepMin: num(m.sleep_total_min ?? m.asleepMin),
    inBedMin: num(m.sleep_in_bed_min ?? m.inBedMin),
    deepMin: num(m.sleep_deep_min ?? m.deepMin),
    remMin: num(m.sleep_rem_min ?? m.remMin),
    lightMin: num(m.sleep_light_min ?? m.lightMin),
    awakeMin: num(m.sleep_awake_min ?? m.awakeMin),
    sleepNeedMin: num(m.sleep_need_min ?? m.sleepNeedMin),
    sleepDebtMin: num(m.sleep_debt_balance_min ?? m.sleepDebtMin),
    sleepOnset: m.sleep_onset_at || m.sleepOnset || null,
    wakeOnset: m.wake_onset_at || m.wakeOnset || null,
    sleepConsistency: num(m.sleep_consistency ?? m.sleepConsistency),
    steps: num(m.steps),
    vo2max: num(m.vo2max ?? m.vo2Max),
    bodyFatPct: num(m.body_fat_pct ?? m.bodyFatPct),
    leanMassKg: num(m.lean_mass_kg ?? m.leanMassKg),
    weightKg: num(m.weight_kg ?? m.weightKg),
    maxHr: num(m.max_hr_bpm ?? m.maxHr),
    workouts: Array.isArray(row.sessions)
      ? row.sessions.filter((s) => /workout/i.test(s.kind || '')).map(sessionToWorkout)
      : row.workouts || [],
    events: row.events || [],
    source: row.source || 'cloud',
  };
}

function sessionToWorkout(s) {
  const summary = s.summary && typeof s.summary === 'object' ? s.summary : {};
  const fromMin = num(summary.duration_min);
  const fromS = num(summary.duration_s);
  const durationMin = (fromMin != null && fromMin > 0)
    ? fromMin
    : (fromS != null ? fromS / 60 : null);
  let zones = summary.zones;
  if (!Array.isArray(zones) && Array.isArray(s.segments) && s.segments.length >= 5 && typeof s.segments[0] === 'number') {
    zones = s.segments.slice(0, 5);
  }
  const samples = Array.isArray(s.samples)
    ? s.samples
    : (Array.isArray(summary.samples) ? summary.samples : undefined);
  return {
    name: summary.sport || s.kind || 'workout',
    start: s.start_at,
    end: s.end_at,
    durationMin,
    strain: num(summary.strain ?? summary.effort),
    calories: num(summary.calories_kcal ?? summary.calories),
    avgHr: num(summary.avg_hr ?? summary.avgHr),
    maxHr: num(summary.peak_hr ?? summary.maxHr),
    zones: Array.isArray(zones) ? zones : [0, 0, 0, 0, 0],
    gpsEnabled: Boolean(summary.gps ?? summary.gps_enabled ?? summary.gpsEnabled),
    distanceM: num(summary.distance_m ?? summary.distanceM ?? summary.distance_meters),
    altitudeGainM: num(summary.altitude_gain_m ?? summary.altitudeGainM ?? summary.elevation_gain_m),
    samples,
    userModified: Boolean(s.user_modified),
  };
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
