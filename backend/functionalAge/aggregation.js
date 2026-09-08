import { addDays, clamp, finiteNumber, mean, median, trimmedMean } from './math.js';
import { getMethodology, METHODOLOGY_VERSION } from './methodology.js';
import { isValidRecovery } from './calibration.js';

export const STRENGTH_NAME_RE = /weightlift|powerlift|strength trainer|strength|barre3|\bbarre\b|pilates|\byoga\b|hot yoga|functional fitness|barry'?s|\bf45\b|box fitness|\bhiit\b|baby wearing|toddler wearing|\bruck|solidcore/i;

export function isStrengthActivity(name) {
  return STRENGTH_NAME_RE.test(String(name || ''));
}

export function workoutDurationMin(w) {
  const direct = finiteNumber(w?.durationMin ?? w?.['Duration (min)'] ?? w?.duration_min);
  if (direct != null && direct > 0) return direct;
  const seconds = finiteNumber(w?.duration_s ?? w?.durationS ?? w?.['Duration (s)']);
  if (seconds != null && seconds > 0) return seconds / 60;
  return 0;
}

export function zoneMinutesFromWorkout(w) {
  const dur = workoutDurationMin(w);
  let zones = w?.zones;
  if (!Array.isArray(zones)) {
    zones = [1, 2, 3, 4, 5].map((z) => Number(w?.[`HR Zone ${z} %`]) || 0);
  }
  const mins = [0, 0, 0, 0, 0];
  if (dur <= 0) return mins;
  for (let i = 0; i < 5; i += 1) mins[i] = dur * ((Number(zones[i]) || 0) / 100);
  return mins;
}

export function workoutsOf(day) {
  if (Array.isArray(day?.workouts)) return day.workouts;
  if (Array.isArray(day?.physiological_summary?.workouts)) return day.physiological_summary.workouts;
  return [];
}

export function phys(day) {
  return day?.physiological_summary && typeof day.physiological_summary === 'object'
    ? day.physiological_summary
    : {};
}

export function sleep(day) {
  return day?.sleep_summary && typeof day.sleep_summary === 'object'
    ? day.sleep_summary
    : {};
}

export function dayValue(day, ...keys) {
  for (const key of keys) {
    if (day?.[key] != null && day[key] !== '') {
      const n = finiteNumber(day[key]);
      if (n != null) return n;
    }
  }
  const p = phys(day);
  const s = sleep(day);
  for (const key of keys) {
    if (p[key] != null && p[key] !== '') {
      const n = finiteNumber(p[key]);
      if (n != null) return n;
    }
    if (s[key] != null && s[key] !== '') {
      const n = finiteNumber(s[key]);
      if (n != null) return n;
    }
  }
  return null;
}

export function isNap(day) {
  if (day?.nap === true || sleep(day).Nap === true) return true;
  const flag = dayValue(day, 'nap');
  if (flag === 1) return true;
  return false;
}

export function validSleepHours(day, cal) {
  if (isNap(day)) return null;
  const min = dayValue(day, 'asleepMin', 'Asleep duration (min)', 'sleep_total_min');
  if (min == null || min < cal.minValidSleepMin || min > cal.maxValidSleepMin) return null;
  return min / 60;
}

export function validSleepConsistency(day) {
  const n = dayValue(day, 'sleepConsistency', 'Sleep consistency %', 'sleep_consistency');
  if (n == null || n <= 0 || n > 100) return null;
  return n;
}

export function validRhr(day, cal) {
  const n = dayValue(day, 'rhr', 'Resting heart rate (bpm)', 'resting_hr_bpm');
  if (n == null || n < cal.minValidRhr || n > cal.maxValidRhr) return null;
  return n;
}

export function validSteps(day, cal) {
  const n = dayValue(day, 'steps', 'Steps');
  if (n == null || n < cal.minValidSteps || n > cal.maxValidSteps) return null;
  return n;
}

export function validVo2(day, cal) {
  const n = dayValue(day, 'vo2max', 'vo2Max', 'VO2 Max');
  if (n == null || n < cal.minValidVo2 || n > cal.maxValidVo2) return null;
  return n;
}

export function validLbmPct(day, cal) {
  const direct = dayValue(day, 'leanBodyMassPct', 'lean_body_mass_pct');
  if (direct != null && direct >= cal.minValidLbm && direct <= cal.maxValidLbm) return direct;
  const fat = dayValue(day, 'bodyFatPct', 'body_fat_pct', 'Body fat %');
  if (fat != null && fat >= 5 && fat <= 60) {
    const lbm = 100 - fat;
    if (lbm >= cal.minValidLbm && lbm <= cal.maxValidLbm) return lbm;
  }
  const leanKg = dayValue(day, 'leanMassKg', 'lean_mass_kg');
  const weight = dayValue(day, 'weightKg', 'weight_kg');
  if (leanKg != null && weight > 0) {
    const lbm = (leanKg / weight) * 100;
    if (lbm >= cal.minValidLbm && lbm <= cal.maxValidLbm) return lbm;
  }
  return null;
}

export function sliceWindow(days, asOfDay, windowDays) {
  const start = addDays(asOfDay, -(windowDays - 1));
  return (days || []).filter((d) => d?.day && d.day >= start && d.day <= asOfDay);
}

function robust(values, methodology) {
  return trimmedMean(values, methodology.aggregation.trimFraction, methodology.aggregation.minTrimN);
}

function weeklyFromDailyMinutes(totalMinutes, windowDays) {
  if (!(windowDays > 0)) return 0;
  return (totalMinutes / windowDays) * 7;
}

export function aggregateWindow(days, extraWorkouts = [], options = {}) {
  const version = options.methodologyVersion || METHODOLOGY_VERSION;
  const m = getMethodology(version);
  const cal = m.calibration;
  const windowDays = options.windowDays || m.windows.historicalDays;
  const asOfDay = options.asOfDay;
  const sliced = asOfDay ? sliceWindow(days, asOfDay, windowDays) : (days || []);
  const extras = extraWorkouts.filter((w) => {
    const day = w.date || (w.start || '').slice(0, 10);
    if (!asOfDay) return true;
    const start = addDays(asOfDay, -(windowDays - 1));
    return day >= start && day <= asOfDay;
  });

  const sleepHours = [];
  const consistency = [];
  const steps = [];
  const rhr = [];
  const vo2 = [];
  const lbm = [];
  let zone13 = 0;
  let zone45 = 0;
  let strengthMin = 0;
  let validSleepDays = 0;
  let validStepDays = 0;
  let validHrDays = 0;
  let validRecoveryDays = 0;
  let vo2Days = 0;
  let lbmDays = 0;
  const activityDays = new Set();

  const addWorkout = (w, dayKey) => {
    const mins = zoneMinutesFromWorkout(w);
    zone13 += mins[0] + mins[1] + mins[2];
    zone45 += mins[3] + mins[4];
    const name = w.name || w['Activity name'] || '';
    const dur = workoutDurationMin(w);
    if (isStrengthActivity(name) && dur > 0 && dur <= 300) {
      strengthMin += dur;
      if (dayKey) activityDays.add(dayKey);
    } else if (mins.some((n) => n > 0) && dayKey) {
      activityDays.add(dayKey);
    }
  };

  for (const day of sliced) {
    const sh = validSleepHours(day, cal);
    if (sh != null) {
      sleepHours.push(sh);
      validSleepDays += 1;
    }
    const sc = validSleepConsistency(day);
    if (sc != null) consistency.push(sc);
    const st = validSteps(day, cal);
    if (st != null) {
      steps.push(st);
      validStepDays += 1;
    }
    const hr = validRhr(day, cal);
    if (hr != null) {
      rhr.push(hr);
      validHrDays += 1;
    }
    const v = validVo2(day, cal);
    if (v != null) {
      vo2.push(v);
      vo2Days += 1;
    }
    const body = validLbmPct(day, cal);
    if (body != null) {
      lbm.push(body);
      lbmDays += 1;
    }
    if (isValidRecovery(day.recovery ?? dayValue(day, 'Recovery score %', 'charge'))) {
      validRecoveryDays += 1;
    }
    for (const w of workoutsOf(day)) addWorkout(w, day.day);
  }
  for (const w of extras) addWorkout(w, w.date || (w.start || '').slice(0, 10));

  const observed = sliced.length;
  const calendarDays = windowDays;
  const weeksObserved = calendarDays / 7;
  const validActivityWeeks = activityDays.size ? Math.max(1, Math.round(activityDays.size / 7)) : 0;

  const metrics = {
    sleepDurationHours: robust(sleepHours, m),
    sleepConsistencyPct: robust(consistency, m),
    stepsPerDay: robust(steps, m),
    zone13MinPerWeek: weeklyFromDailyMinutes(zone13, calendarDays),
    zone45MinPerWeek: weeklyFromDailyMinutes(zone45, calendarDays),
    strengthMinPerWeek: weeklyFromDailyMinutes(strengthMin, calendarDays),
    vo2Max: median(vo2) ?? mean(vo2),
    restingHrBpm: median(rhr) ?? robust(rhr, m),
    leanBodyMassPct: median(lbm) ?? mean(lbm),
  };

  const confidence = {
    sleep_duration: clamp(validSleepDays / Math.max(14, calendarDays * 0.5), 0, 1),
    sleep_consistency: clamp(consistency.length / Math.max(14, calendarDays * 0.5), 0, 1),
    steps: steps.length ? clamp(validStepDays / Math.max(14, calendarDays * 0.5), 0, 1) : 0,
    moderate_activity: clamp(observed / calendarDays, 0, 1),
    vigorous_activity: clamp(observed / calendarDays, 0, 1),
    strength: clamp(observed / calendarDays, 0, 1),
    vo2_max: vo2Days ? clamp(vo2Days / Math.max(3, calendarDays / 30), 0, 1) : 0,
    rhr: clamp(validHrDays / Math.max(14, calendarDays * 0.5), 0, 1),
    lean_body_mass: lbmDays ? 0.85 : 0,
  };

  return {
    metrics,
    confidence,
    counts: {
      daysObserved: observed,
      calendarDays,
      weeksObserved,
      validSleepDays,
      validStepDays,
      validHrDays,
      validRecoveryDays,
      validActivityWeeks,
      vo2Coverage: vo2Days ? 1 : 0,
      bodyCompositionCoverage: lbmDays ? 1 : 0,
      sleepNights: sleepHours.length,
      consistencyNights: consistency.length,
      rhrDays: rhr.length,
      vo2Days,
      lbmDays,
    },
    totals: { zone13, zone45, strengthMin },
  };
}
