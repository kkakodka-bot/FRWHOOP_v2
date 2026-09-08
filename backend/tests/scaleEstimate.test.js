import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Scale model for the redesigned ingest path.
 * HR ~1 sample / 4s → 21,600 samples/user/day.
 * Combined hourly physiology objects → 24 B2 objects/user/day (not 1,440 minute objects).
 * Opaque BLE notify archive (`frames`) → another 24 hourly objects/user/day.
 * Product charts use 1 daily_physiology_series row, not 288 physiology_buckets rows.
 * Frames are larger than physiology (hex payloads) but still one object per UTC hour.
 */

function perUserDay({ users = 1 } = {}) {
  const samples = 21600;
  const physiologyObjects = 24;
  const frameObjects = 24;
  const derivedObjects = 1;
  const seriesRows = 1;
  const dailyRows = 1;
  const manifestRows = physiologyObjects + frameObjects + derivedObjects;
  const physiologyBytes = 24 * 8_000;
  const frameBytes = 24 * 200_000;
  const rawBytes = physiologyBytes + frameBytes;
  return {
    users,
    samples: samples * users,
    b2_objects: (physiologyObjects + frameObjects + derivedObjects) * users,
    series_rows: seriesRows * users,
    supabase_rows: (dailyRows + seriesRows + manifestRows + 2) * users,
    snapshot_bytes: 8_000,
    range_14d_bytes: 4_000,
    queries_per_launch: 3,
    b2_gb_month: (rawBytes * 30 * users) / (1024 ** 3),
  };
}

test('redesign does not create hundreds of thousands of tiny objects per user year', () => {
  const one = perUserDay({ users: 1 });
  assert.equal(one.b2_objects, 49);
  assert.equal(one.series_rows, 1);
  assert.ok(one.b2_objects * 365 < 20_000);
  const hundred = perUserDay({ users: 100 });
  const thousand = perUserDay({ users: 1000 });
  assert.equal(hundred.b2_objects, 4900);
  assert.equal(thousand.b2_objects, 49000);
  assert.ok(thousand.b2_gb_month < 200);
  assert.ok(one.queries_per_launch <= 5);
});
