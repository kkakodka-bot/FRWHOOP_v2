/**
 * Canonical workout session — the authority after the detector confirms.
 *
 * Detector: IDLE → POSSIBLE → LIKELY → CONFIRMED
 * Workout:  ACTIVE → ENDING → COMPLETED
 * Terminal alternatives: DISMISSED | FAILED
 */

export const WORKOUT_LIFECYCLES = Object.freeze([
  'ACTIVE',
  'ENDING',
  'COMPLETED',
  'DISMISSED',
  'FAILED',
]);

export const OPEN_LIFECYCLES = Object.freeze(new Set(['ACTIVE', 'ENDING']));

export function isOpenWorkout(session) {
  return Boolean(session && OPEN_LIFECYCLES.has(session.lifecycle));
}

export function estimateDetectedStrain(durationMin, avgHr, restingHr, maxHr) {
  if (!Number.isFinite(avgHr) || !Number.isFinite(durationMin) || durationMin <= 0) return 0;
  const hrr = Math.max(1, (maxHr || 190) - (restingHr || 60));
  const intensity = Math.min(1.0, Math.max(0.3, 0.35 + ((avgHr - (restingHr || 60)) / hrr) * 1.2));
  const hrFactor = Math.max(0.4, Math.min(1.4, (avgHr - 70) / 70));
  const raw = Math.max(0, durationMin) * intensity * hrFactor;
  return Math.round((21 * Math.log(1 + raw) / Math.log(1 + 180)) * 10) / 10;
}

export function elapsedLabelFromMs(startMs, nowMs) {
  const sec = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function createCanonicalWorkout({
  id,
  start,
  device = {},
  detectorVersion,
  nowMs,
} = {}) {
  const onsetTs = start.effectiveStartTs ?? start.onsetTs;
  const confirmedTs = start.confirmedTs ?? nowMs;
  return {
    id,
    lifecycle: 'ACTIVE',
    detectorState: 'CONFIRMED',
    onsetTs,
    detectedStartTs: start.detectedStartTs ?? onsetTs,
    confirmedTs,
    effectiveStartTs: start.effectiveStartTs ?? onsetTs,
    start: new Date(onsetTs).toISOString(),
    confirmedAt: new Date(confirmedTs).toISOString(),
    hr: null,
    zone: 0,
    avgHr: null,
    peakHr: null,
    strain: 0,
    durationS: 0,
    floor: start.floor ?? null,
    restingHr: start.restingHr ?? null,
    maxHr: start.maxHr ?? null,
    motionMean: start.motionMean ?? null,
    onsetRiseBpm: start.onsetRiseBpm ?? null,
    confirmationPath: start.confirmPath || 'hr_only',
    sport: start.sport || 'detected',
    segments: [{ sport: start.sport || 'detected', startTs: onsetTs }],
    confidence: start.confidence || (start.confirmPath === 'high_confidence' ? 'high' : 'standard'),
    reasonCode: start.confirmReason || 'confirmed',
    detectorVersion: detectorVersion || null,
    whoopGeneration: device.generation || device.model || null,
    firmware: device.firmware || null,
    deviceId: device.deviceId || null,
    connected: device.connected !== false,
    haptic: {
      pending: false,
      attempted: false,
      succeeded: null,
      at: null,
    },
    liveActivityStarted: false,
    modeOpened: false,
    lastSampleTs: confirmedTs,
    endReason: null,
    endedAt: null,
  };
}

export function applySessionPhysiology(session, snap, nowMs) {
  if (!isOpenWorkout(session)) return session;
  const elapsedS = snap?.activeWorkout?.elapsedDurationS
    ?? snap?.activeWorkout?.durationS
    ?? (session.onsetTs ? Math.max(0, Math.round((nowMs - session.onsetTs) / 1000)) : session.durationS);
  const physS = snap?.activeWorkout?.observedDurationS ?? elapsedS;
  const avgHr = snap?.activeWorkout?.avgHr ?? session.avgHr;
  const peakHr = snap?.activeWorkout?.peakHr ?? session.peakHr;
  const hr = snap?.lastBpm ?? session.hr;
  const zone = snap?.activeWorkout?.zone
    ?? session.zone;
  const physMin = Math.max(1 / 60, physS / 60);
  return {
    ...session,
    detectorState: snap?.detectorState || session.detectorState,
    hr,
    zone,
    avgHr,
    peakHr,
    durationS: elapsedS,
    elapsedDurationS: elapsedS,
    observedDurationS: physS,
    unknownGapS: snap?.unknownGapS ?? session.unknownGapS ?? 0,
    strain: estimateDetectedStrain(physMin, avgHr, session.restingHr, session.maxHr),
    motionMean: snap?.confirmPath ? session.motionMean : session.motionMean,
    sport: snap?.sport || snap?.activeWorkout?.sport || session.sport,
    lastSampleTs: snap?.lastSampleTs ?? session.lastSampleTs,
    connected: snap?.stale ? false : session.connected,
    lifecycle: snap?.internalState === 'ENDING' ? 'ENDING' : (session.lifecycle === 'ENDING' && snap?.internalState === 'CONFIRMED' ? 'ACTIVE' : session.lifecycle),
  };
}

export function viewOfWorkout(session, nowMs = Date.now()) {
  if (!session) return null;
  return {
    ...session,
    elapsedLabel: elapsedLabelFromMs(session.onsetTs, nowMs),
    stale: session.lastSampleTs != null && (nowMs - session.lastSampleTs) > 120_000,
  };
}
