import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { createDeviceRegistrar } from '../_shared/devices.ts';
import { createSupabaseRest } from '../_shared/rest.ts';

Deno.test('device registration and retries use the atomic database RPC', async () => {
  const calls: { path: string; body: unknown }[] = [];
  const rest = createSupabaseRest({
    cfg: { supabaseUrl: 'https://fixture.invalid', supabaseServiceRoleKey: 'fixture-only' },
    fetchImpl: async (input, init) => {
      calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
      return new Response('"device"', { status: 200 });
    },
  });
  const register = createDeviceRegistrar(rest);
  const row = { id: 'device', user_id: 'owner', external_device_id: 'strap', last_seen_at: '2026-09-18T00:00:00Z' };
  await register(row);
  await register(row);
  assertEquals(calls, [0, 1].map(() => ({ path: '/rest/v1/rpc/register_noop_device', body: {
    p_device: 'device', p_user: 'owner', p_external_device_id: 'strap', p_last_seen_at: '2026-09-18T00:00:00Z',
  } })));
});

Deno.test('device registration propagates database rejection before ingestion proceeds', async () => {
  const rest = createSupabaseRest({
    cfg: { supabaseUrl: 'https://fixture.invalid', supabaseServiceRoleKey: 'fixture-only' },
    fetchImpl: async () => new Response(JSON.stringify({ message: 'device_registration_conflict' }), { status: 409 }),
  });
  await assertRejects(() => createDeviceRegistrar(rest)({ id: 'device', user_id: 'owner' }), Error, 'device_registration_conflict');
});
