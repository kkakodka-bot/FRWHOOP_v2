import { clampRange, getDay, sliceDays, suggestedDayStrain } from './days.js';
import { BUNDLES } from './lanes.js';

const TOOL_CAP = 3200;
const TREND_ROW_CAP = 28;
const CHART_CAP = 32;

export const TOOL_LABELS = {
  get_day: 'Day',
  get_range: 'Trends',
  get_recovery: 'Recovery',
  get_sleep: 'Sleep',
  get_strain: 'Strain',
  get_workouts: 'Workouts',
  prepare_chart: 'Chart',
  get_metric_history: 'Metric history',
  get_relevant_memories: 'Memories',
  search_user_graph: 'Graph',
  get_user_context: 'User context',
  remember: 'Remember',
  search_user_documents: 'Documents',
  get_document: 'Document',
};

export const ALL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'prepare_chart',
      description: 'Chart a metric series. Copy the returned <chart> block verbatim into the answer. Call at most twice per turn.',
      parameters: {
        type: 'object',
        required: ['metric'],
        properties: {
          metric: {
            type: 'string',
            enum: ['recovery', 'strain', 'hrv', 'rhr', 'sleepPerformance', 'sleepDebtMin', 'deepMin', 'remMin'],
          },
          from_day: { type: 'string', description: 'YYYY-MM-DD' },
          to_day: { type: 'string', description: 'YYYY-MM-DD' },
          limit: { type: 'integer', description: 'max points (<= 32)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_metric_history',
      description: 'Deeper time series for ONE metric over a wide range (up to 90 days): latest, average, min, max, trend, plus rows. Use when the pre-loaded evidence is not enough or you need a longer window for a single metric. For workouts pass metric="workouts" and optionally a sport.',
      parameters: {
        type: 'object',
        required: ['metric'],
        properties: {
          metric: {
            type: 'string',
            enum: ['recovery', 'strain', 'hrv', 'rhr', 'sleepPerformance', 'sleepDebtMin', 'deepMin', 'remMin', 'workouts'],
          },
          from_day: { type: 'string', description: 'YYYY-MM-DD, default 14 days ago' },
          to_day: { type: 'string', description: 'YYYY-MM-DD, default today' },
          sport: { type: 'string', description: 'filter workouts by sport substring' },
          limit: { type: 'integer', description: 'max rows (<= 28)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_user_context',
      description: 'Recall what you know about this user: durable memories (preferences, goals, injuries, schedule, corrections), relevant uploaded document snippets (training plan, physio/coach notes), and graph relationships. Use when the question is about the person, not raw metrics.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you need, e.g. "knee injury history" or "goal and schedule"' },
          types: { type: 'string', description: 'optional: preference|goal|injury|routine|feedback|correction|temporary' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_user_graph',
      description: 'Traverse the user knowledge graph: how entities relate (e.g. user prefers evening workouts; knee soreness started after a leg press on a date). Bounded to a few hops. Use for explicit "how is X related to Y" questions.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Relationship question, e.g. "what usually follows poor sleep"' },
          max_hops: { type: 'integer', description: '1 or 2 (default 2)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_document',
      description: 'Fetch the full content of a specific user document by its id.',
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'document id (from get_user_context results)' },
        },
      },
    },
  },
];

export function toolsForBundle(bundle) {
  const names = BUNDLES[bundle] || BUNDLES.general;
  if (!names.length) return [];
  return ALL_TOOLS.filter((t) => names.includes(t.function.name));
}

export function capText(value, cap = TOOL_CAP) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n…[truncated — ask for a narrower day or metric]`;
}

export async function executeTool(name, args, ctx) {
  const fn = EXECUTORS[name];
  if (!fn) return capText({ error: `unknown tool ${name}` });
  const result = await fn(args || {}, ctx);
  return capText(result);
}

export async function executeTools(calls, ctx, dedup) {
  return Promise.all(calls.map(async (call) => {
    const name = call.name || call.function?.name;
    let args = call.arguments || call.function?.arguments || {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args || '{}'); } catch { args = {}; }
    }
    let deduped = false;
    if (dedup) {
      const key = `${name}|${stableString(args)}`;
      if (dedup.has(key)) {
        const prior = dedup.get(key);
        deduped = true;
        return { name, label: TOOL_LABELS[name] || name, content: `${prior} (This exact call was already returned this turn; no new data.)`, deduped };
      }
      const fresh = await executeTool(name, args, ctx);
      dedup.set(key, fresh);
      return { name, label: TOOL_LABELS[name] || name, content: fresh, deduped };
    }
    const content = await executeTool(name, args, ctx);
    return { name, label: TOOL_LABELS[name] || name, content, deduped };
  }));
}

function stableString(obj) {
  if (Array.isArray(obj)) return `[${obj.map(stableString).join(',')}]`;
  if (obj && typeof obj === 'object') {
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableString(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(obj);
}

const EXECUTORS = {
  get_day: async (args, ctx) => {
    const day = await resolveDay(ctx, args.day || ctx.selectedDate);
    if (!day) return { error: 'no day', day: args.day || ctx.selectedDate };
    return formatDay(day);
  },
  get_range: async (args, ctx) => {
    const rows = await resolveRows(ctx, args);
    const trend = trendSummary(rows, formatTrend);
    return {
      count: rows.length,
      from: rows[rows.length - 1]?.day,
      to: rows[0]?.day,
      summary: trend,
      days: rows.slice(0, TREND_ROW_CAP).map(formatTrend),
    };
  },
  get_recovery: async (args, ctx) => {
    const rows = await resolveRows(ctx, args);
    return summarize(rows, ['recovery', 'hrv', 'rhr'], (row) => ({
      day: row.day,
      recovery: row.recovery,
      hrv: row.hrv,
      rhr: row.rhr,
      suggestedStrain: suggestedDayStrain(row.recovery),
    }));
  },
  get_sleep: async (args, ctx) => {
    const rows = await resolveRows(ctx, args);
    return summarize(rows, ['sleepPerformance', 'sleepDebtMin', 'asleepMin'], (row) => ({
      day: row.day,
      sleepPerformance: row.sleepPerformance,
      efficiency: row.sleepEfficiency,
      asleepMin: row.asleepMin,
      needMin: row.sleepNeedMin,
      debtMin: row.sleepDebtMin,
      deepMin: row.deepMin,
      remMin: row.remMin,
      lightMin: row.lightMin,
      onset: row.sleepOnset,
      wake: row.wakeOnset,
    }));
  },
  get_strain: async (args, ctx) => {
    const rows = await resolveRows(ctx, args);
    return summarize(rows, ['strain'], (row) => {
      const target = suggestedDayStrain(row.recovery);
      return {
        day: row.day,
        strain: row.strain,
        recovery: row.recovery,
        target,
        remaining: row.strain == null ? null : round1(Math.max(0, target - row.strain)),
        workouts: (row.workouts || []).map(formatWorkout),
      };
    });
  },
  get_workouts: async (args, ctx) => {
    const rows = await resolveRows(ctx, { ...args, limit: args.limit || 21 });
    const sport = String(args.sport || '').toLowerCase();
    const items = [];
    for (const row of rows) {
      for (const w of row.workouts || []) {
        if (sport && !String(w.name || '').toLowerCase().includes(sport)) continue;
        items.push({ day: row.day, ...formatWorkout(w) });
      }
    }
    return { count: items.length, workouts: items.slice(0, Math.min(40, Number(args.limit) || 24)) };
  },
  prepare_chart: async (args, ctx) => {
    const metric = args.metric || 'recovery';
    const rows = [...await resolveRows(ctx, { ...args, limit: args.limit || 14 })].reverse();
    const points = rows
      .map((row) => ({ t: row.day, v: row[metric] }))
      .filter((p) => p.v != null)
      .slice(-CHART_CAP);
    const spec = {
      title: metric,
      unit: unitFor(metric),
      points,
    };
    return `<chart>${JSON.stringify(spec)}</chart>`;
  },
  get_relevant_memories: async (args, ctx) => {
    const smile = ctx.memory;
    if (!smile) return { error: 'memory unavailable', memories: [] };
    const q = String(args.query || args.q || '');
    const rows = await smile.search(q || 'general', { types: args.type, limit: 8 });
    return {
      count: rows.length,
      memories: rows.slice(0, 8).map((r) => ({
        id: r.id,
        type: r.type,
        content: r.content,
        confidence: r.confidence,
        provenance: r.provenance,
        lastConfirmedAt: r.lastConfirmedAt,
      })),
    };
  },
  search_user_graph: async (args, ctx) => {
    const smile = ctx.memory;
    if (!smile) return { error: 'graph unavailable', paths: [] };
    const g = smile.searchGraph(String(args.query || ''), { maxHops: Math.min(2, Number(args.max_hops) || 2) });
    return {
      nodes: g.nodes,
      expanded: g.expanded,
      paths: g.paths.slice(0, 24).map((e) => `${e.from} --${e.predicate}--> ${e.to}`),
    };
  },
  remember: async (args, ctx) => {
    const smile = ctx.memory;
    if (!smile) return { error: 'memory unavailable' };
    const rec = smile.add({
      type: 'conversation_event',
      topic: args.topic || 'note',
      content: String(args.note || ''),
      confidence: 0.6,
      provenance: 'inferred',
      stable: false,
    });
    return { ok: true, id: rec.id };
  },
  search_user_documents: async (args, ctx) => {
    const docs = ctx.documents;
    if (!docs) return { error: 'document store unavailable', documents: [] };
    const results = await docs.search(String(args.query || ''), Number(args.limit) || 6);
    return { count: results.length, documents: results };
  },
  get_document: async (args, ctx) => {
    const docs = ctx.documents;
    if (!docs) return { error: 'document store unavailable' };
    const doc = await docs.get(args.id);
    if (!doc) return { error: 'document not found', id: args.id };
    const text = String(doc.text || doc.content || '');
    if (!text.trim()) return { id: doc.id, name: doc.name, kind: doc.kind, date: doc.date, error: 'no text' };
    return { id: doc.id, name: doc.name, kind: doc.kind, date: doc.date, content: text.slice(0, 2400) };
  },
  get_metric_history: async (args, ctx) => {
    const metric = args.metric || 'recovery';
    if (metric === 'workouts') {
      return EXECUTORS.get_workouts(args, ctx);
    }
    const rows = await resolveRows(ctx, args);
    const mapped = rows.map((row) => ({ day: row.day, value: row[metric] != null ? round1(row[metric]) : null })).filter((r) => r.value != null);
    const vals = mapped.map((r) => r.value);
    const summary = vals.length ? {
      latest: vals[vals.length - 1],
      avg: round1(vals.reduce((a, b) => a + b, 0) / vals.length),
      min: round1(Math.min(...vals)),
      max: round1(Math.max(...vals)),
    } : {};
    if (vals.length > 1) {
      const half = Math.floor(vals.length / 2) || 1;
      const m1 = vals.slice(0, half).reduce((a, b) => a + b, 0) / half;
      const m2 = vals.slice(half).reduce((a, b) => a + b, 0) / Math.max(1, vals.length - half);
      summary.trend = m1 === 0 ? 0 : round1(((m2 - m1) / m1) * 100);
    }
    return {
      metric,
      count: mapped.length,
      from: mapped[0]?.day,
      to: mapped[mapped.length - 1]?.day,
      summary,
      rows: mapped.slice(-TREND_ROW_CAP),
    };
  },
  get_user_context: async (args, ctx) => {
    const q = String(args.query || args.q || '');
    const out = {};
    if (ctx.memory) {
      const mems = await ctx.memory.search(q || 'general', { types: args.type, limit: 6 });
      out.memories = (mems || []).map((r) => ({ id: r.id, type: r.type, content: r.content, confidence: r.confidence, provenance: r.provenance }));
    }
    if (ctx.documents) {
      const docs = await ctx.documents.search(q || 'general', 4);
      out.documents = (docs || []).map((d) => ({ id: d.id, name: d.name, kind: d.kind, date: d.date, snippet: d.snippet || '' }));
    }
    if (ctx.memory && /graph|related|relat|connect|how is .* linked|precede|follow/i.test(q)) {
      out.graph = ctx.memory.searchGraph(q, { maxHops: 2, maxNodes: 20 });
    }
    return out;
  },
};



const TREND_HINT = /\b(trend\w*|chang\w*|over the (?:last|past)|this month|last (?:week|month|few|three)|pattern\w*|progress|improving|improv\w*|how has|how is my .* (?:looking|doing)|relatio|compar\w*)\b/i;
const METRIC_BY_INTENT = {
  recovery: 'recovery', sleep: 'sleepPerformance', strain: 'strain', general: 'recovery',
};
const MENTION_METRICS = [
  ['hrv', ['hrv', 'heart rate variab']],
  ['rhr', ['resting heart', 'rhr']],
  ['sleepDebtMin', ['debt']],
  ['remMin', ['rem']],
  ['deepMin', ['deep']],
  ['sleepPerformance', ['sleep performance', 'sleep quality']],
  ['strain', ['strain']],
  ['recovery', ['recover', 'readiness']],
];

function metricFromMessage(message, intent) {
  const lower = String(message || '').toLowerCase();
  for (const [metric, sigs] of MENTION_METRICS) {
    if (metric !== METRIC_BY_INTENT[intent] && sigs.some((s) => lower.includes(s))) return metric;
  }
  return METRIC_BY_INTENT[intent] || 'recovery';
}

/**
 * Deterministic chart pre-build for trend/correlation questions: the router decides a
 * chart is appropriate, so the model never has to. Returns { metric, chart } or null.
 * opts.range: {fromDay,toDay,limit} — defaults to last 30 days.
 */
export async function chartHint(ctx, intent, message, range) {
  if (!TREND_HINT.test(String(message || ''))) return null;
  const metric = metricFromMessage(message, intent);
  const days = ctx.index?.days?.length ? ctx.index : null;
  if (!days) return null;
  const to = range?.toDay || ctx.selectedDate || ctx.index.lastDay;
  const from = range?.fromDay || addDaysIso(to, -29);
  const chart = await EXECUTORS.prepare_chart({ metric, from_day: from, to_day: to, limit: 30 }, ctx);
  return { metric, chart };
}

function addDaysIso(iso, delta) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export async function fetchEvidence(ctx, intent, range, query = '') {
  const args = range || {};
  // Wide windows get more rows so long-range trends show real detail (summaries still
  // aggregate over the FULL window). Narrow windows (yesterday/today) stay tiny.
  const narrow = args.limit != null && args.limit <= 3;
  const show = narrow ? (args.limit || 1) : (args.limit && args.limit <= 7 ? args.limit : Math.min(28, Number(args.limit) || 14));
  // Lane-2 evidence is ALWAYS the complete, cross-cutting slice: one deterministic call,
  // one model call. Recovery/sleep/strain/why-questions all get the same full view.
  const [day, rec, sleep, strain] = await Promise.all([
    EXECUTORS.get_day({ day: ctx.selectedDate }, ctx),
    EXECUTORS.get_recovery({ ...args, limit: show }, ctx),
    EXECUTORS.get_sleep({ ...args, limit: show }, ctx),
    EXECUTORS.get_strain({ ...args, limit: show }, ctx),
  ]);
  const base = { day, recoveryWeek: rec, sleepWeek: sleep, strainWeek: strain };
  if (ctx.documents && query) {
    try {
      const docs = await ctx.documents.search(query, 3);
      if (docs && docs.length) base.relevantDocuments = docs.map((d) => ({
        id: d.id, name: d.name, kind: d.kind, date: d.date, snippet: d.snippet || '',
      }));
    } catch { /* docs are best-effort */ }
  }
  return base;
}

async function resolveDay(ctx, day) {
  if (ctx.cloud?.getDay) {
    const remote = await ctx.cloud.getDay(day);
    if (remote) return remote;
  }
  return getDay(ctx.index, day);
}

async function resolveRows(ctx, args) {
  const { fromDay, toDay } = clampRange(args.from_day || args.fromDay, args.to_day || args.toDay, 90);
  const limit = Math.max(1, Math.min(90, Number(args.limit) || 14));
  if (ctx.cloud?.getRange && fromDay && toDay) {
    const remote = await ctx.cloud.getRange(fromDay, toDay, limit);
    if (remote?.length) return remote;
  }
  return sliceDays(ctx.index, { fromDay, toDay, limit });
}

function summarize(rows, avgKeys, mapRow) {
  const mapped = rows.map(mapRow);
  const avgs = {};
  for (const key of avgKeys) {
    const vals = mapped.map((r) => r[key]).filter((v) => v != null);
    avgs[key] = vals.length ? round1(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }
  const summary = {};
  for (const key of avgKeys) {
    const vals = mapped.map((r) => r[key]).filter((v) => v != null);
    if (!vals.length) { summary[key] = null; continue; }
    const half = Math.floor(vals.length / 2);
    const first = vals.slice(0, half || 1);
    const latest = vals.slice(half, vals.length);
    const m1 = first.reduce((a, b) => a + b, 0) / first.length;
    const m2 = latest.reduce((a, b) => a + b, 0) / latest.length;
    summary[key] = {
      latest: round1(vals[vals.length - 1]),
      avg: round1(vals.reduce((a, b) => a + b, 0) / vals.length),
      min: round1(Math.min(...vals)),
      max: round1(Math.max(...vals)),
      trend: m1 === 0 ? 0 : round1(((m2 - m1) / m1) * 100),
    };
  }
  return {
    count: mapped.length,
    from: mapped[mapped.length - 1]?.day,
    to: mapped[0]?.day,
    averages: avgs,
    summary,
    days: mapped.slice(0, TREND_ROW_CAP),
  };
}

function formatDay(row) {
  const target = suggestedDayStrain(row.recovery);
  return {
    day: row.day,
    recovery: row.recovery,
    strain: row.strain,
    suggestedStrain: target,
    remaining: row.strain == null ? null : round1(Math.max(0, target - row.strain)),
    hrv: row.hrv,
    rhr: row.rhr,
    resp: row.resp,
    spo2: row.spo2,
    calories: row.calories,
    sleepPerformance: row.sleepPerformance,
    sleepEfficiency: row.sleepEfficiency,
    asleepMin: row.asleepMin,
    sleepNeedMin: row.sleepNeedMin,
    sleepDebtMin: row.sleepDebtMin,
    deepMin: row.deepMin,
    remMin: row.remMin,
    lightMin: row.lightMin,
    sleepOnset: row.sleepOnset,
    wakeOnset: row.wakeOnset,
    workouts: (row.workouts || []).map(formatWorkout),
  };
}

function trendSummary(rows, fmt) {
  const mapped = rows.map(fmt);
  const keys = ['recovery', 'strain', 'hrv', 'rhr', 'sleepPerformance', 'sleepDebtMin', 'workouts'];
  const out = {};
  for (const key of keys) {
    const vals = mapped.map((r) => r[key]).filter((v) => v != null && !(key === 'workouts' && typeof v === 'object'));
    if (!vals.length) continue;
    const half = Math.floor(vals.length / 2) || 1;
    const first = vals.slice(0, half); const latest = vals.slice(half);
    const m1 = first.reduce((a, b) => a + b, 0) / first.length;
    const m2 = latest.reduce((a, b) => a + b, 0) / latest.length;
    out[key] = { latest: round1(vals[vals.length - 1]), avg: round1(vals.reduce((a, b) => a + b, 0) / vals.length), min: round1(Math.min(...vals)), max: round1(Math.max(...vals)), trend: m1 === 0 ? 0 : round1(((m2 - m1) / m1) * 100) };
  }
  return out;
}

function formatTrend(row) {
  return {
    day: row.day,
    recovery: row.recovery,
    strain: row.strain,
    hrv: row.hrv,
    rhr: row.rhr,
    sleepPerformance: row.sleepPerformance,
    sleepDebtMin: row.sleepDebtMin,
    workouts: (row.workouts || []).length,
  };
}

function formatWorkout(w) {
  return {
    name: w.name,
    start: w.start,
    durationMin: w.durationMin,
    strain: w.strain,
    avgHr: w.avgHr,
    calories: w.calories,
  };
}

function unitFor(metric) {
  if (metric === 'hrv') return 'ms';
  if (metric === 'rhr') return 'bpm';
  if (metric === 'strain') return '0-21';
  if (/Min$/.test(metric)) return 'min';
  return '%';
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}
