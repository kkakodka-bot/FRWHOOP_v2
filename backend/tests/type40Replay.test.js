import assert from 'node:assert/strict';
import test from 'node:test';
import { puffinRT, notifyOf } from './fixtures/whoopFrames.mjs';
import {
  type40SamplesFromFrames,
  gattSamplesFromFrames,
  mergeHrReplay,
  parseGattHeartRate,
  classifyCaptureWindow,
  productionMissCause,
  evaluateWindow,
  hrOnlySetRestPulses,
  REPLAY_UNAVAILABLE,
  CAPTURE_GAP_CLASSES,
} from '../metrics/workoutDetectReplay.js';

const T0 = Date.UTC(2026, 7, 26, 5, 2, 0);

test('raw-frame replay reconstructs type-40 HR deterministically', () => {
  const rows = [
    notifyOf(puffinRT(1, 1_782_000_000, 0, 91, 0), {
      family: 'puffin',
      t: '2026-08-26T05:10:00.000Z',
      seq: 10,
    }),
    notifyOf(puffinRT(2, 1_782_000_001, 0, 93, 0), {
      family: 'puffin',
      t: '2026-08-26T05:10:01.000Z',
      seq: 11,
    }),
  ];
  const a = type40SamplesFromFrames(rows);
  const b = type40SamplesFromFrames(rows);
  assert.equal(a.stats.raw_type40, 2);
  assert.equal(a.stats.crc_valid, 2);
  assert.equal(a.stats.hr_decoded, 2);
  assert.equal(a.samples[0].bpm, 91);
  assert.equal(a.samples[0].timestamp_source, 'sensor');
  assert.equal(a.samples[0].ts, 1_782_000_000_000);
  assert.equal(a.samples[0].decoder, b.samples[0].decoder);
  assert.deepEqual(a.samples.map((s) => s.frame_hash), b.samples.map((s) => s.frame_hash));
  assert.deepEqual(a.side_effects, []);
});

test('type-40 replay preserves declared RR slot order', () => {
  const rows = [notifyOf(puffinRT(1, 1_782_000_000, 0, 72, 2, [1018, 532]), {
    family: 'puffin',
    t: '2026-08-26T05:10:00.000Z',
  })];
  const { samples } = type40SamplesFromFrames(rows);
  assert.deepEqual(samples[0].rr_ms, [1018, 532]);
});

test('untrustworthy strap unix falls back to receive timestamp', () => {
  const rows = [notifyOf(puffinRT(1, 100, 0, 80, 0), {
    family: 'puffin',
    t: '2026-08-26T05:10:00.000Z',
  })];
  const { samples, stats } = type40SamplesFromFrames(rows);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].timestamp_source, 'receive');
  assert.equal(samples[0].ts, Date.parse('2026-08-26T05:10:00.000Z'));
  assert.equal(stats.ts_receive, 1);
});

test('type-40 replay does not synthesize motion/IMU and has no production side effects', () => {
  const rows = [notifyOf(puffinRT(1, 1_782_000_000, 0, 100, 0), {
    family: 'puffin',
    t: '2026-08-26T05:10:00.000Z',
  })];
  const { samples } = type40SamplesFromFrames(rows);
  assert.equal(samples[0].phoneMotion, undefined);
  assert.equal(samples[0].strapMotion, undefined);
  assert.equal(samples[0].steps, undefined);
  assert.equal(samples[0].gyro, undefined);
  const ev = evaluateWindow({
    samples,
    start: T0,
    end: T0 + 60_000,
    restingHr: 60,
    maxHr: 174,
    padMin: 0,
  });
  assert.equal(ev.coverage.phoneMotion, 0);
  assert.equal(ev.coverage.strapMotion, 0);
  assert.equal(ev.coverage.gyro, 0);
  assert.equal(ev.coverage.steps, 0);
  assert.ok(ev.unavailable.includes('phoneMotion'));
  assert.ok(ev.unavailable.includes('type43_imu'));
  assert.ok(REPLAY_UNAVAILABLE.includes('gyro'));
  assert.equal(ev.v1.hit, false);
});

test('production miss classifies capture vs ingestion vs detector without collapsing to capture_gap', () => {
  assert.equal(productionMissCause({ rawType40: 0, physiologyHr: 0 }), 'unknown_capture_gap');
  assert.equal(productionMissCause({
    rawType40: 0, physiologyHr: 0, captureClass: 'strap_not_connected',
  }), 'strap_not_connected');
  assert.equal(productionMissCause({ rawType40: 4584, physiologyHr: 0, reconstructedHr: 4584 }), 'ingestion');
  assert.equal(productionMissCause({ rawType40: 100, physiologyHr: 100 }), 'detector');
  assert.equal(productionMissCause({ gattHr: 50, physiologyHr: 0, reconstructedHr: 50 }), 'ingestion');
});

test('2A37 GATT HR parses flags/RR and merges only when type-40 is stale', () => {
  const parsed = parseGattHeartRate([0x10, 80, 0x00, 0x04]);
  assert.equal(parsed.bpm, 80);
  assert.ok(parsed.rrMs.length >= 1);
  const withEe = parseGattHeartRate([0x18, 80, 0x11, 0x22, 0x00, 0x04]);
  assert.equal(withEe.bpm, 80);
  assert.deepEqual(withEe.rrMs, [1000]);
  const hr16 = parseGattHeartRate([0x01, 0x50, 0x00]);
  assert.equal(hr16.bpm, 80);
  const t0 = Date.parse('2026-08-26T05:10:00.000Z');
  const t40 = type40SamplesFromFrames([
    notifyOf(puffinRT(1, Math.floor(t0 / 1000), 0, 91, 0), {
      family: 'puffin',
      t: '2026-08-26T05:10:00.000Z',
    }),
  ]);
  const gattRows = [{
    family: 'gatt',
    char: '2A37',
    hex: '1050',
    t: '2026-08-26T05:10:00.200Z',
  }, {
    family: 'gatt',
    char: '2A37',
    hex: '1060',
    t: '2026-08-26T05:10:12.000Z',
  }];
  const gatt = gattSamplesFromFrames(gattRows);
  assert.equal(gatt.stats.hr_decoded, 2);
  const merged = mergeHrReplay(t40.samples, gatt.samples);
  assert.equal(merged.filter((s) => s.src === 'gatt_hr').length, 1);
  assert.equal(merged.find((s) => s.src === 'gatt_hr').bpm, 96);
});

test('capture-gap classes stay distinct', () => {
  assert.equal(classifyCaptureWindow({ objectCount: 0, type40Count: 0, gattHrCount: 0 }), 'raw_archive_missing');
  assert.equal(classifyCaptureWindow({
    objectCount: 4, type40Count: 0, gattHrCount: 0, connected: false,
  }), 'strap_not_connected');
  assert.equal(classifyCaptureWindow({
    objectCount: 4, type40Count: 0, gattHrCount: 12, connected: true,
  }), 'gatt_fallback_available');
  assert.equal(classifyCaptureWindow({
    objectCount: 4, type40Count: 0, gattHrCount: 0, connected: true, anyNotify: true,
  }), 'custom_stream_missing');
  assert.equal(classifyCaptureWindow({
    objectCount: 4, type40Count: 0, gattHrCount: 0, appSuspended: true, connected: true,
  }), 'app_suspended');
  assert.equal(classifyCaptureWindow({ queueWriteFailed: true, type40Count: 10 }), 'queue_write_failed');
  assert.ok(CAPTURE_GAP_CLASSES.includes('unknown_capture_gap'));
});

test('w5_neg fixture: V1 may confirm HR-only set/rest; V2 refuses without motion', () => {
  const t0 = Date.UTC(2026, 7, 27, 3, 0, 0);
  const warmup = [];
  for (let i = 0; i < 180; i += 1) warmup.push({ ts: t0 + i * 1000, bpm: 68 });
  const bout = hrOnlySetRestPulses({ t0: t0 + 180_000, minutes: 12 });
  const ev = evaluateWindow({
    samples: [...warmup, ...bout],
    start: t0 + 180_000,
    end: t0 + 180_000 + 12 * 60_000,
    restingHr: 60,
    maxHr: 174,
    padMin: 0,
  });
  assert.equal(ev.v1.hit, true);
  assert.equal(ev.v1.reason, 'set_rest_pulses');
  assert.equal(ev.v2.hit, false, `V2 must not confirm w5_neg ${ev.v2.path}`);
  assert.notEqual(ev.v2.sport, 'strength');
  assert.ok(ev.v2.miss === 'hr_support_only' || ev.v2.miss === 'hr_active' || ev.v2.detectorState !== 'CONFIRMED');
});
