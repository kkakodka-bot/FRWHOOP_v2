// Port of the retired Node receiver + resolvePushUser.js, narrowed to the edge context:
// a bearer is either a Supabase Auth JWT (validated against auth/v1/user) or an opaque `noop_`
// ingest token (SHA-256 lookup in noop_ingest_tokens). There is no dev-user or device-token
// fallback here — the functions are always production.
import { createHash } from 'node:crypto';
import { isUuid } from './keys.ts';
import type { SupabaseRest } from './rest.ts';

export const INGEST_TOKEN_PREFIX = 'noop_';

export class IdentityError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
    this.code = 'unauthorized';
  }
}

export function looksLikeJwt(token: unknown): boolean {
  const parts = String(token || '').split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

export function hashIngestToken(token: unknown): string {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

export function bearerToken(headers: Headers): string {
  const auth = headers.get('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return '';
}

export async function lookupAuthUser({ accessToken, supabaseUrl, anonKey, fetchImpl = fetch }: {
  accessToken: string;
  supabaseUrl: string;
  anonKey: string;
  fetchImpl?: typeof fetch;
}) {
  if (!accessToken || !supabaseUrl || !anonKey) return null;
  const res = await fetchImpl(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) return null;
  const u = await res.json().catch(() => null);
  if (u?.id && isUuid(u.id)) return { id: u.id as string, email: u.email || null, source: 'jwt' };
  return null;
}

/**
 * Resolve the FRWHOOP user for NOOP push. Order with an Authorization: Bearer:
 *   1. JWT-shaped bearer validated against Supabase Auth → source `jwt`
 *   2. If JWT-shaped and validation failed → fail closed (401)
 *   3. Opaque ingest token (SHA-256 hash lookup) → source `ingest_token`
 * No bearer at all → 401. (The Node backend's device-token/dev-user fallbacks are dev-only and
 * deliberately absent here.)
 */
export async function resolvePushUser({ headers, rest, supabaseUrl, anonKey, fetchImpl = fetch }: {
  headers: Headers;
  rest: SupabaseRest;
  supabaseUrl: string;
  anonKey: string;
  fetchImpl?: typeof fetch;
}) {
  const token = bearerToken(headers);
  if (!token) throw new IdentityError('authentication required');

  if (looksLikeJwt(token)) {
    const jwtUser = await lookupAuthUser({ accessToken: token, supabaseUrl, anonKey, fetchImpl });
    if (jwtUser) return jwtUser;
    throw new IdentityError('authentication required');
  }

  const tokenHash = hashIngestToken(token);
  const rows = await rest.select(
    'noop_ingest_tokens',
    `token_hash=eq.${tokenHash}&revoked_at=is.null&select=id,user_id,label,created_at,last_used_at,revoked_at`,
  );
  const row = rows?.[0];
  if (!row?.user_id) throw new IdentityError('authentication required');
  try {
    await rest.patch('noop_ingest_tokens', { last_used_at: new Date().toISOString() }, `id=eq.${row.id}`);
  } catch {
    // Push auth must not fail because a best-effort last_used_at write missed.
  }
  return { id: row.user_id as string, email: null, source: 'ingest_token', tokenId: row.id };
}

/** Public shape of an ingest-token row (never the hash). Mirrors the retired Node receiver */
export function publicIngestTokenRow(row: any): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label || '',
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || null,
    revokedAt: row.revoked_at || null,
  };
}

/**
 * Mint / list / revoke opaque `noop_` ingest tokens over the service-role REST client.
 * Port of the retired Node receiver createIngestTokenStore — the Edge half of the
 * token lifecycle that Phase 1 of the backend retirement adds (POST/GET/DELETE /tokens).
 */
/** Base64url (RFC 4648 §5) from raw bytes — mirrors Node Buffer.toString('base64url'). */
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createIngestTokenStore({ rest }: { rest: SupabaseRest }) {
  return {
    configured: rest.configured,
    async mint({ userId, label = '' }: { userId: string; label?: string }) {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const token = `${INGEST_TOKEN_PREFIX}${bytesToBase64Url(bytes)}`;
      const tokenHash = hashIngestToken(token);
      const rows = await rest.upsert('noop_ingest_tokens', {
        user_id: userId,
        token_hash: tokenHash,
        label: String(label || '').slice(0, 120),
      });
      const row = Array.isArray(rows) ? rows[0] : rows;
      return { token, row: publicIngestTokenRow(row) };
    },
    async list({ userId }: { userId: string }) {
      const rows = await rest.select(
        'noop_ingest_tokens',
        `user_id=eq.${userId}&order=created_at.desc&select=id,label,created_at,last_used_at,revoked_at`,
      );
      return (rows || []).map(publicIngestTokenRow);
    },
    async revoke({ userId, id }: { userId: string; id: string }) {
      const rows = await rest.patch(
        'noop_ingest_tokens',
        { revoked_at: new Date().toISOString() },
        `id=eq.${id}&user_id=eq.${userId}&revoked_at=is.null&select=id,label,created_at,last_used_at,revoked_at`,
      );
      const row = Array.isArray(rows) ? rows[0] : rows;
      return publicIngestTokenRow(row);
    },
  };
}
