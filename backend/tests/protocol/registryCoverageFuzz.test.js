import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVICE_FAMILIES, PACKET_TYPES, EVENT_NUMBERS, CONFLICTS, REGISTRY_ENTRIES,
  SOURCES, BLOCKED_COMMANDS, isProductEligible, tierRank, registryStats,
  familyForServiceUUID, entriesFor, maxTierOf,
} from '../../protocol/registry.js';
import { buildCoverage, envelopeSpans, BYTE_CLASSES } from '../../protocol/coverage.js';
import {
  reconstructSaturatedDeltaWindow, readI20, opticalAdcInRange, decodeGen5HistoricalHeader,
} from '../../protocol/gen5.js';
import { decodeFrame } from '../../protocol/decoder.js';
import { crc16Modbus, crc32 } from '../../protocol/crc.js';

test('registry: service families carry the pinned UUIDs and connectability facts', () => {
  assert.equal(SERVICE_FAMILIES.whoop4.serviceUUID, '61080001-8d6d-82b8-614a-1c8cb0f8dcc6');
  assert.equal(SERVICE_FAMILIES.maverick_goose_fd4b.serviceUUID, 'fd4b0001-cce1-4033-93ce-002d5875f58a');
  assert.equal(SERVICE_FAMILIES.puffin_1150.serviceUUID, '11500001-6215-11ee-8c99-0242ac120002');
  assert.equal(SERVICE_FAMILIES.monument.serviceUUID, '8a580001-2fe8-4796-9267-b87a2b0c8234');
  assert.equal(SERVICE_FAMILIES.symphony.serviceUUID, '59830001-5955-419b-bb8d-c8262926af23');
  assert.equal(familyForServiceUUID('FD4B0001-CCE1-4033-93CE-002D5875F58A'), 'maverick_goose_fd4b');
  assert.equal(SERVICE_FAMILIES.monument.connectable, false, 'monument is diagnostic-only');
  assert.equal(SERVICE_FAMILIES.symphony.connectable, false);
  assert.equal(SERVICE_FAMILIES.puffin_1150.connectable, false);
});

test('registry: every entry has provenance, tiers, and the conflict ledger is honest', () => {
  const stats = registryStats();
  assert.ok(stats.entries >= 8, `entries ${stats.entries}`);
  assert.ok(stats.fields >= 90, `fields ${stats.fields}`);
  for (const e of REGISTRY_ENTRIES) {
    assert.ok(e.key, 'entry key');
    for (const f of e.fields || []) {
      assert.ok(TIERS_OK.has(f.tier), `field ${f.name} tier ${f.tier}`);
      assert.ok((f.sources || []).length >= 1, `field ${f.name} cites a source`);
    }
  }
  // every open conflict names at least two claims and a policy
  for (const [id, c] of Object.entries(CONFLICTS)) {
    assert.ok(c.claims.length >= 2, `conflict ${id} claims`);
    assert.ok(c.policy && c.policy.length > 10, `conflict ${id} policy`);
  }
  // supersession recorded
  const v26 = CONFLICTS['v26.samples_vs_deltas'];
  assert.equal(v26.status, 'resolved:openstrap_saturated_deltas');
  assert.ok(v26.claims.some((c) => c.reading.includes('SUPERSEDED')));
});
const TIERS_OK = new Set(['structural', 'candidate', 'hardware_attested', 'cross_device_validated', 'product_eligible']);

test('registry: product-eligibility gate refuses non-product tiers', () => {
  assert.equal(isProductEligible({ tier: 'product_eligible' }), true);
  for (const t of ['structural', 'candidate', 'hardware_attested', 'cross_device_validated']) {
    assert.equal(isProductEligible({ tier: t }), false, t);
  }
  // NO field in the entire registry is product_eligible yet (mission rule:
  // nothing feeds health metrics until cross-device validation lands per-field)
  assert.ok(!REGISTRY_ENTRIES.some((e) => (e.fields || []).some((f) => f.tier === 'product_eligible')),
    'no product_eligible fields may exist without the formal per-field gate');
});

test('coverage: bitmap is exact and byte-totaling; unknown spans are maximal runs', () => {
  const cov = buildCoverage(20, [
    { from: 0, to: 4, cls: 'envelope' },
    { from: 4, to: 6, cls: 'decoded', name: 'a' },
    { from: 8, to: 12, cls: 'raw', name: 'b' },
    { from: 16, to: 20, cls: 'crc' },
  ], { warnings: [], confidence: 'low' });
  assert.equal(cov.summary.total_bytes, 20);
  assert.equal(cov.summary.decoded_bytes, 2);
  assert.equal(cov.summary.unknown_bytes, 6); // [6,8) + [12,16)
  assert.deepEqual(cov.unknown.map((s) => [s.from, s.to]), [[6, 8], [12, 16]]);
  const totalByClass = Object.values(cov.summary.by_class).reduce((a, b) => a + b, 0);
  assert.equal(totalByClass, 20, 'every byte is classified exactly once');
  assert.equal(cov.summary.fully_accounted, false);
  const cov2 = buildCoverage(12, [{ from: 0, to: 12, cls: 'decoded' }], { warnings: [], confidence: 'high' });
  assert.equal(cov2.summary.fully_accounted, true);
});

test('saturated-delta reconstruction: rails mark ambiguity, out-of-range proves divergence', () => {
  // clean window
  const r1 = reconstructSaturatedDeltaWindow(1000, [10, 20, -5]);
  assert.deepEqual(r1.samples, [1000, 1010, 1030, 1025]);
  assert.equal(r1.has_saturated_delta, false);
  assert.equal(r1.trusted_sample_count, 4);
  assert.equal(r1.divergence_proven, false);
  // saturated rail: everything after the rail is ambiguous
  const r2 = reconstructSaturatedDeltaWindow(249855, [601, -32768, 0]);
  assert.equal(r2.first_ambiguous_sample_index, 2);
  assert.equal(r2.trusted_sample_count, 2);
  assert.equal(r2.has_saturated_delta, true);
  // out-of-range reconstruction = proven divergence
  const r3 = reconstructSaturatedDeltaWindow(524287, [32767, 32767]);
  assert.equal(r3.divergence_proven, true);
  assert.ok(r3.out_of_range_sample_indices.length >= 1);
});

test('20-bit sign extension: negative rail and positive clip', () => {
  // wire ab a9 ff ff = -22101 (noop #423 example)
  const neg = readI20(new Uint8Array([0xab, 0xa9, 0xff, 0xff]), 0);
  assert.equal(neg, -22101);
  assert.equal(opticalAdcInRange(neg), true);
  assert.equal(readI20(new Uint8Array([0xff, 0xff, 0x07, 0x00]), 0), 524287);
  assert.equal(opticalAdcInRange(524288), false);
});

test('gen5 shared header: Q15 subsecond + flags bit7 rate', () => {
  const buf = new Uint8Array(24);
  buf[8] = 0x2F; buf[9] = 26; buf[10] = 0x80; // bit7 set = 25 Hz
  buf[11] = 0x11; buf[15] = 0x22;
  buf[19] = 0x00; buf[20] = 0x40; // 16384/32768 = 0.5 s
  const h = decodeGen5HistoricalHeader(buf);
  assert.equal(h.ok, true);
  assert.equal(h.fields.ppg_sample_rate_hz, 25);
  assert.equal(h.fields.subsec_seconds, 0.5);
  buf[10] = 0x00;
  assert.equal(decodeGen5HistoricalHeader(buf).fields.ppg_sample_rate_hz, 50);
});

test('property/fuzz: mutated and random frames never throw and always account bytes', () => {
  // seedable PRNG
  let seed = 0x2545F491;
  const rnd = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 0xFFFFFFFF;
  };
  const base = new Uint8Array(2140);
  base[0] = 0xAA; base[1] = 0x01; base[2] = 0x54; base[3] = 0x08;
  base[8] = 0x2f; base[9] = 20;
  for (let i = 21; i < 2136; i++) base[i] = (i * 37) & 0xFF;
  const h = crc16Modbus(base, 0, 6); base[6] = h & 0xFF; base[7] = (h >> 8) & 0xFF;
  const c = crc32(base, 8, 2136); base[2136] = c & 255; base[2137] = (c >>> 8) & 255; base[2138] = (c >>> 16) & 255; base[2139] = (c >>> 24) & 255;
  for (let iter = 0; iter < 60; iter++) {
    const m = Uint8Array.from(base);
    const mutations = 1 + Math.floor(rnd() * 8);
    for (let k = 0; k < 4; k++) m[Math.floor(rnd() * m.length)] = Math.floor(rnd() * 256);
    let d;
    assert.doesNotThrow(() => { d = decodeFrame(m, 'puffin'); }, `iteration ${iter}`);
    assert.equal(d.raw_hex.length, d.raw_length * 2, 'raw preserved verbatim');
    if (d.coverage) {
      const total = Object.values(d.coverage.summary.by_class).reduce((a, b) => a + b, 0);
      assert.equal(total, d.raw_length, `coverage byte-totaling at iteration ${iter}`);
    }
  }
});

test('property: unknown packet types and truncations degrade to preserved-raw statuses', () => {
  const f = new Uint8Array(40);
  f[0] = 0xAA; f[1] = 1; f[2] = 32; f[3] = 0;
  f[8] = 77; f[9] = 1; // unknown type
  const h = crc16Modbus(f, 0, 6); f[6] = h & 255; f[7] = (h >> 8) & 255;
  const c = crc32(f, 8, 36); f[36] = c & 255; f[37] = (c >>> 8) & 255; f[38] = (c >>> 16) & 255; f[39] = (c >>> 24) & 255;
  const d = decodeFrame(f, 'puffin');
  assert.equal(d.decode_status, 'unknown');
  assert.equal(d.raw_hex.length, 80);
  assert.ok(d.coverage, 'even unknown types carry coverage');
  // truncated frame: never throws, bytes preserved
  const t = f.slice(0, 17);
  const d2 = decodeFrame(t, 'puffin');
  assert.equal(d2.raw_length, 17);
});
