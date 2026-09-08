import { storageConfig } from '../storage/config.js';
import { cloudRowToDay } from './days.js';

export function createCloudReader({ accessToken, fetchImpl = fetch, config = storageConfig() } = {}) {
  if (!accessToken || !config.supabaseUrl || !config.supabaseAnonKey) return null;
  if (/service_role/i.test(accessToken) || /service_role/i.test(config.supabaseAnonKey)) return null;

  const rpc = async (name, body) => {
    const res = await fetchImpl(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: config.supabaseAnonKey,
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return res.json();
  };

  return {
    async getDay(day) {
      if (!day) return null;
      const payload = await rpc('get_frwhoop_day', { for_day: day });
      if (!payload || !payload.metrics) return null;
      return cloudRowToDay(payload);
    },
    async getRange(fromDay, toDay, limit = 14) {
      const rows = await rpc('get_frwhoop_range', { from_day: fromDay, to_day: toDay });
      if (!Array.isArray(rows) || !rows.length) return null;
      return rows.slice(0, limit).map((row) => cloudRowToDay({ ...row, source: 'cloud' }));
    },
  };
}
