import { getMethodology } from './methodology.js';
import { CONFIDENCE } from './methodology.js';
import { finiteNumber, mean } from './math.js';
import { tanakaHrMax } from './uth.js';

function inRange(n, lo, hi) {
  return Number.isFinite(n) && n >= lo && n <= hi;
}

function collectPeaks(days, cfg) {
  const peaks = [];
  for (const day of days || []) {
    const dayMax = finiteNumber(day.maxHr ?? day.max_hr);
    if (inRange(dayMax, cfg.minObserved, cfg.maxObserved)) {
      peaks.push({ day: day.day, value: dayMax, kind: 'day' });
    }
    for (const w of day.workouts || []) {
      const wMax = finiteNumber(w.maxHr ?? w.max_hr);
      if (inRange(wMax, cfg.minObserved, cfg.maxObserved)) {
        peaks.push({ day: day.day, value: wMax, kind: 'workout' });
      }
      for (const s of w.samples || []) {
        const hr = finiteNumber(s.hr ?? s.bpm ?? s.heartRate);
        if (inRange(hr, cfg.minObserved, cfg.maxObserved)) {
          peaks.push({ day: day.day, value: hr, kind: 'sample' });
        }
      }
    }
    for (const s of day.bpmData || []) {
      const hr = finiteNumber(s.bpm ?? s.hr);
      if (inRange(hr, cfg.minObserved, cfg.maxObserved)) {
        peaks.push({ day: day.day, value: hr, kind: 'sample' });
      }
    }
  }
  return peaks;
}

function credibleObserved(peaks, tanaka, cfg) {
  if (!peaks.length) return null;
  const sorted = peaks.slice().sort((a, b) => b.value - a.value);
  for (const candidate of sorted) {
    if (tanaka != null && candidate.value > tanaka + cfg.spikeCeilingOverTanaka && candidate.kind === 'sample') {
      continue;
    }
    const near = peaks.filter((p) => Math.abs(p.value - candidate.value) <= cfg.persistToleranceBpm);
    const days = new Set(near.map((p) => p.day));
    if (days.size >= cfg.persistDays) return mean(near.map((p) => p.value));

    if (candidate.kind === 'sample') {
      const sampleNear = peaks.filter((p) => p.kind === 'sample' && Math.abs(p.value - candidate.value) <= cfg.samplePersistToleranceBpm);
      if (sampleNear.length >= cfg.samplePersistCount && (tanaka == null || candidate.value <= tanaka + cfg.spikeCeilingOverTanaka + 2)) {
        return mean(sampleNear.map((p) => p.value));
      }
    }
  }
  const bounded = sorted.filter((p) => tanaka == null || p.value <= tanaka + cfg.spikeCeilingOverTanaka);
  if (!bounded.length) return null;
  const days = new Set(bounded.map((p) => p.day));
  if (days.size < cfg.persistDays) return null;
  return bounded[0].value;
}

export function resolveHrMax({
  age,
  override,
  days = [],
  profileHrMax,
  version,
} = {}) {
  const cfg = getMethodology(version).hrMax;
  const tanaka = tanakaHrMax(age, version);

  const manual = finiteNumber(override?.value ?? override);
  if (inRange(manual, 120, 220)) {
    return { value: manual, source: 'manual_tested', confidence: CONFIDENCE.HIGH };
  }

  const observed = credibleObserved(collectPeaks(days, cfg), tanaka, cfg);
  if (observed != null) {
    return { value: observed, source: 'observed_historical', confidence: CONFIDENCE.MEDIUM };
  }

  const personalized = finiteNumber(profileHrMax);
  if (inRange(personalized, 120, 220)) {
    return { value: personalized, source: 'personalized_existing', confidence: CONFIDENCE.MEDIUM };
  }

  if (tanaka != null) {
    return { value: tanaka, source: 'tanaka_age', confidence: CONFIDENCE.LOW };
  }
  return { value: null, source: 'unavailable', confidence: CONFIDENCE.LOW };
}
