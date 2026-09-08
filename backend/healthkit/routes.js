import { createCloudSync } from '../settings/cloudSync.js';
import { resolveRequestUser } from '../identity/resolveUser.js';
import { PERMISSION_GROUPS, SOURCE_POLICY } from './policy.js';
import { applyCanonicalDay, ingestHealthKit, mergeAppleWatchStepBucket } from './ingest.js';
import { HealthKitPersistError, persistHealthKitResult } from './persist.js';
import { publicIntegration } from '../settings/routes.js';

async function requestUserId(req) {
  try {
    return (await resolveRequestUser({ headers: req.headers || {} })).id;
  } catch {
    return null;
  }
}

function ensureHealthkit(store) {
  if (!store.healthkit || typeof store.healthkit !== 'object') {
    store.healthkit = {
      sessions: [], links: [], measurements: [], appleWatchStepBuckets: [], days: {}, sync: {},
    };
  }
  store.healthkit.appleWatchStepBuckets ||= [];
  return store.healthkit;
}

function windowIso(payload) {
  const starts = [
    ...(payload.workouts || []).map((w) => w.start_time || w.start),
    ...(payload.sleep || []).map((s) => s.start_time || s.start),
    ...(payload.samples || []).map((s) => s.start_time || s.start),
    ...(payload.daily || []).map((d) => d.day),
  ].filter(Boolean);
  const ends = [
    ...(payload.workouts || []).map((w) => w.end_time || w.end),
    ...(payload.sleep || []).map((s) => s.end_time || s.end),
    ...(payload.samples || []).map((s) => s.end_time || s.end),
  ].filter(Boolean);
  return {
    from: starts.sort()[0] || new Date(Date.now() - 8 * 86400000).toISOString(),
    to: ends.sort().at(-1) || new Date().toISOString(),
  };
}

async function loadExisting({ rest, userId, store, payload }) {
  const local = ensureHealthkit(store);
  if (!rest?.configured || !userId) {
    return {
      sessions: [...(local.sessions || []), ...(store.sessions || [])],
      links: local.links || [],
    };
  }
  const { from, to } = windowIso(payload);
  const fromPad = new Date(Date.parse(from) - 6 * 3600000).toISOString();
  const toPad = new Date(Date.parse(to) + 6 * 3600000).toISOString();
  try {
    const [sessions, links] = await Promise.all([
      rest.select(
        'sessions',
        `user_id=eq.${userId}&start_at=lt.${toPad}&end_at=gt.${fromPad}&select=id,user_id,kind,source,external_id,start_at,end_at,summary,quality`,
      ),
      rest.select(
        'source_links',
        `user_id=eq.${userId}&select=*`,
      ),
    ]);
    return { sessions: sessions || [], links: links || local.links || [] };
  } catch {
    return { sessions: local.sessions || [], links: local.links || [] };
  }
}

function cacheLocal(store, result) {
  const local = ensureHealthkit(store);
  const byExt = new Map((local.sessions || []).map((s) => [`${s.source}:${s.external_id}`, s]));
  for (const s of result.sessions) byExt.set(`${s.source}:${s.external_id}`, s);
  local.sessions = [...byExt.values()];
  local.links = result.links;
  const measurements = new Map(
    (local.measurements || []).map((m) => [`${m.source_system}:${m.external_id}`, m]),
  );
  for (const measurement of result.measurements) {
    measurements.set(`${measurement.source_system}:${measurement.external_id}`, measurement);
  }
  local.measurements = [...measurements.values()].slice(-5000);
  const stepBuckets = new Map(
    (local.appleWatchStepBuckets || []).map((bucket) => [
      `${bucket.device_fingerprint}:${bucket.bucket_start}:${bucket.bucket_size_seconds}`,
      bucket,
    ]),
  );
  for (const bucket of result.appleWatchStepBuckets || []) {
    const key = `${bucket.device_fingerprint}:${bucket.bucket_start}:${bucket.bucket_size_seconds}`;
    stepBuckets.set(key, mergeAppleWatchStepBucket(stepBuckets.get(key), bucket));
  }
  local.appleWatchStepBuckets = [...stepBuckets.values()].slice(-20000);
  local.days = { ...(local.days || {}), ...result.daily };
  return local;
}

async function persistOverlays({ rest, userId, result }) {
  if (!rest?.configured || !userId) return;
  for (const [day, extras] of Object.entries(result.daily || {})) {
    const rows = await rest.select(
      'daily_metrics',
      `user_id=eq.${userId}&day=eq.${day}&select=extras,steps,weight_kg,vo2max,hrv_rmssd_ms,resp_rate_bpm,resting_hr_bpm,spo2_pct,provenance`,
    );
    const current = rows?.[0];
    const applied = applyCanonicalDay(current || {}, extras);
    if (!current) {
      await rest.upsert('daily_metrics', {
        user_id: userId,
        day,
        extras: { healthkit: extras },
        resting_hr_bpm: applied.resting_hr_bpm ?? null,
        hrv_rmssd_ms: applied.hrv_rmssd_ms ?? null,
        resp_rate_bpm: applied.resp_rate_bpm ?? null,
        spo2_pct: applied.spo2_pct ?? null,
        provenance: {
          healthkit: { ingested_at: new Date().toISOString(), sources: extras.sources || {} },
        },
        record_class: 'user',
      }, { onConflict: 'user_id,day' });
      continue;
    }
    const mergedExtras = { ...(current.extras || {}), healthkit: extras };
    const patch = {
      extras: mergedExtras,
      provenance: {
        ...(current.provenance || {}),
        healthkit: { ingested_at: new Date().toISOString(), sources: extras.sources || {} },
      },
    };
    if (current.resting_hr_bpm == null && applied.resting_hr_bpm != null) patch.resting_hr_bpm = applied.resting_hr_bpm;
    if (current.hrv_rmssd_ms == null && applied.hrv_rmssd_ms != null) patch.hrv_rmssd_ms = applied.hrv_rmssd_ms;
    if (current.resp_rate_bpm == null && applied.resp_rate_bpm != null) patch.resp_rate_bpm = applied.resp_rate_bpm;
    if (current.spo2_pct == null && applied.spo2_pct != null) patch.spo2_pct = applied.spo2_pct;
    if (current.weight_kg == null && applied.weight_kg != null) patch.weight_kg = applied.weight_kg;
    if (current.vo2max == null && extras.vo2max != null) patch.vo2max = extras.vo2max;
    await rest.patch('daily_metrics', patch, `user_id=eq.${userId}&day=eq.${day}`);
  }
  for (const row of result.weightRows || []) {
    const kg = Number(row.weight_kg);
    if (!Number.isFinite(kg) || kg <= 20 || kg >= 350) continue;
    await rest.upsert('body_weight_measurements', row, { onConflict: 'user_id,measured_at' });
  }
  for (const row of result.nutritionRows || []) {
    const existing = await rest.select('nutrition_days', `user_id=eq.${userId}&day=eq.${row.day}&select=source`);
    if (existing?.[0]?.source === 'manual') continue;
    await rest.upsert('nutrition_days', {
      ...row,
      logging_quality: 'partial',
      macros_complete: false,
    }, { onConflict: 'user_id,day' });
  }
}

export async function persistResult({ rest, userId, store, saveStore, result, sync, authorization }) {
  const local = cacheLocal(store, result);
  local.sync = {
    ...(local.sync || {}),
    lastAttemptAt: new Date().toISOString(),
  };
  saveStore?.(store);

  const durable = await persistHealthKitResult({ rest, userId, result });
  try {
    await persistOverlays({ rest, userId, result });
  } catch (err) {
    local.sync = { ...(local.sync || {}), overlayError: err.message };
  }

  const connectedAt = new Date().toISOString();
  local.sync = {
    ...(local.sync || {}),
    lastIngestAt: connectedAt,
    lastError: null,
    persisted: durable.persisted,
    ack: durable.ack || null,
  };
  if (store.integrations) {
    store.integrations.apple_health = {
      ...(store.integrations.apple_health || {}),
      status: 'connected',
      enabled: true,
      authorizationStatus: authorization || 'authorized',
      connectionStatus: 'connected',
      lastSyncStatus: 'ok',
      lastSyncError: null,
      lastSyncAt: connectedAt,
      meta: {
        authorization: authorization || 'authorized',
        platform: 'ios',
        scopes: Object.keys(PERMISSION_GROUPS),
        persisted: durable.persisted,
      },
      connectedAt: store.integrations.apple_health?.connectedAt || connectedAt,
      updatedAt: connectedAt,
    };
  }
  saveStore?.(store);
  if (userId && sync?.configured) {
    try {
      await sync.upsertIntegration(userId, 'apple_health', {
        status: 'connected',
        enabled: true,
        authorizationStatus: authorization || 'authorized',
        connectionStatus: 'connected',
        lastSyncStatus: 'ok',
        lastSyncError: null,
        lastSyncAt: connectedAt,
        connectedAt,
        meta: { authorization: authorization || 'authorized', platform: 'ios', scopes: Object.keys(PERMISSION_GROUPS) },
      });
    } catch { /* measurements already acknowledged */ }
  }
  return durable;
}

function recordPersistFailure({ store, saveStore, err }) {
  const local = ensureHealthkit(store);
  local.sync = {
    ...(local.sync || {}),
    lastAttemptAt: new Date().toISOString(),
    lastError: err.message,
    failedIngests: (Number(local.sync?.failedIngests) || 0) + 1,
  };
  if (store.integrations?.apple_health) {
    store.integrations.apple_health.lastSyncStatus = 'error';
    store.integrations.apple_health.lastSyncError = err.message;
    store.integrations.apple_health.updatedAt = new Date().toISOString();
  }
  saveStore?.(store);
}

function persistStatus(err) {
  if (err instanceof HealthKitPersistError && err.code === 'auth_required') return 401;
  if (err instanceof HealthKitPersistError && err.code === 'missing_identity') return 400;
  return 503;
}

export function registerHealthKitRoutes(app, { loadStore, saveStore, rest, db, sync: syncArg, resolveUser } = {}) {
  app.get('/api/healthkit/policy', (_req, res) => {
    res.json({ policy: SOURCE_POLICY, groups: PERMISSION_GROUPS });
  });

  app.post('/api/healthkit/ingest', async (req, res) => {
    const userId = resolveUser ? await resolveUser(req) : await requestUserId(req);
    if (rest?.configured && !userId) {
      return res.status(401).json({ ok: false, error: 'auth_required' });
    }
    const store = loadStore?.() || { healthkit: {} };
    const payload = req.body || {};
    const existing = await loadExisting({ rest, userId, store, payload });
    const result = ingestHealthKit({
      userId: userId || 'local',
      payload,
      existingSessions: existing.sessions,
      existingLinks: existing.links,
    });
    const sync = syncArg || createCloudSync();
    try {
      const durable = await persistResult({
        rest,
        db,
        userId,
        store,
        saveStore,
        result,
        sync,
        authorization: payload.authorization || 'authorized',
      });
      res.json({
        ok: true,
        persisted: durable.persisted,
        ingested: {
          measurements: result.measurements.length,
          sessions: result.sessions.length,
          links: result.links.length,
          appleWatchStepBuckets: result.appleWatchStepBuckets.length,
          days: Object.keys(result.daily).length,
          rejected: result.rejected.length,
        },
        exportPlan: result.exportPlan,
        daily: result.daily,
      });
    } catch (err) {
      recordPersistFailure({ store, saveStore, err });
      res.status(persistStatus(err)).json({
        ok: false,
        error: err.code || 'persist_failed',
        message: err.message,
      });
    }
  });

  app.post('/api/healthkit/export-plan', async (req, res) => {
    const userId = await requestUserId(req);
    const store = loadStore?.() || { healthkit: {} };
    const existing = await loadExisting({ rest, userId, store, payload: req.body || {} });
    const result = ingestHealthKit({
      userId: userId || 'local',
      payload: { workouts: [], sleep: [], vitals: req.body?.vitals || [] },
      existingSessions: existing.sessions,
      existingLinks: existing.links,
    });
    res.json({ ok: true, exportPlan: result.exportPlan });
  });

  app.get('/api/healthkit/status', async (req, res) => {
    const store = loadStore?.() || {};
    const hk = store.healthkit || {};
    const local = store.integrations?.apple_health;
    const days = hk.days || {};
    const samples = hk.measurements || [];
    const counts = {};
    for (const m of samples) {
      const k = m.metric_type || 'unknown';
      counts[k] = (counts[k] || 0) + 1;
    }
    res.json({
      policy: SOURCE_POLICY,
      groups: PERMISSION_GROUPS,
      sync: hk.sync || {},
      days: Object.keys(days).length,
      sampleCounts: counts,
      sessions: (hk.sessions || []).length,
      links: (hk.links || []).length,
      appleWatchStepBuckets: (hk.appleWatchStepBuckets || []).length,
      unmatchedWorkouts: (hk.sessions || []).filter((s) => s.summary?.role === 'canonical_fallback').length,
      failedIngests: hk.sync?.failedIngests || 0,
      integration: publicIntegration('apple_health', local),
    });
  });
}
