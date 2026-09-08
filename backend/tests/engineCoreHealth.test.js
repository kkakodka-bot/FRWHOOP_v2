import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetricsEngine, dailyToWhoopDay } from '../metrics/engine.js';

const USER = '22222222-2222-4222-8222-222222222222';

function makeEngine() {
  const blobs = new Map();
  const dbRows = { daily_metrics: [], object_manifests: [], sessions: [] };
  const stores = {
    raw: {
      async putObject(key, body) { blobs.set(key, body); return { etag: '"x"' }; },
      async head(key) { const b = blobs.get(key); return b ? { exists: true, contentLength: b.length } : null; },
    },
    derived: { async putObject(key, body) { blobs.set(key, body); return { etag: '"y"' }; } },
  };
  const db = {
    async upsertPayload(payload) {
      if (payload.daily_metrics) dbRows.daily_metrics.push(...payload.daily_metrics);
      if (payload.object_manifests) dbRows.object_manifests.push(...payload.object_manifests);
      if (payload.sessions) dbRows.sessions.push(...payload.sessions);
      return { ok: true };
    },
    throw: null,
  };
  const engine = createMetricsEngine({
    cfg: { localUserId: USER, rawStore: 'b2', derivedStore: 'b2', b2Bucket: 'FRWHOOP', buildHash: 'test' },
    stores,
    db,
  });
  return { engine, dbRows };
}

test('persistComputed resolves WHOOP steps, skin temperature, and avg/max HR into the daily row with provenance', async () => {
  const { engine, dbRows } = makeEngine();
  const samples = [];
  // 40 nighttime samples (HR + steps + skin temp) + 20 daytime samples
  for (let i = 0; i < 40; i += 1) {
    samples.push({
      datetime: new Date(Date.UTC(2026, 7, 23, 23, i)).toISOString(),
      bpm: 52 + (i % 3),
      steps: 1,
      step_cumulative: 100 + i,
      skin_temp_c: 36.5,
    });
  }
  for (let i = 0; i < 20; i += 1) {
    samples.push({
      datetime: new Date(Date.UTC(2026, 7, 24, 6, i)).toISOString(),
      bpm: 58,
      steps: 2,
      step_cumulative: 140 + i,
      skin_temp_c: 36.7,
    });
  }
  await engine.persistComputed({ samples });

  const row = dbRows.daily_metrics.find((r) => r.day === '2026-08-24');
  assert.ok(row, 'daily row written');
  assert.equal(row.steps, 40); // Aug 24 local/UTC only: 20 samples * 2; Aug 23 lookback is not mixed
  // temperature median is within [36.5, 36.7]
  assert.ok(row.skin_temp_c >= 36.5 && row.skin_temp_c <= 36.7);
  assert.equal(row.avg_hr_bpm !== null, true);
  assert.equal(row.max_hr_bpm, 58);
  assert.equal(row.provenance.steps.algorithm_version, 'frwhoop-steps-v1');
  assert.equal(row.provenance.steps.canonical, 'v1');
  assert.equal(row.extras.steps_v2.algorithm_version, 'frwhoop-steps-v2');
  assert.equal(row.extras.steps_v2.source_mode, 'cumulative_fallback');
  assert.equal(row.provenance.skin_temp.algorithm_version, 'frwhoop-skin-temp-v1');
  assert.ok(row.confidence.steps.status);
});

test('daily API keeps energy-engine calories and strap steps instead of mixing HealthKit', () => {
  const day = dailyToWhoopDay({
    steps: 0,
    active_kcal: 9,
    basal_kcal: 36,
    extras: { healthkit: { steps: 1182, active_kcal: 136, hrv_sdnn: 64.1, resp_rate: 17.25 } },
  });
  assert.equal(day.physiological_summary.Steps, 0);
  assert.equal(day.physiological_summary['Energy burned (cal)'], 45);
  assert.equal(day.physiological_summary['Heart rate variability (ms)'], 64.1);
  assert.equal(day.physiological_summary['Respiratory rate (rpm)'], 17.25);
  const strapSteps = dailyToWhoopDay({
    steps: 1182,
    extras: { healthkit: { steps: 9840, resting_hr: 54 } },
  });
  assert.equal(strapSteps.physiological_summary.Steps, 1182);
  assert.equal(strapSteps.physiological_summary['Resting heart rate (bpm)'], null);
  const elapsedDoesNotWin = dailyToWhoopDay({
    active_kcal: 9,
    basal_kcal: 36,
    extras: { energy_elapsed_kcal: 900 },
  });
  assert.equal(elapsedDoesNotWin.physiological_summary['Energy burned (cal)'], 45);
  const namedEnergy = dailyToWhoopDay({
    energy_kcal: 352,
    active_kcal: 9,
    basal_kcal: 36,
    extras: { energy_elapsed_kcal: 900 },
  });
  assert.equal(namedEnergy.physiological_summary['Energy burned (cal)'], 352);
  assert.equal(namedEnergy.availability.energy.status, 'available');
  const zeroEnergy = dailyToWhoopDay({ energy_kcal: 0, steps: 0, strain_score: 0 });
  assert.equal(zeroEnergy.physiological_summary['Energy burned (cal)'], 0);
  assert.equal(zeroEnergy.physiological_summary.Steps, 0);
  assert.equal(zeroEnergy.availability.steps.status, 'available');
  assert.equal(zeroEnergy.availability.steps.source, 'strap');
});
