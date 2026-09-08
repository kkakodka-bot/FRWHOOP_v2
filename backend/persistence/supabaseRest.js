import { storageConfig } from '../storage/config.js';

function restHeaders(cfg) {
  return {
    apikey: cfg.supabaseServiceRoleKey,
    authorization: `Bearer ${cfg.supabaseServiceRoleKey}`,
    'content-type': 'application/json',
    prefer: 'return=representation',
  };
}

export function createSupabaseRest({ cfg = storageConfig(), fetchImpl = fetch } = {}) {
  const url = cfg.supabaseUrl;
  const configured = Boolean(url && cfg.supabaseServiceRoleKey);

  async function request(path, { method = 'GET', body, query, prefer, schema } = {}) {
    if (!configured) throw new Error('supabase_service_role_required');
    const headers = restHeaders(cfg);
    if (prefer) headers.prefer = prefer;
    if (schema) headers['content-profile'] = schema;
    const q = query ? `?${query}` : '';
    const res = await fetchImpl(`${url}/rest/v1/${path}${q}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
    if (!res.ok) {
      const msg = typeof json === 'string' ? json : (json?.message || json?.hint || text);
      const err = new Error(`${method} ${path} failed (${res.status}) ${String(msg || '').slice(0, 180)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  return {
    configured,
    request,
    async upsert(table, rows, { onConflict, prefer } = {}) {
      const list = Array.isArray(rows) ? rows : [rows];
      if (!list.length) return [];
      return request(table, {
        method: 'POST',
        body: list.length === 1 ? list[0] : list,
        prefer: prefer || `resolution=merge-duplicates,return=representation${onConflict ? '' : ''}`,
        query: onConflict ? `on_conflict=${encodeURIComponent(onConflict)}` : undefined,
      });
    },
    async select(table, query) {
      const rows = await request(table, { query: query || 'select=*' });
      return Array.isArray(rows) ? rows : [];
    },
    async delete(table, query) {
      return request(table, { method: 'DELETE', query });
    },
    async patch(table, body, query) {
      return request(table, { method: 'PATCH', body, query });
    },
    async rpc(name, args) {
      return request(`rpc/${name}`, { method: 'POST', body: args || {} });
    },
    async adminDeleteAuthUser(userId) {
      const res = await fetchImpl(`${url}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: {
          apikey: cfg.supabaseServiceRoleKey,
          authorization: `Bearer ${cfg.supabaseServiceRoleKey}`,
        },
      });
      if (res.status === 404) return { deleted: true, missing: true };
      if (!res.ok) throw new Error(`auth delete failed (${res.status})`);
      return { deleted: true, missing: false };
    },
  };
}
