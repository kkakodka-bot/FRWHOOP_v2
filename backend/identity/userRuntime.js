import fs from 'node:fs';
import path from 'node:path';
import { createHourBuffer } from '../ingest/hourBuffer.js';
import { createHistoryBuffer } from '../ingest/historyBuffer.js';
import { createScoreScheduler } from '../ingest/scoreScheduler.js';
import { ingestScoreAsyncEnabled, scoreDebounceMs } from '../ingest/scorePolicy.js';
import { createWorkoutDetectionService } from '../metrics/workoutDetectionService.js';
import { inc, noteReject } from '../observability/metrics.js';
import { createBatchAckStore } from '../ingest/phoneBatch.js';
import { mergeRangeEvidence } from '../metrics/continuityAccounting.js';

/**
 * Per-authenticated-user live ingest. WHOOP samples and derived workouts
 * belong to the request JWT subject, never a process-wide local user id.
 */
export function createUserRuntimes({
  engine,
  cfg,
  loadStore,
  saveStore,
  syncQueue,
  estimateCalories,
  loadPersistedDays,
  liveDir,
  finalizer = null,
  timeZoneOf = null,
  markDaysDirty = null,
  scoreAsync = null,
  scoreDebounceMs: scoreDebounceMsOverride = null,
} = {}) {
  const map = new Map();
  const batchStores = new Map();
  const scoreScheduler = createScoreScheduler({
    engine,
    finalizer,
    markDaysDirty,
    debounceMs: scoreDebounceMsOverride ?? scoreDebounceMs(),
    scoreAsync: scoreAsync ?? ingestScoreAsyncEnabled(),
    zoneOf: (userId) => zoneOf(userId),
    deviceOf: (userId) => {
      const rt = map.get(userId);
      return { ...(rt?.live || {}), ...(rt?.rangeEvidence || {}) };
    },
    captureDayCompleteness: (userId, result) => {
      const rt = map.get(userId);
      if (rt && result?.dayCompleteness) {
        const rows = result.dayCompleteness;
        rt.lastDayCompleteness = Array.isArray(rows) ? (rows.at(-1) || null) : rows;
      }
    },
  });

  function safeUserId(userId) {
    return String(userId || 'local').replace(/[^a-zA-Z0-9_-]/g, '') || 'local';
  }

  function rangeEvidencePath(userId) {
    return liveDir ? path.join(liveDir, safeUserId(userId), 'range-evidence.json') : null;
  }

  function loadRangeEvidence(userId) {
    const file = rangeEvidencePath(userId);
    if (!file || !fs.existsSync(file)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function persistRangeEvidence(userId, evidence) {
    const file = rangeEvidencePath(userId);
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, `${JSON.stringify(evidence)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  function batchStore(userId) {
    if (!userId) return null;
    const hit = batchStores.get(userId);
    if (hit) return hit;
    const file = liveDir ? path.join(liveDir, safeUserId(userId), 'batch-acks.json') : null;
    const store = createBatchAckStore(file);
    batchStores.set(userId, store);
    return store;
  }

  function zoneOf(userId) {
    if (typeof timeZoneOf === 'function') {
      try {
        const tz = timeZoneOf(userId);
        if (tz) return tz;
      } catch { /* fall through */ }
    }
    return loadStore?.()?.profile?.timezone || 'UTC';
  }

  function forUser(userId) {
    if (!userId) throw new Error('user id required');
    let rt = map.get(userId);
    if (rt) return rt;
    function scheduleAffectedDays(args) {
      return scoreScheduler.enqueue(userId, args);
    }
    const buffer = createHourBuffer({
      userId,
      engine,
      ...(liveDir ? { dir: liveDir } : {}),
      chunkMs: cfg?.hrChunkMs,
      timeZone: () => zoneOf(userId),
      scoreAsync: scoreScheduler.scoreAsync,
      onSamplesArchived: ({ affectedDays, trigger, liveScore }) => scheduleAffectedDays({
        affectedDays,
        trigger: trigger || 'live_archive',
        liveScore,
      }),
      onScoreRequested: ({ affectedDays, trigger, liveScore }) => scheduleAffectedDays({
        affectedDays,
        trigger: trigger || 'frames_derived',
        liveScore,
      }),
    });
    const historyBuffer = createHistoryBuffer({
      userId,
      engine,
      ...(liveDir ? { dir: liveDir } : {}),
      maxBatchSamples: cfg?.historyBatchSamples,
      flushMs: cfg?.historyFlushMs,
      timeZone: () => zoneOf(userId),
      // Fired after each successful history flush (and again when the cycle
      // completes). Serialized per user so an older window cannot overwrite a
      // newer one. Routed through the finalizer: the same event-driven
      // operation every other trigger uses, idempotent and state-resolving.
      onHistoryComplete: ({ affectedDays, historyComplete, cycleId, trigger }) => (
        scheduleAffectedDays({
          affectedDays,
          historyComplete,
          cycleId,
          trigger: trigger || (historyComplete ? 'history_complete' : 'history_archive'),
        })
      ),
    });
    const detector = createWorkoutDetectionService({
      loadStore,
      saveStore,
      syncQueue,
      userId,
      estimateCalories,
      loadPersistedDays: () => loadPersistedDays(userId),
    });
    rt = { userId, buffer, historyBuffer, detector, live: null, rangeEvidence: null };
    const savedRange = loadRangeEvidence(userId);
    if (savedRange && Object.keys(savedRange).length) {
      rt.rangeEvidence = savedRange;
      rt.live = { ...savedRange };
    }
    map.set(userId, rt);
    return rt;
  }

  function setLive(userId, sample) {
    const rt = forUser(userId);
    const prev = rt.live || {};
    rt.live = {
      ...prev,
      connected: Boolean(sample?.connected),
      heartRate: sample?.heartRate ?? sample?.bpm ?? null,
      battery: sample?.battery ?? null,
      deviceId: sample?.deviceId || prev.deviceId || null,
      name: sample?.name || prev.name || null,
      firmware: sample?.firmware || prev.firmware || null,
      // Strap flash drain telemetry rides on the status post only. Per-sample
      // appends also land here, so keep the last known value instead of
      // blanking it on every sample.
      history: sample?.history ?? prev.history ?? null,
      at: sample?.datetime || sample?.at || new Date().toISOString(),
    };
    return rt;
  }

  function append(userId, sample) {
    const rt = setLive(userId, sample);
    const row = rt.buffer.append(sample);
    if (row?._ingest_reject) {
      inc('detector_sample_rejected');
      return rt;
    }
    inc('live_sample_backend_accepted');
    try {
      rt.detector.ingest(sample);
      inc('detector_sample_ingested');
    } catch {
      inc('detector_sample_rejected');
      noteReject('detector_throw');
    }
    return rt;
  }

  function appendGaps(userId, gaps) {
    const rt = forUser(userId);
    for (const gap of gaps || []) {
      try { rt.buffer.recordGap(gap); } catch { /* gap accounting is best-effort */ }
    }
    return rt;
  }

  function appendFrames(userId, frame) {
    const rt = forUser(userId);
    rt.buffer.appendFrame(frame);
    return rt;
  }

  function appendHistory(userId, samples, options) {
    const result = forUser(userId).historyBuffer.appendBatch(samples, options);
    try {
      forUser(userId).detector.ingestHistory?.(samples || [], {
        historyComplete: Boolean(options?.historyComplete),
      });
    } catch { /* v2 history reconcile is best-effort */ }
    return result;
  }

  /** Last canonical DayCompleteness transitions produced by this user's recompute chain. */
  function dayCompletenessOf(userId) {
    try { return forUser(userId).lastDayCompleteness || null; } catch { return null; }
  }

  function noteRangeEvidence(userId, evidence) {
    const rt = map.get(userId) || forUser(userId);
    rt.rangeEvidence = mergeRangeEvidence(rt.rangeEvidence, evidence);
    rt.live = {
      ...(rt.live || {}),
      ...rt.rangeEvidence,
      history: { ...(rt.live?.history || {}), ...rt.rangeEvidence },
    };
    try { persistRangeEvidence(userId, rt.rangeEvidence); } catch { /* watermarks are best-effort durable */ }
  }

  /// Feed the history buffer's live-evidence anchor (phone-posted frontier
  /// evidence: GET_DATA_RANGE newest banked stamp + live wall time).
  function noteAnchorEvidence(userId, dataRangeNewestMs, liveWallMs) {
    const rt = map.get(userId) || forUser(userId);
    try { rt.historyBuffer.noteAnchorEvidence(dataRangeNewestMs, liveWallMs); } catch { /* best-effort */ }
  }

  return {
    forUser,
    append,
    setLive,
    appendGaps,
    appendFrames,
    appendHistory,
    dayCompletenessOf,
    noteAnchorEvidence,
    noteRangeEvidence,
    liveOf(userId) {
      return map.get(userId)?.live || null;
    },
    detectorOf(userId) {
      return userId ? forUser(userId).detector : null;
    },
    bufferOf(userId) {
      return userId ? forUser(userId).buffer : null;
    },
    historyBufferOf(userId) {
      return userId ? forUser(userId).historyBuffer : null;
    },
    pendingCount() {
      let n = 0;
      for (const rt of map.values()) {
        n += rt.buffer.pendingCount();
        n += rt.historyBuffer.pendingCount();
      }
      return n;
    },
    async flushAll() {
      for (const rt of map.values()) {
        try { await rt.buffer.flush(); } catch { /* best-effort */ }
        try { await rt.historyBuffer.flush(); } catch { /* best-effort */ }
      }
      await scoreScheduler.flushAll();
    },
    async flushDueAll() {
      for (const rt of map.values()) {
        try { await rt.buffer.flushIfDue(); } catch { /* best-effort */ }
        try { await rt.historyBuffer.flushIfDue(); } catch { /* best-effort */ }
      }
    },
    async flushAllScores(userId = null) {
      if (userId) await scoreScheduler.drainUser(userId);
      else await scoreScheduler.flushAll();
    },
    userIds() {
      return [...map.keys()];
    },
    hydrateFromDisk(dir) {
      try {
        if (!dir || !fs.existsSync(dir)) return;
        for (const name of fs.readdirSync(dir)) {
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(name)) {
            forUser(name);
          }
        }
      } catch { /* missing live dir */ }
    },
    replayBatchAck(userId, batchId) {
      return batchStore(userId)?.replay(batchId) || null;
    },
    rememberBatchAck(userId, batchId, ack) {
      batchStore(userId)?.remember(batchId, ack);
    },
  };
}
