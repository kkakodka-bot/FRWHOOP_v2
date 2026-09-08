import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateVo2Estimates, metricsFromPairs, parsePhysioNetCpet, subjectLevelSplit,
} from '../vo2/validation.js';
import { syntheticCpetRows } from '../vo2/fixtures.js';
import { RESEARCH_TABLE } from '../vo2/research.js';

test('validation metrics are finite on synthetic paired estimates', () => {
  const rows = syntheticCpetRows();
  const m = metricsFromPairs(rows.map((r) => r.predicted), rows.map((r) => r.actual));
  assert.ok(m.n >= 4);
  assert.ok(m.mae > 0 && m.mae < 5);
  assert.ok(m.rmse >= m.mae);
  assert.ok(Number.isFinite(m.bias));
  const report = evaluateVo2Estimates(rows);
  assert.ok(report.byTier.PASSIVE || report.byTier.GPS_AUGMENTED);
  assert.equal(report.whoopPublishedMae.gps, 3.7);
});

test('subject-level split never fragments one participant across train and test', () => {
  const rows = syntheticCpetRows();
  const split = subjectLevelSplit(rows, { trainFraction: 0.5, seed: 3 });
  const trainIds = new Set(split.train.map((r) => r.subjectId));
  const testIds = new Set(split.test.map((r) => r.subjectId));
  for (const id of trainIds) assert.equal(testIds.has(id), false);
});

test('PhysioNet parser is a no-op when the restricted dump is absent', () => {
  assert.equal(parsePhysioNetCpet('/tmp/frwhoop-missing-cpet'), null);
});

test('research table cites Uth, Tanaka, Jackson, ACSM, and WHOOP public MAE', () => {
  const blob = JSON.stringify(RESEARCH_TABLE);
  assert.match(blob, /Uth/);
  assert.match(blob, /Tanaka/);
  assert.match(blob, /Jackson/);
  assert.match(blob, /ACSM/);
  assert.match(blob, /3\.7/);
});
