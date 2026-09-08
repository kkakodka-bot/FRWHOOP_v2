#!/usr/bin/env node
/**
 * Recover WHOOP IMU from ready/verified Level-A frame objects.
 *
 * Derived imu_raw is created only from:
 *   - CRC-valid Puffin v21 historical IMU frames with 100 samples/axis, or
 *   - a separately hardware-supported type-43 IMU layout (rt43_imu).
 *
 * Unknown frames are not inferred. Type-43 raw flood is not enabled.
 *
 *   node bin/recover-whoop-imu.mjs --user-id UUID --from-day YYYY-MM-DD --to-day YYYY-MM-DD
 *     [--output report.json] [--write-imu-raw dir]
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

import { createMetricsDb } from '../metrics/repository.js';
import { getStores } from '../storage/stores.js';
import { storageConfig } from '../storage/config.js';
import { deriveRecords } from '../redecode/derive.js';
import {
  ACCEL_SCALE_G_PER_LSB,
} from '../protocol/imuArchive.js';
import { DECODER_VERSION } from '../protocol/decoder.js';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function parseLevelA(body) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { buf = gunzipSync(buf); } catch { /* plain */ }
  }
  const text = buf.toString('utf8').trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text);
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function allowedImu(record) {
  if (!record) return false;
  const n = record.accel_x?.length;
  if (n !== 100) return false;
  if (record.kind === 'hist_v21' && record.layout === 'v21') return true;
  if (record.kind === 'rt43_imu' && (record.layout === 'whoop4-1917' || record.layout === 'v21')) {
    return true;
  }
  return false;
}

function provenance(record, source) {
  return {
    source_object_id: source.object_key || source.path || null,
    frame_hash: record.envelope?.frame_hash || null,
    family: record.family || null,
    firmware: record.envelope?.firmware || record.fw || null,
    layout: record.layout || null,
    kind: record.kind,
    original_sensor_timestamp: record.sensor_ts ?? null,
    sample_index_start: record.sample_index_start ?? 0,
    samples_per_axis: record.samples_per_axis,
    accel_scale_g_per_lsb: record.accel?.scale_g_per_lsb ?? ACCEL_SCALE_G_PER_LSB,
    gyro_present: Array.isArray(record.gyro_x) && record.gyro_x.length === 100,
    decoder_version: DECODER_VERSION,
    sha256: record.envelope?.frame_hash || null,
  };
}

function walkLocal(dir, pred, maxFiles = 200) {
  const found = [];
  if (!dir || !existsSync(dir)) return found;
  const stack = [dir];
  while (stack.length && found.length < maxFiles) {
    const current = stack.pop();
    let ents;
    try { ents = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const ent of ents) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        if (['node_modules', '.git'].includes(ent.name)) continue;
        stack.push(full);
      } else if (pred(full)) found.push(full);
    }
  }
  return found;
}

async function main() {
  const userId = argument('--user-id');
  const fromDay = argument('--from-day');
  const toDay = argument('--to-day', fromDay);
  const outputPath = argument('--output');
  const writeDir = argument('--write-imu-raw');
  const timeZone = argument('--time-zone', 'America/Los_Angeles');
  const cfg = storageConfig();
  const db = createMetricsDb({ cfg });
  const { raw } = await getStores(cfg);

  const census = {
    schema: 'frwhoop_whoop_imu_recovery_v1',
    generated_at_utc: new Date().toISOString(),
    decoder_version: DECODER_VERSION,
    type_43_flood_enabled: false,
    preferred_source: 'replayable_banked_v21',
    user_id: userId || null,
    period: { from_day: fromDay, to_day: toDay, time_zone: timeZone },
    frame_objects_listed: 0,
    frame_objects_loaded: 0,
    notify_rows: 0,
    derived_imu_records: 0,
    accepted_v21: 0,
    accepted_type43: 0,
    rejected_unknown_or_incomplete: 0,
    valid_imu_records: 0,
    local_frame_files_scanned: 0,
    note: null,
    objects: [],
  };

  const accepted = [];

  if (userId && fromDay && db.configured && raw) {
    const listed = await db.listObjectManifests({
      userId, fromDay, toDay, timeZone, objectKind: 'frames',
    });
    census.frame_objects_listed = listed.length;
    for (const row of listed) {
      const entry = {
        object_key: row.object_key,
        status: row.status,
        sha256: row.sha256,
        start_at: row.start_at,
        end_at: row.end_at,
        accepted: 0,
      };
      try {
        const obj = await raw.getObject(row.object_key);
        if (!obj?.body) {
          entry.error = 'object_body_missing';
          census.objects.push(entry);
          continue;
        }
        census.frame_objects_loaded += 1;
        const rows = parseLevelA(obj.body);
        census.notify_rows += rows.length;
        const derived = deriveRecords(rows);
        census.derived_imu_records += derived.imu.length;
        for (const rec of derived.imu) {
          if (!allowedImu(rec)) {
            census.rejected_unknown_or_incomplete += 1;
            continue;
          }
          if (rec.kind === 'hist_v21') census.accepted_v21 += 1;
          else census.accepted_type43 += 1;
          accepted.push({ record: rec, provenance: provenance(rec, row) });
          entry.accepted += 1;
        }
      } catch (error) {
        entry.error = String(error.message || error).slice(0, 300);
      }
      census.objects.push(entry);
    }
  }

  const localRoots = [
    process.env.FRWHOOP_FRAMES,
    process.env.FRWHOOP_B2_CACHE,
    path.join(os.homedir(), 'Library/Caches/FRWHOOP'),
    '/tmp/frwhoop-frames',
  ].filter(Boolean);
  for (const root of localRoots) {
    const files = walkLocal(root, (p) => (
      /frames/i.test(p) && (p.endsWith('.gz') || p.endsWith('.ndjson'))
    ));
    census.local_frame_files_scanned += files.length;
    for (const file of files) {
      try {
        const rows = parseLevelA(readFileSync(file));
        census.notify_rows += rows.length;
        const derived = deriveRecords(rows);
        census.derived_imu_records += derived.imu.length;
        for (const rec of derived.imu) {
          if (!allowedImu(rec)) {
            census.rejected_unknown_or_incomplete += 1;
            continue;
          }
          if (rec.kind === 'hist_v21') census.accepted_v21 += 1;
          else census.accepted_type43 += 1;
          accepted.push({ record: rec, provenance: provenance(rec, { path: file }) });
        }
      } catch {
        census.rejected_unknown_or_incomplete += 1;
      }
    }
  }

  census.valid_imu_records = accepted.length;
  if (!accepted.length) {
    census.note = (
      'No CRC-valid Puffin v21 historical IMU (100 samples/axis) or hardware-supported '
      + 'type-43 IMU layout was recovered from the listed Level-A frame objects. '
      + 'Existing derived imu_raw was not inferred from unknown frames. Continuous '
      + 'type-43 raw flood was not enabled.'
    );
  }

  if (writeDir && accepted.length) {
    mkdirSync(writeDir, { recursive: true });
    writeFileSync(
      path.join(writeDir, 'imu_raw.ndjson'),
      accepted.map((row) => JSON.stringify(row.record)).join('\n') + '\n',
    );
    writeFileSync(
      path.join(writeDir, 'imu_raw_provenance.json'),
      `${JSON.stringify(accepted.map((row) => row.provenance), null, 2)}\n`,
    );
  }

  const text = `${JSON.stringify(census, null, 2)}\n`;
  if (outputPath) {
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, text);
  }
  process.stdout.write(text);
}

main().catch((error) => {
  process.stderr.write(`recover-whoop-imu: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
