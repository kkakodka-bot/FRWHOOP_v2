import test from 'node:test';
import assert from 'node:assert/strict';
import { smoothActivityFilter, smoothActivityFull, transitionMatrix } from '../energy/smoothing.js';
import { ACTIVITY } from '../energy/constants.js';

test('filtered smoothing removes a single-minute flicker', () => {
  // 20 walking minutes with a single anomalous "running" minute in the middle.
  const minutes = Array.from({ length: 20 }, (_, i) => ({
    activity: i === 10 ? ACTIVITY.RUNNING : ACTIVITY.WALKING,
    confidence: i === 10 ? 0.9 : 0.6,
  }));
  const out = smoothActivityFilter(minutes);
  assert.equal(out[10].activity, ACTIVITY.WALKING,
    `flicker minute should stay walking, got ${out[10].activity}`);
  // endpoints remain walking
  assert.equal(out[0].activity, ACTIVITY.WALKING);
  assert.equal(out[19].activity, ACTIVITY.WALKING);
  // posteriors sum to 1
  assert.ok(Math.abs(out[5].probs.reduce((a, b) => a + b, 0) - 1) < 1e-3);
});

test('a sustained class change is followed (not swallowed)', () => {
  // 15 walking then 15 running.
  const minutes = Array.from({ length: 30 }, (_, i) => ({
    activity: i < 15 ? ACTIVITY.WALKING : ACTIVITY.RUNNING,
    confidence: 0.8,
  }));
  const out = smoothActivityFilter(minutes);
  assert.equal(out[0].activity, ACTIVITY.WALKING);
  assert.equal(out[29].activity, ACTIVITY.RUNNING,
    `final should be running, got ${out[29].activity}`);
});

test('sleep is heavily self-transient and resists becoming exercise', () => {
  const minutes = Array.from({ length: 20 }, (_, i) => ({
    activity: ACTIVITY.SLEEP, confidence: 0.9,
  }));
  // Inject a lone high-motion label, which sleep should reject.
  minutes.push({ activity: ACTIVITY.RUNNING, confidence: 0.95 });
  minutes.push({ activity: ACTIVITY.SLEEP, confidence: 0.9 });
  minutes.push({ activity: ACTIVITY.SLEEP, confidence: 0.9 });
  const out = smoothActivityFilter(minutes);
  // The inject-at-offset 20 minute should still read sleep (blocked transition).
  assert.equal(out[20].activity, ACTIVITY.SLEEP, `got ${out[20].activity}`);
});

test('transition matrix is row-normalized and has plausible structure', () => {
  const T = transitionMatrix();
  for (const row of T) {
    assert.ok(Math.abs(row.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  }
  // Diagonal (self-transition) should be the largest entry in each row.
  for (let i = 0; i < T.length; i++) {
    const self = T[i][i];
    for (let j = 0; j < T.length; j++) if (j !== i) assert.ok(self >= T[i][j]);
  }
});

test('full smoothing is available and bounded', () => {
  const minutes = Array.from({ length: 10 }, (_, i) => ({
    activity: ACTIVITY.STANDING, confidence: 0.5,
  }));
  const out = smoothActivityFull(minutes);
  assert.equal(out.length, 10);
  for (const o of out) assert.ok(o.confidence >= 0 && o.confidence <= 1);
});
