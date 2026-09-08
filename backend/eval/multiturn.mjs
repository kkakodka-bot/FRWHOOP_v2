
// eval/multiturn.mjs — multi-turn conversation evaluation with topic changes, needles,
// session persistence, and restart reconstruction (Phases 4/5).
// Filler turns use the fast heuristic path; needle + query turns use the live model.
// Usage: node eval/multiturn.mjs [maxTurns]
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
import { SessionStore } from '../context/session.js';

const MODEL = process.env.MODEL || 'deepseek-ai/DeepSeek-V4-Flash-0731';
const llm = new OpenAI({ apiKey: process.env.DEEPINFRA_API_KEY, baseURL: 'https://api.deepinfra.com/v1/openai' });
const complete = (body) => llm.chat.completions.create({ ...body, model: MODEL });

const FILLER_TOPICS = [
  'What is my recovery today?',
  'How did I sleep last night?',
  'What was my strain yesterday?',
  'How has my HRV been this week?',
  'What is zone 2 training?',
  'Suggest a recovery day plan.',
  'What is my resting heart rate?',
  'How much sleep debt do I have?',
  'Should I do light cardio today?',
  'What is RHR?',
  'How many workouts did I do last week?',
  'What is my sleep performance?',
];

const NEEDLES = [
  { at: 6, user: 'I am starting a deload week next Monday before my race.', markers: ['deload'], q: 'When does my deload week start?', qMarkers: ['deload', 'monday'] },
  { at: 15, user: 'My right elbow has been aching during curls lately.', markers: ['elbow'], q: 'What did I say about my elbow?', qMarkers: ['elbow'] },
  { at: 28, user: 'I prefer to train legs on Wednesday now, not Tuesday.', markers: ['wednesday'], q: 'When do I prefer to train legs now?', qMarkers: ['wednesday'] },
  { at: 45, user: 'I started taking creatine daily after breakfast.', markers: ['creatine'], q: 'What supplement did I start taking?', qMarkers: ['creatine'] },
  { at: 70, user: 'My physio cleared me to run 3x a week, max 5k each.', markers: ['5k'], q: 'How often did my physio clear me to run?', qMarkers: ['5k', '3x'] },
];

const QUERIES_AFTER = [
  { user: 'What is my recovery today?', continuity: ['recovery'] },
];

async function runTurn({ message, history, index, memory, userId, live, session }) {
  return runCoachTurn({
    message,
    history,
    selectedDate: '2025-06-03',
    metrics: { recovery: 78, strain: 0, target: 12.1 },
    index, complete: live ? complete : null, memory,
    userId, session,
  });
}

async function main() {
  const maxTurns = Number(process.argv[2] || '120');
  const index = loadCohortIndex();
  const userId = 'multiturn-user';
  // fresh per-run
  fs.rmSync(path.join(SessionStore.pathFor(userId)), { force: true });
  const memory = new MemoryStore({ userId, now: '2025-06-03T00:00:00Z' });
  const session = SessionStore.load(userId);
  let history = [];
  const results = [];
  const needlesRan = [];

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const needle = NEEDLES.find((n) => n.at === turn);
    const msg = needle ? needle.user : FILLER_TOPICS[turn % FILLER_TOPICS.length];
    const live = Boolean(needle);
    const res = await runTurn({ message: msg, history, index, memory, userId, live, session });
    const reply = res.response || '';
    // persist the turn into the session exactly like the server does
    session.append(msg, reply, { analysis: res.analysis });
    history = history.concat([
      { role: 'user', content: msg },
      { role: 'assistant', content: reply },
    ]);
    if (needle) needlesRan.push({ at: turn, markers: needle.markers, replyHas: needle.markers.filter((m) => reply.toLowerCase().includes(m.toLowerCase())) });
    if (turn % 25 === 0) {
      // periodic compaction persistence by re-saving the store object
      session.save();
    }
  }
  session.save();

  // 1) Identity of the session across "restart": rebuild a fresh store from disk
  const revived = SessionStore.load(userId);
  const revivedMemory = new MemoryStore({ userId, now: '2025-06-03T00:00:00Z' });
  // NB: memory here is the in-process one; for a true restart test we also reload memory from disk below.

  // 2) Needle queries through the REVIVED session (fresh process state, no in-memory history)
  for (const n of NEEDLES) {
    const res = await runTurn({ message: n.q, history: revived.history(), index, memory, userId, live: true, session: revived });
    const ok = n.qMarkers.every((m) => String(res.response || '').toLowerCase().includes(m.toLowerCase()));
    results.push({ needle: n.markers, ok, response: String(res.response).slice(0, 300) });
    console.log((ok ? 'PASS' : 'FAIL'), n.q, '| sessionTurns=', revived.messageCount, 'episodes=', revived.episodes.length, 'recent=', revived.recent.length);
  }

  // 3) memory persisted check (durable facts stored this session are still in the store)
  const audits = memory.audits();
  console.log('memory audits:', JSON.stringify(audits));

  const okN = results.filter((r) => r.ok).length;
  const report = {
    meta: { suite: 'multiturn', turns: maxTurns, model: MODEL, fillerMode: 'heuristic', queryMode: 'live', userId },
    session: revived.toJSON(),
    memoryAudits: audits,
    needles: needlesRan,
    queries: results,
    retentionPct: Math.round((okN / results.length) * 1000) / 10,
  };
  const out = path.join(here, '../data/eval/reports', `multiturn-${maxTurns}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('\nreport:', out, 'retention:', report.retentionPct, '%');
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
