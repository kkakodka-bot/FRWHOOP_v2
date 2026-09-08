/**
 * Workout and sleep reconciliation. Matching is overlap-based, never exact timestamps.
 * Apple-owned samples are never deleted or mutated; we only decide how FRWHOOP relates to them.
 */

export const DEFAULT_WORKOUT_THRESHOLDS = Object.freeze({
  sameIou: 0.7,
  sameOverlapFraction: 0.8,
  sameStartDeltaSec: 15 * 60,
  likelyIou: 0.45,
  likelyOverlapSec: 20 * 60,
  hrRelTolerance: 0.12,
  distanceRelTolerance: 0.15,
  calorieRelTolerance: 0.25,
  sportBoost: 0.08,
  sportPenalty: 0.12,
});

export const DEFAULT_SLEEP_THRESHOLDS = Object.freeze({
  sameIou: 0.75,
  likelyIou: 0.5,
  uncertainOverlapSec: 30 * 60,
});

export function toMs(value) {
  if (value == null) return NaN;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const n = Date.parse(value);
  return n;
}

export function intervalOf(row) {
  const start = toMs(row.start ?? row.start_at ?? row.startTime ?? row.startTs);
  const end = toMs(row.end ?? row.end_at ?? row.endTime ?? row.endTs);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end, duration: end - start };
}

export function overlapMs(a, b) {
  if (!a || !b) return 0;
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export function unionMs(a, b) {
  if (!a || !b) return 0;
  return Math.max(a.end, b.end) - Math.min(a.start, b.start);
}

/** Intersection over union of two half-open time intervals. */
export function intervalIoU(a, b) {
  const ov = overlapMs(a, b);
  const un = unionMs(a, b);
  return un > 0 ? ov / un : 0;
}

function relClose(a, b, tol) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return Math.abs(a - b) / Math.max(a, b) <= tol;
}

function sportKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/training|workout|session/g, '')
    .replace(/[^a-z]/g, '')
    .slice(0, 24);
}

function sportsCompatible(a, b) {
  const ka = sportKey(a);
  const kb = sportKey(b);
  if (!ka || !kb) return null;
  if (ka === kb) return true;
  const aliases = [
    ['run', 'running', 'jog'],
    ['cycle', 'cycling', 'bike', 'biking'],
    ['walk', 'walking', 'hike', 'hiking'],
    ['strength', 'lifting', 'weights', 'weighttraining'],
  ];
  return aliases.some((group) => group.some((g) => ka.includes(g)) && group.some((g) => kb.includes(g)));
}

/**
 * @returns {{ match: 'same_workout'|'likely_same_workout'|'different_workout'|'uncertain', confidence: number, iou: number, overlapSec: number, reasons: string[] }}
 */
export function classifyWorkoutMatch(frwhoop, external, thresholds = DEFAULT_WORKOUT_THRESHOLDS) {
  const a = intervalOf(frwhoop);
  const b = intervalOf(external);
  if (!a || !b) {
    return { match: 'uncertain', confidence: 0, iou: 0, overlapSec: 0, reasons: ['missing_interval'] };
  }
  const iou = intervalIoU(a, b);
  const overlapSec = overlapMs(a, b) / 1000;
  const startDeltaSec = Math.abs(a.start - b.start) / 1000;
  const minDur = Math.min(a.duration, b.duration) / 1000;
  const reasons = [`iou=${iou.toFixed(3)}`, `overlap_s=${Math.round(overlapSec)}`];

  let score = iou;
  const sport = sportsCompatible(
    frwhoop.sport || frwhoop.type || frwhoop.summary?.sport || frwhoop.summary?.name,
    external.sport || external.type || external.summary?.sport || external.summary?.name,
  );
  if (sport === true) { score += thresholds.sportBoost; reasons.push('sport_match'); }
  if (sport === false) { score -= thresholds.sportPenalty; reasons.push('sport_mismatch'); }

  const hrA = Number(frwhoop.avgHr ?? frwhoop.avg_hr ?? frwhoop.summary?.avg_hr);
  const hrB = Number(external.avgHr ?? external.avg_hr ?? external.summary?.avg_hr);
  if (relClose(hrA, hrB, thresholds.hrRelTolerance)) { score += 0.05; reasons.push('hr_similar'); }
  else if (Number.isFinite(hrA) && Number.isFinite(hrB) && !relClose(hrA, hrB, 0.35)) {
    score -= 0.08; reasons.push('hr_divergent');
  }

  const dA = Number(frwhoop.distanceM ?? frwhoop.distance_m ?? frwhoop.summary?.distance_m);
  const dB = Number(external.distanceM ?? external.distance_m ?? external.summary?.distance_m);
  if (relClose(dA, dB, thresholds.distanceRelTolerance)) { score += 0.05; reasons.push('distance_similar'); }

  const cA = Number(frwhoop.calories ?? frwhoop.energyKcal ?? frwhoop.summary?.calories);
  const cB = Number(external.calories ?? external.energyKcal ?? external.summary?.calories);
  if (relClose(cA, cB, thresholds.calorieRelTolerance)) reasons.push('calorie_similar');

  score = Math.max(0, Math.min(1, score));
  const sameByOverlap = overlapSec >= thresholds.sameOverlapFraction * minDur
    && startDeltaSec <= thresholds.sameStartDeltaSec
    && minDur >= 5 * 60;

  if (iou >= thresholds.sameIou || sameByOverlap) {
    return { match: 'same_workout', confidence: Math.max(score, 0.85), iou, overlapSec, reasons };
  }
  if (iou >= thresholds.likelyIou || overlapSec >= thresholds.likelyOverlapSec) {
    return { match: 'likely_same_workout', confidence: Math.max(score, 0.6), iou, overlapSec, reasons };
  }
  if (overlapSec > 0) {
    return { match: 'uncertain', confidence: score, iou, overlapSec, reasons };
  }
  return { match: 'different_workout', confidence: 1 - Math.min(1, startDeltaSec / 86400), iou, overlapSec, reasons };
}

/**
 * @returns {{ match: 'same_sleep'|'likely_same_sleep'|'different_sleep'|'uncertain', confidence: number, iou: number, overlapSec: number, reasons: string[] }}
 */
export function classifySleepMatch(frwhoop, external, thresholds = DEFAULT_SLEEP_THRESHOLDS) {
  const a = intervalOf(frwhoop);
  const b = intervalOf(external);
  if (!a || !b) {
    return { match: 'uncertain', confidence: 0, iou: 0, overlapSec: 0, reasons: ['missing_interval'] };
  }
  const iou = intervalIoU(a, b);
  const overlapSec = overlapMs(a, b) / 1000;
  const reasons = [`iou=${iou.toFixed(3)}`];
  if (iou >= thresholds.sameIou) {
    return { match: 'same_sleep', confidence: Math.max(0.85, iou), iou, overlapSec, reasons };
  }
  if (iou >= thresholds.likelyIou) {
    return { match: 'likely_same_sleep', confidence: Math.max(0.6, iou), iou, overlapSec, reasons };
  }
  if (overlapSec >= thresholds.uncertainOverlapSec) {
    return { match: 'uncertain', confidence: iou, iou, overlapSec, reasons };
  }
  return { match: 'different_sleep', confidence: overlapSec === 0 ? 0.9 : 0.4, iou, overlapSec, reasons };
}

/**
 * Decide what FRWHOOP should do with a matching Apple workout. Never modifies Apple samples.
 */
export function workoutRelationship(match) {
  switch (match) {
    case 'same_workout':
      return 'skip_write';
    case 'likely_same_workout':
      return 'associate';
    case 'uncertain':
      return 'comparison';
    default:
      return 'write';
  }
}

export function sleepRelationship(match) {
  switch (match) {
    case 'same_sleep':
    case 'likely_same_sleep':
      return 'comparison';
    case 'uncertain':
      return 'validation';
    default:
      return 'fallback';
  }
}

/**
 * Pair each external interval to at most one canonical interval (greedy by IoU).
 * ponytail: O(n×m) scan is fine for a day of workouts; upgrade to interval tree if a user logs hundreds.
 */
export function pairIntervals(canonical, external, classify) {
  const pairs = [];
  const usedExt = new Set();
  const usedCan = new Set();
  const scored = [];
  for (let i = 0; i < canonical.length; i += 1) {
    for (let j = 0; j < external.length; j += 1) {
      const result = classify(canonical[i], external[j]);
      scored.push({ i, j, result, iou: result.iou || 0 });
    }
  }
  scored.sort((a, b) => b.iou - a.iou);
  for (const row of scored) {
    if (usedCan.has(row.i) || usedExt.has(row.j)) continue;
    if ((row.result.iou || 0) <= 0 && row.result.match?.startsWith('different')) continue;
    usedCan.add(row.i);
    usedExt.add(row.j);
    pairs.push({
      canonical: canonical[row.i],
      external: external[row.j],
      ...row.result,
    });
  }
  const unmatchedCanonical = canonical.filter((_, i) => !usedCan.has(i));
  const unmatchedExternal = external.filter((_, j) => !usedExt.has(j));
  return { pairs, unmatchedCanonical, unmatchedExternal };
}
