/**
 * HR V2 quality layer.
 *
 * Two deliberately separated claims (mission: "Distinguish physiological
 * plausibility from measurement confidence"):
 *   plausible  - hard physiological possibility (range + ceiling physics).
 *   score      - HEURISTIC measurement confidence in [0,1]. NOT a calibrated
 *                probability; must never be presented as P(|err| < X bpm).
 *                The calibrated form {calibrated:true, model_version,
 *                threshold_bpm} is reserved for an ECG-reference corpus
 *                (_hr_v2_research/ppg_hr_accuracy_research.md section 3.2).
 *
 * Features (ppg_hr_accuracy_research.md section 6.1): motion, staleness,
 * reported device quality, temporal consistency/slew, source agreement,
 * RR corroboration, cadence lock, frozen value, reluctant change,
 * age-aware ceiling. Unknown proprietary flag bytes stay NEUTRAL observation
 * fields until validated (whoop-protocol-ppg.md section 4: semantics UNKNOWN).
 */

import {
  HR_STALENESS,
  CONFIDENCE,
  clamp,
} from '../signal/constants.js';

/** Median HR change per 10 s near-implausible outside maximal-effort
 *  onset/recovery (accuracy report 4.2). Context-aware: annotates rather than
 *  rejects during active motion. ENGINEERING-DEFAULT. */
export const MAX_SLEW_BPM_PER_10S = 25;
/** Motion scalar above this is "active" (signal/quality.js precedent). */
export const MOTION_ACTIVE = 0.15;
/** |HR - 60/meanRR| beyond this, with >=2 valid RRs, contradicts the BPM. */
export const RR_CONSISTENCY_DELTA_BPM = 12;
/** Cadence-lock: sustained |HR - k*stepCadence| within this for >= CADENCE_LOCK_MIN_S. */
export const CADENCE_LOCK_DELTA_BPM = 5;
export const CADENCE_LOCK_MIN_S = 180;
/** Frozen-value run that flags an optical relock (accuracy report 6.1 #6). */
export const FROZEN_RUN_MIN_S = 120;
/** Reluctant change: flat +-1 bpm across a motion spike >3x local median (6.1 #8). */
export const RELUCTANT_BAND_BPM = 1;
export const RELUCTANT_SPIKE_RATIO = 3;
/** A run at least this long at a constant bpm is a stuck sensor, not rest. */
export const FLATLINE_RUN_MIN_S = 3600;
/** Neighbor spans longer than this no longer imply temporal adjacency. */
const NEIGHBOR_CAP_MS = 60_000;

export const QUALITY_VERSION = 'hr2-quality-1';

function median(values) {
  const list = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = list.length >> 1;
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function tanakaMax(age) {
  // Tanaka, Monahan, Seals 2001 (18,712 subjects): HRmax = 208 - 0.7*age.
  return 208 - 0.7 * Number(age);
}

function result(score, flags, plausible) {
  return {
    score: Math.round(clamp(score, CONFIDENCE.min, CONFIDENCE.max) * 100) / 100,
    flags: [...flags],
    plausible,
    calibrated: false,
    version: QUALITY_VERSION,
  };
}

/**
 * Score one observation. `context` carries precomputed window features:
 *   { age, gapFromPreviousS, windowFlags: string[] }
 */
export function assessObservation(obs, context = {}) {
  if (obs == null || obs.bpm == null) {
    return result(CONFIDENCE.min, ['hr_absent'], false);
  }
  const flags = [];
  const plausible = true;

  // ---- Stage A: plausibility (flag-only, never clamped) ----
  const age = Number.isFinite(Number(context.age)) ? Number(context.age) : null;
  if (age != null && obs.bpm > tanakaMax(age) + 25) flags.push('age_ceiling');

  // ---- Stage B: heuristic measurement confidence ----
  let score = 1.0;

  // 1) Reported device quality (absent `q` = neutral, never suspicious).
  const q = obs.q_reported;
  if (q != null && q < 0.6) {
    score *= clamp((q + 0.3) / 0.9, 0.2, 1);
    flags.push('low_q_reported');
  }

  // 2) Motion: graded contamination, never a hard reject.
  const mot = obs.motion;
  if (mot != null && mot > MOTION_ACTIVE) {
    score *= clamp(1 - (mot - MOTION_ACTIVE) * 0.3, 0.45, 1);
    flags.push('motion_high');
  }

  // 3) Staleness: first reading after a long silence resumes a stale stream.
  if (context.gapFromPreviousS != null && context.gapFromPreviousS > HR_STALENESS.carrySeconds) {
    score *= 0.75;
    flags.push('stale');
  }

  // 4) RR corroboration (sinus decoupling signature).
  if ((obs.rr_ms || []).length >= 2) {
    const meanRr = obs.rr_ms.reduce((a, b) => a + b, 0) / obs.rr_ms.length;
    const hrFromRr = 60_000 / meanRr;
    if (Math.abs(hrFromRr - obs.bpm) > RR_CONSISTENCY_DELTA_BPM) {
      score *= 0.7;
      flags.push('rr_inconsistent');
    }
  }

  // 5) Cross-source disagreement (stamped by dedupe L2).
  const windowFlags = context.windowFlags || [];
  const hadDisagreement = (obs.flags || []).includes('source_disagreement')
    || windowFlags.includes('source_disagreement');
  if (hadDisagreement) {
    score *= 0.6;
    flags.push('source_disagreement');
  }

  // 6) Age ceiling downgrade.
  if (flags.includes('age_ceiling')) score *= 0.7;

  // 7) Window features (each with its documented factor).
  if (windowFlags.includes('frozen_value')) { score *= 0.75; flags.push('frozen_value'); }
  if (windowFlags.includes('reluctant_change')) { score *= 0.75; flags.push('reluctant_change'); }
  if (windowFlags.includes('cadence_lock')) { score *= 0.7; flags.push('cadence_lock'); }
  if (windowFlags.includes('slew_implausible')) {
    if (mot != null && mot > MOTION_ACTIVE) {
      flags.push('slew_annotated'); // may be real effort; annotate, cut less
    } else {
      score *= 0.8;
    }
    flags.push('slew_implausible');
  }
  if (windowFlags.includes('coverage_low')) { score *= 0.85; flags.push('coverage_low'); }

  return result(score, flags, plausible);
}

/**
 * Neighbor-aware scoring pass over a sorted observation list.
 *
 * Returns a Map<index, assessment> aligned with input order.
 *
 * @param {Array} observations canonical observations (ascending tMs)
 * @param {object} [opts] { age }
 */
export function assessWindow(observations, opts = {}) {
  const obs = observations || [];
  const n = obs.length;
  const out = new Map();

  // Local motion level for reluctant-change detection (accuracy report 6.1 #8:
  // motion spike = 3x the window median).
  const motionValues = obs.map((o) => o.motion).filter((v) => v != null);
  const motionMedian = median(motionValues) ?? 0;

  // --- Frozen-value runs (accuracy report 6.1 #6): identical bpm persisting
  // --- across >= FROZEN_RUN_MIN_S while any motion is present.
  const frozenFlag = new Array(n).fill(false);
  let runStart = 0;
  for (let i = 1; i <= n; i += 1) {
    const sameAsPrev = i < n
      && obs[i].bpm != null
      && obs[i - 1].bpm === obs[i].bpm
      && (obs[i].tMs - obs[i - 1].tMs) <= NEIGHBOR_CAP_MS;
    if (!sameAsPrev) {
      const runEnd = i - 1;
      const spanS = (obs[runEnd].tMs - obs[runStart].tMs) / 1000;
      if (obs[runEnd].bpm != null && spanS >= FROZEN_RUN_MIN_S) {
        const hasMotion = obs.slice(runStart, i).some((o) => (o.motion ?? 0) > 0.05);
        if (hasMotion) {
          for (let k = runStart; k < i; k += 1) frozenFlag[k] = true;
        }
      }
      runStart = i;
    }
  }

  // --- Cadence-lock runs (accuracy report 6.1 #7): sustained |HR - k*cadence|
  //     proximity, k in {1, 2, 1/2}, while the strap reports step cadence.
  //     NOTE: step_cadence semantics are only PARTIALLY pinned (whoop-protocol
  //     report); the feature is heuristic and neutral until validated.
  const cadenceFlag = new Array(n).fill(false);
  for (let i = 0; i < n; i += 1) {
    if (obs[i].bpm == null || obs[i].step_cadence == null || obs[i].step_cadence <= 0) continue;
    const cadenceBpm = obs[i].step_cadence; // cadence-like byte; treated in bpm-equivalent units
    let lockStart = i;
    let lockEnd = i;
    for (let j = i + 1; j < n; j += 1) {
      if (obs[j].bpm == null || obs[j].step_cadence == null) break;
      if ((obs[j].tMs - obs[j - 1].tMs) > NEIGHBOR_CAP_MS) break;
      const c = obs[j].step_cadence;
      const near = [1, 2, 0.5].some((k) => Math.abs(obs[j].bpm - c * k) < CADENCE_LOCK_DELTA_BPM);
      if (!near) break;
      lockEnd = j;
      if ((obs[lockEnd].tMs - obs[lockStart].tMs) / 1000 >= CADENCE_LOCK_MIN_S) break;
    }
    if (lockEnd > lockStart && (obs[lockEnd].tMs - obs[lockStart].tMs) / 1000 >= CADENCE_LOCK_MIN_S) {
      for (let k = lockStart; k <= lockEnd; k += 1) cadenceFlag[k] = true;
    }
    i = lockEnd; // skip past the scanned run
  }

  for (let i = 0; i < n; i += 1) {
    const o = obs[i];
    const prev = i > 0 ? obs[i - 1] : null;
    const next = i < n - 1 ? obs[i + 1] : null;
    const gapPrevS = prev ? (o.tMs - prev.tMs) / 1000 : null;
    const gapNextS = next ? (next.tMs - o.tMs) / 1000 : null;
    const windowFlags = [];

    if ((gapPrevS ?? 0) > 30 && (gapNextS ?? 0) > 30) windowFlags.push('coverage_low');

    if (prev && prev.bpm != null && o.bpm != null) {
      const dtS = Math.max((o.tMs - prev.tMs) / 1000, 0.001);
      const slew10 = (Math.abs(o.bpm - prev.bpm) / dtS) * 10;
      if (slew10 > MAX_SLEW_BPM_PER_10S) windowFlags.push('slew_implausible');
    }

    if (frozenFlag[i]) windowFlags.push('frozen_value');
    if (cadenceFlag[i]) windowFlags.push('cadence_lock');

    // Reluctant change: motion spike while HR is flat in a +-1 bpm band.
    if (o.motion != null && motionMedian > 0 && o.motion > motionMedian * RELUCTANT_SPIKE_RATIO) {
      const bandFlat = (prev && prev.bpm != null && Math.abs(o.bpm - prev.bpm) <= RELUCTANT_BAND_BPM)
        || (next && next.bpm != null && Math.abs(o.bpm - next.bpm) <= RELUCTANT_BAND_BPM);
      if (bandFlat) windowFlags.push('reluctant_change');
    }

    out.set(i, assessObservation(o, { age: opts.age, gapFromPreviousS: gapPrevS, windowFlags }));
  }
  return out;
}
