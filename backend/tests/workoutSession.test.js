import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySessionPhysiology,
  createCanonicalWorkout,
  elapsedLabelFromMs,
  estimateDetectedStrain,
  isOpenWorkout,
} from '../metrics/workoutSession.js';
import { workoutLedgerEvent } from '../metrics/workoutEvents.js';

test('canonical session starts ACTIVE and is open until completed', () => {
  const session = createCanonicalWorkout({
    id: 'w1',
    start: { onsetTs: 1_000, confirmedTs: 4_000, floor: 119, confirmPath: 'high_confidence', confidence: 'high' },
    detectorVersion: '1.2.0',
    nowMs: 4_000,
  });
  assert.equal(session.lifecycle, 'ACTIVE');
  assert.equal(isOpenWorkout(session), true);
  assert.equal(session.confirmationPath, 'high_confidence');
  assert.equal(elapsedLabelFromMs(0, 124_000), '2:04');
});

test('physiology updates keep one id and move ENDING with the detector', () => {
  const session = createCanonicalWorkout({
    id: 'w1',
    start: { onsetTs: 0, confirmedTs: 180_000, floor: 119, restingHr: 60, maxHr: 190 },
    nowMs: 180_000,
  });
  const next = applySessionPhysiology(session, {
    lastBpm: 150,
    lastSampleTs: 200_000,
    internalState: 'ENDING',
    detectorState: 'CONFIRMED',
    activeWorkout: { durationS: 200, avgHr: 148, peakHr: 151, zone: 3 },
  }, 200_000);
  assert.equal(next.id, 'w1');
  assert.equal(next.lifecycle, 'ENDING');
  assert.equal(next.hr, 150);
  assert.ok(next.strain > 0);
});

test('ledger events always carry workout_id and detector version', () => {
  const row = workoutLedgerEvent({
    userId: '00000000-0000-4000-8000-000000000001',
    type: 'workout_confirmed',
    session: { id: 'w1', detectorVersion: '1.2.0', floor: 119, confidence: 'high', reasonCode: 'hr_onset_motion' },
    extra: { reason_code: 'hr_onset_motion' },
    atMs: Date.parse('2026-08-24T12:00:00Z'),
  });
  assert.equal(row.event_type, 'workout_confirmed');
  assert.equal(row.payload.workout_id, 'w1');
  assert.equal(row.payload.detector_version, '1.2.0');
  assert.equal(row.payload.hr_threshold, 119);
  assert.ok(estimateDetectedStrain(20, 140, 60, 190) > 0);
});
