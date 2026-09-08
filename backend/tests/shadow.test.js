
import test from 'node:test';
import assert from 'node:assert/strict';
import { runShadow, createVersionRegistry, inputsHash } from '../energy/shadow.js';

test('shadow records both estimates with shared provenance and a comparison', () => {
  const samples = [{ t: '2026-08-24T15:00:00Z', bpm: 60 }, { t: '2026-08-24T15:00:04Z', bpm: 60 }];
  const perf = (i) => ({ minutes: [{ minute_at: 'x', resting_kcal: 1, active_kcal: 0.5 }], stats: { skipped: 0 } });
  const cand = (i) => ({ minutes: [{ minute_at: 'x', resting_kcal: 1, active_kcal: 0.9 }], stats: { skipped: 0 } });
  const r = runShadow({ production: perf, candidate: cand, inputs: { samples }, modelVersion: 'v1', candidateVersion: 'v2' });
  assert.equal(r.model_version, 'v1');
  assert.equal(r.candidate_version, 'v2');
  assert.ok(r.inputs_hash.length === 16);
  assert.equal(r.production.total_kcal, 1.5);
  assert.equal(r.candidate.total_kcal, 1.9);
  assert.equal(r.comparison.delta_kcal, 0.4);
});

test('version registry supports activate and rollback deterministically', () => {
  const reg = createVersionRegistry({ active: 'prod' });
  assert.equal(reg.active(), 'prod');
  reg.activate('cand-v2');
  assert.equal(reg.active(), 'cand-v2');
  const rolled = reg.rollback();
  assert.equal(rolled, 'prod');
  assert.equal(reg.active(), 'prod');
  // rollback again returns undefined (no earlier version)
  assert.equal(reg.rollback(), undefined);
});

test('inputsHash is stable for the same inputs and version', () => {
  const s = [{ t: 'a', bpm: 1 }, { t: 'b', bpm: 2 }];
  assert.equal(inputsHash(s, { v: 1 }), inputsHash(s, { v: 1 }));
  assert.ok(inputsHash(s, { v: 1 }) !== inputsHash(s, { v: 2 }));
});
