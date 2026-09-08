import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { crc16Modbus, crc32 } from '../../protocol/crc.js';
import { decodeV18 } from '../../protocol/gen5.js';
import {
  classifySpo2Byte,
  observationFromV18,
  summarizeSpo2Observations,
  upsertObservations,
  correlateConsoleLogs,
  scanConfigReadbacks,
} from '../../protocol/spo2.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/openstrap-gen5-parity.json'), 'utf8'));
const v18Inner = fx.v18[0].inner_hex;

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
  sealCrc(frame);
  return frame;
}

function sealCrc(frame) {
  const innerLen = frame.length - 12;
  const c = crc32(frame, 8, 8 + innerLen);
  const o = frame.length - 4;
  frame[o] = c & 0xFF; frame[o + 1] = (c >> 8) & 0xFF;
  frame[o + 2] = (c >> 16) & 0xFF; frame[o + 3] = (c >> 24) & 0xFF;
  return frame;
}

function patchV18(raw, { sleepNibble = null } = {}) {
  const frame = wrapInner(v18Inner);
  frame[82] = raw;
  if (sleepNibble != null) {
    frame[81] = (frame[81] & 0xcf) | ((sleepNibble & 3) << 4);
  }
  return sealCrc(frame);
}

function sha256Hex(buf) {
  return createHash('sha256').update(Buffer.from(buf)).digest('hex');
}

test('raw 0 is unset, not a candidate', () => {
  const c = classifySpo2Byte(0);
  assert.equal(c.spo2_state, 'unset');
  assert.equal(c.spo2_candidate_pct, null);
  assert.equal(c.spo2_raw_byte, 0);
  const fl = decodeV18(patchV18(0)).fields;
  assert.equal(fl.aux_byte_82, 0);
  assert.equal(fl.spo2_raw_byte, 0);
  assert.equal(fl.spo2_state, 'unset');
  assert.equal(fl.spo2_candidate_pct, undefined);
  assert.equal(fl.spo2_candidate_82, undefined);
});

test('70, 95, 100 are candidates and equal the raw byte', () => {
  for (const raw of [70, 95, 100]) {
    const c = classifySpo2Byte(raw);
    assert.equal(c.spo2_state, 'candidate');
    assert.equal(c.spo2_candidate_pct, raw);
    const fl = decodeV18(patchV18(raw)).fields;
    assert.equal(fl.spo2_candidate_pct, raw);
    assert.equal(fl.spo2_candidate_82, raw);
    assert.equal(fl.spo2_raw_byte, raw);
  }
});

test('values outside 70..100 are not percentages', () => {
  for (const raw of [1, 69, 101, 127]) {
    const c = classifySpo2Byte(raw);
    assert.equal(c.spo2_candidate_pct, null);
    assert.equal(c.spo2_state, 'diagnostic');
    const fl = decodeV18(patchV18(raw)).fields;
    assert.equal(fl.spo2_candidate_pct, undefined);
    assert.equal(fl.spo2_state, 'diagnostic');
    assert.equal(fl.spo2_raw_byte, raw);
  }
});

test('high-bit values are sentinel, never a percentage', () => {
  for (const raw of [0x80, 0xa0, 0xff]) {
    const c = classifySpo2Byte(raw);
    assert.equal(c.spo2_state, 'sentinel');
    assert.equal(c.spo2_candidate_pct, null);
    assert.equal(c.spo2_raw_byte, raw);
    const fl = decodeV18(patchV18(raw)).fields;
    assert.equal(fl.spo2_state, 'sentinel');
    assert.equal(fl.spo2_candidate_pct, undefined);
  }
});

test('raw byte and frame hash are preserved on the observation', () => {
  const frame = patchV18(95);
  const hash = sha256Hex(frame);
  const parsed = decodeV18(frame).fields;
  const obs = observationFromV18(parsed, {
    frameHash: hash,
    deviceId: 'dev-1',
    firmware: '50.35.0',
    decoderVersion: 'frwhoop-js/2',
  });
  assert.equal(obs.spo2_raw_byte, 95);
  assert.equal(obs.spo2_candidate_pct, 95);
  assert.equal(obs.source_frame_hash, hash);
  assert.match(obs.source_frame_hash, /^[0-9a-f]{64}$/);
  assert.equal(obs.firmware, '50.35.0');
  assert.equal(obs.decoder_version, 'frwhoop-js/2');
  assert.equal(obs.layout, 'v18');
});

test('sleep_state correlation can be calculated from observations', () => {
  const asleep = observationFromV18(decodeV18(patchV18(96, { sleepNibble: 2 })).fields, { frameHash: 'a'.repeat(64) });
  const awake = observationFromV18(decodeV18(patchV18(94, { sleepNibble: 0 })).fields, { frameHash: 'b'.repeat(64) });
  const summary = summarizeSpo2Observations([asleep, awake]);
  assert.equal(summary.candidate_count, 2);
  assert.equal(summary.candidate_count_while_asleep, 1);
  assert.equal(summary.candidate_count_while_awake, 1);
});

test('same source_frame_hash does not duplicate', () => {
  const frame = patchV18(97);
  const hash = sha256Hex(frame);
  const obs = observationFromV18(decodeV18(frame).fields, { frameHash: hash });
  const first = upsertObservations([], [obs]);
  const second = upsertObservations(first.observations, [obs]);
  assert.equal(first.inserted, 1);
  assert.equal(second.inserted, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(second.observations.length, 1);
});

test('console-log correlation is evidence, not a store gate', () => {
  const hits = correlateConsoleLogs(
    [{ spo2_state: 'candidate', spo2_candidate_pct: 96, sensor_timestamp: 1_700_000_030 }],
    [{ unix: 1_700_000_025, log: 'valid SPO2 window' }],
  );
  assert.equal(hits.log_hits, 1);
  assert.equal(hits.hits[0].nearby_candidates, 1);
  const empty = correlateConsoleLogs(
    [{ spo2_state: 'candidate', spo2_candidate_pct: 96, sensor_timestamp: 1_700_000_030 }],
    [{ unix: 1_700_000_025, log: 'battery 64%' }],
  );
  assert.equal(empty.log_hits, 0);
});

test('read-only config read-backs keep spo2-related keys', () => {
  const found = scanConfigReadbacks([
    { decoded: { parsed: { config_read_back: { cmd: 116, result: 0, key: 'spo2_enable', value: '1' } } } },
    { parsed: { config_read_back: { cmd: 116, result: 0, key: 'battery', value: '1' } } },
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].key, 'spo2_enable');
});

