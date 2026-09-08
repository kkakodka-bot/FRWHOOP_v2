/**
 * Persisted-metric read path: seeded daily_metrics row → snapshot serializer
 * → frontend snapshotToWhoopDay → feature models. Does not change formulas.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { compactMetrics, snapshotToWhoopDay, snapshotsFromPersistedPayload, whoopDaysFromSnapshots } from '../metrics/snapshot.js';
import { dailyToWhoopDay } from '../metrics/engine.js';
import { snapshotToWhoopDay as frontendSnapshotToWhoopDay, spo2FromDay, rangeRowToSnapshot } from '../../frontend/src/lib/daySnapshotModel.js';
import { strainV2 } from '../../frontend/src/lib/strainV2Model.js';
import { strainCurve, overviewVo2Card } from '../../frontend/src/features/overview/overviewModel.js';
import { sleepHeroModel } from '../../frontend/src/features/sleep/sleepPageModel.js';

const DAY = '2026-08-24';

const STRAIN_POINTS = [
  { bucket_start: '2026-08-24T10:00:00.000Z', bucket_minutes: 5, au: 1.25, n: 12 },
  { bucket_start: '2026-08-24T10:05:00.000Z', bucket_minutes: 5, au: 2.5, n: 12 },
];

function seededRow(over = {}) {
  return {
    day: DAY,
    record_class: 'user',
    timezone_name: 'UTC',
    strain_score: 8.1,
    strain_score_v2: 12.4,
    strain_v2: { qualityState: 'HIGH', au: 148.7, algorithmVersion: 'frwhoop-strain-v2.0.0-shadow' },
    sleep_debt_balance_min: 47,
    sleep_consistency: 82,
    vo2max: 48.5,
    spo2_pct: null,
    extras: {
      spo2_candidate: { spo2_candidate_pct: 96, spo2_pct: null },
      spo2_candidate_series: [{ t: '2026-08-24T06:00:00.000Z', pct: 96 }],
    },
    ...over,
  };
}

function rpcSnapshot(row = seededRow()) {
  const metrics = compactMetrics(row);
  return {
    day: DAY,
    metrics,
    strain_series: STRAIN_POINTS,
    spo2_candidate_series: metrics.spo2_candidate_series || [],
    spo2_candidate_pct: metrics.spo2_candidate_pct,
    spo2_source: metrics.spo2_source,
    sleep: [],
    sessions: [],
    chart: [],
  };
}

function contractFields(day) {
  const p = day?.physiological_summary || {};
  return {
    debt: p['Sleep debt (min)'],
    consistency: p['Sleep consistency %'],
    vo2: p['VO2 Max'],
    strainV1: p['Day Strain'],
    strainV2: p['Day Strain V2'],
    spo2Canonical: p['Blood oxygen %'],
    spo2Candidate: day?.spo2_candidate_pct ?? null,
    strainSeries: day?.strain_series || [],
  };
}

test('seeded row → snapshot → WhoopDay → feature models', () => {
  const snap = rpcSnapshot();
  const backend = snapshotToWhoopDay(snap);
  const frontend = frontendSnapshotToWhoopDay(snap);
  const be = contractFields(backend);
  const fe = contractFields(frontend);
  assert.deepEqual(fe, be, '/api/days serializer and RPC mapper must agree');
  assert.equal(fe.debt, 47);
  assert.equal(fe.consistency, 82);
  assert.equal(fe.vo2, 48.5);
  assert.equal(fe.strainV1, 8.1);
  assert.equal(fe.strainV2, 12.4);
  assert.equal(fe.spo2Canonical, null);
  assert.equal(fe.spo2Candidate, 96);
  assert.deepEqual(fe.strainSeries, STRAIN_POINTS);

  const spo2 = spo2FromDay(frontend);
  assert.equal(spo2.pct, 96);
  assert.equal(spo2.experimental, true);
  assert.equal(spo2.source, 'whoop_v18_candidate');

  const v2 = strainV2(frontend);
  assert.equal(v2.v2.score, 12.4);
  assert.equal(frontend.physiological_summary['Day Strain'], 8.1, 'V2 must not replace V1');

  const hero = sleepHeroModel({ [DAY]: frontend }, DAY);
  assert.equal(hero.debtText, '47m');
  assert.equal(hero.spo2, 96);
  assert.equal(hero.spo2Experimental, true);

  const curve = strainCurve(frontend, 10);
  assert.equal(curve.hasSeries, true);
  const slot = Math.floor((new Date('2026-08-24T10:00:00.000Z').getHours() * 60
    + new Date('2026-08-24T10:00:00.000Z').getMinutes()) / 10) * 10;
  assert.equal(curve.points.find((p) => p.minute === slot).value, 3.8);

  const vo2 = overviewVo2Card({ [DAY]: frontend }, DAY);
  assert.equal(vo2.value, 49);
});

test('null stays null and candidate never becomes canonical SpO2', () => {
  const row = seededRow({
    sleep_debt_balance_min: null,
    sleep_consistency: null,
    vo2max: null,
    strain_score_v2: null,
    strain_v2: null,
    extras: { spo2_candidate: { spo2_candidate_pct: 93, spo2_pct: null } },
    spo2_pct: null,
    strain_score: 4.4,
  });
  const day = frontendSnapshotToWhoopDay(rpcSnapshot(row));
  assert.equal(day.physiological_summary['Sleep debt (min)'], null);
  assert.equal(day.physiological_summary['Sleep consistency %'], null);
  assert.equal(day.physiological_summary['VO2 Max'], null);
  assert.equal(day.physiological_summary['Day Strain V2'], null);
  assert.equal(day.physiological_summary['Day Strain'], 4.4);
  assert.equal(day.physiological_summary['Blood oxygen %'], null);
  assert.equal(day.spo2_candidate_pct, 93);
  assert.equal(spo2FromDay(day).experimental, true);
  assert.equal(strainV2(day).v2, null);
});

test('zero debt/consistency/V2 stay zero; missing strain_series falls back', () => {
  const day = frontendSnapshotToWhoopDay({
    metrics: {
      sleep_debt_balance_min: 0,
      sleep_consistency: 0,
      strain_score: 0,
      strain_score_v2: 0,
      vo2max: 0,
    },
    strain_series: [],
  });
  assert.equal(day.physiological_summary['Sleep debt (min)'], 0);
  assert.equal(day.physiological_summary['Sleep consistency %'], 0);
  assert.equal(day.physiological_summary['Day Strain'], 0);
  assert.equal(day.physiological_summary['Day Strain V2'], 0);
  assert.equal(day.physiological_summary['VO2 Max'], 0);
  assert.deepEqual(day.strain_series, []);
  const emptyCurve = strainCurve(day, 10);
  assert.equal(emptyCurve.hasSeries, false);
});

test('get_range compact row maps the same scalars as a full snapshot', () => {
  const range = rangeRowToSnapshot({
    day: DAY,
    strain_score: 8.1,
    strain_score_v2: 12.4,
    sleep_debt_balance_min: 47,
    sleep_consistency: 82,
    vo2max: 48.5,
    spo2_candidate_pct: 96,
  });
  const fromRange = frontendSnapshotToWhoopDay(range);
  const fromSnap = frontendSnapshotToWhoopDay(rpcSnapshot());
  assert.equal(fromRange.physiological_summary['Sleep debt (min)'], fromSnap.physiological_summary['Sleep debt (min)']);
  assert.equal(fromRange.physiological_summary['Sleep consistency %'], fromSnap.physiological_summary['Sleep consistency %']);
  assert.equal(fromRange.physiological_summary['VO2 Max'], fromSnap.physiological_summary['VO2 Max']);
  assert.equal(fromRange.physiological_summary['Day Strain V2'], fromSnap.physiological_summary['Day Strain V2']);
  assert.equal(fromRange.physiological_summary['Day Strain'], fromSnap.physiological_summary['Day Strain']);
  assert.equal(fromRange.spo2_candidate_pct, fromSnap.spo2_candidate_pct);
  assert.equal(fromRange.strain_series.length, 0, 'range must not carry strain_series blobs');
});

test('/api/days payload and RPC snapshot agree after compactMetrics', () => {
  const row = seededRow();
  const payload = {
    daily_metrics: [row],
    daily_physiology_series: [{ day: DAY, hr_series: [], strain_series: STRAIN_POINTS }],
    sleep_details: [],
    sessions: [],
  };
  const fromApi = whoopDaysFromSnapshots(snapshotsFromPersistedPayload(payload))[DAY];
  const fromRpc = frontendSnapshotToWhoopDay(rpcSnapshot(row));
  assert.deepEqual(contractFields(fromApi), contractFields(fromRpc));
  assert.equal(dailyToWhoopDay(compactMetrics(row)).physiological_summary['Day Strain V2'], 12.4);
});
