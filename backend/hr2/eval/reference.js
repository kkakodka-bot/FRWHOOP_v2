/**
 * Ground-truth reference ingestion for the HR V2 evaluation harness.
 *
 * A reference session is produced by a Polar H10 chest strap (1 Hz RR /
 * beat-level recording) and is treated as the GROUND TRUTH against which the
 * WHOOP strap's HR estimates are compared. The Polar H10 is an accepted
 * practical reference for wrist-worn HR validation: 99.6% RR-interval signal
 * quality vs Holter ECG across rest→high-intensity activity (Gilgen-Ammann
 * 2019, Eur J Appl Physiol 119:1525), HRV effectively interchangeable with lab
 * ECG (Blalock 2026, Auton Neurosci 266:103447; Schaffarczyk 2022, Sensors
 * 22:6536), and moment-to-moment Pearson r>0.99 vs ECG (Chung 2026, Sensors
 * 26:855) — citations in _hr_v2_research/ppg_hr_accuracy_research.md §5.1.
 *
 * Scope contract (V2_DESIGN.md §2 "eval/ reference.js"):
 *   - Polar Flow exported CSV (timestamps + heart rate columns, tolerant header
 *     matching)
 *   - a simple JSON format { samples: [{ t, hr, rr_ms }] }
 *   - Polar-accessor-style RR txt (one RR per line, start-time parameter)
 *
 * All parsers are pure and deterministic: gaps are tolerated, duplicate
 * timestamps are deduplicated with a stable rule, and out-of-order rows are
 * sorted before output. No wall-clock reads, no new dependencies.
 */

// ---------------------------------------------------------------------------
// Version + format registry
// ---------------------------------------------------------------------------

export const REFERENCE_VERSION = 'frwhoop-hr2-reference-v1';
export const REFERENCE_FORMATS = Object.freeze({
  CSV: 'csv',
  JSON: 'json',
  RR_TXT: 'rr_txt',
});

const MS = 1000;

// ---------------------------------------------------------------------------
// Numeric / timestamp helpers (exported for reuse by other eval modules)
// ---------------------------------------------------------------------------

function numOr(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Fixed offset expressed as local-minus-UTC, in milliseconds.
 * Accepts 'UTC', '+02:00', '-05:30', 'UTC+2', a bare hours number, or null
 * (treated as UTC). Naive (zone-less) timestamps are interpreted as
 * `local = UTC + timeZone`, so an export recorded in a local wall clock can be
 * converted to an absolute epoch deterministically. Unsupported strings
 * resolve to UTC (documented in meta.warnings by the caller).
 */
export function fixedOffsetMs(timeZone) {
  if (timeZone == null || timeZone === '') return 0;
  const s = String(timeZone).trim();
  if (/^utc$/i.test(s)) return 0;
  const m = s.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (m) {
    const sign = m[1] === '-' ? -1 : 1;
    return sign * ((+m[2]) * 3600 + (+(m[3] || 0)) * 60) * MS;
  }
  const m2 = s.match(/^utc\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i);
  if (m2) {
    const sign = m2[1] === '-' ? -1 : 1;
    return sign * ((+m2[2]) * 3600 + (+(m2[3] || 0)) * 60) * MS;
  }
  const asNum = Number(s);
  if (Number.isFinite(asNum) && s !== '') return asNum * 3600 * MS;
  return 0;
}

/**
 * Parse one timestamp into absolute epoch milliseconds (deterministic).
 *  - numbers: >= 1e11 → epoch ms; 1e9..1e11 → epoch seconds ×1000.
 *  - ISO strings with an explicit zone (Z or +HH:MM) → Date.parse (absolute).
 *  - zone-less ISO strings (YYYY-MM-DD[ T]HH:MM:SS[.fff]) → interpreted as a
 *    wall-clock time in `timeZone` (default UTC); offset applied explicitly so
 *    the result never depends on the host's local timezone.
 *  - bare "HH:MM:SS" (no date part) → null here; callers that combine a date
 *    column handle that case.
 * Returns null for anything unparseable. Never throws.
 */
export function parseTimestamp(value, options = {}) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    const n = value;
    if (!Number.isFinite(n) || n === 0) return null;
    if (Math.abs(n) >= 1e11) return n; // epoch ms
    if (Math.abs(n) >= 1e9) return n * 1000; // epoch seconds
    return null;
  }
  const s = String(value).trim();
  if (!s) return null;
  // Bare wall-clock time with no date and no 4-digit year: let callers combine
  // a date column before calling here.
  if (/^\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return null;
  const withZone = /([zZ]|[+-]\d{2}:?\d{2})\s*$/i.test(s);
  const norm = s.replace(' ', 'T');
  if (withZone) {
    const ms = Date.parse(norm);
    return Number.isFinite(ms) ? ms : null;
  }
  const base = Date.parse(norm.endsWith('Z') ? norm : `${norm}Z`);
  if (!Number.isFinite(base)) {
    // Last-resort: allow Date.parse to try loose formats but never let the host
    // timezone leak in; only used when the string carries an explicit zone.
    if (withZone) {
      const ms = Date.parse(s);
      return Number.isFinite(ms) ? ms : null;
    }
    return null;
  }
  const off = fixedOffsetMs(options.timeZone);
  return base - off;
}

// ---------------------------------------------------------------------------
// Sample normalization: sort, dedupe, drop junk. Deterministic.
// ---------------------------------------------------------------------------

/**
 * Normalize raw reference samples into the canonical sorted, deduplicated
 * `[{ t, hr, rr_ms }]` list. Rules (deterministic, order-independent):
 *  - rows without a finite `t` and without at least one of `hr`/`rr_ms` are
 *    dropped;
 *  - rows are sorted by ascending `t`;
 *  - equal timestamps collapse: the first occurrence's value wins, but an
 *    `rr_ms` seen on a later duplicate attaches to the survivor (merges the
 *    richest observation rather than dropping information).
 */
export function normalizeReferenceSamples(raw) {
  const rows = (Array.isArray(raw) ? raw : [])
    .map((r, i) => ({
      t: r && numOr(r.tMs ?? r.t ?? r.unix_ms),
      hr: r && numOr(r.hr ?? r.bpm),
      rr: r && numOr(r.rr_ms ?? r.rr),
      _i: i,
    }))
    .filter((r) => r.t != null && (r.hr != null || r.rr != null));
  rows.sort((a, b) => a.t - b.t || a._i - b._i);
  const seen = new Map(); // t -> index into out
  const out = [];
  for (const r of rows) {
    const j = seen.get(r.t);
    if (j === undefined) {
      seen.set(r.t, out.length);
      out.push({ t: r.t, hr: r.hr, rr_ms: r.rr });
    } else if (out[j].rr_ms == null && r.rr != null) {
      out[j].rr_ms = r.rr;
      out[j].hr = out[j].hr ?? r.hr;
    } else if (out[j].hr == null && r.hr != null) {
      out[j].hr = r.hr;
    }
  }
  return out.map((r) => {
    const o = { t: r.t };
    if (r.hr != null) o.hr = r.hr;
    if (r.rr_ms != null) o.rr_ms = r.rr_ms;
    return o;
  });
}

// ---------------------------------------------------------------------------
// CSV: split + column detection + row timestamp assembly
// ---------------------------------------------------------------------------

/** Split one CSV line respecting double-quoted fields ("" escapes inside).
 *  Dependency-free equivalent of a minimal RFC-4180 reader. */
export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const TIME_NAME = /^(time|local\s*time|clock|timestamp|start\s*time|session\s*time|datetime|date\s*time|time\s*\(.+\))$/i;
const DATE_NAME = /^(date|day|local\s*date|date\s*\(.+\))$/i;
const HR_NAME = /^(hr|heart\s*rate|heartrate|bpm|pulse|heart\s*rate\s*\(\s*bpm\s*\)|hr\s*\(\s*bpm\s*\)|value)$/i;
const RR_NAME = /^(rr|rr\s*interval|r-r|rr\s*\(\s*ms\s*\)|r-r\s*interval|rr\s*interval\s*\(\s*ms\s*\)|interval\s*\(\s*ms\s*\))$/i;

/** Convert a date-only cell (YYYY-MM-DD, YYYY/MM/DD, DD.MM.YYYY, M/D/YYYY)
 *  into an ISO date string, or null. Determinstic, no Intl. */
export function dateOnlyToIso(cell) {
  const s = String(cell).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  return null;
}

/** Build an epoch-ms timestamp from a data row, combining a time column with a
 *  date column (or options.date) when the time cell is bare HH:MM:SS. */
function buildRowTimestamp(cells, cols, options) {
  const tRaw = cols.time != null ? String(cells[cols.time] ?? '').trim() : '';
  if (!tRaw) return null;
  const direct = parseTimestamp(tRaw, options);
  if (direct != null) return direct;
  const m = tRaw.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!m) return null;
  let day = null;
  if (cols.date != null && cols.date >= 0 && cells[cols.date] != null) {
    day = dateOnlyToIso(cells[cols.date]);
  }
  if (!day && options.date) day = dateOnlyToIso(options.date);
  if (!day) return null;
  const hh = +m[1]; if (hh > 23) return null;
  const frac = m[4] ? `.${m[4]}` : '';
  const iso = `${day}T${pad2(hh)}:${pad2(+m[2])}:${pad2(+(m[3] || 0))}${frac}`;
  return parseTimestamp(iso, options);
}

/**
 * Parse a Polar Flow (or Flow-compatible) session CSV export.
 * Header-finding is tolerant: the first row (within the first 25 non-empty)
 * that contains one time-named column AND one heart-rate-named column becomes
 * the header; anything above it (session metadata lines, quoted preamble) is
 * skipped. Also recognises a separate date column and an RR-interval column.
 * Returns { samples, meta, warnings }; never throws.
 */
export function parsePolarCsv(text, options = {}) {
  const warnings = [];
  const lines = String(text).split(/\r?\n/);
  let headerIdx = -1;
  let cols = null;
  // Header scan horizon (25 rows) is ENGINEERING-DEFAULT: Polar exports put
  // column headers in the first lines; skipping further risks matching a data
  // row. Column-name patterns below are the tolerant-matching contract
  // (design §2 eval/reference.js) — case-insensitive, precedence-ordered.
  for (let i = 0; i < Math.min(lines.length, 25); i += 1) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length < 2) continue;
    const tI = cells.findIndex((c) => TIME_NAME.test(String(c).trim()));
    const dI = cells.findIndex((c) => DATE_NAME.test(String(c).trim()));
    const hI = cells.findIndex((c) => HR_NAME.test(String(c).trim()));
    if (tI !== -1 && hI !== -1 && tI !== hI) {
      headerIdx = i;
      cols = {
        time: tI,
        date: dI === hI || dI === tI ? -1 : dI,
        hr: hI,
        rr: cells.findIndex((c) => RR_NAME.test(String(c).trim())),
      };
      break;
    }
  }
  if (headerIdx === -1) {
    return { samples: [], meta: { headerRow: null }, warnings: ['no_header_row_found'] };
  }
  const samples = [];
  let skippedTimeOnly = 0;
  let skippedNoSignal = 0;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length < 2) continue;
    const ts = buildRowTimestamp(cells, cols, options);
    if (ts == null) { skippedTimeOnly += 1; continue; } // incl. time-only rows with no date
    const hr = cols.hr != null ? numOr(cells[cols.hr]) : null;
    const rr = cols.rr != null && cols.rr >= 0 ? numOr(cells[cols.rr]) : null;
    if (hr == null && rr == null) { skippedNoSignal += 1; continue; }
    samples.push({ t: ts, hr, rr_ms: rr });
  }
  const meta = {
    headerRow: headerIdx + 1,
    columns: { time: cols.time, date: cols.date, hr: cols.hr, rr: cols.rr },
    timezone_interpretation: options.timeZone ? String(options.timeZone) : 'UTC (naive timestamps assumed UTC)',
  };
  if (skippedTimeOnly || skippedNoSignal) {
    warnings.push(`skipped ${skippedTimeOnly} rows without a full timestamp, ${skippedNoSignal} rows without HR/RR`);
  }
  return { samples, meta, warnings };
}

// ---------------------------------------------------------------------------
// JSON format
// ---------------------------------------------------------------------------

/**
 * Parse the simple JSON reference format:
 *   { source?, startedAt?, meta?, samples: [{ t|tMs, hr|bpm, rr_ms? }] }
 * An array (list of samples alone) is also accepted. `t` may be an ISO string
 * or epoch ms/seconds (see parseTimestamp).
 */
export function parseReferenceJson(obj, options = {}) {
  const warnings = [];
  let samples = null;
  let jsonMeta = null;
  let sourceLabel = null;
  if (Array.isArray(obj)) samples = obj;
  else if (obj && Array.isArray(obj.samples)) {
    samples = obj.samples;
    jsonMeta = obj.meta ?? null;
    sourceLabel = obj.source ?? null;
  } else {
    return { samples: [], meta: {}, warnings: ['json_no_samples_array'] };
  }
  const out = [];
  for (const s of samples) {
    if (!s || typeof s !== 'object') continue;
    const t = parseTimestamp(s.t ?? s.tMs, options);
    const hr = numOr(s.hr ?? s.bpm);
    const rr = numOr(s.rr_ms ?? s.rr);
    if (t == null || (hr == null && rr == null)) continue;
    out.push({ t, hr, rr_ms: rr });
  }
  return {
    samples: out,
    meta: { json_meta: jsonMeta, source_label: sourceLabel,
      timezone_interpretation: options.timeZone ? String(options.timeZone) : 'UTC (naive timestamps assumed UTC)' },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// RR txt (Polar-accessor style)
// ---------------------------------------------------------------------------

function parseTimestampFromFileName(fileName) {
  if (!fileName) return null;
  const m = String(fileName).match(/(\d{4})[-_.](\d{2})[-_.](\d{2})[T_ ]?(\d{2})[-.:]?(\d{2})(?:[-.:]?(\d{2}))?/);
  if (!m) return null;
  const hh = +m[4]; const mm = +m[5]; const ss = m[6] ? +m[6] : 0;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
}

/**
 * Parse a Polar-accessor-style RR txt file: one RR interval per line (ms;
 * values < 200 are interpreted as seconds and scaled, with a warning). Start
 * time comes from (in priority order) options.startTime, a `# start: ...` /
 * `# startTime=...` comment line in the file, or a timestamp parsed from
 * options.fileName. Timestamps are cumulative from start: the i-th interval
 * ends at start + sum(first i intervals). A derived 1 Hz HR (60e3/rr_ms) is
 * attached so the RR-only stream can participate in HR-series alignment.
 * Returns { samples, meta, ok, reason, warnings }. `ok:false` with reason
 * 'rr_txt_missing_start' when no start time can be resolved.
 */
export function parseRrText(text, options = {}) {
  const warnings = [];
  const lines = String(text).split(/\r?\n/);
  const intervals = [];
  let startRaw = null;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      const m = t.match(/(?:start|startTime|start_time|starttime)\s*[:=]\s*(\S.*)$/i);
      if (!startRaw && m) startRaw = m[1].trim();
      continue;
    }
    if (t.startsWith('//')) continue;
    const v = Number(t.replace(/,/g, ''));
    if (!Number.isFinite(v) || v <= 0) continue;
    intervals.push(v);
  }
  let startMs = options.startTime != null ? parseTimestamp(options.startTime, options) : null;
  if (startMs == null && startRaw != null) startMs = parseTimestamp(startRaw, options);
  if (startMs == null && options.fileName != null) {
    const fts = parseTimestampFromFileName(options.fileName);
    if (fts != null) startMs = parseTimestamp(fts, options);
  }
  if (startMs == null) {
    return {
      samples: [], meta: {}, ok: false, reason: 'rr_txt_missing_start',
      warnings: [...warnings, 'no start time resolvable (options.startTime / `# start:` comment / filename)'],
    };
  }
  let scale = 1;
  const maxV = intervals.length ? Math.max(...intervals) : 0;
  // ENGINEERING-DEFAULT: RR values all < 200 are unambiguous seconds (RR in ms
  // is 300–1500), so scale to ms. Tuned for Polar-accessor exports; revisit if
  // a real 200–3000 ms exporter ever appears.
  if (maxV > 0 && maxV < 200) { scale = 1000; warnings.push('rr values < 200 interpreted as seconds'); }
  const samples = [];
  let acc = 0;
  for (const v of intervals) {
    const rr = v * scale;
    acc += rr;
    samples.push({ t: startMs + acc, rr_ms: rr, hr: 60000 / rr });
  }
  return {
    samples,
    meta: { startTimeMs: startMs, n_rr: intervals.length, scale_ms: scale, derived_hr_from_rr: true },
    ok: true,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Format detection + main entry point
// ---------------------------------------------------------------------------

/** Guess the input format. Objects/valid JSON → json; text with a comma line →
 *  csv; text with bare numeric lines → rr_txt; otherwise null. */
export function detectFormat(input, options = {}) {
  if (input && typeof input === 'object') return REFERENCE_FORMATS.JSON;
  const s = String(input ?? '').trimStart();
  if (!s) return null;
  if (s.startsWith('{') || s.startsWith('[')) return REFERENCE_FORMATS.JSON;
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => l.includes(','))) return REFERENCE_FORMATS.CSV;
  if (lines.length && lines.some((l) => /^[-+]?\d+(\.\d+)?$/.test(l))) return REFERENCE_FORMATS.RR_TXT;
  return null;
}

/**
 * Main entry point: parse any supported Polar H10 input into the canonical
 * reference model:
 *   {
 *     source: 'polar_h10',
 *     startedAt: epoch-ms of the first sample (or null),
 *     samples: [{ t, hr, rr_ms? }],          // sorted, deduplicated
 *     meta: { format, warnings[], n_raw, n_samples, ...format-specific },
 *     ok: boolean,
 *     reason?: string,
 *   }
 * Never throws for malformed data: unusable input yields { ok:false, reason }
 * and every skipped row is surfaced in meta.warnings.
 *
 * Options:
 *   format   'auto' (default) | 'csv' | 'json' | 'rr_txt'
 *   timeZone fixed offset for naive timestamps ('UTC', '+02:00', 'UTC+2', ...)
 *   date     session date to attach to time-only CSV rows (YYYY-MM-DD)
 *   startTime, fileName — used by the RR txt parser
 *   meta     extra fields merged into output meta
 */
export function parseReference(input, options = {}) {
  const warnings = [];
  const format = options.format && options.format !== 'auto' ? options.format : detectFormat(input, options);
  let samples = [];
  let fmeta = {};
  let fwarn = [];
  let ok = true;
  let reason = null;
  if (!format) {
    return {
      source: 'polar_h10', startedAt: null, samples: [],
      meta: { format: null, warnings: ['unrecognized_input'], n_raw: 0, n_samples: 0 },
      ok: false, reason: 'unrecognized_format',
    };
  }
  switch (format) {
    case REFERENCE_FORMATS.CSV: {
      const r = parsePolarCsv(input, options);
      samples = r.samples; fmeta = r.meta; fwarn = r.warnings;
      break;
    }
    case REFERENCE_FORMATS.JSON: {
      let obj = input;
      if (typeof input === 'string') { try { obj = JSON.parse(input); } catch { obj = null; } }
      const r = parseReferenceJson(obj, options);
      samples = r.samples; fmeta = r.meta; fwarn = r.warnings;
      if (obj == null) ok = false;
      break;
    }
    case REFERENCE_FORMATS.RR_TXT: {
      const r = parseRrText(input, options);
      samples = r.samples; fmeta = r.meta; fwarn = r.warnings;
      ok = r.ok !== false; reason = r.reason ?? null;
      break;
    }
    default:
      ok = false; reason = 'unrecognized_format';
  }
  const normalized = normalizeReferenceSamples(samples);
  const startedAt = normalized.length ? normalized[0].t : null;
  if (normalized.length === 0) ok = false;
  return {
    source: 'polar_h10',
    startedAt,
    samples: normalized,
    meta: {
      version: REFERENCE_VERSION,
      format,
      ...(options.meta ? options.meta : {}),
      ...fmeta,
      timezone_interpretation: fmeta.timezone_interpretation
        ?? (options.timeZone ? String(options.timeZone) : 'UTC (naive timestamps assumed UTC)'),
      n_raw: samples.length,
      n_samples: normalized.length,
      warnings: [...warnings, ...fwarn],
    },
    ok,
    ...(reason ? { reason } : {}),
  };
}
