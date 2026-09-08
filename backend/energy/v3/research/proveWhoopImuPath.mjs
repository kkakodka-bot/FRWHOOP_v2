#!/usr/bin/env node
/**
 * Real-B2 / local-archive diagnostic for the Energy V3 IMU producer path.
 *
 * Does not touch the phone, does not enable type-43, does not set
 * ENERGY_MODEL_V3=on. Fixture identity is proven in tests. This script only
 * reports whether deployed Level-A / imu_raw evidence exists locally.
 *
 *   node energy/v3/research/proveWhoopImuPath.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeImuArchive } from '../../../protocol/imuArchive.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'cache', 'whoop_imu_path_diagnostic.json');

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
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'inlab' || e.name === 'dataset') continue;
        stack.push(p);
      } else if (pred(p)) {
        found.push(p);
      }
    }
  }
  return found;
}

function inspectImu(file) {
  try {
    const body = fs.readFileSync(file);
    const recs = decodeImuArchive(body);
    const v21 = recs.filter((r) => r?.kind === 'hist_v21' && r.accel_x?.length === 100 && r.gyro_z?.length === 100);
    return {
      file,
      records: recs.length,
      v21: v21.length,
      identity: v21[0]?.identity || null,
      scale: v21[0] ? {
        accel: v21[0].accel?.scale_g_per_lsb,
        gyro: v21[0].gyro?.scale_dps_per_lsb,
      } : null,
    };
  } catch (err) {
    return { file, error: String(err?.message || err).slice(0, 200) };
  }
}

function main() {
  const roots = [
    process.env.FRWHOOP_IMU_RAW,
    process.env.FRWHOOP_B2_CACHE,
    path.join(here, '../../../data'),
    path.join(os.homedir(), 'Library/Caches/FRWHOOP'),
    '/tmp/frwhoop-imu',
  ].filter(Boolean);

  const imuFiles = [];
  const levelA = [];
  for (const root of roots) {
    imuFiles.push(...walk(root, {
      pred: (p) => /imu_raw/i.test(p) && (p.endsWith('.gz') || p.endsWith('.ndjson')),
    }));
    levelA.push(...walk(root, {
      pred: (p) => /level[-_]?a/i.test(p) && (p.endsWith('.gz') || p.endsWith('.ndjson')),
    }));
  }

  const inspected = imuFiles.slice(0, 5).map(inspectImu);
  const v21Deployed = inspected.some((x) => x.v21 > 0);
  const report = {
    phone_untouched: true,
    type43_flood_not_enabled: true,
    ENERGY_MODEL_V3: 'not_set_by_this_script',
    roots_searched: roots,
    imu_raw_files: imuFiles.length,
    level_a_files: levelA.length,
    inspected,
    fixture_path: 'tests prove Level-A notify → CRC v21 → 6×100 → 1/4096 g and 2000/32768 dps → identity → 60 s V3 replay',
    production_high_rate_imu_ready: v21Deployed,
    verdict: v21Deployed
      ? 'deployed_v21_imu_raw_present'
      : 'fixture_only_no_deployed_b2_v21',
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    verdict: report.verdict,
    imu_raw_files: report.imu_raw_files,
    production_high_rate_imu_ready: report.production_high_rate_imu_ready,
    out: OUT,
  }, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
