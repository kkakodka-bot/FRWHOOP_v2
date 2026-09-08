function publicIntegrations(rows = []) {
  return (rows || []).map((row) => ({
    provider: row.provider,
    status: row.status || row.connection_status || 'disconnected',
    enabled: row.enabled !== false,
    authorizationStatus: row.authorization_status || row.authorizationStatus || null,
    connectionStatus: row.connection_status || row.connectionStatus || null,
    lastSyncStatus: row.last_sync_status || row.lastSyncStatus || null,
    lastSyncError: row.last_sync_error || row.lastSyncError || null,
    meta: row.meta && typeof row.meta === 'object' ? row.meta : {},
    connectedAt: row.connected_at || row.connectedAt || null,
    updatedAt: row.updated_at || row.updatedAt || null,
  }));
}

function ownActivities(store, userId) {
  return (store?.activities || []).filter((a) => a.userId === userId);
}

/**
 * Account export from canonical Postgres tables. Tokens and archive bodies
 * are omitted. Days come from the engine overlay for this user id.
 */
export async function loadCanonicalAccount({
  rest,
  userId,
  loadPersistedDays,
  loadStore,
} = {}) {
  const bundle = {
    exportedAt: new Date().toISOString(),
    app: { name: 'FRWHOOP' },
    userId,
    source: 'supabase',
    settings: null,
    profile: null,
    devices: [],
    integrations: [],
    calibrations: [],
    days: {},
    activities: [],
  };

  if (rest?.configured) {
    const [settings, profiles, devices, integrations, calibrations] = await Promise.all([
      rest.select('user_settings', `user_id=eq.${userId}&select=*`),
      rest.select('profiles', `id=eq.${userId}&select=*`),
      rest.select(
        'devices',
        `user_id=eq.${userId}&select=id,nickname,firmware,external_device_id,last_synced_at,last_sync_attempt_at,last_sync_status,last_sync_error,last_seen_at,is_active`,
      ),
      rest.select(
        'integration_connections',
        `user_id=eq.${userId}&select=provider,status,enabled,authorization_status,connection_status,last_sync_status,last_sync_error,meta,connected_at,updated_at`,
      ),
      rest.select('health_calibrations', `user_id=eq.${userId}&select=id,kind,systolic_mmhg,diastolic_mmhg,measured_at,is_current,created_at`),
    ]);
    bundle.settings = settings[0] || null;
    bundle.profile = profiles[0] || null;
    bundle.devices = devices;
    bundle.integrations = publicIntegrations(integrations);
    bundle.calibrations = calibrations;
  } else {
    bundle.source = 'host_store';
    const store = typeof loadStore === 'function' ? loadStore() : {};
    bundle.settings = store.prefs || {};
    bundle.profile = store.profile || {};
  }

  if (typeof loadPersistedDays === 'function') {
    try { bundle.days = await loadPersistedDays(userId) || {}; } catch { bundle.days = {}; }
  }
  if (typeof loadStore === 'function') {
    try { bundle.activities = ownActivities(loadStore(), userId); } catch { bundle.activities = []; }
  }
  return bundle;
}
