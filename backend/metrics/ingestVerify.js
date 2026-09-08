import { dayBounds, localDateKey } from '../time/dayBoundary.js';
import { computeDayCompleteness, toDayCompletenessWire } from './dayCompleteness.js';
import { loadCanonicalDayEvidence, loadCanonicalFrameRows } from './dayEvidence.js';
import { dedupeReplaySamples, correctReplayHistoricalClock } from './engine.js';
import {
  collectDeviceFrontiers,
  completenessFrontiers,
  buildIngestReconciliation,
  uiSeriesCoverage,
  derivedSensorThrough,
} from './continuityAccounting.js';
import { replayNotifies, pipelineAccounting } from '../redecode/redecode.js';
import { persistSidecarsFromFrames } from '../redecode/sidecar.js';

function unavailable(detail) {
  const err = new Error(detail);
  err.code = 'ingest_verify_unavailable';
  throw err;
}

export async function loadIngestVerifyReport({
  userId,
  dayParam,
  now = new Date(),
  timeZone,
  restConfigured,
  metricsDb,
  getStores,
  assertContinuitySchema,
  userRuntimes,
  overnightFinalizer,
  persistSidecars = true,
} = {}) {
  const uid = userId;
  if (!uid) throw Object.assign(new Error('user required'), { code: 'unauthorized' });
  const tz = timeZone || 'UTC';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(dayParam || ''))
    ? String(dayParam)
    : localDateKey(now, tz);
  const bounds = dayBounds(day, tz);
  const todayKey = localDateKey(now, tz);
  const historical = day < todayKey;
  const buf = userRuntimes?.bufferOf?.(uid);

  if (historical && !restConfigured) unavailable('service_role_unconfigured');
  if (historical && metricsDb?.configured && typeof assertContinuitySchema === 'function') {
    try { await assertContinuitySchema(metricsDb); }
    catch (err) { unavailable(err.message || 'continuity_schema_behind'); }
  }

  const { raw } = typeof getStores === 'function' ? await getStores() : { raw: null };
  let evidence;
  try {
    evidence = await loadCanonicalDayEvidence({
      db: metricsDb,
      raw,
      userId: uid,
      day,
      timeZone: tz,
    });
  } catch (err) {
    if (historical) {
      const wrapped = new Error(err.message || 'manifest_access_unavailable');
      wrapped.code = 'ingest_verify_unavailable';
      throw wrapped;
    }
    evidence = {
      samples: [],
      gapRows: [],
      manifestRows: [],
      verifiedByObjectKey: {},
      unavailableReason: err.message || 'verification_failed',
    };
  }

  const samples = dedupeReplaySamples(correctReplayHistoricalClock(evidence.samples || []));
  const live = userRuntimes?.liveOf?.(uid) || null;
  const historyBufferStats = (() => {
    const hb = userRuntimes?.historyBufferOf?.(uid);
    return hb ? hb.stats() : null;
  })();
  const hourStats = buf?.stats?.() || {};
  const seedFrontiers = collectDeviceFrontiers({
    live,
    rangeEvidence: live,
    hourBufferStats: hourStats,
    historyBufferStats,
    deviceId: live?.deviceId,
  });
  const completeness = computeDayCompleteness({
    day,
    timeZone: tz,
    samples,
    gapRows: evidence.gapRows || [],
    manifestRows: evidence.manifestRows || [],
    verification: {
      verifiedByObjectKey: evidence.verifiedByObjectKey || {},
      unavailableReason: evidence.unavailableReason || null,
    },
    frontiers: completenessFrontiers(seedFrontiers),
    dayFinishedAt: historical ? bounds.day_end_at : null,
    now,
  });

  let finalizationChain = null;
  try {
    finalizationChain = typeof overnightFinalizer?.diagnoseDay === 'function'
      ? await overnightFinalizer.diagnoseDay({ userId: uid, day, timeZone: tz })
      : null;
  } catch (err) {
    finalizationChain = { error: String(err?.message || err).slice(0, 160) };
  }

  let derivedThrough = null;
  let uiSeries = uiSeriesCoverage(null, completeness);
  try {
    if (typeof metricsDb?.loadUserDays === 'function') {
      const payload = await metricsDb.loadUserDays(uid, day, day);
      const row = (payload?.daily_metrics || []).find((r) => r?.day === day);
      const series = (payload?.daily_physiology_series || []).find((s) => s?.day === day);
      derivedThrough = derivedSensorThrough({ dailyRow: row, seriesRow: series });
      uiSeries = uiSeriesCoverage(series, completeness);
    }
  } catch { /* derived/UI series are diagnostic */ }

  const frontiers = collectDeviceFrontiers({
    live,
    rangeEvidence: live,
    hourBufferStats: hourStats,
    historyBufferStats,
    completeness: {
      ...completeness,
      recomputed_through: derivedThrough != null ? new Date(derivedThrough).toISOString() : null,
    },
    finalization: finalizationChain,
    derivedThrough,
    deviceId: live?.deviceId,
  });

  let evidencePipeline = null;
  try {
    const frames = await loadCanonicalFrameRows({
      db: metricsDb, raw, userId: uid, day, timeZone: tz,
    });
    if (frames.rows.length) {
      const replayed = replayNotifies(frames.rows);
      evidencePipeline = {
        ...pipelineAccounting(replayed.session, replayed.levelB),
        truncated: frames.truncated === true,
        unverified_object_keys: (frames.failures || []).map((f) => f.object_key).filter(Boolean),
      };
      if (persistSidecars) {
        try {
          await persistSidecarsFromFrames(frames.rows, {
            stores: { raw },
            userId: uid,
            deviceId: live?.deviceId || frontiers.device_id,
            timeZone: tz,
          });
        } catch { /* sidecars are derived; Level A is already durable */ }
      }
    } else if (frames.unavailableReason) {
      evidencePipeline = {
        unavailable_reason: frames.unavailableReason,
        truncated: frames.truncated === true,
        unverified_object_keys: (frames.failures || []).map((f) => f.object_key).filter(Boolean),
      };
    }
  } catch (err) {
    evidencePipeline = { unavailable_reason: String(err?.message || err).slice(0, 160) };
  }

  const reconciliation = buildIngestReconciliation({
    completeness,
    finalization: finalizationChain,
    frontiers,
    evidencePipeline,
    uiSeries,
    now,
  });
  const localDayFiles = buf?.samplesFor?.(day) || [];

  return {
    ...completeness,
    ...toDayCompletenessWire(completeness),
    product_status: reconciliation.product_status,
    received_buffered: localDayFiles.length,
    pending_flush: buf?.pendingCount() || 0,
    pending_frames: buf?.pendingFrameCount?.() || 0,
    live,
    history_buffer: historyBufferStats,
    finalization: finalizationChain,
    continuity: frontiers,
    reconciliation,
    replay_available: historical
      ? Boolean(completeness.raw_archive_verification.verification_complete && !evidence.unavailableReason)
      : null,
  };
}
