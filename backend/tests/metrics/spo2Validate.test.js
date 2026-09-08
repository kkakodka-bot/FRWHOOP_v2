import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  importWhoopSpo2References,
  importWhoopApiCycle,
  importPulseOx,
  toWhoopSpo2Reference,
} from '../../metrics/spo2Reference.js';
import {
  pairObservationToWhoopCycles,
  candidateAggregates,
  compareOfficialSpo2,
  chooseLagOnDiscovery,
  evaluatePulseOx,
  deviceCensus,
  finalEvidenceStatus,
} from '../../metrics/spo2Validate.js';
import { summarizeSpo2Observations, annotateSpo2Identity } from '../../protocol/spo2.js';
import { extrasFromSpo2Summary, summarizeSpo2Candidate } from '../../metrics/spo2.js';
import { applyDailyMetricsPersist } from '../../metrics/canonicalRegistry.js';
import { whoopDeviceId } from '../../storage/keys.js';

const T0 = 1_700_000_000;

function obs(over = {}) {
  return annotateSpo2Identity({
    spo2_raw_byte: over.raw ?? 96,
    spo2_candidate_pct: (over.state ?? 'candidate') === 'candidate' ? (over.raw ?? 96) : null,
    spo2_state: over.state ?? 'candidate',
    sensor_timestamp: over.t ?? T0,
    device_id: over.device ?? 'dev-a',
    user_id: over.user ?? 'user-a',
    firmware: over.firmware ?? '50.35.2.0',
    sleep_state: over.sleep ?? 2,
    source_frame_hash: over.hash || `h${over.t ?? T0}`,
  });
}

function burst(start, n, extra = {}) {
  return Array.from({ length: n }, (_, i) => obs({ t: start + i, ...extra }));
}

test('1 SCORED recovery with spo2_percentage is a reference', () => {
  const ref = importWhoopApiCycle({
    id: 'cyc-1',
    start: '2026-08-23T16:00:00.000Z',
    end: '2026-08-24T16:00:00.000Z',
    recovery: { score_state: 'SCORED', score: { spo2_percentage: 97.4 } },
  });
  assert.equal(ref.official_spo2_pct, 97.4);
  assert.equal(ref.score_state, 'SCORED');
  assert.equal(ref.source, 'api');
});

test('2 PENDING_SCORE does not provide official SpO2', () => {
  const ref = importWhoopApiCycle({
    id: 'cyc-p',
    start: '2026-08-23T16:00:00.000Z',
    end: '2026-08-24T16:00:00.000Z',
    recovery: { score_state: 'PENDING_SCORE', score: { spo2_percentage: 97 } },
  });
  assert.equal(ref.official_spo2_pct, null);
  assert.notEqual(ref.official_spo2_pct, 0);
});

test('3 UNSCORABLE does not provide official SpO2', () => {
  const ref = importWhoopApiCycle({
    id: 'cyc-u',
    start: '2026-08-23T16:00:00.000Z',
    end: '2026-08-24T16:00:00.000Z',
    recovery: { score_state: 'UNSCORABLE', score: { spo2_percentage: 91 } },
  });
  assert.equal(ref.official_spo2_pct, null);
});

test('4 missing Recovery / missing spo2_percentage stays null', () => {
  const noRecovery = importWhoopApiCycle({
    id: 'cyc-m',
    start: '2026-08-23T16:00:00.000Z',
    end: '2026-08-24T16:00:00.000Z',
  });
  assert.equal(noRecovery.official_spo2_pct, null);
  const scoredMissing = importWhoopApiCycle({
    id: 'cyc-m2',
    start: '2026-08-23T16:00:00.000Z',
    end: '2026-08-24T16:00:00.000Z',
    recovery: { score_state: 'SCORED', score: {} },
  });
  assert.equal(scoredMissing.official_spo2_pct, null);
  const zero = toWhoopSpo2Reference({
    cycle_start: '2026-08-23T16:00:00.000Z',
    cycle_end: '2026-08-24T16:00:00.000Z',
    score_state: 'SCORED',
    spo2_percentage: 0,
  }, { source: 'api' });
  assert.equal(zero.official_spo2_pct, null);
});

test('5 cycle timestamp pairing is half-open, not date pairing', () => {
  const refs = importWhoopSpo2References([{
    cycle_id: 'c1',
    cycle_start: '2026-08-23T16:00:00.000Z',
    cycle_end: '2026-08-24T16:00:00.000Z',
    score_state: 'SCORED',
    spo2_percentage: 96,
  }]);
  const start = Date.parse('2026-08-23T16:00:00.000Z') / 1000;
  const end = Date.parse('2026-08-24T16:00:00.000Z') / 1000;
  const inside = pairObservationToWhoopCycles(obs({ t: start }), refs);
  const last = pairObservationToWhoopCycles(obs({ t: end - 1 }), refs);
  const boundary = pairObservationToWhoopCycles(obs({ t: end }), refs);
  assert.equal(inside.pairing, 'matched');
  assert.equal(inside.whoop_cycle_id, 'c1');
  assert.equal(last.pairing, 'matched');
  assert.equal(boundary.pairing, 'no_matching_whoop_cycle');
  assert.equal(boundary.whoop_cycle_id, null);
  assert.equal(boundary.official_spo2_pct, null);
});

test('6 nearest calendar-day overlap is not a forced match', () => {
  const refs = [{
    cycle_id: 'later',
    cycle_start: Date.parse('2026-08-24T16:00:00.000Z') / 1000,
    cycle_end: Date.parse('2026-08-25T16:00:00.000Z') / 1000,
    cycle_start_iso: '2026-08-24T16:00:00.000Z',
    cycle_end_iso: '2026-08-25T16:00:00.000Z',
    official_spo2_pct: 98,
    score_state: 'SCORED',
  }];
  const sameDateOutside = obs({ t: Date.parse('2026-08-24T02:00:00.000Z') / 1000 });
  const paired = pairObservationToWhoopCycles(sameDateOutside, refs);
  assert.equal(paired.pairing, 'no_matching_whoop_cycle');
  const compared = compareOfficialSpo2({ observations: [sameDateOutside], references: refs });
  assert.ok(compared.issues.some((i) => i.kind === 'date_only_overlap_not_used'));
});

test('7 mean of window means remains the product formula', () => {
  const rows = [
    ...burst(T0, 2, { raw: 90 }),
    ...burst(T0 + 20, 20, { raw: 100 }),
  ];
  const product = summarizeSpo2Observations(rows);
  const agg = candidateAggregates(rows);
  assert.equal(agg.A, 95);
  assert.equal(agg.A, product.mean);
  assert.notEqual(agg.A, agg.D);
  assert.equal(agg.D, (90 * 2 + 100 * 20) / 22);
});

test('24 pulse-ox importer preserves raw timestamps', () => {
  const csv = 'timestamp,spo2,pulse\n2026-08-24T07:00:15.123Z,96,58\n2026-08-24T07:00:16Z,97,59\n';
  const rows = importPulseOx(csv);
  assert.equal(rows[0].timestamp_raw, '2026-08-24T07:00:15.123Z');
  assert.equal(rows[0].timestamp, Math.floor(Date.parse('2026-08-24T07:00:15.123Z') / 1000));
  assert.equal(rows[1].timestamp_raw, '2026-08-24T07:00:16Z');
});

test('25 lag chosen on discovery nights is not optimized on holdout', () => {
  const windows = [
    { start_unix: 100, end_unix: 129, start: 'a', end: 'a2', window_value: 95 },
    { start_unix: 1100, end_unix: 1129, start: 'b', end: 'b2', window_value: 96 },
    { start_unix: 2100, end_unix: 2129, start: 'c', end: 'c2', window_value: 97 },
    { start_unix: 3100, end_unix: 3129, start: 'd', end: 'd2', window_value: 98 },
  ];
  const pulse = [];
  for (const w of windows.slice(0, 3)) {
    for (let t = w.start_unix + 10; t <= w.end_unix + 10; t += 1) pulse.push({ timestamp: t, spo2_pct: w.window_value });
  }
  for (let t = 3150; t <= 3179; t += 1) pulse.push({ timestamp: t, spo2_pct: 98 });
  const chosen = chooseLagOnDiscovery(windows, pulse, { lags: [-50, 0, 10, 50], minSamples: 25 });
  assert.equal(chosen.lag_s, 10);
  const holdout = evaluatePulseOx({
    windows: [windows[3]],
    pulseSamples: pulse,
    frozenLagS: chosen.lag_s,
    minSamples: 3,
  });
  assert.equal(holdout.frozen_lag_s, 10);
  assert.equal(holdout.zero_lag.n, 0);
});

test('26 source aliases cannot count as independent straps', () => {
  const local = '7f2c9a10-4b3e-4d8a-9c11-00000000f001';
  const jwt = '9f33375b-e029-480f-9ebb-a99e5ff22ac9';
  const census = deviceCensus([
    obs({ device: whoopDeviceId(local, 'strap'), user: local }),
    obs({ t: T0 + 1, device: whoopDeviceId(jwt, 'strap'), user: jwt }),
  ]);
  assert.equal(census.confirmed_device_count, 0);
  assert.equal(census.n_devices, 0);
  assert.notEqual(census.confirmed_device_count, 2);
});

test('27 new validation path cannot write canonical spo2_pct', () => {
  const rows = burst(T0, 5, { raw: 96 });
  const compared = compareOfficialSpo2({
    observations: rows,
    references: [{
      cycle_id: 'c',
      cycle_start: T0 - 10,
      cycle_end: T0 + 100,
      cycle_start_iso: new Date((T0 - 10) * 1000).toISOString(),
      cycle_end_iso: new Date((T0 + 100) * 1000).toISOString(),
      official_spo2_pct: 97,
      score_state: 'SCORED',
    }],
  });
  assert.equal(compared.spo2_pct, null);
  const summary = summarizeSpo2Candidate(rows.map((o) => ({
    sensor_ts: o.sensor_timestamp,
    spo2_raw_byte: o.spo2_raw_byte,
    spo2_state: o.spo2_state,
    spo2_candidate_pct: o.spo2_candidate_pct,
    source_frame_hash: o.source_frame_hash,
  })));
  const extras = extrasFromSpo2Summary(summary, summary.series);
  assert.equal(extras.spo2_candidate.spo2_pct, null);
  assert.equal(applyDailyMetricsPersist({}, extras).spo2_pct, undefined);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(here, '../..');
  for (const rel of [
    'metrics/spo2Validate.js',
    'metrics/spo2Reference.js',
    'protocol/spo2Validity.js',
    'protocol/spo2Probe.js',
    'bin/validate-spo2.mjs',
  ]) {
    const src = readFileSync(path.join(root, rel), 'utf8');
    assert.doesNotMatch(src, /applyDailyMetricsPersist\(/);
    assert.doesNotMatch(src, /\bspo2_pct:\s*[1-9]/);
  }
  assert.equal(finalEvidenceStatus({ n_cycles: 0 }), 'DECODE_ONLY');
  assert.notEqual(finalEvidenceStatus({}), 'PROMOTED');
});
