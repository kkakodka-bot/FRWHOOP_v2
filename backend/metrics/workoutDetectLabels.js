/**
 * Immutable workout-detector correction events. User edits never overwrite
 * the original detector output; they append a new row for later learning.
 */
import { randomUUID } from 'node:crypto';

export const CORRECTION_ACTIONS = Object.freeze([
  'confirmed',
  'edited',
  'deleted',
  'confirmed_correct',
  'dismissed_false_positive',
  'edited_sport',
  'edited_start',
  'edited_end',
  'manual_missed_workout',
]);

export function createCorrectionEvent({
  workoutId,
  detectorVersion,
  featureSchemaVersion,
  predictedStart,
  predictedEnd,
    predictedType,
    userStart,
    userEnd,
    userType,
    action,
    featureObjectRef,
    lane,
    modalityTier,
    confirmPath,
    evidenceScore,
    featureVector,
    atMs,
  } = {}) {
  const act = CORRECTION_ACTIONS.includes(action) ? action : 'edited';
  const at = Number.isFinite(atMs) ? new Date(atMs).toISOString() : new Date().toISOString();
  return Object.freeze({
    id: randomUUID(),
    workout_id: workoutId || null,
    detector_version: detectorVersion || null,
    feature_schema_version: featureSchemaVersion || null,
    predicted_start: predictedStart ?? null,
    predicted_end: predictedEnd ?? null,
    predicted_type: predictedType ?? null,
    user_start: userStart ?? null,
    user_end: userEnd ?? null,
    user_type: userType ?? null,
    action: act,
    feature_object_ref: featureObjectRef || null,
    lane: lane ?? null,
    modality_tier: modalityTier ?? null,
    confirm_path: confirmPath ?? null,
    evidence_score: evidenceScore ?? null,
    feature_vector: featureVector ?? null,
    at,
  });
}
