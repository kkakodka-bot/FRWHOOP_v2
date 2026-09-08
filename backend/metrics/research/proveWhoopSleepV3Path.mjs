#!/usr/bin/env node
/**
 * Real-B2 / local-archive diagnostic for Sleep V3 sensor plumbing.
 * Does not enable FRWHOOP_SLEEP_V3=beta. Reports whether deployed Level-A /
 * ppg_raw / imu_raw / type-48 evidence exists locally.
 *
 *   node metrics/research/proveWhoopSleepV3Path.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeImuArchive } from '../../protocol/imuArchive.js';
import { decodePpgArchive } from '../../protocol/ppgArchive.js';
import { decodeArchive } from '../../ingest/archiveFormat.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'cache', 'whoop_sleep_v3_path_diagnostic.json');

function walk(dir, { maxFiles = 80, pred }) {
  const found = [];
  if (!dir || !fs.existsSync(dir)) return found;
  const stack = [dir];
  while (stack.length && found.length < maxFiles) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'inlab') continue;
        stack.push(p);
      } else if (pred(p)) found.push(p);
    }
  }
  return found;
}

function inspectPpg(file) {
  try {
    const recs = decodePpgArchive(fs.readFileSync(file));
    const v26 = recs.filter((r) => r?.kind === 'hist_v26');
    return {
      file, records: recs.length, v26: v26.length,
      rates: [...new Set(v26.map((r) => r.sample_rate_hz))],
      identity: v26[0]?.identity || null,
      sample_rate_provenance: v26[0]?.sample_rate_provenance || null,
    };
  } catch (err) {
    return { file, error: String(err?.message || err).slice(0, 200) };
  }
}

function inspectImu(file) {
  try {
    const recs = decodeImuArchive(fs.readFileSync(file));
    const v21 = recs.filter((r) => r?.kind === 'hist_v21' && r.accel_x?.length === 100);
    return { file, records: recs.length, v21: v21.length, identity: v21[0]?.identity || null };
  } catch (err) {
    return { file, error: String(err?.message || err).slice(0, 200) };
  }
}

function inspectLevelA(file) {
  try {
    const rows = decodeArchive(fs.readFileSync(file));
    const list = Array.isArray(rows) ? rows : (rows?.rows || []);
    let v18 = 0; let v21 = 0; let v26 = 0; let t48 = 0;
    for (const row of list) {
      const hex = row?.hex || '';
      if (hex.length < 24) continue;
      const buf = Buffer.from(hex, 'hex');
      const fam = String(row.family || '').toLowerCase();
      const pt = fam === 'puffin' ? buf[8] : buf[4];
      const hv = buf[9];
      if (pt === 47 && hv === 18) v18 += 1;
      if (pt === 47 && hv === 21) v21 += 1;
      if (pt === 47 && hv === 26) v26 += 1;
      if (pt === 48) t48 += 1;
    }
    return { file, rows: list.length, v18, v21, v26, type48: t48 };
  } catch (err) {
    return { file, error: String(err?.message || err).slice(0, 200) };
  }
}

function main() {
  const roots = [
    process.env.FRWHOOP_B2_CACHE,
    process.env.FRWHOOP_IMU_RAW,
    path.join(here, '../../../data'),
    path.join(os.homedir(), 'Library/Caches/FRWHOOP'),
    '/tmp/frwhoop-imu',
  ].filter(Boolean);
  const report = {
    generated_at: new Date().toISOString(),
    FRWHOOP_SLEEP_V3: process.env.FRWHOOP_SLEEP_V3 || 'not_set_by_this_script',
    roots,
    ppg: [],
    imu: [],
    levelA: [],
  };
  for (const root of roots) {
    for (const f of walk(root, { pred: (p) => /ppg_raw/i.test(p) && (p.endsWith('.gz') || p.endsWith('.ndjson')) })) {
      report.ppg.push(inspectPpg(f));
    }
    for (const f of walk(root, { pred: (p) => /imu_raw/i.test(p) && (p.endsWith('.gz') || p.endsWith('.ndjson')) })) {
      report.imu.push(inspectImu(f));
    }
    for (const f of walk(root, { pred: (p) => /level[-_]?a/i.test(p) && (p.endsWith('.gz') || p.endsWith('.ndjson')) })) {
      report.levelA.push(inspectLevelA(f));
    }
  }
  report.summary = {
    v26_ppg_raw: report.ppg.reduce((n, r) => n + (r.v26 || 0), 0),
    v21_imu_raw: report.imu.reduce((n, r) => n + (r.v21 || 0), 0),
    levelA_v18: report.levelA.reduce((n, r) => n + (r.v18 || 0), 0),
    levelA_v21: report.levelA.reduce((n, r) => n + (r.v21 || 0), 0),
    levelA_v26: report.levelA.reduce((n, r) => n + (r.v26 || 0), 0),
    levelA_type48: report.levelA.reduce((n, r) => n + (r.type48 || 0), 0),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
}

main();
