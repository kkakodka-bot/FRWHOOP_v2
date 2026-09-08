/**
 * Overnight physiology for one sleep session.
 *
 * The seam between the sleep scorer and the analytics engines. It exists because
 * of an ordering problem: HRV and respiratory rate must be measured INSIDE the
 * detected sleep window, but the recovery score needs them, and recovery is
 * computed while scoring that same session. Rather than run sleep detection
 * twice, `scoreSession` calls a provider built here.
 *
 * Before this existed, `extras.hrv` and `extras.resp` were read by the recovery
 * scorer and never populated by any live caller, so `daily_metrics.hrv_rmssd_ms`
 * and `resp_rate_bpm` were always null and recovery silently ran on its
 * sleep-performance term alone.
 */

import { overnightHrv, ALGORITHM_VERSION as HRV_VERSION } from '../hrv/engine.js';
import { nightlyRespiration } from '../respiration/engine.js';
import { ALGORITHM_VERSION as RESP_VERSION, RESP_CONDITIONS } from '../respiration/constants.js';
import { STATUS } from '../signal/envelope.js';

/**
 * Confidence below which a value is not fed to the recovery score.
 *
 * Recovery is a single number a user acts on, and it has no way to express "this
 * input was weak". A low-confidence HRV would move it silently, so the input is
 * withheld and recovery falls back to the terms it can trust. The envelope is
 * still returned and still persisted — the measurement is reported, it just does
 * not drive a score.
 */
export const MIN_RECOVERY_INPUT_CONFIDENCE = 0.4;

/**
 * Measure HRV and respiratory rate across one sleep window.
 *
 * Returns the envelopes plus the plain numbers the sleep scorer consumes. Both
 * engines return `null` values with a reason rather than throwing, so a night
 * with unusable RR data yields a scored sleep session with no HRV rather than no
 * session.
 */
export function overnightPhysiology({
  samples = [],
  startTime = null,
  endTime = null,
  baselines = null,
  now = () => new Date(),
} = {}) {
  const hrv = overnightHrv({ samples, startTime, endTime, now });
  const resp = nightlyRespiration({
    samples,
    condition: RESP_CONDITIONS.SLEEP,
    startTime,
    endTime,
    now,
  });

  const usable = (env) => env.value != null
    && (env.confidence ?? 0) >= MIN_RECOVERY_INPUT_CONFIDENCE;

  const hrvBaseline = baselines?.summary
    ? baselines.summary('hrv_rmssd', { condition: 'sleep' })
    : null;
  const respBaseline = baselines?.summary
    ? baselines.summary('resp_rate', { condition: 'sleep' })
    : null;

  return {
    envelopes: { hrv, resp },
    // What scoreSession reads for recovery. Null here means "do not use", which the recovery
    // scorer already handles by dropping the term.
    hrv: usable(hrv) ? hrv.value : null,
    resp: usable(resp) ? resp.value : null,
    // Measured resp for display/persistence even when below recovery confidence.
    respMeasured: resp?.value ?? null,
    hrvBaseline: hrvBaseline?.value ?? null,
    respBaseline: respBaseline?.value ?? null,
    withheld: {
      hrv: hrv.value != null && !usable(hrv) ? hrv.confidence : null,
      resp: resp.value != null && !usable(resp) ? resp.confidence : null,
    },
    versions: { hrv: HRV_VERSION, respiration: RESP_VERSION },
  };
}

/**
 * Build the provider `scoreSession` calls, capturing everything it needs.
 *
 * Memoized per window so a session scored once does not measure twice, and so
 * the engine can read the envelopes back out after scoring without recomputing.
 */
export function createOvernightProvider({ baselines = null, now = () => new Date() } = {}) {
  const results = new Map();

  const provider = ({ samples = [], start, end } = {}) => {
    const key = `${start}:${end}`;
    if (!results.has(key)) {
      results.set(key, overnightPhysiology({
        samples,
        startTime: Number.isFinite(start) ? new Date(start).toISOString() : null,
        endTime: Number.isFinite(end) ? new Date(end).toISOString() : null,
        baselines,
        now,
      }));
    }
    return results.get(key);
  };

  /** Envelopes for every window measured, for persistence and the API. */
  provider.results = () => [...results.entries()].map(([key, value]) => ({ window: key, ...value }));

  /**
   * The main (longest) window's envelopes, which are the ones that become the
   * day's HRV and respiratory rate.
   */
  provider.main = () => {
    const all = provider.results();
    if (!all.length) return null;
    return all.reduce((best, r) => {
      const [s, e] = r.window.split(':').map(Number);
      const span = e - s;
      return !best || span > best.span ? { ...r, span } : best;
    }, null);
  };

  provider.summary = () => {
    const main = provider.main();
    if (!main) return null;
    return {
      hrv: envelopeSummary(main.envelopes.hrv),
      respiration: envelopeSummary(main.envelopes.resp),
      withheld: main.withheld,
    };
  };

  return provider;
}

function envelopeSummary(env) {
  if (!env) return null;
  return {
    value: env.value,
    unit: env.unit,
    confidence: env.confidence,
    status: env.status,
    algorithm: env.algorithm,
    algorithm_version: env.algorithmVersion,
    data_quality: env.dataQuality,
    input_coverage: env.inputCoverage,
    reason: env.status === STATUS.OK ? null : env.reason,
    detail: env.detail ?? null,
  };
}
