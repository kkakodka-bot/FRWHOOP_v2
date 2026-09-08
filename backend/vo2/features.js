import { getMethodology } from './methodology.js';
import { addDays, bmi, cv, finiteNumber, linregSlope, mean, median, percentile } from './math.js';

function inWindow(day, asOfDay, windowDays) {
  if (!day?.day || !asOfDay) return false;
  const start = addDays(asOfDay, -(windowDays - 1));
  return day.day >= start && day.day <= asOfDay;
}

export function zoneMinutes(workout) {
  const dur = finiteNumber(workout?.durationMin) || 0;
  let zones = workout?.zones;
  if (!Array.isArray(zones)) {
    zones = [1, 2, 3, 4, 5].map((z) => Number(workout?.[`hrZone${z}Pct`]) || Number(workout?.[`HR Zone ${z} %`]) || 0);
  }
  return (zones || [0, 0, 0, 0, 0]).slice(0, 5).map((z) => dur * ((Number(z) || 0) / 100));
}

function isIdleActivity(label) {
  return /sleep|idle|rest|none|still|sedentary/i.test(String(label || ''));
}

export function physicalActivityRating(features) {
  let score = 0;
  if (features.medianSteps != null) {
    if (features.medianSteps >= 4000) score += 1;
    if (features.medianSteps >= 7000) score += 1;
    if (features.medianSteps >= 10000) score += 1;
  }
  if ((features.workoutsPerWeek || 0) >= 2) score += 1;
  if ((features.workoutsPerWeek || 0) >= 4) score += 1;
  if ((features.zone13MinPerWeek || 0) + (features.zone45MinPerWeek || 0) >= 75) score += 1;
  if ((features.zone45MinPerWeek || 0) >= 40) score += 1;
  return Math.max(0, Math.min(7, score));
}

function freeLivingHrResponse(days, asOfDay, windowDays) {
  const hrs = [];
  for (const day of days || []) {
    if (!inWindow(day, asOfDay, windowDays)) continue;
    for (const s of day.bpmData || []) {
      const hr = finiteNumber(s.bpm ?? s.hr);
      if (hr == null) continue;
      if (isIdleActivity(s.activity ?? s.sleepStage ?? s.sleep_stage)) continue;
      if (/walk|run|active|move/i.test(String(s.activity || ''))) hrs.push(hr);
    }
  }
  if (hrs.length < 20) return null;
  return median(hrs);
}

export function extractPassiveFeatures({
  days = [],
  asOfDay,
  profile = {},
  age,
  version,
} = {}) {
  const m = getMethodology(version);
  const windowDays = m.windows.featureDays;
  const rhr = [];
  const hrv = [];
  const sleepMin = [];
  const efficiency = [];
  const consistency = [];
  const steps = [];
  let zone13 = 0;
  let zone45 = 0;
  let workoutCount = 0;
  let observedDays = 0;

  for (const day of days || []) {
    if (!inWindow(day, asOfDay, windowDays)) continue;
    observedDays += 1;
    const r = finiteNumber(day.rhr);
    if (r != null && r >= m.rhr.min && r <= m.rhr.max) rhr.push(r);
    const h = finiteNumber(day.hrv);
    if (h != null && h >= m.hrv.min && h <= m.hrv.max) hrv.push(h);
    const asleep = finiteNumber(day.asleepMin);
    if (asleep != null && asleep >= 120 && asleep <= 720) sleepMin.push(asleep);
    const eff = finiteNumber(day.sleepEfficiency);
    if (eff != null && eff > 0 && eff <= 100) efficiency.push(eff);
    const cons = finiteNumber(day.sleepConsistency);
    if (cons != null && cons > 0 && cons <= 100) consistency.push(cons);
    const st = finiteNumber(day.steps);
    if (st != null && st >= 200 && st <= 50000) steps.push(st);
    for (const w of day.workouts || []) {
      const z = zoneMinutes(w);
      zone13 += z[0] + z[1] + z[2];
      zone45 += z[3] + z[4];
      if ((finiteNumber(w.durationMin) || 0) >= 5) workoutCount += 1;
    }
  }

  const weeks = windowDays / 7;
  const weightKg = finiteNumber(profile.weightKg);
  const heightCm = finiteNumber(profile.heightCm);
  const features = {
    windowDays,
    observedDays,
    age: finiteNumber(age),
    sex: profile.sex || null,
    heightCm,
    weightKg,
    bmi: bmi(weightKg, heightCm),
    medianRhr: median(rhr),
    p20Rhr: percentile(rhr, 20),
    meanRhr: mean(rhr),
    rhrTrend: rhr.length >= 5 ? linregSlope(rhr.map((_, i) => i), rhr) : 0,
    rhrCv: cv(rhr),
    medianHrv: median(hrv),
    hrvTrend: hrv.length >= 5 ? linregSlope(hrv.map((_, i) => i), hrv) : 0,
    medianSleepHours: median(sleepMin) != null ? median(sleepMin) / 60 : null,
    sleepCv: cv(sleepMin),
    medianSleepEfficiency: median(efficiency),
    medianSleepConsistency: median(consistency),
    medianSteps: steps.length ? median(steps) : null,
    zone13MinPerWeek: zone13 / weeks,
    zone45MinPerWeek: zone45 / weeks,
    workoutsPerWeek: workoutCount / weeks,
    freeLivingActiveHr: freeLivingHrResponse(days, asOfDay, windowDays),
  };
  features.activityRating = physicalActivityRating(features);
  features.missing = {
    steps: features.medianSteps == null,
    hrv: features.medianHrv == null,
    rhr: features.medianRhr == null,
    sleep: features.medianSleepHours == null,
    freeLiving: features.freeLivingActiveHr == null,
  };
  return features;
}
