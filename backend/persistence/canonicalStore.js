import { randomUUID } from 'node:crypto';
import {
  eventsFromStore,
  measurementsFromStore,
  sessionsFromStore,
  profileRow,
  encodeIntegrationSecrets,
  applyIntegrations,
  writeCacheFile,
  readCacheFile,
} from './domainMap.js';

/**
 * Canonical application store. Memory + reconstructible cache file.
 * Supabase is the durable owner. The cache may disappear.
 */
export function createCanonicalStore({
  rest,
  userId: initialUserId,
  cachePath,
  emptyStore,
  normalize,
  credentialsKey,
  queue,
  demoCommunity,
} = {}) {
  let mem = normalize(emptyStore());
  let userId = initialUserId || '';

  function setUserId(id) {
    userId = id || '';
  }

  function load() {
    return mem;
  }

  function persistDomains(store, ownerId = userId) {
    if (!rest?.configured || !ownerId) return;
    const enqueue = (op) => {
      if (queue?.enqueue) queue.enqueue(op);
    };
    if (store.profile?.userId === ownerId) {
      enqueue({ type: 'profile', row: profileRow(store, ownerId), userId: ownerId });
    }
    const events = eventsFromStore(store, ownerId);
    if (events.length) enqueue({ type: 'events_upsert', rows: events, userId: ownerId });
    const measurements = measurementsFromStore(store, ownerId);
    if (measurements.length) enqueue({ type: 'measurements_upsert', rows: measurements, userId: ownerId });
    const sessions = sessionsFromStore(store, ownerId);
    if (sessions.length) enqueue({ type: 'sessions_upsert', rows: sessions, userId: ownerId });
    if (store.ownerUserId === ownerId) {
      const integrations = encodeIntegrationSecrets(store, credentialsKey);
      for (const row of integrations) {
        enqueue({ type: 'integration.upsert', provider: row.provider, row, userId: ownerId });
      }
    }
    if (store.functionalAge?.latest && store.functionalAge.latest.userId === ownerId) {
      enqueue({
        type: 'algorithm_result',
        row: {
          user_id: ownerId,
          algorithm: 'functional_age',
          version: store.functionalAge.latest.version || '1',
          result: store.functionalAge.latest,
          computed_at: store.functionalAge.latest.at || new Date().toISOString(),
        },
      });
    }
  }

  function saveMemory(store) {
    mem = normalize(store);
    if (demoCommunity && (!mem.community?.members || mem.community.members.length === 0)) {
      mem.community = demoCommunity();
    }
    if (cachePath) writeCacheFile(cachePath, mem);
    return mem;
  }

  function save(store) {
    saveMemory(store);
    persistDomains(mem);
    return mem;
  }

  function enqueueOwnedEvent(row, eventType) {
    if (!rest?.configured || !row?.userId || !row?.id) return;
    queue?.enqueue?.({
      type: 'events_upsert',
      userId: row.userId,
      rows: [{
        id: row.id,
        user_id: row.userId,
        event_type: eventType,
        occurred_at: row.date || row.at || row.createdAt || new Date().toISOString(),
        source: 'manual',
        text_value: row.feeling || row.kind || row.note || null,
        payload: row,
      }],
    });
  }

  function enqueueOwnedSession(row) {
    if (!rest?.configured || !row?.userId || !row?.id) return;
    const sessions = sessionsFromStore({ activities: [row] }, row.userId);
    if (!sessions.length) return;
    queue?.enqueue?.({
      type: 'sessions_upsert',
      userId: row.userId,
      rows: sessions,
    });
  }

  function hydrateFromCache() {
    const cached = cachePath ? readCacheFile(cachePath) : null;
    mem = normalize({ ...emptyStore(), ...(cached || {}) });
    if (demoCommunity && (!mem.community?.members || !mem.community.members.length)) {
      mem.community = demoCommunity();
    }
    return mem;
  }

  async function hydrateFromCloud() {
    if (!rest?.configured || !userId) return mem;
    try {
      const settingsRows = await rest.select('user_settings', `user_id=eq.${userId}&select=auto_workout_detect,haptic_alerts_enabled,updated_at`);
      if (settingsRows[0]) {
        mem.prefs = {
          ...(mem.prefs || {}),
          autoWorkoutDetect: settingsRows[0].auto_workout_detect !== false,
          hapticAlerts: settingsRows[0].haptic_alerts_enabled !== false,
        };
      }

      const profiles = await rest.select('profiles', `id=eq.${userId}&select=*`);
      if (profiles[0]) {
        mem.profile = {
          ...mem.profile,
          userId,
          sex: profiles[0].sex_model || mem.profile.sex,
          heightCm: profiles[0].height_cm ?? mem.profile.heightCm,
          weightKg: profiles[0].weight_kg ?? mem.profile.weightKg,
          timezone: profiles[0].timezone || mem.profile.timezone,
        };
      }

      const events = await rest.select('events', `user_id=eq.${userId}&select=*&order=occurred_at.desc&limit=500`);
      mem.journal = events.filter((e) => e.event_type === 'journal').map((e) => e.payload || e);
      mem.checkIns = events.filter((e) => e.event_type === 'check_in').map((e) => ({
        ...(e.payload || e),
        userId: e.user_id,
      }));
      mem.captures = events.filter((e) => e.event_type === 'capture').map((e) => ({
        ...(e.payload || e),
        userId: e.user_id,
      }));

      const sessions = await rest.select('sessions', `user_id=eq.${userId}&select=*`);
      mem.activities = sessions
        .filter((s) => s.kind !== 'sleep' && s.kind !== 'nap' && s.kind !== 'strength_workout')
        .map((s) => ({ id: s.id, ...s.summary, start: s.start_at, end: s.end_at, kind: s.kind }));
      mem.strengthSessions = Object.fromEntries(
        sessions.filter((s) => s.kind === 'strength_workout').map((s) => [s.external_id?.replace(/^strength:/, '') || s.id, { id: s.id, ...s.summary, start: s.start_at, end: s.end_at }]),
      );

      const bp = await rest.select('measurements', `user_id=eq.${userId}&metric_type=eq.blood_pressure&select=*`).catch(() => []);
      mem.bpReadings = bp.map((m) => ({ id: m.id, ...(m.metadata || {}), at: m.measured_at, systolic: m.value }));

      const integrations = await rest.select('integration_connections', `user_id=eq.${userId}&select=*`).catch(() => []);
      const creds = await rest.select('integration_credentials', `user_id=eq.${userId}&select=*`).catch(() => []);
      const merged = integrations.map((row) => ({
        ...row,
        ciphertext: creds.find((c) => c.provider === row.provider)?.ciphertext,
      }));
      applyIntegrations(mem, merged, credentialsKey);
      mem.ownerUserId = userId;

      if (cachePath) writeCacheFile(cachePath, mem);
    } catch {
      // cache remains
    }
    return mem;
  }

  async function migrateLocalIfNeeded() {
    const cached = cachePath ? readCacheFile(cachePath) : null;
    if (!cached || !rest?.configured) return { migrated: false };
    persistDomains(normalize({ ...emptyStore(), ...cached }), userId);
    return { migrated: true };
  }

  return {
    load,
    save,
    saveMemory,
    enqueueOwnedEvent,
    enqueueOwnedSession,
    hydrateFromCache,
    hydrateFromCloud,
    migrateLocalIfNeeded,
    setUserId,
    newId: () => randomUUID(),
  };
}
