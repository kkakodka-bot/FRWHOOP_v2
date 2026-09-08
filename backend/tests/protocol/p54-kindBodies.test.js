// p54-kindBodies.test.js — type-54 pack payload decoders (frwhoop-p54/2).
//
// Fixtures p54k2/p54k9/p54k19/p54k20 are REAL CRC-valid frames from the
// FRWHOOP B2 Level-A corpus (fw 50.35.2.0, WHOOP 5, pack family WBB5B*),
// cached during the 2026-08-30 corpus census (/tmp/frwhoop_fixtures.json).
// Synthetic vectors are clearly marked and never counted as hardware
// evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decodePuffinEvents54,
  decodeKind2StateOfCharge,
  decodeKind20HardwareInfo,
  decodeKind19WptHealth,
  PUFFIN54_CANDIDATE_NAMES,
  PUFFIN54_DECODED_KINDS,
  PUFFIN54_DECODER_VERSION,
} from '../../protocol/puffin54.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(path.join(here, '../../tests/fixtures/p54KindBodies.json'), 'utf8'),
);

function decodeFixture(name) {
  return decodePuffinEvents54(Buffer.from(fixtures[name].hex, 'hex'), {
    fw: fixtures[name].fw || '50.35.2.0',
    char: 'FD4B0005',
  });
}

test('kind 2: battery-pack state of charge (tenths of percent, 0..1000 gate)', () => {
  const out = decodeFixture('p54k2');
  assert.equal(out.unmapped, false);
  const rec = out.records[0];
  assert.equal(rec.kind, 2);
  assert.equal(rec.decode_status, 'decoded');
  assert.equal(rec.candidate_name, 'PACK_STATE_OF_CHARGE');
  assert.equal(rec.decoded.payload_revision, 1);
  assert.ok(Number.isFinite(rec.decoded.pack_soc_deci_percent));
  assert.ok(rec.decoded.pack_soc_deci_percent >= 0 && rec.decoded.pack_soc_deci_percent <= 1000);
  assert.equal(rec.decoded.pack_soc_percent, rec.decoded.pack_soc_deci_percent / 10);
  // out-of-range SoC is kept raw, never clamped into range
  const bad = decodeKind2StateOfCharge([1, 0xF4, 0x05, 0]); // 1524 > 1000
  assert.equal(bad.fields.pack_soc_deci_percent, undefined);
  assert.ok(bad.warnings.length >= 1);
});

test('kind 9: pack double-tap candidate keeps body raw (no invented semantics)', () => {
  const out = decodeFixture('p54k9');
  const rec = out.records[0];
  assert.equal(rec.kind, 9);
  assert.equal(rec.candidate_name, 'PACK_DOUBLE_TAP');
  assert.equal(rec.decoded.payload_revision, 1);
  assert.equal(rec.decoded.unknown_hex, '000000');
  assert.equal(rec.semantic_status, 'candidate_semantic');
});

test('kind 19: WPT health record decodes provisional fields and keeps padding', () => {
  const out = decodeFixture('p54k19');
  const rec = out.records[0];
  assert.equal(rec.kind, 19);
  assert.equal(rec.candidate_name, 'PACK_WPT_HEALTH');
  assert.equal(rec.decoded.payload_revision, 1);
  assert.equal(rec.decoded.wpt_value_u16, 356);
  assert.equal(rec.decode_status, 'partial'); // provisional field names
});

test('kind 20: hardware identity decodes every field and REDACTS serial/address', () => {
  const out = decodeFixture('p54k20');
  const rec = out.records[0];
  assert.equal(rec.kind, 20);
  assert.equal(rec.decode_status, 'decoded');
  assert.equal(rec.candidate_name, 'PACK_HARDWARE_INFO');
  const d = rec.decoded;
  assert.equal(d.payload_revision, 1);
  assert.equal(d.hardware_family, 12);
  assert.equal(d.hardware_revision, 13);
  assert.equal(d.firmware_version, '3.30.5.0');
  assert.equal(d.colorway, 1);
  assert.ok(d.pack_soc_deci_percent <= 1000);
  // Redaction: DECODED fields must not leak the full serial or address.
  // payload_hex is the lossless raw-preservation location and is exempt.
  const decodedRow = JSON.stringify(rec.decoded) + (rec.serial_ascii || '');
  assert.ok(!decodedRow.includes(fixtures.p54k20.plain_serial), 'serial leaked in decoded fields');
  assert.ok(!decodedRow.includes(fixtures.p54k20.plain_addr), 'address leaked in decoded fields');
  assert.ok(rec.decoded.pack_serial_redacted.startsWith('WBB5'));
  assert.ok(rec.decoded.pack_ble_addr_redacted.includes('..'));
  assert.ok(rec.serial_ascii.startsWith('WBB5'));
  // Raw bytes stay losslessly preserved for re-decode (hex form of the serial).
  const serialHex = Buffer.from(fixtures.p54k20.plain_serial, 'utf8').toString('hex');
  assert.ok(rec.payload_hex.includes(serialHex));
  // direct decoder returns the same shape
  const direct = decodeKind20HardwareInfo(Buffer.from(fixtures.p54k20.payload_hex, 'hex'));
  assert.equal(direct.fields.firmware_version, '3.30.5.0');
});

test('pack vocabulary is registered with candidate semantics only (no invented bodies)', () => {
  for (const k of [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 50]) {
    assert.ok(PUFFIN54_CANDIDATE_NAMES[k], `kind ${k} missing from vocabulary`);
    assert.ok(String(PUFFIN54_CANDIDATE_NAMES[k]).startsWith('PACK_'));
  }
  // kinds 21/22 are pack reasons here — deliberately distinct from type-48
  // events 21/22 (pack connect/remove). The vocabularies must not merge.
  assert.equal(PUFFIN54_CANDIDATE_NAMES[21], 'PACK_REBOOT_REASON');
  assert.equal(PUFFIN54_CANDIDATE_NAMES[22], 'PACK_MODULE_FAILURE_REASON');
  for (const k of [2, 9, 19, 20]) assert.ok(PUFFIN54_DECODED_KINDS.has(k));
});

test('ts_subsec rename: range stays within 0..32767 and legacy tag alias is kept', () => {
  const out = decodeFixture('p54k20');
  const rec = out.records[0];
  assert.ok(rec.ts_subsec >= 0 && rec.ts_subsec <= 32767);
  assert.equal(rec.tag, rec.ts_subsec);
  assert.equal(out.decoder_version, PUFFIN54_DECODER_VERSION);
});

test('malformed kind-2 payload with oversized SoC never fabricates a percent', () => {
  const r = decodeKind2StateOfCharge([1, 0xEA, 0x03, 0x00]); // 1002
  assert.equal(r.fields.pack_soc_deci_percent, undefined);
  assert.equal(r.fields.pack_soc_percent, undefined);
  assert.ok(r.warnings.length >= 1);
});
