/**
 * workout_detect_v2 — canonical beta detector.
 *
 * Detector: is sustained intentional exercise occurring?
 * Classifier: what activity class does the evidence support? (abstain = detected)
 *
 * Live wrist evidence is strapMotion on sourceOrigin=live only. Phone motion is
 * contextual. Historical dyn_accel / v18 is reconciler-only. `motion` /
 * `mot` / `dynAccel` are never treated as interchangeable live wrist input.
 * origin=replay is an execution context, not a sensor provenance.
 *
 * Event contract matches workoutDetector.js so the session service can swap
 * canonical/shadow without rewriting persistence. V1 remains the rollback
 * path (prefs.autoWorkoutDetectorVersion 1.x). Default for this build is V2.
 */
import { hrZone, primarySport, sportDisplayName as v1SportDisplayName } from './workoutDetector.js';
import { uuidFromParts } from '../storage/keys.js';

export const WORKOUT_DETECT_V2_ALGORITHM = 'workout_detect_v2';
export const WORKOUT_DETECT_V2_VERSION = '2.2.1-beta';
export const WORKOUT_DETECT_V1_VERSION = '1.3.0';
export const FEATURE_SCHEMA_VERSION = '2.2.1-beta';
export const MOTION_OBS_VERSION = '1.1.0';
export const TRUST_UNIX_MIN = 1_500_000_000;
export const TRUST_UNIX_MAX = 2_200_000_000;

export const DETECTION_PIPELINE_STAGES = Object.freeze([
  'ble_received',
  'locally_durable',
  'feature_generated',
  'native_v2_evaluated',
  'upload_scheduled',
  'upload_started',
  'backend_received',
  'backend_v2_evaluated',
  'canonical_session_created',
]);

export const EVIDENCE_LANES = Object.freeze([
  'cardio_rhythmic',
  'cardio_low_wrist',
  'ambulatory',
  'strength_candidate',
  'generic',
  'unknown',
]);

export const V2_DEFAULTS = Object.freeze({
  ringS: 12 * 60,
  ringMaxN: 900,
  histRingMaxN: 2000,
  windowsS: Object.freeze([10, 30, 60, 180]),
  bpmMin: 20,
  bpmMax: 240,
  elevatedMarginBPM: 40,
  hrrFloorFraction: 0.45,
  activeMarginBPM: 15,
  onsetLookbackS: 180,
  onsetRiseBpm: 25,
  possibleSustainS: 60,
  confirmTierAS: 270,
  confirmTierAStrongS: 180,
  confirmTierBS: 360,
  confirmRunS: 180,
  confirmWalkS: 300,
  confirmCardioS: 480,
  confirmLowWristS: 540,
  confirmStrengthS: 240,
  confirmTierCS: 600,
  confirmTierDS: 780,
  weakOnsetExtraS: 120,
  cardioDipS: 105,
  ambulatoryDipS: 105,
  strengthDipS: 360,
  preConfirmGapS: 90,
  endCardioS: 240,
  endWalkS: 180,
  endLowWristS: 240,
  endStrengthS: 600,
  suspendGapS: 360,
  forgottenStaleS: 30 * 60,
  maxBacktrackS: 8 * 60,
  minWorkoutS: 180,
  maxWorkoutS: 6 * 3600,
  dismissCooldownS: 600,
  zoneDtCapS: 30,
  strapMovingMean: 0.08,
  strapQuietMean: 0.03,
  strapWorkMean: 0.08,
  setWorkMinS: 12,
  setRestMinS: 20,
  strengthSetsMin: 3,
  sampleGapIgnoreS: 15,
  cadenceWalkMin: 90,
  cadenceRunMin: 150,
  movingFractionMin: 0.35,
  phoneContextMean: 0.12,
  sleepHrMax: 55,
  traceWindows: 120,
  traceTransitions: 80,
  allowHighRateImu: false,
});

export function parseDetectorMode(version) {
  const raw = String(version ?? '').trim();
  const v = (raw || WORKOUT_DETECT_V2_VERSION).toLowerCase();
  if (v.startsWith('2') && v.includes('shadow')) {
    return { canonical: 'v1', shadow: 'v2', label: `${WORKOUT_DETECT_V2_VERSION}-shadow` };
  }
  if (v.startsWith('2')) return { canonical: 'v2', shadow: 'v1', label: WORKOUT_DETECT_V2_VERSION };
  return { canonical: 'v1', shadow: 'v2', label: WORKOUT_DETECT_V1_VERSION };
}

/** Latched at first confirm from candidate identity + confirm time, never from effective start.
 * UUID so `public.sessions.id` / `public.events` FKs accept it. Same hash on Swift. */
export function mintWorkoutId(detectedStartTs, confirmedTs) {
  const a = Math.floor(Number(detectedStartTs) / 1000);
  const b = Math.floor(Number(confirmedTs) / 1000);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return uuidFromParts(['autoworkout-v2', String(a), String(b)]);
}

export function validSensorMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const ms = n > 1e12 ? n : n * 1000;
  const sec = ms / 1000;
  if (sec < TRUST_UNIX_MIN || sec > TRUST_UNIX_MAX) return null;
  return ms;
}

function inRange(n, lo, hi) {
  return Number.isFinite(n) && n >= lo && n <= hi;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toMs(ts) {
  if (ts == null) return NaN;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : NaN;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : NaN;
}

function mean(xs) {
  const v = (xs || []).filter((n) => n != null && Number.isFinite(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function median(xs) {
  const v = (xs || []).filter((n) => n != null && Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function percentile(xs, p) {
  const v = (xs || []).filter((n) => n != null && Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
}

function variance(xs) {
  const v = (xs || []).filter((n) => n != null && Number.isFinite(n));
  if (v.length < 2) return null;
  const m = mean(v);
  let s = 0;
  for (const x of v) s += (x - m) ** 2;
  return s / (v.length - 1);
}

function rms(xs) {
  const v = (xs || []).filter((n) => n != null && Number.isFinite(n));
  if (!v.length) return null;
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s / v.length);
}

function round3(n) {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 1000;
}

export function iqr(xs) {
  if (!xs || xs.length < 4) return 0;
  const q1 = percentile(xs, 0.25);
  const q3 = percentile(xs, 0.75);
  return q1 == null || q3 == null ? 0 : q3 - q1;
}

/** RecoFit-style band energy. Meaningless below ~20 Hz; returns zeros then. */
export function spectralBands(xs, sampleHz = 1) {
  const empty = { low: 0, mid: 0, high: 0 };
  if (!xs || xs.length < 16 || !(sampleHz >= 20)) return empty;
  const n = xs.length;
  const m = mean(xs) || 0;
  const energy = (lo, hi) => {
    let e = 0;
    const kMax = Math.floor(n / 2);
    for (let k = 1; k < kMax; k += 1) {
      const f = (k * sampleHz) / n;
      if (f < lo || f >= hi) continue;
      let re = 0;
      let im = 0;
      for (let t = 0; t < n; t += 1) {
        const ang = (-2 * Math.PI * k * t) / n;
        const v = xs[t] - m;
        re += v * Math.cos(ang);
        im += v * Math.sin(ang);
      }
      e += re * re + im * im;
    }
    return e / n;
  };
  return { low: energy(0.5, 2), mid: energy(2, 6), high: energy(6, 15) };
}

export function autocorr(xs, lag) {
  if (!Array.isArray(xs) || xs.length < lag + 4 || lag < 1) return 0;
  const n = xs.length - lag;
  const a = xs.slice(0, n);
  const b = xs.slice(lag);
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let d1 = 0;
  let d2 = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    d1 += x * x;
    d2 += y * y;
  }
  const den = Math.sqrt(d1 * d2);
  return den > 1e-9 ? num / den : 0;
}

export function periodicity(xs) {
  if (!xs || xs.length < 8) return { hz: null, peak: 0, prominence: 0 };
  let bestLag = 0;
  let best = 0;
  let second = 0;
  const maxLag = Math.min(25, Math.floor(xs.length / 2));
  for (let lag = 2; lag <= maxLag; lag += 1) {
    const r = autocorr(xs, lag);
    if (r > best) {
      second = best;
      best = r;
      bestLag = lag;
    } else if (r > second) second = r;
  }
  return {
    hz: bestLag ? 1 / bestLag : null,
    peak: best,
    prominence: Math.max(0, best - second),
  };
}

export function setRestCycles(energy, high = 0.08, low = 0.04) {
  if (!energy?.length) return 0;
  let pulses = 0;
  let inHigh = false;
  let highN = 0;
  for (const e of energy) {
    if (!inHigh && e >= high) {
      inHigh = true;
      highN = 1;
    } else if (inHigh && e >= high) highN += 1;
    else if (inHigh && e <= low) {
      if (highN >= 1) pulses += 1;
      inHigh = false;
      highN = 0;
    }
  }
  return pulses;
}

/** Lab / capability-gated IMU helper. Empty arrays stay empty-featured; not live proof. */
export function compactMotionFeatures({ dyn = [], gyroRms = [], sampleHz = 1 } = {}) {
  const jerk = [];
  for (let i = 1; i < dyn.length; i += 1) jerk.push(Math.abs(dyn[i] - dyn[i - 1]));
  const period = periodicity(dyn);
  const bands = spectralBands(dyn, sampleHz);
  return {
    schema: MOTION_OBS_VERSION,
    accelRms: rms(dyn) ?? 0,
    accelVar: variance(dyn) ?? 0,
    accelIqr: iqr(dyn),
    dynAccel: mean(dyn) ?? 0,
    jerk: rms(jerk) ?? 0,
    gyroRms: mean(gyroRms) ?? 0,
    orientationChange: mean(gyroRms) ?? 0,
    spectralEnergy: mean(dyn.map((x) => x * x)) ?? 0,
    bandLow: bands.low,
    bandMid: bands.mid,
    bandHigh: bands.high,
    dominantHz: period.hz,
    acPeak: period.peak,
    acProminence: period.prominence,
    repetitiveScore: period.peak * (period.prominence || 0),
    sampleHz,
    gyroAvailable: gyroRms.length > 0,
  };
}

export function cardioFloor({ restingHr, maxHr, config = V2_DEFAULTS }) {
  if (!inRange(restingHr, 20, 130)) return null;
  if (!inRange(maxHr, 140, 230)) return restingHr + config.elevatedMarginBPM;
  const hrr = Math.round(restingHr + config.hrrFloorFraction * (maxHr - restingHr));
  return Math.max(restingHr + config.elevatedMarginBPM, hrr);
}

export function activeFloorOf({ restingHr, config = V2_DEFAULTS }) {
  if (!inRange(restingHr, 20, 130)) return null;
  return restingHr + config.activeMarginBPM;
}

export function sportDisplayName(sport) {
  if (sport === 'running') return 'Running';
  return v1SportDisplayName(sport);
}

function isHistoricalFlag(sample) {
  if (sample?.historical === true || sample?.retrospective === true || sample?.live === false) return true;
  const src = String(sample?.src || sample?.source || sample?.origin || '');
  return src === 'v18' || src.startsWith('hist') || src.includes('v18') || src === 'historical';
}

function sourceOriginOf(sample) {
  const explicit = String(sample?.sourceOrigin || sample?.source_origin || '').toLowerCase();
  if (explicit === 'live' || explicit === 'historical' || explicit === 'healthkit') return explicit;
  const origin = String(sample?.origin || '').toLowerCase();
  if (origin === 'replay') {
    const rest = { ...sample, origin: undefined };
    return isHistoricalFlag(rest) ? 'historical' : 'live';
  }
  if (origin === 'live' || origin === 'historical' || origin === 'healthkit') return origin;
  if (origin === 'health_kit') return 'healthkit';
  const src = String(sample?.src || sample?.source || '');
  if (src.includes('healthkit') || src.includes('health_kit')) return 'healthkit';
  if (isHistoricalFlag(sample)) return 'historical';
  return 'live';
}

function executionContextOf(sample) {
  const ex = String(sample?.executionContext || sample?.execution_context || '').toLowerCase();
  if (ex === 'replay' || ex === 'realtime') return ex;
  if (String(sample?.origin || '').toLowerCase() === 'replay') return 'replay';
  return 'realtime';
}

function originOf(sample) {
  return sourceOriginOf(sample);
}

function eventTimeOf(sample) {
  const received = finite(sample?.receivedTs ?? sample?.received_ts);
  const sensor = validSensorMs(sample?.sensorTs ?? sample?.sensor_ts);
  const tsRaw = toMs(sample?.ts ?? sample?.datetime ?? sample?.at ?? sample?.t);
  const explicit = String(sample?.clockSource || sample?.timestamp_source || sample?.clock_source || '').toLowerCase();
  if (sensor != null && explicit !== 'receive') {
    return { t: sensor, receivedTs: received ?? sensor, clockSource: 'sensor' };
  }
  if (Number.isFinite(tsRaw)) {
    const asSensor = validSensorMs(tsRaw);
    const clockSource = explicit === 'receive' ? 'receive' : (asSensor != null ? 'sensor' : 'receive');
    return { t: tsRaw, receivedTs: received ?? tsRaw, clockSource };
  }
  if (received != null) return { t: received, receivedTs: received, clockSource: 'receive' };
  return null;
}

/**
 * Normalized observation. Missing stays missing. Combined `motion`/`mot`/
 * `dynAccel` is never copied into live strapMotion.
 */
export function normalizeObservation(sample) {
  if (!sample || typeof sample !== 'object') return null;
  const timed = eventTimeOf(sample);
  if (!timed) return null;
  const ts = timed.t;
  const origin = originOf(sample);
  const historical = origin !== 'live';
  const executionContext = executionContextOf(sample);
  const bpmRaw = finite(sample.bpm ?? sample.heartRate ?? sample.heart_rate);
  const bpm = inRange(bpmRaw, 20, 240) ? bpmRaw : null;
  const phone = finite(sample.phoneMotion ?? sample.phone_motion);
  const liveStrap = historical ? null : finite(sample.strapMotion ?? sample.strap_motion);
  const histDyn = historical
    ? finite(sample.dyn_accel ?? sample.dynAccel ?? sample.strapMotion ?? sample.strap_motion ?? sample.dynamic_acceleration)
    : null;
  const rr = Array.isArray(sample.rr_ms || sample.rrIntervals)
    ? (sample.rr_ms || sample.rrIntervals).map(Number).filter((n) => n >= 200 && n <= 2500)
    : [];
  const cadenceRaw = finite(sample.step_cadence ?? sample.cadence);
  const cadenceLive = !historical && cadenceRaw != null && sample.cadenceInvented !== true
    && String(sample.cadenceSource || '') !== 'phone';
  const stepsDelta = finite(sample.stepsDelta ?? sample.steps_delta);
  const stepsCumulative = finite(sample.stepsCumulative ?? sample.steps_cumulative ?? sample.steps);
  const wearRaw = sample.wear ?? sample.wearing ?? sample.onWrist;
  let wear = null;
  if (wearRaw === true || wearRaw === 1 || wearRaw === '1') wear = true;
  else if (wearRaw === false || wearRaw === 0 || wearRaw === '0') wear = false;
  const charging = sample.charging === true || sample.charge === true;
  const offWrist = sample.offWrist === true || sample.off_wrist === true || wear === false;
  const sleep = sample.sleep === true || sample.sleeping === true || sample.asleep === true;
  return {
    t: ts,
    ts,
    bpm,
    hrSource: sample.hrSource || sample.hr_source || sample.src || sample.source || null,
    hrQuality: finite(sample.hrQuality ?? sample.hr_quality),
    strapMotion: liveStrap,
    phoneMotion: phone,
    strapMotionSource: sample.motionSource || sample.motion_source || sample.strapMotionSource || null,
    motionCoverage: {
      strap: liveStrap != null,
      phone: phone != null,
      histDyn: histDyn != null,
    },
    rrAvailable: rr.length > 0,
    rrMs: rr,
    stepsDelta: historical ? null : stepsDelta,
    stepsCumulative: historical ? null : stepsCumulative,
    cadence: cadenceLive ? cadenceRaw : null,
    histCadence: historical ? cadenceRaw : null,
    activityClass: historical ? null : finite(sample.activity_class ?? sample.activityClass),
    histActivityClass: historical ? finite(sample.activity_class ?? sample.activityClass) : null,
    wear,
    charging,
    offWrist,
    sleep,
    origin,
    sourceOrigin: origin,
    executionContext,
    clockSource: timed.clockSource,
    receivedTs: timed.receivedTs,
    sensorTs: timed.clockSource === 'sensor' ? ts : null,
    historical,
    phoneLive: sample.phoneMotionLive === true || sample.phone_motion_live === true,
    gyroRms: finite(sample.gyroRms ?? sample.gyro_rms),
    histDynAccel: histDyn,
    highRateImu: sample.highRateImu === true || (Number(sample.imuHz) >= 20),
    imuHz: finite(sample.imuHz),
    connected: sample.connected,
    src: sample.src || sample.source || null,
  };
}

export function modalityTier(coverage = {}) {
  const hr = coverage.hr === true;
  const strap = coverage.strapMotion === true;
  const extra = coverage.cadence === true || coverage.steps === true || coverage.wear === true || coverage.gyro === true;
  const phone = coverage.phoneMotion === true;
  if (hr && strap && extra) return 'A';
  if (hr && strap) return 'B';
  if (hr && phone && !strap) return 'C';
  if (hr) return 'D';
  return 'none';
}

export function detectSetStructure(points, config = V2_DEFAULTS) {
  const pts = (points || []).filter((p) => p.strap != null);
  if (!pts.length) return { count: 0, lastWorkTs: null, bursts: 0, workS: 0 };
  let mode = 'idle';
  let modeSince = pts[0].t;
  let count = 0;
  let bursts = 0;
  let lastWorkTs = null;
  let workS = 0;
  const closeWork = (t) => {
    const dur = (t - modeSince) / 1000;
    if (dur >= config.setWorkMinS) {
      bursts += 1;
      workS += dur;
      lastWorkTs = t;
      return true;
    }
    return false;
  };
  for (const p of pts) {
    const moving = p.strap >= config.strapWorkMean;
    const quiet = p.strap <= config.strapQuietMean;
    if (mode === 'idle' || mode === 'rest') {
      if (moving) {
        mode = 'work';
        modeSince = p.t;
      }
    } else if (mode === 'work') {
      if (moving) lastWorkTs = p.t;
      else if (quiet) {
        const ok = closeWork(p.t);
        mode = ok ? 'rest' : 'idle';
        modeSince = p.t;
        if (ok) count += 1;
      }
    }
  }
  if (mode === 'work') closeWork(pts[pts.length - 1].t);
  return { count, lastWorkTs, bursts, workS: round3(workS) };
}

function windowPts(ring, ts, windowS) {
  const lo = ts - windowS * 1000;
  return ring.filter((p) => p.t >= lo && p.t <= ts);
}

function numStats(vals) {
  const v = vals.filter((n) => n != null && Number.isFinite(n));
  if (!v.length) {
    return { n: 0, mean: null, median: null, p90: null, p95: null, variance: null, min: null, max: null };
  }
  return {
    n: v.length,
    mean: mean(v),
    median: median(v),
    p90: percentile(v, 0.9),
    p95: percentile(v, 0.95),
    variance: variance(v),
    min: v.reduce((a, b) => Math.min(a, b), Infinity),
    max: v.reduce((a, b) => Math.max(a, b), -Infinity),
  };
}

function hrSlope(pts, ts, windowS) {
  const lo = ts - windowS * 1000;
  const xs = pts.filter((p) => p.t >= lo && p.t <= ts && p.bpm != null);
  if (xs.length < 4) return null;
  const dtS = (xs[xs.length - 1].t - xs[0].t) / 1000;
  if (dtS < windowS * 0.35) return null;
  return ((xs[xs.length - 1].bpm - xs[0].bpm) / dtS) * 60;
}

function durationAbove(pts, lo, hi, pred) {
  let s = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a.t < lo || b.t > hi) continue;
    const dt = Math.min(30, (b.t - a.t) / 1000);
    if (dt > 0 && pred(a)) s += dt;
  }
  return s;
}

export function extractFeatures(ring, ts, phys = {}, config = V2_DEFAULTS) {
  const live = ring.filter((p) => p.origin === 'live' && p.t <= ts);
  const w10 = windowPts(live, ts, 10);
  const w30 = windowPts(live, ts, 30);
  const w60 = windowPts(live, ts, 60);
  const w180 = windowPts(live, ts, 180);
  const cur = live.length ? live[live.length - 1] : null;
  const hr60 = numStats(w60.map((p) => p.bpm));
  const hr30 = numStats(w30.map((p) => p.bpm));
  const hr180 = numStats(w180.map((p) => p.bpm));
  const strap60 = numStats(w60.map((p) => p.strapMotion));
  const strap30 = numStats(w30.map((p) => p.strapMotion));
  const strap10 = numStats(w10.map((p) => p.strapMotion));
  const phone60 = numStats(w60.map((p) => p.phoneMotion));
  const strapPts = w180.filter((p) => p.strapMotion != null).map((p) => ({ t: p.t, strap: p.strapMotion }));
  const movingN = strapPts.filter((p) => p.t >= ts - 60_000 && p.strap >= config.strapMovingMean).length;
  const strapN60 = strap60.n;
  const movingFrac60 = strapN60 ? movingN / strapN60 : null;
  const sets = detectSetStructure(strapPts, config);
  const cad60 = numStats(w60.map((p) => p.cadence));
  const stepD = numStats(w60.map((p) => p.stepsDelta));
  const cadenceLive = cad60.n > 0;
  const coverage = {
    hr: w60.some((p) => p.bpm != null) || (cur?.bpm != null),
    rr: w60.some((p) => p.rrAvailable),
    phoneMotion: w60.some((p) => p.phoneMotion != null),
    phoneMotionLive: w60.some((p) => p.phoneLive && p.phoneMotion != null),
    strapMotion: w60.some((p) => p.strapMotion != null),
    wristLive: w60.some((p) => p.strapMotion != null),
    unspecifiedMotion: false,
    dynAccel: false,
    historicalDynAccel: ring.some((p) => p.origin !== 'live' && p.histDynAccel != null && p.t >= ts - 180_000),
    steps: w60.some((p) => p.stepsDelta != null || p.stepsCumulative != null),
    cadence: cadenceLive,
    gyro: w60.some((p) => p.gyroRms != null),
    wear: w60.some((p) => p.wear === true),
    charging: w60.some((p) => p.charging === true),
    offWrist: w60.some((p) => p.offWrist === true),
    highRateImu: config.allowHighRateImu === true && w60.some((p) => p.highRateImu),
  };
  coverage.modalityTier = modalityTier(coverage);
  const gate = phys.activeFloor;
  const floor = phys.floor;
  const aboveActiveS = durationAbove(w180, ts - 180_000, ts, (p) => p.bpm != null && gate != null && p.bpm >= gate);
  const aboveCardioS = durationAbove(w180, ts - 180_000, ts, (p) => p.bpm != null && floor != null && p.bpm >= floor);
  const hrr = Math.max(1, (phys.maxHr || 190) - (phys.restingHr || 60));
  const bpmNow = cur?.bpm ?? hr60.mean;
  const hrrFrac = bpmNow != null && phys.restingHr != null ? clamp((bpmNow - phys.restingHr) / hrr, 0, 1.4) : null;
  const preOnset = phys.preOnsetHr != null ? phys.preOnsetHr : null;
  const onsetRise = bpmNow != null && preOnset != null ? bpmNow - preOnset : null;
  const sleepLike = w180.some((p) => p.sleep === true)
    || (hr180.min != null && hr180.min <= Math.max(config.sleepHrMax, (phys.restingHr || 60) - 8)
      && strap60.mean != null && strap60.mean < config.strapQuietMean);
  const feat = {
    t: ts,
    schema: FEATURE_SCHEMA_VERSION,
    coverage,
    tier: coverage.modalityTier,
    hr: {
      current: cur?.bpm ?? null,
      mean10: numStats(w10.map((p) => p.bpm)).mean,
      mean30: hr30.mean,
      mean60: hr60.mean,
      mean180: hr180.mean,
      median60: hr60.median,
      variance60: hr60.variance,
      min60: hr60.min,
      min180: hr180.min,
      slope30: hrSlope(live, ts, 30),
      slope60: hrSlope(live, ts, 60),
      slope180: hrSlope(live, ts, 180),
      aboveActiveS: round3(aboveActiveS),
      aboveCardioS: round3(aboveCardioS),
      hrrFrac: round3(hrrFrac),
      preOnsetHr: preOnset ?? null,
      onsetRise: round3(onsetRise),
    },
    strap: {
      mean10: strap10.mean,
      mean30: strap30.mean,
      mean60: strap60.mean,
      median60: strap60.median,
      p90_60: strap60.p90,
      p95_60: strap60.p95,
      variance60: strap60.variance,
      movingFrac60,
      n60: strap60.n,
    },
    phone: {
      mean60: phone60.mean,
      variance60: phone60.variance,
      n60: phone60.n,
    },
    cadence: {
      mean: cad60.mean,
      variance: cad60.variance,
      live: cadenceLive,
      stepRate: stepD.mean,
    },
    sets,
    sleepLike,
    quality: {
      n: w60.length,
      ctxN: w180.length,
      winHrN: w60.filter((p) => p.bpm != null).length,
      winWristN: w60.filter((p) => p.strapMotion != null).length,
      winPhoneN: w60.filter((p) => p.phoneMotion != null).length,
      src: cur?.hrSource || cur?.src || null,
      srcAgeS: cur ? Math.max(0, (ts - cur.t) / 1000) : null,
      historical: ring.some((p) => p.origin !== 'live' && p.t >= ts - 180_000),
      ringN: ring.length,
      clockSource: cur?.clockSource || null,
    },
  };
  if (coverage.highRateImu && config.allowHighRateImu) {
    const dyn = w10.map((p) => p.strapMotion).filter((n) => n != null);
    feat.imu = compactMotionFeatures({
      dyn,
      gyroRms: w10.map((p) => p.gyroRms).filter((n) => n != null),
      sampleHz: cur?.imuHz || 1,
    });
  }
  return feat;
}

export function featureVector(feat, extra = {}) {
  return {
    schema: FEATURE_SCHEMA_VERSION,
    detector: WORKOUT_DETECT_V2_VERSION,
    bpm: feat.hr.current,
    bpm_mean_60: feat.hr.mean60,
    bpm_median_60: feat.hr.median60,
    hr_above_active_s: feat.hr.aboveActiveS,
    hr_above_cardio_s: feat.hr.aboveCardioS,
    hrr_frac: feat.hr.hrrFrac,
    slope_30: feat.hr.slope30,
    slope_60: feat.hr.slope60,
    slope_180: feat.hr.slope180,
    onset_rise: feat.hr.onsetRise,
    strap_mean_60: feat.strap.mean60,
    strap_p90_60: feat.strap.p90_60,
    strap_var_60: feat.strap.variance60,
    moving_frac_60: feat.strap.movingFrac60,
    set_count: feat.sets.count,
    cadence_mean: feat.cadence.mean,
    phone_mean_60: feat.phone.mean60,
    tier: feat.tier,
    lane: extra.lane || null,
    coverage: feat.coverage,
  };
}

function strapMoving(feat, config) {
  return feat.strap.mean30 != null && feat.strap.mean30 >= config.strapMovingMean;
}

function gaitEvidence(feat, config) {
  return feat.cadence.live === true && feat.cadence.mean != null && feat.cadence.mean >= config.cadenceWalkMin;
}

export function detectExercise(feat, phys, config = V2_DEFAULTS) {
  const bpm = feat.hr.mean60 ?? feat.hr.current;
  const hrActive = bpm != null && phys.activeFloor != null && bpm >= phys.activeFloor;
  const hrCardio = bpm != null && phys.floor != null && bpm >= phys.floor;
  const moving = strapMoving(feat, config);
  const sustained = feat.strap.movingFrac60 != null && feat.strap.movingFrac60 >= config.movingFractionMin;
  const gait = gaitEvidence(feat, config);
  const setN = feat.sets.count || 0;
  const onsetOk = feat.hr.onsetRise != null && feat.hr.onsetRise >= config.onsetRiseBpm;
  const reasons = [];
  let score = 0;
  if (hrActive) { score += 0.18; reasons.push('hr_active'); }
  if (hrCardio) { score += 0.22; reasons.push('hr_cardio'); }
  if (moving) { score += 0.24; reasons.push('strap_moving'); }
  if (sustained) { score += 0.1; reasons.push('strap_sustained'); }
  if (gait && feat.coverage.strapMotion) { score += 0.22; reasons.push('cadence'); }
  if (setN >= 1 && feat.coverage.strapMotion) { score += 0.14; reasons.push('set_structure'); }
  if (feat.phone.mean60 != null && feat.phone.mean60 >= config.phoneContextMean && !moving) {
    score += 0.04;
    reasons.push('phone_context');
  }
  score = clamp(score, 0, 1);

  let lane = 'unknown';
  if (gait && feat.coverage.strapMotion) lane = 'ambulatory';
  else if (setN >= 1 && feat.coverage.strapMotion && !gait) lane = 'strength_candidate';
  else if (hrCardio && moving) lane = 'cardio_rhythmic';
  else if (hrCardio && feat.coverage.strapMotion && !moving) lane = 'cardio_low_wrist';
  else if (hrCardio && !feat.coverage.strapMotion) lane = 'generic';
  else if (hrActive) lane = 'generic';

  const coherent = feat.coverage.strapMotion
    ? Boolean(hrActive && (moving || sustained || hrCardio || gait || setN >= 1))
    : Boolean(hrCardio);

  return {
    label: coherent ? 'exercise' : (hrActive ? 'uncertain' : 'non_exercise'),
    coherent,
    hrActive,
    hrCardio,
    evidenceScore: round3(score),
    reasons,
    lane,
    onsetOk,
    onsetUnevaluable: feat.hr.preOnsetHr == null || feat.hr.onsetRise == null,
    quality: feat.coverage,
    tier: feat.tier,
  };
}

export function contextVeto(obs, feat, phys, config = V2_DEFAULTS, state = 'IDLE') {
  if (!obs) return null;
  if (obs.offWrist || obs.charging || feat.coverage.offWrist || feat.coverage.charging) return 'off_wrist';
  if (obs.sleep || feat.sleepLike) return 'sleep';
  if (obs.origin !== 'live' && (state === 'POSSIBLE' || state === 'LIKELY' || state === 'CONFIRMED')) {
    return 'stale_historical';
  }
  const bpm = feat.hr.mean60 ?? obs.bpm;
  const moving = strapMoving(feat, config);
  if (feat.sleepLike && !moving) return 'sleep_wake';
  const irregular = feat.coverage.strapMotion
    && feat.strap.mean60 != null
    && feat.strap.mean60 < config.strapMovingMean
    && (feat.strap.variance60 || 0) > 0
    && !gaitEvidence(feat, config)
    && (feat.sets.count || 0) < 1
    && bpm != null
    && phys.floor != null
    && bpm < phys.floor;
  if (irregular && (state === 'IDLE' || state === 'POSSIBLE')) return 'chores';
  return null;
}

export function classifySport(feat, lane, config = V2_DEFAULTS) {
  const gait = gaitEvidence(feat, config);
  const moving = strapMoving(feat, config);
  const setN = feat.sets.count || 0;
  const wrist = feat.coverage.strapMotion === true;
  const hrCardio = feat.hr.mean60 != null && feat.hr.hrrFrac != null && feat.hr.hrrFrac >= 0.45;

  if (!wrist && setN > 0) {
    return { sport: 'detected', activity: 'generic_activity', reason: 'phone_motion_not_wrist' };
  }
  if (setN >= config.strengthSetsMin && wrist && !gait) {
    return { sport: 'strength', activity: 'strength', reason: 'set_motion_structure' };
  }
  if (gait && wrist) {
    if (feat.cadence.mean >= config.cadenceRunMin && (hrCardio || (feat.hr.mean60 || 0) >= 140)) {
      return { sport: 'running', activity: 'running', reason: 'cadence_running' };
    }
    return { sport: 'walking', activity: 'walking', reason: 'cadence_gait' };
  }
  if (lane === 'cardio_low_wrist') {
    return { sport: 'detected', activity: 'cardio', reason: 'low_wrist_cardio_generic' };
  }
  if (lane === 'cardio_rhythmic' && moving) {
    return { sport: 'detected', activity: 'cardio', reason: 'cardio_evidence' };
  }
  if (gait && !wrist) {
    return { sport: 'detected', activity: 'generic_activity', reason: 'cadence_without_strap' };
  }
  if (setN < config.strengthSetsMin && !moving && !gait) {
    return { sport: 'detected', activity: 'generic_activity', reason: 'low_motion_not_strength' };
  }
  return { sport: 'detected', activity: 'generic_activity', reason: 'class_margin_low' };
}

export function confirmMinS({ feat, bout, config = V2_DEFAULTS, strong = false } = {}) {
  const tier = feat?.tier || 'none';
  const gait = gaitEvidence(feat, config);
  const cad = feat?.cadence?.mean;
  const run = gait && cad != null && cad >= config.cadenceRunMin;
  const walk = gait && !run;
  const setN = feat?.sets?.count || 0;
  const wrist = feat?.coverage?.strapMotion === true;
  if (tier === 'D') return config.confirmTierDS;
  if (tier === 'C') return config.confirmTierCS;
  if (run && wrist) return config.confirmRunS;
  if (walk && wrist) return config.confirmWalkS;
  if ((bout?.lane === 'strength_candidate' || setN >= 1) && wrist) return config.confirmStrengthS;
  if (bout?.lane === 'cardio_low_wrist') return config.confirmLowWristS;
  if (bout?.lane === 'cardio_rhythmic') return config.confirmCardioS;
  if (tier === 'A') return strong ? config.confirmTierAStrongS : config.confirmTierAS;
  if (tier === 'B') return config.confirmTierBS;
  return null;
}

export function confirmDecision({
  feat, bout, phys, config = V2_DEFAULTS, elapsedS, veto,
}) {
  if (veto) return { ok: false, reason: veto };
  if (!bout?.coherent) return { ok: false, reason: 'not_coherent' };
  const tier = feat.tier || 'none';
  const onsetOk = bout.onsetOk === true;
  const onsetUneval = bout.onsetUnevaluable === true;
  const moving = strapMoving(feat, config);
  const gait = gaitEvidence(feat, config);
  const setN = feat.sets.count || 0;
  const strong = bout.hrCardio && (feat.strap.movingFrac60 || 0) >= config.movingFractionMin
    && (onsetOk || gait || setN >= config.strengthSetsMin);
  let minS = confirmMinS({ feat, bout, config, strong });
  if (minS == null) return { ok: false, reason: 'no_hr' };

  let path = 'standard';
  if (!onsetOk && !onsetUneval) {
    minS += config.weakOnsetExtraS;
    path = 'sustained_despite_weak_onset';
  }
  if (tier === 'D' && !onsetOk) return { ok: false, reason: 'hr_only_needs_onset' };
  if (tier === 'C' && !onsetOk) return { ok: false, reason: 'tier_c_needs_onset' };
  if (elapsedS < minS) return { ok: false, reason: 'duration' };

  if (tier === 'D') {
    if (!bout.hrCardio || (!onsetOk && !onsetUneval)) return { ok: false, reason: 'hr_only_gates' };
    return {
      ok: true,
      path: 'hr_only',
      reason: 'hr_only_generic',
      sport: 'detected',
      activity: 'generic_activity',
      confidence: 'low',
      haptic: false,
    };
  }
  if (tier === 'C') {
    return {
      ok: true,
      path: path === 'sustained_despite_weak_onset' ? path : 'tier_c_generic',
      reason: 'phone_motion_generic',
      sport: 'detected',
      activity: 'generic_activity',
      confidence: 'low',
      haptic: true,
    };
  }

  const cls = classifySport(feat, bout.lane, config);
  let sport = cls.sport;
  let activity = cls.activity;
  if (tier === 'C' || tier === 'D') {
    sport = 'detected';
    activity = 'generic_activity';
  }
  if (sport === 'walking' && !gait) {
    sport = 'detected';
    activity = 'generic_activity';
  }
  if (sport === 'strength' && (setN < config.strengthSetsMin || !feat.coverage.strapMotion)) {
    sport = 'detected';
    activity = 'generic_activity';
  }
  if (path === 'sustained_despite_weak_onset' && moving && !onsetOk) {
    return {
      ok: true,
      path,
      reason: 'sustained_despite_weak_onset',
      sport,
      activity,
      confidence: 'standard',
      haptic: true,
    };
  }
  const high = tier === 'A' && onsetOk && bout.hrCardio && moving;
  if (sport === 'strength') path = 'strength';
  else if (sport === 'walking') path = 'walking';
  else if (sport === 'running') path = 'running';
  else if (bout.lane === 'cardio_low_wrist') path = 'cardio_low_wrist';
  else path = high ? 'high_confidence' : path;
  return {
    ok: true,
    path,
    reason: cls.reason,
    sport,
    activity,
    confidence: high ? 'high' : (tier === 'B' ? 'standard' : 'low'),
    haptic: true,
  };
}

export function backtrackEffectiveStart(ring, confirmTs, phys, config, firstCoherentTs) {
  const lo = confirmTs - config.maxBacktrackS * 1000;
  const live = ring.filter((p) => p.origin === 'live' && p.t >= lo && p.t <= confirmTs);
  if (!live.length) return firstCoherentTs ?? confirmTs;
  let segStart = live[0].t;
  for (let i = 1; i < live.length; i += 1) {
    if (live[i].t - live[i - 1].t > config.preConfirmGapS * 1000) segStart = live[i].t;
  }
  const seg = live.filter((p) => p.t >= segStart);
  const floor = phys.floor;
  const gate = phys.activeFloor;
  let found = null;
  for (const p of seg) {
    const hrA = p.bpm != null && gate != null && p.bpm >= gate;
    const hrC = p.bpm != null && floor != null && p.bpm >= floor;
    const moving = p.strapMotion != null && p.strapMotion >= config.strapMovingMean;
    const gait = p.cadence != null && p.cadence >= config.cadenceWalkMin;
    if (hrA && (moving || hrC || gait)) {
      found = p.t;
      break;
    }
  }
  const start = found ?? firstCoherentTs ?? segStart;
  if (start < segStart) return segStart;
  return start;
}

export function trimEffectiveEnd(lastExerciseTs, graceTs) {
  if (lastExerciseTs == null) return graceTs;
  return Math.min(lastExerciseTs, graceTs ?? lastExerciseTs);
}

function gapIn(obs, start, end) {
  const inW = obs.filter((p) => p.t >= start && p.t <= end).sort((a, b) => a.t - b.t);
  for (let i = 1; i < inW.length; i += 1) {
    if (inW[i].t - inW[i - 1].t > 90_000) return true;
  }
  if (!inW.length && end - start > 90_000) return true;
  return false;
}

/**
 * Post-hoc boundary/sport refine. Never mints an id, never overwrites user edits,
 * never treats a gap as continuity.
 */
export function reconcileWorkoutV2({
  workout,
  observations = [],
  detectorVersion = WORKOUT_DETECT_V2_VERSION,
  nowMs = Date.now(),
  config = V2_DEFAULTS,
} = {}) {
  if (!workout || !workout.id) return { changed: false, reason: 'no_workout', workout };
  if (workout.userEdited || workout.userModified) {
    return { changed: false, reason: 'user_edited', workout };
  }
  const start0 = workout.startTs ?? workout.effectiveStartTs ?? workout.onsetTs;
  const end0 = workout.endTs ?? workout.effectiveEndTs;
  if (start0 == null || end0 == null) return { changed: false, reason: 'incomplete', workout };

  const obs = observations.map((s) => (s.t != null ? s : normalizeObservation(s))).filter(Boolean);
  const padLo = start0 - config.maxBacktrackS * 1000;
  const padHi = end0 + 120_000;
  const inPad = obs.filter((p) => p.t >= padLo && p.t <= padHi);
  let startTs = start0;
  let endTs = end0;
  let sport = workout.sport || 'detected';

  const support = (p) => {
    const bpm = p.bpm;
    const strap = p.origin === 'live' ? p.strapMotion : p.histDynAccel;
    const cad = p.origin === 'live' ? p.cadence : p.histCadence;
    return (bpm != null && bpm >= 75)
      && ((strap != null && strap >= 0.05) || (cad != null && cad >= 90) || (bpm >= 114));
  };
  const supported = inPad.filter(support);
  if (supported.length) {
    const first = supported[0];
    const last = supported[supported.length - 1];
    if (first.t < startTs && first.t >= padLo && !gapIn(inPad, first.t, startTs)) startTs = first.t;
    else if (first.t > startTs && first.t <= endTs && !gapIn(inPad, startTs, first.t)) startTs = first.t;
    if (last.t < endTs && last.t >= startTs) endTs = last.t;
  }
  if (gapIn(obs, startTs, endTs)) {
    startTs = start0;
    endTs = end0;
  }

  const cadN = inPad.filter((p) => (p.cadence ?? p.histCadence) >= 90).length;
  const setN = detectSetStructure(
    inPad.filter((p) => (p.origin === 'live' ? p.strapMotion : p.histDynAccel) != null)
      .map((p) => ({ t: p.t, strap: p.origin === 'live' ? p.strapMotion : p.histDynAccel })),
    config,
  ).count;
  if (sport === 'detected' && setN >= config.strengthSetsMin) sport = 'strength';
  else if (sport === 'detected' && cadN >= 30) sport = 'walking';

  const same = startTs === start0 && endTs === end0 && sport === (workout.sport || 'detected');
  if (same) return { changed: false, reason: 'idempotent', workout };

  const next = {
    ...workout,
    startTs,
    endTs,
    effectiveStartTs: startTs,
    effectiveEndTs: endTs,
    sport,
    durationS: Math.max(0, Math.round((endTs - startTs) / 1000)),
    reconciled: true,
  };
  return {
    changed: true,
    reason: 'post_hoc',
    workout: next,
    event: Object.freeze({
      workout_id: workout.id,
      old_start: start0,
      old_end: end0,
      old_type: workout.sport || 'detected',
      new_start: startTs,
      new_end: endTs,
      new_type: sport,
      reason: 'post_hoc',
      detector_version: detectorVersion,
      evidence_sources: [...new Set(inPad.map((p) => p.origin).filter(Boolean))],
      at: new Date(nowMs).toISOString(),
    }),
  };
}

function apiState(internal) {
  if (internal === 'ENDING' || internal === 'SUSPENDED_UNKNOWN') return 'CONFIRMED';
  return internal;
}

function tierName(internal) {
  if (internal === 'POSSIBLE') return 'candidate';
  if (internal === 'LIKELY') return 'provisional';
  if (internal === 'CONFIRMED' || internal === 'ENDING' || internal === 'SUSPENDED_UNKNOWN') return 'confirmed';
  return null;
}

function emptyCounters() {
  return {
    candidate_starts: 0,
    confirm_strength: 0,
    confirm_walking: 0,
    confirm_running: 0,
    confirm_cardio: 0,
    confirm_generic: 0,
    reset_timeout: 0,
    reset_signal_gap: 0,
    reset_low_score: 0,
    reset_too_short: 0,
    reset_veto: 0,
    missing_physiology: 0,
    dismissals: 0,
    v1_v2_disagree: 0,
    native_backend_disagree: 0,
    reconcile_applied: 0,
    reconcile_skipped_user_edit: 0,
  };
}

export function createWorkoutDetectorV2({
  thresholds = () => ({}),
  config: overrides = {},
  onEvent = () => {},
  now = () => Date.now(),
} = {}) {
  const config = { ...V2_DEFAULTS, ...overrides };
  let state = 'IDLE';
  let lastSampleTs = null;
  let lastLiveTs = null;
  let lastReceivedTs = null;
  let lastMono = null;
  let detectedStartTs = null;
  let confirmedTs = null;
  let effectiveStartTs = null;
  let effectiveEndTs = null;
  let firstCoherentTs = null;
  let lastExerciseTs = null;
  let belowSinceTs = null;
  let endStartTs = null;
  let lastSupportedTs = null;
  let confirmPath = null;
  let confirmReason = null;
  let sport = 'detected';
  let activity = 'unknown';
  let lane = 'unknown';
  let cooldownUntilTs = 0;
  let rearmBelow = false;
  let sessionOwned = false;
  let confirmed = false;
  let workoutId = null;
  let lastFeat = null;
  let lastBout = null;
  let lastBpm = null;
  let lastVeto = null;
  let lastCpuMs = 0;
  let evidenceScore = null;
  let traceId = null;
  let ring = [];
  let histRing = [];
  let windows = [];
  let transitions = [];
  let boutAcc = null;
  let lastFinished = null;
  let strengthEvidence = false;
  let counters = emptyCounters();
  let featureObj = null;

  function phys() {
    const t = thresholds() || {};
    const restingHr = inRange(Number(t.restingHr), 20, 130) ? Number(t.restingHr) : null;
    const maxHr = inRange(Number(t.maxHr), 140, 230) ? Number(t.maxHr) : null;
    if (restingHr == null) {
      return { restingHr: null, maxHr, floor: null, activeFloor: null, physReady: false, preOnsetHr: null };
    }
    return {
      restingHr,
      maxHr,
      floor: cardioFloor({ restingHr, maxHr, config }),
      activeFloor: activeFloorOf({ restingHr, config }),
      physReady: true,
      preOnsetHr: t.preOnsetHr ?? null,
    };
  }

  function emit(event) {
    try { onEvent(event); } catch { /* listeners must not break ingest */ }
  }

  function pushTransition(row) {
    transitions.push(row);
    if (transitions.length > config.traceTransitions) transitions.shift();
  }

  function setState(next, ts, reason) {
    if (state === next) return;
    const prev = state;
    state = next;
    pushTransition({
      ts, from: prev, to: next, reason, lane, evidenceScore, tier: lastFeat?.tier, version: WORKOUT_DETECT_V2_VERSION,
    });
    emit({
      type: 'state',
      prev: apiState(prev),
      state: apiState(next),
      detectorState: apiState(next),
      internalState: next,
      confidenceTier: tierName(next),
      ts,
    });
  }

  function trimRing(ts) {
    const cut = ts - config.ringS * 1000;
    while (ring.length && (ring[0].t < cut || ring.length > config.ringMaxN)) ring.shift();
    while (histRing.length > config.histRingMaxN) histRing.shift();
  }

  function preOnsetFromRing(ts) {
    const lo = ts - config.onsetLookbackS * 1000;
    const xs = ring.filter((p) => p.origin === 'live' && p.t >= lo && p.t < ts && p.bpm != null);
    return mean(xs.map((p) => p.bpm));
  }

  function startCandidate(ts, bpm) {
    detectedStartTs = ts;
    effectiveStartTs = ts;
    confirmedTs = null;
    effectiveEndTs = null;
    firstCoherentTs = null;
    lastExerciseTs = null;
    belowSinceTs = null;
    endStartTs = null;
    confirmPath = null;
    confirmReason = null;
    sport = 'detected';
    activity = 'unknown';
    lane = 'unknown';
    sessionOwned = false;
    confirmed = false;
    workoutId = null;
    strengthEvidence = false;
    traceId = `v2-${ts}`;
    counters.candidate_starts += 1;
    const pre = preOnsetFromRing(ts);
    boutAcc = {
      hrTimeWt: 0,
      weightS: 0,
      peakBpm: bpm || 0,
      zoneS: [0, 0, 0, 0, 0],
      lastTs: null,
      sportS: { walking: 0, strength: 0, running: 0, detected: 0 },
      motionTimeWt: 0,
      motionWt: 0,
      preOnsetHr: pre,
      unknownGapS: 0,
      gaps: [],
    };
  }

  function accumulate(ts, bpm, strap) {
    if (!boutAcc) return;
    const rawDt = boutAcc.lastTs == null ? 0 : Math.max((ts - boutAcc.lastTs) / 1000, 0);
    if (rawDt > config.sampleGapIgnoreS) {
      boutAcc.unknownGapS = (boutAcc.unknownGapS || 0) + rawDt;
      boutAcc.gaps = boutAcc.gaps || [];
      boutAcc.gaps.push({ startTs: boutAcc.lastTs, endTs: ts, durationS: rawDt });
      boutAcc.lastTs = ts;
      if (bpm != null && bpm > boutAcc.peakBpm) boutAcc.peakBpm = bpm;
      return;
    }
    const dtS = Math.min(rawDt, config.zoneDtCapS);
    boutAcc.lastTs = ts;
    if (dtS > 0 && bpm != null) {
      boutAcc.hrTimeWt += bpm * dtS;
      boutAcc.weightS += dtS;
      const maxHr = phys().maxHr;
      if (maxHr != null) {
        const z = hrZone(bpm, maxHr);
        if (z >= 1) boutAcc.zoneS[z - 1] += dtS;
      }
      const sp = sport || 'detected';
      boutAcc.sportS[sp] = (boutAcc.sportS[sp] || 0) + dtS;
      if (Number.isFinite(strap)) {
        boutAcc.motionTimeWt += strap * dtS;
        boutAcc.motionWt += dtS;
      }
    }
    if (bpm != null && bpm > boutAcc.peakBpm) boutAcc.peakBpm = bpm;
  }

  function backfillFrom(startTs, endTs) {
    if (!boutAcc) return;
    boutAcc.hrTimeWt = 0;
    boutAcc.weightS = 0;
    boutAcc.zoneS = [0, 0, 0, 0, 0];
    boutAcc.sportS = { walking: 0, strength: 0, running: 0, detected: 0 };
    boutAcc.motionTimeWt = 0;
    boutAcc.motionWt = 0;
    boutAcc.unknownGapS = 0;
    boutAcc.gaps = [];
    boutAcc.lastTs = null;
    const slice = ring.filter((p) => p.origin === 'live' && p.t >= startTs && p.t <= endTs);
    for (const p of slice) accumulate(p.t, p.bpm, p.strapMotion);
  }

  function summary(endTs) {
    const start = effectiveStartTs ?? detectedStartTs;
    const durationS = Math.max(0, Math.round((endTs - start) / 1000));
    const avgHr = boutAcc && boutAcc.weightS > 0 ? Math.round(boutAcc.hrTimeWt / boutAcc.weightS) : null;
    const zoneTotal = boutAcc ? boutAcc.zoneS.reduce((a, b) => a + b, 0) : 0;
    const p = phys();
    const motion = boutAcc && boutAcc.motionWt > 0 ? boutAcc.motionTimeWt / boutAcc.motionWt : null;
    const observedDurationS = boutAcc ? Math.round(boutAcc.weightS) : 0;
    const unknownGapS = boutAcc ? Math.round(boutAcc.unknownGapS || 0) : 0;
    return {
      startTs: start,
      endTs,
      detectedStartTs,
      confirmedTs,
      effectiveStartTs: start,
      effectiveEndTs: endTs,
      durationS,
      elapsedDurationS: durationS,
      observedDurationS,
      unknownGapS,
      gaps: boutAcc?.gaps ? boutAcc.gaps.slice() : [],
      avgHr,
      peakHr: boutAcc ? boutAcc.peakBpm : null,
      zonesPct: boutAcc && zoneTotal > 0 ? boutAcc.zoneS.map((s) => Math.round((s / zoneTotal) * 1000) / 10) : [0, 0, 0, 0, 0],
      floor: p.floor,
      restingHr: p.restingHr,
      maxHr: p.maxHr,
      motionMean: motion == null ? null : Math.round(motion * 1000) / 1000,
      confirmPath,
      confirmReason,
      sport: primarySport(boutAcc?.sportS) || sport || 'detected',
      activity,
      lane,
      modalityTier: lastFeat?.tier || null,
      evidenceScore,
      workoutId,
      traceId,
    };
  }

  function resetBout() {
    boutAcc = null;
    detectedStartTs = null;
    confirmedTs = null;
    effectiveStartTs = null;
    effectiveEndTs = null;
    firstCoherentTs = null;
    lastExerciseTs = null;
    belowSinceTs = null;
    endStartTs = null;
    lastSupportedTs = null;
    confirmPath = null;
    confirmReason = null;
    sessionOwned = false;
    confirmed = false;
    workoutId = null;
    activity = 'unknown';
    lane = 'unknown';
    strengthEvidence = false;
    evidenceScore = null;
    featureObj = null;
  }

  function finalize(endTs, ts, reason) {
    const trimmed = trimEffectiveEnd(lastExerciseTs ?? lastSupportedTs ?? endTs, endTs);
    const capped = Math.min(trimmed, (effectiveStartTs ?? detectedStartTs ?? trimmed) + config.maxWorkoutS * 1000);
    const result = summary(capped);
    const discard = result.durationS < config.minWorkoutS;
    lastFinished = discard ? lastFinished : { ...result, id: workoutId, userModified: false };
    resetBout();
    setState('IDLE', ts, reason);
    if (discard) {
      counters.reset_too_short += 1;
      emit({ type: 'workout_discarded', reason: 'too_short', durationS: result.durationS, ts });
    } else {
      emit({ type: 'workout_end', workout: result, reason, ts });
    }
  }

  function confirm(ts, decision, feat) {
    const p = phys();
    const start = backtrackEffectiveStart(ring, ts, p, config, firstCoherentTs ?? detectedStartTs);
    const identityTs = firstCoherentTs ?? detectedStartTs ?? start;
    detectedStartTs = firstCoherentTs ?? start;
    effectiveStartTs = start;
    confirmedTs = ts;
    confirmed = true;
    sessionOwned = true;
    confirmPath = decision.path;
    confirmReason = decision.reason;
    sport = decision.sport;
    activity = decision.activity || activity;
    workoutId = workoutId || mintWorkoutId(identityTs, ts);
    traceId = traceId || workoutId;
    backfillFrom(start, ts);
    if (boutAcc) {
      boutAcc.sportS[sport] = (boutAcc.sportS[sport] || 0) + (boutAcc.sportS.detected || 0);
      boutAcc.sportS.detected = 0;
    }
    if (decision.path === 'walking') counters.confirm_walking += 1;
    else if (decision.path === 'strength') counters.confirm_strength += 1;
    else if (decision.path === 'running') counters.confirm_running += 1;
    else if (decision.activity === 'generic_activity' || decision.path === 'hr_only') counters.confirm_generic += 1;
    else counters.confirm_cardio += 1;
    setState('CONFIRMED', ts, decision.reason);
    emit({
      type: 'workout_start',
      workout: {
        onsetTs: start,
        detectedStartTs,
        confirmedTs: ts,
        effectiveStartTs: start,
        floor: p.floor,
        restingHr: p.restingHr,
        maxHr: p.maxHr,
        onsetRiseBpm: feat.hr.onsetRise != null ? Math.round(feat.hr.onsetRise * 10) / 10 : null,
        motionMean: feat.strap.mean60,
        confirmPath,
        confirmReason,
        sport,
        activity,
        lane,
        modalityTier: feat.tier,
        evidenceScore,
        evidenceReasons: lastBout?.reasons || [],
        coverage: feat.coverage,
        confidence: decision.confidence,
        confidenceTier: 'confirmed',
        haptic: decision.haptic !== false && decision.confidence !== 'low',
        traceId,
        workoutId,
        scores: {
          bout_label: lastBout?.label,
          bout_score: evidenceScore,
          activity,
          reason: decision.reason,
          modality_tier: feat.tier,
          lane,
        },
        featureVector: featureObj,
      },
      ts,
    });
  }

  function dipLimitS() {
    if (strengthEvidence) return config.strengthDipS;
    if (lane === 'ambulatory') return config.ambulatoryDipS;
    return config.cardioDipS;
  }

  function endNeedS() {
    if (sport === 'strength' || lane === 'strength_candidate') return config.endStrengthS;
    if (sport === 'walking' || lane === 'ambulatory') return config.endWalkS;
    if (lane === 'cardio_low_wrist') return config.endLowWristS;
    return config.endCardioS;
  }

  function stepLive(obs) {
    const ts = obs.t;
    const p0 = phys();
    if (!p0.physReady) counters.missing_physiology += 1;
    const p = {
      ...p0,
      preOnsetHr: boutAcc?.preOnsetHr ?? p0.preOnsetHr,
    };
    const tCpu = Date.now();
    const feat = extractFeatures(ring, ts, p, config);
    lastFeat = feat;
    lastCpuMs = Date.now() - tCpu;
    const bout = detectExercise(feat, p, config);
    lastBout = bout;
    evidenceScore = bout.evidenceScore;
    lane = bout.lane;
    if (feat.sets.count >= config.strengthSetsMin && feat.coverage.strapMotion) strengthEvidence = true;
    featureObj = featureVector(feat, { lane });
    const veto = contextVeto(obs, feat, p, config, state);
    lastVeto = veto;

    windows.push({
      t: ts,
      traceId,
      state: apiState(state),
      internalState: state,
      lane,
      coverage: feat.coverage,
      modalityTier: feat.tier,
      evidenceScore,
      reasons: bout.reasons,
      veto,
      cardiac: { bpmMean: feat.hr.mean60, onsetRise: feat.hr.onsetRise, slope60: feat.hr.slope60 },
      motion: { strapMean: feat.strap.mean60, phoneMean: feat.phone.mean60, setCount: feat.sets.count },
      version: WORKOUT_DETECT_V2_VERSION,
      feature_schema_version: FEATURE_SCHEMA_VERSION,
    });
    if (windows.length > config.traceWindows) windows.shift();

    if (ts < cooldownUntilTs) return;
    accumulate(ts, obs.bpm, obs.strapMotion);

    const bpm10 = feat.hr.mean10 ?? feat.hr.current;
    const moving10 = feat.strap.mean10 != null && feat.strap.mean10 >= config.strapMovingMean;
    const activeNow = bpm10 != null && p.activeFloor != null && (
      (bpm10 >= p.floor && p.floor != null)
      || (bpm10 >= p.activeFloor && (moving10 || gaitEvidence(feat, config)))
      || (moving10 && bpm10 >= p.activeFloor)
    );
    if (bout.coherent) {
      firstCoherentTs = firstCoherentTs ?? ts;
      belowSinceTs = null;
    }
    if (activeNow) {
      lastExerciseTs = ts;
      lastSupportedTs = ts;
    }

    switch (state) {
      case 'IDLE': {
        if (rearmBelow) {
          if (p.activeFloor == null || (obs.bpm != null && obs.bpm < p.activeFloor)) rearmBelow = false;
          else break;
        }
        if (veto === 'off_wrist' || veto === 'sleep') break;
        if (p.activeFloor != null && obs.bpm != null && obs.bpm >= p.activeFloor) {
          startCandidate(ts, obs.bpm);
          if (bout.coherent) firstCoherentTs = ts;
          setState('POSSIBLE', ts, 'active_gate');
        }
        break;
      }
      case 'POSSIBLE':
      case 'LIKELY': {
        if (veto === 'off_wrist' || veto === 'sleep') {
          counters.reset_veto += 1;
          resetBout();
          setState('IDLE', ts, veto);
          break;
        }
        if (!bout.coherent) {
          belowSinceTs = belowSinceTs ?? ts;
          if ((ts - belowSinceTs) / 1000 > dipLimitS()) {
            counters.reset_low_score += 1;
            resetBout();
            setState('IDLE', ts, 'below_threshold');
            break;
          }
        }
        const elapsed = firstCoherentTs == null ? 0 : (ts - firstCoherentTs) / 1000;
        if (state === 'POSSIBLE' && bout.coherent && elapsed >= config.possibleSustainS) {
          setState('LIKELY', ts, 'coherent_sustain');
        }
        if (bout.coherent) {
          const decision = confirmDecision({
            feat, bout, phys: p, config, elapsedS: elapsed,
            veto: veto === 'chores' ? null : veto,
          });
          if (decision.ok) confirm(ts, decision, feat);
        }
        break;
      }
      case 'CONFIRMED':
      case 'ENDING':
      case 'SUSPENDED_UNKNOWN': {
        if (ts - (effectiveStartTs ?? detectedStartTs) >= config.maxWorkoutS * 1000) {
          finalize((effectiveStartTs ?? detectedStartTs) + config.maxWorkoutS * 1000, ts, 'max_duration');
          break;
        }
        if (state === 'SUSPENDED_UNKNOWN') {
          if (bout.coherent) {
            setState('CONFIRMED', ts, 'resume_after_gap');
            endStartTs = null;
          } else {
            finalize(lastExerciseTs ?? lastSupportedTs ?? lastLiveTs ?? ts, ts, 'gap_end');
          }
          break;
        }
        const working = (sport === 'strength' || lane === 'strength_candidate')
          ? (bout.coherent || (feat.sets.count >= 1 && bpm10 != null && p.activeFloor != null && bpm10 >= p.activeFloor))
          : activeNow;
        if (working) {
          if (state === 'ENDING') setState('CONFIRMED', ts, 'resume');
          endStartTs = null;
          const cls = classifySport(feat, lane, config);
          if (cls.sport === 'strength' || cls.sport === 'walking' || cls.sport === 'running') {
            if (sport === 'detected') {
              const prev = sport;
              sport = cls.sport;
              activity = cls.activity;
              emit({ type: 'sport_change', prev, sport, ts });
            }
          }
        } else if (state === 'CONFIRMED') {
          endStartTs = ts;
          setState('ENDING', ts, 'evidence_drop');
        }
        if (state === 'ENDING' && endStartTs != null && (ts - endStartTs) / 1000 >= endNeedS()) {
          finalize(lastExerciseTs ?? lastSupportedTs ?? endStartTs, ts, 'auto');
        }
        break;
      }
      default:
        break;
    }
  }

  function handleGap(ts, gapS) {
    if (gapS <= config.sampleGapIgnoreS) return;
    if ((state === 'POSSIBLE' || state === 'LIKELY') && gapS > config.preConfirmGapS) {
      counters.reset_signal_gap += 1;
      const reason = 'signal_gap';
      lastVeto = reason;
      resetBout();
      setState('IDLE', ts, reason);
      return;
    }
    if ((state === 'CONFIRMED' || state === 'ENDING') && gapS > config.sampleGapIgnoreS) {
      if (gapS > config.forgottenStaleS) {
        finalize(lastExerciseTs ?? lastSupportedTs ?? lastLiveTs ?? ts, ts, 'forgotten');
      } else if (gapS > config.suspendGapS) {
        finalize(lastExerciseTs ?? lastSupportedTs ?? lastLiveTs ?? ts, ts, 'unsupported_gap');
      } else if (state !== 'SUSPENDED_UNKNOWN') {
        setState('SUSPENDED_UNKNOWN', ts, 'reconnect_gap');
      }
    }
  }

  function ingest(sample) {
    const obs = normalizeObservation(sample);
    if (!obs) return snapshot();
    if (obs.origin !== 'live') {
      ingestHistorical(sample);
      if (state === 'POSSIBLE' || state === 'LIKELY' || state === 'CONFIRMED') {
        lastVeto = 'stale_historical';
        windows.push({
          t: obs.t, state: apiState(state), reason: 'stale_historical',
          version: WORKOUT_DETECT_V2_VERSION, origin: obs.origin,
        });
        if (windows.length > config.traceWindows) windows.shift();
      }
      return snapshot();
    }
    if (obs.bpm == null && obs.phoneMotion == null && obs.strapMotion == null && !obs.rrAvailable) {
      return snapshot();
    }
    if (lastLiveTs != null && obs.t <= lastLiveTs) return snapshot();
    if (lastLiveTs != null) handleGap(obs.t, (obs.t - lastLiveTs) / 1000);
    lastSampleTs = obs.t;
    lastLiveTs = obs.t;
    lastReceivedTs = obs.receivedTs ?? obs.t;
    lastMono = typeof performance !== 'undefined' ? performance.now() : null;
    if (obs.bpm != null) lastBpm = obs.bpm;
    ring.push(obs);
    trimRing(obs.t);
    stepLive(obs);
    return snapshot();
  }

  function ingestHistorical(sample) {
    const obs = normalizeObservation({ ...sample, origin: sample.origin || 'historical', historical: true });
    if (!obs) return snapshot();
    histRing.push(obs);
    if (histRing.length > config.histRingMaxN) histRing.shift();
    return snapshot();
  }

  function snapshot() {
    const p = phys();
    const ts = lastSampleTs ?? now();
    const phase = apiState(state);
    const snap = {
      state: phase,
      detectorState: phase,
      internalState: state,
      confidenceTier: tierName(state),
      floor: p.floor,
      activeFloor: p.activeFloor,
      restingHr: p.restingHr,
      maxHr: p.maxHr,
      lastBpm,
      lastSampleTs,
      physReady: p.physReady,
      confirmPath,
      confirmReason,
      sessionOwned,
      sport,
      activity,
      lane,
      modalityTier: lastFeat?.tier || null,
      evidenceScore,
      lastRejection: lastVeto,
      pulseCount: lastFeat?.sets.count || 0,
      algorithm: WORKOUT_DETECT_V2_ALGORITHM,
      version: WORKOUT_DETECT_V2_VERSION,
      feature_schema_version: FEATURE_SCHEMA_VERSION,
      traceId,
      workoutId,
      scores: lastBout ? {
        bout_label: lastBout.label,
        bout_score: evidenceScore,
        activity,
        reason: lastBout.reasons?.[0] || lastVeto,
        modality_tier: lastFeat?.tier,
        lane,
      } : null,
      coverage: lastFeat?.coverage || null,
      quality: lastFeat?.quality || null,
      cpuMs: lastCpuMs,
      ringN: ring.length,
      counters: { ...counters },
      detectedStartTs,
      confirmedTs,
      effectiveStartTs,
      effectiveEndTs,
      elapsedDurationS: detectedStartTs != null
        ? Math.max(0, Math.round((ts - (effectiveStartTs ?? detectedStartTs)) / 1000)) : 0,
      observedDurationS: boutAcc ? Math.round(boutAcc.weightS) : 0,
      unknownGapS: boutAcc ? Math.round(boutAcc.unknownGapS || 0) : 0,
      gaps: boutAcc?.gaps ? boutAcc.gaps.slice() : [],
    };
    if (detectedStartTs != null) {
      snap.onsetTs = confirmed ? (effectiveStartTs ?? detectedStartTs) : detectedStartTs;
      snap.activeS = Math.max(0, Math.round((ts - (effectiveStartTs ?? detectedStartTs)) / 1000));
      snap.elevatedS = snap.activeS;
    }
    if (confirmed && boutAcc) {
      snap.activeWorkout = {
        onsetTs: effectiveStartTs ?? detectedStartTs,
        detectedStartTs,
        confirmedTs,
        effectiveStartTs,
        durationS: Math.max(0, Math.round((ts - (effectiveStartTs ?? detectedStartTs)) / 1000)),
        elapsedDurationS: Math.max(0, Math.round((ts - (effectiveStartTs ?? detectedStartTs)) / 1000)),
        observedDurationS: Math.round(boutAcc.weightS),
        unknownGapS: Math.round(boutAcc.unknownGapS || 0),
        gaps: boutAcc.gaps ? boutAcc.gaps.slice() : [],
        avgHr: boutAcc.weightS > 0 ? Math.round(boutAcc.hrTimeWt / boutAcc.weightS) : null,
        peakHr: boutAcc.peakBpm,
        zone: hrZone(lastBpm || 0, p.maxHr),
        sport,
        activity,
      };
    }
    return snap;
  }

  function dismiss(reason = 'user') {
    const ts = now();
    const was = state === 'CONFIRMED' || state === 'ENDING' || state === 'SUSPENDED_UNKNOWN';
    resetBout();
    cooldownUntilTs = ts + config.dismissCooldownS * 1000;
    rearmBelow = true;
    counters.dismissals += 1;
    setState('IDLE', ts, 'dismissed');
    if (was) emit({ type: 'workout_discarded', reason, ts });
    return snapshot();
  }

  function reset() {
    resetBout();
    ring = [];
    histRing = [];
    lastSampleTs = null;
    lastLiveTs = null;
    lastReceivedTs = null;
    lastMono = null;
    cooldownUntilTs = 0;
    rearmBelow = false;
    setState('IDLE', now(), 'reset');
  }

  function tick(at) {
    if (lastLiveTs == null) return snapshot();
    if (at == null) {
      if (lastMono == null) return snapshot();
      const gapS = (performance.now() - lastMono) / 1000;
      handleGap(lastLiveTs + gapS * 1000, gapS);
      return snapshot();
    }
    handleGap(at, (at - lastLiveTs) / 1000);
    return snapshot();
  }

  function exportCheckpoint() {
    return {
      v: WORKOUT_DETECT_V2_VERSION,
      feature_schema_version: FEATURE_SCHEMA_VERSION,
      state,
      lastSampleTs,
      lastLiveTs,
      lastReceivedTs,
      detectedStartTs,
      confirmedTs,
      effectiveStartTs,
      effectiveEndTs,
      firstCoherentTs,
      lastExerciseTs,
      belowSinceTs,
      endStartTs,
      lastSupportedTs,
      confirmPath,
      confirmReason,
      sport,
      activity,
      lane,
      cooldownUntilTs,
      rearmBelow,
      sessionOwned,
      confirmed,
      workoutId,
      lastBpm,
      traceId,
      counters,
      boutAcc,
      lastFeat,
      lastBout,
      strengthEvidence,
      evidenceScore,
      ring: ring.map((p) => ({ ...p })),
      histRing: histRing.map((p) => ({ ...p })),
      windows: windows.slice(-40),
      transitions: transitions.slice(-40),
      lastFinished,
    };
  }

  function restore(cp) {
    if (!cp || typeof cp !== 'object') return snapshot();
    const mapped = cp.state === 'CANDIDATE' ? 'POSSIBLE'
      : cp.state === 'PROVISIONAL' ? 'LIKELY'
        : cp.state;
    state = mapped || 'IDLE';
    lastSampleTs = cp.lastSampleTs ?? null;
    lastLiveTs = cp.lastLiveTs ?? cp.lastSampleTs ?? null;
    lastReceivedTs = cp.lastReceivedTs ?? lastLiveTs;
    lastMono = null;
    detectedStartTs = cp.detectedStartTs ?? cp.onsetTs ?? null;
    confirmedTs = cp.confirmedTs ?? null;
    effectiveStartTs = cp.effectiveStartTs ?? (cp.confirmed ? cp.onsetTs : null) ?? null;
    effectiveEndTs = cp.effectiveEndTs ?? null;
    firstCoherentTs = Object.hasOwn(cp, 'firstCoherentTs') ? (cp.firstCoherentTs ?? null) : detectedStartTs;
    lastExerciseTs = cp.lastExerciseTs ?? null;
    belowSinceTs = cp.belowSinceTs ?? null;
    endStartTs = cp.endStartTs ?? null;
    lastSupportedTs = cp.lastSupportedTs ?? lastExerciseTs;
    confirmPath = cp.confirmPath ?? null;
    confirmReason = cp.confirmReason ?? null;
    sport = cp.sport || 'detected';
    activity = cp.activity || 'unknown';
    lane = cp.lane || 'unknown';
    cooldownUntilTs = Number(cp.cooldownUntilTs) || 0;
    rearmBelow = Boolean(cp.rearmBelow);
    sessionOwned = Boolean(cp.sessionOwned) || Boolean(cp.confirmed);
    confirmed = Boolean(cp.confirmed);
    workoutId = cp.workoutId ?? null;
    lastBpm = cp.lastBpm ?? null;
    traceId = cp.traceId ?? null;
    counters = { ...emptyCounters(), ...(cp.counters || {}) };
    boutAcc = cp.boutAcc || cp.bout
      ? {
        ...(cp.boutAcc || cp.bout),
        zoneS: [...((cp.boutAcc || cp.bout).zoneS || [0, 0, 0, 0, 0])],
        sportS: { ...((cp.boutAcc || cp.bout).sportS || {}) },
        gaps: [...((cp.boutAcc || cp.bout).gaps || [])].map((g) => ({ ...g })),
      }
      : null;
    lastFeat = cp.lastFeat || null;
    lastBout = cp.lastBout || null;
    strengthEvidence = Boolean(cp.strengthEvidence);
    evidenceScore = cp.evidenceScore ?? null;
    ring = Array.isArray(cp.ring) ? cp.ring.map((p) => ({ ...p })) : [];
    histRing = Array.isArray(cp.histRing) ? cp.histRing.map((p) => ({ ...p })) : [];
    windows = Array.isArray(cp.windows) ? cp.windows : [];
    transitions = Array.isArray(cp.transitions) ? cp.transitions : [];
    lastFinished = cp.lastFinished || null;
    return snapshot();
  }

  function reconcile(workout = lastFinished, nowMs = now()) {
    const target = workout || lastFinished;
    if (!target) return { changed: false, reason: 'no_workout' };
    const observations = [...histRing, ...ring];
    const result = reconcileWorkoutV2({
      workout: { ...target, id: target.id || target.workoutId || workoutId },
      observations,
      detectorVersion: WORKOUT_DETECT_V2_VERSION,
      nowMs,
      config,
    });
    if (result.reason === 'user_edited') counters.reconcile_skipped_user_edit += 1;
    if (result.changed) {
      counters.reconcile_applied += 1;
      lastFinished = { ...result.workout, userModified: false };
      emit({ type: 'workout_reconciled', workout: result.workout, event: result.event, ts: nowMs });
    }
    return result;
  }

  return {
    ingest,
    ingestHistorical,
    snapshot,
    dismiss,
    reset,
    tick,
    restore,
    exportCheckpoint,
    reconcile,
    historicalObservations: () => histRing.slice(),
    lastFinished: () => lastFinished,
    config,
    traces: () => ({ windows: windows.slice(), transitions: transitions.slice(), traceId }),
    featureExport: () => ({
      feature_schema_version: FEATURE_SCHEMA_VERSION,
      detector_version: WORKOUT_DETECT_V2_VERSION,
      traceId,
      windows: windows.slice(),
      transitions: transitions.slice(),
      predicted_activity: activity,
      session_boundaries: detectedStartTs != null
        ? { onsetTs: effectiveStartTs ?? detectedStartTs, detectedStartTs, confirmedTs, effectiveStartTs, state, confirmed }
        : null,
      featureVector: featureObj,
    }),
    sportDisplayName,
  };
}

export { v1SportDisplayName };

export function parityRecord(snap) {
  return {
    detectorState: snap.detectorState ?? null,
    internalState: snap.internalState ?? null,
    lane: snap.lane ?? null,
    sport: snap.sport ?? null,
    activity: snap.activity ?? null,
    modalityTier: snap.modalityTier ?? snap.coverage?.modalityTier ?? null,
    confirmPath: snap.confirmPath ?? null,
    evidenceScore: snap.evidenceScore ?? null,
    effectiveStartTs: snap.effectiveStartTs ?? snap.onsetTs ?? null,
    detectedStartTs: snap.detectedStartTs ?? null,
    confirmedTs: snap.confirmedTs ?? null,
    rejection: snap.lastRejection ?? null,
    version: snap.version ?? WORKOUT_DETECT_V2_VERSION,
  };
}

export function replayParity(samples, { restingHr = 60, maxHr = 174, every = 30 } = {}) {
  const det = createWorkoutDetectorV2({ thresholds: () => ({ restingHr, maxHr }) });
  const out = [];
  let i = 0;
  let lastState = 'IDLE';
  for (const s of samples) {
    const snap = det.ingest(s);
    if (snap.internalState !== lastState || i % every === 0) {
      out.push({ i, ts: s.ts ?? s.t, ...parityRecord(snap) });
      lastState = snap.internalState;
    }
    i += 1;
  }
  return out;
}

export function compareNativeBackend(nativeSnap, backendSnap) {
  const n = nativeSnap || {};
  const b = backendSnap || {};
  const keys = ['detectorState', 'sport', 'activity', 'lane', 'modalityTier'];
  const fields = {};
  let disagree = false;
  for (const k of keys) {
    const nv = n[k] ?? n.coverage?.modalityTier ?? null;
    const bv = b[k] ?? b.coverage?.modalityTier ?? null;
    const same = String(nv ?? '') === String(bv ?? '');
    fields[k] = { native: nv, backend: bv, agree: same };
    if (!same && nv != null && bv != null) disagree = true;
  }
  const nOn = n.effectiveStartTs ?? n.onsetTs ?? null;
  const bOn = b.effectiveStartTs ?? b.onsetTs ?? null;
  const onsetDeltaS = nOn != null && bOn != null ? Math.round((nOn - bOn) / 1000) : null;
  if (onsetDeltaS != null && Math.abs(onsetDeltaS) > 15) disagree = true;
  const nState = n.detectorState ?? null;
  const bState = b.detectorState ?? null;
  if (nState && bState && nState !== bState) disagree = true;
  return {
    disagree,
    fields,
    onsetDeltaS,
    nativeTs: n.lastSampleTs ?? null,
    backendTs: b.lastSampleTs ?? null,
    latencyS: n.lastSampleTs != null && b.lastSampleTs != null
      ? Math.round((b.lastSampleTs - n.lastSampleTs) / 1000)
      : null,
  };
}

/** Adapter for older tests that built {t,bpm,phone,strap} rings. */
export function extractWindow(ring, ts, config = V2_DEFAULTS) {
  const obs = (ring || []).map((p) => {
    if (p.origin || p.strapMotion != null || p.phoneMotion != null) return p.t != null ? p : normalizeObservation(p);
    return {
      t: p.t,
      ts: p.t,
      bpm: p.bpm ?? null,
      strapMotion: p.historical ? null : (p.strap ?? null),
      phoneMotion: p.phone ?? null,
      origin: p.historical ? 'historical' : 'live',
      historical: Boolean(p.historical),
      cadence: p.cadence ?? null,
      rrAvailable: (p.rr || []).length > 0,
      rrMs: p.rr || [],
      histDynAccel: p.historical ? (p.strap ?? p.unspecified ?? null) : null,
      gyroRms: p.gyroRms ?? null,
      phoneLive: Boolean(p.phoneLive),
      wear: p.wear ?? null,
      charging: false,
      offWrist: false,
      sleep: false,
      stepsDelta: p.steps ?? null,
      src: p.src || null,
    };
  }).filter(Boolean);
  return extractFeatures(obs, ts, {}, config);
}

export function detectBout(feat, phys, config = V2_DEFAULTS) {
  return detectExercise(feat, phys, config);
}

export function classifyActivity(feat, phys, config = V2_DEFAULTS) {
  const bout = detectExercise(feat, phys, config);
  const cls = classifySport(feat, bout.lane, config);
  return {
    activity: cls.activity,
    reason: cls.reason,
    tier: feat.tier,
    class_confidence: 'low',
  };
}

export function scoreWindow(feat, phys, config = V2_DEFAULTS) {
  const bout = detectExercise(feat, phys, config);
  const cls = classifySport(feat, bout.lane, config);
  return {
    bout_label: bout.label,
    bout_score: bout.evidenceScore,
    strength_score: cls.sport === 'strength' ? 0.6 : 0,
    locomotion_score: cls.sport === 'walking' || cls.sport === 'running' ? 0.6 : 0,
    cardio_score: cls.activity === 'cardio' ? 0.6 : 0,
    workout_score: bout.evidenceScore,
    fused_score: bout.evidenceScore,
    activity: cls.activity,
    class_confidence: 'low',
    branch: cls.sport === 'walking' ? 'locomotion' : cls.sport === 'strength' ? 'strength' : cls.activity === 'cardio' ? 'cardio' : 'generic',
    reason: bout.reasons?.[0] || cls.reason,
    modality_tier: bout.tier,
    quality: bout.quality,
    lane: bout.lane,
  };
}
