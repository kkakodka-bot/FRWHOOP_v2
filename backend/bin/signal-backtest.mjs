#!/usr/bin/env node
/**
 * Derive + readability backtest over golden fixtures and real Level-A captures.
 * Confirms PPG/IMU/optical streams decode, archive round-trip, and carry signal.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveRecords } from '../redecode/derive.js';
import { decodeWhoop5ImuV21, decodeWhoop5PpgV26, decodeWhoop5OpticalV20, gravityShellStats, v26HrLock } from '../protocol/deepSensor.js';
import { ppgRecordFromFrame } from '../protocol/ppgArchive.js';
import { encodePpgArchive, decodePpgArchive } from '../protocol/ppgArchive.js';
import { encodeImuV21Archive, decodeImuV21Archive } from '../protocol/deepSensorArchive.js';
import { encodePpgV26Archive, decodePpgV26Archive } from '../protocol/deepSensorArchive.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const parity = JSON.parse(readFileSync(path.join(here, '../tests/fixtures/noop-whoop5-parity.json'), 'utf8'));
const sept1 = JSON.parse(readFileSync(path.join(here, '../../docs/research/fixtures/deep_records_2026-09-01.json'), 'utf8'));

function stats(nums) {
  if (!nums?.length) return null;
  let min = Infinity; let max = -Infinity; let sum = 0; let sumSq = 0;
  for (const v of nums) {
    min = Math.min(min, v); max = Math.max(max, v); sum += v; sumSq += v * v;
  }
  const mean = sum / nums.length;
  const rms = Math.sqrt(sumSq / nums.length);
  const variance = nums.reduce((a, v) => a + (v - mean) ** 2, 0) / nums.length;
  return { n: nums.length, min, max, mean, rms, variance, dynamic_range: max - min };
}

function row(hex, t, seq) {
  return { hex, family: 'puffin', char: 'FD4B0003', t, seq, fw: '50.35.5' };
}

function readablePpg(rec, label) {
  const s = stats(rec.samples);
  const rt = decodePpgArchive(encodePpgArchive([rec]).body);
  return {
    label,
    kind: rec.kind,
    samples: s,
    sample_rate_hz: rec.sample_rate_hz,
    canonical_stage_input: rec.canonical_stage_input,
    reconstruction_ambiguous: rec.reconstruction_ambiguous,
    round_trip_ok: rt.length === 1 && rt[0].samples?.length === rec.samples?.length,
    first3: rec.samples?.slice(0, 3),
    last3: rec.samples?.slice(-3),
  };
}

function readableV26(buf, label) {
  const d = decodeWhoop5PpgV26(buf);
  if (!d.ok) return { label, ok: false, reason: d.reason };
  const pip = ppgRecordFromFrame(buf, 'puffin', { receivedAt: '2026-08-30T10:00:00Z' });
  const rt = decodePpgV26Archive(encodePpgV26Archive([{
    ...d.frame,
    schema: 'frwhoop_whoop5_ppg_v26',
    kind: 'whoop5_ppg_v26',
    identity: { derived_id: 'test' },
  }]).body);
  return {
    label,
    ok: true,
    deep_samples: stats(d.frame.samples),
    pip: pip ? readablePpg(pip, `${label}/pip`) : null,
    features: d.frame.features || null,
    round_trip_deep_count: rt.length,
  };
}

function readableImu(buf, label) {
  const d = decodeWhoop5ImuV21(buf);
  if (!d.ok) return { label, ok: false, reason: d.reason };
  const g = gravityShellStats([d.frame]);
  const ax = stats(d.frame.accel_x_g);
  const rt = decodeImuV21Archive(encodeImuV21Archive([{
    schema: 'frwhoop_whoop5_imu_v21',
    kind: 'whoop5_imu_v21',
    accel_x_g: d.frame.accel_x_g,
    identity: { derived_id: 'test' },
  }]).body);
  return {
    label,
    ok: true,
    sample_count: d.frame.sample_count,
    gravity_shell: g,
    accel_g: ax,
    features: d.frame.features || null,
    round_trip_ok: rt.length === 1 && rt[0].accel_x_g?.length === 100,
  };
}

function readableV20(buf, label) {
  const d = decodeWhoop5OpticalV20(buf);
  if (!d.ok) return { label, ok: false, reason: d.reason };
  const active = [0, 1, 2, 3, 4].map((i) => d.frame[`block_${i}`]?.sample_count || 0);
  return {
    label,
    ok: true,
    block_sample_counts: active,
    pattern: d.frame.sample_count_pattern,
    block0_ch_a: stats(d.frame.block_0?.channel_a || []),
  };
}

function passFail(report) {
  const failures = [];
  if (!report.derive.ppg_records) failures.push('derive: no ppg_raw');
  if (!report.derive.whoop5_ppg_v26) failures.push('derive: no whoop5_ppg_v26');
  if (!report.derive.whoop5_imu_v21) failures.push('derive: no whoop5_imu_v21');
  if (report.parity.pip?.canonical_stage_input !== true) failures.push('parity: pip not canonical');
  if (report.parity.pip?.round_trip_ok !== true) failures.push('parity: ppg round-trip failed');
  if (report.parity.v26?.ok !== true) failures.push('parity: v26 decode failed');
  if ((report.parity.v26?.deep_samples?.variance || 0) <= 0) failures.push('parity: v26 flat waveform');
  if (report.sept1.imu?.gravity_shell?.median < 0.85 || report.sept1.imu?.gravity_shell?.median > 1.15) {
    failures.push(`sept1: IMU gravity shell median=${report.sept1.imu?.gravity_shell?.median}`);
  }
  report.pass = failures.length === 0;
  report.failures = failures;
  return report;
}

const notifyRows = [
  row(parity.v18[0].hex, '2026-08-30T10:00:00Z', 1),
  row(parity.v21_real.hex, '2026-08-30T10:00:01Z', 2),
  row(parity.v26_real.hex, '2026-08-30T10:00:02Z', 3),
  row(parity.v20_real.hex, '2026-08-30T10:00:03Z', 4),
  row(sept1.v21_type47_1236.hex, sept1.v21_type47_1236.t, 5),
  row(sept1.v20_type47_2132.hex, sept1.v20_type47_2132.t, 6),
];

const derived = deriveRecords(notifyRows, { family: 'puffin' });

const v26Buf = Buffer.from(parity.v26_real.hex, 'hex');
const pipRec = ppgRecordFromFrame(v26Buf, 'puffin', { receivedAt: '2026-08-30T10:00:00Z' });

// Synthetic HR lock: v26 waveform at 24Hz with ~100bpm-ish periodicity isn't in single frame;
// run HR lock on repeated v26 frames with matching HR map for sanity.
const v26Frames = Array.from({ length: 60 }, (_, i) => ({
  base_ts: 1780917232 + i,
  samples: parity.v26_real.expect.waveform,
}));
const hrByUnix = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [1780917232 + i, 102]));
const hrLock = v26HrLock(v26Frames, hrByUnix, { windowSec: 20 });

const report = passFail({
  derive: {
    session: derived.session,
    ppg_records: derived.ppg.length,
    whoop5_ppg_v26: derived.whoop5Ppg.length,
    whoop5_imu_v21: derived.whoop5Imu.length,
    whoop5_optical_v20: derived.whoop5Optical.length,
    imu_records: derived.imu.length,
  },
  parity: {
    pip: pipRec ? readablePpg(pipRec, 'noop-v26-pip') : null,
    v26: readableV26(v26Buf, 'noop-v26'),
    v21: readableImu(Buffer.from(parity.v21_real.hex, 'hex'), 'noop-v21'),
    v20: readableV20(Buffer.from(parity.v20_real.hex, 'hex'), 'noop-v20'),
    hr_lock_synthetic: hrLock,
  },
  sept1: {
    imu: readableImu(Buffer.from(sept1.v21_type47_1236.hex, 'hex'), 'levelA-v21'),
    v20: readableV20(Buffer.from(sept1.v20_type47_2132.hex, 'hex'), 'levelA-v20'),
    source: sept1.v21_type47_1236.source,
  },
});

console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
