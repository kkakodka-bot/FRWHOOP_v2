/**
 * Daily-life surfaces: journal entries, alarms, community feed, weekly plan,
 * and longevity settings. All persist into the user store via loadStore /
 * saveStore; defaultCommunity / round1 / normalizeSchedule are module-local
 * helpers that moved with the routes they serve.
 *
 * Route blocks were extracted verbatim from backend/index.js and registered
 * in the same relative order they had inline.
 */

export function registerJournalRoutes(app, {
  loadStore,
  saveStore,
} = {}) {
  app.get('/api/journal', (req, res) => {
    const { date } = req.query;
    const rows = loadStore().journal;
    if (date) {
      return res.json(rows.find((r) => r.date === date) || { date, behaviors: {}, metrics: {} });
    }
    res.json(rows);
  });

  app.post('/api/journal', (req, res) => {
    const { date, key, value, behaviors, metrics } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date is required' });
    const store = loadStore();
    let row = store.journal.find((r) => r.date === date);
    if (!row) {
      row = { date, behaviors: {}, metrics: {}, updatedAt: new Date().toISOString() };
      store.journal.push(row);
    }
    if (behaviors && typeof behaviors === 'object') {
      row.behaviors = { ...row.behaviors, ...behaviors };
    }
    if (metrics && typeof metrics === 'object') {
      row.metrics = { ...(row.metrics || {}), ...metrics };
    }
    if (key) row.behaviors[key] = Boolean(value);
    row.updatedAt = new Date().toISOString();
    saveStore(store);
    res.json(row);
  });

  function normalizeSchedule(days) {
    if (!Array.isArray(days)) return [0, 1, 2, 3, 4, 5, 6];
    return [...new Set(days.map(Number).filter((n) => n >= 0 && n <= 6))].sort((a, b) => a - b);
  }

  app.get('/api/alarms', (_req, res) => {
    res.json(loadStore().alarms || []);
  });

  app.post('/api/alarms', (req, res) => {
    const { wakeTime, haptic, smartWake, schedule, recoveryGoal, sleepMode } = req.body || {};
    if (!wakeTime || !/^\d{2}:\d{2}$/.test(String(wakeTime))) {
      return res.status(400).json({ error: 'wakeTime (HH:MM) is required' });
    }
    const store = loadStore();
    const row = {
      id: crypto.randomUUID(),
      wakeTime,
      haptic: haptic !== false,
      smartWake: smartWake !== false,
      schedule: normalizeSchedule(schedule),
      recoveryGoal: Math.max(1, Math.min(100, Number(recoveryGoal) || 66)),
      sleepMode: sleepMode || store.prefs?.sleepMode || 'PEAK',
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    store.alarms = [row, ...(store.alarms || []).slice(0, 19)];
    store.prefs = {
      ...store.prefs,
      wakeTime: row.wakeTime,
      hapticAlarm: row.haptic,
      smartWake: row.smartWake,
      sleepSchedule: row.schedule,
      recoveryGoal: row.recoveryGoal,
      sleepMode: row.sleepMode,
      alarmEnabled: true,
    };
    saveStore(store);
    res.status(201).json(row);
  });

  function defaultCommunity() {
    const member = (id, name, recovery, strain, sleepMin, highlight, followed, spark) => ({
      id, name, recovery, strain, sleepMin, highlight, followed: Boolean(followed),
      sparkRecovery: spark[0], sparkStrain: spark[1], sparkSleep: spark[2],
      lastWeek: {
        recovery: Math.max(20, recovery - 4),
        strain: round1(Math.max(4, strain - 0.8)),
        sleepMin: Math.max(300, sleepMin - 18),
      },
      month: {
        recovery: Math.max(20, recovery - 2),
        strain: round1(strain - 0.3),
        sleepMin: Math.max(300, sleepMin - 8),
      },
    });
    const spark = (a, b, c) => [a, b, c];
    return {
      team: {
        name: 'WHOOP SQUAD',
        motto: 'Building better habits, together.',
      },
      members: [
        member('alex', 'Alex M.', 81, 12.8, 476, 'sleep', true, spark([74, 76, 79, 80, 78, 82, 81], [11, 12, 14, 13, 12, 13, 12.8], [450, 460, 470, 468, 472, 480, 476])),
        member('sam', 'Sam R.', 69, 14.1, 445, 'strain', false, spark([66, 68, 70, 67, 71, 69, 69], [13, 14, 15, 14, 13, 14, 14.1], [420, 430, 440, 438, 442, 448, 445])),
        member('jordan', 'Jordan K.', 74, 11.6, 432, 'recovery', false, spark([70, 72, 73, 71, 75, 74, 74], [10, 11, 12, 12, 11, 12, 11.6], [410, 418, 425, 428, 430, 434, 432])),
        member('taylor', 'Taylor S.', 64, 15.2, 418, 'sleep', false, spark([60, 62, 63, 65, 64, 66, 64], [14, 15, 16, 15, 14, 15, 15.2], [400, 405, 412, 410, 416, 420, 418])),
        member('morgan', 'Morgan L.', 78, 10.4, 451, 'recovery', true, spark([72, 74, 76, 77, 75, 79, 78], [9, 10, 11, 10, 10, 11, 10.4], [430, 438, 444, 448, 450, 452, 451])),
        member('chris', 'Chris D.', 71, 14.2, 428, 'strain', true, spark([68, 69, 70, 72, 71, 73, 71], [13, 14, 15, 14, 13, 14, 14.2], [410, 418, 422, 424, 426, 430, 428])),
        member('jamie', 'Jamie P.', 76, 12.1, 451, 'sleep', false, spark([72, 73, 75, 74, 77, 76, 76], [11, 12, 13, 12, 12, 12, 12.1], [430, 438, 444, 446, 448, 452, 451])),
        member('riley', 'Riley B.', 83, 9.8, 488, 'recovery', false, spark([78, 80, 81, 82, 80, 84, 83], [8, 9, 10, 10, 9, 10, 9.8], [460, 470, 478, 480, 484, 490, 488])),
        member('casey', 'Casey W.', 67, 13.6, 404, 'strain', false, spark([64, 65, 66, 68, 67, 69, 67], [12, 13, 14, 14, 13, 14, 13.6], [390, 396, 400, 398, 402, 406, 404])),
        member('avery', 'Avery H.', 72, 12.4, 439, 'sleep', false, spark([68, 70, 71, 73, 72, 74, 72], [11, 12, 13, 12, 12, 13, 12.4], [420, 428, 432, 434, 436, 440, 439])),
        member('drew', 'Drew P.', 70, 11.2, 422, 'recovery', false, spark([66, 68, 69, 71, 70, 72, 70], [10, 11, 12, 11, 11, 11, 11.2], [400, 408, 414, 416, 418, 424, 422])),
      ],
    };
  }

  function round1(n) {
    return Math.round(Number(n) * 10) / 10;
  }

  app.get('/api/community', (req, res) => {
    if (String(req.query.demo) === '1') {
      const demo = defaultCommunity();
      return res.json({
        team: { ...demo.team, memberCount: demo.members.length, demo: true },
        members: demo.members.map((m) => ({ ...m, source: 'demo' })),
        available: false,
        demo: true,
      });
    }
    const community = loadStore().community || {};
    const demoIds = new Set(['alex', 'sam', 'jordan', 'taylor', 'morgan', 'chris', 'jamie', 'riley', 'casey', 'avery', 'drew']);
    const members = (community.members || []).filter((m) => m && m.source !== 'demo' && !demoIds.has(m.id));
    res.json({
      team: members.length ? { ...community.team, memberCount: members.length } : null,
      members,
      available: members.length > 0,
    });
  });

  app.post('/api/community/follow', (req, res) => {
    const { id, followed } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id is required' });
    const store = loadStore();
    const member = store.community.members.find((m) => m.id === id);
    if (!member) return res.status(404).json({ error: 'member not found' });
    member.followed = Boolean(followed);
    saveStore(store);
    res.json(member);
  });

  app.get('/api/weekly-plan', (_req, res) => {
    res.json(loadStore().weeklyPlan);
  });

  app.post('/api/weekly-plan', (req, res) => {
    const b = req.body || {};
    const store = loadStore();
    const p = store.weeklyPlan;
    if (b.sleepGoalMin != null) {
      const n = Number(b.sleepGoalMin);
      if (!Number.isFinite(n) || n < 180 || n > 720) return res.status(400).json({ error: 'sleepGoalMin must be 180–720' });
      p.sleepGoalMin = n;
    }
    if (b.strainGoalAvg != null) {
      const n = Number(b.strainGoalAvg);
      if (!Number.isFinite(n) || n < 4 || n > 21) return res.status(400).json({ error: 'strainGoalAvg must be 4–21' });
      p.strainGoalAvg = n;
    }
    if (b.recoveryDaysGoal != null) {
      const n = Number(b.recoveryDaysGoal);
      if (!Number.isFinite(n) || n < 0 || n > 7) return res.status(400).json({ error: 'recoveryDaysGoal must be 0–7' });
      p.recoveryDaysGoal = n;
    }
    const patchDay = (weekStart, date, row) => {
      if (!weekStart || !date || !row) return;
      const week = p.weeks[weekStart] || { days: {} };
      week.days[date] = { ...week.days[date], ...row, date };
      p.weeks[weekStart] = week;
      if (row.completed === true && !p.completedDates.includes(date)) p.completedDates.push(date);
      if (row.completed === false) p.completedDates = p.completedDates.filter((d) => d !== date);
    };
    if (b.weekStart && b.day?.date) patchDay(b.weekStart, b.day.date, b.day);
    if (b.weekStart && b.days && typeof b.days === 'object') {
      for (const [date, row] of Object.entries(b.days)) {
        if (row && typeof row === 'object') patchDay(b.weekStart, date, row);
      }
    }
    saveStore(store);
    res.json(p);
  });

  app.get('/api/longevity', (_req, res) => {
    res.json(loadStore().longevity);
  });

  app.post('/api/longevity', (req, res) => {
    const b = req.body || {};
    const store = loadStore();
    const L = store.longevity;
    if (b.bedtimeWindowStart) L.bedtimeWindowStart = String(b.bedtimeWindowStart).slice(0, 5);
    if (b.bedtimeWindowEnd) L.bedtimeWindowEnd = String(b.bedtimeWindowEnd).slice(0, 5);
    if (b.caffeineCutoff) L.caffeineCutoff = String(b.caffeineCutoff).slice(0, 5);
    if (b.zone2GoalPerWeek != null) {
      const n = Number(b.zone2GoalPerWeek);
      if (!Number.isFinite(n) || n < 1 || n > 7) return res.status(400).json({ error: 'zone2GoalPerWeek must be 1–7' });
      L.zone2GoalPerWeek = n;
    }
    if (b.bedtimeLog?.date) L.bedtimeLogs[b.bedtimeLog.date] = Boolean(b.bedtimeLog.inWindow);
    if (b.caffeineLog?.date) L.caffeineLogs[b.caffeineLog.date] = Boolean(b.caffeineLog.avoided);
    saveStore(store);
    res.json(L);
  });
}
