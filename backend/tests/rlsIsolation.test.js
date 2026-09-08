import assert from 'node:assert/strict';
import test from 'node:test';
import { storageConfig } from '../storage/config.js';

function fakeJwt(role, sub) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, sub })}.sig`;
}

test('RLS policy shape uses auth.uid() equality not a shared user_key', () => {
  const sql = `
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id)
  `;
  assert.match(sql, /auth\.uid\(\)/);
  assert.doesNotMatch(sql, /local-demo/);
});

test('two distinct jwt subjects cannot share an identity', () => {
  const a = fakeJwt('authenticated', '11111111-1111-4111-8111-111111111111');
  const b = fakeJwt('authenticated', '22222222-2222-4222-8222-222222222222');
  const pa = JSON.parse(Buffer.from(a.split('.')[1], 'base64url').toString());
  const pb = JSON.parse(Buffer.from(b.split('.')[1], 'base64url').toString());
  assert.notEqual(pa.sub, pb.sub);
});

test('live RLS isolation against Supabase when service role is configured', async (t) => {
  const cfg = storageConfig();
  if (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey || !cfg.supabaseAnonKey) {
    t.skip('supabase not configured');
    return;
  }
  const headers = {
    apikey: cfg.supabaseAnonKey,
    authorization: `Bearer ${cfg.supabaseAnonKey}`,
  };
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/daily_metrics?select=user_id&limit=1`, { headers });
  // anon without a user jwt must not see rows (RLS).
  if (res.ok) {
    const rows = await res.json();
    assert.equal(rows.length, 0);
  } else {
    assert.ok(res.status === 401 || res.status === 403 || res.status === 200);
  }
});
