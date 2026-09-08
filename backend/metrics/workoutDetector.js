/**
 * Realtime workout-onset detector — streaming state machine:
 *
 *   Detector: IDLE → POSSIBLE → LIKELY → CONFIRMED
 *   After CONFIRMED the workout session is authoritative. This module still
 *   tracks physiology (including an internal ENDING grace) so auto-end can
 *   be suggested, but it must not invent a second workout id.
 *
 * Confirmation paths:
 *   high_confidence — HR onset + sustained HR + motion → ~confirmS (3 min)
 *   hr_only         — HR onset + sustained HR, no motion → hrOnlyConfirmS
 *   walking         — RHR+15 + ambulatory motion → walkConfirmS (5 min)
 *   strength        — set/rest HR pulses, quiet wrist → strengthConfirmS (8 min)
 *
 * Cardio thresholds are ported from OpenStrap auto_detect.dart. Walking and
 * strength gates match noop WorkoutDetector (RHR+15) plus set-rest pulses so
 * a quiet-wrist lift + short walk is not dropped by the cardio floor.
 * Missing/out-of-range RHR abstains. Missing HRmax drops the HRR term
 * (floor = RHR+40).
 *
 * Pure / headless: no I/O, no clock of its own — inject `now` for tests.
 * All timestamps are unix MILLISECONDS internally.
 */

export const DETECTOR_STATES = Object.freeze([
  'IDLE',
  'POSSIBLE',
  'LIKELY',
  'CONFIRMED',
]);

export const DETECTOR_DEFAULTS = Object.freeze({
  elevatedMarginBPM: 40,
  hrrFloorFraction: 0.45,
  defaultRestingHR: 60,
  defaultMaxHR: 190,

  possibleSustainS: 60,
  confirmS: 180,
  // HR-only (no IMU) must not buzz at 3 minutes — stairs / desk stress.
  hrOnlyConfirmS: 8 * 60,
  confirmTimeoutS: 10 * 60,
  unevaluableConfirmS: 12 * 60,

  // Walking / lifting sit below the cardio floor (RHR+40). noop WorkoutDetector
  // uses RHR+15; that is the active gate here. Cardio floor still gates hr_only.
  activeMarginBPM: 15,
  walkConfirmS: 5 * 60,
  strengthConfirmS: 8 * 60,
  // Real lift rests drop to ~RHR+5 for 3–6 min; one evening gap was ~12 min.
  // 90s was killing the candidate before 3 pulses. 15 min without a set ends it.
  strengthMaxDipS: 6 * 60,
  strengthEndQuietS: 15 * 60,
  strengthPulseWorkExtraBPM: 15,
  strengthPulseRestExtraBPM: 10,
  strengthMinPulses: 3,
  strengthMinWorkS: 15,
  // Between-rack walks are 1–2 min; a real cardio walk is ~5–8 min.
  sportHoldS: 180,
  recentWindowS: 90,

  maxDipS: 90,
  preActiveMaxGapS: 90,
  // 6 min covers a 5-minute reconnect without splitting the session.
  activeMaxGapS: 360,

  onsetLookbackS: 180,
  onsetWindowS: 180,
  onsetRiseBpm: 25,
  motionConfirmMean: 0.15,
  motionRequired: false,

  exitHysteresisBPM: 10,
  // Water / lifting rests of ~3–4 min must not auto-end.
  endConfirmS: 240,

  minWorkoutS: 180,
  maxWorkoutS: 6 * 3600,
  forgottenStaleS: 30 * 60,

  dismissCooldownS: 600,
  zoneDtCapS: 30,
  bpmMin: 20,
  bpmMax: 240,
});

function inPhysRange(v, lo, hi) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) return null;
  return n;
}

function clampNum(v, lo, hi, fallback) {
  const n = inPhysRange(v, lo, hi);
  return n == null ? fallback : n;
}

/** HR zone (1–5) by % of HRmax; 0 below zone 1. */
export function hrZone(bpm, maxHr) {
  if (!Number.isFinite(bpm) || !Number.isFinite(maxHr) || maxHr <= 0) return 0;
  const pct = (bpm / maxHr) * 100;
  if (pct >= 90) return 5;
  if (pct >= 80) return 4;
  if (pct >= 70) return 3;
  if (pct >= 60) return 2;
  if (pct >= 50) return 1;
  return 0;
}

export function workoutFloor({ restingHr, maxHr, config = DETECTOR_DEFAULTS }) {
  const rhr = clampNum(restingHr, 20, 130, config.defaultRestingHR);
  const hrMax = clampNum(maxHr, 140, 230, config.defaultMaxHR);
  const hrrFloor = Math.round(rhr + config.hrrFloorFraction * (hrMax - rhr));
  return Math.max(rhr + config.elevatedMarginBPM, hrrFloor);
}

export function activeFloor({ restingHr, config = DETECTOR_DEFAULTS }) {
  const rhr = clampNum(restingHr, 20, 130, config.defaultRestingHR);
  return rhr + config.activeMarginBPM;
}

/** Live + archive samples name motion three different ways. */
export function sampleMotion(sample) {
  for (const key of ['motion', 'mot', 'dyn_accel', 'dynAccel']) {
    const n = Number(sample?.[key]);
    if (Number.isFinite(n)) return n;
  }
  const enmo = Number(sample?.enmo_mean ?? sample?.enmoMean);
  if (Number.isFinite(enmo)) return enmo;
  return null;
}

export function classifyLiveSport({ motionMean, pulseCount = 0, walkFraction = null, meanHr = null, cardioFloor = null }) {
  if (walkFraction != null && walkFraction >= 0.4) return 'walking';
  const ambulatory = motionMean != null && motionMean >= 0.15;
  if (ambulatory && meanHr != null && cardioFloor != null && meanHr >= cardioFloor) return 'detected';
  if (ambulatory) return 'walking';
  if (pulseCount >= 2) return 'strength';
  if (motionMean != null && motionMean < 0.08) return 'strength';
  return 'detected';
}

export function sportDisplayName(sport) {
  if (sport === 'walking') return 'Walking';
  if (sport === 'strength') return 'Weightlifting';
  if (sport === 'running') return 'Running';
  return 'Detected Workout';
}

export function primarySport(sportS) {
  if (!sportS || typeof sportS !== 'object') return 'detected';
  let best = 'detected';
  let n = -1;
  for (const [k, v] of Object.entries(sportS)) {
    const s = Number(v) || 0;
    if (s > n) { n = s; best = k; }
  }
  return n > 0 ? best : 'detected';
}

export function detectorPhase(internalState) {
  if (internalState === 'ENDING' || internalState === 'CONFIRMED') return 'CONFIRMED';
  return internalState === 'POSSIBLE' || internalState === 'LIKELY' || internalState === 'IDLE'
    ? internalState
    : 'IDLE';
}

function toMs(ts) {
  if (ts == null) return NaN;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : NaN;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : NaN;
}

function cloneBout(bout) {
  if (!bout) return null;
  return {
    ...bout,
    zoneS: Array.isArray(bout.zoneS) ? [...bout.zoneS] : [0, 0, 0, 0, 0],
    sportS: bout.sportS ? { ...bout.sportS } : { walking: 0, strength: 0, detected: 0 },
    recent: Array.isArray(bout.recent) ? bout.recent.map((p) => ({ ...p })) : [],
  };
}

export function createWorkoutDetector({
  thresholds = () => ({}),
  config: overrides = {},
  onEvent = () => {},
  now = () => Date.now(),
} = {}) {
  const config = { ...DETECTOR_DEFAULTS, ...overrides };

  let state = 'IDLE';
  let stateSinceTs = null;
  let onsetTs = null;
  let lastElevatedTs = null;
  let lastActiveTs = null;
  let cardioOnsetTs = null;
  let lastAboveExitTs = null;
  let dipStartTs = null;
  let endStartTs = null;
  let lastSampleTs = null;
  let confirmed = false;
  let confirmPath = null;
  let confirmReason = null;
  let onsetCache = null;
  let cooldownUntilTs = 0;
  let rearmBelowFloor = false;
  let sessionOwned = false;

  let bout = null;
  let baseline = [];

  function emit(event) {
    try { onEvent(event); } catch { /* listeners must not break ingestion */ }
  }

  function setState(next, ts) {
    if (state === next) return;
    const prev = state;
    state = next;
    stateSinceTs = ts;
    emit({ type: 'state', prev, state: next, detectorState: detectorPhase(next), ts });
  }

  function currentFloor() {
    const t = thresholds() || {};
    const restingHr = inPhysRange(t.restingHr, 20, 130);
    const maxHr = inPhysRange(t.maxHr, 140, 230);
    if (restingHr == null) {
      return { restingHr: null, maxHr, floor: null, physReady: false };
    }
    const floor = maxHr == null
      ? restingHr + config.elevatedMarginBPM
      : workoutFloor({ restingHr, maxHr, config });
    return {
      restingHr,
      maxHr,
      floor,
      activeFloor: activeFloor({ restingHr, config }),
      physReady: true,
    };
  }

  function resetBout() {
    bout = null;
    onsetTs = null;
    lastElevatedTs = null;
    lastActiveTs = null;
    cardioOnsetTs = null;
    lastAboveExitTs = null;
    dipStartTs = null;
    endStartTs = null;
    confirmed = false;
    confirmPath = null;
    confirmReason = null;
    onsetCache = null;
    sessionOwned = false;
  }

  function startBout(ts, bpm, atCardio) {
    bout = {
      hrTimeWt: 0,
      motionTimeWt: 0,
      motionWt: 0,
      weightS: 0,
      peakBpm: bpm,
      zoneS: [0, 0, 0, 0, 0],
      lastTs: null,
      earlyHrSum: 0,
      earlyHrCount: 0,
      pulseCount: 0,
      inWorkSinceTs: null,
      lastWorkTs: null,
      sport: 'detected',
      sportHold: null,
      sportHoldSinceTs: null,
      sportS: { walking: 0, strength: 0, detected: 0 },
      recent: [],
    };
    onsetTs = ts;
    lastActiveTs = ts;
    lastElevatedTs = atCardio ? ts : null;
    cardioOnsetTs = atCardio ? ts : null;
    lastAboveExitTs = ts;
  }

  function accumulate(ts, bpm, motion) {
    if (!bout) return;
    const dtS = bout.lastTs == null
      ? 0
      : Math.min(Math.max((ts - bout.lastTs) / 1000, 0), config.zoneDtCapS);
    bout.lastTs = ts;
    if (dtS > 0) {
      bout.hrTimeWt += bpm * dtS;
      bout.weightS += dtS;
      const { maxHr } = currentFloor();
      if (maxHr != null) {
        const z = hrZone(bpm, maxHr);
        if (z >= 1) bout.zoneS[z - 1] += dtS;
      }
      if (Number.isFinite(motion)) {
        bout.motionTimeWt += motion * dtS;
        bout.motionWt += dtS;
      }
      const sp = bout.sport || 'detected';
      bout.sportS[sp] = (bout.sportS[sp] || 0) + dtS;
    }
    if (ts < onsetTs + config.onsetWindowS * 1000) {
      bout.earlyHrSum += bpm;
      bout.earlyHrCount += 1;
    }
    if (bpm > bout.peakBpm) bout.peakBpm = bpm;
    bout.recent.push({ ts, bpm, motion });
    const cut = ts - config.recentWindowS * 1000;
    while (bout.recent.length && bout.recent[0].ts < cut) bout.recent.shift();
  }

  function trackPulse(ts, bpm, gate) {
    if (!bout || gate == null) return;
    const work = gate + config.strengthPulseWorkExtraBPM;
    const rest = gate + config.strengthPulseRestExtraBPM;
    if (bpm >= work) {
      bout.inWorkSinceTs = bout.inWorkSinceTs ?? ts;
      bout.lastWorkTs = ts;
    } else if (bout.inWorkSinceTs != null && bpm <= rest) {
      if ((ts - bout.inWorkSinceTs) / 1000 >= config.strengthMinWorkS) bout.pulseCount += 1;
      bout.inWorkSinceTs = null;
    }
  }

  function recentMotionMean() {
    if (!bout?.recent?.length) return motionMean();
    let sum = 0;
    let n = 0;
    for (const p of bout.recent) {
      if (Number.isFinite(p.motion)) { sum += p.motion; n += 1; }
    }
    return n > 0 ? sum / n : motionMean();
  }

  function recentMeanHr() {
    if (!bout?.recent?.length) return null;
    let sum = 0;
    let n = 0;
    for (const p of bout.recent) {
      if (Number.isFinite(p.bpm)) { sum += p.bpm; n += 1; }
    }
    return n > 0 ? sum / n : null;
  }

  function liveSport() {
    const { floor } = currentFloor();
    return classifyLiveSport({
      motionMean: recentMotionMean(),
      pulseCount: bout?.pulseCount || 0,
      meanHr: recentMeanHr(),
      cardioFloor: floor,
    });
  }

  function maybeSportChange(ts) {
    if (!bout || !confirmed) return;
    const next = liveSport();
    if (next === bout.sport) {
      bout.sportHold = null;
      bout.sportHoldSinceTs = null;
      return;
    }
    if (bout.sportHold !== next) {
      bout.sportHold = next;
      bout.sportHoldSinceTs = ts;
      return;
    }
    if (ts - bout.sportHoldSinceTs < config.sportHoldS * 1000) return;
    const prev = bout.sport;
    bout.sport = next;
    bout.sportHold = null;
    bout.sportHoldSinceTs = null;
    emit({ type: 'sport_change', prev, sport: next, ts });
  }

  function onsetEvidence(ts) {
    const origin = cardioOnsetTs || onsetTs;
    if (onsetCache) return onsetCache;
    if (origin == null || ts < origin + config.onsetWindowS * 1000) {
      return { evaluated: false, rise: null };
    }
    const lo = origin - config.onsetLookbackS * 1000;
    let sum = 0;
    let cnt = 0;
    for (const p of baseline) {
      if (p.ts >= lo && p.ts < origin) { sum += p.bpm; cnt += 1; }
    }
    const pre = cnt >= 2 ? sum / cnt : null;
    if (pre == null || !bout || bout.earlyHrCount === 0) {
      onsetCache = { evaluated: false, rise: null, unevaluable: true };
      return onsetCache;
    }
    const early = bout.earlyHrSum / bout.earlyHrCount;
    onsetCache = { evaluated: true, rise: early - pre };
    return onsetCache;
  }

  function motionMean() {
    if (!bout || bout.motionWt <= 0) return null;
    return bout.motionTimeWt / bout.motionWt;
  }

  function confirmDecision(ts, elevatedS, activeS) {
    const motion = motionMean();
    const recentM = recentMotionMean();
    const hasMotion = (recentM != null && recentM >= config.motionConfirmMean)
      || (motion != null && motion >= config.motionConfirmMean);
    const hasWalk = recentM != null && recentM >= config.motionConfirmMean;
    const onset = onsetEvidence(ts);
    const onsetOk = Boolean(onset.evaluated && onset.rise >= config.onsetRiseBpm);
    const pulses = bout?.pulseCount || 0;
    const sport = liveSport();

    if (config.motionRequired && !hasMotion && !hasWalk) {
      const giveUp = onset.evaluated && !onsetOk && elevatedS >= config.confirmTimeoutS;
      return { ok: false, giveUp };
    }

    if (hasMotion && elevatedS >= config.confirmS) {
      if (onsetOk) return { ok: true, path: 'high_confidence', reason: 'hr_onset_motion', sport };
      if (onset.evaluated && !onsetOk) {
        return { ok: true, path: 'high_confidence', reason: 'motion_gate', sport };
      }
      if (onset.unevaluable && elevatedS >= config.unevaluableConfirmS) {
        return { ok: true, path: 'high_confidence', reason: 'unevaluable_motion', sport };
      }
    }

    if (hasWalk && activeS >= config.walkConfirmS && elevatedS < config.confirmS
      && pulses < 2) {
      const { floor } = currentFloor();
      const mean = recentMeanHr();
      if (mean == null || mean < floor) {
        return { ok: true, path: 'walking', reason: 'ambulatory_motion', sport: 'walking' };
      }
    }

    if (pulses >= config.strengthMinPulses && activeS >= config.strengthConfirmS && !hasWalk) {
      return { ok: true, path: 'strength', reason: 'set_rest_pulses', sport: 'strength' };
    }

    if (!hasMotion && onsetOk && elevatedS >= config.hrOnlyConfirmS) {
      return { ok: true, path: 'hr_only', reason: 'hr_onset_no_motion', sport };
    }
    if (!hasMotion && onset.unevaluable && elevatedS >= config.unevaluableConfirmS) {
      return { ok: true, path: 'hr_only', reason: 'unevaluable_hr_only', sport };
    }

    const giveUp = !hasWalk && pulses < config.strengthMinPulses
      && elevatedS < config.confirmS
      && activeS >= config.confirmTimeoutS;
    return { ok: false, giveUp };
  }

  function sessionOnsetTs() {
    if (confirmPath === 'high_confidence' || confirmPath === 'hr_only') {
      return cardioOnsetTs || onsetTs;
    }
    return onsetTs;
  }

  function summary(endTs) {
    const startTs = sessionOnsetTs();
    const durationS = Math.max(0, Math.round((endTs - startTs) / 1000));
    const avgHr = bout && bout.weightS > 0 ? Math.round(bout.hrTimeWt / bout.weightS) : null;
    const zoneTotal = bout ? bout.zoneS.reduce((a, b) => a + b, 0) : 0;
    const zonesPct = bout && zoneTotal > 0
      ? bout.zoneS.map((s) => Math.round((s / zoneTotal) * 1000) / 10)
      : [0, 0, 0, 0, 0];
    const { restingHr, maxHr, floor } = currentFloor();
    const motion = motionMean();
    return {
      startTs,
      endTs,
      durationS,
      avgHr,
      peakHr: bout ? bout.peakBpm : null,
      zonesPct,
      floor,
      restingHr,
      maxHr,
      motionMean: motion == null ? null : Math.round(motion * 1000) / 1000,
      confirmPath,
      confirmReason,
      sport: primarySport(bout?.sportS) || bout?.sport || 'detected',
    };
  }

  function finalize(endTs, ts, reason = 'auto') {
    const result = summary(Math.min(endTs, onsetTs + config.maxWorkoutS * 1000));
    const discard = result.durationS < config.minWorkoutS;
    const workout = result;
    resetBout();
    setState('IDLE', ts);
    if (discard) {
      emit({ type: 'workout_discarded', reason: 'too_short', durationS: result.durationS, ts });
    } else {
      emit({ type: 'workout_end', workout, reason, ts });
    }
  }

  function tryConfirm(ts, floor) {
    const elevatedS = cardioOnsetTs == null || lastElevatedTs == null
      ? 0
      : (lastElevatedTs - cardioOnsetTs) / 1000;
    const activeS = ((lastActiveTs ?? lastElevatedTs ?? ts) - onsetTs) / 1000;
    const decision = confirmDecision(ts, elevatedS, activeS);
    if (decision.ok) {
      confirmed = true;
      sessionOwned = true;
      confirmPath = decision.path;
      confirmReason = decision.reason;
      if (bout) {
        bout.sport = decision.sport || liveSport();
        const parked = bout.sportS.detected || 0;
        bout.sportS[bout.sport] = (bout.sportS[bout.sport] || 0) + parked;
        bout.sportS.detected = 0;
      }
      setState('CONFIRMED', ts);
      const { restingHr, maxHr } = currentFloor();
      emit({
        type: 'workout_start',
        workout: {
          onsetTs: sessionOnsetTs(),
          confirmedTs: ts,
          floor,
          restingHr,
          maxHr,
          onsetRiseBpm: onsetEvidence(ts).evaluated
            ? Math.round(onsetEvidence(ts).rise * 10) / 10
            : null,
          motionMean: motionMean(),
          confirmPath,
          confirmReason,
          sport: bout?.sport || 'detected',
          confidence: decision.path === 'high_confidence' ? 'high' : 'standard',
        },
        ts,
      });
      return true;
    }
    if (decision.giveUp) {
      resetBout();
      setState('IDLE', ts);
      return true;
    }
    return false;
  }

  function exitFloor() {
    const { floor, activeFloor: gate } = currentFloor();
    // ponytail: sleep HR sits ~RHR to RHR+10. Cardio hysteresis (floor-10) would
    // keep a lift session open all night; lift/walk exit at the active gate.
    if (confirmPath === 'strength' || confirmPath === 'walking') return gate;
    return floor - config.exitHysteresisBPM;
  }

  function stillWorking(ts, bpm, gate, leave) {
    const sport = bout?.sport;
    if (sport === 'strength' || confirmPath === 'strength' || (bout?.pulseCount || 0) >= 2) {
      const quietS = (ts - (bout.lastWorkTs ?? lastActiveTs ?? onsetTs)) / 1000;
      const moving = recentMotionMean() >= config.motionConfirmMean;
      const hrUp = (recentMeanHr() ?? bpm) >= gate + config.strengthPulseRestExtraBPM;
      return quietS < config.strengthEndQuietS || moving || hrUp;
    }
    if (sport === 'walking' || confirmPath === 'walking') {
      const mean = recentMeanHr();
      return (mean ?? bpm) >= gate;
    }
    return bpm >= leave;
  }

  function ingest(sample) {
    const bpm = Number(sample?.bpm ?? sample?.heartRate);
    if (!Number.isFinite(bpm) || bpm < config.bpmMin || bpm > config.bpmMax) return snapshot();
    const ts = toMs(sample?.ts ?? sample?.datetime ?? sample?.at);
    if (!Number.isFinite(ts)) return snapshot();
    if (lastSampleTs != null && ts <= lastSampleTs) return snapshot();
    const motion = sampleMotion(sample);
    const { floor, activeFloor: gate, physReady } = currentFloor();
    const gapS = lastSampleTs == null ? 0 : (ts - lastSampleTs) / 1000;

    baseline.push({ ts, bpm });
    const cutoff = ts - (config.onsetLookbackS + 60) * 1000;
    while (baseline.length && baseline[0].ts < cutoff) baseline.shift();

    if (!physReady || floor == null || gate == null) {
      lastSampleTs = ts;
      return snapshot();
    }

    switch (state) {
      case 'IDLE': {
        if (ts < cooldownUntilTs) break;
        if (rearmBelowFloor) {
          if (bpm < gate) rearmBelowFloor = false;
          else break;
        }
        if (bpm >= gate) {
          startBout(ts, bpm, bpm >= floor);
          accumulate(ts, bpm, motion);
          trackPulse(ts, bpm, gate);
          setState('POSSIBLE', ts);
        }
        break;
      }

      case 'POSSIBLE':
      case 'LIKELY': {
        if (gapS > config.preActiveMaxGapS) {
          resetBout();
          setState('IDLE', ts);
          if (bpm >= gate) {
            startBout(ts, bpm, bpm >= floor);
            accumulate(ts, bpm, motion);
            trackPulse(ts, bpm, gate);
            setState('POSSIBLE', ts);
          }
          break;
        }
        const dipLimitS = config.strengthMaxDipS;
        if (bpm >= gate) {
          lastActiveTs = ts;
          dipStartTs = null;
        } else {
          dipStartTs = dipStartTs ?? ts;
          if (ts - dipStartTs > dipLimitS * 1000) {
            resetBout();
            setState('IDLE', ts);
            break;
          }
        }
        if (bpm >= floor) {
          lastElevatedTs = ts;
          if (cardioOnsetTs == null) {
            cardioOnsetTs = ts;
            onsetCache = null;
          }
        }
        accumulate(ts, bpm, motion);
        trackPulse(ts, bpm, gate);
        const activeS = ((lastActiveTs ?? ts) - onsetTs) / 1000;
        if (state === 'POSSIBLE' && activeS >= config.possibleSustainS) {
          setState('LIKELY', ts);
        }
        tryConfirm(ts, floor);
        break;
      }

      case 'CONFIRMED':
      case 'ENDING': {
        // Do not finalize a 5–6 minute reconnect: that silently splits one workout.
        // A forgotten session (no samples for forgottenStaleS) still auto-ends.
        if (gapS > config.forgottenStaleS) {
          finalize(lastSampleTs, ts, 'forgotten');
          break;
        }
        if (ts - onsetTs >= config.maxWorkoutS * 1000) {
          finalize(onsetTs + config.maxWorkoutS * 1000, ts, 'max_duration');
          break;
        }
        const leave = exitFloor();
        const working = stillWorking(ts, bpm, gate, leave);
        if (state === 'CONFIRMED' || working) {
          accumulate(ts, bpm, motion);
          trackPulse(ts, bpm, gate);
          maybeSportChange(ts);
        }
        if (bpm >= gate) lastActiveTs = ts;
        if (bpm >= floor) {
          lastElevatedTs = ts;
          if (cardioOnsetTs == null) cardioOnsetTs = ts;
        }
        const holdS = (bout?.sport === 'strength' || confirmPath === 'strength')
          ? 0
          : config.endConfirmS;
        if (working) {
          lastAboveExitTs = ts;
          if (state === 'ENDING') {
            endStartTs = null;
            setState('CONFIRMED', ts);
          }
        } else if (state === 'CONFIRMED') {
          endStartTs = ts;
          setState('ENDING', ts);
        }
        if (state === 'ENDING' && endStartTs != null && ts - endStartTs >= holdS * 1000) {
          finalize(lastAboveExitTs ?? lastElevatedTs ?? lastActiveTs ?? ts, ts, 'auto');
        }
        break;
      }

      default:
        break;
    }

    lastSampleTs = ts;
    return snapshot();
  }

  function snapshot() {
    const { restingHr, maxHr, floor, activeFloor: gate } = currentFloor();
    const ts = lastSampleTs ?? now();
    const phase = detectorPhase(state);
    const snap = {
      state: phase,
      detectorState: phase,
      internalState: state,
      stateSinceTs,
      floor,
      activeFloor: gate ?? null,
      restingHr,
      maxHr,
      lastBpm: baseline.length ? baseline[baseline.length - 1].bpm : null,
      lastSampleTs,
      physReady: floor != null,
      confirmPath,
      confirmReason,
      sessionOwned,
      sport: bout?.sport || null,
      pulseCount: bout?.pulseCount || 0,
    };
    if (onsetTs != null) {
      snap.onsetTs = confirmed ? sessionOnsetTs() : onsetTs;
      snap.elevatedS = Math.max(0, Math.round(((lastElevatedTs ?? ts) - onsetTs) / 1000));
      snap.activeS = Math.max(0, Math.round(((lastActiveTs ?? lastElevatedTs ?? ts) - onsetTs) / 1000));
    }
    if (confirmed && bout) {
      const durationS = Math.max(0, Math.round((ts - onsetTs) / 1000));
      const avgHr = bout.weightS > 0 ? Math.round(bout.hrTimeWt / bout.weightS) : null;
      snap.activeWorkout = {
        onsetTs,
        durationS,
        avgHr,
        peakHr: bout.peakBpm,
        zone: hrZone(snap.lastBpm || avgHr || 0, maxHr),
        sport: bout.sport,
      };
    }
    return snap;
  }

  function dismiss(reason = 'user') {
    const ts = now();
    const wasActive = state === 'CONFIRMED' || state === 'ENDING';
    resetBout();
    cooldownUntilTs = ts + config.dismissCooldownS * 1000;
    rearmBelowFloor = true;
    setState('IDLE', ts);
    if (wasActive) emit({ type: 'workout_discarded', reason, ts });
    return snapshot();
  }

  function reset() {
    resetBout();
    baseline = [];
    lastSampleTs = null;
    cooldownUntilTs = 0;
    rearmBelowFloor = false;
    setState('IDLE', now());
  }

  function tick(at = now()) {
    if (lastSampleTs == null) return snapshot();
    const gapS = (at - lastSampleTs) / 1000;
    if (state === 'POSSIBLE' || state === 'LIKELY') {
      if (gapS > config.preActiveMaxGapS) {
        resetBout();
        setState('IDLE', at);
      }
    } else if (state === 'CONFIRMED' || state === 'ENDING') {
      if (gapS > config.forgottenStaleS) finalize(lastSampleTs, at, 'forgotten');
      else if (at - onsetTs >= config.maxWorkoutS * 1000) {
        finalize(Math.min(lastSampleTs, onsetTs + config.maxWorkoutS * 1000), at, 'max_duration');
      }
    }
    return snapshot();
  }

  function exportCheckpoint() {
    return {
      state,
      stateSinceTs,
      onsetTs,
      lastElevatedTs,
      lastActiveTs,
      cardioOnsetTs,
      lastAboveExitTs,
      dipStartTs,
      endStartTs,
      lastSampleTs,
      confirmed,
      confirmPath,
      confirmReason,
      onsetCache,
      cooldownUntilTs,
      rearmBelowFloor,
      sessionOwned,
      bout: cloneBout(bout),
      baseline: baseline.map((p) => ({ ...p })),
    };
  }

  function restore(checkpoint) {
    if (!checkpoint || typeof checkpoint !== 'object') return snapshot();
    state = checkpoint.state || 'IDLE';
    stateSinceTs = checkpoint.stateSinceTs ?? null;
    onsetTs = checkpoint.onsetTs ?? null;
    lastElevatedTs = checkpoint.lastElevatedTs ?? null;
    lastActiveTs = checkpoint.lastActiveTs ?? checkpoint.lastElevatedTs ?? null;
    cardioOnsetTs = checkpoint.cardioOnsetTs ?? (checkpoint.confirmed ? checkpoint.onsetTs : null) ?? null;
    lastAboveExitTs = checkpoint.lastAboveExitTs ?? null;
    dipStartTs = checkpoint.dipStartTs ?? null;
    endStartTs = checkpoint.endStartTs ?? null;
    lastSampleTs = checkpoint.lastSampleTs ?? null;
    confirmed = Boolean(checkpoint.confirmed);
    confirmPath = checkpoint.confirmPath ?? null;
    confirmReason = checkpoint.confirmReason ?? null;
    onsetCache = checkpoint.onsetCache ?? null;
    cooldownUntilTs = Number(checkpoint.cooldownUntilTs) || 0;
    rearmBelowFloor = Boolean(checkpoint.rearmBelowFloor);
    sessionOwned = Boolean(checkpoint.sessionOwned) || confirmed;
    bout = cloneBout(checkpoint.bout);
    baseline = Array.isArray(checkpoint.baseline)
      ? checkpoint.baseline.map((p) => ({ ts: Number(p.ts), bpm: Number(p.bpm) }))
        .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.bpm))
      : [];
    return snapshot();
  }

  return { ingest, snapshot, dismiss, reset, tick, restore, exportCheckpoint, config };
}
