// Lossless invariant: a payload larger than the nominal frame cap is preserved
// in full by the Level A normalizer. Unknown and oversized bytes must never be
// sliced away from the re-decode source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFrame } from '../ingest/archiveFormat.js';

test('normalizeFrame preserves >8192-byte payloads in full', () => {
  const big = Buffer.alloc(20000, 0xAB);
  const hex = big.toString('hex');
  const row = normalizeFrame({ hex, t: '2026-08-25T02:00:00Z', kind: 'notify', char: '6108', family: 'harvard', n: 20000 });
  assert.ok(row, 'row must be produced');
  assert.equal(row.hex.length, hex.length, 'hex must not be truncated');
  assert.equal(row.hex, hex, 'bytes must be byte-identical');
  assert.equal(row.n, 20000);
  assert.equal(row.truncated, undefined, 'no artificial truncation flag for full data');
});

test('normalizeFrame rejects a payload with no valid hex at all', () => {
  // 'zzqq!!' contains no hex digits -> empty after strip -> rejected, not mangled.
  const row = normalizeFrame({ hex: 'zzqq!!', t: '2026-08-25T02:00:00Z' });
  assert.equal(row, null);
});
