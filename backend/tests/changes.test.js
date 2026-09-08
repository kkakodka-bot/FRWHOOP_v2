import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { registerHostRoutes, normalizeHostStore } from '../host/routes.js';
import { loadChangedDays } from '../metrics/snapshot.js';
import { dayBounds, localDateKey } from '../time/dayBoundary.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TZ = 'UTC';

// Tiny PostgREST-faithful filter: understands the eq/gte/lte/gt/lt clauses the
// changed-days queries emit, so the stub really enforces updated_at/day
// predicates instead of echoing canned rows.
function postgrestFilter(rows, query) {
  const clauses = String(query || '')
    .split('&')
    .filter((part) => part && !/^(select|order)=/.test(part));
  const isTs = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
  return rows.filter((row) => clauses.every((clause) => {
    const eq = clause.indexOf('=');
    if (eq < 0) return true;
    const col = clause.slice(0, eq);
    const spec = clause.slice(eq + 1);
    const dot = spec.indexOf('.');
    const op = spec.slice(0, dot);
    const raw = spec.slice(dot + 1);
    const left = row[col];
    if (op === 'eq') return String(left) === String(raw);
    if (!['gte', 'lte', 'gt', 'lt'].includes(op)) return true;
    if (isTs(left) && isTs(raw)) {
      const l = Date.parse(left);
      const r = Date.parse(raw);
      if (op === 'gte') return l >= r;
      if (op === 'lte') return l <= r;
      if (op === 'gt') return l > r;
      return l < r;
    }
    if (op === 'gte') return String(left) >= String(raw);
    if (op === 'lte') return String(left) <= String(raw);
    if (op === 'gt') return String(left) > String(raw);
    return String(left) < String(raw);
  }));
}

function stubRest(tables, calls = []) {
  return {
    configured: true,
    async select(table, query) {
      calls.push({ table, query });
      return postgrestFilter(tables[table] || [], query);
    },
  };
}

function utcKeys(now = new Date()) {
  const today = localDateKey(now, TZ);
  const yesterday = localDateKey(new Date(Date.parse(dayBounds(today, TZ).day_start_at) - 3600000), TZ);
  return { today, yesterday };
}

/** Controlled rows relative to the real clock so since-filtering is honest. */
function changedRowsFixture({ now = new Date() } = {}) {
  const fresh = new Date(Date.parse(now.toISOString()) - 5000).toISOString();
  const stale = new Date(Date.parse(now.toISOString()) - 10 * 86400e3).toISOString();
  const { today, yesterday } = utcKeys(now);
  return {
    daily_metrics: [
      {
        user_id: USER_ID,
        day: today,
        record_class: 'user',
        recovery_score: 72,
        strain_score: 8.1,
        sleep_performance_pct: 41,
        hrv_rmssd_ms: 64,
        resting_hr_bpm: 50,
        extras: {},
        provenance: {},
        timezone_name: TZ,
        updated_at: fresh,
      },
      {
        user_id: USER_ID,
        day: '2020-01-01',
        record_class: 'user',
        recovery_score: 55,
        strain_score: 2,
        extras: {},
        provenance: {},
        timezone_name: TZ,
        updated_at: stale,
      },
    ],
    sessions: [
      {
        user_id: USER_ID,
        id: 'w1',
        kind: 'workout',
        source: 'auto',
        start_at: `${yesterday}T18:00:00.000Z`,
        end_at: `${yesterday}T19:00:00.000Z`,
        summary: { sport: 'run', duration_min: 60, strain: 5.5, calories: 640 },
        segments: [],
        user_modified: false,
        updated_at: fresh,
      },
      {
        user_id: USER_ID,
        id: 'night-1',
        kind: 'sleep',
        source: 'frwhoop',
        start_at: `${yesterday}T22:30:00.000Z`,
        end_at: `${today}T06:12:00.000Z`,
        summary: {},
        segments: [],
        user_modified: false,
        updated_at: fresh,
      },
    ],
    sleep_details: [
      {
        user_id: USER_ID,
        session_id: 'night-1',
        is_nap: false,
        asleep_min: 431,
        in_bed_min: 462,
        light_min: 220,
        deep_min: 90,
        rem_min: 101,
        awake_min: 20,
        need_min: 480,
        efficiency: 0.93,
        performance_pct: 91,
        overnight_hr_bpm: 48,
        hrv_rmssd_ms: 64,
        original_start_at: `${yesterday}T22:31:00.000Z`,
        original_end_at: `${today}T06:12:00.000Z`,
        updated_at: fresh,
      },
      {
        // Wake day before the window yet inside the REST wake bounds
        // (wake >= fromDay start − 14h), so only the JS window filter can drop
        // it: it must never surface as a 2019-12-31 patch.
        user_id: USER_ID,
        session_id: 'night-0',
        is_nap: false,
        asleep_min: 300,
        original_start_at: '2019-12-31T07:00:00.000Z',
        original_end_at: '2019-12-31T15:00:00.000Z',
        updated_at: fresh,
      },
    ],
    daily_physiology_series: [
      { user_id: USER_ID, day: today, hr_series: [{ t: `${today}T20:00:00.000Z`, avg_hr: 61, samples: 12 }] },
      { user_id: USER_ID, day: '2020-01-01', hr_series: [{ t: '2020-01-01T20:00:00.000Z', avg_hr: 50, samples: 12 }] },
    ],
  };
}

test('loadChangedDays returns whoop-day patches only for rows updated after since', async () => {
  const now = new Date();
  const { today, yesterday } = utcKeys(now);
  const sinceIso = new Date(Date.parse(now.toISOString()) - 30_000).toISOString();
  const calls = [];
  const rest = stubRest(changedRowsFixture({ now }), calls);
  const days = await loadChangedDays({
    rest,
    userId: USER_ID,
    sinceIso,
    fromDay: '2020-01-01',
    toDay: today,
    timeZone: TZ,
    now,
  });

  // (a) only changed days: stale daily row (2020-01-01) and the out-of-window
  // night (wake 2020-01-02) never surface.
  assert.deepEqual(Object.keys(days).sort(), [yesterday, today]);
  assert.equal(days[today].physiological_summary['Recovery score %'], 72);
  assert.equal(days[today].sleep_summary['Asleep duration (min)'], 431);
  assert.equal(days[today].sleep_summary['Sleep efficiency %'], 93);
  assert.equal(days[today].sleep_summary['Wake onset'], `${today}T06:12:00.000Z`);
  assert.equal(days[today].physiological_summary['Resting heart rate (bpm)'], 48);
  assert.equal(days[yesterday].workouts[0]['Activity name'], 'run');
  assert.equal(days[yesterday].workouts[0]['Duration (min)'], 60);
  // sleep-only kind must not leak into workouts
  assert.equal(days[today].workouts.length, 0);

  // (b) bpm_data only for today/yesterday, and only when a series row exists:
  // the stub also returned a 2020-01-01 series row, which must not surface.
  assert.ok(Array.isArray(days[today].bpm_data) && days[today].bpm_data.length >= 1);
  assert.equal(days[yesterday].bpm_data, undefined);
  assert.equal(days['2020-01-01'], undefined);

  // Explicit select lists, never select=*.
  for (const { query } of calls) {
    assert.match(query, /select=/);
    assert.ok(!query.includes('select=*'), `unexpected select=* in ${query}`);
  }
  const daily = calls.find((c) => c.table === 'daily_metrics');
  assert.ok(daily.query.includes(`updated_at=gte.${sinceIso}`), daily.query);
  assert.ok(daily.query.includes('record_class=eq.user'), daily.query);
  assert.ok(daily.query.includes('day=gte.2020-01-01') && daily.query.includes(`day=lte.${today}`), daily.query);
  assert.ok(daily.query.includes('select=day,record_class,recovery_score'), daily.query);
  const sessions = calls.find((c) => c.table === 'sessions');
  assert.ok(sessions.query.includes(`updated_at=gte.${sinceIso}`), sessions.query);
  assert.ok(sessions.query.includes(`start_at=gte.${dayBounds('2020-01-01', TZ).day_start_at}`), sessions.query);
  assert.ok(sessions.query.includes(`start_at=lt.${dayBounds(today, TZ).day_end_at}`), sessions.query);
  const sleep = calls.find((c) => c.table === 'sleep_details');
  assert.ok(sleep.query.includes(`updated_at=gte.${sinceIso}`), sleep.query);
  const sleepFrom = new Date(Date.parse(dayBounds('2020-01-01', TZ).day_start_at) - 14 * 3600000).toISOString();
  const sleepTo = new Date(Date.parse(dayBounds(today, TZ).day_end_at) + 2 * 3600000).toISOString();
  assert.ok(sleep.query.includes(`original_end_at=gte.${sleepFrom}`), sleep.query);
  assert.ok(sleep.query.includes(`original_start_at=lte.${sleepTo}`), sleep.query);
});

test('loadChangedDays keeps bpm_data on today and yesterday only', async () => {
  const now = new Date();
  const { today, yesterday } = utcKeys(now);
  const calls = [];
  const rest = stubRest({
    daily_metrics: [
      { user_id: USER_ID, day: '2020-01-01', record_class: 'user', recovery_score: 50, extras: {}, provenance: {}, timezone_name: TZ, updated_at: new Date().toISOString() },
      { user_id: USER_ID, day: yesterday, record_class: 'user', recovery_score: 60, extras: {}, provenance: {}, timezone_name: TZ, updated_at: new Date().toISOString() },
      { user_id: USER_ID, day: today, record_class: 'user', recovery_score: 70, extras: {}, provenance: {}, timezone_name: TZ, updated_at: new Date().toISOString() },
    ],
    daily_physiology_series: [
      { user_id: USER_ID, day: '2020-01-01', hr_series: [{ t: '2020-01-01T20:00:00.000Z', avg_hr: 50 }] },
      { user_id: USER_ID, day: today, hr_series: [{ t: `${today}T20:00:00.000Z`, avg_hr: 61, samples: 12 }] },
    ],
  }, calls);
  const days = await loadChangedDays({
    rest,
    userId: USER_ID,
    sinceIso: new Date(Date.parse(now.toISOString()) - 30_000).toISOString(),
    fromDay: '2020-01-01',
    toDay: today,
    timeZone: TZ,
    now,
  });
  assert.equal(days['2020-01-01'].bpm_data, undefined);
  assert.equal(days[yesterday].bpm_data, undefined);
  assert.ok((days[today].bpm_data || []).length >= 1);
  // The series read is bounded to the two chart days, not the 2020 window.
  const seriesCall = calls.find((c) => c.table === 'daily_physiology_series');
  assert.ok(seriesCall, 'series queried for recent chart days');
  assert.ok(seriesCall.query.includes(`day=gte.${yesterday}`), seriesCall.query);
  assert.ok(seriesCall.query.includes(`day=lte.${today}`), seriesCall.query);
  assert.ok(seriesCall.query.includes('select=day,hr_series'), seriesCall.query);
});

test('loadChangedDays tolerates a stub-less day window and empty payload', async () => {
  const days = await loadChangedDays({});
  assert.deepEqual(days, {});
  const rest = stubRest({});
  const empty = await loadChangedDays({
    rest,
    userId: USER_ID,
    sinceIso: new Date().toISOString(),
    fromDay: '2026-01-01',
    toDay: '2026-01-02',
    timeZone: TZ,
  });
  assert.deepEqual(empty, {});
});

function buildChangesApp({ rest, loadLiveForUser, resolveUser } = {}) {
  let store = normalizeHostStore({ prefs: {} });
  store.profile.timezone = TZ;
  const app = express();
  app.use(express.json());
  registerHostRoutes(app, {
    loadStore: () => store,
    saveStore: () => {},
    resolveUser,
    loadLiveForUser,
    rest,
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('GET /api/days/changes serves changed days, live, userId, and serverTime', async () => {
  const now = new Date();
  const { today, yesterday } = utcKeys(now);
  const calls = [];
  const rest = stubRest(changedRowsFixture({ now }), calls);
  const { server, port } = await buildChangesApp({
    rest,
    loadLiveForUser: () => ({ connected: true, heartRate: 77, battery: 80 }),
    resolveUser: async () => ({ id: USER_ID }),
  });
  const json = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.json() };
  };
  try {
    const since = encodeURIComponent(new Date(Date.parse(now.toISOString()) - 30_000).toISOString());
    const ok = await json(`/api/days/changes?since=${since}`);
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(ok.body).sort(), ['changes', 'live', 'serverTime', 'userId']);
    assert.equal(ok.body.userId, USER_ID);
    assert.equal(ok.body.live?.heartRate, 77);
    assert.ok(ok.body.serverTime, 'serverTime present');
    assert.ok(!Number.isNaN(Date.parse(ok.body.serverTime)));
    assert.deepEqual(Object.keys(ok.body.changes).sort(), [yesterday, today]);
    assert.equal(ok.body.changes[today].physiological_summary['Recovery score %'], 72);
    assert.equal(ok.body.changes[today].bpm_data?.length >= 1, true);
    assert.ok(!('bpm_data' in ok.body.changes[yesterday]));
    assert.equal(ok.body.changes[yesterday].workouts[0]['Activity name'], 'run');
    // since is enforced server-side through the emitted queries.
    const daily = calls.find((c) => c.table === 'daily_metrics');
    assert.ok(daily.query.includes(`updated_at=gte.${decodeURIComponent(since)}`), daily.query);
    // default window: since−1d .. today
    assert.ok(daily.query.includes(`day=gte.${localDateKey(new Date(Date.parse(decodeURIComponent(since)) - 24 * 3600000), TZ)}`), daily.query);
    assert.ok(daily.query.includes(`day=lte.${today}`), daily.query);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('GET /api/days/changes honors from/to and the bpm payload gate', async () => {
  const now = new Date();
  const { today } = utcKeys(now);
  const calls = [];
  const rest = stubRest(changedRowsFixture({ now }), calls);
  const { server, port } = await buildChangesApp({
    rest,
    loadLiveForUser: () => null,
    resolveUser: async () => ({ id: USER_ID }),
  });
  const json = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.json() };
  };
  try {
    const since = encodeURIComponent(new Date(Date.parse(now.toISOString()) - 30_000).toISOString());
    const ok = await json(`/api/days/changes?since=${since}&from=2020-01-01&to=${today}`);
    assert.equal(ok.status, 200);
    const daily = calls.find((c) => c.table === 'daily_metrics');
    assert.ok(daily.query.includes('day=gte.2020-01-01'), daily.query);
    assert.ok(daily.query.includes(`day=lte.${today}`), daily.query);
    // 2020-01-01 daily row was updated long ago, so the stub filters it out:
    // only genuinely changed days come back, and only recent ones carry series.
    assert.ok(!('2020-01-01' in ok.body.changes));
    assert.equal(ok.body.changes[today].bpm_data?.length >= 1, true);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('GET /api/days/changes enforces since and auth like /api/days', async () => {
  const { server, port } = await buildChangesApp({
    rest: stubRest({}),
    loadLiveForUser: () => null,
    resolveUser: async () => ({ id: USER_ID }),
  });
  const raw = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.json() };
  };
  try {
    // since is required.
    assert.equal((await raw('/api/days/changes')).status, 400);
    assert.equal((await raw('/api/days/changes?since=not-a-date')).status, 400);
    // since older than 31 days is rejected: the client should re-pull instead.
    const stale = new Date(Date.now() - 40 * 86400e3).toISOString();
    assert.equal((await raw(`/api/days/changes?since=${encodeURIComponent(stale)}`)).status, 400);
    // from after to is a bad window.
    const fresh = encodeURIComponent(new Date().toISOString());
    assert.equal((await raw(`/api/days/changes?since=${fresh}&from=2026-08-02&to=2026-08-01`)).status, 400);
    // within the window it serves, even with no changed rows.
    const ok = await raw(`/api/days/changes?since=${fresh}`);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.changes, {});
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('GET /api/days/changes propagates auth errors like /api/days', async () => {
  const { server, port } = await buildChangesApp({
    rest: stubRest({}),
    loadLiveForUser: () => null,
    resolveUser: async () => {
      const err = new Error('expired token');
      err.status = 401;
      throw err;
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/days/changes?since=${encodeURIComponent(new Date().toISOString())}`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'expired token');
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('GET /api/days/changes degrades to an empty delta without a REST client', async () => {
  const { server, port } = await buildChangesApp({
    rest: null,
    loadLiveForUser: () => ({ connected: false, heartRate: null }),
    resolveUser: async () => ({ id: USER_ID }),
  });
  const raw = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.json() };
  };
  try {
    const ok = await raw(`/api/days/changes?since=${encodeURIComponent(new Date().toISOString())}`);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.changes, {});
    assert.equal(ok.body.userId, USER_ID);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
