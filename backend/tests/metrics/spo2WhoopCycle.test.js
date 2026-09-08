import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeSpo2Candidate,
  extrasFromSpo2Summary,
} from '../../metrics/spo2.js';
import {
  compareSpo2CandidateToWhoopCycles,
  observationInWhoopCycle,
  normalizeWhoopCycle,
  attachWhoopCycleValidation,
} from '../../metrics/spo2WhoopCycle.js';
import { physiologicalNightKey, inferSleepEpisodes, annotateSpo2Identity } from '../../protocol/spo2.js';
import { applyDailyMetricsPersist } from '../../metrics/canonicalRegistry.js';

const START = Date.parse('2026-08-24T06:30:00.000Z') / 1000;
const WAKE = Date.parse('2026-08-24T14:30:00.000Z') / 1000;
const CYCLE_START = '2026-08-23T16:00:00.000Z';
const CYCLE_END = '2026-08-24T16:00:00.000Z';
const SLEEP = [{ start: START, end: WAKE, wakeIso: new Date(WAKE * 1000).toISOString() }];

function sample(over = {}) {
  const sensor_ts = over.sensor_ts ?? START + 600;
  return {
    t: new Date(sensor_ts * 1000).toISOString(),
    sensor_ts,
    bpm: 58,
    spo2_raw_byte: 96,
    spo2_state: 'candidate',
    spo2_candidate_pct: 96,
    source_frame_hash: String(sensor_ts).padStart(64, '0'),
    layout: 'v18',
    decoder: 'frwhoop-spo2/1',
    firmware: '50.35.2.0',
    band_sleep_state: 2,
    user_id: '9f33375b-e029-480f-9ebb-a99e5ff22ac9',
    device_id: 'b4c6ae60-5afc-53d8-ac1c-f3a931dca7ba',
    ...over,
  };
}

function obsFromSample(s) {
  return annotateSpo2Identity({
    spo2_raw_byte: s.spo2_raw_byte,
    spo2_candidate_pct: s.spo2_candidate_pct,
    spo2_state: s.spo2_state,
    sensor_timestamp: s.sensor_ts,
    device_id: s.device_id,
    user_id: s.user_id,
    firmware: s.firmware,
    sleep_state: s.band_sleep_state,
    source_frame_hash: s.source_frame_hash,
  });
}

test('FRWHOOP product grouping remains wake-day based', () => {
  const samples = [
    sample({ sensor_ts: START + 600, spo2_raw_byte: 94 }),
    sample({ sensor_ts: WAKE - 600, spo2_raw_byte: 98, source_frame_hash: 'b'.repeat(64) }),
  ];
  const utcStartDay = new Date(START * 1000).toISOString().slice(0, 10);
  const utcWakeDay = new Date(WAKE * 1000).toISOString().slice(0, 10);
  assert.equal(utcStartDay, utcWakeDay);
  const summary = summarizeSpo2Candidate(samples, {
    day: '2026-08-24',
    timeZone: 'America/Los_Angeles',
    sleepSessions: SLEEP,
  });
  assert.equal(summary.candidate_count, 2);
  assert.equal(summary.spo2_pct, null);
  const extras = extrasFromSpo2Summary(summary, summary.series);
  assert.equal('whoop_cycle_id' in extras.spo2_candidate, false);
  assert.equal('whoop_cycle_start' in extras.spo2_candidate, false);
});

test('sleep crossing local midnight is one FRWHOOP physiological day', () => {
  const start = Date.parse('2026-08-24T06:30:00.000Z') / 1000;
  const wake = Date.parse('2026-08-24T14:30:00.000Z') / 1000;
  const observations = [];
  for (let t = start; t <= wake; t += 300) {
    observations.push(obsFromSample(sample({
      sensor_ts: t,
      spo2_raw_byte: t === start + 600 || t === wake - 600 ? 95 : 0,
      spo2_state: t === start + 600 || t === wake - 600 ? 'candidate' : 'unset',
      spo2_candidate_pct: t === start + 600 || t === wake - 600 ? 95 : null,
      band_sleep_state: 2,
      source_frame_hash: String(t).padStart(64, '0'),
    })));
  }
  const episodes = inferSleepEpisodes(observations);
  const nights = new Set(observations.filter((o) => o.spo2_state === 'candidate').map((o) => physiologicalNightKey(o, {
    timeZone: 'America/Los_Angeles',
    episodes,
  })));
  assert.deepEqual([...nights], ['2026-08-24']);
});

test('WHOOP validation grouping uses exact cycle_start / cycle_end', () => {
  const cycle = normalizeWhoopCycle({
    id: 'whoop-cycle-1',
    cycle_start: CYCLE_START,
    cycle_end: CYCLE_END,
    blood_oxygen_pct: 97,
  });
  const startUnix = Date.parse(CYCLE_START) / 1000;
  const endUnix = Date.parse(CYCLE_END) / 1000;
  assert.equal(observationInWhoopCycle({ sensor_timestamp: startUnix }, cycle), true);
  assert.equal(observationInWhoopCycle({ sensor_timestamp: endUnix - 1 }, cycle), true);
  assert.equal(observationInWhoopCycle({ sensor_timestamp: endUnix }, cycle), false);
  const inside = obsFromSample(sample({ sensor_ts: startUnix + 3600 }));
  const outside = obsFromSample(sample({ sensor_ts: endUnix }));
  const compared = compareSpo2CandidateToWhoopCycles({
    observations: [inside, outside],
    cycles: [cycle],
    timeZone: 'UTC',
  });
  assert.equal(compared.whoop_cycle_comparisons[0].candidate_count, 1);
  assert.equal(compared.whoop_cycle_comparisons[0].whoop_cycle_start, CYCLE_START);
  assert.equal(compared.whoop_cycle_comparisons[0].whoop_cycle_end, CYCLE_END);
});

test('one FRWHOOP night can link to a WHOOP cycle without changing product storage', () => {
  const samples = [
    sample({ sensor_ts: START + 600, spo2_raw_byte: 94 }),
    sample({ sensor_ts: WAKE - 600, spo2_raw_byte: 98, source_frame_hash: 'c'.repeat(64) }),
  ];
  const observations = samples.map(obsFromSample);
  const product = summarizeSpo2Candidate(samples, {
    day: '2026-08-24',
    timeZone: 'America/Los_Angeles',
    sleepSessions: SLEEP,
  });
  const extras = extrasFromSpo2Summary(product, product.series);
  const validation = compareSpo2CandidateToWhoopCycles({
    observations,
    cycles: [{
      cycle_id: 'whoop-cycle-1',
      cycle_start: CYCLE_START,
      cycle_end: CYCLE_END,
      blood_oxygen_pct: 96,
    }],
    timeZone: 'America/Los_Angeles',
    sleepSessions: SLEEP,
  });
  const night = validation.product_nights.find((n) => n.frwhoop_physiological_day === '2026-08-24');
  assert.ok(night);
  assert.equal(night.whoop_cycle_id, 'whoop-cycle-1');
  assert.equal(night.whoop_cycle_start, CYCLE_START);
  assert.equal(night.whoop_cycle_end, CYCLE_END);
  assert.equal(extras.spo2_candidate.spo2_pct, null);
  assert.equal(extras.spo2_candidate.whoop_cycle_id, undefined);
  assert.equal(product.mean, night.product.mean);
});

test('missing WHOOP cycle data leaves validation fields null', () => {
  const observations = [obsFromSample(sample())];
  const validation = compareSpo2CandidateToWhoopCycles({
    observations,
    cycles: [],
    timeZone: 'America/Los_Angeles',
    sleepSessions: SLEEP,
  });
  assert.equal(validation.whoop_cycle_comparisons.length, 0);
  assert.equal(validation.product_nights[0].whoop_cycle_id, null);
  assert.equal(validation.product_nights[0].whoop_cycle_start, null);
  assert.equal(validation.product_nights[0].whoop_cycle_end, null);
  const stamped = attachWhoopCycleValidation(observations, []);
  assert.equal(stamped[0].whoop_cycle_id, null);
  assert.equal(stamped[0].whoop_cycle_start, null);
  assert.equal(stamped[0].whoop_cycle_end, null);
});

test('candidate values still cannot populate spo2_pct', () => {
  const summary = summarizeSpo2Candidate([sample()]);
  assert.equal(summary.spo2_pct, null);
  const extras = extrasFromSpo2Summary(summary, summary.series);
  assert.equal(extras.spo2_candidate.spo2_pct, null);
  const persisted = applyDailyMetricsPersist({}, { spo2_candidate: extras.spo2_candidate });
  assert.equal(persisted.spo2_pct, undefined);
});
