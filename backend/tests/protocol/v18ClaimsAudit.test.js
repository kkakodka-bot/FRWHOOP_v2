import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { crc16Modbus, crc32 } from '../../protocol/crc.js';
import { puffinRT, notifyOf } from '../fixtures/whoopFrames.mjs';
import {
  ticksToMs, parseGattRr, zipFromEnd, scorePair, ingestNotifyRow,
  auditV18Claims, rrUnitVerdict, byte43Stats,
  rmssd, RR_UNIT_MIN_PAIRS, H0_RATIO,
} from '../../protocol/v18ClaimsAudit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/noop-whoop5-parity.json'), 'utf8'));

function puffinV18({ unix = 1_782_000_000, hr = 60, rr = [1000], dyn = 0.01, gx = 0, gy = 0, gz = 1, sleep = 0, opticalA = 40, opticalB = 40 } = {}) {
  const inner = new Uint8Array(112);
  inner[0] = 0x2f;
  inner[1] = 18;
  inner[2] = 0x80;
  inner[7] = unix & 0xFF; inner[8] = (unix >> 8) & 0xFF;
  inner[9] = (unix >> 16) & 0xFF; inner[10] = (unix >>> 24) & 0xFF;
  inner[14] = hr;
  inner[15] = rr.length;
  for (let i = 0; i < rr.length; i += 1) {
    inner[16 + i * 2] = rr[i] & 0xFF;
    inner[17 + i * 2] = (rr[i] >> 8) & 0xFF;
  }
  new DataView(inner.buffer).setFloat32(33, dyn, true);
  new DataView(inner.buffer).setFloat32(37, gx, true);
  new DataView(inner.buffer).setFloat32(41, gy, true);
  new DataView(inner.buffer).setFloat32(45, gz, true);
  inner[73] = (sleep & 0x03) << 4;
  inner[98] = opticalA;
  inner[99] = opticalB;
  const declared = inner.length + 4;
  const frame = [0xAA, 0x01, declared & 0xFF, (declared >> 8) & 0xFF, 0x00, 0x01];
  const c16 = crc16Modbus(frame, 0, 6);
  frame.push(c16 & 0xFF, (c16 >> 8) & 0xFF, ...inner);
  const c = crc32(inner);
  frame.push(c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF, (c >>> 24) & 0xFF);
  return Uint8Array.from(frame);
}

test('2A37 ticks convert with the SIG 1/1024 formula', () => {
  assert.equal(ticksToMs(1024), 1000);
  assert.equal(ticksToMs(512), 500);
  const p = parseGattRr([0x10, 80, 0x00, 0x04]);
  assert.equal(p.bpm, 80);
  assert.deepEqual(p.ticks, [1024]);
  assert.deepEqual(p.ms, [1000]);
});

test('beats pair from the end of each slot list', () => {
  assert.deepEqual(zipFromEnd([1, 2, 3], [20, 30]), [[2, 20], [3, 30]]);
});

test('H0 vs H1 errors split a millisecond live beat from a tick-valued hist slot', () => {
  const ms = scorePair(1000, 1000);
  const ticks = scorePair(1024, 1000);
  assert.equal(ms.favor, 'H0');
  assert.equal(ms.h0_err, 0);
  assert.equal(ticks.favor, 'H1');
  assert.equal(ticks.h1_err, 0);
  assert.ok(Math.abs(ticks.ratio - 1.024) < 0.001);
});

test('matched 2A37 and v18 pairs prefer H0 when hist raw equals live ms', () => {
  const unix = 1_782_000_000;
  const v18 = [];
  const gatt = [];
  for (let i = 0; i < RR_UNIT_MIN_PAIRS; i += 1) {
    const t = unix + i;
    const raw = 800 + (i % 50);
    v18.push(ingestNotifyRow(notifyOf(puffinV18({ unix: t, hr: 72, rr: [raw] }), {
      family: 'puffin', t: new Date(t * 1000).toISOString(),
    }), { device: 'd1', fw: '50.35.2.0' }));
    gatt.push({
      kind: 'gatt', bpm: 72, ticks: [Math.round(raw * 1024 / 1000)], rr_ms: [raw],
      recv_ms: t * 1000, unix: t, device: 'd1', firmware: '50.35.2.0',
    });
  }
  v18.push(ingestNotifyRow(notifyOf(puffinV18({ unix: unix + 4000, hr: 72, rr: [810] }), {
    family: 'puffin', t: new Date((unix + 4000) * 1000).toISOString(),
  }), { device: 'd1', fw: '50.35.0' }));
  gatt.push({
    kind: 'gatt', bpm: 72, ticks: [830], rr_ms: [ticksToMs(830)],
    recv_ms: (unix + 4000) * 1000, unix: unix + 4000, device: 'd1', firmware: '50.35.0',
  });
  const report = auditV18Claims({ v18: v18.filter(Boolean), gatt, type40: [] });
  assert.ok(report.rr.gatt_vs_v18.n >= RR_UNIT_MIN_PAIRS);
  assert.equal(report.rr.gatt_vs_v18.mae_h0, 0);
  assert.ok(report.rr.gatt_vs_v18.mae_h1 > 0);
  assert.ok(report.rr.gatt_vs_v18.median_hist_live_ratio >= H0_RATIO[0]);
  assert.ok(report.rr.gatt_vs_v18.median_hist_live_ratio <= H0_RATIO[1]);
  assert.equal(report.rr.verdict, 'CONFIRMED');
});

test('matched pairs prefer H1 when hist raw is 1024-tick and live is converted ms', () => {
  const unix = 1_782_100_000;
  const v18 = [];
  const gatt = [];
  for (let i = 0; i < RR_UNIT_MIN_PAIRS; i += 1) {
    const t = unix + i;
    const ticks = 900 + (i % 40);
    v18.push(ingestNotifyRow(notifyOf(puffinV18({ unix: t, hr: 64, rr: [ticks] }), {
      family: 'puffin', t: new Date(t * 1000).toISOString(),
    }), { device: 'd2', fw: '50.35.2.0' }));
    gatt.push({
      kind: 'gatt', bpm: 64, ticks: [ticks], rr_ms: [ticksToMs(ticks)],
      recv_ms: t * 1000, unix: t, device: 'd2', firmware: '50.35.2.0',
    });
  }
  v18.push(ingestNotifyRow(notifyOf(puffinV18({ unix: unix + 5000, hr: 64, rr: [1024] }), {
    family: 'puffin', t: new Date((unix + 5000) * 1000).toISOString(),
  }), { device: 'd2', fw: '50.35.0' }));
  gatt.push({
    kind: 'gatt', bpm: 64, ticks: [1024], rr_ms: [1000],
    recv_ms: (unix + 5000) * 1000, unix: unix + 5000, device: 'd2', firmware: '50.35.0',
  });
  const report = auditV18Claims({ v18: v18.filter(Boolean), gatt, type40: [] });
  assert.equal(report.rr.gatt_vs_v18.mae_h1, 0);
  assert.ok(report.rr.gatt_vs_v18.mae_h0 > 0);
  assert.equal(report.rr.verdict, 'REFUTED');
});

test('zero 2A37 overlap stays OPEN even when 60000/mean(RR) prefers H0', () => {
  const v18 = [];
  for (let i = 0; i < 30; i += 1) {
    v18.push(ingestNotifyRow(notifyOf(puffinV18({
      unix: 1_782_200_000 + i, hr: 60, rr: [1000, 1000],
    }), { family: 'puffin', t: '2026-08-26T05:00:00.000Z' }), { device: 'd3', fw: '50.35.2.0' }));
  }
  const report = auditV18Claims({ v18: v18.filter(Boolean), gatt: [], type40: [] });
  assert.equal(report.rr.gatt_vs_v18.n, 0);
  assert.equal(report.rr.verdict, 'OPEN');
  assert.equal(rrUnitVerdict(report.rr.gatt_vs_v18), 'OPEN');
  assert.equal(report.rr.hr_from_rr.n_multi_rr, 30);
  assert.ok(report.rr.hr_from_rr.mae_h0 < report.rr.hr_from_rr.mae_h1);
});

test('HRV scale under H1 is the 1000/1024 factor', () => {
  const raw = [800, 820, 790, 810, 805];
  const conv = raw.map((v) => v * 1000 / 1024);
  const a = rmssd(raw), b = rmssd(conv);
  assert.ok(Math.abs(b / a - 1000 / 1024) < 1e-9);
});

test('real v18 fixtures: byte 43 is not a respiratory rate; f32@41 is a small g value', () => {
  const rows = [];
  for (const fr of fixture.v18) {
    const rec = ingestNotifyRow({ hex: fr.hex, family: 'puffin', t: '2026-08-01T00:00:00.000Z' }, { device: 'fx', fw: 'oracle' });
    assert.equal(rec.kind, 'v18', fr.name);
    rows.push(rec);
    if (fr.name === 'whoop5_v18_real_offwrist') {
      assert.equal(rec.b43, 195);
      assert.equal(rec.hr, null);
      assert.equal(rec.worn, false);
    }
    if (fr.expect.dynamic_acceleration != null) {
      assert.ok(Math.abs(rec.dyn - fr.expect.dynamic_acceleration) < 1e-4, fr.name);
    }
  }
  const stats = byte43Stats(rows);
  assert.equal(stats.off_wrist.n, 1);
  assert.equal(stats.off_wrist.median, 195);
  assert.ok(stats.frac_physio_8_30 < 0.7);
  assert.equal(stats.dynamic_acceleration.frac_0_8g, 1);
});

test('respiration-byte claim is REFUTED when byte 43 tracks an f32 mantissa', () => {
  const rows = [];
  for (let i = 0; i < 80; i += 1) {
    const dyn = 0.004 + ((i * 37) % 250) / 20000;
    const off = i < 8;
    rows.push(ingestNotifyRow(notifyOf(puffinV18({
      unix: 1_782_400_000 + i,
      hr: off ? 0 : 58,
      rr: [1000],
      dyn,
      opticalA: off ? 0 : 50,
      opticalB: off ? 0 : 51,
    }), { family: 'puffin', t: '2026-08-26T05:00:00.000Z' }), { device: 'd5', fw: '50.35.2.0' }));
  }
  const report = auditV18Claims({ v18: rows.filter(Boolean), gatt: [], type40: [] });
  assert.equal(report.respiration_verdict, 'REFUTED');
  assert.equal(report.dynamic_acceleration_verdict, 'CONFIRMED');
  assert.ok(report.byte43.entropy_bits >= 6);
  assert.ok(report.byte43.frac_physio_8_30 < 0.45);
});

test('type-40 live RR zip against v18 on the same strap unix', () => {
  const unix = 1_782_300_000;
  const v18 = ingestNotifyRow(notifyOf(puffinV18({ unix, hr: 75, rr: [790, 810] }), {
    family: 'puffin', t: '2026-08-26T05:10:00.000Z',
  }), { device: 'd4', fw: '50.35.2.0' });
  const t40 = ingestNotifyRow(notifyOf(puffinRT(1, unix, 0, 75, 2, [790, 810]), {
    family: 'puffin', t: '2026-08-26T05:10:00.100Z',
  }), { device: 'd4', fw: '50.35.2.0' });
  const report = auditV18Claims({ v18: [v18], gatt: [], type40: [t40] });
  assert.equal(t40.kind, 'type40');
  assert.deepEqual(t40.rr_raw, [790, 810]);
  assert.equal(report.rr.type40_vs_v18.n, 2);
  assert.equal(report.rr.type40_vs_v18.mae_h0, 0);
});

test('per-record H1 HRV delta is the 1000/1024 scale on 3-slot v18 rows', () => {
  const v18 = ingestNotifyRow(notifyOf(puffinV18({
    unix: 1_782_500_000, hr: 70, rr: [800, 820, 790],
  }), { family: 'puffin', t: '2026-08-26T05:00:00.000Z' }), { device: 'd6', fw: '50.35.2.0' });
  const report = auditV18Claims({ v18: [v18], gatt: [], type40: [] });
  assert.equal(report.rr.hrv.n_records_3plus_rr, 1);
  assert.equal(report.rr.hrv.expected_scale, 1000 / 1024);
  assert.ok(report.rr.hrv.median_rmssd_h0 > 0);
});
