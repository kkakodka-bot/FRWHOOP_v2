// PPG raw archive — compact per-second optical windows derived from verified
// WHOOP frames. High-rate samples stay in B2 (`ppg_raw`), never in Supabase.
//
// Proven inputs only:
//   - WHOOP 5/MG type-47 v26 Pulse Information Packet: first absolute ADC
//     sample + 24 saturated i16 deltas → 25-sample window. Native rate is
//     header flags bit7 (set=25 Hz, clear=50 Hz), never sample count.
//   - WHOOP 4 type-43 optical variant 1921: 419 s24 samples @ 437 Hz (layout
//     verified against the harvard golden). WHOOP 5 type-43 optical remains a
//     hypothesis and is not archived as a canonical stage input.
//
// v20 optical blocks are preserved on the Level A/B frame archive. They are
// NOT a V3 stage input: wavelength identity is unproven.

import { gzipSync, gunzipSync } from 'node:zlib';
import { decodeFrame, DECODER_VERSION, DECODER_LINEAGE, PACKET_TYPES, sha256 } from './decoder.js';

export const PPG_ARCHIVE_SCHEMA = 'frwhoop_ppg_raw_v1';
export const PPG_ARCHIVE_STREAM = 'ppg_raw';
export const PPG_ARCHIVE_FORMAT = 'ndjson_gzip_ppg_v1';
export const PPG_ARCHIVE_SCHEMA_VERSION = 1;
export const V26_SUPPORTED_RATES_HZ = Object.freeze([25, 50]);

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function ppgDerivedIdentity({
  frameHash, decoderVersion = DECODER_VERSION, layout, kind,
} = {}) {
  return sha256(Buffer.from(
    `${frameHash || ''}|${decoderVersion || ''}|${layout || ''}|${kind || ''}`,
    'utf8',
  ));
}

export function ppgRecordIdentity(rec) {
  return rec?.identity?.derived_id || rec?.envelope?.frame_hash || null;
}

export function dedupePpgRecords(records = []) {
  const seen = new Set();
  const out = [];
  for (const rec of records) {
    if (!rec) continue;
    const id = ppgRecordIdentity(rec);
    const key = id || JSON.stringify([rec.sensor_ts, rec.kind, rec.samples?.[0], rec.samples?.length]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out;
}

function envelope(buf, packetType, ctx, deep) {
  return {
    packet_type: packetType,
    packet_name: PACKET_TYPES[packetType] || null,
    frame_hash: ctx.frameHash || deep?.frame_hash || null,
    frame_length: buf.length,
    crc_ok: deep?.crc_ok ?? null,
  };
}

function clockFields(parsedUnix, ctx, deep) {
  const sensorSeconds = Number(parsedUnix);
  const sensorMs = Number.isFinite(sensorSeconds)
    ? (sensorSeconds > 1e12 ? sensorSeconds : sensorSeconds * 1000)
    : null;
  const receivedMs = Date.parse(ctx.receivedAt || '');
  const liveClockReference = Number.isFinite(sensorMs)
    && Number.isFinite(receivedMs)
    && Math.abs(receivedMs - sensorMs) <= 5 * 60_000;
  const timestampVerified = Number.isFinite(sensorMs) && deep?.crc_ok === true;
  const clockVerified = ctx.clockVerified === true
    || (timestampVerified && liveClockReference);
  return {
    sensor_ts: Number.isFinite(sensorSeconds) ? parsedUnix : null,
    received_at: ctx.receivedAt || null,
    timestamp_verified: timestampVerified,
    clock_verified: clockVerified,
    clock_provenance: {
      timestamp_source: 'strap_rtc_frame_header',
      frame_crc_verified: deep?.crc_ok === true,
      reference_source: ctx.clockVerified === true
        ? 'caller_verified_clock_mapping'
        : (liveClockReference ? 'live_receive_time_within_5m' : null),
      reference_at: Number.isFinite(receivedMs) ? new Date(receivedMs).toISOString() : null,
      corrected: false,
    },
  };
}

function finishRecord(record, layout, kind) {
  const frameHash = record.envelope.frame_hash;
  record.identity = {
    source_frame_hash: frameHash,
    decoder_version: DECODER_VERSION,
    layout,
    kind,
    derived_id: ppgDerivedIdentity({
      frameHash, decoderVersion: DECODER_VERSION, layout, kind,
    }),
  };
  return record;
}

/**
 * One verified frame → a PPG raw record, or null when the frame has no
 * proven optical waveform. v20 is intentionally skipped.
 */
export function ppgRecordFromFrame(frame, family, ctx = {}) {
  if (!frame || frame.length < 12) return null;
  const buf = frame instanceof Uint8Array ? frame : Array.from(frame);
  const packetType = family === 'puffin' ? buf[8] : buf[4];

  if (packetType === 47 && family === 'puffin') {
    const deep = decodeFrame(buf, family, { frameHash: ctx.frameHash });
    const p = deep?.decoded?.parsed;
    if (deep?.decoded?.hist_version !== 26) return null;
    const rec = p?.ppg_window_reconstruction || null;
    const deltas = Array.isArray(p.optical_deltas) ? p.optical_deltas.slice() : [];
    const samples = rec?.samples || p?.ppg_waveform;
    if (!Array.isArray(samples) && !deltas.length) return null;
    const waveform = Array.isArray(samples) ? samples : [];
    const trusted = rec?.trusted_samples
      || waveform.slice(0, rec?.trusted_sample_count || 0);
    const rate = finite(p.ppg_sample_rate_hz);
    const rateSupported = V26_SUPPORTED_RATES_HZ.includes(rate);
    const firstInvalid = rec?.first_sample_invalid === true
      || p.first_sample_adc_in_range === false
      || p.first_sample_adc == null;
    const reconstructionAmbiguous = Boolean(rec?.has_saturated_delta)
      || Boolean(rec?.divergence_proven)
      || firstInvalid;
    const durationSec = rateSupported ? waveform.length / rate : null;
    const record = {
      schema: PPG_ARCHIVE_SCHEMA,
      kind: 'hist_v26',
      family,
      layout: 'v26',
      ...clockFields(p.unix ?? p.timestamp, ctx, deep),
      subsec: p.subsec_q15 ?? p.subsec ?? null,
      subsec_seconds: finite(p.subsec_seconds),
      pip_state_counter: p.pip_state_counter ?? null,
      first_sample_adc: p.first_sample_adc ?? null,
      optical_deltas: deltas,
      sample_rate_hz: rate,
      sample_rate_provenance: rate != null
        ? 'v26_header_flags_bit7'
        : 'flags_missing',
      sample_rate_supported: rateSupported,
      duration_sec: durationSec,
      samples: waveform,
      trusted_samples: trusted,
      trusted_sample_count: trusted.length,
      has_saturated_delta: Boolean(rec?.has_saturated_delta),
      divergence_proven: Boolean(rec?.divergence_proven),
      first_ambiguous_sample_index: rec?.first_ambiguous_sample_index ?? (firstInvalid ? 0 : null),
      reconstruction_ambiguous: reconstructionAmbiguous,
      first_sample_invalid: firstInvalid,
      canonical_stage_input: rateSupported && !firstInvalid && !rec?.divergence_proven
        && !reconstructionAmbiguous && trusted.length >= 1,
      firmware: { fw: ctx.fw || null, model: ctx.model || null },
      transport: { char: ctx.char || null, seq: ctx.seq ?? null },
      decoder: { version: DECODER_VERSION, lineage: DECODER_LINEAGE },
      envelope: envelope(buf, packetType, ctx, deep),
    };
    return finishRecord(record, 'v26', 'hist_v26');
  }

  if (packetType === 43 && family !== 'puffin') {
    // WHOOP 4 type-43 optical 1921 only. Puffin type-43 optical is unproven.
    const deep = decodeFrame(buf, family, { frameHash: ctx.frameHash });
    const d = deep?.decoded;
    if (d?.kind !== 'optical' || d?.variant !== '1921' || !Array.isArray(d.optical_ac)) return null;
    if (d.optical_ac.length < 8) return null;
    const record = {
      schema: PPG_ARCHIVE_SCHEMA,
      kind: 'rt43_optical_whoop4',
      family,
      layout: 'whoop4-1921',
      ...clockFields(d.timestamp, ctx, deep),
      subsec: null,
      sample_rate_hz: finite(d.sample_rate_hz) || 437,
      sample_rate_provenance: finite(d.sample_rate_hz) != null
        ? 'whoop4_1921_layout'
        : 'whoop4_1921_layout_default_437',
      samples: d.optical_ac,
      trusted_samples: d.optical_ac,
      trusted_sample_count: d.optical_ac.length,
      optical_deltas: null,
      first_sample_adc: d.optical_ac[0],
      has_saturated_delta: false,
      divergence_proven: false,
      reconstruction_ambiguous: false,
      first_ambiguous_sample_index: null,
      canonical_stage_input: true,
      firmware: { fw: ctx.fw || null, model: ctx.model || null },
      transport: { char: ctx.char || null, seq: ctx.seq ?? null },
      decoder: { version: DECODER_VERSION, lineage: DECODER_LINEAGE },
      envelope: envelope(buf, packetType, ctx, deep),
    };
    return finishRecord(record, 'whoop4-1921', 'rt43_optical_whoop4');
  }

  return null;
}

export function encodePpgArchive(records) {
  const rows = dedupePpgRecords((records || []).filter((r) => r && r.schema === PPG_ARCHIVE_SCHEMA));
  const ndjson = `${rows.map((r) => JSON.stringify(r)).join('\n')}${rows.length ? '\n' : ''}`;
  const body = gzipSync(Buffer.from(ndjson, 'utf8'));
  return {
    body,
    sample_count: rows.length,
    compressed_bytes: body.length,
    format: PPG_ARCHIVE_FORMAT,
    compression: 'gzip',
    content_type: 'application/x-ndjson',
    schema_version: PPG_ARCHIVE_SCHEMA_VERSION,
    stream: PPG_ARCHIVE_STREAM,
    rows,
  };
}

export function decodePpgArchive(body) {
  if (!body) return [];
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  let text;
  try {
    text = gunzipSync(raw).toString('utf8');
  } catch {
    text = raw.toString('utf8');
  }
  const trimmed = text.trim();
  if (!trimmed) return [];
  const lines = trimmed.startsWith('[')
    ? JSON.parse(trimmed)
    : trimmed.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const rows = Array.isArray(lines) ? lines : [];
  return rows.filter((r) => r && r.schema === PPG_ARCHIVE_SCHEMA && Array.isArray(r.samples));
}
