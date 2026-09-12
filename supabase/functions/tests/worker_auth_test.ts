import { assertEquals } from 'jsr:@std/assert';
import { authorizeWorkerRequest } from '../_shared/workerAuth.ts';

const SERVICE = 'service-role-jwt-test-value';

function req(bearer?: string): Request {
  if (!bearer) return new Request('https://example.test/worker');
  return new Request('https://example.test/worker', { headers: { authorization: `Bearer ${bearer}` } });
}

Deno.test('worker auth: 401 when WORKER_SECRET unset and bearer missing', () => {
  const prev = Deno.env.get('WORKER_SECRET');
  Deno.env.delete('WORKER_SECRET');
  assertEquals(authorizeWorkerRequest(req(), { supabaseServiceRoleKey: '' }), false);
  if (prev) Deno.env.set('WORKER_SECRET', prev);
});

Deno.test('worker auth: accepts service-role bearer when WORKER_SECRET unset', () => {
  const prev = Deno.env.get('WORKER_SECRET');
  Deno.env.delete('WORKER_SECRET');
  assertEquals(authorizeWorkerRequest(req(SERVICE), { supabaseServiceRoleKey: SERVICE }), true);
  if (prev) Deno.env.set('WORKER_SECRET', prev);
});

Deno.test('worker auth: accepts WORKER_SECRET bearer', () => {
  const prev = Deno.env.get('WORKER_SECRET');
  Deno.env.set('WORKER_SECRET', 'cron-secret');
  assertEquals(authorizeWorkerRequest(req('cron-secret'), { supabaseServiceRoleKey: '' }), true);
  if (prev) Deno.env.set('WORKER_SECRET', prev);
  else Deno.env.delete('WORKER_SECRET');
});

Deno.test('worker auth: rejects wrong bearer even when WORKER_SECRET is set', () => {
  const prev = Deno.env.get('WORKER_SECRET');
  Deno.env.set('WORKER_SECRET', 'cron-secret');
  assertEquals(authorizeWorkerRequest(req('wrong'), { supabaseServiceRoleKey: SERVICE }), false);
  if (prev) Deno.env.set('WORKER_SECRET', prev);
  else Deno.env.delete('WORKER_SECRET');
});
