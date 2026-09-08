#!/usr/bin/env node
// Replay existing Level A WHOOP frames and extract v18 @82 SpO₂ candidates.
// Idempotent on source_frame_hash. Never writes canonical spo2_pct.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { extractSpo2FromNotifies } from '../redecode/spo2.js';
import {
  correlateConsoleLogs, reportsByDeviceFirmwareNight, summarizeSpo2Observations,
  investigateSpo2Schedule, utcNightKey, deviceAliasRelations, independentSpo2DeviceCount,
} from '../protocol/spo2.js';
import { compareSpo2CandidateToWhoopCycles } from '../metrics/spo2WhoopCycle.js';
import { storageConfig } from '../storage/config.js';
import { createS3 } from '../storage/s3.js';

const argv = process.argv.slice(2);
function flagValue(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  if (!next || next.startsWith('--')) return fallback;
  return next;
}
function hasFlag(name) {
  return argv.includes(`--${name}`);
}

const IN = flagValue('in', '/tmp/frwhoop-redecode/frames');
const OUT = flagValue('out', '/tmp/frwhoop-spo2');
const FROM_B2 = hasFlag('from-b2');
const LIST = flagValue('b2-list', '/tmp/frwhoop-b2-list.json');
const TZ = flagValue('tz', 'UTC');
const APPLY = hasFlag('apply');
const CYCLES = flagValue('whoop-cycles', null);

function utcCandidateNights(observations) {
  const groups = new Map();
  for (const o of observations || []) {
    if (o.spo2_state !== 'candidate') continue;
    const night = utcNightKey(o.sensor_timestamp);
    if (!night) continue;
    const key = `${o.device_id || 'unknown'}|${o.firmware || 'unknown'}|${night}`;
    if (!groups.has(key)) {
      groups.set(key, {
        night,
        device_id: o.device_id || null,
        firmware: o.firmware || null,
        values: [],
      });
    }
    groups.get(key).values.push(o.spo2_candidate_pct);
  }
  return [...groups.values()].map((g) => ({
    night: g.night,
    device_id: g.device_id,
    firmware: g.firmware,
    candidate_count: g.values.length,
    mean: g.values.reduce((a, b) => a + b, 0) / g.values.length,
  })).sort((a, b) => a.night.localeCompare(b.night));
}

function parseRows(buf) {
  let text;
  try { text = gunzipSync(buf).toString('utf8'); } catch { text = buf.toString('utf8'); }
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    return Array.isArray(arr) ? arr : [];
  }
  return trimmed.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function idsOf(name) {
  const m = /users[_/]([0-9a-f-]{8,}).*?devices[_/]([0-9a-f-]{8,})/i.exec(name);
  return m ? { userId: m[1], deviceId: m[2] } : { userId: null, deviceId: null };
}

function collectFiles(input) {
  if (!existsSync(input)) return [];
  const st = statSync(input);
  if (st.isFile()) return [input];
  const out = [];
  const stack = [input];
  while (stack.length) {
    const dir = stack.pop();
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out;
}

function asNotify(row, fileName) {
  const hex = row.hex || row.frame_hex;
  if (typeof hex !== 'string') return null;
  const ids = idsOf(fileName);
  return {
    ...row,
    hex,
    device_id: row.device_id || row.deviceId || ids.deviceId,
    user_id: row.user_id || row.userId || ids.userId,
    fw: row.fw || row.firmware || null,
  };
}

function notifiesFromBuf(buf, fileName) {
  const out = [];
  try {
    for (const row of parseRows(buf)) {
      const n = asNotify(row, fileName);
      if (n) out.push(n);
    }
  } catch {
    // skip non-ndjson objects
  }
  return out;
}

function foldBatch(state, notifies) {
  if (!notifies.length) return state;
  const r = extractSpo2FromNotifies(notifies, { existing: state.observations, summarize: false });
  state.observations = r.observations;
  state.inserted += r.inserted;
  state.duplicates += r.duplicates;
  state.notifies += notifies.length;
  for (const log of r.logs || []) state.logs.push(log);
  for (const rb of r.config_readbacks || []) state.config.push(rb);
  state.lastNotifies = notifies;
  return state;
}

async function pool(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

async function buffersFromB2() {
  const listed = JSON.parse(readFileSync(LIST, 'utf8'));
  const frameKeys = listed.frame_keys || [];
  mkdirSync(IN, { recursive: true });
  const cfg = storageConfig();
  const s3 = createS3({
    endpoint: cfg.b2S3Endpoint,
    bucket: cfg.b2Bucket,
    region: cfg.b2Region,
    accessKeyId: cfg.b2KeyId,
    secretAccessKey: cfg.b2ApplicationKey,
  });
  const files = [];
  let downloadFailures = 0;
  await pool(frameKeys, 8, async (key) => {
    const local = path.join(IN, key.replaceAll('/', '_'));
    try {
      if (!existsSync(local)) {
        const obj = await s3.getObject(key);
        if (!obj) throw new Error('missing');
        writeFileSync(local, obj.body);
      }
      files.push({ name: local });
    } catch {
      downloadFailures += 1;
    }
  });
  return { files, frameKeys: frameKeys.length, downloadFailures };
}

async function applyBackfill(observations) {
  const { applySpo2CandidateBackfill } = await import('../metrics/spo2Backfill.js');
  const { createMetricsDb } = await import('../metrics/repository.js');
  const cfg = storageConfig();
  const db = createMetricsDb({ cfg });
  const first = await applySpo2CandidateBackfill({ observations, db, timeZone: TZ });
  const second = await applySpo2CandidateBackfill({ observations, db, timeZone: TZ });
  return {
    first_days: first.count,
    second_days: second.count,
    days: first.days,
    rerun_identical: JSON.stringify(first.days) === JSON.stringify(second.days),
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  let files = [];
  let frameKeys = 0;
  let downloadFailures = 0;
  if (FROM_B2) {
    const pulled = await buffersFromB2();
    files = pulled.files;
    frameKeys = pulled.frameKeys;
    downloadFailures = pulled.downloadFailures;
  } else {
    files = collectFiles(IN).map((p) => ({ name: p }));
  }

  const state = {
    observations: [],
    inserted: 0,
    duplicates: 0,
    notifies: 0,
    logs: [],
    config: [],
    lastNotifies: [],
  };
  for (const f of files) {
    foldBatch(state, notifiesFromBuf(readFileSync(f.name), f.name));
  }
  const rerun = extractSpo2FromNotifies(state.lastNotifies || [], { existing: state.observations });
  const summary = summarizeSpo2Observations(state.observations, { timeZone: TZ });
  const nights = reportsByDeviceFirmwareNight(state.observations, { timeZone: TZ });
  const consoleHits = correlateConsoleLogs(state.observations, state.logs);
  const schedule = investigateSpo2Schedule(state.observations);
  let apply = null;
  if (APPLY) apply = await applyBackfill(state.observations);
  let whoopCycles = [];
  if (CYCLES && existsSync(CYCLES)) {
    const parsed = JSON.parse(readFileSync(CYCLES, 'utf8'));
    whoopCycles = Array.isArray(parsed) ? parsed : (parsed.cycles || []);
  }
  const whoopCycleValidation = compareSpo2CandidateToWhoopCycles({
    observations: state.observations,
    cycles: whoopCycles,
    timeZone: TZ,
  });
  const report = {
    files: files.length,
    frame_keys: frameKeys || files.length,
    download_failures: downloadFailures,
    notifies: state.notifies,
    inserted: state.inserted,
    duplicates_first_pass: state.duplicates,
    rerun_inserted: rerun.inserted,
    rerun_duplicates: rerun.duplicates,
    time_zone: TZ,
    summary,
    nights,
    utc_calendar_nights: utcCandidateNights(state.observations),
    physical_identity: {
      source_device_ids: summary.source_device_ids,
      physical_device_id: summary.physical_device_id,
      physical_identity_confidence: summary.physical_identity_confidence,
      physical_identity_evidence: summary.physical_identity_evidence,
      independent_physical_device_count: independentSpo2DeviceCount(state.observations),
      alias_relations: deviceAliasRelations(state.observations),
    },
    whoop_cycle_validation: whoopCycleValidation,
    schedule,
    apply,
    console: {
      log_hits: consoleHits.log_hits,
      correlated_candidate_count: consoleHits.correlated_candidate_count,
      hits: consoleHits.hits.slice(0, 40),
    },
    config_readbacks: state.config,
  };
  writeFileSync(path.join(OUT, 'spo2-report.json'), JSON.stringify(report, null, 2));
  writeFileSync(
    path.join(OUT, 'spo2-observations.ndjson'),
    state.observations.map((o) => JSON.stringify(o)).join('\n') + (state.observations.length ? '\n' : ''),
  );
  console.log(JSON.stringify({
    candidate_count: summary.candidate_count,
    v18: summary.total_v18_records,
    nights: nights.length,
    classification: summary.classification,
    rerun_inserted: rerun.inserted,
    download_failures: downloadFailures,
    apply: apply && { days: apply.first_days, rerun_identical: apply.rerun_identical },
    out: OUT,
  }, null, 2));
}

await main();
