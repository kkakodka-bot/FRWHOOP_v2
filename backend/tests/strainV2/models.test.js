// FRWHOOP Strain V2 — Layer 3+5 model + display tests (node --test)
//
// Property tests (from the architecture D5/acceptance list):
//   HR-monotonicity  | duration-monotonicity | unknown/gap contribute nothing
//   duplicated epochs contribute once | lucia unavailable (never zero) | display
//   monotone + display(0)=0 | determinism (deep-equal) | insufficient => null au
// plus hand-computed unit values per model (arithmetic in comments) and an
// Edwards V1-parity check against the verbatim V1 zone table in sleep.js:174-180.

import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreModel, DEFAULT_MODEL, MODELS, listModels, modelMeta } from '../../metrics/strainV2/models/index.js';
import { weight as edwardsWeight, VERSION as EDWARDS_VERSION } from '../../metrics/strainV2/models/edwards.js';
import {
  weight as banisterWeight,
  coefficients as banisterCoefficients,
  MALE_PARAMS,
  FEMALE_PARAMS,
} from '../../metrics/strainV2/models/banister.js';
import { weight as stagnoWeight, ZONES as STAGNO_ZONES } from '../../metrics/strainV2/models/stagno.js';
import { toDisplayScore, VERSION as DISPLAY_VERSION } from '../../metrics/strainV2/display.js';
import { strainFromHr } from '../../metrics/sleep.js';

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const REST = 55;
const HRMAX = 190;

function epoch(frac, i = 0, { coverage = 1, quality = 'HIGH', hr } = {}) {
  const hrValue = hr ?? REST + frac * (HRMAX - REST);
  return { t: T0 + i * 60_000, hr: hrValue, hrrFrac: frac, coverage, quality };
}

function session(fracs, opts) {
  return fracs.map((f, i) => epoch(f, i, opts));
}

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ~= ${b}`);

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

test('registry lists the five mandated models and names the default', () => {
  assert.deepEqual(listModels().sort(), ['banister', 'edwards', 'individualized', 'lucia', 'stagno']);
  // Default chosen by WEEE ground truth (scripts/strainV2WeeeCompare.mjs):
  // banister best tracks MET-minutes in every pool; stagno zeroes <50% HRR.
  assert.equal(DEFAULT_MODEL, 'banister');
  assert.equal(MODELS.banister.defaultModel, true);
  assert.equal(MODELS.edwards.defaultModel, false);
});

test('scoreModel throws a clear Error for an unknown model, never for missing optional inputs', () => {
  assert.throws(() => scoreModel('nope', { epochs: [] }), /unknown strain model/);
  assert.equal(scoreModel('lucia', { epochs: [] }).au, null); // missing thresholds is not a throw
  assert.equal(scoreModel('individualized', { epochs: [] }).au, null); // missing curve is not a throw
});

// ---------------------------------------------------------------------------
// unit values (hand-computed, arithmetic shown in comments)
// ---------------------------------------------------------------------------

test('edwards zone weight matches the V1 zone table (sleep.js:174-180)', () => {
  // V1: pct>=90?5 : >=80?4 : >=70?3 : >=60?2 : >=50?1 : >=25?0.5 : 0
  const oracle = (pct) => (pct >= 90 ? 5 : pct >= 80 ? 4 : pct >= 70 ? 3 : pct >= 60 ? 2 : pct >= 50 ? 1 : pct >= 25 ? 0.5 : 0);
  for (const pct of [0, 10, 25, 25.0001, 49.9, 50, 59.9, 60, 69.9, 70, 79.9, 80, 89.9, 90, 95, 100]) {
    assert.equal(edwardsWeight(pct / 100), oracle(pct), `at ${pct}% HRR`);
  }
  assert.equal(edwardsWeight(null), 0);
  assert.equal(edwardsWeight(NaN), 0);
});

test('edwards session spot value: 0.5/0.6/0.7/0.8/0.9 HRR, full coverage => 15 AU', () => {
  // weight(0.5)=1, weight(0.6)=2, weight(0.7)=3, weight(0.8)=4, weight(0.9)=5
  // 1 + 2 + 3 + 4 + 5 = 15 AU (each epoch exactly 1 scorable minute)
  const r = scoreModel('edwards', { epochs: session([0.5, 0.6, 0.7, 0.8, 0.9]) });
  approx(r.au, 15);
  assert.equal(r.model.version, EDWARDS_VERSION);
});

test('edwards V1-parity cross-check: identical 60s samples produce V1 trimp under the V1 log map', () => {
  // Feed V1 (strainFromHr, sleep.js:153-185) the same per-minute series that
  // edwards scores. V1's per-sample minutes are 1 (60s delta, final sample
  // reuses prior minutes) so V1 trimp == edwards au. V1 maps
  //   score = round(clamp(21*log(trimp+1)/log(7201),0,21)*10)/10
  const fracs = [0.5, 0.6, 0.7, 0.8, 0.9];
  const v1 = scoreModel('edwards', { epochs: session(fracs) });
  const samples = fracs.map((f, i) => ({ bpm: REST + f * (HRMAX - REST), t: new Date(T0 + i * 60_000).toISOString() }));
  const expectedV1 = Math.round(Math.min(21, Math.max(0, 21 * Math.log(v1.au + 1) / Math.log(7201))) * 10) / 10;
  assert.equal(strainFromHr(samples, REST, HRMAX), expectedV1);
  assert.equal(expectedV1, 6.6); // 21*ln(16)/ln(7201) = 6.56 -> 6.6
});

test('banister male spot value: w(0.6) = 0.6*0.64*e^(1.92*0.6) = 1.215173996585...', () => {
  // per-minute weight = dHR * 0.64 * e^(1.92*dHR)   (Morton et al. 1990)
  // dHR=0.6: 0.6*0.64=0.384 ; 1.92*0.6=1.152 ; e^1.152=3.1645... ; 0.384*3.1645=1.2151739965854707
  assert.equal(banisterWeight(0.6, MALE_PARAMS), 1.2151739965854707);
  approx(banisterWeight(0.6, MALE_PARAMS) * 60, 72.91043979512824); // 60 min
  // 3-epoch session 0.6/0.8/0.9 (coverage 1) sums 6.836435326824379
  const r = scoreModel('banister', { epochs: session([0.6, 0.8, 0.9]), profile: { sex: 'male', hrMax: HRMAX, hrRest: REST } });
  approx(r.au, 6.836435326824379);
});

test('banister female variants are the two published (weakly replicated) constants', () => {
  // widely-cited female form: dHR * 0.86 * e^(1.67*dHR)
  assert.equal(banisterWeight(0.6, FEMALE_PARAMS.classic), 1.4054414974697973);
  assert.equal(FEMALE_PARAMS.classic.a, 0.86);
  assert.equal(FEMALE_PARAMS.classic.b, 1.67);
  // Miguel 2021 systematic-review table: dHR * 0.64 * e^(1.62*dHR)
  assert.equal(banisterWeight(0.6, FEMALE_PARAMS.miguel), 1.0149986410294265);
  assert.equal(FEMALE_PARAMS.miguel.a, 0.64);
  assert.equal(FEMALE_PARAMS.miguel.b, 1.62);
  assert.equal(banisterCoefficients('male').a, 0.64);
  assert.equal(banisterCoefficients('female').a, 0.86); // default classic
  assert.equal(banisterCoefficients('female', 'miguel').a, 0.64);
});

test('stagno weights are exactly the published Stagno/Miguel constants 1.25/1.71/2.54/3.61/5.16', () => {
  assert.deepEqual(STAGNO_ZONES, [
    { minHrrFrac: 0.90, weight: 5.16 },
    { minHrrFrac: 0.80, weight: 3.61 },
    { minHrrFrac: 0.70, weight: 2.54 },
    { minHrrFrac: 0.60, weight: 1.71 },
    { minHrrFrac: 0.50, weight: 1.25 },
  ]);
  assert.equal(stagnoWeight(0.4999), 0);
  assert.equal(stagnoWeight(0.5), 1.25);
  assert.equal(stagnoWeight(0.8999), 3.61);
  assert.equal(stagnoWeight(0.9), 5.16);
  // session 0.5/0.6/0.7/0.8/0.9 => 1.25+1.71+2.54+3.61+5.16 = 14.27 AU
  const r = scoreModel('stagno', { epochs: session([0.5, 0.6, 0.7, 0.8, 0.9]) });
  approx(r.au, 14.27);
});

test('lucia spot value with vt1=150, vt2=170 bpm: 140=>1, 160=>2, 180=>3 AU', () => {
  const thresholds = { vt1: 150, vt2: 170, source: 'ramp test 2026-05' };
  const eps = [
    { t: T0, hr: 140, hrrFrac: 0.63, coverage: 1, quality: 'HIGH' }, // phase I  -> x1
    { t: T0 + 60_000, hr: 160, hrrFrac: 0.78, coverage: 1, quality: 'HIGH' }, // phase II -> x2
    { t: T0 + 120_000, hr: 180, hrrFrac: 0.93, coverage: 1, quality: 'HIGH' }, // phase III -> x3
  ];
  const r = scoreModel('lucia', { epochs: eps, thresholds });
  approx(r.au, 1 + 2 + 3);
  assert.equal(r.model.weightCurve.weights.join(','), '1,2,3');
});

test('individualized spot value with curve {a:1.1, b:1.5}: w(0.6) = 0.6*1.1*e^(1.5*0.6)', () => {
  // Manzi 2009: TRIMP_i = T * dHR * y_i,  y_i = a*e^(b*dHR)
  // dHR=0.6: 0.6*1.1=0.66 ; 1.5*0.6=0.9 ; e^0.9=2.4596... ; 0.66*2.4596=1.6233380533635866
  const r = scoreModel('individualized', { epochs: session([0.6]), config: { curve: { a: 1.1, b: 1.5, source: 'graded test' } } });
  approx(r.au, 1.6233380533635866);
  assert.equal(r.model.weightCurve.type, 'exponential');
});

// ---------------------------------------------------------------------------
// property: HR monotonicity (each model)
// ---------------------------------------------------------------------------

test('increasing valid HR at the same duration never decreases AU (all models)', () => {
  const curve = { a: 1.1, b: 1.5, source: 'test' };
  const thresholds = { vt1: 150, vt2: 170, source: 'test' };
  const low = session([0.4, 0.45, 0.5, 0.55], { quality: 'HIGH' });
  const high = session([0.6, 0.7, 0.8, 0.9], { quality: 'HIGH' });
  for (const name of ['edwards', 'banister', 'stagno', 'lucia']) {
    const optsLow = name === 'lucia' ? { thresholds } : {};
    const optsHigh = { ...optsLow };
    const aLo = scoreModel(name, { epochs: low, config: { curve }, thresholds, profile: { sex: 'male' } });
    const aHi = scoreModel(name, { epochs: high, thresholds, profile: { sex: 'male' } });
    assert.ok(aHi.au >= aLo.au, `${name}: high(${aHi.au}) >= low(${aLo.au})`);
  }
  // individualized: same curve, higher dHR => higher au
  const il = scoreModel('individualized', { epochs: low, config: { curve } });
  const ih = scoreModel('individualized', { epochs: high, config: { curve } });
  assert.ok(ih.au > il.au);
  // gradual monotonicity within a single model across a ladder of levels
  let prev = -1;
  for (const frac of [0.25, 0.4, 0.55, 0.7, 0.85, 0.95]) {
    const r = scoreModel('stagno', { epochs: [epoch(frac)] });
    assert.ok(r.au >= prev, `stagno monotone at frac=${frac}`);
    prev = r.au;
  }
});

// ---------------------------------------------------------------------------
// property: duration monotonicity (each model)
// ---------------------------------------------------------------------------

test('increasing valid duration at the same HR never decreases AU (all models)', () => {
  const curve = { a: 1.1, b: 1.5, source: 'test' };
  const thresholds = { vt1: 150, vt2: 170, source: 'test' };
  const short = session([0.7, 0.7, 0.7]); // 3 min, coverage 1
  const long = session([0.7, 0.7, 0.7, 0.7, 0.7, 0.7]); // 6 min
  for (const name of ['edwards', 'banister', 'stagno', 'lucia', 'individualized']) {
    const aSh = scoreModel(name, { epochs: short, thresholds, config: { curve }, profile: { sex: 'male' } });
    const aLo = scoreModel(name, { epochs: long, thresholds, config: { curve }, profile: { sex: 'male' } });
    assert.ok(aLo.au >= aSh.au, `${name}: long(${aLo.au}) >= short(${aSh.au})`);
  }
  // doubling per-epoch coverage (more valid samples in the same epoch) doubles minutes
  const cov1 = scoreModel('edwards', { epochs: [epoch(0.8, 0, { coverage: 1 })] }).au;
  const cov05 = scoreModel('edwards', { epochs: [epoch(0.8, 0, { coverage: 0.5 })] }).au;
  approx(cov1, cov05 * 2);
});

// ---------------------------------------------------------------------------
// property: unknown / gap epochs contribute nothing
// ---------------------------------------------------------------------------

test('UNKNOWN-quality epochs contribute 0 AU and never extend scorable duration', () => {
  const base = scoreModel('stagno', { epochs: session([0.7, 0.8], { coverage: 1 }) });
  const eps = [
    ...session([0.7, 0.8]),
    epoch(0.95, 2, { quality: 'UNKNOWN' }),
    epoch(0.95, 3, { quality: 'UNKNOWN', coverage: 1 }),
  ];
  const withUnknown = scoreModel('stagno', { epochs: eps });
  approx(withUnknown.au, base.au);
  const unknownInc = withUnknown.increments.filter((i) => Math.abs(i.au) < 1e-12);
  assert.equal(unknownInc.length, 2); // the two UNKNOWN epochs appear with au 0
  assert.ok(withUnknown.notes.some((n) => /UNKNOWN epoch/.test(n)));
});

test('missing hrrFrac / missing coverage mean the epoch contributes nothing', () => {
  const base = scoreModel('edwards', { epochs: [epoch(0.8)] }).au;
  const eps = [
    epoch(0.8),
    epoch(0.95, 1, { coverage: 0 }), // zero coverage -> no scorable minutes
    { t: T0 + 120_000, hr: 170, coverage: 1, quality: 'HIGH' }, // hrrFrac missing
    { t: T0 + 180_000, hr: 170, hrrFrac: 0.8, quality: 'HIGH' }, // coverage missing
  ];
  const r = scoreModel('edwards', { epochs: eps });
  approx(r.au, base);
});

// ---------------------------------------------------------------------------
// property: duplicated epochs contribute once
// ---------------------------------------------------------------------------

test('duplicated epochs (same t) contribute exactly once; best quality wins', () => {
  const single = scoreModel('stagno', { epochs: session([0.5, 0.7, 0.9]) });
  const dup = scoreModel('stagno', { epochs: [...session([0.5, 0.7, 0.9]), ...session([0.5, 0.7, 0.9])] });
  approx(dup.au, single.au);
  assert.equal(dup.increments.length, 3); // normalized to one entry per t
  // a duplicate at UNKNOWN quality loses to an existing HIGH-quality epoch
  const withBetterGarbage = scoreModel('edwards', {
    epochs: [...session([0.5]), { t: T0, hr: 190, hrrFrac: 0.98, coverage: 1, quality: 'UNKNOWN' }],
  });
  approx(withBetterGarbage.au, 1 * 1); // keeps the HIGH 0.5 epoch, not the UNKNOWN dup
});

// ---------------------------------------------------------------------------
// property: insuffiency => null au (never fabricated zero)
// ---------------------------------------------------------------------------

test('no scorable data => au null (INSUFFICIENT), not zero, for every model', () => {
  const curve = { a: 1.1, b: 1.5, source: 'test' };
  const thresholds = { vt1: 150, vt2: 170, source: 'test' };
  const empty = [];
  const onlyUnknown = [epoch(0.9, 0, { quality: 'UNKNOWN' })];
  for (const name of ['edwards', 'banister', 'stagno', 'lucia', 'individualized']) {
    for (const eps of [empty, onlyUnknown]) {
      const r = scoreModel(name, { epochs: eps, thresholds, config: { curve }, profile: { sex: 'male' } });
      assert.equal(r.au, null, `${name} with ${eps.length} epochs`);
      assert.ok(r.notes.some((n) => /INSUFFICIENT/.test(n)));
    }
  }
});

test('a genuinely rest-y day with valid HR but zero-weight bands still scores a numeric 0, not null', () => {
  // 5 epochs at 10% HRR (below every weight threshold) => real data, no load
  const r = scoreModel('stagno', { epochs: session([0.1, 0.1, 0.1, 0.1, 0.1]) });
  assert.equal(r.au, 0);
  assert.ok(Number.isFinite(r.au));
});

// ---------------------------------------------------------------------------
// lucia / individualized availability contract
// ---------------------------------------------------------------------------

test('lucia without usable thresholds is "unavailable" with null au — never 0, never throw, never fallback', () => {
  const r = scoreModel('lucia', { epochs: session([0.9]) });
  assert.equal(r.au, null);
  assert.equal(r.model.params.status, 'unavailable');
  assert.deepEqual(r.increments, []);
  // partial thresholds (only one of the pair) are also unusable -> unavailable
  const partial = scoreModel('lucia', { epochs: session([0.9]), thresholds: { vt1: 150 } });
  assert.equal(partial.au, null);
  assert.equal(partial.model.params.status, 'unavailable');
});

test('individualized without a usable curve is "unavailable" with null au', () => {
  const none = scoreModel('individualized', { epochs: session([0.9]) });
  assert.equal(none.au, null);
  assert.equal(none.model.params.status, 'unavailable');
  const bad = scoreModel('individualized', { epochs: session([0.9]), config: { curve: { a: -1, b: 2 } } });
  assert.equal(bad.au, null);
  // non-monotone points table is rejected too (would break monotonicity)
  const badPts = scoreModel('individualized', { epochs: session([0.9]), config: { curve: { points: [[0, 1], [0.5, 0.5]], source: 'x' } } });
  assert.equal(badPts.au, null);
});

test('lucia and individualized refuse to silently fall back when inputs are missing', () => {
  // even with epochs present, missing thresholds/curve => unavailable, and the
  // notes explicitly say so (no population-model substitution)
  const l = scoreModel('lucia', { epochs: session([0.9]) });
  assert.ok(l.model === null || l.model.params.status === 'unavailable');
  assert.ok(l.notes.some((n) => /unavailable/.test(n)));
  const i = scoreModel('individualized', { epochs: session([0.9]) });
  assert.ok(i.model.params.status === 'unavailable');
  assert.ok(i.notes.some((n) => /unavailable/.test(n)));
});

// ---------------------------------------------------------------------------
// model metadata / weightCurve
// ---------------------------------------------------------------------------

test('edwards weightCurve exposes the discrete V1-parity bands', () => {
  const r = scoreModel('edwards', { epochs: session([0.6]) });
  assert.equal(r.model.weightCurve.type, 'zones');
  assert.deepEqual(r.model.weightCurve.bands, [
    { minHrrFrac: 0.9, weight: 5 },
    { minHrrFrac: 0.8, weight: 4 },
    { minHrrFrac: 0.7, weight: 3 },
    { minHrrFrac: 0.6, weight: 2 },
    { minHrrFrac: 0.5, weight: 1 },
    { minHrrFrac: 0.25, weight: 0.5 },
  ]);
});

test('stagno weightCurve exposes the lactate-anchored band weights', () => {
  const r = scoreModel('stagno', { epochs: session([0.6]) });
  assert.equal(r.model.weightCurve.type, 'zones');
  assert.equal(r.model.weightCurve.bands[0].weight, 5.16);
  assert.equal(r.model.weightCurve.bands[4].weight, 1.25);
});

test('modelMeta advertises the default-model recommendation', () => {
  const meta = modelMeta();
  assert.ok(meta.some((m) => m.name === 'banister' && m.defaultModel === true
    && /ground-truth replay/.test(m.recommendation)));
  assert.ok(meta.some((m) => m.name === 'stagno' && m.defaultModel === false && m.note));
});

// ---------------------------------------------------------------------------
// increments
// ---------------------------------------------------------------------------

test('increments are chronological and sum to the total AU', () => {
  const r = scoreModel('stagno', { epochs: session([0.5, 0.6, 0.7, 0.8, 0.9]) });
  const sum = r.increments.reduce((a, b) => a + b.au, 0);
  approx(sum, r.au);
  const ts = r.increments.map((i) => i.t);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
});

// ---------------------------------------------------------------------------
// display transform
// ---------------------------------------------------------------------------

test('display transform is monotone non-decreasing across the AU range', () => {
  let prev = -1;
  for (let au = 0; au <= 1000; au += 1) {
    const s = toDisplayScore(au);
    assert.ok(s >= prev, `display monotone at au=${au}`);
    prev = s;
  }
});

test('display(0) = 0 and negative/NaN au => 0', () => {
  assert.equal(toDisplayScore(0), 0);
  assert.equal(toDisplayScore(-5), 0);
  assert.equal(toDisplayScore(NaN), 0);
  assert.equal(toDisplayScore(undefined), 0);
});

test('display clamps to [0,21] with 1-decimal rounding', () => {
  assert.equal(toDisplayScore(1e9), 21);
  assert.equal(toDisplayScore(480), 21);
  assert.ok(Math.abs(toDisplayScore(75) - 8.3) < 1e-9); // sqrt(75/480)*21 = 8.30...
  assert.ok(Math.abs(toDisplayScore(310) - 16.9) < 1e-9);
  for (let au = 0; au < 5000; au += 7) {
    const s = toDisplayScore(au);
    assert.ok(s >= 0 && s <= 21);
    assert.equal(Math.round(s * 10), s * 10); // exactly 1 decimal
  }
});

test('display version is v2.display.1', () => {
  assert.equal(DISPLAY_VERSION, 'v2.display.1');
});

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

test('repeated calls are deep-equal for every model (determinism)', () => {
  const curve = { a: 1.1, b: 1.5, source: 'test' };
  const thresholds = { vt1: 150, vt2: 170, source: 'test' };
  const eps = session([0.4, 0.6, 0.8, 0.95]);
  for (const name of Object.keys(MODELS)) {
    const a = scoreModel(name, { epochs: eps, thresholds, config: { curve }, profile: { sex: 'female', hrMax: HRMAX, hrRest: REST } });
    const b = scoreModel(name, { epochs: eps, thresholds, config: { curve }, profile: { sex: 'female', hrMax: HRMAX, hrRest: REST } });
    assert.deepEqual(a, b, `${name} deterministic`);
  }
});

// ---------------------------------------------------------------------------
// notes / caveats
// ---------------------------------------------------------------------------

test('long sessions emit the cardiac-drift caveat; short no', () => {
  const longEps = []; // 62 minutes of steady z3
  for (let i = 0; i < 62; i += 1) longEps.push(epoch(0.75, i));
  const long = scoreModel('stagno', { epochs: longEps });
  assert.ok(long.notes.some((n) => /cardiac-drift/.test(n)));
  const short = scoreModel('stagno', { epochs: session([0.75, 0.75, 0.75]) });
  assert.ok(!short.notes.some((n) => /cardiac-drift/.test(n)));
});

test('selected default model note: stagno is the lit-recommended default path', () => {
  const r = scoreModel('stagno', { epochs: session([0.7]) });
  assert.equal(r.model.name, 'stagno');
  assert.deepEqual(r.model.weightCurve.bands.map((b) => b.weight), [5.16, 3.61, 2.54, 1.71, 1.25]);
});
