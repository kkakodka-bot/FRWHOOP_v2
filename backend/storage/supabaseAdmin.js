export async function createSupabaseAdmin({ url, anonKey, serviceRoleKey, fetchImpl = fetch }) {
  const rest = (path, { method = 'GET', jwt, service = false, body, query, prefer } = {}) => {
    const headers = {
      apikey: service ? serviceRoleKey : anonKey,
      authorization: `Bearer ${service ? serviceRoleKey : jwt}`,
    };
    if (body != null) headers['content-type'] = 'application/json';
    if (prefer) headers.prefer = prefer;
    const q = query ? `?${query}` : '';
    return fetchImpl(`${url}/rest/v1/${path}${q}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
  };

  return {
    async getUser(jwt) {
      if (!jwt) return null;
      const res = await fetchImpl(`${url}/auth/v1/user`, {
        headers: { apikey: anonKey, authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) return null;
      const user = await res.json();
      return user?.id ? { id: user.id } : null;
    },
    async getDevice(userId, deviceId) {
      const res = await rest('devices', {
        service: true,
        query: `id=eq.${deviceId}&user_id=eq.${userId}&select=id,user_id`,
      });
      if (!res.ok) return null;
      const rows = await res.json();
      return rows[0] || null;
    },
    async insertSensorObject(row) {
      const res = await rest('sensor_objects', {
        service: true,
        method: 'POST',
        body: row,
        prefer: 'return=representation',
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error('manifest insert failed');
      }
      const rows = await res.json();
      return rows[0];
    },
    async findDuplicateObject({ userId, deviceId, kind, sha256, startAt, endAt }) {
      if (!sha256) return null;
      const query = [
        `user_id=eq.${userId}`,
        `device_id=eq.${deviceId}`,
        `object_kind=eq.${kind}`,
        `sha256=eq.${sha256}`,
        `start_at=eq.${encodeURIComponent(startAt)}`,
        `end_at=eq.${encodeURIComponent(endAt)}`,
        'select=id,status,object_key,content_type,compressed_bytes,sha256',
        'order=created_at.desc',
        'limit=1',
      ].join('&');
      const res = await rest('sensor_objects', { service: true, query });
      if (!res.ok) return null;
      const rows = await res.json();
      return rows[0] || null;
    },
    async getSensorObject(id) {
      const res = await rest('sensor_objects', {
        service: true,
        query: `id=eq.${id}&select=*`,
      });
      if (!res.ok) return null;
      const rows = await res.json();
      return rows[0] || null;
    },
    async updateSensorObject(id, patch) {
      const res = await rest('sensor_objects', {
        service: true,
        method: 'PATCH',
        query: `id=eq.${id}`,
        body: patch,
        prefer: 'return=representation',
      });
      if (!res.ok) throw new Error('manifest update failed');
      const rows = await res.json();
      return rows[0];
    },
    async listSensorObjects(userId) {
      const res = await rest('sensor_objects', {
        service: true,
        query: `user_id=eq.${userId}&select=*`,
      });
      if (!res.ok) return [];
      return res.json();
    },
    async listExpiredReady(nowIso) {
      const res = await rest('sensor_objects', {
        service: true,
        query: `status=eq.ready&expires_at=lte.${encodeURIComponent(nowIso)}&select=id,object_key,expires_at,status`,
      });
      if (!res.ok) return [];
      return res.json();
    },
    async markPrivacyDeletionRequested(userId) {
      const res = await rest('profiles', {
        service: true,
        method: 'PATCH',
        query: `id=eq.${userId}`,
        body: { privacy_state: { deletion_requested: true, deletion_requested_at: new Date().toISOString() } },
      });
      return res.ok;
    },
    async deleteAuthUser(userId) {
      const res = await fetchImpl(`${url}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` },
      });
      if (res.status === 404) return { deleted: true, missing: true };
      if (!res.ok) throw new Error('auth user delete failed');
      return { deleted: true, missing: false };
    },
    async loadExportBundle(userId) {
      const tables = ['profiles', 'devices', 'daily_metrics', 'sessions', 'events', 'sensor_objects'];
      const out = {};
      for (const table of tables) {
        const col = table === 'profiles' ? 'id' : 'user_id';
        const res = await rest(table, {
          service: true,
          query: `${col}=eq.${userId}&select=*`,
        });
        out[table] = res.ok ? await res.json() : [];
      }
      return out;
    },
  };
}
