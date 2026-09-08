import assert from 'node:assert/strict';
import test from 'node:test';
import { createMetricsDb } from '../metrics/repository.js';

const USER = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';

function response(body = null) {
  return {
    ok: true,
    status: 200,
    async text() { return body == null ? '' : JSON.stringify(body); },
    async json() { return body ?? []; },
  };
}

function sleepPayload() {
  return {
    user_id: USER,
    device: {
      id: DEVICE,
      source_kind: 'whoop',
      external_device_id: 'strap-1',
    },
    daily_metrics: [{
      user_id: USER,
      day: '2026-08-25',
      source_device_id: DEVICE,
      record_class: 'user',
      timezone_name: 'UTC',
    }],
    sessions: [
      {
        id: 'sleep-1', user_id: USER, device_id: DEVICE, kind: 'sleep',
        external_id: `sleep:${DEVICE}:2026-08-25:main`,
        start_at: '2026-08-25T22:00:00Z', end_at: '2026-08-26T06:00:00Z',
      },
      {
        id: 'nap-1', user_id: USER, device_id: DEVICE, kind: 'nap',
        external_id: `sleep:${DEVICE}:2026-08-25:nap:0`,
        start_at: '2026-08-25T15:00:00Z', end_at: '2026-08-25T16:00:00Z',
      },
      { id: 'workout-1', user_id: USER, device_id: DEVICE, kind: 'workout' },
    ],
    // Presence, including an empty array, means authoritative replacement.
    sleep_details: [],
  };
}

test('service-role persistence replaces sleep transactionally before direct projections', async () => {
  const calls = [];
  const db = createMetricsDb({
    cfg: {
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'service-key',
      ingestSecret: 'secret',
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({
        url,
        method: options.method,
        body: options.body ? JSON.parse(options.body) : null,
      });
      return response([]);
    },
  });

  await db.upsertPayload(sleepPayload());

  const replacement = calls.findIndex((call) => call.url.endsWith('/rpc/engine_replace_sleep_day'));
  const daily = calls.findIndex((call) => call.url.endsWith('/daily_metrics'));
  assert.ok(replacement >= 0, 'the transactional sleep replacement RPC is called');
  assert.ok(replacement < daily, 'sleep replacement completes before direct daily projection writes');

  const sessionWrite = calls.find((call) => (
    call.url.endsWith('/sessions') && call.method === 'POST'
  ));
  assert.deepEqual(sessionWrite.body.map((row) => row.kind), ['workout']);
  assert.equal(
    calls.some((call) => call.url.endsWith('/sleep_details')),
    false,
    'canonical details are written only inside the replacement transaction',
  );
});

test('anon ingest is rejected; engine ingest requires service role', async () => {
  const db = createMetricsDb({
    cfg: {
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'anon-key',
      ingestSecret: 'secret',
    },
    fetchImpl: async () => response({ ok: true }),
  });

  await assert.rejects(
    db.upsertPayload(sleepPayload()),
    /service_role_required_for_engine_ingest/,
  );
});

test('service-role writes reject PostgREST failures so the outbox can retry', async () => {
  const db = createMetricsDb({
    cfg: { supabaseUrl: 'https://example.supabase.co', supabaseServiceRoleKey: 'service-key' },
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      async text() { return 'missing device'; },
    }),
  });
  await assert.rejects(
    db.upsertPayload({ user_id: USER, daily_metrics: [{ user_id: USER, day: '2026-08-25' }] }),
    /daily_metrics write failed \(409\)/,
  );
});
