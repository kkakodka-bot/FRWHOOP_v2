import { isUuid } from '../storage/keys.js';
import { storageConfig } from '../storage/config.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve the authenticated FRWHOOP user.
 *
 * Production identity is always an auth.users UUID. There is no silent
 * fallback to `local-demo` or a shared user_key.
 *
 * Order:
 *   1. Bearer JWT validated against Supabase Auth (`auth.users.id`)
 *   2. Dev-only: X-FRWHOOP-DEVICE-TOKEN may map to FRWHOOP_LOCAL_USER_ID
 *      when no Authorization header is present
 *   3. Dev-only local user when FRWHOOP_ALLOW_DEV_USER=true
 *
 * A presented Bearer token that fails validation is never replaced by a
 * device-token or local user. Device tokens authenticate a device. They
 * never select a production user. Client-supplied userId values are never
 * trusted.
 *
 * NOOP push (`/api/push`) uses `resolvePushUser` instead: after JWT failure
 * on a JWT-shaped bearer it also fails closed; opaque ingest tokens are
 * resolved separately (see `identity/resolvePushUser.js`).
 */
export class IdentityError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
    this.code = 'unauthorized';
  }
}

export function bearerToken(headers = {}) {
  const auth = headers.authorization || headers.Authorization || '';
  if (String(auth).startsWith('Bearer ')) return String(auth).slice(7).trim();
  return '';
}

export function deviceTokenOf(headers = {}) {
  return String(headers['x-frwhoop-device-token'] || headers['X-FRWHOOP-DEVICE-TOKEN'] || '').trim();
}

export function allowDevUser(cfg) {
  if (cfg.allowDevUser === true) return true;
  if (cfg.allowDevUser === false) return false;
  return String(cfg.nodeEnv || '').toLowerCase() !== 'production';
}

export async function lookupAuthUser({ accessToken, cfg, fetchImpl = fetch }) {
  if (!accessToken || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return null;
  const res = await fetchImpl(`${cfg.supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: cfg.supabaseAnonKey,
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) return null;
  const u = await res.json().catch(() => null);
  if (u?.id && isUuid(u.id)) return { id: u.id, email: u.email || null, source: 'jwt' };
  return null;
}

export async function resolveRequestUser({
  headers = {},
  cfg = storageConfig(),
  fetchImpl = fetch,
  cache,
} = {}) {
  const accessToken = bearerToken(headers);
  if (accessToken) {
    if (cache?.has(accessToken)) return cache.get(accessToken);
    const user = await lookupAuthUser({ accessToken, cfg, fetchImpl });
    if (user) {
      cache?.set(accessToken, user);
      return user;
    }
    throw new IdentityError('authentication required');
  }

  const presented = deviceTokenOf(headers);
  if (cfg.deviceToken && presented && presented === cfg.deviceToken) {
    if (!allowDevUser(cfg)) {
      throw new IdentityError('jwt required for user identity');
    }
    if (!isUuid(cfg.localUserId)) {
      throw new IdentityError('FRWHOOP_LOCAL_USER_ID must be a uuid', 500);
    }
    return { id: cfg.localUserId, email: null, source: 'device_token' };
  }

  if (allowDevUser(cfg)) {
    if (!isUuid(cfg.localUserId)) {
      throw new IdentityError('FRWHOOP_LOCAL_USER_ID must be a uuid', 500);
    }
    return { id: cfg.localUserId, email: null, source: 'dev' };
  }

  throw new IdentityError('authentication required');
}

export function assertUuidUserId(value) {
  if (!value || !UUID_RE.test(String(value))) {
    throw new IdentityError('user id must be a uuid', 400);
  }
  return String(value);
}

export function identityMiddleware({ cfg, fetchImpl, cache = new Map() } = {}) {
  return async function identity(req, res, next) {
    try {
      req.frwhoopUser = await resolveRequestUser({
        headers: req.headers || {},
        cfg: cfg || storageConfig(),
        fetchImpl,
        cache,
      });
      return next();
    } catch (err) {
      const status = err.status || 401;
      return res.status(status).json({ error: err.message || 'unauthorized' });
    }
  };
}
