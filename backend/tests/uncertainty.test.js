import test from 'node:test';
import assert from 'node:assert/strict';
import { conformalWidth, evaluateCoverage, adaptiveWidths } from '../energy/uncertainty.js';
import { mulberry } from '../energy/metrics.js';

/** Deterministic standard-normal via Box-Muller on the seeded RNG. */
function gaussian(rng) {
  const u1 = Math.max(rng(), 1e-12), u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function absNormalSamples(n, rng) {
  return Array.from({ length: n }, () => Math.abs(gaussian(rng)));
}

test('split-conformal width from |N(0,1)| residuals gives ~90% coverage on fresh |N(0,1)|', () => {
  const rng = mulberry(123);
  const calResid = absNormalSamples(400, rng);
  const q = conformalWidth(calResid, 0.10);
  assert.ok(q > 1.4 && q < 2.0, `width ${q}`);
  // fresh test residuals from the same distribution
  const yhat = absNormalSamples(2000, rng).map(() => 0);
  const y = absNormalSamples(2000, rng);
  const cov = evaluateCoverage({ yhat, y, widths: Array(2000).fill(q), nominalAlpha: 0.10 });
  assert.ok(cov.empirical_coverage >= 0.85 && cov.empirical_coverage <= 0.96,
    `coverage ${cov.empirical_coverage}`);
});

test('conformal interval is wider for a larger alpha-demand (95% > 90% width)', () => {
  const rng = mulberry(7);
  const res = absNormalSamples(300, rng);
  const q90 = conformalWidth(res, 0.10);
  const q95 = conformalWidth(res, 0.05);
  assert.ok(q95 > q90, `q95 ${q95} > q90 ${q90}`);
});

test('evaluateCoverage with a 100%-wide interval covers everything', () => {
  const cov = evaluateCoverage({ yhat: [1, 2, 3], y: [1.1, 2.1, 3.1], widths: [100, 100, 100], nominalAlpha: 0.10 });
  assert.equal(cov.empirical_coverage, 1);
});

test('evaluateCoverage with a 0-width interval covers only exact hits', () => {
  const cov = evaluateCoverage({ yhat: [1, 2, 3], y: [1, 2, 9], widths: [0, 0, 0], nominalAlpha: 0.10 });
  assert.ok(Math.abs(cov.empirical_coverage - 2 / 3) < 0.001, `cov ${cov.empirical_coverage}`);
});

test('adaptiveWidths scales the base width by relative per-point uncertainty', () => {
  const se = [1, 1, 1, 4, 4];
  const w = adaptiveWidths(2, se, { clampMin: 0.5, clampMax: 2.0 });
  // high-se points get up to 2x, low-se points down to 0.5x
  assert.ok(Math.max(...w) <= 4, `max width ${Math.max(...w)}`);
  assert.ok(se[3] > se[0] ? w[3] > w[0] : true, 'higher se -> wider');
});
