import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCredentialsPolicy, assertServerConfig, assertProductionRuntime, jwtRole, storageConfig } from '../storage/config.js';

function jwtFor(role) {
  const payload = Buffer.from(JSON.stringify({ role, iss: 'supabase' })).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

test('b2-only config is ready without AWS', () => {
  const cfg = storageConfig({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    INGEST_SECRET: 'secret',
    B2_KEY_ID: 'kid',
    B2_APPLICATION_KEY: 'app',
    B2_BUCKET: 'FRWHOOP',
    B2_S3_ENDPOINT: 's3.us-west-004.backblazeb2.com',
  });
  assert.equal(cfg.rawStore, 'b2');
  assert.equal(cfg.derivedStore, 'b2');
  assert.equal(cfg.b2S3Endpoint, 'https://s3.us-west-004.backblazeb2.com');
  assert.deepEqual(assertServerConfig(cfg), []);
});

test('anon JWT is not treated as a service role key', () => {
  const anon = jwtFor('anon');
  const cfg = storageConfig({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: anon,
    SERVICE_ROLE_KEY: anon,
    B2_KEY_ID: 'kid',
    B2_APPLICATION_KEY: 'app',
    B2_BUCKET: 'FRWHOOP',
    INGEST_SECRET: 'secret',
  });
  assert.equal(jwtRole(anon), 'anon');
  assert.equal(cfg.supabaseServiceRoleKey, '');
});

test('opaque secret keys are treated as service role', () => {
  const cfg = storageConfig({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    B2_KEY_ID: 'kid',
    B2_APPLICATION_KEY: 'app',
    B2_BUCKET: 'FRWHOOP',
  });
  assert.equal(cfg.supabaseServiceRoleKey, 'service-key');
});

test('service_role JWT is accepted', () => {
  const svc = jwtFor('service_role');
  const cfg = storageConfig({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: svc,
    B2_KEY_ID: 'kid',
    B2_APPLICATION_KEY: 'app',
    B2_BUCKET: 'FRWHOOP',
  });
  assert.equal(cfg.supabaseServiceRoleKey, svc);
  assert.deepEqual(assertServerConfig(cfg), []);
});

test('credentials policy fails closed when a token integration is enabled without a key', () => {
  assert.throws(
    () => assertCredentialsPolicy({ credentialsKey: '' }, { STRAVA_CLIENT_ID: '1', STRAVA_CLIENT_SECRET: 's' }),
    /FRWHOOP_CREDENTIALS_KEY/,
  );
  assert.doesNotThrow(() => assertCredentialsPolicy({ credentialsKey: '' }, {}));
  assert.doesNotThrow(() => assertCredentialsPolicy(
    { credentialsKey: 'ab'.repeat(32) },
    { STRAVA_CLIENT_ID: '1', STRAVA_CLIENT_SECRET: 's' },
  ));
});

test('production requires service role, ingest secret, and B2 together', () => {
  const env = {
    NODE_ENV: 'production',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    INGEST_SECRET: 'secret',
    B2_KEY_ID: 'kid',
    B2_APPLICATION_KEY: 'app',
    B2_BUCKET: 'FRWHOOP',
  };
  const rpcOnly = storageConfig(env);
  const missing = assertProductionRuntime(rpcOnly, env);
  assert.ok(missing.includes('SUPABASE_SERVICE_ROLE_KEY'));
  assert.ok(missing.includes('FRWHOOP_DEVICE_TOKEN'));
  assert.equal(rpcOnly.localUserId, '');
  assert.equal(rpcOnly.allowDevUser, false);
});

test('production is ready only with full persistence credentials', () => {
  const env = {
    NODE_ENV: 'production',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: jwtFor('service_role'),
    INGEST_SECRET: 'ingest',
    B2_KEY_ID: 'kid',
    B2_APPLICATION_KEY: 'app',
    B2_BUCKET: 'FRWHOOP',
    RAW_STORE: 'b2',
    DERIVED_STORE: 'b2',
    FRWHOOP_DEVICE_TOKEN: 'phone-token',
  };
  const cfg = storageConfig(env);
  assert.deepEqual(assertProductionRuntime(cfg, env), []);
});

test('empty production env lists every required secret', () => {
  const env = { NODE_ENV: 'production', FRWHOOP_RUNTIME: 'production' };
  const missing = assertProductionRuntime(storageConfig(env), env);
  assert.ok(missing.includes('SUPABASE_URL'));
  assert.ok(missing.includes('SUPABASE_ANON_KEY'));
  assert.ok(missing.includes('SUPABASE_SERVICE_ROLE_KEY'));
  assert.ok(missing.includes('INGEST_SECRET'));
  assert.ok(missing.includes('B2_KEY_ID/B2_APPLICATION_KEY'));
  assert.ok(missing.includes('FRWHOOP_DEVICE_TOKEN'));
});

test('production ignores FRWHOOP_LOCAL_USER_ID even when set', () => {
  const env = {
    NODE_ENV: 'production',
    FRWHOOP_LOCAL_USER_ID: '7f2c9a10-4b3e-4d8a-9c11-00000000f001',
  };
  const cfg = storageConfig(env);
  assert.equal(cfg.localUserId, '');
  assert.equal(cfg.allowDevUser, false);
});
