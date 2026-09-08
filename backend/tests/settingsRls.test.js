import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../.env') });

const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const anon = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';
const service = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const live = Boolean(url && anon && service && !/example\.supabase/.test(url));

function skip(name) {
  test(name, { skip: 'live supabase credentials not configured' }, () => {});
}

async function rest(key, pathName, { method = 'GET', body, query, prefer } = {}) {
  const res = await fetch(`${url}/rest/v1/${pathName}${query ? `?${query}` : ''}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(prefer ? { prefer } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  return { ok: res.ok, status: res.status, json };
}

async function adminCreateUser(email, password) {
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: service,
      authorization: `Bearer ${service}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`admin create failed ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function adminDeleteUser(id) {
  await fetch(`${url}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    headers: { apikey: service, authorization: `Bearer ${service}` },
  });
}

async function passwordSession(email, password) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: anon,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`login failed ${res.status}`);
  return json;
}

async function authed(accessToken, pathName, opts = {}) {
  const res = await fetch(`${url}/rest/v1/${pathName}${opts.query ? `?${opts.query}` : ''}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: anon,
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      ...(opts.prefer ? { prefer: opts.prefer } : {}),
    },
    body: opts.body == null ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  return { ok: res.ok, status: res.status, json };
}

if (!live) {
  skip('new user receives default settings');
  skip('user A cannot read or write user B settings');
  skip('unauthenticated and expired tokens are rejected');
  skip('account deletion removes settings');
  skip('invalid settings values are rejected');
  skip('anonymous signup is disabled or receives default settings');
  skip('two sessions update independent fields without clobbering');
  skip('expired and junk JWTs are rejected; privileged RPCs are not client-callable');
} else {
  const stamp = Date.now();
  const password = `Test-${stamp}-Aa1!`;
  const emailA = `frwhoop-rls-a-${stamp}@example.com`;
  const emailB = `frwhoop-rls-b-${stamp}@example.com`;
  let userA;
  let userB;
  let sessionA;
  let sessionB;

  test('new user receives default settings and cannot see another user', async (t) => {
    t.after(async () => {
      if (userA?.id) await adminDeleteUser(userA.id);
      if (userB?.id) await adminDeleteUser(userB.id);
    });

    userA = await adminCreateUser(emailA, password);
    userB = await adminCreateUser(emailB, password);
    sessionA = await passwordSession(emailA, password);
    sessionB = await passwordSession(emailB, password);

    const created = await rest(service, 'user_settings', {
      query: `user_id=eq.${userA.id}&select=*`,
    });
    if (!created.json?.[0]) {
      await authed(sessionA.access_token, 'user_settings', {
        method: 'POST',
        body: { user_id: userA.id },
        prefer: 'return=representation',
      });
    }
    const mine = await authed(sessionA.access_token, 'user_settings', {
      query: `select=*`,
    });
    assert.equal(mine.ok, true, JSON.stringify(mine.json));
    const row = Array.isArray(mine.json) ? mine.json[0] : mine.json;
    assert.equal(row.user_id, userA.id);
    assert.equal(row.units, 'imperial');
    assert.equal(row.calories_goal, 2400);
    assert.equal(row.steps_goal, 10000);
    assert.equal(row.activity_goal, 'moderate');
    assert.equal(row.sleep_mode, 'PEAK');

    const other = await authed(sessionA.access_token, 'user_settings', {
      query: `user_id=eq.${userB.id}&select=*`,
    });
    assert.equal(other.ok, true);
    assert.equal((other.json || []).length, 0);

    const steal = await authed(sessionA.access_token, 'user_settings', {
      method: 'PATCH',
      query: `user_id=eq.${userB.id}`,
      body: { units: 'metric' },
      prefer: 'return=representation',
    });
    assert.equal((steal.json || []).length, 0);

    const patch = await authed(sessionA.access_token, 'user_settings', {
      method: 'PATCH',
      query: `user_id=eq.${userA.id}`,
      body: { steps_goal: 12000, units: 'metric' },
      prefer: 'return=representation',
    });
    assert.equal(patch.ok, true, JSON.stringify(patch.json));
    const updated = Array.isArray(patch.json) ? patch.json[0] : patch.json;
    assert.equal(updated.steps_goal, 12000);
    assert.equal(updated.units, 'metric');

    const invalid = await authed(sessionA.access_token, 'user_settings', {
      method: 'PATCH',
      query: `user_id=eq.${userA.id}`,
      body: { units: 'stone' },
    });
    assert.equal(invalid.ok, false);

    const anonRead = await rest(anon, 'user_settings', { query: 'select=*' });
    assert.ok(anonRead.status === 401 || anonRead.status === 403 || (anonRead.json || []).length === 0);

    await adminDeleteUser(userA.id);
    userA = null;
    const gone = await rest(service, 'user_settings', { query: `user_id=eq.${sessionA.user.id}&select=user_id` });
    assert.equal((gone.json || []).length, 0);
  });

  test('anonymous signup is disabled or receives default settings', async (t) => {
    const res = await fetch(`${url}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: anon, authorization: `Bearer ${anon}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const json = await res.json();
    const disabled = res.status === 422 || res.status === 403
      || json?.error_code === 'anonymous_provider_disabled'
      || /anonymous/i.test(JSON.stringify(json));
    if (disabled && !res.ok) {
      t.skip('anonymous sign-ins are disabled in this project (intentional)');
      return;
    }
    const userId = json.user?.id || json.id;
    const token = json.access_token || json.session?.access_token;
    t.after(async () => { if (userId) await adminDeleteUser(userId); });
    assert.equal(res.ok, true, JSON.stringify(json));
    assert.ok(token);
    const mine = await authed(token, 'user_settings', { query: 'select=*' });
    assert.equal(mine.ok, true, JSON.stringify(mine.json));
    const row = Array.isArray(mine.json) ? mine.json[0] : mine.json;
    assert.equal(row.user_id, userId);
    assert.equal(row.units, 'imperial');
    assert.equal(row.steps_goal, 10000);
    assert.equal(row.calories_goal, 2400);
  });

  test('two sessions update independent fields without clobbering', async (t) => {
    const email = `frwhoop-rls-sess-${stamp}@example.com`;
    const user = await adminCreateUser(email, password);
    t.after(async () => { if (user?.id) await adminDeleteUser(user.id); });
    const s1 = await passwordSession(email, password);
    const s2 = await passwordSession(email, password);
    const existing = await authed(s1.access_token, 'user_settings', { query: 'select=user_id' });
    if (!(existing.json || []).length) {
      await authed(s1.access_token, 'user_settings', {
        method: 'POST',
        body: { user_id: user.id },
        prefer: 'return=minimal',
      });
    }
    const a = await authed(s1.access_token, 'user_settings', {
      method: 'PATCH',
      query: `user_id=eq.${user.id}`,
      body: { units: 'metric' },
      prefer: 'return=representation',
    });
    assert.equal(a.ok, true, JSON.stringify(a.json));
    const b = await authed(s2.access_token, 'user_settings', {
      method: 'PATCH',
      query: `user_id=eq.${user.id}`,
      body: { steps_goal: 12000 },
      prefer: 'return=representation',
    });
    assert.equal(b.ok, true, JSON.stringify(b.json));
    const row = Array.isArray(b.json) ? b.json[0] : b.json;
    assert.equal(row.units, 'metric');
    assert.equal(row.steps_goal, 12000);
    const same = await authed(s1.access_token, 'user_settings', {
      method: 'PATCH',
      query: `user_id=eq.${user.id}`,
      body: { steps_goal: 8000 },
      prefer: 'return=representation',
    });
    const last = Array.isArray(same.json) ? same.json[0] : same.json;
    assert.equal(last.steps_goal, 8000);
    assert.equal(last.units, 'metric');
  });

  test('expired and junk JWTs are rejected; privileged RPCs are not client-callable', async () => {
    const junk = await authed('not-a-jwt', 'user_settings', { query: 'select=*' });
    assert.ok(junk.status === 401 || junk.status === 403);

    const expired = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ role: 'authenticated', exp: 1, sub: '00000000-0000-4000-8000-000000000000' })).toString('base64url'),
      'sig',
    ].join('.');
    const expiredRes = await authed(expired, 'user_settings', { query: 'select=*' });
    assert.ok(expiredRes.status === 401 || expiredRes.status === 403);

    const missing = await fetch(`${url}/rest/v1/rpc/app_get_settings`, {
      method: 'POST',
      headers: { apikey: anon, authorization: `Bearer ${anon}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_secret: 'x', p_user_key: 'x' }),
    });
    assert.ok(missing.status === 404 || missing.status === 400 || missing.status === 410);

    const ingest = await fetch(`${url}/rest/v1/rpc/engine_ingest_upsert`, {
      method: 'POST',
      headers: { apikey: anon, authorization: `Bearer ${anon}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_secret: 'x', p_payload: {} }),
    });
    assert.ok(ingest.status === 401 || ingest.status === 403 || ingest.status === 404);
  });
}
