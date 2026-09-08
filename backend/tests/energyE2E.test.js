/**
 * Energy expenditure integration tests.
 *
 * Covers the seam the unit tests deliberately skip: BLE samples through the
 * archive, the metric engine, the repository, the ingest RPC payload, and out to
 * the HTTP routes the phone actually calls. Everything external is a stub, so a
 * failure here is a wiring failure, not a network flake.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { encodeArchive } from '../ingest/archiveFormat.js';
import { createMetricsEngine } from '../metrics/engine.js';
import { createMetricsDb } from '../metrics/repository.js';
import { registerEnergyRoutes } from '../energy/routes.js';
import { computeEnergy } from '../energy/service.js';
import { resolvePhysiology } from '../energy/physiology.js';
import { estimateVo2FromHr, routeEstimate } from '../energy/estimators.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const PROFILE = { birthYear: 1994, sex: 'male', heightCm: 178, weightKg: 74, restingHr: 48 };

/** A day with a sleep block, a sedentary morning, and a 40-minute run. */
function dayOfSamples(dayUtc = Date.UTC(2026, 7, 24)) {
  const samples = [];
  const at = (min) => new Date(dayUtc + min * 60_000).toISOString();
  for (let m = 0; m < 420; m += 1) {
    samples.push({ datetime: at(m), bpm: 50 + (m % 4), sleep_stage: 'light', motion: 0.01 });
  }
  for (let m = 420; m < 600; m += 1) {
    samples.push({ datetime: at(m), bpm: 62 + (m % 5), sleep_stage: 'none', motion: 0.05 });
  }
  for (let m = 600; m < 640; m += 1) {
    samples.push({ datetime: at(m), bpm: 155 + (m % 6), sleep_stage: 'none', motion: 0.9 });
  }
  for (let m = 640; m < 1440; m += 1) {
    samples.push({ datetime: at(m), bpm: 68 + (m % 6), sleep_stage: 'none', motion: 0.08 });
  }
  return samples;
}

function stubStores(blobs) {
  return {
    raw: {
      async putObject(key, body) { blobs.set(key, body); return { etag: '"x"', bytes: body.length }; },
      async head(key) {
        const b = blobs.get(key);
        return b ? { exists: true, contentLength: b.length } : null;
      },
    },
    derived: {
      async putObject(key, body) { blobs.set(key, body); return { etag: '"y"', bytes: body.length }; },
    },
  };
}

test('e2e: BLE samples → B2 archive → engine → energy RPC payload → Supabase rollup', async () => {
  const blobs = new Map();
  const payloads = [];
  const db = {
    async upsertPayload(payload) { payloads.push(payload); return { ok: true }; },
    async loadUserDays() { return { daily_metrics: [], sleep_nights: [], sessions: [] }; },
  };
  const engine = createMetricsEngine({
    cfg: { localUserId: USER, rawStore: 'b2', derivedStore: 'b2', b2Bucket: 'FRWHOOP', buildHash: 'test' },
    stores: stubStores(blobs),
    db,
    energyContext: async () => ({ profile: PROFILE, timeZone: 'UTC', workouts: [] }),
  });

  const samples = dayOfSamples();
  // The archive is what makes recomputation possible later, so assert the motion
  // channel survived it: without motion, a re-run would be HR-only.
  const archive = encodeArchive(samples);
  assert.equal(archive.sample_count, samples.length, 'every sample is archived');
  const firstRow = JSON.parse(gunzipSync(archive.body).toString('utf8').split('\n')[0]);
  assert.ok(firstRow.mot != null, 'motion is preserved in the raw archive');

  await engine.persistComputed({
    userId: USER,
    day: '2026-08-24',
    samples,
    timeZone: 'UTC',
  });

  const energyPayload = payloads.find((p) => p.energy_minutes?.length);
  assert.ok(energyPayload, 'the engine emitted energy minutes');

  const minutes = energyPayload.energy_minutes;
  assert.equal(minutes.length, 1440, 'a fully covered day yields 1440 minute rows');

  for (const m of minutes) {
    assert.equal(m.user_id, USER, 'every row is attributed to the ingesting user');
    assert.ok(m.model_version, 'every row carries a model version');
    assert.ok(m.minute_at, 'every row is timestamped');
    assert.ok(m.active_kcal >= 0, 'active energy is never negative');
    assert.ok(m.resting_kcal > 0, 'a covered minute always costs something to be alive');
    // total_kcal is a generated column: the writer must not send one, or the two
    // halves and the total could be persisted disagreeing with each other.
    assert.equal(m.total_kcal, undefined, 'total is derived in Postgres, never written');
    assert.equal(m.debug, undefined, 'per-minute debug detail is not persisted');
  }

  // Effort has to show up as effort: 40 minutes of running must cost far more per
  // minute than the 13 hours of light evening activity around it. This is the
  // check that fails if the classifier or the router stops distinguishing them.
  const perMin = (from, to) => {
    const rows = minutes.slice(from, to);
    return rows.reduce((a, m) => a + m.active_kcal, 0) / rows.length;
  };
  const runRate = perMin(600, 640);
  assert.ok(runRate > 10, `running should exceed 10 active kcal/min, got ${runRate.toFixed(1)}`);
  assert.ok(runRate > 8 * perMin(640, 1440), 'a run costs at least 8x a light evening minute');
  assert.ok(perMin(0, 420) < 0.05, 'sleep accrues essentially no active energy');

  const dayTotal = minutes.reduce((a, m) => a + m.resting_kcal + m.active_kcal, 0);
  assert.ok(dayTotal > 2000 && dayTotal < 3600, `a 74 kg adult day should land in range, got ${dayTotal.toFixed(0)}`);

  const daily = energyPayload.daily_metrics?.[0];
  assert.ok(daily, 'daily metrics row is written with energy');
  assert.equal(typeof daily.active_kcal, 'number');
  assert.ok(daily.active_kcal > 0, 'Overview calories read daily_metrics.active_kcal');
  assert.equal(typeof daily.basal_kcal, 'number');
  assert.ok(daily.basal_kcal > 0);
});

test('an awake resting heart rate is priced as rest, not as light exercise', () => {
  // Regression: with the flex point set below the awake-and-seated band, ordinary
  // desk minutes were priced on the exercise line at ~0.11 MET/bpm, which added
  // several hundred phantom active kcal across a waking day.
  const phys = resolvePhysiology({ profile: PROFILE });
  assert.ok(phys.flexHr >= 70, `flex HR must clear the awake-seated band, got ${phys.flexHr}`);

  const metAt = (hr) => estimateVo2FromHr({ hr, motion: null }, phys, 'daily_activity', {}) / 3.5;
  assert.ok(metAt(60) < 1.15, `sitting at 60 bpm is rest, got ${metAt(60).toFixed(2)} MET`);
  assert.ok(metAt(72) < 1.3, `sitting at 72 bpm is rest, got ${metAt(72).toFixed(2)} MET`);
  // The exercise range must still climb properly, or the fix traded one bias for
  // the opposite one.
  assert.ok(metAt(140) > 8, `140 bpm is real work, got ${metAt(140).toFixed(2)} MET`);
  assert.ok(metAt(140) < 14, `140 bpm is not maximal, got ${metAt(140).toFixed(2)} MET`);
  assert.ok(metAt(100) > metAt(80) && metAt(80) > metAt(70), 'the curve is monotonic in HR');
});

test('a quiet wrist cannot claim sustained work while the heart is at rest', () => {
  // The other half of the same bias: 13 hours of desk-level wrist motion at a
  // resting heart rate must not accumulate as whole-body activity.
  const phys = resolvePhysiology({ profile: PROFILE });
  const atRest = { hr: 66, motion: 0.08, hrQuality: 1 };
  const est = routeEstimate({
    features: atRest,
    quality: { hr: 0.9, motion: 0.9, overall: 0.9 },
    physiology: phys,
    activity: 'daily_activity',
    activityConfidence: 0.6,
  });
  assert.ok(est.met < 1.6, `fidgeting at a resting HR is not 2 MET, got ${est.met.toFixed(2)}`);
});

test('the repository routes energy through the transactional RPC, never a bare table upsert', async () => {
  const calls = [];
  const db = createMetricsDb({
    cfg: {
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'service-key',
      ingestSecret: 'shhh',
      localUserId: USER,
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body || '{}') });
      return { ok: true, status: 200, async text() { return '{}'; } };
    },
  });

  const result = computeEnergy({ samples: dayOfSamples(), userId: USER, timeZone: 'UTC', profile: PROFILE });
  await db.upsertPayload({ user_id: USER, energy_minutes: result.rows.slice(0, 5) });

  const rpcCalls = calls.filter((c) => c.url.includes('/rpc/engine_ingest_energy'));
  assert.equal(rpcCalls.length, 1, 'exactly one energy RPC call');
  assert.equal(rpcCalls[0].body.p_secret, 'shhh', 'the ingest secret is presented');
  assert.equal(rpcCalls[0].body.p_payload.energy_minutes.length, 5);
  assert.ok(
    !calls.some((c) => /\/rest\/v1\/energy_minutes/.test(c.url)),
    'energy rows never bypass the RPC into a direct table write',
  );
});

test('re-ingesting the same batch produces byte-identical RPC arguments', async () => {
  const bodies = [];
  const mk = () => createMetricsDb({
    cfg: {
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'k',
      ingestSecret: 's',
      localUserId: USER,
    },
    fetchImpl: async (url, init) => {
      if (String(url).includes('engine_ingest_energy')) bodies.push(init.body);
      return { ok: true, status: 200, async text() { return '{}'; } };
    },
  });

  const samples = dayOfSamples();
  for (let i = 0; i < 2; i += 1) {
    const out = computeEnergy({ samples, userId: USER, timeZone: 'UTC', profile: PROFILE });
    await mk().upsertPayload({ user_id: USER, energy_minutes: out.rows });
  }
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1], 'a duplicate upload is a no-op at the byte level');
});

/* --------------------------------- routes ---------------------------------- */

/** Minimal express double: records handlers, then invokes them directly. */
function fakeApp() {
  const routes = new Map();
  return {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    async call(method, path, { query = {}, params = {}, headers = {} } = {}) {
      const handler = routes.get(`${method} ${path}`);
      assert.ok(handler, `route ${method} ${path} is registered`);
      let status = 200;
      let body = null;
      const res = {
        status(code) { status = code; return res; },
        json(payload) { body = payload; return res; },
      };
      await handler({ query, params, headers }, res);
      return { status, body };
    },
    paths: routes,
  };
}

function routeDeps(overrides = {}) {
  return {
    requestUser: async () => ({ id: USER }),
    energyContextFor: async () => ({ profile: PROFILE, timeZone: 'UTC', workouts: [] }),
    liveSamplesFor: () => [],
    localSamplesForDay: () => [],
    rpc: null,
    ...overrides,
  };
}

test('the three documented energy endpoints are registered', () => {
  const app = fakeApp();
  registerEnergyRoutes(app, routeDeps());
  assert.ok(app.paths.has('GET /api/energy/day'));
  assert.ok(app.paths.has('GET /api/energy/range'));
  assert.ok(app.paths.has('GET /api/energy/workout/:id'));
});

test('a day with no confirmed rollup is served provisionally from the live buffer', async () => {
  const app = fakeApp();
  const samples = dayOfSamples();
  registerEnergyRoutes(app, routeDeps({ liveSamplesFor: () => samples }));

  const { status, body } = await app.call('GET', '/api/energy/day', { query: { day: '2026-08-24' } });
  assert.equal(status, 200);
  assert.equal(body.state, 'provisional', 'unarchived data is labelled, not passed off as confirmed');
  assert.ok(body.daily.total_kcal > 0);
  assert.ok(body.buckets.length > 1, 'the day is bucketed for charting rather than sent minute by minute');
  assert.ok(body.buckets.length <= 96, '15-minute buckets cap a day at 96 points');
});

test('a missing Supabase JWT falls back to the local energy engine', async () => {
  const app = fakeApp();
  registerEnergyRoutes(app, routeDeps({
    liveSamplesFor: () => dayOfSamples(),
    rpc: {
      async call() { throw new Error('bearer_token_required'); },
    },
  }));
  const { status, body } = await app.call('GET', '/api/energy/day', { query: { day: '2026-08-24' } });
  assert.equal(status, 200);
  assert.equal(body.state, 'provisional');
  assert.ok(body.daily.total_kcal > 2000, `engine total should be a full-day burn, got ${body.daily.total_kcal}`);
});

test('local day files feed the engine when the live buffer is empty', async () => {
  const app = fakeApp();
  registerEnergyRoutes(app, routeDeps({
    liveSamplesFor: () => [],
    localSamplesForDay: (_uid, day) => (day === '2026-08-24' ? dayOfSamples() : []),
  }));
  const { status, body } = await app.call('GET', '/api/energy/day', { query: { day: '2026-08-24' } });
  assert.equal(status, 200);
  assert.equal(body.state, 'provisional');
  assert.ok(body.daily.total_kcal > 0);
});

test('sparse live buffer is unioned with local day files, not preferred over them', async () => {
  const app = fakeApp();
  registerEnergyRoutes(app, routeDeps({
    liveSamplesFor: () => dayOfSamples().slice(0, 20),
    localSamplesForDay: () => dayOfSamples(),
  }));
  const { body } = await app.call('GET', '/api/energy/day', { query: { day: '2026-08-24' } });
  assert.equal(body.state, 'provisional');
  assert.ok(body.daily.coverage_minutes > 200, `union should keep the full day, got ${body.daily.coverage_minutes}`);
});

test('a richer local recompute beats a thin confirmed rollup', async () => {
  const app = fakeApp();
  registerEnergyRoutes(app, routeDeps({
    liveSamplesFor: () => dayOfSamples(),
    rpc: {
      async call() {
        return {
          day: '2026-08-24',
          daily: { total_kcal: 80, active_kcal: 10, resting_kcal: 70, coverage_minutes: 40 },
          workouts: [],
          buckets: [],
        };
      },
    },
  }));
  const { body } = await app.call('GET', '/api/energy/day', { query: { day: '2026-08-24' } });
  assert.ok(body.daily.total_kcal > 2000, `local engine should win, got ${body.daily.total_kcal}`);
});

test('a confirmed day is preferred over the local recomputation of the same day', async () => {
  const app = fakeApp();
  registerEnergyRoutes(app, routeDeps({
    liveSamplesFor: () => dayOfSamples(),
    rpc: {
      async call(name) {
        assert.equal(name, 'get_energy_day');
        return {
          day: '2026-08-24',
          daily: { total_kcal: 2600, active_kcal: 900, resting_kcal: 1700, coverage_minutes: 1440 },
          workouts: [],
          buckets: [],
        };
      },
    },
  }));

  const { body } = await app.call('GET', '/api/energy/day', {
    query: { day: '2026-08-24' },
    headers: { authorization: 'Bearer user-jwt' },
  });
  assert.equal(body.daily.total_kcal, 2600, 'the backend rollup is authoritative');
  assert.equal(body.state, 'confirmed');
});

test('an unauthenticated request never reaches the energy engine', async () => {
  const app = fakeApp();
  let engineRan = false;
  registerEnergyRoutes(app, routeDeps({
    requestUser: async () => null,
    liveSamplesFor: () => { engineRan = true; return dayOfSamples(); },
  }));
  const { body } = await app.call('GET', '/api/energy/day', { query: { day: '2026-08-24' } });
  assert.equal(body, null, 'the handler returns without writing a body; auth already replied');
  assert.equal(engineRan, false, 'no computation is done for an unauthenticated caller');
});

test('a caller cannot read another user by passing a user_id', async () => {
  const app = fakeApp();
  const seen = [];
  registerEnergyRoutes(app, routeDeps({
    liveSamplesFor: (uid) => { seen.push(uid); return []; },
  }));
  await app.call('GET', '/api/energy/day', { query: { day: '2026-08-24', user_id: OTHER } });
  assert.deepEqual(seen, [USER], 'the identity comes from the session, never the query string');
});

test('a malformed day is rejected before any work happens', async () => {
  const app = fakeApp();
  registerEnergyRoutes(app, routeDeps({
    liveSamplesFor: () => { throw new Error('should not be reached'); },
  }));
  const { status, body } = await app.call('GET', '/api/energy/day', { query: { day: 'yesterday' } });
  assert.equal(status, 400);
  assert.equal(body.error, 'invalid_day');
});

test('workout energy is looked up by session id and 404s when absent', async () => {
  const app = fakeApp();
  registerEnergyRoutes(app, routeDeps({
    rpc: { async call() { return { workout: null }; } },
  }));
  const { status } = await app.call('GET', '/api/energy/workout/:id', {
    params: { id: '33333333-3333-4333-8333-333333333333' },
    headers: { authorization: 'Bearer jwt' },
  });
  assert.equal(status, 404);
});

test('a workout id that is not a uuid is rejected, not forwarded to Postgres', async () => {
  const app = fakeApp();
  let forwarded = false;
  registerEnergyRoutes(app, routeDeps({
    rpc: { async call() { forwarded = true; return {}; } },
  }));
  const { status } = await app.call('GET', '/api/energy/workout/:id', {
    params: { id: "'; drop table energy_minutes; --" },
    headers: { authorization: 'Bearer jwt' },
  });
  assert.equal(status, 400);
  assert.equal(forwarded, false);
});

test('trends fall back to local day files when Supabase is not configured', async () => {
  const app = fakeApp();
  const byDay = { '2026-08-24': dayOfSamples() };
  registerEnergyRoutes(app, routeDeps({
    localSamplesForDay: (_uid, day) => byDay[day] || [],
  }));
  const { body } = await app.call('GET', '/api/energy/range', {
    query: { from: '2026-08-20', to: '2026-08-26' },
  });
  assert.equal(body.days.length, 1, 'only days with samples appear');
  assert.equal(body.days[0].day, '2026-08-24');
  assert.equal(body.state, 'provisional');
});

test('an oversized range is clamped rather than recomputing a year on request', async () => {
  const app = fakeApp();
  let daysProbed = 0;
  registerEnergyRoutes(app, routeDeps({
    localSamplesForDay: () => { daysProbed += 1; return []; },
  }));
  await app.call('GET', '/api/energy/range', { query: { from: '2020-01-01', to: '2026-12-31' } });
  assert.ok(daysProbed <= 62, `local recomputation is capped, probed ${daysProbed}`);
});
