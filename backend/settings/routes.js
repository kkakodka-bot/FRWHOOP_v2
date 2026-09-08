import crypto from 'node:crypto';
import { createCloudSync } from './cloudSync.js';
import { loadWhoopDays } from '../host/whoopDays.js';
import { enqueueCoachBackfill } from '../metrics/backfill.js';
import { storageConfig } from '../storage/config.js';
import { resolveRequestUser } from '../identity/resolveUser.js';
import { loadCanonicalAccount } from './canonicalExport.js';
import {
  athleteMeta,
  authorizeUrl,
  deauthorize,
  exchangeCode,
  refreshTokens,
  stravaConfig,
  tokensExpired,
} from '../integrations/strava.js';
import { PERMISSION_GROUPS } from '../healthkit/policy.js';

/**
 * Settings cloud sync, health integrations (Apple Health, Strava), diagnostics
 * and server-side export. Everything degrades gracefully: without
 * SUPABASE_SERVICE_ROLE_KEY the cloud calls no-op and the local JSON store
 * stays the source of truth; without STRAVA_CLIENT_ID/SECRET the OAuth routes
 * return an explicit not-configured payload.
 */

const OAUTH_STATES = new Map(); // state → { expiresAt, userId }
const STATE_TTL_MS = 10 * 60 * 1000;

function newState(userId) {
  const state = crypto.randomBytes(16).toString('hex');
  OAUTH_STATES.set(state, { expiresAt: Date.now() + STATE_TTL_MS, userId });
  return state;
}

function consumeState(state) {
  const row = OAUTH_STATES.get(state);
  OAUTH_STATES.delete(state);
  if (!row || row.expiresAt <= Date.now()) return null;
  return row;
}

async function requestUserId(req) {
  try {
    return (await resolveRequestUser({ headers: req.headers || {} })).id;
  } catch {
    return null;
  }
}

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const { athlete, authorization, platform, scopes } = meta;
  return {
    ...(athlete ? { athlete: athleteMeta(athlete) } : {}),
    ...(authorization ? { authorization } : {}),
    ...(platform ? { platform } : {}),
    ...(scopes ? { scopes } : {}),
  };
}

/** Integration shape safe for clients: never includes tokens. */
export function publicIntegration(provider, row) {
  if (!row || typeof row !== 'object') {
    return { provider, connected: false, status: 'disconnected', meta: {}, connectedAt: null, updatedAt: null };
  }
  const status = row.status || 'disconnected';
  return {
    provider,
    connected: status === 'connected',
    status,
    meta: sanitizeMeta(row.meta),
    connectedAt: row.connectedAt || row.connected_at || null,
    updatedAt: row.updatedAt || row.updated_at || null,
  };
}

function ensureIntegrations(store) {
  if (!store.integrations || typeof store.integrations !== 'object') store.integrations = {};
  return store.integrations;
}

function appReturnUrl(env = process.env) {
  return (env.APP_RETURN_URL && env.APP_RETURN_URL.trim()) || 'http://localhost:5173/';
}

function callbackPage(title, detail, returnUrl) {
  const target = `${returnUrl}${returnUrl.includes('#') ? '' : '#settings'}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{background:#0B0D10;color:#fff;font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px;box-sizing:border-box}
.card{max-width:340px}.t{font-size:18px;font-weight:600;margin-bottom:8px}.d{font-size:13px;color:rgba(255,255,255,.55);line-height:1.5}
a{display:inline-block;margin-top:18px;background:#2E7CF6;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;font-size:14px}</style></head>
<body><div class="card"><div class="t">${title}</div><div class="d">${detail}</div>
<a href="${target}">Return to FRWHOOP</a>
<script>setTimeout(function(){window.location.href=${JSON.stringify(target)}},1200)</script>
</div></body></html>`;
}

export function registerSettingsRoutes(app, { loadStore, saveStore, queue, loadPersistedDays, rest } = {}) {
  // Cloud writes go through the durable outbox when present (retries with
  // backoff, survives restarts); otherwise fire-and-forget as a fallback.
  const enqueueOr = (op, fallback) => {
    if (queue) return queue.enqueue(op);
    if (fallback) fallback().catch(() => {});
    return false;
  };

  /* ── Settings cloud sync ─────────────────────────────────────────────── */

  app.get('/api/settings/cloud', async (_req, res) => {
    const sync = createCloudSync();
    const ping = await sync.cloudPing();
    res.json({ ...ping, settingsOwner: 'supabase_auth', queue: queue ? queue.status() : null });
  });

  app.post('/api/settings/sync', async (_req, res) => {
    res.json({
      synced: false,
      reason: 'client_owned',
      message: 'Settings persist directly to Supabase from the authenticated client.',
    });
  });

  // Manual one-shot backfill of the coach history into cloud daily_metrics.
  // Not run at boot by design; rows are tagged provenance.source
  // 'coach-days-backfill' and the engine keeps them out of live overlays.
  app.post('/api/settings/backfill', (_req, res) => {
    if (!queue) return res.status(503).json({ error: 'sync_queue_unavailable' });
    try {
      const userId = storageConfig().localUserId;
      if (!userId) return res.status(401).json({ error: 'user required' });
      const r = enqueueCoachBackfill(queue, userId);
      queue.flush().catch(() => {});
      res.json({ queued: true, ...r });
    } catch (err) {
      res.status(500).json({ error: 'backfill_failed', message: String(err?.message || err) });
    }
  });

  /* ── Integrations ────────────────────────────────────────────────────── */

  app.get('/api/integrations', async (req, res) => {
    const sync = createCloudSync();
    const userId = await requestUserId(req);
    const store = loadStore();
    const local = ensureIntegrations(store);
    let cloud = { configured: sync.configured, reachable: false };
    if (sync.configured && userId) {
      try {
        const rows = await sync.listIntegrations(userId);
        cloud.reachable = true;
        for (const row of rows) {
          local[row.provider] = {
            status: row.status || row.connection_status || 'disconnected',
            tokens: {},
            meta: row.meta || {},
            connectedAt: row.connected_at || null,
            updatedAt: row.updated_at || null,
          };
        }
      } catch {
        /* local copy below is still accurate */
      }
    }
    res.json({
      integrations: {
        apple_health: publicIntegration('apple_health', local.apple_health),
        strava: publicIntegration('strava', local.strava),
      },
      cloud,
    });
  });

  // The iOS app reports HealthKit authorization results here.
  app.post('/api/integrations/apple-health', async (req, res) => {
    const userId = await requestUserId(req);
    const authorization = req.body?.authorization
      || (req.body?.connected ? 'authorized' : 'not_requested');
    const enabled = Boolean(req.body?.enabled ?? req.body?.connected);
    const authorized = authorization === 'authorized';
    const meta = {
      authorization,
      platform: req.body?.platform || 'ios',
      scopes: Object.keys(PERMISSION_GROUPS),
    };
    const store = loadStore();
    const integrations = ensureIntegrations(store);
    integrations.apple_health = {
      status: enabled && authorized ? 'connected' : 'disconnected',
      enabled,
      authorizationStatus: authorization,
      connectionStatus: enabled && authorized ? 'connected' : 'disconnected',
      lastSyncStatus: enabled && authorized ? 'pending' : 'idle',
      tokens: {},
      meta,
      connectedAt: enabled && authorized ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
    };
    saveStore(store);
    if (userId) {
      enqueueOr(
        {
          type: 'integration.upsert',
          userId,
          provider: 'apple_health',
          row: {
            status: enabled && authorized ? 'connected' : 'disconnected',
            enabled,
            authorizationStatus: authorization,
            connectionStatus: enabled && authorized ? 'connected' : 'disconnected',
            lastSyncStatus: enabled && authorized ? 'pending' : 'idle',
            lastSyncError: null,
            tokens: {},
            meta,
            connectedAt: enabled && authorized ? new Date().toISOString() : null,
          },
        },
        () => {
          const sync = createCloudSync();
          return sync.configured
            ? sync.upsertIntegration(userId, 'apple_health', {
                status: enabled && authorized ? 'connected' : 'disconnected',
                enabled,
                authorizationStatus: authorization,
                connectionStatus: enabled && authorized ? 'connected' : 'disconnected',
                lastSyncStatus: enabled && authorized ? 'pending' : 'idle',
                lastSyncError: null,
                tokens: {},
                meta,
                connectedAt: enabled && authorized ? new Date().toISOString() : null,
              })
            : Promise.resolve(false);
        },
      );
    }
    res.json(publicIntegration('apple_health', integrations.apple_health));
  });

  /* ── Strava OAuth ────────────────────────────────────────────────────── */

  app.get('/api/integrations/strava/start', async (req, res) => {
    const cfg = stravaConfig();
    if (!cfg.configured) {
      return res.status(400).json({
        error: 'strava_not_configured',
        message: 'Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in backend/.env (create an app at strava.com/settings/api).',
      });
    }
    const userId = await requestUserId(req);
    if (!userId) return res.status(401).json({ error: 'authentication required' });
    res.json({ url: authorizeUrl({ clientId: cfg.clientId, redirectUri: cfg.redirectUri, state: newState(userId) }) });
  });

  app.get('/api/integrations/strava/callback', async (req, res) => {
    const cfg = stravaConfig();
    const ret = appReturnUrl();
    if (!cfg.configured) {
      return res.status(400).send(callbackPage('Strava is not configured', 'Add STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET to backend/.env, then try again.', ret));
    }
    if (req.query.error) {
      return res.send(callbackPage('Connection cancelled', 'You declined the Strava authorization. Nothing was connected.', ret));
    }
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const session = consumeState(state);
    if (!code || !session?.userId) {
      return res.status(400).send(callbackPage('Invalid callback', 'The authorization session expired. Start the connection again from Settings.', ret));
    }
    try {
      const tokens = await exchangeCode(code, cfg);
      const store = loadStore();
      const integrations = ensureIntegrations(store);
      integrations.strava = {
        status: 'connected',
        tokens,
        meta: { athlete: athleteMeta(tokens.athlete), scopes: String(req.query.scope || '') },
        connectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      saveStore(store);
      enqueueOr(
        {
          type: 'integration.upsert',
          userId: session.userId,
          provider: 'strava',
          row: {
            status: 'connected',
            enabled: true,
            authorizationStatus: 'authorized',
            connectionStatus: 'connected',
            tokens,
            meta: integrations.strava.meta,
            connectedAt: integrations.strava.connectedAt,
          },
        },
        () => {
          const sync = createCloudSync();
          return sync.configured
            ? sync.upsertIntegration(session.userId, 'strava', {
                status: 'connected',
                enabled: true,
                authorizationStatus: 'authorized',
                connectionStatus: 'connected',
                tokens,
                meta: integrations.strava.meta,
                connectedAt: integrations.strava.connectedAt,
              })
            : Promise.resolve(false);
        },
      );
      const name = integrations.strava.meta?.athlete?.name;
      return res.send(callbackPage('Strava connected', name ? `Connected as ${name}. Your activities will now sync.` : 'Your activities will now sync.', ret));
    } catch (err) {
      return res.status(502).send(callbackPage('Connection failed', `Strava did not complete the exchange (${err?.message || 'unknown error'}). Try again.`, ret));
    }
  });

  app.get('/api/integrations/strava/status', async (req, res) => {
    const userId = await requestUserId(req);
    const store = loadStore();
    const row = ensureIntegrations(store).strava;
    if (!row || row.status !== 'connected') {
      return res.json(publicIntegration('strava', row));
    }
    if (row.tokens?.refresh_token && tokensExpired(row.tokens)) {
      const cfg = stravaConfig();
      if (cfg.configured) {
        try {
          const next = await refreshTokens(row.tokens.refresh_token, cfg);
          row.tokens = { ...row.tokens, ...next };
          row.updatedAt = new Date().toISOString();
          saveStore(store);
          if (userId) {
            enqueueOr(
              {
                type: 'integration.upsert',
                userId,
                provider: 'strava',
                row: { status: 'connected', enabled: true, authorizationStatus: 'authorized', connectionStatus: 'connected', tokens: row.tokens, meta: row.meta, connectedAt: row.connectedAt },
              },
              () => {
                const sync = createCloudSync();
                return sync.configured
                  ? sync.upsertIntegration(userId, 'strava', {
                      status: 'connected',
                      enabled: true,
                      authorizationStatus: 'authorized',
                      connectionStatus: 'connected',
                      tokens: row.tokens,
                      meta: row.meta,
                      connectedAt: row.connectedAt,
                    })
                  : Promise.resolve(false);
              },
            );
          }
        } catch {
          row.status = 'error';
          saveStore(store);
        }
      }
    }
    res.json(publicIntegration('strava', row));
  });

  app.post('/api/integrations/strava/disconnect', async (req, res) => {
    const userId = await requestUserId(req);
    const store = loadStore();
    const integrations = ensureIntegrations(store);
    const row = integrations.strava;
    if (row?.tokens?.access_token) {
      deauthorize(row.tokens.access_token).catch(() => {});
    }
    integrations.strava = { status: 'disconnected', tokens: {}, meta: {}, connectedAt: null, updatedAt: new Date().toISOString() };
    saveStore(store);
    if (userId) {
      enqueueOr(
        { type: 'integration.delete', provider: 'strava', userId },
        () => {
          const sync = createCloudSync();
          return sync.configured ? sync.removeIntegration(userId, 'strava') : Promise.resolve(false);
        },
      );
    }
    res.json(publicIntegration('strava', integrations.strava));
  });

  /* ── Diagnostics + export ────────────────────────────────────────────── */

  app.get('/api/diagnostics', async (_req, res) => {
    const sync = createCloudSync();
    const ping = await sync.cloudPing();
    const storage = storageConfig();
    let dayKeys = [];
    let daysSource = 'local';
    if (typeof loadPersistedDays === 'function') {
      try {
        const persisted = await loadPersistedDays();
        dayKeys = Object.keys(persisted || {}).sort();
        daysSource = 'cloud';
      } catch { dayKeys = []; }
    }
    if (!dayKeys.length) {
      try { dayKeys = Object.keys(loadWhoopDays() || {}).sort(); } catch { dayKeys = []; }
      daysSource = 'local';
    }
    res.json({
      ok: true,
      at: new Date().toISOString(),
      backend: { ok: true, uptimeSec: Math.round(process.uptime()) },
      supabase: {
        configured: ping.configured,
        reachable: ping.reachable,
        mode: ping.mode,
        latencyMs: ping.latencyMs,
        project: (process.env.SUPABASE_URL || '').replace(/^https:\/\//, '').split('.')[0] || null,
      },
      sync: queue ? queue.status() : null,
      storage: {
        raw: storage.rawStore || 'b2',
        derived: storage.derivedStore || 'b2',
        b2Bucket: storage.b2Bucket || null,
        b2Configured: Boolean(storage.b2KeyId && storage.b2ApplicationKey),
      },
      strava: { configured: stravaConfig().configured },
      store: {
        days: dayKeys.length,
        latestDay: dayKeys[dayKeys.length - 1] || null,
        source: daysSource,
      },
    });
  });

  app.get('/api/export', async (req, res) => {
    let user;
    try {
      user = await resolveRequestUser({ headers: req.headers || {} });
    } catch (err) {
      return res.status(err.status || 401).json({ error: err.message || 'unauthorized' });
    }
    try {
      const bundle = await loadCanonicalAccount({
        rest,
        userId: user.id,
        loadPersistedDays,
        loadStore,
      });
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="frwhoop-export-${stamp}.json"`);
      res.send(JSON.stringify(bundle, null, 2));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'export_failed' });
    }
  });
}
