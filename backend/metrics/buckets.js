import { dayBounds, localDateKey } from '../time/dayBoundary.js';
import { skinTempSeriesFromSamples } from './temperature.js';

const BUCKET_MS = 5 * 60 * 1000;

export function bucketStartIso(iso, bucketMs = BUCKET_MS) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const aligned = Math.floor(t / bucketMs) * bucketMs;
  return new Date(aligned).toISOString();
}

export function accumulateBucket(existing, sample, bucketMinutes = 5) {
  const bpm = Number(sample?.bpm ?? sample?.heartRate);
  const hasHr = Number.isFinite(bpm) && bpm >= 20 && bpm <= 240;
  const start = existing?.bucket_start || bucketStartIso(sample.datetime || sample.at || sample.t);
  const row = existing || {
    bucket_start: start,
    bucket_minutes: bucketMinutes,
    avg_hr: null,
    min_hr: null,
    max_hr: null,
    avg_motion: null,
    max_motion: null,
    motion_count: 0,
    sample_count: 0,
    strain_increment: 0,
    quality: 1,
    sleep_minutes: 0,
    metadata: {},
    _sum: 0,
    _motSum: 0,
  };
  if (hasHr) {
    row._sum = (row._sum || 0) + bpm;
    row.sample_count += 1;
    row.avg_hr = Math.round((row._sum / row.sample_count) * 10) / 10;
    row.min_hr = row.min_hr == null ? bpm : Math.min(row.min_hr, bpm);
    row.max_hr = row.max_hr == null ? bpm : Math.max(row.max_hr, bpm);
  }
  const src = sample?.src || sample?.source;
  if (src) {
    const list = Array.isArray(row.metadata.sources) ? row.metadata.sources : [];
    if (!list.includes(src)) list.push(src);
    row.metadata.sources = list;
  }
  const mot = Number(sample?.mot ?? sample?.motion);
  if (Number.isFinite(mot) && mot >= 0) {
    row._motSum = (row._motSum || 0) + mot;
    row.motion_count = (row.motion_count || 0) + 1;
    row.avg_motion = Math.round((row._motSum / row.motion_count) * 1000) / 1000;
    row.max_motion = row.max_motion == null ? mot : Math.max(row.max_motion, mot);
  }
  if (sample?.sleep_stage && sample.sleep_stage !== 'none') {
    row.sleep_minutes = (row.sleep_minutes || 0) + (bucketMinutes / Math.max(row.sample_count, 1));
  }
  return row;
}

export function bucketsFromSamples(samples, bucketMinutes = 5) {
  const ms = bucketMinutes * 60 * 1000;
  const map = new Map();
  for (const sample of samples || []) {
    const start = bucketStartIso(sample.datetime || sample.at || sample.t, ms);
    if (!start) continue;
    map.set(start, accumulateBucket(map.get(start), sample, bucketMinutes));
  }
  return [...map.values()]
    .map(({ _sum, _motSum, ...row }) => row)
    .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start));
}

/** Compact motion track for `daily_physiology_series.movement_series`. */
export function movementFromBuckets(rows) {
  return (rows || [])
    .filter((r) => r.avg_motion != null)
    .map((r) => ({
      t: r.bucket_start,
      avg: r.avg_motion,
      max: r.max_motion,
      n: r.motion_count,
    }));
}

export function chartFromBuckets(rows) {
  return (rows || []).map((r) => ({
    t: r.bucket_start,
    avg_hr: r.avg_hr,
    min_hr: r.min_hr,
    max_hr: r.max_hr,
    n: r.sample_count,
    sleep_stage: r.metadata?.sleep_stage || null,
    src: Array.isArray(r.metadata?.sources) ? r.metadata.sources : [],
  }));
}

export function chartFromSeries(row) {
  const series = Array.isArray(row?.hr_series) ? row.hr_series : (Array.isArray(row) ? row : []);
  return series.map((p) => ({
    t: p.t || p.bucket_start,
    avg_hr: p.avg_hr ?? p.avg ?? null,
    min_hr: p.min_hr ?? p.min ?? null,
    max_hr: p.max_hr ?? p.max ?? null,
    n: p.n ?? p.sample_count ?? 0,
    sleep_stage: p.sleep_stage || null,
    src: p.src || p.sources || [],
  }));
}

export function mergeHrSeries(existing, incoming) {
  const map = new Map();
  for (const p of existing || []) {
    if (p?.t) map.set(p.t, p);
  }
  for (const p of incoming || []) {
    if (p?.t) map.set(p.t, p);
  }
  return [...map.values()].sort((a, b) => String(a.t).localeCompare(String(b.t)));
}

export function mergeSkinTempSeries(existing, incoming) {
  const map = new Map();
  for (const p of existing || []) {
    const key = p?.t || p?.datetime;
    if (key) map.set(key, p);
  }
  for (const p of incoming || []) {
    const key = p?.t || p?.datetime;
    if (key) map.set(key, p);
  }
  return [...map.values()].sort((a, b) => (
    String(a.t || a.datetime).localeCompare(String(b.t || b.datetime))
  ));
}

export function mergeStrainSeries(existing, incoming) {
  const map = new Map();
  for (const p of existing || []) {
    const key = p?.bucket_start || p?.t;
    if (key) map.set(key, p);
  }
  for (const p of incoming || []) {
    const key = p?.bucket_start || p?.t;
    if (key) map.set(key, p);
  }
  return [...map.values()].sort((a, b) => (
    String(a.bucket_start || a.t).localeCompare(String(b.bucket_start || b.t))
  ));
}

function bpmOf(row) {
  const n = Number(row?.bpm ?? row?.avg_hr ?? row?.heartRate);
  return Number.isFinite(n) && n >= 20 && n <= 240 ? n : null;
}

function timeOf(row) {
  return Date.parse(row?.datetime || row?.t || row?.at || '');
}

/**
 * Merge two 5-minute HR curves by bucket. Picking the longer array used to
 * drop banked strap history whenever a shorter live overlay (app-open ticks)
 * arrived, and the reverse when live had more buckets than a partial persist.
 * Unparseable fixture timestamps keep the previous longer-array behavior.
 */
export function unionBpmData(left, right, bucketMs = BUCKET_MS) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (!a.length) return b;
  if (!b.length) return a;
  const parseable = (rows) => rows.some((row) => Number.isFinite(timeOf(row)));
  if (!parseable(a) && !parseable(b)) return b.length >= a.length ? b : a;
  const map = new Map();
  const ingest = (rows, incoming) => {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const bpm = bpmOf(row);
      if (bpm == null) continue;
      const t = timeOf(row);
      const key = Number.isFinite(t)
        ? Math.floor(t / bucketMs)
        : `raw:${row.datetime || row.t || row.at || ''}`;
      const aligned = Number.isFinite(t)
        ? { ...row, datetime: new Date(key * bucketMs).toISOString(), bpm, src: row.src || row.source }
        : { ...row, bpm, src: row.src || row.source };
      const prev = map.get(key);
      if (!prev) {
        map.set(key, aligned);
        continue;
      }
      const hist = (r) => r?.src === 'whoop_history' || r?.source === 'whoop_history';
      if (hist(aligned) && !hist(prev)) {
        map.set(key, aligned);
        continue;
      }
      if (!hist(aligned) && hist(prev)) continue;
      if (prev.live && !aligned.live) {
        map.set(key, aligned);
        continue;
      }
      if (!prev.live && aligned.live) continue;
      const prevN = Number(prev.n) || 0;
      const nextN = Number(aligned.n) || 0;
      if (nextN > prevN || (nextN === prevN && incoming)) map.set(key, aligned);
    }
  };
  ingest(a, false);
  ingest(b, true);
  return [...map.entries()]
    .sort((x, y) => {
      const ka = x[0];
      const kb = y[0];
      if (typeof ka === 'number' && typeof kb === 'number') return ka - kb;
      return String(ka).localeCompare(String(kb));
    })
    .map(([, row]) => row);
}

export function seriesFromSamples(samples, {
  userId,
  day,
  timeZone = 'UTC',
  bucketMinutes = 5,
} = {}) {
  const bounds = dayBounds(day, timeZone);
  const inDay = bucketsFromSamples(samples, bucketMinutes).filter((b) => (
    b.bucket_start >= bounds.day_start_at && b.bucket_start < bounds.day_end_at
  ));
  const points = chartFromBuckets(inDay);
  return {
    user_id: userId,
    day,
    timezone_name: bounds.timezone_name,
    day_start_at: bounds.day_start_at,
    day_end_at: bounds.day_end_at,
    bucket_minutes: bucketMinutes,
    hr_series: points,
    stress_series: [],
    strain_series: [],
    movement_series: movementFromBuckets(inDay),
    quality_series: [],
    skin_temp_series: skinTempSeriesFromSamples(samples, {
      dayStartAt: bounds.day_start_at,
      dayEndAt: bounds.day_end_at,
    }),
    sample_count: points.reduce((n, p) => n + (Number(p.n) || 0), 0),
    version: 1,
  };
}

/** One series row per local day present in the batch. A flush that crosses
 * midnight must not park the pre-midnight tail on the end day only. */
export function seriesRowsFromSamples(samples, { userId, timeZone = 'UTC', bucketMinutes = 5 } = {}) {
  const days = new Set();
  for (const sample of samples || []) {
    const day = localDateKey(sample?.t || sample?.datetime || sample?.at, timeZone);
    if (day) days.add(day);
  }
  return [...days].sort().map((day) => seriesFromSamples(samples, {
    userId, day, timeZone, bucketMinutes,
  }));
}

export function bpmDataFromBuckets(rows) {
  return (rows || [])
    .filter((r) => r.avg_hr != null)
    .map((r) => ({
      datetime: r.bucket_start.replace('T', ' ').replace(/\.\d{3}Z$/, ''),
      bpm: r.avg_hr,
      sleep_stage: r.metadata?.sleep_stage || 'none',
    }));
}

export function bpmDataFromSeries(row) {
  return chartFromSeries(row)
    .filter((p) => p.avg_hr != null)
    .map((p) => ({
      datetime: String(p.t).replace('T', ' ').replace(/\.\d{3}Z$/, ''),
      bpm: p.avg_hr,
      sleep_stage: p.sleep_stage || 'none',
    }));
}

export function createBucketBuffer({ rest, userId, deviceId, bucketMinutes = 5, timeZone = 'UTC' } = {}) {
  const open = new Map();
  async function ingest(sample) {
    const start = bucketStartIso(sample.datetime || sample.at);
    if (!start) return null;
    const next = accumulateBucket(open.get(start), { ...sample, datetime: sample.datetime || sample.at || sample.t }, bucketMinutes);
    open.set(start, next);
    return next;
  }
  async function flushClosed(nowIso) {
    const now = Date.parse(nowIso || new Date().toISOString());
    const rows = [];
    for (const [start, row] of open) {
      if (Date.parse(start) + bucketMinutes * 60 * 1000 <= now) {
        const { _sum, ...restRow } = row;
        rows.push({
          user_id: userId,
          device_id: deviceId || null,
          ...restRow,
        });
        open.delete(start);
      }
    }
    if (rows.length && rest?.upsert) {
      const byDay = new Map();
      for (const row of rows) {
        const day = localDateKey(row.bucket_start, timeZone);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(row);
      }
      for (const [day, dayRows] of byDay) {
        const series = seriesFromSamples(
          dayRows.map((r) => ({ datetime: r.bucket_start, bpm: r.avg_hr })),
          { userId, day, timeZone, bucketMinutes },
        );
        await rest.upsert('daily_physiology_series', series, { onConflict: 'user_id,day' });
      }
    }
    return rows;
  }
  return { ingest, flushClosed, open };
}
