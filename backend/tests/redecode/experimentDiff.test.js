// Tests for the differential experiment analyzer (census + diff + evidence extraction).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { crc8, crc16Modbus, crc32 } from '../../protocol/crc.js';
import { notifyOf, puffinRT } from '../fixtures/whoopFrames.mjs';

import { censusWindow, diffCensus, extractExperimentFrames } from '../../redecode/experimentDiff.js';
import { decodeFrame } from '../../protocol/decoder.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(path.join(here, '../fixtures/noop-whoop5-parity.json'), 'utf8'));

/** Build a puffin frame with an arbitrary payload (type byte first). */
function puffinFrame(type, seq, body, { ts = 1784037165, sub = 0 } = {}) {
  const inner = [type, seq,
    ts & 0xFF, (ts >> 8) & 0xFF, (ts >> 16) & 0xFF, (ts >> 24) & 0xFF,
    sub & 0xFF, (sub >> 8) & 0xFF, ...body];
  const decl = inner.length + 4;
  const frame = [0xAA, 0x01, decl & 0xFF, (decl >> 8) & 0xFF, 0x00, 0x01];
  const c16 = crc16Modbus(frame, 0, 6);
  frame.push(c16 & 0xFF, (c16 >> 8) & 0xFF, ...inner);
  const c = crc32(inner);
  frame.push(c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF, (c >> 24) & 0xFF);
  return Uint8Array.from(frame);
}

const puffinChar = 'FD4B0003-8D6D-82B8-614A-1C8CB0F8DCC6';

test('censusWindow counts packet types + hist versions, skips CRC-invalid', () => {
  const frame = Buffer.from(fx.v21_real.hex, 'hex');
  const rows = [
    { hex: frame.slice(0, 500).toString('hex'), char: puffinChar, family: 'puffin', fw: '50.35.2', t: '2026-08-30T10:00:00Z', seq: 1 },
    { hex: frame.slice(500).toString('hex'), char: puffinChar, family: 'puffin', fw: '50.35.2', t: '2026-08-30T10:00:00.01Z', seq: 2 },
  ];
  const bad = Buffer.from(frame); bad[bad.length - 1] ^= 0xFF;
  rows.push({ hex: bad.toString('hex'), char: puffinChar, family: 'puffin', t: '2026-08-30T10:00:01Z', seq: 3 });
  const c = censusWindow(rows);
  assert.equal(c.frames, 2);
  assert.equal(c.crc_valid, 1);
  assert.equal(c.crc_invalid, 1);
  assert.equal(c.packet_types['47'], 1);
  assert.equal(c.hist_versions['21'], 1);
});

test('diffCensus flags a new packet type appearing only during the experiment', () => {
  const before = { packet_types: { 40: 100, 47: 5 }, frame_lengths: {} };
  const during = { packet_types: { 40: 100, 47: 5, 52: 12 }, frame_lengths: { '52:1300': 12 } };
  const after = { packet_types: { 40: 100, 47: 5 }, frame_lengths: {} };
  const d = diffCensus(before, during, after);
  assert.deepEqual(d.new_types_during, ['52']);
  const row = d.changed_types.find((r) => r.packet_type === '52');
  assert.ok(row && row.before === 0 && row.during === 12 && row.delta_during === 12);
});

test('extractExperimentFrames: real v21 yields a physics-passing IMU record', () => {
  const frame = Buffer.from(fx.v21_real.hex, 'hex');
  const rows = [
    { hex: frame.slice(0, 500).toString('hex'), char: puffinChar, family: 'puffin', fw: '50.35.2.0', t: '2026-08-30T10:00:00Z', seq: 1 },
    { hex: frame.slice(500).toString('hex'), char: puffinChar, family: 'puffin', fw: '50.35.2.0', t: '2026-08-30T10:00:00.01Z', seq: 2 },
  ];
  const ex = extractExperimentFrames(rows);
  assert.equal(ex.imu.length, 1);
  assert.equal(ex.imu[0].kind, 'hist_v21');
  assert.equal(ex.imu_physics_pass, 1);
  assert.equal(ex.type52.length, 0);
});

test('extractExperimentFrames: a CRC-valid type-52 frame is captured raw, never force-parsed', () => {
  // Synthetic 52 body: whoop-vault-hypothesis-shaped header only (epoch + rate),
  // marked as hypothesis in the decoder, raw hex preserved in extraction.
  const body = [];
  const epoch = 1784037165;
  body.push(epoch & 0xFF, (epoch >> 8) & 0xFF, (epoch >> 16) & 0xFF, (epoch >> 24) & 0xFF);
  body.push(100, 0); // rate u16 = 100
  for (let i = 0; i < 24; i++) body.push(i & 0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0); // 12B records
  const frame = puffinFrame(52, 1, body);
  const rows = [notifyOf(frame, { family: 'puffin', char: puffinChar, seq: 5 })];
  const ex = extractExperimentFrames(rows);
  assert.equal(ex.type52.length, 1);
  assert.equal(ex.samples['52'].length, 1);
  const decoded = decodeFrame(Buffer.from(ex.type52[0].hex, 'hex'), 'puffin');
  assert.ok(['decoded', 'unknown', 'partial', 'classified'].includes(decoded.decode_status));
  // The vault-header plausibility note or a mapped version must be attached, never a fabricated parse.
  if (!decoded.decoded?.mapped) {
    assert.equal(decoded.decoded?.historical_imu_note !== undefined, true);
  }
});

test('extractExperimentFrames: unknown header 52 stays unmapped with plausibility note', () => {
  const body = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];
  const frame = puffinFrame(52, 2, body);
  const decoded = decodeFrame(frame, 'puffin');
  assert.equal(decoded.packet_type, 52);
  assert.equal(decoded.decoded?.mapped, false);
  assert.ok(String(decoded.decoded?.historical_imu_note || '').includes('layout unknown'));
});

test('censusWindow keeps type-54 kinds out of type-48 events', () => {
  const fx54 = JSON.parse(readFileSync(path.join(here, '../fixtures/puffinEvents54.json'), 'utf8'));
  const f = fx54.frames.find((x) => x.expect.kind === 20);
  const c = censusWindow([{ hex: f.hex, char: puffinChar, family: 'puffin', fw: '50.35.2.0', t: '2026-08-26T01:59:10Z', seq: 1 }]);
  assert.equal(c.packet_types['54'], 1);
  assert.equal(c.type_counts['54'], 1);
  assert.equal(c.puffin54_kinds['20'], 1);
  assert.equal(c.events['20'], undefined);
});
