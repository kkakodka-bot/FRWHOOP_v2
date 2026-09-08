import {
  IdentityError,
  allowDevUser,
  bearerToken,
  lookupAuthUser,
  resolveRequestUser,
} from './resolveUser.js';
import { looksLikeJwt } from './ingestTokens.js';

/**
 * Resolve the FRWHOOP user for NOOP push (`GET`/`POST /api/push`).
 *
 * Order when Authorization: Bearer is present:
 *   1. Dev-only INGEST_SECRET when FRWHOOP_ALLOW_DEV_USER=true → source `ingest_secret`
 *   2. JWT-shaped bearer validated against Supabase Auth → source `jwt`
 *   3. If JWT-shaped and validation failed → fail closed (401)
 *   4. Opaque ingest token (SHA-256 hash lookup) → source `ingest_token`
 *
 * Without a bearer, falls through to resolveRequestUser (device token / dev user).
 */
export async function resolvePushUser({
  headers = {},
  cfg,
  fetchImpl = fetch,
  cache,
  ingestTokenStore,
  ingestSecret,
  localUserId,
} = {}) {
  const token = bearerToken(headers);

  if (token) {
    if (ingestSecret && token === ingestSecret && allowDevUser(cfg)) {
      return { id: localUserId, email: null, source: 'ingest_secret' };
    }

    if (looksLikeJwt(token)) {
      const jwtUser = await lookupAuthUser({ accessToken: token, cfg, fetchImpl });
      if (jwtUser) {
        cache?.set(token, jwtUser);
        return jwtUser;
      }
      throw new IdentityError('authentication required');
    }

    const ingestUser = await ingestTokenStore?.resolve?.(token);
    if (ingestUser) return ingestUser;
    throw new IdentityError('authentication required');
  }

  return resolveRequestUser({ headers, cfg, fetchImpl, cache });
}
