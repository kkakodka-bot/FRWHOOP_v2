// Scenario builders for the push wire conformance suite (PUSH_PROTOCOL.md v1.1/v1.2).
// Payloads are byte-fixed so every receiver sees identical input. Ported from the Node
// pushIngest.test.js fixtures; do not vary these between Node and Edge runs.
import { gzipSync } from 'node:zlib';

export const USER = '7f2c9a10-4b3e-4d8a-9c11-00000000f001';
export const BATCH = 'e835f32f-60e7-4c93-90a0-51eb6830119a';
export const SOURCE = '3a3486dd-5030-4e17-a00d-a781399890f9';
export const DEVICE = 'strap-local-id';

const TS_MIN = 1723939201;
const TS_MAX = 1723939205;

export function encodeBatch(header, recordLines) {
  const lines = [JSON.stringify(header), ...recordLines.map((row) => JSON.stringify(row))];
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

export function hrBatch(overrides = {}) {
  const header = {
    type: 'batch',
    protocolVersion: '1.0',
    batchId: BATCH,
    sourceId: SOURCE,
    deviceId: DEVICE,
    stream: 'hrSample',
    delivery: 'append',
    recordCount: 2,
    startCursor: null,
    endCursor: { rowId: 19, keySha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    ...overrides,
  };
  return encodeBatch(header, [
    { type: 'record', key: { ts: TS_MIN }, data: { bpm: 61 } },
    { type: 'record', key: { ts: TS_MAX }, data: { bpm: 62 } },
  ]);
}

export function gzipBatch(batch) {
  return gzipSync(batch);
}
