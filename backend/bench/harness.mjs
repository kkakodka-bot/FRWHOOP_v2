
// Runs the sleep pipeline over labeled scenarios and reports agreement metrics.
// Usage: node bench/harness.mjs [--freeze BASELINE.json] [--scenario name]
import fs from 'node:fs';
import { SCENARIOS } from './scenarios.mjs';
import { simulateScenario } from './simulator.mjs';
import { extractSleepStreams, detectSleepSessions } from '../metrics/sleepDetection.js';
import { stageSession } from '../metrics/sleepStagerV2.js';
import { scoreSleep } from '../metrics/sleep.js';
import { hdczaSleepPeriods } from '../metrics/hdczaSleep.js';
import { detectNaps } from '../metrics/napDetection.js';
import {
  epochGrid, confusionMatrix, perStageMetrics, overallAccuracy, macroF1,
  balancedAccuracy, cohenKappa, sleepWakeConfusion,
} from './metrics.mjs';

export function frameworkStreams(sc) {
  const sim = simulateScenario(sc, {});
  const rows = [
    ...sim.gravity.map((g) => ({ t: new Date(g.ts * 1000).toISOString(), bpm: 60, gravity: { x: g.x, y: g.y, z: g.z } })),
    ...sim.hr.map((h) => ({ t: new Date(h.ts * 1000).toISOString(), bpm: h.bpm })),
    ...sim.rr.map((r) => ({ t: new Date(r.ts * 1000).toISOString(), bpm: 60, rr_ms: [r.rrMs] })),
  ];
  return { sim, rows, streams: extractSleepStreams(rows) };
}

export function detectedStages(streams, scenario) {
  // run the current detector + stager
  const det = detectSleepSessions({ ...streams, tzOffsetSeconds: 0 });
  const sessions = (det.sessions || []).map((s) => ({
    startSec: s.startSec, endSec: s.endSec, stages: s.stages,
  }));
  return { sessions, coverage: det.coverage, fallbackReason: det.fallbackReason };
}

export function detectWindows(streams, variant, sc) {
  if (variant === 'hdcza') {
    const periods = hdczaSleepPeriods(streams.gravity);
    return periods.map((p) => ({
      startSec: p.onsetSec, endSec: p.offsetSec,
      stages: stageSession({ start: p.onsetSec, end: p.offsetSec, gravity: streams.gravity, hr: streams.hr, rr: streams.rr }),
    }));
  }
  const det = detectSleepSessions({ ...streams, tzOffsetSeconds: 0 });
  return (det.sessions || []).map((s) => ({ startSec: s.startSec, endSec: s.endSec, stages: s.stages }));
}

export function evaluateScenario(name, opts = {}) {
  const sc = SCENARIOS[name];
  if (!sc) return null;
  const { rows, streams } = frameworkStreams(sc);
  const variant = opts.variant || 'current';
  const sessions = detectWindows(streams, variant, sc);
  const truthStart = sc.startSec;
  const truthEnd = sc.endSec;
  const truthIsNap = sc.kind === 'nap';

  // ---- detection metrics over the truth window ----
  // predicted asleep per epoch over the labeled truth window
  const predSleepEpochs = [];
  const truthSleepEpochs = [];
  for (let t = truthStart; t < truthEnd; t += 30) {
    const inAny = sessions.some((s) => t >= s.startSec && t < s.endSec);
    predSleepEpochs.push(inAny);
    truthSleepEpochs.push(sc.epochs[Math.floor((t - sc.startSec) / 30)].stage !== 'wake');
  }
  const detSW = sleepWakeConfusion(predSleepEpochs.map((p, i) => [p ? 'sleep' : 'wake', truthSleepEpochs[i] ? 'sleep' : 'wake']));

  // detected main session = longest
  const main = sessions.reduce((b, s) => (!b || s.endSec - s.startSec > b.endSec - b.startSec ? s : b), null);
  const onsetErrMin = main ? (main.startSec - truthStart) / 60 : null;
  const wakeErrMin = main ? (main.endSec - truthEnd) / 60 : null;
  const detectedMainSpanMin = main ? (main.endSec - main.startSec) / 60 : 0;
  const truthSpanMin = (truthEnd - truthStart) / 60;

  // ---- staging metrics ----
  // Build predicted per-epoch stage over the truth window from sessions
  const predEpochs = [];
  for (let t = truthStart; t < truthEnd; t += 30) {
    const sess = sessions.find((s) => t >= s.startSec && t < s.endSec);
    let stage = 'wake';
    if (sess) {
      const seg = sess.stages.find((x) => t >= x.start && t < x.end);
      if (seg) stage = seg.stage === 'awake' ? 'wake' : seg.stage;
    }
    predEpochs.push(stage);
  }
  const truthEpochs = sc.epochs.map((e) => e.stage);
  const cm = confusionMatrix(predEpochs, truthEpochs);
  const perStage = perStageMetrics(cm);
  const sw = sleepWakeConfusion(predEpochs.map((p, i) => [p, truthEpochs[i]]));
  const totalsTruth = { wake: 0, light: 0, deep: 0, rem: 0 };
  for (const e of truthEpochs) totalsTruth[e] += 1;
  const totalsPred = { wake: 0, light: 0, deep: 0, rem: 0 };
  for (const p of predEpochs) totalsPred[p] += 1;

  // nap detection evaluation
  const mainW = main ? { startSec: main.startSec, endSec: main.endSec } : null;
  const napCands = detectNaps({ gravity: streams.gravity, hr: streams.hr, wristOff: [], bandSleepState: [], mainSleep: mainW, tzOffsetSeconds: 0 });
  const napOverlap = napCands.some((n) => n.startSec < truthEnd && n.endSec > truthStart);
  return {
    scenario: name,
    kind: truthIsNap ? 'nap' : 'night',
    napsDetected: napCands.map((n) => ({ durationMin: n.durationMin, probability: n.probability, confidence: n.confidence })),
    napFound: napOverlap,
    detector: variant,
    sessions: sessions.length,
    detectedMainSpanMin: round2(detectedMainSpanMin),
    truthSpanMin: round2(truthSpanMin),
    onsetErrMin: round2(onsetErrMin),
    wakeErrMin: round2(wakeErrMin),
    detection: {
      sleepSensitivity: round3(detSW.sensitivity),
      wakeSpecificity: round3(detSW.specificity),
      sleepWakeAccuracy: round3(detSW.accuracy),
    },
    staging: {
      overallAccuracy: round3(overallAccuracy(cm)),
      balancedAccuracy: round3(balancedAccuracy(cm)),
      macroF1: round3(macroF1(perStage)),
      kappa: round3(cohenKappa(cm)),
      sleepSensitivity: round3(sw.sensitivity),
      wakeSpecificity: round3(sw.specificity),
      confusion: cm,
      perStage,
      truthMinutes: minutes(totalsTruth),
      predictedMinutes: minutes(totalsPred),
    },
  };
}

function minutes(t) { const o = {}; for (const k of Object.keys(t)) o[k] = round1(t[k] * 30 / 60); return o; }
function round1(x) { return Math.round(x * 10) / 10; }
function round2(x) { return x == null ? null : Math.round(x * 100) / 100; }
function round3(x) { return Math.round(x * 1000) / 1000; }

export function runAll() {
  const out = [];
  for (const name of Object.keys(SCENARIOS)) {
    const r = evaluateScenario(name);
    if (r) out.push(r);
  }
  return out;
}

// CLI
if (process.argv[1] && process.argv[1].endsWith('harness.mjs')) {
  const args = process.argv.slice(2);
  const freezeIdx = args.indexOf('--freeze');
  const vIdx = args.indexOf('--variant');
  const variant = vIdx >= 0 ? args[vIdx + 1] : 'current';
  const scenarios = args.includes('--all') ? Object.keys(SCENARIOS) : (args.includes('--scenario') ? [args[args.indexOf('--scenario') + 1]] : Object.keys(SCENARIOS));
  const results = scenarios.map((s) => evaluateScenario(s, { variant })).filter(Boolean);
  console.log(JSON.stringify(results, null, 2));
  if (freezeIdx >= 0) {
    const file = args[freezeIdx + 1];
    fs.writeFileSync(file, JSON.stringify(results, null, 2));
    console.error(`frozen -> ${file}`);
  }
}
