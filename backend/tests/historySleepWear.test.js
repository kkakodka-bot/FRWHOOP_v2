// Mission target 2: sleep/wear/skin-contact fields survive the history row
// normalizer end to end (iOS HistoricalSample -> historyBuffer -> archive row).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeHistoricalSample } from '../ingest/historyBuffer.js';
import { normalizeSample } from '../ingest/archiveFormat.js';

const base = {
  t: '2026-08-30T10:00:00.000Z',
  seq: 1,
  bpm: 62,
  layout: 'v18',
  family: 'puffin',
};

test('v18 sleep/wear byte fields pass through the history row normalizer', () => {
  const row = normalizeHistoricalSample({
    t: '2026-08-30T10:00:00.000Z',
    seq: 1,
    bpm: 62,
    band_sleep_state: 2,
    on_wrist: 1,
    wake_quality: 2,
    skin_contact: 1,
    skin_temp_c: 33.4,
  });
  assert.ok(row, 'row accepted');
  assert.equal(row.band_sleep_state, 2);
  assert.equal(row.on_wrist, 1);
  assert.equal(row.wake_quality, 2);
  assert.equal(row.skin_contact, 1);
  assert.equal(row.skin_temp_c, 33.4);
});

test('legacy camelCase keys and 5/MG onwrist alias still map', () => {
  const row = normalizeHistoricalSample({
    t: '2026-08-30T10:00:01.000Z',
    seq: 2,
    bandSleepState: 1,
    onWrist: 0,
    wakeQuality: 3,
    onwrist: 0,
  });
  assert.ok(row);
  assert.equal(row.band_sleep_state, 1);
  assert.equal(row.on_wrist, 0);
  assert.equal(row.wake_quality, 3);
});

test('absent wear fields stay null (never fabricated)', () => {
  const row = normalizeHistoricalSample({
    t: '2026-08-30T10:00:02.000Z',
    seq: 3,
    bpm: 61,
  });
  assert.ok(row);
  assert.equal(row.band_sleep_state, null);
  assert.equal(row.on_wrist, null);
  assert.equal(row.wake_quality, null);
  assert.equal(row.skin_contact, null);
});

test('harvard v24 skin_contact value reaches the normalized archive row', () => {
  const row = normalizeHistoricalSample({
    t: '2026-08-30T10:00:03.000Z',
    seq: 4,
    family: 'harvard',
    layout: 'v24',
    skin_contact: 0,
  });
  assert.ok(row);
  assert.equal(row.skin_contact, 0);
});
