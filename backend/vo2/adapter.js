import { loadWhoopDays } from '../host/whoopDays.js';
import { METHODOLOGY_VERSION } from './methodology.js';
import { ageYears, finiteNumber, lastDayOf } from './math.js';
import { calculateVo2Max } from './engine.js';

function num(v) {
  return finiteNumber(v);
}

function zoneArray(w) {
  if (Array.isArray(w.zones)) return w.zones;
  return [
    num(w['HR Zone 1 %']) || 0,
    num(w['HR Zone 2 %']) || 0,
    num(w['HR Zone 3 %']) || 0,
    num(w['HR Zone 4 %']) || 0,
    num(w['HR Zone 5 %']) || 0,
  ];
}

export function normalizeWorkout(w = {}, date) {
  return {
    id: w.id || `${date || ''}:${w.start || w['Workout start time'] || w.name || 'workout'}`,
    name: w.name || w.activityName || w['Activity name'] || 'Activity',
    start: w.start || w['Workout start time'] || null,
    end: w.end || w['Workout end time'] || null,
    durationMin: num(w.durationMin ?? w['Duration (min)']),
    avgHr: num(w.avgHr ?? w['Average HR (bpm)']),
    maxHr: num(w.maxHr ?? w['Max HR (bpm)']),
    zones: zoneArray(w),
    gpsEnabled: Boolean(w.gpsEnabled ?? w.gps_enabled ?? w['GPS enabled']),
    distanceM: num(w.distanceM ?? w.distance_m ?? w['Distance (meters)']),
    altitudeGainM: num(w.altitudeGainM ?? w.altitude_gain_m ?? w['Altitude gain (meters)']),
    samples: Array.isArray(w.samples) ? w.samples : undefined,
  };
}

export function daysFromWhoopMap(map) {
  if (Array.isArray(map)) return map;
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map).map(([day, rec]) => {
    const p = rec?.physiological_summary || rec?.physiological_summary || {};
    const s = rec?.sleep_summary || rec?.sleep_summary || {};
    return {
      day,
      recovery: rec.recovery ?? num(p['Recovery score %']),
      rhr: rec.rhr ?? num(p['Resting heart rate (bpm)']),
      hrv: rec.hrv ?? num(p['Heart rate variability (ms)']),
      asleepMin: rec.asleepMin ?? num(p['Asleep duration (min)']) ?? num(s['Asleep duration (min)']),
      sleepEfficiency: rec.sleepEfficiency ?? num(p['Sleep efficiency %']) ?? num(s['Sleep efficiency %']),
      sleepConsistency: rec.sleepConsistency ?? num(p['Sleep consistency %']) ?? num(s['Sleep consistency %']),
      steps: rec.steps ?? num(p.Steps ?? p.steps),
      maxHr: rec.maxHr ?? num(p['Max HR (bpm)']),
      workouts: (rec.workouts || []).map((w) => normalizeWorkout(w, day)),
      bpmData: rec.bpm_data || rec.bpmData || rec.bpm_data,
    };
  }).sort((a, b) => a.day.localeCompare(b.day));
}

export function normalizeDay(row) {
  if (!row) return null;
  const day = row.day || row.date;
  if (!day) return null;
  return {
    day,
    recovery: num(row.recovery),
    rhr: num(row.rhr ?? row.restingHr),
    hrv: num(row.hrv),
    asleepMin: num(row.asleepMin ?? row.asleep_min),
    sleepEfficiency: num(row.sleepEfficiency ?? row.sleep_efficiency),
    sleepConsistency: num(row.sleepConsistency ?? row.sleep_consistency),
    steps: num(row.steps),
    maxHr: num(row.maxHr ?? row.max_hr),
    workouts: (row.workouts || []).map((w) => normalizeWorkout(w, day)),
    bpmData: row.bpm_data || row.bpmData,
  };
}

export function extraWorkoutsFromStore(store = {}) {
  return (store.activities || []).map((a) => ({
    date: a.date,
    ...normalizeWorkout(a, a.date),
  }));
}

function mergeExtraWorkouts(days, extras) {
  if (!extras?.length) return days;
  const byDay = new Map(days.map((d) => [d.day, { ...d, workouts: [...(d.workouts || [])] }]));
  for (const w of extras) {
    const day = w.date || (w.start ? String(w.start).slice(0, 10) : null);
    if (!day) continue;
    if (!byDay.has(day)) {
      byDay.set(day, { day, recovery: null, rhr: null, hrv: null, workouts: [] });
    }
    byDay.get(day).workouts.push(normalizeWorkout(w, day));
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function collectDays(store) {
  if (store?.days && typeof store.days === 'object' && Object.keys(store.days).length) {
    return daysFromWhoopMap(store.days);
  }
  try {
    const mapped = daysFromWhoopMap(loadWhoopDays());
    if (mapped.length) return mapped;
  } catch { /* ignore */ }
  return [];
}

export function resolveWeightKg(profile = {}, weightHistory = [], asOfDay) {
  const hist = (weightHistory || [])
    .filter((h) => finiteNumber(h.kg) != null && (!asOfDay || !h.at || String(h.at).slice(0, 10) <= asOfDay))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const ok = [...hist].reverse().find((h) => h.quality !== 'reject' && h.quality !== 'suspect');
  if (ok) return finiteNumber(ok.kg);
  return finiteNumber(profile.weightKg ?? profile.weight_kg);
}

export function profileFromStore(store = {}, asOfDay) {
  const p = store.profile || {};
  const birthYear = finiteNumber(p.birthYear ?? p.birth_year);
  return {
    birthYear,
    sex: p.sex || null,
    heightCm: finiteNumber(p.heightCm ?? p.height_cm),
    weightKg: resolveWeightKg(p, store.vo2?.weightHistory, asOfDay),
    age: ageYears(birthYear, asOfDay),
    hrMax: finiteNumber(p.hrMax ?? p.maxHr),
  };
}

export function computeVo2FromData({
  days,
  profile = {},
  extraWorkouts = [],
  labAnchors = [],
  hrMaxOverride,
  priorSnapshot,
  asOfDay,
  methodologyVersion = METHODOLOGY_VERSION,
  calculatedAt,
} = {}) {
  const merged = mergeExtraWorkouts(days || [], extraWorkouts);
  const asOf = asOfDay || lastDayOf(merged);
  return calculateVo2Max({
    days: merged,
    profile: {
      ...profile,
      age: profile.age ?? ageYears(profile.birthYear, asOf),
    },
    labAnchors,
    hrMaxOverride,
    priorSnapshot,
    asOfDay: asOf,
    methodologyVersion,
  }, { calculatedAt });
}
