import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetricsEngine } from '../../metrics/engine.js';

const USER = '33333333-3333-4333-8333-333333333333';

function makeEngine() {
  const blobs = new Map();
  const dbRows = { daily_metrics: [], object_manifests: [], sessions: [], metric_runs: [], daily_physiology_series: [] };
  const stores = {
    raw: { async putObject(key, body) { blobs.set(key, body); return { etag: '"x"' }; } },
    derived: { async putObject(key, body) { blobs.set(key, body); return { etag: '"y"' }; } },
  };
  const db = {
    async upsertPayload(payload) {
      for (const k of ['daily_metrics', 'object_manifests', 'sessions', 'metric_runs', 'daily_physiology_series']) {
        if (payload[k]) dbRows[k].push(...payload[k]);
      }
      return { ok: true };
    },
  };
  const engine = createMetricsEngine({
    cfg: { localUserId: USER, rawStore: 'b2', derivedStore: 'b2', b2Bucket: 'FRWHOOP', buildHash: 'test' },
    stores,
    db,
  });
  return { engine, dbRows, blobs };
}

// Wake-day 2026-08-24: an overnight window (23:00 -> 06:00, like
// tests/engineCoreHealth.test.js) plus a 30-min exercise window at ~150 bpm.
// The engine derives the scored day from the wake date of the overnight window.
function exerciseSamples(base) {
  const nightStart = Date.UTC(2026, 7, 23, 23, 0, 0);
  const samples = [];
  for (let i = 0; i < 7 * 3600; i += 1) {
    samples.push({ datetime: new Date(nightStart + i * 1000).toISOString(), bpm: 48 + (i % 4) });
  }
  for (let i = 0; i < 30 * 60; i += 1) {
    samples.push({ datetime: new Date(base + i * 1000).toISOString(), bpm: 148 + (i % 5) });
  }
  return samples;
}

test('shadow mode off by default: no V2 keys touch the daily row', async () => {
  const prior = process.env.FRWHOOP_STRAIN_V2;
  process.env.FRWHOOP_STRAIN_V2 = 'off';
  const { engine, dbRows } = makeEngine();
  const base = Date.UTC(2026, 7, 24, 10, 0, 0);
  try {
    await engine.persistComputed({ samples: exerciseSamples(base) });
    const row = dbRows.daily_metrics.find((r) => r.day === '2026-08-24');
    assert.ok(row, 'V1 daily row written');
    assert.notEqual(row.strain_score, null);
    assert.equal(row.strain_score_v2, undefined);
    assert.equal(row.strain_v2, undefined);
    const series = dbRows.daily_physiology_series[0];
    assert.ok(Array.isArray(series.strain_series) && series.strain_series.length > 0, 'V1 strain_series is canonical');
    assert.equal(row.extras?.strain_v2_series, undefined);
  } finally {
    if (prior == null) delete process.env.FRWHOOP_STRAIN_V2;
    else process.env.FRWHOOP_STRAIN_V2 = prior;
  }
});

test('shadow mode on: V2 lands additively; V1 strain/effort byte-identical to off-mode', async () => {
  const { engine, dbRows, blobs } = makeEngine();
  const base = Date.UTC(2026, 7, 24, 10, 0, 0);
  const fresh = exerciseSamples(base);

  process.env.FRWHOOP_STRAIN_V2 = 'off';
  await engine.persistComputed({ samples: exerciseSamples(base) });
  const offRow = dbRows.daily_metrics.find((r) => r.day === '2026-08-24');
  const offStrain = offRow.strain_score;

  process.env.FRWHOOP_STRAIN_V2 = 'shadow';
  try {
    await engine.persistComputed({ samples: fresh });
    // persistComputed upserts the same PK; dbRows has both writes
    const onRows = dbRows.daily_metrics.filter((r) => r.day === '2026-08-24');
    const onRow = onRows[onRows.length - 1];
    // V1 keys untouched by shadow mode
    assert.equal(onRow.strain_score, offStrain);
    assert.equal(onRow.effort, offStrain);
    // V2 keys present with full provenance envelope
    assert.ok(onRow.strain_score_v2 !== undefined && onRow.strain_score_v2 !== null);
    assert.ok(onRow.strain_v2);
    assert.equal(onRow.strain_v2.algorithmVersion, 'frwhoop-strain-v2.0.0-shadow');
    assert.ok(['HIGH', 'MODERATE', 'LOW', 'INSUFFICIENT'].includes(onRow.strain_v2.qualityState));
    assert.ok(onRow.strain_v2.hrMax && onRow.strain_v2.hrMax.source);
    assert.ok(onRow.strain_v2.restingHr && onRow.strain_v2.restingHr.source);
    const series = dbRows.daily_physiology_series[dbRows.daily_physiology_series.length - 1];
    assert.ok(Array.isArray(series.strain_series) && series.strain_series.length > 0);
    const v2Series = onRow.extras?.strain_v2_series || [];
    assert.ok(v2Series.length > 0, 'V2 series lives beside V1, not in strain_series');
    const bucketSum = v2Series.reduce((a, b) => a + (b.au || 0), 0);
    const onAu = onRow.strain_v2.au;
    assert.ok(Math.abs(bucketSum - onAu) < 0.51, `v2 series ${bucketSum} vs day ${onAu}`);
    // activity window == same increments (D7): full-day window equals the day AU
    // (activity scoring is exercised in score.test.js; here we assert the run row)
    const runs = dbRows.metric_runs.filter((m) => m.algorithm === 'strain_v2');
    assert.ok(runs.length >= 2, 'off-run (partial) and on-run (complete) both recorded');
    const run = runs[runs.length - 1];
    assert.equal(run.status, 'complete');
    assert.equal(run.output_refs.quality_state, onRow.strain_v2.qualityState);
    // blob carries the provenance envelope (derived object)
    assert.ok(blobs.size > 0);
  } finally {
    delete process.env.FRWHOOP_STRAIN_V2;
  }
});

test('shadow mode on: replay idempotency - second run of the same window is byte-identical', async () => {
  const { engine, dbRows } = makeEngine();
  const base = Date.UTC(2026, 7, 25, 8, 0, 0);
  process.env.FRWHOOP_STRAIN_V2 = 'shadow';
  try {
    const s1 = exerciseSamples(base);
    await engine.persistComputed({ samples: s1 });
    const first = dbRows.daily_metrics[dbRows.daily_metrics.length - 1].strain_v2;
    const s2 = exerciseSamples(base);
    await engine.persistComputed({ samples: s2 });
    const second = dbRows.daily_metrics[dbRows.daily_metrics.length - 1].strain_v2;
    assert.deepEqual(second, first);
  } finally {
    delete process.env.FRWHOOP_STRAIN_V2;
  }
});
