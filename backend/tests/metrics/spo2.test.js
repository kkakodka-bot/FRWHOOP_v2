import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSample, encodeArchive, decodeArchive } from '../../ingest/archiveFormat.js';
import { summarizeSpo2Candidate, spo2CandidateSeriesFromSamples } from '../../metrics/spo2.js';
import { applyCanonicalDay } from '../../healthkit/ingest.js';
import { SOURCES } from '../../healthkit/policy.js';
import { applyDailyMetricsPersist, metricRegistry, presentMetric } from '../../metrics/canonicalRegistry.js';
import { dailyToWhoopDay } from '../../metrics/engine.js';

test('missing SpO2 stays null and is never replaced with zero', () => {
  const row = normalizeSample({ t: '2026-08-24T18:00:00Z', bpm: 70 });
  assert.equal(row.spo2_candidate_pct, null);
  assert.equal(row.spo2_pct, undefined);
  const summary = summarizeSpo2Candidate([row]);
  assert.equal(summary.spo2_pct, null);
  assert.equal(summary.spo2_candidate_pct, null);
  assert.equal(presentMetric(summary.spo2_pct), null);
  assert.equal(presentMetric(null), null);
  assert.notEqual(presentMetric(null), 0);
});

test('candidate observations never populate canonical spo2_pct', () => {
  const samples = [{
    t: '2026-02-25T02:00:00Z',
    sensor_ts: 1740448800,
    bpm: 58,
    spo2_raw_byte: 96,
    spo2_state: 'candidate',
    spo2_candidate_pct: 96,
    source_frame_hash: 'ab'.repeat(32),
    layout: 'v18',
    decoder: 'frwhoop-whoop-ble/4',
    firmware: '50.35.0',
  }];
  const summary = summarizeSpo2Candidate(samples);
  assert.equal(summary.spo2_candidate_pct, 96);
  assert.equal(summary.spo2_pct, null);
  const persisted = applyDailyMetricsPersist({}, {
    spo2_candidate: { spo2_candidate_pct: summary.spo2_candidate_pct, spo2_pct: null },
  });
  assert.equal(persisted.spo2_pct, undefined);
  const day = dailyToWhoopDay({
    spo2_pct: null,
    extras: { spo2_candidate: { spo2_candidate_pct: 96, spo2_pct: null } },
  });
  assert.equal(day.physiological_summary['Blood oxygen %'], null);
  assert.equal(day.spo2_candidate_pct, 96);
  assert.equal(metricRegistry({}).spo2_candidate.status, 'shadow');
});

test('validated HealthKit SpO2 retains precedence over a missing strap spo2_pct', () => {
  const applied = applyCanonicalDay(
    { spo2_pct: null, extras: { spo2_candidate: { spo2_candidate_pct: 93, spo2_pct: null } } },
    { spo2: 98, spo2_source: SOURCES.APPLE_WATCH_HEALTHKIT },
  );
  assert.equal(applied.spo2_pct, 98);
  const strapWins = applyCanonicalDay(
    { spo2_pct: 97 },
    { spo2: 91, spo2_source: SOURCES.APPLE_WATCH_HEALTHKIT },
  );
  assert.equal(strapWins.spo2_pct, 97);
});

test('physiology archive round-trips candidate provenance and drops a 0 fill', () => {
  const encoded = encodeArchive([{
    t: '2026-02-25T02:00:00Z',
    bpm: 60,
    spo2_raw_byte: 95,
    source_frame_hash: 'cd'.repeat(32),
    firmware: '50.35.0',
  }]);
  const [row] = decodeArchive(encoded.body);
  assert.equal(row.spo2_raw_byte, 95);
  assert.equal(row.spo2_candidate_pct, 95);
  assert.equal(row.spo2_state, 'candidate');
  assert.equal(row.source_frame_hash, 'cd'.repeat(32));
  const series = spo2CandidateSeriesFromSamples([row]);
  assert.equal(series.length, 1);
  assert.equal(series[0].pct, 95);
  const sentinelOnly = encodeArchive([{ t: '2026-02-25T02:00:04Z', spo2_raw_byte: 0x80 }]);
  assert.equal(sentinelOnly.sample_count, 1);
  assert.equal(decodeArchive(sentinelOnly.body)[0].spo2_candidate_pct, null);
  assert.equal(decodeArchive(sentinelOnly.body)[0].spo2_state, 'sentinel');
});
