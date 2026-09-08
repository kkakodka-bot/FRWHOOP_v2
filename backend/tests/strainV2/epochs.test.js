import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCanonicalEpochs } from '../../metrics/strainV2/epochs.js';
import { EPOCH_MS } from '../../metrics/strainV2/constants.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'epochs');
// Fixture base timestamp must match fixtures/epochs/*.json exactly.
const BASE0 = 1787460000000;

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
}

function score(name) {
  const fx = loadFixture(name);
  return { fx, ...buildCanonicalEpochs(fx) };
}

test('epochs: rest day is fully scorable at rest intensity', () => {
  const { epochs, dayStats } = score('rest-day');
  assert.equal(epochs.length, 180);
  assert.ok(dayStats.scorableMinutes >= 170, `scorable=${dayStats.scorableMinutes}`);
  assert.equal(dayStats.state, 'HIGH');
  const hr = epochs.map((e) => e.hr);
  assert.ok(Math.min(...hr) >= 45 && Math.max(...hr) <= 60);
  for (const e of epochs) assert.ok(e.hrrFrac !== null);
});

test('epochs: duplicate timestamps cannot increase scorable duration', () => {
  const fx = loadFixture('walking');
  const base = buildCanonicalEpochs(fx);
  const doubled = buildCanonicalEpochs({ ...fx, samples: fx.samples.flatMap((s) => [s, { ...s }]) });
  assert.equal(base.dayStats.scorableMinutes, doubled.dayStats.scorableMinutes);
  assert.equal(base.dayStats.duplicatesRemoved, 0);
  assert.ok(doubled.dayStats.duplicatesRemoved > 0);
});

test('epochs: packet frequency alone cannot change scorable duration', () => {
  const fx = loadFixture('walking');
  const at1Hz = buildCanonicalEpochs(fx);
  const at4s = buildCanonicalEpochs({ ...fx, samples: fx.samples.filter((s, i) => i % 4 === 0) });
  assert.equal(at1Hz.dayStats.scorableMinutes, at4s.dayStats.scorableMinutes);
  const scorable = (r) => r.epochs.filter((e) => e.quality !== 'UNKNOWN');
  const mean = (r) => scorable(r).reduce((a, e) => a + e.hrrFrac, 0) / scorable(r).length;
  assert.ok(Math.abs(mean(at1Hz) - mean(at4s)) < 0.02);
});

test('epochs: gaps receive no invented duration (unknown, never sedentary)', () => {
  const { epochs, dayStats } = score('disconnects');
  assert.ok(dayStats.scorableMinutes <= 60, `scorable=${dayStats.scorableMinutes}`);
  const gapEpochs = epochs.filter((e) => e.t >= BASE0 + 25 * EPOCH_MS && e.t < BASE0 + 135 * EPOCH_MS);
  assert.ok(gapEpochs.length > 0);
  for (const e of gapEpochs) {
    assert.equal(e.hr, null);
    assert.equal(e.quality, 'UNKNOWN');
    assert.equal(e.hrrFrac, null);
  }
  assert.ok(dayStats.gaps.length >= 1);
});

test('epochs: final observation receives no invented tail duration', () => {
  const fx = loadFixture('walking');
  const extended = buildCanonicalEpochs({ ...fx, opts: { ...fx.opts, dayEndMs: fx.opts.dayEndMs + 30 * EPOCH_MS } });
  const base = buildCanonicalEpochs(fx);
  assert.equal(base.dayStats.scorableMinutes, extended.dayStats.scorableMinutes);
  const lastSampleMin = Math.floor(Math.max(...fx.samples.map((s) => s.t)) / EPOCH_MS) * EPOCH_MS;
  for (const e of extended.epochs) {
    if (e.t > lastSampleMin) assert.equal(e.quality, 'UNKNOWN');
  }
});

test('epochs: implausible HR cannot create load-relevant epochs', () => {
  const { epochs, dayStats } = score('hr-spikes');
  for (const e of epochs) {
    if (e.hr != null) assert.ok(e.hr >= 25 && e.hr <= 230);
  }
  // the 220-bpm relock minute: either quarantined or flagged, never trusted
  const spikeT = BASE0 + 20 * EPOCH_MS;
  const e = epochs.find((x) => x.t === spikeT);
  assert.ok(e, 'spike minute must produce an epoch');
  const trusted = e.quality !== 'UNKNOWN' && !e.flags.includes('hr_jumps') && !e.flags.includes('hr_unstable');
  assert.equal(trusted, false, `spike epoch trusted: ${e.quality} ${e.flags}`);
});

test('epochs: no data -> INSUFFICIENT, never a zero-strain-shaped output', () => {
  const fx = loadFixture('walking');
  const { epochs, dayStats } = buildCanonicalEpochs({ ...fx, samples: [] });
  assert.deepEqual(epochs, []);
  assert.equal(dayStats.scorableMinutes, 0);
  assert.equal(dayStats.coveragePct, 0);
  assert.equal(dayStats.state, 'INSUFFICIENT');
});

test('epochs: uncorroborated high-motion epochs cannot create strain', () => {
  const { epochs } = score('mixed-day');
  // lifting window: HR ~108-112 with motion 0.5-1.0; neighbors are a run ~155
  // (before) and rest ~60 (after): no clean neighbor within 10 bpm.
  const lift = epochs.filter((e) => e.t >= BASE0 + 45 * EPOCH_MS && e.t < BASE0 + 105 * EPOCH_MS);
  assert.ok(lift.length > 50);
  let flagged = 0;
  for (const e of lift) {
    if (e.flags.includes('high_motion')) {
      flagged += 1;
      assert.ok(e.quality === 'UNKNOWN' || e.flags.includes('motion_uncorroborated') || e.flags.includes('motion_corroborated'));
      if (e.flags.includes('motion_uncorroborated')) assert.equal(e.quality, 'UNKNOWN');
    }
  }
  assert.ok(flagged > 40, `high-motion flagged epochs: ${flagged}`);
});

test('epochs: determinism - identical input yields identical output', () => {
  const fx = loadFixture('intervals-recovery');
  const a = buildCanonicalEpochs(fx);
  const b = buildCanonicalEpochs(fx);
  assert.deepEqual(a.epochs, b.epochs);
  assert.deepEqual(a.dayStats, b.dayStats);
});

test('epochs: hrrFrac respects the resolved profile and stays in [0,1]', () => {
  const fx = loadFixture('rest-day');
  const { epochs } = buildCanonicalEpochs(fx);
  const p = fx.profile;
  for (const e of epochs) {
    const expected = Math.max(0, (e.hr - p.restingHr) / Math.max(p.hrMax - p.restingHr, 20));
    assert.ok(Math.abs(e.hrrFrac - expected) < 0.001, `${e.hrrFrac} vs ${expected}`);
    assert.ok(e.hrrFrac >= 0 && e.hrrFrac <= 1);
  }
});

test('epochs: sparse 8 s cadence scores the SAME scorable minutes as 1 Hz', () => {
  const sparse = score('sparse');
  const walking = score('walking');
  // Time-coverage semantics: a uniform 8 s cadence represents each epoch as
  // fully as 1 Hz (8 samples x 8 s >= 60 s of wall clock). Load must not
  // depend on packet frequency: both sessions are 60 scorable minutes.
  // Each session scores its own true wall-clock duration as scorable minutes:
  // 60 min at 8 s cadence == 60 min; 45 min at 1 Hz == 45 min.
  assert.equal(sparse.dayStats.scorableMinutes, 60);
  assert.equal(walking.dayStats.scorableMinutes, 45);
  assert.equal(sparse.dayStats.state, 'MODERATE'); // 60 of 120-min fixture window
  assert.equal(sparse.dayStats.expectedSamplesPerEpoch, 8); // 8 s observed cadence, honestly reported
});

test('epochs: timestamp corruption is quarantined, not fatal', () => {
  const { epochs, dayStats } = score('timestamp-corruption');
  for (const e of epochs) {
    if (e.hr != null) assert.ok(e.hr >= 25 && e.hr <= 230);
  }
  assert.ok(dayStats.scorableMinutes >= 25);
  assert.ok(dayStats.outOfRangeDropped >= 2);
});

test('epochs: interval structure survives canonicalization', () => {
  const { epochs } = score('intervals-recovery');
  const hard = epochs.filter((e) => e.hr != null && e.hr >= 160);
  const easy = epochs.filter((e) => e.hr != null && e.hr <= 120);
  assert.ok(hard.length >= 20);
  assert.ok(easy.length >= 12);
  const meanHrr = (es) => es.reduce((a, e) => a + e.hrrFrac, 0) / es.length;
  assert.ok(meanHrr(hard) > meanHrr(easy) + 0.2);
});

test('epochs: long zone2 day scores above tempo-free rest but below tempo day per minute', () => {
  const z2 = score('long-zone2');
  const tempo = score('tempo');
  const meanHrr = (r) => {
    const s = r.epochs.filter((e) => e.quality !== 'UNKNOWN');
    return s.reduce((a, e) => a + e.hrrFrac, 0) / s.length;
  };
  assert.ok(meanHrr(tempo) > meanHrr(z2));
  assert.equal(z2.dayStats.scorableMinutes >= 80, true);
});
