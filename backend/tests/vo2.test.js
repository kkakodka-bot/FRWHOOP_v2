import assert from 'node:assert/strict';
import test from 'node:test';
import { addDays } from '../vo2/math.js';
import { tanakaHrMax, uthVo2Max } from '../vo2/uth.js';
import { resolveHrMax } from '../vo2/hrMax.js';
import { evaluateEligibility, gpsSessionQuality } from '../vo2/eligibility.js';
import { jacksonVo2, estimatePassive } from '../vo2/passive.js';
import { extractPassiveFeatures } from '../vo2/features.js';
import { acsmOxygenCost, vo2FromCostAndHr, estimateGps } from '../vo2/exercise.js';
import { calculateVo2Max } from '../vo2/engine.js';
import { smoothVo2, weeklyDeltaCap } from '../vo2/smoothing.js';
import {
  appendLabAnchor, emptyVo2State, ensureVo2Store, persistSnapshot, previousSnapshot,
  recordWeightChange,
} from '../vo2/repository.js';
import { resolveWeightKg } from '../vo2/adapter.js';
import { TIERS, ELIGIBILITY } from '../vo2/methodology.js';
import { coachRowToWhoopDay } from '../host/whoopDays.js';
import { cloudRowToDay } from '../coach/days.js';
import { adultProfile, daysWithRecoveries, gpsSamples, runningWorkout } from '../vo2/fixtures.js';

const AS_OF = '2026-03-01';
const PROFILE = adultProfile();

function resultFor({ valid = 21, workoutsByDay = {}, age = 40, labAnchors = [], priorSnapshot, hrMaxOverride } = {}) {
  return calculateVo2Max({
    asOfDay: AS_OF,
    age,
    profile: { ...PROFILE, age },
    days: daysWithRecoveries({ asOfDay: AS_OF, valid, workoutsByDay }),
    labAnchors,
    priorSnapshot,
    hrMaxOverride,
    methodologyVersion: 'vo2_v1',
  }, { calculatedAt: '2026-03-01T12:00:00.000Z' });
}

test('Uth baseline: age 40, RHR 60 → Tanaka 180, VO2 45.9', () => {
  assert.equal(tanakaHrMax(40), 180);
  assert.equal(Number(uthVo2Max(180, 60).toFixed(1)), 45.9);
});

test('HRmax prefers manual, then persistent observed, then Tanaka; spikes are ignored', () => {
  const manual = resolveHrMax({ age: 40, override: { value: 191 }, days: [] });
  assert.equal(manual.source, 'manual_tested');
  assert.equal(manual.value, 191);

  const spike = resolveHrMax({
    age: 40,
    days: [{ day: AS_OF, maxHr: 120, bpmData: [{ bpm: 230 }], workouts: [] }],
  });
  assert.equal(spike.source, 'tanaka_age');
  assert.equal(spike.value, 180);

  const observed = resolveHrMax({
    age: 40,
    days: [
      { day: addDays(AS_OF, -3), maxHr: 188, workouts: [{ maxHr: 188 }] },
      { day: addDays(AS_OF, -1), maxHr: 190, workouts: [{ maxHr: 189 }] },
    ],
  });
  assert.equal(observed.source, 'observed_historical');
  assert.ok(observed.value >= 185 && observed.value <= 192);
});

test('13 recoveries are insufficient; 14 unlock PASSIVE', () => {
  const thirteen = resultFor({ valid: 13 });
  assert.equal(thirteen.eligibility, ELIGIBILITY.INSUFFICIENT_DATA);
  assert.equal(thirteen.tier, TIERS.INSUFFICIENT_DATA);
  assert.equal(thirteen.vo2Max, null);

  const fourteen = resultFor({ valid: 14 });
  assert.equal(fourteen.eligibility, ELIGIBILITY.PASSIVE_ELIGIBLE);
  assert.equal(fourteen.tier, TIERS.PASSIVE);
  assert.ok(fourteen.vo2Max > 20);
});

test('minors have no adult model', () => {
  const kid = resultFor({ valid: 21, age: 16 });
  assert.equal(kid.eligibility, ELIGIBILITY.INSUFFICIENT_DATA);
  assert.equal(kid.tier, TIERS.INSUFFICIENT_DATA);
});

test('14-minute GPS run fails; 15-minute outdoor run can unlock GPS', () => {
  const short = runningWorkout({ durationMin: 14, distanceM: 3500 });
  const long = runningWorkout({ durationMin: 15, distanceM: 3750 });
  assert.equal(gpsSessionQuality(short, 180).ok, false);
  assert.equal(gpsSessionQuality(long, 180).ok, true);

  const noGps = resultFor({
    valid: 14,
    workoutsByDay: { [AS_OF]: [runningWorkout({ durationMin: 14, distanceM: 3500 })] },
  });
  assert.equal(noGps.eligibility, ELIGIBILITY.PASSIVE_ELIGIBLE);

  const gps = resultFor({
    valid: 14,
    workoutsByDay: { [AS_OF]: [long] },
  });
  assert.equal(gps.eligibility, ELIGIBILITY.GPS_ELIGIBLE);
  assert.ok(gps.tier === TIERS.GPS_AUGMENTED || gps.tier === TIERS.PASSIVE);
});

test('GPS jump speeds are rejected', () => {
  const jump = runningWorkout({ durationMin: 15, distanceM: 12000, avgHr: 150 });
  assert.equal(gpsSessionQuality(jump, 180).ok, false);
  const est = estimateGps(jump, 58, 180);
  assert.equal(est, null);
});

test('lower stable HR at the same pace yields higher VO2; faster pace at same %HRmax also yields higher VO2', () => {
  const easy = vo2FromCostAndHr(acsmOxygenCost(3.0, 0), 140, 58, 180);
  const hardHr = vo2FromCostAndHr(acsmOxygenCost(3.0, 0), 160, 58, 180);
  assert.ok(easy > hardHr);

  const faster = vo2FromCostAndHr(acsmOxygenCost(3.6, 0), 150, 58, 180);
  const slower = vo2FromCostAndHr(acsmOxygenCost(3.0, 0), 150, 58, 180);
  assert.ok(faster > slower);

  const lowHrRun = estimateGps(runningWorkout({
    durationMin: 20,
    distanceM: 3600,
    avgHr: 138,
    samples: gpsSamples({ durationMin: 20, speedMps: 3.0, hr: 138 }),
  }), 58, 180);
  const highHrRun = estimateGps(runningWorkout({
    durationMin: 20,
    distanceM: 3600,
    avgHr: 158,
    samples: gpsSamples({ durationMin: 20, speedMps: 3.0, hr: 158 }),
  }), 58, 180);
  assert.ok(lowHrRun && highHrRun);
  assert.ok(lowHrRun.vo2 > highHrRun.vo2);
});

test('a GPS spike does not swing VO2 by ~10 ml/kg/min', () => {
  const clean = estimateGps(runningWorkout({
    durationMin: 20,
    distanceM: 3600,
    avgHr: 150,
    samples: gpsSamples({ durationMin: 20, speedMps: 3.0, hr: 150 }),
  }), 58, 180);
  const spiked = estimateGps(runningWorkout({
    durationMin: 20,
    distanceM: 3600,
    avgHr: 150,
    samples: gpsSamples({ durationMin: 20, speedMps: 3.0, hr: 150, spikeSpeedMps: 12, spikeAtSec: 200 }),
  }), 58, 180);
  assert.ok(clean && spiked);
  assert.ok(Math.abs(spiked.vo2 - clean.vo2) < 10);
});

test('passive ensemble is not Uth alone and uses Jackson when demographics exist', () => {
  const days = daysWithRecoveries({ asOfDay: AS_OF, valid: 21 });
  const features = extractPassiveFeatures({ days, asOfDay: AS_OF, profile: PROFILE, age: 40 });
  const jackson = jacksonVo2(features);
  const passive = estimatePassive({ features, hrMax: 180 });
  const uth = uthVo2Max(180, features.medianRhr);
  assert.ok(jackson != null);
  assert.ok(passive.vo2 != null);
  assert.notEqual(Number(passive.vo2.toFixed(2)), Number(uth.toFixed(2)));
});

test('lab anchors are append-only; user-entered profile VO2 is not a lab anchor', () => {
  const store = ensureVo2Store({ vo2: emptyVo2State() });
  const first = appendLabAnchor(store, { value: 52, modality: 'gas_exchange_gxt', measuredOn: '2025-12-01' });
  const second = appendLabAnchor(store, { value: 54, modality: 'cpet', measuredOn: '2026-02-01' });
  assert.equal(store.vo2.labAnchors.length, 2);
  assert.equal(store.vo2.labAnchors[0].id, first.anchor.id);
  assert.equal(store.vo2.labAnchors[0].value, 52);
  assert.equal(second.anchor.value, 54);

  const withProfileOnly = calculateVo2Max({
    asOfDay: AS_OF,
    profile: { ...PROFILE, vo2Max: 62, vo2MaxSource: 'user_entered' },
    days: daysWithRecoveries({ asOfDay: AS_OF, valid: 21 }),
    labAnchors: [],
  });
  assert.notEqual(withProfileOnly.tier, TIERS.LAB_CALIBRATED);
  assert.equal(withProfileOnly.sources.labAnchor, null);

  const labbed = resultFor({
    valid: 14,
    labAnchors: [{ value: 52, modality: 'gas_exchange_gxt', measuredOn: '2025-12-01', modelAtAnchor: 48 }],
  });
  assert.equal(labbed.eligibility, ELIGIBILITY.LAB_CALIBRATED);
  assert.equal(labbed.tier, TIERS.LAB_CALIBRATED);
});

test('historical weight uses the last plausible value on or before asOfDay', () => {
  const store = ensureVo2Store({ profile: { weightKg: 75 }, vo2: emptyVo2State() });
  recordWeightChange(store, 75, '2026-01-01T00:00:00Z');
  recordWeightChange(store, 74, '2026-02-01T00:00:00Z');
  recordWeightChange(store, 96, '2026-02-03T00:00:00Z');
  const rejected = store.vo2.weightHistory.find((h) => h.quality === 'reject');
  assert.ok(rejected);
  assert.equal(resolveWeightKg(store.profile, store.vo2.weightHistory, '2026-02-01'), 74);
  assert.equal(resolveWeightKg(store.profile, store.vo2.weightHistory, '2026-02-10'), 74);
});

test('smoothing clamps weekly jumps and is stricter for thin passive coverage', () => {
  const cap = weeklyDeltaCap(TIERS.PASSIVE);
  const gpsCap = weeklyDeltaCap(TIERS.GPS_AUGMENTED);
  assert.ok(cap < gpsCap);
  const jumped = smoothVo2({ raw: 70, prior: 45, quality: 0.3, tier: TIERS.PASSIVE });
  assert.ok(Math.abs(jumped.delta) <= cap + 1e-9);
});

test('same input is deterministic; a new methodology version does not rewrite old snapshots', () => {
  const a = resultFor({ valid: 21 });
  const b = resultFor({ valid: 21 });
  assert.equal(a.vo2Max, b.vo2Max);
  assert.equal(a.tier, b.tier);
  assert.deepEqual(a.sources, b.sources);

  const store = ensureVo2Store({ vo2: emptyVo2State() });
  persistSnapshot(store, { ...a, methodologyVersion: 'vo2_v1', effectiveDate: '2026-02-23' });
  persistSnapshot(store, { ...a, vo2Max: a.vo2Max + 1, methodologyVersion: 'vo2_v2', effectiveDate: '2026-02-23' });
  assert.equal(store.vo2.snapshots.length, 2);
  assert.equal(store.vo2.snapshots.find((s) => s.methodologyVersion === 'vo2_v1').vo2Max, a.vo2Max);
  const prior = previousSnapshot(store, '2026-03-02', 'vo2_v1');
  assert.equal(prior.methodologyVersion, 'vo2_v1');
});

test('GPS summary fields survive whoop-day mapping and cloud session conversion', () => {
  const whoop = coachRowToWhoopDay({
    day: AS_OF,
    recovery: 70,
    rhr: 58,
    workouts: [{
      name: 'Running',
      durationMin: 32,
      avgHr: 152,
      maxHr: 178,
      zones: [10, 20, 40, 20, 10],
      gpsEnabled: true,
      distanceM: 6400,
      altitudeGainM: 40,
    }],
  });
  assert.equal(whoop.workouts[0].gpsEnabled, true);
  assert.equal(whoop.workouts[0]['GPS enabled'], true);
  assert.equal(whoop.workouts[0].distanceM, 6400);

  const cloud = cloudRowToDay({
    day: AS_OF,
    sessions: [{
      kind: 'workout',
      start_at: `${AS_OF}T12:00:00Z`,
      end_at: `${AS_OF}T12:32:00Z`,
      summary: {
        sport: 'Running',
        duration_min: 32,
        avg_hr: 152,
        peak_hr: 178,
        gps: true,
        distance_m: 6400,
        altitude_gain_m: 40,
        samples: [{ t: 0, hr: 140, speedMps: 3 }],
      },
    }],
  });
  assert.equal(cloud.workouts[0].gpsEnabled, true);
  assert.equal(cloud.workouts[0].distanceM, 6400);
  assert.equal(cloud.workouts[0].samples.length, 1);
});
