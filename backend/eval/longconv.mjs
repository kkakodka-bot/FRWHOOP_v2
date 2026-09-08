
// eval/longconv.mjs — long conversation stress test with needle facts at random positions.
// Filler turns run the fast heuristic path; needle + query turns run the live model so
// durable memory promotion + compaction are exercised end-to-end. Reports JSON.
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

const MODEL = process.env.MODEL || 'deepseek-ai/DeepSeek-V4-Flash-0731';
const llm = new OpenAI({ apiKey: process.env.DEEPINFRA_API_KEY, baseURL: 'https://api.deepinfra.com/v1/openai' });
const complete = (body) => llm.chat.completions.create({ ...body, model: MODEL });

const FILLERS = [
  'What is my recovery today?',
  'How much sleep debt do I have?',
  'What was my strain yesterday?',
  'Should I train today?',
  'What is zone 2 training?',
  'What are my HRV trends this week?',
  'Suggest a recovery day plan.',
  'What is my resting heart rate?',
  'How did I sleep?',
  'What is RHR?',
];

// Adversarial placement: needles sit at block-END positions (worst case for compaction).
const NEEDLES = [
  { at: 9, user: 'My favorite recovery drink is beet juice, and I try to have it after evening runs.', markers: ['beet'], q: 'What did I tell you about recovery drinks?', qMarkers: ['beet'] },
  { at: 19, user: 'My left ankle has been tight ever since the trail run last Saturday.', markers: ['ankle', 'tight'], q: 'What happened to my left ankle?', qMarkers: ['ankle'] },
  { at: 29, user: 'I am deloading next week before my 10K race.', markers: ['deload'], q: 'Am I deloading next week?', qMarkers: ['deload'] },
  { at: 49, user: 'I decided to switch my long run to Saturday mornings instead of Sundays.', markers: ['saturday'], q: 'When did I move my long run to?', qMarkers: ['saturday'] },
  { at: 69, user: 'My coach said to keep my zone 2 heart rate under 135 bpm.', markers: ['135'], q: 'What heart rate zone did my coach say to stay under?', qMarkers: ['135'] },
];

function hasAny(needleMarkers, text) {
  return needleMarkers.some((m) => String(text).toLowerCase().includes(String(m).toLowerCase()));
}

async function main() {
  const cohort = loadCohortIndex();
  const NOW = '2026-08-20T00:00:00Z';
  const store = new MemoryStore({ userId: 'long', now: NOW });
  let history = [];
  let live = 0, heur = 0;
  const events = [];

  for (let turn = 0; turn < 80; turn += 1) {
    const needle = NEEDLES.find((n) => n.at === turn);
    let msg;
    if (needle) msg = needle.user; else msg = FILLERS[turn % FILLERS.length];
    const isLive = Boolean(needle);
    const res = await runCoachTurn({
      message: msg,
      history,
      selectedDate: '2025-06-03',
      metrics: { recovery: 78, strain: 0, target: 12.1 },
      index: cohort,
      complete: isLive ? complete : null,
      memory: store,
      userId: 'long',
    });
    history = history.concat([
      { role: 'user', content: msg },
      { role: 'ai', content: res.response || '' },
    ]);
    if (isLive) { live += 1; events.push({ turn, needle: needle.markers, promoted: res.analysis?.memoryWritten }); }
    else { heur += 1; }
  }

  // Query turns (live) with FULL rolling history to force compaction.
  const queries = [];
  for (const n of NEEDLES) {
    const res = await runCoachTurn({
      message: n.q,
      history,
      selectedDate: '2025-06-03',
      metrics: { recovery: 78, strain: 0, target: 12.1 },
      index: cohort,
      complete,
      memory: store,
      userId: 'long',
    });
    const ok = hasAny(n.qMarkers, res.response);
    queries.push({
      needle: n.markers, question: n.q,
      ok, response: String(res.response).slice(0, 500),
      memActive: store.active().length,
      historyTurns: history.length,
      contextTokens: res.analysis?.contextTokens || null,
    });
    console.log((ok ? 'PASS' : 'FAIL'), n.q, '| activeMem=', store.active().length, 'history=', history.length);
  }

  const okCount = queries.filter((q) => q.ok).length;
  const report = {
    meta: { suite: 'longconv', totalTurns: 70, liveCalls: live + queries.length, heuristicFiller: heur, model: MODEL },
    retentionPct: Math.round((okCount / queries.length) * 1000) / 10,
    queries,
    memoryAudit: store.audits(),
    needles: events,
  };
  const out = path.join(here, '../data/eval/reports', `longconv-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('report:', out, 'retention:', report.retentionPct, '%');
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
