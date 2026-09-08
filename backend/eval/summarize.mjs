
// eval/summarize.mjs — produce the before/after markdown comparison from JSON reports.
// Usage: node eval/summarize.mjs <baseline.json> <final.json>
import fs from 'node:fs';
import path from 'node:path';

const [a, b] = process.argv.slice(2);
function load(f) {
  return JSON.parse(fs.readFileSync(path.resolve(f), 'utf8'));
}
function pctile(arr, p) {
  const s = [...arr].sort((x, y) => x - y);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)));
  return s[i];
}
function md() {
  if (!a || !b) { console.log('usage: node eval/summarize.mjs baseline final'); return; }
  const A = load(a), B = load(b);
  const rows = [
    ['n questions', A.meta.count, B.meta.count],
    ['lane correct %', A.aggregate.laneCorrectPct, B.aggregate.laneCorrectPct],
    ['intent correct %', A.aggregate.intentCorrectPct, B.aggregate.intentCorrectPct],
    ['tool selection %', A.aggregate.toolSelectionPct, B.aggregate.toolSelectionPct],
    ['unnecessary tools/turn', A.aggregate.unnecessaryPerTurn, B.aggregate.unnecessaryPerTurn],
    ['fact coverage %', A.aggregate.factCoverage, B.aggregate.factCoverage],
    ['model calls/turn', A.telemetry.avgModelCallsPerTurn, B.telemetry.avgModelCallsPerTurn],
    ['prompt tokens total', A.telemetry.totalPromptTokens, B.telemetry.totalPromptTokens],
    ['completion tokens total', A.telemetry.totalCompletionTokens, B.telemetry.totalCompletionTokens],
    ['est cost total $', A.telemetry.totalCost, B.telemetry.totalCost],
    ['p50 ms', A.telemetry.p50Ms, B.telemetry.p50Ms],
    ['p95 ms', A.telemetry.p95Ms, B.telemetry.p95Ms],
    ['p99 ms', A.telemetry.p99Ms, B.telemetry.p99Ms],
    ['avg ms', A.telemetry.avgMs, B.telemetry.avgMs],
  ];
  let out = '| metric | baseline | final | change |\n|---|---|---|---|\n';
  for (const [k, x, y] of rows) {
    let d = '';
    if (typeof x === 'number' && typeof y === 'number' && x !== 0) d = `${Math.round(((y - x) / x) * 1000) / 10}%`;
    out += `| ${k} | ${x} | ${y} | ${d} |\n`;
  }
  if (B.safety) {
    out += `\n## Safety (final)\n${JSON.stringify(B.safety)}\n`;
  }
  console.log(out);
}
md();
