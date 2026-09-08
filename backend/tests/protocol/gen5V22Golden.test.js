import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { decodeV22, decodeGen5HistoricalHeader } from '../../protocol/gen5.js';
import { crc16Modbus, crc32 } from '../../protocol/crc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/openstrap-gen5-v22-parity.json'), 'utf8'));

// Wrap an OpenStrap INNER record (176 B) into a CRC-valid puffin frame:
// [AA 01 declared u16 LE][hdr 0x00 0x01][crc16 over 0..6][inner][crc32 over inner]
function frameFromInner(inner) {
  const total = 8 + inner.length + 4;
  const f = new Uint8Array(total);
  f[0] = 0xAA; f[1] = 0x01;
  const declared = inner.length + 4;
  f[2] = declared & 0xFF; f[3] = (declared >> 8) & 0xFF;
  f[4] = 0x00; f[5] = 0x01;
  const h = crc16Modbus(f, 0, 6);
  f[6] = h & 0xFF; f[7] = (h >> 8) & 0xFF;
  f.set(inner, 8);
  const c = crc32(f, 8, total - 4);
  f[total - 4] = c & 0xFF; f[total - 3] = (c >>> 8) & 0xFF; f[total - 2] = (c >>> 16) & 0xFF; f[total - 1] = (c >>> 24) & 0xFF;
  return f;
}
const frameOf = (name) => {
  const hex = fx.v22_real[name];
  const inner = new Uint8Array(hex.length / 2);
  for (let i = 0; i < inner.length; i++) inner[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return { inner, frame: frameFromInner(inner) };
};

test('v22 golden: all five real OpenStrap tags decode; realTag1 pins the shared header', () => {
  // Each real tag has its OWN synthesized timestamp; only realTag1's values are
  // pinned in the fixture expectations (record_index 21742447, unix 1780000001).
  const e = fx.expectations.header;
  for (const name of Object.keys(fx.v22_real)) {
    const { frame } = frameOf(name);
    const r = decodeV22(frame);
    assert.equal(r.fields.hist_version, 22, `${name} version`);
    assert.equal(r.fields.known_layout, true, `${name} known layout`);
    assert.equal(r.fields.tag, Number(name.replace('realTag', '')), `${name} tag byte`);
    assert.equal(r.fields.ppg_sample_rate_hz, e.ppg_sample_rate_hz, `${name} flags-bit7 rate (every checked record is 25 Hz)`);
   }
  {
    const { frame } = frameOf('realTag1');
    const r = decodeV22(frame);
    assert.equal(r.fields.record_index, e.record_index, 'realTag1 record_index');
    assert.equal(r.fields.unix, e.unix, 'realTag1 unix');
    assert.equal(r.fields.subsec_q15, e.subsec_q15, 'realTag1 subsec_q15');
  }
});

test('v22 golden tag 1: 49-slot window, rail at delta 24, meta block matches the twin R18', () => {
  const { frame } = frameOf('realTag1');
  const r = decodeV22(frame);
  const e = fx.expectations.tag1;
  assert.equal(r.fields.optical_windows.length, 1);
  const w = r.fields.optical_windows[0];
  assert.equal(w.first_sample_adc, e.first_sample_adc);
  assert.equal(w.deltas[0], e.deltas0);
  assert.equal(w.deltas[24], e.deltas24);
  const rec = r.fields.reconstruction[0];
  assert.equal(rec.trusted_sample_count, e.trusted_sample_count);
  assert.equal(rec.first_ambiguous_sample_index, e.first_ambiguous_sample_index);
  const m = r.fields.meta;
  assert.equal(m.flags_snapshot, e.meta.flags_snapshot, `flags_snapshot got ${m.flags_snapshot}`);
  assert.ok(Math.abs(m.accel_delta_g - e.meta.accel_delta_g) < 1e-9, `accel_delta_g got ${m.accel_delta_g}`);
  assert.equal(m.state_word, e.meta.state_word);
  assert.equal(m.primary_flags, e.meta.primary_flags);
});

test('v22 golden tag 5: embedded PIP carries its OWN unix, 39 s behind the carrier', () => {
  const { frame } = frameOf('realTag5');
  const r = decodeV22(frame);
  const e = fx.expectations.tag5;
  assert.equal(r.fields.tag, 5);
  assert.equal(r.fields.unix, e.carrier_unix);
  assert.equal(r.fields.pip_record_unix, e.pip_record_unix);
  assert.equal(r.fields.unix - r.fields.pip_record_unix, e.carrier_minus_pip);
  assert.ok(Math.abs(r.fields.accel_delta_g - e.accel_delta_g) < 1e-9, `accel ${r.fields.accel_delta_g}`);
  assert.equal(r.fields.state_word, e.state_word);
  assert.equal(r.fields.optical_windows[0].deltas.length, 24);
  assert.equal(r.fields.reconstruction[0].samples.length, 25);
});

test('v22 exact-length dispatch: 175/177-byte frames are refused before tag trust', () => {
  const { inner } = frameOf('realTag1');
  for (const len of [inner.length - 1, inner.length + 1]) {
    const wrong = new Uint8Array(len);
    wrong[0] = 0x2F; wrong[1] = 22;
    const total = 8 + len + 4;
    const f = new Uint8Array(total);
    f[0] = 0xAA; f[1] = 0x01;
    const declared = len + 4; f[2] = declared & 255; f[3] = (declared >> 8) & 255;
    f.set(wrong, 8);
    const h = crc16Modbus(f, 0, 6); f[6] = h & 255; f[7] = (h >> 8) & 255;
    const c = crc32(f, 8, total - 4); f[total - 4] = c & 255; f[total - 3] = (c >>> 8) & 255; f[total - 2] = (c >>> 16) & 255; f[total - 1] = (c >>> 24) & 255;
    const r = decodeV22(f);
    assert.equal(r.fields.known_layout, false, `len ${len} must not claim a v22 layout`);
    assert.ok(r.warnings.some((w) => w.includes('exact-length gate')), `len ${len} warns`);
  }
});

test('v22 stale-bytes poison: a decoder that reads an unassigned offset shows the poison', () => {
  // fill every body byte with 0xA5, then write ONLY the offsets the layout assigns
  const inner = new Uint8Array(176).fill(0xA5);
  inner[0] = 0x2F; inner[1] = 22; inner[2] = 0x80;
  inner[3] = 0x32; inner[4] = 0xA1; inner[5] = 0x01; inner[6] = 0x00; // record_index 4242
  inner[7] = 0x00; inner[8] = 0x20; inner[9] = 0x1A; inner[10] = 0x6A; // unix 1780000000
  inner[11] = 0xD2; inner[12] = 0x04; // subsec 1234
  inner[13] = 1; inner[14] = 0;
  const dv = new DataView(inner.buffer);
  dv.setInt32(15, 249855, true);
  inner[19] = 0x59; inner[20] = 0x02; // delta 601
  dv.setInt16(19 + 2 * 24, -32768, true);
  inner[118] = 1; // meta flags_snapshot lives at inner[118] = frame 126
  dv.setFloat32(117 + 4, 0.11080145835876465, true);
  dv.setUint16(117 + 20, 1872, true);
  inner[117 + 26] = 1;
  const f = frameFromInner(inner);
  const r = decodeV22(f);
  assert.equal(r.fields.meta.flags_snapshot, 1, 'meta reads the WRITTEN byte, not poison');
  assert.ok(Math.abs(r.fields.meta.accel_delta_g - 0.11080145835876465) < 1e-9);
  assert.equal(r.fields.meta.state_word, 1872);
  assert.equal(r.fields.meta.primary_flags, 1);
  const poisonVisible = r.coverage.bitmap.some((s) => s.cls === 'unknown');
  assert.equal(poisonVisible, false, 'every body byte is accounted (raw or decoded)');
});
