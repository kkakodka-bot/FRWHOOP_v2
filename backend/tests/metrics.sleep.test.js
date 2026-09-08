import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  sleepEfficiency, sleepNeedMin, sleepPerformance, sleepDebtMin,
  scoreSleep, detectSleepWindow, strainFromHr, ALGORITHM_VERSION,
} from '../metrics/sleep.js';
import { derivedObjectKey, objectKey, uuidFromParts } from '../storage/keys.js';
import { createLiveBuffer } from '../ingest/live.js';
import { overlayPersistedDays, mergeBpmSamples } from '../host/whoopDays.js';
import { correctReplayHistoricalClock, sleepToWhoopDay, mergeWhoopDays, replayWindowCoverage, guardReplayWindowCoverage } from '../metrics/engine.js';

test('sleep efficiency and performance stay in range', () => {
  assert.equal(sleepEfficiency(432, 480), 0.9);
  assert.equal(sleepPerformance(432, 480), 90);
  assert.equal(sleepEfficiency(null, 480), null);
});

test('sleep need grows with strain and debt but stays bounded', () => {
  const easy = sleepNeedMin({ strainYesterday: 4, debtMin: 0 });
  const hard = sleepNeedMin({ strainYesterday: 18, debtMin: 120 });
  assert.ok(hard > easy);
  assert.ok(hard <= 720);
  assert.ok(easy >= 360);
});

test('sleep debt carries a fraction of unpaid need', () => {
  const debt = sleepDebtMin([
    { needMin: 480, asleepMin: 360 },
    { needMin: 480, asleepMin: 400 },
  ]);
  assert.ok(debt > 0);
  assert.ok(debt < 240);
});

test('strain integrates elapsed time instead of packet count', () => {
  const start = Date.parse('2026-08-25T12:00:00Z');
  const sustained = Array.from({ length: 901 }, (_, i) => ({
    datetime: new Date(start + i * 4_000).toISOString(),
    bpm: 160,
  }));
  const duplicated = sustained.flatMap((row) => [row, row, row]);
  const score = strainFromHr(sustained, 55, 190);
  assert.ok(score > 0 && score < 21);
  assert.equal(strainFromHr(duplicated, 55, 190), score);
  assert.equal(strainFromHr([
    { datetime: new Date(start).toISOString(), bpm: 160 },
    { datetime: new Date(start + 60 * 60_000).toISOString(), bpm: 160 },
  ], 55, 190), 0);
});

test('strain counts 5-minute walking buckets instead of only hard efforts', () => {
  const start = Date.parse('2026-08-25T12:00:00Z');
  const walk = Array.from({ length: 24 }, (_, i) => ({
    datetime: new Date(start + i * 5 * 60_000).toISOString(),
    bpm: 95,
  }));
  const score = strainFromHr(walk, 55, 190);
  assert.ok(score > 0 && score < 21);
});

test('historical replay preserves age between batches with a bad strap clock', () => {
  const rows = correctReplayHistoricalClock([
    { t_strap: '2026-01-24T10:00:00Z', t: '2026-08-25T22:00:00Z', bpm: 60 },
    { t_strap: '2026-02-18T10:00:00Z', t: '2026-08-25T22:01:00Z', bpm: 61 },
  ]);
  assert.equal(Date.parse(rows[1].t) - Date.parse(rows[0].t), 25 * 86_400_000);
  assert.equal(rows[1].t, '2026-08-25T22:01:00.000Z');
});

test('overnight HR stream becomes a scored sleep night', () => {
  const start = Date.parse('2026-08-23T23:00:00Z');
  const samples = [];
  for (let i = 0; i < 120; i += 1) {
    const t = start + i * 4 * 60_000;
    const asleep = i > 5 && i < 100;
    samples.push({
      datetime: new Date(t).toISOString(),
      bpm: asleep ? 52 + (i % 5) : 78,
    });
  }
  const window = detectSleepWindow(samples);
  assert.ok(window);
  assert.ok(window.end > window.start);
  const night = scoreSleep({ samples });
  assert.equal(night.ok, true);
  assert.equal(night.algorithmVersion, ALGORITHM_VERSION);
  assert.ok(night.asleepMin > 60);
  assert.ok(night.hypnogram.length >= 1);
  const whoop = sleepToWhoopDay(night);
  assert.ok(whoop.sleep_summary['Asleep duration (min)'] > 0);
  assert.ok(whoop.physiological_summary['Sleep performance %'] != null);
});

test('derived keys stay on the S3 prefix and raw live_hr uses gzip ndjson', () => {
  const user = '11111111-1111-4111-8111-111111111111';
  const device = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const objectId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const derived = derivedObjectKey({ userId: user, kind: 'sleep', day: '2026-08-23', objectId });
  assert.match(derived, /^v1\/users\/11111111-1111-4111-8111-111111111111\/derived\/sleep\//);
  assert.match(derived, /\.json\.gz$/);
  const raw = objectKey({ userId: user, deviceId: device, kind: 'live_hr', day: '2026-08-23', objectId });
  assert.match(raw, /\/live_hr\/2026\/08\/23\//);
  assert.match(raw, /\.ndjson\.gz$/);
  assert.equal(uuidFromParts(['a']), uuidFromParts(['a']));
});

test('live buffer appends locally and flushes to the engine', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-live-'));
  const archived = [];
  const engine = {
    async archiveRawSamples({ samples }) { archived.push(samples.length); return { sample_count: samples.length }; },
    async persistComputed() { return { sleepRow: null }; },
  };
  const buf = createLiveBuffer({
    dir,
    userId: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
    flushEvery: 99,
    flushMs: 60 * 60_000,
    engine,
    now: () => new Date('2026-08-24T08:00:00Z'),
  });
  buf.append({ heartRate: 62, datetime: '2026-08-24T07:59:00Z', deviceId: 'strap' });
  buf.append({ heartRate: 64, datetime: '2026-08-24T07:59:04Z', deviceId: 'strap' });
  const flushed = await buf.flush();
  assert.equal(buf.samplesFor('2026-08-24').length, 2);
  assert.equal(flushed.flushed, 2);
  assert.ok(archived[0] >= 2);
});

test('persisted sleep overlays fixture days without dropping bpm', () => {
  const base = {
    '2026-08-24': {
      physiological_summary: { 'Day Strain': 8 },
      sleep_summary: {},
      bpm_data: [{ datetime: '2026-08-24T01:00:00Z', bpm: 55 }],
    },
  };
  const persisted = {
    '2026-08-24': sleepToWhoopDay({
      onsetIso: '2026-08-23T23:10:00Z',
      wakeIso: '2026-08-24T07:02:00Z',
      performance: 88,
      asleepMin: 420,
      inBedMin: 450,
      efficiency: 0.93,
    }),
  };
  const merged = overlayPersistedDays(base, persisted);
  assert.equal(merged['2026-08-24'].physiological_summary['Sleep performance %'], 88);
  assert.equal(merged['2026-08-24'].bpm_data[0].bpm, 55);
  const withLive = mergeBpmSamples(merged, [{ datetime: '2026-08-24T12:00:00Z', bpm: 90 }]);
  assert.equal(withLive['2026-08-24'].bpm_data.at(-1).bpm, 90);
});

test('strap overlay keeps JWT HRV when B2 recovery is still null', () => {
  const jwt = {
    '2026-08-25': {
      physiological_summary: {
        'Heart rate variability (ms)': 64.1,
        'Respiratory rate (rpm)': 17.25,
        'Day Strain': 5.2,
      },
      bpm_data: Array.from({ length: 73 }, (_, i) => ({ datetime: `t${i}`, bpm: 70 })),
    },
  };
  const strap = {
    '2026-08-25': {
      physiological_summary: {
        'Heart rate variability (ms)': null,
        'Respiratory rate (rpm)': null,
        'Day Strain': 2.9,
        'Resting heart rate (bpm)': 60,
        'Energy burned (cal)': 62.32,
      },
      bpm_data: Array.from({ length: 36 }, (_, i) => ({ datetime: `s${i}`, bpm: 80 })),
    },
  };
  const merged = overlayPersistedDays(jwt, strap);
  assert.equal(merged['2026-08-25'].physiological_summary['Heart rate variability (ms)'], 64.1);
  assert.equal(merged['2026-08-25'].physiological_summary['Respiratory rate (rpm)'], 17.25);
  assert.equal(merged['2026-08-25'].physiological_summary['Day Strain'], 2.9);
  assert.equal(merged['2026-08-25'].physiological_summary['Resting heart rate (bpm)'], 60);
  assert.equal(merged['2026-08-25'].physiological_summary['Energy burned (cal)'], 62.32);
  assert.equal(merged['2026-08-25'].bpm_data.length, 73);
});

test('later null daily metrics do not wipe overnight recovery', () => {
  const days = mergeWhoopDays({}, [
    { day: '2026-08-25', patch: { physiological_summary: { 'Recovery score %': 71, 'Day Strain': 8 } } },
    { day: '2026-08-25', patch: { physiological_summary: { 'Recovery score %': null, 'Day Strain': 2.9 } } },
  ]);
  assert.equal(days['2026-08-25'].physiological_summary['Recovery score %'], 71);
  assert.equal(days['2026-08-25'].physiological_summary['Day Strain'], 2.9);
});

test('replay clock correction never double-shifts already-corrected rows', () => {
  // Mixed batch: an anchor corrected the second row mid-drain (t moved to wall,
  // clock_offset_sec set); the first row is still strap-dated.
  const strapBase = Date.parse('2026-01-24T10:00:00Z');
  const lagMs = 30 * 86_400_000;
  const rows = correctReplayHistoricalClock([
    { t_strap: new Date(strapBase).toISOString(), t: new Date(strapBase).toISOString(), bpm: 60 },
    {
      t_strap: new Date(strapBase + 60_000).toISOString(),
      t: new Date(strapBase + 60_000 + lagMs).toISOString(),
      clock_offset_sec: lagMs / 1000,
      bpm: 61,
    },
  ]);
  // Corrected row keeps its corrected t exactly.
  assert.equal(rows[1].t, new Date(strapBase + 60_000 + lagMs).toISOString());
  // Uncorrected row is anchored relative to the drain window's recorded time.
  // (The uncorrected subset's recorded t ≈ strap, so offset ≈ 0 → untouched,
  // which is the honest reading: one uncorrected sample is not evidence.)
  assert.equal(rows[0].t, new Date(strapBase).toISOString());
});

test('replay window guard reports samples outside the day window', () => {
  const lo = Date.parse('2026-09-01T07:00:00.000Z');
  const hi = Date.parse('2026-09-02T07:00:00.000Z');
  const inside = { t: '2026-09-01T12:00:00.000Z', bpm: 70 };
  const outside = { t: '2026-08-20T12:00:00.000Z', bpm: 72, t_strap: '2026-08-20T12:00:00.000Z' };
  const coverage = replayWindowCoverage([inside, outside, outside, outside, outside, outside, outside, outside, outside, outside], { lo, hi });
  assert.equal(coverage.in_window, 1);
  assert.equal(coverage.out_window, 9);
  assert.ok(coverage.fraction_outside >= 0.9);
  const guarded = guardReplayWindowCoverage([inside, ...Array.from({ length: 9 }, () => outside)], { lo, hi, label: 'test' });
  assert.equal(guarded.fraction_outside, 0.9);
});
