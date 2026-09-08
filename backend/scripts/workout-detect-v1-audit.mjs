#!/usr/bin/env node
/**
 * Read-only V1 auto-workout miss audit for labeled LA windows.
 * Never prints secrets. Loads env via storageConfig.
 */
import { storageConfig } from '../storage/config.js';
import { getStores } from '../storage/stores.js';
import { decodeArchive, decodeFrameArchive } from '../ingest/archiveFormat.js';
import { decodeImuArchive } from '../protocol/imuArchive.js';
import { createWorkoutDetector } from '../metrics/workoutDetector.js';
import { resolveHrMax } from '../vo2/hrMax.js';

const TZ = 'America/Los_Angeles';
const PAD_MIN = 45;
const LABELS = [
  { id: 'w1', day: '2026-08-30', start: '16:46', end: '17:48', sport: 'strength' },
  { id: 'w2', day: '2026-08-29', start: '18:50', end: '19:51', sport: 'strength' },
  { id: 'w3', day: '2026-08-28', start: '21:02', end: '21:53', sport: 'strength' },
  { id: 'w4', day: '2026-08-27', start: '22:02', end: '23:05', sport: 'indoor_walk' },
  { id: 'w5', day: '2026-08-26', start: '22:02', end: '23:12', sport: 'strength' },
  { id: 'w6', day: '2026-08-25', start: '22:32', end: '23:35', sport: 'strength' },
];

const cfg = storageConfig();

function laMs(day, hm) {
  const [h, m] = hm.split(':').map(Number);
  // DST-safe: construct as UTC then interpret via Intl offset for that local instant.
  const guess = Date.parse(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const parts = (ms) => Object.fromEntries(fmt.formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  let ms = guess - 8 * 3600000;
  for (let i = 0; i < 4; i += 1) {
    const p = parts(ms);
    const got = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const want = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), h, m, 0);
    ms += want - got;
  }
  return ms;
}

async function restAll(path, query, { page = 1000 } = {}) {
  const rows = [];
  let from = 0;
  for (;;) {
    const url = `${cfg.supabaseUrl}/rest/v1/${path}?${query}`;
    const res = await fetch(url, {
      headers: {
        apikey: cfg.supabaseServiceRoleKey,
        authorization: `Bearer ${cfg.supabaseServiceRoleKey}`,
        Range: `${from}-${from + page - 1}`,
        prefer: 'count=exact',
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`rest ${path} ${res.status}: ${text.slice(0, 200)}`);
    const chunk = text ? JSON.parse(text) : [];
    if (!Array.isArray(chunk) || !chunk.length) break;
    rows.push(...chunk);
    if (chunk.length < page) break;
    from += page;
  }
  return rows;
}

function parseKey(key) {
  const v3 = /^v3\/([^/]+)\/users\/([^/]+)\/devices\/([^/]+)\/([^/]+)\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\//;
  const m = v3.exec(key);
  if (m) {
    return {
      key, version: 3, stream: m[4],
      utcHour: `${m[5]}-${m[6]}-${m[7]}T${m[8]}:00:00Z`,
      hourMs: Date.UTC(+m[5], +m[6] - 1, +m[7], +m[8]),
    };
  }
  const v2 = /^v2\/users\/[^/]+\/devices\/[^/]+\/raw\/([^/]+)\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\//;
  const n = v2.exec(key);
  if (n) {
    return {
      key, version: 2, stream: n[1],
      utcHour: `${n[2]}-${n[3]}-${n[4]}T${n[5]}:00:00Z`,
      hourMs: Date.UTC(+n[2], +n[3] - 1, +n[4], +n[5]),
    };
  }
  return { key, stream: 'unknown', hourMs: null };
}

function tsOf(s) {
  const t = Date.parse(s?.t || s?.datetime || s?.at || '');
  return Number.isFinite(t) ? t : null;
}

function coverage(samples, start, end, pred) {
  const inW = samples.filter((s) => {
    const t = tsOf(s);
    return t != null && t >= start && t < end && pred(s, t);
  });
  const times = inW.map((s) => tsOf(s)).sort((a, b) => a - b);
  let maxGap = 0;
  let prev = start;
  for (const t of times) {
    maxGap = Math.max(maxGap, t - prev);
    prev = t;
  }
  maxGap = Math.max(maxGap, end - prev);
  const dur = Math.max(1, end - start);
  return {
    n: inW.length,
    pct1s: Math.round(1000 * new Set(times.map((t) => Math.floor((t - start) / 1000))).size / (dur / 1000)) / 10,
    maxGapS: Math.round(maxGap / 1000),
  };
}

function replayV1(samples, { restingHr, maxHr, start, end }) {
  const events = [];
  const det = createWorkoutDetector({
    thresholds: () => ({ restingHr, maxHr }),
    onEvent: (e) => events.push(e),
    now: () => end,
  });
  let lastSnap = det.snapshot();
  const timeline = [];
  let peakPulse = 0;
  let peakMotion = null;
  let peakActiveS = 0;
  let peakElevatedS = 0;
  for (const s of samples) {
    const t = tsOf(s);
    if (t == null || t < start - PAD_MIN * 60_000 || t > end + PAD_MIN * 60_000) continue;
    const bpm = Number(s.bpm ?? s.heartRate);
    if (!Number.isFinite(bpm)) continue;
    const motion = Number(s.mot ?? s.motion ?? s.dyn_accel);
    lastSnap = det.ingest({
      ts: t,
      bpm,
      motion: Number.isFinite(motion) ? motion : undefined,
      source: s.src,
    });
    peakPulse = Math.max(peakPulse, lastSnap.pulseCount || 0);
    peakActiveS = Math.max(peakActiveS, lastSnap.activeS || 0);
    peakElevatedS = Math.max(peakElevatedS, lastSnap.elevatedS || 0);
    if (Number.isFinite(motion)) peakMotion = Math.max(peakMotion ?? 0, motion);
    if (lastSnap.state !== timeline.at(-1)?.state) {
      timeline.push({
        t, state: lastSnap.state, pulse: lastSnap.pulseCount, path: lastSnap.confirmPath,
        activeS: lastSnap.activeS, elevatedS: lastSnap.elevatedS,
      });
    }
  }
  det.tick(end + PAD_MIN * 60_000);
  const starts = events.filter((e) => e.type === 'workout_start');
  const ends = events.filter((e) => e.type === 'workout_end');
  const discards = events.filter((e) => e.type === 'workout_discarded');
  const overlap = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;
  const hits = starts.filter((e) => overlap(e.workout.onsetTs, e.ts, start, end)
    || ends.some((x) => overlap(x.workout.startTs, x.workout.endTs, start, end)));
  let miss = null;
  if (!hits.length) {
    if (lastSnap.physReady === false || lastSnap.floor == null) miss = 'missing_physiology_rhr';
    else if (!timeline.some((x) => x.state !== 'IDLE')) miss = 'active_floor_failure';
    else if (discards.some((d) => d.reason === 'too_short')) miss = 'too_short';
    else if (peakPulse < 3 && (peakMotion == null || peakMotion < 0.15) && peakElevatedS < 180) {
      miss = peakActiveS >= 600 ? 'insufficient_hr_pulses_timeout' : 'insufficient_hr_pulses';
    } else if (peakMotion != null && peakMotion >= 0.15 && peakElevatedS < 180) {
      miss = 'motion_present_below_cardio_floor';
    } else if (timeline.some((x) => x.state === 'LIKELY') && !starts.length) miss = 'candidate_timeout_or_reset';
    else miss = 'unconfirmed';
  }
  return {
    floor: lastSnap.floor,
    activeFloor: lastSnap.activeFloor,
    physReady: lastSnap.physReady,
    starts: starts.map((e) => ({
      path: e.workout.confirmPath, reason: e.workout.confirmReason, sport: e.workout.sport,
      onset: e.workout.onsetTs, confirmed: e.workout.confirmedTs,
    })),
    ends: ends.map((e) => ({ sport: e.workout.sport, start: e.workout.startTs, end: e.workout.endTs, path: e.workout.confirmPath })),
    discards: discards.map((e) => e.reason),
    timeline: timeline.slice(0, 40),
    peakPulse, peakMotion, peakActiveS, peakElevatedS,
    hit: hits.length > 0,
    miss,
  };
}

function packetTypeOfHex(hex, family) {
  if (!hex || hex.length < 20) return null;
  const typeOff = family === 'puffin' ? 8 : 4;
  const i = typeOff * 2;
  if (hex.length < i + 2) return null;
  return Number.parseInt(hex.slice(i, i + 2), 16);
}

const labels = LABELS.map((l) => {
  const start = laMs(l.day, l.start);
  const end = laMs(l.day, l.end);
  return { ...l, start, end, padStart: start - PAD_MIN * 60_000, padEnd: end + PAD_MIN * 60_000 };
});
const globStart = Math.min(...labels.map((l) => l.padStart));
const globEnd = Math.max(...labels.map((l) => l.padEnd));

const report = {
  tz: TZ,
  generated_at: new Date().toISOString(),
  config: {
    supabaseHost: new URL(cfg.supabaseUrl).host,
    b2Bucket: cfg.b2Bucket,
    serviceRole: Boolean(cfg.supabaseServiceRoleKey),
    localUserIdSet: Boolean(cfg.localUserId),
  },
};

if (!cfg.supabaseServiceRoleKey) {
  console.error('NO_SERVICE_ROLE');
  process.exit(2);
}

const sessions = await restAll(
  'sessions',
  `select=id,user_id,kind,source,external_id,start_at,end_at,summary,algorithm_version,user_modified`
  + `&start_at=gte.${encodeURIComponent(new Date(globStart - 6 * 3600000).toISOString())}`
  + `&start_at=lt.${encodeURIComponent(new Date(globEnd + 6 * 3600000).toISOString())}`
  + `&order=start_at.asc`,
);
const metrics = await restAll(
  'daily_metrics',
  `select=user_id,day,resting_hr_bpm,max_hr_bpm,avg_hr_bpm,algorithm_version&record_class=eq.user&day=gte.2026-08-24&day=lte.2026-08-31&order=day.asc`,
);
const events = await restAll(
  'events',
  `select=event_type,occurred_at,source,text_value,payload&occurred_at=gte.${encodeURIComponent(new Date(globStart).toISOString())}`
  + `&occurred_at=lt.${encodeURIComponent(new Date(globEnd).toISOString())}&order=occurred_at.asc`,
);
const manifests = await restAll(
  'object_manifests',
  `select=object_kind,object_key,status,start_at,end_at,sample_count`
  + `&start_at=gte.${encodeURIComponent(new Date(globStart - 3600000).toISOString())}`
  + `&start_at=lt.${encodeURIComponent(new Date(globEnd + 3600000).toISOString())}&order=start_at.asc`,
);

report.supabase = {
  sessionCount: sessions.length,
  sessions: sessions.map((s) => ({
    kind: s.kind, source: s.source, start: s.start_at, end: s.end_at,
    sport: s.summary?.sport || s.summary?.name, algo: s.algorithm_version,
    auto: /auto/.test(String(s.source || '')),
  })),
  metrics: metrics.map((m) => ({ day: m.day, rhr: m.resting_hr_bpm, max: m.max_hr_bpm, avg: m.avg_hr_bpm })),
  workoutEvents: events.filter((e) => /workout/.test(String(e.event_type || ''))).slice(0, 80).map((e) => ({
    type: e.event_type, at: e.occurred_at, reason: e.text_value, path: e.payload?.confirmation_path,
  })),
  manifests: manifests.reduce((acc, m) => {
    acc[m.object_kind] = (acc[m.object_kind] || 0) + 1;
    return acc;
  }, {}),
};

const stores = await getStores(cfg);
if (!stores.raw) {
  console.error('NO_B2');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(3);
}

const userIds = [...new Set([
  ...sessions.map((s) => s.user_id),
  ...metrics.map((m) => m.user_id),
  cfg.localUserId,
].filter(Boolean))];

const allKeys = [];
for (const uid of userIds) {
  for (const prefix of [`v3/core/users/${uid}/`, `v2/users/${uid}/`]) {
    try { allKeys.push(...await stores.raw.listPrefix(prefix)); } catch (err) {
      console.error(`listPrefix ${prefix.slice(0, 24)}: ${err.message}`);
    }
  }
}

const parsed = allKeys.map(parseKey).filter((p) => p.hourMs != null
  && p.hourMs + 3600000 >= globStart && p.hourMs <= globEnd);
report.b2 = {
  listed: allKeys.length,
  inWindow: parsed.length,
  byStream: parsed.reduce((acc, p) => {
    acc[p.stream] = (acc[p.stream] || 0) + 1;
    return acc;
  }, {}),
};

const physKeys = parsed.filter((p) => /^(physiology|hr|live_hr)$/.test(p.stream));
const frameKeys = parsed.filter((p) => p.stream === 'frames' || p.stream === 'ble');
const imuKeys = parsed.filter((p) => p.stream === 'imu_raw');

const samples = [];
for (const p of physKeys) {
  try {
    const obj = await stores.raw.getObject(p.key);
    if (!obj?.body) continue;
    for (const row of decodeArchive(obj.body)) samples.push(row);
  } catch (err) {
    console.error(`phys ${p.key.split('/').slice(-1)[0]}: ${err.message}`);
  }
}
samples.sort((a, b) => (tsOf(a) || 0) - (tsOf(b) || 0));

const frameTypes = {};
let frameN = 0;
for (const p of frameKeys.slice(0, 36)) {
  try {
    const obj = await stores.raw.getObject(p.key);
    if (!obj?.body) continue;
    for (const row of decodeFrameArchive(obj.body)) {
      frameN += 1;
      const t = packetTypeOfHex(row.hex, row.family);
      const k = `${row.family || '?'}:${t ?? 'na'}`;
      frameTypes[k] = (frameTypes[k] || 0) + 1;
    }
  } catch { /* skip */ }
}

let imuN = 0;
let imuWithGyro = 0;
let imuWithAccel = 0;
for (const p of imuKeys.slice(0, 24)) {
  try {
    const obj = await stores.raw.getObject(p.key);
    if (!obj?.body) continue;
    for (const rec of decodeImuArchive(obj.body)) {
      imuN += 1;
      if (rec.accel_x?.length) imuWithAccel += 1;
      if (rec.gyro_x?.length) imuWithGyro += 1;
    }
  } catch { /* skip */ }
}

report.archives = {
  physSamples: samples.length,
  sources: samples.reduce((acc, s) => {
    acc[s.src || 'unknown'] = (acc[s.src || 'unknown'] || 0) + 1;
    return acc;
  }, {}),
  framePacketsSampled: frameN,
  frameTypes,
  imuRecordsSampled: imuN,
  imuWithAccel,
  imuWithGyro,
};

const rhrByDay = Object.fromEntries(metrics.map((m) => [m.day, Number(m.resting_hr_bpm)]));
const daysForHrMax = metrics.map((m) => ({ day: m.day, maxHr: m.max_hr_bpm }));
const hrMax = resolveHrMax({ days: daysForHrMax });

report.windows = labels.map((lab) => {
  const rhr = rhrByDay[lab.day] || rhrByDay[Object.keys(rhrByDay).sort().reverse().find((d) => d <= lab.day)] || null;
  const win = samples.filter((s) => {
    const t = tsOf(s);
    return t != null && t >= lab.padStart && t < lab.padEnd;
  });
  const inBout = samples.filter((s) => {
    const t = tsOf(s);
    return t != null && t >= lab.start && t < lab.end;
  });
  const bpms = inBout.map((s) => Number(s.bpm)).filter((n) => Number.isFinite(n));
  const mots = inBout.map((s) => Number(s.mot ?? s.motion)).filter((n) => Number.isFinite(n));
  const dyns = inBout.map((s) => Number(s.dyn_accel)).filter((n) => Number.isFinite(n));
  const live = win.filter((s) => /whoop_rt|gatt_hr|ble_hr/.test(String(s.src || '')));
  const liveOnly = live.length ? live : win.filter((s) => s.src && !/hist|history|offload/.test(String(s.src)));
  const v1All = replayV1(win, { restingHr: rhr, maxHr: hrMax.value, start: lab.start, end: lab.end });
  const v1Live = replayV1(liveOnly, { restingHr: rhr, maxHr: hrMax.value, start: lab.start, end: lab.end });
  const overlappingSessions = sessions.filter((s) => {
    const a = Date.parse(s.start_at);
    const b = Date.parse(s.end_at);
    return a < lab.end && b > lab.start;
  }).map((s) => ({ kind: s.kind, source: s.source, start: s.start_at, sport: s.summary?.sport }));

  // matched negative: 45 min before bout
  const negStart = lab.start - PAD_MIN * 60_000;
  const negEnd = lab.start;
  const v1Neg = replayV1(win, { restingHr: rhr, maxHr: hrMax.value, start: negStart, end: negEnd });

  return {
    id: lab.id,
    label: `${lab.day} ${lab.start}–${lab.end} ${lab.sport}`,
    local: { start: lab.start, end: lab.end },
    utc: { start: new Date(lab.start).toISOString(), end: new Date(lab.end).toISOString() },
    rhr,
    hrMax: hrMax.value,
    hrMaxSource: hrMax.source,
    overlappingSessions,
    coverage: {
      hr: coverage(inBout, lab.start, lab.end, (s) => Number.isFinite(Number(s.bpm))),
      rr: coverage(inBout, lab.start, lab.end, (s) => Array.isArray(s.rr_ms) && s.rr_ms.length > 0),
      mot: coverage(inBout, lab.start, lab.end, (s) => Number.isFinite(Number(s.mot ?? s.motion))),
      dyn_accel: coverage(inBout, lab.start, lab.end, (s) => Number.isFinite(Number(s.dyn_accel))),
      gravity: coverage(inBout, lab.start, lab.end, (s) => s.gx != null && s.gy != null && s.gz != null),
      steps: coverage(inBout, lab.start, lab.end, (s) => s.steps != null || s.step_cumulative != null),
      activity_class: coverage(inBout, lab.start, lab.end, (s) => s.activity_class != null),
      skin: coverage(inBout, lab.start, lab.end, (s) => s.skin_temp_c != null),
    },
    hrStats: bpms.length ? {
      n: bpms.length, min: Math.min(...bpms), max: Math.max(...bpms),
      mean: Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length),
    } : null,
    motStats: mots.length ? {
      n: mots.length, mean: Math.round(1000 * mots.reduce((a, b) => a + b, 0) / mots.length) / 1000,
      max: Math.round(1000 * Math.max(...mots)) / 1000,
    } : null,
    dynStats: dyns.length ? {
      n: dyns.length, mean: Math.round(1000 * dyns.reduce((a, b) => a + b, 0) / dyns.length) / 1000,
      max: Math.round(1000 * Math.max(...dyns)) / 1000,
    } : null,
    v1_all_phys: v1All,
    v1_live_src: { n: liveOnly.length, ...v1Live },
    v1_pre_window_negative: { hit: v1Neg.hit, miss: v1Neg.miss, starts: v1Neg.starts },
  };
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
