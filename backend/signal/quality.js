/**
 * The shared signal-quality engine.
 *
 * Every derived metric in FRWHOOP is gated on this. Quality is deliberately NOT
 * folded into the values it describes: an estimator needs to see "HR says 150
 * but I only trust it 0.2" rather than a silently attenuated HR, because those
 * two inputs lead to different decisions.
 *
 * The HR / RR / motion scorers moved here from `energy/features.js` unchanged so
 * there is exactly one definition of "is this heart rate trustworthy" in the
 * codebase; `energy/features.js` re-exports them and its behaviour is
 * bit-identical. The temperature and PPG scorers are new and, per
 * `capability.js`, have no production input yet — they exist so the engines that
 * need them are one decoder away rather than one decoder plus an analytics
 * layer, and they are exercised against synthetic waveforms in the tests.
 */

import {
  EXPECTED_SAMPLES_PER_MINUTE,
  HR_STALENESS,
  LIMITS,
  clamp,
  num,
} from './constants.js';
import { goertzelPower } from './spectrum.js';

const MINUTE_MS = 60_000;

export function median(values) {
  const list = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = list.length >> 1;
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

export function stddev(values, mean) {
  const list = (values || []).filter(Number.isFinite);
  if (list.length < 2) return 0;
  const m = mean ?? list.reduce((a, b) => a + b, 0) / list.length;
  let acc = 0;
  for (const v of list) acc += (v - m) ** 2;
  return Math.sqrt(acc / (list.length - 1));
}

/** Floor a timestamp to its containing UTC minute. */
export function minuteFloor(ts) {
  const ms = ts instanceof Date ? ts.getTime() : Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * RR-interval statistics with artifact rejection.
 *
 * Successive intervals differing by more than 20% are ectopic or motion
 * artefacts; they are excluded from RMSSD/SDNN and counted so the caller can see
 * how much of the window was rejected.
 */
function rrValue(x) {
  if (x != null && typeof x === 'object') return num(x.rrMs ?? x.rr_ms);
  return num(x);
}

function rrEpoch(x) {
  if (x != null && typeof x === 'object') {
    const e = x.epoch ?? x.connection_epoch;
    return e == null ? null : e;
  }
  return null;
}

export function rrStats(intervals) {
  const clean = [];
  // Positions in the input that survived, so a caller holding timestamps
  // alongside the intervals can re-pair them exactly. Matching cleaned VALUES
  // back to their source rows would mis-pair whenever two beats share a length,
  // which at 1 ms quantisation is common.
  const keptIndices = [];
  let rejected = 0;
  let prev = null;
  let prevEpoch = null;
  const list = intervals || [];
  for (let i = 0; i < list.length; i += 1) {
    const v = rrValue(list[i]);
    const epoch = rrEpoch(list[i]);
    if (prevEpoch != null && epoch != null && epoch !== prevEpoch) prev = null;
    if (epoch != null) prevEpoch = epoch;
    if (v == null || v < LIMITS.rrMinMs || v > LIMITS.rrMaxMs) { rejected += 1; continue; }
    if (prev != null && Math.abs(v - prev) > 0.2 * prev) { rejected += 1; prev = v; continue; }
    clean.push(v);
    keptIndices.push(i);
    prev = v;
  }
  const total = clean.length + rejected;
  if (clean.length < 2) {
    return {
      count: clean.length,
      rejected,
      artifactFraction: total ? rejected / total : 1,
      rmssd: null,
      sdnn: null,
      meanRr: clean[0] ?? null,
      clean,
      keptIndices,
    };
  }
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  let sqDiffs = 0;
  for (let i = 1; i < clean.length; i += 1) sqDiffs += (clean[i] - clean[i - 1]) ** 2;
  return {
    count: clean.length,
    rejected,
    artifactFraction: total ? rejected / total : 0,
    rmssd: Math.sqrt(sqDiffs / (clean.length - 1)),
    sdnn: stddev(clean, mean),
    meanRr: mean,
    clean,
    keptIndices,
  };
}

/**
 * Per-channel signal quality in [0,1] for the HR / RR / motion channels.
 *
 * Nothing here ever substitutes a value; it only reports how much a consumer
 * should lean on each channel. A channel with quality 0 is treated as absent.
 */
export function scoreQuality(f) {
  const flags = [];

  let hr = 0;
  if (f.hrCount > 0) {
    hr = 0.35 + 0.65 * f.hrCoverage;
    if (f.implausibleJumps > 0) {
      hr *= clamp(1 - 0.25 * f.implausibleJumps, 0.2, 1);
      flags.push('hr_jumps');
    }
    // Wide spread inside a single minute means the sensor is fighting motion,
    // not that the heart did something interesting.
    if (f.hrStd != null && f.hrStd > 18) { hr *= 0.7; flags.push('hr_unstable'); }
    if (f.reportedQuality != null && f.reportedQuality < 0.6) {
      hr *= clamp(f.reportedQuality + 0.3, 0.2, 1);
      flags.push('device_low_quality');
    }
    if (f.lastSampleAgeSeconds != null && f.lastSampleAgeSeconds > HR_STALENESS.carrySeconds) {
      hr *= 0.5;
      flags.push('hr_stale');
    }
  } else {
    flags.push('hr_absent');
  }

  let rr = 0;
  if (f.rrCount >= 4) {
    rr = clamp(1 - f.rrArtifactFraction, 0, 1) * clamp(f.rrCount / 20, 0.3, 1);
    if (f.rrArtifactFraction > 0.4) flags.push('rr_artefacts');
  } else if (f.rrCount > 0) {
    rr = 0.15;
    flags.push('rr_sparse');
  }

  let motion = 0;
  if (f.motionCount > 0) {
    motion = 0.4 + 0.6 * f.motionCoverage;
  } else {
    flags.push('motion_absent');
  }

  if (f.maxGapSeconds > 30) flags.push('sample_gap');
  if (f.disconnectedSamples > 0) flags.push('disconnected');

  const coverage = Math.max(f.hrCoverage, f.motionCoverage);
  // Overall is dominated by whichever channel is usable; a minute with perfect
  // motion and no HR is still a usable minute, just a differently-shaped one.
  const overall = clamp(
    0.55 * Math.max(hr, motion * 0.85) + 0.25 * coverage + 0.2 * Math.max(hr, rr, motion),
    0,
    1,
  );

  return {
    hr: Math.round(clamp(hr, 0, 1) * 100) / 100,
    rr: Math.round(clamp(rr, 0, 1) * 100) / 100,
    motion: Math.round(clamp(motion, 0, 1) * 100) / 100,
    coverage: Math.round(coverage * 100) / 100,
    overall: Math.round(overall * 100) / 100,
    flags,
  };
}

/**
 * Group samples into minute buckets. Out-of-order and duplicate input is fine:
 * bucketing is a pure function of each sample's own timestamp.
 */
export function bucketSamplesByMinute(samples) {
  const byMinute = new Map();
  for (const s of samples || []) {
    const ts = Date.parse(s.t ?? s.datetime ?? s.at ?? '');
    if (!Number.isFinite(ts)) continue;
    const minute = Math.floor(ts / MINUTE_MS) * MINUTE_MS;
    const bucket = byMinute.get(minute);
    const withTs = { ...s, ts };
    if (bucket) bucket.push(withTs);
    else byMinute.set(minute, [withTs]);
  }
  return byMinute;
}

// ---------------------------------------------------------------------------
// Temperature channel
// ---------------------------------------------------------------------------

/**
 * How long after the strap goes back on before its thermistor reading means
 * anything. A cold device against warm skin takes minutes to equilibrate, and
 * the rising limb is the device warming up, not the wearer.
 */
export const TEMP_STABILIZATION_MINUTES = 20;

/**
 * Fastest defensible worn skin-temperature change, C per minute.
 *
 * Peripheral vasodilation is fast but not instant. A step faster than this is a
 * contact change or an ADC artifact, so it is flagged rather than smoothed —
 * smoothing would turn a doff/don event into a plausible physiological swing.
 */
export const TEMP_MAX_SLEW_C_PER_MIN = 0.5;

/**
 * Score a temperature window.
 *
 * @param {object} w
 * @param {Array}  w.samples      [{ ts, tempC }] ascending, worn-gated by caller
 * @param {number} w.expected     samples expected in the window
 * @param {number} w.motion       mean motion magnitude over the window, or null
 * @param {boolean} w.charging    device charging during the window
 * @param {boolean} w.worn        device reported on-wrist
 * @param {number} w.minutesSinceDon minutes since the strap went on, or null
 */
export function scoreTemperatureQuality({
  samples = [],
  expected = null,
  motion = null,
  charging = false,
  worn = true,
  minutesSinceDon = null,
} = {}) {
  const flags = [];
  const rows = (samples || [])
    .map((s) => ({ ts: num(s.ts) ?? Date.parse(s.t ?? s.datetime ?? ''), tempC: num(s.tempC ?? s.temp_c ?? s.value) }))
    .filter((s) => Number.isFinite(s.ts) && s.tempC != null)
    .sort((a, b) => a.ts - b.ts);

  if (!rows.length) {
    return { temperature: 0, coverage: 0, overall: 0, flags: ['temp_absent'], usableSamples: 0 };
  }

  // Charging heats the device directly. Nothing measured then is skin.
  if (charging) flags.push('charging');
  if (!worn) flags.push('not_worn');

  const inBand = rows.filter((r) => r.tempC >= LIMITS.skinTempCMin && r.tempC <= LIMITS.skinTempCMax);
  const outOfBand = rows.length - inBand.length;
  if (outOfBand > 0) flags.push('temp_out_of_band');

  let slewViolations = 0;
  for (let i = 1; i < inBand.length; i += 1) {
    const dtMin = (inBand[i].ts - inBand[i - 1].ts) / MINUTE_MS;
    if (dtMin <= 0) continue;
    const rate = Math.abs(inBand[i].tempC - inBand[i - 1].tempC) / dtMin;
    if (rate > TEMP_MAX_SLEW_C_PER_MIN) slewViolations += 1;
  }
  if (slewViolations > 0) flags.push('temp_implausible_slew');

  // A thermistor that never moves at all is stuck, not stable: real worn skin
  // temperature always carries some jitter.
  const spread = inBand.length > 2 ? stddev(inBand.map((r) => r.tempC)) : null;
  if (spread != null && spread === 0) flags.push('temp_flatline');

  const coverage = expected ? clamp(inBand.length / expected, 0, 1) : (inBand.length ? 1 : 0);

  let q = inBand.length ? 0.4 + 0.6 * coverage : 0;
  if (charging || !worn) q = 0;
  if (outOfBand > 0) q *= clamp(inBand.length / rows.length, 0, 1);
  if (slewViolations > 0) q *= clamp(1 - 0.2 * slewViolations, 0.1, 1);
  if (spread === 0) q *= 0.3;

  // Motion contaminates contact temperature by pumping air across the sensor and
  // changing the skin-device gap, not by changing skin temperature itself.
  const mot = num(motion);
  if (mot != null && mot > 0.15) { q *= 0.6; flags.push('temp_motion_contaminated'); }

  if (minutesSinceDon != null && minutesSinceDon < TEMP_STABILIZATION_MINUTES) {
    q *= clamp(minutesSinceDon / TEMP_STABILIZATION_MINUTES, 0.05, 1);
    flags.push('temp_stabilizing');
  }

  return {
    temperature: Math.round(clamp(q, 0, 1) * 100) / 100,
    coverage: Math.round(coverage * 100) / 100,
    overall: Math.round(clamp(q, 0, 1) * 100) / 100,
    flags,
    usableSamples: inBand.length,
    slewViolations,
    outOfBand,
  };
}

// ---------------------------------------------------------------------------
// PPG channel
// ---------------------------------------------------------------------------

/** Cardiac band, Hz — 42 to 210 bpm. */
export const PULSE_BAND_HZ = Object.freeze({ min: 0.7, max: 3.5 });

/** Reference sweep for the spectral concentration ratio. */
export const SPECTRAL_SWEEP_MIN_HZ = 0.1;
export const SPECTRAL_SWEEP_MAX_HZ = 12;
export const SPECTRAL_SWEEP_STEP_HZ = 0.1;

/**
 * Concentration below which a window is not called pulsatile.
 *
 * 1.0 is exactly what white noise scores, so 1.5 asks for the cardiac band to
 * hold half again as much power as noise would put there.
 */
export const MIN_PULSE_CONCENTRATION = 1.5;

/** Concentration at which pulsatility saturates: a clean single-tone pulse. */
export const PULSE_CONCENTRATION_FULL = 4;

/**
 * Score a raw PPG window.
 *
 * NOT EXERCISED IN PRODUCTION: no PPG reaches the backend today (see
 * `capability.js` — `ppg_waveform` is `reachable`, gated on enabling
 * REALTIME_RAW type 43). This exists so the respiratory and embedding engines
 * have a real gate the day that decoder lands, and it is tested against
 * synthetic clean / clipped / flatlined / noisy waveforms.
 *
 * `samples` are raw AC-coupled ADC counts. `adcRange` is the full-scale count
 * magnitude used to detect clipping; for the WHOOP signed-24-bit channel that
 * is 2^23.
 *
 * ponytail: spectral checks use a plain Goertzel sweep over the pulse band
 * rather than a full FFT. O(bands x n) is fine for a 437 Hz window of a few
 * seconds; swap in an FFT if windows grow past ~10 s.
 */
export function scorePpgQuality({
  samples = [],
  rateHz = null,
  adcRange = 2 ** 23,
  expected = null,
  motion = null,
} = {}) {
  const flags = [];
  const xs = (samples || []).map(num).filter((n) => n != null);

  if (xs.length < 8) {
    return { ppg: 0, coverage: 0, overall: 0, flags: ['ppg_absent'], usableSamples: xs.length };
  }

  const coverage = expected ? clamp(xs.length / expected, 0, 1) : 1;
  if (coverage < 0.9) flags.push('ppg_missing_samples');

  // Clipping / saturation: samples pinned at the converter rail carry no
  // morphology, and a clipped pulse still looks like a pulse to a peak finder.
  const rail = adcRange * 0.995;
  const clipped = xs.filter((v) => Math.abs(v) >= rail).length;
  const clipFraction = clipped / xs.length;
  if (clipFraction > 0.001) flags.push('ppg_clipping');

  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = stddev(xs, mean);
  const range = Math.max(...xs) - Math.min(...xs);

  // Flatline: a dead or fully-occluded sensor. Distinguished from "quiet" by
  // being flat relative to its own scale, so it holds at any gain setting.
  const flat = sd === 0 || range <= Math.abs(mean) * 1e-6 || range === 0;
  if (flat) flags.push('ppg_flatline');

  let pulsatility = 0;
  let concentration = null;
  if (rateHz && rateHz > PULSE_BAND_HZ.max * 2 && !flat) {
    // How much MORE power sits in the cardiac band than a flat (noise) spectrum
    // would put there. A raw band fraction cannot answer this: white noise
    // already puts ~24% of a 0.1-12 Hz sweep inside 0.7-3.5 Hz purely because
    // that is how wide the band is. Dividing by the flat-spectrum expectation
    // makes 1.0 mean "indistinguishable from noise" at any sweep width.
    const sweepMax = Math.min(SPECTRAL_SWEEP_MAX_HZ, rateHz * 0.45);
    let bandPower = 0;
    let totalPower = 0;
    for (let f = SPECTRAL_SWEEP_MIN_HZ; f <= sweepMax; f += SPECTRAL_SWEEP_STEP_HZ) {
      const p = goertzelPower(xs, f, rateHz, mean);
      totalPower += p;
      if (f >= PULSE_BAND_HZ.min && f <= PULSE_BAND_HZ.max) bandPower += p;
    }
    const bandFraction = totalPower > 0 ? bandPower / totalPower : 0;
    const flatFraction = (PULSE_BAND_HZ.max - PULSE_BAND_HZ.min)
      / Math.max(sweepMax - SPECTRAL_SWEEP_MIN_HZ, 1e-9);
    concentration = flatFraction > 0 ? bandFraction / flatFraction : 0;
    pulsatility = clamp(concentration / PULSE_CONCENTRATION_FULL, 0, 1);
    if (concentration < MIN_PULSE_CONCENTRATION) flags.push('ppg_no_pulse_band');
  }

  let q = flat ? 0 : 0.35 + 0.65 * coverage;
  if (clipFraction > 0) q *= clamp(1 - 4 * clipFraction, 0.1, 1);
  if (concentration != null) q *= clamp(0.15 + 0.85 * pulsatility, 0.1, 1);

  const mot = num(motion);
  if (mot != null && mot > 0.15) {
    // Motion in the pulse band is indistinguishable from a pulse by amplitude
    // alone, so motion must reduce trust even when the waveform looks good.
    q *= clamp(1 - (mot - 0.15), 0.15, 1);
    flags.push('ppg_motion_contaminated');
  }

  return {
    ppg: Math.round(clamp(q, 0, 1) * 100) / 100,
    coverage: Math.round(coverage * 100) / 100,
    overall: Math.round(clamp(q, 0, 1) * 100) / 100,
    flags,
    usableSamples: xs.length,
    clipFraction: Math.round(clipFraction * 1e4) / 1e4,
    pulsatility: Math.round(pulsatility * 1000) / 1000,
  };
}

export { EXPECTED_SAMPLES_PER_MINUTE, HR_STALENESS, LIMITS, clamp, num };
