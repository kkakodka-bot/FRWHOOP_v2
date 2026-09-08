/**
 * Energy HTTP surface.
 *
 * Reads are served from Supabase where it is configured, because the rollups
 * there are authoritative and already aggregated — a phone should never pull 1440
 * minute rows to draw a chart a few hundred pixels wide. When Supabase is not
 * configured, or for the current in-progress day whose minutes have not been
 * flushed yet, the same engine runs locally over the live buffer and the result is
 * labelled `provisional` so the client can tell the difference.
 *
 * B2 objects are never exposed here.
 */

import { computeEnergy } from './service.js';
import { MODEL_VERSION } from './constants.js';
import { localDateKey } from '../time/dayBoundary.js';
import { mergeSamples } from './sampleSource.js';

const RANGE_WINDOWS = { '7d': 7, '30d': 30, '3m': 91, '6m': 183, '1y': 366 };

function isDay(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A supplied-but-invalid date parameter is an error, not a cue to substitute
 * today: answering a different question than the one asked is worse than
 * refusing, because the caller cannot tell the difference.
 */
function dayParam(value, fallback) {
  if (value == null || value === '') return { day: fallback };
  if (!isDay(value)) return { error: 'invalid_day' };
  return { day: String(value) };
}

function shiftDay(day, deltaDays) {
  const ms = Date.parse(`${day}T00:00:00Z`) + deltaDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * @param {object} deps
 * @param {Function} deps.requestUser        resolves the JWT subject, or responds 401
 * @param {Function} deps.energyContextFor   (userId) => { profile, prefs, workouts, days, calibration, timeZone }
 * @param {Function} deps.liveSamplesFor     (userId) => raw samples still in the live buffer
 * @param {object}   [deps.rpc]              { call(name, args, req) } forwarding the caller's JWT
 * @param {Function} [deps.localSamplesForDay] (userId, day) => samples, for the
 *   offline/no-Supabase fallback. Reads the per-day NDJSON the hour buffer
 *   already maintains, so no new storage is introduced.
 */
export function registerEnergyRoutes(app, {
  requestUser,
  energyContextFor,
  liveSamplesFor,
  localSamplesForDay,
  rpc,
} = {}) {
  function samplesForDay(userId, day, tz) {
    const live = (liveSamplesFor?.(userId) || []).filter(
      (s) => localDateKey(s.datetime || s.t || s.at, tz) === day,
    );
    const local = localSamplesForDay?.(userId, day) || [];
    // Union, never "live wins": a thin in-memory tail must not hide the day file.
    return mergeSamples(live, local);
  }

  async function confirmedRpc(name, args, req) {
    if (!rpc) return null;
    try {
      return await rpc.call(name, args, req);
    } catch {
      // Device-token sessions have no Supabase JWT. A failed rollup must not
      // hide the local engine — that is the number Overview actually shows.
      return null;
    }
  }

  /** Recompute the requested day from the live buffer or the local day file. */
  async function provisionalDay(userId, day) {
    const ctx = await energyContextFor(userId);
    const tz = ctx?.timeZone || 'UTC';
    const samples = samplesForDay(userId, day, tz);
    if (!samples.length) return null;
    const result = computeEnergy({
      samples,
      userId,
      timeZone: tz,
      profile: ctx?.profile,
      prefs: ctx?.prefs,
      days: ctx?.days,
      workouts: ctx?.workouts,
      calibration: ctx?.calibration,
    });
    const daily = result.daily.find((d) => d.day === day) || null;
    return {
      day,
      state: 'provisional',
      daily,
      workouts: result.workouts,
      live: result.live,
      // 15-minute buckets, matching what get_energy_day returns, so the client
      // renders one shape whichever source answered.
      buckets: bucket15(result.minutes),
      model_version: MODEL_VERSION,
    };
  }

  app.get('/api/energy/day', async (req, res) => {
    const user = await requestUser(req, res);
    if (!user) return;
    const ctx = await energyContextFor(user.id);
    const today = localDateKey(new Date(), ctx?.timeZone || 'UTC');
    const parsed = dayParam(req.query.day, today);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { day } = parsed;
    try {
      const confirmed = await confirmedRpc('get_energy_day', { p_day: day }, req);
      if (confirmed?.daily) {
        // Today keeps its provisional tail: the confirmed rollup only covers
        // minutes already flushed to B2 and Supabase. A thin confirmed rollup
        // for any day is also recomputed locally so HealthKit-sized stubs
        // cannot hide energy-v1.
        const confirmedCov = Number(confirmed.daily?.coverage_minutes) || 0;
        const shouldRecompute = day === today || confirmedCov < 600;
        const provisional = shouldRecompute
          ? await provisionalDay(user.id, day).catch(() => null)
          : null;
        const provisionalCov = Number(provisional?.daily?.coverage_minutes) || 0;
        // A stale confirmed rollup must not hide a richer local recompute.
        if (provisional?.daily && provisionalCov > confirmedCov) {
          return res.json({
            ...confirmed,
            ...provisional,
            state: day === today ? 'mixed' : 'provisional',
            model_version: MODEL_VERSION,
          });
        }
        return res.json({
          ...confirmed,
          state: provisional ? 'mixed' : 'confirmed',
          live: provisional?.live || null,
          model_version: MODEL_VERSION,
        });
      }
      const local = await provisionalDay(user.id, day);
      if (!local) return res.json({ day, state: 'empty', daily: null, workouts: [], buckets: [], live: null });
      return res.json(local);
    } catch (error) {
      return res.status(503).json({ error: 'energy_unavailable', message: String(error.message || error) });
    }
  });

  app.get('/api/energy/range', async (req, res) => {
    const user = await requestUser(req, res);
    if (!user) return;
    const ctx = await energyContextFor(user.id);
    const tz = ctx?.timeZone || 'UTC';
    const toParsed = dayParam(req.query.to, localDateKey(new Date(), tz));
    if (toParsed.error) return res.status(400).json({ error: toParsed.error });
    const to = toParsed.day;
    const window = RANGE_WINDOWS[String(req.query.window || '')];
    const fromParsed = dayParam(req.query.from, shiftDay(to, -(window ?? 30) + 1));
    if (fromParsed.error) return res.status(400).json({ error: fromParsed.error });
    const from = fromParsed.day;
    if (from > to) return res.status(400).json({ error: 'invalid_range' });
    try {
      const data = await confirmedRpc('get_energy_range', { p_from: from, p_to: to }, req);
      if (data?.days?.length) return res.json({ ...data, state: 'confirmed', model_version: MODEL_VERSION });
      const days = await localRange(user.id, from, to, ctx);
      return res.json({ from, to, days, state: days.length ? 'provisional' : 'empty', model_version: MODEL_VERSION });
    } catch (error) {
      return res.status(503).json({ error: 'energy_unavailable', message: String(error.message || error) });
    }
  });

  /**
   * Offline trends from the local day files the hour buffer already keeps.
   *
   * Capped at 62 days: this recomputes minute-by-minute from raw samples, so an
   * uncapped year would be a multi-second request. Longer windows are a Supabase
   * job, which is what the confirmed path above is for.
   */
  async function localRange(userId, from, to, ctx) {
    if (!localSamplesForDay) return [];
    const tz = ctx?.timeZone || 'UTC';
    const out = [];
    let day = from;
    for (let i = 0; i < 62 && day <= to; i += 1) {
      const samples = localSamplesForDay(userId, day) || [];
      if (samples.length) {
        const result = computeEnergy({
          samples,
          userId,
          timeZone: tz,
          profile: ctx?.profile,
          prefs: ctx?.prefs,
          workouts: ctx?.workouts,
          calibration: ctx?.calibration,
        });
        const row = result.daily.find((d) => d.day === day);
        if (row) out.push(row);
      }
      day = shiftDay(day, 1);
    }
    return out;
  }

  app.get('/api/energy/workout/:id', async (req, res) => {
    const user = await requestUser(req, res);
    if (!user) return;
    // Rejected here rather than relying on Postgres to fail the cast: a bad id is
    // a client bug, and a 400 says so without spending a round trip.
    if (!UUID_RE.test(String(req.params.id || ''))) {
      return res.status(400).json({ error: 'invalid_session_id' });
    }
    try {
      if (!rpc) return res.status(503).json({ error: 'energy_unavailable' });
      const data = await rpc.call('get_energy_workout', { p_session_id: req.params.id }, req);
      if (!data?.workout) return res.status(404).json({ error: 'not_found' });
      return res.json({ ...data, state: 'confirmed', model_version: MODEL_VERSION });
    } catch (error) {
      return res.status(503).json({ error: 'energy_unavailable', message: String(error.message || error) });
    }
  });
}

/** Collapse a minute series into 15-minute buckets for charting. */
export function bucket15(minutes) {
  const out = new Map();
  for (const m of minutes || []) {
    const ms = Date.parse(m.minute_at);
    const key = new Date(Math.floor(ms / 900_000) * 900_000).toISOString();
    const b = out.get(key) || { t: key, total_kcal: 0, active_kcal: 0, _met: 0, _conf: 0, n: 0 };
    b.total_kcal += m.resting_kcal + m.active_kcal;
    b.active_kcal += m.active_kcal;
    b._met += m.met;
    b._conf += m.model_confidence;
    b.n += 1;
    out.set(key, b);
  }
  return [...out.values()]
    .sort((a, b) => a.t.localeCompare(b.t))
    .map(({ _met, _conf, ...b }) => ({
      ...b,
      total_kcal: Math.round(b.total_kcal * 100) / 100,
      active_kcal: Math.round(b.active_kcal * 100) / 100,
      met: Math.round((_met / b.n) * 100) / 100,
      confidence: Math.round((_conf / b.n) * 100) / 100,
    }));
}
