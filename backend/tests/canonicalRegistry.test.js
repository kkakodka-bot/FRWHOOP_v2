import assert from 'node:assert/strict';
import test from 'node:test';
import {
  metricRegistry,
  canonicalIds,
  inspectRequiredArtifacts,
  presentMetric,
  resolveEnergyKcal,
  resolveSteps,
  buildAvailability,
  energyV3ComputeMode,
  energyV2ComputeMode,
  applyDailyMetricsPersist,
  persistDestinations,
  HR_EXPECTED_BUCKETS,
} from '../metrics/canonicalRegistry.js';

test('defaults keep V1 canonical; V2/V3 stay off the product columns', () => {
  const env = {};
  const ids = canonicalIds(env);
  assert.deepEqual(
    ids.sort(),
    ['energy', 'hr', 'hrv', 'rhr', 'skin_temp', 'sleep', 'steps', 'strain'].sort(),
  );
  const reg = metricRegistry(env);
  assert.equal(reg.steps.status, 'canonical');
  assert.equal(reg.steps_v3.status, 'shadow');
  assert.equal(reg.steps_v2.status, 'shadow');
  assert.equal(reg.strain.status, 'canonical');
  assert.equal(reg.strain_v2.status, 'disabled');
  assert.equal(reg.energy.status, 'canonical');
  assert.equal(reg.energy_v3.status, 'disabled');
  assert.equal(reg.hr.status, 'canonical');
  assert.equal(reg.hr_v2.status, 'disabled');
  assert.equal(reg.spo2_candidate.status, 'shadow');
  assert.equal(reg.energy_v2.status, 'disabled');
  assert.equal(canonicalIds(env).includes('spo2_candidate'), false);
  assert.equal(inspectRequiredArtifacts(env).length, 0);
});

test('explicit env cannot promote Energy V3, Energy V2, or HR V2 onto product columns', () => {
  const promoted = metricRegistry({ ENERGY_MODEL_V3: 'on', ENERGY_MODEL_V2: 'on', FRWHOOP_HR2: 'v2' });
  assert.equal(promoted.energy.status, 'canonical');
  assert.equal(promoted.energy_v3.status, 'shadow');
  assert.equal(promoted.energy_v2.status, 'shadow');
  assert.equal(promoted.hr.status, 'canonical');
  assert.equal(promoted.hr_v2.status, 'shadow');
  assert.equal(metricRegistry({}).energy_v3.status, 'disabled');
  assert.equal(metricRegistry({}).energy_v2.status, 'disabled');
  assert.deepEqual(
    canonicalIds({ ENERGY_MODEL_V3: 'on', ENERGY_MODEL_V2: 'on', FRWHOOP_HR2: 'v2' }).sort(),
    ['energy', 'hr', 'hrv', 'rhr', 'skin_temp', 'sleep', 'steps', 'strain'].sort(),
  );
  assert.equal(energyV3ComputeMode({ ENERGY_MODEL_V3: 'on' }), 'shadow');
  assert.equal(energyV3ComputeMode({}), 'off');
  assert.equal(energyV2ComputeMode({ ENERGY_MODEL_V2: 'on' }), 'shadow');
  assert.equal(energyV2ComputeMode({ ENERGY_MODEL_V2: 'shadow' }), 'shadow');
  assert.equal(energyV2ComputeMode({}), 'off');
});

test('presentMetric keeps numeric 0 and treats null as unavailable', () => {
  assert.equal(presentMetric(0), 0);
  assert.equal(presentMetric('0'), 0);
  assert.equal(presentMetric(null), null);
  assert.equal(presentMetric(''), null);
  assert.equal(presentMetric(undefined), null);
});

test('availability: 0 is available, missing is unavailable, HR coverage is 5-min buckets', () => {
  const empty = buildAvailability({});
  assert.equal(empty.hr.status, 'unavailable');
  assert.equal(empty.steps.status, 'unavailable');
  assert.equal(empty.sleep.status, 'unavailable');
  assert.equal(empty.sleep.kind, 'unavailable');
  assert.equal(empty.rhr.status, 'unavailable');
  assert.equal(empty.energy.status, 'unavailable');
  assert.equal(empty.strain.status, 'unavailable');
  assert.equal(empty.skin_temp.status, 'unavailable');
  assert.equal(empty.hr.expected_buckets, HR_EXPECTED_BUCKETS);

  const zeros = buildAvailability({
    metrics: {
      steps: 0,
      strain_score: 0,
      resting_hr_bpm: 0,
      hrv_rmssd_ms: 0,
      active_kcal: 0,
      basal_kcal: 0,
      energy_kcal: 0,
      sleep_total_min: 0,
    },
    chart: [{ t: '2026-08-24T00:00:00.000Z', avg_hr: 62 }],
    sleep: [{ asleep_min: 0 }],
  });
  assert.equal(zeros.steps.status, 'available');
  assert.equal(zeros.steps.value, 0);
  assert.equal(zeros.strain.status, 'available');
  assert.equal(zeros.rhr.status, 'available');
  assert.equal(zeros.hrv.status, 'available');
  assert.equal(zeros.energy.status, 'available');
  assert.equal(zeros.energy.energy_kcal, 0);
  assert.equal(zeros.sleep.status, 'available');
  assert.equal(zeros.sleep.kind, 'complete');
  assert.equal(zeros.hr.status, 'available');
  assert.equal(zeros.hr.buckets, 1);
  assert.equal(zeros.hr.coverage_pct, Math.round(1000 / HR_EXPECTED_BUCKETS) / 10);
});

test('energy precedence is named total, then active+basal; steps are strap-only', () => {
  assert.equal(resolveEnergyKcal({ energy_kcal: 352, active_kcal: 10, basal_kcal: 20 }), 352);
  assert.equal(resolveEnergyKcal({ active_kcal: 11.03, basal_kcal: 51.29 }), 62.32);
  assert.equal(resolveEnergyKcal({ energy_kcal: 0 }), 0);
  assert.equal(resolveEnergyKcal({}), null);
  assert.equal(resolveEnergyKcal({ energy_kcal: null, extras: { energy_elapsed_kcal: 900 } }), null);
  assert.equal(resolveSteps({ steps: 0, watch_steps: 13146 }), 0);
  assert.equal(resolveSteps({ watch_steps: 13146 }), null);

  const watchOnly = buildAvailability({ metrics: { watch_steps: 13146 } });
  assert.equal(watchOnly.steps.status, 'unavailable');
  assert.equal(watchOnly.steps.source, null);
  assert.equal(watchOnly.steps.watch_steps, 13146);

  const strap = buildAvailability({ metrics: { steps: 4000, watch_steps: 13146 } });
  assert.equal(strap.steps.status, 'available');
  assert.equal(strap.steps.source, 'strap');
  assert.equal(strap.steps.value, 4000);
  assert.equal(strap.steps.watch_steps, 13146);

  const hrOnly = buildAvailability({
    sleep: [{ persist_state: 'provisional', asleep_min: 240, is_nap: false }],
  });
  assert.equal(hrOnly.sleep.status, 'provisional');
  assert.equal(hrOnly.sleep.kind, 'provisional');
  assert.equal(hrOnly.sleep.source, 'sleep_details');
});

test('registry persist destinations own the V1 daily_metrics columns', () => {
  const dest = persistDestinations({}).filter((d) => d.status === 'canonical' && d.table === 'daily_metrics');
  assert.deepEqual(
    dest.map((d) => [d.id, d.column || d.columns.join(',')]).sort(),
    [
      ['energy', 'active_kcal,basal_kcal'],
      ['hrv', 'hrv_rmssd_ms'],
      ['rhr', 'resting_hr_bpm'],
      ['skin_temp', 'skin_temp_c'],
      ['steps', 'steps'],
      ['strain', 'strain_score'],
    ].sort(),
  );
  const row = applyDailyMetricsPersist({ effort: 4.4 }, {
    strain: 0,
    steps: 12,
    rhr: 52,
    hrv: 0,
    energy: { active_kcal: 10, basal_kcal: 20 },
  });
  assert.equal(row.strain_score, 0);
  assert.equal(row.steps, 12);
  assert.equal(row.resting_hr_bpm, 52);
  assert.equal(row.hrv_rmssd_ms, 0);
  assert.equal(row.active_kcal, 10);
  assert.equal(row.basal_kcal, 20);
  assert.equal(row.effort, 4.4);
  const omitted = applyDailyMetricsPersist({}, {});
  assert.equal('strain_score' in omitted, false);
  const shadowOff = applyDailyMetricsPersist({}, { strain_v2: 9.9 }, {});
  assert.equal('strain_score_v2' in shadowOff, false);
  const shadowOn = applyDailyMetricsPersist({}, { strain_v2: 9.9 }, { FRWHOOP_STRAIN_V2: 'shadow' });
  assert.equal(shadowOn.strain_score_v2, 9.9);
  const candidate = applyDailyMetricsPersist({}, {
    spo2_candidate: { spo2_candidate_pct: 96, spo2_pct: null },
  });
  assert.equal('spo2_pct' in candidate, false);
});
