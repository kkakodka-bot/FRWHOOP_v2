#!/usr/bin/env node
// Validation-only SpO2 report. Never writes canonical spo2_pct. Never sends 119/120.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFrame } from '../protocol/decoder.js';
import {
  annotateSpo2Identity,
  observationFromV18,
  reportsByDeviceFirmwareNight,
  summarizeSpo2Observations,
  detectMeasurementWindows,
  independentSpo2DeviceCount,
  deviceAliasRelations,
} from '../protocol/spo2.js';
import { importWhoopSpo2References, importPulseOx } from '../metrics/spo2Reference.js';
import {
  compareOfficialSpo2,
  chooseLagOnDiscovery,
  evaluatePulseOx,
  deviceCensus,
  finalEvidenceStatus,
} from '../metrics/spo2Validate.js';
import {
  describeValidityGate,
  scanOffsetSpecificity,
  wakeFalsification,
  incompleteNightFalsification,
  correlateWindowLogs,
  highFrequencyHypothesis,
  leaveOneNightValidity,
  leaveOneDeviceValidity,
  classifyConsoleLog,
  SPECIFICITY_OFFSETS,
} from '../protocol/spo2Validity.js';
import { planReadOnlyProbe, archiveProbeFromRecords, isProbeWriteBlocked } from '../protocol/spo2Probe.js';

const argv = process.argv.slice(2);
function flagValue(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  if (!next || next.startsWith('--')) return fallback;
  return next;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = flagValue('out', '/tmp/frwhoop-spo2');
const OBS = flagValue('observations', path.join(OUT, 'spo2-observations.ndjson'));
const WHOOP_JSON = flagValue('whoop-json', path.join(ROOT, 'frontend/src/data/day_wise_whoop_data.json'));
const WHOOP_CSV = flagValue('whoop-csv', null);
const PULSE = flagValue('pulse-ox', null);
const FRAMES = flagValue('frames', '/tmp/frwhoop-redecode/frames');
const PRIOR = flagValue('prior-report', path.join(OUT, 'spo2-report.json'));
const TZ = flagValue('tz', 'America/Los_Angeles');

function loadNdjson(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function loadReferences() {
  const found = [];
  if (WHOOP_CSV && existsSync(WHOOP_CSV)) {
    found.push(...importWhoopSpo2References(WHOOP_CSV, { source: 'csv' }));
  }
  if (existsSync(WHOOP_JSON)) {
    found.push(...importWhoopSpo2References(WHOOP_JSON, { source: 'imported' }));
  }
  return found;
}

function loadPulse() {
  if (!PULSE || !existsSync(PULSE)) return [];
  return importPulseOx(PULSE);
}

function loadPrior() {
  if (!existsSync(PRIOR)) return { logs: [], config: [], console: { hits: [] } };
  try {
    const j = JSON.parse(readFileSync(PRIOR, 'utf8'));
    return {
      logs: (j.console?.hits || []).map((h) => ({ unix: h.unix, log: h.log, hash: h.hash })),
      config: j.config_readbacks || [],
      console: j.console || { hits: [] },
    };
  } catch {
    return { logs: [], config: [], console: { hits: [] } };
  }
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const ent of ents) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else files.push(p);
    }
  }
  return files;
}

function parseFrameRows(file) {
  try {
    let buf = readFileSync(file);
    if (file.endsWith('.gz') || (buf[0] === 0x1f && buf[1] === 0x8b)) {
      buf = gunzipSync(buf);
    }
    const text = buf.toString('utf8');
    const trimmed = text.trim();
    if (!trimmed) return [];
    return trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function collectFromFrames(dir, { sampleLimit = 800, v18Limit = 4000 } = {}) {
  const files = listFiles(dir);
  const samples = [];
  const validityObs = [];
  const logs = [];
  const config = [];
  const readCmds = new Set([115, 116, 117, 118, 121, 128]);
  let v18Seen = 0;
  let asleepSeen = 0;
  let seed = 0xC0FFEE;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (const f of files) {
    for (const row of parseFrameRows(f)) {
      const hex = row.hex || row.frame_hex;
      if (typeof hex !== 'string' || hex.length < 24) continue;
      let bytes;
      try { bytes = Buffer.from(hex, 'hex'); } catch { continue; }
      if (bytes.length < 16 || bytes[0] !== 0xAA) continue;
      if (bytes[8] === 50) {
        try {
          const d = decodeFrame(bytes, 'puffin');
          const parsed = d.decoded?.parsed || {};
          if (parsed.log) logs.push({ unix: parsed.unix, log: parsed.log, hash: d.frame_hash });
        } catch { /* keep scanning */ }
      }
      if (bytes[8] === 36 && readCmds.has(bytes[10])) {
        try {
          const d = decodeFrame(bytes, 'puffin');
          const rb = d.decoded?.parsed?.config_read_back;
          if (rb) config.push({ decoded: { parsed: { config_read_back: rb } }, frame_hash: d.frame_hash, fw: row.fw, t: row.t });
        } catch { /* keep scanning */ }
      }
      if (bytes.length >= 93 && bytes[9] === 18) {
        const unix = bytes.readUInt32LE(11);
        const sample = { unix, sleep_state: (bytes[81] >> 4) & 3, bytes };
        v18Seen += 1;
        const asleep = ((bytes[81] >> 4) & 3) === 2;
        if (asleep) {
          asleepSeen += 1;
          if (samples.length < sampleLimit) samples.push(sample);
          else {
            const j = Math.floor(rnd() * asleepSeen);
            if (j < sampleLimit) samples[j] = sample;
          }
        }
        if (validityObs.length < v18Limit && (bytes[82] !== 0 || validityObs.length < 200)) {
          try {
            const parsed = decodeFrame(bytes, 'puffin').decoded?.parsed;
            const o = observationFromV18(parsed, {
              frameHash: row.frame_hash || null,
              deviceId: row.device_id,
              firmware: row.fw || row.firmware,
            });
            if (o) validityObs.push(annotateSpo2Identity(o));
          } catch { /* skip */ }
        }
      }
    }
  }
  return { samples, validityObs, logs, config, files: files.length };
}

function mdTable(headers, rows) {
  if (!rows.length) return '_none_\n';
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map((c) => (c == null ? '' : String(c))).join(' | ')} |`);
  return [head, sep, ...body].join('\n') + '\n';
}

function renderMarkdown(doc) {
  const c = doc.official?.cycles?.filter((r) => r.sufficient) || [];
  return `# FRWHOOP SpO₂ validation report

Status: **${doc.final_status}** (promotion: **PROMOTION_BLOCKED**; no PROMOTED state)

## A. Byte-decode evidence

- Frame offset 82 / inner 74 unchanged
- Candidate 70…100; sentinel high-bit; other nonzero diagnostic
- Canonical \`spo2_pct\` untouched

## B. Duty-cycle evidence

${mdTable(
    ['night', 'firmware', 'period_s', 'phase_s', 'windows', 'coverage_pct', 'classification'],
    (doc.duty_nights || []).map((n) => [
      n.frwhoop_physiological_day, n.firmware, n.median_period, n.phase, n.observed_windows,
      n.window_coverage_pct, n.classification,
    ]),
  )}

## C. Offset-specificity evidence

Offsets ${SPECIFICITY_OFFSETS[0]}…${SPECIFICITY_OFFSETS.at(-1)}. Floors: ≥5 distinct in-band, in-band SD ≥ 0.5.

${mdTable(
    ['offset', 'n', 'in_band', 'distinct', 'sd', 'sleep_only', 'duty', 'rejected'],
    (doc.specificity || []).map((r) => [
      r.offset, r.n, r.in_band_fraction?.toFixed?.(3), r.distinct_inband,
      r.inband_stdev?.toFixed?.(3), r.sleep_only_fraction?.toFixed?.(3),
      r.duty_classification, (r.rejected || []).join('; ') || (r.plausible ? 'plausible' : ''),
    ]),
  )}

## D. Official WHOOP-cycle agreement

- Reference source: ${doc.reference_source || 'none'}
- References imported: ${doc.n_references}
- Official SpO₂ present: ${doc.n_official_values}
- Matched scored cycles with candidate coverage: ${doc.n_cycles}
- Overlap: ${doc.overlap_note}

${mdTable(
    ['cycle_id', 'official', 'A', 'B', 'C', 'D', 'err_A'],
    c.map((r) => [
      r.cycle_id, r.official_spo2_pct, r.candidate_mean_window_means, r.candidate_median_window_means,
      r.candidate_median_seconds, r.candidate_mean_seconds, r.error_A,
    ]),
  )}

Stats (all matched): ${JSON.stringify(doc.official?.stats_all?.A || null)}

## E. Quality-gate findings

${JSON.stringify(doc.validity?.conditional || {}, null, 2)}

Classifier leave-one-night-out folds: ${(doc.classifier?.folds || []).length}
Leave-one-device-out: ${doc.classifier_device?.reason || 'n/a'}

## F. Console-log correlation

Nearby log events across ${doc.log_windows || 0} windows. Success/failure/HF classified from raw lines.

## G. Feature/config probe results

Read-only plan opcodes: ${(doc.probe?.planned_opcodes || []).join(', ')}
Blocked: 119, 120
Archived read-backs: ${(doc.probe?.archive || []).length}
Live strap probe: not run (no opcode sweep, no SET)

## H. External pulse-ox agreement

${doc.pulse_ox ? JSON.stringify(doc.pulse_ox, null, 2) : '_no pulse-ox file supplied_'}

## I. Independent-device replication

- confirmed_device_count: ${doc.census.confirmed_device_count}
- probable_device_count: ${doc.census.probable_device_count}
- unknown_device_count: ${doc.census.unknown_device_count}

Independent confirmed WHOOP devices = ${doc.census.confirmed_device_count}

## J. Contradictions / falsifications

${(doc.contradictions || []).map((x) => `- ${x}`).join('\n') || '_none recorded_'}

## K. Final status

**${doc.final_status}**

Promotion remains blocked. Canonical \`spo2_pct\` is unchanged.
`;
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const observations = loadNdjson(OBS).map((o) => annotateSpo2Identity(o));
  const references = loadReferences();
  const pulse = loadPulse();
  const prior = loadPrior();
  const framed = existsSync(FRAMES) ? collectFromFrames(FRAMES) : { samples: [], validityObs: [], logs: [], config: [], files: 0 };
  const logs = [...prior.logs, ...framed.logs];
  const nights = observations.length
    ? reportsByDeviceFirmwareNight(observations, { timeZone: TZ, by: 'user' })
    : [];
  const official = compareOfficialSpo2({ observations, references, timeZone: TZ });
  const census = deviceCensus(observations);
  const validitySource = observations.some((o) => o.optical_amp_a != null) ? observations : framed.validityObs;
  const validity = validitySource.length ? describeValidityGate(validitySource) : null;
  const wake = wakeFalsification(observations);
  const incomplete = incompleteNightFalsification(observations, references, { timeZone: TZ });
  const windows = detectMeasurementWindows(observations);
  const logCorr = correlateWindowLogs(windows, logs);
  const hf = highFrequencyHypothesis(observations, logs, { timeZone: TZ });
  const classifier = validitySource.length ? leaveOneNightValidity(validitySource, { timeZone: TZ }) : { folds: [] };
  const classifierDevice = leaveOneDeviceValidity(observations);
  const specificity = scanOffsetSpecificity(framed.samples);
  let pulseEval = null;
  if (pulse.length && windows.length) {
    const disc = chooseLagOnDiscovery(windows, pulse, { minSamples: 5 });
    const holdout = windows.slice(Math.ceil(windows.length * 0.6));
    pulseEval = {
      discovery_lag_s: disc.lag_s,
      holdout: evaluatePulseOx({ windows: holdout, pulseSamples: pulse, frozenLagS: disc.lag_s }),
      all_zero_lag: evaluatePulseOx({ windows, pulseSamples: pulse, frozenLagS: 0 }),
    };
  }
  const probePlan = planReadOnlyProbe('device_config');
  const archive = archiveProbeFromRecords([
    ...prior.config.map((c) => ({ decoded: { parsed: { config_read_back: c } } })),
    ...framed.config,
  ]);
  const logClasses = { spo2_success: 0, spo2_failure: 0, spo2_high_frequency_mode: 0, spo2_other: 0 };
  const logExamples = { spo2_success: [], spo2_failure: [], spo2_high_frequency_mode: [], spo2_other: [] };
  for (const log of logs) {
    const cls = classifyConsoleLog(log.log);
    if (!cls) continue;
    logClasses[cls] += 1;
    if (logExamples[cls].length < 5) logExamples[cls].push(String(log.log).slice(0, 240));
  }
  const contradictions = [];
  if (wake.awake_candidate_count) {
    contradictions.push(`wake falsification: ${wake.awake_candidate_count} candidate seconds outside asleep`);
  }
  const missingOfficialWithWindows = incomplete.filter((n) => n.missing_official);
  if (missingOfficialWithWindows.length) {
    contradictions.push(`${missingOfficialWithWindows.length} candidate nights have no official WHOOP SpO2`);
  }
  if (official.issues.some((i) => i.kind === 'overlapping_cycles')) {
    contradictions.push('overlapping WHOOP cycles for some observations');
  }
  if (!logClasses.spo2_success && !logClasses.spo2_failure) {
    contradictions.push('no Type-50 lines classified as spo2_success or spo2_failure in scanned archives');
  }
  let obsMin = null;
  let obsMax = null;
  for (const o of observations) {
    const t = o.sensor_timestamp;
    if (!Number.isFinite(t)) continue;
    if (obsMin == null || t < obsMin) obsMin = t;
    if (obsMax == null || t > obsMax) obsMax = t;
  }
  const obsSpan = obsMin == null ? null : { min: obsMin, max: obsMax };
  const refSpan = references.length
    ? { min: Math.min(...references.map((r) => r.cycle_start)), max: Math.max(...references.map((r) => r.cycle_end)) }
    : null;
  const overlapNote = (!obsSpan || !refSpan)
    ? 'missing observations or references'
    : (obsSpan.max < refSpan.min || obsSpan.min > refSpan.max
      ? `no timestamp overlap (observations ${new Date(obsSpan.min * 1000).toISOString()}…${new Date(obsSpan.max * 1000).toISOString()} vs references ${new Date(refSpan.min * 1000).toISOString()}…${new Date(refSpan.max * 1000).toISOString()})`
      : 'timestamp ranges intersect');
  const final_status = finalEvidenceStatus({
    confirmed_device_count: census.confirmed_device_count,
    n_cycles: official.n_cycles,
    pulse_ox_n: pulseEval?.holdout?.lagged?.n || 0,
    official_mae: official.stats_all?.A?.mae,
  });
  const summary = summarizeSpo2Observations(observations, { timeZone: TZ });
  const docsDir = path.join(ROOT, 'docs');
  const doc = {
    generated_at: new Date().toISOString(),
    decoder: 'frwhoop-spo2/1',
    spo2_pct: null,
    promotion: 'PROMOTION_BLOCKED',
    final_status,
    reference_source: existsSync(WHOOP_JSON) ? WHOOP_JSON : (WHOOP_CSV || null),
    n_references: references.length,
    n_official_values: references.filter((r) => r.official_spo2_pct != null).length,
    n_cycles: official.n_cycles,
    overlap_note: overlapNote,
    census,
    n_devices: census.n_devices,
    independent_confirmed_whoop_devices: independentSpo2DeviceCount(observations),
    alias_relations: deviceAliasRelations(observations),
    product_summary: {
      candidate_count: summary.candidate_count,
      mean_of_window_means: summary.mean,
      classification: summary.classification,
      spo2_pct: summary.spo2_pct,
    },
    duty_nights: nights.map((n) => ({
      frwhoop_physiological_day: n.night,
      firmware: n.firmware,
      source_device_id: n.source_device_id,
      physical_device_id: n.physical_device_id,
      median_period: n.median_period,
      phase: n.phase,
      observed_windows: n.observed_windows,
      valid_windows: n.valid_windows,
      window_coverage_pct: n.window_coverage_pct,
      classification: n.classification,
      candidate_count: n.candidate_count,
      sentinel_count: n.sentinel_count,
      diagnostic_count: n.diagnostic_count,
    })),
    official,
    validity,
    validity_source: observations.some((o) => o.optical_amp_a != null) ? 'observations' : 'frame_resample',
    classifier,
    classifier_device: classifierDevice,
    specificity,
    specificity_sample_n: framed.samples.length,
    frame_files_scanned: framed.files,
    type50_logs: logs.length,
    log_classes: logClasses,
    log_examples: logExamples,
    log_windows: logCorr.length,
    log_correlation: logCorr.slice(0, 40),
    high_frequency_hypothesis: hf,
    probe: {
      planned_opcodes: probePlan.planned_opcodes,
      blocked: probePlan.blocked,
      writes_blocked: isProbeWriteBlocked(119) && isProbeWriteBlocked(120),
      archive,
      live_probe: 'not_run',
    },
    pulse_ox: pulseEval,
    wake_falsification: wake,
    incomplete_nights: missingOfficialWithWindows.slice(0, 50),
    contradictions,
  };
  const json = JSON.stringify(doc, null, 2);
  const md = renderMarkdown(doc);
  writeFileSync(path.join(OUT, 'spo2-validation-report.json'), json);
  writeFileSync(path.join(OUT, 'spo2-validation-report.md'), md);
  if (existsSync(docsDir)) {
    writeFileSync(path.join(docsDir, 'spo2-validation-report.json'), json);
    writeFileSync(path.join(docsDir, 'spo2-validation-report.md'), md);
  }
  console.log(JSON.stringify({
    out: OUT,
    observations: observations.length,
    references: references.length,
    n_cycles: official.n_cycles,
    final_status,
    confirmed_devices: census.confirmed_device_count,
    type50_logs: logs.length,
    spo2_pct: null,
  }, null, 2));
}

main();
