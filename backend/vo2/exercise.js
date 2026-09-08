import { getMethodology } from './methodology.js';
import {
  clamp, cv, finiteNumber, mean, parseTimestamp, weightedMedian,
} from './math.js';

function sampleTime(sample, startMs, index, resampleSec) {
  const t = parseTimestamp(sample.t ?? sample.time ?? sample.at ?? sample.datetime);
  if (t != null) return t;
  if (Number.isFinite(Number(sample.offsetSec))) return startMs + Number(sample.offsetSec) * 1000;
  return startMs + index * resampleSec * 1000;
}

function sampleHr(s) {
  return finiteNumber(s.hr ?? s.bpm ?? s.heartRate);
}

function sampleSpeed(s) {
  const mps = finiteNumber(s.speedMps ?? s.speed_mps ?? s.speed);
  if (mps != null) return mps;
  const pace = finiteNumber(s.paceMinPerKm);
  if (pace != null && pace > 0) return 1000 / (pace * 60);
  return null;
}

function sampleElev(s) {
  return finiteNumber(s.elevM ?? s.elevationM ?? s.altitude ?? s.alt);
}

export function acsmOxygenCost(speedMps, grade = 0) {
  const speed = finiteNumber(speedMps);
  if (speed == null || speed <= 0) return null;
  const mMin = speed * 60;
  const g = clamp(finiteNumber(grade) || 0, -0.3, 0.3);
  if (mMin < 134) return 3.5 + 0.1 * mMin + 1.8 * mMin * Math.max(g, 0);
  return 3.5 + 0.2 * mMin + 0.9 * mMin * Math.max(g, 0);
}

export function vo2FromCostAndHr(cost, hr, hrRest, hrMax) {
  if (![cost, hr, hrRest, hrMax].every(Number.isFinite)) return null;
  if (hrMax <= hrRest) return null;
  const hrr = (hr - hrRest) / (hrMax - hrRest);
  if (hrr <= 0.2) return null;
  return (cost - 3.5) / hrr + 3.5;
}

function resample(samples, version) {
  const gps = getMethodology(version).gps;
  if (!Array.isArray(samples) || samples.length < 8) return [];
  const start = sampleTime(samples[0], Date.now(), 0, gps.resampleSec);
  const parsed = samples.map((s, i) => ({
    t: sampleTime(s, start, i, gps.resampleSec),
    hr: sampleHr(s),
    speed: sampleSpeed(s),
    elev: sampleElev(s),
    accuracy: finiteNumber(s.gpsAccuracy ?? s.accuracy),
  })).filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
  if (parsed.length < 8) return [];

  const out = [];
  const t0 = parsed[0].t;
  const t1 = parsed[parsed.length - 1].t;
  let j = 0;
  for (let t = t0; t <= t1; t += gps.resampleSec * 1000) {
    while (j < parsed.length - 1 && parsed[j + 1].t <= t) j += 1;
    const a = parsed[j];
    const b = parsed[Math.min(j + 1, parsed.length - 1)];
    const span = b.t - a.t;
    const w = span === 0 ? 0 : clamp((t - a.t) / span, 0, 1);
    const lerp = (x, y) => (x == null || y == null ? x ?? y : x + (y - x) * w);
    const speed = lerp(a.speed, b.speed);
    if (speed != null && speed > gps.jumpSpeedMps) continue;
    if (a.hr != null && (a.hr < 40 || a.hr > 230)) continue;
    out.push({
      t,
      hr: lerp(a.hr, b.hr),
      speed,
      elev: lerp(a.elev, b.elev),
      accuracy: a.accuracy,
    });
  }
  return out;
}

function gradeBetween(a, b) {
  if (a?.elev == null || b?.elev == null || b.t === a.t) return 0;
  const dt = (b.t - a.t) / 1000;
  const dist = (a.speed || 0) * dt;
  if (dist < 2) return 0;
  return clamp((b.elev - a.elev) / dist, -0.3, 0.3);
}

export function stableSegments(samples, hrRest, hrMax, version) {
  const gps = getMethodology(version).gps;
  const series = resample(samples, version);
  if (series.length < 12) return [];
  const durationMs = series[series.length - 1].t - series[0].t;
  const startCut = durationMs > 12 * 60 * 1000 ? gps.warmupSec * 1000 : 0;
  const endCut = durationMs > 12 * 60 * 1000 ? gps.cooldownSec * 1000 : 0;
  const tStart = series[0].t + startCut;
  const tEnd = series[series.length - 1].t - endCut;
  const usable = series.filter((s) => s.t >= tStart && s.t <= tEnd
    && s.speed != null && s.speed >= gps.stopSpeedMps
    && s.hr != null);

  const window = Math.max(6, Math.round(gps.minSegmentSec / gps.resampleSec));
  const segs = [];
  for (let i = 0; i + window <= usable.length; i += Math.floor(window / 2)) {
    const slice = usable.slice(i, i + window);
    const hrs = slice.map((s) => s.hr);
    const speeds = slice.map((s) => s.speed);
    const meanHr = mean(hrs);
    const meanSpeed = mean(speeds);
    const hrCv = cv(hrs);
    const speedCv = cv(speeds);
    const grade = Math.abs(gradeBetween(slice[0], slice[slice.length - 1]));
    if (meanSpeed < gps.minSpeedMps || meanSpeed > gps.maxSpeedMps) continue;
    if (hrMax && (meanHr / hrMax < gps.minPctHrMax || meanHr / hrMax > gps.maxPctHrMax)) continue;
    if (hrCv != null && hrCv > gps.maxHrCv) continue;
    if (speedCv != null && speedCv > gps.maxSpeedCv) continue;
    if (grade > gps.maxGrade) continue;
    const cost = acsmOxygenCost(meanSpeed, grade);
    const vo2 = vo2FromCostAndHr(cost, meanHr, hrRest, hrMax);
    if (vo2 == null || vo2 < 20 || vo2 > 80) continue;
    const durationSec = (slice[slice.length - 1].t - slice[0].t) / 1000;
    const gpsQ = slice.every((s) => s.accuracy == null || s.accuracy <= 25) ? 1 : 0.6;
    const weight = (durationSec / 60) * (1 / (1 + (hrCv || 0) * 8)) * (1 / (1 + (speedCv || 0) * 8)) * gpsQ;
    segs.push({
      meanHr, meanSpeed, grade, durationSec, cost, vo2, weight, hrCv, speedCv, gpsQuality: gpsQ,
    });
  }
  return segs;
}

export function estimateFromSummary(workout, hrRest, hrMax, version) {
  const gps = getMethodology(version).gps;
  const dur = finiteNumber(workout?.durationMin) || 0;
  const dist = finiteNumber(workout?.distanceM);
  const avgHr = finiteNumber(workout?.avgHr);
  if (dur < getMethodology(version).eligibility.gpsMinDurationMin || dist == null || dist <= 0 || avgHr == null) {
    return null;
  }
  const speed = dist / (dur * 60);
  if (speed < gps.minSpeedMps || speed > gps.maxSpeedMps || speed > gps.jumpSpeedMps) return null;
  const cost = acsmOxygenCost(speed, 0);
  const vo2 = vo2FromCostAndHr(cost, avgHr, hrRest, hrMax);
  if (vo2 == null || vo2 < 20 || vo2 > 80) return null;
  return {
    vo2,
    quality: gps.summaryQuality,
    fidelity: 'summary',
    segments: [{ vo2, weight: dur * gps.summaryQuality, meanHr: avgHr, meanSpeed: speed, durationSec: dur * 60 }],
  };
}

export function estimateGps(workout, hrRest, hrMax, version) {
  const gps = getMethodology(version).gps;
  const samples = workout?.samples;
  if (Array.isArray(samples) && samples.length >= 8) {
    const segs = stableSegments(samples, hrRest, hrMax, version);
    if (segs.length) {
      const vo2 = weightedMedian(segs.map((s) => ({ value: s.vo2, weight: s.weight })));
      const quality = clamp(
        gps.timeseriesQualityFloor + 0.08 * Math.min(segs.length, 6) / 6,
        0,
        0.95,
      );
      return { vo2, quality, fidelity: 'timeseries', segments: segs };
    }
  }
  return estimateFromSummary(workout, hrRest, hrMax, version);
}

export function aggregateGpsEstimates(results) {
  const ok = (results || []).filter((r) => r && Number.isFinite(r.vo2));
  if (!ok.length) return null;
  const vo2 = weightedMedian(ok.map((r) => ({
    value: r.vo2,
    weight: (r.quality || 0.4) * (r.segments?.length || 1),
  })));
  const quality = mean(ok.map((r) => r.quality));
  const fidelity = ok.some((r) => r.fidelity === 'timeseries') ? 'timeseries' : 'summary';
  return {
    vo2,
    quality,
    fidelity,
    runCount: ok.length,
    segmentCount: ok.reduce((s, r) => s + (r.segments?.length || 0), 0),
  };
}
