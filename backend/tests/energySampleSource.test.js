import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  mergeSamples,
  overlayLiveUserIds,
  preferRealStrap,
  REAL_DAY_FILE_BYTES,
} from '../energy/sampleSource.js';

const JWT = '9f33375b-e029-480f-9ebb-a99e5ff22ac9';
const LOCAL = '7f2c9a10-4b3e-4d8a-9c11-00000000f001';

test('e2e-strap rows drop once a real WHOOP device is in the mix', () => {
  const merged = preferRealStrap([
    { datetime: '2026-08-25T12:00:00Z', bpm: 150, deviceId: 'e2e-strap', seq: 1 },
    { datetime: '2026-08-25T12:00:00Z', bpm: 72, deviceId: 'BAB4F5E9-E3C6-AF66-3C03-020A8621AD7B', seq: 2 },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].bpm, 72);
});

test('identical samples from two identity folders collapse to one', () => {
  const a = { datetime: '2026-08-25T12:00:00Z', bpm: 70, deviceId: 'strap', seq: 9 };
  const out = mergeSamples([a], [{ ...a }]);
  assert.equal(out.length, 1);
});

test('overlay includes the JWT folder when only the device-token user is asked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'energy-src-'));
  try {
    fs.mkdirSync(path.join(dir, JWT));
    fs.mkdirSync(path.join(dir, LOCAL));
    fs.writeFileSync(path.join(dir, JWT, '2026-08-25.ndjson'), 'x'.repeat(REAL_DAY_FILE_BYTES + 10));
    fs.writeFileSync(path.join(dir, LOCAL, '2026-08-25.ndjson'), 'tiny');
    const ids = overlayLiveUserIds({
      userId: LOCAL,
      localUserId: LOCAL,
      liveDir: dir,
      days: ['2026-08-25'],
    });
    assert.ok(ids.includes(LOCAL));
    assert.ok(ids.includes(JWT), 'the larger strap recording is merged onto the device-token user');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
