import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeStrainV2, windowCardioLoad } from '../../metrics/strainV2/score.js';
import { DEFAULT_MODEL } from '../../metrics/strainV2/models/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'epochs');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
}

const HIST = Array.from({ length: 12 }, (_, i) => ({
  day: `2026-08-${String(10 + i).padStart(2, '0')}`,
  rhr: 52,
}));

test('score: end-to-end on a walking day - default (banister) captures light activity', () => {
  const fx = loadFixture('walking');
  const common = { profile: { birthYear: 1992 }, prefs: {}, days: HIST, currentDay: '2026-08-28' };
  // DEFAULT (banister, chosen by WEEE ground truth): continuous weighting is
  // nonzero at walking intensity (~33% HRR) so a daily construct captures
  // light activity. qualityState stays data-driven (LOW: 37.5% coverage).
  const banister = computeStrainV2({ samples: fx.samples, ...common, opts: fx.opts });
  assert.equal(banister.qualityState, 'LOW');
  assert.ok(banister.au > 0, `banister au=${banister.au}`);
  assert.ok(banister.strain > 0 && banister.strain <= 21);
  assert.equal(banister.cardioModel.name, 'banister');
  assert.equal(banister.cardioModel.state, 'scored');
  assert.equal(banister.hrMax.source, 'tanaka_age');
  assert.equal(banister.restingHr.source, 'overnight_history_rolling_median');
  assert.equal(banister.muscular.state, 'not_implemented_v2_0');
  assert.ok(banister.strainSeries.length > 0);
  // Stagno (session-scoring option) zeroes sub-50% HRR: documented MODEL
  // property - a measured zero, distinct from INSUFFICIENT (no data).
  const stagno = computeStrainV2({ samples: fx.samples, ...common, opts: { ...fx.opts, model: 'stagno' } });
  assert.equal(stagno.au, 0);
  assert.equal(stagno.strain, 0);
  assert.equal(stagno.qualityState, 'LOW');
  assert.ok(stagno.strainSeries.length > 0); // increments exist; all 0 AU
});

test('score: property - activity window load equals the same underlying increments (D7)', () => {
  const fx = loadFixture('walking');
  const out = computeStrainV2({
    samples: fx.samples,
    profile: { birthYear: 1992 },
    prefs: {},
    days: HIST,
    currentDay: '2026-08-28',
    activities: [{ id: 'w1', name: 'walk', start: fx.opts.dayStartMs, end: fx.opts.dayEndMs }],
    opts: fx.opts,
  });
  assert.equal(out.activities.length, 1);
  // the activity covers the whole scored window: its AU equals the day AU
  assert.ok(Math.abs(out.activities[0].au - out.au) < 1e-6);
  assert.equal(out.activities[0].state, 'scored');
  // the 5-min series (disjoint buckets) also partitions the daily AU
  const seriesSum = out.strainSeries.reduce((a, b) => a + b.au, 0);
  assert.ok(Math.abs(seriesSum - out.au) < 0.51);
});

test('score: two disjoint windows partition the daily AU', () => {
  const fx = loadFixture('long-zone2'); // 90 min session
  const mid = fx.opts.dayStartMs + 45 * 60_000;
  const out = computeStrainV2({
    samples: fx.samples,
    profile: { birthYear: 1992 },
    prefs: {},
    days: HIST,
    currentDay: '2026-08-28',
    activities: [
      { id: 'a', start: fx.opts.dayStartMs, end: mid },
      { id: 'b', start: mid, end: fx.opts.dayEndMs },
    ],
    opts: fx.opts,
  });
  const [a, b] = out.activities;
  assert.equal(a.state, 'scored');
  assert.equal(b.state, 'scored');
  assert.ok(Math.abs(a.au + b.au - out.au) < 0.51, `${a.au} + ${b.au} vs ${out.au}`);
  assert.ok(a.au > 0 && b.au > 0);
  // strain is monotone in AU: both halves map below the full-day score
  assert.ok(a.strain < out.strain && b.strain < out.strain);
});

test('score: no data -> INSUFFICIENT with null strain, never zero', () => {
  const fx = loadFixture('walking');
  const out = computeStrainV2({
    samples: [],
    profile: { birthYear: 1992 },
    prefs: {},
    days: HIST,
    currentDay: '2026-08-28',
    opts: fx.opts,
  });
  assert.equal(out.strain, null);
  assert.equal(out.au, null);
  assert.equal(out.qualityState, 'INSUFFICIENT');
  assert.equal(out.scorableMinutes, 0);
  assert.equal(out.strainSeries.length, 0);
});

test('score: unknown model degrades with provenance, never throws', () => {
  const fx = loadFixture('walking');
  const out = computeStrainV2({
    samples: fx.samples,
    profile: { birthYear: 1992 },
    prefs: {},
    days: HIST,
    currentDay: '2026-08-28',
    opts: { ...fx.opts, model: 'nope' },
  });
  assert.equal(out.au, null);
  assert.equal(out.strain, null);
  assert.equal(out.cardioModel.state, 'error');
  assert.ok(out.notes.includes('cardio_model_error'));
});

test('score: model selection is honored (stagno default, edwards on request)', () => {
  const fx = loadFixture('intervals-recovery');
  const stagno = computeStrainV2({ samples: fx.samples, profile: { birthYear: 1992 }, prefs: {}, days: HIST, currentDay: '2026-08-28', opts: { ...fx.opts, model: 'stagno' } });
  const edwards = computeStrainV2({ samples: fx.samples, profile: { birthYear: 1992 }, prefs: {}, days: HIST, currentDay: '2026-08-28', opts: { ...fx.opts, model: 'edwards' } });
  assert.ok(stagno.au > 0 && edwards.au > 0);
  assert.equal(stagno.cardioModel.name, 'stagno');
  assert.equal(edwards.cardioModel.name, 'edwards');
  // models genuinely differ on an interval day (Stagno's steeper curve)
  assert.notEqual(stagno.au, edwards.au);
});

test('score: determinism - identical inputs give identical envelopes', () => {
  const fx = loadFixture('tempo');
  const args = {
    samples: fx.samples,
    profile: { birthYear: 1992 },
    prefs: {},
    days: HIST,
    currentDay: '2026-08-28',
    activities: [{ id: 't', start: fx.opts.dayStartMs, end: fx.opts.dayEndMs }],
    opts: fx.opts,
  };
  const a = computeStrainV2(args);
  const b = computeStrainV2(args);
  assert.deepEqual(a, b);
});

test('score: uncorroborated high-motion lifting epochs do not score', () => {
  const fx = loadFixture('mixed-day');
  const out = computeStrainV2({
    samples: fx.samples,
    profile: { birthYear: 1992 },
    prefs: {},
    days: HIST,
    currentDay: '2026-08-28',
    opts: fx.opts,
  });
  // 30 min run + ~60 min rest scorable; 60 uncorroborated lifting min UNKNOWN
  assert.ok(out.scorableMinutes >= 80 && out.scorableMinutes <= 95,
    `scorable=${out.scorableMinutes}`);
  assert.ok(out.au > 0);
});

test('score: acute resting HR deviation is context, never load weighting', () => {
  const fx = loadFixture('walking');
  const base = computeStrainV2({ samples: fx.samples, profile: { birthYear: 1992 }, prefs: {}, days: HIST, currentDay: '2026-08-28', opts: fx.opts });
  const acute = computeStrainV2({ samples: fx.samples, profile: { birthYear: 1992 }, prefs: {}, days: HIST, currentDay: '2026-08-28', acuteRestingHr: 70, opts: fx.opts });
  assert.equal(acute.au, base.au);
  assert.ok(acute.acuteRestingHrDelta > 0);
  assert.equal(base.acuteRestingHrDelta, null);
});

test('score: default scale notes appear when history is absent', () => {
  const fx = loadFixture('walking');
  const out = computeStrainV2({
    samples: fx.samples,
    profile: { birthYear: 1992 },
    prefs: {},
    days: [],
    currentDay: '2026-08-28',
    opts: fx.opts,
  });
  assert.ok(out.notes.includes('rhr_population_default'));
  // default model (banister, WEEE-evidence-backed) is nonzero on walking days
  assert.ok(out.au > 0);
  assert.equal(DEFAULT_MODEL, 'banister');
});
