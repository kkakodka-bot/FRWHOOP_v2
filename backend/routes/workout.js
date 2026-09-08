/**
 * Workout surfaces: real-time workout detection, workout runtime prefs, and
 * strength-session capture.
 *
 * Route blocks were extracted verbatim from backend/index.js; the registration
 * order below matches the original inline order. Middleware such as
 * `app.use('/api/workout-detection', hostAuth)` is applied in index.js before
 * this factory runs, so nothing here re-authorizes.
 */

export function registerWorkoutRoutes(app, {
  requestUser,
  userRuntimes,
  loadStore,
  saveStore,
  writeRuntimePrefs,
} = {}) {
  app.get('/api/workout-detection/state', async (req, res) => {
    const user = await requestUser(req, res);
    if (!user) return;
    try {
      res.json(userRuntimes.detectorOf(user.id).state());
    } catch {
      res.status(500).json({ error: 'detector_unavailable' });
    }
  });

  app.post('/api/workout-detection/dismiss', async (req, res) => {
    const user = await requestUser(req, res);
    if (!user) return;
    try {
      res.json(userRuntimes.detectorOf(user.id).dismiss());
    } catch {
      res.status(500).json({ error: 'detector_unavailable' });
    }
  });

  app.post('/api/workout-detection/end', async (req, res) => {
    const user = await requestUser(req, res);
    if (!user) return;
    try {
      const reason = req.body?.reason === 'automatic' ? 'automatic' : 'manual';
      res.json(userRuntimes.detectorOf(user.id).end({ reason }));
    } catch {
      res.status(500).json({ error: 'detector_unavailable' });
    }
  });

  app.post('/api/workout-detection/mode-started', async (req, res) => {
    const user = await requestUser(req, res);
    if (!user) return;
    try {
      res.json(userRuntimes.detectorOf(user.id).markModeStarted());
    } catch {
      res.status(500).json({ error: 'detector_unavailable' });
    }
  });

  app.post('/api/workout-detection/live-activity', async (req, res) => {
    const user = await requestUser(req, res);
    if (!user) return;
    try {
      res.json(userRuntimes.detectorOf(user.id).markLiveActivityStarted());
    } catch {
      res.status(500).json({ error: 'detector_unavailable' });
    }
  });

  app.post('/api/workout-detection/haptic', async (req, res) => {
    const user = await requestUser(req, res);
    if (!user) return;
    try {
      res.json(userRuntimes.detectorOf(user.id).reportHaptic(Boolean(req.body?.ok ?? req.body?.succeeded)));
    } catch {
      res.status(500).json({ error: 'detector_unavailable' });
    }
  });

  app.post('/api/workout-detection/correct', async (req, res) => {
    const user = await requestUser(req, res);
    if (!user) return;
    try {
      const body = req.body || {};
      const startTs = body.startTs != null ? Number(body.startTs) : (body.start ? Date.parse(body.start) : null);
      const endTs = body.endTs != null ? Number(body.endTs) : (body.end ? Date.parse(body.end) : null);
      const row = userRuntimes.detectorOf(user.id).editWorkout({
        workoutId: body.workoutId || body.id,
        startTs: Number.isFinite(startTs) ? startTs : null,
        endTs: Number.isFinite(endTs) ? endTs : null,
        sport: body.sport || body.userType || null,
        action: body.action || 'edited',
      });
      res.json(row);
    } catch {
      res.status(500).json({ error: 'detector_unavailable' });
    }
  });

  app.get('/api/prefs', (_req, res) => {
    const prefs = loadStore().prefs || {};
    res.json({
      autoWorkoutDetect: prefs.autoWorkoutDetect !== false,
      hapticAlerts: prefs.hapticAlerts !== false,
    });
  });

  // The app re-hints these flags every couple of seconds. Saving an unchanged
  // store on each one rewrites the cache file and enqueues a cloud op, so only
  // write on a real change. writeRuntimePrefs is defined in index.js (it is
  // shared with the inline POST /api/host/runtime route) and passed in here.
  app.post('/api/prefs', writeRuntimePrefs);

  function sanitizeExercises(list) {
    return (Array.isArray(list) ? list : []).map((ex) => ({
      id: ex.id || crypto.randomUUID(),
      name: String(ex.name || 'Exercise').trim().slice(0, 80) || 'Exercise',
      bodyweight: Boolean(ex.bodyweight),
      sets: (Array.isArray(ex.sets) ? ex.sets : []).map((s) => ({
        reps: Math.max(0, Math.round(Number(s.reps) || 0)),
        weightLb: s.weightLb == null || s.weightLb === '' ? null : Math.max(0, Number(s.weightLb)),
        restSec: s.restSec == null || s.restSec === '' ? null : Math.max(0, Math.round(Number(s.restSec) || 0)),
      })),
    }));
  }

  app.get('/api/strength-sessions', (req, res) => {
    const { date, activityId } = req.query;
    let rows = Object.values(loadStore().strengthSessions || {});
    if (date) rows = rows.filter((s) => s.date === date);
    if (activityId) rows = rows.filter((s) => s.activityId === activityId);
    res.json(rows);
  });

  app.get('/api/strength-sessions/:activityId', (req, res) => {
    const row = loadStore().strengthSessions?.[req.params.activityId];
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  });

  app.put('/api/strength-sessions/:activityId', (req, res) => {
    const { date, routineName, exercises } = req.body || {};
    if (!date || !Array.isArray(exercises)) {
      return res.status(400).json({ error: 'date and exercises are required' });
    }
    const store = loadStore();
    const session = {
      activityId: req.params.activityId,
      date,
      routineName: String(routineName || 'ROUTINE').trim().slice(0, 40) || 'ROUTINE',
      exercises: sanitizeExercises(exercises),
      updatedAt: new Date().toISOString(),
    };
    store.strengthSessions[req.params.activityId] = session;
    saveStore(store);
    res.json(session);
  });

  app.delete('/api/strength-sessions/:activityId', (req, res) => {
    const store = loadStore();
    if (!store.strengthSessions?.[req.params.activityId]) return res.status(404).json({ error: 'not found' });
    delete store.strengthSessions[req.params.activityId];
    saveStore(store);
    res.json({ ok: true });
  });
}
