import assert from 'node:assert/strict';
import test from 'node:test';
import { probeContinuitySchema } from '../metrics/schemaReadiness.js';
import { createMetricsDb } from '../metrics/repository.js';

test('schema probe fails loud when day_completeness is missing', async () => {
  await assert.rejects(
    () => probeContinuitySchema({
      rest: async (table) => ({ ok: table !== 'day_completeness', status: table === 'day_completeness' ? 404 : 200, text: async () => 'missing' }),
    }),
    (err) => err.code === 'continuity_schema_behind' && String(err.message).includes('day_completeness'),
  );
});

test('schema probe fails loud when engine_ingest_upsert RPC is missing', async () => {
  await assert.rejects(
    () => probeContinuitySchema({
      rest: async (path) => {
        if (String(path) === 'rpc/engine_ingest_upsert') return { ok: false, status: 404, text: async () => 'not found' };
        if (String(path).startsWith('rpc/')) return { ok: false, status: 400, text: async () => 'bad secret' };
        return { ok: true, status: 200, text: async () => '' };
      },
    }),
    (err) => err.code === 'continuity_schema_behind' && String(err.message).includes('engine_ingest_upsert'),
  );
});

test('schema probe passes when tables and RPCs exist', async () => {
  const result = await probeContinuitySchema({
    rest: async (path) => {
      if (String(path).startsWith('rpc/')) return { ok: false, status: 400, text: async () => 'bad secret' };
      return { ok: true, status: 200, text: async () => '' };
    },
  });
  assert.equal(result.ok, true);
});

test('resolveIngestGaps PATCHes by id even when payload already has resolved_at', async () => {
  const calls = [];
  const db = createMetricsDb({
    cfg: {
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'service-key',
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET', body: options.body });
      return {
        ok: true,
        status: 200,
        async json() { return []; },
        async text() { return '[]'; },
      };
    },
  });
  const n = await db.resolveIngestGaps('11111111-1111-4111-8111-111111111111', [{
    id: '22222222-2222-4222-8222-222222222222',
    resolved_at: '2026-08-29T02:00:00.000Z',
    resolution: 'backfilled',
    meta: { resolution_evidence: { kind: 'samples_cover_interval' } },
  }]);
  assert.equal(n, 1);
  const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('ingest_gaps'));
  assert.ok(patch, 'must PATCH ingest_gaps');
  assert.equal(patch.url.includes('resolved_at=is.null'), true);
  assert.equal(patch.url.includes('id=eq.22222222-2222-4222-8222-222222222222'), true);
  const body = JSON.parse(patch.body);
  assert.equal(body.resolution, 'backfilled');
  assert.equal(body.resolved_at, '2026-08-29T02:00:00.000Z');
});

test('replayed resolve of an already-closed row is a no-op at the filter', async () => {
  const db = createMetricsDb({
    cfg: {
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'service-key',
    },
    fetchImpl: async (url, options = {}) => {
      if ((options.method || 'GET') === 'PATCH') {
        return { ok: true, status: 200, async json() { return []; }, async text() { return '[]'; } };
      }
      return { ok: true, status: 200, async json() { return []; }, async text() { return '[]'; } };
    },
  });
  const n = await db.resolveIngestGaps('11111111-1111-4111-8111-111111111111', [{
    id: '33333333-3333-4333-8333-333333333333',
    resolved_at: '2026-08-28T01:00:00.000Z',
  }]);
  assert.equal(n, 1);
});
