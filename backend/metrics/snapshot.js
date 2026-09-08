import { dailyToWhoopDay, sleepToWhoopDay, sessionToWhoopWorkout, mergeWhoopDays } from './engine.js';
import { bpmDataFromSeries, chartFromSeries } from './buckets.js';
import { dayBounds, localDateKey, physiologicalDay } from '../time/dayBoundary.js';
import { applyCanonicalDay, primarySleep, primaryWorkouts } from '../healthkit/ingest.js';
import { buildAvailability, presentMetric, resolveEnergyKcal, resolveSteps } from './canonicalRegistry.js';
import { buildShadowReadModel, compactSleepV3 } from './shadowReadModel.js';

function compactMetrics(row) {
  if (!row) return null;
  const hk = row.extras?.healthkit || {};
  const applied = applyCanonicalDay(row, hk);
  const active = presentMetric(row.active_kcal);
  const basal = presentMetric(row.basal_kcal);
  return {
    day: row.day,
    recovery_score: row.recovery_score ?? row.charge ?? null,
    strain_score: row.strain_score ?? row.effort ?? null,
    strain_score_v2: presentMetric(row.strain_score_v2),
    strain_v2: row.strain_v2 && typeof row.strain_v2 === 'object' && !Array.isArray(row.strain_v2)
      ? row.strain_v2
      : null,
    vo2max: presentMetric(row.vo2max ?? hk.vo2max),
    sleep_debt_balance_min: presentMetric(row.sleep_debt_balance_min),
    sleep_consistency: presentMetric(row.sleep_consistency),
    sleep_performance_pct: row.sleep_performance_pct ?? row.rest ?? null,
    hrv_rmssd_ms: applied.hrv_rmssd_ms,
    resting_hr_bpm: presentMetric(row.resting_hr_bpm),
    avg_hr_bpm: applied.avg_hr_bpm,
    max_hr_bpm: row.max_hr_bpm ?? null,
    resp_rate_bpm: row.resp_rate_bpm ?? presentMetric(row.extras?.respiration?.value),
    spo2_pct: applied.spo2_pct ?? row.spo2_pct ?? null,
    spo2_candidate_pct: presentMetric(
      row.extras?.spo2_candidate?.spo2_candidate_pct ?? row.extras?.spo2_candidate_pct ?? row.spo2_candidate_pct,
    ),
    spo2_candidate: row.extras?.spo2_candidate || null,
    spo2_candidate_series: Array.isArray(row.extras?.spo2_candidate_series) ? row.extras.spo2_candidate_series : null,
    spo2_source: (applied.spo2_pct ?? row.spo2_pct) != null
      ? (applied.sources?.oxygen_saturation || 'validated')
      : ((row.extras?.spo2_candidate?.spo2_candidate_pct ?? row.extras?.spo2_candidate_pct ?? row.spo2_candidate_pct) != null
        ? 'whoop_v18_candidate'
        : null),
    steps: resolveSteps(applied),
    watch_steps: presentMetric(row.watch_steps),
    active_kcal: active,
    basal_kcal: basal,
    energy_kcal: resolveEnergyKcal({
      energy_kcal: row.energy_kcal,
      active_kcal: active,
      basal_kcal: basal,
    }),
    skin_temp_c: row.skin_temp_c ?? null,
    skin_temp_dev_c: row.skin_temp_dev_c ?? null,
    skin_temp_series: Array.isArray(row.extras?.skin_temp_series) ? row.extras.skin_temp_series : null,
    sleep_total_min: presentMetric(row.sleep_total_min),
    weight_kg: applied.weight_kg,
    sources: applied.sources,
    // Per-value provenance. The daily row carries its own scalar + algorithm
    // version; the per-metric source/algorithm/confidence in these JSONB blobs
    // let the UI distinguish 'unavailable' from 'zero' and show the algorithm.
    confidence: row.confidence ?? null,
    provenance: row.provenance ?? null,
    healthkit: Object.keys(hk).length ? hk : null,
    sleep_in_bed_min: row.sleep_in_bed_min ?? null,
    sleep_need_min: row.sleep_need_min ?? null,
    sleep_efficiency: row.sleep_efficiency ?? null,
    sleep_onset_at: row.sleep_onset_at ?? null,
    wake_onset_at: row.wake_onset_at ?? null,
    timezone_name: row.timezone_name ?? null,
    day_start_at: row.day_start_at ?? null,
    day_end_at: row.day_end_at ?? null,
    algorithm_version: row.algorithm_version ?? null,
    computed_at: row.computed_at ?? null,
    battery_timeline: Array.isArray(row.provenance?.battery_timeline)
      ? row.provenance.battery_timeline
      : (Array.isArray(row.extras?.device_state?.battery_timeline) ? row.extras.device_state.battery_timeline : []),
    device_state: row.extras?.device_state || null,
    hr_v2: row.extras?.hr_v2 || row.confidence?.hr_v2 || null,
    energy_v2: row.extras?.energy_v2 || null,
    energy_v2_blocker: row.extras?.energy_v2_blocker || null,
    energy_v3_shadow: row.extras?.energy_v3_shadow || null,
    energy_v3_blocker: row.extras?.energy_v3_blocker || null,
    steps_v2: row.extras?.steps_v2 || row.confidence?.steps?.v2 || null,
    steps_v3: row.extras?.steps_v3 || row.confidence?.steps?.v3 || null,
  };
}

export async function loadDaySnapshot({
  rest,
  userId,
  day,
  timeZone = 'UTC',
} = {}) {
  const bounds = dayBounds(day, timeZone);
  // Bound the sleep read to the wake window (day start − 14h .. day end + 2h).
  // A night belongs to `day` only when its wake instant falls inside the IANA
  // day window, and sleep starts at most ~14h before it, so this range
  // predicate keeps the REST read O(window) instead of the user's entire
  // sleep_details history. The JS wake-day filter below stays as the precise
  // local-day check (and keeps NULL-original_end_at fallbacks correct).
  const sleepFrom = new Date(Date.parse(bounds.day_start_at) - 14 * 3600000).toISOString();
  const sleepTo = new Date(Date.parse(bounds.day_end_at) + 2 * 3600000).toISOString();
  const qDay = `user_id=eq.${userId}&day=eq.${day}`;
  const [metrics, sessions, events, seriesRows, sleep, energyRows, gapRows, watchRows] = await Promise.all([
    rest.select('daily_metrics', `${qDay}&record_class=eq.user&select=*`),
    rest.select(
      'sessions',
      `user_id=eq.${userId}&start_at=lt.${bounds.day_end_at}&end_at=gt.${bounds.day_start_at}&select=id,user_id,device_id,kind,source,start_at,end_at,summary,quality,user_modified,algorithm_version,segments`,
    ),
    rest.select(
      'events',
      `user_id=eq.${userId}&occurred_at=gte.${bounds.day_start_at}&occurred_at=lt.${bounds.day_end_at}&select=*`,
    ),
    rest.select(
      'daily_physiology_series',
      `${qDay}&select=*`,
    ).catch(() => []),
    rest.select(
      'sleep_details',
      `user_id=eq.${userId}&original_end_at=gte.${sleepFrom}&original_start_at=lte.${sleepTo}&select=*`,
    ).catch(() => []),
    rest.select(
      'energy_daily',
      `${qDay}&select=active_kcal,resting_kcal,total_kcal,coverage_minutes`,
    ).catch(() => []),
    rest.select(
      'ingest_gaps',
      `user_id=eq.${userId}&start_at=lt.${bounds.day_end_at}&end_at=gt.${bounds.day_start_at}&select=id,kind,start_at,end_at,expected_samples,received_samples`,
    ).catch(() => []),
    rest.select(
      'apple_watch_step_buckets',
      `user_id=eq.${userId}&bucket_size_seconds=eq.60&bucket_start=gte.${bounds.day_start_at}&bucket_start=lt.${bounds.day_end_at}&select=step_count`,
    ).catch(() => []),
  ]);
  const metric = (metrics || []).find((r) => r.record_class !== 'fixture') || metrics[0] || null;
  const energy = energyRows?.[0] || null;
  const compacted = compactMetrics(metric);
  if (compacted && energy) {
    if (energy.active_kcal != null) compacted.active_kcal = energy.active_kcal;
    if (energy.resting_kcal != null) compacted.basal_kcal = energy.resting_kcal;
    if (energy.total_kcal != null) compacted.energy_kcal = energy.total_kcal;
  }
  if (compacted) {
    const watchSum = (watchRows || []).reduce((n, row) => n + (Number(row?.step_count) || 0), 0);
    compacted.watch_steps = watchRows?.length ? watchSum : compacted.watch_steps;
    compacted.steps = resolveSteps(compacted);
    compacted.energy_kcal = resolveEnergyKcal(compacted);
  }
  const sleepRows = (sleep || []).filter((s) => {
    const wakeDay = localDateKey(s.original_end_at || s.wake_at, timeZone);
    return wakeDay === day || sessions.some((sess) => sess.id === s.session_id);
  });
  const mappedSleep = sleepRows.map((s) => {
    const sess = (sessions || []).find((row) => row.id === s.session_id);
    const summary = sess?.summary && typeof sess.summary === 'object' ? sess.summary : {};
    return {
      session_id: s.session_id,
      is_nap: s.is_nap,
      persist_state: summary.persist_state || (s.is_nap ? 'nap' : 'complete'),
      performance_pct: s.performance_pct,
      efficiency: s.efficiency,
      asleep_min: s.asleep_min,
      in_bed_min: s.in_bed_min,
      light_min: s.light_min,
      deep_min: s.deep_min,
      rem_min: s.rem_min,
      awake_min: s.awake_min,
      need_min: s.need_min,
      debt_min: s.debt_min,
      consistency_pct: s.consistency_pct,
      hypnogram: s.hypnogram,
      shadow_v3: compactSleepV3(s.shadow_v3),
      original_start_at: s.original_start_at,
      original_end_at: s.original_end_at,
    };
  });
  const detailIds = new Set(mappedSleep.map((s) => s.session_id).filter(Boolean));
  for (const s of sessions || []) {
    if (!/^(sleep|nap)$/i.test(String(s.kind || '')) || detailIds.has(s.id)) continue;
    const wakeDay = localDateKey(s.end_at, timeZone);
    if (wakeDay !== day) continue;
    const summary = s.summary && typeof s.summary === 'object' ? s.summary : {};
    mappedSleep.push({
      session_id: s.id,
      is_nap: summary.is_nap ?? /nap/i.test(String(s.kind || '')),
      persist_state: summary.persist_state || (summary.is_nap || /nap/i.test(String(s.kind || '')) ? 'nap' : 'complete'),
      performance_pct: summary.performance ?? summary.performance_pct,
      efficiency: summary.efficiency,
      asleep_min: summary.asleep_min,
      in_bed_min: summary.in_bed_min,
      light_min: summary.light_min,
      deep_min: summary.deep_min,
      rem_min: summary.rem_min,
      awake_min: summary.awake_min,
      need_min: summary.need_min,
      debt_min: summary.debt_min,
      consistency_pct: summary.consistency_pct,
      hypnogram: s.segments || summary.hypnogram,
      original_start_at: s.start_at,
      original_end_at: s.end_at,
    });
  }
  if (compacted && compacted.sleep_total_min == null) {
    let max = null;
    for (const row of mappedSleep) {
      const scored = Number(row?.asleep_min);
      let n = Number.isFinite(scored) ? scored : null;
      if (n == null) {
        const a = Date.parse(row?.original_start_at);
        const b = Date.parse(row?.original_end_at);
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) n = (b - a) / 60000;
      }
      if (n == null) continue;
      if (max == null || n > max) max = n;
    }
    compacted.sleep_total_min = max;
  }
  const series = seriesRows?.[0] || null;
  const chart = chartFromSeries(series);
  const strainSeries = Array.isArray(series?.strain_series) ? series.strain_series : [];
  const skinTempSeries = Array.isArray(series?.skin_temp_series) && series.skin_temp_series.length
    ? series.skin_temp_series
    : (Array.isArray(compacted?.skin_temp_series) ? compacted.skin_temp_series : []);
  if (compacted && skinTempSeries.length) compacted.skin_temp_series = skinTempSeries;
  const snapshot = {
    day,
    ...bounds,
    metrics: compacted,
    sleep: mappedSleep,
    sessions: sessions || [],
    primary_sessions: primaryWorkouts(sessions || []).concat(primarySleep(sessions || [])),
    events: events || [],
    gaps: gapRows || [],
    chart,
    strain_series: strainSeries,
    skin_temp_series: skinTempSeries,
    spo2_candidate_series: Array.isArray(compacted?.spo2_candidate_series) ? compacted.spo2_candidate_series : [],
    spo2_candidate_pct: compacted?.spo2_candidate_pct ?? null,
    spo2_source: compacted?.spo2_source || null,
  };
  if (compacted) {
    compacted.shadows = metric?.extras?.shadows && Array.isArray(metric.extras.shadows.candidates)
      ? metric.extras.shadows
      : buildShadowReadModel({
        metrics: compacted,
        extras: metric?.extras,
        confidence: compacted.confidence,
        provenance: compacted.provenance,
        sleep: mappedSleep,
        gaps: gapRows,
      });
    snapshot.shadows = compacted.shadows;
    snapshot.battery_timeline = compacted.battery_timeline || [];
  }
  snapshot.availability = buildAvailability({
    metrics: compacted || {},
    chart,
    sleep: mappedSleep,
    sessions: sessions || [],
    strainSeries,
    skinTempSeries,
  });
  return snapshot;
}

export function snapshotHeadlines(snapshot) {
  const m = snapshot?.metrics || {};
  return {
    day: snapshot?.day || null,
    steps: presentMetric(m.steps),
    strain_score: presentMetric(m.strain_score),
    energy_kcal: presentMetric(m.energy_kcal),
    resting_hr_bpm: presentMetric(m.resting_hr_bpm),
    avg_hr_bpm: presentMetric(m.avg_hr_bpm),
    sleep_total_min: presentMetric(m.sleep_total_min),
    persist_states: (snapshot?.sleep || []).map((s) => s.persist_state).filter(Boolean).sort(),
    hr_buckets: Array.isArray(snapshot?.chart) ? snapshot.chart.length : 0,
    sleep_kind: snapshot?.availability?.sleep?.kind || null,
  };
}

export function whoopDayHeadlines(day, whoop) {
  const p = whoop?.physiological_summary || {};
  return {
    day,
    steps: presentMetric(p.Steps),
    strain_score: presentMetric(p['Day Strain']),
    energy_kcal: presentMetric(p['Energy burned (cal)']),
    resting_hr_bpm: presentMetric(p['Resting heart rate (bpm)']),
    avg_hr_bpm: presentMetric(p['Average HR (bpm)']),
    sleep_total_min: presentMetric(p['Asleep duration (min)']),
  };
}

export function headlinesMatch(a, b, keys = ['steps', 'strain_score', 'energy_kcal', 'resting_hr_bpm', 'avg_hr_bpm', 'sleep_total_min']) {
  if (!a || !b) return false;
  return keys.every((key) => {
    const x = presentMetric(a[key]);
    const y = presentMetric(b[key]);
    if (x == null && y == null) return true;
    if (x == null || y == null) return false;
    return Math.abs(x - y) < 0.05;
  });
}

export async function loadRange({ rest, userId, fromDay, toDay } = {}) {
  const rows = await rest.select(
    'daily_metrics',
    `user_id=eq.${userId}&day=gte.${fromDay}&day=lte.${toDay}&record_class=eq.user&order=day.desc&select=day,recovery_score,strain_score,strain_score_v2,sleep_performance_pct,charge,effort,rest,hrv_rmssd_ms,resting_hr_bpm,avg_hr_bpm,max_hr_bpm,resp_rate_bpm,spo2_pct,skin_temp_c,skin_temp_dev_c,steps,active_kcal,basal_kcal,sleep_total_min,sleep_need_min,sleep_debt_balance_min,sleep_consistency,vo2max,computed_at,timezone_name,confidence,provenance,extras`,
  );
  return (rows || []).map((r) => {
    const metrics = compactMetrics(r);
    if (!metrics) return null;
    metrics.availability = buildAvailability({ metrics });
    return metrics;
  }).filter(Boolean);
}

export function snapshotToWhoopDay(snapshot) {
  if (!snapshot) return null;
  const metricDay = snapshot.metrics
    ? dailyToWhoopDay({
      ...snapshot.metrics,
      charge: snapshot.metrics.recovery_score,
      effort: snapshot.metrics.strain_score,
      rest: snapshot.metrics.sleep_performance_pct,
    })
    : { physiological_summary: {}, sleep_summary: {} };
  const sleepRows = (snapshot.sleep || []).length
    ? snapshot.sleep
    : (snapshot.sessions || []).filter((s) => /^(sleep|nap)$/i.test(String(s.kind || ''))).map((s) => {
      const summary = s.summary && typeof s.summary === 'object' ? s.summary : {};
      return {
        original_start_at: s.start_at,
        original_end_at: s.end_at,
        performance_pct: summary.performance ?? summary.performance_pct,
        asleep_min: summary.asleep_min,
        in_bed_min: summary.in_bed_min,
        light_min: summary.light_min,
        deep_min: summary.deep_min,
        rem_min: summary.rem_min,
        awake_min: summary.awake_min,
        need_min: summary.need_min,
        debt_min: summary.debt_min,
        consistency_pct: summary.consistency_pct,
        efficiency: summary.efficiency,
        hypnogram: s.segments || summary.hypnogram,
        is_nap: summary.is_nap ?? /nap/i.test(String(s.kind || '')),
      };
    });
  const overnight = sleepRows.find((s) => s.persist_state === 'complete' && !s.is_nap)
    || sleepRows.find((s) => s.persist_state === 'complete')
    || sleepRows.find((s) => !s.is_nap)
    || sleepRows[0];
  const sleepPatch = overnight
    ? sleepToWhoopDay({
      ...overnight,
      onsetIso: overnight.original_start_at,
      wakeIso: overnight.original_end_at,
      performance: overnight.performance_pct,
      asleepMin: overnight.asleep_min,
      inBedMin: overnight.in_bed_min,
      lightMin: overnight.light_min,
      deepMin: overnight.deep_min,
      remMin: overnight.rem_min,
      awakeMin: overnight.awake_min,
      needMin: overnight.need_min,
      efficiency: overnight.efficiency,
      is_nap: overnight.is_nap,
      hypnogram: overnight.hypnogram,
    })
    : null;
  const workouts = primaryWorkouts(snapshot.sessions || [])
    .map((s) => ({
      'Activity name': s.summary?.name || s.kind,
      'Start time': s.start_at,
      'End time': s.end_at,
      'Duration (min)': s.summary?.duration_min ?? null,
      'Activity Strain': s.summary?.strain ?? null,
      'Energy burned (cal)': s.summary?.calories ?? null,
    }));
  const availability = snapshot.availability || buildAvailability({
    metrics: snapshot.metrics || {},
    chart: snapshot.chart || [],
    sleep: sleepRows,
    sessions: snapshot.sessions || [],
    strainSeries: snapshot.strain_series || [],
    skinTempSeries: snapshot.skin_temp_series || [],
  });
  return {
    ...metricDay,
    ...(sleepPatch || {}),
    physiological_summary: {
      ...(sleepPatch?.physiological_summary || {}),
      ...(metricDay.physiological_summary || {}),
    },
    sleep_summary: {
      ...(sleepPatch?.sleep_summary || {}),
      ...(metricDay.sleep_summary || {}),
    },
    sleep_hypnogram: sleepPatch?.sleep_hypnogram || sleepRows[0]?.hypnogram || [],
    workouts,
    bpm_data: bpmDataFromSeries({ hr_series: snapshot.chart || [] }),
    chart: snapshot.chart,
    strain_series: Array.isArray(snapshot.strain_series) ? snapshot.strain_series : (metricDay.strain_series || []),
    skin_temp_series: snapshot.skin_temp_series
      || snapshot.metrics?.skin_temp_series
      || [],
    spo2_candidate_pct: presentMetric(
      metricDay.spo2_candidate_pct ?? snapshot.metrics?.spo2_candidate_pct ?? snapshot.spo2_candidate_pct,
    ),
    spo2_candidate_series: Array.isArray(snapshot.spo2_candidate_series) && snapshot.spo2_candidate_series.length
      ? snapshot.spo2_candidate_series
      : (Array.isArray(metricDay.spo2_candidate_series) ? metricDay.spo2_candidate_series : []),
    spo2_source: snapshot.spo2_source || snapshot.metrics?.spo2_source || metricDay.spo2_source || null,
    strain_v2: snapshot.metrics?.strain_v2 || metricDay.strain_v2 || null,
    strain_score_v2: presentMetric(snapshot.metrics?.strain_score_v2 ?? metricDay.strain_score_v2),
    shadows: snapshot.shadows || snapshot.metrics?.shadows || buildShadowReadModel({
      metrics: snapshot.metrics || {},
      extras: snapshot.metrics,
      confidence: snapshot.metrics?.confidence,
      provenance: snapshot.metrics?.provenance,
      sleep: sleepRows,
      gaps: snapshot.gaps || [],
    }),
    battery_timeline: snapshot.battery_timeline
      || snapshot.metrics?.battery_timeline
      || [],
    device_state: snapshot.metrics?.device_state || null,
    availability,
  };
}

function sleepRowFromSession(session) {
  const summary = session?.summary && typeof session.summary === 'object' ? session.summary : {};
  return {
    session_id: session.id,
    is_nap: summary.is_nap ?? /nap/i.test(String(session.kind || '')),
    persist_state: summary.persist_state
      || ((summary.is_nap ?? /nap/i.test(String(session.kind || ''))) ? 'nap' : 'complete'),
    performance_pct: summary.performance ?? summary.performance_pct,
    efficiency: summary.efficiency,
    asleep_min: summary.asleep_min,
    in_bed_min: summary.in_bed_min,
    light_min: summary.light_min,
    deep_min: summary.deep_min,
    rem_min: summary.rem_min,
    awake_min: summary.awake_min,
    need_min: summary.need_min,
    debt_min: summary.debt_min,
    consistency_pct: summary.consistency_pct,
    hypnogram: session.segments || summary.hypnogram,
    original_start_at: session.start_at,
    original_end_at: session.end_at,
  };
}

/**
 * Batched loadUserDays payload → the same snapshot object GET /api/days/snapshot
 * and get_day_snapshot return. /api/days whoop-days are derived from this, so
 * there is one serializer, not a second overlay path.
 */
export function snapshotsFromPersistedPayload(payload = {}, { timeZone = 'UTC' } = {}) {
  const tz = payload.daily_metrics?.find((r) => r.timezone_name)?.timezone_name || timeZone;
  const byDay = new Map();
  const ensure = (day) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return null;
    if (!byDay.has(day)) {
      byDay.set(day, {
        day,
        metrics: null,
        chart: [],
        strain_series: [],
        skin_temp_series: [],
        spo2_candidate_series: [],
        sleep: [],
        sessions: [],
      });
    }
    return byDay.get(day);
  };

  for (const row of payload.daily_metrics || []) {
    if (row?.provenance?.source === 'coach-days-backfill') continue;
    if (row?.record_class && row.record_class !== 'user') continue;
    const snap = ensure(row.day);
    if (snap) {
      snap.metrics = compactMetrics(row);
      if (Array.isArray(snap.metrics?.spo2_candidate_series)) {
        snap.spo2_candidate_series = snap.metrics.spo2_candidate_series;
      }
      if (snap.metrics?.spo2_candidate_pct != null) snap.spo2_candidate_pct = snap.metrics.spo2_candidate_pct;
      if (snap.metrics?.spo2_source) snap.spo2_source = snap.metrics.spo2_source;
    }
  }

  const sleepDays = new Set();
  for (const night of payload.sleep_details || []) {
    const wakeDay = physiologicalDay({
      wakeIso: night.original_end_at || night.wake_onset_at,
      timeZone: tz,
    });
    const snap = ensure(wakeDay);
    if (!snap) continue;
    sleepDays.add(wakeDay);
    snap.sleep.push(night);
  }

  for (const session of payload.sessions || []) {
    if (/^(sleep|nap)$/i.test(String(session.kind || ''))) {
      const wakeDay = physiologicalDay({ wakeIso: session.end_at, timeZone: tz });
      const snap = ensure(wakeDay);
      if (!snap) continue;
      snap.sessions.push(session);
      if (!sleepDays.has(wakeDay)) {
        sleepDays.add(wakeDay);
        snap.sleep.push(sleepRowFromSession(session));
      }
      continue;
    }
    const day = localDateKey(session.start_at, tz);
    const snap = ensure(day);
    if (snap) snap.sessions.push(session);
  }

  for (const series of payload.daily_physiology_series || []) {
    const snap = ensure(series.day);
    if (!snap) continue;
    snap.chart = chartFromSeries(series);
    snap.strain_series = Array.isArray(series.strain_series) ? series.strain_series : [];
    snap.skin_temp_series = Array.isArray(series.skin_temp_series) && series.skin_temp_series.length
      ? series.skin_temp_series
      : (Array.isArray(snap.metrics?.skin_temp_series) ? snap.metrics.skin_temp_series : []);
    if (!snap.spo2_candidate_series?.length && Array.isArray(snap.metrics?.spo2_candidate_series)) {
      snap.spo2_candidate_series = snap.metrics.spo2_candidate_series;
    }
  }

  const out = {};
  for (const [day, snap] of byDay) {
    snap.availability = buildAvailability({
      metrics: snap.metrics || {},
      chart: snap.chart,
      sleep: snap.sleep,
      sessions: snap.sessions,
      strainSeries: snap.strain_series,
      skinTempSeries: snap.skin_temp_series,
    });
    out[day] = snap;
  }
  return out;
}

export function whoopDaysFromSnapshots(snapshots = {}) {
  const overlays = Object.entries(snapshots).map(([day, snap]) => ({
    day,
    patch: snapshotToWhoopDay(snap),
  }));
  return mergeWhoopDays({}, overlays);
}

export async function loadWhoopDaysMap({ rest, userId, fromDay, toDay, timeZone = 'UTC' } = {}) {
  const range = await loadRange({ rest, userId, fromDay, toDay });
  const overlays = [];
  for (const row of range) {
    const snap = await loadDaySnapshot({ rest, userId, day: row.day, timeZone });
    overlays.push({ day: row.day, patch: snapshotToWhoopDay(snap) });
  }
  return mergeWhoopDays({}, overlays);
}

// Explicit column lists for the delta read. Never select=*: chart_data,
// stages, and hypnogram JSONB are the heavy columns, and the whoop-day patch
// builders below never read them.
const CHANGED_DAILY_COLS = [
  'day', 'record_class', 'recovery_score', 'strain_score', 'sleep_performance_pct',
  'charge', 'effort', 'rest', 'hrv_rmssd_ms', 'resting_hr_bpm', 'avg_hr_bpm', 'max_hr_bpm',
  'resp_rate_bpm', 'spo2_pct', 'skin_temp_c', 'skin_temp_dev_c', 'steps', 'active_kcal',
  'basal_kcal', 'sleep_total_min', 'sleep_in_bed_min', 'sleep_light_min', 'sleep_deep_min',
  'sleep_rem_min', 'sleep_awake_min', 'sleep_need_min', 'sleep_debt_balance_min',
  'sleep_efficiency', 'sleep_consistency', 'sleep_onset_at', 'wake_onset_at',
  'vo2max', 'strain_score_v2', 'strain_v2',
  'timezone_name', 'extras', 'provenance',
].join(',');

const CHANGED_SLEEP_COLS = [
  'session_id', 'is_nap', 'in_bed_min', 'asleep_min', 'awake_min', 'light_min',
  'deep_min', 'rem_min', 'efficiency', 'performance_pct', 'need_min', 'debt_min',
  'consistency_pct', 'resp_rate_bpm', 'overnight_hr_bpm', 'resting_hr_bpm',
  'hrv_rmssd_ms', 'recovery_pct', 'original_start_at', 'original_end_at',
].join(',');

const CHANGED_SESSION_COLS = [
  'id', 'kind', 'source', 'start_at', 'end_at', 'summary', 'segments', 'user_modified',
].join(',');

/**
 * Startup delta read (GET /api/days/changes): the days whose persisted rows
 * changed after `since`, shaped as whoop-day patches keyed by local date —
 * the same merge shape loadPersistedDays feeds mergeWhoopDays with, so the
 * client overlays the patch onto its cached days without a second mapping.
 *
 * Mirrors loadDaySnapshot's bounded reads: explicit select lists (never
 * select=*), sessions/sleep constrained to the window so a 31-day catch-up
 * cannot scan unbounded history. Chart data follows the /api/days payload
 * gate: bpm_data is attached only for today + yesterday; older changed days
 * reload their series on demand via the day-snapshot RPC.
 */
export async function loadChangedDays({
  rest,
  userId,
  sinceIso,
  fromDay,
  toDay,
  timeZone = 'UTC',
  now = new Date(),
} = {}) {
  if (!rest || !userId || !sinceIso || !fromDay || !toDay) return {};
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs)) return {};
  const since = new Date(sinceMs).toISOString();
  const first = dayBounds(fromDay, timeZone);
  const last = dayBounds(toDay, timeZone);
  // Same wake-window widening loadDaySnapshot uses per day, unioned across the
  // requested range: a night belongs to a day via its wake instant (start − 14h).
  const sleepFrom = new Date(Date.parse(first.day_start_at) - 14 * 3600000).toISOString();
  const sleepTo = new Date(Date.parse(last.day_end_at) + 2 * 3600000).toISOString();
  const [metrics, sessions, nights] = await Promise.all([
    rest.select(
      'daily_metrics',
      `user_id=eq.${userId}&record_class=eq.user&updated_at=gte.${since}&day=gte.${fromDay}&day=lte.${toDay}&select=${CHANGED_DAILY_COLS}`,
    ),
    rest.select(
      'sessions',
      `user_id=eq.${userId}&updated_at=gte.${since}&start_at=gte.${first.day_start_at}&start_at=lt.${last.day_end_at}&select=${CHANGED_SESSION_COLS}`,
    ),
    rest.select(
      'sleep_details',
      `user_id=eq.${userId}&updated_at=gte.${since}&original_end_at=gte.${sleepFrom}&original_start_at=lte.${sleepTo}&select=${CHANGED_SLEEP_COLS}`,
    ),
  ]);
  const tz = (metrics || []).find((r) => r.timezone_name)?.timezone_name || timeZone;
  const inWindow = (day) => /^\d{4}-\d{2}-\d{2}$/.test(day || '') && day >= fromDay && day <= toDay;
  const overlays = [];
  for (const row of metrics || []) {
    // Same row policies as loadPersistedDays: coach backfill rows and non-user
    // classes never surface through the user day read path.
    if (row?.provenance?.source === 'coach-days-backfill') continue;
    if (row?.record_class && row.record_class !== 'user') continue;
    if (!row?.day) continue;
    overlays.push({ day: row.day, patch: dailyToWhoopDay(row) });
  }
  for (const night of nights || []) {
    const wakeDay = physiologicalDay({
      wakeIso: night.original_end_at || night.wake_onset_at,
      timeZone: tz,
    });
    if (!inWindow(wakeDay)) continue;
    overlays.push({ day: wakeDay, patch: sleepToWhoopDay({
      ...night,
      onsetIso: night.original_start_at,
      wakeIso: night.original_end_at,
      performance: night.performance_pct,
      asleepMin: night.asleep_min,
      inBedMin: night.in_bed_min,
      lightMin: night.light_min,
      deepMin: night.deep_min,
      remMin: night.rem_min,
      awakeMin: night.awake_min,
      needMin: night.need_min,
      debtMin: night.debt_min,
      efficiency: night.efficiency,
      consistency: night.consistency_pct,
      overnightHr: night.overnight_hr_bpm,
      restingHr: night.resting_hr_bpm,
      recovery: night.recovery_pct,
    }) });
  }
  for (const session of sessions || []) {
    if (!/workout/i.test(String(session.kind || ''))) continue;
    const mapped = sessionToWhoopWorkout(session);
    const day = localDateKey(session.start_at, tz);
    if (mapped && inWindow(day)) {
      overlays.push({ day, patch: { workouts: [mapped] } });
    }
  }
  // Payload gate: Overview draws only today + yesterday, so only those two
  // days ever carry bpm_data here — older changed days stay scalar-only and
  // reload their chart on demand via the day-snapshot RPC.
  const today = localDateKey(now, timeZone);
  let yesterday = null;
  try {
    yesterday = localDateKey(new Date(Date.parse(dayBounds(today, timeZone).day_start_at) - 3600000), timeZone);
  } catch { /* tz lookup failed */ }
  const changedDays = new Set(overlays.map((o) => o.day));
  const chartDays = [today, yesterday].filter((d) => d && changedDays.has(d)).sort();
  if (chartDays.length) {
    const rows = await rest.select(
      'daily_physiology_series',
      `user_id=eq.${userId}&day=gte.${chartDays[0]}&day=lte.${chartDays.at(-1)}&select=day,hr_series,strain_series,skin_temp_series`,
    ).catch(() => []);
    for (const row of rows || []) {
      if (!chartDays.includes(row.day) || !changedDays.has(row.day)) continue;
      overlays.push({
        day: row.day,
        patch: {
          bpm_data: bpmDataFromSeries(row),
          strain_series: Array.isArray(row.strain_series) ? row.strain_series : [],
          skin_temp_series: Array.isArray(row.skin_temp_series) ? row.skin_temp_series : [],
        },
      });
    }
  }
  const days = mergeWhoopDays({}, overlays);
  // mergeWhoopDays normalizes every day to bpm_data: [] — strip the key again
  // so older days omit it entirely and today/yesterday only ever carry a
  // non-empty series.
  for (const [day, patch] of Object.entries(days)) {
    if (!patch || !Array.isArray(patch.bpm_data)) continue;
    if ((day !== today && day !== yesterday) || patch.bpm_data.length === 0) {
      delete patch.bpm_data;
    }
  }
  return days;
}

export { compactMetrics, physiologicalDay };
