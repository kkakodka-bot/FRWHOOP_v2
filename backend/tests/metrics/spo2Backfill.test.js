import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeArchive, decodeArchive } from '../../ingest/archiveFormat.js';
import {
  summarizeSpo2Candidate,
  extrasFromSpo2Summary,
  overlaySpo2OnSamples,
  spo2CandidateSeriesFromSamples,
} from '../../metrics/spo2.js';
import { applySpo2CandidateBackfill, whoopDayFromSpo2Extras, mergeObservationPasses } from '../../metrics/spo2Backfill.js';
import { applyDailyMetricsPersist, metricRegistry } from '../../metrics/canonicalRegistry.js';
import { dailyToWhoopDay } from '../../metrics/engine.js';
import { observationsFromSamples } from '../../metrics/spo2.js';
import { detectMeasurementWindows } from '../../protocol/spo2.js';

const T0 = 1_788_000_000;

function sample(over = {}) {
  return {
    t: new Date((over.sensor_ts || T0) * 1000).toISOString(),
    sensor_ts: T0,
    bpm: 58,
    spo2_raw_byte: 96,
    spo2_state: 'candidate',
    spo2_candidate_pct: 96,
    source_frame_hash: 'ab'.repeat(32),
    layout: 'v18',
    decoder: 'frwhoop-js/2',
    firmware: '50.35.2.0',
    band_sleep_state: 2,
    user_id: '9f33375b-e029-480f-9ebb-a99e5ff22ac9',
    device_id: 'b4c6ae60-5afc-53d8-ac1c-f3a931dca7ba',
    ...over,
  };
}

test('historical B2 replay/backfill is idempotent', async () => {
  const patches = [];
  const db = {
    patchDailyExtras: async (userId, day, patch) => {
      patches.push({ userId, day, body: JSON.stringify(patch) });
      return { ok: true };
    },
  };
  const observations = observationsFromSamples([
    sample({ sensor_ts: T0, spo2_raw_byte: 96, source_frame_hash: '11'.repeat(32) }),
    sample({ sensor_ts: T0 + 1, spo2_raw_byte: 96, source_frame_hash: '22'.repeat(32) }),
  ]);
  const first = await applySpo2CandidateBackfill({
    observations,
    db,
    timeZone: 'UTC',
  });
  const second = await applySpo2CandidateBackfill({
    observations,
    db,
    timeZone: 'UTC',
  });
  assert.equal(first.count, second.count);
  assert.equal(patches.length, 2);
  assert.equal(patches[0].body, patches[1].body);
  assert.equal(first.days[0].spo2_pct, null);
  const merged = mergeObservationPasses(observations, observations);
  assert.equal(merged.inserted, 0);
  assert.equal(merged.duplicates, 2);
});

test('historical candidates reach the same day API shape as newly ingested candidates', () => {
  const samples = [
    sample({ sensor_ts: T0, spo2_raw_byte: 94 }),
    sample({ sensor_ts: T0 + 1, spo2_raw_byte: 96, source_frame_hash: 'cd'.repeat(32) }),
  ];
  const live = summarizeSpo2Candidate(samples, { day: new Date(T0 * 1000).toISOString().slice(0, 10), timeZone: 'UTC' });
  const extras = extrasFromSpo2Summary(live, live.series);
  const liveDay = dailyToWhoopDay({ spo2_pct: null, extras });
  const backfillDay = whoopDayFromSpo2Extras(extras);
  assert.equal(liveDay.spo2_candidate_pct, backfillDay.spo2_candidate_pct);
  assert.equal(liveDay.spo2_candidate_series.length, backfillDay.spo2_candidate_series.length);
  assert.equal(liveDay.physiological_summary['Blood oxygen %'], null);
  assert.equal(backfillDay.physiological_summary['Blood oxygen %'], null);
  assert.equal(extras.spo2_candidate.spo2_pct, null);
});

test('canonical spo2_pct remains impossible to populate from this candidate', () => {
  const summary = summarizeSpo2Candidate([sample()]);
  assert.equal(summary.spo2_pct, null);
  const extras = extrasFromSpo2Summary(summary, summary.series);
  assert.equal(extras.spo2_candidate.spo2_pct, null);
  const persisted = applyDailyMetricsPersist({}, {
    spo2_candidate: extras.spo2_candidate,
  });
  assert.equal(persisted.spo2_pct, undefined);
  const day = dailyToWhoopDay({ spo2_pct: 98, extras });
  assert.equal(day.physiological_summary['Blood oxygen %'], 98);
  const candidateOnly = dailyToWhoopDay({ spo2_pct: null, extras });
  assert.equal(candidateOnly.physiological_summary['Blood oxygen %'], null);
  assert.equal(metricRegistry({}).spo2_candidate.status, 'shadow');
  assert.equal(overlaySpo2OnSamples([{ t: '2026-02-25T02:00:00Z', bpm: 70 }], [{
    sensor_timestamp: T0,
    spo2_raw_byte: 96,
    spo2_state: 'candidate',
    spo2_candidate_pct: 96,
  }])[0].spo2_raw_byte, undefined);
});

test('window reconstructed across encoded archive chunks', () => {
  const samples = Array.from({ length: 30 }, (_, i) => sample({
    sensor_ts: T0 + i,
    t: new Date((T0 + i) * 1000).toISOString(),
    spo2_raw_byte: 95,
    source_frame_hash: String(i).padStart(64, '0'),
  }));
  const a = encodeArchive(samples.slice(0, 15));
  const b = encodeArchive(samples.slice(15));
  const rows = [...decodeArchive(a.body), ...decodeArchive(b.body)];
  const windows = detectMeasurementWindows(observationsFromSamples(rows));
  assert.equal(windows.length, 1);
  assert.equal(windows[0].duration_s, 30);
  assert.equal(spo2CandidateSeriesFromSamples(rows).length, 30);
});
