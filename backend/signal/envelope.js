/**
 * The metric envelope: the only shape a derived metric may be returned in.
 *
 * A bare number is not a measurement. Two temperature deviations of +0.4 C, one
 * from eight hours of clean contact and one from four minutes of a half-worn
 * strap, are not the same fact, and any pipeline that returns both as `0.4`
 * has thrown away the part that decides whether to act on it.
 *
 * So every engine returns:
 *
 *   value              the number, or null
 *   unit               unit of `value`
 *   confidence         [0,1] trust in THIS value given its inputs
 *   dataQuality        [0,1] quality of the input signal that produced it
 *   inputCoverage      [0,1] fraction of the expected window actually present
 *   algorithm          stable identifier, e.g. 'respiration_fusion'
 *   algorithmVersion   version of that algorithm
 *   sourceSignals      capability-map signal names the value derives from
 *   status             'ok' | 'low_confidence' | 'unavailable'
 *   reason             why, when not 'ok'
 *   timestamp          when computed
 *   startTime/endTime  the window the value describes
 *
 * `confidence` and `dataQuality` are separate on purpose. A fusion of four
 * estimators that disagree can have excellent input quality and poor
 * confidence; a single clean estimator can have the reverse.
 */

import { CONFIDENCE, clamp, num } from './constants.js';

export const STATUS = Object.freeze({
  OK: 'ok',
  LOW_CONFIDENCE: 'low_confidence',
  UNAVAILABLE: 'unavailable',
});

/**
 * Below this, a value is real but must not drive a user-facing claim. It is
 * still returned — hiding it would lose the evidence that the sensor was
 * struggling — but it is labelled so the API and UI can present it as such.
 */
export const LOW_CONFIDENCE_BELOW = 0.35;

function iso(v) {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Build an envelope for a computed value.
 *
 * Passing `value: null` produces an `unavailable` envelope even if a confidence
 * was supplied, because a confidence attached to no value is meaningless.
 */
export function metric({
  value,
  unit = null,
  confidence = null,
  dataQuality = null,
  inputCoverage = null,
  algorithm,
  algorithmVersion,
  sourceSignals = [],
  startTime = null,
  endTime = null,
  reason = null,
  detail = null,
  experimental = false,
  now = () => new Date(),
} = {}) {
  if (!algorithm || !algorithmVersion) {
    throw new Error('metric() requires algorithm and algorithmVersion');
  }
  const v = num(value);
  const conf = confidence == null ? null : clamp(num(confidence) ?? 0, CONFIDENCE.min, CONFIDENCE.max);

  let status = STATUS.OK;
  if (v == null) status = STATUS.UNAVAILABLE;
  else if (conf != null && conf < LOW_CONFIDENCE_BELOW) status = STATUS.LOW_CONFIDENCE;

  return {
    value: v,
    unit,
    confidence: v == null ? null : conf,
    dataQuality: dataQuality == null ? null : clamp(num(dataQuality) ?? 0, 0, 1),
    inputCoverage: inputCoverage == null ? null : clamp(num(inputCoverage) ?? 0, 0, 1),
    algorithm,
    algorithmVersion,
    sourceSignals: [...sourceSignals],
    status,
    reason: status === STATUS.OK ? null : (reason || defaultReason(status, conf)),
    detail,
    experimental: Boolean(experimental),
    startTime: iso(startTime),
    endTime: iso(endTime),
    timestamp: now().toISOString(),
  };
}

function defaultReason(status, conf) {
  if (status === STATUS.UNAVAILABLE) return 'no value could be computed from the available signals';
  if (status === STATUS.LOW_CONFIDENCE) return `confidence ${conf} below usable threshold ${LOW_CONFIDENCE_BELOW}`;
  return null;
}

/**
 * An explicitly unavailable metric.
 *
 * This is the honest output when inputs are missing, and it is why the engines
 * never emit a plausible-looking default. `missing` accepts the output of
 * `capability.missingSignals()` so the envelope carries the unlock path.
 */
export function unavailable({
  algorithm,
  algorithmVersion,
  unit = null,
  sourceSignals = [],
  reason,
  missing = [],
  startTime = null,
  endTime = null,
  experimental = false,
  now = () => new Date(),
} = {}) {
  const env = metric({
    value: null,
    unit,
    algorithm,
    algorithmVersion,
    sourceSignals,
    startTime,
    endTime,
    reason: reason || describeMissing(missing),
    experimental,
    now,
  });
  return missing.length ? { ...env, missingSignals: missing } : env;
}

function describeMissing(missing) {
  if (!missing?.length) return 'inputs unavailable';
  const names = missing.map((m) => `${m.signal} (${m.status})`).join(', ');
  return `required signals unavailable: ${names}`;
}

/**
 * Propagate confidence from inputs into a metric derived from them.
 *
 * Uses the WEAKEST input rather than the mean: a fusion is only as trustworthy
 * as its least trustworthy necessary input, and averaging lets one clean channel
 * launder three broken ones. `penalty` is the algorithm's own added uncertainty
 * (model error, extrapolation, immature baseline) as a multiplier <= 1.
 */
export function propagate(inputConfidences, { penalty = 1 } = {}) {
  const list = (inputConfidences || []).map(num).filter((n) => n != null);
  if (!list.length) return null;
  const weakest = Math.min(...list);
  return clamp(weakest * clamp(penalty, 0, 1), CONFIDENCE.min, CONFIDENCE.max);
}

/**
 * Confidence-weighted fusion of independent estimates of the same quantity.
 *
 * Weight is `confidence * quality`, so an estimator that is confident about a
 * garbage signal does not dominate. Agreement between estimators then modulates
 * the result: four estimators landing within a breath of each other is real
 * evidence, and four scattered across 10 brpm is not, even when each is
 * individually confident.
 *
 * `spreadTolerance` is the spread (in the metric's own unit) at which agreement
 * has fully decayed. Returns null when no estimate carries usable weight.
 */
export function fuse(estimates, { spreadTolerance = 1, minWeight = 1e-6 } = {}) {
  const usable = (estimates || [])
    .map((e) => ({
      ...e,
      value: num(e?.value),
      weight: clamp((num(e?.confidence) ?? 0) * (num(e?.quality) ?? 1), 0, 1),
    }))
    .filter((e) => e.value != null && e.weight > minWeight);

  if (!usable.length) return null;

  const total = usable.reduce((a, e) => a + e.weight, 0);
  const value = usable.reduce((a, e) => a + e.value * e.weight, 0) / total;

  // Weighted mean absolute deviation from the fused value, in the metric's unit.
  const spread = usable.reduce((a, e) => a + e.weight * Math.abs(e.value - value), 0) / total;
  const agreement = usable.length > 1
    ? clamp(1 - spread / Math.max(spreadTolerance, 1e-9), 0, 1)
    // A single estimator cannot corroborate itself. Not zero — it is still a
    // measurement — but it never earns the agreement bonus.
    : 0.5;

  const bestWeight = Math.max(...usable.map((e) => e.weight));
  const confidence = clamp(bestWeight * (0.6 + 0.4 * agreement), CONFIDENCE.min, CONFIDENCE.max);

  return {
    value,
    confidence,
    agreement,
    spread,
    contributors: usable.map((e) => ({
      estimator: e.estimator ?? null,
      value: e.value,
      confidence: e.confidence ?? null,
      quality: e.quality ?? null,
      weight: Math.round(e.weight * 1000) / 1000,
    })),
    usedCount: usable.length,
    offeredCount: (estimates || []).length,
  };
}
