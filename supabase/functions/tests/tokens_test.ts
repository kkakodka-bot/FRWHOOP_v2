// Token lifecycle tests for the Edge port of the retired Node receiver +
// the retired Node receiver createIngestTokenStore.
import { assertEquals, assert } from 'jsr:@std/assert';
import {
  createIngestTokenStore,
  hashIngestToken,
  resolvePushUser,
  publicIngestTokenRow,
} from '../_shared/tokens.ts';
import { makeMemRest } from './helpers.ts';

const USER = '7f2c9a10-4b3e-4d8a-9c11-00000000f001';

Deno.test('tokens: mint stores the SHA-256 hash, returns the raw token once', async () => {
  const rest = makeMemRest();
  const store = createIngestTokenStore({ rest });
  const minted = await store.mint({ userId: USER, label: 'conformance' });
  assert(typeof minted.token === 'string' && minted.token.startsWith('noop_'));
  assertEquals(minted.row?.label, 'conformance');
  const rows = rest.tables.get('noop_ingest_tokens') || [];
  assertEquals(rows.length, 1);
  assertEquals(rows[0].token_hash, hashIngestToken(minted.token));
  assert(!String(rows[0].token_hash).includes(minted.token), 'hash must not leak the raw token');
});

Deno.test('tokens: list returns every minted token for the user', async () => {
  const rest = makeMemRest();
  const store = createIngestTokenStore({ rest });
  await store.mint({ userId: USER, label: 'a' });
  await store.mint({ userId: USER, label: 'b' });
  const listed = await store.list({ userId: USER });
  assertEquals(listed.length, 2);
  assertEquals(new Set(listed.filter((r) => r != null).map((r) => r!.label)), new Set(['a', 'b']));
});

Deno.test('tokens: revoke hides the token and the revoked bearer no longer authenticates', async () => {
  const rest = makeMemRest();
  const store = createIngestTokenStore({ rest });
  const minted = await store.mint({ userId: USER, label: 'revoke-me' });
  const revoked = await store.revoke({ userId: USER, id: String(minted.row?.id) });
  assert(revoked != null && revoked.revokedAt != null);
  // A revoked bearer must be rejected by resolvePushUser (same path the function uses).
  const headers = new Headers({ authorization: `Bearer ${minted.token}` });
  let denied = false;
  try {
    await resolvePushUser({
      headers,
      rest: rest as any,
      supabaseUrl: 'http://127.0.0.1:54321',
      anonKey: 'anon',
    });
  } catch {
    denied = true;
  }
  assert(denied, 'revoked token must fail resolvePushUser');
});

Deno.test('tokens: revoking a missing or already-revoked id returns null', async () => {
  const rest = makeMemRest();
  const store = createIngestTokenStore({ rest });
  assertEquals(await store.revoke({ userId: USER, id: '00000000-0000-4000-8000-000000000000' }), null);
  const minted = await store.mint({ userId: USER });
  await store.revoke({ userId: USER, id: String(minted.row?.id) });
  assertEquals(await store.revoke({ userId: USER, id: String(minted.row?.id) }), null);
});

Deno.test('tokens: publicIngestTokenRow never exposes the hash', async () => {
  const pub = publicIngestTokenRow({ id: 'x', label: 'l', created_at: '2026-01-01T00:00:00Z', token_hash: 'secret', last_used_at: null, revoked_at: null });
  assert(!JSON.stringify(pub).includes('secret'));
  assertEquals(pub?.id, 'x');
});
