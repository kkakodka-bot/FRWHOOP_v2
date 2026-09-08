import { appendWearLocationEvent, mergeWearLocationEvents } from '../energy/v3/placement.js';

export function applyWorkoutRuntimePrefs(prefs = {}, body = {}) {
  const next = { ...prefs };
  if (typeof body.autoWorkoutDetect === 'boolean') next.autoWorkoutDetect = body.autoWorkoutDetect;
  if (typeof body.hapticAlerts === 'boolean') next.hapticAlerts = body.hapticAlerts;
  if (typeof body.autoWorkoutHaptics === 'boolean') next.autoWorkoutHaptics = body.autoWorkoutHaptics;
  if (typeof body.autoWorkoutMotionRequired === 'boolean') next.autoWorkoutMotionRequired = body.autoWorkoutMotionRequired;
  if (body.autoWorkoutMinConfidence === 'high' || body.autoWorkoutMinConfidence === 'standard') {
    next.autoWorkoutMinConfidence = body.autoWorkoutMinConfidence;
  }
  if (typeof body.autoWorkoutDetectorVersion === 'string' && body.autoWorkoutDetectorVersion.trim()) {
    next.autoWorkoutDetectorVersion = body.autoWorkoutDetectorVersion.trim().slice(0, 32);
  }
  const pct = Number(body.autoWorkoutRolloutPercentage);
  if (Number.isFinite(pct)) next.autoWorkoutRolloutPercentage = Math.max(0, Math.min(100, Math.round(pct)));
  if (body.wearLocation === 'wrist' || body.wearLocation === 'bicep') next.wearLocation = body.wearLocation;
  if (Array.isArray(body.wearLocationEvents)) {
    next.wearLocationEvents = mergeWearLocationEvents(prefs.wearLocationEvents, body.wearLocationEvents);
  }
  if (body.wearLocation === 'wrist' || body.wearLocation === 'bicep') {
    next.wearLocationEvents = appendWearLocationEvent(next.wearLocationEvents, body.wearLocation);
  }
  return next;
}

/**
 * Cloud settings -> the flags the detector reads locally. Keeps the strap buzz
 * on the user's saved choice across a host restart, when local prefs are still
 * at their defaults and the app has not hinted yet.
 *
 * Fills gaps only. The startup pull is asynchronous, so it can land after the
 * app has already hinted; overwriting there would silence a buzz the app just
 * asked for.
 */
export function applyCloudWorkoutSettings(prefs = {}, settings = {}) {
  const fromCloud = {
    autoWorkoutDetect: settings.autoWorkoutDetect,
    hapticAlerts: settings.hapticAlerts,
    autoWorkoutHaptics: settings.autoWorkoutHaptics,
    autoWorkoutMotionRequired: settings.autoWorkoutMotionRequired,
    autoWorkoutMinConfidence: settings.autoWorkoutMinConfidence,
    autoWorkoutDetectorVersion: settings.autoWorkoutDetectorVersion,
    autoWorkoutRolloutPercentage: settings.autoWorkoutRolloutPercentage,
  };
  for (const key of Object.keys(fromCloud)) {
    if (prefs[key] !== undefined) delete fromCloud[key];
  }
  return applyWorkoutRuntimePrefs(prefs, fromCloud);
}

export function workoutRuntimeView(prefs = {}) {
  const pct = Number(prefs.autoWorkoutRolloutPercentage);
  return {
    ok: true,
    autoWorkoutDetect: prefs.autoWorkoutDetect !== false,
    hapticAlerts: prefs.hapticAlerts !== false,
    autoWorkoutHaptics: prefs.autoWorkoutHaptics === true,
    autoWorkoutMotionRequired: prefs.autoWorkoutMotionRequired === true,
    autoWorkoutMinConfidence: prefs.autoWorkoutMinConfidence === 'high' ? 'high' : 'standard',
    autoWorkoutDetectorVersion: prefs.autoWorkoutDetectorVersion || '2.2.1-beta',
    autoWorkoutRolloutPercentage: Number.isFinite(pct) ? pct : 100,
  };
}
