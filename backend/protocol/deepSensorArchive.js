// Frame-oriented B2 archives for WHOOP 5/MG deep sensor layouts.
// High-rate arrays stay in object storage, never as Postgres rows.
// Identity is frame-hash + decoder version + layout, so live decode and
// B2 replay converge and a second replay cannot mint a duplicate.

import { gzipSync, gunzipSync } from 'node:zlib';
import { sha256, PACKET_TYPES } from './decoder.js';
import {
  DEEP_SENSOR_DECODER_VERSION,
  decodeWhoop5ImuV21,
  decodeWhoop5PpgV26,
  decodeWhoop5OpticalV20,
  compactMotionFeatures,
} from './deepSensor.js';

export const WHOOP5_IMU_V21_STREAM = 'whoop5_imu_v21';
export const WHOOP5_PPG_V26_STREAM = 'whoop5_ppg_v26';
export const WHOOP5_OPTICAL_V20_STREAM = 'whoop5_optical_v20';

export const WHOOP5_IMU_V21_SCHEMA = 'frwhoop_whoop5_imu_v21';
export const WHOOP5_PPG_V26_SCHEMA = 'frwhoop_whoop5_ppg_v26';
export const WHOOP5_OPTICAL_V20_SCHEMA = 'frwhoop_whoop5_optical_v20';

export function deepDerivedIdentity({
  frameHash, decoderVersion = DEEP_SENSOR_DECODER_VERSION, layout, kind,
} = {}) {
  return sha256(Buffer.from(
    `${frameHash || ''}|${decoderVersion || ''}|${layout || ''}|${kind || ''}`,
    'utf8',
  ));
}

function envelope(buf, packetType, ctx, crcOk, frameHash) {
  return {
    packet_type: packetType,
    packet_name: PACKET_TYPES[packetType] || null,
    frame_hash: frameHash,
    frame_length: buf.length,
    crc_ok: crcOk,
  };
}

function finish(record, layout, kind, frameHash) {
  record.identity = {
    source_frame_hash: frameHash,
    decoder_version: DEEP_SENSOR_DECODER_VERSION,
    layout,
    kind,
    derived_id: deepDerivedIdentity({
      frameHash, decoderVersion: DEEP_SENSOR_DECODER_VERSION, layout, kind,
    }),
  };
  return record;
}

export function imuV21RecordFromFrame(frame, ctx = {}) {
  const buf = frame instanceof Uint8Array ? frame : Uint8Array.from(frame || []);
  const d = decodeWhoop5ImuV21(buf, ctx);
  if (!d.ok) return null;
  const f = d.frame;
  const frameHash = f.source_frame_hash;
  const record = {
    schema: WHOOP5_IMU_V21_SCHEMA,
    kind: 'whoop5_imu_v21',
    family: 'puffin',
    layout: 'v21',
    sensor_ts: f.base_ts,
    record_index: f.record_index,
    sample_count: f.sample_count,
    nominal_sample_rate_hz: f.nominal_sample_rate_hz,
    sample_time_s: f.sample_time_s,
    accel_x_raw: f.accel_x_raw,
    accel_y_raw: f.accel_y_raw,
    accel_z_raw: f.accel_z_raw,
    gyro_x_raw: f.gyro_x_raw,
    gyro_y_raw: f.gyro_y_raw,
    gyro_z_raw: f.gyro_z_raw,
    accel_x_g: f.accel_x_g,
    accel_y_g: f.accel_y_g,
    accel_z_g: f.accel_z_g,
    gyro_x_dps: f.gyro_x_dps,
    gyro_y_dps: f.gyro_y_dps,
    gyro_z_dps: f.gyro_z_dps,
    gyro_scale_status: f.gyro_scale_status || 'reference_noop_2000dps',
    source: f.source || 'historical',
    features: f.features || compactMotionFeatures(f),
    received_at: ctx.receivedAt || null,
    firmware: { fw: ctx.fw || null, model: ctx.model || null },
    decoder: { version: DEEP_SENSOR_DECODER_VERSION },
    source_object_id: f.source_object_id,
    envelope: envelope(buf, f.packet_type || buf[8], ctx, true, frameHash),
  };
  return finish(record, 'v21', 'whoop5_imu_v21', frameHash);
}

export function ppgV26RecordFromFrame(frame, ctx = {}) {
  const buf = frame instanceof Uint8Array ? frame : Uint8Array.from(frame || []);
  const d = decodeWhoop5PpgV26(buf, ctx);
  if (!d.ok) return null;
  const f = d.frame;
  const frameHash = f.source_frame_hash;
  const record = {
    schema: WHOOP5_PPG_V26_SCHEMA,
    kind: 'whoop5_ppg_v26',
    family: 'puffin',
    layout: 'v26',
    sensor_ts: f.base_ts,
    record_index: f.record_index,
    sample_count: f.sample_count,
    nominal_sample_rate_hz: f.nominal_sample_rate_hz,
    sample_time_s: f.sample_time_s,
    samples: f.samples,
    features: f.features || null,
    raw_byte_12: f.raw_byte_12,
    raw_19_26: f.raw_19_26,
    raw_75_83: f.raw_75_83,
    received_at: ctx.receivedAt || null,
    firmware: { fw: ctx.fw || null, model: ctx.model || null },
    decoder: { version: DEEP_SENSOR_DECODER_VERSION },
    source_object_id: f.source_object_id,
    envelope: envelope(buf, 47, ctx, true, frameHash),
  };
  return finish(record, 'v26', 'whoop5_ppg_v26', frameHash);
}

export function opticalV20RecordFromFrame(frame, ctx = {}) {
  const buf = frame instanceof Uint8Array ? frame : Uint8Array.from(frame || []);
  const d = decodeWhoop5OpticalV20(buf, ctx);
  if (!d.ok) return null;
  const f = d.frame;
  const frameHash = f.source_frame_hash;
  const record = {
    schema: WHOOP5_OPTICAL_V20_SCHEMA,
    kind: 'whoop5_optical_v20',
    family: 'puffin',
    layout: 'v20',
    sensor_ts: f.base_ts,
    record_index: f.record_index,
    flags: f.flags,
    sample_rate_hz_declared: f.sample_rate_hz_declared,
    sample_count_pattern: f.sample_count_pattern,
    envelope_raw: f.envelope_raw,
    raw_21_25: f.raw_21_25,
    crc_raw: f.crc_raw,
    block_0: f.block_0,
    block_1: f.block_1,
    block_2: f.block_2,
    block_3: f.block_3,
    block_4: f.block_4,
    v20_block_0: f.v20_block_0 || f.block_0,
    v20_block_1: f.v20_block_1 || f.block_1,
    v20_block_2: f.v20_block_2 || f.block_2,
    v20_block_3: f.v20_block_3 || f.block_3,
    v20_block_4: f.v20_block_4 || f.block_4,
    features: f.features || null,
    received_at: ctx.receivedAt || null,
    firmware: { fw: ctx.fw || null, model: ctx.model || null },
    decoder: { version: DEEP_SENSOR_DECODER_VERSION },
    source_object_id: f.source_object_id,
    envelope: envelope(buf, 47, ctx, true, frameHash),
  };
  return finish(record, 'v20', 'whoop5_optical_v20', frameHash);
}

export function deepSensorRecordsFromFrame(frame, family, ctx = {}) {
  if (family !== 'puffin' || !frame || frame.length < 12) {
    return { imu: null, ppg: null, optical: null };
  }
  const buf = frame instanceof Uint8Array ? frame : Uint8Array.from(frame);
  if (buf[8] === 43) return { imu: imuV21RecordFromFrame(buf, ctx), ppg: null, optical: null };
  if (buf[8] !== 47) return { imu: null, ppg: null, optical: null };
  const v = buf[9];
  if (v === 21) return { imu: imuV21RecordFromFrame(buf, ctx), ppg: null, optical: null };
  if (v === 26) return { imu: null, ppg: ppgV26RecordFromFrame(buf, ctx), optical: null };
  if (v === 20) return { imu: null, ppg: null, optical: opticalV20RecordFromFrame(buf, ctx) };
  return { imu: null, ppg: null, optical: null };
}

export function deepRecordIdentity(rec) {
  return rec?.identity?.derived_id || rec?.envelope?.frame_hash || null;
}

export function dedupeDeepRecords(records = []) {
  const seen = new Set();
  const out = [];
  for (const rec of records) {
    if (!rec) continue;
    const id = deepRecordIdentity(rec);
    const key = id || JSON.stringify([rec.sensor_ts, rec.kind, rec.layout]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out;
}

function encodeRows(records, schema, stream, format) {
  const rows = dedupeDeepRecords((records || []).filter((r) => r && r.schema === schema));
  const ndjson = `${rows.map((r) => JSON.stringify(r)).join('\n')}${rows.length ? '\n' : ''}`;
  const body = gzipSync(Buffer.from(ndjson, 'utf8'));
  return {
    body,
    sample_count: rows.length,
    compressed_bytes: body.length,
    format,
    compression: 'gzip',
    content_type: 'application/x-ndjson',
    schema_version: 1,
    stream,
    rows,
  };
}

function decodeRows(body, schema) {
  if (!body) return [];
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  let text;
  try { text = gunzipSync(raw).toString('utf8'); } catch { text = raw.toString('utf8'); }
  const trimmed = text.trim();
  if (!trimmed) return [];
  const lines = trimmed.startsWith('[')
    ? JSON.parse(trimmed)
    : trimmed.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const rows = Array.isArray(lines) ? lines : [];
  return rows.filter((r) => r && r.schema === schema);
}

export function encodeImuV21Archive(records) {
  return encodeRows(records, WHOOP5_IMU_V21_SCHEMA, WHOOP5_IMU_V21_STREAM, 'ndjson_gzip_whoop5_imu_v21');
}
export function decodeImuV21Archive(body) {
  return decodeRows(body, WHOOP5_IMU_V21_SCHEMA);
}
export function encodePpgV26Archive(records) {
  return encodeRows(records, WHOOP5_PPG_V26_SCHEMA, WHOOP5_PPG_V26_STREAM, 'ndjson_gzip_whoop5_ppg_v26');
}
export function decodePpgV26Archive(body) {
  return decodeRows(body, WHOOP5_PPG_V26_SCHEMA);
}
export function encodeOpticalV20Archive(records) {
  return encodeRows(records, WHOOP5_OPTICAL_V20_SCHEMA, WHOOP5_OPTICAL_V20_STREAM, 'ndjson_gzip_whoop5_optical_v20');
}
export function decodeOpticalV20Archive(body) {
  return decodeRows(body, WHOOP5_OPTICAL_V20_SCHEMA);
}
