import crypto from 'node:crypto';

export const INGEST_TOKEN_PREFIX = 'noop_';

const TOKEN_BYTES = 32;

export function looksLikeJwt(token) {
  const parts = String(token || '').split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

export function hashIngestToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

export function generateIngestToken() {
  return `${INGEST_TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

export function publicIngestTokenRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label || '',
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || null,
    revokedAt: row.revoked_at || null,
  };
}

export function createIngestTokenStore({ rest } = {}) {
  if (!rest?.configured) {
    return {
      configured: false,
      async mint() { throw new Error('ingest_token_store_unconfigured'); },
      async list() { throw new Error('ingest_token_store_unconfigured'); },
      async revoke() { throw new Error('ingest_token_store_unconfigured'); },
      async resolve() { return null; },
    };
  }

  return {
    configured: true,
    async mint({ userId, label = '' } = {}) {
      const token = generateIngestToken();
      const tokenHash = hashIngestToken(token);
      const rows = await rest.upsert('noop_ingest_tokens', {
        user_id: userId,
        token_hash: tokenHash,
        label: String(label || '').slice(0, 120),
      });
      const row = Array.isArray(rows) ? rows[0] : rows;
      return { token, row: publicIngestTokenRow(row) };
    },

    async list({ userId } = {}) {
      const rows = await rest.select(
        'noop_ingest_tokens',
        `user_id=eq.${userId}&order=created_at.desc&select=id,label,created_at,last_used_at,revoked_at`,
      );
      return (rows || []).map(publicIngestTokenRow);
    },

    async revoke({ userId, id } = {}) {
      const now = new Date().toISOString();
      const rows = await rest.patch(
        'noop_ingest_tokens',
        { revoked_at: now },
        `id=eq.${id}&user_id=eq.${userId}&revoked_at=is.null&select=id,label,created_at,last_used_at,revoked_at`,
      );
      const row = Array.isArray(rows) ? rows[0] : rows;
      return publicIngestTokenRow(row);
    },

    async resolve(bearerToken) {
      const token = String(bearerToken || '').trim();
      if (!token || looksLikeJwt(token)) return null;
      const tokenHash = hashIngestToken(token);
      const rows = await rest.select(
        'noop_ingest_tokens',
        `token_hash=eq.${tokenHash}&revoked_at=is.null&select=id,user_id,label,created_at,last_used_at,revoked_at`,
      );
      const row = rows?.[0];
      if (!row?.user_id) return null;
      const now = new Date().toISOString();
      try {
        await rest.patch('noop_ingest_tokens', { last_used_at: now }, `id=eq.${row.id}`);
      } catch {
        // Push auth must not fail because a best-effort last_used_at write missed.
      }
      return { id: row.user_id, source: 'ingest_token', tokenId: row.id };
    },
  };
}
