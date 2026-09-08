
// eval/retrieval-bench.mjs — deterministic retrieval-layer benchmark (no model).
// Builds the 9 cross-source scenarios and checks whether the evidence package the coach
// would construct contains the facts needed to answer. Measures recall@K / precision by
// token budget + noise.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCohortIndex } from './lib/runner.js';
import { DocumentStore } from '../documents/store.js';
import { MemoryStore } from '../memory/store.js';
import { fetchEvidence } from '../coach/tools.js';
import { resolveRange } from '../coach/lanes.js';
import { buildDayIndex } from './lib/sandbox.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = '2026-08-20T00:00:00Z';

function jsonSize(o) { return JSON.stringify(o).length; }

const SCENARIOS = [
  {
    id: 's01_supabase_only', sources: ['local'], q: 'What was my recovery on 2025-05-30?',
    needs: [{ in: 'day', keys: ['recovery'] }],
  },
  {
    id: 's02_docs_only', sources: ['documents'], q: 'What does the training plan say about deload weeks?',
    needsDoc: 'training-plan', needsText: ['deload'],
  },
  {
    id: 's03_memory_only', sources: ['memory'], q: 'What time do I usually train?',
    needsMem: 'training_time',
  },
  {
    id: 's04_conversation_only', sources: ['conversation'], q: 'Did I say I had a race last month?',
    needsConversation: true, // handled by context, not evidence
  },
  {
    id: 's05_supabase_plus_docs', sources: ['local', 'documents'], q: 'My recovery dipped and my physio note flagged my knee. Show recovery plus the physio flags.',
    needs: [{ in: 'recoveryWeek', keys: ['recovery'] }], needsDoc: 'physio-note', needsText: ['knee'],
  },
  {
    id: 's06_supabase_plus_memory', sources: ['local', 'memory'], q: 'Is my current strain in line with my low-volume preference?',
    needs: [{ in: 'strainWeek', keys: ['strain'] }], needsMem: 'training_focus',
  },
  {
    id: 's07_docs_plus_memory', sources: ['documents', 'memory'], q: 'My goal plan mentions a taper. What should I do with my knee restriction?',
    needsMem: 'knee', needsDoc: 'coach-note',
    skip: true, // reworked below
  },
  {
    id: 's07b_docs_plus_memory', sources: ['documents', 'memory'], q: 'My knee is sore and recovery is low. What did my coach note recommend?',
    needsMem: 'knee', needsDoc: 'coach-note',
  },
  {
    id: 's08_all_three', sources: ['local', 'documents', 'memory'], q: 'My knee is sore, recovery is low, and the coach note says easy week. What do my numbers and the note say?',
    needs: [{ in: 'recoveryWeek', keys: ['recovery'] }, { in: 'sleepWeek', keys: ['sleepPerformance'] }], needsMem: 'knee', needsDoc: 'coach-note',
  },
  {
    id: 's09_graph_plus_metrics', sources: ['local', 'memory_graph'], q: 'What usually happens to my HRV after hard leg sessions?',
    needs: [{ in: 'recoveryWeek', keys: ['hrv'] }], needsPattern: true,
  },
];

function containsKey(obj, keys) {
  return keys.every((k) => JSON.stringify(obj).toLowerCase().includes(String(k).toLowerCase()));
}

async function run() {
  const cohort = loadCohortIndex();
  const memory = new MemoryStore({ userId: 'alex', now: NOW });
  const memSpec = [
    { id: 'training_time', type: 'preference', topic: 'training_time', content: 'User prefers evening workouts.', provenance: 'user_supplied', confidence: 0.9 },
    { id: 'knee', type: 'injury', topic: 'knee', content: 'Right knee soreness since leg press on 2025-04-02.', provenance: 'user_supplied', confidence: 0.85 },
    { id: 'leg_volume', type: 'preference', topic: 'training_focus', content: 'User dislikes high volume leg sessions, prefers low volume heavy.', provenance: 'user_supplied', confidence: 0.9 },
  ];
  for (const r of memSpec) memory.add({ ...r, userId: 'alex' });

  const docs = new DocumentStore({ userId: 'alex', docs: [
    { id: 'training-plan', name: '2025 H1 Training Plan', kind: 'training_plan', text: 'Deload week every fourth week: drop volume 40%. Taper before the race.' },
    { id: 'physio-note', name: 'Physio knee note', kind: 'medical_note', text: 'Right knee patellar tendinopathy. Avoid deep knee flexion under load and high volume leg press.' },
    { id: 'coach-note', name: 'Coach progress note', kind: 'coach_note', text: 'Recovery trended low in May; recommend an easy week with Zone 2 focus and earlier bedtime.' },
  ] });

  const ctx = { index: cohort, selectedDate: '2025-06-03', cloud: null, memory, documents: docs, userId: 'alex' };
  const results = [];
  for (const s of SCENARIOS) {
    if (s.skip) continue;
    const range = resolveRange(s.q, '2025-06-03', cohort.lastDay);
    const ev = await fetchEvidence(ctx, 'general', range, s.q);
    const size = jsonSize(ev);
    const okMetric = (s.needs || []).every((n) => {
      const obj = ev[n.in];
      return obj && containsKey(obj, n.keys);
    });
    let okMem = true;
    if (s.needsMem) {
      const hit = await memory.search(s.q, { limit: 5 });
      okMem = hit.some((r) => r.topic === s.needsMem);
    }
    let okDoc = true, okDocText = true;
    if (s.needsDoc) {
      const found = (ev.relevantDocuments || []).find((d) => d.id === s.needsDoc);
      okDoc = Boolean(found);
      if (s.needsText && found) okDocText = s.needsText.every((t) => String(found.snippet || '').toLowerCase().includes(t));
    }
    const okPattern = s.needsPattern ? Boolean((ev.recoveryWeek?.averages?.hrv != null) || (ev.strainWeek?.days || []).some((d) => (d.workouts || []).length)) : true;
    const pass = okMetric && okMem && okDoc && okDocText && okPattern;
    results.push({ id: s.id, pass, okMetric, okMem, okDoc, okDocText, evidenceBytes: size, sources: s.sources.join('+') });
    console.log((pass ? 'PASS' : 'FAIL'), s.id.padEnd(28), `${size}B  metric=${okMetric} mem=${okMem} doc=${okDoc}/${okDocText}`);
  }
  const passN = results.filter((r) => r.pass).length;
  const noise = jsonSize({ recoveryWeek: null, sleepWeek: null, strainWeek: null, day: null, relevantDocuments: [] });
  const totalBytes = results.reduce((a, r) => a + r.evidenceBytes, 0);
  const report = {
    meta: { suite: 'retrieval-bench', scenarios: SCENARIOS.length },
    passPct: Math.round((passN / results.length) * 1000) / 10,
    avgEvidenceBytes: Math.round(totalBytes / results.length),
    results,
  };
  const out = path.join(here, '../data/eval/reports', `retrieval-bench-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('\nreport:', out);
  console.log('pass%:', report.passPct, 'avg evidence bytes:', report.avgEvidenceBytes);
}

run().catch((e) => { console.error('ERR', e); process.exit(1); });
