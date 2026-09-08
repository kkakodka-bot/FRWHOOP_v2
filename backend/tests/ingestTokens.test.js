import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';
import {
  INGEST_TOKEN_PREFIX,
  createIngestTokenStore,
  generateIngestToken,
  hashIngestToken,
  looksLikeJwt,
} from '../identity/ingestTokens.js';
import { IdentityError } from '../identity/resolveUser.js';
import { resolvePushUser } from '../identity/resolvePushUser.js';
import { registerPushRoutes } from '../routes/push.js';
import { registerPushTokenRoutes } from '../routes/pushTokens.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const JWT_USER = '9f33375b-e029-480f-9ebb-a99e5ff22ac9';
const CFG = {
  nodeEnv: 'production',
  allowDevUser: false,
  localUserId: USER_A,
  supabaseUrl: 'https://example.supabase.co',
  supabaseAnonKey: 'anon',
};

function fakeJwt(sub) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, role: 'authenticated' })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function memoryIngestTokenStore() {
  const rows = new Map();
  const rest = {
    configured: true,
    async upsert(_table, row) {
      const id = crypto.randomUUID();
      const stored = {
        id,
        user_id: row.user_id,
        token_hash: row.token_hash,
        label: row.label || '',
        created_at: new Date().toISOString(),
        last_used_at: null,
        revoked_at: null,
      };
      rows.set(row.token_hash, stored);
      return [stored];
    },
    async select(_table, query) {
      const hashMatch = /token_hash=eq\.([0-9a-f]{64})/.exec(query);
      if (hashMatch) {
        const row = rows.get(hashMatch[1]);
        if (!row || row.revoked_at) return [];
        return [row];
      }
      const userMatch = /user_id=eq\.([^&]+)/.exec(query);
      if (userMatch) {
        return [...rows.values()].filter((row) => row.user_id === userMatch[1]);
      }
      return [];
    },
    async patch(_table, body, query) {
      const idMatch = /id=eq\.([^&]+)/.exec(query);
      const userMatch = /user_id=eq\.([^&]+)/.exec(query);
      for (const row of rows.values()) {
        if (row.id === idMatch?.[1] && row.user_id === userMatch?.[1] && !row.revoked_at) {
          Object.assign(row, body);
          return [row];
        }
      }
      return [];
    },
  };
  return { store: createIngestTokenStore({ rest }), rows };
}

test('looksLikeJwt distinguishes JWTs from opaque ingest tokens', () => {
  assert.equal(looksLikeJwt(fakeJwt('user')), true);
  assert.equal(looksLikeJwt(`${INGEST_TOKEN_PREFIX}abc123`), false);
  assert.equal(looksLikeJwt('not-a-jwt'), false);
});

test('generateIngestToken is opaque and hashes to 64 hex chars', () => {
  const token = generateIngestToken();
  assert.match(token, /^noop_[A-Za-z0-9_-]+$/);
  assert.equal(hashIngestToken(token).length, 64);
});

test('two ingest tokens resolve to different user_ids', async () => {
  const { store, rows } = memoryIngestTokenStore();
  const mintA = await store.mint({ userId: USER_A, label: 'phone-a' });
  const mintB = await store.mint({ userId: USER_B, label: 'phone-b' });
  assert.equal(rows.size, 2);

  const userA = await resolvePushUser({
    headers: { authorization: `Bearer ${mintA.token}` },
    cfg: CFG,
    ingestTokenStore: store,
    ingestSecret: 'dev-secret',
    localUserId: USER_A,
  });
  const userB = await resolvePushUser({
    headers: { authorization: `Bearer ${mintB.token}` },
    cfg: CFG,
    ingestTokenStore: store,
    ingestSecret: 'dev-secret',
    localUserId: USER_A,
  });
  assert.equal(userA.id, USER_A);
  assert.equal(userA.source, 'ingest_token');
  assert.equal(userB.id, USER_B);
  assert.equal(userB.source, 'ingest_token');
});

test('revoked ingest token is rejected', async () => {
  const { store } = memoryIngestTokenStore();
  const minted = await store.mint({ userId: USER_A, label: 'revoke-me' });
  const revoked = await store.revoke({ userId: USER_A, id: minted.row.id });
  assert.ok(revoked.revokedAt);

  await assert.rejects(
    () => resolvePushUser({
      headers: { authorization: `Bearer ${minted.token}` },
      cfg: CFG,
      ingestTokenStore: store,
      ingestSecret: 'dev-secret',
      localUserId: USER_A,
    }),
    IdentityError,
  );
});

test('invalid jwt does not fall through to ingest token or dev user', async () => {
  const { store } = memoryIngestTokenStore();
  const minted = await store.mint({ userId: USER_A, label: 'should-not-match' });
  const expiredJwt = fakeJwt(JWT_USER);

  await assert.rejects(
    () => resolvePushUser({
      headers: {
        authorization: `Bearer ${expiredJwt}`,
        'x-frwhoop-device-token': 'secret',
      },
      cfg: {
        ...CFG,
        deviceToken: 'secret',
        allowDevUser: true,
        nodeEnv: 'development',
      },
      fetchImpl: async () => ({ ok: false, json: async () => null }),
      ingestTokenStore: store,
      ingestSecret: minted.token,
      localUserId: USER_A,
    }),
    IdentityError,
  );
});

test('jwt user wins over ingest token when both could apply', async () => {
  const { store } = memoryIngestTokenStore();
  const minted = await store.mint({ userId: USER_A, label: 'unused' });
  const jwt = fakeJwt(JWT_USER);
  const user = await resolvePushUser({
    headers: { authorization: `Bearer ${jwt}` },
    cfg: CFG,
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: JWT_USER }) }),
    ingestTokenStore: store,
    ingestSecret: minted.token,
    localUserId: USER_A,
  });
  assert.equal(user.id, JWT_USER);
  assert.equal(user.source, 'jwt');
});

test('production push with ingest token works when allowDevUser is false', async () => {
  const { store } = memoryIngestTokenStore();
  const minted = await store.mint({ userId: USER_B, label: 'prod-phone' });
  const user = await resolvePushUser({
    headers: { authorization: `Bearer ${minted.token}` },
    cfg: { ...CFG, allowDevUser: false, nodeEnv: 'production' },
    ingestTokenStore: store,
    ingestSecret: 'engine-rpc-secret',
    localUserId: USER_A,
  });
  assert.equal(user.id, USER_B);
  assert.equal(user.source, 'ingest_token');
});

test('push routes isolate users by ingest token', async () => {
  const { store } = memoryIngestTokenStore();
  const tokenA = await store.mint({ userId: USER_A, label: 'a' });
  const tokenB = await store.mint({ userId: USER_B, label: 'b' });
  const seen = [];

  const app = express();
  registerPushRoutes(app, {
    pushIngest: {
      acceptBatch: async ({ userId }) => {
        seen.push(userId);
        return { status: 'accepted', batchId: 'x', stream: 'hrSample', acceptedRows: 0 };
      },
    },
    resolvePushUser: async (req, res) => {
      try {
        return await resolvePushUser({
          headers: req.headers,
          cfg: CFG,
          ingestTokenStore: store,
          ingestSecret: 'dev',
          localUserId: USER_A,
        });
      } catch (err) {
        res.status(err.status || 401).json({ error: err.message || 'unauthorized' });
        return null;
      }
    },
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  try {
    const capA = await fetch(`http://127.0.0.1:${port}/api/push`, {
      headers: { authorization: `Bearer ${tokenA.token}`, 'noop-push-accept-version': '1.0' },
    });
    const capB = await fetch(`http://127.0.0.1:${port}/api/push`, {
      headers: { authorization: `Bearer ${tokenB.token}`, 'noop-push-accept-version': '1.0' },
    });
    assert.equal(capA.status, 200);
    assert.equal(capB.status, 200);
    const bodyA = await capA.json();
    const bodyB = await capB.json();
    assert.equal(bodyA.userId, USER_A);
    assert.equal(bodyB.userId, USER_B);

    const revoked = await store.revoke({ userId: USER_A, id: tokenA.row.id });
    assert.ok(revoked.revokedAt);
    const denied = await fetch(`http://127.0.0.1:${port}/api/push`, {
      headers: { authorization: `Bearer ${tokenA.token}`, 'noop-push-accept-version': '1.0' },
    });
    assert.equal(denied.status, 401);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('mint route returns token once and list omits secret', async () => {
  const { store } = memoryIngestTokenStore();
  const app = express();
  app.use(express.json());
  registerPushTokenRoutes(app, {
    ingestTokenStore: store,
    requestUser: async (req, res) => {
      const auth = req.headers.authorization || '';
      if (auth === `Bearer jwt-${USER_A}`) return { id: USER_A, source: 'jwt' };
      res.status(401).json({ error: 'authentication required' });
      return null;
    },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const auth = { authorization: `Bearer jwt-${USER_A}`, 'content-type': 'application/json' };
  try {
    const minted = await fetch(`http://127.0.0.1:${port}/api/push/tokens`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ label: 'my phone' }),
    });
    assert.equal(minted.status, 201);
    const body = await minted.json();
    assert.match(body.token, /^noop_/);
    assert.equal(body.label, 'my phone');
    assert.ok(body.id);

    const listed = await fetch(`http://127.0.0.1:${port}/api/push/tokens`, { headers: auth });
    const listBody = await listed.json();
    assert.equal(listBody.tokens.length, 1);
    assert.equal(listBody.tokens[0].id, body.id);
    assert.equal(listBody.tokens[0].token, undefined);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('noop_ingest_tokens migration pins schema contract', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = fileURLToPath(new URL('.', import.meta.url));
  const sql = readFileSync(join(here, '../../supabase/migrations/20260907140000_noop_ingest_tokens.sql'), 'utf8');
  assert.match(sql, /create table if not exists public\.noop_ingest_tokens/);
  assert.match(sql, /token_hash text not null/);
  assert.match(sql, /revoked_at timestamptz/);
  assert.match(sql, /noop_ingest_tokens_select_own/);
  assert.match(sql, /noop_ingest_tokens_service_all/);
  assert.doesNotMatch(sql, /insert into public\.noop_ingest_tokens.*values/i);
});
