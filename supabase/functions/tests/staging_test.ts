// The Postgres-backed replacement staging is the one piece of the port with NEW logic (the Node
// original stages in process memory). Pin the state machine: part conflicts, window conflicts,
// supersede, completion order, and clear.
import assert from 'node:assert/strict';
import { createPushReplacementStaging } from '../_shared/staging.ts';
import { PushProtocolError } from '../_shared/registry.ts';

const USER = '11111111-1111-4111-8111-111111111111';

/** In-memory stand-in for the noop_push_staging_parts table, behind the rest interface. */
function makeStagingRest() {
  const rows = new Map<string, any>();
  const keyOf = (r: any) => `${r.user_id}${r.scope}${r.replacement_id}${r.part}`;
  return {
    configured: true,
    rows,
    async select(_table: string, query = '') {
      const userId = /user_id=eq\.([^&]+)/.exec(query)?.[1];
      const scope = decodeURIComponent(/scope=eq\.([^&]+)/.exec(query)?.[1] || '');
      return [...rows.values()]
        .filter((r) => r.user_id === userId && r.scope === scope)
        .sort((a, b) => a.part - b.part)
        .map((r) => ({ ...r }));
    },
    async upsert(_table: string, row: any) {
      const list = Array.isArray(row) ? row : [row];
      for (const r of list) if (!rows.has(keyOf(r))) rows.set(keyOf(r), { ...r });
      return list;
    },
    async delete(_table: string, query = '') {
      const userId = /user_id=eq\.([^&]+)/.exec(query)?.[1];
      const scope = decodeURIComponent(/scope=eq\.([^&]+)/.exec(query)?.[1] || '');
      const replacementId = /replacement_id=eq\.([^&]+)/.exec(query)?.[1];
      for (const [k, r] of [...rows.entries()]) {
        if (r.user_id !== userId || r.scope !== scope) continue;
        if (replacementId && r.replacement_id !== decodeURIComponent(replacementId)) continue;
        rows.delete(k);
      }
      return [];
    },
  };
}

function headerFor(over: Record<string, unknown> = {}) {
  return {
    stream: 'dailyMetric',
    deviceId: 'strap-1',
    sourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    batchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    window: {
      replacementId: 'r1',
      selector: 'day',
      startInclusive: '2026-09-01',
      endExclusive: '2026-09-02',
      part: 1,
      parts: 2,
    },
    ...over,
  };
}

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

Deno.test('staging: parts accumulate and the completing part carries every record', async () => {
  const rest = makeStagingRest();
  const staging = createPushReplacementStaging({ rest: rest as any });

  const first = await staging.stagePart({
    userId: USER,
    header: headerFor(),
    records: [{ key: { day: '2026-09-01' }, data: { steps: 100 } }],
    bodySha256: SHA_A,
  });
  assert.equal(first.complete, false);
  assert.equal(first.isCompletingPart, false);
  assert.deepEqual(first.records, []);

  const second = await staging.stagePart({
    userId: USER,
    header: headerFor({ batchId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', window: { ...headerFor().window, part: 2 } }),
    records: [{ key: { day: '2026-09-01' }, data: { steps: 200 } }],
    bodySha256: SHA_B,
  });
  assert.equal(second.complete, true);
  assert.equal(second.isCompletingPart, true);
  assert.equal(second.records.length, 2, 'the completing part must carry parts 1 and 2 in order');
  assert.equal(second.records[0].data.steps, 100);
  assert.equal(second.records[1].data.steps, 200);

  await staging.clearGeneration({ userId: USER, header: headerFor() });
  assert.equal(rest.rows.size, 0, 'clearing must drop every staged part');
});

Deno.test('staging: a re-delivered part with the same bytes is idempotent', async () => {
  const rest = makeStagingRest();
  const staging = createPushReplacementStaging({ rest: rest as any });
  const header = headerFor();
  await staging.stagePart({ userId: USER, header, records: [{ key: { day: '2026-09-01' } }], bodySha256: SHA_A });
  const again = await staging.stagePart({ userId: USER, header, records: [{ key: { day: '2026-09-01' } }], bodySha256: SHA_A });
  assert.equal(again.alreadyStaged, true);
  assert.equal(rest.rows.size, 1);
});

Deno.test('staging: same part, different batch or bytes, is a conflict', async () => {
  const rest = makeStagingRest();
  const staging = createPushReplacementStaging({ rest: rest as any });
  const header = headerFor();
  await staging.stagePart({ userId: USER, header, records: [], bodySha256: SHA_A });

  await assert.rejects(
    () => staging.stagePart({
      userId: USER,
      header: headerFor({ batchId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }),
      records: [],
      bodySha256: SHA_A,
    }),
    (err: any) => err instanceof PushProtocolError && err.code === 'replacement_part_conflict' && err.status === 409,
  );
  await assert.rejects(
    () => staging.stagePart({ userId: USER, header, records: [], bodySha256: SHA_B }),
    (err: any) => err.code === 'batch_id_conflict' && err.status === 409,
  );
});

Deno.test('staging: a new replacement id abandons an incomplete generation', async () => {
  const rest = makeStagingRest();
  const staging = createPushReplacementStaging({ rest: rest as any });
  await staging.stagePart({ userId: USER, header: headerFor(), records: [], bodySha256: SHA_A });

  const superseding = headerFor({ window: { ...headerFor().window, replacementId: 'r2' } });
  const out = await staging.stagePart({ userId: USER, header: superseding, records: [], bodySha256: SHA_B });
  assert.equal(out.complete, false);
  const remaining = [...rest.rows.values()];
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].replacement_id, 'r2', 'the abandoned generation must be gone');
});

Deno.test('staging: window shape validation matches the Node codes', async () => {
  const rest = makeStagingRest();
  const staging = createPushReplacementStaging({ rest: rest as any });
  await assert.rejects(
    () => staging.stagePart({ userId: USER, header: { stream: 'dailyMetric' }, records: [], bodySha256: SHA_A }),
    (err: any) => err.code === 'missing_window',
  );
  await assert.rejects(
    () => staging.stagePart({
      userId: USER,
      header: headerFor({ window: { ...headerFor().window, part: 3 } }),
      records: [],
      bodySha256: SHA_A,
    }),
    (err: any) => err.code === 'invalid_window_part',
  );
  await assert.rejects(
    () => staging.stagePart({
      userId: USER,
      header: { ...headerFor(), endCursor: { rowId: 1 } },
      records: [],
      bodySha256: SHA_A,
    }),
    (err: any) => err.code === 'invalid_replace_cursor',
  );
});
