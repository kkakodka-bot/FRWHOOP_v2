// CLI integration: `bin/redecode.mjs` replays a Level A file end-to-end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harvardRT, notifyOf } from '../fixtures/whoopFrames.mjs';

const root = path.dirname(fileURLToPath(import.meta.url)); // tests/redecode
const bin = path.resolve(root, '../../bin/redecode.mjs');

test('redecode CLI reassembles splits, decodes, writes Level B, and accounts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'frwhoop-redecode-cli-'));
  const f = harvardRT(1, 1700000000, 500, 72, 2);
  const half = Math.floor(f.length / 2);
  const n1 = notifyOf(f.slice(0, half), { seq: 1 });
  const n2 = notifyOf(f.slice(half), { seq: 2 });
  const levelA = path.join(dir, 'levelA.ndjson');
  writeFileSync(levelA, [n1, n2].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const levelB = path.join(dir, 'levelB.ndjson');

  const out = execFileSync('node', [bin, levelA, '--summary', '--out', levelB], { encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert.equal(parsed.notifications_received, 2);
  assert.equal(parsed.reassembled_frames, 1);
  assert.equal(parsed.decoded_frames, 1);
  assert.equal(parsed.dropped_records, 0);
  assert.equal(parsed.levelB_records, 1);

  const lines = readFileSync(levelB, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.kind, 'frame');
  assert.equal(rec.packet_type, 40);
  assert.equal(rec.crc_ok, true);
  assert.ok(rec.frame_hash && rec.frame_hash.length === 64);
});
