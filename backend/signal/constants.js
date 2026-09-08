/**
 * Sensor-level constants shared by every analytics engine.
 *
 * These are facts about the SENSOR, not about any one model: what counts as a
 * physiologically possible heart rate, how many live posts a minute should
 * contain, how stale a reading may be before it stops meaning anything. They
 * lived in `energy/constants.js` while energy was the only consumer; they are
 * here now so temperature, respiration and autonomic load cannot drift to a
 * second set of plausibility gates. `energy/constants.js` re-exports them, so
 * existing energy call sites are unchanged.
 */

/**
 * Physiological plausibility gates. Values outside these are treated as ABSENT,
 * never clamped into range — a clamped implausible reading is a fabricated
 * measurement that looks like a real one.
 */
export const LIMITS = Object.freeze({
  hrMin: 20,
  hrMax: 240,
  rrMinMs: 250,
  rrMaxMs: 3000,
  metMin: 0.7,
  metMax: 25,
  motionMax: 16,
  weightKgMin: 25,
  weightKgMax: 300,
  heightCmMin: 100,
  heightCmMax: 250,
  ageMin: 5,
  ageMax: 110,
  vo2MaxMin: 12,
  vo2MaxMax: 90,
  hrMaxMin: 120,
  hrMaxMax: 230,
  restingHrMin: 25,
  restingHrMax: 130,
  /**
   * Worn wrist skin temperature. Deliberately wider than the nocturnal band
   * (33-35 C) because daytime peripheral temperature legitimately swings with
   * ambient and vasomotor tone, and narrower than the raw register range so a
   * pegged or no-contact ADC value fails the gate instead of becoming a reading.
   */
  skinTempCMin: 20,
  skinTempCMax: 42,
  /** Breaths per minute. Below 4 or above 45 at the wrist is an artifact. */
  respRateMin: 4,
  respRateMax: 45,
});

/**
 * Sample cadence assumed by coverage accounting: one live post per ~4 s.
 *
 * Not the strap's internal rate. The iOS plugin throttles live posts to at least
 * 1.8 s apart and coalesces, so ~15 samples is a fully-covered minute as seen by
 * the backend. Using the strap's 1 Hz here would make every minute look 75%
 * missing.
 */
export const EXPECTED_SAMPLES_PER_MINUTE = 15;

/** How long a heart-rate reading may be carried forward before it is unusable. */
export const HR_STALENESS = Object.freeze({
  freshSeconds: 30,
  carrySeconds: 120,
  maxSeconds: 300,
});

/** Confidence floor/ceiling. Nothing is ever reported as certain. */
export const CONFIDENCE = Object.freeze({
  min: 0.05,
  max: 0.97,
});

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Finite-number coercion. Returns null rather than NaN or 0 for absent input. */
export function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Interpolate a piecewise-linear anchor table, flat outside the endpoints. */
export function interpolateAnchors(anchors, x) {
  if (!Array.isArray(anchors) || !anchors.length) return null;
  const v = num(x);
  if (v == null) return null;
  if (v <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (v >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i += 1) {
    const [x1, y1] = anchors[i];
    const [x0, y0] = anchors[i - 1];
    if (v <= x1) {
      const span = x1 - x0;
      return span <= 0 ? y1 : y0 + ((v - x0) / span) * (y1 - y0);
    }
  }
  return last[1];
}
