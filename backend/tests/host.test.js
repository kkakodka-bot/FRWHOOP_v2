import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { coachRowToWhoopDay, daysMapFromIndex, overlayHealthKitStore, downsampleBpmSamples, mergeLiveSeriesIntoDays, fillHeadlineScores } from '../host/whoopDays.js';
import { defaultPermissions, defaultProfile, liveMotionOf, normalizeHostStore, registerHostRoutes } from '../host/routes.js';
import { loadDaySnapshot } from '../metrics/snapshot.js';
import { dayBounds, localDateKey } from '../time/dayBoundary.js';

test('coach row maps onto WHOOP frontend field names', () => {
  const day = coachRowToWhoopDay({
    day: '2025-06-01',
    recovery: 73,
    strain: 9.8,
    hrv: 70,
    rhr: 62,
    resp: 12.4,
    spo2: 97.35,
    skinTemp: 34.09,
    calories: 2373,
    avgHr: 74,
    maxHr: 159,
    sleepPerformance: 19,
    sleepEfficiency: 85,
    sleepConsistency: 57,
    asleepMin: 65,
    inBedMin: 76,
    lightMin: 30,
    deepMin: 33,
    remMin: 2,
    awakeMin: 11,
    sleepNeedMin: 530,
    sleepDebtMin: 58,
    sleepOnset: '2025-06-01 10:04:53',
    wakeOnset: '2025-06-01 11:23:43',
    nap: true,
    workouts: [{
      name: 'Weightlifting',
      start: '2025-06-01 20:36:44',
      end: '2025-06-01 21:20:04',
      durationMin: 43,
      strain: 5.7,
      calories: 162,
      avgHr: 110,
      maxHr: 143,
      zones: [62, 0, 0, 0, 0],
    }],
  });

  assert.equal(day.physiological_summary['Recovery score %'], 73);
  assert.equal(day.physiological_summary['Day Strain'], 9.8);
  assert.equal(day.physiological_summary['Heart rate variability (ms)'], 70);
  assert.equal(day.sleep_summary.Nap, true);
  assert.equal(day.sleep_summary['Asleep duration (min)'], 65);
  assert.equal(day.workouts[0]['Activity name'], 'Weightlifting');
  assert.equal(day.workouts[0]['Duration (min)'], 43);
  assert.equal(day.workouts[0]['HR Zone 1 %'], 62);
  assert.equal(day.bpm_data, undefined);
});

test('days map is keyed by calendar date', () => {
  const map = daysMapFromIndex({
    days: [
      { day: '2025-06-01', recovery: 70, strain: 8, workouts: [] },
      { day: '2025-06-02', recovery: 80, strain: 5, workouts: [] },
    ],
  });
  assert.deepEqual(Object.keys(map).sort(), ['2025-06-01', '2025-06-02']);
  assert.equal(map['2025-06-02'].physiological_summary['Recovery score %'], 80);
});

test('host store fills profile, permissions, and browser BLE defaults', () => {
  const store = normalizeHostStore({ profile: {}, permissions: {}, ble: { scanning: true, supported: true } });
  assert.equal(store.profile.sex, defaultProfile().sex);
  assert.equal(store.permissions.health, defaultPermissions().health);
  assert.equal(store.ble.supported, false);
  assert.equal(store.ble.scanning, false);
  assert.match(store.ble.hint, /phone/i);
  assert.equal(liveMotionOf({ phoneMotion: 0.2, strapMotion: 0.5 }), 0.5);
  assert.equal(liveMotionOf({}), null);
});

test('HealthKit store fills Watch RHR and never copies Watch steps onto Steps', () => {
  const days = overlayHealthKitStore({
    '2026-08-24': { physiological_summary: { 'Resting heart rate (bpm)': 54, 'Day Strain': 8, Steps: 4000 } },
    '2026-08-25': { physiological_summary: { 'Day Strain': 2.9 } },
  }, {
    days: {
      '2026-08-24': { steps: 10007, resting_hr: 48 },
      '2026-08-25': { steps: 6282 },
    },
    measurements: [{
      metric_type: 'resting_heart_rate',
      value: 52,
      measured_at: '2026-08-25T12:00:00.000Z',
      metadata: { end_time: '2026-08-25T12:00:00.000Z' },
    }],
  });
  assert.equal(days['2026-08-24'].physiological_summary.Steps, 4000);
  assert.equal(days['2026-08-24'].physiological_summary['Resting heart rate (bpm)'], 54);
  assert.equal(days['2026-08-25'].physiological_summary.Steps, undefined);
  assert.equal(days['2026-08-25'].physiological_summary['Resting heart rate (bpm)'], 52);
});

test('HealthKit Watch sleep fills last night when FRWHOOP overnight is missing', () => {
  const days = overlayHealthKitStore({
    '2026-08-26': { physiological_summary: { Steps: 520 } },
  }, {
    days: { '2026-08-26': { steps: 520 } },
    sessions: [{
      kind: 'sleep',
      start_at: '2026-08-26T08:29:27.372Z',
      end_at: '2026-08-26T16:44:26.557Z',
      summary: { role: 'fallback' },
    }],
  }, 'America/Los_Angeles');
  assert.equal(days['2026-08-26'].physiological_summary.Steps, 520);
  assert.equal(days['2026-08-26'].physiological_summary['Asleep duration (min)'], 495);
  assert.equal(days['2026-08-26'].sleep_summary['Wake onset'], '2026-08-26T16:44:26.557Z');
  const kept = overlayHealthKitStore({
    '2026-08-26': { physiological_summary: { 'Asleep duration (min)': 420, 'Wake onset': 'frwhoop' } },
  }, {
    sessions: [{
      kind: 'sleep',
      start_at: '2026-08-26T08:29:27.372Z',
      end_at: '2026-08-26T16:44:26.557Z',
    }],
  }, 'America/Los_Angeles');
  assert.equal(kept['2026-08-26'].physiological_summary['Asleep duration (min)'], 420);
});

test('fillHeadlineScores scores recovery from last night when the engine row is blank', () => {
  const days = fillHeadlineScores({
    '2026-08-25': {
      physiological_summary: {
        'Recovery score %': 62,
        'Heart rate variability (ms)': 64,
        'Resting heart rate (bpm)': 50,
        'Day Strain': 2.9,
      },
    },
    '2026-08-26': {
      physiological_summary: {
        'Heart rate variability (ms)': 73,
        'Resting heart rate (bpm)': 55,
        'Asleep duration (min)': 495,
      },
      bpm_data: [
        { datetime: '2026-08-26T20:03:42.998Z', bpm: 72 },
        { datetime: '2026-08-26T20:03:46.998Z', bpm: 74 },
      ],
    },
  });
  assert.ok(days['2026-08-26'].physiological_summary['Recovery score %'] > 0);
  assert.equal(days['2026-08-26'].physiological_summary['Day Strain'], 0);
  assert.equal(days['2026-08-25'].physiological_summary['Recovery score %'], 62);
  const tomorrow = fillHeadlineScores({
    '2026-08-27': {
      physiological_summary: { 'Heart rate variability (ms)': 81 },
      bpm_data: [{ datetime: '2026-08-27T00:30:00.000Z', bpm: 70 }],
    },
  });
  assert.equal(tomorrow['2026-08-27'].physiological_summary['Recovery score %'], undefined);
  assert.equal(tomorrow['2026-08-27'].physiological_summary['Day Strain'], undefined);
  const sleepOnly = fillHeadlineScores({
    '2026-08-24': {
      physiological_summary: {
        'Asleep duration (min)': 480,
        'Heart rate variability (ms)': 70,
        'Resting heart rate (bpm)': 52,
      },
    },
  });
  assert.equal(sleepOnly['2026-08-24'].physiological_summary['Recovery score %'], undefined);
  const walkStart = Date.parse('2026-08-26T18:00:00.000Z');
  const walked = fillHeadlineScores({
    '2026-08-26': {
      physiological_summary: { 'Resting heart rate (bpm)': 55 },
      bpm_data: Array.from({ length: 24 }, (_, i) => ({
        datetime: new Date(walkStart + i * 5 * 60_000).toISOString(),
        bpm: 95,
      })),
    },
  });
  assert.ok(walked['2026-08-26'].physiological_summary['Day Strain'] > 0);
  const restDay = fillHeadlineScores({
    '2026-08-26': {
      physiological_summary: { 'Resting heart rate (bpm)': 55, 'Day Strain': 0 },
      bpm_data: Array.from({ length: 24 }, (_, i) => ({
        datetime: new Date(walkStart + i * 5 * 60_000).toISOString(),
        bpm: 95,
      })),
    },
  });
  assert.equal(restDay['2026-08-26'].physiological_summary['Day Strain'], 0);
});

test('live samples downsample into a 24h curve without dumping the raw buffer', () => {
  const samples = [];
  for (let i = 0; i < 120; i += 1) {
    samples.push({
      datetime: `2026-08-26T${String(16 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
      bpm: 60 + (i % 7),
    });
  }
  const byDay = downsampleBpmSamples(samples, { bucketMin: 5, timeZone: 'America/Los_Angeles' });
  const rows = byDay['2026-08-26'] || [];
  assert.ok(rows.length >= 12 && rows.length <= 30, `expected ~24 buckets, got ${rows.length}`);
  const merged = mergeLiveSeriesIntoDays({
    '2026-08-26': { physiological_summary: { Steps: 1363 }, bpm_data: [{ datetime: '2026-08-26T16:00:00.000Z', bpm: 70 }] },
  }, samples, 'America/Los_Angeles');
  assert.ok(merged['2026-08-26'].bpm_data.length >= rows.length);
  assert.equal(merged['2026-08-26'].physiological_summary.Steps, 1363);
});

test('live overlay unions with persisted history instead of replacing the 24h curve', () => {
  const history = Array.from({ length: 48 }, (_, i) => ({
    datetime: new Date(Date.parse('2026-08-26T00:00:00.000Z') + i * 30 * 60_000).toISOString(),
    bpm: 62,
  }));
  const liveOpen = Array.from({ length: 8 }, (_, i) => ({
    datetime: new Date(Date.parse('2026-08-26T21:00:00.000Z') + i * 60_000).toISOString(),
    bpm: 118,
  }));
  const merged = mergeLiveSeriesIntoDays(
    { '2026-08-26': { bpm_data: history } },
    liveOpen,
    'UTC',
  );
  const rows = merged['2026-08-26'].bpm_data;
  assert.ok(rows.length >= 48, `history must survive a short live overlay, got ${rows.length}`);
  assert.ok(rows.some((p) => Number(p.bpm) === 62), 'overnight/daytime history stays on the curve');
  assert.ok(rows.some((p) => Number(p.bpm) === 118), 'foreground live buckets still overlay');
});

test('host routes match the frontend contract', async () => {
  let store = normalizeHostStore({ prefs: {} });
  const app = express();
  app.use(express.json());
  registerHostRoutes(app, {
    loadStore: () => store,
    saveStore: (next) => { store = next; },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const json = async (path, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  try {
    const days = await json('/api/days');
    assert.equal(days.status, 200);
    assert.equal(typeof days.body.days, 'object');
    assert.ok(!Array.isArray(days.body.days));
    assert.equal(days.body.source, 'persisted');

    const profile = await json('/api/profile');
    assert.equal(profile.status, 200);
    assert.equal(profile.body.sex, 'male');

    const saved = await json('/api/profile', {
      method: 'POST',
      body: { sex: 'female', birthYear: 1994, heightCm: 170, weightKg: 62 },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.sex, 'female');
    assert.equal(saved.body.heightCm, 170);

    const denied = await json('/api/permissions');
    assert.equal(denied.body.health, 'not_determined');
    const granted = await json('/api/permissions', { method: 'POST', body: { kind: 'health' } });
    assert.equal(granted.status, 200);
    assert.equal(granted.body.health, 'granted');

    const ble = await json('/api/ble/state');
    assert.equal(ble.status, 200);
    assert.equal(ble.body.supported, false);

    const haptic = await json('/api/haptic', { method: 'POST', body: { style: 'medium' } });
    assert.equal(haptic.status, 200);
    assert.equal(haptic.body.ok, true);

    const live = await json('/api/ble/live', {
      method: 'POST',
      body: { heartRate: 68, battery: 41, connected: true, deviceId: 'strap-1', phoneMotion: 0.2, strapMotion: 0.4 },
    });
    assert.equal(live.status, 200);
    assert.equal(live.body.heartRate, 68);
    assert.equal(live.body.battery, 41);
    assert.equal(live.body.motion, 0.4);
    const liveGet = await json('/api/ble/live');
    assert.equal(liveGet.body.heartRate, 68);
    const inherited = await json('/api/ble/live', {
      method: 'POST',
      body: {
        heartRate: 120,
        phoneMotion: 0.3,
        samples: [{ bpm: 121, datetime: '2026-08-24T12:00:00.000Z' }],
      },
    });
    assert.equal(inherited.status, 200);
    assert.equal(inherited.body.motion, 0.3);
    assert.equal(inherited.body.heartRate, 120);
    const daysAfter = await json('/api/days');
    assert.ok(daysAfter.body.live?.heartRate === 120);
    assert.ok((daysAfter.body.days['2026-08-24']?.bpm_data || []).length <= 1);

    const runtime = await json('/api/host/runtime', {
      method: 'POST',
      body: { autoWorkoutDetect: false, hapticAlerts: false },
    });
    assert.equal(runtime.status, 200);
    assert.equal(runtime.body.autoWorkoutDetect, false);
    assert.equal(store.prefs.autoWorkoutDetect, false);

    const cap = await json('/api/sensors/capability');
    assert.equal(cap.status, 200);
    // The client must be able to distinguish a permanently unavailable metric
    // from one that is merely absent tonight, without inferring it from a null.
    assert.ok(cap.body.signals.available.includes('heart_rate'));
    assert.ok(cap.body.signals.available.includes('rr_intervals'));
    assert.ok(cap.body.signals.reachable.includes('skin_temperature'));
    assert.ok(cap.body.signals.absent.includes('ecg'));
    assert.equal(cap.body.metrics.hrv_rmssd.available, true);
    assert.equal(cap.body.metrics.skin_temperature.available, false);
    assert.equal(cap.body.metrics.respiratory_rate.experimental, true);
    assert.equal(cap.body.metrics.respiratory_rate.mechanisms_available, 1);
    assert.equal(cap.body.metrics.respiratory_rate.mechanisms_total, 4);
    assert.ok(cap.body.signals.unlocks.historical_offload.risk, 'an unlock must state its risk');
    assert.equal(cap.body.estimators.respiration.length, 4);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test('/api/days omits bpm_data for days older than yesterday', async () => {
  const tz = 'UTC';
  const today = localDateKey(new Date(), tz);
  const yesterday = localDateKey(new Date(Date.parse(dayBounds(today, tz).day_start_at) - 3600000), tz);
  const oldDay = '2020-01-01';
  let store = normalizeHostStore({ prefs: {} });
  store.profile.timezone = tz;
  const app = express();
  app.use(express.json());
  registerHostRoutes(app, {
    loadStore: () => store,
    saveStore: () => {},
    loadPersistedDays: async () => ({
      [oldDay]: {
        physiological_summary: { 'Recovery score %': 55, Steps: 8400 },
        sleep_summary: { Nap: false },
        workouts: [],
        bpm_data: [{ datetime: `${oldDay}T12:00:00.000Z`, bpm: 60 }],
      },
      [yesterday]: {
        physiological_summary: { 'Recovery score %': 58 },
        bpm_data: [{ datetime: `${yesterday}T12:00:00.000Z`, bpm: 61 }],
      },
      [today]: {
        physiological_summary: { 'Recovery score %': 66 },
        bpm_data: [{ datetime: `${today}T12:00:00.000Z`, bpm: 62 }],
      },
    }),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/days`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.days, 'object');
    // The old day keeps its vitals but its 288-point chart never ships: the
    // day-detail view reloads it via the bounded snapshot RPC.
    assert.equal(body.days[oldDay].bpm_data, undefined);
    assert.equal(body.days[oldDay].physiological_summary['Recovery score %'], 55);
    assert.equal(body.days[oldDay].physiological_summary.Steps, 8400);
    assert.ok((body.days[yesterday]?.bpm_data || []).length >= 1);
    assert.ok((body.days[today]?.bpm_data || []).length >= 1);
    assert.equal(body.source, 'persisted');
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('/api/days/snapshot bounds the sleep_details query to the wake window', async () => {
  const calls = [];
  const rest = {
    async select(table, query) {
      calls.push({ table, query });
      if (table === 'sleep_details') {
        // Deliberately ignore the REST bounds so the JS wake-day filter is
        // also under test: only the in-window night may survive.
        return [
          {
            session_id: 'in-window',
            is_nap: false,
            performance_pct: 91,
            efficiency: 0.93,
            asleep_min: 431,
            original_start_at: '2026-08-25T22:31:00.000Z',
            original_end_at: '2026-08-26T14:12:00.000Z',
          },
          {
            session_id: 'other-week',
            is_nap: false,
            asleep_min: 400,
            original_start_at: '2026-08-10T22:31:00.000Z',
            original_end_at: '2026-08-11T06:12:00.000Z',
          },
        ];
      }
      if (table === 'sessions') {
        return [{
          id: 's-link',
          kind: 'sleep',
          start_at: '2026-08-26T23:00:00.000Z',
          end_at: '2026-08-27T07:00:00.000Z',
        }];
      }
      return [];
    },
  };
  const day = '2026-08-26';
  const bounds = dayBounds(day, 'UTC');
  const expectedFrom = new Date(Date.parse(bounds.day_start_at) - 14 * 3600000).toISOString();
  const expectedTo = new Date(Date.parse(bounds.day_end_at) + 2 * 3600000).toISOString();
  const snap = await loadDaySnapshot({ rest, userId: 'u1', day, timeZone: 'UTC' });

  const sleepCall = calls.find((c) => c.table === 'sleep_details');
  assert.ok(sleepCall, 'sleep_details queried exactly once');
  assert.equal(calls.filter((c) => c.table === 'sleep_details').length, 1);
  assert.ok(sleepCall.query.includes(`original_end_at=gte.${expectedFrom}`), sleepCall.query);
  assert.ok(sleepCall.query.includes(`original_start_at=lte.${expectedTo}`), sleepCall.query);
  // The precise local-day filter still applies on top of the window.
  assert.equal(snap.sleep.length, 1);
  assert.equal(snap.sleep[0].session_id, 'in-window');
  // The other queries keep their day-bounded shapes.
  const sessionCall = calls.find((c) => c.table === 'sessions');
  assert.ok(sessionCall.query.includes(`start_at=lt.${bounds.day_end_at}`), sessionCall.query);
  assert.ok(sessionCall.query.includes(`end_at=gt.${bounds.day_start_at}`), sessionCall.query);
  const eventsCall = calls.find((c) => c.table === 'events');
  assert.ok(eventsCall.query.includes(`occurred_at=gte.${bounds.day_start_at}`), eventsCall.query);
});

test('snapshot Steps stay strap-only when Watch buckets exist', async () => {
  const rest = {
    async select(table) {
      if (table === 'daily_metrics') {
        return [{
          day: '2026-08-24',
          record_class: 'user',
          steps: null,
          active_kcal: 10,
          basal_kcal: 40,
          extras: {},
        }];
      }
      if (table === 'energy_daily') return [{ total_kcal: 352, active_kcal: 10, resting_kcal: 40 }];
      if (table === 'apple_watch_step_buckets') return [{ step_count: 13146 }];
      return [];
    },
  };
  const snap = await loadDaySnapshot({ rest, userId: 'u1', day: '2026-08-24', timeZone: 'UTC' });
  assert.equal(snap.metrics.steps, null);
  assert.equal(snap.metrics.watch_steps, 13146);
  assert.equal(snap.metrics.energy_kcal, 352);
  assert.equal(snap.availability.steps.status, 'unavailable');
  assert.equal(snap.availability.steps.source, null);
  assert.equal(snap.availability.steps.watch_steps, 13146);
  assert.equal(snap.availability.energy.status, 'available');
  assert.equal(snap.availability.energy.energy_kcal, 352);
});
