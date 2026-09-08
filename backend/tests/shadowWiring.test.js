/**
 * Shadow engine chain: fixture → persist → snapshot → diagnostic read model.
 * Canonical Overview columns must stay V1 while flags are on.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMetricsEngine } from '../metrics/engine.js';
import { loadDaySnapshot, snapshotToWhoopDay } from '../metrics/snapshot.js';
import { shadowById } from '../metrics/shadowReadModel.js';

const USER = '55555555-5555-4555-8555-555555555555';
const DAY = '2026-08-24';
const TZ = 'UTC';
const PROFILE = { birthYear: 1994, sex: 'male', heightCm: 178, weightKg: 74, restingHr: 48 };

function makeDb() {
  const state = {
    daily_metrics: new Map(),
    series: new Map(),
    sessions: [],
    sleep_details: [],
    metric_runs: [],
    energy_daily: [],
    object_manifests: new Map(),
    ingest_gaps: [],
  };
  return {
    state,
    async upsertPayload(payload = {}) {
      for (const d of payload.daily_metrics || []) state.daily_metrics.set(`${d.user_id}|${d.day}`, d);
      for (const s of payload.daily_physiology_series || []) {
        state.series.set(`${s.user_id}|${s.day}`, s);
      }
      if (payload.sessions) state.sessions.push(...payload.sessions);
      if (payload.sleep_details) {
        state.sleep_details = payload.sleep_details;
      }
      if (payload.metric_runs) state.metric_runs.push(...payload.metric_runs);
      if (payload.energy_daily) state.energy_daily.push(...payload.energy_daily);
      for (const m of payload.object_manifests || []) state.object_manifests.set(m.id, m);
      return { ok: true };
    },
  };
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
        return row ? [row] : [];
      }
      if (table === 'sessions') return state.sessions.filter((s) => s.user_id === USER);
      if (table === 'sleep_details') return state.sleep_details.filter((s) => s.user_id === USER);
      if (table === 'energy_daily') return state.energy_daily.filter((r) => r.user_id === USER);
      return [];
    },
  };
}

function nightAndDaySamples() {
  const samples = [];
  for (let i = 0; i < 90; i += 1) {
    samples.push({
      datetime: new Date(Date.UTC(2026, 7, 24, 0, 0, i * 40)).toISOString(),
      t: new Date(Date.UTC(2026, 7, 24, 0, 0, i * 40)).toISOString(),
      bpm: 50 + (i % 4),
      gx: 0,
      gy: 0,
      gz: 1,
      mot: 0.01,
      motion: 0.01,
      rr_ms: [1200, 1180],
      spo2_raw_byte: 96,
      spo2_state: 'candidate',
      spo2_candidate_pct: 96,
      skin_temp_c: 33.4,
    });
  }
  let counter = 200;
  for (let i = 0; i < 40; i += 1) {
    counter += 3;
    samples.push({
      datetime: new Date(Date.UTC(2026, 7, 24, 10, i)).toISOString(),
      t: new Date(Date.UTC(2026, 7, 24, 10, i)).toISOString(),
      bpm: 148,
      mot: 0.8,
      motion: 0.8,
      step_cumulative: counter,
      skin_temp_c: 33.6,
    });
  }
  return samples;
}

function withFlags(fn) {
  const prior = {
    FRWHOOP_HR2: process.env.FRWHOOP_HR2,
    FRWHOOP_STRAIN_V2: process.env.FRWHOOP_STRAIN_V2,
    ENERGY_MODEL_V2: process.env.ENERGY_MODEL_V2,
    ENERGY_MODEL_V3: process.env.ENERGY_MODEL_V3,
    FRWHOOP_SLEEP_V3: process.env.FRWHOOP_SLEEP_V3,
  };
  process.env.FRWHOOP_HR2 = 'dual';
  process.env.FRWHOOP_STRAIN_V2 = 'shadow';
  process.env.ENERGY_MODEL_V2 = 'shadow';
  process.env.ENERGY_MODEL_V3 = 'shadow';
  process.env.FRWHOOP_SLEEP_V3 = 'shadow';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prior)) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

test('shadow flags persist versioned extras without overwriting canonical columns', async () => {
  await withFlags(async () => {
    const db = makeDb();
    const engine = createMetricsEngine({
      cfg: { localUserId: USER, rawStore: 'none', derivedStore: 'none', b2Bucket: 'FRWHOOP', buildHash: 'test' },
      stores: { raw: null, derived: null },
      db,
      energyContext: async () => ({ profile: PROFILE, workouts: [] }),
      stepsV3Artifact: null,
    });
    const samples = nightAndDaySamples();
    await engine.persistComputed({ samples, extras: { timeZone: TZ, userId: USER, day: DAY } });
    const row = [...db.state.daily_metrics.values()].find((r) => r.day === DAY);
    assert.ok(row, 'daily_metrics written');
    const v1Steps = row.steps;
    const v1Strain = row.strain_score;
    const v1Hr = row.avg_hr_bpm;
    assert.ok(Number.isFinite(Number(v1Steps)));
    assert.ok(Number.isFinite(Number(v1Strain)));
    assert.ok(Number.isFinite(Number(v1Hr)));
    assert.equal(row.spo2_pct, undefined);
    assert.equal(row.provenance.steps.canonical, 'v1');
    assert.ok(row.extras.steps_v2);
    assert.equal(row.extras.steps_v3.unavailable_reason.startsWith('artifact') || row.extras.steps_v3.status === 'unavailable', true);
    assert.ok(row.extras.hr_v2);
    assert.equal(row.extras.hr_v2.mode, 'dual');
    assert.ok(Number.isFinite(Number(row.extras.hr_v2.avg_hr)));
    assert.ok(row.strain_score_v2 != null);
    assert.equal(row.extras.energy_v3_blocker?.reason, 'v21_frames_incomplete');
    assert.equal(row.extras.spo2_candidate?.spo2_pct ?? null, null);

    const snap = await loadDaySnapshot({ rest: restFromDb(db.state), userId: USER, day: DAY, timeZone: TZ });
    assert.ok(snap.shadows?.candidates?.length);
    const whoop = snapshotToWhoopDay(snap);
    assert.equal(whoop.physiological_summary.Steps, v1Steps);
    assert.equal(whoop.physiological_summary['Day Strain'], v1Strain);
    assert.equal(whoop.physiological_summary['Average HR (bpm)'], v1Hr);
    assert.equal(whoop.physiological_summary['Blood oxygen %'], null);

    const stepsV3 = shadowById(snap.shadows, 'steps_v3');
    assert.equal(stepsV3.status, 'artifact_missing');
    assert.equal(stepsV3.shadow_value, null);
    const energyV3 = shadowById(snap.shadows, 'energy_v3');
    assert.equal(energyV3.status, 'input_missing');
    const spo2 = shadowById(snap.shadows, 'spo2_candidate');
    assert.equal(spo2.status, 'experimental');
    const hr2 = shadowById(snap.shadows, 'hr_v2');
    assert.equal(hr2.status, 'shadow');
    const strain2 = shadowById(snap.shadows, 'strain_v2');
    assert.equal(strain2.status, 'shadow');
    const sleepV3 = shadowById(snap.shadows, 'sleep_v3');
    assert.ok(['artifact_missing', 'unavailable', 'shadow'].includes(sleepV3.status));

    const snap2 = await loadDaySnapshot({ rest: restFromDb(db.state), userId: USER, day: DAY, timeZone: TZ });
    assert.equal(snap2.metrics.steps, snap.metrics.steps);
    assert.equal(snap2.metrics.strain_score, snap.metrics.strain_score);
    assert.equal(shadowById(snap2.shadows, 'steps_v3').status, 'artifact_missing');
  });
});

test('canonical Overview scalars match shadow-off when shadow flags are enabled', async () => {
  const samples = nightAndDaySamples();
  const offDb = makeDb();
  const onDb = makeDb();
  const prior = {
    FRWHOOP_HR2: process.env.FRWHOOP_HR2,
    FRWHOOP_STRAIN_V2: process.env.FRWHOOP_STRAIN_V2,
    ENERGY_MODEL_V2: process.env.ENERGY_MODEL_V2,
    ENERGY_MODEL_V3: process.env.ENERGY_MODEL_V3,
  };
  try {
    delete process.env.FRWHOOP_HR2;
    process.env.FRWHOOP_STRAIN_V2 = 'off';
    process.env.ENERGY_MODEL_V2 = 'off';
    process.env.ENERGY_MODEL_V3 = 'off';
    const offEngine = createMetricsEngine({
      cfg: { localUserId: USER, rawStore: 'none', derivedStore: 'none', b2Bucket: 'FRWHOOP', buildHash: 'test' },
      stores: { raw: null, derived: null },
      db: offDb,
      energyContext: async () => ({ profile: PROFILE, workouts: [] }),
      stepsV3Artifact: null,
    });
    await offEngine.persistComputed({ samples, extras: { timeZone: TZ, userId: USER, day: DAY } });
    const off = [...offDb.state.daily_metrics.values()].find((r) => r.day === DAY);

    process.env.FRWHOOP_HR2 = 'dual';
    process.env.FRWHOOP_STRAIN_V2 = 'shadow';
    process.env.ENERGY_MODEL_V2 = 'shadow';
    process.env.ENERGY_MODEL_V3 = 'shadow';
    const onEngine = createMetricsEngine({
      cfg: { localUserId: USER, rawStore: 'none', derivedStore: 'none', b2Bucket: 'FRWHOOP', buildHash: 'test' },
      stores: { raw: null, derived: null },
      db: onDb,
      energyContext: async () => ({ profile: PROFILE, workouts: [] }),
      stepsV3Artifact: null,
    });
    await onEngine.persistComputed({ samples, extras: { timeZone: TZ, userId: USER, day: DAY } });
    const on = [...onDb.state.daily_metrics.values()].find((r) => r.day === DAY);
    assert.equal(on.steps, off.steps);
    assert.equal(on.strain_score, off.strain_score);
    assert.equal(on.avg_hr_bpm, off.avg_hr_bpm);
    assert.equal(on.active_kcal, off.active_kcal);
    assert.equal(on.basal_kcal, off.basal_kcal);
    assert.equal(on.spo2_pct, off.spo2_pct);
    assert.ok(on.extras.hr_v2);
    assert.equal(off.extras?.hr_v2, undefined);
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
