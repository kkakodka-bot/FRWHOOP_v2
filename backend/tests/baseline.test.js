import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAD_TO_SIGMA,
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
} from '../baseline/stats.js';
import {
  ACTIVITY_STATE,
  MATURITY,
  MATURITY_THRESHOLDS,
  conditionChain,
  conditionKey,
  createBaseline,
  createBaselineSet,
  fromJSON,
  maturityFor,
  observation,
  personalWeight,
  timeBand,
} from '../baseline/service.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-25T12:00:00Z');

/** A clock fixed at NOW, so window pruning is deterministic. */
const now = () => new Date(NOW);

function daysAgo(n, hourUtc = 3) {
  const d = new Date(NOW - n * DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Robust statistics
// ---------------------------------------------------------------------------

test('percentile interpolates and tolerates unsorted input', () => {
  assert.equal(percentile([3, 1, 2, 4], 0.5), 2.5);
  assert.equal(percentile([10], 0.9), 10);
  assert.equal(percentile([], 0.5), null);
});

test('median resists a single wild outlier where a mean would not', () => {
  const clean = [50, 51, 52, 53, 54];
  const dirty = [...clean, 500];
  const meanOf = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.equal(median(clean), 52);
  assert.equal(median(dirty), 52.5);
  assert.ok(Math.abs(meanOf(dirty) - meanOf(clean)) > 70, 'the mean moves by more than 70');
});

test('MAD scales to a standard-deviation equivalent', () => {
  const values = [10, 12, 14, 16, 18];
  assert.equal(mad(values), 2);
  assert.equal(robustSigma(values), 2 * MAD_TO_SIGMA);
});

test('a constant series has zero spread, and robust Z refuses to be infinite', () => {
  const flat = [5, 5, 5, 5, 5];
  assert.equal(mad(flat), 0);
  assert.equal(robustSigma(flat), 0);
  assert.equal(robustZ(9, flat), null, 'differing from a constant history is not a magnitude');
});

test('robustSigma falls back to the IQR when more than half the window is identical', () => {
  // MAD is 0 here because the median absolute deviation is itself 0.
  const quantised = [1, 1, 1, 1, 1, 1, 2, 3, 4];
  assert.equal(mad(quantised), 0);
  assert.ok(robustSigma(quantised) > 0, 'a series with real spread must not report zero scale');
});

test('robust Z flags a genuine excursion', () => {
  const nights = [50, 51, 49, 52, 50, 51, 50, 49];
  assert.ok(Math.abs(robustZ(50, nights)) < 1);
  assert.ok(Math.abs(robustZ(70, nights)) > 3.5);
});

test('outlier removal keeps the bulk and drops the excursion', () => {
  const values = [50, 51, 49, 52, 50, 51, 200];
  const clean = withoutOutliers(values);
  assert.ok(!clean.includes(200));
  assert.equal(clean.length, 6);
});

test('outlier removal is inert on a short window it cannot judge', () => {
  assert.deepEqual(withoutOutliers([1, 99]), [1, 99]);
});

test('EWMA weights recent observations more heavily', () => {
  const rising = [50, 50, 50, 50, 60, 60, 60, 60];
  assert.ok(ewma(rising, { halfLifeDays: 2 }) > ewma(rising, { halfLifeDays: 30 }));
});

test('IQR describes the middle of the distribution', () => {
  assert.equal(iqr([1, 2, 3, 4, 5]), 2);
});

test('CUSUM catches a recent sustained shift that no single day would flag', () => {
  const stable = Array.from({ length: 30 }, (_, i) => 50 + (i % 3) - 1);
  const shifted = [...stable.slice(0, 24), ...stable.slice(24).map((v) => v + 3)];
  assert.equal(cusum(stable).alarm, false, 'a stable series must not alarm');
  const alarm = cusum(shifted);
  assert.equal(alarm.alarm, true);
  assert.equal(alarm.direction, 'up');
  assert.ok(alarm.index >= 24, 'the alarm cannot precede the shift');
});

test('a shift filling half the window is invisible to a self-centered CUSUM', () => {
  // Documents WHY baseline.shift() supplies a head-based reference rather than
  // letting CUSUM center itself. With a 50/50 split the median lands mid-shift
  // and MAD grows with the step, so the standardised departure is pinned near
  // 0.67 no matter how large the shift gets.
  const half = (delta) => {
    const stable = Array.from({ length: 20 }, (_, i) => 50 + (i % 3) - 1);
    return [...stable.slice(0, 10), ...stable.slice(10).map((v) => v + delta)];
  };
  assert.equal(cusum(half(4)).alarm, false);
  assert.equal(cusum(half(40)).alarm, false, 'a tenfold larger shift is equally invisible');
  assert.equal(
    cusum(half(40), { center: 50, sigma: 1.5 }).alarm,
    true,
    'the same series alarms immediately given an in-control reference',
  );
});

test('CUSUM stays silent on a series with no scale to standardise by', () => {
  assert.equal(cusum([5, 5, 5, 5, 5, 5]).alarm, false);
});

test('Pettitt finds where a level changed and in which direction', () => {
  const values = [...new Array(10).fill(50), ...new Array(10).fill(58)];
  const cp = changePoint(values);
  assert.equal(cp.found, true);
  assert.equal(cp.index, 9, 'the change point is the last index of the first regime');
  assert.equal(cp.direction, 'up');
  assert.ok(cp.pValue < 0.05);
});

test('Pettitt reports no change point on a stationary series', () => {
  const values = Array.from({ length: 30 }, (_, i) => 50 + ((i * 7) % 5) - 2);
  assert.equal(changePoint(values).found, false);
});

test('Pettitt refuses to answer on a series too short to test', () => {
  const cp = changePoint([1, 2, 3]);
  assert.equal(cp.found, false);
  assert.match(cp.reason, /10 observations/);
});

test('ties do not fabricate a change point', () => {
  assert.equal(changePoint(new Array(30).fill(7)).found, false);
});

test('Theil-Sen recovers a clean slope and survives a contaminated endpoint', () => {
  const clean = Array.from({ length: 10 }, (_, i) => [i, 2 * i + 1]);
  assert.equal(theilSen(clean).slope, 2);

  const dirty = [...clean.slice(0, 9), [9, 500]];
  const robust = theilSen(dirty).slope;
  // Least squares on the same points is dragged far above the true slope.
  const n = dirty.length;
  const sx = dirty.reduce((a, [x]) => a + x, 0);
  const sy = dirty.reduce((a, [, y]) => a + y, 0);
  const sxy = dirty.reduce((a, [x, y]) => a + x * y, 0);
  const sxx = dirty.reduce((a, [x]) => a + x * x, 0);
  const ols = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  assert.ok(Math.abs(robust - 2) < 1, `Theil-Sen stayed near 2, got ${robust}`);
  assert.ok(ols > 6, `OLS was dragged to ${ols}`);
});

test('Theil-Sen needs three points before it claims a trend', () => {
  assert.equal(theilSen([[0, 1], [1, 2]]).slope, null);
});

// ---------------------------------------------------------------------------
// Conditioning
// ---------------------------------------------------------------------------

test('time bands cover the clock exactly once', () => {
  assert.equal(timeBand(0), 'overnight');
  assert.equal(timeBand(5.9), 'overnight');
  assert.equal(timeBand(6), 'morning');
  assert.equal(timeBand(13), 'afternoon');
  assert.equal(timeBand(23.9), 'evening');
  assert.equal(timeBand(null), null);
});

test('sleep is the outermost conditioner and drops the time band', () => {
  assert.equal(conditionKey({ asleep: true, localHour: 3 }), 'sleep');
  assert.equal(conditionKey({ asleep: true, localHour: 14 }), 'sleep');
});

test('an awake condition carries the time band and any non-rest activity', () => {
  assert.equal(conditionKey({ asleep: false, localHour: 20 }), 'awake:evening');
  assert.equal(
    conditionKey({ asleep: false, localHour: 20, activity: ACTIVITY_STATE.EXERCISE }),
    'awake:evening:exercise',
  );
  assert.equal(
    conditionKey({ asleep: false, localHour: 20, activity: ACTIVITY_STATE.REST }),
    'awake:evening',
    'rest is the default and must not thin the bucket',
  );
});

test('the fallback chain widens from specific to all', () => {
  assert.deepEqual(conditionChain('awake:evening:exercise'), [
    'awake:evening:exercise', 'awake:evening', 'awake', 'all',
  ]);
  assert.deepEqual(conditionChain('sleep'), ['sleep', 'all']);
});

// ---------------------------------------------------------------------------
// Maturity
// ---------------------------------------------------------------------------

test('maturity tiers follow the thresholds the codebase already uses', () => {
  const t = MATURITY_THRESHOLDS;
  assert.equal(maturityFor(0), MATURITY.INSUFFICIENT);
  assert.equal(maturityFor(t.minObservations - 1), MATURITY.INSUFFICIENT);
  assert.equal(maturityFor(t.minObservations), MATURITY.LOW);
  assert.equal(maturityFor(t.moderateDays), MATURITY.MODERATE);
  assert.equal(maturityFor(t.personalizedDays), MATURITY.PERSONALIZED);
});

test('personal weight ramps rather than stepping, so nothing visibly jumps', () => {
  assert.equal(personalWeight(0), 0);
  assert.equal(personalWeight(MATURITY_THRESHOLDS.personalizedDays), 1);
  const mid = personalWeight(14);
  assert.ok(mid > 0 && mid < 1);
  assert.ok(personalWeight(20) > mid, 'more evidence must mean more personal weight');
});

// ---------------------------------------------------------------------------
// Baseline store
// ---------------------------------------------------------------------------

function nightly(values, { condition = 'sleep', quality = 0.9 } = {}) {
  return values.map((v, i) => observation({
    value: v, at: daysAgo(values.length - i), condition, quality,
  }));
}

test('an observation without a usable value or time is refused', () => {
  assert.equal(observation({ value: null, at: daysAgo(1) }), null);
  assert.equal(observation({ value: 50, at: 'not-a-date' }), null);
});

test('a baseline with no data and no prior reports null, not a default', () => {
  const b = createBaseline({ metric: 'resp_rate', unit: 'brpm', now });
  const s = b.summary({ condition: 'sleep' });
  assert.equal(s.value, null);
  assert.equal(s.maturity, MATURITY.INSUFFICIENT);
  assert.equal(s.observations, 0);
});

test('a cold-start baseline leans on the population prior and says so', () => {
  const b = createBaseline({ metric: 'resp_rate', unit: 'brpm', populationPrior: 15, now });
  b.addMany(nightly([20, 20, 20]));
  const s = b.summary({ condition: 'sleep' });
  assert.equal(s.blendedWithPrior, true);
  assert.equal(s.maturity, MATURITY.LOW);
  assert.ok(s.value > 15 && s.value < 20, `expected a blend, got ${s.value}`);
  assert.ok(s.confidence < 0.5, 'three nights is not a confident baseline');
});

test('a mature baseline uses the personal value outright', () => {
  const b = createBaseline({ metric: 'resp_rate', unit: 'brpm', populationPrior: 15, now });
  b.addMany(nightly(new Array(28).fill(20)));
  const s = b.summary({ condition: 'sleep' });
  assert.equal(s.maturity, MATURITY.PERSONALIZED);
  assert.equal(s.personalWeight, 1);
  assert.equal(s.value, 20);
  assert.equal(s.blendedWithPrior, false);
});

test('one contaminated night does not move a mature baseline', () => {
  const clean = createBaseline({ metric: 'rhr', now });
  const dirty = createBaseline({ metric: 'rhr', now });
  const nights = Array.from({ length: 28 }, (_, i) => 50 + (i % 3) - 1);
  clean.addMany(nightly(nights));
  dirty.addMany(nightly([...nights.slice(0, 27), 140]));
  const a = clean.summary({ condition: 'sleep' });
  const b = dirty.summary({ condition: 'sleep' });
  assert.equal(a.value, b.value, 'the median is unmoved');
  assert.equal(b.outliersExcluded, 1);
});

test('an evening measurement is compared against evening history, not the whole day', () => {
  // The confound this whole design exists to prevent: peripheral temperature is
  // legitimately warmer in the evening, and an all-day baseline would report
  // every evening as a fever.
  const b = createBaseline({ metric: 'skin_temp', now });
  for (let d = 1; d <= 28; d += 1) {
    b.add(observation({ value: 33.0, at: daysAgo(d, 3), condition: 'awake:overnight', quality: 0.9 }));
    b.add(observation({ value: 34.5, at: daysAgo(d, 20), condition: 'awake:evening', quality: 0.9 }));
  }
  const evening = b.deviation(34.5, { condition: 'awake:evening' });
  const overall = b.deviation(34.5, { condition: 'all' });
  assert.ok(Math.abs(evening.delta) < 0.1, `conditioned deviation should be ~0, got ${evening.delta}`);
  assert.ok(overall.delta > 0.5, 'the unconditioned comparison invents an excursion');
});

test('a thin bucket widens to a coarser one and reports that it did', () => {
  const b = createBaseline({ metric: 'rhr', minBucket: 5, now });
  b.addMany(nightly(new Array(20).fill(50), { condition: 'awake:morning' }));
  b.add(observation({ value: 52, at: daysAgo(1, 20), condition: 'awake:evening', quality: 0.9 }));
  const s = b.summary({ condition: 'awake:evening' });
  assert.equal(s.widened, true);
  assert.equal(s.matchedCondition, 'awake');
  assert.ok(s.confidence < b.summary({ condition: 'awake:morning' }).confidence);
});

test('low-quality observations are retained but excluded from the reference set', () => {
  const b = createBaseline({ metric: 'rhr', now });
  b.addMany(nightly(new Array(28).fill(50)));
  b.addMany(nightly(new Array(5).fill(120), { quality: 0.05 }));
  const s = b.summary({ condition: 'sleep' });
  assert.equal(s.value, 50, 'unusable windows must not shape the baseline');
  assert.ok(b.size() > s.observations, 'but they stay in the history as evidence about the sensor');
});

test('observations outside the window are pruned', () => {
  const b = createBaseline({ metric: 'rhr', windowDays: 30, now });
  b.add(observation({ value: 50, at: daysAgo(200), condition: 'sleep', quality: 0.9 }));
  assert.equal(b.size(), 0);
});

test('deviation reports direction, delta and a bounded anomaly score', () => {
  const b = createBaseline({ metric: 'rhr', now });
  b.addMany(nightly(Array.from({ length: 28 }, (_, i) => 50 + (i % 3) - 1)));
  const high = b.deviation(70, { condition: 'sleep' });
  assert.equal(high.direction, 'above');
  assert.ok(high.delta > 15);
  assert.equal(high.anomalyScore, 1, 'saturates rather than growing without bound');

  const normal = b.deviation(50, { condition: 'sleep' });
  assert.ok(normal.anomalyScore < 0.3);
});

test('deviation of an absent value is null, never zero', () => {
  const b = createBaseline({ metric: 'rhr', now });
  b.addMany(nightly(new Array(28).fill(50)));
  const d = b.deviation(null, { condition: 'sleep' });
  assert.equal(d.observed, null);
  assert.equal(d.delta, null);
  assert.equal(d.z, null);
});

test('trend is reported per day and needs three observations', () => {
  const b = createBaseline({ metric: 'rhr', now });
  b.addMany(nightly([50, 51, 52, 53, 54, 55, 56]));
  const t = b.trend({ condition: 'sleep', lookbackDays: 7 });
  assert.ok(t.slopePerDay > 0.5 && t.slopePerDay < 1.5, `got ${t.slopePerDay}`);

  const thin = createBaseline({ metric: 'rhr', now });
  thin.addMany(nightly([50, 51]));
  assert.equal(thin.trend({ condition: 'sleep' }).slopePerDay, null);
});

test('a sustained shift is detected and located', () => {
  const b = createBaseline({ metric: 'rhr', now });
  // Real nights vary, so the reference period has a scale to standardise by.
  const values = Array.from({ length: 28 }, (_, i) => (i < 14 ? 50 : 58) + (i % 3) - 1);
  b.addMany(nightly(values));
  const s = b.shift({ condition: 'sleep' });
  assert.equal(s.cusumAlarm, true, 'a half-window shift is detectable from a head reference');
  assert.equal(s.cusumDirection, 'up');
  assert.equal(s.changePointFound, true);
  assert.equal(s.changePointDirection, 'up');
  assert.ok(s.changePointAt);
});

test('shift detection survives a reference period with no spread', () => {
  // A quantised sensor makes the head MAD zero. Falling back to the full-window
  // scale keeps this insensitive rather than silently never alarming.
  const b = createBaseline({ metric: 'rhr', now });
  b.addMany(nightly([...new Array(20).fill(50), ...new Array(8).fill(62)]));
  const s = b.shift({ condition: 'sleep' });
  assert.ok(s.cusumReferenceDays >= 3);
  assert.equal(s.changePointFound, true, 'Pettitt is rank-based and needs no scale at all');
});

test('a stable history reports no shift', () => {
  const b = createBaseline({ metric: 'rhr', now });
  b.addMany(nightly(Array.from({ length: 28 }, (_, i) => 50 + (i % 3) - 1)));
  const s = b.shift({ condition: 'sleep' });
  assert.equal(s.cusumAlarm, false);
  assert.equal(s.changePointFound, false);
});

test('a baseline round-trips through JSON unchanged', () => {
  const b = createBaseline({ metric: 'rhr', unit: 'bpm', populationPrior: 60, now });
  b.addMany(nightly(Array.from({ length: 20 }, (_, i) => 50 + (i % 4))));
  const revived = fromJSON(b.toJSON(), { now });
  assert.deepEqual(revived.summary({ condition: 'sleep' }), b.summary({ condition: 'sleep' }));
});

test('recomputing a baseline from the same observations is deterministic', () => {
  const build = () => {
    const b = createBaseline({ metric: 'rhr', now });
    b.addMany(nightly(Array.from({ length: 28 }, (_, i) => 50 + (i % 5))));
    return b.summary({ condition: 'sleep' });
  };
  assert.deepEqual(build(), build());
});

test('out-of-order observations produce the same baseline as ordered ones', () => {
  const values = Array.from({ length: 20 }, (_, i) => 50 + (i % 4));
  const ordered = createBaseline({ metric: 'rhr', now });
  ordered.addMany(nightly(values));
  const shuffled = createBaseline({ metric: 'rhr', now });
  shuffled.addMany(nightly(values).slice().reverse());
  assert.deepEqual(
    shuffled.summary({ condition: 'sleep' }),
    ordered.summary({ condition: 'sleep' }),
  );
});

test('a baseline set keeps metrics independent and applies per-metric priors', () => {
  const set = createBaselineSet({ priors: { resp_rate: 15, rhr: 60 }, now });
  set.add('resp_rate', observation({ value: 20, at: daysAgo(1), condition: 'sleep', quality: 0.9 }));
  set.add('rhr', observation({ value: 50, at: daysAgo(1), condition: 'sleep', quality: 0.9 }));
  assert.deepEqual(set.metrics().sort(), ['resp_rate', 'rhr']);
  assert.equal(set.summary('resp_rate', { condition: 'sleep' }).prior, 15);
  assert.equal(set.summary('rhr', { condition: 'sleep' }).prior, 60);
});

test('a baseline set round-trips through JSON', () => {
  const set = createBaselineSet({ priors: { rhr: 60 }, now });
  set.add('rhr', observation({ value: 50, at: daysAgo(2), condition: 'sleep', quality: 0.9 }));
  set.add('rhr', observation({ value: 51, at: daysAgo(1), condition: 'sleep', quality: 0.9 }));
  const revived = createBaselineSet({ priors: { rhr: 60 }, now }).load(set.toJSON());
  assert.deepEqual(
    revived.summary('rhr', { condition: 'sleep' }).observations,
    set.summary('rhr', { condition: 'sleep' }).observations,
  );
});
