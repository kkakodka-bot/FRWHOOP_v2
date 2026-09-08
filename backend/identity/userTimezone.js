import { resolveTimeZone } from '../time/dayBoundary.js';

/**
 * Per-user IANA timezone. Stored instants stay UTC; day bounds use this zone.
 * The authenticated profile row is authoritative — not the process local store,
 * not FRWHOOP_LOCAL_USER_ID, and not the host's own TZ.
 */
export function createTimeZoneResolver({
  loadProfileTimeZone,
  fallback = 'UTC',
} = {}) {
  const cache = new Map();
  const TTL_MS = 60_000;

  function peek(userId) {
    const hit = userId ? cache.get(userId) : null;
    if (hit) return hit.tz;
    return resolveTimeZone(fallback);
  }

  function set(userId, name) {
    const tz = resolveTimeZone(name, fallback);
    if (userId) cache.set(userId, { tz, at: Date.now() });
    return tz;
  }

  async function ensure(userId) {
    if (!userId) return resolveTimeZone(fallback);
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.tz;
    if (typeof loadProfileTimeZone === 'function') {
      try {
        const loaded = await loadProfileTimeZone(userId);
        if (loaded) return set(userId, loaded);
      } catch {
        return hit?.tz || resolveTimeZone(fallback);
      }
    }
    return set(userId, fallback);
  }

  return { peek, set, ensure, get: peek };
}

export async function readProfileTimeZone({ rest, userId } = {}) {
  if (!userId || typeof rest !== 'function') return null;
  const rows = await rest('profiles', `id=eq.${encodeURIComponent(userId)}&select=timezone&limit=1`);
  const tz = Array.isArray(rows) ? rows[0]?.timezone : rows?.timezone;
  return tz ? String(tz).trim() : null;
}
