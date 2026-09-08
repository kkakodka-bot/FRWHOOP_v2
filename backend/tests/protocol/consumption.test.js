import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROTOCOL_CONSUMPTION,
  DISPOSITIONS,
  CONFIDENCE,
  highConfidenceFields,
  missingDisposition,
  implicitHighFields,
  foldBatteryTimeline,
  CONSUMPTION_REGISTRY_VERSION,
} from '../../protocol/consumption.js';

test('consumption registry version is pinned', () => {
  assert.equal(CONSUMPTION_REGISTRY_VERSION, 'frwhoop-consumption/1');
});

test('every HIGH-confidence field has an explicit disposition', () => {
  assert.equal(implicitHighFields().length, 0);
  const missing = missingDisposition();
  assert.deepEqual(missing.map((r) => r.id), []);
  for (const row of highConfidenceFields()) {
    assert.ok(DISPOSITIONS.includes(row.disposition), row.id);
    assert.notEqual(row.disposition, undefined, row.id);
  }
});

test('no HIGH row is an implicit leftover of decoder-only work', () => {
  for (const row of PROTOCOL_CONSUMPTION) {
    if (row.confidence !== CONFIDENCE.HIGH) continue;
    assert.ok(row.backend || row.ios || row.queue, row.id);
  }
});

test('foldBatteryTimeline keeps event-3 counter and does not invent health', () => {
  const timeline = foldBatteryTimeline([
    {
      event_id: 3,
      event_name: 'BATTERY_LEVEL',
      event_ts: '2026-09-01T12:00:00Z',
      battery_pct: 78,
      battery_mV: 3900,
      battery_counter: 9,
      battery_charging: 1,
      envelope: { frame_hash: 'abc' },
    },
    { event_id: 29, event_name: 'STRAP_CONDITION_REPORT', battery_pct: null },
  ], [{ battery_pct: 80, received_at: '2026-09-01T12:01:00Z' }]);
  assert.equal(timeline.length, 2);
  assert.equal(timeline[0].source, 'event_3');
  assert.equal(timeline[0].counter, 9);
  assert.equal(timeline[0].pct, 78);
  assert.equal(timeline[1].source, 'cmd_26');
  assert.equal(timeline[1].pct, 80);
});
