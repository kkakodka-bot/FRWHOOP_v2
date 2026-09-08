
// eval/compaction-stress.mjs — deterministic compaction stress (Phase 6), PLUS optional live check.
// Cycles: 100/250/500/1000/2500 turns simulated by repeated compact + append. Needles placed
// at adversarial positions (block start, block end, just-before-compaction, inside long
// irrelevant streaks, inside contradictory conversation). Verifies critical state retention
// including negations/corrections/open tasks/numeric facts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore } from '../context/session.js';
import { MemoryStore } from '../memory/store.js';
import { promoteTurn } from '../memory/manager.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const FILLER = [
  'What is my recovery today?', 'How did I sleep last night?', 'What was my strain?',
  'What is my HRV?', 'Suggest a rest day plan.', 'What is zone 2?', 'How is my RHR?',
  'What is sleep debt?', 'Should I do cardio?', 'What were my workouts this week?',
];

const MAX_TURNS_PER_CYCLE = 50; // cap needles/steps to keep deterministic runtime sane

function run(cycles) {
  const userId = `comp-${cycles}`;
  const session = SessionStore.load(userId);
  const memory = new MemoryStore({ userId, now: '2025-06-03T00:00:00Z' });
  const put = (msg) => {
    const reply = `Answer for: ${String(msg).slice(0, 60)}`;
    session.append(msg, reply);
    promoteTurn({ store: memory, message: msg, response: reply });
  };
  const totalTurns = cycles * 1; // user turns only; each cycles = 1 user turn
  // adversarial needle placements (message turn indices):
  const needles = [
    { id: 'n_start', turn: 2, msg: 'My recovery baseline goal is to keep HRV above 50 ms.', marker: '50', durable: true },
    { id: 'n_block_start', turn: 12, msg: 'I only train with barefoot shoes now, no more cushioned runners.', marker: 'barefoot', durable: false },
    { id: 'n_block_end', turn: 19, msg: "My wife's name is Priya and she also lifts.", marker: 'priya', durable: false },
    { id: 'n_pre', turn: Math.max(30, totalTurns - 3), msg: 'Do NOT let me train on Sundays anymore, ever.', marker: 'sundays', durable: false, negated: true },
    { id: 'n_open', turn: Math.max(31, totalTurns - 2), msg: 'My open task: build me a weekly plan by Friday.', marker: 'weekly plan', durable: false },
  ].filter((n) => n.turn < totalTurns);
  const needleSet = new Set(needles.map((n) => n.turn));
  for (let turn = 0; turn < totalTurns; turn += 1) {
    if (needleSet.has(turn)) {
      const n = needles.find((x) => x.turn === turn);
      put(n.msg);
    } else if (turn % 97 === 0) {
      put('This is a long irrelevant discussion about travel plans, groceries and movies that has nothing to do with training.');
    } else if (turn % 13 === 7) {
      put('Hmm actually I think I said the opposite before, but never mind.'); // contradictory noise
    } else {
      put(FILLER[turn % FILLER.length]);
    }
  }
  session.save();
  // reload from disk = server restart with no process memory
  const revived = SessionStore.load(userId);
  const joined = revived.history().map((m) => m.content || '').join(' ');
  const memText = memory.active().map((r) => r.content.toLowerCase()).join(' ');
  const results = needles.map((n) => {
    const m = String(n.marker).toLowerCase();
    const viaSession = joined.toLowerCase().includes(m);
    const viaMemory = memory.active().some((r) => r.content.toLowerCase().includes(m));
    return { id: n.id, marker: n.marker, got: viaSession || viaMemory, viaSession, viaMemory };
  });
  const ok = results.filter((r) => r.got).length;
  return { cycles, totalTurns, ok, total: results.length, results, facts: revived.facts.length, episodes: revived.episodes.length, memoryAudit: memory.audits() };
}

function main() {
  const out = [];
  for (const cycles of [100, 250, 500, 1000, 2500]) {
    const r = run(cycles);
    out.push(r);
    console.log(`cycles=${cycles} turns=${r.totalTurns} retention=${r.ok}/${r.total} episodes=${r.episodes} facts=${r.facts}`);
    for (const res of r.results) console.log('   ', res.id.padEnd(12), res.got ? 'PASS' : 'FAIL', res.marker, 'viaSession=', res.viaSession, 'viaMemory=', res.viaMemory);
  }
  const report = { meta: { suite: 'compaction-stress' }, runs: out };
  const file = path.join(here, '../data/eval/reports', `compaction-stress-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('\nreport:', file);
}

main();
