// Adversarial audit of the WHOOP reassembler + frame verification.
// Ported from the NOOP reference and verified CRC-against-standard-check-values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc8, crc16Modbus, crc32 } from '../../protocol/crc.js';
import { verifyFrame, createReassembler, MAX_FRAME_BYTES } from '../../protocol/framing.js';
import {
  harvardRT, puffinRT, harvardCorrupt, notifyOf,
} from '../fixtures/whoopFrames.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const whoop5Fx = JSON.parse(readFileSync(join(here, '../fixtures/noop-whoop5-parity.json'), 'utf8'));

test('CRC ports match standard check values', () => {
  const data = Buffer.from('123456789', 'ascii');
  assert.equal(crc8(data), 0xF4);
  assert.equal(crc16Modbus(data), 0x4B37);
  assert.equal(crc32(data), 0xCBF43926);
});

test('WHOOP4 (harvard) valid frame verifies', () => {
  const f = harvardRT(1, 1700000000, 500, 65, 2);
  const c = verifyFrame(f, 'harvard');
  assert.equal(c.ok, true);
  assert.equal(c.crc8_ok, true);
  assert.equal(c.crc32_ok, true);
});

test('WHOOP5 (puffin) valid frame verifies', () => {
  const f = puffinRT(2, 1700000000, 250, 72, 1);
  const c = verifyFrame(f, 'puffin');
  assert.equal(c.ok, true);
  assert.equal(c.crc8_ok, true);
  assert.equal(c.crc32_ok, true);
});

test('CRC corruption is detected, not fatal', () => {
  const f = harvardCorrupt(1, 1700000000, 500, 65, 2, 9);
  const c = verifyFrame(f, 'harvard');
  assert.equal(c.ok, false);
  assert.equal(c.crc32_ok, false);
});

test('corrupted header crc is detected', () => {
  const f = Array.from(harvardRT(1, 1700000000, 500, 65, 2));
  f[3] ^= 0xFF; // break header crc8
  const c = verifyFrame(Uint8Array.from(f), 'harvard');
  assert.equal(c.crc8_ok, false);
  assert.equal(c.ok, false);
});

test('puffin header crc16 is validated', () => {
  const f = Array.from(puffinRT(2, 1700000000, 250, 72, 1));
  f[7] ^= 0xFF; // break header crc16
  const c = verifyFrame(Uint8Array.from(f), 'puffin');
  assert.equal(c.crc8_ok, false);
  assert.equal(c.ok, false);
});

test('WHOOP4 and WHOOP5 are not a 4-byte offset shift', () => {
  // A WHOOP4 frame must not verify as puffin and vice versa; each has a
  // distinct envelope (length position + CRC).
  const f4 = harvardRT(1, 1700000000, 500, 65, 2);
  const f5 = puffinRT(1, 1700000000, 500, 65, 2);
  assert.equal(verifyFrame(f4, 'puffin').ok, false, 'harvard frame must not verify as puffin');
  assert.equal(verifyFrame(f5, 'harvard').ok, false, 'puffin frame must not verify as harvard');
  // Puffin declared-length sits at [2..4], harvard at [1..3].
  assert.equal(verifyFrame(f4, 'harvard').total, 18);
  assert.equal(verifyFrame(f5, 'puffin').total, 22);
});

test('reassembler: whole frame in one callback', () => {
  const r = createReassembler({ family: 'harvard' });
  const f = harvardRT(1, 1700000000, 500, 65, 2);
  const out = r.feed(f);
  assert.equal(out.frames.length, 1);
  assert.deepEqual(Array.from(out.frames[0]), Array.from(f));
});

test('reassembler: frame split at every byte position keeps byte identity', () => {
  for (let split = 1; split < 18; split += 1) {
    const r = createReassembler({ family: 'harvard' });
    const f = harvardRT(1, 1700000000, 500, 65, 2);
    const a = r.feed(f.slice(0, split));
    const b = r.feed(f.slice(split));
    assert.equal(a.frames.length + b.frames.length, 1, `split@${split}`);
    const got = [...(a.frames[0] || []), ...(b.frames[0] || [])];
    assert.deepEqual(Array.from(a.frames[0] || b.frames[0] || []), Array.from(f), `split@${split}`);
  }
});

test('reassembler: multiple frames in one callback', () => {
  const r = createReassembler({ family: 'harvard' });
  const f = harvardRT(1, 1700000000, 500, 65, 2);
  const combined = Buffer.concat([f, f, f]);
  const out = r.feed(combined);
  assert.equal(out.frames.length, 3);
});

test('reassembler: split across three callbacks mid-frame', () => {
  const r = createReassembler({ family: 'harvard' });
  const f = harvardRT(1, 1700000000, 500, 65, 2);
  r.feed(f.slice(0, 3));
  r.feed(f.slice(3, 11));
  const out = r.feed(f.slice(11));
  assert.equal(out.frames.length, 1);
  assert.deepEqual(Array.from(out.frames[0]), Array.from(f));
});

test('reassembler: garbage before start of frame is skipped and accounted', () => {
  const r = createReassembler({ family: 'harvard' });
  const f = harvardRT(1, 1700000000, 500, 65, 2);
  const garbage = Uint8Array.from([0x11, 0x22, 0x33, 0x44]);
  const out = r.feed(Buffer.concat([garbage, f]));
  assert.equal(out.frames.length, 1);
  assert.equal(out.droppedBytes, 4);
});

test('reassembler: start marker inside payload is handled by length', () => {
  // A frame whose payload contains 0xAA bytes: length-driven, not SOF-driven.
  const r = createReassembler({ family: 'harvard' });
  const seqBytes = [42]; // fake payload with AA
  const inner = [40, 1, 1700000000 & 0xFF, 0, 0, 0, 0, 0, 65, 2, 0xAA];
  const length = inner.length + 4;
  const frame = [0xAA, length & 0xFF, (length >> 8) & 0xFF, 0, ...inner];
  frame[3] = crc8(frame, 1, 3);
  const c = crc32(inner);
  frame.push(c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF, (c >> 24) & 0xFF);
  // feed two frames concatenated
  const out = r.feed(Buffer.concat([Buffer.from(frame), Buffer.from(frame)]));
  assert.equal(out.frames.length, 2);
});

test('reassembler: corrupted length resyncs instead of stalling', () => {
  const r = createReassembler({ family: 'harvard' });
  const f = harvardRT(1, 1700000000, 500, 65, 2);
  // corrupt the length bytes to an impossible large value > MAX
  const bad = Uint8Array.from(Array.from(f));
  bad[1] = 0xFF; bad[2] = 0xFF;
  const out = r.feed(Buffer.concat([bad, f]));
  // the bad SOF is dropped and resynced; the trailing good frame reassembles
  assert.ok(out.frames.length >= 1);
  assert.ok(out.droppedBytes >= 1);
});

test('reassembler: truncated notification sequence leaves incomplete frame + accounting', () => {
  const r = createReassembler({ family: 'harvard' });
  const f = harvardRT(1, 1700000000, 500, 65, 2);
  const out = r.feed(f.slice(0, 6)); // only partial
  assert.equal(out.frames.length, 0);
  const reset = r.reset();
  assert.equal(reset.incomplete, true);
  assert.ok(reset.discardedCount > 0);
});

test('reassembler: disconnect + reconnect resets and preserves later frames', () => {
  const r = createReassembler({ family: 'harvard' });
  const f = harvardRT(1, 1700000000, 500, 65, 2);
  r.feed(f.slice(0, 7)); // partial before disconnect
  r.reset();
  const out = r.feed(f); // full frame after reconnect
  assert.equal(out.frames.length, 1);
  assert.deepEqual(Array.from(out.frames[0]), Array.from(f));
});

test('reassembler: duplicate delivery is preserved as frames (dedup is downstream)', () => {
  const r = createReassembler({ family: 'harvard' });
  const f = harvardRT(1, 1700000000, 500, 65, 2);
  const out = r.feed(Buffer.concat([f, f]));
  // reassembler is transport-faithful: it emits both physical occurrences
  assert.equal(out.frames.length, 2);
});

test('reassembler: puffin split across notifies', () => {
  const r = createReassembler({ family: 'puffin' });
  const f = puffinRT(9, 1700000000, 250, 72, 1);
  r.feed(f.slice(0, 4));
  const out = r.feed(f.slice(4));
  assert.equal(out.frames.length, 1);
  assert.deepEqual(Array.from(out.frames[0]), Array.from(f));
});

test('reassembler: truncated puffin v21 prefixes are not concatenated into a 1244-byte frame', () => {
  const full = Buffer.from(whoop5Fx.v21_real.hex, 'hex');
  assert.equal(full.length, 1244);
  const a = Array.from(full.subarray(0, 244));
  const b = a.slice();
  b[11] = (b[11] + 1) & 0xFF;
  const hb = crc16Modbus(b, 0, 6);
  b[6] = hb & 0xFF; b[7] = (hb >> 8) & 0xFF;
  const r = createReassembler({ family: 'puffin' });
  assert.equal(r.feed(a).frames.length, 0);
  const out = r.feed(b);
  assert.equal(out.frames.length, 0, 'second truncated header must not complete a fake frame');
  assert.equal(r.stats().buffered, b.length);
});

test('reassembler: complete puffin type-40 is not spliced into a partial type-47', () => {
  const inner = [47, 21, ...new Array(200).fill(0)];
  const decl = inner.length + 4;
  const big = [0xAA, 0x01, decl & 0xFF, (decl >> 8) & 0xFF, 0, 1];
  const c16 = crc16Modbus(big, 0, 6);
  big.push(c16 & 0xFF, c16 >> 8, ...inner);
  const c = crc32(inner);
  big.push(c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF, (c >> 24) & 0xFF);
  const t40 = puffinRT(1, 1700000000, 0, 88, 0);
  const r = createReassembler({ family: 'puffin' });
  r.feed(big.slice(0, 40));
  const mid = r.feed(t40);
  assert.equal(mid.frames.length, 1);
  assert.equal(mid.frames[0][8], 40);
  assert.equal(mid.frames[0][16], 88);
  const rest = r.feed(big.slice(40));
  assert.equal(rest.frames.length, 1);
  assert.equal(rest.frames[0][8], 47);
  const old = createReassembler({ family: 'puffin', intactNotify: false });
  old.feed(big.slice(0, 40));
  const lost = old.feed(t40);
  assert.equal(lost.frames.length, 0, 'legacy concat waits for the type-47 declared length');
});

test('reassembler: very large frame within cap reassembles', () => {
  const r = createReassembler({ family: 'harvard' });
  // build a type-47 historical-like large frame up to near the cap
  const payloadLen = 4000;
  const payload = new Array(payloadLen).fill(0x7F);
  const inner = [47, 24, ...payload];
  const length = inner.length + 4;
  const frame = [0xAA, length & 0xFF, (length >> 8) & 0xFF, 191, ...inner];
  frame[3] = crc8(frame, 1, 3);
  const c = crc32(inner);
  frame.push(c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF, (c >> 24) & 0xFF);
  assert.ok(frame.length < MAX_FRAME_BYTES);
  const out = r.feed(Uint8Array.from(frame));
  assert.equal(out.frames.length, 1);
  assert.equal(out.frames[0].length, frame.length);
});

test('unknown future frame variant is retained, not discarded', () => {
  const r = createReassembler({ family: 'harvard' });
  // a type-99 (unknown) frame following a known one must still reassemble
  const inner = [99, 1, 0xAA, 0x01, 0x02, 0x03, 0x04];
  const length = inner.length + 4;
  const frame = [0xAA, length & 0xFF, (length >> 8) & 0xFF, 0, ...inner];
  frame[3] = crc8(frame, 1, 3);
  const c = crc32(inner);
  frame.push(c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF, (c >> 24) & 0xFF);
  const f = harvardRT(1, 1700000000, 500, 65, 2);
  const out = r.feed(Buffer.concat([f, Buffer.from(frame)]));
  assert.equal(out.frames.length, 2);
  assert.equal(out.frames[1][4], 99, 'unknown packet frame preserved');
});
