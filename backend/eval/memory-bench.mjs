
// eval/memory-bench.mjs — deterministic recall/precision/temporal/correction benchmark of the
// memory subsystem (no model). Reports JSON to data/eval/reports/memory-bench-<ts>.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../memory/store.js';
import { promoteTurn } from '../memory/manager.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function hr(ms) {
  const day = 86400000;
  const d = new Date(Date.parse('2025-01-05T00:00:00Z') + ms * day);
  return d.toISOString();
}

// ---- synthetic user with hundreds of interactions, hidden facts seeded via conversation ----
const NOW = '2025-06-01T00:00:00Z';
const CONVERSATIONS = [
  { day: 0, user: 'I prefer evening workouts, mornings feel terrible.', note: 'seed pref evening' },
  { day: 2, user: 'I am training for a 5K and want to break 22 minutes by September.', note: 'seed goal 5k' },
  { day: 5, user: 'My right knee has been sore since the heavy leg press session.', note: 'seed knee' },
  { day: 8, user: 'I usually train Monday, Wednesday, and Friday evenings.', note: 'seed schedule' },
  { day: 12, user: 'I hate high volume leg days, keep them low volume heavy.', note: 'seed leg volume' },
  { day: 20, user: 'My friend Jason the cyclist recommended a taper week.', note: 'noise entity <ignored>' },
  { day: 25, user: 'What is my recovery today?', note: 'lookup, must NOT promote' },
  { day: 30, user: 'I switched my schedule. I prefer mornings now.', note: 'correction supersede evening' },
  { day: 45, user: 'I cannot run uphill due to Achilles pain.', note: 'temporary constraint' },
  { day: 60, user: 'That zone 2 plan worked really well for my recovery.', note: 'feedback' },
  { day: 90, user: 'Hey, thanks for yesterday! See you tomorrow.', note: 'small talk, must NOT promote' },
  { day: 120, user: 'I signed up for a marathon in October, target sub 4 hours.', note: 'new goal supersedes 5k? (different topic: race vs time)' },
  { day: 150, user: 'Now that my knee is better, can I add high volume quads?', note: 'temporary constraint epoch' },
  { day: 180, user: 'I want to get back to the 5K base now that the marathon is done.', note: 'goal shift' },
];

function buildUser() {
  const store = new MemoryStore({ userId: 'sam', now: NOW });
  const log = [];
  for (const c of CONVERSATIONS) {
    store.now = () => hr(c.day);
    const written = promoteTurn({ store, message: c.user, response: '' });
    log.push({ day: c.day, note: c.note, user: c.user, written: written.map((r) => r.type + ':' + r.topic) });
  }
  store.now = () => NOW;
  return { store, log };
}

function hitTopK(rows, matcher) {
  return rows.findIndex((r) => matcher(r));
}

async function run() {
  const { store, log } = buildUser();
  const active = store.active();

  // expected active edges after the script
  const results = [];
  const add = (id, ok, detail) => results.push({ id, ok: Boolean(ok), detail });

  const look = async (id, query, matcher, opts) => {
    const rows = await store.search(query, opts || { limit: 5 });
    const idx = hitTopK(rows, matcher);
    add(id, idx >= 0, { query, k: idx >= 0 ? idx + 1 : null, top: rows.slice(0, 3).map((r) => r.content.slice(0, 60)) });
  };

  // 1. direct recall
  await look('r_direct_time_pref', 'evening workout preference', (r) => r.topic === 'training_time');
  await look('r_direct_goal', '5k race goal', (r) => r.type === 'goal' && /5k/i.test(r.content));
  await look('r_direct_knee', 'knee injury', (r) => r.type === 'injury' && /knee/i.test(r.content));
  // 2. indirect recall
  await look('r_indirect_time', 'when do I like to train now', (r) => /morning/i.test(r.content));
  // 3. correction recall (old phrasing finds the new fact, never the contradicted one)
  await look('r_correction_old_phrase', 'I hate morning workouts', (r) => /morning/i.test(r.content) && !/hate/i.test(r.content));
  // 4. temporal: temporary constraint should not be promoted as durable
  add('t_no_eternal_constraint', !active.some((r) => r.topic === 'achilles' && r.type === 'temporary' && r.stable !== false), {});
  // 5. promotion precision: lookups + small talk not stored
  add('p_no_lookup', !active.some((r) => /what is my recovery/i.test(r.content)), {});
  add('p_no_smalltalk', !active.some((r) => /thanks for yesterday/i.test(r.content)), {});
  // 6. no dupes: preference topic has exactly 1 active record (evening superseded -> morning)
  const timePrefs = active.filter((r) => r.topic === 'training_time');
  add('p_single_active_pref', timePrefs.length === 1 && /morning/i.test(timePrefs[0].content), { count: timePrefs.length });
  // 7. graph: user prefers -> object reachable; multi-relation: user -> prefers -> training_time, training_time -> ... 
  const g = store.searchGraph('training time preference', { maxHops: 2, maxNodes: 20 });
  add('g_user_prefers_edge', g.nodes.includes('training_time') && g.paths.some((e) => e.from === 'user' && e.predicate === 'prefers'), { nodes: g.nodes });
  // 8. goal shift: latest goal (5k base again) active
  const goals = active.filter((r) => r.type === 'goal');
  add('r_goal_latest', goals.some((r) => /5k/i.test(r.content)), { goals: goals.map((r) => r.content.slice(0, 50)) });
  // 9. entities with similar names — ensure Jason the cyclist isn't bound to training goals
  add('p_entity_isolation', !active.some((r) => /jason/i.test(r.content)), {});

  const recall = results.filter((r) => r.ok).length / results.filter((r) => r.ok !== null).length * 100 || 0;
  const audits = store.audits();
  const report = {
    meta: { suite: 'memory-bench', user: 'sam', conversations: CONVERSATIONS.length, now: NOW },
    recallPrecisionPct: Math.round(recall * 10) / 10,
    results,
    audits,
    log,
  };
  const out = path.join(here, '../data/eval/reports', `memory-bench-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('memory bench report:', out);
  console.log('recall/precision pct:', report.recallPrecisionPct);
  console.log('audits:', JSON.stringify(audits));
  for (const r of results) console.log((r.ok ? 'PASS' : 'FAIL').padEnd(4), r.id, r.detail ? JSON.stringify(r.detail).slice(0, 200) : '');
  return report;
}

run().catch((e) => { console.error('ERR', e); process.exit(1); });
