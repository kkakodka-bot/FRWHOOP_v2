import assert from 'node:assert/strict';
import test from 'node:test';
import { allowDevUser, IdentityError, resolveRequestUser } from '../identity/resolveUser.js';

const UUID = '7f2c9a10-4b3e-4d8a-9c11-00000000f001';
const JWT_USER = '9f33375b-e029-480f-9ebb-a99e5ff22ac9';

test('production does not fall back to a shared user', async () => {
  await assert.rejects(
    () => resolveRequestUser({
      headers: {},
      cfg: { nodeEnv: 'production', allowDevUser: false, localUserId: UUID },
    }),
    IdentityError,
  );
});

test('production device token does not map to FRWHOOP_LOCAL_USER_ID', async () => {
  await assert.rejects(
    () => resolveRequestUser({
      headers: { 'x-frwhoop-device-token': 'secret' },
      cfg: { deviceToken: 'secret', localUserId: UUID, allowDevUser: false, nodeEnv: 'production' },
    }),
    (err) => err instanceof IdentityError && /jwt required/.test(err.message),
  );
});

test('invalid jwt plus device token does not write as the local user', async () => {
  await assert.rejects(
    () => resolveRequestUser({
      headers: { authorization: 'Bearer expired', 'x-frwhoop-device-token': 'secret' },
      cfg: {
        deviceToken: 'secret',
        localUserId: UUID,
        supabaseUrl: 'https://example.supabase.co',
        supabaseAnonKey: 'anon',
        allowDevUser: false,
        nodeEnv: 'production',
      },
      fetchImpl: async () => ({ ok: false, json: async () => null }),
    }),
    IdentityError,
  );
});

test('invalid jwt plus device token does not write as the local user in development', async () => {
  await assert.rejects(
    () => resolveRequestUser({
      headers: { authorization: 'Bearer expired', 'x-frwhoop-device-token': 'secret' },
      cfg: {
        deviceToken: 'secret',
        localUserId: UUID,
        supabaseUrl: 'https://example.supabase.co',
        supabaseAnonKey: 'anon',
        allowDevUser: true,
        nodeEnv: 'development',
      },
      fetchImpl: async () => ({ ok: false, json: async () => null }),
    }),
    IdentityError,
  );
});

test('dev device token maps to the configured uuid', async () => {
  const user = await resolveRequestUser({
    headers: { 'x-frwhoop-device-token': 'secret' },
    cfg: { deviceToken: 'secret', localUserId: UUID, allowDevUser: true, nodeEnv: 'development' },
  });
  assert.equal(user.id, UUID);
  assert.equal(user.source, 'device_token');
});

test('dev fallback uses uuid never local-demo', async () => {
  const user = await resolveRequestUser({
    headers: {},
    cfg: { localUserId: UUID, allowDevUser: true, nodeEnv: 'development' },
  });
  assert.equal(user.id, UUID);
  assert.notEqual(user.id, 'local-demo');
  assert.equal(allowDevUser({ nodeEnv: 'development' }), true);
  assert.equal(allowDevUser({ nodeEnv: 'production' }), false);
});

test('jwt user wins over device token', async () => {
  const user = await resolveRequestUser({
    headers: { authorization: 'Bearer aaa', 'x-frwhoop-device-token': 'secret' },
    cfg: {
      deviceToken: 'secret',
      localUserId: UUID,
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'anon',
      allowDevUser: false,
      nodeEnv: 'production',
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: JWT_USER }) }),
  });
  assert.equal(user.id, JWT_USER);
  assert.equal(user.source, 'jwt');
});
