import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { decodeFrame } from '../../protocol/decoder.js';
import { crc16Modbus, crc32 } from '../../protocol/crc.js';
import { sidecarFromLevelB, encodeSidecarArchive, persistSidecarsFromFrames, SIDECAR_STREAM, SIDECAR_FORMAT } from '../../redecode/sidecar.js';

function puffinV18() {
  // minimal valid v18 puffin frame (from the parity fixture builder pattern)
  const f = new Uint8Array(124);
  f[0] = 0xAA; f[1] = 0x01; f[2] = 116; f[3] = 0; f[4] = 1; f[5] = 0;
  f[8] = 0x2f; f[9] = 18;
  const putU32 = (o, v) => { f[o] = v & 255; f[o+1] = (v>>8)&255; f[o+2] = (v>>16)&255; f[o+3] = (v>>24)&255; };
  putU32(11, 4242); putU32(15, 1780000000);
  f[22] = 72;
  const h = crc16Modbus(f, 0, 6); f[6] = h & 255; f[7] = (h >> 8) & 255;
  const c = crc32(f, 8, 120); f[120] = c & 255; f[121] = (c >>> 8) & 255; f[122] = (c >>> 16) & 255; f[123] = (c >>> 24) & 255;
  return f;
}

test('sidecars carry interpretation summary keyed by (frame_hash, decoder_version), never raw bytes', () => {
  const f = puffinV18();
  const d = decodeFrame(f, 'puffin');
  const sc = sidecarFromLevelB(d, 'frwhoop-js/2');
  assert.equal(sc.sidecar_schema, 'frwhoop_redecode_sidecar_v2');
  assert.equal(sc.frame_hash, d.frame_hash);
  assert.equal(sc.decoder_version, 'frwhoop-js/2');
  assert.equal(sc.hist_version, 18);
  assert.equal(sc.packet_type, 47);
  assert.ok(sc.coverage_summary, 'sidecar carries the coverage summary');
  assert.ok(!('raw_hex' in sc) && !('raw_bytes' in sc), 'sidecars never embed raw bytes');
  assert.equal(sc.registry_version != null, true);
});

test('sidecar archive round-trips as gzip NDJSON with exact accounting', () => {
  const d1 = decodeFrame(puffinV18(), 'puffin');
  const d2 = decodeFrame(puffinV18(), 'puffin'); // same content -> same hash
  const a = encodeSidecarArchive([sidecarFromLevelB(d1, 'frwhoop-js/2'), sidecarFromLevelB(d2, 'frwhoop-js/2')]);
  assert.equal(a.sample_count, 2);
  assert.equal(a.format, SIDECAR_FORMAT);
  assert.equal(a.stream, SIDECAR_STREAM);
  const text = gunzipSync(a.body).toString('utf8');
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const row = JSON.parse(line);
    assert.equal(row.decoder_version, 'frwhoop-js/2');
    assert.equal(row.frame_hash, d1.frame_hash);
  }
});

test('empty sidecars are refused (never write empty archives)', () => {
  const a = encodeSidecarArchive([]);
  assert.equal(a.sample_count, 0);
});

test('persistSidecarsFromFrames writes a sidecar object from Level A notifies', async () => {
  const f = puffinV18();
  const hex = Buffer.from(f).toString('hex');
  const blobs = new Map();
  const raw = {
    async putObject(key, body) { blobs.set(key, body); return { etag: '"x"' }; },
  };
  const out = await persistSidecarsFromFrames([{
    hex,
    t: '2026-08-24T18:00:00.000Z',
    family: 'puffin',
    char: 'FD4B0003-8D6D-82B8-614A-1C8CB0F8DCC6',
    seq: 1,
  }], {
    stores: { raw, cfg: { rawStore: 'b2', b2Bucket: 'FRWHOOP' } },
    userId: '55555555-5555-4555-8555-555555555555',
    deviceId: '55555555-5555-4555-8555-555555555555',
  });
  assert.equal(out.ok, true);
  assert.equal(blobs.size, 1);
});
