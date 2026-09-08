/**
 * Debounced async score queue per user. Archives land immediately; scoring
 * (persistComputed + recomputeFromStorage / finalizer) coalesces by day.
 */
export function createScoreScheduler({
  engine,
  finalizer = null,
  markDaysDirty = null,
  debounceMs = 2000,
  scoreAsync = true,
  zoneOf = () => 'UTC',
  deviceOf = () => ({}),
  captureDayCompleteness = () => {},
} = {}) {
  const users = new Map();

  function stateFor(userId) {
    if (!users.has(userId)) {
      users.set(userId, {
        chain: Promise.resolve(),
        pendingDays: new Set(),
        lastTrigger: null,
        historyComplete: false,
        cycleId: null,
        liveScoreJobs: [],
        timer: null,
      });
    }
    return users.get(userId);
  }

  async function runScoreJob(userId, st) {
    const days = [...st.pendingDays].sort();
    const trigger = st.historyComplete
      ? 'history_complete'
      : (st.lastTrigger || 'recompute');
    const cycleId = st.cycleId;
    const liveJobs = st.liveScoreJobs.splice(0);
    st.pendingDays.clear();
    st.lastTrigger = null;
    st.historyComplete = false;
    st.cycleId = null;
    clearTimeout(st.timer);
    st.timer = null;

    if (!days.length && !liveJobs.length) return;

    const tz = zoneOf(userId);
    const device = deviceOf(userId);

    for (const liveScore of liveJobs) {
      try {
        await liveScore();
      } catch (err) {
        console.error(`live_score_failed ${userId}:`, err?.message || err);
      }
    }

    const capture = (result) => {
      captureDayCompleteness(userId, result);
      return result;
    };

    if (days.length && typeof markDaysDirty === 'function') {
      try {
        await markDaysDirty(userId, days);
      } catch (err) {
        console.error(`mark_days_dirty_failed ${userId}:`, err?.message || err);
      }
    }

    if (!days.length) return;

    const replay = () => engine.recomputeFromStorage({
      userId,
      device,
      days,
      timeZone: tz,
    }).then(capture).catch((err) => {
      console.error(`history_recompute_failed ${userId}:`, err?.message || err);
    });

    if (trigger === 'live_archive' || !finalizer?.finalizeAffectedDays) {
      await replay();
      return;
    }
    try {
      await finalizer.finalizeAffectedDays({
        userId,
        days,
        trigger,
        timeZone: tz,
        device,
        cycleId: cycleId || null,
      }).then(capture);
    } catch (err) {
      console.error(`history_finalize_failed ${userId}:`, err?.message || err);
      await replay();
    }
  }

  function flushUser(userId) {
    const st = stateFor(userId);
    const run = () => runScoreJob(userId, st);
    st.chain = st.chain.then(run, run);
    return st.chain;
  }

  async function drainUser(userId) {
    await new Promise((resolve) => setImmediate(resolve));
    const st = stateFor(userId);
    clearTimeout(st.timer);
    st.timer = null;
    if (st.pendingDays.size || st.liveScoreJobs.length) {
      await flushUser(userId);
    }
    return st.chain;
  }

  function enqueue(userId, {
    affectedDays = [],
    trigger,
    historyComplete = false,
    cycleId = null,
    liveScore = null,
  } = {}) {
    const st = stateFor(userId);
    for (const d of affectedDays) if (d) st.pendingDays.add(d);
    if (trigger) st.lastTrigger = trigger;
    if (historyComplete) st.historyComplete = true;
    if (cycleId) st.cycleId = cycleId;
    if (typeof liveScore === 'function') st.liveScoreJobs.push(liveScore);

    if (!scoreAsync || debounceMs <= 0) {
      return flushUser(userId);
    }
    clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      flushUser(userId).catch((err) => {
        console.error(`score_scheduler_flush_failed ${userId}:`, err?.message || err);
      });
    }, debounceMs);
    return st.chain;
  }

  return {
    enqueue,
    flushUser,
    drainUser,
    async flushAll() {
      await new Promise((resolve) => setImmediate(resolve));
      for (let pass = 0; pass < 4; pass += 1) {
        let pending = false;
        for (const userId of users.keys()) {
          const st = stateFor(userId);
          clearTimeout(st.timer);
          st.timer = null;
          if (st.pendingDays.size || st.liveScoreJobs.length) {
            pending = true;
            await flushUser(userId);
          }
        }
        if (!pending) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      await Promise.all([...users.keys()].map((uid) => stateFor(uid).chain));
    },
    scoreAsync,
  };
}
