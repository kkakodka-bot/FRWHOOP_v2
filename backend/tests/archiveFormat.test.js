import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeArchive, decodeFrameArchive, encodeArchive, encodeFrameArchive, normalizeSample, normalizeSteps, normalizeSkinTempC, decodeFieldCensus, ARCHIVE_FORMAT, FRAME_ARCHIVE_FORMAT } from '../ingest/archiveFormat.js';

test('archive is actual gzip NDJSON not a json array', () => {
  const { body, format, sha256, sample_count } = encodeArchive([
    {
      datetime: '2026-08-24T18:00:00.000Z',
      t_strap: '2026-02-25T18:00:00.000Z',
      clock_offset_sec: 15_552_000,
      bpm: 62,
      rr_ms: [968],
    },
    { datetime: '2026-08-24T18:00:04.000Z', bpm: 64 },
  ]);
  assert.equal(format, ARCHIVE_FORMAT);
  assert.equal(sample_count, 2);
  assert.match(sha256, /^[0-9a-f]{64}$/);
  const rows = decodeArchive(body);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].bpm, 62);
  assert.deepEqual(rows[0].rr_ms, [968]);
  assert.equal(rows[0].t_strap, '2026-02-25T18:00:00.000Z');
  assert.equal(rows[0].clock_offset_sec, 15_552_000);
  assert.equal(body[0], 0x1f);
  assert.equal(body[1], 0x8b);
});

test('decode accepts legacy gzip json array', async () => {
  const { gzipSync } = await import('node:zlib');
  const body = gzipSync(Buffer.from(JSON.stringify([{ datetime: '2026-08-24T18:00:00.000Z', bpm: 70 }])));
  const rows = decodeArchive(body);
  assert.equal(rows[0].bpm, 70);
});

test('decodeFieldCensus counts present physiology columns', () => {
  const census = decodeFieldCensus([
    { bpm: 70, rr_ms: [900], gx: 0.1, gy: 0.2, gz: 0.9, steps: 2, skin_temp_c: 33.1 },
    { bpm: 72 },
  ]);
  assert.equal(census.samples, 2);
  assert.equal(census.bpm, 2);
  assert.equal(census.rr_ms, 1);
  assert.equal(census.gravity, 1);
  assert.equal(census.steps, 1);
  assert.equal(census.skin_temp_c, 1);
});

test('gravity-only physiology rows round-trip without phone motion', () => {
  const encoded = encodeArchive([{
    t: '2026-08-24T18:00:00.000Z',
    seq: 44,
    gx: 0.12,
    gy: -0.98,
    gz: 0.03,
    dyn_accel: 0.17,
    source: 'whoop_history',
    layout: 'imu-v2',
    family: 'puffin',
    decoder: 'ios/3',
    phoneMotion: 9,
    motion: 4,
  }]);
  assert.equal(encoded.sample_count, 1);
  const [row] = decodeArchive(encoded.body);
  assert.equal(row.bpm, null);
  assert.deepEqual([row.gx, row.gy, row.gz], [0.12, -0.98, 0.03]);
  assert.equal(row.dyn_accel, 0.17);
  assert.equal(row.src, 'whoop_history');
  assert.equal(row.layout, 'imu-v2');
  assert.equal(row.family, 'puffin');
  assert.equal(row.decoder, 'ios/3');
  assert.equal(row.seq, 44);
  assert.equal(row.mot, null);
});

test('invalid or partial gravity vectors do not create physiology rows', () => {
  const encoded = encodeArchive([
    { t: '2026-08-24T18:00:00.000Z', gx: 0.1, gy: 0.2 },
    { t: '2026-08-24T18:00:04.000Z', gx: 99, gy: 0, gz: 0 },
  ]);
  assert.equal(encoded.sample_count, 0);
  assert.deepEqual(decodeArchive(encoded.body), []);
});

test('frame archive keeps opaque hex without requiring bpm', () => {
  const { body, format, sample_count, rows } = encodeFrameArchive([
    {
      hex: 'AA01FF',
      t: '2026-08-24T18:00:00.000Z',
      family: 'puffin',
      char: 'FD4B0003',
      seq: 12,
      fw: '50.35.0',
      model: 'WHOOP 5.0 / MG',
    },
  ]);
  assert.equal(format, FRAME_ARCHIVE_FORMAT);
  assert.equal(sample_count, 1);
  assert.equal(rows[0].hex, 'aa01ff');
  assert.equal(rows[0].bpm, undefined);
  const decoded = decodeFrameArchive(body);
  assert.equal(decoded[0].hex, 'aa01ff');
  assert.equal(decoded[0].family, 'puffin');
  assert.equal(decoded[0].fw, '50.35.0');
});

test('wear_location stamps survive archive round-trip and unstamped rows stay null', () => {
  const stamped = normalizeSample({
    t: '2026-08-24T18:00:00.000Z',
    bpm: 70,
    wear_location: 'bicep',
    wear_location_source: 'user',
  });
  assert.equal(stamped.wear_location, 'bicep');
  assert.equal(stamped.wear_location_source, 'user');
  const legacy = normalizeSample({ t: '2026-08-24T18:00:00.000Z', bpm: 70 });
  assert.equal(legacy.wear_location, null);
  assert.equal(legacy.wear_location_source, null);
  const { body } = encodeArchive([stamped, { t: '2026-08-24T18:00:04.000Z', bpm: 72, wear_location: 'wrist' }]);
  const rows = decodeArchive(body);
  assert.equal(rows[0].wear_location, 'bicep');
  assert.equal(rows[1].wear_location, 'wrist');
});

test('decoder field aliases (heart_rate, step_motion_counter, skin_temp_raw) normalize into ingest samples', () => {
  const row = normalizeSample({
    t: '2026-08-25T02:00:00Z',
    heart_rate: 70,
    step_motion_counter: 9001,
    skin_temp_raw: 3400,
    gx: 0, gy: 0, gz: 1,
  }, '2026-08-25T02:00:00Z');
  assert.equal(row.bpm, 70);
  assert.equal(row.step_cumulative, 9001);
  assert.equal(row.skin_temp_c, 34);
});

test('WHOOP5 v18 history row carries steps + skin temp through the archive', () => {
  const row = normalizeSample({
    t: '2026-08-25T02:00:00Z',
    bpm: 60,
    rr_ms: [],
    gx: 0, gy: 0, gz: 1,
    step_cumulative: 100,
    step_cadence: 170,
    activity_class: 1,
    skin_temp_c: 36.6,
    family: 'puffin',
    layout: 'v18',
    seq: 1,
  }, '2026-08-25T02:00:00Z');
  assert.equal(row.step_cumulative, 100);
  assert.equal(row.step_cadence, 170);
  assert.equal(row.activity_class, 1);
  assert.equal(row.skin_temp_c, 36.6);
});

test('raw ADC temperature and implausible step units are refused at ingest', () => {
  // 3057 is a raw ADC, not degrees C: must not be stored as skin temperature.
  assert.equal(normalizeSkinTempC({ skin_temp_c: 3057 }), null);
  assert.equal(normalizeSkinTempC({ skin_temp_c: 14.07 }), null); // off-wrist artifact
  assert.equal(normalizeSkinTempC({ skin_temp_c: 4 }), null);    // below physiological band
  assert.equal(normalizeSkinTempC({ skin_temp_c: 46 }), null);   // above physiological band
  // A per-second delta far beyond running cadence is a unit error.
  assert.equal(normalizeSteps({ steps: 5000 }), null);
  assert.equal(normalizeSteps({ steps: 3 }), 3);
});

test('sensor_ts is archived with step samples for replay dedupe', () => {
  const encoded = encodeArchive([{
    t: '2026-08-24T18:00:00.000Z',
    step_cumulative: 44,
    sensor_ts: 1780000000,
    seq: 9,
  }]);
  const [row] = decodeArchive(encoded.body);
  assert.equal(row.sensor_ts, 1780000000);
  assert.equal(row.step_cumulative, 44);
});
