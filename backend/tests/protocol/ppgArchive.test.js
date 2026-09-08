import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  ppgRecordFromFrame, encodePpgArchive, decodePpgArchive, dedupePpgRecords,
  PPG_ARCHIVE_SCHEMA, PPG_ARCHIVE_STREAM,
} from '../../protocol/ppgArchive.js';
import { deriveRecords } from '../../redecode/derive.js';
import { decodeFrame } from '../../protocol/decoder.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(fs.readFileSync(path.join(here, '../fixtures/noop-whoop5-parity.json'), 'utf8'));

test('v26 PIP frame derives a canonical PPG record; reconstruction is the waveform', () => {
  const frame = Buffer.from(fx.v26_real.hex, 'hex');
  const rec = ppgRecordFromFrame(frame, 'puffin', {
    fw: '50.35.5', char: 'FD4B0003', seq: 9, receivedAt: '2026-08-30T10:00:00Z',
  });
  assert.ok(rec);
  assert.equal(rec.schema, PPG_ARCHIVE_SCHEMA);
  assert.equal(rec.kind, 'hist_v26');
  assert.equal(rec.layout, 'v26');
  assert.equal(rec.canonical_stage_input, true);
  assert.equal(rec.samples.length, 25);
  assert.equal(rec.trusted_sample_count, rec.trusted_samples.length);
  assert.equal(rec.sample_rate_hz, 25);
  const deep = decodeFrame(frame, 'puffin');
  assert.deepEqual(rec.samples, deep.decoded.parsed.ppg_waveform);
  assert.equal(rec.envelope.frame_hash, deep.frame_hash);
});

test('v21 IMU is not a PPG record; v20 optical is not a canonical PPG input', () => {
  const v21 = Buffer.from(fx.v21_real.hex, 'hex');
  assert.equal(ppgRecordFromFrame(v21, 'puffin', {}), null);
  const ev = Buffer.from(fx.regression_corpus.type48.hex, 'hex');
  assert.equal(ppgRecordFromFrame(ev, 'harvard', {}), null);
});

test('ppg archive round-trips gzip NDJSON and dedupes by derived id', () => {
  const frame = Buffer.from(fx.v26_real.hex, 'hex');
  const rec = ppgRecordFromFrame(frame, 'puffin', { receivedAt: '2026-08-30T10:00:00Z' });
  const encoded = encodePpgArchive([rec, rec]);
  assert.equal(encoded.stream, PPG_ARCHIVE_STREAM);
  const decoded = decodePpgArchive(encoded.body);
  assert.equal(decoded.length, 1);
  assert.deepEqual(decoded[0].samples, rec.samples);
  assert.equal(dedupePpgRecords([rec, { ...rec }]).length, 1);
});

test('deriveRecords extracts PPG from v26 and IMU from v21 on the same path', () => {
  const v26 = Buffer.from(fx.v26_real.hex, 'hex');
  const v21 = Buffer.from(fx.v21_real.hex, 'hex');
  const out = deriveRecords([
    { hex: v26.toString('hex'), family: 'puffin', char: 'FD4B0003', t: '2026-08-30T10:00:00Z', seq: 1 },
    { hex: v21.slice(0, 500).toString('hex'), family: 'puffin', char: 'FD4B0003', t: '2026-08-30T10:00:01Z', seq: 2 },
    { hex: v21.slice(500).toString('hex'), family: 'puffin', char: 'FD4B0003', t: '2026-08-30T10:00:01.01Z', seq: 3 },
  ]);
  assert.equal(out.ppg.length, 1);
  assert.equal(out.ppg[0].kind, 'hist_v26');
  assert.equal(out.session.ppg_records, 1);
  assert.equal(out.imu.length, 1);
  assert.equal(out.imu[0].kind, 'hist_v21');
});
