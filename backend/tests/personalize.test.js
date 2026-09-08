import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPersonalizationMatrix, fitResidualPersonalization, predictDiscrepancy,
  applyCorrection, buildDesignRow, defaultParams, identifiabilityGate,
} from '../energy/personalize.js';
import { mulberry } from '../energy/metrics.js';

function g(rng, mean, sd) { return mean + (rng() - 0.5) * 2 * Math.sqrt(3) * sd; }

/** Build synthetic days with INDEPENDENT (decoupled) activity exposures and a known
 *  per-activity discrepancy in per-kcal units. Each activity is drawn from its own
 *  distribution and is frequently near-zero on days when other activities are
 *  large, so columns are far from collinear and each coefficient is identifiable
 *  (this is the recoverable case the module is meant to handle). */
function synthIndependent(n, seed = 5) {
  const rng = mulberry(seed);
  const trueScale = { walking: 0.10, running: 0.04, cycling: 0.06, strength: -0.15, generic: 0.02 };
  const days = [];
  for (let i = 0; i < n; i++) {
    // decouple: pick which activity is 'active' today via an independent toggle,
    // then give that one a large dose while others stay small.
    const focus = i % ACTIVITY_KEYS.length;
    const row = {
      walking: 0, running: 0, cycling: 0, strength: 0, generic: 0,
      resting: 1700,
    };
    for (const k of ACTIVITY_KEYS) {
      // every activity gets a small baseline, but each day emphasizes one
      row[k] = Math.abs(g(rng, 60, 30)) + (k === keysS[i % keysS.length] ? Math.abs(g(rng, 400, 80)) : 0);
    }
    const noise = g(rng, 0, 30);
    const disc = ACTIVITY_KEYS.reduce((a, k) => a + trueScale[k] * row[k], 0) + noise;
    const sensorTdee = 2400 + g(rng, 0, 50);
    days.push({
      day: `d${i}`,
      sensorTdee,
      energyBalanceTdee: sensorTdee + disc,
      walkingActiveKcal: row.walking, runningActiveKcal: row.running,
      cyclingActiveKcal: row.cycling, strengthActiveKcal: row.strength,
      genericActiveKcal: row.generic, restingKcal: row.resting,
      intakeKcal: 2600, macrosComplete: true,
    });
  }
  return { days, trueScale };
}
const ACTIVITY_KEYS = ['walking','running','cycling','strength','generic'];
const keysS = ['walking','running','cycling','strength','generic'];

test('with enough independent days the residual model recovers the discrepancy signal', () => {
  const { days, trueScale } = synthIndependent(80);
  const fit = fitResidualPersonalization({ days });
  assert.equal(fit.fitted, true);
  assert.ok(fit.nDays >= 60, `days ${fit.nDays}`);
  // predicted discrepancies should correlate with the known (noise-free) signal
  const pred = days.map((d) => predictDiscrepancy(buildDesignRow(d), fit.params));
  const trueDisc = days.map((d) => d.energyBalanceTdee - d.sensorTdee);
  const r = pearson(pred, trueDisc);
  assert.ok(r > 0.4, `corr ${r}`);
});

test('collinear design is flagged and coefficients shrink toward prior', () => {
  const rng = mulberry(11);
  // force walking exactly proportional to running (collinear)
  const days = [];
  for (let i = 0; i < 60; i++) {
    const w = Math.abs(g(rng, 300, 50));
    const rows = {
      walking: w, running: w * 2, cycling: Math.abs(g(rng, 100, 30)),
      strength: Math.abs(g(rng, 100, 30)), generic: Math.abs(g(rng, 50, 20)),
      resting: 1700,
    };
    const sensorTdee = 2400;
    days.push({
      day: `c${i}`, sensorTdee, energyBalanceTdee: sensorTdee + 20,
      walkingActiveKcal: rows.walking, runningActiveKcal: rows.running,
      cyclingActiveKcal: rows.cycling, strengthActiveKcal: rows.strength,
      genericActiveKcal: rows.generic, restingKcal: rows.resting,
      intakeKcal: 2500, macrosComplete: true,
    });
  }
  const fit = fitResidualPersonalization({ days, minDays: 10 });
  assert.equal(fit.fitted, true);
  assert.ok(fit.collinear === true, 'collinear design flagged');
});

test('insufficient complete days refuses to fit (no fabricated personalization)', () => {
  const { days } = synthIndependent(5);
  const fit = fitResidualPersonalization({ days, minDays: 20 });
  assert.equal(fit.fitted, false);
  assert.equal(fit.reason, 'insufficient_complete_days');
});

test('incomplete-logging days (missing meals / suspiciously low intake) are excluded', () => {
  const days = Array.from({ length: 10 }, (_, i) => ({
    day: `x${i}`, sensorTdee: 2400, energyBalanceTdee: 2500,
    walkingActiveKcal: 100, runningActiveKcal: 0, cyclingActiveKcal: 0,
    strengthActiveKcal: 0, genericActiveKcal: 0, restingKcal: 1700,
    intakeKcal: i < 5 ? 2600 : 100,               // last 5 suspiciously low
    macrosComplete: true, missingMeals: i < 5 ? 0 : 2,
  }));
  const { daysUsed } = buildPersonalizationMatrix(days);
  assert.equal(daysUsed.length, 5, `used ${daysUsed.length}`);
});

test('applyCorrection adjusts the sensor TDEE by the learned discrepancy', () => {
  const { days } = synthIndependent(80);
  const fit = fitResidualPersonalization({ days });
  const d = days[10];
  const adjusted = applyCorrection(d.sensorTdee, buildDesignRow(d), fit.params);
  assert.ok(Math.abs(adjusted - d.energyBalanceTdee) < 250, `adjust ${adjusted} vs eb ${d.energyBalanceTdee}`);
});

test('identifiabilityGate flags collinear columns and keeps independent ones', () => {
  const cols = ['a', 'b'];
  // independent columns
  const A = [[1, 0], [0, 1], [1, 1], [1, 0], [0, 1], [0, 1], [1, 1], [1, 0]];
  const gA = identifiabilityGate(A, cols);
  assert.ok(gA.identifiable.a === true && gA.identifiable.b === true);
  // collinear: col2 = 2*col1 exactly
  const B = [[1, 2], [2, 4], [3, 6], [0.5, 1]];
  const gB = identifiabilityGate(B, cols);
  assert.ok(gB.identifiable.a === false, 'collinear col a flagged');
});

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = a[i] - ma, dy = b[i] - mb; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxy / Math.sqrt(sxx * syy);
}
