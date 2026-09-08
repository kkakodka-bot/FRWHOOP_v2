/**
 * Event-level V2 evaluation. Does not tune detector constants.
 * Labeled positives are diagnostic examples, not a training set.
 */
import { createWorkoutDetector } from './workoutDetector.js';
import { createWorkoutDetectorV2 } from './workoutDetectV2.js';

export const EVAL_VERSION = '1.0.0';

export const HARD_NEGATIVE_IDS = Object.freeze([
  'elevated_hr_stress',
  'stairs',
  'chores',
  'driving',
  'typing_desk',
  'carrying',
  'eating',
  'shower_dress',
  'ordinary_walk',
  'walk_holding_phone',
  'vigorous_wrist_non_workout',
  'long_standing',
  'sleep_wake',
  'w5_neg',
]);

function overlap(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

function durationS(a0, a1) {
  return Math.max(0, (a1 - a0) / 1000);
}

/**
 * Leave-one-session-out folds. Never split windows from the same session.
 */
export function losoFolds(sessions = []) {
  const byKey = new Map();
  for (const s of sessions) {
    const key = String(s.participantId || s.userId || 'anon') + ':' + String(s.sessionId || s.id);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(s);
  }
  const keys = [...byKey.keys()];
  return keys.map((hold) => ({
    test: byKey.get(hold),
    train: keys.filter((k) => k !== hold).flatMap((k) => byKey.get(k)),
    holdout: hold,
  }));
}

export function matchDetections(labeled, detections) {
  const used = new Set();
  const pairs = [];
  const fn = [];
  for (const lab of labeled) {
    let best = null;
    let bestI = -1;
    let bestOv = 0;
    detections.forEach((d, i) => {
      if (used.has(i)) return;
      const ov = Math.min(lab.end, d.endTs) - Math.max(lab.start, d.onsetTs);
      if (ov > bestOv) {
        bestOv = ov;
        best = d;
        bestI = i;
      }
    });
    if (best && bestOv > 0) {
      used.add(bestI);
      pairs.push({ labeled: lab, detected: best, overlapS: bestOv / 1000 });
    } else fn.push(lab);
  }
  const fp = detections.filter((_, i) => !used.has(i));
  return { pairs, fn, fp };
}

export function eventLevelReport({
  labeled = [],
  detections = [],
  corpusStart,
  corpusEnd,
  classifications = [],
  coverage = {},
  v1Hits = null,
  nativeDetections = [],
} = {}) {
  const { pairs, fn, fp } = matchDetections(labeled, detections);
  const hours = Math.max(1 / 3600, durationS(corpusStart, corpusEnd) / 3600);
  const days = hours / 24;
  const tp = pairs.length;
  const recall = labeled.length ? tp / labeled.length : null;
  const precision = (tp + fp.length) ? tp / (tp + fp.length) : null;
  const latencies = pairs.map((p) => (p.detected.confirmedTs - p.labeled.start) / 1000);
  const onsetErr = pairs.map((p) => (p.detected.onsetTs - p.labeled.start) / 1000);
  const endErr = pairs.filter((p) => p.detected.endTs != null)
    .map((p) => (p.detected.endTs - p.labeled.end) / 1000);
  const durErr = pairs.filter((p) => p.detected.endTs != null)
    .map((p) => durationS(p.detected.onsetTs, p.detected.endTs) - durationS(p.labeled.start, p.labeled.end));
  const fpMinutes = fp.reduce((n, d) => n + durationS(d.onsetTs, d.endTs || d.confirmedTs) / 60, 0);
  const classN = classifications.length;
  const classCorrect = classifications.filter((c) => c.predicted === c.labeled).length;
  const genericN = classifications.filter((c) => c.predicted === 'generic_activity' || c.predicted === 'unknown').length;
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  let v1v2Disagree = null;
  if (Array.isArray(v1Hits)) {
    v1v2Disagree = labeled.filter((_, i) => Boolean(v1Hits[i]) !== Boolean(pairs.find((p) => p.labeled === labeled[i]))).length;
  }
  const nativeDisagree = nativeDetections.length
    ? detections.filter((d, i) => {
      const n = nativeDetections[i];
      if (!n) return true;
      return d.sport !== n.sport || Math.abs((d.onsetTs || 0) - (n.onsetTs || 0)) > 15000;
    }).length
    : null;
  return {
    eval_version: EVAL_VERSION,
    n_labeled: labeled.length,
    n_detected: detections.length,
    tp,
    fn: fn.length,
    fp: fp.length,
    recall,
    precision,
    false_workouts_per_hour: fp.length / hours,
    false_workouts_per_day: fp.length / Math.max(days, 1 / 24),
    false_positive_minutes_per_day: fpMinutes / Math.max(days, 1 / 24),
    detection_latency_s: mean(latencies),
    onset_error_s: mean(onsetErr),
    end_error_s: mean(endErr),
    duration_error_s: mean(durErr),
    activity_accuracy: classN ? classCorrect / classN : null,
    generic_unknown_rate: classN ? genericN / classN : null,
    modality_coverage: coverage,
    v1_v2_disagree: v1v2Disagree,
    native_backend_disagree: nativeDisagree,
    false_positives: fp.map((d) => ({ onsetTs: d.onsetTs, sport: d.sport, path: d.confirmPath })),
    misses: fn.map((l) => ({ id: l.id, start: l.start, sport: l.sport })),
  };
}

function feed(create, samples, { restingHr, maxHr }) {
  const events = [];
  const det = create({
    thresholds: () => ({ restingHr, maxHr }),
    onEvent: (e) => events.push(e),
  });
  for (const s of samples) det.ingest(s);
  if (samples.length) det.tick(samples[samples.length - 1].ts + 1000);
  const starts = events.filter((e) => e.type === 'workout_start');
  const ends = events.filter((e) => e.type === 'workout_end');
  return starts.map((st, i) => ({
    onsetTs: st.workout.effectiveStartTs || st.workout.onsetTs,
    confirmedTs: st.workout.confirmedTs || st.ts,
    endTs: ends[i]?.workout?.endTs ?? null,
    sport: st.workout.sport,
    activity: st.workout.activity,
    confirmPath: st.workout.confirmPath,
  }));
}

export function replayEventLevel({ samples, labeled, restingHr, maxHr, corpusStart, corpusEnd }) {
  const v1 = feed(createWorkoutDetector, samples, { restingHr, maxHr });
  const v2 = feed(createWorkoutDetectorV2, samples, { restingHr, maxHr });
  const classifications = labeled.map((lab) => {
    const hit = v2.find((d) => overlap(lab.start, lab.end, d.onsetTs, d.endTs || d.confirmedTs));
    return { labeled: lab.sport, predicted: hit?.activity || hit?.sport || 'unknown' };
  });
  return {
    v1: eventLevelReport({
      labeled, detections: v1, corpusStart, corpusEnd,
    }),
    v2: eventLevelReport({
      labeled,
      detections: v2,
      corpusStart,
      corpusEnd,
      classifications,
      v1Hits: labeled.map((lab) => v1.some((d) => overlap(lab.start, lab.end, d.onsetTs, d.endTs || d.confirmedTs))),
    }),
  };
}
