import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { crc16Modbus, crc32 } from '../../protocol/crc.js';
import { decodeV18 } from '../../protocol/gen5.js';
import { extractSpo2FromNotifies, extractSpo2FromObjects } from '../../redecode/spo2.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/openstrap-gen5-parity.json'), 'utf8'));
const v18Inner = fx.v18[0].inner_hex;
const CHAR = 'FD4B0003-8D6D-82B8-614A-1C8CB0F8DCC6';

function wrapInner(innerHex) {
  const inner = Buffer.from(innerHex, 'hex');
  const frame = Buffer.alloc(8 + inner.length + 4);
  frame[0] = 0xAA; frame[1] = 0x01;
  const declared = inner.length + 4;
  frame[2] = declared & 0xFF; frame[3] = (declared >> 8) & 0xFF;
  frame[4] = 0x00; frame[5] = 0x01;
  const h = crc16Modbus(frame, 0, 6);
  frame[6] = h & 0xFF; frame[7] = (h >> 8) & 0xFF;
  inner.copy(frame, 8);
  const innerLen = frame.length - 12;
  const c = crc32(frame, 8, 8 + innerLen);
  const o = frame.length - 4;
  frame[o] = c & 0xFF; frame[o + 1] = (c >> 8) & 0xFF;
  frame[o + 2] = (c >> 16) & 0xFF; frame[o + 3] = (c >> 24) & 0xFF;
  return frame;
}

function patch82(raw) {
  const frame = wrapInner(v18Inner);
  frame[82] = raw;
  const innerLen = frame.length - 12;
  const c = crc32(frame, 8, 8 + innerLen);
  const o = frame.length - 4;
  frame[o] = c & 0xFF; frame[o + 1] = (c >> 8) & 0xFF;
  frame[o + 2] = (c >> 16) & 0xFF; frame[o + 3] = (c >> 24) & 0xFF;
  return frame;
}

function notify(frame, over = {}) {
  return {
    hex: Buffer.from(frame).toString('hex'),
    family: 'puffin',
    char: CHAR,
    fw: '50.35.0',
    device_id: 'dev-spo2',
    t: '2026-02-25T02:00:00.000Z',
    seq: 1,
    ...over,
  };
}

test('B2 replay of a v18 frame matches direct decodeV18', () => {
  const frame = patch82(95);
  const direct = decodeV18(frame).fields;
  const replayed = extractSpo2FromNotifies([notify(frame)]);
  const hit = replayed.observations.find((o) => o.spo2_state === 'candidate');
  assert.equal(direct.spo2_candidate_pct, 95);
  assert.equal(hit.spo2_candidate_pct, 95);
  assert.equal(hit.spo2_raw_byte, 95);
  assert.equal(hit.spo2_state, 'candidate');
  assert.equal(hit.source_frame_hash, replayed.observations[0].source_frame_hash);
  assert.match(hit.source_frame_hash, /^[0-9a-f]{64}$/);
});

test('replaying the same capture twice inserts no duplicates', () => {
  const frame = patch82(98);
  const notifies = [notify(frame)];
  const twice = extractSpo2FromObjects([{ rows: notifies }]);
  assert.equal(twice.inserted, 1);
  assert.equal(twice.rerun_inserted, 0);
  assert.ok(twice.rerun_duplicates >= 1);
  assert.equal(twice.observations.filter((o) => o.spo2_state === 'candidate').length, 1);
});

test('byte 82 = 0 produces no candidate observation percentage', () => {
  const replayed = extractSpo2FromNotifies([notify(patch82(0))]);
  assert.equal(replayed.summary.candidate_count, 0);
  assert.equal(replayed.observations[0].spo2_state, 'unset');
  assert.equal(replayed.observations[0].spo2_candidate_pct, null);
});
