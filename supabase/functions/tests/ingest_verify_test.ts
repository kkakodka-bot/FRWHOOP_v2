import { assertEquals, assert } from 'jsr:@std/assert';
import { makeMemRest } from './helpers.ts';
import { buildIngestVerifyReport } from '../_shared/ingestVerify.ts';
import { authorizeWorkerRequest } from '../_shared/workerAuth.ts';

const USER = '7f2c9a10-4b3e-4d8a-9c11-00000000f001';
const DAY = '2026-09-10';

Deno.test('ingest-verify auth: fails closed without WORKER_SECRET or service-role bearer', () => {
  const prev = Deno.env.get('WORKER_SECRET');
  Deno.env.delete('WORKER_SECRET');
  assertEquals(
    authorizeWorkerRequest(new Request('https://x'), { supabaseServiceRoleKey: '' }),
    false,
  );
  if (prev) Deno.env.set('WORKER_SECRET', prev);
});

Deno.test('ingest-verify: reports first incomplete stage from receipts through projection', async () => {
  const rest = makeMemRest();
  await rest.upsert('noop_push_wal', {
    user_id: USER,
    batch_id: 'batch-1',
    stream: 'hrSample',
    device_id: 'dev',
    record_count: 2,
    body_sha256: 'a'.repeat(64),
    received_at: '2026-09-10T12:00:00.000Z',
  });
  await rest.upsert('noop_push_acks', {
    user_id: USER,
    batch_id: 'batch-1',
    body_sha256: 'a'.repeat(64),
    ack: { status: 'accepted' },
    saved_at: '2026-09-10T12:00:01.000Z',
  });
  await rest.upsert('object_manifests', {
    id: 'obj-1',
    user_id: USER,
    period_day: DAY,
    object_key: 'v3/core/users/u/raw/x',
    status: 'ready',
    object_kind: 'rawBatch',
  });
  await rest.upsert('daily_metrics', {
    user_id: USER,
    day: DAY,
    computed_at: '2026-09-10T13:00:00.000Z',
    algorithm_version: 'noop-client',
    provenance: { source: 'noop_push' },
  });

  const report = await buildIngestVerifyReport({
    rest: rest as any,
    objectStore: {
      async head(key: string) {
        return { exists: key === 'v3/core/users/u/raw/x', contentLength: 128 };
      },
    },
    userId: USER,
    day: DAY,
  });

  assertEquals(report.complete, true);
  assertEquals(report.first_incomplete_stage, null);
  assertEquals(report.push_receipts.ack_batches, 1);
  assertEquals(report.manifest_statuses.ready, 1);
  assert(report.b2_presence['v3/core/users/u/raw/x']?.exists);
  assert(report.projections.daily_metrics.present);
});

Deno.test('ingest-verify: missing B2 object surfaces b2_object stage', async () => {
  const rest = makeMemRest();
  await rest.upsert('noop_push_acks', {
    user_id: USER,
    batch_id: 'batch-2',
    body_sha256: 'b'.repeat(64),
    ack: { status: 'accepted' },
    saved_at: '2026-09-10T12:00:01.000Z',
  });
  await rest.upsert('object_manifests', {
    id: 'obj-2',
    user_id: USER,
    period_day: DAY,
    object_key: 'missing-key',
    status: 'ready',
    object_kind: 'rawBatch',
  });

  const report = await buildIngestVerifyReport({
    rest: rest as any,
    objectStore: { async head() { return { exists: false, contentLength: null }; } },
    userId: USER,
    day: DAY,
  });

  assertEquals(report.first_incomplete_stage, 'b2_object');
  assertEquals(report.complete, false);
});
