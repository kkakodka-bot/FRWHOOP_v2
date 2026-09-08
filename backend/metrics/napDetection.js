
/**
 * Dedicated nap detector. Naps are treated as their OWN detection problem, not
 * as an afterthought of the overnight detector.
 *
 * Evidence used:
 *   - sustained inactivity (gravity angle-change stillness) of plausible nap
 *     duration (default 10-180 min)
 *   - HR reduction relative to the individual's daytime baseline
 *   - time of day (nap-prone window) as a soft prior, never a hard gate
 *   - exclusion of explicit off-wrist time and of the main overnight sleep
 *     window, so a night is never double-counted
 *   - optional band "asleep" state corroboration
 *
 * Outputs per candidate: probability, duration, confidence, and a separate
 * "sleep vs quiet rest" confidence that reflects how strongly the cardiac and
 * stillness evidence support actual sleep rather than merely being still.
 *
 * It deliberately does NOT label every sedentary period as a nap: a stationary
 * awake person (reading, working) keeps HR near baseline, so the HR-dip
 * component separates "still" from "asleep".
 */

import { hdczaSleepPeriods } from './hdczaSleep.js';

export const NAP_DEFAULTS = Object.freeze({
  minDurationMin: 10,
  maxDurationMin: 180,
  sustainedMin: 3,
  stillnessThresholdG: 0.012,
  stillnessFraction: 0.85,
  hrDipMult: 0.97,          // median HR must be below daytime baseline * this
  hrBaselineP: 0.4,         // daytime HR baseline percentile
  hrRefineMinSamples: 3,
  offWristMaxFraction: 0.25,
  timeWindowStartHour: 10,
  timeWindowEndHour: 21,
  centerPenaltyHour: 17,     // hours after which probability starts dropping
  mainOverlapMarginMin: 30,  // must end before / start after main window + this
});

function median(values) {
  const v = (values || []).filter(Number.isFinite);
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function finite(n) { return Number.isFinite(Number(n)) ? Number(n) : null; }

export function daytimeHrBaseline(hr, tzOffsetSeconds) {
  const values = (hr || []).filter((row) => {
    const local = ((row.ts + tzOffsetSeconds) % 86400 + 86400) % 86400;
    const hour = Math.floor(local / 3600);
    return hour >= NAP_DEFAULTS.timeWindowStartHour && hour < NAP_DEFAULTS.timeWindowEndHour;
  }).map((row) => row.bpm);
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * NAP_DEFAULTS.hrBaselineP)));
  return s[idx];
}

export function timeOfDayScore(startSec, tzOffsetSeconds) {
  const local = ((startSec + tzOffsetSeconds) % 86400 + 86400) % 86400;
  const hour = Math.floor(local / 3600);
  if (hour < NAP_DEFAULTS.timeWindowStartHour || hour > NAP_DEFAULTS.timeWindowEndHour) return 0.2;
  // peak ~14:00
  const peak = 14;
  const sigma = 2.5;
  const g = Math.exp(-0.5 * ((hour - peak) / sigma) ** 2);
  return 0.3 + 0.7 * g;
}

export function hrDipEvidence(period, hr, baseline) {
  if (!Number.isFinite(baseline)) return { dip: null, ratio: null, samples: 0 };
  const seg = (hr || []).filter((r) => r.ts >= period.start && r.ts <= period.end).map((r) => r.bpm);
  if (seg.length < NAP_DEFAULTS.hrRefineMinSamples) return { dip: null, ratio: null, samples: seg.length };
  const med = median(seg);
  return { dip: med <= baseline * NAP_DEFAULTS.hrDipMult, ratio: med / baseline, samples: seg.length };
}

/** Fraction of still seconds within a window (assumes candidate is already still). */
export function stillnessFraction(period, gravity, angleThresholdDeg = 5) {
  const rows = (gravity || []).filter((r) => r.ts >= period.start && r.ts <= period.end);
  if (rows.length < 2) return 0;
  // z-angle of the wrist relative to the horizon (same definition as HDCZA)
  const z = rows.map((r) => Math.atan2(r.z, Math.sqrt(r.x * r.x + r.y * r.y)) * 180 / Math.PI);
  // smooth with a rolling median (10 s) so a single noisy sample cannot look like movement
  const width = Math.max(1, Math.round(10));
  const smooth = z.map((v, i) => {
    const lo = Math.max(0, i - Math.floor(width / 2));
    const hi = Math.min(z.length - 1, i + Math.floor(width / 2));
    const seg = z.slice(lo, hi + 1).sort((a, b) => a - b);
    const m = seg.length >> 1;
    return seg.length % 2 ? seg[m] : (seg[m - 1] + seg[m]) / 2;
  });
  let still = 0;
  for (let i = 1; i < smooth.length; i += 1) {
    if (Math.abs(smooth[i] - smooth[i - 1]) < angleThresholdDeg) still += 1;
  }
  return still / Math.max(1, smooth.length - 1);
}

export function overlapsMain(period, main, marginMin = NAP_DEFAULTS.mainOverlapMarginMin) {
  if (!main) return false;
  const m = marginMin * 60;
  return period.start < main.endSec + m && period.end > main.startSec - m;
}

function offWristFraction(period, wristOff = []) {
  const dur = period.end - period.start;
  if (dur <= 0) return 1;
  let covered = 0;
  for (const w of wristOff) {
    const s = Math.max(w.start, period.start);
    const e = Math.min(w.end, period.end);
    if (e > s) covered += e - s;
  }
  return covered / dur;
}

export function bandAsleepEvidence(period, bandSleepState, frac = 0.5) {
  const inBlock = (bandSleepState || []).filter((r) => r.ts >= period.start && r.ts <= period.end);
  if (!inBlock.length) return null;
  const asleep = inBlock.filter((r) => r.state === 2).length;
  return asleep / inBlock.length >= frac;
}

/**
 * Detect naps.
 * @returns {Array<{startSec,endSec,durationMin,probability,confidence,sleepVsQuietConfidence,hrRatio,detector}>}
 */
export function detectNaps({
  gravity = [],
  hr = [],
  wristOff = [],
  bandSleepState = [],
  mainSleep = null,
  excludeWindows = [],
  tzOffsetSeconds = 0,
} = {}) {
  const baseline = daytimeHrBaseline(hr, tzOffsetSeconds);
  // find inactivity bouts across the day with a short sustained window
  const candidates = hdczaSleepPeriods(gravity, {
    sustainedMin: NAP_DEFAULTS.sustainedMin,
    minDurationMin: NAP_DEFAULTS.minDurationMin,
    bridgeGapMin: 5,
  }).filter((p) => p.durationSec <= NAP_DEFAULTS.maxDurationMin * 60);

  const naps = [];
  for (const cand of candidates) {
    const period = { start: cand.onsetSec, end: cand.offsetSec };
    if (overlapsMain(period, mainSleep)) continue;
    if (excludeWindows.some((w) => overlapsMain(period, w, NAP_DEFAULTS.mainOverlapMarginMin))) continue;
    const offWrist = offWristFraction(period, wristOff);
    if (offWrist > NAP_DEFAULTS.offWristMaxFraction) continue;
    const still = stillnessFraction(period, gravity);
    if (still < NAP_DEFAULTS.stillnessFraction) continue;
    const hrE = hrDipEvidence(period, hr, baseline);
    const tod = timeOfDayScore(period.start, tzOffsetSeconds);

    // probability: combination of stillness, HR dip, time of day
    let prob = 0.25;
    prob += 0.35 * still;
    if (hrE.dip === true) prob += 0.25; else if (hrE.dip === false) prob -= 0.15;
    prob += 0.15 * tod;
    prob = Math.max(0, Math.min(0.98, prob));

    // sleep-vs-quiet-rest confidence
    let sleepConf = 0.25 + 0.4 * still;
    if (hrE.dip === true) sleepConf += 0.3;
    if (hrE.dip === false) sleepConf -= 0.2;
    if (cand.durationSec >= 30 * 60) sleepConf += 0.1;
    sleepConf = Math.max(0.05, Math.min(0.99, sleepConf));

    const bandEv = bandAsleepEvidence(period, bandSleepState);
    if (bandEv === true) { prob = Math.min(0.98, prob + 0.1); sleepConf = Math.min(0.99, sleepConf + 0.1); }

    // confidence based on input coverage
    const hrCoverage = hrE.samples > 0;
    const gravCoverage = gravity.some((g) => g.ts >= period.start && g.ts <= period.end);
    const confidence = (!gravCoverage || !hrCoverage) ? 'low' : (prob > 0.72 ? 'high' : 'medium');

    naps.push({
      startSec: period.start,
      endSec: period.end,
      durationMin: Math.round((period.end - period.start) / 60),
      probability: Math.round(prob * 100) / 100,
      confidence,
      sleepVsQuietConfidence: Math.round(sleepConf * 100) / 100,
      hrRatio: hrE.ratio == null ? null : Math.round(hrE.ratio * 1000) / 1000,
      detector: 'nap_detector_v1',
    });
  }
  // dedupe / sort
  naps.sort((a, b) => a.startSec - b.startSec);
  return naps;
}
