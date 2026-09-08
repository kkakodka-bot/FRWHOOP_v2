// PUFFIN_EVENTS_FROM_STRAP (packet 54) — real B2 goldens + reject / replay cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { decodePuffinEvents54, readPuffin54Structure, PUFFIN54_DECODER_VERSION } from '../../protocol/whoop5.js';
import { decodeFrame } from '../../protocol/decoder.js';
import { puffin54RecordsFromFrame, isLiveWhoopEvent, isHistoricalPuffin54 } from '../../protocol/eventRecords.js';
import { deriveRecords } from '../../redecode/derive.js';
import { replayNotifies } from '../../redecode/redecode.js';
import { deriveHistoricalFromObjects, puffin54PersistOk } from '../../redecode/historicalDerived.js';
import { createHourBuffer } from '../../ingest/hourBuffer.js';
import { crc16Modbus, crc32 } from '../../protocol/crc.js';
import { hasExplicitNonwearEvidence, nonwearWindowsFromSamples } from '../../metrics/dayCompleteness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(path.join(here, '../fixtures/puffinEvents54.json'), 'utf8'));

function makePuffin54({
  kind, storedUnix, tag, payload, trailing = [], seq = 1, corruptCrc = false, declaredDelta = 0,
}) {
  const rec = Buffer.alloc(10 + payload.length);
  rec.writeUInt16LE(kind, 0);
  rec.writeUInt32LE(storedUnix >>> 0, 2);
  rec.writeUInt16LE(tag, 6);
  rec.writeUInt16LE(payload.length, 8);
  Buffer.from(payload).copy(rec, 10);
  const inner = Buffer.concat([Buffer.from([54, seq]), rec, Buffer.from(trailing)]);
  const declared = inner.length + 4 + declaredDelta;
  const frame = Buffer.alloc(8 + inner.length + 4);
  frame[0] = 0xaa;
  frame[1] = 0x01;
  frame.writeUInt16LE(declared, 2);
  frame[4] = 0x01;
  frame[5] = 0x00;
  frame.writeUInt16LE(crc16Modbus(frame.subarray(0, 6)), 6);
  inner.copy(frame, 8);
  const payloadEnd = frame.length - 4;
  let c = crc32(frame.subarray(8, payloadEnd));
  if (corruptCrc) c ^= 0xffffffff;
  frame.writeUInt32LE(c >>> 0, payloadEnd);
  return frame;
}

test('all four real 54 frames decode through the CRC-gated path with expected records', () => {
  for (const f of fx.frames) {
    const buf = Buffer.from(f.hex, 'hex');
    const independent = readPuffin54Structure(buf);
    assert.equal(independent.ok, true, f.name);
    assert.equal(independent.records[0].kind, f.expect.kind);
    assert.equal(independent.records[0].stored_unix, f.expect.stored_unix);
    assert.equal(independent.records[0].tag, f.expect.tag);
    assert.equal(independent.records[0].payload_len, f.expect.payload_len);

    const d = decodeFrame(buf, 'puffin');
    assert.equal(d.decode_status, 'decoded', f.name);
    assert.equal(d.decoded?.puffin_events_from_strap, true);
    const recs = d.decoded.parsed.records;
    assert.equal(recs.length, f.expect.record_count);
    assert.equal(recs[0].kind, f.expect.kind);
    assert.equal(recs[0].stored_unix, f.expect.stored_unix);
    assert.equal(recs[0].tag, f.expect.tag);
    assert.equal(recs[0].payload_len, f.expect.payload_len);
    assert.equal(d.decoded.timestamp, f.expect.stored_unix, 'timestamp is stored_unix not envelope u32@10');
    assert.equal(recs[0].decoder_version, PUFFIN54_DECODER_VERSION);
    assert.ok(recs[0].semantic_status === 'structurally_verified' || recs[0].semantic_status === 'candidate_semantic');
    assert.notEqual(recs[0].semantic_status, 'hardware_verified');
    assert.ok(!String(recs[0].candidate_name || '').includes('SERIAL_HEAD') || recs[0].semantic_status === 'candidate_semantic');
    assert.ok(String(d.decoded?.lineage || '').includes('noop@'));
  }
});

test('kind-20 payload surfaces the strap serial as instrumentation only', () => {
  const f = fx.frames.find((x) => x.expect.kind === 20);
  const rec = decodePuffinEvents54(Buffer.from(f.hex, 'hex')).records[0];
  assert.ok(rec.serial_ascii && rec.serial_ascii.startsWith('WBB5'), rec.serial_ascii);
  assert.equal(rec.payload_hex.length, 64);
  assert.equal(rec.candidate_name, 'PACK_HARDWARE_INFO'); // p54/2: pack hardware info, not serial-head removal
  assert.equal(rec.semantic_status, 'candidate_semantic');
});

test('unknown/short payload stays raw and unmapped (graceful fallback)', () => {
  const deep = decodePuffinEvents54([0xAA, 1, 0, 0, 0, 0, 0, 0, 54, 1, 2]);
  assert.equal(deep.unmapped, true);
  assert.equal(deep.reject_reason, 'truncated');
});

test('54 records join the derived events stream with kind=puffin_event_54', () => {
  const f = fx.frames.find((x) => x.expect.kind === 20);
  const buf = Buffer.from(f.hex, 'hex');
  const recs = puffin54RecordsFromFrame(buf, 'puffin', { fw: '50.35.2.0', crcOk: true, char: 'FD4B0005' });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, 'puffin_event_54');
  assert.equal(recs[0].event_id, 20);
  assert.equal(recs[0].event_name, 'PUFFIN_EVENT_20');
  assert.equal(recs[0].stored_unix, f.expect.stored_unix);
  assert.equal(recs[0].tag, f.expect.tag);
  assert.ok(recs[0].payload_hex.length > 0);
  assert.equal(recs[0].historical, true);
  assert.equal(recs[0].live_side_effects, false);
  assert.equal(recs[0].firmware.fw, '50.35.2.0');
  assert.equal(recs[0].transport.char, 'FD4B0005');
  assert.equal(recs[0].decoder.version, PUFFIN54_DECODER_VERSION);
  assert.equal(recs[0].envelope.frame_hash.length, 64);
  assert.equal(recs[0].provenance.packet_type, 54);
  assert.equal(recs[0].provenance.decoder_version, PUFFIN54_DECODER_VERSION);
  assert.equal(recs[0].provenance.characteristic, 'FD4B0005');
  assert.equal(recs[0].provenance.live_side_effects, false);
  assert.ok(puffin54PersistOk(recs[0]));
  assert.equal(isHistoricalPuffin54(recs[0]), true);
  assert.equal(isLiveWhoopEvent(recs[0]), false);
  assert.ok(!recs[0].event_name.includes('SERIAL_HEAD'));
  const out = deriveRecords([{ hex: f.hex, char: 'FD4B0005-CCE1-4033-93CE-002D5875F58A', family: 'puffin', fw: '50.35.2.0', t: f.received_at, seq: 1 }]);
  assert.equal(out.events.length, 1);
  assert.equal(out.session.event_names.PUFFIN_EVENT_20, 1);
  assert.equal(out.session.puffin54_records, 1);
  assert.equal(out.session.puffin54_kinds[20], 1);
  assert.equal(out.session.puffin54_unique_hashes, 1);
  assert.equal(out.events[0].stored_unix, f.expect.stored_unix);
  assert.equal(out.events[0].provenance.historical, true);
  assert.ok(out.events[0].decoder.lineage);
});

test('non-54 frames yield no puffin54 records', () => {
  assert.equal(puffin54RecordsFromFrame([1, 2, 3], 'puffin', {}).length, 0);
});

test('unknown kind remains a valid decoded record and keeps payload', () => {
  const payload = [0xde, 0xad, 0xbe, 0xef];
  const frame = makePuffin54({ kind: 99, storedUnix: 1_780_000_000, tag: 1, payload });
  const deep = decodePuffinEvents54(frame);
  assert.equal(deep.unmapped, false);
  assert.equal(deep.records.length, 1);
  assert.equal(deep.records[0].kind, 99);
  assert.equal(deep.records[0].payload_hex, 'deadbeef');
  assert.equal(deep.records[0].candidate_name, null);
  assert.equal(deep.records[0].semantic_status, 'structurally_verified');
  const durable = puffin54RecordsFromFrame(frame, 'puffin', { fw: '50.35.2.0', char: 'FD4B0005' });
  assert.equal(durable[0].event_name, 'PUFFIN_EVENT_99');
  assert.equal(durable[0].payload_hex, 'deadbeef');
  assert.equal(durable[0].semantic_status, 'structurally_verified');
  assert.ok(puffin54PersistOk(durable[0]));
});

test('CRC corruption is rejected', () => {
  const f = fx.frames[0];
  const buf = Buffer.from(f.hex, 'hex');
  const flipped = Buffer.from(buf);
  flipped[flipped.length - 1] ^= 0xff;
  const gated = decodeFrame(flipped, 'puffin');
  assert.equal(gated.decode_status, 'crc_failed');
  const deep = decodePuffinEvents54(flipped);
  assert.equal(deep.unmapped, true);
  assert.equal(deep.reject_reason, 'crc');
  assert.equal(puffin54RecordsFromFrame(flipped, 'puffin', { crcOk: false }).length, 0);
});

test('truncation is rejected', () => {
  const buf = Buffer.from(fx.frames[0].hex, 'hex').subarray(0, 16);
  const deep = decodePuffinEvents54(buf);
  assert.equal(deep.unmapped, true);
  assert.equal(deep.reject_reason, 'truncated');
});

test('bad payload length is rejected', () => {
  const rec = Buffer.alloc(14);
  rec.writeUInt16LE(2, 0);
  rec.writeUInt32LE(1_780_000_000, 2);
  rec.writeUInt16LE(1, 6);
  rec.writeUInt16LE(40, 8);
  rec[10] = 1; rec[11] = 2; rec[12] = 3; rec[13] = 4;
  const inner = Buffer.concat([Buffer.from([54, 1]), rec]);
  const declared = inner.length + 4;
  const frame = Buffer.alloc(8 + inner.length + 4);
  frame[0] = 0xaa; frame[1] = 0x01;
  frame.writeUInt16LE(declared, 2);
  frame[4] = 0x01; frame[5] = 0x00;
  frame.writeUInt16LE(crc16Modbus(frame.subarray(0, 6)), 6);
  inner.copy(frame, 8);
  const payloadEnd = frame.length - 4;
  frame.writeUInt32LE(crc32(frame.subarray(8, payloadEnd)) >>> 0, payloadEnd);
  const deep = decodePuffinEvents54(frame);
  assert.equal(deep.unmapped, true);
  assert.equal(deep.reject_reason, 'truncated');
});

test('nonzero trailing bytes are rejected', () => {
  const frame = makePuffin54({
    kind: 2, storedUnix: 1_780_000_000, tag: 3, payload: [1, 0, 0, 0], trailing: [0x11, 0x22],
  });
  const deep = decodePuffinEvents54(frame);
  assert.equal(deep.unmapped, true);
  assert.equal(deep.reject_reason, 'length');
});

test('zero padding leftover is rejected as padding', () => {
  const frame = makePuffin54({
    kind: 2, storedUnix: 1_780_000_000, tag: 3, payload: [1, 0, 0, 0], trailing: [0, 0, 0, 0],
  });
  const deep = decodePuffinEvents54(frame);
  assert.equal(deep.unmapped, true);
  assert.equal(deep.reject_reason, 'padding');
});

test('replayed duplicate frames emit one durable event', () => {
  const f = fx.frames[0];
  const row = { hex: f.hex, char: 'FD4B0005', family: 'puffin', fw: '50.35.2.0', t: f.received_at, seq: 1 };
  const once = deriveRecords([row]);
  const twice = deriveRecords([row, { ...row, seq: 2 }]);
  assert.equal(once.events.length, 1);
  assert.equal(twice.events.length, 1);
  assert.equal(twice.session.puffin54_duplicates, 1);
});

test('old stored timestamp still parses and is not a live side-effect record', () => {
  const f = fx.frames.find((x) => x.expect.kind === 9);
  const rec = decodePuffinEvents54(Buffer.from(f.hex, 'hex')).records[0];
  assert.equal(rec.stored_unix, f.expect.stored_unix);
  assert.ok(rec.stored_unix < Date.parse(f.received_at) / 1000);
  const derived = puffin54RecordsFromFrame(Buffer.from(f.hex, 'hex'), 'puffin', { fw: '50.35.2.0', char: 'FD4B0005' });
  assert.equal(derived[0].event_name, 'PUFFIN_EVENT_9');
  assert.equal(derived[0].semantic_status, 'candidate_semantic');
});

test('future / implausible timestamp still parses structurally', () => {
  const frame = makePuffin54({ kind: 2, storedUnix: 2_200_000_000, tag: 0, payload: [0, 0, 0, 0] });
  const rec = decodePuffinEvents54(frame).records[0];
  assert.equal(rec.stored_unix, 2_200_000_000);
  assert.equal(rec.semantic_status, 'candidate_semantic');
});

test('hourBuffer replay of the same type-54 hex does not duplicate derived events', async () => {
  const f = fx.frames[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-p54-'));
  const derivedCalls = [];
  const buf = createHourBuffer({
    dir,
    userId: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
    chunkMs: 3600_000,
    now: () => new Date('2026-08-30T17:59:50.100Z'),
    engine: {
      archiveRawSamples: async () => ({ status: 'ready' }),
      archiveRawFrames: async () => ({ id: 'frames-obj', status: 'ready' }),
      archiveDerivedStream: async (args) => {
        derivedCalls.push(args);
        return { id: 'derived-obj', status: 'ready' };
      },
    },
  });
  buf.appendFrame({ hex: f.hex, char: 'FD4B0005', family: 'puffin', fw: '50.35.2.0', t: '2026-08-26T01:59:10.452Z', seq: 11 });
  buf.appendFrame({ hex: f.hex, char: 'FD4B0005', family: 'puffin', fw: '50.35.2.0', t: '2026-08-26T01:59:10.500Z', seq: 12 });
  await buf.flush();
  const eventCalls = derivedCalls.filter((c) => c.stream === 'events');
  const p54 = eventCalls.flatMap((c) => c.records).filter((r) => r.kind === 'puffin_event_54');
  assert.equal(p54.length, 1);
  assert.equal(p54[0].stored_unix, fx.frames[0].expect.stored_unix);
  assert.equal(p54[0].historical, true);
  assert.equal(p54[0].live_side_effects, false);
  assert.ok(p54[0].provenance?.frame_hash);
  assert.equal(p54[0].provenance.decoder_version, PUFFIN54_DECODER_VERSION);
});

test('replayNotifies Level B decodes type 54 without mixing into type-48 events', () => {
  const f = fx.frames.find((x) => x.expect.kind === 2);
  const r = replayNotifies([{
    hex: f.hex, char: 'FD4B0005', family: 'puffin', fw: '50.35.2.0', t: f.received_at, seq: 1,
  }]);
  const rec = r.levelB.find((x) => x.packet_type === 54);
  assert.ok(rec);
  assert.equal(rec.decode_status, 'decoded');
  assert.equal(rec.decoded.puffin_events_from_strap, true);
  assert.equal(rec.decoded.parsed.records[0].kind, 2);
  assert.equal(rec.decoded.parsed.records[0].stored_unix, f.expect.stored_unix);
  assert.equal(rec.decoded.decoder_version, PUFFIN54_DECODER_VERSION);
});

test('historical B2 redecode persists type 54 with provenance and is idempotent across objects', () => {
  const f = fx.frames[0];
  const row = { hex: f.hex, char: 'FD4B0004', family: 'puffin', fw: '50.35.2.0', t: f.received_at, seq: 1 };
  const a = deriveHistoricalFromObjects([
    { key: 'users/u1/devices/d1/frames/1', user: 'u1', device: 'd1', rows: [row] },
  ]);
  assert.equal(a.puffin54.length, 1);
  assert.equal(a.census.puffin54_records, 1);
  assert.ok(puffin54PersistOk(a.puffin54[0]));
  assert.equal(a.puffin54[0].provenance.b2_key, 'users/u1/devices/d1/frames/1');
  assert.equal(a.puffin54[0].provenance.characteristic, 'FD4B0004');
  const b = deriveHistoricalFromObjects([
    { key: 'users/u1/devices/d1/frames/1', user: 'u1', device: 'd1', rows: [row] },
    { key: 'users/u1/devices/d1/frames/2', user: 'u1', device: 'd1', rows: [{ ...row, seq: 2 }] },
  ]);
  assert.equal(b.puffin54.length, 1);
  assert.equal(b.census.puffin54_duplicates, 1);
  assert.equal(b.census.puffin54_unique_hashes, 1);
});

test('packet 54 never counts as live wear evidence', () => {
  const f = fx.frames.find((x) => x.expect.kind === 9);
  const rec = puffin54RecordsFromFrame(Buffer.from(f.hex, 'hex'), 'puffin', { fw: '50.35.2.0', char: 'FD4B0005' })[0];
  assert.equal(rec.candidate_name, 'PACK_DOUBLE_TAP'); // p54/2 pack vocabulary (supersedes WRIST_ON)
  assert.equal(rec.event_name, 'PUFFIN_EVENT_9');
  assert.equal(hasExplicitNonwearEvidence(rec), false);
  const lo = rec.stored_unix * 1000;
  const windows = nonwearWindowsFromSamples([
    { ...rec, datetime: new Date(lo).toISOString() },
    { datetime: new Date(lo).toISOString(), kind: 'puffin_event_54', event_name: 'WRIST_OFF', historical: true, live_side_effects: false, envelope: { packet_type: 54 } },
  ], lo - 1000, lo + 3600000);
  assert.equal(windows.length, 0);
});
