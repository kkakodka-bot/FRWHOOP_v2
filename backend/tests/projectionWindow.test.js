import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROJECTION_WINDOW_DAYS,
  projectionCutoffTs,
  projectionWindowCoverageGaps,
  projectionWindowPlan,
  projectionWindowTables,
  sweepProjectionWindow,
} from '../storage/projectionWindow.js';
import { APPEND_STREAM_PROJECTIONS } from '../ingest/pushRegistry.js';
import { OBJECT_LANE_STREAMS } from '../storage/keys.js';

/**
 * The division of labour between the two stores: B2 keeps every sample forever, Postgres keeps a
 * bounded recent window so the UI can render without fetching objects. These tests exist because
 * that boundary is the one that fails quietly — nothing errors when a cache table grows without
 * limit, it just gets slower until it stops.
 */

const NOW = new Date('2026-09-07T18:00:00.000Z');

function memRest() {
  const deletes = [];
  return {
    configured: true,
    deletes,
    async delete(table, filter) { deletes.push({ table, filter }); },
  };
}

test('every per-sample projection has a timestamp column the sweep can use', () => {
  const gaps = projectionWindowCoverageGaps();
  assert.deepEqual(
    gaps,
    [],
    `these streams write per-sample rows with nothing to sweep on, so they grow forever: ${gaps.join(', ')}`,
  );
});

test('the sweep covers every append projection, and only append projections', () => {
  const swept = new Set(projectionWindowTables().map((e) => e.stream));
  for (const stream of Object.keys(APPEND_STREAM_PROJECTIONS)) {
    assert.ok(swept.has(stream), `${stream} projects rows but is not swept`);
  }
  // The object lane writes no per-sample rows, so it must not appear in the plan at all.
  for (const stream of OBJECT_LANE_STREAMS) {
    assert.ok(!swept.has(stream), `${stream} is object-lane and should have no projection to sweep`);
  }
});

test('the sweep never touches the archive, its index, or the labels', () => {
  const tables = new Set(projectionWindowTables().map((e) => e.table));
  for (const protectedTable of ['object_manifests', 'noop_signal_windows', 'noop_event_labels']) {
    assert.ok(
      !tables.has(protectedTable),
      `${protectedTable} is not reconstructible from the archive and must never be swept`,
    );
  }
});

test('the cutoff is a fixed window back from now, in unix seconds', () => {
  const cutoff = projectionCutoffTs(NOW);
  assert.equal(cutoff, Math.floor(NOW.getTime() / 1000) - PROJECTION_WINDOW_DAYS * 86400);

  const plan = projectionWindowPlan({ now: NOW });
  assert.ok(plan.length > 0);
  for (const entry of plan) {
    assert.equal(entry.cutoffTs, cutoff, 'every table must sweep to the same instant');
  }
});

test('sweeping issues one bounded delete per table and leaves recent rows alone', async () => {
  const rest = memRest();
  const { swept } = await sweepProjectionWindow({ rest, now: () => NOW });

  assert.equal(swept.length, projectionWindowTables().length);
  assert.ok(swept.every((s) => s.ok));

  const cutoff = projectionCutoffTs(NOW);
  for (const call of rest.deletes) {
    // `lt` and not `lte`/`gt`: an off-by-one here either leaves a row forever or deletes the
    // present, and both are invisible until the table is either huge or missing today's data.
    assert.match(call.filter, /=lt\.\d+$/, `unbounded or wrong-direction delete on ${call.table}`);
    assert.equal(Number(call.filter.split('=lt.')[1]), cutoff);
  }
  assert.equal(new Set(rest.deletes.map((d) => d.table)).size, rest.deletes.length, 'duplicate sweeps');
});

test('sweeping is a no-op when Postgres is not configured', async () => {
  const result = await sweepProjectionWindow({ rest: { configured: false }, now: () => NOW });
  assert.equal(result.skipped, 'rest_not_configured');
  assert.deepEqual(result.swept, []);
});

test('one failing table does not abort the rest of the sweep', async () => {
  const rest = memRest();
  const target = projectionWindowTables()[0].table;
  rest.delete = async (table) => {
    if (table === target) throw new Error('deadlock detected');
    rest.deletes.push({ table });
  };

  const { swept } = await sweepProjectionWindow({ rest, now: () => NOW });
  const failed = swept.filter((s) => !s.ok);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /deadlock/);
  assert.equal(swept.filter((s) => s.ok).length, swept.length - 1, 'a failure stopped the sweep');
});

/**
 * The sizing claim behind the whole split, asserted rather than left in a comment. If someone widens
 * the window or adds a high-rate projection, this fails with the number that motivated the design.
 */
test('the retained window keeps Postgres in the millions of rows, not the billions', () => {
  const PATIENTS = 50;
  const SAMPLES_PER_PATIENT_DAY = 100_000;   // rrInterval-dominated, order of magnitude
  const retained = PATIENTS * SAMPLES_PER_PATIENT_DAY * PROJECTION_WINDOW_DAYS;
  const unswept = PATIENTS * SAMPLES_PER_PATIENT_DAY * 365;

  assert.ok(retained < 100e6, `retained window is ${retained} rows; Postgres will not hold this`);
  assert.ok(unswept > 1e9, 'the unswept figure should still be the reason this sweep exists');
  assert.ok(PROJECTION_WINDOW_DAYS <= 30, 'widening the cache window past a month re-creates the problem');
});
