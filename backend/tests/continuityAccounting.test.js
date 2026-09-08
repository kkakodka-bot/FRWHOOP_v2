import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { crc8, crc32 } from '../protocol/crc.js';
import { decodeFrame } from '../protocol/decoder.js';
import { deriveRecords } from '../redecode/derive.js';
import { replayNotifies, pipelineAccounting } from '../redecode/redecode.js';
import { sidecarFromLevelB } from '../redecode/sidecar.js';
import { encodeFrameArchive } from '../ingest/archiveFormat.js';
import { createHistoryBuffer } from '../ingest/historyBuffer.js';
import { createUserRuntimes } from '../identity/userRuntime.js';
import { loadCanonicalFrameRows, MAX_FRAME_OBJECTS } from '../metrics/dayEvidence.js';
import { computeDayCompleteness, DAY_STATUS } from '../metrics/dayCompleteness.js';
import { dayBounds } from '../time/dayBoundary.js';
import {
  PRODUCT_DAY_STATUS,
  collectDeviceFrontiers,
  completenessFrontiers,
  resolveProductDayState,
  buildIngestReconciliation,
  historicalLagMs,
  mergeRangeEvidence,
  derivedSensorThrough,
} from '../metrics/continuityAccounting.js';
import {
  harvardRT, harvardCorrupt, puffinRT, puffinHistorical, notifyOf,
} from './fixtures/whoopFrames.mjs';

const TZ = 'America/Los_Angeles';
const DAY = '2026-08-28';
const PUFFIN = 'FD4B0003-8D6D-82B8-614A-1C8CB0F8DCC6';

function unknownTypeFrame() {
  const inner = [77, 1, 1, 2, 3, 4];
  const length = inner.length + 4;
  const frame = [0xAA, length & 0xFF, (length >> 8) & 0xFF, 0, ...inner];
  frame[3] = crc8(frame, 1, 3);
  const c = crc32(inner);
  frame.push(c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF, (c >> 24) & 0xFF);
  return Uint8Array.from(frame);
}

function denseHour(startIso, n = 900, bpm = 60) {
  const start = Date.parse(startIso);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      datetime: new Date(start + i * 4000).toISOString(),
      bpm,
      rr_ms: [],
      connected: true,
      src: 'ble_hr',
    });
  }
  return out;
}

test('fragmented notifies reassemble; Level B keeps hash, CRC, decoder, notify seq', () => {
  const f = harvardRT(3, 1700000000, 500, 72, 2);
  const half = Math.floor(f.length / 2);
  const n1 = notifyOf(f.slice(0, half), {
    seq: 11, fw: '50.35.2.0', model: 'WHOOP 5', device_id: 'strap-a',
  });
  const n2 = notifyOf(f.slice(half), {
    seq: 12, fw: '50.35.2.0', model: 'WHOOP 5', device_id: 'strap-a',
  });
  const r = replayNotifies([n1, n2], { decoder: 'frwhoop-js/1' });
  assert.equal(r.session.notifications_received, 2);
  assert.equal(r.levelB.length, 1);
  const rec = r.levelB[0];
  assert.equal(rec.packet_type, 40);
  assert.equal(rec.crc_ok, true);
  assert.equal(rec.frame_hash.length, 64);
  assert.equal(rec.fw, '50.35.2.0');
  assert.equal(rec.model, 'WHOOP 5');
  assert.equal(rec.device_id, 'strap-a');
  assert.equal(rec.receive_seq, 12);
  assert.equal(rec.decoder_version, 'frwhoop-js/1');
  const pipe = pipelineAccounting(r.session, r.levelB);
  assert.equal(pipe.notifications, 2);
  assert.equal(pipe.frames, 1);
  assert.equal(pipe.crc_valid, 1);
  assert.equal(pipe.decoded_rows, 1);
  assert.equal(pipe.raw_only_rows, 0);
});

test('unknown packet type survives as Level B evidence, not physiology', () => {
  const n = notifyOf(unknownTypeFrame(), { seq: 4 });
  const r = replayNotifies([n]);
  assert.equal(r.levelB.length, 1);
  assert.equal(r.levelB[0].packet_type, 77);
  assert.equal(r.levelB[0].crc_ok, true);
  assert.ok(r.levelB[0].decode_status === 'unknown' || r.levelB[0].packet_name == null);
  const pipe = pipelineAccounting(r.session, r.levelB);
  assert.equal(pipe.unknown_packet_types, 1);
  assert.equal(pipe.raw_only_rows, 1);
  const derived = deriveRecords([n]);
  assert.equal(derived.imu.length, 0);
});

test('unknown v47 layout survives; no trusted physiology', () => {
  const f = puffinHistorical(47, 47, { body: [0, 0, 0, 0, 0, 0, 0, 0] });
  const n = notifyOf(f, { family: 'puffin', char: PUFFIN, seq: 9, fw: '50.35.2.0' });
  const r = replayNotifies([n]);
  assert.equal(r.levelB.length, 1);
  assert.equal(r.levelB[0].packet_type, 47);
  assert.equal(r.levelB[0].crc_ok, true);
  assert.equal(r.levelB[0].decoded?.mapped, false);
  assert.equal(r.levelB[0].layout, 47);
  const pipe = pipelineAccounting(r.session, r.levelB);
  assert.equal(pipe.unknown_layouts, 1);
  assert.equal(pipe.decoded_rows, 0);
  assert.equal(pipe.raw_only_rows, 1);
  const derived = deriveRecords([n]);
  assert.equal(derived.imu.length, 0);
});

test('CRC-invalid complete frame is evidence and cannot produce trusted physiology', () => {
  const f = harvardCorrupt(1, 1700000000, 500, 65, 2, 9);
  const n = notifyOf(f, { seq: 1 });
  const r = replayNotifies([n]);
  assert.equal(r.levelB.length, 1);
  assert.equal(r.levelB[0].crc_ok, false);
  assert.equal(r.levelB[0].decode_status, 'crc_failed');
  assert.ok(r.levelB[0].frame_hash);
  const d = decodeFrame(f, 'harvard');
  assert.equal(d.decode_status, 'crc_failed');
  assert.equal(d.decoded, null);
  const pipe = pipelineAccounting(r.session, r.levelB);
  assert.equal(pipe.crc_invalid, 1);
  assert.equal(pipe.raw_only_rows, 1);
  const derived = deriveRecords([n]);
  assert.equal(derived.imu.length, 0);
  assert.equal(derived.session.crc_invalid_frames, 1);
});

test('duplicate replay is idempotent: same hash, two decoder sidecars', () => {
  const f = puffinRT(2, 1700000001, 250, 72, 1);
  const n = notifyOf(f, { family: 'puffin', char: PUFFIN, seq: 5 });
  const a = replayNotifies([n, n]);
  assert.ok(a.session.duplicate_frames >= 1);
  assert.equal(new Set(a.levelB.map((x) => x.frame_hash)).size, 1);
  const hash = a.levelB[0].frame_hash;
  const s1 = sidecarFromLevelB(a.levelB[0], 'frwhoop-js/1');
  const s2 = sidecarFromLevelB(a.levelB[0], 'frwhoop-js/2');
  assert.equal(s1.frame_hash, hash);
  assert.equal(s2.frame_hash, hash);
  assert.equal(s1.decoder_version, 'frwhoop-js/1');
  assert.equal(s2.decoder_version, 'frwhoop-js/2');
  const b = replayNotifies([n]);
  assert.equal(b.levelB[0].frame_hash, hash);
});

test('type-43 high-rate is realtime-only and not recoverable from history', () => {
  const f = puffinHistorical(43, 1, { body: Array(20).fill(0) });
  const n = notifyOf(f, { family: 'puffin', char: PUFFIN, seq: 8 });
  const r = replayNotifies([n]);
  const pipe = pipelineAccounting(r.session, r.levelB);
  assert.equal(pipe.realtime_high_rate.length, 1);
  assert.equal(pipe.realtime_high_rate[0].packet_type, 43);
  assert.equal(pipe.realtime_high_rate[0].recoverable, false);
});

test('connected + type-40 arriving is never day complete', () => {
  const b = dayBounds(DAY, TZ);
  const samples = [{
    datetime: b.day_start_at,
    bpm: 72,
    rr_ms: [],
    connected: true,
    src: 'ble_hr',
  }];
  const completeness = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    manifestRows: [],
    verification: {},
    dayFinishedAt: null,
    now: new Date('2026-08-28T18:00:00Z'),
  });
  assert.notEqual(completeness.status, DAY_STATUS.COMPLETE);
  const frontiers = collectDeviceFrontiers({
    live: { connected: true, heartRate: 72, deviceId: 'strap' },
    completeness,
  });
  const product = resolveProductDayState({
    completeness,
    frontiers,
    now: new Date('2026-08-28T18:00:00Z'),
    day: DAY,
    timeZone: TZ,
  });
  assert.notEqual(product, PRODUCT_DAY_STATUS.COMPLETE);
  assert.ok(
    product === PRODUCT_DAY_STATUS.COLLECTING
    || product === PRODUCT_DAY_STATUS.STALE
    || product === PRODUCT_DAY_STATUS.WAITING_FOR_HISTORY,
  );
});

test('live healthy with a stuck durable frontier is stale, not complete', () => {
  const completeness = {
    day: '2026-09-01',
    timezone_name: TZ,
    day_finished: false,
    status: DAY_STATUS.OPEN,
    gaps: { counts: { recoverable: 0, unclassified: 0, unrecoverable: 0, expected_absence: 0 } },
    hr_coverage: { coverage_pct: 3.5 },
    contiguous_sample_through: '2026-08-31T10:00:00.000Z',
  };
  const frontiers = collectDeviceFrontiers({
    live: { connected: true, heartRate: 73 },
    completeness,
    hourBufferStats: { last_ts: { strap: Date.parse('2026-08-31T10:00:00.000Z') } },
  });
  const product = resolveProductDayState({
    completeness,
    frontiers,
    now: new Date('2026-09-01T19:00:00Z'),
    day: '2026-09-01',
    timeZone: TZ,
  });
  assert.equal(product, PRODUCT_DAY_STATUS.STALE);
});

test('recoverable history debt is waiting_for_history', () => {
  const completeness = {
    day: DAY,
    timezone_name: TZ,
    day_finished: true,
    status: DAY_STATUS.OPEN,
    gaps: {
      counts: { recoverable: 1, unclassified: 0, unrecoverable: 0, expected_absence: 0 },
      recoverable_remaining: [{ start_at: '2026-08-28T10:00:00Z', end_at: '2026-08-28T11:00:00Z', duration_ms: 3600000 }],
    },
    hr_coverage: { coverage_pct: 80 },
  };
  const product = resolveProductDayState({
    completeness,
    frontiers: collectDeviceFrontiers({ completeness, historyBufferStats: { history_complete: false } }),
    now: new Date('2026-08-29T15:00:00Z'),
  });
  assert.equal(product, PRODUCT_DAY_STATUS.WAITING_FOR_HISTORY);
});

test('derived behind B2 verified is recompute_pending', () => {
  const completeness = {
    day: DAY,
    timezone_name: TZ,
    day_finished: true,
    status: DAY_STATUS.COMPLETE,
    archive_verified_through: '2026-08-29T06:00:00.000Z',
    recomputed_through: '2026-08-28T12:00:00.000Z',
    gaps: { counts: { recoverable: 0, unclassified: 0, unrecoverable: 0, expected_absence: 0 } },
    hr_coverage: { coverage_pct: 100 },
  };
  const frontiers = collectDeviceFrontiers({
    completeness,
    historyBufferStats: { history_complete: true },
  });
  assert.ok(frontiers.b2_verified_frontier_ms > frontiers.derived_frontier_ms);
  assert.equal(
    resolveProductDayState({ completeness, frontiers, now: new Date('2026-08-29T15:00:00Z') }),
    PRODUCT_DAY_STATUS.RECOMPUTE_PENDING,
  );
});

test('off-wrist expected absence is not unresolved loss', () => {
  const completeness = {
    day: DAY,
    timezone_name: TZ,
    day_finished: true,
    status: DAY_STATUS.COMPLETE,
    gaps: {
      counts: { recoverable: 0, unclassified: 0, unrecoverable: 0, expected_absence: 1 },
      expected_absence: [{
        start_at: '2026-08-28T07:00:00.000Z',
        end_at: '2026-08-29T06:00:00.000Z',
        duration_ms: 23 * 3600000,
        kind: 'off_wrist',
      }],
    },
    hr_coverage: { coverage_pct: 8 },
  };
  const product = resolveProductDayState({
    completeness,
    frontiers: collectDeviceFrontiers({ completeness }),
    now: new Date('2026-08-29T15:00:00Z'),
  });
  assert.equal(product, PRODUCT_DAY_STATUS.OFF_WRIST);
});

test('day-boundary history marks both local days', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-cont-hist-'));
  const buffer = createHistoryBuffer({
    dir,
    userId: '55555555-5555-4555-8555-555555555555',
    engine: { archiveRawSamples: async () => ({ id: 'x', status: 'ready' }) },
    timeZone: TZ,
  });
  const accepted = buffer.appendBatch([
    { seq: 1, t: '2026-08-25T06:50:00.000Z', bpm: 61, source: 'history' },
    { seq: 2, t: '2026-08-25T07:10:00.000Z', bpm: 64, source: 'history' },
  ]);
  assert.deepEqual(accepted.affectedDays, ['2026-08-24', '2026-08-25']);
});

test('late-arriving records flip a computed day to recompute_pending', () => {
  const completeness = {
    day: DAY,
    timezone_name: TZ,
    day_finished: true,
    status: DAY_STATUS.COMPLETE,
    archive_verified_through: '2026-08-29T07:00:00.000Z',
    recomputed_through: '2026-08-29T06:00:00.000Z',
    gaps: {
      counts: { recoverable: 0, unclassified: 0, unrecoverable: 0, expected_absence: 0, backfilled: 1 },
      backfilled: [{ start_at: '2026-08-28T10:00:00Z', end_at: '2026-08-28T11:00:00Z', duration_ms: 3600000 }],
    },
    hr_coverage: { coverage_pct: 100 },
  };
  const report = buildIngestReconciliation({
    completeness,
    frontiers: collectDeviceFrontiers({
      completeness,
      historyBufferStats: { history_complete: true },
    }),
    now: new Date('2026-08-29T15:00:00Z'),
  });
  assert.equal(report.product_status, PRODUCT_DAY_STATUS.RECOMPUTE_PENDING);
  assert.equal(report.gap_kinds.repaired_by_history.length, 1);
  assert.equal(report.recompute.pending, true);
});

test('ingest reconciliation report carries expected/actual coverage, lag, B2, UI series', () => {
  const samples = denseHour('2026-08-28T15:00:00.000Z', 50);
  const completeness = computeDayCompleteness({
    day: DAY,
    timeZone: TZ,
    samples,
    dayFinishedAt: null,
    now: new Date('2026-08-28T18:00:00Z'),
  });
  const frontiers = collectDeviceFrontiers({
    live: {
      connected: true,
      heartRate: 60,
      deviceId: 'strap',
      data_range_newest: '2026-08-28T20:00:00.000Z',
      data_range_oldest: '2026-08-24T00:00:00.000Z',
      phone_physiology_frontier_ts: Date.parse('2026-08-28T15:10:00.000Z'),
    },
    hourBufferStats: {
      last_ts: { strap: Date.parse('2026-08-28T15:10:00.000Z') },
      last_seq: { strap: 100 },
      last_frame_seq: { strap: 80 },
    },
    completeness,
  });
  const report = buildIngestReconciliation({
    completeness,
    frontiers,
    evidencePipeline: {
      notifications: 10, frames: 4, crc_valid: 3, crc_invalid: 1,
      known_packet_types: 3, unknown_packet_types: 1,
      known_layouts: 0, unknown_layouts: 1,
      decoded_rows: 2, raw_only_rows: 2, realtime_high_rate: [],
    },
    uiSeries: { present: false, sample_count: 0, coverage_pct: completeness.hr_coverage.coverage_pct },
    now: new Date('2026-08-28T18:00:00Z'),
  });
  assert.ok(report.expected_coverage);
  assert.ok(report.actual_coverage);
  assert.ok('largest_gap' in report);
  assert.ok(report.historical_lag_ms > 0);
  assert.equal(report.raw_evidence.crc_invalid, 1);
  assert.equal(report.ui_series.present, false);
  assert.ok(report.frontiers.strap_newest_ms);
  assert.ok(report.frontiers.phone_physiology_frontier_ms);
  assert.ok(report.frontiers.backend_durable_frontier_ms);
  assert.equal(completenessFrontiers(frontiers).rangeTrustworthy, false);
  assert.ok(historicalLagMs(frontiers) > 0);
});

test('Level A frame objects replay through loadCanonicalFrameRows', async () => {
  const f = harvardRT(1, 1700000000, 500, 70, 1);
  const row = notifyOf(f, { seq: 1, fw: 'x', model: 'WHOOP 4' });
  const packed = encodeFrameArchive([row]);
  const db = {
    async listObjectManifests() {
      return [{ object_key: 'frames-1', object_kind: 'frames', sha256: packed.sha256 }];
    },
  };
  const raw = { async getObject() { return { body: packed.body }; } };
  const loaded = await loadCanonicalFrameRows({ db, raw, userId: 'u', day: DAY, timeZone: TZ });
  assert.equal(loaded.rows.length, 1);
  assert.equal(loaded.rows[0].hex, row.hex);
  const replayed = replayNotifies(loaded.rows);
  assert.equal(replayed.levelB[0].crc_ok, true);
});

test('unknown strap history frontier stays null (never fabricated from strap newest)', () => {
  const frontiers = collectDeviceFrontiers({
    live: { data_range_newest: '2026-08-28T20:00:00.000Z' },
  });
  assert.ok(frontiers.strap_newest_ms);
  assert.equal(frontiers.strap_history_frontier_ms, null);
});

test('finished dense day with missing frontiers is waiting_for_history, not complete', () => {
  const samples = denseHour('2026-08-28T07:00:00.000Z', 900);
  const more = denseHour('2026-08-28T08:00:00.000Z', 900);
  const completeness = {
    day: DAY,
    timezone_name: TZ,
    day_finished: true,
    status: DAY_STATUS.COMPLETE,
    archive_verified_through: '2026-08-29T06:00:00.000Z',
    gaps: { counts: { recoverable: 0, unclassified: 0, unrecoverable: 0, expected_absence: 0 } },
    hr_coverage: { coverage_pct: 100, received_samples: samples.length + more.length },
  };
  const product = resolveProductDayState({
    completeness,
    frontiers: collectDeviceFrontiers({ completeness }),
    now: new Date('2026-08-29T15:00:00Z'),
  });
  assert.equal(product, PRODUCT_DAY_STATUS.WAITING_FOR_HISTORY);
});

test('recompute_pending compares B2 sample time to derived sample time, not computed_at', () => {
  const completeness = {
    day: DAY,
    timezone_name: TZ,
    day_finished: true,
    status: DAY_STATUS.COMPLETE,
    archive_verified_through: '2026-08-29T07:00:00.000Z',
    gaps: { counts: { recoverable: 0, unclassified: 0, unrecoverable: 0, expected_absence: 0 } },
    hr_coverage: { coverage_pct: 100 },
  };
  const derivedThrough = derivedSensorThrough({
    dailyRow: {
      computed_at: '2026-08-29T15:00:00.000Z',
      extras: { latest_sensor_at: '2026-08-29T06:00:00.000Z' },
    },
  });
  assert.equal(derivedThrough, Date.parse('2026-08-29T06:00:00.000Z'));
  const frontiers = collectDeviceFrontiers({
    completeness,
    derivedThrough,
    historyBufferStats: { history_complete: true },
  });
  assert.equal(
    resolveProductDayState({ completeness, frontiers, now: new Date('2026-08-29T16:00:00Z') }),
    PRODUCT_DAY_STATUS.RECOMPUTE_PENDING,
  );
});

test('mergeRangeEvidence skips nulls and keeps the later watermark', () => {
  const first = mergeRangeEvidence({}, {
    data_range_oldest: '2026-08-20T00:00:00.000Z',
    data_range_newest: '2026-08-28T12:00:00.000Z',
    raw_type47_newest: '2026-08-28T11:00:00.000Z',
  });
  const clobbered = mergeRangeEvidence(first, {
    data_range_oldest: null,
    data_range_newest: null,
    raw_type47_newest: null,
    range_trustworthy: false,
  });
  assert.equal(clobbered.data_range_newest, '2026-08-28T12:00:00.000Z');
  assert.equal(clobbered.raw_type47_newest, '2026-08-28T11:00:00.000Z');
  assert.equal(clobbered.range_trustworthy, true);
  const newer = mergeRangeEvidence(clobbered, { data_range_newest: '2026-08-28T18:00:00.000Z' });
  assert.equal(newer.data_range_newest, '2026-08-28T18:00:00.000Z');
});

test('unreadable or digest-mismatched frame objects are failures, not empty evidence', async () => {
  const f = harvardRT(1, 1700000000, 500, 70, 1);
  const row = notifyOf(f, { seq: 1 });
  const packed = encodeFrameArchive([row]);
  const db = {
    async listObjectManifests() {
      return [
        { object_key: 'frames-bad', object_kind: 'frames', sha256: '0'.repeat(64), status: 'ready' },
        { object_key: 'frames-gone', object_kind: 'frames', status: 'ready' },
      ];
    },
  };
  const raw = {
    async getObject(key) {
      if (key === 'frames-bad') return { body: packed.body };
      return { body: packed.body };
    },
  };
  const loaded = await loadCanonicalFrameRows({ db, raw, userId: 'u', day: DAY, timeZone: TZ });
  assert.equal(loaded.rows.length, 0);
  assert.equal(loaded.failures.length, 2);
  assert.ok(loaded.failures.some((f) => f.reason === 'digest_mismatch'));
  assert.ok(loaded.failures.some((f) => f.reason === 'missing_digest'));
  assert.equal(loaded.unavailableReason, 'digest_mismatch');
});

test('frame verify is bounded and marks truncated', async () => {
  const packed = encodeFrameArchive([notifyOf(harvardRT(1, 1700000000, 500, 70, 1), { seq: 1 })]);
  const manifests = Array.from({ length: MAX_FRAME_OBJECTS + 3 }, (_, i) => ({
    object_key: `frames-${i}`,
    object_kind: 'frames',
    sha256: packed.sha256,
    status: 'ready',
  }));
  const db = { async listObjectManifests() { return manifests; } };
  const raw = { async getObject() { return { body: packed.body }; } };
  const loaded = await loadCanonicalFrameRows({ db, raw, userId: 'u', day: DAY, timeZone: TZ });
  assert.equal(loaded.truncated, true);
  assert.equal(loaded.rows.length, MAX_FRAME_OBJECTS);
});

test('range evidence is merge-safe and survives process restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-range-'));
  const engine = {
    archiveRawSamples: async () => null,
    persistComputed: async () => null,
    recomputeFromStorage: async () => ({}),
  };
  const uid = '55555555-5555-4555-8555-555555555555';
  const first = createUserRuntimes({
    engine, liveDir: dir, loadStore: () => ({}), saveStore: () => {}, loadPersistedDays: async () => ({}),
  });
  first.noteRangeEvidence(uid, {
    data_range_oldest: '2026-08-20T00:00:00.000Z',
    data_range_newest: '2026-08-28T12:00:00.000Z',
    raw_type47_newest: '2026-08-28T11:00:00.000Z',
  });
  first.noteRangeEvidence(uid, {
    data_range_oldest: null,
    data_range_newest: null,
    raw_type47_newest: null,
    range_trustworthy: false,
  });
  assert.equal(first.liveOf(uid).data_range_newest, '2026-08-28T12:00:00.000Z');
  const second = createUserRuntimes({
    engine, liveDir: dir, loadStore: () => ({}), saveStore: () => {}, loadPersistedDays: async () => ({}),
  });
  second.hydrateFromDisk(dir);
  assert.equal(second.liveOf(uid).data_range_newest, '2026-08-28T12:00:00.000Z');
  assert.equal(second.liveOf(uid).raw_type47_newest, '2026-08-28T11:00:00.000Z');
});
