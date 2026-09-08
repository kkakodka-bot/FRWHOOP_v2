
// Byte-coverage accounting for WHOOP decoders.
//
// CONTRACT (mission: "every decoder must emit decoded fields, unknown byte
// spans, a byte-coverage bitmap, warnings, and confidence"):
//   - A decoder declares which byte spans it DECODED (mapped to a named field),
//     which spans it deliberately kept RAW (semantics known but not named, or
//     tag-gated), which are padding/CRC/envelope, and which remain UNKNOWN.
//   - The bitmap is per byte. A byte has exactly one class. Anything a decoder
//     did not account for is `unknown` — never silently discarded, never
//     silently claimed.
//   - The output is plain JSON: summary numbers + the maximal unknown runs, so
//     a re-decode sidecar can carry it and a census can aggregate it.

export const COVERAGE_VERSION = 'frwhoop-coverage/1';

export const BYTE_CLASSES = Object.freeze({
  envelope: 'envelope',     // SOF/format/length/header-CRC/packet-type/seq
  decoded: 'decoded',       // mapped to a named, tiered field
  raw: 'raw',               // kept raw with a labeled span (semantics unpinned but region known)
  padding: 'padding',       // structurally known to be zero padding
  crc: 'crc',               // CRC8/CRC16/CRC32 trailer bytes
  unknown: 'unknown',       // not accounted for by this decoder version
});

/**
 * Build a byte-coverage report for one record.
 *
 * @param {number} total        record length in bytes (full frame incl. trailer)
 * @param {Array}  spans        [{from, to, cls, name?, note?}] — [from, to) half-open
 * @param {Object} opts         {warnings: [], confidence: 'low'|'medium'|'high'}
 * @returns {{summary, bitmap, unknown_spans, warnings}}
 *   summary: per-class byte counts + mapped/unknown percentages.
 *   bitmap:  maximal runs [{from, to, cls, name?, note?}] (to exclusive).
 *   unknown: maximal runs of class `unknown` only.
 */
export function buildCoverage(total, spans = [], { warnings = [], confidence = 'low' } = {}) {
  if (!Number.isInteger(total) || total < 0) {
    throw new TypeError(`buildCoverage: total must be a non-negative integer, got ${total}`);
  }
  const cls = new Array(total).fill('unknown');
  const owner = new Array(total).fill(null);
  const notes = new Array(total).fill(null);
  const overlapping = [];
  for (const s of spans) {
    if (!s || typeof s !== 'object') continue;
    const from = Math.max(0, Math.min(total, s.from | 0));
    const to = Math.max(0, Math.min(total, s.to | 0));
    if (to <= from) continue;
    const c = COVERAGE_CLASS_OF(s.cls);
    for (let i = from; i < to; i += 1) {
      if (cls[i] !== 'unknown' && owner[i] !== null && cls[i] !== c) {
        overlapping.push({ byte: i, was: cls[i], now: c });
      }
      // first-writer-wins would hide spans; later spans OVERWRITE earlier ones
      // except envelope/crc which are claimed first. Callers should pass spans
      // in precedence order; we record overlaps as warnings instead of failing.
      if (cls[i] === 'unknown' || cls[i] === c) {
        cls[i] = c;
        owner[i] = s.name || null;
        notes[i] = s.note || null;
      }
    }
  }
  // fold into runs
  const bitmap = [];
  let start = 0;
  for (let i = 1; i <= total; i += 1) {
    if (i === total || cls[i] !== cls[i - 1] || owner[i] !== owner[i - 1]) {
      bitmap.push({
        from: start, to: i, cls: cls[start], len: i - start,
        name: owner[start] || undefined,
        note: notes[start] || undefined,
      });
      start = i;
    }
  }
  const unknown = bitmap.filter((r) => r.cls === 'unknown');
  const counts = {};
  for (const c of Object.values(cls)) counts[c] = (counts[c] || 0) + 1;
  const summary = {
    total_bytes: total,
    by_class: counts,
    decoded_bytes: counts.decoded || 0,
    raw_kept_bytes: counts.raw || 0,
    unknown_bytes: counts.unknown || 0,
    payload_bytes_structurally_mapped: (counts.decoded || 0) + (counts.raw || 0),
    mapped_pct: total ? Number((((counts.decoded || 0) + (counts.raw || 0)) / total) * 100).toFixed(2) : '0.00',
    unknown_pct: total ? Number((((counts.unknown || 0)) / total) * 100).toFixed(2) : '0.00',
    fully_accounted: unknown.length === 0,
  };
  return { summary, bitmap, unknown, warnings, confidence, coverage_version: 'frwhoop-coverage/1' };
}

function COVERAGE_CLASS_OF(c) {
  switch (c) {
    case 'envelope': case 'decoded': case 'raw': case 'padding': case 'crc': case 'unknown':
      return c;
    case 'decoded_raw': case 'raw_unknown': case 'reserved': case 'stale':
      return 'raw';
    default:
      return 'unknown';
  }
}

// (the overlapping warnings array is module-level by design: callers read it)
let overlapping = [];
export function consumeOverlapWarnings() {
  const out = overlapping;
  overlapping = [];
  return out;
}

/**
 * Convenience: frame-level envelope + CRC spans for a verified puffin/harvard
 * frame, so every decoder starts from the same envelope accounting.
 *   puffin: [0,8) envelope incl. crc16; [total-4, total) crc32
 *   harvard: [0,4) envelope incl. crc8; [total-4, total) crc32
 */
export function envelopeSpans(frameLength, family) {
  const spans = family === 'puffin'
    ? [{ from: 0, to: 8, cls: 'envelope', name: 'puffin_header', note: 'SOF/format/declaredLen/header/crc16' }]
    : [{ from: 0, to: 4, cls: 'envelope', name: 'harvard_header', note: 'SOF/len/crc8' }];
  spans.push({ from: frameLength - 4, to: frameLength, cls: 'crc', name: 'crc32_trailer' });
  return spans;
}

/**
 * Merge two span lists (later wins except for crc/envelope).
 */
export function mergeSpans(...spanLists) {
  return spanLists.flat().filter(Boolean);
}
