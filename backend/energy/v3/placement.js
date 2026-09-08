/**
 * Wear location as event-time metadata.
 *
 * Placement is not a mutable global. A toggle at T1 must not reinterpret
 * samples with t < T1. Replay uses the stamp on the sample, else the last
 * event with `at <= sample.t`, else wrist + legacy_default.
 *
 * Never apply a calorie multiplier by placement. RMR / HRmax / VO2max / kcal
 * conversion stay placement-independent.
 */

export const WEAR_WRIST = 'wrist';
export const WEAR_BICEP = 'bicep';
export const WEAR_LOCATIONS = Object.freeze([WEAR_WRIST, WEAR_BICEP]);
export const WEAR_SOURCE_USER = 'user';
export const WEAR_SOURCE_LEGACY = 'legacy_default';

export function normalizeWearLocation(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === WEAR_BICEP) return WEAR_BICEP;
  if (v === WEAR_WRIST) return WEAR_WRIST;
  return null;
}

export function normalizeWearSource(value) {
  return value === WEAR_SOURCE_LEGACY ? WEAR_SOURCE_LEGACY : WEAR_SOURCE_USER;
}

export function normalizeEvents(events) {
  if (!Array.isArray(events)) return [];
  const out = [];
  for (const e of events) {
    const location = normalizeWearLocation(e?.location);
    const atMs = Date.parse(e?.at || '');
    if (!location || !Number.isFinite(atMs)) continue;
    out.push({ at: new Date(atMs).toISOString(), location });
  }
  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return out;
}

/** Append-only. Same location as the last event is a no-op. Never rewrites past rows. */
export function appendWearLocationEvent(events, location, now = new Date()) {
  const loc = normalizeWearLocation(location);
  const out = normalizeEvents(events);
  if (!loc) return out;
  const last = out[out.length - 1];
  if (last?.location === loc) return out;
  const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  if (!Number.isFinite(Date.parse(at))) return out;
  if (last && Date.parse(at) < Date.parse(last.at)) return out;
  out.push({ at, location: loc });
  return out;
}

/**
 * Append-only merge. Incoming events never rewrite or drop earlier rows.
 * Backdated incoming rows are ignored. Truncated replacement lists cannot
 * erase history already in `existing`.
 */
export function mergeWearLocationEvents(existing, incoming) {
  const out = normalizeEvents(existing);
  for (const e of normalizeEvents(incoming)) {
    const t = Date.parse(e.at);
    const last = out[out.length - 1];
    if (last && t < Date.parse(last.at)) continue;
    if (last?.location === e.location) continue;
    out.push(e);
  }
  return out;
}

function lastEventAtOrBefore(events, ms) {
  if (!Number.isFinite(ms)) return null;
  const list = normalizeEvents(events);
  let best = null;
  for (const e of list) {
    const t = Date.parse(e.at);
    if (t <= ms) best = e;
    else break;
  }
  return best;
}

/**
 * Resolve placement for one sample / minute.
 *
 * `current` is intentionally unused: applying the live toggle to unstamped
 * history is the retrospective-mutation bug this module exists to prevent.
 */
export function resolveWearLocation({ sample = null, events = [], t = null } = {}) {
  const stamped = normalizeWearLocation(sample?.wear_location ?? sample?.wearLocation);
  if (stamped) {
    const raw = sample?.wear_location_source ?? sample?.wearLocationSource;
    return {
      location: stamped,
      source: raw === WEAR_SOURCE_LEGACY ? WEAR_SOURCE_LEGACY : WEAR_SOURCE_USER,
    };
  }
  const ms = Date.parse(t || sample?.t || sample?.datetime || sample?.at || '');
  const covering = lastEventAtOrBefore(events, ms);
  if (covering) return { location: covering.location, source: WEAR_SOURCE_USER };
  return { location: WEAR_WRIST, source: WEAR_SOURCE_LEGACY };
}

/** Stamp a NEW live row from the user's current setting. History must omit this. */
export function stampLiveWearLocation(current) {
  const loc = normalizeWearLocation(current);
  if (!loc) return null;
  return { wear_location: loc, wear_location_source: WEAR_SOURCE_USER };
}

export function parseWearLocationFromArchive(value) {
  return normalizeWearLocation(value);
}
