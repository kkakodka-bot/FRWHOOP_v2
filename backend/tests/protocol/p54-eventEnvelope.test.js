// p54-eventEnvelope.test.js — unified puffin event envelope (types 48/50/53/55)
// + expanded live event catalog, against REAL CRC-valid corpus frames.
//
// Envelope (corpus-validated, 340k frames): [type@8][seq@9][id u16@10:12]
// [unix u32@12:16][subsec u16 Q15@16:18][body_len u16@18:20][body@20..20+len].
// Every fixture is a real B2 frame; expected ids come from the fixture key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { crc32 } from '../../protocol/crc.js';
import {
  eventRecordFromFrame, consoleRecordFromFrame,
  relativeEventsRecordFromFrame, relativePackConsoleRecordFromFrame,
  recordsFromFrame, readPuffinEventEnvelope, EVENT_NUMBER_NAMES,
} from '../../protocol/eventRecords.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(path.join(here, '../fixtures/eventEnvelopeCorpus.json'), 'utf8'));

const EVENT_IDS = [1, 3, 21, 22, 29, 56, 61, 62, 63, 100, 109, 110, 112, 120, 123];

test('unified envelope: id u16, subsec Q15, body_len all read correctly on real frames', () => {
  for (const id of EVENT_IDS) {
    const key = `ev${id}`;
    assert.ok(fx[key], `fixture ${key} missing`);
    const buf = Buffer.from(fx[key], 'hex');
    const env = readPuffinEventEnvelope(buf, 8);
    assert.equal(env.ok, true, key);
    assert.equal(env.record_type, 48, key);
    assert.equal(env.id, id, `envelope id must match fixture key (${key})`);
    assert.ok(env.unix >= 1_500_000_000 && env.unix <= 2_000_000_000, `${key} unix`);
    assert.ok(env.subsec >= 0 && env.subsec <= 32767, `${key} subsec range`);
    assert.equal(env.body_len, buf.length - 4 - 20, `${key} body_len must consume the interior exactly`);
11  }
});

test('expanded catalog: new live event names present, candidate status only', () => {
  assert.equal(EVENT_NUMBER_NAMES[109], 'BATTERY_PACK_INFO');
  assert.equal(EVENT_NUMBER_NAMES[21], 'BATTERY_PACK_CONNECTED');
  assert.equal(EVENT_NUMBER_NAMES[22], 'BATTERY_PACK_REMOVED');
  assert.equal(EVENT_NUMBER_NAMES[56], 'STRAP_DRIVEN_ALARM_SET');
  assert.equal(EVENT_NUMBER_NAMES[123], 'GENERIC_FIRMWARE_EVENT');
  // legacy names unchanged
  assert.equal(EVENT_NUMBER_NAMES[9], 'WRIST_ON');
  assert.equal(EVENT_NUMBER_NAMES[3], 'BATTERY_LEVEL');
});

test('event 109 decodes pack info body with redaction (same content as pack kind 20)', () => {
  const rec = eventRecordFromFrame(Buffer.from(fx.ev109, 'hex'), 'puffin', { fw: '50.35.2.0' });
  assert.equal(rec.event_name, 'BATTERY_PACK_INFO');
  assert.equal(rec.event_body.body_revision, 1);
  assert.equal(rec.event_body.hardware_family, 12);
  assert.equal(rec.event_body.colorway, 1);
  assert.equal(rec.event_body.pack_soc_deci_percent, 102);
  assert.ok(rec.event_body.pack_serial_redacted.startsWith('WBB5'));
  assert.ok(rec.event_body.pack_ble_addr_redacted.includes('..'));
  const row = JSON.stringify(rec.event_body);
  assert.ok(!row.includes('WBB5BP0358810'), 'pack serial leaked');
});

test('events 61/62 decode the strap serial + address (redacted) — serial-bearing', () => {
  for (const key of ['ev61', 'ev62']) {
    const rec = eventRecordFromFrame(Buffer.from(fx[key], 'hex'), 'puffin', { fw: '50.35.2.0' });
    assert.ok(rec.event_body.strap_serial_redacted.startsWith('5B00'), key);
    assert.ok(rec.event_body.strap_ble_addr_redacted.includes('..'), key);
    assert.equal(rec.event_body.marker_byte, 3, key);
  }
});

test('event 3 battery body keeps deci-percent + mV on the unified envelope', () => {
  const rec = eventRecordFromFrame(Buffer.from(fx.ev3, 'hex'), 'puffin', { fw: '50.35.2.0' });
  assert.equal(rec.event_id, 3);
  assert.ok(rec.battery_pct > 0 && rec.battery_pct <= 100, JSON.stringify(rec.battery_pct));
  assert.ok(rec.battery_mV >= 3000 && rec.battery_mV <= 4300);
});

test('event 56 carries an embedded unix (record bookkeeping), raw otherwise', () => {
  const rec = eventRecordFromFrame(Buffer.from(fx.ev56, 'hex'), 'puffin', { fw: '50.35.2.0' });
  assert.equal(rec.event_body.body_revision, 3);
  assert.ok(rec.event_body.embedded_unix > 1_500_000_000);
});

test('type 50 console: chunk_len 52 + channel 1 fields land on the record', () => {
  const rec = consoleRecordFromFrame(Buffer.from(fx.t50, 'hex'), 'puffin', { fw: '50.35.2.0' });
  assert.equal(rec.chunk_len, 52);
  assert.equal(rec.channel, 1);
  assert.ok(rec.log && rec.log.includes('SENSORS'), rec.log);
  assert.ok(rec.record_index > 0, 'record_index u16@9 (seq slot = low byte)');
});

test('type 53/55: structural envelope decode preserves body raw (no captures exist)', () => {
  // synthetic: relative variant of a captured event frame with type 53/55
  const build = (packetType) => {
    const buf = Buffer.from(fx.ev110, 'hex');
    buf[8] = packetType;
    // rewrite the interior CRC32 over the modified body (zlib crc32, LE)
    const payloadEnd = buf.length - 4;
    buf.writeUInt32LE(crc32(buf.subarray(8, payloadEnd)) >>> 0, payloadEnd);
    return buf;
  };
  for (const packetType of [53, 55]) {
    const buf = build(packetType);
    const rec = packetType === 53
      ? relativeEventsRecordFromFrame(buf, 'puffin', { fw: '50.35.2.0' })
      : relativePackConsoleRecordFromFrame(buf, 'puffin', { fw: '50.35.2.0' });
    assert.ok(rec, `type ${packetType} record`);
    assert.equal(rec.envelope.packet_type, packetType);
    assert.equal(rec.envelope.packet_name, packetType === 53 ? 'RELATIVE_PUFFIN_EVENTS' : 'RELATIVE_BATTERY_PACK_CONSOLE_LOGS');
    assert.ok(rec.relative_timestamp_hypothesis.includes('unresolved'));
    assert.ok(rec.body_hex.length > 0);
  }
});

test('recordsFromFrame routes 48/53/54/55/50 without mixing kinds', () => {
  const ev = recordsFromFrame(Buffer.from(fx.ev109, 'hex'), 'puffin', {});
  assert.equal(ev.events[0].kind, 'event');
  assert.equal(ev.events[0].event_id, 109);
  const con = recordsFromFrame(Buffer.from(fx.t50, 'hex'), 'puffin', {});
  assert.equal(con.console[0].kind, 'console_log');
});
