import { storageConfig, jwtRole, isProductionRuntime } from '../storage/config.js';
import { encryptJson } from '../persistence/cryptoSecrets.js';
import { toTypedSettingsRow, fromTypedSettingsRow } from './typedSettings.js';

/**
 * Cloud sync transport for settings, integrations, daily metrics and device
 * state. Two server-side transports, picked automatically:
 *
 *   service — SUPABASE_SERVICE_ROLE_KEY holds a real service_role JWT.
 *             Direct PostgREST access; bypasses RLS.
 *   rpc     — anon/publishable key + INGEST_SECRET shared secret. Calls the
 *             engine RPCs (settings sync, scoring). Not NOOP push identity;
 *             push uses per-user opaque tokens minted via POST /api/push/tokens.
 *             secret-gated security-definer RPCs (app_*); RLS stays locked
 *             for direct table access.
 *
 * A service key slot containing an anon-role JWT (a common paste mistake) is
 * detected and NOT treated as service access. With neither transport
 * available, every call degrades to a safe no-op and the local store remains
 * the source of truth.
 *
 * `fetchImpl` is injectable so tests run without network.
 */

export const DEFAULT_USER_KEY = '7f2c9a10-4b3e-4d8a-9c11-00000000f001';

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

export { jwtRole, isUuidLike };

export function resolveCloudTransport(env = process.env) {
  const cfg = storageConfig(env);
  const url = cfg.supabaseUrl;
  const production = isProductionRuntime(cfg, env);
  const rawKey = production ? '' : ((env.FRWHOOP_LOCAL_USER_ID && String(env.FRWHOOP_LOCAL_USER_ID).trim()) || DEFAULT_USER_KEY);
  const userKey = isUuidLike(rawKey) ? rawKey : (production ? '' : DEFAULT_USER_KEY);
  const serviceKey = cfg.supabaseServiceRoleKey;
  const anonKey = cfg.supabaseAnonKey;
  const secret = (env.INGEST_SECRET && String(env.INGEST_SECRET).trim()) || '';
  const serviceRole = jwtRole(serviceKey);
  if (url && serviceKey && (serviceRole === 'service_role' || (serviceRole !== 'anon' && serviceRole !== 'authenticated'))) {
    return { mode: 'service', url, key: serviceKey, userKey };
  }
  if (url && anonKey && secret) {
    return { mode: 'rpc', url, key: anonKey, secret, userKey };
  }
  return { mode: 'none', url, userKey };
}

export function cloudConfigured(env = process.env) {
  return resolveCloudTransport(env).mode !== 'none';
}

export function createCloudSync({ fetchImpl = fetch, env = process.env } = {}) {
  const t = resolveCloudTransport(env);
  const configured = t.mode !== 'none';

  const call = async (path, { method = 'GET', body, query, prefer } = {}) => {
    if (!configured) throw new Error('supabase_not_configured');
    const headers = { apikey: t.key, authorization: `Bearer ${t.key}` };
    if (body != null) headers['content-type'] = 'application/json';
    if (prefer) headers.prefer = prefer;
    return fetchImpl(`${t.url}/rest/v1/${path}${query ? `?${query}` : ''}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
  };

  const serviceRpc = async (name, args) => {
    const res = await call(`rpc/${name}`, { method: 'POST', body: args || {} });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`rpc_${name}_failed:${res.status}:${text.slice(0, 120)}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  const rpc = async (name, args) => {
    return serviceRpc(name, { p_secret: t.mode === 'rpc' ? t.secret : null, ...args });
  };

  const sync = {
    configured,
    mode: t.mode,
    userKey: t.userKey,

    /** Reachability + auth check with latency. Never throws. */
    async cloudPing() {
      if (!configured) return { configured: false, mode: 'none', reachable: false, latencyMs: null };
      const t0 = Date.now();
      try {
        if (t.mode === 'service') {
          const res = await call('user_settings', { query: 'select=user_id&limit=1' });
          return { configured: true, mode: t.mode, reachable: res.ok, latencyMs: Date.now() - t0 };
        }
        const res = await call('user_settings', { query: 'select=user_id&limit=1' });
        return { configured: true, mode: t.mode, reachable: res.ok, latencyMs: Date.now() - t0 };
      } catch {
        return { configured: true, mode: t.mode, reachable: false, latencyMs: Date.now() - t0 };
      }
    },

    async pushSettings(userKey, settings) {
      if (t.mode === 'service') {
        const uid = isUuidLike(userKey) ? userKey : t.userKey;
        const row = toTypedSettingsRow(settings, uid);
        const res = await call('user_settings', {
          method: 'POST',
          query: 'on_conflict=user_id',
          body: row,
          prefer: 'resolution=merge-duplicates,return=minimal',
        });
        return res.ok;
      }
      return false;
    },

    async pullSettings(userKey) {
      if (t.mode === 'service') {
        const uid = isUuidLike(userKey) ? userKey : t.userKey;
        const res = await call('user_settings', {
          query: `user_id=eq.${encodeURIComponent(uid)}&select=*&limit=1`,
        });
        if (!res.ok) return null;
        const rows = await res.json();
        const row = rows?.[0];
        if (!row) return null;
        return fromTypedSettingsRow(row);
      }
      return null;
    },

    async upsertIntegration(userKey, provider, { status, tokens, meta, connectedAt, authorizationStatus, connectionStatus, enabled, lastSyncStatus, lastSyncError, lastSyncAt } = {}) {
      const uid = isUuidLike(userKey) ? userKey : t.userKey;
      const authorized = authorizationStatus || (status === 'connected' ? 'authorized' : 'not_requested');
      const connected = connectionStatus || (status === 'connected' ? 'connected' : 'disconnected');
      if (t.mode === 'service') {
        const row = {
          user_id: uid,
          provider,
          enabled: enabled ?? status === 'connected',
          authorization_status: authorized,
          connection_status: connected,
          last_sync_status: lastSyncStatus || null,
          last_sync_error: lastSyncError || null,
          last_sync_at: lastSyncAt || null,
          last_sync_attempt_at: lastSyncAt || null,
          meta: meta || {},
          connected_at: connectedAt || null,
        };
        const res = await call('integration_connections', {
          method: 'POST',
          query: 'on_conflict=user_id,provider',
          body: row,
          prefer: 'resolution=merge-duplicates,return=minimal',
        });
        if (tokens && Object.keys(tokens).length) {
          const cfg = storageConfig(env);
          if (!cfg.credentialsKey) {
            throw new Error('FRWHOOP_CREDENTIALS_KEY is required to store integration secrets');
          }
          const payload = {
            v: 'enc',
            key_version: cfg.credentialsKeyVersion || 1,
            cipher: encryptJson(tokens, cfg.credentialsKey, { version: cfg.credentialsKeyVersion || 1 }),
          };
          await serviceRpc('engine_put_integration_secret', {
            p_user_id: uid,
            p_provider: provider,
            p_tokens: payload,
          });
        }
        return res.ok;
      }
      throw new Error('integration_upsert_requires_service_role');
    },

    async listIntegrations(userKey) {
      if (t.mode === 'service') {
        const res = await call('integration_connections', {
          query: `user_id=eq.${encodeURIComponent(userKey)}&select=provider,enabled,authorization_status,connection_status,meta,connected_at,updated_at,last_sync_at,last_sync_status,last_sync_error`,
        });
        if (!res.ok) return [];
        const rows = await res.json();
        return Array.isArray(rows) ? rows.map((row) => ({
          ...row,
          status: row.connection_status === 'connected' || row.enabled ? 'connected' : 'disconnected',
        })) : [];
      }
      return [];
    },

    async removeIntegration(userKey, provider) {
      const uid = isUuidLike(userKey) ? userKey : t.userKey;
      if (t.mode === 'service') {
        await serviceRpc('engine_delete_integration_secret', { p_user_id: uid, p_provider: provider }).catch(() => {});
        const res = await call('integration_connections', {
          method: 'DELETE',
          query: `user_id=eq.${encodeURIComponent(uid)}&provider=eq.${encodeURIComponent(provider)}`,
        });
        return res.ok;
      }
      return false;
    },

    /** Bulk upsert daily metric rows. Returns rows written. */
    async upsertDailyMetrics(rows) {
      if (!Array.isArray(rows) || !rows.length) return 0;
      if (t.mode === 'service') {
        const res = await call('daily_metrics', {
          method: 'POST',
          body: rows,
          prefer: 'resolution=merge-duplicates,return=minimal',
        });
        if (!res.ok) throw new Error(`daily_metrics_upsert_failed:${res.status}`);
        return rows.length;
      }
      const n = await rpc('app_upsert_daily_metrics', { p_rows: rows });
      return Number(n) || 0;
    },

    async upsertDevice({ externalDeviceId, nickname, firmware, syncState } = {}) {
      if (!externalDeviceId) return false;
      await rpc('app_upsert_device', {
        p_user_id: t.userKey,
        p_external_device_id: externalDeviceId,
        p_nickname: nickname || null,
        p_firmware: firmware || null,
        p_sync_state: syncState || {},
      });
      return true;
    },
  };

  return sync;
}
