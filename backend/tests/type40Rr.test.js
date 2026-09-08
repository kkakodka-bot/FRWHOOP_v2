import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { puffinRT } from './fixtures/whoopFrames.mjs';
import { decodeFrame } from '../protocol/decoder.js';
import { verifyFrame } from '../protocol/framing.js';
import { beatsFromRrArray, beatsFromRrSamples } from '../hrv/beats.js';
import { intervalsFromSamples } from '../hrv/engine.js';
import { beatsFromSamples } from '../respiration/engine.js';
import { observationsFromSamples } from '../hr2/observation.js';
import { dedupeObservations } from '../hr2/dedupe.js';
import { rrStats } from '../signal/quality.js';
import { createHistoryBuffer, advanceContiguousThrough } from '../ingest/historyBuffer.js';

const T = 1_700_000_000;

test('puffin type-40 decoder: 0/1/many RR, no four-slot cap, zeros, bounds', () => {
  const empty = decodeFrame(puffinRT(1, T, 0, 72, 0), 'puffin').decoded;
  assert.deepEqual(empty.rr_intervals, []);
  assert.equal(empty.rr_count_declared, 0);

  const one = decodeFrame(puffinRT(1, T, 0, 72, 1, [812]), 'puffin').decoded;
  assert.deepEqual(one.rr_intervals, [812]);

  const many = decodeFrame(
    puffinRT(1, T, 0, 72, 5, [700, 710, 720, 730, 740]),
    'puffin',
  ).decoded;
  assert.deepEqual(many.rr_intervals, [700, 710, 720, 730, 740]);

  const zeros = decodeFrame(puffinRT(1, T, 0, 72, 3, [800, 0, 810]), 'puffin').decoded;
  assert.deepEqual(zeros.rr_intervals, [800, 810]);
  assert.equal(zeros.rr_zero_slots, 1);

  const bounds = decodeFrame(puffinRT(1, T, 0, 72, 2, [200, 2500]), 'puffin').decoded;
  assert.deepEqual(bounds.rr_intervals, [200, 2500]);

  const oor = decodeFrame(puffinRT(1, T, 0, 72, 2, [199, 2501]), 'puffin').decoded;
  assert.deepEqual(oor.rr_intervals, []);
  assert.equal(oor.rr_out_of_range, 2);

  const truncated = decodeFrame(puffinRT(1, T, 0, 72, 8, [800]), 'puffin').decoded;
  assert.deepEqual(truncated.rr_intervals, [800]);
  assert.equal(truncated.rr_truncated_count, 7);
});

test('CRC-invalid puffin type-40 preserves raw bytes and emits no RR', () => {
  const frame = [...puffinRT(1, T, 0, 72, 1, [800])];
  frame[18] ^= 1;
  const rec = decodeFrame(frame, 'puffin');
  assert.equal(rec.decode_status, 'crc_failed');
  assert.equal(rec.decoded, null);
  assert.ok(rec.raw_hex);
  assert.equal(verifyFrame(frame, 'puffin').ok, false);
});

test('subseconds use the shared 1/32768 helper', () => {
  const rec = decodeFrame(puffinRT(1, T, 16384, 60, 0), 'puffin').decoded;
  assert.equal(rec.subseconds, 16384);
  assert.equal(rec.sensor_time_ms, (T + 0.5) * 1000);
});

test('beats walk backward; equal consecutive RRs stay two beats', () => {
  const end = Date.parse('2026-08-25T02:00:10Z');
  const beats = beatsFromRrArray(end, [800, 900, 1000]);
  assert.deepEqual(beats.map((b) => b.rrMs), [800, 900, 1000]);
  assert.equal(beats[2].ts, end);
  assert.equal(beats[1].ts, end - 1000);
  assert.equal(beats[0].ts, end - 1900);

  const twins = beatsFromRrArray(end, [812, 812]);
  assert.equal(twins.length, 2);
  assert.equal(twins[0].rrMs, 812);
  assert.equal(twins[1].rrMs, 812);
  assert.equal(twins[1].ts - twins[0].ts, 812);
});

test('Type-40 and GATT at the same second keep one RR sequence', () => {
  const t = '2026-08-25T02:00:10.000Z';
  const samples = [
    { t, datetime: t, bpm: 72, rr_ms: [812], src: 'whoop_type40', device_id: 'd', seq: 1 },
    { t, datetime: t, bpm: 72, rr_ms: [812], src: 'gatt_hr', device_id: 'd', seq: 2 },
  ];
  const { kept, suppressed, stats } = dedupeObservations(observationsFromSamples(samples));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].src, 'whoop_type40');
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0].src, 'gatt_hr');
  assert.ok(stats.crossSourceSuppressed >= 1);

  const hrv = intervalsFromSamples(samples);
  const resp = beatsFromSamples(samples);
  assert.deepEqual(hrv.map((b) => b.rrMs), resp.map((b) => b.rrMs));
  assert.equal(hrv.length, 1);
});

test('late same-timestamp RR extends an earlier empty-RR sample', () => {
  const t = '2026-08-25T02:00:10.000Z';
  const beats = beatsFromRrSamples([
    { t, datetime: t, bpm: 50, rr_ms: [], src: 'whoop_history', seq: 10800 },
    { t, datetime: t, bpm: 50, rr_ms: [1200], src: 'whoop_history', seq: 0 },
  ]);
  assert.equal(beats.length, 1);
  assert.equal(beats[0].rrMs, 1200);
});

test('later historical overlap does not double HRV beats', () => {
  const t = '2026-08-25T02:00:10.000Z';
  const samples = [
    { t, datetime: t, bpm: 72, rr_ms: [800, 810], src: 'whoop_type40', device_id: 'd', seq: 1 },
    { t, datetime: t, bpm: 72, rr_ms: [800, 810], src: 'whoop_history', device_id: 'd', seq: 9 },
  ];
  const beats = beatsFromRrSamples(samples);
  assert.equal(beats.length, 2);
  assert.equal(beats[0].src, 'whoop_history');
});

test('successive RR difference is not taken across connection epoch', () => {
  const stats = rrStats([
    { rrMs: 800, epoch: 1 },
    { rrMs: 2000, epoch: 2 },
  ]);
  assert.equal(stats.count, 2);
  assert.equal(stats.rejected, 0);
});

test('isolated late sample does not advance contiguous frontier', () => {
  const t0 = Date.parse('2026-08-25T00:00:00Z');
  assert.equal(advanceContiguousThrough(t0, t0 + 60_000), t0 + 60_000);
  assert.equal(advanceContiguousThrough(t0, t0 + 120_000), t0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-contig-'));
  const buffer = createHistoryBuffer({ dir, userId: 'u', engine: {} });
  const first = Date.parse('2026-08-25T01:00:00.000Z');
  buffer.appendBatch([
    { seq: 1, t: new Date(first).toISOString(), bpm: 60, src: 'whoop_history' },
    { seq: 2, t: new Date(first + 4_000).toISOString(), bpm: 61, src: 'whoop_history' },
    { seq: 3, t: new Date(first + 3_600_000).toISOString(), bpm: 62, src: 'whoop_history' },
  ]);
  const stats = buffer.stats();
  const through = Date.parse(stats.history_contiguous_through);
  assert.ok(through < first + 3_600_000, 'MAX timestamp must not catch up the frontier');
  assert.ok(through >= first);
});
