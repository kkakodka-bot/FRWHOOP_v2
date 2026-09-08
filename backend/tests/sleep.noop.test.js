import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { decodeArchive, encodeArchive } from '../ingest/archiveFormat.js';
import { normalizeHistoricalSample } from '../ingest/historyBuffer.js';
import { createMetricsEngine, dedupeReplaySamples } from '../metrics/engine.js';
import { scoreSleep, isPersistableOvernight, sleepPersistState } from '../metrics/sleep.js';
import {
  bandStateConfirmsAsleep,
  detectSleepSessions,
  extractSleepStreams,
  offWristFraction,
  offWristHrGapSpans,
  passesMorningStillnessGuard,
} from '../metrics/sleepDetection.js';
import { stageSession } from '../metrics/sleepStagerV2.js';
import { restBoutsFromAccel } from '../metrics/vanHeesSleep.js';

const fixture = JSON.parse(fs.readFileSync(
  new URL('./fixtures/noop-sleep-parity.json', import.meta.url),
  'utf8',
));
const USER = '11111111-1111-4111-8111-111111111111';

function activeVector(i) {
  return Math.floor(i / 3) % 2
    ? { x: 1, y: 0, z: 0 }
    : { x: 0, y: 0, z: 1 };
}

function appendBlock(samples, startSec, durationSec, {
  bpm,
  still,
  rr = false,
} = {}) {
  for (let i = 0; i < durationSec; i += 1) {
    const gravity = still ? { x: 0, y: 0, z: 1 } : activeVector(i);
    samples.push({
      t: new Date((startSec + i) * 1000).toISOString(),
      bpm,
      rr_ms: rr ? [Math.trunc(60_000 / bpm)] : [],
      gravity,
    });
  }
}

test('Van Hees compact fixture matches sibling two-bout semantics', () => {
  const spec = fixture.van_hees;
  const accel = [];
  let second = 0;
  const append = (duration, still) => {
    for (let i = 0; i < duration; i += 1) {
      const phase = Math.sin(i * 0.5);
      const vector = still
        ? { x: 0.02, y: 0.02, z: 1 }
        : { x: 0.3 * phase, y: 0.3, z: 0.9 * (1 - 0.2 * phase) };
      accel.push({ tsMs: second * 1000, ...vector, valid: true });
      second += 1;
    }
  };
  append(spec.still_a_sec, true);
  append(spec.active_sec, false);
  append(spec.still_b_sec, true);
  const bouts = restBoutsFromAccel(accel);
  assert.deepEqual(bouts, spec.expected);
});

test('SleepStagerV2 reproduces the shipped frozen golden hypnogram', () => {
  const spec = fixture.staging_v2;
  const duration = spec.phase_sec * spec.phases;
  const gravity = [];
  const hr = [];
  const rr = [];
  const amplitudes = [12, 60, 30, 20];
  for (let i = 0; i < duration; i += 1) {
    const ts = spec.start_sec + i;
    const phase = Math.floor(i / spec.phase_sec);
    const restless = phase === 3 && i % 20 < 6;
    gravity.push({ ts, ...(restless ? { x: 0.2, y: 0.15, z: 0.96 } : { x: 0, y: 0, z: 1 }) });
    const bpm = phase === 0 ? 50
      : phase === 1 ? 54 + [0, 1, 2, 3, 2, 1][Math.floor(i / 20) % 6]
        : phase === 2 ? 56 + (Math.floor(i / 60) % 4)
          : 66 + (Math.floor(i / 30) % 6);
    hr.push({ ts, bpm });
    rr.push({
      ts,
      rrMs: Math.trunc(60_000 / bpm) + [0, amplitudes[phase], 0, -amplitudes[phase]][i % 4],
    });
  }
  const actual = stageSession({
    start: spec.start_sec,
    end: spec.start_sec + duration,
    gravity,
    hr,
    rr,
  }).map((segment) => [
    segment.start - spec.start_sec,
    segment.end - spec.start_sec,
    segment.stage,
  ]);
  assert.deepEqual(actual, spec.expected);
});

test('history/archive gx rows feed authoritative Van Hees scoring', () => {
  const start = Date.parse('2026-06-10T01:00:00Z') / 1000;
  const rows = [];
  for (let i = 0; i < 75 * 60; i += 1) {
    rows.push(normalizeHistoricalSample({
      seq: i,
      t: new Date((start + i) * 1000).toISOString(),
      bpm: 50 + Math.floor(i / 60) % 2,
      rr_ms: [1200 - (i % 4) * 10],
      gx: 0,
      gy: 0,
      gz: 1,
      source: 'whoop_history',
      layout: 'history-v1',
      decoder: 'ios/3',
    }));
  }
  const archived = decodeArchive(encodeArchive(rows).body);
  const streams = extractSleepStreams(archived);
  assert.equal(streams.gravity.length, rows.length);
  assert.deepEqual(streams.gravity[0], { ts: start, x: 0, y: 0, z: 1 });

  const scored = scoreSleep({ samples: archived, extras: { timeZone: 'UTC' } });
  assert.equal(scored.ok, true);
  assert.equal(scored.detector, 'van_hees');
  assert.equal(scored.confidence, 'high');
  assert.equal(scored.gravityCoverage.adequate, true);
  assert.equal(scored.provenance.gravityAuthoritative, true);
  assert.equal(scored.provenance.stagingAlgorithm, 'sleep_stager_v2');
  assert.ok(scored.stages.every(({ stage }) => ['awake', 'light', 'deep', 'rem'].includes(stage)));
  assert.equal(
    scored.awakeMin + scored.lightMin + scored.deepMin + scored.remMin,
    scored.inBedMin,
  );
});

test('isolated gravity points and daytime HR-only stillness fail conservatively', () => {
  const start = Date.parse('2026-06-10T01:00:00Z') / 1000;
  const isolated = detectSleepSessions({
    gravity: [
      { ts: start, x: 0, y: 0, z: 1 },
      { ts: start + 2 * 3600, x: 0, y: 0, z: 1 },
    ],
  });
  assert.equal(isolated.sessions.length, 0);
  assert.equal(isolated.coverage.sufficient, false);

  const daytimeStart = Date.parse('2026-06-10T13:00:00Z');
  const daytimeHr = Array.from({ length: 60 }, (_, i) => ({
    t: new Date(daytimeStart + i * 2 * 60_000).toISOString(),
    bpm: 50,
  }));
  const fallback = scoreSleep({ samples: daytimeHr, extras: { timeZone: 'UTC' } });
  assert.equal(fallback.ok, false);
  assert.equal(fallback.fallbackReason, 'insufficient_gravity');
});

test('dense main sleep plus a quality daytime nap are both persisted', async () => {
  const start = Date.parse('2026-06-10T00:00:00Z') / 1000;
  const samples = [];
  appendBlock(samples, start, 3600, { bpm: 72, still: false });
  appendBlock(samples, start + 3600, 3 * 3600, { bpm: 50, still: true, rr: true });
  appendBlock(samples, start + 4 * 3600, 9 * 3600, { bpm: 72, still: false });
  appendBlock(samples, start + 13 * 3600, 2 * 3600, { bpm: 50, still: true, rr: true });

  const payloads = [];
  const blobs = new Map();
  const engine = createMetricsEngine({
    cfg: {
      localUserId: USER,
      rawStore: 'b2',
      derivedStore: 'b2',
      b2Bucket: 'FRWHOOP',
      buildHash: 'test',
    },
    stores: {
      derived: {
        async putObject(key, body) {
          blobs.set(key, body);
          return { bytes: body.length };
        },
      },
    },
    db: {
      async upsertPayload(payload) {
        payloads.push(payload);
        return { ok: true };
      },
    },
  });
  const result = await engine.persistComputed({
    samples,
    device: { externalId: 'strap' },
    extras: { timeZone: 'UTC' },
  });
  assert.equal(result.scored.sleep.sessions.length, 2);
  assert.equal(result.sessionRows.filter((row) => row.kind === 'sleep').length, 1);
  assert.equal(result.sessionRows.filter((row) => row.kind === 'nap').length, 1);
  assert.equal(result.sleepDetails.length, 2);
  assert.equal(payloads[0].sessions.length, 2);
  assert.equal(payloads[0].sleep_details.length, 2);
  assert.equal(new Set(result.sessionRows.map((row) => row.id)).size, 2);
  assert.match(result.sessionRows[0].external_id, /:2026-06-10:/);
});

test('daytime sedentary stillness without a cardiac dip is rejected', () => {
  const start = Date.parse('2026-06-10T10:00:00Z') / 1000;
  const samples = [];
  appendBlock(samples, start, 3 * 3600, { bpm: 72, still: false });
  appendBlock(samples, start + 3 * 3600, 2 * 3600, { bpm: 70, still: true });
  const streams = extractSleepStreams(samples);
  const result = detectSleepSessions({ ...streams, tzOffsetSeconds: 0 });
  assert.equal(result.sessions.length, 0);
});

test('sparse gravity uses the HR-vouched path instead of HR-only detection', () => {
  const start = Date.parse('2026-06-10T01:00:00Z') / 1000;
  const duration = 6 * 3600;
  const hr = Array.from({ length: duration }, (_, i) => ({ ts: start + i, bpm: 50 }));
  const gravity = [];
  for (let i = 0; i < duration; i += 25 * 60) gravity.push({ ts: start + i, x: 0, y: 0, z: 1 });
  const result = detectSleepSessions({ gravity, hr, rr: [] });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].detector, 'sparse_gravity_hr_vouched');
  assert.equal(result.sessions[0].fallbackReason, 'sparse_gravity_hr_vouched');
  assert.ok(result.sessions[0].endSec - result.sessions[0].startSec > 5 * 3600);
});

test('morning residual stillness and over-16-hour spans are rejected', () => {
  const day = Date.parse('2026-06-10T00:00:00Z') / 1000;
  const morning = { start: day + 11 * 3600, end: day + 13 * 3600 };
  assert.equal(passesMorningStillnessGuard(morning, 74, 80, day + 10 * 3600), false);
  assert.equal(passesMorningStillnessGuard(morning, 70, 80, day + 10 * 3600), true);

  const duration = 17 * 3600;
  const hr = [];
  for (let i = 0; i < duration; i += 60) hr.push({ ts: day + i, bpm: 50 });
  const gravity = [];
  for (let i = 0; i < duration; i += 25 * 60) gravity.push({ ts: day + i, x: 0, y: 0, z: 1 });
  assert.equal(detectSleepSessions({ gravity, hr, rr: [] }).sessions.length, 0);
});

test('off-wrist fractional rejection matches NOOP union and density semantics', () => {
  const period = { start: 0, end: 3600 };
  const dense = Array.from({ length: 3601 }, (_, ts) => ({ ts, bpm: 50 }));
  assert.deepEqual(offWristHrGapSpans(period, dense), []);
  assert.equal(offWristFraction(period, dense, []), 0);

  const gappy = [
    ...Array.from({ length: 601 }, (_, ts) => ({ ts, bpm: 50 })),
    ...Array.from({ length: 1741 }, (_, i) => ({ ts: 1860 + i, bpm: 50 })),
  ];
  assert.deepEqual(offWristHrGapSpans(period, gappy), [{ start: 600, end: 1860 }]);
  assert.equal(offWristFraction(period, gappy, []), 1260 / 3600);
  assert.equal(offWristFraction(period, gappy, [{ start: 800, end: 1500 }]), 1260 / 3600);
  assert.equal(offWristFraction(period, gappy, [{ start: 2400, end: 3000 }]), 1860 / 3600);
  assert.equal(offWristFraction(period, [], []), 0);

  const sparse = [0, 1500, 3000, 4500].map((ts) => ({ ts, bpm: 52 }));
  const sparsePeriod = { start: 0, end: 5400 };
  assert.deepEqual(offWristHrGapSpans(sparsePeriod, sparse), []);
  assert.equal(offWristFraction(sparsePeriod, sparse, []), 0);
  assert.ok(offWristFraction(sparsePeriod, sparse, [{ start: 0, end: 3000 }]) >= 0.5);
});

test('off-wrist rejection drops majority coverage but keeps a short tail', () => {
  const start = Date.parse('2026-06-10T01:00:00Z') / 1000;
  const duration = 90 * 60;
  const gravity = Array.from({ length: duration }, (_, i) => ({
    ts: start + i, x: 0, y: 0, z: 1,
  }));
  const hr = Array.from({ length: duration }, (_, i) => ({ ts: start + i, bpm: 50 }));
  const base = { gravity, hr, rr: [] };
  assert.equal(detectSleepSessions(base).sessions.length, 1);
  assert.equal(detectSleepSessions({
    ...base,
    wristOff: [{ start, end: start + 30 * 60 }],
  }).sessions.length, 1);
  assert.equal(detectSleepSessions({
    ...base,
    wristOff: [{ start, end: start + 50 * 60 }],
  }).sessions.length, 0);
});

test('band-state morning rescue is thresholded and cannot bypass the ordinary guard', () => {
  const day = Date.parse('2026-06-10T00:00:00Z') / 1000;
  const period = { start: day + 11 * 3600, end: day + 13 * 3600 };
  const wakeEnd = day + 10 * 3600;
  const band = Array.from({ length: 100 }, (_, i) => ({
    ts: period.start + i * 60,
    state: i < 80 ? 2 : 1,
  }));
  const extractedBand = extractSleepStreams(band.map((row) => ({
    t: new Date(row.ts * 1000).toISOString(),
    sleep_state: row.state,
  }))).bandSleepState;
  assert.deepEqual(extractedBand, band);
  assert.equal(bandStateConfirmsAsleep(period, extractedBand), true);
  assert.equal(passesMorningStillnessGuard(period, 74, 80, wakeEnd), false);
  assert.equal(passesMorningStillnessGuard(period, 74, 80, wakeEnd, extractedBand), true);

  const belowThreshold = band.map((row, i) => ({ ...row, state: i < 59 ? 2 : 1 }));
  assert.equal(bandStateConfirmsAsleep(period, belowThreshold), false);
  assert.equal(passesMorningStillnessGuard(period, 74, 80, wakeEnd, belowThreshold), false);
  assert.equal(passesMorningStillnessGuard(period, 77, 80, wakeEnd, band), false);
  assert.equal(bandStateConfirmsAsleep(period, []), false);
});

test('HR-only scoring is explicitly low confidence and normalizes stage totals', () => {
  const start = Date.parse('2026-08-23T23:00:00Z');
  const samples = Array.from({ length: 120 }, (_, i) => ({
    datetime: new Date(start + i * 4 * 60_000).toISOString(),
    bpm: i > 5 && i < 100 ? 52 + (i % 5) : 78,
    sleep_stage: i % 9 === 0 ? 'wake' : 'light',
  }));
  const scored = scoreSleep({ samples });
  assert.equal(scored.ok, true);
  assert.equal(scored.confidence, 'low');
  assert.equal(scored.fallbackReason, 'insufficient_gravity_hr_only');
  assert.ok(scored.stages.every((segment) => segment.stage !== 'wake'));
  assert.equal(
    scored.awakeMin + scored.lightMin + scored.deepMin + scored.remMin,
    scored.inBedMin,
  );
  assert.equal(isPersistableOvernight(scored), true);
  assert.equal(sleepPersistState(scored), 'provisional');
});

test('HR-only evening sitting is not scored as overnight sleep', () => {
  const start = Date.parse('2026-08-24T02:30:00Z');
  const samples = Array.from({ length: 64 }, (_, i) => ({
    datetime: new Date(start + i * 4 * 60_000).toISOString(),
    bpm: 58,
  }));
  const scored = scoreSleep({ samples, extras: { timeZone: 'America/Los_Angeles' } });
  assert.equal(scored.ok, false);
  assert.equal(isPersistableOvernight(scored), false);
});

test('HR-only overnight with pre-dawn onset is not rejected by Pacific daytime center', () => {
  const start = Date.parse('2026-09-01T10:53:30.358Z');
  const end = Date.parse('2026-09-02T02:39:22.092Z');
  const minutes = Math.floor((end - start) / 60_000);
  const samples = Array.from({ length: minutes }, (_, i) => ({
    datetime: new Date(start + i * 60_000).toISOString(),
    bpm: i > 20 && i < minutes - 20 ? 52 : 78,
    rr_ms: i % 5 === 0 ? [900] : [],
  }));
  const scored = scoreSleep({ samples, extras: { timeZone: 'America/Los_Angeles' } });
  assert.equal(scored.ok, true);
  assert.equal(scored.fallbackReason, 'insufficient_gravity_hr_only');
  assert.equal(isPersistableOvernight(scored), true);
});

test('B2 replay deduplicates overlapping physiology objects before scoring', async () => {
  const start = Date.parse('2026-08-23T23:00:00Z');
  const samples = Array.from({ length: 120 }, (_, i) => ({
    datetime: new Date(start + i * 4 * 60_000).toISOString(),
    bpm: i > 5 && i < 100 ? 53 : 78,
  }));
  const archive = encodeArchive(samples);
  const manifests = ['a', 'b'].map((suffix) => ({
    id: `${suffix}1111111-1111-4111-8111-111111111111`,
    object_key: `physiology-${suffix}`,
    object_kind: 'physiology',
    status: 'ready',
    period_day: '2026-08-24',
    start_at: samples[0].datetime,
    end_at: samples.at(-1).datetime,
    schema_version: 2,
    format: 'ndjson_gzip_v2',
    sha256: archive.sha256,
  }));
  const payloads = [];
  const engine = createMetricsEngine({
    cfg: {
      localUserId: USER,
      rawStore: 'b2',
      derivedStore: 'b2',
      b2Bucket: 'FRWHOOP',
      buildHash: 'test',
    },
    stores: {
      raw: { async getObject() { return { body: archive.body }; } },
      derived: { async putObject() { return { bytes: 1 }; } },
    },
    db: {
      async listPhysiologyManifests() { return manifests; },
      async upsertPayload(payload) { payloads.push(payload); return { ok: true }; },
    },
  });
  const replay = await engine.recomputeFromStorage({
    userId: USER,
    days: ['2026-08-24'],
    timeZone: 'UTC',
  });
  assert.equal(replay.samples, samples.length);
  assert.equal(replay.deduplicated, samples.length);
  assert.equal(replay.results.length, 1);
  assert.deepEqual(payloads[0].metric_runs[0].input_refs.object_ids, manifests.map((row) => row.id));
  assert.equal(payloads[0].metric_runs[0].input_refs.fallback_reason, 'insufficient_gravity_hr_only');
  assert.deepEqual(payloads[0].metric_runs[0].input_refs.decoder_versions, ['archive-schema-2']);
  assert.deepEqual(payloads[0].metric_runs[0].input_refs.layouts, ['ndjson_gzip_v2']);
  assert.equal(payloads[0].metric_runs[0].input_refs.gravity_coverage.sufficient, false);

  assert.equal(dedupeReplaySamples([samples[0], samples[0]]).length, 1);
});
