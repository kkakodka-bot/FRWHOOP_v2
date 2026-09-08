// Decoder audit: versioned interpretation over immutable frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFrame, DECODER_VERSION, PACKET_TYPES } from '../../protocol/decoder.js';
import { harvardRT, puffinRT, harvardCorrupt, harvardHistorical, notifyOf } from '../fixtures/whoopFrames.mjs';
import { createReassembler } from '../../protocol/framing.js';
import { replayNotifies } from '../../redecode/redecode.js';
import { crc8, crc32 } from '../../protocol/crc.js';

test('decoder dispatches on WHOOP4 vs WHOOP5 offsets', () => {
  const f4 = harvardRT(1, 1700000000, 500, 65, 2);
  const f5 = puffinRT(2, 1700000000, 250, 72, 1);
  const d4 = decodeFrame(f4, 'harvard');
  const d5 = decodeFrame(f5, 'puffin');
  assert.equal(d4.decoded.heart_rate, 65);
  assert.equal(d5.decoded.heart_rate, 72);
  assert.equal(d4.decoded.rr_count_declared, 2);
  assert.ok(Array.isArray(d4.decoded.rr_intervals));
  assert.equal(d4.decode_status, 'decoded');
  assert.equal(d5.decode_status, 'decoded');
});

test('decoder carries full lineage', () => {
  const d = decodeFrame(harvardRT(1, 1700000000, 500, 65, 2), 'harvard');
  assert.ok(d.frame_hash && d.frame_hash.length === 64);
  assert.equal(d.decoder, DECODER_VERSION);
  assert.equal(d.family, 'harvard');
  assert.equal(d.packet_name, 'REALTIME_DATA');
  assert.ok(d.raw_hex.length > 0);
  assert.equal(d.raw_length, 18);
});

test('decoder preserves unknown packet bytes with status unknown', () => {
  const inner = [77, 1, 1, 2, 3, 4, 5];
  const length = inner.length + 4;
  const frame = [0xAA, length & 0xFF, (length >> 8) & 0xFF, 0, ...inner];
  frame[3] = crc8(frame, 1, 3);
  const c = crc32(inner);
  frame.push(c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF, (c >> 24) & 0xFF);
  const d = decodeFrame(Uint8Array.from(frame), 'harvard');
  assert.equal(d.decode_status, 'unknown');
  assert.equal(d.packet_type, 77);
  assert.equal(d.packet_name, null);
  assert.ok(d.raw_hex.includes('4d010102030405'));
});

test('decoder retains crc-failed / malformed evidence', () => {
  const bad = harvardCorrupt(1, 1700000000, 500, 65, 2, 10);
  try {
    const d = decodeFrame(bad, 'harvard');
    // decode must still produce a record (bytes preserved), not throw
    assert.ok(d);
  } catch (e) {
    assert.fail('decoder threw on corrupt bytes: ' + e.message);
  }
});

test('decodeFrame never throws on arbitrary input', () => {
  const cases = [ [0xAA], [], [0xAA, 0x01], new Array(20).fill(0xFF), [1,2,3] ];
  for (const c of cases) {
    assert.doesNotThrow(() => decodeFrame(c, 'harvard'));
  }
});

test('type 43 REALTIME_RAW_DATA variant identification is neutral', () => {
  // Build a plausible type-43 frame; decoder should classify without inventing
  // a medical label. (Channel identities are not claimed here.)
  const inner = new Array(60).fill(0);
  inner[0] = 43; inner[1] = 1; // type@0-in-inner, seq
  const length = inner.length + 4;
  const frame = [0xAA, length & 0xFF, (length >> 8) & 0xFF, 0, ...inner];
  frame[3] = crc8(frame, 1, 3);
  const c = crc32(inner);
  frame.push(c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF, (c >> 24) & 0xFF);
  const d = decodeFrame(Uint8Array.from(frame), 'harvard');
  assert.equal(d.packet_type, 43);
  assert.equal(d.packet_name, 'REALTIME_RAW_DATA');
  assert.ok(['decoded', 'unknown', 'partial'].includes(d.decode_status));
});

test('replay elevates split frames to Level B with lineage', () => {
  const f = harvardRT(1, 1700000000, 500, 65, 2);
  const n1 = notifyOf(f.slice(0, 5), { seq: 1 });
  const n2 = notifyOf(f.slice(5), { seq: 2 });
  const r = replayNotifies([n1, n2], { decoder: DECODER_VERSION });
  assert.equal(r.levelB.length, 1);
  const b = r.levelB[0];
  assert.equal(b.kind, 'frame');
  assert.equal(b.family, 'harvard');
  assert.equal(b.packet_type, 40);
  assert.equal(b.crc_ok, true);
  assert.ok(b.decoder);
  assert.ok(b.frame_hash);
  assert.equal(r.session.notifications_received, 2);
  assert.equal(r.session.reassembled_frames, 1);
});

test('type 40 unpacks declared RR slots and does not treat CRC32 as intervals', () => {
  const withSlots = puffinRT(1, 1700000000, 0, 72, 2, [1018, 532]);
  const decoded = decodeFrame(withSlots, 'puffin');
  assert.equal(decoded.decode_status, 'decoded');
  assert.equal(decoded.decoded.heart_rate, 72);
  assert.equal(decoded.decoded.rr_count_declared, 2);
  assert.deepEqual(decoded.decoded.rr_intervals, [1018, 532]);
  const countOnly = puffinRT(1, 1700000000, 0, 72, 2);
  const empty = decodeFrame(countOnly, 'puffin');
  assert.equal(empty.decoded.rr_count_declared, 2);
  assert.deepEqual(empty.decoded.rr_intervals, []);
});

test('Harvard type 47 redecode is header-only and keeps raw_hex', () => {
  const f = harvardHistorical(24, 1700000000, [21, 80, 0, 0]);
  const d = decodeFrame(f, 'harvard');
  assert.equal(d.packet_type, 47);
  assert.equal(d.decode_status, 'partial');
  assert.equal(d.decoded.harvard_type47, 'header_only');
  assert.equal(d.decoded.heart_rate, undefined);
  assert.equal(d.decoded.bpm, undefined);
  assert.ok(d.raw_hex.length > 0);
  assert.equal(d.crc_ok, true);
});
