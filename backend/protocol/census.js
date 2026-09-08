// protocol/census.js — FRWHOOP corpus census aggregation.
//
// A census is a per-axis breakdown of a decoded Level B corpus. It reuses the
// exact Level B records that redecode/replayNotifies() emits (the same records
// the redecode pipeline writes to the B2 `frames` stream) and aggregates:
//
//   - frames / classified / crc_ok / crc_failed counts
//   - byte-coverage sums from the decoder's coverage summaries
//     (decoded.parsed.coverage, built by protocol/coverage.js buildCoverage():
//     payload_bytes_structurally_mapped = decoded_bytes + raw_kept_bytes,
//     unknown_bytes, by_class per decoder output)
//   - semantically-validated field counts (decoded fields minus gate-failed:
//     the gen5 decoders emit a field as null when its validator rejects the
//     value, so a non-null non-empty value means the field passed; alias and
//     accounting keys are excluded so each canonical field is counted once)
//   - unknown byte spans (maximal unknown runs per decoder output, top 20 by
//     length with occurrence counts)
//   - decode_status histogram + warnings histogram (top 20)
//
// The aggregation is pure: censusFromLevelB(levelBRecords) takes the same
// records the CLI produces and the tests synthesize. No network, no I/O.
//
// Read-only by design. This module never downloads and never uploads.

import { gunzipSync } from 'node:zlib';

export const CENSUS_VERSION = 'frwhoop-census/1';

// Accounting / metadata keys the deep decoders add on top of canonical fields.
const PARSED_META_KEYS = new Set([
  'decode_warnings', 'confidence', 'coverage', 'unknown_spans', 'lineage',
]);
// Legacy alias keys: same canonical field re-exposed under NOOP-era names.
// Excluded so a canonical field is counted exactly once.
const LEGACY_ALIAS_KEYS = new Set([
  'layout_marker', 'rr_intervals', 'gravity_x', 'gravity_y', 'gravity_z',
  'gravity_mag', 'ppg_waveform', 'ppg_sample_count', 'sensor_channel_samples',
  'channel_b0_0', 'channel_b0_1', 'channel_b1_0', 'channel_b1_1',
  'channel_b2_0', 'channel_b2_1', 'channel_b3_0', 'channel_b3_1',
  'channel_b4_0', 'channel_b4_1',
  'spo2_raw_byte', 'spo2_candidate_pct', 'spo2_state',
]);
// Top-level keys of non-historical decoded records that are status/accounting,
// not semantic fields.
const TOP_META_KEYS = new Set(['decode_status', 'confidence', 'coverage', 'warnings']);

const CLASSIFIED_STATUSES = new Set(['decoded', 'partial', 'classified']);
const HISTORICAL_PACKET_TYPES = new Set([47, 52]);

export const CENSUS_AXES = Object.freeze([
  'model', 'firmware', 'service_family', 'characteristic', 'packet_type',
  'hist_version', 'body_tag', 'frame_length',
]);

function isMeaningful(v) {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/**
 * Count fields of one decoder output that passed their validators.
 *
 * Deep historical records carry `decoded.parsed` (canonical fields + legacy
 * aliases + coverage). Non-historical records (type 40/43/48/49/...) carry the
 * decoded fields directly on `decoded`. A field that failed its validator is
 * emitted as null / empty by the gen5 decoders, so it is not counted. Boolean
 * false, 0 and non-empty arrays/objects count as validated values.
 */
export function validatedFieldCount(decoded) {
  if (!decoded || typeof decoded !== 'object') return 0;
  const source = decoded.parsed && typeof decoded.parsed === 'object'
    ? decoded.parsed : decoded;
  let n = 0;
  for (const [k, v] of Object.entries(source)) {
    if (PARSED_META_KEYS.has(k)) continue;
    if (LEGACY_ALIAS_KEYS.has(k)) continue;
    if (source === decoded && TOP_META_KEYS.has(k)) continue;
    if (isMeaningful(v)) n += 1;
  }
  return n;
}

/** Pull the coverage summary off a decoder output (may be null).
 *
 * Two shapes exist in the wild:
 *   - decoded.parsed.coverage  — buildCoverage() SUMMARY object directly
 *     (whoop5.js baseView: p.coverage = r.coverage?.summary), and
 *   - decoded.coverage         — the full buildCoverage() result
 *     {summary, bitmap, unknown, warnings, ...} (decoder.js REALTIME_DATA).
 * Both are normalized to the summary object, which carries the mission keys:
 * total_bytes, decoded_bytes, raw_kept_bytes, unknown_bytes,
 * payload_bytes_structurally_mapped, mapped_pct, unknown_pct, fully_accounted.
 */
export function coverageOf(decoded) {
  if (!decoded || typeof decoded !== 'object') return null;
  const fromParsed = decoded.parsed && typeof decoded.parsed === 'object'
    ? decoded.parsed.coverage : null;
  const cov = fromParsed || decoded.coverage || null;
  if (!cov || typeof cov !== 'object') return null;
  return cov.summary && typeof cov.summary === 'object' ? cov.summary : cov;
}

/** Pull warnings off a decoder output (array of strings, may be empty). */
export function warningsOf(decoded) {
  if (!decoded || typeof decoded !== 'object') return [];
  const out = [];
  if (Array.isArray(decoded.parsed?.decode_warnings)) out.push(...decoded.parsed.decode_warnings);
  if (Array.isArray(decoded.warnings)) out.push(...decoded.warnings);
  return out;
}

/** Maximal unknown byte runs from a decoder output (may be empty).
 *
 * Historical records carry them on decoded.parsed.unknown_spans; REALTIME_DATA
 * carries the full buildCoverage result (with .unknown runs) on
 * decoded.coverage. Both are read so no decoder output loses its spans.
 */
export function unknownSpansOf(decoded) {
  if (!decoded || typeof decoded !== 'object') return [];
  const parsed = decoded.parsed;
  if (parsed && Array.isArray(parsed.unknown_spans)) return parsed.unknown_spans;
  if (decoded.coverage && Array.isArray(decoded.coverage.unknown)) return decoded.coverage.unknown;
  return [];
}

/** Hist-version axis key for a Level B record. */
export function histVersionOf(rec) {
  const decoded = rec?.decoded;
  if (decoded && decoded.hist_version != null) return String(decoded.hist_version);
  if (HISTORICAL_PACKET_TYPES.has(rec?.packet_type)) {
    return rec.version == null ? 'null' : String(rec.version);
  }
  return 'n/a';
}

/** Body-tag axis key: v22 tag or p54 record kind; 'none' otherwise. */
export function bodyTagOf(rec) {
  const parsed = rec?.decoded?.parsed;
  if (rec?.packet_type === 54) {
    const kind = parsed?.records?.[0]?.kind;
    return kind == null ? 'p54:no_records' : `p54:kind_${kind}`;
  }
  if (parsed && parsed.tag != null) return `v22:tag_${parsed.tag}`;
  return 'none';
}

// ---------------------------------------------------------------------------
// Aggregation core
// ---------------------------------------------------------------------------

function emptyGroup() {
  return {
    frames: 0,
    classified: 0,
    crc_ok: 0,
    crc_failed: 0,
    payload_bytes_structurally_mapped: 0,
    unknown_bytes: 0,
    decoded_bytes: 0,
    raw_kept_bytes: 0,
    fields_validated: 0,
    records_with_coverage: 0,
    decode_status: {},
  };
}

function statsOf(rec) {
  const decoded = rec?.decoded ?? null;
  const cov = coverageOf(decoded);
  const status = rec.decode_status ?? 'unknown';
  return {
    classified: CLASSIFIED_STATUSES.has(status),
    crc_ok: rec.crc_ok === true,
    crc_failed: rec.crc_ok === false,
    mapped: cov ? (cov.payload_bytes_structurally_mapped ?? 0) : 0,
    unknownBytes: cov ? (cov.unknown_bytes ?? 0) : 0,
    decodedBytes: cov ? (cov.decoded_bytes ?? 0) : 0,
    rawBytes: cov ? (cov.raw_kept_bytes ?? 0) : 0,
    hasCoverage: cov != null,
    fields: validatedFieldCount(decoded),
    status,
  };
}

function accumulate(group, s) {
  group.frames += 1;
  if (s.classified) group.classified += 1;
  if (s.crc_ok) group.crc_ok += 1;
  if (s.crc_failed) group.crc_failed += 1;
  group.payload_bytes_structurally_mapped += s.mapped;
  group.unknown_bytes += s.unknownBytes;
  group.decoded_bytes += s.decodedBytes;
  group.raw_kept_bytes += s.rawBytes;
  group.fields_validated += s.fields;
  if (s.hasCoverage) group.records_with_coverage += 1;
  group.decode_status[s.status] = (group.decode_status[s.status] || 0) + 1;
}

function groupKeyOf(rec, axis) {
  switch (axis) {
    case 'model': return rec._meta?.model != null ? String(rec._meta.model) : 'unknown';
    case 'firmware': return rec._meta?.fw != null ? String(rec._meta.fw) : 'unknown';
    case 'service_family': return rec.family != null ? String(rec.family) : 'unknown';
    case 'characteristic': return rec.char != null ? String(rec.char) : 'null';
    case 'packet_type': return rec.packet_type != null ? String(rec.packet_type) : 'null';
    case 'hist_version': return histVersionOf(rec);
    case 'body_tag': return bodyTagOf(rec);
    case 'frame_length': return rec.frame_length != null ? String(rec.frame_length) : 'null';
    default: return 'unknown';
  }
}

function finalizeGroupMap(map, { numeric = false } = {}) {
  const out = {};
  const entries = [...map.entries()];
  if (numeric) {
    entries.sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0));
  } else {
    entries.sort((a, b) => b[1].frames - a[1].frames || String(a[0]).localeCompare(String(b[0])));
  }
  for (const [key, g] of entries) out[key] = g;
  return out;
}

/**
 * Build the corpus census over an array of Level B records.
 *
 * @param {Array} levelBRecords  records as emitted by replayNotifies()
 *   (fields used: family, char, frame_length, packet_type, version, crc_ok,
 *   decode_status, decoded, and the optional `_meta: {model, fw, user, device}`
 *   attached by the CLI so model/firmware axes are populated).
 * @returns census object (see README comment at the top of this file).
 */
export function censusFromLevelB(levelBRecords) {
  const totals = emptyGroup();
  const axisMaps = Object.fromEntries(CENSUS_AXES.map((a) => [a, new Map()]));
  const decodeStatusHistogram = {};
  const warningsMap = new Map();
  const spanMap = new Map();

  for (const rec of levelBRecords || []) {
    const s = statsOf(rec);
    accumulate(totals, s);
    for (const axis of CENSUS_AXES) {
      const key = groupKeyOf(rec, axis);
      if (!axisMaps[axis].has(key)) axisMaps[axis].set(key, emptyGroup());
      accumulate(axisMaps[axis].get(key), s);
    }
    decodeStatusHistogram[s.status] = (decodeStatusHistogram[s.status] || 0) + 1;
    for (const w of warningsOf(rec.decoded)) {
      warningsMap.set(w, (warningsMap.get(w) || 0) + 1);
    }
    for (const span of unknownSpansOf(rec.decoded)) {
      const from = Number.isInteger(span.from) ? span.from : 0;
      const to = Number.isInteger(span.to) ? span.to : 0;
      if (to <= from) continue;
      const key = `${from}:${to}`;
      const e = spanMap.get(key) || { from, to, len: to - from, count: 0, bytes: 0 };
      e.count += 1;
      e.bytes += to - from;
      spanMap.set(key, e);
    }
  }

  const groups = {};
  for (const axis of CENSUS_AXES) {
    groups[axis] = finalizeGroupMap(axisMaps[axis], { numeric: axis === 'frame_length' });
  }

  const distinctSpans = [...spanMap.values()]
    .sort((a, b) => b.len - a.len || b.count - a.count || a.from - b.from);
  const warningsHistogram = [...warningsMap.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, 20)
    .map(([warning, count]) => ({ warning, count }));

  return {
    census_version: CENSUS_VERSION,
    generated_at: new Date().toISOString(),
    totals,
    groups,
    unknown_spans: {
      distinct: distinctSpans.length,
      total_bytes: distinctSpans.reduce((acc, s) => acc + s.len, 0),
      total_occurrences: distinctSpans.reduce((acc, s) => acc + s.count, 0),
      top: distinctSpans.slice(0, 20),
    },
    decode_status_histogram: decodeStatusHistogram,
    warnings_histogram: warningsHistogram,
  };
}

// ---------------------------------------------------------------------------
// Level A helpers shared by the CLI and tests (read-only, no I/O)
// ---------------------------------------------------------------------------

/**
 * Parse a Level A archive object body: gzip NDJSON (one JSON row per line),
 * plain NDJSON, or a JSON array. Returns an array of row objects.
 */
export function parseArchiveRows(buf) {
  let text;
  try {
    text = gunzipSync(buf).toString('utf8');
  } catch {
    text = buf.toString('utf8');
  }
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    return Array.isArray(arr) ? arr : [];
  }
  return trimmed.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Keep only Level A rows whose payload is a WHOOP frame (0xAA SOF + declared
 * envelope). GATT service reads (battery/model/fw) and non-WHOOP vault blobs
 * contain 0xAA bytes too; feeding them to the shared reassembler interleaves
 * garbage into real frame streams, so the census applies the same framed-rows-
 * only filter as bin/redecode-b2-archive.mjs: hex starts with 'aa' and is at
 * least 16 characters (8 bytes) long.
 */
export function framedRowsOnly(rows) {
  return (rows || []).filter((row) => {
    const hex = typeof row?.hex === 'string' ? row.hex : '';
    return hex.length >= 16 && hex.startsWith('aa');
  });
}

/**
 * Build a lookup keyed by `char|seq|t` (the identity a Level B record carries
 * from the notify row in which its last fragment arrived) -> the row's
 * provenance {model, fw, user, device, key}. First row wins per key.
 */
export function buildRowMetaMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    const char = String(row.char ?? row.characteristic ?? '');
    const seq = row.seq ?? row.sequence ?? '';
    const t = row.t ?? '';
    const key = `${char}|${seq}|${t}`;
    if (map.has(key)) continue;
    map.set(key, {
      model: row.model ?? null,
      fw: row.fw ?? row.firmware ?? null,
      user: row._user ?? null,
      device: row._device ?? null,
      key: row._key ?? null,
    });
  }
  return map;
}

/**
 * Attach `_meta` provenance to every Level B record. Records whose completing
 * notify row is not found get an all-null `_meta` (model/firmware report as
 * 'unknown'), never a fabricated value.
 */
export function attachMetaToLevelB(levelB, metaMap) {
  for (const rec of levelB || []) {
    const key = `${rec.char ?? ''}|${rec.seq ?? ''}|${rec.t ?? ''}`;
    const meta = metaMap.get(key) || null;
    rec._meta = meta || { model: null, fw: null, user: null, device: null, key: null };
  }
  return levelB;
}
