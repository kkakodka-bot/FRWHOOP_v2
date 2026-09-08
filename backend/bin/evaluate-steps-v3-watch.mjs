#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

import { computeWatchAgreementMetrics, computeWatchSampleIntervalMetrics, overlapV18WithWatchSamples, calibrateStepsV3WithWatch, fitV18OnlyFallback, normalizeWatchQuantitySamples } from '../metrics/stepsV3Calibration.js';
import { loadImuRecordsForWindow } from '../metrics/engine.js';
import { createMetricsDb } from '../metrics/repository.js';
import { computeStepsV3 } from '../metrics/stepsV3.js';
import { loadStepsV3Artifact } from '../metrics/stepsV3Artifact.js';
import { createSupabaseRest } from '../persistence/supabaseRest.js';
import { storageConfig } from '../storage/config.js';
import { getStores } from '../storage/stores.js';
import { dayBounds, localDateKey } from '../time/dayBoundary.js';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function readJson(path, fallback) {
  return path ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

async function selectAll(rest, table, query, pageSize = 1000) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await rest.select(
      table,
      `${query}&limit=${pageSize}&offset=${offset}`,
    );
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

function predictionBuckets(dailyRows, key) {
  return dailyRows.flatMap((row) => (
    Array.isArray(row?.extras?.[key]?.event_buckets_60s)
      ? row.extras[key].event_buckets_60s.map((bucket) => ({
        ...bucket,
        day: row.day,
        count: Number(bucket.count ?? 0),
      }))
      : []
  ));
}

function eligibleDay(row, key) {
  const diagnostic = row?.extras?.[key];
  if (!diagnostic) return false;
  if (diagnostic.fallback === true && key === 'steps_v2') return false;
  if (key === 'steps_v1') return Number(diagnostic.coverage_seconds) > 0;
  if (key === 'steps_v2') return Number(diagnostic.imu_coverage) >= 0.05;
  const imuSeconds = Number(diagnostic?.coverage?.imu_seconds);
  const provenanceOk = diagnostic?.evidence_eligibility?.accuracy_eligible === true
    || diagnostic?.clock?.verified === true
    || diagnostic?.manifest_load_integrity?.complete === true;
  return imuSeconds > 0 || provenanceOk;
}

function agreementForDevice(dailyRows, watchBuckets) {
  return Object.fromEntries(['steps_v1', 'steps_v2', 'steps_v3'].map((key) => {
    const eligibleRows = dailyRows.filter((row) => eligibleDay(row, key));
    const days = new Set(eligibleRows.map((row) => row.day));
    const references = watchBuckets.filter((row) => days.has(row.day));
    const buckets = predictionBuckets(eligibleRows, key);
    const available = buckets.length > 0 && references.length > 0;
    return [key, {
      available,
      reason: available ? null : 'no_minimum_coverage_watch_prediction_overlap',
      eligible_days: [...days].sort(),
      overlapping_watch_buckets: references.length,
      metrics: available
        ? computeWatchAgreementMetrics({
          predictionBuckets: buckets,
          watchBuckets: references,
        })
        : null,
    }];
  }));
}

function daysBetween(fromDay, toDay) {
  const days = [];
  const cursor = new Date(`${fromDay}T12:00:00.000Z`);
  const end = new Date(`${toDay}T12:00:00.000Z`);
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

async function calibrationInputFromStorage({
  userId, fromDay, toDay, timeZone, artifact, artifactSha,
}) {
  const cfg = storageConfig();
  const db = createMetricsDb({ cfg });
  const { raw } = await getStores(cfg);
  if (!db.configured || !raw) {
    return {
      input: { windows: [], events: [] },
      diagnostics: { attempted: true, available: false, reason: 'durable_raw_storage_unavailable' },
    };
  }
  const loaded = await loadImuRecordsForWindow({
    db,
    raw,
    userId,
    fromDay,
    toDay,
    timeZone,
    extraKeys: [],
  });
  const records = loaded.records;
  const verified = records.filter((row) => row?._manifest_verified === true
    && (row?.clock_verified === true || row?.time?.verified === true));
  const windows = [];
  const events = [];
  const perDay = [];
  for (const day of daysBetween(fromDay, toDay)) {
    const bounds = dayBounds(day, timeZone);
    const computed = computeStepsV3({
      imuRecords: verified,
      artifact,
      dayStartMs: Date.parse(bounds.day_start_at),
      dayEndMs: Date.parse(bounds.day_end_at),
      loadIntegrity: loaded.integrity,
    });
    const eligible = Number(computed.coverage?.imu_seconds) > 0
      && (computed.evidence_eligibility?.accuracy_eligible === true
        || computed.status === 'ok'
        || computed.status === 'partial');
    if (eligible) {
      for (const window of computed.gait_windows || []) {
        windows.push({
          ...window,
          day,
          public_model_sha256: artifactSha,
          synthetic: false,
        });
      }
      for (const event of computed.candidate_events || []) {
        events.push({
          ...event,
          day,
          public_model_sha256: artifactSha,
          synthetic: false,
        });
      }
    }
    perDay.push({
      day,
      status: computed.status,
      unavailable_reason: computed.unavailable_reason || null,
      imu_seconds: computed.coverage?.imu_seconds || 0,
      windows: computed.gait_windows?.length || 0,
      candidate_events: computed.candidate_events?.length || 0,
      accuracy_eligible: computed.evidence_eligibility?.accuracy_eligible === true,
      exclusion_reason: eligible
        ? null
        : (computed.evidence_eligibility?.reason || computed.unavailable_reason || computed.status),
    });
  }
  return {
    input: { windows, events },
    diagnostics: {
      attempted: true,
      available: windows.length > 0 && events.length > 0,
      source: 'manifest_sha256_and_clock_verified_imu_replay',
      manifest_load_integrity: loaded.integrity,
      loaded_records: records.length,
      verified_records: verified.length,
      rejected_unverified_or_clock_records: records.length - verified.length,
      windows: windows.length,
      candidate_events: events.length,
      days: perDay,
    },
  };
}

async function main() {
  const userId = argument('--user-id');
  if (!/^[a-f0-9-]{36}$/i.test(userId || '')) {
    throw new Error('--user-id UUID is required');
  }
  const outputPath = argument('--output');
  const artifactPath = argument('--artifact');
  const artifactSha256 = argument('--artifact-sha256');
  let calibrationInput = readJson(argument('--calibration-input'), {});
  const v18Input = readJson(argument('--v18-input'), {});
  const rest = createSupabaseRest();
  const [profile] = await rest.select(
    'profiles',
    `select=timezone&id=eq.${encodeURIComponent(userId)}&limit=1`,
  );
  const requestedTimeZone = argument('--time-zone');
  const timeZone = requestedTimeZone || profile?.timezone || 'UTC';
  const fromDay = argument('--from-day');
  const toDay = argument('--to-day', fromDay);
  if ((fromDay && !/^\d{4}-\d{2}-\d{2}$/.test(fromDay))
      || (toDay && !/^\d{4}-\d{2}-\d{2}$/.test(toDay))) {
    throw new Error('--from-day and --to-day must use YYYY-MM-DD');
  }
  const allWatchRows = await selectAll(
    rest,
    'apple_watch_step_buckets',
    `select=*&user_id=eq.${encodeURIComponent(userId)}&order=bucket_start.asc`,
  );
  const watchRows = allWatchRows.filter((row) => {
    const day = localDateKey(row.bucket_start, timeZone);
    return (!fromDay || day >= fromDay) && (!toDay || day <= toDay);
  });
  const dailyDayFilter = [
    fromDay ? `day=gte.${fromDay}` : null,
    toDay ? `day=lte.${toDay}` : null,
  ].filter(Boolean).join('&');
  const dailyRows = await selectAll(
    rest,
    'daily_metrics',
    `select=day,steps,extras&user_id=eq.${encodeURIComponent(userId)}`
      + `${dailyDayFilter ? `&${dailyDayFilter}` : ''}&order=day.asc`,
  );
  const watchByDevice = new Map();
  for (const row of watchRows) {
    const device = String(row.device_fingerprint || 'unknown');
    const bucket = {
      ...row,
      day: localDateKey(row.bucket_start, timeZone),
    };
    const list = watchByDevice.get(device) || [];
    list.push(bucket);
    watchByDevice.set(device, list);
  }
  const artifactLoad = loadStepsV3Artifact({
    ...(artifactPath ? { path: artifactPath } : {}),
    expectedSha256: artifactSha256,
    allowFixture: false,
  });
  let calibrationReplay = {
    attempted: false,
    available: Boolean(calibrationInput.windows?.length && calibrationInput.events?.length),
    source: calibrationInput.windows?.length ? 'supplied_file' : null,
  };
  if (artifactLoad.ok && fromDay && toDay
      && (!calibrationInput.windows?.length || !calibrationInput.events?.length)) {
    const replayed = await calibrationInputFromStorage({
      userId,
      fromDay,
      toDay,
      timeZone,
      artifact: artifactLoad.artifact,
      artifactSha: artifactLoad.sha256,
    });
    calibrationInput = replayed.input;
    calibrationReplay = replayed.diagnostics;
  }
  const measurementQuery = [
    `user_id=eq.${encodeURIComponent(userId)}`,
    'metric_type=in.(steps,step_count,stepCount)',
    'select=*',
    'order=measured_at.asc',
  ].join('&');
  const measurementRows = await selectAll(rest, 'measurements', measurementQuery);
  const watchSamples = normalizeWatchQuantitySamples(measurementRows).samples.filter((sample) => {
    const day = localDateKey(sample.start, timeZone);
    return (!fromDay || day >= fromDay) && (!toDay || day <= toDay);
  });
  const extrasEvents = (key) => dailyRows.flatMap((row) => {
    const extra = row?.extras?.[key] || {};
    const events = extra.events || extra.candidate_events || [];
    return events.map((event) => ({ ...event, day: row.day }));
  });
  const intervalOverlap = computeWatchSampleIntervalMetrics({
    watchSamples,
    predictionEventsByAlgorithm: {
      steps_v1: extrasEvents('steps_v1'),
      steps_v2: extrasEvents('steps_v2'),
      steps_v3: extrasEvents('steps_v3').concat(calibrationInput.events || []),
    },
  });
  const v18Overlap = overlapV18WithWatchSamples(v18Input.rows || [], watchSamples);
  const primaryWatch = [...watchByDevice.values()]
    .sort((a, b) => b.length - a.length)[0] || [];
  const calibration = calibrateStepsV3WithWatch({
    publicModelArtifact: artifactLoad.artifact,
    publicModelSha256: artifactLoad.sha256,
    windows: calibrationInput.windows || [],
    events: calibrationInput.events || [],
    watchBuckets: primaryWatch,
    referenceCoverage: calibrationInput.referenceCoverage || [],
    benchmarkLearnedLogit: true,
  });
  const fallback = fitV18OnlyFallback({
    rows: v18Input.rows || [],
    watchBuckets: primaryWatch,
  });
  const result = {
    schema: 'frwhoop_steps_v3_watch_evaluation_v2',
    generated_at_utc: new Date().toISOString(),
    user_id: userId,
    time_zone: timeZone,
    time_zone_source: requestedTimeZone ? 'cli_override' : 'stored_profile',
    period: { from_day: fromDay || null, to_day: toDay || null },
    reference_role: 'agreement_reference_not_ground_truth',
    primary_join: 'raw_HKQuantitySample_interval_overlap',
    watch_raw_samples: {
      count: watchSamples.length,
      preserved_fields: [
        'uuid', 'startDate', 'endDate', 'step_count',
        'HKDevice', 'source/sourceRevision', 'coalesced',
      ],
    },
    interval_overlap: intervalOverlap,
    bucket_visualization_estimate: {
      note: '60s/5min buckets remain for visualization; fractional allocation is not the primary target',
      rows: watchRows.length,
      devices: watchByDevice.size,
      by_device: Object.fromEntries([...watchByDevice.entries()].map(([device, rows]) => [
        device,
        {
          buckets: rows.length,
          first_bucket: rows[0]?.bucket_start || null,
          last_bucket: rows.at(-1)?.bucket_start || null,
          algorithms: agreementForDevice(dailyRows, rows),
        },
      ])),
    },
    watch: {
      rows: watchRows.length,
      devices: watchByDevice.size,
      by_device: Object.fromEntries([...watchByDevice.entries()].map(([device, rows]) => [
        device,
        {
          buckets: rows.length,
          first_bucket: rows[0]?.bucket_start || null,
          last_bucket: rows.at(-1)?.bucket_start || null,
          algorithms: agreementForDevice(dailyRows, rows),
        },
      ])),
    },
    public_artifact: {
      ok: artifactLoad.ok,
      path: artifactLoad.path,
      sha256: artifactLoad.sha256,
      reason: artifactLoad.reason,
    },
    calibration_input: calibrationReplay,
    calibration,
    v18_fallback: fallback,
    v18_interval_overlap: v18Overlap,
    safeguards: {
      canonical_steps_unchanged: true,
      apple_watch_is_not_ground_truth: true,
      synthetic_rows_excluded_by_calibration_library: true,
    },
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) writeFileSync(outputPath, text);
  process.stdout.write(text);
}

main().catch((error) => {
  process.stderr.write(`evaluate-steps-v3-watch: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
