import { overlayPersistedDays, overlayHealthKitStore, mergeLiveIntoDays, mergeLiveSeriesIntoDays, fillHeadlineScores } from './whoopDays.js';
import { dayBounds, localDateKey } from '../time/dayBoundary.js';
import { loadChangedDays } from '../metrics/snapshot.js';
import { createSupabaseRest } from '../persistence/supabaseRest.js';
import { storageConfig } from '../storage/config.js';
import { recordWeightChange } from '../vo2/repository.js';
import { applyWorkoutRuntimePrefs, workoutRuntimeView } from './runtimePrefs.js';
import { capabilityReport } from '../signal/capability.js';
import { describeEstimators } from '../respiration/engine.js';
import { HRV_ALGORITHM, ALGORITHM_VERSION as HRV_VERSION } from '../hrv/engine.js';
import { ALGORITHM_VERSION as RESP_VERSION, FUSION_ALGORITHM } from '../respiration/constants.js';
import { inc, snapshot, liveIngestView } from '../observability/metrics.js';
import { resolveBatchId } from '../ingest/phoneBatch.js';

export function liveMotionOf(body = {}) {
  const values = [body.motion, body.phoneMotion, body.strapMotion]
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
  return values.length ? Math.max(...values) : null;
}

const PERMISSION_KINDS = new Set(['health', 'notifications', 'motion']);
// Delta catch-up horizon: a client whose cache is older than this is cheaper
// to reset with a full /api/days than to replay every change since.
const MAX_CHANGES_WINDOW_MS = 31 * 24 * 3600000;
const SEXES = new Set(['male', 'female', 'nonbinary']);
const CURRENT_YEAR = new Date().getFullYear();

export function defaultProfile() {
  let timezone = 'UTC';
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { /* Intl missing */ }
  return {
    sex: 'male',
    birthYear: CURRENT_YEAR - 30,
    heightCm: 178,
    weightKg: 75,
    timezone,
  };
}

export function defaultPermissions() {
  return {
    health: 'not_determined',
    notifications: 'not_determined',
    motion: 'not_determined',
  };
}

export function defaultBle() {
  return {
    supported: false,
    scanning: false,
    connected: false,
    bonded: false,
    encryptedBond: false,
    battery: null,
    firmware: null,
    hint: 'Bluetooth pairing is only available in the app on your phone.',
    status: 'Disconnected',
    discovered: [],
    model: 'WHOOP 4.0',
  };
}

/** Local day key for "yesterday" relative to `today`, DST-safe. */
function yesterdayKeyOf(today, timeZone) {
  if (!today) return null;
  try {
    return localDateKey(new Date(Date.parse(dayBounds(today, timeZone).day_start_at) - 3600000), timeZone);
  } catch { /* bad timezone */ return null; }
}

export function normalizeHostStore(store) {
  store.profile = { ...defaultProfile(), ...(store.profile && typeof store.profile === 'object' ? store.profile : {}) };
  store.permissions = { ...defaultPermissions(), ...(store.permissions && typeof store.permissions === 'object' ? store.permissions : {}) };
  store.ble = { ...defaultBle(), ...(store.ble && typeof store.ble === 'object' ? store.ble : {}) };
  store.ble.supported = false;
  store.ble.scanning = false;
  if (!store.ble.hint) store.ble.hint = defaultBle().hint;
  store.bleLive = store.bleLive && typeof store.bleLive === 'object' ? store.bleLive : null;
  return store;
}

function bleView(store) {
  const ble = { ...defaultBle(), ...(store.ble || {}) };
  ble.supported = false;
  ble.scanning = false;
  return ble;
}

async function userFrom(req, resolveUser) {
  if (typeof resolveUser !== 'function') return null;
  return resolveUser(req);
}

function zoneFor(user, store, timeZoneOf) {
  if (user?.id && typeof timeZoneOf === 'function') {
    try {
      const tz = timeZoneOf(user.id);
      if (tz) return tz;
    } catch { /* fall through */ }
  }
  return store?.profile?.timezone || 'UTC';
}

export function registerHostRoutes(app, {
  loadStore,
  saveStore,
  onLiveSample,
  onLiveSampleForUser,
  onLiveStatusForUser,
  onLiveGapsForUser,
  onLiveFramesForUser,
  onHistorySamplesForUser,
  onAnchorEvidence,
  onRangeEvidence,
  loadPersistedDays,
  loadPersistedSnapshots,
  loadLiveSamples,
  loadLiveForUser,
  loadIngestVerify,
  dayCompletenessForUser,
  historyDiagnosticsForUser,
  recomputeMetrics,
  finalizeForUser,
  finalizationForUser,
  detectionState,
  detectionStateForUser,
  resolveUser,
  onHapticResult,
  rest: restOverride,
  timeZoneOf,
  replayBatchAckForUser,
  rememberBatchAckForUser,
} = {}) {
  // /api/days/changes needs a service-role REST client. index.js wires the
  // shared restDb into snapshot routes directly, so fall back to a lazily
  // created client from storageConfig() (never constructed at import time).
  let changesRestDb = restOverride || null;
  let changesRestTried = Boolean(restOverride);

  function liveSnapshot(user) {
    if (user?.id && typeof loadLiveForUser === 'function') {
      return loadLiveForUser(user.id)
        || { connected: false, heartRate: null, battery: null, userId: user.id };
    }
    if (typeof resolveUser === 'function') {
      return { connected: false, heartRate: null, battery: null, userId: user?.id || null };
    }
    return loadStore().bleLive || { connected: false, heartRate: null, battery: null };
  }
  function changesRest() {
    if (!changesRestTried) {
      changesRestTried = true;
      try { changesRestDb = createSupabaseRest({ cfg: storageConfig() }); }
      catch { changesRestDb = null; }
    }
    return changesRestDb && changesRestDb.configured !== false ? changesRestDb : null;
  }

  app.get('/api/ingest/metrics', (_req, res) => {
    res.json(snapshot());
  });

  app.get('/api/days', async (req, res) => {
    try {
      let user = null;
      if (typeof resolveUser === 'function') {
        try { user = await userFrom(req, resolveUser); }
        catch (err) { return res.status(err.status || 401).json({ error: err.message || 'unauthorized' }); }
      }
      let days = {};
      if (typeof loadPersistedDays === 'function') {
        const owner = user?.id;
        if (owner || typeof resolveUser !== 'function') {
          days = overlayPersistedDays(days, await loadPersistedDays(owner).catch(() => ({})));
        }
      }
      const store = loadStore();
      const live = liveSnapshot(user);
      const tz = zoneFor(user, store, timeZoneOf);
      days = overlayHealthKitStore(days, store.healthkit, tz);
      const today = localDateKey(new Date(), tz);
      if (today && !days[today]) {
        days = overlayPersistedDays(days, {
          [today]: { physiological_summary: {}, sleep_summary: { Nap: false }, workouts: [], bpm_data: [] },
        });
      }
      if (typeof loadLiveSamples === 'function') {
        try {
          days = mergeLiveSeriesIntoDays(days, loadLiveSamples(user?.id) || [], tz);
        } catch { /* live series is best-effort */ }
      }
      if (live) days = mergeLiveIntoDays(days, live);
      days = fillHeadlineScores(days);
      // Payload gate: Overview charts draw only today + yesterday, but shipping
      // 21 days of 5-minute hr series cost ~430KB on every boot/poll/RT
      // invalidation. Older days omit bpm_data entirely (~45KB); a day-detail
      // chart loads its series on demand via the bounded get_day_snapshot RPC
      // (/api/days/snapshot). Stripping happens last so headline scoring still
      // sees the series it needs.
      const yesterday = yesterdayKeyOf(today, tz);
      const slimmedDays = {};
      for (const [key, day] of Object.entries(days || {})) {
        if (day && typeof day === 'object' && Array.isArray(day.bpm_data) && key !== today && key !== yesterday) {
          const { bpm_data: _olderCharts, ...withoutSeries } = day;
          slimmedDays[key] = withoutSeries;
        } else {
          slimmedDays[key] = day;
        }
      }
      days = slimmedDays;
      let snapshots = {};
      if (typeof loadPersistedSnapshots === 'function') {
        snapshots = await loadPersistedSnapshots(user?.id).catch(() => ({})) || {};
        const slimmedSnapshots = {};
        for (const [key, snap] of Object.entries(snapshots)) {
          if (snap && typeof snap === 'object' && Array.isArray(snap.chart) && key !== today && key !== yesterday) {
            const { chart: _olderChart, ...withoutSeries } = snap;
            slimmedSnapshots[key] = withoutSeries;
          } else {
            slimmedSnapshots[key] = snap;
          }
        }
        snapshots = slimmedSnapshots;
      }
      // Observability: how many days/bpm samples the frontend actually pulls.
      const dayKeys = Object.keys(days || {});
      if (dayKeys.length) inc('frontend_days_returned', dayKeys.length);
      const sampleTot = dayKeys.reduce((n, k) => n + (Array.isArray(days[k]?.bpm_data) ? days[k].bpm_data.length : 0), 0);
      if (sampleTot) inc('frontend_samples_returned', sampleTot);
      res.json({ days, snapshots, source: 'persisted', live: live || null, userId: user?.id || null });
    } catch (error) {
      res.status(500).json({ error: 'days unavailable' });
    }
  });

  /**
   * Startup delta feed for returning users. The client keeps its localStorage
   * days cache and the revision from GET /api/sync/revision; when the revision
   * moves it asks this endpoint what actually changed instead of re-downloading
   * the whole 21-day /api/days body. Only days with rows updated after `since`
   * come back, and each day carries only the sections that changed
   * (physiological_summary / sleep_summary / workouts / bpm_data), so an
   * invalidation that touched one workout transfers kilobytes, not 430KB.
   * Auth, live, and userId mirror /api/days exactly.
   */
  app.get('/api/days/changes', async (req, res) => {
    let user = null;
    if (typeof resolveUser === 'function') {
      try { user = await userFrom(req, resolveUser); }
      catch (err) { return res.status(err.status || 401).json({ error: err.message || 'unauthorized' }); }
    }
    const sinceMs = Date.parse(String(req.query?.since ?? ''));
    if (!Number.isFinite(sinceMs)) {
      return res.status(400).json({ error: 'since must be an ISO timestamp' });
    }
    if (Date.now() - sinceMs > MAX_CHANGES_WINDOW_MS) {
      return res.status(400).json({ error: 'since must be within the last 31 days' });
    }
    const dayRe = /^\d{4}-\d{2}-\d{2}$/;
    const fromParam = dayRe.test(String(req.query?.from || '')) ? String(req.query.from) : null;
    const toParam = dayRe.test(String(req.query?.to || '')) ? String(req.query.to) : null;
    const store = loadStore();
    const tz = zoneFor(user, store, timeZoneOf);
    const today = localDateKey(new Date(), tz);
    // Default window: the day of `since` and the one before it, through today.
    const fromDay = fromParam || localDateKey(new Date(sinceMs - 24 * 3600000), tz) || today;
    const toDay = toParam || today;
    if (fromDay > toDay) {
      return res.status(400).json({ error: 'from must not be after to' });
    }
    let changes = {};
    if (user?.id && typeof loadChangedDays === 'function') {
      const restDb = changesRest();
      if (restDb) {
        try {
          changes = await loadChangedDays({
            rest: restDb,
            userId: user.id,
            sinceIso: new Date(sinceMs).toISOString(),
            fromDay,
            toDay,
            timeZone: tz,
          });
        } catch {
          return res.status(500).json({ error: 'changes unavailable' });
        }
      }
    }
    const live = liveSnapshot(user);
    res.json({
      changes,
      live: live || null,
      userId: user?.id || null,
      serverTime: new Date().toISOString(),
    });
  });

  app.get('/api/profile', (_req, res) => {
    res.json(loadStore().profile);
  });

  app.post('/api/profile', (req, res) => {
    const body = req.body || {};
    const store = loadStore();
    const next = { ...store.profile };

    if (body.sex != null) {
      const sex = String(body.sex);
      if (!SEXES.has(sex)) return res.status(400).json({ error: 'sex must be male, female, or nonbinary' });
      next.sex = sex;
    }
    if (body.birthYear != null) {
      const birthYear = Number(body.birthYear);
      if (!Number.isFinite(birthYear) || birthYear < CURRENT_YEAR - 100 || birthYear > CURRENT_YEAR - 13) {
        return res.status(400).json({ error: 'birthYear out of range' });
      }
      next.birthYear = birthYear;
      store.prefs = { ...store.prefs, chronoAge: CURRENT_YEAR - birthYear };
    }
    if (body.heightCm != null) {
      const heightCm = Number(body.heightCm);
      if (!Number.isFinite(heightCm) || heightCm < 120 || heightCm > 230) {
        return res.status(400).json({ error: 'heightCm must be 120–230' });
      }
      next.heightCm = heightCm;
    }
    if (body.weightKg != null) {
      const weightKg = Number(body.weightKg);
      if (!Number.isFinite(weightKg) || weightKg < 30 || weightKg > 250) {
        return res.status(400).json({ error: 'weightKg must be 30–250' });
      }
      const prevWeight = Number(store.profile?.weightKg);
      next.weightKg = weightKg;
      if (!Number.isFinite(prevWeight) || Math.abs(prevWeight - weightKg) >= 0.05) {
        recordWeightChange(store, weightKg);
      }
    }
    if (body.leanBodyMassPct != null && body.leanBodyMassPct !== '') {
      const leanBodyMassPct = Number(body.leanBodyMassPct);
      if (!Number.isFinite(leanBodyMassPct) || leanBodyMassPct < 40 || leanBodyMassPct > 95) {
        return res.status(400).json({ error: 'leanBodyMassPct must be 40–95' });
      }
      next.leanBodyMassPct = leanBodyMassPct;
    }
    if (body.leanBodyMassPct === null) next.leanBodyMassPct = null;
    if (body.vo2Max != null && body.vo2Max !== '') {
      const vo2Max = Number(body.vo2Max);
      if (!Number.isFinite(vo2Max) || vo2Max < 12 || vo2Max > 85) {
        return res.status(400).json({ error: 'vo2Max must be 12–85' });
      }
      next.vo2Max = vo2Max;
      next.vo2MaxSource = 'user_entered';
    }
    if (body.vo2Max === null) {
      next.vo2Max = null;
      next.vo2MaxSource = null;
    }
    if (body.timezone != null) {
      const timezone = String(body.timezone).trim();
      try {
        Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
      } catch {
        return res.status(400).json({ error: 'timezone must be a valid IANA name' });
      }
      next.timezone = timezone;
    }

    store.profile = next;
    saveStore(store);
    res.json(store.profile);
  });

  app.get('/api/permissions', (_req, res) => {
    res.json(loadStore().permissions);
  });

  app.post('/api/permissions', (req, res) => {
    const kind = String(req.body?.kind || '');
    if (!PERMISSION_KINDS.has(kind)) {
      return res.status(400).json({ error: 'kind must be health, notifications, or motion' });
    }
    const store = loadStore();
    store.permissions = { ...store.permissions, [kind]: 'granted' };
    saveStore(store);
    res.json(store.permissions);
  });

  app.get('/api/ble/state', (_req, res) => {
    res.json(bleView(loadStore()));
  });

  app.post('/api/ble/scan', (req, res) => {
    const store = loadStore();
    const model = String(req.body?.model || store.ble?.model || 'WHOOP 4.0');
    store.ble = { ...bleView(store), model };
    saveStore(store);
    res.json(store.ble);
  });

  app.post('/api/ble/stop', (_req, res) => {
    res.json(bleView(loadStore()));
  });

  app.post('/api/haptic', (req, res) => {
    const style = String(req.body?.style || 'light');
    res.json({ ok: true, style });
  });

  app.post('/api/host/runtime', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const store = loadStore();
    store.prefs = applyWorkoutRuntimePrefs(store.prefs || {}, body);
    saveStore(store);
    res.json(workoutRuntimeView(store.prefs));
  });

  app.get('/api/ble/live', async (req, res) => {
    let user = null;
    if (typeof resolveUser === 'function') {
      try { user = await userFrom(req, resolveUser); }
      catch (err) { return res.status(err.status || 401).json({ error: err.message || 'unauthorized' }); }
      if (!user?.id) return res.status(401).json({ error: 'unauthorized' });
    }
    res.json(liveSnapshot(user));
  });

  app.post('/api/ble/live', async (req, res) => {
    let user = null;
    if (typeof resolveUser === 'function') {
      try { user = await userFrom(req, resolveUser); }
      catch (err) { return res.status(err.status || 401).json({ error: err.message || 'unauthorized' }); }
    }
    const body = req.body || {};
    const diag = body.diag && typeof body.diag === 'object' ? body.diag : null;
    if (user?.id && diag && typeof onRangeEvidence === 'function') {
      const oldest = Date.parse(diag.data_range_oldest ?? '');
      const newest = Date.parse(diag.data_range_newest ?? '');
      const probed = Date.parse(diag.data_range_at ?? '');
      const watermarks = diag.history_watermarks && typeof diag.history_watermarks === 'object'
        ? diag.history_watermarks
        : {};
      try {
        onRangeEvidence(user.id, {
          data_range_oldest: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
          data_range_newest: Number.isFinite(newest) ? new Date(newest).toISOString() : null,
          data_range_at: Number.isFinite(probed)
            ? new Date(probed).toISOString()
            : (Number.isFinite(oldest) || Number.isFinite(newest) ? new Date().toISOString() : null),
          range_trustworthy: Number.isFinite(oldest) && Number.isFinite(newest),
          phone_physiology_frontier_ts: diag.phone_history_contiguous_frontier_ts
            ?? watermarks.queue_newest
            ?? diag.phone_history_newest_sensor_ts
            ?? null,
          phone_raw_notify_at: diag.last_notify_at || diag.last_custom_notify_at || null,
          raw_type47_newest: watermarks.raw_type47_newest || diag.raw_type47_newest || null,
          last_type40_at: diag.last_type40 || diag.last_custom_hr_at || null,
        });
      } catch { /* telemetry */ }
    }
    const heartRate = body.heartRate == null ? null : Number(body.heartRate);
    const battery = body.battery == null ? null : Number(body.battery);
    const motion = liveMotionOf(body);
    const phoneMotion = Number(body.phoneMotion);
    const strapMotion = Number(body.strapMotion);
    const live = {
      connected: Boolean(body.connected),
      heartRate: Number.isFinite(heartRate) ? heartRate : null,
      battery: Number.isFinite(battery) ? battery : null,
      deviceId: body.deviceId ? String(body.deviceId) : null,
      name: body.name ? String(body.name) : null,
      firmware: body.firmware ? String(body.firmware) : null,
      motion,
      phoneMotion: Number.isFinite(phoneMotion) ? phoneMotion : null,
      strapMotion: Number.isFinite(strapMotion) ? strapMotion : null,
      phoneMotionLive: body.phoneMotionLive === true,
      at: body.at || new Date().toISOString(),
    };
    if (body.haptic && typeof onHapticResult === 'function') {
      try { onHapticResult(user?.id, body.haptic); } catch { /* telemetry is best-effort */ }
    }
    const samplesProvided = Array.isArray(body.samples);
    const incoming = samplesProvided
      ? body.samples.map((sample, i, arr) => ({
        ...live,
        ...sample,
        motion: Number.isFinite(Number(sample?.motion)) ? Number(sample.motion) : live.motion,
        phoneMotion: Number.isFinite(Number(sample?.phoneMotion)) ? Number(sample.phoneMotion) : live.phoneMotion,
        strapMotion: Number.isFinite(Number(sample?.strapMotion)) ? Number(sample.strapMotion) : live.strapMotion,
        phoneMotionLive: sample?.phoneMotionLive === true || live.phoneMotionLive,
        nativeV2: i === arr.length - 1
          ? (sample?.nativeV2 || sample?.native_v2 || (body.nativeV2 && typeof body.nativeV2 === 'object' ? body.nativeV2 : null))
          : sample?.nativeV2 || sample?.native_v2,
      }))
      : (Number.isFinite(heartRate) ? [{ ...live, bpm: heartRate, datetime: live.at, motion }] : []);
    const gaps = Array.isArray(body.gaps) ? body.gaps : [];
    const incomingFrames = Array.isArray(body.frames) ? body.frames : [];
    const incomingHistory = Array.isArray(body.historySamples) ? body.historySamples : [];
    const batchId = resolveBatchId(req.headers || {}, body);
    if (batchId && user?.id && typeof replayBatchAckForUser === 'function') {
      const hit = replayBatchAckForUser(user.id, batchId);
      if (hit && typeof hit === 'object') {
        if (user?.id && typeof onLiveStatusForUser === 'function') {
          try { onLiveStatusForUser(user.id, live); } catch { /* live snapshot is best-effort */ }
        }
        return res.json({
          ...live,
          userId: user.id,
          batch_id: batchId,
          ...hit,
        });
      }
    }
    const historyProvided = Array.isArray(body.historySamples)
      || body.historyComplete != null
      || body.history_complete != null;
    let ackedThrough = 0;
    let framesAckedThrough = 0;
    let framesPersisted = 0;
    let historyResult = {
      accepted: 0,
      durable: 0,
      rejected: incomingHistory.length,
      ackedThrough: null,
      affectedDays: [],
      historyComplete: false,
    };
    if (user?.id && typeof onLiveStatusForUser === 'function') {
      // `live` itself is spread into every persisted sample, so the strap-flash
      // drain telemetry is attached only to the status snapshot. It makes a
      // wedged history cycle visible from the host.
      const status = body.history && typeof body.history === 'object'
        ? { ...live, history: body.history }
        : live;
      try { onLiveStatusForUser(user.id, status); } catch { /* live snapshot is best-effort */ }
    }
    if (user?.id && typeof onLiveFramesForUser === 'function') {
      for (const frame of incomingFrames) {
        try {
          onLiveFramesForUser(user.id, frame);
          framesPersisted += 1;
          const seq = Number(frame?.seq);
          if (Number.isFinite(seq) && seq > framesAckedThrough) framesAckedThrough = seq;
        } catch {
          break;
        }
      }
    }
    if (historyProvided && user?.id && typeof onHistorySamplesForUser === 'function') {
      try {
        // Live-evidence anchor feed: the phone's posted GET_DATA_RANGE newest
        // banked stamp (banking-clock domain) and the newest live wall time in
        // the same POST (correct domain). Two spaced probes with a stable lag
        // prove a misdated banking clock; see historyBuffer's anchor MARK.
        if (typeof onAnchorEvidence === 'function') {
          const diag = body.diag && typeof body.diag === 'object' ? body.diag : null;
          const rangeNewest = diag ? Date.parse(diag.data_range_newest ?? '') : NaN;
          const liveWall = incoming.reduce((acc, s) => {
            const t = Date.parse(s?.datetime || s?.t || s?.at || '');
            return Number.isFinite(t) && t > acc ? t : acc;
          }, -Infinity);
          if (Number.isFinite(rangeNewest) && Number.isFinite(liveWall)) {
            onAnchorEvidence(user.id, rangeNewest, liveWall);
          }
        }
        historyResult = await onHistorySamplesForUser(user.id, incomingHistory.map((sample) => ({
          ...sample,
          deviceId: sample?.deviceId || live.deviceId,
          battery: sample?.battery ?? live.battery,
        })), {
          historyComplete: Boolean(body.historyComplete ?? body.history_complete),
        }) || historyResult;
      } catch {
        // No history acknowledgement: the phone retains and retries its queue.
      }
    }
    if (user?.id && typeof onLiveSampleForUser === 'function') {
      if (typeof onLiveGapsForUser === 'function' && gaps.length) {
        try { onLiveGapsForUser(user.id, gaps); } catch { /* persist is best-effort */ }
      }
      let ackBroken = false;
      let acceptedCount = 0;
      for (const sample of incoming) {
        // Ack only a contiguous accepted prefix. The phone deletes rows with
        // seq <= acked_through, so a later accepted sample must never cover an
        // earlier one whose persist failed: stop advancing once any sample in
        // the batch is rejected (same contract as historyBuffer's prefix ack).
        let accepted = false;
        try { onLiveSampleForUser(user.id, sample); accepted = true; }
        catch { /* persist is best-effort; do not ack */ }
        if (!accepted) { ackBroken = true; continue; }
        acceptedCount += 1;
        if (!ackBroken) {
          const seq = Number(sample?.seq);
          if (Number.isFinite(seq) && seq > ackedThrough) ackedThrough = seq;
        }
      }
      const ackBody = {
        persisted: acceptedCount,
        acked_through: ackedThrough || null,
        frames_persisted: framesPersisted,
        frames_acked_through: framesAckedThrough || null,
        history_persisted: historyResult.accepted || 0,
        history_durable: historyResult.durable || 0,
        history_rejected: historyResult.rejected || 0,
        history_acked_through: historyResult.ackedThrough ?? null,
        history_affected_days: historyResult.affectedDays || [],
        history_complete: Boolean(historyResult.historyComplete),
        history_contiguous_through: historyResult.history_contiguous_through
          ?? (typeof historyDiagnosticsForUser === 'function'
            ? historyDiagnosticsForUser(user.id)?.history_contiguous_through
            : null)
          ?? null,
        history_queue_depth: historyResult.history_queue_depth
          ?? (typeof historyDiagnosticsForUser === 'function'
            ? historyDiagnosticsForUser(user.id)?.history_queue_depth
            : null)
          ?? null,
        history_progress_revision: historyResult.history_progress_revision
          ?? (typeof historyDiagnosticsForUser === 'function'
            ? historyDiagnosticsForUser(user.id)?.history_progress_revision
            : null)
          ?? null,
      };
      if (batchId && typeof rememberBatchAckForUser === 'function') {
        try { rememberBatchAckForUser(user.id, batchId, ackBody); } catch { /* replay is optional */ }
      }
      const detection = typeof detectionStateForUser === 'function'
        ? detectionStateForUser(user.id, { consumeBuzz: true })
        : null;
      return res.json({
        ...live,
        userId: user.id,
        batch_id: batchId || undefined,
        ...ackBody,
        day_completeness: typeof dayCompletenessForUser === 'function'
          ? (dayCompletenessForUser(user.id) || null)
          : null,
        live_ingest: liveIngestView(),
        ...(detection ? { detection } : {}),
      });
    }
    const store = loadStore();
    store.bleLive = live;
    saveStore(store);
    if (typeof onLiveSample === 'function') {
      for (const sample of incoming) {
        try { onLiveSample(sample); } catch { /* persist is best-effort */ }
      }
    }
    const detection = typeof detectionState === 'function' ? detectionState({ consumeBuzz: true }) : null;
    res.json({
      ...live,
      persisted: incoming.length,
      acked_through: ackedThrough || null,
      frames_persisted: framesPersisted,
      frames_acked_through: framesAckedThrough || null,
      history_persisted: 0,
      history_durable: 0,
      history_rejected: incomingHistory.length,
      history_acked_through: null,
      history_affected_days: [],
      history_complete: false,
      history_contiguous_through: null,
      history_queue_depth: null,
      history_progress_revision: null,
      live_ingest: liveIngestView(),
      ...(detection ? { detection } : {}),
    });
  });

  app.get('/api/ingest/verify', async (req, res) => {
    let user = null;
    if (typeof resolveUser === 'function') {
      try { user = await userFrom(req, resolveUser); }
      catch (err) { return res.status(err.status || 401).json({ error: err.message || 'unauthorized' }); }
    }
    if (typeof loadIngestVerify !== 'function') {
      return res.status(503).json({ error: 'ingest_verify_unavailable' });
    }
    try {
      const dayParam = typeof req.query?.day === 'string' ? req.query.day : undefined;
      res.json(await loadIngestVerify(user?.id, dayParam));
    } catch (err) {
      if (err?.code === 'ingest_verify_unavailable') {
        // Loud failure: historical completeness must never come back as a
        // clean-looking empty day when manifest access or the service role is
        // unavailable.
        return res.status(503).json({
          error: 'ingest_verify_manifest_unavailable',
          replay_available: false,
          detail: err.message || 'manifest access unavailable',
        });
      }
      res.status(500).json({ error: 'ingest_verify_failed' });
    }
  });

  /**
   * What this deployment can actually measure, and what it cannot.
   *
   * Exists so the client never has to infer capability from a null. A metric
   * that is absent because the hardware channel does not reach the backend is a
   * different thing from one that is absent because last night's data was noisy,
   * and only the first is permanent. Static and unauthenticated: it describes
   * the build, not a user.
   */
  app.get('/api/sensors/capability', (_req, res) => {
    const report = capabilityReport();
    const respiration = describeEstimators();
    res.json({
      signals: report,
      metrics: {
        heart_rate: { available: true, algorithm: 'device_reported', version: null },
        resting_heart_rate: { available: true, algorithm: 'sleep_noop_v2', version: HRV_VERSION },
        hrv_rmssd: {
          available: true,
          algorithm: HRV_ALGORITHM,
          version: HRV_VERSION,
          requires: ['rr_intervals'],
          note: 'Measured from RR intervals inside the detected sleep window. '
            + 'Absent on nights where the strap reported no RR intervals.',
        },
        respiratory_rate: {
          available: true,
          algorithm: FUSION_ALGORITHM,
          version: RESP_VERSION,
          requires: ['rr_intervals'],
          experimental: true,
          mechanisms_available: respiration.availableCount,
          mechanisms_total: respiration.total,
          note: 'One of four mechanisms is live. The three PPG-derived estimators '
            + 'need a raw waveform that does not reach the backend.',
        },
        skin_temperature: {
          available: false,
          requires: ['skin_temperature'],
          missing: report.reachable.includes('skin_temperature')
            ? [{ signal: 'skin_temperature', unlock: 'historical_offload' }]
            : [],
        },
        blood_oxygen: {
          available: false,
          requires: ['spo2'],
          missing: [{ signal: 'spo2', unlock: 'historical_offload' }],
        },
      },
      estimators: { respiration: respiration.estimators },
    });
  });

  /**
   * Foreground catch-up. The morning path: the app calls this as soon as it is
   * foregrounded and overnight finalization is unresolved. The backend flushes
   * any pending history, reconciles ready raw manifests against the latest
   * successful metric runs, and returns the explicit per-day states. Safe to
   * call repeatedly; idempotent by input fingerprint.
   */
  app.post('/api/metrics/finalize', async (req, res) => {
    if (typeof finalizeForUser !== 'function') {
      return res.status(503).json({ error: 'finalization_unavailable' });
    }
    let user = null;
    if (typeof resolveUser === 'function') {
      try { user = await userFrom(req, resolveUser); }
      catch (err) { return res.status(err.status || 401).json({ error: err.message || 'unauthorized' }); }
    }
    try {
      const days = Array.isArray(req.body?.days)
        ? req.body.days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        : undefined;
      const result = await finalizeForUser(user?.id, {
        days: days && days.length ? days : undefined,
        trigger: 'foreground_catch_up',
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      const detail = String(error?.message || '')
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .slice(0, 160);
      res.status(500).json({ error: 'finalize_failed', detail });
    }
  });

  /** Explicit finalization states for a day (or every tracked day). */
  app.get('/api/metrics/finalization', async (req, res) => {
    if (typeof finalizationForUser !== 'function') {
      return res.status(503).json({ error: 'finalization_unavailable' });
    }
    let user = null;
    if (typeof resolveUser === 'function') {
      try { user = await userFrom(req, resolveUser); }
      catch (err) { return res.status(err.status || 401).json({ error: err.message || 'unauthorized' }); }
    }
    try {
      const dayParam = typeof req.query?.day === 'string' ? req.query.day : undefined;
      res.json(await finalizationForUser(user?.id, dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : undefined));
    } catch {
      res.status(500).json({ error: 'finalization_state_unavailable' });
    }
  });

  app.post('/api/metrics/recompute', async (req, res) => {
    if (typeof recomputeMetrics !== 'function') {
      return res.status(503).json({ error: 'metrics_unavailable' });
    }
    let user = null;
    if (typeof resolveUser === 'function') {
      try { user = await userFrom(req, resolveUser); }
      catch (err) { return res.status(err.status || 401).json({ error: err.message || 'unauthorized' }); }
    }
    try {
      const result = await recomputeMetrics(user?.id, {
        days: Array.isArray(req.body?.days) ? req.body.days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : undefined,
        fromDay: typeof req.body?.fromDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.fromDay)
          ? req.body.fromDay
          : undefined,
        toDay: typeof req.body?.toDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.toDay)
          ? req.body.toDay
          : undefined,
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      console.error('metrics_recompute_failed:', error?.stack || error?.message || error);
      res.status(500).json({ error: 'recompute_failed' });
    }
  });
}
