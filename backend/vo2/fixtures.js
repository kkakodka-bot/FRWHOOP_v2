import { addDays } from './math.js';

export function adultProfile(over = {}) {
  return {
    birthYear: 1986,
    sex: 'male',
    heightCm: 178,
    weightKg: 75,
    age: 40,
    ...over,
  };
}

export function daysWithRecoveries({
  asOfDay = '2026-03-01',
  n = 21,
  valid = 21,
  rhr = 58,
  hrv = 70,
  recovery = 72,
  workoutsByDay = {},
} = {}) {
  const days = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const day = addDays(asOfDay, -i);
    const idx = n - 1 - i;
    const isValid = idx >= (n - valid);
    days.push({
      day,
      recovery: isValid ? recovery : 0,
      rhr,
      hrv,
      asleepMin: 430,
      sleepEfficiency: 88,
      sleepConsistency: 80,
      maxHr: 168,
      workouts: workoutsByDay[day] || [],
    });
  }
  return days;
}

export function gpsSamples({
  durationMin = 20,
  speedMps = 3.0,
  hr = 150,
  intervalSec = 5,
  spikeSpeedMps = null,
  spikeAtSec = 300,
} = {}) {
  const n = Math.round((durationMin * 60) / intervalSec);
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const t = i * intervalSec;
    const speed = (spikeSpeedMps != null && Math.abs(t - spikeAtSec) < intervalSec)
      ? spikeSpeedMps
      : speedMps;
    samples.push({ t, offsetSec: t, hr, speedMps: speed });
  }
  return samples;
}

export function runningWorkout({
  name = 'Outdoor Run',
  durationMin = 30,
  distanceM = 5000,
  avgHr = 150,
  maxHr = 168,
  gpsEnabled = true,
  samples,
} = {}) {
  return {
    name,
    durationMin,
    distanceM,
    avgHr,
    maxHr,
    gpsEnabled,
    zones: [10, 20, 40, 25, 5],
    samples,
  };
}

export function syntheticCpetRows() {
  return [
    { subjectId: 'S1', sex: 'male', age: 28, bmi: 23, actual: 54.2, predicted: 52.8, tier: 'GPS_AUGMENTED', gps: true, coverage: 0.9 },
    { subjectId: 'S2', sex: 'female', age: 41, bmi: 26, actual: 38.1, predicted: 40.0, tier: 'PASSIVE', gps: false, coverage: 0.7 },
    { subjectId: 'S3', sex: 'male', age: 55, bmi: 29, actual: 32.4, predicted: 31.1, tier: 'PASSIVE', gps: false, coverage: 0.8 },
    { subjectId: 'S4', sex: 'female', age: 33, bmi: 22, actual: 44.0, predicted: 45.6, tier: 'GPS_AUGMENTED', gps: true, coverage: 0.85 },
    { subjectId: 'S1', sex: 'male', age: 28, bmi: 23, actual: 54.2, predicted: 53.4, tier: 'GPS_AUGMENTED', gps: true, coverage: 0.9 },
  ];
}
