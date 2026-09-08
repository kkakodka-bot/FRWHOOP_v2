import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudSync, cloudConfigured, DEFAULT_USER_KEY, resolveCloudTransport } from '../settings/cloudSync.js';
import { publicIntegration } from '../settings/routes.js';
import { applyCloudWorkoutSettings, workoutRuntimeView } from '../host/runtimePrefs.js';
import {
  athleteMeta,
  authorizeUrl,
  exchangeCode,
  refreshTokens,
  stravaConfig,
  tokensExpired,
} from '../integrations/strava.js';

function fakeJwt(role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role })}.sig`;
}

const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: fakeJwt('anon'),
  SUPABASE_SERVICE_ROLE_KEY: fakeJwt('service_role'),
  FRWHOOP_CREDENTIALS_KEY: 'ab'.repeat(32),
};

const RPC_ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: fakeJwt('anon'),
  INGEST_SECRET: 'test-secret',
};

function mockFetch(captured, responder) {
  return async (url, opts = {}) => {
    captured.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    return responder(url, opts);
  };
}

const okJson = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });

test('cloud sync is disabled without a service role key', async () => {
  assert.equal(cloudConfigured({}), false);
  const sync = createCloudSync({ env: {} });
  assert.equal(sync.configured, false);
  const ping = await sync.cloudPing();
  assert.equal(ping.configured, false);
  assert.equal(ping.reachable, false);
});

test('pushSettings writes typed user_settings columns', async () => {
  const captured = [];
  const sync = createCloudSync({ env: ENV, fetchImpl: mockFetch(captured, () => okJson(null)) });
  assert.equal(await sync.pushSettings(DEFAULT_USER_KEY, { units: 'metric', notificationsApp: true }), true);
  assert.equal(captured.length, 1);
  assert.match(captured[0].url, /user_settings\?on_conflict=user_id/);
  const body = JSON.parse(captured[0].body);
  assert.equal(body.user_id, DEFAULT_USER_KEY);
  assert.equal(body.units, 'metric');
  assert.equal(body.notifications_enabled, true);
  assert.equal(body.settings, undefined);

  const pulled = await createCloudSync({
    env: ENV,
    fetchImpl: mockFetch([], () => okJson([{
      user_id: DEFAULT_USER_KEY,
      units: 'metric',
      notifications_enabled: true,
      updated_at: '2026-08-23T00:00:00Z',
    }])),
  }).pullSettings(DEFAULT_USER_KEY);
  assert.equal(pulled.settings.units, 'metric');
});

test('a saved strap-buzz setting survives the trip back into detector flags', async () => {
  // Fresh host: local prefs are at their defaults, so the buzz is off until the
  // saved setting is pulled back down. Losing the flag anywhere along this path
  // means a confirmed workout silently never buzzes.
  const pulled = await createCloudSync({
    env: ENV,
    fetchImpl: mockFetch([], () => okJson([{
      user_id: DEFAULT_USER_KEY,
      haptic_alerts_enabled: true,
      auto_workout_detect: true,
      auto_workout_haptics_enabled: true,
      auto_workout_min_confidence: 'high',
      auto_workout_rollout_percentage: 100,
    }])),
  }).pullSettings(DEFAULT_USER_KEY);

  assert.equal(workoutRuntimeView({}).autoWorkoutHaptics, false);
  const seeded = workoutRuntimeView(applyCloudWorkoutSettings({}, pulled.settings));
  assert.equal(seeded.autoWorkoutHaptics, true);
  assert.equal(seeded.autoWorkoutDetect, true);
  assert.equal(seeded.hapticAlerts, true);
  assert.equal(seeded.autoWorkoutMinConfidence, 'high');
});

test('a saved strap-buzz opt-out is not read as an opt-in', async () => {
  const pulled = await createCloudSync({
    env: ENV,
    fetchImpl: mockFetch([], () => okJson([{
      user_id: DEFAULT_USER_KEY,
      auto_workout_haptics_enabled: false,
      auto_workout_detect: false,
    }])),
  }).pullSettings(DEFAULT_USER_KEY);
  const seeded = workoutRuntimeView(applyCloudWorkoutSettings({}, pulled.settings));
  assert.equal(seeded.autoWorkoutHaptics, false);
  assert.equal(seeded.autoWorkoutDetect, false);
});

test('the cloud pull never overrides a flag the app already hinted', () => {
  // The pull is async, so it can land after the app's hint. Overwriting here
  // silences a buzz the app just asked for.
  const hinted = { autoWorkoutHaptics: true, autoWorkoutDetect: true };
  const merged = applyCloudWorkoutSettings(hinted, {
    autoWorkoutHaptics: false,
    autoWorkoutDetect: false,
    autoWorkoutMinConfidence: 'high',
  });
  assert.equal(merged.autoWorkoutHaptics, true);
  assert.equal(merged.autoWorkoutDetect, true);
  assert.equal(merged.autoWorkoutMinConfidence, 'high');
});

test('an anon JWT in the service slot is not treated as service access', () => {
  const sync = createCloudSync({
    env: { SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_ANON_KEY: fakeJwt('anon'), SUPABASE_SERVICE_ROLE_KEY: fakeJwt('anon') },
  });
  assert.equal(sync.mode, 'none');
  assert.equal(sync.configured, false);
  const rpc = createCloudSync({
    env: { SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_ANON_KEY: fakeJwt('anon'), SUPABASE_SERVICE_ROLE_KEY: fakeJwt('anon'), INGEST_SECRET: 's' },
  });
  assert.equal(rpc.mode, 'rpc');
});

test('service role ping hits typed user_settings', async () => {
  const captured = [];
  const sync = createCloudSync({ env: ENV, fetchImpl: mockFetch(captured, () => okJson([])) });
  const ping = await sync.cloudPing();
  assert.equal(ping.configured, true);
  assert.match(captured[0].url, /user_settings\?select=user_id/);
});

test('rpc mode daily metrics still uses the gated ingest function', async () => {
  const captured = [];
  const sync = createCloudSync({ env: RPC_ENV, fetchImpl: mockFetch(captured, () => okJson(2)) });
  const n = await sync.upsertDailyMetrics([{ user_id: 'u', day: '2026-08-24' }]);
  assert.equal(n, 2);
  assert.match(captured[0].url, /rpc\/app_upsert_daily_metrics/);
});

test('integration upsert uses typed columns and never writes a settings blob', async () => {
  const captured = [];
  const sync = createCloudSync({ env: ENV, fetchImpl: mockFetch(captured, () => okJson(null)) });
  await sync.upsertIntegration(DEFAULT_USER_KEY, 'strava', {
    status: 'connected',
    tokens: { access_token: 'x' },
    meta: { athlete: { name: 'A' } },
    connectedAt: '2026-08-23T00:00:00Z',
  });
  assert.equal(captured[0].url.split('?')[0], 'https://example.supabase.co/rest/v1/integration_connections');
  const row = JSON.parse(captured[0].body);
  assert.equal(row.user_id, DEFAULT_USER_KEY);
  assert.equal(row.provider, 'strava');
  assert.equal(row.authorization_status, 'authorized');
  assert.equal(row.connection_status, 'connected');
  assert.equal(row.tokens, undefined);
  assert.match(captured[1].url, /rpc\/engine_put_integration_secret/);
  const secretBody = JSON.parse(captured[1].body);
  assert.equal(secretBody.p_tokens.v, 'enc');
  assert.equal(JSON.stringify(secretBody).includes('access_token'), false);

  await sync.listIntegrations(DEFAULT_USER_KEY);
  assert.match(captured[2].url, /integration_connections\?user_id=eq/);

  await sync.removeIntegration(DEFAULT_USER_KEY, 'strava');
  assert.equal(captured[captured.length - 1].method, 'DELETE');
});

test('rpc mode cannot upsert integrations without a service role', async () => {
  const sync = createCloudSync({ env: RPC_ENV, fetchImpl: mockFetch([], () => okJson(null)) });
  await assert.rejects(
    () => sync.upsertIntegration(DEFAULT_USER_KEY, 'apple_health', { status: 'connected' }),
    /service_role/,
  );
});

test('token upsert fails closed without FRWHOOP_CREDENTIALS_KEY', async () => {
  const sync = createCloudSync({
    env: { ...ENV, FRWHOOP_CREDENTIALS_KEY: '' },
    fetchImpl: mockFetch([], () => okJson(null)),
  });
  await assert.rejects(
    () => sync.upsertIntegration(DEFAULT_USER_KEY, 'strava', {
      status: 'connected',
      tokens: { access_token: 'x' },
    }),
    /FRWHOOP_CREDENTIALS_KEY/,
  );
});

test('publicIntegration never leaks tokens', () => {
  const pub = publicIntegration('strava', {
    status: 'connected',
    tokens: { access_token: 'SECRET', refresh_token: 'SECRET2' },
    meta: { athlete: { id: 1, firstname: 'Rahul', lastname: 'V', profile_medium: 'p.jpg' } },
    connectedAt: '2026-08-23T00:00:00Z',
    updatedAt: '2026-08-23T01:00:00Z',
  });
  assert.equal(pub.connected, true);
  assert.equal(pub.meta.athlete.name, 'Rahul V');
  assert.equal(JSON.stringify(pub).includes('SECRET'), false);

  const empty = publicIntegration('apple_health', undefined);
  assert.equal(empty.connected, false);
  assert.equal(empty.status, 'disconnected');
});

test('strava config + authorize url', () => {
  const cfg = stravaConfig({ STRAVA_CLIENT_ID: '123', STRAVA_CLIENT_SECRET: 's', STRAVA_REDIRECT_URI: 'http://localhost:8080/cb' });
  assert.equal(cfg.configured, true);
  assert.equal(stravaConfig({}).configured, false);
  const url = authorizeUrl({ clientId: cfg.clientId, redirectUri: cfg.redirectUri, state: 'abc' });
  assert.match(url, /^https:\/\/www\.strava\.com\/oauth\/authorize\?/);
  assert.match(url, /client_id=123/);
  assert.match(url, /response_type=code/);
  assert.match(url, /state=abc/);
  assert.match(url, /scope=read%2Cactivity%3Aread_all/);
  assert.match(url, /redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcb/);
});

test('strava code exchange posts form and normalizes tokens', async () => {
  const captured = [];
  const cfg = stravaConfig({ STRAVA_CLIENT_ID: '123', STRAVA_CLIENT_SECRET: 'sec' });
  const tokens = await exchangeCode('CODE', cfg, mockFetch(captured, () => okJson({
    access_token: 'at', refresh_token: 'rt', expires_at: 1893456000,
    athlete: { id: 7, firstname: 'Rahul', lastname: 'V' },
  })));
  assert.equal(captured[0].url, 'https://www.strava.com/oauth/token');
  assert.match(captured[0].body, /grant_type=authorization_code/);
  assert.match(captured[0].body, /client_secret=sec/);
  assert.equal(tokens.access_token, 'at');
  assert.equal(tokens.athlete.id, 7);

  const refreshed = await refreshTokens('rt', cfg, mockFetch([], () => okJson({ access_token: 'at2', refresh_token: 'rt2', expires_at: 1893456000 })));
  assert.equal(refreshed.access_token, 'at2');

  await assert.rejects(
    () => exchangeCode('BAD', cfg, mockFetch([], () => ({ ok: false, status: 400, json: async () => ({ message: 'Bad Request' }) }))),
    /Bad Request/,
  );
});

test('athleteMeta + token expiry helpers', () => {
  assert.deepEqual(athleteMeta(null), {});
  assert.equal(athleteMeta({ firstname: 'A', lastname: 'B' }).name, 'A B');
  assert.equal(tokensExpired({ expires_at: Math.floor(Date.now() / 1000) - 10 }), true);
  assert.equal(tokensExpired({ expires_at: Math.floor(Date.now() / 1000) + 3600 }), false);
  assert.equal(tokensExpired({}), false);
});

test('production cloud transport has no demo userKey', () => {
  const t = resolveCloudTransport({
    NODE_ENV: 'production',
    FRWHOOP_LOCAL_USER_ID: DEFAULT_USER_KEY,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: fakeJwt('anon'),
    SUPABASE_SERVICE_ROLE_KEY: fakeJwt('service_role'),
  });
  assert.equal(t.userKey, '');
});
