import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { OpenAI } from 'openai';
import { storageRouter } from './storage/router.js';
import { runCoachTurn } from './coach/loop.js';
import { heuristicCoachReply } from './coach/heuristic.js';
import { registerObservabilityRoutes } from './routes/observability.js';
import { registerWorkoutRoutes } from './routes/workout.js';
import { registerJournalRoutes } from './routes/journal.js';
import { registerDeviceSurfacesRoutes } from './routes/deviceSurfaces.js';
import { loadMemory, persistMemory as persistMemoryFile } from './memory/manager.js';
import { SessionStore } from './context/session.js';
import { loadDocuments } from './documents/store.js';
import { storageConfig, assertCredentialsPolicy, isProductionRuntime, requireProductionRuntime } from './storage/config.js';
import { applyB2Lifecycle } from './storage/b2Lifecycle.js';
import { dayBounds, localDateKey } from './time/dayBoundary.js';
import { summarizeCoverage } from './ingest/gaps.js';
import { createStreamingClient } from './coach/streaming.js';
import { normalizeHostStore, registerHostRoutes } from './host/routes.js';
import { ensureHostToken, requireHostSession, isLoopbackAddress } from './host/sessionAuth.js';
import { applyWorkoutRuntimePrefs, applyCloudWorkoutSettings, workoutRuntimeView } from './host/runtimePrefs.js';
import { registerFunctionalAgeRoutes } from './functionalAge/routes.js';
import { registerVo2Routes } from './vo2/routes.js';
import { emptyVo2State, ensureVo2Store } from './vo2/repository.js';
import { collectDays, resolveWeightKg } from './vo2/adapter.js';
import { registerEnergyRoutes } from './energy/routes.js';
import { mergeSamples } from './energy/sampleSource.js';
import { registerSettingsRoutes } from './settings/routes.js';
import { registerHealthKitRoutes } from './healthkit/routes.js';
import { registerStepValidationRoutes } from './metrics/stepValidation.js';
import { createCloudSync, resolveCloudTransport } from './settings/cloudSync.js';
import { createSyncQueue } from './cloud/syncQueue.js';
import { bootstrapStores } from './storage/stores.js';
import { createMetricsDb, bindLiveMetricsReads } from './metrics/repository.js';
import { createMetricsEngine } from './metrics/engine.js';
import { assertContinuitySchema, assertCanonicalMigrationLineage } from './metrics/schemaReadiness.js';
import { loadIngestVerifyReport } from './metrics/ingestVerify.js';
import { uuidFromParts } from './storage/keys.js';
import { resolveRequestUser, bearerToken, allowDevUser } from './identity/resolveUser.js';
import { createUserRuntimes } from './identity/userRuntime.js';
import { createTimeZoneResolver, readProfileTimeZone } from './identity/userTimezone.js';
import { createFinalizer, finalizeFromTrigger } from './metrics/finalization.js';
import { createBaselineSet, observation } from './baseline/service.js';
import { createSupabaseRest } from './persistence/supabaseRest.js';
import { createCanonicalStore } from './persistence/canonicalStore.js';
import { loadDaySnapshot, loadRange, snapshotToWhoopDay } from './metrics/snapshot.js';
import { createDeletionService, buildExportBundle } from './storage/deletion.js';
import { reconcileObjects } from './storage/reconcile.js';
import { sweepExpiredManifests } from './storage/retention.js';
import { getStores } from './storage/stores.js';
import { registerPushRoutes, defaultReceiverStateId } from './routes/push.js';
import { createPushWal, createPushWalStore, getMemoryPushWalStore } from './ingest/pushWal.js';
import { createPushIngest } from './ingest/pushIngest.js';
import { createPushObjects } from './ingest/pushObjects.js';
import { deleteReplacementRows } from './ingest/pushDelete.js';
import { createPushArchive } from './ingest/pushArchive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVE_DIR = process.env.FRWHOOP_LIVE_DIR || path.join(__dirname, 'data/live');
const PUSH_DIR = process.env.FRWHOOP_PUSH_DIR || path.join(__dirname, 'data/push');

dotenv.config();

const app = express();

const PORT = process.env.PORT || 8080;

function allowOrigin(origin, cb) {
  if (!origin) return cb(null, true);
  const allowed = [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost',
    'https://localhost',
    'capacitor://localhost',
    'ionic://localhost',
  ];
  if (allowed.includes(origin)) return cb(null, true);
  if (origin.startsWith('capacitor://') || origin.startsWith('ionic://')) return cb(null, true);
  if (/^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/.test(origin)) {
    return cb(null, true);
  }
  cb(null, false);
}

app.use(cors({ origin: allowOrigin, credentials: true }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// FRWHOOP_ACCESS_LOG=1 to see what the phone actually calls. Without it a phone
// that never posts strap samples looks identical to one whose posts are rejected.
if (process.env.FRWHOOP_ACCESS_LOG === '1') {
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const n = Array.isArray(req.body?.samples) ? req.body.samples.length : null;
      // The native plugin and the webview both call the host; only the plugin
      // can post strap samples, so the agent matters when nothing arrives.
      const agent = /CFNetwork|Darwin/.test(req.headers['user-agent'] || '') ? 'native' : 'webview';
      console.log(`[req] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`
        + ` from=${req.socket?.remoteAddress || '?'} ${agent}${n == null ? '' : ` samples=${n}`}`);
    });
    next();
  });
}

let runtimeReady = false;
let runtimeError = null;

// Health check endpoint
app.get('/', (req, res) => {
  if (!runtimeReady) {
    return res.status(503).json({
      status: 'not_ready',
      error: runtimeError,
      timestamp: new Date().toISOString(),
    });
  }
  res.json({ 
    status: 'WHOOP AI Coach API is running',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

function sendHealth(req, res) {
  if (!runtimeReady) {
    return res.status(503).json({
      status: 'not_ready',
      ingest: false,
      ingest_secret: Boolean(metricsCfg.ingestSecret),
      error: runtimeError,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  }
  const queue = syncQueue.status();
  res.json({
    status: 'healthy',
    ingest: true,
    ingest_secret: Boolean(metricsCfg.ingestSecret),
    outbox: {
      pending: queue.pending,
      deadLetters: queue.deadLetters,
      failed: queue.totals?.failed || 0,
      lastError: queue.lastError
        ? { at: queue.lastError.at, op: queue.lastError.op, status: queue.lastError.status, retryClass: queue.lastError.retryClass }
        : null,
    },
    persistence: isProductionRuntime(metricsCfg) ? 'full' : (metricsDb.configured ? 'configured' : 'dev'),
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
}

app.get('/health', sendHealth);
app.get('/healthz', sendHealth);

app.use('/storage', storageRouter());

const COACH_MODEL = process.env.MODEL || 'deepseek-ai/DeepSeek-V4-Flash-0731';
const llm = process.env.DEEPINFRA_API_KEY
  ? new OpenAI({
      apiKey: process.env.DEEPINFRA_API_KEY,
      baseURL: 'https://api.deepinfra.com/v1/openai',
    })
  : null;

function completeChat(body) {
  if (!llm) throw new Error('llm unavailable');
  return llm.chat.completions.create({ ...body, model: COACH_MODEL });
}


function embedSession(session, message, result) {
  if (!session || typeof session.append !== 'function') return;
  try {
    session.append(String(message || ''), result?.response || '', { analysis: result?.analysis || {} });
    session.save();
  } catch (error) {
    console.error('session persist failed:', error);
  }
}

app.post('/api/ai-coach', async (req, res) => {
  const startTime = Date.now();
  try {
    const { message, metrics, history, selectedDate, userId } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    const auth = req.headers.authorization || '';
    const accessToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const resolvedUserId = (await resolveRequestUser({
      headers: req.headers,
      cfg: storageConfig(),
    })).id;
    const memory = await loadMemory(resolvedUserId);
    const documents = await loadDocuments(resolvedUserId);
    const session = SessionStore.load(resolvedUserId);
    // Persistent session state is the source of older context; client history is preferred
    // when present (keeps the UI in control), otherwise reconstruct from the session.
    const baseHistory = Array.isArray(history) && history.length ? history : session.history();
    const result = await runCoachTurn({
      message: String(message),
      history: baseHistory,
      metrics,
      selectedDate,
      accessToken,
      complete: llm ? completeChat : null,
      memory,
      documents,
      userId: resolvedUserId,
      session,
    });
    persistMemory(memory);
    embedSession(session, message, result);
    res.json({ ...result, sessionId: session.sessionId, sessionTurns: session.messageCount });
  } catch (error) {
    console.error('AI Coach Error:', error);
    res.status(500).json({
      error: 'Failed to get response from AI coach',
      processingTime: Date.now() - startTime,
    });
  }
});

// Authenticated user identity: JWT, device token, or explicit dev user.
// Bounded + expiring identity cache: entries expire after TTL_MS and the store
// keeps at most MAX entries, so a long-lived process cannot grow identity
// state without limit and cannot serve a stale subject forever.
class BoundedTtlCache {
  constructor({ ttlMs = 60 * 60 * 1000, maxEntries = 1024 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map();
  }
  has(key) {
    const hit = this.map.get(key);
    if (!hit) return false;
    if (Date.now() - hit.at > this.ttlMs) { this.map.delete(key); return false; }
    return true;
  }
  get(key) { return this.has(key) ? this.map.get(key).value : undefined; }
  set(key, value) {
    if (this.map.size >= this.maxEntries) {
      let oldest = null; let oldestAt = Infinity;
      for (const [k, v] of this.map) {
        if ((v?.at ?? 0) < oldestAt) { oldestAt = v?.at ?? 0; oldest = k; }
      }
      if (oldest != null) this.map.delete(oldest);
    }
    this.map.set(key, { value, at: Date.now() });
  }
}
const userIdCache = new BoundedTtlCache();
async function resolveUserId({ accessToken, headers = {} } = {}) {
  const h = { ...headers };
  if (accessToken && !h.authorization) h.authorization = `Bearer ${accessToken}`;
  const user = await resolveRequestUser({ headers: h, cfg: storageConfig(), cache: userIdCache });
  return user.id;
}

const metricsCfg = storageConfig();
assertCredentialsPolicy(metricsCfg);
metricsCfg.deviceToken = ensureHostToken(metricsCfg);
const hostAuth = requireHostSession({ cfg: metricsCfg });
const metricsDb = createMetricsDb({ cfg: metricsCfg });

function queueUserId(op) {
  return op?.payload?.user_id || op?.userId || op?.row?.user_id || metricsCfg.localUserId;
}

async function requestUser(req, res) {
  try {
    const user = await resolveRequestUser({ headers: req.headers, cfg: metricsCfg, cache: userIdCache });
    await tzResolver.ensure(user.id);
    return user;
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message || 'unauthorized' });
    return null;
  }
}

// Durable cloud outbox: every Supabase write goes through here so offline
// periods, restarts, and hiccups retry instead of failing. Flushed in order
// with backoff; state persists to data/sync-queue.json.
const syncQueue = createSyncQueue({
  filePath: process.env.FRWHOOP_SYNC_QUEUE_PATH || path.join(__dirname, 'data/sync-queue.json'),
  modeOf: () => resolveCloudTransport().mode,
  executor: {
    configured: () => metricsDb.configured || resolveCloudTransport().mode !== 'none',
    async exec(op) {
      const sync = createCloudSync();
      switch (op.type) {
        case 'settings':
          return sync.pushSettings(op.userId || sync.userKey, op.settings);
        case 'profile':
          if (!metricsDb.configured) return null;
          return createSupabaseRest({ cfg: metricsCfg }).upsert('profiles', op.row, { onConflict: 'id' });
        case 'integration.upsert': {
          const row = { ...op.row };
          const userId = op.userId || sync.userKey;
          return sync.upsertIntegration(userId, op.provider, row);
        }
        case 'integration.delete':
          return sync.removeIntegration(op.userId || sync.userKey, op.provider);
        case 'daily_metrics':
          return metricsDb.upsertPayload({ user_id: queueUserId(op), daily_metrics: op.rows });
        case 'ingest':
          return metricsDb.upsertPayload(op.payload);
        case 'events_upsert':
          return metricsDb.upsertPayload({ user_id: queueUserId(op), events: op.rows });
        case 'sessions_upsert':
          return metricsDb.upsertPayload({ user_id: queueUserId(op), sessions: op.rows });
        case 'measurements_upsert':
          return metricsDb.upsertPayload({ user_id: queueUserId(op), measurements: op.rows });
        case 'algorithm_result':
          return createSupabaseRest({ cfg: metricsCfg }).upsert('algorithm_results', op.row);
        case 'coach_memory':
          return createSupabaseRest({ cfg: metricsCfg }).upsert('coach_memories', op.row, { onConflict: 'user_id' });
        case 'coach_session':
          return createSupabaseRest({ cfg: metricsCfg }).upsert('coach_sessions', op.row);
        default:
          throw new Error(`unknown op ${op.type}`);
      }
    },
  },
});

// Engine writes enqueue into the outbox (durable); reads pass through live.
const queuedMetricsDb = {
  get configured() { return metricsDb.configured; },
  upsertPayload: (payload) => {
    syncQueue.enqueue({ type: 'ingest', payload });
    return Promise.resolve({ queued: true });
  },
  ...bindLiveMetricsReads(metricsDb),
};

function persistMemory(memory) {
  persistMemoryFile(memory);
  try {
    const json = memory?.toJSON?.() || {};
    if (json.userId) {
      syncQueue.enqueue({
        type: 'coach_memory',
        row: {
          user_id: json.userId,
          records: json.records || [],
          relations: json.relations || [],
        },
      });
    }
  } catch { /* cache already written */ }
}
const restDb = createSupabaseRest({ cfg: metricsCfg });
const pushWalStore = createPushWalStore({ rest: restDb });
const pushArchive = createPushArchive({ cfg: metricsCfg, rest: restDb });
const pushUpsertRows = (table, rows, opts) => {
  if (!restDb.configured) return Promise.resolve([]);
  return restDb.upsert(table, rows, opts);
};
const pushEnsureDevice = (row) => {
  if (!restDb.configured) return Promise.resolve([]);
  return restDb.upsert('devices', row, { onConflict: 'id' });
};
const pushIngest = createPushIngest({
  walFactory: (userId) => createPushWal({
    userId,
    store: pushWalStore || getMemoryPushWalStore(PUSH_DIR),
  }),
  walStore: pushWalStore || getMemoryPushWalStore(PUSH_DIR),
  archiveObject: (args) => pushArchive.archiveObject(args),
  upsertRows: pushUpsertRows,
  deleteRows: (table, filter) => {
    if (!restDb.configured) return Promise.resolve();
    return deleteReplacementRows(restDb, table, filter);
  },
  ensureDevice: pushEnsureDevice,
});
const pushObjects = createPushObjects({
  cfg: metricsCfg,
  rest: restDb,
  upsertRows: pushUpsertRows,
  ensureDevice: pushEnsureDevice,
});
const tzResolver = createTimeZoneResolver({
  loadProfileTimeZone: restDb.configured
    ? (userId) => readProfileTimeZone({ rest: (table, query) => restDb.select(table, query), userId })
    : null,
  fallback: 'UTC',
});
function timeZoneOf(userId) {
  return tzResolver.peek(userId);
}
const metricsEngine = createMetricsEngine({
  cfg: metricsCfg,
  db: queuedMetricsDb,
  energyContext: (uid) => energyContextFor(uid),
});
const persistedDaysCache = new Map();

async function loadPersistedBundle(uid) {
  const userId = uid;
  if (!userId) return { days: {}, snapshots: {} };
  const hit = persistedDaysCache.get(userId);
  if (hit && Date.now() - hit.at < 15_000) return hit;
  try {
    const tz = timeZoneOf(userId);
    const today = localDateKey(new Date(), tz);
    const fromDay = localDateKey(new Date(Date.now() - 21 * 86400000), tz);
    const bundle = await metricsEngine.loadPersistedBundle(userId, { fromDay, toDay: today });
    const packed = {
      at: Date.now(),
      days: bundle.days || {},
      snapshots: bundle.snapshots || {},
    };
    persistedDaysCache.set(userId, packed);
    return packed;
  } catch {
    return hit || { days: {}, snapshots: {} };
  }
}

async function loadPersistedDays(uid) {
  return (await loadPersistedBundle(uid)).days;
}

async function loadPersistedSnapshots(uid) {
  return (await loadPersistedBundle(uid)).snapshots;
}

async function baselinesOf(userId) {
  if (!userId || !metricsDb?.configured) return null;
  try {
    const tz = timeZoneOf(userId);
    const to = localDateKey(new Date(Date.now() - 86400000), tz);
    const from = localDateKey(new Date(Date.now() - 30 * 86400000), tz);
    const payload = await metricsDb.loadUserDays(userId, from, to);
    const set = createBaselineSet({ priors: { hrv_rmssd: 40 } });
    let n = 0;
    for (const row of payload?.daily_metrics || []) {
      if (row?.hrv_rmssd_ms == null) continue;
      const obs = observation({
        value: Number(row.hrv_rmssd_ms),
        at: row.computed_at || `${row.day}T08:00:00Z`,
        condition: 'sleep',
      });
      if (obs) {
        set.add('hrv_rmssd', obs);
        n += 1;
      }
    }
    return n ? set : null;
  } catch {
    return null;
  }
}

function energySampleUserIds(userId) {
  return userId ? [userId] : [];
}

// Live-sample reads are hot (/api/days and every dashboard refresh call this),
// so the merged two-day sample list is memoized briefly. The buffer itself
// appends monotonically; a 2s window is far below the 5-minute bucket the
// frontend renders, so a short cache cannot change what the UI sees.
const liveSamplesCache = new Map();
const LIVE_SAMPLES_TTL_MS = 2000;

function loadLiveSamples(userId) {
  if (!userId) return [];
  const tz = timeZoneOf(userId);
  const today = localDateKey(new Date(), tz);
  const yesterday = localDateKey(new Date(Date.now() - 86400000), tz);
  const ids = energySampleUserIds(userId);
  const key = `${userId || ''}|${today}|${yesterday}`;
  const hit = liveSamplesCache.get(key);
  if (hit && Date.now() - hit.at < LIVE_SAMPLES_TTL_MS) return hit.samples;
  const samples = mergeSamples(...ids.map((id) => {
    const buf = userRuntimes.bufferOf(id);
    const history = userRuntimes.historyBufferOf(id);
    if (!buf && !history) return [];
    return [
      ...(buf?.samplesFor(yesterday) || []),
      ...(buf?.samplesFor(today) || []),
      ...(history?.pendingSamples?.() || []),
    ];
  }));
  liveSamplesCache.set(key, { samples, at: Date.now() });
  return samples;
}

function localSamplesForDay(userId, day) {
  try {
    const ids = energySampleUserIds(userId);
    return mergeSamples(...ids.map((id) => userRuntimes.bufferOf(id)?.samplesFor(day) || []));
  } catch {
    return [];
  }
}

/**
 * Subject context for the energy model.
 *
 * Reuses the VO2 adapter's own resolvers rather than reading the profile raw, so
 * energy and VO2 max agree on this user's weight and HRmax history instead of
 * quietly disagreeing on the two most important inputs either of them has.
 */
async function energyContextFor(uid) {
  const store = loadStore();
  const profile = store.profile || {};
  const workouts = (store.activities || [])
    .filter((a) => !a.userId || a.userId === uid || uid === metricsCfg.localUserId)
    .filter((a) => a.start && a.end)
    .map((a) => ({ id: a.id, sport: a.name, start: a.start, end: a.end }));
  // The still-open workout matters most: it is the one the user is watching.
  const open = store.activeWorkout;
  if (open?.id && open.startTs && !workouts.some((w) => w.id === open.id)) {
    workouts.push({
      id: open.id,
      sport: open.sport || 'detected',
      start: new Date(open.startTs).toISOString(),
      end: null,
    });
  }
  return {
    profile: { ...profile, weightKg: resolveWeightKg(profile, store.vo2?.weightHistory) },
    prefs: {
      ...(store.prefs || {}),
      hrMaxOverride: store.vo2?.hrMaxOverride ?? null,
      wearLocation: store.prefs?.wearLocation,
      wearLocationEvents: store.prefs?.wearLocationEvents || [],
    },
    days: collectDays(store),
    workouts,
    calibration: await loadEnergyCalibration(uid),
    timeZone: timeZoneOf(uid),
  };
}

const energyCalibrationCache = new Map();

/** Active calibration row for a user, cached briefly; absent means population model. */
async function loadEnergyCalibration(uid) {
  const hit = energyCalibrationCache.get(uid);
  if (hit && Date.now() - hit.at < 300_000) return hit.row;
  let row = null;
  if (restDb.configured) {
    try {
      const rows = await restDb.select(
        'energy_user_calibration',
        `user_id=eq.${uid}&status=eq.active&select=version,params,calibration_confidence,training_days&limit=1`,
      );
      const r = rows[0];
      if (r) {
        row = {
          version: r.version,
          params: r.params || {},
          confidence: r.calibration_confidence,
          training_days: r.training_days,
          active: true,
        };
      }
    } catch { /* table arrives with the energy migration; population model until then */ }
  }
  energyCalibrationCache.set(uid, { at: Date.now(), row });
  return row;
}

/**
 * Supabase RPC using the *caller's* JWT, not the service role.
 *
 * The energy read functions are SECURITY INVOKER and resolve auth.uid(), so RLS
 * stays the enforcement boundary: a bug in a route handler cannot leak another
 * user's rows, because Postgres would refuse them anyway.
 */
const energyRpc = (metricsCfg.supabaseUrl && metricsCfg.supabaseAnonKey) ? {
  async call(name, args, req) {
    const auth = req?.headers?.authorization || '';
    if (!auth.startsWith('Bearer ')) throw new Error('bearer_token_required');
    const res = await fetch(`${metricsCfg.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: metricsCfg.supabaseAnonKey,
        authorization: auth,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args || {}),
    });
    if (!res.ok) throw new Error(`${name} failed (${res.status})`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  },
} : null;

// Event-driven overnight finalization. Every trigger — an archived history
// chunk, HISTORY_COMPLETE, a restored BLE catch-up, morning foreground,
// startup reconciliation — funnels through this one idempotent operation.
const overnightFinalizer = createFinalizer({
  engine: metricsEngine,
  db: queuedMetricsDb,
  cfg: metricsCfg,
  flushOutbox: () => syncQueue.flush(),
  dir: LIVE_DIR,
  historyStatsOf: (uid) => userRuntimes?.historyBufferOf(uid)?.stats() || null,
  liveOf: (uid) => userRuntimes?.liveOf(uid) || null,
  baselinesOf,
});

const userRuntimes = createUserRuntimes({
  engine: metricsEngine,
  cfg: metricsCfg,
  loadStore: (...args) => loadStore(...args),
  saveStore: (...args) => saveStore(...args),
  syncQueue,
  estimateCalories: (...args) => estimateCalories(...args),
  loadPersistedDays,
  liveDir: LIVE_DIR,
  finalizer: overnightFinalizer,
  timeZoneOf,
  markDaysDirty: (uid, days) => queuedMetricsDb?.invalidateDayCompleteness?.(uid, days),
});
userRuntimes.hydrateFromDisk(LIVE_DIR);


app.post('/api/ai-coach/stream', async (req, res) => {
  const dbg = (m) => { try { fs.appendFileSync('/tmp/sse-dbg.log', `[${Date.now()}] ${m}\n`); } catch {} };
  dbg('handler enter');
  const startTime = Date.now();
  const requestId = `sse-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    dbg('pre body parse');
    const { message, metrics, history, selectedDate, userId } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    const auth = req.headers.authorization || '';
    const accessToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const resolvedUserId = (await resolveRequestUser({
      headers: req.headers,
      cfg: storageConfig(),
    })).id;
    const memory = await loadMemory(resolvedUserId);
    const documents = await loadDocuments(resolvedUserId);
    dbg('stores loaded');
    const session = SessionStore.load(resolvedUserId);
    const baseHistory = Array.isArray(history) && history.length ? history : session.history();

    const streamComplete = createStreamingClient({
      apiKey: process.env.DEEPINFRA_API_KEY,
      baseURL: 'https://api.deepinfra.com/v1/openai',
    });

    // SSE response headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
    };
    send('meta', { requestId, userId: resolvedUserId, model: COACH_MODEL });

    let aborted = false;
    const controller = new AbortController();
    res.on('close', () => { aborted = true; controller.abort(); });

    dbg('def completeFn');
    const completeFn = async (body) => {
      let streamedAny = false;
      let chunks = [];
      let lastRes = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (aborted) throw new Error('client_aborted');
        const res1 = await streamComplete(body, {
          signal: controller.signal,
          onDelta: (d) => { chunks.push(d); },
        });
        if (!res1) continue;
        lastRes = res1;
        const msg = res1.choices?.[0]?.message || {};
        const content = String(msg.content || '').replace(/ thinking[\s\S]*?<\/think>/gi, '').trim();
        if (content || ((msg.tool_calls || []).length && attempt === 0)) break;
      }
      // flush the accumulated deltas of the successful call
      if (!aborted && chunks.length && lastRes && String(lastRes.choices?.[0]?.message?.content || '').trim()) {
        for (const c of chunks) send('delta', { requestId, content: c });
      }
      return lastRes;
    };

    dbg('calling runCoachTurn');
    const result = await runCoachTurn({
      message: String(message),
      history: baseHistory,
      metrics,
      selectedDate,
      accessToken,
      complete: llm && process.env.DEEPINFRA_API_KEY ? completeFn : null,
      memory,
      documents,
      userId: resolvedUserId,
      session,
    });

    if (!aborted) {
      persistMemory(memory);
      embedSession(session, message, result);
      send('done', {
        requestId,
        response: result.response,
        analysis: result.analysis,
        toolsUsed: result.toolsUsed,
        processingTime: Date.now() - startTime,
        sessionId: session.sessionId,
      });
    }
    res.end();
    dbg('turn returned ms='+ (Date.now()-startTime));
    console.log(`[sse] ${requestId} lane=${result.analysis?.lane} ms=${Date.now() - startTime}`);
  } catch (error) {
    try {
      send('error', { requestId, error: 'coach_failed', message: String(error.message || '') });
      res.end();
    } catch { /* socket closed */ }
  }
});

registerObservabilityRoutes(app, {
  syncQueue,
  userRuntimes,
  ingestSecret: Boolean(metricsCfg.ingestSecret),
});

// --- User store (activities, check-ins, captures, prefs) -------------------
// ponytail: JSON file is the ceiling. Swap for SQLite if this outgrows one user.
// Overridable so an end-to-end run can use a scratch store instead of writing
// fake workouts into the store the phone reads.
const storePath = process.env.FRWHOOP_STORE_PATH || path.join(__dirname, 'data', 'user-store.json');

function emptyStore() {
  return {
    activities: [],
    checkIns: [],
    captures: [],
    prefs: {},
    journal: [],
    healthReports: [],
    alarms: [],
    ecgReports: [],
    bpReadings: [],
    weeklyPlan: {
      sleepGoalMin: 480,
      strainGoalAvg: 14,
      recoveryDaysGoal: 2,
      weeks: {},
      completedDates: [],
    },
    longevity: {
      bedtimeWindowStart: '22:00',
      bedtimeWindowEnd: '22:45',
      caffeineCutoff: '12:00',
      zone2GoalPerWeek: 3,
      bedtimeLogs: {},
      caffeineLogs: {},
    },
    community: { team: null, members: [] },
    strengthSessions: {},
    profile: {},
    permissions: {},
    integrations: {},
    ble: {},
    functionalAge: { snapshots: [], latest: null },
    vo2: emptyVo2State(),
  };
}

const appStore = createCanonicalStore({
  rest: restDb,
  userId: metricsCfg.localUserId,
  cachePath: storePath,
  emptyStore,
  normalize: normalizeHostStore,
  credentialsKey: metricsCfg.credentialsKey,
  queue: syncQueue,
  demoCommunity: null,
});
appStore.hydrateFromCache();

function loadStore() {
  return appStore.load();
}

function saveStore(store) {
  appStore.save(store);
}

const lastLiveConnected = new Map();

function onLiveSampleForUser(userId, sample) {
  if (!userId) return;
  userRuntimes.append(userId, sample);
  const connected = sample?.connected;
  if (typeof connected === 'boolean' && connected !== lastLiveConnected.get(userId)) {
    console.log(JSON.stringify({
      evt: connected ? 'BLE_restored' : 'BLE_disconnected',
      v: '1.1.0',
      at: new Date().toISOString(),
      userId,
    }));
    lastLiveConnected.set(userId, connected);
  }
}

app.use('/api/ble/live', hostAuth);
app.use('/api/ingest/verify', hostAuth);
app.use('/api/workout-detection', hostAuth);
app.use('/api/host/runtime', hostAuth);
app.use('/api/metrics/finalize', hostAuth);
app.use('/api/metrics/finalization', hostAuth);

app.get('/api/host/session-token', (req, res) => {
  const ip = req.socket?.remoteAddress || req.ip;
  if (!isLoopbackAddress(ip)) return res.status(404).json({ error: 'not found' });
  res.json({ configured: Boolean(metricsCfg.deviceToken) });
});

/**
 * Startup / periodic reconciliation. Finds days whose ready raw physiology is
 * newer than the latest successful metric run (or whose durable local marker
 * never resolved) and finalizes them. Raw data alone is sufficient — a lost
 * HISTORY_COMPLETE signal costs nothing.
 */
async function reconcileOvernightFinalization(trigger = 'startup_reconciliation') {
  const ids = new Set([...(userRuntimes.userIds?.() || [])].filter(Boolean));
  const summary = [];
  for (const uid of ids) {
    if (!uid) continue;
    try {
      await tzResolver.ensure(uid);
      const outcome = await overnightFinalizer.reconcile({
        userId: uid,
        timeZone: timeZoneOf(uid),
        device: userRuntimes.liveOf(uid) || {},
        trigger,
      });
      if (outcome?.days?.length) {
        summary.push({ userId: uid, days: outcome.days });
        persistedDaysCache.delete(uid);
      }
    } catch (error) {
      console.error(`overnight_reconcile_failed ${uid}:`, error?.message || error);
    }
  }
  return summary;
}

registerHostRoutes(app, {
  loadStore,
  saveStore,
  resolveUser: async (req) => {
    const user = await resolveRequestUser({ headers: req.headers, cfg: metricsCfg, cache: userIdCache });
    await tzResolver.ensure(user.id);
    return user;
  },
  timeZoneOf,
  onLiveSampleForUser,
  onLiveFramesForUser: (userId, frame) => userRuntimes.appendFrames(userId, frame),
  onHistorySamplesForUser: (userId, samples, options) => userRuntimes.appendHistory(userId, samples, options),
  replayBatchAckForUser: (userId, batchId) => userRuntimes.replayBatchAck(userId, batchId),
  rememberBatchAckForUser: (userId, batchId, ack) => userRuntimes.rememberBatchAck(userId, batchId, ack),
  onAnchorEvidence: (userId, dataRangeNewestMs, liveWallMs) => {
    userRuntimes.noteAnchorEvidence(userId, dataRangeNewestMs, liveWallMs);
  },
  onRangeEvidence: (userId, evidence) => {
    userRuntimes.noteRangeEvidence(userId, evidence);
  },
  onLiveStatusForUser: (userId, live) => {
    userRuntimes.setLive(userId, live);
  },
  onLiveGapsForUser: (userId, gaps) => {
    userRuntimes.appendGaps(userId, gaps);
    const rows = (gaps || []).map((g) => ({
      id: g.id || crypto.randomUUID(),
      user_id: userId,
      kind: g.kind,
      // Deterministic id per gap window: a retried gap report must not mint
      // a second row (phone rows carry ids; this covers id-less reports).
      id: g.id || uuidFromParts([userId, 'lgap', String(g.kind || 'missing_interval'), String(g.start_at || ''), String(g.end_at || '')]),
      start_at: g.start_at,
      end_at: g.end_at,
      expected_samples: g.expected_samples ?? 0,
      received_samples: g.received_samples ?? 0,
      sample_seq_start: g.sample_seq_start ?? null,
      sample_seq_end: g.sample_seq_end ?? null,
      meta: g.meta && typeof g.meta === 'object' ? g.meta : {},
    })).filter((g) => g.kind && g.start_at && g.end_at);
    if (rows.length && restDb.configured) {
      restDb.upsert('ingest_gaps', rows, { onConflict: 'id' }).catch(() => {});
    }
  },
  onHapticResult: (userId, haptic) => {
    if (!userId) return;
    try { userRuntimes.detectorOf(userId)?.reportHaptic(Boolean(haptic?.ok ?? haptic?.succeeded)); } catch { /* telemetry */ }
  },
  loadLiveForUser: (userId) => userRuntimes.liveOf(userId),
  dayCompletenessForUser: (userId) => userRuntimes.dayCompletenessOf(userId),
  historyDiagnosticsForUser: (userId) => {
    try {
      const s = userRuntimes.historyBufferOf(userId)?.stats?.() || {};
      const dc = userRuntimes.dayCompletenessOf(userId);
      const fromDay = dc?.history_synced_through || dc?.contiguous_sample_through || null;
      return {
        history_contiguous_through: fromDay || s.history_contiguous_through || null,
        history_queue_depth: s.pending_history_samples ?? 0,
        history_progress_revision: s.history_progress_revision ?? 0,
        history_complete: Boolean(s.history_complete),
      };
    } catch {
      return null;
    }
  },
  detectionStateForUser: (userId, opts) => userRuntimes.detectorOf(userId)?.state(opts),
  finalizeForUser: async (userId, options = {}) => {
    const uid = userId;
    if (!uid) return { error: 'user required' };
    const tz = timeZoneOf(uid);
    const result = await finalizeFromTrigger({
      finalizer: overnightFinalizer,
      userId: uid,
      days: Array.isArray(options?.days) && options.days.length ? options.days : undefined,
      timeZone: tz,
      device: userRuntimes.liveOf(uid) || {},
      trigger: options.trigger || 'foreground_catch_up',
      flushHistory: async () => {
        try { return await userRuntimes.forUser(uid).historyBuffer.flush(); }
        catch { return { flushed: 0 }; }
      },
    });
    if (result?.dayCompleteness) {
      try { userRuntimes.forUser(uid).lastDayCompleteness = result.dayCompleteness; } catch { /* runtime may not exist */ }
    }
    persistedDaysCache.delete(uid);
    return result;
  },
  finalizationForUser: async (userId, day) => {
    const uid = userId;
    if (!uid) return { days: [] };
    if (day) return overnightFinalizer.stateOf(uid, day) || { day, state: 'unknown' };
    return { days: overnightFinalizer.allStates(uid) };
  },
  loadPersistedDays,
  loadPersistedSnapshots,
  loadLiveSamples,
  loadIngestVerify: async (userId, dayParam) => loadIngestVerifyReport({
    userId,
    dayParam,
    timeZone: timeZoneOf(userId),
    restConfigured: restDb.configured,
    metricsDb,
    getStores,
    assertContinuitySchema,
    userRuntimes,
    overnightFinalizer,
  }),

  recomputeMetrics: async (userId, options = {}) => {
    const uid = userId;
    if (!uid) return { error: 'user required' };
    const tz = timeZoneOf(uid);
    const defaultDays = [
      localDateKey(new Date(Date.now() - 86400000), tz),
      localDateKey(new Date(), tz),
    ];
    try {
      await userRuntimes.forUser(uid).historyBuffer.flush();
    } catch { /* pending history is best-effort */ }
    const days = Array.isArray(options?.days) && options.days.length ? options.days : undefined;
    const fromDay = options?.fromDay;
    const toDay = options?.toDay;
    const historyDays = userRuntimes.historyBufferOf(uid)?.affectedDays?.() || [];
    // Finalize through the state machine when the days are explicit: same
    // deterministic pipeline, plus state resolution, readback, and traces.
    if (typeof overnightFinalizer?.finalizeAffectedDays === 'function'
      && !fromDay && !toDay) {
      const finalizeDays = days || (historyDays.length ? historyDays : [
        localDateKey(new Date(Date.now() - 86400000), tz),
        localDateKey(new Date(), tz),
      ]);
      const outcome = await overnightFinalizer.finalizeAffectedDays({
        userId: uid,
        days: finalizeDays,
        trigger: 'manual_recompute',
        timeZone: tz,
        device: userRuntimes.liveOf(uid) || {},
        force: true,
      });
      persistedDaysCache.delete(uid);
      await userRuntimes.bufferOf(uid)?.flush();
      const last = outcome.results.at(-1) || null;
      return {
        samples: last?.sample_count ?? 0,
        day: last?.day || null,
        sleep: Boolean(last?.sleep_detected),
        derivedKey: null,
        finalization: outcome.results,
        replay: { days: outcome.days },
      };
    }
    const replay = await metricsEngine.recomputeFromStorage({
      userId: uid,
      device: userRuntimes.liveOf(uid) || {},
      days: days || historyDays || [],
      fromDay,
      toDay,
      timeZone: tz,
    });
    let computed = replay.results.filter((r) => !r?.skipped).at(-1) || null;
    let sampleCount = replay.samples;
    if (!computed) {
      const samples = loadLiveSamples(uid);
      sampleCount = samples.length;
      computed = await metricsEngine.persistComputed({
        samples,
        device: userRuntimes.liveOf(uid) || {},
        extras: { userId: uid, timeZone: tz, replay: true },
      });
    }
    persistedDaysCache.delete(uid);
    await userRuntimes.bufferOf(uid)?.flush();
    return {
      samples: sampleCount,
      day: computed?.scored?.day || null,
      sleep: Boolean(computed?.sleepRow),
      derivedKey: computed?.derivedKey || null,
      replay: {
        manifests: replay.manifests,
        days: replay.days,
        deduplicated: replay.deduplicated || 0,
      },
    };
  },
});
registerFunctionalAgeRoutes(app, { loadStore, saveStore });
registerVo2Routes(app, { loadStore, saveStore });
registerEnergyRoutes(app, {
  requestUser,
  energyContextFor,
  liveSamplesFor: loadLiveSamples,
  localSamplesForDay,
  rpc: energyRpc,
});
async function resolvePushUser(req, res) {
  try {
    const token = bearerToken(req.headers);
    if (token && metricsCfg.ingestSecret && token === metricsCfg.ingestSecret && allowDevUser(metricsCfg)) {
      const user = { id: metricsCfg.localUserId, source: 'ingest_secret' };
      await tzResolver.ensure(user.id);
      return user;
    }
    const user = await resolveRequestUser({ headers: req.headers, cfg: metricsCfg, cache: userIdCache });
    await tzResolver.ensure(user.id);
    return user;
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message || 'unauthorized' });
    return null;
  }
}

registerPushRoutes(app, {
  pushIngest,
  pushObjects,
  resolvePushUser,
  receiverStateId: defaultReceiverStateId(metricsCfg),
});

registerSettingsRoutes(app, { loadStore, saveStore, queue: syncQueue, loadPersistedDays, rest: restDb });
registerHealthKitRoutes(app, { loadStore, saveStore, rest: restDb, db: metricsDb });
registerStepValidationRoutes(app, { rest: restDb });

registerWorkoutRoutes(app, {
  requestUser,
  userRuntimes,
  loadStore,
  saveStore,
  writeRuntimePrefs,
});

function estimateActivityStrain(durationMin, avgHr, name = '') {
  const sport = String(name).toLowerCase();
  const intensity = /run|hiit|box/.test(sport) ? 1.0
    : /swim|cycl/.test(sport) ? 0.85
    : /walk|yoga/.test(sport) ? 0.35
    : 0.22;
  const hrFactor = avgHr ? Math.max(0.4, Math.min(1.4, (avgHr - 70) / 70)) : 1;
  const raw = Math.max(0, Number(durationMin) || 0) * intensity * hrFactor;
  return Math.round((21 * Math.log(1 + raw) / Math.log(1 + 180)) * 10) / 10;
}

function estimateCalories(durationMin, name = '') {
  const sport = String(name).toLowerCase();
  const met = /run|hiit/.test(sport) ? 9.8
    : /swim/.test(sport) ? 8
    : /cycl/.test(sport) ? 7.5
    : /box/.test(sport) ? 7.8
    : /walk/.test(sport) ? 3.5
    : /strength|weight|lift/.test(sport) ? 5
    : /yoga/.test(sport) ? 3
    : 5;
  return Math.round(met * 3.5 * 70 / 200 * Math.max(0, Number(durationMin) || 0));
}

function ownRows(rows, userId) {
  return (rows || []).filter((row) => row.userId === userId || (!row.userId && userId === metricsCfg.localUserId));
}

app.get('/api/activities', async (req, res) => {
  const user = await requestUser(req, res);
  if (!user) return;
  const { date } = req.query;
  const store = loadStore();
  const mine = ownRows(store.activities, user.id);
  res.json(date ? mine.filter((a) => a.date === date) : mine);
});

app.post('/api/activities', async (req, res) => {
  const user = await requestUser(req, res);
  if (!user) return;
  const { date, name, start, end, durationMin, avgHr, maxHr, zones } = req.body || {};
  if (!date || !name || !durationMin) {
    return res.status(400).json({ error: 'date, name, and durationMin are required' });
  }
  const duration = Number(durationMin);
  const activity = {
    id: crypto.randomUUID(),
    date,
    name,
    start: start || null,
    end: end || null,
    durationMin: duration,
    avgHr: avgHr ?? null,
    maxHr: maxHr ?? null,
    zones: Array.isArray(zones) ? zones : [0, 0, 0, 0, 0],
    strain: estimateActivityStrain(duration, avgHr, name),
    calories: estimateCalories(duration, name),
    source: 'user',
    userId: user.id,
    createdAt: new Date().toISOString(),
  };
  appStore.setUserId(user.id);
  const store = loadStore();
  store.activities.push(activity);
  appStore.saveMemory(store);
  appStore.enqueueOwnedSession(activity);
  res.status(201).json(activity);
});

app.delete('/api/activities/:id', async (req, res) => {
  const user = await requestUser(req, res);
  if (!user) return;
  appStore.setUserId(user.id);
  const store = loadStore();
  const row = (store.activities || []).find((a) => a.id === req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.userId && row.userId !== user.id) return res.status(404).json({ error: 'not found' });
  if (!row.userId && user.id !== metricsCfg.localUserId) return res.status(404).json({ error: 'not found' });
  store.activities = store.activities.filter((a) => a.id !== req.params.id);
  appStore.saveMemory(store);
  res.json({ ok: true });
});

app.get('/api/check-ins', async (req, res) => {
  const user = await requestUser(req, res);
  if (!user) return;
  appStore.setUserId(user.id);
  const store = loadStore();
  const owned = (store.checkIns || []).filter((c) => c.userId === user.id);
  // ponytail: process-local store is one user's cache. Postgres events are
  // durable. Upgrade: read/write events only.
  if (!owned.length) await appStore.hydrateFromCloud().catch(() => {});
  const { date } = req.query;
  const rows = (loadStore().checkIns || []).filter((c) => c.userId === user.id);
  res.json(date ? rows.filter((c) => c.date === date) : rows);
});

app.post('/api/check-ins', async (req, res) => {
  const user = await requestUser(req, res);
  if (!user) return;
  const { date, feeling, note } = req.body || {};
  if (!date || !feeling) return res.status(400).json({ error: 'date and feeling are required' });
  const row = {
    id: crypto.randomUUID(),
    userId: user.id,
    date,
    feeling,
    note: note || '',
    createdAt: new Date().toISOString(),
  };
  appStore.setUserId(user.id);
  const store = loadStore();
  store.checkIns.push(row);
  appStore.saveMemory(store);
  appStore.enqueueOwnedEvent(row, 'check_in');
  res.status(201).json(row);
});

app.get('/api/captures', async (req, res) => {
  const user = await requestUser(req, res);
  if (!user) return;
  appStore.setUserId(user.id);
  const store = loadStore();
  const owned = (store.captures || []).filter((c) => c.userId === user.id);
  if (!owned.length) await appStore.hydrateFromCloud().catch(() => {});
  res.json((loadStore().captures || []).filter((c) => c.userId === user.id));
});

app.post('/api/captures', async (req, res) => {
  const user = await requestUser(req, res);
  if (!user) return;
  const { date, kind, note } = req.body || {};
  if (!date || !kind) return res.status(400).json({ error: 'date and kind are required' });
  const row = {
    id: crypto.randomUUID(),
    userId: user.id,
    date,
    kind,
    note: note || '',
    createdAt: new Date().toISOString(),
  };
  appStore.setUserId(user.id);
  const store = loadStore();
  store.captures.push(row);
  appStore.saveMemory(store);
  appStore.enqueueOwnedEvent(row, 'capture');
  res.status(201).json(row);
});

// The app re-hints these flags every couple of seconds. Saving an unchanged
// store on each one rewrites the cache file and enqueues a cloud op, so only
// write on a real change. applyWorkoutRuntimePrefs overwrites in place, which
// keeps key order stable and lets this compare by serialization.
function writeRuntimePrefs(req, res) {
  const store = loadStore();
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const before = store.prefs || {};
  const next = applyWorkoutRuntimePrefs(before, body);
  if (JSON.stringify(next) !== JSON.stringify(before)) {
    if (process.env.FRWHOOP_ACCESS_LOG === '1') {
      console.log(`[prefs] ${JSON.stringify(before)} -> ${JSON.stringify(next)}`);
    }
    store.prefs = next;
    saveStore(store);
  }
  res.json(workoutRuntimeView(next));
}

app.post('/api/host/runtime', writeRuntimePrefs);

registerJournalRoutes(app, { loadStore, saveStore });

registerDeviceSurfacesRoutes(app, { loadStore, saveStore });

app.post('/api/coach/insight', async (req, res) => {
  const { metrics, topic } = req.body || {};
  const prompt = topic === 'sleep'
    ? `Using these metrics, give a 2-sentence sleep coach note: ${JSON.stringify(metrics)}`
    : `Using these metrics, give a 2-sentence strain coach note: ${JSON.stringify(metrics)}`;
  if (!llm) {
    return res.json({ insight: heuristicCoachReply(prompt, metrics), source: 'local' });
  }
  try {
    const completion = await completeChat({
      messages: [
        { role: 'system', content: 'You are WHOOP Coach. Two sentences, specific numbers, no markdown.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 120,
    });
    res.json({ insight: completion.choices[0].message.content, source: 'deepinfra' });
  } catch (error) {
    res.json({ insight: heuristicCoachReply(prompt, metrics), source: 'local' });
  }
});

app.get('/api/sync/revision', async (req, res) => {
  try {
    const user = await requestUser(req, res);
    if (!user) return;
    const hit = persistedDaysCache.get(user.id);
    if (!restDb.configured) return res.json({ revision: hit?.at || 0 });
    const rows = await restDb.select('user_sync_state', `user_id=eq.${user.id}&select=revision,updated_at`);
    res.json(rows[0] || { revision: 0, updated_at: null });
  } catch {
    res.json({ revision: 0 });
  }
});

app.get('/api/days/snapshot', async (req, res) => {
  try {
    const user = await requestUser(req, res);
    if (!user) return;
    const day = String(req.query.day || new Date().toISOString().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'invalid_day' });
    if (!restDb.configured) {
      const days = await loadPersistedDays(user.id);
      return res.json({ day, whoop: days[day] || null });
    }
    const snap = await loadDaySnapshot({
      rest: restDb,
      userId: user.id,
      day,
      timeZone: timeZoneOf(user.id),
    });
    res.json({ ...snap, whoop: snapshotToWhoopDay(snap) });
  } catch (error) {
    res.status(500).json({ error: 'snapshot_unavailable' });
  }
});

app.get('/api/days/range', async (req, res) => {
  try {
    const user = await requestUser(req, res);
    if (!user) return;
    const from = String(req.query.from || new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10));
    const to = String(req.query.to || new Date().toISOString().slice(0, 10));
    if (!restDb.configured) {
      const days = await loadPersistedDays(user.id);
      const keys = Object.keys(days).filter((d) => d >= from && d <= to);
      return res.json({ days: keys.map((d) => ({ day: d })) });
    }
    const rows = await loadRange({ rest: restDb, userId: user.id, fromDay: from, toDay: to });
    res.json({ days: rows });
  } catch {
    res.status(500).json({ error: 'range_unavailable' });
  }
});

app.post('/api/account/delete', async (req, res) => {
  try {
    const user = await resolveRequestUser({ headers: req.headers, cfg: metricsCfg, cache: userIdCache });
    const stores = await getStores(metricsCfg);
    const deletion = createDeletionService({
      rest: restDb,
      objectStore: stores.raw,
      localCleanup: async (userId) => {
        const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
        for (const rel of ['memory', 'sessions', 'documents', 'live']) {
          try {
            fs.rmSync(path.join(__dirname, 'data', rel, safe), { recursive: true, force: true });
          } catch { /* missing */ }
        }
      },
    });
    const result = await deletion.run(user.id);
    res.status(result.status === 'deleted' ? 200 : 202).json(result);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message || 'delete_failed' });
  }
});

app.post('/api/admin/reconcile', async (_req, res) => {
  try {
    const stores = await getStores(metricsCfg);
    const ids = (userRuntimes.userIds?.() || []).filter(Boolean);
    if (!ids.length) return res.json({ reports: [], users: 0 });
    const reports = [];
    for (const userId of ids) {
      reports.push(await reconcileObjects({
        rest: restDb,
        objectStore: stores.raw,
        userId,
      }));
    }
    res.json({ reports, users: ids.length });
  } catch (error) {
    res.status(500).json({ error: 'reconcile_failed' });
  }
});

app.post('/api/export', async (req, res) => {
  try {
    const user = await resolveRequestUser({ headers: req.headers, cfg: metricsCfg, cache: userIdCache });
    const stores = await getStores(metricsCfg);
    const built = await buildExportBundle({
      rest: restDb,
      objectStore: stores.raw,
      userId: user.id,
      includeArchives: Boolean(req.body?.include_archives),
      includeArchiveBodies: Boolean(req.body?.include_archive_bodies),
    });
    if (stores.raw) {
      await stores.raw.putObject(built.key, built.body, { contentType: 'application/gzip' });
      await restDb.upsert('object_manifests', { ...built.meta, status: 'ready', uploaded_at: new Date().toISOString(), verified_at: new Date().toISOString() });
    }
    res.json({
      object_key: built.key,
      sha256: built.meta.sha256,
      compressed_bytes: built.meta.compressed_bytes,
      content_type: 'application/gzip',
      format: 'json_gzip_v1',
      omitted: built.omitted,
      mode: built.payload.mode,
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'export_failed' });
  }
});

// The detector reads its own flags — auto-detect and the strap buzz — out of
// local prefs, which start at their defaults on a fresh host. Without this the
// buzz stays silent after every restart until the app happens to hint again,
// even though the user's saved setting says otherwise.
async function seedWorkoutRuntimeFromCloud() {
  if (isProductionRuntime(metricsCfg)) return;
  const transport = resolveCloudTransport();
  if (transport.mode !== 'service') return;
  const cloud = (await createCloudSync().pullSettings(transport.userKey))?.settings;
  if (!cloud) return;
  const store = loadStore();
  store.prefs = applyCloudWorkoutSettings(store.prefs || {}, cloud);
  saveStore(store);
  console.log(`[workout-runtime] seeded from cloud settings ${JSON.stringify(workoutRuntimeView(store.prefs))}`);
}

function afterListen() {
  appStore.hydrateFromCache();
  appStore.hydrateFromCloud()
    .then(() => appStore.migrateLocalIfNeeded())
    .then(() => seedWorkoutRuntimeFromCloud())
    .catch(() => {});
  userRuntimes.flushAll().catch(() => {});
  syncQueue.start();
  reconcileOvernightFinalization().catch(() => {});
  const transport = resolveCloudTransport();
  console.log(`[cloud-sync] transport=${transport.mode}`);
  bootstrapStores().then((info) => {
    console.log(`storage raw=${info.raw} derived=${info.derived}`);
  }).catch((error) => {
    console.error('storage bootstrap failed:', error.message || error);
  });
  applyB2Lifecycle({ cfg: metricsCfg }).then((r) => {
    console.log(`[b2-lifecycle] matched=${Boolean(r.matched)} applied=${Boolean(r.applied)} bucket=${r.bucket || ''} error=${r.error || ''}`);
  }).catch((error) => {
    console.error('[b2-lifecycle] failed:', error.message || error);
  });
  setInterval(() => {
    userRuntimes.flushDueAll().catch(() => {});
  }, 5 * 60 * 1000).unref?.();
  setInterval(() => {
    reconcileOvernightFinalization('periodic_reconciliation').catch(() => {});
  }, 30 * 60 * 1000).unref?.();
  setInterval(() => {
    getStores(metricsCfg).then((stores) => {
      const ids = userRuntimes.userIds?.() || [];
      return Promise.all([
        ...ids.map((userId) => reconcileObjects({
          rest: restDb,
          objectStore: stores.raw,
          userId,
        })),
        sweepExpiredManifests({ rest: restDb, objectStore: stores.raw }),
      ]);
    }).catch(() => {});
  }, 6 * 60 * 60 * 1000).unref?.();
}

export async function startServer() {
  assertCanonicalMigrationLineage();
  const production = isProductionRuntime(metricsCfg);
  if (production) {
    requireProductionRuntime(metricsCfg);
    await assertContinuitySchema(metricsDb);
  } else if (metricsDb.configured) {
    try { await assertContinuitySchema(metricsDb); }
    catch (err) { console.warn(`[continuity] schema not ready: ${err.message}`); }
  }
  runtimeError = null;
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, '0.0.0.0', () => {
      runtimeReady = true;
      console.log(`FRWHOOP API running on port ${PORT} env=${metricsCfg.nodeEnv}`);
      afterListen();
      resolve(server);
    });
    server.on('error', (err) => {
      runtimeReady = false;
      runtimeError = err.message || String(err);
      reject(err);
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().catch((err) => {
    runtimeError = err.message || String(err);
    console.error(runtimeError);
    process.exit(1);
  });
}
