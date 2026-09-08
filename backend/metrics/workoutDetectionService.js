import { createWorkoutDetector, hrZone, sportDisplayName } from './workoutDetector.js';
import {
  createWorkoutDetectorV2,
  parseDetectorMode,
  compareNativeBackend,
  reconcileWorkoutV2,
  WORKOUT_DETECT_V2_ALGORITHM,
  WORKOUT_DETECT_V2_VERSION,
  WORKOUT_DETECT_V1_VERSION,
  FEATURE_SCHEMA_VERSION,
  DETECTION_PIPELINE_STAGES,
} from './workoutDetectV2.js';
import { createCorrectionEvent } from './workoutDetectLabels.js';
import { workoutLedgerEvent } from './workoutEvents.js';
import {
  applySessionPhysiology,
  createCanonicalWorkout,
  estimateDetectedStrain,
  isOpenWorkout,
  viewOfWorkout,
} from './workoutSession.js';
import { stableUuid, workoutSessionRow } from '../storage/structuredSync.js';
import { resolveHrMax } from '../vo2/hrMax.js';

export const WORKOUT_DETECT_ALGORITHM = 'workout_detect_v1';
export const WORKOUT_DETECT_VERSION = WORKOUT_DETECT_V1_VERSION;
export { WORKOUT_DETECT_V2_ALGORITHM, WORKOUT_DETECT_V2_VERSION, FEATURE_SCHEMA_VERSION, parseDetectorMode, DETECTION_PIPELINE_STAGES };

const LEDGER_CAP = 200;
const CHECKPOINT_MS = 4000;
const CORRECTION_CAP = 200;

function emptyPipeline() {
  return Object.fromEntries(DETECTION_PIPELINE_STAGES.map((k) => [k, 0]));
}

function dayKeyLocal(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function inRange(n, lo, hi) {
  return Number.isFinite(n) && n >= lo && n <= hi;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

function canonicalId(userId, identityMs) {
  return stableUuid([String(userId || 'local'), 'autoworkout', String(Math.floor(identityMs / 1000))]);
}

function sameOpenSession(session, w, startMs) {
  if (!isOpenWorkout(session)) return false;
  if (w?.workoutId && (session.id === w.workoutId || session.workoutId === w.workoutId)) return true;
  if (session.onsetTs === startMs || session.onsetTs === w?.onsetTs) return true;
  if (session.detectedStartTs != null && w?.detectedStartTs != null
    && session.detectedStartTs === w.detectedStartTs) return true;
  return false;
}

function latchedWorkoutId(session, w, startMs, userId) {
  if (session?.id) return session.id;
  if (w?.workoutId) return w.workoutId;
  const identityMs = w?.detectedStartTs ?? w?.confirmedTs ?? startMs;
  return canonicalId(userId, identityMs);
}

function rolloutAllows(userId, pct) {
  const n = Number(pct);
  if (!Number.isFinite(n) || n >= 100) return true;
  if (n <= 0) return false;
  const hex = String(userId || '0').replace(/-/g, '').slice(0, 8);
  const bucket = Number.parseInt(hex, 16) % 100;
  return Number.isFinite(bucket) ? bucket < n : true;
}

function logEvent(kind, extra = {}) {
  try {
    console.log(JSON.stringify({
      evt: kind,
      v: WORKOUT_DETECT_VERSION,
      at: new Date().toISOString(),
      ...extra,
    }));
  } catch { /* logging must never throw */ }
}

export function createWorkoutDetectionService({
  loadStore,
  saveStore,
  syncQueue,
  userId,
  estimateCalories,
  loadPersistedDays,
  detectorConfig,
  now = () => Date.now(),
} = {}) {
  let physCache = { at: 0, maxHr: null, restingHr: null, maxHrSource: 'default' };
  let rhrDays = [];
  const dismissedOnsets = new Set();
  const persistedIds = new Set();
  const recent = [];
  let lastCheckpointAt = 0;
  let session = null;
  let lastCompleted = null;
  const pipeline = emptyPipeline();

  function remember(kind, extra) {
    recent.push({ kind, at: now(), ...extra });
    if (recent.length > 80) recent.shift();
    logEvent(kind, extra);
  }

  function persistStore(mutator) {
    try {
      const store = loadStore();
      mutator(store);
      saveStore(store);
    } catch { /* best-effort */ }
  }

  function appendLedger(type, extra = {}) {
    const row = workoutLedgerEvent({
      userId,
      type,
      session,
      extra,
      atMs: now(),
    });
    persistStore((store) => {
      const prev = Array.isArray(store.workoutEvents) ? store.workoutEvents : [];
      store.workoutEvents = [...prev, row].slice(-LEDGER_CAP);
      if (session) store.activeWorkout = session;
    });
    remember(type, { id: session?.id || extra.workout_id, reason: extra.reason_code || extra.reason });
    try {
      syncQueue?.enqueue({
        type: 'events_upsert',
        userId,
        rows: [row],
      });
    } catch { /* ledger upload is best-effort */ }
    return row;
  }

  function persistDismissed(onsetTs) {
    if (!onsetTs) return;
    dismissedOnsets.add(onsetTs);
    dismissedOnsets.add(Math.floor(onsetTs / 1000));
    persistStore((store) => {
      const prev = Array.isArray(store.dismissedAutoOnsets) ? store.dismissedAutoOnsets : [];
      store.dismissedAutoOnsets = [...new Set([...prev, onsetTs, Math.floor(onsetTs / 1000)])].slice(-40);
    });
  }

  function persistCorrection(row) {
    persistStore((store) => {
      const prev = Array.isArray(store.workoutDetectCorrections) ? store.workoutDetectCorrections : [];
      store.workoutDetectCorrections = [...prev, row].slice(-CORRECTION_CAP);
    });
    return row;
  }

  try {
    const stored = loadStore();
    if (Array.isArray(stored.dismissedAutoOnsets)) {
      stored.dismissedAutoOnsets.forEach((v) => dismissedOnsets.add(v));
    }
    if (stored.activeWorkout && isOpenWorkout(stored.activeWorkout)) {
      session = stored.activeWorkout;
    }
    if (stored.lastCompletedWorkout) lastCompleted = stored.lastCompletedWorkout;
  } catch { /* empty */ }

  function readPrefs() {
    try { return loadStore().prefs || {}; } catch { return {}; }
  }

  function readDevice() {
    try {
      const store = loadStore();
      return {
        deviceId: store.bleLive?.deviceId || store.ble?.deviceId || null,
        firmware: store.bleLive?.firmware || store.ble?.firmware || null,
        model: store.bleLive?.name || store.ble?.model || null,
        generation: store.ble?.model || null,
        connected: store.bleLive?.connected,
      };
    } catch {
      return {};
    }
  }

  function flags() {
    const prefs = readPrefs();
    const detect = prefs.autoWorkoutDetect !== false && rolloutAllows(userId, prefs.autoWorkoutRolloutPercentage ?? 100);
    const haptics = detect && prefs.hapticAlerts !== false && prefs.autoWorkoutHaptics === true;
    const motionRequired = prefs.autoWorkoutMotionRequired === true
      || prefs.autoWorkoutMinConfidence === 'high';
    const mode = parseDetectorMode(prefs.autoWorkoutDetectorVersion);
    return { detect, haptics, motionRequired, shadow: detect && !haptics, mode };
  }

  function canonicalAlgo() {
    return flags().mode.canonical === 'v2'
      ? { algorithm: WORKOUT_DETECT_V2_ALGORITHM, version: WORKOUT_DETECT_V2_VERSION }
      : { algorithm: WORKOUT_DETECT_ALGORITHM, version: WORKOUT_DETECT_VERSION };
  }

  function enabledNow() {
    return flags().detect;
  }

  function refreshPhysiology() {
    const t = now();
    if (t - physCache.at < 30_000) return physCache;
    let profile = {};
    try { profile = loadStore().profile || {}; } catch { /* keep */ }
    const prefs = readPrefs();
    const birthYear = Number(profile.birthYear);
    const year = new Date(t).getFullYear();
    const age = Number.isFinite(birthYear) && birthYear > 1900 ? year - birthYear : null;
    const resolved = resolveHrMax({
      age,
      override: prefs.hrMax ?? profile.hrMax,
      days: rhrDays,
      profileHrMax: profile.maxHr ?? profile.hrMax,
    });
    const prefRhr = Number(prefs.restingHr);
    physCache = {
      at: t,
      maxHr: resolved.value,
      maxHrSource: resolved.source,
      restingHr: inRange(prefRhr, 20, 130) ? Math.round(prefRhr) : physCache.restingHr,
    };
    return physCache;
  }

  async function refreshRestingHr() {
    if (typeof loadPersistedDays !== 'function') return;
    try {
      const daysMap = await loadPersistedDays();
      const keys = Object.keys(daysMap || {}).sort().reverse();
      rhrDays = keys.map((day) => ({
        day,
        maxHr: daysMap[day]?.physiological_summary?.['Max HR (bpm)'],
        workouts: daysMap[day]?.workouts,
      }));
      for (const key of keys) {
        const v = Number(daysMap[key]?.physiological_summary?.['Resting heart rate (bpm)']);
        if (Number.isFinite(v) && v >= 20 && v <= 130) {
          physCache = { ...physCache, at: now(), restingHr: Math.round(v) };
          return;
        }
      }
    } catch { /* keep previous */ }
    physCache = { ...physCache, at: now() };
  }

  function saveCheckpoint(force = false) {
    const t = now();
    if (!force && t - lastCheckpointAt < CHECKPOINT_MS) return;
    lastCheckpointAt = t;
    persistStore((store) => {
      store.workoutDetectorCheckpoint = detectorV1.exportCheckpoint();
      store.workoutDetectorV2Checkpoint = detectorV2.exportCheckpoint();
      if (session) store.activeWorkout = session;
      else delete store.activeWorkout;
    });
  }

  function persistV2Diag() {
    persistStore((store) => {
      const exp = detectorV2.featureExport();
      store.workoutDetectV2Diag = {
        feature_schema_version: exp.feature_schema_version,
        detector_version: exp.detector_version,
        traceId: exp.traceId,
        transitions: exp.transitions.slice(-40),
        windows: exp.windows.slice(-24),
        predicted_activity: exp.predicted_activity,
        session_boundaries: exp.session_boundaries,
        counters: detectorV2.snapshot().counters,
        at: now(),
      };
    });
  }

  function noteShadow(which, event) {
    if (event.type !== 'workout_start' && event.type !== 'workout_end' && event.type !== 'workout_discarded') {
      if (which === 'v2' && event.type === 'state' && (event.state === 'CONFIRMED' || event.state === 'IDLE')) {
        persistV2Diag();
      }
      return;
    }
    persistStore((store) => {
      const prev = Array.isArray(store.workoutDetectShadow) ? store.workoutDetectShadow : [];
      store.workoutDetectShadow = [...prev, {
        which,
        type: event.type,
        ts: event.ts,
        path: event.workout?.confirmPath || null,
        sport: event.workout?.sport || null,
        reason: event.reason || event.workout?.confirmReason || null,
        traceId: event.workout?.traceId || null,
      }].slice(-40);
      const c = store.workoutDetectCounters || {};
      if (event.type === 'workout_start') {
        c[`${which}_confirms`] = (c[`${which}_confirms`] || 0) + 1;
      }
      store.workoutDetectCounters = c;
    });
    if (which === 'v2') persistV2Diag();
  }

  function routeDetectorEvent(which, event) {
    if (flags().mode.canonical === which) onDetectorEvent(event, which);
    else noteShadow(which, event);
  }

  function activeDetector() {
    return flags().mode.canonical === 'v2' ? detectorV2 : detectorV1;
  }

  function onDetectorEvent(event, which = 'v1') {
    const source = which === 'v2' ? detectorV2 : detectorV1;
    if (event.type === 'state') {
      if (event.state === 'POSSIBLE' && event.prev === 'IDLE') {
        appendLedger('workout_candidate_started', {
          reason_code: 'elevated_hr',
          payload: { onset_ts: event.ts },
        });
      }
      saveCheckpoint(true);
      return;
    }
    if (event.type === 'workout_start') {
      const w = event.workout;
      const startMs = w.effectiveStartTs ?? w.onsetTs;
      if (dismissedOnsets.has(startMs) || dismissedOnsets.has(w.onsetTs)
        || dismissedOnsets.has(Math.floor(startMs / 1000))) {
        source.dismiss('dismissed_onset');
        return;
      }
      if (sameOpenSession(session, w, startMs)) {
        return;
      }
      const id = latchedWorkoutId(session, w, startMs, userId);
      const { haptics } = flags();
      const hrOnlyOptIn = readPrefs().autoWorkoutHrOnlyHaptics === true;
      const allowHaptic = haptics && (which !== 'v2' || w.confirmPath !== 'hr_only' || hrOnlyOptIn)
        && w.haptic !== false;
      session = createCanonicalWorkout({
        id,
        start: { ...w, onsetTs: startMs, effectiveStartTs: startMs },
        device: readDevice(),
        detectorVersion: canonicalAlgo().version,
        nowMs: now(),
      });
      session.sport = w.sport || 'detected';
      session.workoutId = w.workoutId || id;
      session.detectedStartTs = w.detectedStartTs ?? session.detectedStartTs;
      session.lane = w.lane || null;
      session.modalityTier = w.modalityTier || null;
      session.evidenceScore = w.evidenceScore ?? null;
      session.featureVector = w.featureVector || null;
      session.segments = [{ sport: session.sport, startTs: startMs }];
      session.haptic.pending = allowHaptic && session.haptic.succeeded !== true;
      persistStore((store) => {
        store.activeWorkout = session;
        store.liveDetectedWorkout = {
          id,
          onsetTs: session.start,
          confirmedAt: session.confirmedAt,
          floor: session.floor,
        };
      });
      appendLedger('workout_confirmed', { reason_code: w.confirmReason, confidence: w.confidence });
      pipeline.canonical_session_created += 1;
      saveCheckpoint(true);
      if (which === 'v2') persistV2Diag();
      return;
    }
    if (event.type === 'sport_change' && session && isOpenWorkout(session)) {
      const prev = session.sport;
      session = { ...session, sport: event.sport };
      if (Array.isArray(session.segments) && session.segments.length) {
        const last = session.segments[session.segments.length - 1];
        last.endTs = event.ts;
        session.segments = [...session.segments.slice(0, -1), last, { sport: event.sport, startTs: event.ts }];
      }
      persistStore((store) => { store.activeWorkout = session; });
      appendLedger('workout_sport_changed', { reason_code: `${prev}->${event.sport}` });
      return;
    }
    if (event.type === 'workout_discarded') {
      if (event.reason === 'manual_end') return;
      if (!session || !isOpenWorkout(session)) {
        session = null;
        persistStore((store) => { delete store.activeWorkout; delete store.liveDetectedWorkout; });
        return;
      }
      session = { ...session, lifecycle: 'DISMISSED', endReason: event.reason, endedAt: new Date(now()).toISOString() };
      appendLedger('workout_dismissed', { reason_code: event.reason });
      persistStore((store) => {
        store.activeWorkout = session;
        delete store.liveDetectedWorkout;
      });
      session = null;
      return;
    }
    if (event.type === 'workout_end') {
      const reason = event.reason === 'manual' ? 'manual' : 'automatic';
      finalizeWorkout(event.workout, reason);
      return;
    }
    if (event.type === 'workout_reconciled' && event.workout) {
      applyReconciliation(event);
    }
  }

  function applyReconciliation(event) {
    const w = event.workout;
    const row = event.event;
    if (!w?.id) return;
    persistStore((store) => {
      const act = (store.activities || []).find((a) => a.id === w.id);
      if (act?.userModified) {
        const c = store.workoutDetectCounters || {};
        c.reconcile_skipped_user_edit = (c.reconcile_skipped_user_edit || 0) + 1;
        store.workoutDetectCounters = c;
        return;
      }
      const prev = Array.isArray(store.workoutDetectReconcile) ? store.workoutDetectReconcile : [];
      const dup = prev.some((e) => e.workout_id === row?.workout_id
        && e.new_start === row?.new_start && e.new_end === row?.new_end && e.new_type === row?.new_type);
      if (row && !dup) store.workoutDetectReconcile = [...prev, row].slice(-200);
      if (act) {
        const durationMin = Math.max(1, Math.round((w.durationS || ((w.endTs - w.startTs) / 1000)) / 60));
        act.start = new Date(w.startTs).toISOString();
        act.end = new Date(w.endTs).toISOString();
        act.durationMin = durationMin;
        act.name = sportDisplayName(w.sport);
        act.reconciled = true;
      }
      if (lastCompleted?.id === w.id) {
        lastCompleted = { ...lastCompleted, ...w, userModified: false };
        store.lastCompletedWorkout = lastCompleted;
      }
    });
  }

  function ingestHistory(samples = [], { historyComplete = false } = {}) {
    for (const s of samples || []) detectorV2.ingestHistorical(s);
    if (!historyComplete) return { changed: false, reason: 'pending' };
    const target = isOpenWorkout(session)
      ? {
        id: session.id,
        startTs: session.effectiveStartTs ?? session.onsetTs,
        endTs: session.lastSampleTs || now(),
        sport: session.sport,
        userModified: Boolean(session.userModified),
      }
      : lastCompleted;
    const result = detectorV2.reconcile(target);
    if (flags().mode.canonical === 'v2' && result.changed) {
      applyReconciliation(result);
    } else if (result.changed) {
      persistStore((store) => {
        const prev = Array.isArray(store.workoutDetectShadow) ? store.workoutDetectShadow : [];
        store.workoutDetectShadow = [...prev, {
          which: 'v2', type: 'workout_reconciled', ts: now(), reason: result.reason,
        }].slice(-40);
      });
    }
    return result;
  }

  function editWorkout({ workoutId, startTs, endTs, sport, action = 'edited' } = {}) {
    const id = workoutId || session?.id || lastCompleted?.id;
    const v2 = detectorV2.snapshot();
    persistStore((store) => {
      if (action === 'dismissed_false_positive') {
        store.activities = (store.activities || []).filter((a) => a.id !== id);
      } else {
        const act = (store.activities || []).find((a) => a.id === id);
        if (act) {
          act.userModified = true;
          if (startTs != null) act.start = new Date(startTs).toISOString();
          if (endTs != null) act.end = new Date(endTs).toISOString();
          if (sport) { act.name = sportDisplayName(sport); act.sport = sport; }
        }
      }
      if (lastCompleted?.id === id) {
        lastCompleted = {
          ...lastCompleted,
          userModified: true,
          startTs: startTs ?? lastCompleted.startTs,
          endTs: endTs ?? lastCompleted.endTs,
          sport: sport || lastCompleted.sport,
        };
        store.lastCompletedWorkout = lastCompleted;
      }
      if (session?.id === id) session = { ...session, userModified: true, sport: sport || session.sport };
    });
    return persistCorrection(createCorrectionEvent({
      workoutId: id,
      detectorVersion: canonicalAlgo().version,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      predictedStart: lastCompleted?.startTs || session?.onsetTs,
      predictedEnd: lastCompleted?.endTs,
      predictedType: lastCompleted?.sport || session?.sport,
      userStart: startTs ?? null,
      userEnd: endTs ?? null,
      userType: sport ?? null,
      action,
      featureObjectRef: v2.traceId || session?.traceId || lastCompleted?.traceId || null,
      lane: session?.lane || lastCompleted?.lane || v2.lane || null,
      modalityTier: session?.modalityTier || lastCompleted?.modalityTier || v2.modalityTier || null,
      confirmPath: session?.confirmationPath || lastCompleted?.confirmPath || v2.confirmPath || null,
      evidenceScore: session?.evidenceScore ?? lastCompleted?.evidenceScore ?? v2.evidenceScore ?? null,
      featureVector: session?.featureVector || lastCompleted?.featureVector || detectorV2.featureExport()?.featureVector || null,
      atMs: now(),
    }));
  }

  const detectorV1 = createWorkoutDetector({
    thresholds: () => {
      const phys = refreshPhysiology();
      return { restingHr: phys.restingHr, maxHr: phys.maxHr };
    },
    config: {
      ...detectorConfig,
      motionRequired: flags().motionRequired,
    },
    onEvent: (event) => routeDetectorEvent('v1', event),
    now,
  });
  const detectorV2 = createWorkoutDetectorV2({
    thresholds: () => {
      const phys = refreshPhysiology();
      return { restingHr: phys.restingHr, maxHr: phys.maxHr };
    },
    onEvent: (event) => routeDetectorEvent('v2', event),
    now,
  });

  try {
    const stored = loadStore();
    if (stored.workoutDetectorCheckpoint) {
      detectorV1.restore(stored.workoutDetectorCheckpoint);
    }
    if (stored.workoutDetectorV2Checkpoint) {
      detectorV2.restore(stored.workoutDetectorV2Checkpoint);
    }
    if (isOpenWorkout(session)) {
      const canonical = activeDetector();
      const snap = canonical.snapshot();
      if (snap.detectorState !== 'CONFIRMED') {
        canonical.restore({
          ...(flags().mode.canonical === 'v2'
            ? (stored.workoutDetectorV2Checkpoint || {})
            : (stored.workoutDetectorCheckpoint || {})),
          state: 'CONFIRMED',
          confirmed: true,
          sessionOwned: true,
          onsetTs: session.onsetTs,
          effectiveStartTs: session.effectiveStartTs ?? session.onsetTs,
          detectedStartTs: session.detectedStartTs ?? session.onsetTs,
          confirmed: true,
        });
      }
      session.haptic.pending = false;
    }
  } catch { /* restore is best-effort */ }

  function correctionFromSession(action, extra = {}) {
    const v2 = detectorV2.snapshot();
    return persistCorrection(createCorrectionEvent({
      workoutId: session?.id || extra.workoutId,
      detectorVersion: canonicalAlgo().version,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      predictedStart: session?.onsetTs || v2.onsetTs,
      predictedEnd: extra.predictedEnd || null,
      predictedType: session?.sport || v2.sport,
      userStart: extra.userStart ?? null,
      userEnd: extra.userEnd ?? null,
      userType: extra.userType ?? null,
      action,
      featureObjectRef: v2.traceId || extra.featureObjectRef || null,
      atMs: now(),
    }));
  }

  function overlappingActivity(store, startMs, endMs, day) {
    return (store.activities || []).find((a) => {
      if (userId && a.userId && a.userId !== userId) return false;
      if (a.date !== day || !a.start || !a.end) return false;
      const s = Date.parse(a.start);
      const e = Date.parse(a.end);
      return Number.isFinite(s) && Number.isFinite(e) && overlaps(startMs, endMs, s, e);
    });
  }

  function finalizeWorkout(w, endKind = 'automatic') {
    const startMs = w.startTs;
    const endMs = w.endTs;
    const id = latchedWorkoutId(session, w, startMs, userId);
    if (dismissedOnsets.has(startMs) || dismissedOnsets.has(Math.floor(startMs / 1000))) {
      remember('workout_end_ignored', { id, reason: 'dismissed' });
      session = null;
      persistStore((store) => { delete store.activeWorkout; delete store.liveDetectedWorkout; });
      return null;
    }
    if (persistedIds.has(id)) {
      remember('workout_end_ignored', { id, reason: 'already_persisted' });
      session = null;
      persistStore((store) => { delete store.activeWorkout; delete store.liveDetectedWorkout; });
      return null;
    }
    const day = dayKeyLocal(startMs);
    const elapsedS = w.elapsedDurationS ?? w.durationS;
    const observedS = w.observedDurationS ?? w.durationS;
    const durationMin = Math.max(1, Math.round(elapsedS / 60));
    const physMin = Math.max(1, Math.round(observedS / 60));
    const strain = estimateDetectedStrain(physMin, w.avgHr, w.restingHr, w.maxHr);
    const calories = typeof estimateCalories === 'function'
      ? estimateCalories(physMin, sportDisplayName(w.sport))
      : null;

    const activity = {
      id,
      userId,
      date: day,
      name: sportDisplayName(w.sport),
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      durationMin,
      avgHr: w.avgHr,
      maxHr: w.peakHr,
      zones: w.zonesPct,
      strain,
      calories,
      unknownGapS: w.unknownGapS || 0,
      observedDurationS: observedS,
      elapsedDurationS: elapsedS,
      source: 'auto',
      autoDetected: true,
      createdAt: new Date().toISOString(),
    };

    let skipped = null;
    persistStore((store) => {
      if ((store.activities || []).some((a) => a.id === id)) skipped = 'id';
      else {
        const clash = overlappingActivity(store, startMs, endMs, day);
        if (clash) skipped = clash.source === 'auto' ? 'id' : 'manual_overlap';
      }
      if (!skipped) store.activities.push(activity);
      delete store.liveDetectedWorkout;
    });

    if (skipped === 'manual_overlap' || skipped === 'id') {
      remember('workout_end_ignored', { id, reason: skipped });
      persistedIds.add(id);
      if (session) {
        session = { ...session, lifecycle: 'FAILED', endReason: skipped, endedAt: new Date(now()).toISOString() };
        appendLedger(endKind === 'manual' ? 'workout_ended_manually' : 'workout_ended_automatically', {
          reason_code: skipped,
        });
      }
      persistStore((store) => { store.activeWorkout = session; });
      session = null;
      return null;
    }

    persistedIds.add(id);
    lastCompleted = {
      id,
      startTs: startMs,
      endTs: endMs,
      sport: w.sport || session?.sport || 'detected',
      userModified: endKind === 'manual',
      durationS: w.durationS,
      observedDurationS: observedS,
      unknownGapS: w.unknownGapS || 0,
      workoutId: w.workoutId || id,
      lane: w.lane || session?.lane || null,
      modalityTier: w.modalityTier || session?.modalityTier || null,
      confirmPath: w.confirmPath || session?.confirmationPath || null,
      evidenceScore: w.evidenceScore ?? session?.evidenceScore ?? null,
      featureVector: session?.featureVector || w.featureVector || null,
      traceId: w.traceId || session?.traceId || null,
    };
    persistStore((store) => { store.lastCompletedWorkout = lastCompleted; });
    if (session) {
      session = {
        ...session,
        lifecycle: 'COMPLETED',
        endReason: endKind,
        endedAt: new Date(endMs).toISOString(),
        durationS: w.durationS,
        avgHr: w.avgHr,
        peakHr: w.peakHr,
        strain,
      };
    }
    appendLedger(endKind === 'manual' ? 'workout_ended_manually' : 'workout_ended_automatically', {
      reason_code: w.confirmReason || endKind,
    });
    try {
      const device = readDevice();
      const sessionRow = workoutSessionRow({
        userId,
        deviceUuid: null,
        workout: {
          deviceId: device.deviceId || 'unknown',
          sport: w.sport || session?.sport || 'detected',
          startTs: Math.floor(startMs / 1000),
          endTs: Math.floor(endMs / 1000),
          durationS: w.durationS,
          avgHr: w.avgHr,
          maxHr: w.peakHr,
          strain,
          energyKcal: calories,
          zonesJSON: JSON.stringify(w.zonesPct || []),
          source: 'auto-detect',
        },
        algorithmVersion: canonicalAlgo().version,
      });
      sessionRow.id = id;
      sessionRow.external_id = `workout:auto:${id}`;
      syncQueue?.enqueue({
        type: 'sessions_upsert',
        userId,
        rows: [sessionRow],
      });
      syncQueue?.enqueue({
        type: 'ingest',
        payload: {
          user_id: userId,
          metric_runs: [{
            id: stableUuid([String(userId || 'local'), canonicalAlgo().algorithm, String(Math.floor(startMs / 1000))]),
            user_id: userId,
            period_day: day,
            algorithm: canonicalAlgo().algorithm,
            version: canonicalAlgo().version,
            status: 'complete',
            input_refs: {
              floor: w.floor,
              resting_hr: w.restingHr,
              max_hr: w.maxHr,
              motion_mean: w.motionMean,
              confirm_path: w.confirmPath,
              feature_schema_version: flags().mode.canonical === 'v2' ? FEATURE_SCHEMA_VERSION : undefined,
              trace_id: w.traceId || null,
              branch: w.scores?.branch || w.sport || null,
            },
            output_refs: { session_id: id },
            started_at: new Date(startMs).toISOString(),
            finished_at: new Date().toISOString(),
          }],
        },
      });
      appendLedger('workout_persisted', { reason_code: 'local_and_outbox' });
      remember('session_persisted', { id, day, durationMin });
    } catch (err) {
      appendLedger('workout_sync_failed', { reason_code: 'enqueue_failed', payload: { error: String(err?.message || err).slice(0, 120) } });
      remember('session_persist_failed', { id, error: String(err?.message || err).slice(0, 120) });
    }
    persistStore((store) => {
      store.activeWorkout = session;
      delete store.liveDetectedWorkout;
    });
    session = null;
    saveCheckpoint(true);
    const rec = detectorV2.reconcile({ ...lastCompleted });
    if (rec?.changed && flags().mode.canonical === 'v2') applyReconciliation(rec);
    return activity;
  }

  function takeBuzz() {
    if (!session || !isOpenWorkout(session) || !session.haptic.pending) return false;
    if (session.haptic.succeeded === true || session.haptic.attempted) return false;
    const { haptics } = flags();
    if (!haptics) return false;
    session = {
      ...session,
      haptic: { ...session.haptic, pending: false, attempted: true, at: new Date(now()).toISOString() },
    };
    appendLedger('haptic_attempted', { reason_code: session.confirmationPath });
    persistStore((store) => { store.activeWorkout = session; });
    return true;
  }

  function ingest(sample) {
    detectorV1.config.motionRequired = flags().motionRequired;
    if (!enabledNow()) {
      if (!isOpenWorkout(session)) {
        if (detectorV1.snapshot().detectorState !== 'IDLE') detectorV1.reset();
        if (detectorV2.snapshot().detectorState !== 'IDLE') detectorV2.reset();
      }
      return activeDetector().snapshot();
    }
    const ts = Number(sample?.ts) || Date.parse(sample?.datetime || sample?.at || '');
    const at = Number.isFinite(ts) ? ts : now();
    detectorV1.tick(at);
    // V2 gaps are applied inside ingest() from sensor/event time. Do not also
    // tick(at) here: that mixed receive-wall `now()` with sample timestamps.
    pipeline.backend_received += 1;
    if (now() - physCache.at > 5 * 60_000) refreshRestingHr().catch(() => {});
    const v1Before = detectorV1.snapshot().detectorState;
    const v2Before = detectorV2.snapshot().detectorState;
    detectorV2.ingest({ ...sample, receivedTs: sample?.receivedTs ?? now() });
    detectorV1.ingest(sample);
    pipeline.backend_v2_evaluated += 1;
    const v1After = detectorV1.snapshot().detectorState;
    const v2After = detectorV2.snapshot().detectorState;
    if (sample?.nativeV2 || sample?.native_v2) {
      const cmp = compareNativeBackend(sample.nativeV2 || sample.native_v2, detectorV2.snapshot());
      persistStore((store) => {
        const prev = Array.isArray(store.workoutDetectEdge) ? store.workoutDetectEdge : [];
        store.workoutDetectEdge = [...prev, { at: now(), ...cmp }].slice(-40);
        if (cmp.disagree) {
          const c = store.workoutDetectCounters || {};
          c.native_backend_disagree = (c.native_backend_disagree || 0) + 1;
          store.workoutDetectCounters = c;
        }
      });
    }
    const v1Just = v1Before !== 'CONFIRMED' && v1After === 'CONFIRMED';
    const v2Just = v2Before !== 'CONFIRMED' && v2After === 'CONFIRMED';
    if ((v1Just || v2Just) && (v1After === 'CONFIRMED') !== (v2After === 'CONFIRMED')) {
      persistStore((store) => {
        const c = store.workoutDetectCounters || {};
        c.v1_v2_disagree = (c.v1_v2_disagree || 0) + 1;
        store.workoutDetectCounters = c;
      });
    }
    const snap = activeDetector().snapshot();
    if (isOpenWorkout(session)) {
      session = applySessionPhysiology(session, { ...snap, stale: false }, now());
      if (snap.lastBpm != null) session.zone = hrZone(snap.lastBpm, session.maxHr || snap.maxHr);
      persistStore((store) => { store.activeWorkout = session; });
    }
    saveCheckpoint();
    return snap;
  }

  function state({ consumeBuzz = false } = {}) {
    detectorV1.tick(now());
    detectorV2.tick();
    const snap = activeDetector().snapshot();
    const stale = snap.lastSampleTs != null && (now() - snap.lastSampleTs) > 120_000;
    const connectedNow = readDevice().connected !== false && !stale;
    if (isOpenWorkout(session) && session.connected !== connectedNow) {
      session = { ...session, connected: connectedNow };
      persistStore((store) => { store.activeWorkout = session; });
    }
    const workout = viewOfWorkout(session, now());
    const live = workout && isOpenWorkout(workout)
      ? {
        id: workout.id,
        onsetTs: workout.start,
        confirmedAt: workout.confirmedAt,
        floor: workout.floor,
        hr: workout.hr,
      }
      : null;
    const buzz = consumeBuzz ? takeBuzz() : false;
    const openWorkoutMode = Boolean(workout && isOpenWorkout(workout) && !workout.modeOpened);
    const startLiveActivity = Boolean(workout && isOpenWorkout(workout) && !workout.liveActivityStarted);
    const mode = flags().mode;
    const algo = canonicalAlgo();
    const v2 = detectorV2.snapshot();
    return {
      enabled: enabledNow(),
      shadow: flags().shadow,
      hapticsEnabled: flags().haptics,
      ...snap,
      stale,
      live,
      workout,
      buzz,
      openWorkoutMode,
      startLiveActivity,
      algorithm: algo.algorithm,
      version: algo.version,
      detectorMode: mode.label,
      shadowDetector: mode.shadow,
      v2: {
        detectorState: v2.detectorState,
        internalState: v2.internalState,
        confidenceTier: v2.confidenceTier,
        scores: v2.scores,
        coverage: v2.coverage,
        quality: v2.quality,
        activity: v2.activity,
        counters: v2.counters,
        traceId: v2.traceId,
        confirmPath: v2.confirmPath,
        sport: v2.sport,
        lane: v2.lane,
        modalityTier: v2.modalityTier,
        evidenceScore: v2.evidenceScore,
        onsetTs: v2.effectiveStartTs ?? v2.onsetTs,
        detectedStartTs: v2.detectedStartTs,
        confirmedTs: v2.confirmedTs,
        effectiveStartTs: v2.effectiveStartTs,
        lastSampleTs: v2.lastSampleTs,
        feature_schema_version: v2.feature_schema_version,
        version: v2.version,
        cpuMs: v2.cpuMs,
      },
      pipeline: { ...pipeline },
    };
  }

  function markModeStarted() {
    if (!session || session.modeOpened) return state();
    session = { ...session, modeOpened: true };
    appendLedger('workout_mode_started', { reason_code: 'canonical_mode' });
    persistStore((store) => { store.activeWorkout = session; });
    return state();
  }

  function markLiveActivityStarted() {
    if (!session || session.liveActivityStarted) return state();
    session = { ...session, liveActivityStarted: true };
    persistStore((store) => { store.activeWorkout = session; });
    return state();
  }

  function reportHaptic(ok) {
    if (!session) return state();
    if (session.haptic.succeeded != null) return state();
    session = {
      ...session,
      haptic: {
        ...session.haptic,
        attempted: true,
        pending: false,
        succeeded: Boolean(ok),
        at: new Date(now()).toISOString(),
      },
    };
    appendLedger(ok ? 'haptic_succeeded' : 'haptic_failed', { reason_code: ok ? 'buzz' : 'buzz_failed' });
    persistStore((store) => { store.activeWorkout = session; });
    return state();
  }

  function dismiss() {
    const snap = activeDetector().snapshot();
    persistDismissed(session?.onsetTs || snap.onsetTs);
    if (session && isOpenWorkout(session)) {
      session = {
        ...session,
        lifecycle: 'DISMISSED',
        endReason: 'user',
        endedAt: new Date(now()).toISOString(),
      };
      appendLedger('workout_dismissed', { reason_code: 'user' });
      correctionFromSession('dismissed_false_positive', { userType: session.sport });
    }
    detectorV1.dismiss('user');
    detectorV2.dismiss('user');
    persistStore((store) => {
      delete store.activeWorkout;
      delete store.liveDetectedWorkout;
    });
    session = null;
    saveCheckpoint(true);
    return state();
  }

  function end({ reason = 'manual' } = {}) {
    const snap = activeDetector().snapshot();
    if (!isOpenWorkout(session) && snap.detectorState !== 'CONFIRMED') return state();
    const cp = activeDetector().exportCheckpoint();
    const zoneTotal = cp.bout?.zoneS?.reduce((a, b) => a + b, 0) || 0;
    const zonesPct = zoneTotal > 0
      ? cp.bout.zoneS.map((s) => Math.round((s / zoneTotal) * 1000) / 10)
      : [0, 0, 0, 0, 0];
    const summary = {
      startTs: session?.onsetTs || snap.onsetTs,
      endTs: snap.lastSampleTs || now(),
      durationS: session?.durationS || snap.activeWorkout?.durationS || 0,
      avgHr: session?.avgHr || snap.activeWorkout?.avgHr || null,
      peakHr: session?.peakHr || snap.activeWorkout?.peakHr || null,
      zonesPct,
      floor: session?.floor || snap.floor,
      restingHr: session?.restingHr || snap.restingHr,
      maxHr: session?.maxHr || snap.maxHr,
      motionMean: session?.motionMean ?? null,
      confirmPath: session?.confirmationPath,
      confirmReason: session?.reasonCode,
      sport: session?.sport || snap.activeWorkout?.sport || 'detected',
    };
    if (session) {
      session = { ...session, lifecycle: 'ENDING' };
      persistStore((store) => { store.activeWorkout = session; });
    }
    detectorV1.dismiss('manual_end');
    detectorV2.dismiss('manual_end');
    if (reason !== 'automatic') {
      correctionFromSession('edited', {
        predictedEnd: summary.endTs,
        userEnd: summary.endTs,
        userType: summary.sport,
      });
    }
    finalizeWorkout(summary, reason === 'automatic' ? 'automatic' : 'manual');
    return state();
  }

  refreshRestingHr().catch(() => {});
  return {
    ingest,
    ingestHistory,
    editWorkout,
    state,
    dismiss,
    end,
    markModeStarted,
    markLiveActivityStarted,
    reportHaptic,
    get detector() { return activeDetector(); },
    detectorV1,
    detectorV2,
    recordCorrection: (action, extra) => persistCorrection(createCorrectionEvent({
      ...extra,
      action,
      detectorVersion: extra?.detectorVersion || canonicalAlgo().version,
      featureSchemaVersion: extra?.featureSchemaVersion || FEATURE_SCHEMA_VERSION,
      atMs: extra?.atMs || now(),
    })),
    _recent: () => recent.slice(),
    _takeBuzz: takeBuzz,
    _session: () => session,
  };
}
