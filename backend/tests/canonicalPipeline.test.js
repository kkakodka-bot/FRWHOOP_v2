/**
 * Canonical pipeline: persist a complete local 24h day, recompute from that
 * archive, and assert the snapshot contract (HR series, steps, sleep/RHR,
 * energy basal+active, strain series, null vs 0).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMetricsEngine } from '../metrics/engine.js';
import { loadDaySnapshot, snapshotToWhoopDay } from '../metrics/snapshot.js';
import { presentMetric } from '../metrics/canonicalRegistry.js';

const USER = '44444444-4444-4444-8444-444444444444';
const DAY = '2026-08-24';
const TZ = 'UTC';
const PROFILE = { birthYear: 1994, sex: 'male', heightCm: 178, weightKg: 74, restingHr: 48 };

function makeObjectStore() {
  const blobs = new Map();
  return {
    blobs,
    async putObject(key, body) {
      blobs.set(key, body);
      return { etag: '"x"', bytes: Buffer.isBuffer(body) ? body.length : body.byteLength };
    },
    async head(key) {
      const b = blobs.get(key);
      return b ? { exists: true, contentLength: b.length } : null;
    },
    async getObject(key) {
      const b = blobs.get(key);
      return b ? { body: b } : null;
    },
  };
}

function makeDb() {
  const state = {
    object_manifests: new Map(),
    daily_metrics: new Map(),
    series: new Map(),
    sessions: [],
    sleep_details: [],
    ingest_gaps: [],
    metric_runs: [],
    day_completeness: new Map(),
    energy_daily: [],
  };
  const db = {
    state,
    async upsertPayload(payload = {}) {
      for (const m of payload.object_manifests || []) state.object_manifests.set(m.id, m);
      for (const d of payload.daily_metrics || []) state.daily_metrics.set(`${d.user_id}|${d.day}`, d);
      for (const s of payload.daily_physiology_series || []) {
        const key = `${s.user_id}|${s.day}`;
        const existing = state.series.get(key);
        const map = new Map(existing?.hr_series || []);
        for (const pt of s.hr_series || []) map.set(pt.t, pt);
        const strain = new Map((existing?.strain_series || []).map((p) => [p.bucket_start || p.t, p]));
        for (const pt of s.strain_series || []) strain.set(pt.bucket_start || pt.t, pt);
        const skin = new Map((existing?.skin_temp_series || []).map((p) => [p.t || p.datetime, p]));
        for (const pt of s.skin_temp_series || []) skin.set(pt.t || pt.datetime, pt);
        state.series.set(key, {
          ...existing,
          ...s,
          user_id: s.user_id,
          day: s.day,
          sample_count: Math.max(existing?.sample_count || 0, s.sample_count || map.size),
          hr_series: map,
          strain_series: [...strain.values()],
          skin_temp_series: [...skin.values()],
        });
      }
      if (payload.sessions) state.sessions.push(...payload.sessions);
      if (payload.sleep_details) state.sleep_details.push(...payload.sleep_details);
      if (payload.ingest_gaps) state.ingest_gaps.push(...payload.ingest_gaps);
      if (payload.metric_runs) state.metric_runs.push(...payload.metric_runs);
      if (payload.energy_daily) state.energy_daily.push(...payload.energy_daily);
      return { ok: true };
    },
    async getDayCompleteness(userId, day) {
      return state.day_completeness.get(`${userId}|${day}`) || null;
    },
    async upsertDayCompleteness(userId, row = {}) {
      const key = `${userId}|${row.day}`;
      const existing = state.day_completeness.get(key) || null;
      state.day_completeness.set(key, { ...existing, ...row, user_id: userId });
      return state.day_completeness.get(key);
    },
    async invalidateDayCompleteness(userId, days = []) {
      for (const day of days) {
        const key = `${userId}|${day}`;
        const row = state.day_completeness.get(key);
        if (row) state.day_completeness.set(key, { ...row, status: 'open', finalized_at: null });
      }
      return days.length;
    },
    async listIngestGaps() { return state.ingest_gaps; },
    async resolveIngestGaps() { return 0; },
    async listPhysiologyManifests({ userId, days = [] } = {}) {
      const selected = new Set(days);
      return [...state.object_manifests.values()].filter((m) => (
        m.user_id === userId
        && m.object_kind === 'physiology'
        && ['ready', 'verified'].includes(m.status)
        && (selected.size ? selected.has(m.period_day) : true)
      )).sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));
    },
  };
  return db;
}

function restFromDb(state) {
  return {
    async select(table, query) {
      const q = String(query || '');
      const day = (q.match(/day=eq\.(\d{4}-\d{2}-\d{2})/) || [])[1];
      if (table === 'daily_metrics') {
        const row = day ? state.daily_metrics.get(`${USER}|${day}`) : null;
        return row ? [row] : [];
      }
      if (table === 'daily_physiology_series') {
        const row = day ? state.series.get(`${USER}|${day}`) : null;
        if (!row) return [];
        return [{
          ...row,
          hr_series: [...(row.hr_series?.values?.() || [])],
          strain_series: row.strain_series || [],
          skin_temp_series: row.skin_temp_series || [],
        }];
      }
      if (table === 'sessions') return state.sessions.filter((s) => s.user_id === USER);
      if (table === 'sleep_details') return state.sleep_details.filter((s) => s.user_id === USER);
      if (table === 'energy_daily') {
        return state.energy_daily.filter((row) => row.user_id === USER && (!day || row.day === day));
      }
      return [];
    },
  };
}

/** 24h UTC day: 1 Hz still gravity overnight, walking + step counter after 07:00. */
function completeDaySamples() {
  const start = Date.parse(`${DAY}T00:00:00.000Z`);
  const samples = [];
  let stepCounter = 100;
  for (let sec = 0; sec < 24 * 3600; sec += 1) {
    const t = start + sec * 1000;
    const hour = Math.floor(sec / 3600);
    const night = hour < 7;
    const workout = hour === 10 && (sec % 3600) < 30 * 60;
    if (!night && sec % 10 !== 0) continue;
    const sample = {
      datetime: new Date(t).toISOString(),
      t: new Date(t).toISOString(),
      seq: samples.length + 1,
      bpm: workout ? 148 : (night ? 48 + (hour % 3) : 72 + (hour % 12)),
      gx: night ? 0 : (Math.floor(sec / 3) % 2),
      gy: 0,
      gz: night ? 1 : (Math.floor(sec / 3) % 2 ? 0 : 1),
      mot: workout ? 0.85 : (night ? 0.01 : 0.12),
      motion: workout ? 0.85 : (night ? 0.01 : 0.12),
      skin_temp_c: 33.4 + (hour % 5) * 0.05,
      connected: true,
      src: 'history',
    };
    if (night) sample.rr_ms = [1220, 1180, 1200];
    else {
      stepCounter += 1;
      sample.step_cumulative = stepCounter;
    }
    samples.push(sample);
  }
  return samples;
}

test('persisted 24h day recomputes a usable canonical snapshot', async () => {
  const raw = makeObjectStore();
  const derived = makeObjectStore();
  const db = makeDb();
  const engine = createMetricsEngine({
    cfg: { localUserId: USER, rawStore: 'b2', derivedStore: 'b2', b2Bucket: 'FRWHOOP', buildHash: 'test' },
    stores: { raw, derived },
    db,
    energyContext: async () => ({ profile: PROFILE, workouts: [] }),
  });

  const samples = completeDaySamples();
  assert.ok(samples.length > 20_000);

  for (let hour = 0; hour < 24; hour += 1) {
    const chunk = samples.filter((s) => new Date(s.t).getUTCHours() === hour);
    const archived = await engine.archiveRawSamples({
      samples: chunk,
      device: { id: 'strap' },
      startAt: chunk[0].datetime,
      endAt: chunk.at(-1).datetime,
      extras: { userId: USER, timeZone: TZ, periodDay: DAY },
    });
    assert.equal(archived.status, 'ready');
  }

  const replay = await engine.recomputeFromStorage({
    userId: USER,
    days: [DAY],
    timeZone: TZ,
  });
  assert.ok(replay.manifests >= 24, `replay manifests ${replay.manifests}`);
  assert.equal(replay.samples, samples.length);
  assert.ok(replay.results.some((r) => !r?.skipped));

  const replay2 = await engine.recomputeFromStorage({
    userId: USER,
    days: [DAY],
    timeZone: TZ,
  });
  const firstRow = db.state.daily_metrics.get(`${USER}|${DAY}`);
  const secondMetrics = replay2.results.find((r) => r?.day === DAY) || replay2.results.at(-1);
  assert.ok(firstRow, 'daily_metrics written');
  assert.equal(firstRow.steps, db.state.daily_metrics.get(`${USER}|${DAY}`).steps);
  assert.ok(Number.isFinite(Number(firstRow.steps)));
  assert.ok(Number.isFinite(Number(firstRow.strain_score)) && Number(firstRow.strain_score) > 0);
  assert.ok(firstRow.active_kcal != null || firstRow.basal_kcal != null, 'energy basal+active persisted');
  assert.equal(firstRow.extras?.steps_v3?.canonical, undefined);

  const snap = await loadDaySnapshot({ rest: restFromDb(db.state), userId: USER, day: DAY, timeZone: TZ });
  const whoop = snapshotToWhoopDay(snap);
  const hrPoints = (snap.chart || []).filter((p) => presentMetric(p.avg_hr) != null);
  assert.ok(hrPoints.length >= 200, `HR 5-min buckets ${hrPoints.length}`);
  assert.equal(whoop.bpm_data[0].bpm, Number(hrPoints[0].avg_hr));
  assert.equal(snap.availability.hr.status, 'available');
  assert.ok(snap.availability.hr.coverage_pct > 50);

  assert.equal(snap.availability.steps.status, 'available');
  assert.equal(presentMetric(snap.metrics.steps), snap.metrics.steps);
  assert.ok(snap.metrics.steps > 0);

  assert.equal(snap.availability.strain.status, 'available');
  assert.ok((snap.strain_series || []).length > 0, 'V1 strain_series persisted');
  assert.equal(whoop.strain_series.length, snap.strain_series.length);
  assert.ok((snap.skin_temp_series || []).length >= 100, `skin_temp_series ${snap.skin_temp_series?.length}`);
  assert.equal(whoop.skin_temp_series.length, snap.skin_temp_series.length);
  assert.equal(snap.availability.skin_temp.status, 'available');
  assert.ok(presentMetric(snap.metrics.skin_temp_c) >= 20);

  const energy = presentMetric(snap.metrics.energy_kcal)
    ?? ((presentMetric(snap.metrics.active_kcal) || 0) + (presentMetric(snap.metrics.basal_kcal) || 0));
  assert.equal(snap.availability.energy.status, 'available');
  assert.ok(energy > 0, `energy ${energy}`);
  assert.ok(snap.metrics.basal_kcal != null || snap.metrics.active_kcal != null);

  const hasSleep = (snap.sleep || []).length > 0
    || (snap.sessions || []).some((s) => /sleep/i.test(String(s.kind || '')));
  assert.equal(hasSleep, true, 'gravity overnight must persist a sleep session');
  assert.equal(snap.availability.sleep.status, 'available');
  assert.ok(snap.metrics.sleep_total_min != null || snap.sleep[0]?.asleep_min != null);
  assert.equal(snap.availability.rhr.status, 'available');
  assert.ok(presentMetric(snap.metrics.resting_hr_bpm) != null);

  assert.equal(presentMetric(0), 0);
  assert.equal(whoop.availability.steps.status, 'available');
  assert.ok(secondMetrics);

  const firstWhoop = snapshotToWhoopDay(snap);
  assert.deepEqual(firstWhoop.strain_series, snap.strain_series, 'strain_series survives snapshot exactly');
  assert.equal(firstWhoop.physiological_summary['Day Strain'], presentMetric(snap.metrics.strain_score));
  assert.equal(
    firstWhoop.physiological_summary['Day Strain V2'] == null
      || firstWhoop.physiological_summary['Day Strain V2'] !== firstWhoop.physiological_summary['Day Strain']
      || firstWhoop.physiological_summary['Day Strain'] == null,
    true,
    'V2 must not replace V1',
  );
  assert.equal(firstWhoop.physiological_summary['Blood oxygen %'], null);

  const seeded = db.state.daily_metrics.get(`${USER}|${DAY}`);
  seeded.sleep_debt_balance_min = 47;
  seeded.sleep_consistency = 82;
  seeded.vo2max = 48.5;
  seeded.strain_score_v2 = 12.4;
  seeded.strain_v2 = { qualityState: 'HIGH', au: 12 };
  seeded.extras = {
    ...(seeded.extras || {}),
    spo2_candidate: { spo2_candidate_pct: 96, spo2_pct: null },
    spo2_candidate_series: [{ t: `${DAY}T06:00:00.000Z`, pct: 96 }],
  };
  const seededSnap = await loadDaySnapshot({ rest: restFromDb(db.state), userId: USER, day: DAY, timeZone: TZ });
  const seededWhoop = snapshotToWhoopDay(seededSnap);
  assert.equal(seededSnap.metrics.sleep_debt_balance_min, 47);
  assert.equal(seededSnap.metrics.sleep_consistency, 82);
  assert.equal(seededSnap.metrics.vo2max, 48.5);
  assert.equal(seededSnap.metrics.strain_score_v2, 12.4);
  assert.equal(seededSnap.metrics.spo2_candidate_pct, 96);
  assert.equal(seededWhoop.physiological_summary['Sleep debt (min)'], 47);
  assert.equal(seededWhoop.physiological_summary['Sleep consistency %'], 82);
  assert.equal(seededWhoop.physiological_summary['VO2 Max'], 48.5);
  assert.equal(seededWhoop.physiological_summary['Day Strain V2'], 12.4);
  assert.equal(seededWhoop.physiological_summary['Day Strain'], firstWhoop.physiological_summary['Day Strain']);
  assert.equal(seededWhoop.physiological_summary['Blood oxygen %'], null);
  assert.equal(seededWhoop.spo2_candidate_pct, 96);
  assert.deepEqual(seededWhoop.strain_series, seededSnap.strain_series);
  console.log('METRIC_READ_PATH sample', {
    day: DAY,
    db: {
      sleep_debt_balance_min: seeded.sleep_debt_balance_min,
      sleep_consistency: seeded.sleep_consistency,
      vo2max: seeded.vo2max,
      strain_score: seeded.strain_score,
      strain_score_v2: seeded.strain_score_v2,
      spo2_candidate_pct: seeded.extras.spo2_candidate.spo2_candidate_pct,
      strain_series_n: db.state.series.get(`${USER}|${DAY}`)?.strain_series?.length,
    },
    rpc: {
      sleep_debt_balance_min: seededSnap.metrics.sleep_debt_balance_min,
      sleep_consistency: seededSnap.metrics.sleep_consistency,
      vo2max: seededSnap.metrics.vo2max,
      strain_score: seededSnap.metrics.strain_score,
      strain_score_v2: seededSnap.metrics.strain_score_v2,
      spo2_candidate_pct: seededSnap.metrics.spo2_candidate_pct,
      strain_series_n: seededSnap.strain_series.length,
    },
    whoop: {
      'Sleep debt (min)': seededWhoop.physiological_summary['Sleep debt (min)'],
      'Sleep consistency %': seededWhoop.physiological_summary['Sleep consistency %'],
      'VO2 Max': seededWhoop.physiological_summary['VO2 Max'],
      'Day Strain': seededWhoop.physiological_summary['Day Strain'],
      'Day Strain V2': seededWhoop.physiological_summary['Day Strain V2'],
      'Blood oxygen %': seededWhoop.physiological_summary['Blood oxygen %'],
      spo2_candidate_pct: seededWhoop.spo2_candidate_pct,
      strain_series_n: seededWhoop.strain_series.length,
    },
  });
});

test('snapshot keeps numeric 0 and marks missing fields unavailable', async () => {
  const snap = {
    day: DAY,
    metrics: { steps: 0, strain_score: 0, resting_hr_bpm: null, energy_kcal: 0, active_kcal: 0, basal_kcal: 0 },
    chart: [],
    sleep: [],
    sessions: [],
    strain_series: [],
  };
  const whoop = snapshotToWhoopDay(snap);
  assert.equal(whoop.physiological_summary.Steps, 0);
  assert.equal(whoop.physiological_summary['Day Strain'], 0);
  assert.equal(whoop.physiological_summary['Resting heart rate (bpm)'], null);
  assert.equal(whoop.physiological_summary['Energy burned (cal)'], 0);
  assert.equal(whoop.availability.steps.status, 'available');
  assert.equal(whoop.availability.rhr.status, 'unavailable');
  assert.equal(whoop.availability.hr.status, 'unavailable');
});
