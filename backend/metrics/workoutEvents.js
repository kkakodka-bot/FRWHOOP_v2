import { randomUUID } from 'node:crypto';
import { stableUuid } from '../storage/structuredSync.js';

export const WORKOUT_EVENT_TYPES = Object.freeze([
  'workout_candidate_started',
  'workout_confirmed',
  'workout_mode_started',
  'haptic_attempted',
  'haptic_succeeded',
  'haptic_failed',
  'workout_dismissed',
  'workout_sport_changed',
  'workout_ended_automatically',
  'workout_ended_manually',
  'workout_persisted',
  'workout_sync_succeeded',
  'workout_sync_failed',
]);

export function workoutLedgerEvent({
  userId,
  type,
  session,
  extra = {},
  atMs,
} = {}) {
  const at = Number.isFinite(atMs) ? new Date(atMs).toISOString() : new Date().toISOString();
  const workoutId = session?.id || extra.workout_id || extra.workoutId || null;
  return {
    id: extra.id || (workoutId && type
      ? stableUuid([String(userId || 'local'), type, String(workoutId), String(at)])
      : randomUUID()),
    user_id: userId,
    event_type: type,
    occurred_at: at,
    source: 'auto-detect',
    numeric_value: extra.numeric_value ?? session?.hr ?? null,
    text_value: extra.reason_code || extra.reason || session?.reasonCode || null,
    payload: {
      workout_id: workoutId,
      timestamp: at,
      detector_version: session?.detectorVersion || extra.detector_version || null,
      whoop_generation: session?.whoopGeneration || extra.whoop_generation || null,
      firmware: session?.firmware || extra.firmware || null,
      hr_threshold: session?.floor ?? extra.hr_threshold ?? null,
      confidence: session?.confidence || extra.confidence || null,
      reason_code: extra.reason_code || extra.reason || session?.reasonCode || null,
      confirmation_path: session?.confirmationPath || extra.confirmation_path || null,
      lifecycle: session?.lifecycle || extra.lifecycle || null,
      detector_state: session?.detectorState || extra.detector_state || null,
      ...extra.payload,
    },
  };
}
