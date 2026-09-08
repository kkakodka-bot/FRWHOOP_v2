
// eval/latency-bench.mjs — latency distributions by request class (Phase 12).
// Uses a STREAMING complete so TTFT + generation time are measured separately from
// app-controlled stages. Returns per-class p50/p95/p99 and provider-vs-app split.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '../../noop/docs/.env'), override: false });
dotenv.config();

import { runCoachTurn } from '../coach/loop.js';
import { loadCohortIndex } from './lib/runner.js';
import { MemoryStore } from '../memory/store.js';
import { DocumentStore } from '../documents/store.js';
import { MEMORY_FIXTURES } from './suites/coaching.suite.js';
import { DOC_FIXTURES, USER_DOCS } from './suites/coaching.suite.js';

const MODEL = process.env.MODEL || 'deepseek-ai/DeepSeek-V4-Flash-0731';
const llm = new OpenAI({ apiKey: process.env.DEEPINFRA_API_KEY, baseURL: 'https://api.deepinfra.com/v1/openai' });

// Streaming completion that returns the non-stream shape + _ttftMs + _genMs
let ES = null;
async function getEncoder() {
  // rough chars/token
  return (s) => Math.ceil(String(s).length / 4);
}

async function nonStream(body) {
  const res = await llm.chat.completions.create({ ...body, model: MODEL });
  const m = res.choices?.[0]?.message || {};
  return { choices: [{ message: m }], usage: res.usage, _ttftMs: null, _genMs: null };
}

async function streamComplete(body) {
  const est = await getEncoder();
  const t0 = Date.now();
  let ttft = null;
  let content = '';
  const toolCalls = [];
  let usage = null;
  let stream;
  try {
    stream = await llm.chat.completions.create({ ...body, model: MODEL, stream: true });
  } catch (e) {
    // resumed tool-round requests occasionally fail under streaming — fall back to non-stream
    return nonStream(body);
  }
  try {
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta || {};
    if (ttft == null && (delta.content || (delta.tool_calls || []).length)) ttft = Date.now() - t0;
    if (delta.content) content += delta.content;
    let ti = 0;
    for (const tc of delta.tool_calls || []) {
      const idx = tc.index != null ? tc.index : ti++;
      let target = toolCalls[idx];
      if (!target) { target = { id: '', type: 'function', function: { name: '', arguments: '' } }; toolCalls[idx] = target; }
      if (tc.id) target.id = tc.id;
      if (tc.function?.name) target.function.name += tc.function.name;
      if (tc.function?.arguments) target.function.arguments += tc.function.arguments;
    }
    if (chunk.usage) usage = chunk.usage;
  }
  } catch (e) {
    return nonStream(body);
  }
  const total = Date.now() - t0;
  return {
    choices: [{ message: {
      role: 'assistant',
      content: toolCalls.length ? (content || '') : (content || null),
      tool_calls: toolCalls.filter((tc) => tc.function.name && tc.function.name.trim()).map((tc) => ({ id: tc.id || `tool-${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments || '{}' } })),
    } }],
    usage: usage || { prompt_tokens: est(''), completion_tokens: est(content) },
    _ttftMs: ttft && ttft < total ? ttft : total,
    _genMs: ttft != null ? Math.max(0, total - ttft) : total,
  };
}

const CLASSES = [
  { cls: 'simple', q: 'How did I sleep last night?', n: 5, intent: 'sleep' },
  { cls: 'structured', q: 'What are my recovery trends this month?', n: 5, intent: 'recovery' },
  { cls: 'complex', q: 'Compare my HRV after hard leg days to my normal recovery pattern.', n: 4, intent: 'recovery' },
  { cls: 'memory', q: 'What did I tell you about my knee and what is my goal?', n: 4, intent: 'general' },
];

function pctile(arr, p) { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? null; }

async function main() {
  const index = loadCohortIndex();
  const documents = new DocumentStore({ userId: 'alex', docs: (USER_DOCS.alex || []).map((id) => ({ ...DOC_FIXTURES[id], userId: 'alex' })) });
  const memory = new MemoryStore({ userId: 'alex', now: '2026-08-20T00:00:00Z' });
  for (const id of MEMORY_FIXTURES.alex.map((x) => x.id)) {
    const f = MEMORY_FIXTURES.alex.find((x) => x.id === id);
    if (f) memory.add({ ...f, userId: 'alex' });
  }

  const report = { meta: { suite: 'latency-bench', model: MODEL, provider: 'deepinfra-streaming', generatedAt: new Date().toISOString() }, classes: [] };
  for (const c of CLASSES) {
    const total = [], ttft = [], gen = [], appOverhead = [], modelCalls = [];
    let appTotal = 0;
    for (let rep = 0; rep < c.n; rep += 1) {
      const t0 = Date.now();
      let res;
      try {
        res = await runCoachTurn({
          message: c.q, selectedDate: '2025-06-03',
          metrics: { recovery: 78, strain: 0, target: 12.1 },
          index, complete: streamComplete, memory, documents, userId: 'alex',
        });
      } catch (err) {
        console.error('TURN ERR', err.message);
        if (err.args) console.error('ARGS-BODY', JSON.stringify(err.args)?.slice(0, 1500));
        throw err;
      }
      const el = Date.now() - t0;
      total.push(el);
      const perf = res.analysis?.perf || [];
      const callMs = perf.filter((p) => p.k.startsWith('model_call_') && !p.k.endsWith('_ttft')).reduce((a, p) => a + p.ms, 0);
      const callTtft = perf.filter((p) => p.k.endsWith('_ttft')).reduce((a, p) => a + p.ms, 0);
      if (callTtft) ttft.push(callTtft);
      gen.push(callMs - callTtft || 0);
      appTotal = el - callMs;
      appOverhead.push(Math.max(0, appTotal));
      modelCalls.push(perf.filter((p) => p.k.startsWith('model_call_') && !p.k.endsWith('_ttft')).length);
      console.log(`${c.cls} rep${rep}: total=${el}ms provider=${Math.round(callMs)} app=${Math.round(appOverhead[appOverhead.length-1])}ms ttft=${callTtft ? Math.round(callTtft) : 'n/a'}ms`);
    }
    report.classes.push({
      cls: c.cls,
      n: total.length,
      total: { p50: pctile(total, 0.5), p95: pctile(total, 0.95), p99: pctile(total, 0.99), avg: Math.round(total.reduce((a, b) => a + b, 0) / total.length) },
      provider: { p95: pctile([...total.map((t, i) => t - appOverhead[i])].map((x) => Math.max(0, x)), 0.95), avg: Math.round(total.reduce((a, b) => a + b, 0) / total.length - appOverhead.reduce((a, b) => a + b, 0) / total.length) },
      ttftMs: { p50: pctile(ttft, 0.5), p95: pctile(ttft, 0.95) },
      genMs: { p50: pctile(gen, 0.5), p95: pctile(gen, 0.95) },
      appOverheadMs: { p95: pctile(appOverhead, 0.95), avg: Math.round(appOverhead.reduce((a, b) => a + b, 0) / appOverhead.length) },
      modelCallsPerTurn: Math.round(modelCalls.reduce((a, b) => a + b, 0) / modelCalls.length),
      responses: [],
    });
  }
  const out = path.join(here, '../data/eval/reports', `latency-bench-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('\nreport:', out);
  for (const c of report.classes) console.log(c.cls, JSON.stringify(c.total), 'ttft', JSON.stringify(c.ttftMs), 'app', JSON.stringify(c.appOverheadMs));
}
main().catch((e) => { console.error('ERR', e.message); if (e.data) console.error('DATA', JSON.stringify(e.data).slice(0,800)); if (e.args) console.error('ARGS', JSON.stringify(e.args).slice(0,800)); process.exit(1); });
