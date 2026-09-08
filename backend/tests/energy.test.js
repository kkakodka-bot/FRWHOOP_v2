import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVITY,
  ACTIVITY_MODEL,
  MOTION_MET_ANCHORS,
  interpolateAnchors,
} from '../energy/constants.js';
import {
  hrEffortFraction,
  katchMcArdle,
  mifflinStJeor,
  resolvePhysiology,
  vo2ToKcalPerMin,
  vo2ToMet,
  applyCalibration,
} from '../energy/physiology.js';
import { extractMinuteFeatures, extractSeriesFeatures, rrStats, scoreQuality } from '../energy/features.js';
import { activityFromSport, classifyActivity } from '../energy/activity.js';
import { estimateVo2FromHr, estimateVo2FromMotion, routeEstimate } from '../energy/estimators.js';
import { aggregateDay, aggregateWorkouts, computeEnergyMinutes, currentBurnRate } from '../energy/engine.js';
import { computeEnergy } from '../energy/service.js';
import { baselineKeytel, legacyFixedMet } from '../energy/baselines.js';
import { fitCalibration } from '../energy/calibration.js';

const PROFILE = { sex: 'male', birthYear: 1994, heightCm: 180, weightKg: 78 };
const PREFS = { restingHr: 52 };
const USER = '7f2c9a10-4b3e-4d8a-9c11-00000000f001';
const T0 = Date.parse('2026-08-24T15:00:00Z');

function phys(over = {}) {
  return resolvePhysiology({ profile: { ...PROFILE, ...over.profile }, prefs: { ...PREFS, ...over.prefs } });
}

/** Build samples at the strap's ~4 s cadence. */
function samples({ startMs = T0, minutes = 10, bpm = 60, mot = 0.01, stage = null, extra = {} } = {}) {
  const out = [];
  for (let s = 0; s < minutes * 60; s += 4) {
    out.push({
      t: new Date(startMs + s * 1000).toISOString(),
      bpm: typeof bpm === 'function' ? bpm(s) : bpm,
      mot: typeof mot === 'function' ? mot(s) : mot,
      stage,
      rr_ms: [960, 970, 955],
      ...extra,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resting metabolism and unit conversion
// ---------------------------------------------------------------------------

test('Mifflin-St Jeor matches the published equation', () => {
  // 10(80) + 6.25(180) - 5(30) + 5 = 800 + 1125 - 150 + 5
  assert.equal(mifflinStJeor({ weightKg: 80, heightCm: 180, age: 30, sex: 'male' }), 1780);
  assert.equal(mifflinStJeor({ weightKg: 60, heightCm: 165, age: 30, sex: 'female' }), 10 * 60 + 6.25 * 165 - 150 - 161);
  assert.equal(mifflinStJeor({ weightKg: 60, heightCm: 165, age: 30, sex: null }), 10 * 60 + 6.25 * 165 - 150 - 78);
  assert.equal(mifflinStJeor({ weightKg: null, heightCm: 180, age: 30, sex: 'male' }), null);
});

test('Katch-McArdle is used when body composition is known', () => {
  assert.equal(katchMcArdle({ leanMassKg: 60 }), 370 + 21.6 * 60);
  assert.equal(katchMcArdle({ leanMassKg: 5 }), null);
  const withComp = phys({ profile: { leanBodyMassPct: 80 } });
  assert.equal(withComp.restingSource, 'katch_mcardle');
  assert.equal(phys().restingSource, 'mifflin_st_jeor');
});

test('resting VO2 round-trips back to resting kcal, which is what makes total = resting + active', () => {
  const p = phys();
  const backOut = vo2ToKcalPerMin(p.restingVo2, p);
  // restingVo2 is clamped, so allow the clamp band rather than exact equality.
  assert.ok(Math.abs(backOut - p.restingKcalPerMin) < 0.02, `${backOut} vs ${p.restingKcalPerMin}`);
});

test('MET is reported in conventional Compendium units', () => {
  assert.equal(vo2ToMet(3.5), 1);
  assert.equal(vo2ToMet(35), 10);
});

test('resting VO2 is anchored to the subject, not the 3.5 convention', () => {
  // A heavy, older subject has a lower resting VO2 per kg than 3.5, and using the
  // convention for them would overstate every MET-derived kcal.
  const heavy = resolvePhysiology({ profile: { sex: 'male', birthYear: 1960, heightCm: 170, weightKg: 130 }, prefs: { restingHr: 70 } });
  assert.ok(heavy.restingVo2 < 3.5, `expected < 3.5, got ${heavy.restingVo2}`);
});

// ---------------------------------------------------------------------------
// Flex HR: the correction that stops phantom calories at rest
// ---------------------------------------------------------------------------

test('flex HR sits above resting and below the exercise range', () => {
  const p = phys();
  assert.ok(p.flexHr > p.restingHr, 'flex must be above resting');
  assert.ok(p.flexHr < p.restingHr + 0.35 * p.hrReserve, 'flex must stay well below exercise HR');
});

test('below flex HR, a small HR rise costs at most 25% above resting', () => {
  const p = phys();
  const atRest = estimateVo2FromHr({ hr: p.restingHr }, p, ACTIVITY.SEDENTARY);
  const atFlex = estimateVo2FromHr({ hr: p.flexHr }, p, ACTIVITY.SEDENTARY);
  assert.ok(Math.abs(atRest - p.restingVo2) < 0.01);
  assert.ok(Math.abs(atFlex - p.restingVo2 * 1.25) < 0.01);
});

test('the flex branches meet continuously', () => {
  const p = phys();
  const below = estimateVo2FromHr({ hr: p.flexHr - 0.01 }, p, ACTIVITY.SEDENTARY);
  const above = estimateVo2FromHr({ hr: p.flexHr + 0.01 }, p, ACTIVITY.SEDENTARY);
  assert.ok(Math.abs(above - below) < 0.05, `discontinuity: ${below} -> ${above}`);
});

test('sitting still all day does not manufacture active calories', () => {
  const r = computeEnergy({ samples: samples({ minutes: 60, bpm: 61, mot: 0.01 }), profile: PROFILE, prefs: PREFS, userId: USER });
  const active = r.minutes.reduce((a, m) => a + m.active_kcal, 0);
  // An hour of sitting should be a small NEAT contribution, not a workout.
  assert.ok(active < 20, `an hour of sitting produced ${active} active kcal`);
  assert.ok(active >= 0);
});

test('hrEffortFraction is negative below flex and 1 at HRmax', () => {
  const p = phys();
  assert.ok(hrEffortFraction(p.restingHr, p) < 0);
  assert.ok(Math.abs(hrEffortFraction(p.flexHr, p)) < 1e-9);
  assert.ok(Math.abs(hrEffortFraction(p.hrMax, p) - 1) < 1e-9);
  assert.equal(hrEffortFraction(null, p), null);
});

// ---------------------------------------------------------------------------
// Features and signal quality
// ---------------------------------------------------------------------------

test('RR artefact rejection excludes out-of-range and >20% jumps', () => {
  const clean = rrStats([900, 910, 905, 915]);
  assert.equal(clean.count, 4);
  assert.equal(clean.rejected, 0);
  assert.ok(clean.rmssd > 0);

  const dirty = rrStats([900, 40, 910, 5000, 2000]);
  assert.ok(dirty.rejected >= 3, `rejected ${dirty.rejected}`);
  assert.ok(dirty.artifactFraction > 0.5);
});

test('impossible HR values are treated as absent, not clamped into range', () => {
  const row = extractMinuteFeatures(T0, samples({ minutes: 1, bpm: 400, mot: 0.3 }).map((s, i) => ({ ...s, ts: T0 + i * 4000 })));
  assert.equal(row.features.hr, null);
  assert.equal(row.features.hrCount, 0);
  assert.ok(row.quality.flags.includes('hr_absent'));
  assert.equal(row.quality.hr, 0);
});

test('a minute with neither HR nor motion yields no features at all', () => {
  const row = extractMinuteFeatures(T0, [{ ts: T0, bpm: null, mot: null }]);
  assert.equal(row, null);
});

test('optical relock spikes are flagged and reduce HR quality', () => {
  const jumpy = [];
  for (let i = 0; i < 15; i += 1) {
    jumpy.push({ ts: T0 + i * 4000, bpm: i % 2 ? 70 : 140, mot: 0.05, rr_ms: [] });
  }
  const row = extractMinuteFeatures(T0, jumpy);
  assert.ok(row.features.implausibleJumps > 0);
  assert.ok(row.quality.flags.includes('hr_jumps'));
  assert.ok(row.quality.hr < 0.5, `hr quality ${row.quality.hr}`);
});

test('coverage drives quality: two samples is not a well-measured minute', () => {
  const sparse = scoreQuality({ hrCount: 2, hrCoverage: 2 / 15, motionCount: 0, motionCoverage: 0, rrCount: 0, rrArtifactFraction: 1, maxGapSeconds: 28, disconnectedSamples: 0, implausibleJumps: 0, hrStd: 1, reportedQuality: null, lastSampleAgeSeconds: 5 });
  const full = scoreQuality({ hrCount: 15, hrCoverage: 1, motionCount: 15, motionCoverage: 1, rrCount: 20, rrArtifactFraction: 0, maxGapSeconds: 4, disconnectedSamples: 0, implausibleJumps: 0, hrStd: 2, reportedQuality: 1, lastSampleAgeSeconds: 2 });
  assert.ok(full.overall > sparse.overall + 0.3, `${full.overall} vs ${sparse.overall}`);
});

test('features never fabricate a channel that was not sampled', () => {
  const noMotion = extractMinuteFeatures(T0, samples({ minutes: 1, bpm: 70, mot: null }).map((s, i) => ({ ...s, ts: T0 + i * 4000 })));
  assert.equal(noMotion.features.motion, null);
  assert.equal(noMotion.features.motionCount, 0);
  assert.ok(noMotion.quality.flags.includes('motion_absent'));
});

// ---------------------------------------------------------------------------
// Activity classification and routing
// ---------------------------------------------------------------------------

test('sport labels are matched as prefixes so compound names resolve', () => {
  assert.equal(activityFromSport('Weightlifting'), ACTIVITY.STRENGTH);
  assert.equal(activityFromSport('Powerlifting'), ACTIVITY.STRENGTH);
  assert.equal(activityFromSport('Running'), ACTIVITY.RUNNING);
  assert.equal(activityFromSport('Trail Running'), ACTIVITY.RUNNING);
  assert.equal(activityFromSport('Cycling'), ACTIVITY.CYCLING);
  assert.equal(activityFromSport('Walking'), ACTIVITY.WALKING);
  assert.equal(activityFromSport('Swimming'), null);
  assert.equal(activityFromSport(null), null);
});

test('a labelled workout routes to its own estimator', () => {
  const p = phys();
  const { features, quality } = extractMinuteFeatures(T0, samples({ minutes: 1, bpm: 130, mot: 0.18 }).map((s, i) => ({ ...s, ts: T0 + i * 4000 })));
  const cls = classifyActivity(features, p, quality, { workout: { id: 'w1', sport: 'Weightlifting' } });
  assert.equal(cls.activity, ACTIVITY.STRENGTH);
  assert.equal(routeEstimate({ features, quality, physiology: p, activity: cls.activity, activityConfidence: cls.confidence }).estimator, 'strength');
});

test('a quiet wrist with a high heart rate is an effort, not sedentary time', () => {
  const p = phys();
  const { features, quality } = extractMinuteFeatures(T0, samples({ minutes: 1, bpm: 150, mot: 0.01 }).map((s, i) => ({ ...s, ts: T0 + i * 4000 })));
  const cls = classifyActivity(features, p, quality, {});
  assert.equal(cls.activity, ACTIVITY.WORKOUT_OTHER);

  // And the estimate must not be dragged down by the stationary wrist: indoor
  // cycling really does cost 8+ METs while the arms do nothing.
  const est = routeEstimate({ features, quality, physiology: p, activity: cls.activity, activityConfidence: cls.confidence });
  assert.ok(est.met > 8, `stationary-wrist effort estimated at only ${est.met} MET`);
  assert.ok(est.weights.motion < est.weights.hr, 'motion should be down-weighted here');
});

test('sleep is bounded by physiology even if HR spikes', () => {
  const p = phys();
  const { features, quality } = extractMinuteFeatures(T0, samples({ minutes: 1, bpm: 140, mot: 0.005, stage: 'deep' }).map((s, i) => ({ ...s, ts: T0 + i * 4000 })));
  const cls = classifyActivity(features, p, quality, {});
  assert.equal(cls.activity, ACTIVITY.SLEEP);
  const est = routeEstimate({ features, quality, physiology: p, activity: cls.activity, activityConfidence: cls.confidence });
  assert.ok(est.met < 1.1, `sleep minute estimated at ${est.met} MET`);
});

test('degraded HR during strength work shifts weight onto motion', () => {
  const p = phys();
  const good = extractMinuteFeatures(T0, samples({ minutes: 1, bpm: 130, mot: 0.18 }).map((s, i) => ({ ...s, ts: T0 + i * 4000 })));
  const bad = extractMinuteFeatures(T0, samples({ minutes: 1, bpm: 130, mot: 0.18, extra: { q: 0.15 } }).map((s, i) => ({ ...s, ts: T0 + i * 4000 })));
  const opts = { physiology: p, activity: ACTIVITY.STRENGTH, activityConfidence: 0.9 };
  const a = routeEstimate({ features: good.features, quality: good.quality, ...opts });
  const b = routeEstimate({ features: bad.features, quality: bad.quality, ...opts });
  assert.ok(b.weights.hr < a.weights.hr, `hr weight did not fall: ${a.weights.hr} -> ${b.weights.hr}`);
  assert.ok(bad.quality.flags.includes('device_low_quality'));
});

test('the HR channel is refused rather than guessed when resting HR is unknown', () => {
  const noRhr = resolvePhysiology({ profile: PROFILE, prefs: {} });
  assert.equal(noRhr.restingHr, null);
  assert.equal(estimateVo2FromHr({ hr: 120 }, noRhr, ACTIVITY.WALKING), null);
  assert.ok(noRhr.notes.includes('resting_hr_unknown'));
});

test('estimates stay inside the plausible band for their activity', () => {
  const p = phys();
  for (const activity of [ACTIVITY.SEDENTARY, ACTIVITY.WALKING, ACTIVITY.RUNNING, ACTIVITY.STRENGTH, ACTIVITY.CYCLING]) {
    const { features, quality } = extractMinuteFeatures(T0, samples({ minutes: 1, bpm: 200, mot: 3 }).map((s, i) => ({ ...s, ts: T0 + i * 4000 })));
    const est = routeEstimate({ features, quality, physiology: p, activity, activityConfidence: 0.9 });
    assert.ok(est.met <= ACTIVITY_MODEL[activity].metMax + 1e-6, `${activity} exceeded its ceiling: ${est.met}`);
    assert.ok(est.vo2 >= p.restingVo2 * 0.9, `${activity} fell below resting: ${est.vo2}`);
  }
});

test('motion anchors are monotonic in motion intensity', () => {
  for (const [activity, anchors] of Object.entries(MOTION_MET_ANCHORS)) {
    let prev = -Infinity;
    for (const [, met] of anchors) {
      assert.ok(met >= prev, `${activity} anchors are not monotonic`);
      prev = met;
    }
  }
  assert.equal(interpolateAnchors([[0, 1], [1, 3]], 0.5), 2);
  assert.equal(interpolateAnchors([[0, 1], [1, 3]], -5), 1, 'flat below the first anchor');
  assert.equal(interpolateAnchors([[0, 1], [1, 3]], 99), 3, 'flat above the last anchor');
});

test('a motion-only minute still produces an estimate', () => {
  const p = phys();
  const { features, quality } = extractMinuteFeatures(T0, samples({ minutes: 1, bpm: null, mot: 0.3 }).map((s, i) => ({ ...s, ts: T0 + i * 4000 })));
  assert.ok(estimateVo2FromMotion(features, p, ACTIVITY.WALKING) > p.restingVo2);
  const est = routeEstimate({ features, quality, physiology: p, activity: ACTIVITY.WALKING, activityConfidence: 0.6 });
  assert.ok(est != null && est.weights.hr === 0);
});

// ---------------------------------------------------------------------------
// Calorie semantics: the Phase 7 contract
// ---------------------------------------------------------------------------

test('total = resting + active on every minute, and active is never negative', () => {
  const r = computeEnergy({
    samples: [
      ...samples({ minutes: 20, bpm: 55, mot: 0.005, stage: 'deep' }),
      ...samples({ startMs: T0 + 20 * 60000, minutes: 20, bpm: 150, mot: 0.9 }),
    ],
    profile: PROFILE,
    prefs: PREFS,
    userId: USER,
  });
  assert.ok(r.minutes.length >= 39);
  for (const m of r.minutes) {
    assert.ok(m.active_kcal >= 0, `negative active kcal at ${m.minute_at}`);
    assert.ok(m.resting_kcal > 0);
    assert.ok(Number.isFinite(m.met) && m.met > 0);
  }
});

test('workout calories are a subset of active calories, never an addition', () => {
  const workout = { id: 'w1', sport: 'Running', start: new Date(T0 + 5 * 60000).toISOString(), end: new Date(T0 + 15 * 60000).toISOString() };
  const r = computeEnergy({
    samples: samples({ minutes: 25, bpm: (s) => (s > 300 && s < 900 ? 160 : 65), mot: (s) => (s > 300 && s < 900 ? 0.9 : 0.02) }),
    profile: PROFILE,
    prefs: PREFS,
    workouts: [workout],
    userId: USER,
  });
  const [day] = r.daily;
  assert.ok(day.workout_kcal > 0, 'no workout energy attributed');
  assert.ok(day.workout_kcal <= day.active_kcal + 1e-6, 'workout energy exceeded active energy');
  assert.ok(Math.abs(day.total_kcal - (day.resting_kcal + day.active_kcal)) < 0.05);

  const [w] = r.workouts;
  const tagged = r.minutes.filter((m) => m.workout_session_id === 'w1');
  assert.equal(w.coverage_minutes, tagged.length);
  assert.ok(Math.abs(w.active_kcal - tagged.reduce((a, m) => a + m.active_kcal, 0)) < 0.05);
});

test('daily aggregation is recomputed, so running it twice gives the same answer', () => {
  const rows = computeEnergy({ samples: samples({ minutes: 30, bpm: 90, mot: 0.2 }), profile: PROFILE, prefs: PREFS, userId: USER }).minutes;
  assert.deepEqual(aggregateDay(rows), aggregateDay([...rows].reverse()));
});

test('projected total is separated from the measured total', () => {
  const [day] = computeEnergy({ samples: samples({ minutes: 30, bpm: 70, mot: 0.05 }), profile: PROFILE, prefs: PREFS, userId: USER }).daily;
  assert.equal(day.coverage_minutes, 30);
  assert.equal(day.gap_minutes, 1410);
  assert.ok(day.projected_total_kcal > day.total_kcal, 'projection should exceed the measured total');
  assert.ok(Math.abs(day.projected_total_kcal - (day.total_kcal + day.resting_gap_kcal)) < 0.05);
  // The projection is resting-only. It must never imply active energy we did not measure.
  assert.ok(day.resting_gap_kcal / day.gap_minutes < day.resting_kcal / day.coverage_minutes + 1e-6);
});

test('elapsed total fills only the hours that have already passed', () => {
  const t0 = Date.UTC(2026, 7, 25, 7, 0, 0); // 00:00 America/Los_Angeles on 2026-08-25
  const now = t0 + 7 * 3600_000;
  const [day] = computeEnergy({
    samples: samples({ startMs: t0, minutes: 30, bpm: 62, mot: 0.04 }),
    profile: PROFILE,
    prefs: PREFS,
    userId: USER,
    timeZone: 'America/Los_Angeles',
    now,
  }).daily;
  assert.equal(day.coverage_minutes, 30);
  assert.ok(day.elapsed_total_kcal > day.total_kcal, 'elapsed fill includes morning gaps');
  assert.ok(day.elapsed_total_kcal < day.projected_total_kcal, 'elapsed must not include the rest of the day');
  const restingPerMin = day.resting_kcal / day.coverage_minutes;
  const expected = day.total_kcal + restingPerMin * (7 * 60 - 30);
  assert.ok(Math.abs(day.elapsed_total_kcal - expected) < 0.2);
});

// ---------------------------------------------------------------------------
// Edge cases from Phase 19
// ---------------------------------------------------------------------------

test('gaps stay gaps: a disconnect produces missing rows, not zeros', () => {
  const r = computeEnergy({
    samples: [
      ...samples({ minutes: 5, bpm: 70, mot: 0.05 }),
      ...samples({ startMs: T0 + 60 * 60000, minutes: 5, bpm: 70, mot: 0.05 }),
    ],
    profile: PROFILE,
    prefs: PREFS,
    userId: USER,
  });
  assert.equal(r.minutes.length, 10);
  const [day] = r.daily;
  assert.equal(day.coverage_minutes, 10);
  assert.equal(day.gap_minutes, 1430);
});

test('a minute with no usable channel is skipped, not invented', () => {
  const r = computeEnergy({
    samples: samples({ minutes: 3, bpm: 400, mot: null }),
    profile: PROFILE,
    prefs: PREFS,
    userId: USER,
  });
  assert.equal(r.minutes.length, 0);
  assert.equal(r.stats.skipped, 0, 'no features at all, so nothing even reaches the estimator');
});

test('duplicate and out-of-order batches converge on the same minute rows', () => {
  const base = samples({ minutes: 10, bpm: 95, mot: 0.25 });
  const straight = computeEnergy({ samples: base, profile: PROFILE, prefs: PREFS, userId: USER });
  const shuffled = computeEnergy({
    samples: [...base].reverse().concat(base.slice(0, 40)),
    profile: PROFILE,
    prefs: PREFS,
    userId: USER,
  });
  assert.equal(straight.minutes.length, shuffled.minutes.length);
  assert.deepEqual(
    straight.minutes.map((m) => [m.minute_at, m.met]),
    shuffled.minutes.map((m) => [m.minute_at, m.met]),
  );
});

test('midnight crossing splits into two local days', () => {
  const start = Date.parse('2026-08-24T06:50:00Z'); // 23:50 the previous day in LA
  const r = computeEnergy({
    samples: samples({ startMs: start, minutes: 20, bpm: 80, mot: 0.1 }),
    profile: PROFILE,
    prefs: PREFS,
    timeZone: 'America/Los_Angeles',
    userId: USER,
  });
  const days = new Set(r.minutes.map((m) => m.day));
  assert.equal(days.size, 2, `expected two local days, got ${[...days]}`);
  assert.equal(r.daily.length, 2);
});

test('a DST spring-forward day still assigns every minute to one local day', () => {
  // 2026-03-08 02:00 local does not exist in America/Los_Angeles.
  const start = Date.parse('2026-03-08T09:55:00Z');
  const r = computeEnergy({
    samples: samples({ startMs: start, minutes: 10, bpm: 80, mot: 0.1 }),
    profile: PROFILE,
    prefs: PREFS,
    timeZone: 'America/Los_Angeles',
    userId: USER,
  });
  assert.ok(r.minutes.length > 0);
  for (const m of r.minutes) assert.equal(m.day, '2026-03-08');
});

test('a workout crossing midnight keeps one workout but two days', () => {
  const start = Date.parse('2026-08-24T06:50:00Z');
  const workout = { id: 'w1', sport: 'Running', start: new Date(start).toISOString(), end: new Date(start + 20 * 60000).toISOString() };
  const r = computeEnergy({
    samples: samples({ startMs: start, minutes: 20, bpm: 155, mot: 0.85 }),
    profile: PROFILE,
    prefs: PREFS,
    workouts: [workout],
    timeZone: 'America/Los_Angeles',
    userId: USER,
  });
  assert.equal(r.workouts.length, 1);
  assert.equal(r.daily.length, 2);
  const total = r.daily.reduce((a, d) => a + d.workout_kcal, 0);
  assert.ok(Math.abs(total - r.workouts[0].active_kcal) < 0.05, 'workout energy must survive the day split intact');
});

test('overlapping workouts assign each minute to exactly one session', () => {
  const a = { id: 'wa', sport: 'Running', start: new Date(T0).toISOString(), end: new Date(T0 + 20 * 60000).toISOString() };
  const b = { id: 'wb', sport: 'Weightlifting', start: new Date(T0 + 5 * 60000).toISOString(), end: new Date(T0 + 10 * 60000).toISOString() };
  const r = computeEnergy({ samples: samples({ minutes: 20, bpm: 150, mot: 0.6 }), profile: PROFILE, prefs: PREFS, workouts: [a, b], userId: USER });
  const counts = new Map();
  for (const m of r.minutes) counts.set(m.workout_session_id, (counts.get(m.workout_session_id) || 0) + 1);
  // Longest containing span wins, deterministically.
  assert.equal(counts.get('wa'), r.minutes.length);
  assert.equal(counts.get('wb'), undefined);
  const [day] = r.daily;
  assert.ok(day.workout_kcal <= day.active_kcal + 1e-6);
});

test('a weight change mid-day changes only the minutes computed after it', () => {
  const light = computeEnergy({ samples: samples({ minutes: 5, bpm: 120, mot: 0.4 }), profile: PROFILE, prefs: PREFS, userId: USER });
  const heavy = computeEnergy({ samples: samples({ minutes: 5, bpm: 120, mot: 0.4 }), profile: { ...PROFILE, weightKg: 95 }, prefs: PREFS, userId: USER });
  assert.ok(heavy.minutes[0].resting_kcal > light.minutes[0].resting_kcal);
  // Rows are keyed by minute, so a recompute replaces rather than duplicates.
  assert.equal(heavy.minutes[0].minute_at, light.minutes[0].minute_at);
});

test('24 hours of continuous data produces one fully covered day of 1440 rows', () => {
  const midnightUtc = Date.parse('2026-08-24T00:00:00Z');
  const r = computeEnergy({
    samples: samples({ startMs: midnightUtc, minutes: 1440, bpm: 70, mot: 0.05 }),
    profile: PROFILE,
    prefs: PREFS,
    userId: USER,
  });
  assert.equal(r.minutes.length, 1440);
  assert.equal(r.daily.length, 1);
  assert.equal(r.daily[0].coverage_minutes, 1440);
  assert.equal(r.daily[0].gap_minutes, 0);
  assert.equal(r.daily[0].resting_gap_kcal, 0);
  assert.equal(r.daily[0].projected_total_kcal, r.daily[0].total_kcal);
});

test('cardiovascular drift discounts prolonged steady effort but not a fresh bout', () => {
  const p = phys();
  const f = { hr: 150 };
  const fresh = estimateVo2FromHr(f, p, ACTIVITY.RUNNING, { sustainedEffortMinutes: 0 });
  const long = estimateVo2FromHr(f, p, ACTIVITY.RUNNING, { sustainedEffortMinutes: 60 });
  assert.ok(long < fresh, 'drift correction did not apply');
  assert.ok(long > fresh * 0.85, 'drift correction is too aggressive');
});

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

test('calibration is inert until there is enough evidence', () => {
  const early = applyCalibration({ params: { rmrScale: 1.5 }, training_days: 3, confidence: 1, active: true });
  assert.equal(early.rmrScale, 1, 'a 3-day fit must not move anything');
  assert.equal(early.blend, 0);

  const mature = applyCalibration({ params: { rmrScale: 1.5 }, training_days: 45, confidence: 1, active: true });
  assert.ok(mature.rmrScale > 1 && mature.rmrScale < 1.09, `bounded and blended, got ${mature.rmrScale}`);
});

test('calibration parameters are clamped, so one wild reference day cannot swing the model', () => {
  const absurd = applyCalibration({ params: { hrEfficiency: 100 }, training_days: 90, confidence: 1, active: true });
  assert.ok(absurd.hrEfficiency <= 1.08, `unbounded calibration leaked through: ${absurd.hrEfficiency}`);
});

test('fitting reports insufficient evidence rather than emitting a bad parameter set', () => {
  const minutes = computeEnergy({ samples: samples({ minutes: 100, bpm: 70, mot: 0.05 }), profile: PROFILE, prefs: PREFS, userId: USER }).minutes;
  const fit = fitCalibration({ minutes, dayReferences: [{ day: minutes[0].day, total_kcal: 2200 }], userId: USER });
  assert.equal(fit.status, 'shadow');
  assert.deepEqual(fit.params, {});
  assert.equal(fit.calibration_confidence, 0);
  assert.match(fit.notes, /insufficient/);
});

test('a new calibration is always a new version in shadow status', () => {
  const minutes = computeEnergy({ samples: samples({ minutes: 100, bpm: 70, mot: 0.05 }), profile: PROFILE, prefs: PREFS, userId: USER }).minutes;
  const fit = fitCalibration({ minutes, dayReferences: [{ day: minutes[0].day, total_kcal: 2200 }], previousVersion: 7, userId: USER });
  assert.equal(fit.version, 8);
  assert.equal(fit.status, 'shadow');
});

// ---------------------------------------------------------------------------
// Baselines and live behaviour
// ---------------------------------------------------------------------------

test('the legacy fixed-MET baseline is preserved exactly, including its 70 kg assumption', () => {
  assert.equal(legacyFixedMet(60, 'Running'), Math.round(9.8 * 3.5 * 70 / 200 * 60));
  assert.equal(legacyFixedMet(60, 'other'), Math.round(5 * 3.5 * 70 / 200 * 60));
  assert.equal(legacyFixedMet(0, 'Running'), 0);
  assert.equal(legacyFixedMet(-5, 'Running'), 0);
});

test('Keytel is floored at resting instead of going negative at rest', () => {
  const p = phys();
  const atRest = baselineKeytel({ hr: 50 }, p);
  assert.ok(atRest.total_kcal >= p.restingKcalPerMin);
  assert.equal(atRest.active_kcal, 0);
  assert.equal(baselineKeytel({ hr: null }, p), null);
});

test('live burn rate is marked provisional and goes stale', () => {
  const now = T0 + 10 * 60000;
  const r = computeEnergy({ samples: samples({ minutes: 10, bpm: 150, mot: 0.8 }), profile: PROFILE, prefs: PREFS, userId: USER, now });
  assert.equal(r.live.state, 'provisional');
  assert.ok(r.live.kcal_per_min > 0);
  assert.equal(currentBurnRate(r.minutes, { now: now + 60 * 60000 }), null, 'an hour-old estimate must not be shown as live');
});

test('every row carries the versions needed to reproduce it', () => {
  const r = computeEnergy({ samples: samples({ minutes: 3, bpm: 80, mot: 0.1 }), profile: PROFILE, prefs: PREFS, userId: USER });
  for (const row of r.rows) {
    assert.equal(row.user_id, USER);
    assert.ok(row.algorithm_version && row.feature_version && row.model_version);
    assert.ok(!('debug' in row), 'debug payload must not be persisted');
    assert.ok(['measured', 'absent', 'carried'].includes(row.hr_source));
    assert.ok(Array.isArray(row.quality_flags));
  }
});

test('recomputation is deterministic: same input, byte-identical rows', () => {
  const input = { samples: samples({ minutes: 30, bpm: (s) => 70 + (s % 120), mot: (s) => (s % 200) / 400 }), profile: PROFILE, prefs: PREFS, userId: USER };
  assert.deepEqual(computeEnergy(input).rows, computeEnergy(input).rows);
});

test('the engine is a pure function of its arguments', () => {
  const p = phys();
  const input = samples({ minutes: 5, bpm: 100, mot: 0.2 });
  const frozen = JSON.stringify(input);
  computeEnergyMinutes({ samples: input, physiology: p, workouts: [], timeZone: 'UTC' });
  assert.equal(JSON.stringify(input), frozen, 'engine mutated its input');
});

test('aggregateWorkouts tolerates workout metadata it was not given', () => {
  const r = computeEnergy({
    samples: samples({ minutes: 10, bpm: 150, mot: 0.8 }),
    profile: PROFILE,
    prefs: PREFS,
    workouts: [{ id: 'w1', sport: 'Running', start: new Date(T0).toISOString(), end: new Date(T0 + 10 * 60000).toISOString() }],
    userId: USER,
  });
  const [w] = aggregateWorkouts(r.minutes, []);
  assert.equal(w.session_id, 'w1');
  assert.ok(w.start_time && w.end_time && w.duration_minutes > 0);
});
