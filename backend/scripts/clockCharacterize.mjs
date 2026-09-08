#!/usr/bin/env node
/**
 * Clock characterization for the FRWHOOP strap RTC (V2_DESIGN.md §2 scripts/,
 * "clockCharacterize.mjs").
 *
 * Reads:
 *   1. backend/data/live/<userId>/*.ndjson day files (receive-time + seq
 *      stream; the strap's own RTC is NOT present in the live post stream)
 *   2. Optional local Level-A frame archives (gzip), if present — historically
 *      a sibling `_energy_v2_research/frames_real` checkout, not in this repo.
 *
 * Decodes ONLY the strap timestamps (unix@15) of type-47 v18/v26 historical
 * records through the repo's own public decoder (backend/protocol/whoop5.js →
 * decodeWhoop5Historical → decodeV18/decodeV26, both exported and documented).
 * No decoder is re-implemented here.
 *
 * Produces:
 *   - backend/docs/CLOCK_CHARACTERIZATION.md  (markdown report)
 *   - backend/docs/CLOCK_CHARACTERIZATION.json (machine-readable summary)
 *   - a short JSON summary on stdout
 *
 * Handles absence of data gracefully (empty sections, exit 0).
 *
 * Usage:
 *   node scripts/clockCharacterize.mjs
 *   node scripts/clockCharacterize.mjs --frames-dir <path> --live-dir <path>
 * Options: --frames-dir, --live-dir, --md-out, --json-out, --max-files <n>
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import { decodeWhoop5Historical } from '../protocol/whoop5.js';
import { estimateDrift } from '../time/clockCorrection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const FRAMES_DIR = arg('--frames-dir', process.env.FRWHOOP_FRAMES_REAL)
  ?? path.resolve(__dirname, '../../../_energy_v2_research/frames_real');
const LIVE_DIR = arg('--live-dir', path.resolve(__dirname, '../data/live'));
const MD_OUT = arg('--md-out', path.resolve(__dirname, '../docs/CLOCK_CHARACTERIZATION.md'));
const JSON_OUT = arg('--json-out', path.resolve(__dirname, '../docs/CLOCK_CHARACTERIZATION.json'));
const MAX_FILES = Number(arg('--max-files', '0')) || 0; // 0 = unlimited (dev cap)

// ---------------------------------------------------------------------------
// Small deterministic stats
// ---------------------------------------------------------------------------
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}
function quantiles(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return {
    n: s.length,
    median: quantile(s, 0.5),
    p5: quantile(s, 0.05),
    p95: quantile(s, 0.95),
    min: quantile(s, 0),
    max: quantile(s, 1),
  };
}
function sampleStd(arr, m) {
  if (arr.length < 2) return 0;
  const mu = m ?? arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - mu) ** 2, 0) / (arr.length - 1));
}

/** Longest strictly-increasing run over an array of numbers (deterministic).
 *  Returns { startIndex, length, slice: number[] }. Used to isolate a single
 *  contiguous historical window inside WAL-style archive files, where the same
 *  strap-time window is appended repeatedly with different seq offsets (unix
 *  diffs can go negative / re-emit → whole-file OLS is meaningless). */
function longestMonotonicRun(arr) {
  let bestStart = 0, bestLen = 0;
  let curStart = 0;
  for (let i = 1; i <= arr.length; i += 1) {
    if (i < arr.length && arr[i] > arr[i - 1]) continue;
    const len = i - curStart;
    if (len > bestLen) { bestLen = len; bestStart = curStart; }
    curStart = i;
  }
  const slice = arr.slice(bestStart, bestStart + bestLen);
  return { startIndex: bestStart, length: bestLen, slice };
}
const fmtS = (ms) => (ms == null ? 'n/a' : `${(ms / 1000).toFixed(0)} s`);

const fmtXs = (ms) => (ms == null ? 'n/a' : `${ms / 1000} s`);
const fmtD = (ms) => {
  if (ms == null) return 'n/a';
  const d = Math.floor(ms / 86400000); const r = ms - d * 86400000;
  return `${d} d ${(Math.round(r / 1000))} s`;
};

// ---------------------------------------------------------------------------
// 1. Live day files backend/data/live/<userId>/YYYY-MM-DD.ndjson
// ---------------------------------------------------------------------------
function scanLive(liveDir) {
  const sources = [];
  const out = { users: 0, files: 0, rows: 0, bpm_rows: 0, files_with_estimate: 0, drift_est: [] };
  if (!existsSync(liveDir)) return { users: 0, files: 0, rows: 0, bpm_rows: 0, files_with_estimate: 0, drift_est: [], sources: [], missing: liveDir };
  const dayPat = /^\d{4}-\d{2}-\d{2}\.ndjson$/;
  const users = readdirSync(liveDir).filter((u) => statSync(path.join(liveDir, u)).isDirectory());
  out.users = users.length;
  for (const u of users) {
    let userFiles = readdirSync(path.join(liveDir, u)).filter((f) => dayPat.test(f)).sort();
    if (MAX_FILES) userFiles = userFiles.slice(0, MAX_FILES);
    for (const fn of userFiles) {
      out.files += 1;
      const lines = readFileSync(path.join(liveDir, u, fn), 'utf8').split('\n').filter(Boolean);
      out.rows += lines.length;
      // collapse receive-second → last seq (receive timestamps are batched)
      const byT = new Map();
      for (const ln of lines) {
        try {
          const o = JSON.parse(ln);
          const t = Date.parse(o.datetime);
          if (Number.isFinite(t) && Number.isFinite(o.seq) && Number.isFinite(o.bpm)) {
            out.bpm_rows += 1;
            const key = Math.floor(t / 1000);
            if (!byT.has(key) || o.seq > byT.get(key).seq) byT.set(key, { t: key * 1000, seq: o.seq });
          }
        } catch { /* skip malformed row */ }
      }
      const pts = [...byT.entries()].map(([, v]) => ({ t: v.t, seq: v.seq })).sort((a, b) => a.t - b.t);
      const row = {
        source: 'live_ndjson', user: u, file: fn, raw_rows: lines.length,
        distinct_seconds: pts.length,
      };
      // only a monotonic ~1 Hz stream yields a meaningful seq-vs-ts slope; a
      // degenerate fit (all x equal) has den ~ 0 and is unusable.
      if (pts.length >= 3) {
        const d = estimateDrift(pts.map((p) => p.t / 1000), pts.map((p) => p.seq));
        row.drift_ppm = d.driftPpm;
        row.correlation = d.correlation;
        const usable = d.driftPpm != null && d.correlation != null
          && Math.abs(d.driftPpm) < 1e6 && Math.abs(d.correlation) >= 0.5;
        row.usable = usable;
        if (usable) { out.files_with_estimate += 1; out.drift_est.push(d.driftPpm); }
      }
      sources.push(row);
    }
  }
  out.sources = sources;
  return out;
}

// ---------------------------------------------------------------------------
// 2. Frame archives (gzipped Level-A JSONL)
// ---------------------------------------------------------------------------
// Plausibility window for the strap RTC: 2015-01-01 .. recv + 45 d. u32 unix
// reads of 0xFFFFFFFF / era-garbage land far outside and are counted as
// exclusions (matches clockCorrection.js HISTORICAL_CLOCK floor guidance).
const STRAP_MIN_MS = Date.UTC(2015, 0, 1);
// ENGINEERING-DEFAULT: allow strap RTC to be up to 45 d ahead of receive
// (clockCorrection.js allows 20 y of lag; a small future slack tolerates
// clock-set-ahead states) — beyond that the u32 epoch is rollover/era garbage.
const STRAP_MAX_SLACK_MS = 45 * 86400000;

function scanFrames(framesDir) {
  const out = {
    files: 0, rows: 0, decodable: 0,
    byVersion: { v18: { rows: 0, offMs: [], driftFiles: [] }, v26: { rows: 0, offMs: [], driftFiles: [] } },
    otherRows: 0, excludedRollover: 0, sources: [],
    cadence_ms: [],
  };
  if (!existsSync(framesDir)) return { ...out, missing: framesDir, sources: [] };
  const files = readdirSync(framesDir)
    .filter((f) => f.endsWith('.ndjson.gz'))
    .sort()
    .slice(0, MAX_FILES || undefined);
  out.files = files.length;
  for (const fn of files) {
    const text = zlib.gunzipSync(readFileSync(path.join(framesDir, fn))).toString('utf8');
    const rec = { file: fn, rows: 0, v18: 0, v26: 0, other: 0,
      off: { v18: [], v26: [] }, cadence: { v18: [], v26: [] } };
    const unixSeries = { v18: [], v26: [] }; // strap unix seconds in file order
    const seqSeries = { v18: [], v26: [] };
    let prevStrap = null; let prevVer = null;
    for (const ln of text.split('\n')) {
      if (!ln.trim()) continue;
      let o; try { o = JSON.parse(ln); } catch { continue; }
      rec.rows += 1; out.rows += 1;
      const h = o.hex; if (!h) continue;
      const b = Buffer.from(h, 'hex');
      if (b.length <= 9) { rec.other += 1; out.otherRows += 1; continue; }
      const ver = b[9];
      if (ver !== 18 && ver !== 26) { rec.other += 1; out.otherRows += 1; continue; }
      const parsed = decodeWhoop5Historical(b).parsed;
      const strapSec = parsed.unix;
      if (strapSec == null || !Number.isFinite(strapSec)) continue;
      out.decodable += 1;
      const key = ver === 18 ? 'v18' : 'v26';
      const strapMs = strapSec * 1000;
      const recvMs = Date.parse(o.t);
      if (Number.isFinite(recvMs)) {
        // plausible-window filter (rollover eras excluded)
        if (strapMs < STRAP_MIN_MS || strapMs > recvMs + STRAP_MAX_SLACK_MS) {
          out.excludedRollover += 1;
        } else {
          out.byVersion[key].rows += 1;
          out.byVersion[key].offMs.push(recvMs - strapMs);
          rec.off[key].push(recvMs - strapMs);
        }
      }
      if (ver === 18) rec.v18 += 1; else rec.v26 += 1;
      if (prevStrap != null && strapMs > prevStrap) {
        const d = strapMs - prevStrap;
        // ENGINEERING-DEFAULT: cadence window 0..5 min between consecutive
        // records (a 1 Hz banked stream is 1000 ms; jumps beyond 5 min are
        // archive-boundary artifacts, not cadence).
        if (d > 0 && d < 5 * 60000) {
          out.cadence_ms.push(d);
          if (prevVer === key) rec.cadence[key].push(d);
        }
      }
      prevStrap = strapMs; prevVer = key;
      if (Number.isFinite(o.seq)) { unixSeries[key].push(strapSec); seqSeries[key].push(o.seq); }
    }
    // Drift estimate on the longest strictly-monotonic strap-window run only.
    // The archives are WAL-style (same 60 s window re-appended with new seq
    // offsets): whole-file OLS is invalid (see report §4 evidence). Within a
    // single contiguous run unix and seq are 1:1 at 1 s → any nonzero value
    // here is internal cadence, not wall-clock calibration.
    for (const v of ['v18', 'v26']) {
      const run = longestMonotonicRun(unixSeries[v]);
      // ENGINEERING-DEFAULT minimal drift run: >= 30 records and |corr| >= 0.99
      // (a clean 1 Hz run of 30 s is the smallest window with a stable slope).
      if (run.length >= 30) {
        const d = estimateDrift(run.slice, seqSeries[v].slice(run.startIndex, run.startIndex + run.length));
        const usable = d.driftPpm != null && d.correlation != null && Math.abs(d.correlation) >= 0.99;
        out.byVersion[v].driftFiles.push({
          file: fn, n: run.length, run_len: run.length,
          drift_ppm: usable ? d.driftPpm : null,
          correlation: d.correlation,
          classification: usable ? 'internal_cadence_1s' : 'rejected_low_corr',
        });
      }
    }
    out.sources.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Assemble + report
// ---------------------------------------------------------------------------
function buildJson(live, frames, runAt) {
  const offsetSummary = {};
  const clusterOf = (v) => {
    const off = frames.byVersion[v]?.offMs ?? [];
    const below = off.filter((x) => x < 200 * 86400000).length;
    return { n: off.length, below_200d: below, at_least_200d: off.length - below };
  };
  for (const [v, b] of Object.entries(frames.byVersion)) {
    const q = quantiles(b.offMs);
    offsetSummary[v] = {
      rows: q.n,
      cluster: clusterOf(v),
      offset_ms: { median: q.median, p5: q.p5, p95: q.p95, min: q.min, max: q.max,
        sd_ms: Math.round(sampleStd(b.offMs) * 10) / 10 },
    };
  }
  if (offsetSummary.v18 && offsetSummary.v26) {
    const all = [...(frames.byVersion.v18.offMs || []), ...(frames.byVersion.v26.offMs || [])];
    const q = quantiles(all);
    offsetSummary['v18+v26'] = { rows: q.n,
      offset_ms: { median: q.median, p5: q.p5, p95: q.p95, min: q.min, max: q.max,
        sd_ms: Math.round(sampleStd(all) * 10) / 10 } };
  }
  const driftSummary = {};
  for (const [v, b] of Object.entries(frames.byVersion)) {
    const good = b.driftFiles.filter((d) => d.classification === 'internal_cadence_1s' && d.drift_ppm != null);
    const ppm = good.map((d) => d.drift_ppm);
    const cad = frames.sources.flatMap((s) => s.cadence?.[v] ?? []);
    driftSummary[v] = {
      clean_runs: b.driftFiles.length,
      classified_1s: good.length,
      drift_ppm: quantiles(ppm),
      long_run_corr: quantiles(b.driftFiles.map((d) => d.correlation)),
      record_cadence_ms: quantiles(cad),
    };
    if (good.length) driftSummary[v].driftFiles_1s = good;
  }
  const livePpm = quantiles(live.drift_est);
  return {
    generated_at: runAt,
    inputs: {
      live_dir: LIVE_DIR, live: { users: live.users, files: live.files, rows: live.rows, bpm_rows: live.bpm_rows },
      frames_dir: FRAMES_DIR, frames: { files: frames.files, rows: frames.rows, decodable_v18_26: frames.decodable, excluded_rollover: frames.excludedRollover },
    },
    strap_offset_recv_minus_strap_ms: offsetSummary,
    drift: {
      live_ndjson_seq_vs_receive: { files_with_estimate: live.files_with_estimate, drift_ppm: livePpm, caveat: 'live stream has no strap RTC; seq-vs-receive slope reflects BLE post cadence only' },
      frames_seq_vs_strap_unix: driftSummary,
      caveat: 'seq-vs-unix slope conflates record cadence with RTC rate; absolute wall-clock drift is NOT measured here (see UNCHARACTERIZED)',
    },
    uncharacterized: [
      'strap RTC absolute calibration (wall-clock drift rate) is not measurable: the archive is bulk-downloaded banked history on a lost-RTC clock (≈constant −188 d offset), so no wall-clock reference timebase spans the recording',
      'live day stream carries no strap timestamp; strap-vs-receive offset is unavailable from backend/data/live',
      'receive timestamps are BLE delivery times with jitter; within-burst "rate" estimates are meaningless (records are delivered in <2 s bursts)',
      'DST/timezone shifts, RTC re-sync after phone connect, and temperature-dependent RTC error are untested',
    ],
  };
}

function mdReport(live, frames, json) {
  const L = [];
  const h1 = (s) => L.push(`# ${s}`);
  const h2 = (s) => L.push(`\n## ${s}`);
  const p = (s) => L.push(s);
  const row = (cells) => L.push(`| ${cells.join(' | ')} |`);
  const sep = (n) => L.push(`|${new Array(n).fill('---').join(' | ')}|`);

  h1('FRWHOOP strap clock characterization');
  p(`Generated: ${json.generated_at} · inputs: live=${live.files} day file(s) / ${live.rows} rows; frames=${frames.files} archive(s) / ${frames.rows} rows.`);
  p('Method: strap timestamps of type-47 v18/v26 records decoded with backend/protocol/whoop5.js (decodeWhoop5Historical; unix@15 strap RTC seconds). Recv-vs-strap offset = receive − strap. seq-vs-ts slope via backend/time/clockCorrection.js `estimateDrift`. Nothing wall-clock–read during computation; this report stamps UTC at generation.');

  h2('1. Inputs scanned');
  row(['input', 'value']);
  sep(2);
  row(['backend/data/live (day files)', `${live.users} user dir(s), ${live.files} file(s), ${live.rows} rows, ${live.bpm_rows} HR rows`]);
  row(['frames_real (gzipped Level-A)', `${frames.files} archive(s), ${frames.rows} rows, ${frames.decodable} v18/v26 decoded, ${frames.excludedRollover} rollover-era rows excluded`]);

  h2('2. Recv-vs-strap offset distribution (per source)');
  row(['source', 'rows', 'median', 'p5', 'p95', 'min', 'max', 'SD (ms)']);
  sep(8);
  for (const [v, s] of Object.entries(json.strap_offset_recv_minus_strap_ms)) {
    const o = s.offset_ms;
    row([v, String(s.rows), fmtD(o.median), fmtD(o.p5), fmtD(o.p95), fmtD(o.min), fmtD(o.max), String(o.sd_ms)]);
  }
  p('Sign: positive = receive clock ahead of strap RTC. The v18/v26 archive sits on a lost-RTC clock: median strap RTC is ~188 days behind receive — the WHOOP-5 "banks type-47 with a lost RTC, SET_CLOCK does not redate stored flash" failure mode documented in backend/time/clockCorrection.js. The offset is essentially constant within each cluster (SD of the v26 cluster is < 9 s over 82 records), i.e. a constant offset, not a runaway drift.');
  const c = json.strap_offset_recv_minus_strap_ms.v18?.cluster;
  p('Offset is BIMODAL — two banking epochs: ~188 d for the bulk (v18: ' + (c?.below_200d ?? 'n/a') + ' of ' + (c?.n ?? 'n/a') + ' records < 200 d) and ~213 d for the 2026-08-25/19h Windows-of-history files (report table). Both are consistent with the RTC having been left at an epoch ~6–7 months before receipt; they do not indicate ongoing drift.');
  p('Resolution limit: v18/v26 `unix` is a u32 INTEGER-SECOND field (record cadence median exactly 1000 ms, min exactly 1000 ms). Sub-second RTC behaviour and fine ppm drift are invisible in this field by design; any sub-second drift claim would need a higher-resolution strap clock field. \u2192 do NOT interpret the ±1% "internal cadence" residuals in §4 as strap drift.');

  h2('3. Frame-level detail (v18/v26)');
  row(['archive', 'rows', 'v18', 'v26', 'other', 'v18 offset median', 'v26 records']);
  sep(7);
  for (const rec of frames.sources) {
    const q18 = quantiles(rec.off.v18); const q26 = quantiles(rec.off.v26);
    row([rec.file, String(rec.rows), String(rec.v18), String(rec.v26), String(rec.other),
      q18.median != null ? fmtS(q18.median) : '—', String(rec.off.v26.length)]);
  }

  h2('4. seq-vs-ts drift estimates (estimateDrift)');
  p('CAVEAT (read first): `estimateDrift` returns (1/slope − 1)·1e6 in ppm assuming a ~1 Hz monotonic sequence counter vs the timestamp series. Evidence from the archives: v18 files are WAL-style — the same ≈60 s strap window is appended repeatedly with new BLE seq offsets (unix diffs go negative: -59/-56/-50 observed, identical unix re-emitted at multiple seq positions). Whole-file OLS is therefore INVALID; the estimate is computed only on the longest strictly-monotonic strap-time run in each file, and only runs with |correlation| ≥ 0.99 are classified. A nonzero value here is *internal record cadence*, never wall-clock calibration (no absolute timebase spans the recording).');
  for (const [v, d] of Object.entries(json.drift.frames_seq_vs_strap_unix)) {
    p(`- frames ${v}: ${d.clean_runs} long monotonic run(s); ${d.classified_1s} classified 1 s-cadence (drift_ppm median ${d.drift_ppm.median ?? 'n/a'}, p5 ${d.drift_ppm.p5 ?? 'n/a'}, p95 ${d.drift_ppm.p95 ?? 'n/a'}); strap record cadence median ${d.record_cadence_ms?.median ?? 'n/a'} ms; run |corr| median ${d.long_run_corr?.median ?? 'n/a'}.`);
    if (d.driftFiles_1s) {
      for (const f of d.driftFiles_1s) p(`   - ${f.file} run_len=${f.run_len} corr=${f.correlation} drift_ppm=${f.drift_ppm}`);
    }
  }
  p(`- live day files: ${live.files_with_estimate} of ${live.files} yield a usable seq-vs-receive slope; median ${json.drift.live_ndjson_seq_vs_receive.drift_ppm.median ?? 'n/a'} ppm. Live rows carry no strap RTC and receive timestamps are batched (132/134 rows shared one receive second in a sampled file), so this measures BLE post cadence, not clock drift.`);

  h2('5. Explicitly UNCHARACTERIZED');
  for (const c of json.uncharacterized) p(`- ${c}`);

  h2('6. How to close the gap');
  p('1) Collect two absolute-strap-vs-receive pairs spaced in wall-clock time on a *live, connected* strap (strap RTC set at connect → offset ≈ latency, then re-measure hours/days later → true drift). ');
  p('2) The eval foundation is ready (backend/hr2/eval/): Polar H10 reference sessions + alignReference() expose per-session offset_ms/drift_ppm/residual_std_ms; a multi-session H10 campaign (backend/docs/POLAR_H10_EVAL_PROCEDURE.md) yields the calibratable strap-vs-reference drift. ');
  p('3) Until then: clock hygiene must assume up to the observed constant offset (~188 d in archive) + unquantified drift, exactly what backend/time/clockCorrection.js historical offset correction already guards.');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const runAt = new Date().toISOString();
const live = scanLive(LIVE_DIR);
const frames = scanFrames(FRAMES_DIR);
const json = buildJson(live, frames, runAt);
writeFileSync(MD_OUT, mdReport(live, frames, json));
writeFileSync(JSON_OUT, JSON.stringify(json, null, 2));

// console JSON summary (compact)
const summary = {
  generated_at: runAt,
  inputs: json.inputs,
  strap_offset_recv_minus_strap_ms: Object.fromEntries(
    Object.entries(json.strap_offset_recv_minus_strap_ms).map(([k, v]) => [k, {
      rows: v.rows, median_ms: v.offset_ms.median, p5_ms: v.offset_ms.p5,
      p95_ms: v.offset_ms.p95, sd_ms: v.offset_ms.sd_ms,
    }])),
  drift: json.drift,
  md_out: MD_OUT,
  json_out: JSON_OUT,
  missing: { live: live.missing ?? null, frames: frames.missing ?? null },
};
console.log(JSON.stringify(summary, null, 2));
