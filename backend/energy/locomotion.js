/**
 * Activity-specific locomotion energy experts (Phase 5).
 *
 * The mission requires activity-specific expenditure experts rather than one
 * universal HR equation. This module implements validated locomotion equations
 * (walking, running, grades) as physiological *priors* — the thing to compare a
 * learned/HR model against, and to fall back to when GPS speed is known. These
 * are the ACSM metabolic equations, which express oxygen uptake from speed and
 * grade. They are standard, well-validated, documented in primary literature,
 * and independently reimplemented here (no code copied).
 *
 * Provenance:
 *   ACSM walking VO2 (mL/kg/min):
 *     VO2 = 0.1*speed(m/min) + 1.8*speed*grade(fraction) + 3.5
 *   ACSM running VO2:
 *     VO2 = 0.2*speed(m/min) + 0.9*speed*grade + 3.5
 *   (American College of Sports Medicine, "ACSM's Guidelines for Exercise
 *   Testing and Prescription." Horizontal + grade components.)
 *
 * Speed input: GPS speed (m/s) from the phone, or cadence-derived estimate.
 * The equations need true overground speed; wrist cadence alone is a weak
 * proxy, so when only cadence is available the expert returns a WIDER
 * uncertainty and marks speed_source='cadence_derived'.
 *
 * Output is VO2 (mL/kg/min) in the engine's internal currency, so it fuses
 * directly with the existing channels. Convert speed m/s = m/min / 60.
 */

import { clamp, num } from './constants.js';

/** Convert a step cadence (steps/min) to a walking speed estimate (m/s).
 *  Gait studies: ~0.6-0.8 m/step for walking adults (stride length ∝ leg),
 *  but wrist cadence-to-stride is noisy; use a range. */
export function cadenceToWalkSpeed(stepsPerMin) {
  const spm = num(stepsPerMin);
  if (spm == null || spm <= 0) return null;
  // typical walk cadence 90-130 spm; stride ~0.6-0.8 m => speed = spm*stride/60
  const lo = (spm * 0.6) / 60;
  const hi = (spm * 0.8) / 60;
  return { speedMsLo: lo, speedMsHi: hi, speedMsCentral: (lo + hi) / 2, source: 'cadence_derived' };
}

/**
 * ACSM walking VO2 (mL/kg/min) from overground speed (m/s) and grade (fraction).
 * VO2 includes the 3.5 resting constant (resting + activity components combined).
 */
export function walkingVo2({ speedMs, grade = 0, weightKg = null } = {}) {
  const speed = num(speedMs);
  if (speed == null || speed <= 0) return null;
  const mPerMin = speed * 60;
  // 0.1 * speed(m/min) + 1.8 * speed(m/min)*grade + 3.5
  const vo2 = 0.1 * mPerMin + 1.8 * mPerMin * grade + 3.5;
  return { vo2MlPerKgMin: round(vo2, 3), grade, speedMs: speed, equation: 'acsm_walking' };
}

/**
 * ACSM running VO2 (mL/kg/min) from overground speed (m/s) and grade.
 */
export function runningVo2({ speedMs, grade = 0, weightKg = null } = {}) {
  const speed = num(speedMs);
  if (speed == null || speed <= 0) return null;
  const mPerMin = speed * 60;
  const vo2 = 0.2 * mPerMin + 0.9 * mPerMin * grade + 3.5;
  return { vo2MlPerKgMin: round(vo2, 3), grade, speedMs: speed, equation: 'acsm_running' };
}

/**
 * The locomotion expert wrapper used by routeEstimate: given a classified
 * activity and an optional reliable speed, return a VO2 prior.
 *
 * @returns {null|{vo2MlPerKgMin, speedSource, uncertainty:'low'|'medium'|'high'}}
 */
export function locomotionExpert({
  activity, speedMs = null, cadenceSpm = null, grade = 0, physiology,
} = {}) {
  const weightKg = physiology?.weightKg ?? null;
  const isRun = activity === 'running';
  const isWalk = activity === 'walking';
  if (!isRun && !isWalk) return null;

  let speed = num(speedMs);
  let speedSource = speed != null && speed > 0.3 ? 'gps' : null;

  if (speed == null && cadenceSpm != null) {
    const cs = cadenceToWalkSpeed(cadenceSpm);
    // For running, cadence 150-190 spm; treat central estimate as speed.
    const cad = num(cadenceSpm);
    speed = isRun ? (cad * 1.2) / 60 : cs.speedMsCentral; // run stride ~1.2-1.5 m
    speedSource = 'cadence_derived';
  }
  if (speed == null) return null;

  const eq = isRun ? runningVo2({ speedMs: speed, grade, weightKg }) : walkingVo2({ speedMs: speed, grade, weightKg });
  if (!eq) return null;
  const uncertainty = speedSource === 'gps' ? 'low' : 'high';
  return { ...eq, speedSource, uncertainty };
}

/** Sanity check plausible range: a walking expert should stay within 2-7 MET. */
export function plausibleVo2ForActivity(activity, vo2) {
  const met = vo2 / 3.5;
  if (activity === 'walking') return met >= 1.5 && met <= 8;
  if (activity === 'running') return met >= 5 && met <= 22;
  return true;
}

function round(n, p) {
  const f = 10 ** p;
  return Math.round(n * f) / f;
}
