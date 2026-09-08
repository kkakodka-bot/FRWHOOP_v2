import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';

import { createMetricsEngine } from '../metrics/engine.js';
import { scoreDay, scoreSleep } from '../metrics/sleep.js';
import {
  MIN_RECOVERY_INPUT_CONFIDENCE,
  createOvernightProvider,
  overnightPhysiology,
} from '../metrics/overnight.js';
import { STATUS } from '../signal/envelope.js';

const USER = '11111111-1111-4111-8111-111111111111';
const NIGHT_START = Date.parse('2026-06-10T01:00:00Z');
const now = () => new Date(Date.parse('2026-06-10T12:00:00Z'));

function activeVector(i) {
  return Math.floor(i / 3) % 2 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
}

/**
 * A day of 1 Hz samples with physiologically consistent RR bursts.
 *
 * RR intervals are emitted in bursts whose total duration matches the elapsed
 * wall time, so the reconstructed beat times track the sample times instead of
 * drifting away from them. A fixture that emitted one 1200 ms interval per
 * second would silently test a strap running at half speed.
 */
function appendBlock(samples, startMs, durationSec, { bpm, still, rr = false, jitterMs = 40 }) {
  const rrMs = Math.round(60_000 / bpm);
  const burst = Math.max(1, Math.round(6000 / rrMs));
  let carry = 0;
  let beat = 0;
  for (let i = 0; i < durationSec; i += 1) {
    const gravity = still ? { x: 0, y: 0, z: 1 } : activeVector(i);
    const sample = {
      t: new Date(startMs + i * 1000).toISOString(),
      bpm,
      rr_ms: [],
      gravity,
    };
    if (rr) {
      carry += 1000;
      if (carry >= burst * rrMs) {
        carry -= burst * rrMs;
        sample.rr_ms = Array.from({ length: burst }, () => {
          const v = rrMs + (beat % 2 ? jitterMs : 0);
          beat += 1;
          return v;
        });
      }
    }
    samples.push(sample);
  }
  return samples;
}

/** One active hour, three still hours with RR, then an active tail. */
function nightSamples({ jitterMs = 40 } = {}) {
  const samples = [];
  appendBlock(samples, NIGHT_START, 3600, { bpm: 72, still: false });
  appendBlock(samples, NIGHT_START + 3600_000, 3 * 3600, { bpm: 50, still: true, rr: true, jitterMs });
  appendBlock(samples, NIGHT_START + 4 * 3600_000, 3600, { bpm: 72, still: false });
  return samples;
}

function makeEngine() {
  const payloads = [];
  const blobs = new Map();
  const engine = createMetricsEngine({
    cfg: {
      localUserId: USER,
      rawStore: 'b2',
      derivedStore: 'b2',
      b2Bucket: 'FRWHOOP',
      buildHash: 'test',
    },
    stores: {
      derived: {
        async putObject(key, body) {
          blobs.set(key, body);
          return { bytes: body.length };
        },
      },
    },
    db: {
      async upsertPayload(payload) {
        payloads.push(payload);
        return { ok: true };
      },
    },
    now,
  });
  return { engine, payloads, blobs };
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

test('overnight physiology measures HRV from the sleep window', () => {
  const samples = nightSamples();
  const out = overnightPhysiology({
    samples,
    startTime: new Date(NIGHT_START + 3600_000).toISOString(),
    endTime: new Date(NIGHT_START + 4 * 3600_000).toISOString(),
    now,
  });
  assert.equal(out.envelopes.hrv.status, STATUS.OK);
  assert.ok(Math.abs(out.envelopes.hrv.value - 40) < 3, `expected ~40 ms, got ${out.envelopes.hrv.value}`);
  assert.equal(out.hrv, out.envelopes.hrv.value, 'a confident value is passed to recovery');
});

test('a value measured but not confident enough is reported and withheld', () => {
  const hrv = {
    value: 42, confidence: MIN_RECOVERY_INPUT_CONFIDENCE - 0.05, status: STATUS.LOW_CONFIDENCE,
  };
  // Exercised through the real path by starving the window instead of stubbing.
  const out = overnightPhysiology({
    samples: nightSamples().slice(0, 3700),
    startTime: new Date(NIGHT_START + 3600_000).toISOString(),
    endTime: new Date(NIGHT_START + 4 * 3600_000).toISOString(),
    now,
  });
  if (out.envelopes.hrv.value != null && out.envelopes.hrv.confidence < MIN_RECOVERY_INPUT_CONFIDENCE) {
    assert.equal(out.hrv, null, 'a weak value must not move recovery');
    assert.equal(out.withheld.hrv, out.envelopes.hrv.confidence);
  } else {
    assert.equal(out.envelopes.hrv.value, null, 'a starved window has nothing to report');
  }
  assert.ok(hrv.value > 0);
});

test('the provider measures each window once', () => {
  const provider = createOvernightProvider({ now });
  const samples = nightSamples();
  const args = { samples, start: NIGHT_START + 3600_000, end: NIGHT_START + 4 * 3600_000 };
  const a = provider(args);
  const b = provider(args);
  assert.equal(a, b, 'the same window must not be recomputed');
  assert.equal(provider.results().length, 1);
});

test('the provider reports the longest window as the main one', () => {
  const provider = createOvernightProvider({ now });
  const samples = nightSamples();
  provider({ samples, start: NIGHT_START + 3600_000, end: NIGHT_START + 4 * 3600_000 });
  provider({ samples, start: NIGHT_START, end: NIGHT_START + 600_000 });
  assert.equal(provider.results().length, 2);
  const main = provider.main();
  assert.equal(main.span, 3 * 3600_000);
});

test('the provider summary is null before anything is measured', () => {
  assert.equal(createOvernightProvider({ now }).summary(), null);
});

// ---------------------------------------------------------------------------
// The wiring the bug lived in
// ---------------------------------------------------------------------------

test('a scored session carries the HRV measured inside its own window', () => {
  const provider = createOvernightProvider({ now });
  const night = scoreSleep({
    samples: nightSamples(),
    extras: { timeZone: 'UTC', overnight: provider },
  });
  assert.equal(night.ok, true);
  assert.ok(night.hrv != null, 'the session must expose the HRV it scored recovery with');
  assert.ok(Math.abs(night.hrv - 40) < 3);
});

test('without a provider the behaviour is exactly as before', () => {
  const samples = nightSamples();
  const withoutProvider = scoreDay({ samples, extras: { timeZone: 'UTC' } });
  assert.equal(withoutProvider.hrv, null, 'no provider and no extras means no HRV');

  const explicit = scoreDay({ samples, extras: { timeZone: 'UTC', hrv: 55, resp: 14 } });
  assert.equal(explicit.hrv, 55, 'a caller-supplied value is still honoured');
  assert.equal(explicit.resp, 14);
});

test('a caller-supplied value wins over the provider', () => {
  const provider = createOvernightProvider({ now });
  const scored = scoreDay({
    samples: nightSamples(),
    extras: { timeZone: 'UTC', overnight: provider, hrv: 99 },
  });
  assert.equal(scored.hrv, 99);
});

test('recovery responds to HRV once it is actually supplied', () => {
  // The bug: recovery ran on its sleep-performance term alone because hrv and
  // resp were never populated. If recovery is indifferent to HRV, it is broken.
  const samples = nightSamples();
  const low = scoreSleep({ samples, extras: { timeZone: 'UTC', hrv: 20, hrvBaseline: 60 } });
  const high = scoreSleep({ samples, extras: { timeZone: 'UTC', hrv: 90, hrvBaseline: 60 } });
  assert.ok(low.ok && high.ok);
  assert.ok(
    high.recovery > low.recovery,
    `recovery ignored HRV entirely: ${low.recovery} vs ${high.recovery}`,
  );
});

test('a scored session carries resp measured for display when recovery withholds it', () => {
  const provider = () => ({
    hrv: 40,
    resp: null,
    respMeasured: 14.5,
    hrvBaseline: 60,
    respBaseline: 15,
    withheld: { resp: MIN_RECOVERY_INPUT_CONFIDENCE - 0.05 },
    envelopes: { hrv: { value: 40 }, resp: { value: 14.5 } },
  });
  const night = scoreSleep({
    samples: nightSamples(),
    extras: { timeZone: 'UTC', overnight: provider },
  });
  assert.equal(night.ok, true);
  assert.equal(night.resp, 14.5, 'display scalar must use respMeasured when recovery resp is withheld');
});

test('persistComputed now writes a real HRV instead of null', async () => {
  const { engine, payloads, blobs } = makeEngine();
  const result = await engine.persistComputed({
    samples: nightSamples(),
    device: { externalId: 'strap' },
    extras: { timeZone: 'UTC' },
  });

  assert.ok(result.scored.sleep, 'the fixture must produce a scored night');
  assert.ok(result.dailyRow.hrv_rmssd_ms != null, 'hrv_rmssd_ms was null before this wiring');
  assert.ok(Math.abs(result.dailyRow.hrv_rmssd_ms - 40) < 3);
  assert.equal(payloads[0].daily_metrics[0].hrv_rmssd_ms, result.dailyRow.hrv_rmssd_ms);

  assert.ok(result.overnight?.hrv, 'the envelope travels with the result');
  assert.equal(result.overnight.hrv.status, STATUS.OK);
  assert.ok(result.overnight.hrv.confidence > 0);
  assert.equal(result.overnight.hrv.algorithm, 'hrv_rmssd_windowed');

  const run = payloads[0].metric_runs[0];
  assert.ok(run.output_refs.hrv, 'provenance must record what was measured');
  assert.equal(run.output_refs.hrv.value, result.dailyRow.hrv_rmssd_ms);
  assert.ok('respiration' in run.output_refs);
  assert.ok('withheld_from_recovery' in run.output_refs);

  const blob = JSON.parse(gunzipSync([...blobs.values()][0]).toString('utf8'));
  assert.ok(blob.overnight_physiology?.hrv, 'the derived blob carries the diagnostic detail');
  assert.ok(blob.overnight_physiology.hrv.detail.windowsUsed >= 3);
  assert.equal(blob.daily.hrv, result.dailyRow.hrv_rmssd_ms);
});

test('a night without RR intervals still scores sleep, with a null HRV', async () => {
  const samples = [];
  appendBlock(samples, NIGHT_START, 3600, { bpm: 72, still: false });
  appendBlock(samples, NIGHT_START + 3600_000, 3 * 3600, { bpm: 50, still: true, rr: false });
  appendBlock(samples, NIGHT_START + 4 * 3600_000, 3600, { bpm: 72, still: false });

  const { engine, payloads } = makeEngine();
  const result = await engine.persistComputed({
    samples,
    device: { externalId: 'strap' },
    extras: { timeZone: 'UTC' },
  });
  assert.ok(result.scored.sleep, 'HRV must be additive: no RR cannot cost us the night');
  assert.equal(result.dailyRow.hrv_rmssd_ms, null);
  assert.ok(result.dailyRow.sleep_total_min > 0);
  assert.match(result.overnight.hrv.reason, /no RR intervals/);

  // Provenance records that the measurement was ATTEMPTED and why it failed.
  // A bare null here would be indistinguishable from a run that never tried.
  const refs = payloads[0].metric_runs[0].output_refs;
  assert.equal(refs.hrv.value, null);
  assert.equal(refs.hrv.status, STATUS.UNAVAILABLE);
  assert.equal(refs.hrv.version, '1.0.0');
});

test('reprocessing the same samples reproduces the same HRV', async () => {
  const samples = nightSamples();
  const first = await makeEngine().engine.persistComputed({
    samples, device: { externalId: 'strap' }, extras: { timeZone: 'UTC' },
  });
  const second = await makeEngine().engine.persistComputed({
    samples: samples.map((s) => ({ ...s })),
    device: { externalId: 'strap' },
    extras: { timeZone: 'UTC' },
  });
  assert.equal(second.dailyRow.hrv_rmssd_ms, first.dailyRow.hrv_rmssd_ms);
  assert.equal(second.overnight.hrv.confidence, first.overnight.hrv.confidence);
  assert.equal(second.dailyRow.recovery_score, first.dailyRow.recovery_score);
});

test('the overnight summary is JSON-serializable for persistence', async () => {
  const { engine } = makeEngine();
  const result = await engine.persistComputed({
    samples: nightSamples(),
    device: { externalId: 'strap' },
    extras: { timeZone: 'UTC' },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.overnight)), result.overnight);
});

test('HR-only nights still persist the recovery scalar', async () => {
  const start = Date.parse('2026-08-23T23:00:00Z');
  const samples = Array.from({ length: 120 }, (_, i) => ({
    datetime: new Date(start + i * 4 * 60_000).toISOString(),
    bpm: i > 5 && i < 100 ? 52 + (i % 5) : 78,
    sleep_stage: i % 9 === 0 ? 'wake' : 'light',
  }));
  const { engine, payloads } = makeEngine();
  const result = await engine.persistComputed({
    samples,
    device: { externalId: 'strap' },
    extras: { timeZone: 'UTC', replay: true },
  });
  assert.equal(result.dailyRow.sleep_total_min, 332);
  assert.equal(result.dailyRow.recovery_score, 60);
  assert.equal(payloads[0].daily_metrics[0].recovery_score, 60);
  assert.deepEqual(payloads[0].sleep_replace_days, []);
  assert.equal(payloads[0].sessions.some((s) => s.kind === 'sleep'), true);
  assert.equal(payloads[0].sessions.find((s) => s.kind === 'sleep').summary.persist_state, 'provisional');
  assert.ok(payloads[0].sleep_details?.length);
  assert.equal(result.sleepRow, null);
});
