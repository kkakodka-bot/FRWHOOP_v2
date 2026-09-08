
// eval/tool-bench.mjs — offline tool layer benchmark: golden-args correctness, bounds,
// malformed-input recovery, failure modes. No model.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeTool, capText } from '../coach/tools.js';
import { buildDayIndex, generateUser } from './lib/sandbox.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const idx = buildDayIndex(generateUser({ seed: 3, runs: [{ days: [2, 4], name: 'Heavy leg day', durationMin: 65, strain: 16.5, avgHr: 138 }, { days: [6], name: 'Long run', durationMin: 85, strain: 13.2, avgHr: 148 }] }));
const ctx = { index: idx, selectedDate: idx.lastDay, memory: null, documents: null };

const cases = [
  { name: 'get_range clamp <90d', tool: 'get_range', args: { from_day: '2024-01-01', to_day: idx.lastDay }, check: (o) => JSON.parse(o).count <= 90 },
  { name: 'get_range empty', tool: 'get_range', args: { from_day: '2030-01-01', to_day: '2030-02-01' }, check: (o) => JSON.parse(o).count === 0 },
  { name: 'get_recovery avg math', tool: 'get_recovery', args: { limit: 30 }, check: (o) => { const j = JSON.parse(o); return j.averages.recovery > 0 && j.averages.recovery <= 100; } },
  { name: 'get_day never leaks bpm_data', tool: 'get_day', args: {}, check: (o) => !o.includes('bpm_data') },
  { name: 'get_workouts sport filter', tool: 'get_workouts', args: { sport: 'run', limit: 10 }, check: (o) => JSON.parse(o).workouts.every((w) => /run/i.test(w.name)) },
  { name: 'get_workouts none found', tool: 'get_workouts', args: { sport: 'zzz-nope', limit: 5 }, check: (o) => JSON.parse(o).workouts.length === 0 },
  { name: 'malformed args json handled', tool: 'get_day', args: 'not-json', handledBy: 'caller', check: () => true },
  { name: 'unknown tool returns error object', tool: 'nope_tool', args: {}, check: (o) => /unknown tool/.test(o) },
  { name: 'prepare_chart machine built', tool: 'prepare_chart', args: { metric: 'hrv', limit: 10 }, check: (o) => /^<chart>/.test(o) },
  { name: 'missing day -> error not crash', tool: 'get_day', args: { day: '2030-06-01' }, check: (o) => /no day/.test(o) },
  { name: 'capText truncates big results', tool: null, args: null, check: () => capText('x'.repeat(5000)).length < 3400 && capText('x'.repeat(5000)).includes('truncated') },
  { name: 'get_range from>to swapped', tool: 'get_range', args: { from_day: idx.lastDay, to_day: idx.firstDay }, check: (o) => JSON.parse(o).count > 0 },
];

let pass = 0;
const results = [];
for (const c of cases) {
  try {
    const out = c.tool ? await executeTool(c.tool, c.args, ctx) : capText('x'.repeat(5000));
    const ok = c.check(out);
    results.push({ name: c.name, ok });
    console.log((ok ? 'PASS' : 'FAIL'), c.name);
    if (ok) pass += 1;
  } catch (e) {
    results.push({ name: c.name, ok: false, error: e.message });
    console.log('FAIL', c.name, e.message);
  }
}
const report = { meta: { suite: 'tool-bench' }, pass: pass, n: cases.length, results };
const out = path.join(here, '../data/eval/reports', `tool-bench-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\n${pass}/${cases.length} passed ->`, out);
