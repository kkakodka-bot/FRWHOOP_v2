// Golden parity tests: FRWHOOP gen5 decoders vs OpenStrap/protocol @ c78c1762 (MIT) fixtures.
//
// Source of truth: OpenStrap/protocol @ c78c1762 (MIT) Dart tests
//   test/gen5_v22_test.dart, test/gen5_historical_test.dart, test/gen5_record_fields_test.dart
// Fixtures: tests/fixtures/openstrap-gen5-parity.json (hex extracted VERBATIM; every hex string is an
// INNER record starting at packet-type 0x2F).
//
// Frame wrapping: the FRWHOOP decoders take COMPLETE puffin frames and read frame-absolute offsets
// (inner + 8). Each inner fixture is wrapped here (never in the fixture file) as:
//   [AA 01][declared LE = inner.length + 4][00 01][crc16Modbus(frame[0:6]) LE][inner][crc32(inner) LE]
// (recipe + CRC verification live in openstrap-gen5-parity.json -> wrap_recipe).
//
// RESOLVED DECODER DIVERGENCE (was reported to parent during extraction; the fix has landed and
//   these assertions now pass): decodeV22 previously read the tags-1/2/4 metadata block at frame
//   offset 117 via `v22MetaBlock(buf, 117)`. OpenStrap places that block at inner[117] = frame 125
//   (gen5_records.dart `_kV22WideMetaBase = 117`, inner-relative) and tag 3 at inner[119] = frame 127.
//   decodeV22 now reads 125/127 and every golden meta assertion below passes.
//
// DOCUMENTED DIVERGENCES asserted as FRWHOOP behavior (per mission rule, both sources cited inline):
//   - v22 exact length: OpenStrap Gen5V22Decoder.matches() requires inner.length == 176 exactly
//     (parse returns null otherwise); FRWHOOP decodeV22 emits a warning but still decodes.
//   - v26 exact length: OpenStrap rejects inner != 76; FRWHOOP decodeV26 has no length gate.
//   - v18 morphologyPass / sleep-state names are computed in-test from FRWHOOP raw fields.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { crc16Modbus, crc32 } from '../../protocol/crc.js';
import {
  decodeV22, decodeV26, decodeV18, decodeV20,
  decodeGen5ImuBuffer, isGen5ImuBuffer,
  decodeGen5HistoricalHeader, reconstructSaturatedDeltaWindow,
  GEN5_V22_FRAME_LEN, GEN5_V22_INNER_LEN,
} from '../../protocol/gen5.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/openstrap-gen5-parity.json'), 'utf8'));

// ---- puffin frame wrapper (see fixture wrap_recipe) ----
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
  const c = crc32(inner, 0, inner.length);
  const o = 8 + inner.length;
  frame[o] = c & 0xFF; frame[o + 1] = (c >> 8) & 0xFF;
  frame[o + 2] = (c >> 16) & 0xFF; frame[o + 3] = (c >> 24) & 0xFF;
  return frame;
}

// little-endian writers over FRAME-absolute offsets (the decoder contract)
function putI16(f, off, v) { const u = v & 0xFFFF; f[off] = u & 0xFF; f[off + 1] = (u >> 8) & 0xFF; }
function putI32(f, off, v) { const u = v >>> 0; f[off] = u & 0xFF; f[off + 1] = (u >> 8) & 0xFF; f[off + 2] = (u >> 16) & 0xFF; f[off + 3] = (u >> 24) & 0xFF; }
function putF32(f, off, v) { new DataView(f.buffer).setFloat32(off, v, true); }

const approx = (got, want, tol, msg) => assert.ok(Math.abs(got - want) <= tol, `${msg}: ${got} vs ${want} (tol ${tol})`);

// =============================================================================
// v22 — shared header + gating
// =============================================================================
for (const name of ['realTag1', 'realTag2', 'realTag3', 'realTag5', 'realTag6']) {
  const e = fx.v22[name].expect;
  test(`v22 ${name}: header + tag + known_layout`, () => {
    const f = wrapInner(fx.v22[name].inner_hex);
    assert.equal(f.length, GEN5_V22_FRAME_LEN, 'full frame length');
    const d = decodeV22(f);
    assert.deepEqual(d.warnings, [], `${name} no warnings`);
    const fl = d.fields;
    assert.equal(fl.tag, e.tag);
    assert.equal(fl.known_layout, e.knownLayout);
    assert.equal(fl.hist_version, e.histVersion);
    assert.equal(fl.flags, e.flags);
    assert.equal(fl.ppg_sample_rate_hz, e.ppgSampleRateHz);
    assert.equal(fl.record_index, e.recordIndex);
    assert.equal(fl.unix, e.unix);
    assert.equal(fl.subsec_q15, e.tsSubsec, 'tsSubsec -> subsec_q15');
    assert.equal(fl.raw_body_hex.length / 2, e.rawBodyLen);
  });
}

// =============================================================================
// v22 — tag 1 real capture
// =============================================================================
test('v22 tag1: one 49-slot optical window at inner[15]', () => {
  const e = fx.v22.realTag1.expect;
  const fl = decodeV22(wrapInner(fx.v22.realTag1.inner_hex)).fields;
  assert.equal(fl.optical_windows.length, 1);
  const w = fl.optical_windows[0];
  assert.equal(w.frame_offset, 23, 'frame 23 = inner 15');
  assert.equal(w.first_sample_adc, e.opticalWindows[0].firstSampleAdc);
  assert.equal(w.first_sample_adc_in_range, e.opticalWindows[0].firstSampleAdcInRange);
  assert.equal(w.deltas.length, e.opticalWindows[0].deltasLen);
  assert.equal(w.deltas[0], e.opticalWindows[0].deltas0);
  assert.equal(w.deltas[24], e.opticalWindows[0].deltas24);
  assert.ok(w.deltas.slice(25).every((d) => d === 0), 'deltas[25:] are the padding marker run');
});

test('v22 tag1: reconstruction reports where it stops being trustworthy', () => {
  const e = fx.v22.realTag1.expect;
  const fl = decodeV22(wrapInner(fx.v22.realTag1.inner_hex)).fields;
  const r = fl.reconstruction[0];
  assert.equal(r.samples.length, e.reconstruction[0].samplesLen);
  assert.equal(r.samples[0], e.reconstruction[0].samplesFirst);
  assert.equal(r.first_ambiguous_sample_index, e.reconstruction[0].firstAmbiguousSampleIndex);
  assert.equal(r.trusted_sample_count, e.reconstruction[0].trustedSampleCount);
  assert.equal(r.has_saturated_delta, e.reconstruction[0].hasSaturatedDelta);
  assert.deepEqual(r.out_of_range_sample_indices, e.reconstruction[0].outOfRangeSampleIndices);
});

// KNOWN DECODER DIVERGENCE: decodeV22 reads tags-1/2/4 meta at frame 117, OpenStrap says inner[117] = frame 125.
test('v22 tag1: metadata block mirrors the paired R18 (OpenStrap inner[117] = frame 125)', () => {
  const e = fx.v22.realTag1.expect.meta;
  const fl = decodeV22(wrapInner(fx.v22.realTag1.inner_hex)).fields;
  const m = fl.meta;
  // OpenStrap reads the block at inner[117] = frame 125 (resolved decoder divergence).
  assert.equal(m.flags_snapshot, e.flagsSnapshotByte, 'flags_snapshot (want 0x21)');
  assert.equal(m.flags_snapshot & 3, e.flagsSnapshotLow2Bits, 'flags_snapshot & 3');
  approx(m.accel_delta_g, e.accelDeltaG, e.accelDeltaGTol, 'accel_delta_g');
  assert.equal(m.state_word, e.channelStateWord, 'state_word (want 1872)');
  assert.equal(m.primary_flags, e.primaryFlagsByte, 'primary_flags (want 1)');
  assert.equal(m.primary_flags & 3, e.primaryFlagsBit8Raw);
  assert.equal(m.unnamed_floats.length, e.unnamedMetadataFloatsLen);
  approx(m.unnamed_floats[0], e.unnamedMetadataFloats0, e.unnamedMetadataFloats0Tol, 'unnamed_floats[0]');
});

test('v22 tag1: no tag-2/4 extension region; raw body preserved', () => {
  const e = fx.v22.realTag1.expect;
  const fl = decodeV22(wrapInner(fx.v22.realTag1.inner_hex)).fields;
  assert.equal(fl.extended_metrics_raw_hex, undefined, 'extended_metrics_raw_hex empty');
  assert.equal(fl.accel_raw_x, undefined, 'accelRawX empty');
  assert.equal(fl.pip_record_unix, undefined, 'pipRecordUnix null');
  assert.equal(fl.raw_body_hex.length / 2, e.rawBodyLen);
});

// =============================================================================
// v22 — tag 2 real capture (clipped-flat window)
// =============================================================================
test('v22 tag2: clipped-flat window is detectable, not silently "valid"', () => {
  const e = fx.v22.realTag2.expect;
  const fl = decodeV22(wrapInner(fx.v22.realTag2.inner_hex)).fields;
  const w = fl.optical_windows[0];
  assert.equal(w.first_sample_adc, e.opticalWindows[0].firstSampleAdc, '+2^19-1 clip code');
  assert.equal(w.first_sample_adc_in_range, e.opticalWindows[0].firstSampleAdcInRange);
  assert.equal(w.is_clipped_flat, e.opticalWindows[0].isClippedFlat);
  assert.equal(w.deltas.length, e.opticalWindows[0].deltasLen);
  // The rail sits at delta[24] (inner[67:69] = 00 80), so samples[0..24] are all 524287 —
  // OpenStrap's take(25)-all-clip assertion holds; first_ambiguous_sample_index = 25.
  const r = fl.reconstruction[0];
  assert.ok(r.samples.slice(0, 25).every((s) => s === 524287), 'samples.take(25) all == 524287');
  assert.equal(r.first_ambiguous_sample_index, e.reconstruction[0].firstAmbiguousSampleIndex);
  assert.equal(r.trusted_sample_count, e.reconstruction[0].trustedSampleCount);
  assert.deepEqual(r.out_of_range_sample_indices, e.reconstruction[0].outOfRangeSampleIndices);
});

// KNOWN DECODER DIVERGENCE (same as tag1): meta read at frame 117 instead of 125.
test('v22 tag2: metadata block mirrors the paired R18', () => {
  const e = fx.v22.realTag2.expect.meta;
  const fl = decodeV22(wrapInner(fx.v22.realTag2.inner_hex)).fields;
  const m = fl.meta;
  assert.equal(m.flags_snapshot, e.flagsSnapshotByte, 'flags_snapshot (want 0x00)');
  approx(m.accel_delta_g, e.accelDeltaG, e.accelDeltaGTol, 'accel_delta_g (want 0.2208...)');
  assert.equal(m.state_word, e.channelStateWord, 'state_word (want 22512)');
  assert.equal(m.primary_flags, e.primaryFlagsByte, 'primary_flags (want 0)');
});

test('v22 tag2: located-but-unsplit extension region exposed raw', () => {
  const e = fx.v22.realTag2.expect;
  const fl = decodeV22(wrapInner(fx.v22.realTag2.inner_hex)).fields;
  assert.equal(fl.extended_metrics_raw_hex.length / 2, e.extendedMetricsRawLen, 'inner[144:155]');
  assert.equal(fl.raw_body_hex.length / 2, e.rawBodyLen);
});

// =============================================================================
// v22 — tag 3 real capture (two windows, metadata shifted +2)
// =============================================================================
test('v22 tag3: two 24-slot windows at inner[15] and inner[67]', () => {
  const e = fx.v22.realTag3.expect;
  const fl = decodeV22(wrapInner(fx.v22.realTag3.inner_hex)).fields;
  assert.equal(fl.optical_windows.length, 2);
  const a = fl.optical_windows[0];
  const b = fl.optical_windows[1];
  assert.equal(a.frame_offset, 23, 'window A frame 23 = inner 15');
  assert.equal(a.first_sample_adc, e.opticalWindows[0].firstSampleAdc);
  assert.equal(a.deltas.length, e.opticalWindows[0].deltasLen);
  assert.equal(a.deltas[0], e.opticalWindows[0].deltas0);
  assert.equal(a.deltas[12], e.opticalWindows[0].deltas12);
  assert.equal(fl.reconstruction[0].trusted_sample_count, e.opticalWindows[0].reconstructionTrustedSampleCount);
  assert.equal(b.frame_offset, 75, 'window B frame 75 = inner 67');
  assert.equal(b.first_sample_adc, e.opticalWindows[1].firstSampleAdc);
  assert.equal(b.is_clipped_flat, e.opticalWindows[1].isClippedFlat);
  assert.equal(b.deltas[12], e.opticalWindows[1].deltas12);
  assert.equal(b.deltas.length, e.opticalWindows[1].deltasLen);
});

test('v22 tag3: metadata block sits at inner[119], +2 from tags 1/2/4', () => {
  const e = fx.v22.realTag3.expect.meta;
  const fl = decodeV22(wrapInner(fx.v22.realTag3.inner_hex)).fields;
  const m = fl.meta;
  assert.equal(m.flags_snapshot, e.flagsSnapshotByte, 'flags_snapshot (want 0xE0)');
  assert.equal(m.flags_snapshot & 3, e.flagsSnapshotLow2Bits);
  approx(m.accel_delta_g, e.accelDeltaG, e.accelDeltaGTol, 'accel_delta_g');
  assert.equal(m.state_word, e.channelStateWord, 'state_word (want 592)');
  assert.equal(m.primary_flags, e.primaryFlagsByte, 'primary_flags (want 0)');
  assert.equal(fl.extended_metrics_raw_hex, undefined, 'extendedMetricsRaw empty');
});

// =============================================================================
// v22 — tag 5 real capture (embedded PIP ring record)
// =============================================================================
test('v22 tag5: ring record carries its OWN timestamp 39 s behind the carrier', () => {
  const e = fx.v22.realTag5.expect;
  const fl = decodeV22(wrapInner(fx.v22.realTag5.inner_hex)).fields;
  assert.equal(fl.unix, e.unix);
  assert.equal(fl.pip_record_unix, e.pipRecordUnix);
  assert.equal(fl.carrier_minus_pip_seconds, e.carrierMinusPipSeconds);
});

test('v22 tag5: one 24-slot window at inner[23], no saturation', () => {
  const e = fx.v22.realTag5.expect;
  const fl = decodeV22(wrapInner(fx.v22.realTag5.inner_hex)).fields;
  const w = fl.optical_windows[0];
  assert.equal(w.frame_offset, 31, 'frame 31 = inner 23');
  assert.equal(w.first_sample_adc, e.opticalWindows[0].firstSampleAdc);
  assert.equal(w.deltas.length, e.opticalWindows[0].deltasLen);
  assert.ok(!w.deltas.includes(-32768), 'no -32768 in deltas');
  const r = fl.reconstruction[0];
  assert.equal(r.has_saturated_delta, false);
  assert.equal(r.samples.length, e.opticalWindows[0].reconstructionSamplesLen);
});

test('v22 tag5: mirrors match the R18 of the RING second, not the carrier', () => {
  const e = fx.v22.realTag5.expect;
  const fl = decodeV22(wrapInner(fx.v22.realTag5.inner_hex)).fields;
  approx(fl.accel_delta_g, e.accelDeltaG, e.accelDeltaGTol, 'accel_delta_g');
  assert.equal(fl.state_word, e.channelStateWord);
  assert.equal(fl.primary_flags, e.primaryFlagsByte);
});

test('v22 tag5: stale tail is NOT decoded as tag-1/2/4 metadata', () => {
  const e = fx.v22.realTag5.expect;
  const fl = decodeV22(wrapInner(fx.v22.realTag5.inner_hex)).fields;
  assert.equal(fl.meta, undefined, 'no meta block on tag 5');
  assert.equal(fl.accel_raw_x, undefined);
  // raw body still carries the stale bytes verbatim (rawBody[108] == inner[121])
  const inner = Buffer.from(fx.v22.realTag5.inner_hex, 'hex');
  assert.equal(fl.raw_body_hex.slice(2 * 108, 2 * 108 + 2), inner[121].toString(16).padStart(2, '0'));
  assert.equal(fl.raw_body_hex.length / 2, e.rawBodyLen);
});

// =============================================================================
// v22 — tag 6 real capture (25 x i16 acceleration per axis)
// =============================================================================
test('v22 tag6: three 25-sample axes at inner[18]/[68]/[118]', () => {
  const e = fx.v22.realTag6.expect;
  const fl = decodeV22(wrapInner(fx.v22.realTag6.inner_hex)).fields;
  assert.equal(fl.accel_raw_x.length, e.accelRawXLen);
  assert.equal(fl.accel_raw_y.length, e.accelRawYLen);
  assert.equal(fl.accel_raw_z.length, e.accelRawZLen);
  assert.equal(fl.accel_raw_x[0], e.accelRawXFirst);
  assert.equal(fl.accel_raw_x[fl.accel_raw_x.length - 1], e.accelRawXLast);
  assert.equal(fl.accel_raw_y[0], e.accelRawYFirst);
  assert.equal(fl.accel_raw_z[0], e.accelRawZFirst);
  assert.equal(fl.accel_raw_z[fl.accel_raw_z.length - 1], e.accelRawZLast);
});

test('v22 tag6: 4096 LSB/g scale puts a resting wrist at 1 g', () => {
  const e = fx.v22.realTag6.expect;
  const fl = decodeV22(wrapInner(fx.v22.realTag6.inner_hex)).fields;
  approx(fl.accel_raw_x[0] * fl.accel_scale_g_per_lsb, e.accelScaleGPerLsb * e.accelRawXFirst, 1e-12, 'accelXg.first');
  let total = 0;
  for (let i = 0; i < 25; i += 1) {
    const x = fl.accel_raw_x[i] * fl.accel_scale_g_per_lsb;
    const y = fl.accel_raw_y[i] * fl.accel_scale_g_per_lsb;
    const z = fl.accel_raw_z[i] * fl.accel_scale_g_per_lsb;
    total += Math.sqrt(x * x + y * y + z * z);
  }
  assert.ok(Math.abs(total / 25 - 1.0) <= 0.1, `mean magnitude ${total / 25} ~ 1.0 g`);
});

test('v22 tag6: no optical window, no R18 mirror; tail raw', () => {
  const e = fx.v22.realTag6.expect;
  const fl = decodeV22(wrapInner(fx.v22.realTag6.inner_hex)).fields;
  assert.equal(fl.optical_windows, undefined);
  assert.equal(fl.meta, undefined);
  assert.deepEqual(Buffer.from(fl.accel_tail_raw_hex, 'hex'), Buffer.from(e.accelTailRaw), 'inner[168:176]');
});

// =============================================================================
// v22 — synthetic poisoned bodies (stale-bytes rule) + unknown tag + length gate
// =============================================================================
function poisonBody(tag) {
  const r = fx.v22.poison.recipe;
  const inner = Buffer.alloc(r.inner_len, r.poison_byte);
  inner[0] = r.record_class;
  inner[1] = r.hist_version;
  inner[2] = r.flags;
  putI32(inner, 3, r.record_index);
  putI32(inner, 7, r.unix);
  putI16(inner, 11, r.subsec_q15);
  inner[13] = tag;
  inner[14] = r.byte14;
  return inner; // inner-relative; callers wrap
}

function writeMetaInner(inner, base, w) {
  inner[base + 1] = w.flagsSnapshot;
  putF32(inner, base + 4, w.accelDeltaG);
  putF32(inner, base + 8, w.f1);
  putF32(inner, base + 12, w.f2);
  putF32(inner, base + 16, w.f3);
  putI16(inner, base + 20, w.stateWord);
  inner[base + 26] = w.primaryFlags;
}

function writeWindowInner(inner, start, firstSample, deltas) {
  putI32(inner, start, firstSample);
  for (let i = 0; i < deltas.length; i += 1) putI16(inner, start + 4 + 2 * i, deltas[i]);
}

test('v22 unknown tag: header + tag + raw body, nothing invented', () => {
  const e = fx.v22.poison.expect_unknown_tag;
  const fl = decodeV22(wrapInner(poisonBody(7).toString('hex'))).fields;
  assert.equal(fl.tag, e.tag);
  assert.equal(fl.known_layout, e.hasKnownLayout);
  assert.equal(fl.raw_body_hex.length / 2, e.rawBodyLen);
  assert.equal(fl.raw_body_hex.slice(0, 2), '07', 'rawBody[0] is the tag itself');
  assert.equal(fl.optical_windows, undefined, 'no optical windows');
  assert.equal(fl.meta, undefined, 'no meta block');
  assert.equal(fl.pip_record_unix, undefined);
  assert.equal(fl.accel_raw_x, undefined);
  assert.equal(fl.accel_tail_raw_hex, undefined);
  assert.equal(fl.extended_metrics_raw_hex, undefined);
  assert.equal(fl.accel_delta_g, undefined);
  assert.equal(fl.state_word, undefined);
  assert.equal(fl.primary_flags, undefined);
});

test('v22 poison tag1: only assigned offsets are read; meta block reads inner[117]', () => {
  const e = fx.v22.poison.per_tag['1'].expect;
  const inner = poisonBody(1);
  const deltas = Array.from({ length: 49 }, (_, i) => (i < 24 ? i - 12 : 0));
  deltas[24] = -32768;
  writeWindowInner(inner, 15, -12345, deltas);
  writeMetaInner(inner, 117, fx.v22.poison.per_tag['1'].write.meta);
  const fl = decodeV22(wrapInner(inner.toString('hex'))).fields;
  assert.equal(fl.optical_windows[0].first_sample_adc, e.firstSampleAdc);
  assert.equal(fl.optical_windows[0].deltas[24], e.deltas24);
  // Meta block written at inner[117] (frame 125) — the stale-bytes guard: a decoder reading
  // any unassigned offset would surface the 0xA5 poison. Asserting OpenStrap truth:
  assert.equal(fl.meta.flags_snapshot, e.flagsSnapshotByte, 'flags_snapshot (want 0x61)');
  assert.equal(fl.meta.accel_delta_g, e.accelDeltaG, 'accel_delta_g (want 0.25)');
  assert.deepEqual(fl.meta.unnamed_floats, e.unnamedMetadataFloats, 'unnamed_floats (want [-0.5, 0.75, 1.5])');
  assert.equal(fl.meta.state_word, e.channelStateWord, 'state_word (want 0xBEEF)');
  assert.equal(fl.meta.primary_flags, e.primaryFlagsByte, 'primary_flags (want 1)');
  assert.equal(fl.extended_metrics_raw_hex, undefined, 'extendedMetricsRaw empty');
  assert.equal(fl.accel_raw_x, undefined);
  assert.equal(fl.pip_record_unix, undefined);
  assert.equal(fl.raw_body_hex.slice(2 * (160 - 13), 2 * (160 - 13) + 2), 'a5', 'raw body keeps poison verbatim at inner[160]');
});

test('v22 poison tag2: extension region exposed without naming anything in it', () => {
  const e = fx.v22.poison.per_tag['2'].expect;
  const inner = poisonBody(2);
  writeWindowInner(inner, 15, 100, Array(49).fill(0));
  writeMetaInner(inner, 117, fx.v22.poison.per_tag['2'].write.meta);
  const fl = decodeV22(wrapInner(inner.toString('hex'))).fields;
  assert.equal(fl.extended_metrics_raw_hex.length / 2, e.extendedMetricsRawLen);
  assert.ok(Buffer.from(fl.extended_metrics_raw_hex, 'hex').every((b) => b === 0xA5), 'extension bytes are the poison verbatim');
});

test('v22 poison tag4: shares tag-1/2 layout and writes the extension region', () => {
  const e = fx.v22.poison.per_tag['4'].expect;
  const inner = poisonBody(4);
  writeWindowInner(inner, 15, 300, Array(49).fill(0));
  writeMetaInner(inner, 117, fx.v22.poison.per_tag['4'].write.meta);
  const fl = decodeV22(wrapInner(inner.toString('hex'))).fields;
  assert.equal(fl.optical_windows[0].deltas.length, e.deltasLen);
  // Meta block written at inner[117] = frame 125 (resolved decoder divergence).
  assert.equal(fl.meta.accel_delta_g, e.accelDeltaG, 'accel_delta_g (want 0.5)');
  assert.equal(fl.meta.state_word, e.channelStateWord, 'state_word (want 1872)');
  assert.equal(fl.meta.flags_snapshot, e.flagsSnapshotByte, 'flags_snapshot (want 0x10)');
  assert.equal(fl.extended_metrics_raw_hex.length / 2, e.extendedMetricsRawLen);
  assert.equal(fl.pip_record_unix, undefined);
  assert.equal(fl.accel_raw_x, undefined);
});

test('v22 poison tag3: reads two windows and the +2 metadata base', () => {
  const e = fx.v22.poison.per_tag['3'].expect;
  const inner = poisonBody(3);
  writeWindowInner(inner, 15, 1000, Array.from({ length: 24 }, (_, i) => i + 1));
  writeWindowInner(inner, 67, -2000, Array.from({ length: 24 }, (_, i) => -(i + 1)));
  writeMetaInner(inner, 119, fx.v22.poison.per_tag['3'].write.meta);
  const fl = decodeV22(wrapInner(inner.toString('hex'))).fields;
  assert.deepEqual(fl.optical_windows.map((w) => w.first_sample_adc), e.firstSampleAdcs);
  assert.equal(fl.optical_windows[0].deltas[0], e.deltas0A);
  assert.equal(fl.optical_windows[1].deltas[0], e.deltas0B);
  assert.equal(fl.meta.accel_delta_g, e.accelDeltaG);
  assert.equal(fl.meta.state_word, e.channelStateWord);
  assert.equal(fl.meta.flags_snapshot, e.flagsSnapshotByte);
  assert.equal(fl.meta.primary_flags, e.primaryFlagsByte);
});

test('v22 poison tag5: reads the ring record, never the shared metadata block', () => {
  const e = fx.v22.poison.per_tag['5'].expect;
  const inner = poisonBody(5);
  putI32(inner, 15, 1780000024);
  writeWindowInner(inner, 23, 4096, Array(24).fill(7));
  putF32(inner, 75, 0.5);
  putI16(inner, 79, 864);
  inner[81] = 1;
  const fl = decodeV22(wrapInner(inner.toString('hex'))).fields;
  assert.equal(fl.pip_record_unix, e.pipRecordUnix);
  assert.equal(fl.optical_windows[0].first_sample_adc, e.firstSampleAdc);
  assert.equal(fl.optical_windows[0].deltas.length, e.deltasLen);
  assert.equal(fl.accel_delta_g, e.accelDeltaG);
  assert.equal(fl.state_word, e.channelStateWord);
  assert.equal(fl.primary_flags, e.primaryFlagsByte);
  assert.equal(fl.primary_flags & 3, e.primaryFlagsBit8Raw);
  assert.equal(fl.meta, undefined, 'no meta block on tag 5');
});

test('v22 poison tag6: three axes and the raw tail, no window', () => {
  const e = fx.v22.poison.per_tag['6'].expect;
  const inner = poisonBody(6);
  for (let i = 0; i < 25; i += 1) {
    putI16(inner, 18 + 2 * i, 4096);
    putI16(inner, 68 + 2 * i, -2048);
    putI16(inner, 118 + 2 * i, 0);
  }
  for (let o = 168; o < GEN5_V22_INNER_LEN; o += 1) inner[o] = o - 168;
  const fl = decodeV22(wrapInner(inner.toString('hex'))).fields;
  assert.ok(fl.accel_raw_x.every((x) => x * fl.accel_scale_g_per_lsb === e.accelXgAll), 'X = 1.0 g');
  assert.ok(fl.accel_raw_y.every((y) => y * fl.accel_scale_g_per_lsb === e.accelYgAll), 'Y = -0.5 g');
  assert.ok(fl.accel_raw_z.every((z) => z * fl.accel_scale_g_per_lsb === e.accelZgAll), 'Z = 0.0 g');
  assert.deepEqual(Buffer.from(fl.accel_tail_raw_hex, 'hex'), Buffer.from(e.accelTailRaw));
  assert.equal(fl.optical_windows, undefined);
});

test('v22 isClippedFlat: +/- i16 rails end the usable band; nonzero in-band delta is signal', () => {
  // OpenStrap gen5_v22_test.dart: positive/negative rail runs are clipped-flat,
  // a nonzero in-band delta is not.
  const cases = [
    { deltas: [0, 0, 0, 32767, 12, -9], clipped: true, name: 'positive rail' },
    { deltas: [0, 0, 0, -32768, 12, -9], clipped: true, name: 'negative rail' },
    { deltas: [0, 5, 0, -32768], clipped: false, name: 'real signal' },
  ];
  for (const c of cases) {
    const inner = poisonBody(1);
    const d = Array(49).fill(0);
    c.deltas.forEach((v, i) => { d[i] = v; });
    writeWindowInner(inner, 15, 524287, d);
    const fl = decodeV22(wrapInner(inner.toString('hex'))).fields;
    assert.equal(fl.optical_windows[0].is_clipped_flat, c.clipped, c.name);
  }
});

test('v22 exact-length gate: OpenStrap rejects !=176; FRWHOOP warns and still decodes (documented divergence)', () => {
  const g = fx.v22.exact_length_gate;
  const full = wrapInner(fx.v22.realTag1.inner_hex);
  assert.equal(full.length, GEN5_V22_FRAME_LEN);
  const innerFull = Buffer.from(fx.v22.realTag1.inner_hex, 'hex');
  for (const len of g.truncate_to) {
    // truncate for 175; APPEND a byte for 177 (subarray cannot grow)
    const inner = len <= innerFull.length
      ? innerFull.subarray(0, len)
      : Buffer.concat([innerFull, Buffer.from([0x00])]);
    const f = wrapInner(inner.toString('hex'));
    const d = decodeV22(f);
    // OpenStrap: Gen5V22Decoder.matches() is EXACT (inner.length == 176) -> parse returns null.
    // FRWHOOP (documented, gen5.js): emits 'v22 exact-length gate failed' but still decodes.
    assert.ok(d.warnings.some((w) => w.includes('exact-length gate')), `len=${len} warns`);
    assert.equal(d.fields.known_layout, true, `len=${len} FRWHOOP continues decoding`);
    assert.equal(d.fields.raw_body_hex.length / 2, 163, `len=${len} raw body span`);
  }
});

// =============================================================================
// v18 — real fixture
// =============================================================================
const v18 = fx.v18[0];
function decodeV18Fx() {
  return decodeV18(wrapInner(v18.inner_hex));
}

test('v18: shared header (flags, subsec Q15, record index, unix)', () => {
  const e = v18.expect;
  const fl = decodeV18Fx().fields;
  assert.equal(fl.hist_version, e.histVersion);
  assert.equal(fl.record_index, e.recordIndex);
  assert.equal(fl.unix, e.unix);
  assert.equal(fl.flags, e.flags);
  assert.equal(fl.ppg_sample_rate_hz, e.ppgSampleRateHz);
  assert.equal(fl.subsec_q15, e.tsSubsec);
  approx(fl.subsec_seconds, e.tsSubsec / 32768, e.subSecondTol, 'subSecond');
});

test('v18: heart rate + RR', () => {
  const e = v18.expect;
  const fl = decodeV18Fx().fields;
  assert.equal(fl.heart_rate, e.heartRate);
  assert.equal(fl.rr_count, e.rrCount);
  assert.deepEqual(fl.rr_intervals_ms, e.rrIntervalsMs);
});

test('v18: quality flags stay raw; alt-HR is gated, never substituted', () => {
  const e = v18.expect;
  const fl = decodeV18Fx().fields;
  assert.equal(fl.hr_quality_flags, e.hrQualityFlags);
  assert.equal(fl.hr_quality_flags & 0x10, 0, 'bit4 is never set on observed records');
  assert.equal(fl.heart_rate_alt, e.heartRateAlt);
  assert.notEqual(fl.heart_rate_alt, fl.heart_rate, 'heartRateAlt is a corroboration signal, not a duplicate');
});

test('v18: motion — gravity unit magnitude, dynamic accel small', () => {
  const e = v18.expect;
  const fl = decodeV18Fx().fields;
  const g = fl.gravity_or_accel_means;
  for (let i = 0; i < 3; i += 1) approx(g[i], e.gravityG[i], e.gravityGTol, `gravityG[${i}]`);
  const magSq = g.reduce((a, b) => a + b * b, 0);
  assert.ok(Math.abs(magSq - 1.0) <= 0.05, `gravity magnitude^2 ${magSq} ~ 1.0`);
  approx(fl.dynamic_acceleration, e.dynamicAccelerationG, e.dynamicAccelerationGTol, 'dynamicAccelerationG');
});

test('v18: steps + activity', () => {
  const e = v18.expect;
  const fl = decodeV18Fx().fields;
  assert.equal(fl.step_motion_counter, e.stepMotionCounter);
  assert.equal(fl.step_cadence, e.stepCadence);
  assert.equal(fl.activity_class, e.activityClass);
});

test('v18: temperature (gen5-specific scales)', () => {
  const e = v18.expect;
  const fl = decodeV18Fx().fields;
  approx(fl.temp_aux_1_raw / 10, e.tempAux1C, e.tempTol, 'tempAux1C');
  approx(fl.temp_aux_2_raw / 10, e.tempAux2C, e.tempTol, 'tempAux2C');
  approx(fl.skin_temp_raw / 100, e.skinTempC, e.tempTol, 'skinTempC');
});

test('v18: optical front end — four independent bytes, not two u16s', () => {
  const e = v18.expect;
  const fl = decodeV18Fx().fields;
  assert.deepEqual(fl.optical_baseline_ab, [e.pdMeanB, e.pdMeanA], 'pdMeanB/pdMeanA');
  assert.deepEqual(fl.optical_amp_or_psnr, [e.psnrB, e.psnrA], 'psnrB/psnrA signed dB');
  assert.equal(fl.optical_sentinel_pair, false);
  assert.equal((fl.optical_baseline_ab[0] << 8) | fl.optical_baseline_ab[1], e.opticalBaseline, 'compat u16 view');
});

test('v18: experimental fields exposed raw, not fabricated', () => {
  const e = v18.expect;
  const fl = decodeV18Fx().fields;
  assert.equal(fl.cardiac_status, e.cardiacStatusRaw);
  assert.equal(fl.aux_byte_82, e.spo2CandidateRaw);
});

test('v18: band sleep state — this fixture is awake', () => {
  const e = v18.expect;
  const fl = decodeV18Fx().fields;
  assert.equal(fl.sleep_state_byte, e.sleepStateByte);
  assert.equal((fl.sleep_state_byte >> 4) & 3, e.sleepStateRawNibble);
  assert.equal(fl.sleep_state, 0, '0 = wake (openstrap ordering: 0 wake / 1 still / 2 sleep / 3 up)');
  assert.equal(fl.sleep_state_byte_bits67, e.bits67Raw);
  assert.equal(fl.primary_flags_bit8_or_onwrist, e.onWristRaw);
  assert.equal(fl.strap_fit_or_wake_quality, e.wakeQualityRaw);
});

test('v18: signal-quality log variance decodes off the real fixture', () => {
  const e = v18.expect;
  const fl = decodeV18Fx().fields;
  approx(fl.f32_113, e.signalQualityLogVariance, e.signalQualityLogVarianceTol, 'signalQualityLogVariance');
});

test('v18: skin temp -5000 raw reads as unavailable, not a temperature', () => {
  const f = wrapInner(v18.inner_hex);
  putI16(f, 73, -5000);
  const fl = decodeV18(f).fields;
  assert.equal(fl.skin_temp_unavailable, true, '-5000 sentinel (signed i16)');
  assert.equal(fl.skin_temp_raw, undefined, 'no temperature value fabricated');
});

test('v18: sleep-state nibble ordering (0 wake / 1 still / 2 sleep / 3 up), masked to 2 bits', () => {
  for (let nibble = 0; nibble <= 3; nibble += 1) {
    const f = wrapInner(v18.inner_hex);
    f[81] = (f[81] & 0x0F) | (nibble << 4);
    const fl = decodeV18(f).fields;
    assert.equal(fl.sleep_state, nibble, `nibble ${nibble}`);
  }
  // full-byte mask invariant (openstrap record-fields test: bits 0-1 onwrist, 2-3 wake, 4-5 sleep, 6-7 raw)
  for (let b = 0; b <= 255; b += 1) {
    const f = wrapInner(v18.inner_hex);
    f[81] = b;
    const fl = decodeV18(f).fields;
    assert.equal(fl.primary_flags_bit8_or_onwrist, b & 0x03, `byte ${b} onwrist`);
    assert.equal(fl.strap_fit_or_wake_quality, (b >> 2) & 0x03, `byte ${b} wake`);
    assert.equal(fl.sleep_state, (b >> 4) & 0x03, `byte ${b} sleep`);
    assert.equal(fl.sleep_state_byte_bits67, (b >> 6) & 0x03, `byte ${b} bits67`);
  }
});

test('v18: flags bit 7 = PPG sample rate (25 Hz set / 50 Hz clear), other bits do not disturb it', () => {
  for (const b of [0x00, 0x02, 0x7F, 0x80, 0x82, 0xFF]) {
    const f = wrapInner(v18.inner_hex);
    f[10] = b;
    const fl = decodeV18(f).fields;
    assert.equal(fl.flags, b, `raw byte ${b}`);
    assert.equal(fl.ppg_sample_rate_hz, (b & 0x80) !== 0 ? 25 : 50, `b=${b}`);
  }
});

test('v18: Q15 sub-second scale holds for verified raw values', () => {
  for (const [raw, seconds] of [[18350, 0.56], [18022, 0.55], [12124, 0.37]]) {
    const f = wrapInner(v18.inner_hex);
    putI16(f, 19, raw);
    const fl = decodeV18(f).fields;
    assert.equal(fl.subsec_q15, raw);
    approx(fl.subsec_seconds, seconds, 1e-4, `raw=${raw}`);
  }
});

// =============================================================================
// v20 — five-block optical buffer (synthetic, offsets from OpenStrap §1.5)
// =============================================================================
test('v20: decodes 5 blocks, only 0/3/4 active, raw channel samples verbatim', () => {
  const fx20 = fx.v20[0];
  const e = fx20.expect;
  const f = wrapInner(fx20.inner_hex);
  assert.equal(f.length, 2140, 'full frame 2140');
  const fl = decodeV20(f).fields;
  assert.equal(fl.record_index, e.recordIndex);
  assert.equal(fl.unix, e.unix);
  const counts = [0, 1, 2, 3, 4].map((b) => fl[`block_${b}_sample_count`]);
  assert.deepEqual(counts, e.activeSampleCounts);
  assert.equal(fl.block_0_slot_0_samples[0], e.block0Channel0[0], 'channel0 first');
  assert.equal(fl.block_0_slot_0_samples[24], e.block0Channel0[1], 'channel0 last');
  assert.equal(fl.block_0_slot_0_samples.length, 25);
  assert.equal(fl.block_0_slot_1_samples[0], e.block0Channel1[0], 'channel1 first');
  assert.equal(fl.block_0_slot_1_samples[24], e.block0Channel1[1], 'channel1 last');
  assert.equal(fl.block_0_slot_1_samples.length, 25);
  assert.equal(fl.block_1_slot_0_samples, undefined, 'empty block 1 no channel');
  assert.equal(fl.block_2_slot_0_samples, undefined, 'empty block 2 no channel');
  assert.equal(fl.block_3_slot_0_samples.length, 25);
  assert.equal(fl.block_4_slot_0_samples.length, 25);
});

test('v20: channel slot start offsets match both reference repos exactly', () => {
  // whoop-rs inner-relative offsets (39,239,1305,1505,1727,1927) from the frame-absolute (47,247,...).
  const bodyStart = 18; const blockLen = 422;
  const ch0 = (b) => bodyStart + b * blockLen + 21;
  const ch1 = (b) => ch0(b) + 200;
  const e = fx.v20[0].expect.slotOffsets;
  assert.equal(ch0(0), e.ch0_0); assert.equal(ch1(0), e.ch1_0);
  assert.equal(ch0(3), e.ch0_3); assert.equal(ch1(3), e.ch1_3);
  assert.equal(ch0(4), e.ch0_4); assert.equal(ch1(4), e.ch1_4);
});

test('v20: buffer carries its own sample rate and sub-second', () => {
  const fx20 = fx.v20[1];
  const e = fx20.expect;
  const fl = decodeV20(wrapInner(fx20.inner_hex)).fields;
  assert.equal(fl.sample_rate_hz_declared, e.sampleRateHz);
  assert.equal(fl.subsec_q15, e.tsSubsec);
  approx(fl.subsec_seconds, e.tsSubsec / 32768, e.subSecondTol, 'subSecond');
  assert.equal(fl.flags, e.flags);
  assert.equal(fl.ppg_sample_rate_hz, e.ppgSampleRateHz);
  assert.equal(fl.flags & 0x01, e.flagsBit0, 'block-3 IR-fallback flag');
});

test('v20: block metadata decomposes into LED drive + per-photodiode ADC', () => {
  const fx20 = fx.v20[1];
  const e = fx20.expect;
  const fl = decodeV20(wrapInner(fx20.inner_hex)).fields;
  for (let b = 0; b < 5; b += 1) {
    const h = fl[`block_${b}_header`];
    assert.equal(h.led_a_driver_connection, e.ledADriverConnection, `block ${b} ledA conn`);
    assert.equal(h.led_a_current_raw, e.ledACurrentRaw, `block ${b} ledA raw`);
    // OpenStrap: ledACurrentMicroamps = raw * 10 (units of 10 µA).
    assert.equal(h.led_a_current_raw * 10, e.ledACurrentMicroamps, `block ${b} ledA µA`);
    assert.equal(h.led_b_driver_connection, e.ledBDriverConnection, `block ${b} ledB conn`);
    assert.equal(h.led_b_current_raw, e.ledBCurrentRaw, `block ${b} ledB raw`);
    assert.equal(h.led_b_current_raw * 10, e.ledBCurrentMicroamps, `block ${b} ledB µA`);
    assert.equal(h.detector0_source, e.channel0Source, `block ${b} det0 src`);
    assert.equal(h.detector0_range, e.channel0AdcRange, `block ${b} det0 range`);
    assert.equal(h.detector0_offset_current, e.tia1OffsetCurrentRaw, `block ${b} tia1 offset`);
    assert.equal(h.detector1_source, e.channel1Source, `block ${b} det1 src`);
    assert.equal(h.detector1_range, e.channel1AdcRange, `block ${b} det1 range`);
    assert.equal(h.detector1_offset_current, e.tia2OffsetCurrentRaw, `block ${b} tia2 offset`);
    // FRWHOOP exposes raw blobs as bytes, not named spans; OpenStrap lengths are documented below.
  }
});

test('v20: TIA offset current is a signed i16 in 10 nA/LSB', () => {
  const fx20 = fx.v20[2];
  const e = fx20.expect;
  const fl = decodeV20(wrapInner(fx20.inner_hex)).fields;
  const h = fl.block_0_header;
  assert.equal(h.detector0_offset_current, e.tia1OffsetCurrentRaw, '0xFC18 = -1000 signed');
  assert.equal(h.detector0_offset_current * 10, e.tia1OffsetCurrentNanoamps, '-10,000 nA');
  assert.equal(h.detector1_offset_current, e.tia2OffsetCurrentRaw, '2400');
  assert.equal(h.detector1_offset_current * 10, e.tia2OffsetCurrentNanoamps, '+24,000 nA');
});

// =============================================================================
// v21 — 6-axis IMU buffer (synthetic, offsets from OpenStrap §1.5)
// =============================================================================
test('v21: is identified by shape (paired declared counts), decodes six axes', () => {
  const fx21 = fx.v21[0];
  const e = fx21.expect;
  const f = wrapInner(fx21.inner_hex);
  assert.equal(f.length, 1244, 'full frame 1244');
  assert.equal(isGen5ImuBuffer(f), true, 'shape gate');
  const d = decodeGen5ImuBuffer(f);
  assert.equal(d.fields.record_index, e.recordIndex);
  assert.equal(d.fields.unix, e.unix);
  assert.equal(d.fields.count_a, e.countA);
  assert.equal(d.fields.count_b, e.countB);
  assert.equal(d.fields.accel_x.length, e.accelXLen);
  // 4096 LSB * (1/4096) = 1.0 g
  approx(d.fields.accel_x[0] * d.fields.accel_scale_g_per_lsb, e.accelXgFirst, 1e-9, 'accelXg.first');
  assert.equal(d.fields.accel_y[0] * d.fields.accel_scale_g_per_lsb, e.accelYgFirst);
  // gyro raw 16384 * (2000/32768) dps
  approx(d.fields.gyro_x[0] * d.fields.gyro_scale_dps_per_lsb, e.gyroXdpsFirst, 1e-9, 'gyroXdps.first');
  assert.equal(d.fields.accel_scale_g_per_lsb, e.accelScaleGPerLsb);
  assert.equal(d.fields.gyro_scale_dps_per_lsb, e.gyroScaleDpsPerLsb);
});

test('v21: a partly-filled block decodes only the samples it declares', () => {
  const fx21 = fx.v21[1];
  const e = fx21.expect;
  const fl = decodeGen5ImuBuffer(wrapInner(fx21.inner_hex)).fields;
  assert.equal(fl.count_b, e.countB);
  assert.equal(fl.accel_x.length, e.accelXLen, 'accel block still full');
  assert.equal(fl.gyro_x.length, e.gyroXLen, 'gyro decodes only declared 40, never stale trailing bytes');
  assert.equal(fl.gyro_y.length, e.gyroYLen);
  assert.equal(fl.gyro_z.length, e.gyroZLen);
});

test('v21: rejects counts outside the block capacity (never reads stale bytes)', () => {
  const fx21 = fx.v21[2];
  for (const bad of [0, 101]) {
    const hex = bad === 0 ? fx21.inner_hex_bad_0 : fx21.inner_hex_bad_101;
    const f = wrapInner(hex);
    assert.equal(isGen5ImuBuffer(f), false, `countB=${bad} shape gate rejects`);
    const d = decodeGen5ImuBuffer(f);
    assert.equal(d.fields.count_b, bad, `countB=${bad} kept raw`);
    assert.equal(d.fields.accel_x, undefined, `countB=${bad} no axes decoded`);
    assert.ok(d.warnings.some((w) => w.includes('outside 1..100')), `countB=${bad} warns`);
  }
});

test('v21: an otherwise-v21-shaped buffer at the wrong length is not misidentified', () => {
  const f = wrapInner(fx.v21[0].inner_hex);
  const short = f.subarray(0, f.length - 1);
  assert.equal(isGen5ImuBuffer(short), false);
});

// =============================================================================
// v26 — real PIP record
// =============================================================================
const v26 = fx.v26[0];
function decodeV26Fx() {
  return decodeV26(wrapInner(v26.inner_hex));
}

test('v26: shared header + pip body', () => {
  const e = v26.expect;
  const fl = decodeV26Fx().fields;
  assert.equal(fl.hist_version, e.histVersion);
  assert.equal(fl.record_index, e.recordIndex);
  assert.equal(fl.unix, e.unix);
  assert.equal(fl.flags, e.flags);
  assert.equal(fl.ppg_sample_rate_hz, e.ppgSampleRateHz);
  assert.equal(fl.subsec_q15, e.tsSubsec, 'tsSubsec == segmentId');
  assert.equal(fl.pip_state_counter, e.pipStateCounter);
});

test('v26: first sample is the sign-extended i32; deltas are the wire truth', () => {
  const e = v26.expect;
  const fl = decodeV26Fx().fields;
  assert.equal(fl.first_sample_adc, e.firstSampleAdc);
  assert.equal(fl.first_sample_adc_in_range, e.firstSampleAdcInRange);
  assert.deepEqual(fl.optical_deltas, e.opticalDeltas);
});

test('v26: reconstructs a 25-sample window from first sample + 24 deltas', () => {
  const e = v26.expect.reconstruction;
  const fl = decodeV26Fx().fields;
  const r = fl.ppg_window_reconstruction;
  assert.equal(r.samples.length, e.samplesLen);
  assert.equal(r.samples[0], e.samplesFirst);
  assert.equal(r.samples[r.samples.length - 1], e.samplesLast);
  // cumulative sum: sample i+1 == sample i + delta i
  for (let i = 0; i < fl.optical_deltas.length; i += 1) {
    assert.equal(r.samples[i + 1], r.samples[i] + fl.optical_deltas[i], `delta ${i}`);
  }
  assert.equal(r.has_saturated_delta, e.hasSaturatedDelta);
  assert.equal(r.first_ambiguous_sample_index, e.firstAmbiguousSampleIndex);
  assert.deepEqual(r.out_of_range_sample_indices, e.outOfRangeSampleIndices);
  assert.equal(r.divergence_proven, e.divergenceProven);
  assert.equal(r.trusted_sample_count, e.trustedSampleCount);
});

test('v26: per-record metadata (accel delta, state word, flags, morphology, tail)', () => {
  const e = v26.expect;
  const fl = decodeV26Fx().fields;
  approx(fl.accel_delta_g, e.accelDeltaG, e.accelDeltaGTol, 'accel_delta_g');
  assert.equal(fl.channel_state_word, e.channelStateWord);
  assert.equal(fl.primary_flags_snapshot, e.primaryFlagsByte);
  assert.equal(fl.primary_flags_snapshot & 3, e.primaryFlagsBit8Raw);
  assert.equal(fl.waveform_morphology, e.morphologyByte);
  assert.equal(fl.waveform_morphology === 1, e.morphologyPass, 'morphologyPass (FRWHOOP exposes raw byte; computed here)');
  assert.equal(fl.aligned_tail, e.alignedTailByte);
});

test('v26: a -32768 delta marks its sample and everything after it ambiguous', () => {
  const f = wrapInner(v26.inner_hex);
  // delta[3] lives at inner[19 + 2*3] = frame[27 + 6] = frame 33: 00 80 LE = -32768
  putI16(f, 33, -32768);
  const fl = decodeV26(f).fields;
  assert.equal(fl.optical_deltas[3], -32768);
  const r = fl.ppg_window_reconstruction;
  assert.equal(r.has_saturated_delta, true);
  assert.equal(r.first_ambiguous_sample_index, 4, 'delta 3 produces sample 4; samples 0..3 survive');
  assert.equal(r.trusted_sample_count, 4);
  assert.equal(r.samples.length, 25, 'window still reconstructs — approximate, not withheld');
});

test('v26: +32767 is a rail too; one rail off is an ordinary delta', () => {
  const r = reconstructSaturatedDeltaWindow(1000, [10, 32767, 10]);
  assert.equal(r.has_saturated_delta, true);
  assert.equal(r.first_ambiguous_sample_index, 2);
  assert.equal(r.trusted_sample_count, 2);
  const near = reconstructSaturatedDeltaWindow(1000, [10, 32766, -10]);
  assert.equal(near.has_saturated_delta, false);
  assert.equal(near.trusted_sample_count, 4);
});

test('v26: an out-of-range reconstructed sample proves the inversion diverged', () => {
  const r = reconstructSaturatedDeltaWindow(524000, [200, 300, -100]);
  assert.deepEqual(r.samples, [524000, 524200, 524500, 524400]);
  assert.deepEqual(r.out_of_range_sample_indices, [2, 3]);
  assert.equal(r.divergence_proven, true);
  assert.equal(r.has_saturated_delta, false, 'independent of the clamp');
});

test('v26: a morphology byte other than 1 is not a pass', () => {
  for (const b of [0x00, 0x02, 0xFF]) {
    const f = wrapInner(v26.inner_hex);
    f[82] = b;
    const fl = decodeV26(f).fields;
    assert.equal(fl.waveform_morphology, b, 'raw byte preserved');
    assert.equal(fl.waveform_morphology === 1, false, `b=${b} not a pass`);
  }
});

test('v26: the first sample is a signed i32, not four independent bytes', () => {
  const f = wrapInner(v26.inner_hex);
  f.set([0x0A, 0xBB, 0xFD, 0xFF], 23); // -148726 sign-extends into the high byte
  const fl = decodeV26(f).fields;
  assert.equal(fl.first_sample_adc, -148726);
  assert.equal(fl.first_sample_adc_in_range, true);
});

test('v26: an impossible first sample is exposed raw, not fabricated', () => {
  const f = wrapInner(v26.inner_hex);
  f.set([0x00, 0x00, 0x40, 0x00], 23); // 4194304 > 2^19-1
  const fl = decodeV26(f).fields;
  assert.equal(fl.first_sample_adc, 4194304, 'raw value stays visible as itself');
  assert.equal(fl.first_sample_adc_in_range, false, 'not offered as a code the front end can produce');
  const r = fl.ppg_window_reconstruction;
  assert.ok(r.out_of_range_sample_indices.includes(0), 'reconstruction reports sample 0');
  assert.equal(r.divergence_proven, true);
});

test('v26: exact-length — OpenStrap rejects inner != 76; FRWHOOP decodes with no gate (documented divergence)', () => {
  // OpenStrap gen5_historical_test.dart: a v26 inner not exactly 76 bytes is rejected outright.
  // FRWHOOP decodeV26 has no length gate (gen5.js); fields are bail-safe and missing bytes are absent.
  for (const len of [75, 74]) {
    const short = Buffer.from(v26.inner_hex, 'hex').subarray(0, len);
    const fl = decodeV26(wrapInner(short.toString('hex'))).fields;
    assert.equal(fl.first_sample_adc, 378307, `len=${len} FRWHOOP still decodes header+window`);
    assert.equal(fl.optical_deltas.length, 24, `len=${len} deltas intact`);
  }
});

test('decodeGen5HistoricalHeader: shared header reports flags rate + Q15 subsec', () => {
  const f = wrapInner(v18.inner_hex);
  const hdr = decodeGen5HistoricalHeader(f);
  assert.equal(hdr.ok, true);
  assert.equal(hdr.fields.record_class, 0x2F);
  assert.equal(hdr.fields.flags, 0x80);
  assert.equal(hdr.fields.ppg_sample_rate_hz, 25);
  assert.equal(hdr.fields.subsec_q15, 18022);
  approx(hdr.fields.subsec_seconds, 18022 / 32768, 1e-6, 'subsec_seconds');
});
