import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectMeasurementWindows,
  classifyDutyCycle,
  summarizeSpo2Observations,
  physiologicalNightKey,
  inferSleepEpisodes,
  applyConnectionFirmware,
  annotateSpo2Identity,
  utcNightKey,
  independentSpo2DeviceCount,
} from '../../protocol/spo2.js';
import {
  whoopDeviceId,
  resolvePhysicalWhoopIdentity,
} from '../../storage/keys.js';

const T0 = 1_700_000_000;

function row({
  t = T0,
  raw = 95,
  state = 'candidate',
  sleep = 2,
  device = 'dev-a',
  user = null,
  firmware = '50.35.2.0',
  hash = null,
} = {}) {
  return annotateSpo2Identity({
    spo2_raw_byte: raw,
    spo2_candidate_pct: state === 'candidate' ? raw : null,
    spo2_state: state,
    sensor_timestamp: t,
    device_id: device,
    user_id: user,
    firmware,
    source_frame_hash: hash || `h${t}-${raw}-${state}`,
    sleep_state: sleep,
  });
}

function burst(start, n, extra = {}) {
  return Array.from({ length: n }, (_, i) => row({ t: start + i, ...extra }));
}

test('30-second nonzero bursts are one measurement window', () => {
  const rows = [
    ...burst(T0, 10, { state: 'sentinel', raw: 0x80 }),
    ...burst(T0 + 10, 10, { state: 'candidate', raw: 96 }),
    ...burst(T0 + 20, 10, { state: 'diagnostic', raw: 12 }),
  ];
  const windows = detectMeasurementWindows(rows);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].duration_s, 30);
  assert.equal(windows[0].candidate_count, 10);
  assert.equal(windows[0].sentinel_count, 10);
  assert.equal(windows[0].diagnostic_count, 10);
  assert.equal(windows[0].window_value, 96);
});

test('unequal sample counts per window do not bias the nightly mean', () => {
  const rows = [
    ...burst(T0, 2, { raw: 90 }),
    ...burst(T0 + 20, 20, { raw: 100 }),
  ];
  const summary = summarizeSpo2Observations(rows);
  assert.equal(summary.valid_windows, 2);
  assert.equal(summary.mean, 95);
  assert.equal(summary.candidate_mean, (90 * 2 + 100 * 20) / 22);
});

test('schedule phase is learned rather than hardcoded', () => {
  const period = 777;
  const a = [...burst(T0, 5), ...burst(T0 + period, 5), ...burst(T0 + 2 * period, 5)];
  const b = [...burst(T0 + 90, 5), ...burst(T0 + 90 + period, 5), ...burst(T0 + 90 + 2 * period, 5)];
  const dutyA = classifyDutyCycle(detectMeasurementWindows(a));
  const dutyB = classifyDutyCycle(detectMeasurementWindows(b));
  assert.equal(dutyA.classification, 'duty_cycled');
  assert.equal(dutyB.classification, 'duty_cycled');
  assert.equal(dutyA.median_period, period);
  assert.equal(dutyB.median_period, period);
  assert.notEqual(dutyA.phase, dutyB.phase);
  assert.notEqual(dutyA.median_period, 1200);
});

test('sparse off-phase captures are insufficient, not feature_absent', () => {
  const offPhase = burst(T0, 60, { state: 'unset', raw: 0 });
  const span = { captureStart: T0, captureEnd: T0 + 59, priorPeriod: 1200 };
  const duty = classifyDutyCycle(detectMeasurementWindows(offPhase), span);
  assert.equal(duty.classification, 'insufficient');
  const longUnset = burst(T0, 4 * 3600, { state: 'unset', raw: 0 });
  const absent = classifyDutyCycle(detectMeasurementWindows(longUnset), {
    priorPeriod: 1200,
    asleepUnix: longUnset.map((r) => r.sensor_timestamp),
  });
  assert.equal(absent.classification, 'feature_absent');
});

test('awake-only unset is insufficient even when a prior period is known', () => {
  const awakeDay = burst(T0, 4 * 3600, { state: 'unset', raw: 0, sleep: 0 });
  assert.equal(summarizeSpo2Observations(awakeDay, { priorPeriod: 1200 }).classification, 'insufficient');
});

test('sentinel and diagnostic stay stored but are excluded from window_value', () => {
  const rows = [
    row({ t: T0, state: 'sentinel', raw: 0x80 }),
    row({ t: T0 + 1, state: 'candidate', raw: 94 }),
    row({ t: T0 + 2, state: 'diagnostic', raw: 12 }),
    row({ t: T0 + 3, state: 'candidate', raw: 96 }),
  ];
  const [window] = detectMeasurementWindows(rows);
  assert.equal(window.sentinel_count, 1);
  assert.equal(window.diagnostic_count, 1);
  assert.equal(window.window_value, 95);
  assert.equal(summarizeSpo2Observations(rows).sentinel_count, 1);
});

test('a window split across archive chunks is reconstructed', () => {
  const chunkA = burst(T0, 15, { raw: 97 });
  const chunkB = burst(T0 + 15, 15, { raw: 97 });
  const windows = detectMeasurementWindows([...chunkA, ...chunkB]);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].duration_s, 30);
  assert.equal(windows[0].candidate_count, 30);
});

test('sleep crossing UTC midnight maps to one physiological day', () => {
  const rows = [];
  for (let t = T0; t <= T0 + 8 * 3600; t += 60) {
    rows.push(row({ t, sleep: 2, raw: 0, state: 'unset' }));
  }
  rows.push(row({ t: T0 + 1800, raw: 93 })); // 30 min after start
  rows.push(row({ t: T0 + 6 * 3600, raw: 97 }));
  const startIso = new Date(T0 * 1000).toISOString();
  assert.equal(utcNightKey(T0), startIso.slice(0, 10));
  const later = T0 + 6 * 3600;
  assert.notEqual(utcNightKey(T0), utcNightKey(later));
  const episodes = inferSleepEpisodes(rows);
  assert.equal(episodes.length, 1);
  const nights = new Set(rows.filter((r) => r.spo2_state === 'candidate').map((o) => physiologicalNightKey(o, {
    timeZone: 'UTC',
    episodes,
  })));
  assert.deepEqual([...nights], [utcNightKey(later)]);
});

test('sleep crossing local midnight maps to one FRWHOOP physiological day', () => {
  const start = Date.parse('2026-08-24T06:30:00.000Z') / 1000;
  const wake = Date.parse('2026-08-24T14:30:00.000Z') / 1000;
  const rows = [];
  for (let t = start; t <= wake; t += 60) {
    rows.push(row({ t, sleep: 2, raw: 0, state: 'unset' }));
  }
  rows.push(row({ t: start + 600, raw: 94 }));
  rows.push(row({ t: wake - 600, raw: 97 }));
  const episodes = inferSleepEpisodes(rows);
  const nights = new Set(rows.filter((r) => r.spo2_state === 'candidate').map((o) => physiologicalNightKey(o, {
    timeZone: 'America/Los_Angeles',
    episodes,
  })));
  assert.deepEqual([...nights], ['2026-08-24']);
});

test('firmware is recovered only from connection metadata', () => {
  const recovered = applyConnectionFirmware([row({ firmware: null, raw: 98 })], '50.35.2.0');
  assert.equal(recovered[0].firmware, '50.35.2.0');
  assert.equal(recovered[0].firmware_recovered, true);
  const kept = applyConnectionFirmware([row({ firmware: '1.0.0', raw: 98 })], '50.35.2.0');
  assert.equal(kept[0].firmware, '1.0.0');
});

test('duplicate historical seconds do not inflate observed asleep duration', () => {
  const uniq = burst(T0, 4 * 3600, { state: 'unset', raw: 0 });
  const dups = [...uniq, ...uniq, ...uniq];
  const a = classifyDutyCycle(detectMeasurementWindows(uniq), {
    priorPeriod: 1200,
    asleepUnix: uniq.map((r) => r.sensor_timestamp),
  });
  const b = classifyDutyCycle(detectMeasurementWindows(dups), {
    priorPeriod: 1200,
    asleepUnix: dups.map((r) => r.sensor_timestamp),
  });
  assert.equal(a.observed_distinct_asleep_seconds, 4 * 3600);
  assert.equal(a.observed_distinct_asleep_seconds, b.observed_distinct_asleep_seconds);
  assert.equal(a.classification, b.classification);
  assert.equal(a.classification, 'feature_absent');
});

test('gappy asleep stamps cannot use max-minus-min as coverage', () => {
  const gappy = [row({ t: T0, raw: 0, state: 'unset' }), row({ t: T0 + 4 * 3600, raw: 0, state: 'unset' })];
  const duty = classifyDutyCycle(detectMeasurementWindows(gappy), {
    priorPeriod: 1200,
    captureStart: T0,
    captureEnd: T0 + 4 * 3600,
    asleepUnix: gappy.map((r) => r.sensor_timestamp),
  });
  assert.equal(duty.observed_distinct_asleep_seconds, 2);
  assert.equal(duty.classification, 'insufficient');
});

test('learned period aliases remain on the duty-cycle object', () => {
  const rows = [...burst(T0, 5), ...burst(T0 + 600, 5), ...burst(T0 + 1200, 5)];
  const duty = classifyDutyCycle(detectMeasurementWindows(rows));
  assert.equal(duty.period_s, duty.median_period);
  assert.equal(duty.phase_s, duty.phase);
  assert.equal(duty.mode, duty.classification);
});

test('user UUID aliases do not prove one physical strap; spo2_pct stays null', () => {
  const local = '7f2c9a10-4b3e-4d8a-9c11-00000000f001';
  const jwt = '9f33375b-e029-480f-9ebb-a99e5ff22ac9';
  const a = whoopDeviceId(local, 'strap');
  const b = whoopDeviceId(jwt, 'strap');
  assert.equal(resolvePhysicalWhoopIdentity({
    userId: local, sourceDeviceId: a, externalId: 'strap',
  }).physical_identity_confidence, 'unknown');
  const summary = summarizeSpo2Observations([
    row({ device: a, user: local, raw: 95 }),
    row({ t: T0 + 1, device: b, user: jwt, raw: 95 }),
  ]);
  assert.equal(summary.physical_device_id, null);
  assert.equal(summary.physical_identity_confidence, 'unknown');
  assert.equal(summary.spo2_pct, null);
  assert.notEqual(summary.status, 'validated');
  assert.equal(independentSpo2DeviceCount([
    row({ device: a, user: local, raw: 95 }),
    row({ t: T0 + 1, device: b, user: jwt, raw: 95 }),
  ]), 0);
});
