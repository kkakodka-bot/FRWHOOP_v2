// Differential parity: FRWHOOP WHOOP5 decoder vs upstream NOOP (ryanbr/noop @ ab0f699e).
//
// Semantic parity means: given the SAME raw frame, the FRWHOOP decoder reaches the
// SAME interpretation as current NOOP for every high-confidence field NOOP maps. This
// file replays NOOP's own ground truth (its decoder_oracle.json WHOOP5 v18 real frames
// and the real captured v20/v21 buffers) plus synthetic v18/v20/v21/v26 frames, and
// asserts the FRWHOOP port matches. Offsets, endianness, gates, and neutral naming are
// carried over byte-for-byte; see protocol/whoop5.js for the NOOP source commit lineage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { decodeFrame, DECODER_LINEAGE } from '../../protocol/decoder.js';
import {
  decodeWhoop5Historical, decodeMetadata, decodeCommandResponse, decodeEvent, decodeConsoleLogs,
} from '../../protocol/whoop5.js';
import { verifyFrame, createReassembler } from '../../protocol/framing.js';
import { crc16Modbus, crc32 } from '../../protocol/crc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/noop-whoop5-parity.json'), 'utf8'));

// ---- puffin frame builder (mirrors NOOP Whoop5HistoricalV2021Tests.makeFrame) ----
function makeFrame(total, version, build) {
  const f = new Uint8Array(total);
  f[0] = 0xAA; f[1] = 0x01;
  const declared = total - 8;
  f[2] = declared & 0xFF; f[3] = (declared >> 8) & 0xFF;
  f[4] = 0x01; f[5] = 0x00;
  f[8] = 0x2f;              // packet type 47 HISTORICAL_DATA
  f[9] = version;
  build(f);
  const h = crc16Modbus(Array.from(f.slice(0, 6)));
  f[6] = h & 0xFF; f[7] = (h >> 8) & 0xFF;
  const payloadEnd = total - 4;
  const c = crc32(Array.from(f.slice(8, payloadEnd)));
  f[payloadEnd] = c & 0xFF; f[payloadEnd + 1] = (c >> 8) & 0xFF;
  f[payloadEnd + 2] = (c >> 16) & 0xFF; f[payloadEnd + 3] = (c >> 24) & 0xFF;
  return f;
}
const putU32 = (f, off, v) => {
  f[off] = v & 0xFF; f[off + 1] = (v >> 8) & 0xFF; f[off + 2] = (v >> 16) & 0xFF; f[off + 3] = (v >> 24) & 0xFF;
};
const putI16 = (f, off, v) => { const u = v & 0xFFFF; f[off] = u & 0xFF; f[off + 1] = (u >> 8) & 0xFF; };
const putI32 = (f, off, v) => { const u = v >>> 0; f[off] = u & 0xFF; f[off + 1] = (u >> 8) & 0xFF; f[off + 2] = (u >> 16) & 0xFF; f[off + 3] = (u >> 24) & 0xFF; };

function setFloat32(b, off, val) { new DataView(b.buffer).setFloat32(off, val, true); }
function bufOf(hex) { return Buffer.from(hex, 'hex'); }

test('parity: real WHOOP5 v18 oracle frames decode to NOOP semantics', () => {
  const acc = fixture.gravity_mag_accuracy;
  for (const fr of fixture.v18) {
    const d = decodeFrame(bufOf(fr.hex), 'puffin');
    assert.equal(d.decoded.hist_version, 18, `${fr.name} hist_version`);
    assert.equal(d.decoded.mapped, true, `${fr.name} mapped`);
    assert.equal(d.decoded.lineage, DECODER_LINEAGE, `${fr.name} lineage`);
    const got = d.decoded.parsed;
    for (const [k, e] of Object.entries(fr.expect)) {
      if (k === 'hist_version') continue;
      if (k === 'gravity_mag') {
        assert.ok(Math.abs(got.gravity_mag - e) <= acc, `${fr.name} gravity_mag ${got.gravity_mag} vs ${e} (acc ${acc})`);
        continue;
      }
      if (Array.isArray(e)) { assert.deepEqual(got[k], e, `${fr.name}.${k}`); continue; }
      if (typeof e === 'number' && !Number.isInteger(e)) {
        // floating-point fields (f32 like unknown_f32_113 / gravity) are compared within
        // tolerance, matching NOOP's decoder-oracle 1e-4 double rule.
        assert.ok(Math.abs(got[k] - e) <= 1e-4, `${fr.name}.${k} = ${got[k]} expected ${e} (tol 1e-4)`);
        continue;
      }
      assert.equal(got[k], e, `${fr.name}.${k} = ${got[k]} expected ${e}`);
    }
  }
});

test('parity: real WHOOP5 v20 optical buffer decodes 25-sample channels in blocks 0/3/4', () => {
  const fr = fixture.v20_real;
  const f = bufOf(fr.hex);
  assert.equal(f.length, 2140);
  assert.equal(verifyFrame(f, 'puffin').ok, true, 'v20 real frame CRC must verify');
  const d = decodeFrame(f, 'puffin');
  const p = d.decoded.parsed;
  assert.equal(p.hist_version, 20);
  assert.equal(p.layout_marker, 0x81);
  assert.equal(p.record_index, 11494060);
  assert.equal(p.unix, 1784054004);
  assert.equal(p.sensor_channel_samples, 25);
  assert.equal(p.sensor_channels_present, 6);
  for (const b of ['b0_0','b0_1','b3_0','b3_1','b4_0','b4_1']) assert.equal(p[`channel_${b}`].length, 25, `channel_${b} 25 samples`);
  assert.equal(p.channel_b1_0, undefined, 'empty block 1 no channel');
  assert.equal(p.channel_b2_0, undefined, 'empty block 2 no channel');
  assert.equal(p.channel_b0_0[0], 118434);
  assert.equal(p.channel_b0_0[24], 147258);
  assert.equal(p.channel_b0_1[0], -22101);
  assert.equal(p.channel_b4_1[24], 11318);
});

test('parity: real WHOOP5 v21 1244-B IMU buffer decodes six 100-sample channels', () => {
  const fr = fixture.v21_real;
  const f = bufOf(fr.hex);
  assert.equal(f.length, 1244);
  assert.equal(verifyFrame(f, 'puffin').ok, true);
  const d = decodeFrame(f, 'puffin');
  const p = d.decoded.parsed;
  assert.equal(p.hist_version, 21);
  assert.equal(p.layout_marker, 0x80);
  assert.equal(p.sensor_channel_samples, 100);
  for (const ch of ['accel_x','accel_y','accel_z','gyro_x','gyro_y','gyro_z']) {
    assert.equal(p[ch].length, 100, `${ch} has 100 samples`);
  }
});

test('synthetic v18 decodes every mapped field with correct offsets', () => {
  const f = makeFrame(124, 18, (b) => {
    putU32(b, 11, 1234567);        // record_index
    putU32(b, 15, 1784054004);     // unix
    b[22] = 70;                    // heart_rate
    b[23] = 2;                     // rr_count
    putI16(b, 24, 857); putI16(b, 26, 851);  // rr
    setFloat(b, 45, 0.1); setFloat(b, 49, 0.0); setFloat(b, 53, 0.995);
    setFloat(b, 41, 0.05);          // dynamic_acceleration
    putI16(b, 57, 9001);            // step_motion_counter
    b[59] = 128;                    // step_cadence
    putI16(b, 69, 340); putI16(b, 71, 350);  // temp_aux (34.0 / 35.0 C)
    putI16(b, 73, 3400);            // skin_temp_raw 34.00 C
    putI16(b, 108 + 0, 0);          // (no-op alignment)
    b[106] = 101; b[107] = 111; b[108] = 30; b[109] = 30; // optical baselines + amps
    b[81] = 0x04;                   // wake_quality=1, sleep_state=0, onwrist=0
    b[82] = 0;
  });
  function setFloat(b, off, val) { new DataView(b.buffer).setFloat32(off, val, true); }
  const d = decodeFrame(f, 'puffin');
  const p = d.decoded.parsed;
  assert.equal(p.record_index, 1234567);
  assert.equal(p.unix, 1784054004);
  assert.equal(p.heart_rate, 70);
  assert.deepEqual(p.rr_intervals, [857, 851]);
  assert.ok(Math.abs(p.gravity_mag - 1.0) < 0.02);
  assert.ok(Math.abs(p.dynamic_acceleration - 0.05) < 1e-6);
  assert.equal(p.step_motion_counter, 9001);
  assert.equal(p.step_cadence, 128);
  assert.equal(p.temp_aux_1_raw, 340);
  assert.equal(p.temp_aux_2_raw, 350);
  assert.equal(p.skin_temp_raw, 3400);
  assert.equal(p.optical_baseline_a, 101);
  assert.equal(p.optical_amp_a, 30);
  assert.equal(p.wake_quality, 1);
});

test('v26 is a Pulse Information Packet: 1 absolute sample + 24 saturated deltas -> 25 reconstructed samples', () => {
  // SUPERSEDED READING (registry v26.samples_vs_deltas): the old "24 i16 PPG
  // samples @27..75" was wrong. Bytes 27..75 are 24 saturated i16 DELTAS over
  // a 25-sample window whose sample 0 is the sign-extended 20-bit i32 @23.
  // The rate comes from the header flags bit7 (25/50 Hz), not the counts.
  const f = makeFrame(88, 26, (b) => {
    putU32(b, 11, 77);
    putU32(b, 15, 1784054004);
    putI16(b, 21, 5);                       // pip_state_counter (legacy burst_index)
    putI32(b, 23, 249855);                  // first sample (sign-extended 20-bit)
    for (let i = 0; i < 24; i++) putI16(b, 27 + i * 2, 1000 + i);   // deltas
    setFloat32(b, 75, 0.03);                // accel delta g
    putI16(b, 79, 4242);                    // channel state word
    b[81] = 1; b[82] = 1;                   // primary flags / morphology
  });
  const d = decodeFrame(f, 'puffin');
  const p = d.decoded.parsed;
  assert.equal(p.hist_version, 26);
  assert.equal(p.pip_state_counter, 5);
  assert.equal(p.optical_deltas.length, 24);
  assert.equal(p.ppg_window_sample_count, 25);
  assert.equal(p.ppg_waveform.length, 25);          // legacy key = reconstruction
  assert.equal(p.ppg_waveform[0], 249855);
  assert.equal(p.ppg_waveform[1], 249855 + 1000);   // delta 0
  // cumulative sum of all 24 deltas: 249855 + sum(1000..1023) = 274131
  assert.equal(p.ppg_waveform[24], 274131);
  assert.ok(Math.abs(p.accel_delta_g - 0.03) < 1e-6, `accel_delta_g ${p.accel_delta_g}`);
});

test('synthetic v21 decodes six 100-sample channels preserving full arrays (no reduction)', () => {
  const f = makeFrame(1244, 21, (b) => {
    putU32(b, 11, 0x01A8CF25);
    putU32(b, 15, 1781556371);
    putI16(b, 22, 100); putI16(b, 24, 100); b[26] = 3; b[27] = 0;
    putI16(b, 624, 100); putI16(b, 630, 100); b[632] = 5; b[633] = 0;
    for (let i = 0; i < 100; i++) putI16(b, 28 + i * 2, 1800 + (i % 7));
    for (let i = 0; i < 100; i++) putI16(b, 228 + i * 2, 700 + (i % 5));
    for (let i = 0; i < 100; i++) putI16(b, 428 + i * 2, 3600 + (i % 3));
    for (let i = 0; i < 100; i++) putI16(b, 640 + i * 2, 10 + (i % 4));
    for (let i = 0; i < 100; i++) putI16(b, 840 + i * 2, -20 + (i % 3));
    for (let i = 0; i < 100; i++) putI16(b, 1040 + i * 2, 5 + (i % 2));
  });
  const d = decodeFrame(f, 'puffin');
  const p = d.decoded.parsed;
  assert.equal(p.accel_x.length, 100);
  assert.equal(p.accel_x[0], 1800);
  assert.equal(p.accel_x[99], 1800 + (99 % 7));
  assert.equal(p.gyro_y[99], -20 + (99 % 3));
  // The full arrays must be present verbatim (mission: never reduce to a mean).
  assert.equal(p.accel_z.filter((_, i) => i > 0).length, 99);
});

test('unknown historical version stays mapped:false, bytes preserved', () => {
  const f = makeFrame(124, 43, () => {});
  const d = decodeFrame(f, 'puffin');
  assert.equal(d.decoded.mapped, false);
  assert.equal(d.decode_status, 'unknown');
  assert.equal(d.raw_hex.length, 124 * 2);
});

test('WHOOP5 metadata, command-response, event, console decoders', () => {
  // METADATA (49): unix@11, subsec@15, trim_cursor@21.
  const f = makeFrame(40, 49, (b) => {
    putU32(b, 11, 1784054004); putI16(b, 15, 123); putU32(b, 21, 9999);
  });
  // Override packet type to 49 for the metadata test.
  // (makeFrame sets type 47; rebuild with type at [8]=49.)
  const meta = Uint8Array.from(f); meta[8] = 49;
  const md = decodeMetadata(meta);
  assert.equal(md.unix, 1784054004);
  assert.equal(md.subsec, 123);
  assert.equal(md.trim_cursor, 9999);

  // COMMAND_RESPONSE (36): GET_BATTERY_LEVEL => battery_pct=pay[2].
  const cr = new Uint8Array(32); cr[10] = 26; cr[11] = 5; cr[12] = 1; cr[13] = 47;
  const crd = decodeCommandResponse(cr, 30);
  assert.equal(crd.resp_command, 26);
  assert.equal(crd.result, 'SUCCESS');
  assert.equal(crd.battery_pct, 47);

  // EVENT (48) BATTERY_LEVEL payload (family-aware: puffin ev@10/ts@12, soc@21/mV@25/charging@30).
  const ev = new Uint8Array(40); ev[10] = 3; putU32(ev, 12, 1784054004);
  putI16(ev, 21, 499); putI16(ev, 25, 3850); ev[30] = 1;
  const evd = decodeEvent(ev, 'puffin', 'BATTERY_LEVEL');
  assert.equal(evd.event, 3);
  assert.equal(evd.event_timestamp, 1784054004);
  assert.equal(evd.battery_pct, 49.9);
  assert.equal(evd.battery_mV, 3850);
  assert.equal(evd.battery_charging, 1);

  // Harvard BATTERY_LEVEL (event@6, ts@8, soc@17/mV@21/charging@26 — NOOP PostHooks 4.0 layout).
  const ev4 = new Uint8Array(40); ev4[6] = 3; putU32(ev4, 8, 1784054004);
  putI16(ev4, 17, 800); putI16(ev4, 21, 3900); ev4[26] = 0;
  const ev4d = decodeEvent(ev4, 'harvard', 'BATTERY_LEVEL');
  assert.equal(ev4d.battery_pct, 80);
  assert.equal(ev4d.battery_mV, 3900);
  assert.equal(ev4d.battery_charging, 0);
  assert.equal(evd.event_timestamp, 1784054004);
  assert.equal(evd.battery_pct, 49.9);
  assert.equal(evd.battery_mV, 3850);
  assert.equal(evd.battery_charging, 1);

  // CONSOLE_LOGS (50): text from 21..payloadEnd.
  const cl = new Uint8Array(64);
  putI16(cl, 9, 7); putU32(cl, 12, 1784054004); putI16(cl, 16, 0);
  const msg = Buffer.from('SENSORS: AFE configuration changed');
  cl.set(msg, 21);
  const cld = decodeConsoleLogs(cl, 21 + msg.length);
  assert.equal(cld.record_index, 7);
  assert.ok(cld.log.includes('AFE configuration changed'));
});

test('parity: type-43 REALTIME_RAW_DATA — 1917 IMU (100 Hz 6-axis) + 1921 optical (437 Hz, s24)', () => {
  const imu = fixture.type43_imu_1917;
  const dI = decodeFrame(bufOf(imu.hex), 'harvard');
  assert.equal(dI.decode_status, 'decoded');
  const pI = dI.decoded;
  assert.equal(pI.kind, 'imu');
  assert.equal(pI.samples_per_axis, 100);
  assert.equal(pI.heart_rate, 70);
  assert.deepEqual(pI.rr, [857]);
  assert.equal(pI.accel_z.length, 100);
  assert.equal(pI.accel_z[0], 4096);
  assert.equal(pI.unmapped_tail_bytes, 632);

  const opt = fixture.type43_optical_1921;
  const dO = decodeFrame(bufOf(opt.hex), 'harvard');
  assert.equal(dO.decode_status, 'decoded');
  const pO = dO.decoded;
  assert.equal(pO.kind, 'optical');
  assert.equal(pO.samples, 419);
  assert.equal(pO.sample_rate_hz, 437);
  assert.equal(pO.optical_ac.length, 419);
  assert.deepEqual(pO.optical_ac.slice(0, 5), [0, 250, 497, 736, 963]);
  assert.equal(pO.optical_config_header.length, 27);
});

test('whoop5 type-43 structural hypothesis does not throw and preserves bytes', () => {
  const total = 1400;
  const f = new Uint8Array(total).fill(0);
  f[0] = 0xAA; f[1] = 0x01;
  const declared = total - 8; f[2] = declared & 0xFF; f[3] = (declared >> 8) & 0xFF;
  f[8] = 43;
  for (let i = 0; i < 100; i++) { putI16(f, 493 + i * 2, 4096); putI16(f, 93 + i * 2, i % 7); }
  const c16 = crc16Modbus(Array.from(f.slice(0, 6))); f[6] = c16 & 0xFF; f[7] = (c16 >> 8) & 0xFF;
  const c32 = crc32(Array.from(f.slice(8, total - 4))); f[total-4]=c32&0xFF; f[total-3]=(c32>>8)&0xFF; f[total-2]=(c32>>16)&0xFF; f[total-1]=(c32>>24)&0xFF;
  const d = decodeFrame(f.slice(0, total), 'puffin');
  assert.ok(d.raw_hex.length > 0);
});

test('parity: real v26 PIP - wire deltas match the old flat reading, window reconstructs to 25 samples', () => {
  const fr = fixture.v26_real;
  const d = decodeFrame(bufOf(fr.hex), 'puffin');
  const p = d.decoded.parsed;
  assert.equal(p.hist_version, 26);
  assert.equal(p.unix, 1780917232);
  // SUPERSEDED READING (registry v26.samples_vs_deltas): the 24 i16 values the
  // old decoder surfaced as a flat "waveform" are the WIRE DELTAS. The window
  // is first_sample_adc (i32 @23) + cumulative sum -> 25 samples.
  assert.equal(p.optical_deltas.length, 24);
  assert.deepEqual(p.optical_deltas, fr.expect.waveform, 'the old flat reading is exactly the delta array');
  assert.equal(p.ppg_window_sample_count, 25);
  assert.equal(p.ppg_waveform.length, 25);
  assert.equal(p.ppg_waveform[0], p.first_sample_adc);
  let acc = p.first_sample_adc;
  for (let i = 0; i < 24; i += 1) acc += fr.expect.waveform[i];
  assert.equal(p.ppg_waveform[24], acc);
});

test('read-only feature-flag / device-config read-back decodes (GET_FF_VALUE 128 / GET_DEVICE_CONFIG_VALUE 121)', () => {
  // Mirror NOOP DeviceConfigReadProbeTests.whoop5Response: inner = [36,seq,cmd]+payload,
  // payload = [0x0A,result] + record ([b3 lead][32-byte name][value]).
  function echoRecord(name, value) { const f = new Uint8Array(33); for (let i=0;i<32&&i<name.length;i++) f[i]=name.charCodeAt(i); f[32]=value; return [0x01, ...f]; }
  function whoop5Response(cmd, payload) {
    const inner=[36,1,cmd,...payload]; const pad=(4-inner.length%4)%4; for(let i=0;i<pad;i++) inner.push(0);
    const declLen=inner.length+4; const frame=[0xAA,0x01,declLen&0xFF,(declLen>>8)&0xFF,0x00,0x01];
    const c16=crc16Modbus(Array.from(frame.slice(0,6))); frame.push(c16&0xFF,(c16>>8)&0xFF); frame.push(...inner);
    const c32=crc32(inner); frame.push(c32&0xFF,(c32>>8)&0xFF,(c32>>16)&0xFF,(c32>>24)&0xFF); return Uint8Array.from(frame);
  }
  const d = decodeFrame(whoop5Response(128,[0x0A,0x01,...echoRecord("enable_r22_packets",0x32)]), "puffin");
  const rb = d.decoded.parsed.config_read_back;
  assert.equal(rb.cmd, 128);
  assert.equal(rb.result, 'SUCCESS');
  assert.equal(rb.key, 'enable_r22_packets');
  assert.equal(rb.value, 0x32);
  const d2 = decodeFrame(whoop5Response(121,[0x0A,0x03,...echoRecord("whoop_live_hr_in_adv_ind_pkt",0x30)]), "puffin");
  const rb2 = d2.decoded.parsed.config_read_back;
  assert.equal(rb2.result, 'UNSUPPORTED');
  assert.equal(rb2.key, 'whoop_live_hr_in_adv_ind_pkt');
});

test('type 52 HISTORICAL_IMU_DATA_STREAM routes as a 5/MG history body (version@9)', () => {
  // Build a 1244-B type-52 (not 47) frame carrying a valid v21 6-axis IMU body, version@9.
  const f = makeFrame(1244, 21, (b) => {
    b[8] = 52; // packet type HISTORICAL_IMU_DATA_STREAM; version already @9 = 21
    putU32(b, 11, 0x01A8CF25); putU32(b, 15, 1781556371);
    // declared counts identify the buffer (shared 43/47/51/52 decoder)
    putI16(b, 22, 100); putI16(b, 24, 100); b[26] = 3; b[27] = 0;
    putI16(b, 624, 100); putI16(b, 630, 100); b[632] = 5; b[633] = 0;
    for (let i = 0; i < 100; i++) { putI16(b, 28 + i * 2, 1800 + (i % 7)); putI16(b, 428 + i * 2, 3600 + (i % 3)); }
    for (let i = 0; i < 100; i++) putI16(b, 640 + i * 2, 10 + (i % 4));
  });
  const d = decodeFrame(f, 'puffin');
  assert.equal(d.packet_type, 52);
  const p = d.decoded.parsed || {};
  assert.equal(p.hist_version, 21);
  assert.equal(d.decoded.imu_data_stream, true);
  assert.equal(p.accel_x.length, 100);
});

test('type 56 PUFFIN_METADATA routes as METADATA (alias of 49)', () => {
  const f = makeFrame(40, 0, (b) => {
    b[8] = 56; // build a CRC-consistent type-56 frame (type set BEFORE envelope CRC is computed)
    putU32(b, 11, 1784054004); putI16(b, 15, 123); putU32(b, 21, 9999);
  });
  const d = decodeFrame(f, 'puffin');
  assert.equal(d.crc_ok, true);
  assert.equal(d.packet_type, 56);
  assert.equal(d.decoded.puffin_metadata, true);
  assert.equal(d.decoded.parsed.unix, 1784054004);
  assert.equal(d.decoded.parsed.trim_cursor, 9999);
});
