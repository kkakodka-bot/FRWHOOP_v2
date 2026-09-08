import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHistoryBuffer, normalizeHistoricalSample } from '../ingest/historyBuffer.js';

const USER = '11111111-1111-4111-8111-111111111111';

test('history buffer buckets out-of-order sensor timestamps by UTC hour and day', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-'));
  const archived = [];
  const buffer = createHistoryBuffer({
    dir,
    userId: USER,
    engine: {
      archiveRawSamples: async (args) => {
        archived.push(args);
        return { id: `obj-${archived.length}`, status: 'ready' };
      },
    },
  });
  const accepted = buffer.appendBatch([
    { seq: 3, t: '2026-08-25T00:00:04.000Z', bpm: 62, source: 'history' },
    { seq: 1, t: '2026-08-24T23:00:00.000Z', gx: 0, gy: 1, gz: 0, source: 'history' },
    { seq: 2, t: '2026-08-24T23:59:56.000Z', rr_ms: [970], source: 'history' },
  ]);
  assert.equal(accepted.durable, 3);
  assert.deepEqual(accepted.affectedDays, ['2026-08-24', '2026-08-25']);

  const result = await buffer.flush();
  assert.equal(result.flushed, 3);
  assert.deepEqual(result.affectedDays, ['2026-08-24', '2026-08-25']);
  assert.equal(archived.length, 2);
  assert.equal(archived[0].extras.periodDay, '2026-08-24');
  assert.equal(archived[0].hourStart, '2026-08-24T23:00:00.000Z');
  assert.deepEqual(archived[0].samples.map((row) => row.seq), [1, 2]);
  assert.equal(archived[1].extras.periodDay, '2026-08-25');
  assert.deepEqual(buffer.pendingDays(), []);
});

test('history flush bounds every archive batch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-bounded-'));
  const engine = {};
  const buffer = createHistoryBuffer({
    dir,
    userId: USER,
    engine,
    maxBatchSamples: 2,
  });
  buffer.appendBatch(Array.from({ length: 5 }, (_, i) => ({
    seq: i + 1,
    t: new Date(Date.parse('2026-08-24T18:00:00.000Z') + i * 4000).toISOString(),
    bpm: 60 + i,
  })));
  const sizes = [];
  engine.archiveRawSamples = async ({ samples }) => {
    sizes.push(samples.length);
    return { status: 'ready' };
  };
  await buffer.flush();
  assert.deepEqual(sizes, [2, 2, 1]);
  assert.equal(buffer.pendingCount(), 0);
});

test('history WAL survives archive failure and retries without loss', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-retry-'));
  let attempts = 0;
  const buffer = createHistoryBuffer({
    dir,
    userId: USER,
    engine: {
      archiveRawSamples: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('b2 unavailable');
        return { id: 'obj-ok', status: 'ready' };
      },
    },
  });
  const accepted = buffer.appendBatch([
    { seq: 9, datetime: '2026-08-24T18:00:00.000Z', bpm: 60 },
  ]);
  assert.equal(accepted.ackedThrough, 9);
  assert.equal(buffer.pendingCount(), 1);
  await assert.rejects(buffer.flush(), /b2 unavailable/);
  assert.equal(buffer.pendingCount(), 1);
  assert.match(
    fs.readFileSync(path.join(dir, USER, 'history-pending-wal.ndjson'), 'utf8'),
    /"seq":9/,
  );
  const retried = await buffer.flush();
  assert.equal(retried.flushed, 1);
  assert.equal(buffer.pendingCount(), 0);
  assert.equal(attempts, 2);
});

test('history WAL recovers pending rows after restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-recover-'));
  const first = createHistoryBuffer({ dir, userId: USER, engine: {} });
  first.appendBatch([
    { seq: 17, t: '2026-08-23T04:00:00.000Z', gx: 0.1, gy: 0.2, gz: 0.9 },
  ]);
  assert.equal(first.pendingCount(), 1);

  const archived = [];
  const recovered = createHistoryBuffer({
    dir,
    userId: USER,
    engine: {
      archiveRawSamples: async (args) => {
        archived.push(args);
        return { status: 'verified' };
      },
    },
  });
  assert.equal(recovered.pendingCount(), 1);
  await recovered.flush();
  assert.equal(recovered.pendingCount(), 0);
  assert.equal(archived[0].samples[0].seq, 17);
});

test('history completion and affected days remain exposed after restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-state-'));
  const first = createHistoryBuffer({ dir, userId: USER, engine: {} });
  const result = first.appendBatch([{
    seq: 22,
    t: '2026-08-21T12:00:00.000Z',
    bpm: 58,
  }], { historyComplete: true });
  assert.equal(result.historyComplete, true);
  assert.deepEqual(first.affectedDays(), ['2026-08-21']);

  const recovered = createHistoryBuffer({ dir, userId: USER, engine: {} });
  assert.equal(recovered.historyComplete(), true);
  assert.deepEqual(recovered.affectedDays(), ['2026-08-21']);
});

test('new history cycle clears the previous completion state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-cycle-'));
  const buffer = createHistoryBuffer({ dir, userId: USER, engine: {} });
  buffer.appendBatch([{
    seq: 22,
    t: '2026-08-21T12:00:00.000Z',
    bpm: 58,
  }], { historyComplete: true });
  assert.equal(buffer.historyComplete(), true);

  const next = buffer.appendBatch([{
    seq: 23,
    t: '2026-08-25T12:00:00.000Z',
    gx: 0,
    gy: 1,
    gz: 0,
  }]);
  assert.equal(next.historyComplete, false);
  assert.equal(buffer.historyComplete(), false);
  assert.deepEqual(buffer.affectedDays(), ['2026-08-25']);
});

test('history normalization keeps a v18 SpO2 candidate without fabricating spo2_pct', () => {
  const row = normalizeHistoricalSample({
    seq: 9,
    t: '2026-02-25T02:00:00.000Z',
    spo2_raw_byte: 94,
    source_frame_hash: 'ab'.repeat(32),
  });
  assert.equal(row.spo2_raw_byte, 94);
  assert.equal(row.spo2_candidate_pct, 94);
  assert.equal(row.spo2_state, 'candidate');
  assert.equal(row.spo2_pct, undefined);
  assert.equal(normalizeHistoricalSample({
    seq: 10,
    t: '2026-02-25T02:00:04.000Z',
    spo2_raw_byte: 0,
  }), null);
});

test('history normalization keeps HR when gravity is a dummy zero vector', () => {
  const row = normalizeHistoricalSample({
    seq: 4,
    t: '2026-08-24T18:00:00.000Z',
    bpm: 72,
    gx: 0,
    gy: 0,
    gz: 0,
    dyn_accel: 0.2,
  });
  assert.equal(row.bpm, 72);
  assert.equal(row.gx, null);
  assert.equal(row.src, 'whoop_history');
});

test('history normalization rejects invalid vectors and requires sequence', () => {
  assert.equal(normalizeHistoricalSample({
    seq: 1,
    t: '2026-08-24T18:00:00.000Z',
    gx: 0.1,
    gy: 0.2,
  }), null);
  assert.equal(normalizeHistoricalSample({
    seq: 2,
    t: '2026-08-24T18:00:00.000Z',
    gx: 20,
    gy: 0,
    gz: 0,
  }), null);
  assert.equal(normalizeHistoricalSample({
    t: '2026-08-24T18:00:00.000Z',
    bpm: 60,
  }), null);
  assert.ok(normalizeHistoricalSample({
    seq: 3,
    t: '2026-08-24T18:00:00.000Z',
    gx: 0,
    gy: 1,
    gz: 0,
    phoneMotion: 5,
  }));
});


test('history flush recomputes affected days before the cycle completes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-incremental-'));
  const recomputed = [];
  const buffer = createHistoryBuffer({
    dir,
    userId: USER,
    engine: {
      archiveRawSamples: async () => ({ id: 'obj-ok', status: 'ready' }),
    },
    onHistoryComplete: async ({ affectedDays, historyComplete }) => {
      recomputed.push({ affectedDays, historyComplete });
    },
  });
  buffer.appendBatch([
    { seq: 1, datetime: '2026-08-24T18:00:00.000Z', bpm: 60, step_cumulative: 10 },
  ]);
  const result = await buffer.flush();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.recomputeScheduled, true);
  assert.deepEqual(result.recomputeDays, ['2026-08-24']);
  assert.equal(recomputed.length, 1);
  assert.equal(recomputed[0].historyComplete, false);
  assert.deepEqual(recomputed[0].affectedDays, ['2026-08-24']);
});


test('history completion triggers recompute over every affected day', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-recompute-'));
  const recomputed = [];
  let completed = false;
  const buffer = createHistoryBuffer({
    dir,
    userId: USER,
    engine: {
      archiveRawSamples: async () => ({ id: 'obj-ok', status: 'ready' }),
    },
    onHistoryComplete: async ({ affectedDays, historyComplete }) => {
      completed = historyComplete;
      recomputed.push(affectedDays);
    },
  });
  buffer.appendBatch([
    { seq: 1, datetime: '2026-08-24T18:00:00.000Z', bpm: 60 },
    { seq: 2, datetime: '2026-08-24T20:00:00.000Z', gx: 0, gy: 1, gz: 0 },
  ]);
  buffer.appendBatch([{ seq: 3, datetime: '2026-08-25T02:00:00.000Z', bpm: 61 }], { historyComplete: true });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(completed, 'completion callback fired');
  assert.deepEqual(recomputed[0], ['2026-08-24', '2026-08-25']);
  assert.ok(buffer.pendingCount() === 0);
});

test('stale historyComplete with new rows starts a new cycle', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-stale-complete-'));
  const cycles = [];
  const buffer = createHistoryBuffer({
    dir,
    userId: USER,
    engine: {
      archiveRawSamples: async () => ({ id: 'obj-ok', status: 'ready' }),
    },
    onHistoryComplete: async ({ affectedDays }) => {
      cycles.push(affectedDays);
    },
  });
  buffer.appendBatch([{ seq: 1, datetime: '2026-08-24T18:00:00.000Z', bpm: 60 }], { historyComplete: true });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  buffer.appendBatch([{ seq: 2, datetime: '2026-08-30T18:00:00.000Z', bpm: 70 }], { historyComplete: true });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cycles[0], ['2026-08-24']);
  assert.deepEqual(cycles[1], ['2026-08-30']);
});


test('reconnection re-send of already-persisted history is deduped by (device, sensor_ts)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-hdup-'));
  const engine = {
    async archiveRawSamples() { return { id: 'o', status: 'ready' }; },
  };
  const buf = createHistoryBuffer({ dir, userId: '7f2c9a10-4b3e-4d8a-9c11-00000000f001', engine });
  const chunk = [
    { seq: 1, t: '2026-08-24T18:00:00.000Z', bpm: 60, deviceId: 'strap1', src: 'whoop_history', layout: 'v21', decoder: 'ios/3' },
    { seq: 2, t: '2026-08-24T18:00:04.000Z', bpm: 61, deviceId: 'strap1', src: 'whoop_history', layout: 'v21', decoder: 'ios/3' },
    { seq: 3, t: '2026-08-24T18:00:08.000Z', bpm: 62, deviceId: 'strap1', src: 'whoop_history', layout: 'v21', decoder: 'ios/3' },
  ];
  const first = buf.appendBatch(chunk);
  assert.equal(first.accepted, 3);
  assert.equal(first.results.filter((r) => r.duplicate).length, 0);

  // Simulate a reconnect that re-streams the SAME window but with FRESH seqs
  // (the phone mints a new seq per re-appended row). src:seq would miss this;
  // (device, sensor_ts) must catch it.
  const resend = buf.appendBatch(chunk.map((c) => ({ ...c, seq: c.seq + 1000 })));
  assert.equal(resend.accepted, 0, 're-sent chunk must not be accepted again');
  assert.equal(resend.results.filter((r) => r.duplicate).length, 3);
  assert.equal(buf.pendingCount(), 3);
});

test('same wall second with different step counters is not a duplicate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-stepdup-'));
  const buf = createHistoryBuffer({
    dir,
    userId: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
    engine: { async archiveRawSamples() { return { id: 'o', status: 'ready' }; } },
  });
  const t = '2026-08-24T18:00:00.000Z';
  const first = buf.appendBatch([
    { seq: 1, t, bpm: 60, step_cumulative: 100, deviceId: 'strap1', src: 'whoop_history', layout: 'v18', decoder: 'ios/3' },
  ]);
  const second = buf.appendBatch([
    { seq: 2, t, bpm: 60, step_cumulative: 104, deviceId: 'strap1', src: 'whoop_history', layout: 'v18', decoder: 'ios/3' },
  ]);
  assert.equal(first.accepted, 1);
  assert.equal(second.accepted, 1);
  assert.equal(buf.pendingCount(), 2);
});

test('history buffer keeps a months-old but plausible strap clock on its real days', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-clock-'));
  const archived = [];
  const now = () => new Date('2026-08-25T22:00:00.000Z');
  const buffer = createHistoryBuffer({
    dir,
    userId: USER,
    now,
    engine: {
      archiveRawSamples: async (args) => {
        archived.push(args);
        return { status: 'ready' };
      },
    },
  });
  const accepted = buffer.appendBatch([
    { seq: 1, t: '2026-01-24T20:23:00.000Z', bpm: 60, source: 'history' },
    { seq: 2, t: '2026-01-24T23:23:00.000Z', bpm: 62, source: 'history' },
  ]);
  // An unsynced strap legitimately banks months of flash. Shifting it forward
  // would restamp January onto today and invent a workout that never happened.
  assert.deepEqual(accepted.affectedDays, ['2026-01-24']);
  assert.deepEqual(buffer.pendingDays(), ['2026-01-24']);
  await buffer.flush();
  const samples = archived.flatMap((row) => row.samples);
  const times = samples.map((row) => row.t).sort();
  assert.equal(times[0], '2026-01-24T20:23:00.000Z');
  assert.equal(times[1], '2026-01-24T23:23:00.000Z');
});

test('history buffer rebases a pre-2015 epoch clock onto receive time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-clock-epoch-'));
  const buffer = createHistoryBuffer({
    dir,
    userId: USER,
    now: () => new Date('2026-08-25T22:00:00.000Z'),
    engine: {},
  });
  const accepted = buffer.appendBatch([{ seq: 1, t: '1970-01-01T00:00:05.000Z', bpm: 60 }]);
  assert.deepEqual(accepted.affectedDays, ['2026-08-25']);
});

test('history buffer rebases a strap clock running ahead of receive time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-clock-future-'));
  const buffer = createHistoryBuffer({
    dir,
    userId: USER,
    now: () => new Date('2026-08-25T22:00:00.000Z'),
    engine: {},
  });
  // Flash cannot hold samples from the future, so this clock is provably wrong.
  const accepted = buffer.appendBatch([{ seq: 1, t: '2026-10-01T00:00:00.000Z', bpm: 60 }]);
  assert.deepEqual(accepted.affectedDays, ['2026-08-25']);
});

test('history WAL with a plausible old strap clock keeps its days on recover', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-clock-wal-'));
  const first = createHistoryBuffer({
    dir,
    userId: USER,
    now: () => new Date('2026-08-25T22:00:00.000Z'),
    engine: {},
  });
  first.appendBatch([{ seq: 9, t: '2026-01-24T23:23:00.000Z', bpm: 61 }]);
  assert.deepEqual(first.pendingDays(), ['2026-01-24']);

  const recovered = createHistoryBuffer({
    dir,
    userId: USER,
    now: () => new Date('2026-08-25T22:05:00.000Z'),
    engine: {},
  });
  assert.deepEqual(recovered.pendingDays(), ['2026-01-24']);
  assert.equal(recovered.stats().clock_offset_ms || 0, 0);
});

test('pendingSamples exposes unflushed historical BPM for the 24h curve', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-pending-'));
  const buffer = createHistoryBuffer({
    dir,
    userId: USER,
    engine: {},
  });
  buffer.appendBatch([
    { seq: 1, datetime: '2026-08-26T09:00:00.000Z', bpm: 64 },
    { seq: 2, datetime: '2026-08-26T09:00:01.000Z', bpm: 65 },
  ]);
  const pending = buffer.pendingSamples();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].bpm, 64);
  assert.equal(pending[1].datetime, '2026-08-26T09:00:01.000Z');
});

// --- Live-evidence anchor for misdated banked history (2026-08 failure) ---

test('live-evidence anchor re-dates banked history stamped days behind wall', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-anchor-'));
  const buffer = createHistoryBuffer({
    dir,
    userId: USER,
    // Drain moment: wall 2026-08-27T23:00Z, live type-40 also ≈ now.
    now: () => new Date('2026-08-27T23:00:00.000Z'),
    engine: {},
  });
  const wall1 = Date.parse('2026-08-27T18:00:00.000Z');
  const wall2 = Date.parse('2026-08-27T23:00:00.000Z');
  const bankedLag = 3 * 86_400_000; // banking clock 3 d behind wall
  // Two spaced probes: banked newest advances at wall rate, stable 3 d lag.
  buffer.noteAnchorEvidence(wall1 - bankedLag, wall1);
  buffer.noteAnchorEvidence(wall2 - bankedLag, wall2);
  // A row stamped at strap-now − 10 min (misdated banking domain) must land
  // on the drain day (2026-08-27), not the strap-clock day (2026-08-24).
  const strapStamp = new Date(wall2 - bankedLag - 600_000).toISOString();
  const accepted = buffer.appendBatch([{ seq: 1, t: strapStamp, t_strap: strapStamp, bpm: 62 }]);
  assert.deepEqual(accepted.affectedDays, ['2026-08-27']);
  assert.equal(buffer.pendingDays().includes('2026-08-24'), false);
});

test('live-evidence anchor stays off while the banking frontier is current', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-anchor-off-'));
  const buffer = createHistoryBuffer({
    dir,
    userId: USER,
    now: () => new Date('2026-08-27T23:00:00.000Z'),
    engine: {},
  });
  const wall1 = Date.parse('2026-08-27T18:00:00.000Z');
  const wall2 = Date.parse('2026-08-27T23:00:00.000Z');
  // Current banking: banked newest ≈ wall at both probes (lag ≈ 0).
  buffer.noteAnchorEvidence(wall1 - 5000, wall1);
  buffer.noteAnchorEvidence(wall2 - 5000, wall2);
  // An old-stamped row is GENUINE history: stays on its own day.
  const oldStamp = '2026-06-17T07:38:27.000Z';
  const accepted = buffer.appendBatch([{ seq: 1, t: oldStamp, t_strap: oldStamp, bpm: 61 }]);
  assert.deepEqual(accepted.affectedDays, ['2026-06-17']);
});

test('live-evidence anchor requires two spaced agreeing probes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-anchor-1probe-'));
  const buffer = createHistoryBuffer({
    dir,
    userId: USER,
    now: () => new Date('2026-08-27T23:00:00.000Z'),
    engine: {},
  });
  const wall = Date.parse('2026-08-27T23:00:00.000Z');
  buffer.noteAnchorEvidence(wall - 3 * 86_400_000, wall);
  const strapStamp = new Date(wall - 3 * 86_400_000 - 600_000).toISOString();
  const accepted = buffer.appendBatch([{ seq: 1, t: strapStamp, t_strap: strapStamp, bpm: 62 }]);
  // One probe is not confirmation: the row keeps its strap-clock day.
  assert.deepEqual(accepted.affectedDays, ['2026-08-24']);
});

test('live-evidence anchor rejects a stalled banking frontier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-anchor-stalled-'));
  const buffer = createHistoryBuffer({
    dir,
    userId: USER,
    now: () => new Date('2026-08-27T23:00:00.000Z'),
    engine: {},
  });
  const wall1 = Date.parse('2026-08-27T18:00:00.000Z');
  const wall2 = Date.parse('2026-08-27T23:00:00.000Z');
  const stalled = wall1 - 3 * 86_400_000;
  // Frontier NOT advancing (banking stalled) — the lag is a stall, not a
  // slow clock, and must not drag history onto the present.
  buffer.noteAnchorEvidence(stalled, wall1);
  buffer.noteAnchorEvidence(stalled, wall2);
  const strapStamp = new Date(stalled).toISOString();
  const accepted = buffer.appendBatch([{ seq: 1, t: strapStamp, t_strap: strapStamp, bpm: 62 }]);
  assert.deepEqual(accepted.affectedDays, ['2026-08-24']);
});

test('phone-stamped clock_offset_sec rows keep their phone-corrected day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-history-phone-anchor-'));
  const buffer = createHistoryBuffer({
    dir,
    userId: USER,
    now: () => new Date('2026-08-27T23:00:00.000Z'),
    engine: {},
  });
  // Phone applied its own measured correction and said so: trust it.
  const accepted = buffer.appendBatch([{
    seq: 1,
    t: '2026-08-27T22:50:00.000Z',
    t_strap: '2026-08-24T22:50:00.000Z',
    clock_offset_sec: 3 * 86_400,
    bpm: 62,
  }]);
  assert.deepEqual(accepted.affectedDays, ['2026-08-27']);
});
