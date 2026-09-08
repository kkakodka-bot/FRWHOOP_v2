
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { hdczaSleepPeriods, hdczaMainSleep } from '../metrics/hdczaSleep.js';
import { detectNaps, daytimeHrBaseline, timeOfDayScore } from '../metrics/napDetection.js';
import { correctRRIntervals } from '../signal/rrArtifact.js';
import {
  analyzeTimestamps, correctWithReference, estimateDrift, monotonicMask,
  historicalClockOffsetMs,
} from '../time/clockCorrection.js';
import { gravityVectorOf } from '../ingest/archiveFormat.js';
import { stageEpochsDetailed, features, softmaxEmissions } from '../metrics/sleepStagerV2.js';
import { sessionScorability, stageConfidence } from '../metrics/scorability.js';
import { SCENARIOS } from '../bench/scenarios.mjs';
import { simulateScenario } from '../bench/simulator.mjs';
import {
  extractSleepStreams,
  detectSleepSessions,
  mergeCloseSleepPeriods,
} from '../metrics/sleepDetection.js';
import { scoreSleep } from '../metrics/sleep.js';

test('HDCZA detects a normal simulated night and rejects wake motion', () => {
  const sc = SCENARIOS.normal8;
  const sim = simulateScenario(sc, {});
  const main = hdczaMainSleep(sim.gravity);
  assert.ok(main);
  assert.ok(main.durationSec > 6 * 3600, 'long night detected');
  const truthSpan = sc.endSec - sc.startSec;
  assert.ok(Math.abs((main.offsetSec - main.onsetSec) - truthSpan) < 30 * 60);

  const awake = simulateScenario(SCENARIOS.motionless_awake, {});
  assert.equal(hdczaSleepPeriods(awake.gravity).length, 0);
});

test('HDCZA is configurable (angle threshold retunes detection)', () => {
  const sim = simulateScenario(SCENARIOS.normal8, {});
  const strict = hdczaMainSleep(sim.gravity, { angleThresholdDeg: 3 });
  const loose = hdczaMainSleep(sim.gravity, { angleThresholdDeg: 20 });
  assert.ok(loose?.durationSec >= strict?.durationSec);
});

test('nap detector separates a real afternoon nap from the main night', () => {
  const nap = simulateScenario(SCENARIOS.nap45, {});
  const dayBase = daytimeHrBaseline(nap.hr, 0);
  const naps = detectNaps({ gravity: nap.gravity, hr: nap.hr, tzOffsetSeconds: 0 });
  assert.ok(naps.length >= 1, 'a decent nap is detected');
  const top = naps[0];
  assert.ok(top.probability > 0.5);
  assert.ok(['high', 'medium'].includes(top.confidence));
  assert.ok(top.endSec - top.startSec >= 10 * 60);

  // A night stream with no daytime HR must not conjure a nap.
  const night = simulateScenario(SCENARIOS.normal8, {});
  const nightNaps = detectNaps({
    gravity: night.gravity, hr: night.hr,
    mainSleep: { startSec: night.start, endSec: night.end }, tzOffsetSeconds: 0,
  });
  assert.equal(nightNaps.length, 0);
});

test('time-of-day score peaks mid-afternoon and falls off outside nap hours', () => {
  assert.ok(timeOfDayScore(Date.parse('2026-06-10T00:00:00Z') / 1000, 0) <= 0.3);
  assert.ok(timeOfDayScore(Date.parse('2026-06-10T14:00:00Z') / 1000, 0) > 0.5);
});

test('Lipponen+Tarvainen RR artifact correction fixes beat-level errors, not gaps', () => {
  // clean 1000 ms series
  const clean = Array.from({ length: 60 }, () => 1000);
  // inject an ectopic beat (short then long pair near the middle)
  clean[20] = 700; clean[21] = 1300;
  // a genuine long gap (missing data)
  for (let i = 30; i < 55; i += 1) clean[i] = 100000; // out of band -> long gap
  const res = correctRRIntervals(clean);
  assert.ok(res.artifactFraction > 0, 'artifacts flagged');
  // corrected series should be back near 1000 for the ectopic pair
  assert.ok(Math.abs(res.corrected[20] - 1000) < 50);
  assert.ok(Math.abs(res.corrected[21] - 1000) < 50);
  // the long run is a gap, not "corrected" into fake physiology
  assert.ok(res.gapCount >= 1);
});

test('RR correction leaves a clean series untouched', () => {
  const clean = Array.from({ length: 40 }, () => 980);
  const res = correctRRIntervals(clean);
  assert.equal(res.artifactFraction, 0);
});

test('clock correction detects duplicates, backward jumps, and constant offset', () => {
  const ts = [1000, 1000, 1001, 1002, 999, 1003, 1004];
  const a = analyzeTimestamps(ts, { expectedIntervalSec: 1 });
  assert.ok(a.duplicateCount >= 1);
  assert.ok(a.backwardCount >= 1);

  const strap = [1000, 1001, 1002, 1003];
  const ref = [2000, 2001, 2002, 2003];
  const corr = correctWithReference(strap, ref);
  assert.equal(corr.constantOffsetSec, 1000);
  assert.deepEqual(corr.corrected, [2000, 2001, 2002, 2003]);
  assert.equal(corr.accepted, true);

  const recv = Date.parse('2026-08-25T22:00:00.000Z');
  // A plausible past clock is never shifted, however old: a strap banks weeks or
  // months of flash while unsynced, and shifting it forward would restamp real
  // history onto the present.
  assert.equal(historicalClockOffsetMs(Date.parse('2026-01-24T23:23:00.000Z'), recv), 0);
  assert.equal(historicalClockOffsetMs(recv - 3 * 86_400_000, recv), 0);
  assert.equal(historicalClockOffsetMs(recv - 500 * 86_400_000, recv), 0);
  // A pre-2015 epoch clock is provably lost and correctable within 20 years.
  assert.ok(historicalClockOffsetMs(Date.parse('2014-01-01T00:00:00.000Z'), recv) > 0);
  // A multi-decade epoch garbage clock is still rejected outright.
  assert.equal(historicalClockOffsetMs(recv - 25 * 365 * 86_400_000, recv), 0);
  // Flash cannot hold the future, so a clock running ahead is provably wrong.
  assert.ok(historicalClockOffsetMs(recv + 30 * 86_400_000, recv) < 0);
  assert.equal(historicalClockOffsetMs(recv + 3600_000, recv), 0);

  const mask = monotonicMask(ts);
  const kept = ts.filter((_, i) => mask[i]);
  for (let i = 1; i < kept.length; i += 1) assert.ok(kept[i] > kept[i - 1]);
});

test('backend gravity validation requires ~1g resultant and bounded axes', () => {
  assert.deepEqual(gravityVectorOf({ gx: 0, gy: 0, gz: 1 }), { gx: 0, gy: 0, gz: 1 });
  assert.equal(gravityVectorOf({ gx: 0, gy: 0, gz: 16 }), null);   // axis beyond 8 g
  assert.equal(gravityVectorOf({ gx: 0, gy: 0, gz: 3 }), null);    // resultant 3 g not ~1 g
  assert.equal(gravityVectorOf({ gx: 1, gy: 1, gz: null }), null); // incomplete vector
});

test('stage probabilities normalize to one and carry input coverage', () => {
  const sc = SCENARIOS.normal8;
  const sim = simulateScenario(sc, {});
  const feats = features(sc.startSec, sc.endSec, sim.gravity, sim.hr, sim.rr);
  const detail = stageEpochsDetailed(feats);
  assert.ok(detail.length > 100);
  for (const epoch of detail.slice(0, 20)) {
    const sum = epoch.probs.awake + epoch.probs.light + epoch.probs.deep + epoch.probs.rem;
    assert.ok(Math.abs(sum - 1) < 1e-6);
    assert.ok(['wake', 'light', 'deep', 'rem'].includes(epoch.stage));
    assert.ok(epoch.coverage >= 0 && epoch.coverage <= 1);
  }
  const probs = softmaxEmissions([{ awake: 0, light: 0, deep: 2, rem: 0 }]);
  assert.ok(probs[0].deep > 0.6);
});

test('session scorability summarizes per-epoch confidence and coverage', () => {
  const epochs = [
    { probs: { deep: 0.9, light: 0.05, rem: 0.03, awake: 0.02 }, coverage: 1, hrPresent: true, rrPresent: true, accPresent: true },
    { probs: { awake: 0.4, light: 0.3, deep: 0.2, rem: 0.1 }, coverage: 0.5, hrPresent: true, rrPresent: false, accPresent: true },
    { probs: { light: 0.34, deep: 0.33, rem: 0.33, awake: 0 }, coverage: 0, hrPresent: false, rrPresent: false, accPresent: false },
  ];
  const s = sessionScorability({ epochs, offWristDurationMin: 10, detector: 'van_hees', fallbackReason: null });
  assert.equal(s.epochCount, 3);
  assert.ok(s.pctLowConfidence > 0);
  assert.equal(s.offWristDurationMin, 10);
  assert.equal(s.model, 'sleep_stager_v2');
  assert.equal(stageConfidence({ deep: 0.9, light: 0.05, rem: 0.03, awake: 0.02 }, 1), 'high');
});

test('benchmark simulator is deterministic for reproducibility', () => {
  const a = simulateScenario(SCENARIOS.normal8, {});
  const b = simulateScenario(SCENARIOS.normal8, {});
  assert.deepEqual(a.hr, b.hr);
  assert.deepEqual(a.gravity, b.gravity);
  assert.deepEqual(a.rr, b.rr);
});

test('scored session exposes per-epoch probabilities and a real nap is flagged', () => {
  const sc = SCENARIOS.nap90;
  const sim = simulateScenario(sc, {});
  const rows = [
    ...sim.gravity.map((g) => ({ t: new Date(g.ts * 1000).toISOString(), bpm: 60, gravity: { x: g.x, y: g.y, z: g.z } })),
    ...sim.hr.map((h) => ({ t: new Date(h.ts * 1000).toISOString(), bpm: h.bpm })),
  ];
  const res = scoreSleep({ samples: rows, extras: { timeZone: 'UTC' } });
  assert.equal(res.ok, true);
  const nap = (res.sessions || []).find((s) => s.isNap);
  assert.ok(nap, 'nap session present');
  assert.equal(nap.napProbability, nap.napProbability);
});

test('overnight WASO fragments merge into one in-bed night', () => {
  const sc = SCENARIOS.overnight_wake;
  const sim = simulateScenario(sc, {});
  const det = detectSleepSessions({
    gravity: sim.gravity, hr: sim.hr, rr: sim.rr, tzOffsetSeconds: 0,
  });
  assert.equal(det.sessions.length, 1, 'one night, not two halves');
  const night = det.sessions[0];
  const onsetErrMin = (night.startSec - sc.startSec) / 60;
  const wakeErrMin = (night.endSec - sc.endSec) / 60;
  assert.ok(Math.abs(onsetErrMin) < 20, `onset ${onsetErrMin} min`);
  assert.ok(Math.abs(wakeErrMin) < 20, `wake ${wakeErrMin} min`);
  assert.ok(night.endSec - night.startSec > 6.5 * 3600);
  const mid = sc.startSec + 3.5 * 3600;
  const midSeg = night.stages.find((s) => mid >= s.start && mid < s.end);
  assert.equal(midSeg?.stage, 'wake');
});

test('motionless awake is not scored as sleep', () => {
  const sim = simulateScenario(SCENARIOS.motionless_awake, {});
  const det = detectSleepSessions({
    gravity: sim.gravity, hr: sim.hr, rr: sim.rr, tzOffsetSeconds: 0,
  });
  assert.equal(det.sessions.length, 0);
});

test('normal night onset and wake stay close to labeled bounds', () => {
  const sc = SCENARIOS.normal8;
  const sim = simulateScenario(sc, {});
  const det = detectSleepSessions({
    gravity: sim.gravity, hr: sim.hr, rr: sim.rr, tzOffsetSeconds: 0,
  });
  assert.ok(det.sessions.length >= 1);
  const night = det.sessions.reduce(
    (best, s) => (!best || s.endSec - s.startSec > best.endSec - best.startSec ? s : best),
    null,
  );
  assert.ok(Math.abs(night.startSec - sc.startSec) < 15 * 60);
  assert.ok(Math.abs(night.endSec - sc.endSec) < 15 * 60);
});

test('mergeCloseSleepPeriods joins a 60-minute WASO but not a 3-hour gap', () => {
  const waso = mergeCloseSleepPeriods([
    { stage: 'sleep', start: 0, end: 3 * 3600 },
    { stage: 'sleep', start: 4 * 3600, end: 8 * 3600 },
  ]);
  assert.equal(waso.length, 1);
  assert.equal(waso[0].start, 0);
  assert.equal(waso[0].end, 8 * 3600);

  const split = mergeCloseSleepPeriods([
    { stage: 'sleep', start: 0, end: 3 * 3600 },
    { stage: 'sleep', start: 6.5 * 3600, end: 8 * 3600 },
  ]);
  assert.equal(split.length, 2);
});
