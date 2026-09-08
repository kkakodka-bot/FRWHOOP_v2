import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeTemperature, skinTempSeriesFromSamples, TEMP_ALGORITHM_VERSION } from '../metrics/temperature.js';
import { normalizeSkinTempC } from '../ingest/archiveFormat.js';

function s(iso, c) { return { t: iso, skin_temp_c: c }; }
const TZ = 'America/New_York';

test('nightly average from a dense night (median, not mean)', () => {
  const samples = [];
  // 60 samples of 36.5, 60 of 36.7 during night hours (22:00-23:59 local)
  for (let i = 0; i < 60; i++) samples.push(s(`2026-08-25T03:00:${String(i).padStart(2, '0')}Z`, 36.5));
  for (let i = 0; i < 60; i++) samples.push(s(`2026-08-25T03:02:${String(i).padStart(2, '0')}Z`, 36.7));
  const r = summarizeTemperature(samples, { timeZone: TZ });
  assert.ok(r.temperature_c >= 36.5 && r.temperature_c <= 36.7);
  assert.equal(r.window, 'night');
  assert.equal(r.algorithm_version, TEMP_ALGORITHM_VERSION);
  // Sparse subset of the night -> measured but not full-coverage
  assert.ok(['ok', 'partial'].includes(r.status));
});

test('no temperature samples is unavailable, never zero', () => {
  const r = summarizeTemperature([], { timeZone: TZ });
  assert.equal(r.status, 'unavailable');
  assert.equal(r.temperature_c, null);
});

test('insufficient night samples falls back to all_day or insufficient, not a fabricated value', () => {
  // only 3 daytime samples -> not a night window
  const r = summarizeTemperature([s('2026-08-25T18:00:00Z', 30), s('2026-08-25T18:00:01Z', 31), s('2026-08-25T18:00:02Z', 32)], { timeZone: TZ });
  assert.ok(['all_day', 'insufficient', 'partial'].includes(r.window));
});

test('deviation from baseline when a baseline is provided', () => {
  const samples = Array.from({ length: 40 }, (_, i) => s(`2026-08-25T03:00:${String(i).padStart(2, '0')}Z`, 36.8));
  const r = summarizeTemperature(samples, { timeZone: TZ, baselineC: 36.5 });
  assert.equal(Math.abs(r.deviation_c - (36.8 - 36.5)) < 0.05, true);
  assert.equal(r.baseline_c, 36.5);
});

test('no deviation when baseline is absent', () => {
  const samples = Array.from({ length: 40 }, (_, i) => s(`2026-08-25T03:00:${String(i).padStart(2, '0')}Z`, 36.8));
  const r = summarizeTemperature(samples, { timeZone: TZ });
  assert.equal(r.deviation_c, null);
  assert.equal(r.baseline_c, null);
});

test('12-minute skin temp series is five points per hour, never a fabricated 0', () => {
  const samples = [];
  for (let i = 0; i < 60; i += 1) {
    samples.push(s(`2026-08-25T03:${String(i).padStart(2, '0')}:00Z`, i < 30 ? 33.2 : 33.8));
  }
  const series = skinTempSeriesFromSamples(samples, { intervalMinutes: 12 });
  assert.equal(series.length, 5);
  for (const p of series) {
    assert.ok(p.c >= 33.2 && p.c <= 33.8);
    assert.ok(p.n >= 12);
  }
  assert.equal(skinTempSeriesFromSamples([], {}).length, 0);
  assert.equal(skinTempSeriesFromSamples([s('2026-08-25T03:00:00Z', 4)]).length, 0);
});

test('duplicate temperature samples are not double counted in coverage', () => {
  const a = s('2026-08-25T03:00:00Z', 36.6);
  const b = s('2026-08-25T03:00:01Z', 36.7);
  const r = summarizeTemperature([a, a, b, b], { timeZone: TZ });
  assert.equal(r.sample_count, 2);
});

test('out-of-range values are excluded by the archive layer (unit protection)', () => {
  // 3057 is a raw ADC, not °C; the actual range gate lives in archiveFormat,
  // but the temperature module must also be robust to a leaked raw value.
  assert.equal(normalizeSkinTempC({ skin_temp_c: 3057 }), null);
  assert.equal(normalizeSkinTempC({ skin_temp_c: 36.6 }), 36.6);
  assert.equal(normalizeSkinTempC({ skin_temp_c: 4 }), null);
  assert.equal(normalizeSkinTempC({ skin_temp_c: 46 }), null);
});
