#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import process from 'node:process';

import {
  correctReplayHistoricalClock,
  dedupeReplaySamples,
  extraPhysiologyKeys,
} from '../metrics/engine.js';
import { loadCanonicalWindowEvidence } from '../metrics/dayEvidence.js';
import { createMetricsDb } from '../metrics/repository.js';
import { getStores } from '../storage/stores.js';
import { storageConfig } from '../storage/config.js';
import { localDateKey } from '../time/dayBoundary.js';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function daysBetween(fromDay, toDay) {
  const output = [];
  const cursor = new Date(`${fromDay}T12:00:00.000Z`);
  const end = new Date(`${toDay}T12:00:00.000Z`);
  while (cursor <= end) {
    output.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return output;
}

async function main() {
  const userId = argument('--user-id');
  const fromDay = argument('--from-day');
  const toDay = argument('--to-day', fromDay);
  const outputPath = argument('--output');
  const timeZone = argument('--time-zone', 'UTC');
  if (!/^[a-f0-9-]{36}$/i.test(userId || '')) throw new Error('--user-id UUID is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay || '')
      || !/^\d{4}-\d{2}-\d{2}$/.test(toDay || '')) {
    throw new Error('--from-day and --to-day YYYY-MM-DD are required');
  }
  if (!outputPath) throw new Error('--output is required');
  const cfg = storageConfig();
  const db = createMetricsDb({ cfg });
  const { raw } = await getStores(cfg);
  if (!db.configured || !raw) throw new Error('durable_raw_storage_unavailable');
  const days = daysBetween(fromDay, toDay);
  const extraKeys = await extraPhysiologyKeys(
    raw,
    userId,
    days,
    timeZone,
    cfg.localUserId,
  );
  const evidence = await loadCanonicalWindowEvidence({
    db,
    raw,
    userId,
    fromDay,
    toDay,
    timeZone,
    extraKeys,
  });
  if (evidence.blocked) throw new Error('raw_object_store_unavailable');
  const persisted = await db.loadUserDays(userId, fromDay, toDay);
  const sleepIntervals = (persisted.sleep_details || []).map((row) => ({
    start: Date.parse(row.user_start_at || row.original_start_at || ''),
    end: Date.parse(row.user_end_at || row.original_end_at || ''),
  })).filter((row) => Number.isFinite(row.start)
    && Number.isFinite(row.end) && row.end > row.start);
  const sleepCoverageDays = new Set(sleepIntervals.flatMap((interval) => [
    localDateKey(interval.start, timeZone),
    localDateKey(interval.end, timeZone),
  ]).filter(Boolean));
  const corrected = correctReplayHistoricalClock(evidence.samples || []);
  const samples = dedupeReplaySamples(corrected);
  const windowStart = Date.parse(`${fromDay}T00:00:00.000Z`) - 12 * 3600_000;
  const windowEnd = Date.parse(`${toDay}T23:59:59.999Z`) + 12 * 3600_000;
  const rows = samples
    .filter((sample) => {
      const layout = String(sample?.layout || '').toLowerCase();
      if (layout !== 'v18') return false;
      const time = Date.parse(sample?.t || sample?.datetime || sample?.at || '');
      return Number.isFinite(time) && time >= windowStart && time < windowEnd;
    })
    .map((sample) => {
      const startAt = sample.t || sample.datetime || sample.at;
      const time = Date.parse(startAt || '');
      const day = localDateKey(startAt, timeZone);
      const explicitWear = sample.on_wrist ?? sample.onwrist ?? sample.wrist_on;
      const explicitSleep = sample.sleep ?? sample.is_sleep;
      const heartRate = sample.bpm ?? sample.heartRate ?? sample.hr ?? sample.heart_rate;
      const numericHeartRate = Number(heartRate);
      const sleep = typeof explicitSleep === 'boolean'
        ? explicitSleep
        : (sleepCoverageDays.has(day)
          ? sleepIntervals.some((interval) => time >= interval.start && time < interval.end)
          : null);
      const wear = typeof explicitWear === 'boolean'
        ? explicitWear
        : (Number.isFinite(Number(explicitWear))
          ? Number(explicitWear) > 0
          : (Number.isFinite(numericHeartRate) ? numericHeartRate > 0 : null));
      return {
        start_at: startAt,
        day,
        device_id: sample.device_id || sample.deviceId || 'whoop-strap',
        layout: 'v18',
        step_cumulative: sample.step_cumulative ?? sample.step_motion_counter ?? null,
        step_cadence: sample.step_cadence ?? null,
        activity_class: sample.activity_class ?? null,
        dyn_accel: sample.dyn_accel ?? null,
        wear,
        sleep,
        wear_gate_source: explicitWear != null
          ? 'strap_on_wrist'
          : (wear == null ? 'unavailable' : 'heart_rate_present_proxy'),
        sleep_gate_source: typeof explicitSleep === 'boolean'
          ? 'strap_sleep_state'
          : (sleep == null ? 'unavailable' : 'persisted_sleep_interval'),
        source: 'manifest_verified_whoop_physiology',
        synthetic: false,
      };
    });
  const payload = {
    schema: 'frwhoop_steps_v18_feature_export_v1',
    generated_at_utc: new Date().toISOString(),
    user_id: userId,
    time_zone: timeZone,
    from_day: fromDay,
    to_day: toDay,
    rows,
    provenance: {
      manifest_rows: evidence.manifestRows?.length || 0,
      verified_objects: Object.keys(evidence.verifiedByObjectKey || {}).length,
      failed_objects: evidence.failures?.length || 0,
      prefix_discovered_objects: extraKeys.length,
      sleep_intervals: sleepIntervals.length,
      decoded_samples: evidence.samples?.length || 0,
      deduplicated_samples: (evidence.samples?.length || 0) - samples.length,
    },
  };
  writeFileSync(outputPath, `${JSON.stringify(payload)}\n`);
  process.stdout.write(`${JSON.stringify({
    output: outputPath,
    rows: rows.length,
    provenance: payload.provenance,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`export-v18-step-features: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
