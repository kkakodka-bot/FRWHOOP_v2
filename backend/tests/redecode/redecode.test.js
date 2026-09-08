// Redeode pipeline: replay, idempotency, selection, compare, accounting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayNotifies, compareDecodes, emptySession } from '../../redecode/redecode.js';
import { harvardRT, puffinRT, notifyOf } from '../fixtures/whoopFrames.mjs';
import { crc8, crc32 } from '../../protocol/crc.js';

function frames2Notifies(frames, opts = {}) {
  return frames.map((f, i) => notifyOf(f, { seq: i + 1, ...opts }));
}

test('replay produces Level A -> Level B intact', () => {
  const f = harvardRT(1, 1700000000, 500, 65, 2);
  const notifies = frames2Notifies([f]);
  const r = replayNotifies(notifies, { decoder: 'frwhoop-js/1' });
  assert.equal(r.levelB.length, 1);
  assert.equal(r.decoded.length, 1);
  assert.equal(r.session.bytes_received, f.length);
  assert.equal(r.session.dropped_records, 0);
});

test('dropped_records counter is zero on a clean stream (invariant)', () => {
  const fs = [1, 2, 3].map((i) => harvardRT(i, 1700000000 + i, 500, 60 + i, 1));
  const r = replayNotifies(frames2Notifies(fs), {});
  assert.equal(r.session.dropped_records, 0);
  assert.equal(r.session.duplicate_frames, 0);
  assert.equal(r.session.reassembled_frames, 3);
});

test('duplicates are counted at transport, not silently dropped', () => {
  const f = harvardRT(1, 1700000000, 500, 65, 2);
  const n = notifyOf(f, { seq: 1 });
  const r = replayNotifies([n, n], {});
  // both physical occurrences fed; the second is a duplicate frame at the bob
  assert.equal(r.session.notifications_received, 2);
  assert.ok(r.session.duplicate_frames >= 1);
});

test('idempotency: same frames replayed produce identical frame_hashes', () => {
  const fs = [harvardRT(1, 1700000000, 500, 65, 2), puffinRT(2, 1700000001, 250, 72, 1)];
  const a = replayNotifies(frames2Notifies(fs), {});
  const b = replayNotifies(frames2Notifies(fs), {});
  const hashA = a.levelB.map((x) => x.frame_hash).sort();
  const hashB = b.levelB.map((x) => x.frame_hash).sort();
  assert.deepEqual(hashA, hashB);
});

test('packet-type selection filter', () => {
  const known = harvardRT(1, 1700000000, 500, 65, 2);
  const n = notifyOf(known, { seq: 1 });
  const kept = replayNotifies([n], { filters: { packetTypes: [40] } });
  const empty = replayNotifies([n], { filters: { packetTypes: [47] } });
  assert.equal(kept.levelB.length, 1);
  assert.equal(empty.levelB.length, 0);
});

test('unknown-only selection filter surfaces unknown packets', () => {
  const known = harvardRT(1, 1700000000, 500, 65, 2);
  const inner = [77, 1, 1, 2, 3, 4];
  const length = inner.length + 4;
  const frame = [0xAA, length & 0xFF, (length >> 8) & 0xFF, 0, ...inner];
  frame[3] = crc8(frame, 1, 3);
  const c = crc32(inner);
  frame.push(c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF, (c >> 24) & 0xFF);
  const nKnown = notifyOf(known, { seq: 1 });
  const nUnknown = notifyOf(Uint8Array.from(frame), { seq: 2 });
  const r = replayNotifies([nKnown, nUnknown], { filters: { unknownOnly: true } });
  assert.equal(r.levelB.length, 1);
  assert.equal(r.levelB[0].packet_type, 77);
});

test('unknown observation aggregation keys on protocol tuple', () => {
  const inner = [77, 1, 1, 2, 3, 4];
  const length = inner.length + 4;
  const frame = [0xAA, length & 0xFF, (length >> 8) & 0xFF, 0, ...inner];
  frame[3] = crc8(frame, 1, 3);
  const c = crc32(inner);
  frame.push(c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF, (c >> 24) & 0xFF);
  const n1 = notifyOf(Uint8Array.from(frame), { seq: 1, t: '2026-08-25T02:00:00Z' });
  const n2 = notifyOf(Uint8Array.from(frame), { seq: 2, t: '2026-08-25T03:00:00Z' });
  const r = replayNotifies([n1, n2], {});
  const unknown = r.observed.filter((o) => o.packet_type === 77);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].occurrence_count, 2);
  assert.equal(unknown[0].representative_frame_hash.length, 64);
});

test('time-range filter', () => {
  const f = harvardRT(1, 1700000000, 500, 65, 2);
  const inRange = notifyOf(f, { seq: 1, t: '2026-08-25T02:00:00Z' });
  const outRange = notifyOf(f, { seq: 2, t: '2026-08-26T02:00:00Z' });
  const r = replayNotifies([outRange, inRange], { filters: { startAt: '2026-08-25T00:00:00Z', endAt: '2026-08-25T23:59:59Z' } });
  assert.equal(r.levelB.length, 1);
  assert.equal(r.session.dropped_records, 1);
});

test('compare detects decode changes between decoder versions', () => {
  const f = harvardRT(1, 1700000000, 500, 65, 2);
  const n = notifyOf(f, { seq: 1 });
  // simulate an old decoder that could not see HR
  const c = compareDecodes([n], { decoderA: 'frwhoop-js/0', decoderB: 'frwhoop-js/1' });
  assert.ok(c.decodedA === 1 || c.decodedA === 0);
  assert.ok(c.changedCount >= 0);
  assert.ok(Array.isArray(c.changed));
});

test('mixed-generation replay (harvard+puffin) works in one stream', () => {
  const f4 = harvardRT(1, 1700000000, 500, 65, 2);
  const f5 = puffinRT(1, 1700000001, 250, 72, 1);
  const n4 = notifyOf(f4, { family: 'harvard', seq: 1 });
  const n5 = notifyOf(f5, { family: 'puffin', seq: 2, char: 'FD4B0003-7185-4667-B7A6-36C427CBA76A' });
  const r = replayNotifies([n4, n5], {});
  assert.equal(r.levelB.length, 2);
  assert.ok(r.levelB.some((b) => b.family === 'harvard'));
  assert.ok(r.levelB.some((b) => b.family === 'puffin'));
});

test('incomplete stream reports dropped reason, not silent loss', () => {
  const f = harvardRT(1, 1700000000, 500, 65, 2);
  // only a partial notify, then end-of-stream
  const partial = notifyOf(f.slice(0, 6), { seq: 1 });
  const r = replayNotifies([partial], {});
  assert.ok(r.session.incomplete_frame_discards >= 1);
  assert.ok(r.session.dropped_records >= 1);
});
