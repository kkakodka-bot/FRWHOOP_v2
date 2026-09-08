#!/usr/bin/env node
/**
 * Read-only HR continuity probe: B2 physiology/frames vs Supabase series.
 * Never prints secrets. Load env from whoop/backend/.env via storageConfig.
 *
 *   node scripts/hrGapTrace.mjs [--days 7] [--day YYYY-MM-DD] [--tz IANA]
 */
import { storageConfig } from '../storage/config.js';
import { getStores } from '../storage/stores.js';
import { decodeArchive, decodeFrameArchive } from '../ingest/archiveFormat.js';
import { dayBounds, localDateKey } from '../time/dayBoundary.js';
import { classifyGap, hoursSpanned } from '../ingest/gapProvenance.js';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const daysN = Number(flag('days', '7')) || 7;
const tz = flag('tz', 'America/Los_Angeles');
const oneDay = flag('day', null);
const cfg = storageConfig();

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function rest(path, query) {
  const url = `${cfg.supabaseUrl}/rest/v1/${path}?${query}`;
  const res = await fetch(url, {
    headers: {
      apikey: cfg.supabaseServiceRoleKey,
      authorization: `Bearer ${cfg.supabaseServiceRoleKey}`,
      prefer: 'count=exact',
    },
  });
  const text = await res.text();
  let json = [];
  try { json = text ? JSON.parse(text) : []; } catch { json = { error: text.slice(0, 200) }; }
  return { ok: res.ok, status: res.status, json, range: res.headers.get('content-range') };
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
    if (!res.ok) {
      console.error(`rest ${path} ${res.status}: ${text.slice(0, 240)}`);
      return rows;
    }
    const chunk = text ? JSON.parse(text) : [];
    if (!Array.isArray(chunk) || !chunk.length) break;
    rows.push(...chunk);
    if (chunk.length < page) break;
    from += page;
    if (from > 50_000) break;
  }
  return rows;
}

function parseKey(key) {
  // v3/{class}/users/{user}/devices/{device}/{stream}/YYYY/MM/DD/HH/{id}.ext
  const v3 = /^v3\/([^/]+)\/users\/([^/]+)\/devices\/([^/]+)\/([^/]+)\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\//;
  const m = v3.exec(key);
  if (m) {
    return {
      version: 3,
      cls: m[1],
      user: m[2],
      device: m[3],
      stream: m[4],
      yyyy: m[5],
      mm: m[6],
      dd: m[7],
      hh: m[8],
      utcDay: `${m[5]}-${m[6]}-${m[7]}`,
      utcHour: `${m[5]}-${m[6]}-${m[7]}T${m[8]}:00:00Z`,
    };
  }
  const v2 = /^v2\/users\/([^/]+)\/devices\/([^/]+)\/raw\/([^/]+)\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\//;
  const n = v2.exec(key);
  if (n) {
    return {
      version: 2,
      user: n[1],
      device: n[2],
      stream: n[3],
      yyyy: n[4],
      mm: n[5],
      dd: n[6],
      hh: n[7],
      utcDay: `${n[4]}-${n[5]}-${n[6]}`,
      utcHour: `${n[4]}-${n[5]}-${n[6]}T${n[7]}:00:00Z`,
    };
  }
  return { version: 0, stream: 'unknown', key };
}

function coverage(times, startMs, endMs, bucketMs) {
  const expected = Math.max(0, Math.floor((endMs - startMs) / bucketMs));
  const set = new Set();
  for (const t of times) {
    if (t < startMs || t >= endMs) continue;
    set.add(Math.floor((t - startMs) / bucketMs));
  }
  const sorted = [...times].filter((t) => t >= startMs && t < endMs).sort((a, b) => a - b);
  let largestGap = 0;
  let gapStart = null;
  let prev = startMs;
  for (const t of sorted) {
    const g = t - prev;
    if (g > largestGap) {
      largestGap = g;
      gapStart = prev;
    }
    prev = t;
  }
  const tail = endMs - prev;
  if (tail > largestGap) {
    largestGap = tail;
    gapStart = prev;
  }
  return {
    expected,
    covered: set.size,
    pct: expected ? Math.round((1000 * set.size) / expected) / 10 : 0,
    sampleCount: sorted.length,
    first: sorted[0] || null,
    last: sorted.at(-1) || null,
    largestGapSec: Math.round(largestGap / 1000),
    largestGapStart: gapStart,
  };
}

function gapsOver(times, startMs, endMs, minSec) {
  const sorted = [...times].filter((t) => t >= startMs && t < endMs).sort((a, b) => a - b);
  const out = [];
  let prev = startMs;
  const push = (from, to) => {
    const sec = (to - from) / 1000;
    if (sec >= minSec) out.push({ from, to, sec: Math.round(sec) });
  };
  for (const t of sorted) {
    push(prev, t);
    prev = t;
  }
  push(prev, endMs);
  return out;
}

function packetTypeOfHex(hex, family) {
  if (!hex || hex.length < 20) return null;
  const typeOff = family === 'puffin' ? 8 : 4;
  const i = typeOff * 2;
  if (hex.length < i + 2) return null;
  return Number.parseInt(hex.slice(i, i + 2), 16);
}

async function listAll(s3, prefix) {
  const keys = await s3.listPrefix(prefix);
  return keys;
}

const now = new Date();
const endDay = oneDay || localDateKey(now, tz);
const start = new Date(Date.parse(dayBounds(endDay, tz).day_start_at) - (daysN - 1) * 86400000);
const startDay = localDateKey(start, tz);
const windowStart = Date.parse(dayBounds(startDay, tz).day_start_at);
const windowEnd = Date.parse(dayBounds(endDay, tz).day_end_at);

const report = {
  generated_at: now.toISOString(),
  timezone: tz,
  window: { startDay, endDay, windowStart: new Date(windowStart).toISOString(), windowEnd: new Date(windowEnd).toISOString() },
  config: {
    supabaseUrlHost: new URL(cfg.supabaseUrl).host,
    b2Bucket: cfg.b2Bucket,
    b2Region: cfg.b2Region,
    serviceRole: Boolean(cfg.supabaseServiceRoleKey),
    localUserId: cfg.localUserId,
    rawStore: cfg.rawStore,
    derivedStore: cfg.derivedStore,
  },
};

console.log(JSON.stringify({ phase: 'config', ...report.config, window: report.window }, null, 2));

if (!cfg.supabaseServiceRoleKey) {
  console.error('NO_SERVICE_ROLE');
  process.exit(2);
}

const devices = await restAll(
  'devices',
  'select=id,user_id,source_kind,device_family,firmware,nickname,last_seen_at,created_at&order=last_seen_at.desc',
);
const seriesMeta = await restAll(
  'daily_physiology_series',
  `select=user_id,day,timezone_name,sample_count,updated_at,hr_series&day=gte.${startDay}&day=lte.${endDay}&order=day.asc`,
);
const metrics = await restAll(
  'daily_metrics',
  `select=user_id,day,avg_hr_bpm,max_hr_bpm,resting_hr_bpm,computed_at,algorithm_version&record_class=eq.user&day=gte.${startDay}&day=lte.${endDay}&order=day.asc`,
);
const manifests = await restAll(
  'object_manifests',
  `select=id,user_id,device_id,object_kind,object_key,status,start_at,end_at,sample_count,compressed_bytes,sha256,schema_version,created_at&start_at=gte.${encodeURIComponent(new Date(windowStart - 12 * 3600000).toISOString())}&start_at=lt.${encodeURIComponent(new Date(windowEnd + 12 * 3600000).toISOString())}&order=start_at.asc`,
);
const gaps = await restAll(
  'ingest_gaps',
  `select=id,user_id,kind,start_at,end_at,expected_samples,received_samples&start_at=lt.${encodeURIComponent(new Date(windowEnd).toISOString())}&end_at=gt.${encodeURIComponent(new Date(windowStart).toISOString())}&order=start_at.asc`,
);
const runs = await restAll(
  'metric_runs',
  `select=id,user_id,algorithm,started_at,finished_at,status,period_day&order=started_at.desc&limit=40`,
);

const userIds = [...new Set([
  ...devices.map((d) => d.user_id),
  ...seriesMeta.map((s) => s.user_id),
  ...manifests.map((m) => m.user_id),
  cfg.localUserId,
].filter(Boolean))];

report.supabase = {
  devices: devices.map((d) => ({
    id: d.id,
    user_id: d.user_id,
    source_kind: d.source_kind,
    device_family: d.device_family,
    firmware: d.firmware,
    last_seen_at: d.last_seen_at,
  })),
  users: userIds,
  series_days: seriesMeta.map((s) => {
    const hr = Array.isArray(s.hr_series) ? s.hr_series : [];
    const withHr = hr.filter((p) => Number.isFinite(Number(p.avg_hr ?? p.bpm)));
    const zeros = hr.filter((p) => Number(p.avg_hr ?? p.bpm) === 0).length;
    const times = withHr.map((p) => Date.parse(p.t || p.bucket_start)).filter(Number.isFinite);
    const bounds = dayBounds(s.day, s.timezone_name || tz);
    const cov = coverage(times, Date.parse(bounds.day_start_at), Date.parse(bounds.day_end_at), 5 * 60_000);
    return {
      user_id: s.user_id,
      day: s.day,
      tz: s.timezone_name,
      sample_count: s.sample_count,
      hr_points: hr.length,
      hr_with_bpm: withHr.length,
      hr_zero: zeros,
      updated_at: s.updated_at,
      coverage5m_pct: cov.pct,
      covered5m: cov.covered,
      expected5m: cov.expected,
      largestGapSec: cov.largestGapSec,
      first: cov.first ? new Date(cov.first).toISOString() : null,
      last: cov.last ? new Date(cov.last).toISOString() : null,
    };
  }),
  metrics: metrics.map((m) => ({
    user_id: m.user_id,
    day: m.day,
    avg_hr_bpm: m.avg_hr_bpm,
    max_hr_bpm: m.max_hr_bpm,
    resting_hr_bpm: m.resting_hr_bpm,
    computed_at: m.computed_at,
    algorithm_version: m.algorithm_version,
  })),
  manifests: {
    count: manifests.length,
    byKind: manifests.reduce((acc, m) => {
      acc[m.object_kind] = (acc[m.object_kind] || 0) + 1;
      return acc;
    }, {}),
    byStatus: manifests.reduce((acc, m) => {
      acc[m.status] = (acc[m.status] || 0) + 1;
      return acc;
    }, {}),
    sampleTotal: manifests.reduce((n, m) => n + (Number(m.sample_count) || 0), 0),
  },
  ingest_gaps: {
    count: gaps.length,
    byKind: gaps.reduce((acc, g) => {
      acc[g.kind] = (acc[g.kind] || 0) + 1;
      return acc;
    }, {}),
  },
  metric_runs: runs.slice(0, 20).map((r) => ({
    algorithm: r.algorithm,
    day: r.period_day,
    status: r.status,
    started_at: r.started_at,
    finished_at: r.finished_at,
  })),
};

console.log(JSON.stringify({ phase: 'supabase', ...report.supabase }, null, 2));

const stores = await getStores(cfg);
if (!stores.raw) {
  console.error('NO_B2');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(3);
}

const prefixes = [];
for (const uid of userIds) {
  prefixes.push(`v3/core/users/${uid}/`);
  prefixes.push(`v3/ppg/users/${uid}/`);
  prefixes.push(`v3/imu/users/${uid}/`);
  prefixes.push(`v3/diag/users/${uid}/`);
  prefixes.push(`v2/users/${uid}/`);
  prefixes.push(`v1/users/${uid}/`);
}

const allKeys = [];
for (const prefix of prefixes) {
  try {
    const keys = await listAll(stores.raw, prefix);
    allKeys.push(...keys);
  } catch (err) {
    console.error(`listPrefix failed for ${prefix}: ${err.message}`);
  }
}

const parsed = allKeys.map((key) => ({ key, ...parseKey(key) }));
const inWindow = parsed.filter((p) => {
  if (!p.utcHour) return false;
  const t = Date.parse(p.utcHour);
  return t >= windowStart - 12 * 3600000 && t < windowEnd + 12 * 3600000;
});

const byStream = inWindow.reduce((acc, p) => {
  acc[p.stream] = (acc[p.stream] || 0) + 1;
  return acc;
}, {});

report.b2 = {
  listed: allKeys.length,
  inWindow: inWindow.length,
  byStream,
  byHour: {},
};

const physKeys = inWindow.filter((p) => p.stream === 'physiology' || p.stream === 'hr' || p.stream === 'live_hr');
const frameKeys = inWindow.filter((p) => p.stream === 'frames' || p.stream === 'ble');

const samplesByDay = new Map();
const sources = {};
const layouts = {};
let physObjects = 0;
let physHashMismatch = 0;
let invalidBpm = 0;
let duplicateTs = 0;

function dayBucket() {
  return {
    times: [],
    validHr: 0,
    samples: 0,
    src: {},
    layout: {},
    objects: 0,
    first: null,
    last: null,
  };
}

console.log(JSON.stringify({
  phase: 'b2-list',
  listed: allKeys.length,
  inWindow: inWindow.length,
  byStream,
  physiologyObjects: physKeys.length,
  frameObjects: frameKeys.length,
}, null, 2));

const MAX_PHYS = 400;
for (const obj of physKeys.slice(0, MAX_PHYS)) {
  let body;
  try {
    const got = await stores.raw.getObject(obj.key);
    if (!got?.body) continue;
    const manifest = manifests.find((m) => m.object_key === obj.key);
    if (manifest?.sha256) {
      const actual = sha256(got.body);
      if (actual !== manifest.sha256) physHashMismatch += 1;
    }
    const rows = decodeArchive(got.body);
    physObjects += 1;
    for (const row of rows) {
      const t = Date.parse(row.t || row.datetime || row.at || '');
      if (!Number.isFinite(t)) continue;
      const day = localDateKey(new Date(t), tz);
      if (!samplesByDay.has(day)) samplesByDay.set(day, dayBucket());
      const b = samplesByDay.get(day);
      b.samples += 1;
      b.objects = (b.objects || 0);
      const bpm = Number(row.bpm ?? row.heartRate);
      const valid = Number.isFinite(bpm) && bpm >= 20 && bpm <= 240;
      if (valid) {
        b.validHr += 1;
        b.times.push(t);
      } else if (Number.isFinite(bpm)) {
        invalidBpm += 1;
      }
      const src = String(row.src || row.source || 'unknown');
      b.src[src] = (b.src[src] || 0) + 1;
      sources[src] = (sources[src] || 0) + 1;
      const layout = String(row.layout || 'none');
      b.layout[layout] = (b.layout[layout] || 0) + 1;
      layouts[layout] = (layouts[layout] || 0) + 1;
      if (!b.first || t < b.first) b.first = t;
      if (!b.last || t > b.last) b.last = t;
    }
    const hour = obj.utcHour;
    report.b2.byHour[hour] = (report.b2.byHour[hour] || 0) + 1;
  } catch (err) {
    console.error(`phys get failed ${obj.utcHour}: ${err.message}`);
  }
}

// Frame census: decode a bounded set, count packet types near gaps later.
const frameCensus = { objects: 0, notifies: 0, types: {}, chars: {}, families: {} };
const MAX_FRAMES = 80;
const frameTimesByType = { 40: [], 43: [], 47: [], gatt: [] };
const frameHours = new Set(frameKeys.map((p) => p.utcHour));

for (const obj of frameKeys.slice(-MAX_FRAMES)) {
  try {
    const got = await stores.raw.getObject(obj.key);
    if (!got?.body) continue;
    const rows = decodeFrameArchive(got.body);
    frameCensus.objects += 1;
    frameCensus.notifies += rows.length;
    for (const row of rows) {
      const fam = row.family || 'unknown';
      frameCensus.families[fam] = (frameCensus.families[fam] || 0) + 1;
      const ch = String(row.char || '').toUpperCase();
      frameCensus.chars[ch.slice(0, 36)] = (frameCensus.chars[ch.slice(0, 36)] || 0) + 1;
      const t = Date.parse(row.t || '');
      if (ch.includes('2A37')) {
        frameCensus.types.gatt_2a37 = (frameCensus.types.gatt_2a37 || 0) + 1;
        if (Number.isFinite(t)) frameTimesByType.gatt.push(t);
        continue;
      }
      const pt = packetTypeOfHex(row.hex, fam);
      if (pt != null) {
        frameCensus.types[pt] = (frameCensus.types[pt] || 0) + 1;
        if (Number.isFinite(t) && frameTimesByType[pt]) frameTimesByType[pt].push(t);
      }
    }
  } catch (err) {
    console.error(`frame get failed: ${err.message}`);
  }
}

const recon = [];
for (let i = 0; i < daysN; i += 1) {
  const day = localDateKey(new Date(windowStart + i * 86400000 + 12 * 3600000), tz);
  const bounds = dayBounds(day, tz);
  const startMs = Date.parse(bounds.day_start_at);
  const endMs = Date.parse(bounds.day_end_at);
  const b = samplesByDay.get(day) || dayBucket();
  const unique = new Set(b.times.map((t) => Math.floor(t / 1000)));
  duplicateTs += Math.max(0, b.times.length - unique.size);
  const cov = coverage(b.times, startMs, endMs, 5 * 60_000);
  const hourCov = coverage(b.times, startMs, endMs, 60 * 60_000);
  const sb = report.supabase.series_days.find((s) => s.day === day);
  const md = report.supabase.metrics.find((m) => m.day === day);
  const dayGaps = gapsOver(b.times, startMs, endMs, 10);
  recon.push({
    day,
    b2_phys_samples: b.samples,
    b2_valid_hr: b.validHr,
    b2_unique_sec: unique.size,
    b2_5m_pct: cov.pct,
    b2_5m_covered: cov.covered,
    b2_hour_pct: hourCov.pct,
    b2_largest_gap_s: cov.largestGapSec,
    b2_first: b.first ? new Date(b.first).toISOString() : null,
    b2_last: b.last ? new Date(b.last).toISOString() : null,
    b2_src: b.src,
    supabase_5m: sb?.hr_with_bpm ?? 0,
    supabase_5m_pct: sb?.coverage5m_pct ?? 0,
    supabase_gap_s: sb?.largestGapSec ?? null,
    supabase_zeros: sb?.hr_zero ?? 0,
    metrics_avg_hr: md?.avg_hr_bpm ?? null,
    gaps_gt_10s: dayGaps.length,
    gaps_gt_10m: dayGaps.filter((g) => g.sec >= 600).length,
    gaps_gt_30m: dayGaps.filter((g) => g.sec >= 1800).length,
    top_gaps: dayGaps.sort((a, b) => b.sec - a.sec).slice(0, 8).map((g) => {
      const hours = hoursSpanned(g.from, g.to);
      const sbTimes = seriesMeta
        .filter((s) => s.day === day)
        .flatMap((s) => (Array.isArray(s.hr_series) ? s.hr_series : []))
        .map((p) => Date.parse(p.t || p.bucket_start))
        .filter(Number.isFinite);
      const cls = classifyGap({
        b2NormalizedHr: b.times.some((t) => t >= g.from && t < g.to),
        supabaseHr: sbTimes.some((t) => t >= g.from && t < g.to),
        apiHr: sbTimes.some((t) => t >= g.from && t < g.to),
        frontendHr: sbTimes.some((t) => t >= g.from && t < g.to),
        b2AnyFrames: hours.some((h) => frameHours.has(h)),
        b2RawType40: (frameTimesByType[40] || []).some((t) => t >= g.from && t < g.to),
        b2RawType47: (frameTimesByType[47] || []).some((t) => t >= g.from && t < g.to),
        b2RawGatt: (frameTimesByType.gatt || []).some((t) => t >= g.from && t < g.to),
      });
      return {
        from: new Date(g.from).toISOString(),
        to: new Date(g.to).toISOString(),
        sec: g.sec,
        class: cls,
      };
    }),
  });
}

report.b2.physiology = {
  objectsDecoded: physObjects,
  hashMismatch: physHashMismatch,
  invalidBpm,
  duplicateUnixSec: duplicateTs,
  sources,
  layouts,
};
report.b2.frames = frameCensus;
report.reconciliation = recon;

console.log(JSON.stringify({ phase: 'reconciliation', recon, physiology: report.b2.physiology, frames: frameCensus }, null, 2));
process.stdout.write(`${JSON.stringify({ ok: true, report }, null, 2)}\n`);
