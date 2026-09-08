/**
 * The personal baseline service.
 *
 * One implementation of "what is normal for this person, under these
 * conditions", shared by every metric. Written once because the alternative —
 * temperature, respiration, HR, HRV and strain each growing their own
 * baseline code — guarantees they disagree about maturity, about outlier
 * handling, and about what happens on day one.
 *
 * The central rule: NEVER compare a measurement against an all-day average.
 * An evening skin temperature is legitimately warmer than a 04:00 one, and a
 * respiratory rate while awake is legitimately higher than asleep. A baseline
 * that ignores this reports a circadian rhythm as a health anomaly every single
 * evening. So observations are bucketed by CONDITION, and a query is answered
 * from the bucket that matches the query's own condition, falling back to
 * progressively coarser buckets when the exact one is too thin.
 *
 * Cold start is handled by blending toward a population prior rather than by
 * refusing to answer or by pretending three days is a baseline. `maturity`
 * reports which regime a value came from, and `confidence` carries it, so the
 * UI can say "still learning" honestly instead of showing a confident number
 * built from two nights.
 */

import { CONFIDENCE, clamp, num } from '../signal/constants.js';
import {
  changePoint,
  cusum,
  ewma,
  iqr,
  mad,
  median,
  percentile,
  robustSigma,
  robustZ,
  theilSen,
  withoutOutliers,
} from './stats.js';

export const ALGORITHM_VERSION = '1.0.0';
export const BASELINE_ENGINE = 'personal_baseline';

const DAY_MS = 86_400_000;

/**
 * Maturity tiers, in distinct observation-days.
 *
 * These are NOT invented for this module. They are the thresholds the codebase
 * already uses for evidence-gated personalization, so a user does not cross
 * "personalized" for one metric and "still learning" for another on different
 * days:
 *
 *   3   the minimum at which a median and a MAD mean anything at all
 *   14  energy CALIBRATION.minTrainingDays — the existing floor for letting
 *       personal data influence a model
 *   28  vo2 methodology windows.featureDays — the existing definition of a full
 *       personal feature window
 *
 * `blend` is how much weight the personal estimate carries against the
 * population prior. It ramps rather than steps, so the displayed baseline does
 * not visibly jump on the morning a user crosses a threshold.
 */
export const MATURITY = Object.freeze({
  INSUFFICIENT: 'insufficient',
  LOW: 'low',
  MODERATE: 'moderate',
  PERSONALIZED: 'personalized',
});

export const MATURITY_THRESHOLDS = Object.freeze({
  minObservations: 3,
  moderateDays: 14,
  personalizedDays: 28,
});

export function maturityFor(observationDays) {
  const n = num(observationDays) ?? 0;
  const t = MATURITY_THRESHOLDS;
  if (n < t.minObservations) return MATURITY.INSUFFICIENT;
  if (n < t.moderateDays) return MATURITY.LOW;
  if (n < t.personalizedDays) return MATURITY.MODERATE;
  return MATURITY.PERSONALIZED;
}

/**
 * How many days of the user's own data the population prior is worth.
 *
 * A population prior for a physiological quantity is genuinely weak evidence
 * about an individual: it knows nothing about their fitness, autonomic tone or
 * medication. Treating it as worth about a week of their own nights is the
 * judgement call this number encodes, and it is the one knob that decides how
 * fast a new user's baseline becomes theirs.
 */
export const PRIOR_EQUIVALENT_DAYS = 7;

/**
 * Weight given to the personal estimate versus the population prior.
 *
 * Empirical-Bayes shrinkage, n/(n+K), rescaled to reach exactly 1 at the
 * personalized threshold. Two properties matter and a linear ramp has neither:
 *
 *   - It is smooth and monotone, with no step at the threshold. The displayed
 *     baseline never visibly jumps on the morning a user crosses a tier.
 *   - Evidence starts counting immediately. A ramp anchored at minObservations
 *     gives the third night literally zero weight, which contradicts this
 *     module's own claim that three observations are where a median starts to
 *     mean something.
 *
 * Above the threshold the personal value is used outright — a user with sixty
 * nights of data should not have a permanent 10% pull toward the population.
 */
export function personalWeight(observationDays) {
  const n = Math.max(num(observationDays) ?? 0, 0);
  const { personalizedDays } = MATURITY_THRESHOLDS;
  if (n >= personalizedDays) return 1;
  const k = PRIOR_EQUIVALENT_DAYS;
  const full = personalizedDays / (personalizedDays + k);
  return clamp((n / (n + k)) / full, 0, 1);
}

// ---------------------------------------------------------------------------
// Conditioning
// ---------------------------------------------------------------------------

/**
 * Time-of-day bands.
 *
 * Four bands, not 24 hourly buckets: a 30-day window holds ~30 observations, and
 * splitting those across 24 buckets leaves ~1 per bucket, which is no baseline at
 * all. Boundaries follow the circadian shape of peripheral temperature and
 * resting heart rate rather than the clock — the overnight band is the stable
 * one and is kept whole.
 */
export const TIME_BANDS = Object.freeze([
  { id: 'overnight', fromHour: 0, toHour: 6 },
  { id: 'morning', fromHour: 6, toHour: 12 },
  { id: 'afternoon', fromHour: 12, toHour: 18 },
  { id: 'evening', fromHour: 18, toHour: 24 },
]);

export function timeBand(localHour) {
  const h = num(localHour);
  if (h == null) return null;
  const band = TIME_BANDS.find((b) => h >= b.fromHour && h < b.toHour);
  return band ? band.id : null;
}

/** Coarse activity states. Deliberately few, for the same sample-count reason. */
export const ACTIVITY_STATE = Object.freeze({
  REST: 'rest',
  ACTIVE: 'active',
  EXERCISE: 'exercise',
});

/**
 * Build a condition key from a context.
 *
 * `sleep` is the strongest conditioner (asleep vs awake changes almost every
 * physiological quantity more than time of day does), so it is the outermost
 * term. During sleep the time band is dropped: the whole point of the sleeping
 * baseline is that it is the stable state, and banding it just thins the bucket.
 */
export function conditionKey({ asleep = null, localHour = null, activity = null } = {}) {
  if (asleep === true) return 'sleep';
  const parts = ['awake'];
  const band = timeBand(localHour);
  if (band) parts.push(band);
  if (activity && activity !== ACTIVITY_STATE.REST) parts.push(activity);
  return parts.join(':');
}

/**
 * Fallback chain from most to least specific.
 *
 * A query for `awake:evening:exercise` that has too few observations falls back
 * to `awake:evening`, then `awake`, then `all`. Each step is a real widening of
 * the reference population, so `matchedCondition` is reported and the confidence
 * is reduced — an answer from `all` is a weaker claim than one from the exact
 * condition, and must not look identical.
 */
export function conditionChain(key) {
  if (!key) return ['all'];
  if (key === 'sleep') return ['sleep', 'all'];
  const parts = key.split(':');
  const chain = [];
  for (let i = parts.length; i >= 1; i -= 1) chain.push(parts.slice(0, i).join(':'));
  chain.push('all');
  return chain;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * An observation contributed to a baseline.
 *
 * `quality` and `confidence` come from the signal-quality engine. They are
 * carried, not applied on the way in: a low-quality observation still belongs in
 * the history (it is evidence about the sensor), but it is down-weighted when a
 * baseline is computed. Dropping it at write time would make the history
 * unreproducible from the raw archive.
 */
export function observation({
  value, at, condition = 'all', quality = null, confidence = null,
} = {}) {
  const v = num(value);
  const ts = at instanceof Date ? at.getTime() : Date.parse(at);
  if (v == null || !Number.isFinite(ts)) return null;
  return {
    value: v,
    at: new Date(ts).toISOString(),
    ts,
    condition,
    quality: quality == null ? null : clamp(num(quality) ?? 0, 0, 1),
    confidence: confidence == null ? null : clamp(num(confidence) ?? 0, 0, 1),
  };
}

/**
 * Minimum input quality for an observation to shape a baseline.
 *
 * Below this the observation is retained but excluded from the reference set. A
 * baseline built from unusable windows is worse than no baseline, because
 * everything measured later reads as normal against it.
 */
export const MIN_OBSERVATION_QUALITY = 0.3;

/**
 * Create a baseline store for one metric.
 *
 * Deliberately storage-agnostic: it holds observations in memory and exposes
 * `toJSON`/`fromJSON`, so the caller decides whether they live in the user store,
 * Postgres, or nowhere (tests). The service never performs I/O, which is what
 * makes recomputing a baseline from the raw archive produce the same numbers as
 * the original live pass.
 */
export function createBaseline({
  metric,
  unit = null,
  windowDays = 30,
  populationPrior = null,
  minBucket = 3,
  halfLifeDays = 7,
  now = () => new Date(),
} = {}) {
  if (!metric) throw new Error('createBaseline requires a metric name');
  let rows = [];

  function prune(nowMs) {
    const cutoff = nowMs - windowDays * DAY_MS;
    // Longest window any query can ask for is the store's own window, so
    // anything older can never contribute again.
    rows = rows.filter((r) => r.ts >= cutoff);
  }

  /** Distinct local-ish days represented, which is what maturity counts. */
  function observationDays(list) {
    return new Set(list.map((r) => r.at.slice(0, 10))).size;
  }

  function reference(condition, { lookbackDays = windowDays, nowMs } = {}) {
    const cutoff = nowMs - lookbackDays * DAY_MS;
    const chain = conditionChain(condition);
    for (const cond of chain) {
      const matched = rows.filter((r) => r.ts >= cutoff
        && (cond === 'all' || r.condition === cond || r.condition.startsWith(`${cond}:`))
        && (r.quality == null || r.quality >= MIN_OBSERVATION_QUALITY));
      if (matched.length >= minBucket) {
        return { rows: matched, condition: cond, widened: cond !== condition, chain };
      }
    }
    return { rows: [], condition: null, widened: true, chain };
  }

  return {
    metric,
    unit,

    add(obs) {
      const o = obs && obs.ts ? obs : observation(obs);
      if (!o) return false;
      rows.push(o);
      rows.sort((a, b) => a.ts - b.ts);
      prune(now().getTime());
      return true;
    },

    addMany(list) {
      let added = 0;
      for (const o of list || []) if (this.add(o)) added += 1;
      return added;
    },

    size() { return rows.length; },
    rows() { return rows.map((r) => ({ ...r })); },

    /**
     * The baseline for a condition, plus the shape of the reference distribution.
     *
     * Returns `null` for `value` when nothing usable exists and there is no
     * population prior — the honest answer, and the reason callers must handle a
     * null baseline rather than receiving a plausible default.
     */
    summary({ condition = 'all', lookbackDays = windowDays } = {}) {
      const nowMs = now().getTime();
      const ref = reference(condition, { lookbackDays, nowMs });
      const values = ref.rows.map((r) => r.value);
      const cutoff = nowMs - lookbackDays * DAY_MS;
      const days = observationDays(
        ref.rows.length ? ref.rows : rows.filter((r) => r.ts >= cutoff)
      );
      const clean = withoutOutliers(values);
      const personal = clean.length ? median(clean) : null;
      const weight = personalWeight(days);
      const prior = num(populationPrior);

      let value = personal;
      let blended = false;
      if (personal != null && prior != null && weight < 1) {
        value = weight * personal + (1 - weight) * prior;
        blended = true;
      } else if (personal == null) {
        value = prior;
        blended = prior != null;
      }

      const sigma = robustSigma(clean);
      const maturity = maturityFor(days);

      // Widening the condition weakens the claim; so does an immature history.
      // Both must show up in confidence or a day-3 baseline from the `all`
      // bucket would look exactly like a day-60 one from the exact bucket.
      const base = personal == null ? 0.1 : 0.15 + 0.75 * weight;
      const confidence = clamp(base * (ref.widened ? 0.7 : 1), CONFIDENCE.min, CONFIDENCE.max);

      return {
        metric,
        unit,
        value,
        median: personal,
        prior,
        blendedWithPrior: blended,
        personalWeight: Math.round(weight * 1000) / 1000,
        mad: mad(clean),
        sigma,
        iqr: iqr(clean),
        p10: percentile(clean, 0.1),
        p90: percentile(clean, 0.9),
        ewma: ewma(ref.rows.map((r) => r.value), { halfLifeDays }),
        observations: ref.rows.length,
        observationDays: days,
        outliersExcluded: values.length - clean.length,
        requestedCondition: condition,
        matchedCondition: ref.condition,
        widened: ref.widened,
        maturity,
        confidence,
        algorithm: BASELINE_ENGINE,
        algorithmVersion: ALGORITHM_VERSION,
        windowDays: lookbackDays,
      };
    },

    /**
     * Deviation of `value` from its conditioned baseline.
     *
     * `z` is the robust modified Z-score and is null when the reference window
     * has no spread. `anomalyScore` is a bounded [0,1] mapping of |z| for UI use;
     * it saturates at OUTLIER_Z so a wildly broken sample and a moderately odd
     * one do not both read as exactly 1.0 until they genuinely deserve to.
     */
    deviation(value, { condition = 'all', lookbackDays = windowDays } = {}) {
      const v = num(value);
      const base = this.summary({ condition, lookbackDays });
      if (v == null || base.value == null) {
        return {
          ...base,
          observed: v,
          delta: null,
          z: null,
          anomalyScore: null,
          direction: null,
        };
      }
      const nowMs = now().getTime();
      const ref = reference(condition, { lookbackDays, nowMs });
      const clean = withoutOutliers(ref.rows.map((r) => r.value));
      const z = clean.length >= 2 ? robustZ(v, clean) : null;
      const delta = v - base.value;
      return {
        ...base,
        observed: v,
        delta,
        z,
        anomalyScore: z == null ? null : clamp(Math.abs(z) / 3.5, 0, 1),
        direction: delta === 0 ? 'flat' : (delta > 0 ? 'above' : 'below'),
      };
    },

    /**
     * Robust trend over a window, in metric units per day.
     *
     * Theil-Sen rather than least squares: a 7-day trend computed by OLS is
     * dominated by whichever endpoint is most contaminated.
     */
    trend({ condition = 'all', lookbackDays = 7 } = {}) {
      const nowMs = now().getTime();
      const ref = reference(condition, { lookbackDays, nowMs });
      if (ref.rows.length < 3) {
        return { slopePerDay: null, observations: ref.rows.length, lookbackDays, reason: 'need at least 3 observations' };
      }
      const t0 = ref.rows[0].ts;
      const fit = theilSen(ref.rows.map((r) => [(r.ts - t0) / DAY_MS, r.value]));
      return {
        slopePerDay: fit.slope,
        intercept: fit.intercept,
        observations: ref.rows.length,
        matchedCondition: ref.condition,
        lookbackDays,
      };
    },

    /**
     * Sustained-shift detection: CUSUM for "has been off for a while", Pettitt
     * for "where did it change". Reported together because they answer different
     * questions and disagreeing is informative — a CUSUM alarm with no change
     * point is drift, not a step.
     */
    shift({ condition = 'all', lookbackDays = windowDays } = {}) {
      const nowMs = now().getTime();
      const ref = reference(condition, { lookbackDays, nowMs });
      const values = ref.rows.map((r) => r.value);

      // Center and scale come from the OLDEST third, which is the closest thing
      // to an in-control reference period available. Letting CUSUM default to
      // the whole window would make a shift that has been running for half the
      // window undetectable at any magnitude (see cusum's note). Scale falls
      // back to the full window when the head has no spread, so a quantised
      // sensor degrades to insensitive rather than to silent.
      const headCount = Math.max(3, Math.floor(values.length / 3));
      const head = values.slice(0, headCount);
      const center = head.length >= 3 ? median(head) : null;
      const sigma = robustSigma(head) || robustSigma(values) || null;

      const c = cusum(values, { center, sigma });
      const cp = changePoint(values);
      return {
        cusumReferenceDays: head.length,
        cusumAlarm: c.alarm,
        cusumDirection: c.direction,
        cusumIndex: c.index,
        cusumAt: c.index == null ? null : ref.rows[c.index]?.at ?? null,
        changePointFound: cp.found,
        changePointAt: cp.index == null ? null : ref.rows[cp.index]?.at ?? null,
        changePointDirection: cp.direction,
        changePointP: cp.pValue,
        observations: values.length,
        matchedCondition: ref.condition,
      };
    },

    toJSON() {
      return {
        metric,
        unit,
        windowDays,
        populationPrior,
        algorithmVersion: ALGORITHM_VERSION,
        rows: rows.map(({ value, at, condition, quality, confidence }) => ({
          value, at, condition, quality, confidence,
        })),
      };
    },
  };
}

/** Rehydrate a store from `toJSON()` output. */
export function fromJSON(json, overrides = {}) {
  const store = createBaseline({
    metric: json?.metric,
    unit: json?.unit ?? null,
    windowDays: json?.windowDays ?? 30,
    populationPrior: json?.populationPrior ?? null,
    ...overrides,
  });
  store.addMany((json?.rows || []).map(observation).filter(Boolean));
  return store;
}

/**
 * A registry of baselines for one user, so callers hold one object rather than
 * one store per metric. `priors` supplies the population default per metric.
 */
export function createBaselineSet({ priors = {}, windowDays = 30, now = () => new Date() } = {}) {
  const stores = new Map();

  function store(metric, unit = null) {
    if (!stores.has(metric)) {
      stores.set(metric, createBaseline({
        metric,
        unit,
        windowDays,
        populationPrior: priors[metric] ?? null,
        now,
      }));
    }
    return stores.get(metric);
  }

  return {
    store,
    metrics: () => [...stores.keys()],
    add(metric, obs) { return store(metric).add(obs); },
    summary(metric, opts) { return store(metric).summary(opts); },
    deviation(metric, value, opts) { return store(metric).deviation(value, opts); },
    trend(metric, opts) { return store(metric).trend(opts); },
    shift(metric, opts) { return store(metric).shift(opts); },
    toJSON() {
      const out = {};
      for (const [k, v] of stores) out[k] = v.toJSON();
      return out;
    },
    load(json) {
      for (const [k, v] of Object.entries(json || {})) stores.set(k, fromJSON(v, { now }));
      return this;
    },
  };
}
