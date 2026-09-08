#!/usr/bin/env node
/**
 * Strain V2 shadow replay-compare tool.
 *
 * Runs V1 (metrics/sleep.js strainFromHr) and V2 (metrics/strainV2/score.js)
 * side by side over the SAME local sample files (data/live/<user>/<day>.ndjson),
 * READ-ONLY, and prints a per-day comparison with cause attribution.
 * Deterministic. No network. Never writes to repos or services.
 *
 * Usage: node bin/strainV2-compare.mjs [--user <uuid>] [--day YYYY-MM-DD] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strainFromHr } from '../metrics/sleep.js';
import { computeStrainV2 } from '../metrics/strainV2/score.js';
import { scoreModel } from '../metrics/strainV2/models/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE = path.resolve(HERE, '../data/live');

function parseArgs(argv) {
  const args = { user: null, day: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--user') args.user = argv[++i];
    else if (argv[i] === '--day') args.day = argv[++i];
  }
  return args;
}

function readDayFile(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch { /* skip malformed line */ }
  }
  return rows;
}

function compareUserDay(user, dayFile) {
  const day = path.basename(dayFile, '.ndjson');
  const rows = readDayFile(dayFile);
  const bpmRows = rows.filter((r) => r && r.bpm != null && Number.isFinite(Number(r.bpm)));
  if (!bpmRows.length) return { user, day, skipped: 'no bpm rows' };

  const times = bpmRows.map((r) => Date.parse(r.datetime ?? r.t ?? r.at)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!times.length) return { user, day, skipped: 'no parseable timestamps' };
  const dayStartMs = Math.floor(times[0] / 86400000) * 86400000;
  const dayEndMs = dayStartMs + 86400000;

  // V1 canonical scorer (defaults exactly as shipped).
  const v1Strain = strainFromHr(bpmRows);

  // V2 with default model (stagno) and banister co-primary.
  const v2 = computeStrainV2({
    samples: bpmRows,
    profile: {},
    prefs: {},
    days: [],
    currentDay: day,
    opts: { dayStartMs, dayEndMs },
  });
  const v2Banister = computeStrainV2({
    samples: bpmRows,
    profile: {},
    prefs: {},
    days: [],
    currentDay: day,
    opts: { dayStartMs, dayEndMs, model: 'banister' },
  });

  const out = {
    user: user.slice(0, 8),
    day,
    samples: bpmRows.length,
    v1Strain,
    v2Strain: v2.strain,
    v2Au: v2.au,
    v2BanisterStrain: v2Banister.strain,
    coveragePct: v2.coveragePct,
    scorableMinutes: v2.scorableMinutes,
    qualityState: v2.qualityState,
    hrMax: v2.hrMax,
    restingHr: v2.restingHr,
    duplicatesRemoved: v2.dayStats ? undefined : undefined,
    model: v2.cardioModel?.name ?? null,
  };

  // Cause attribution
  const causes = [];
  if (v1Strain > 0 && (v2.au ?? 0) === 0) causes.push('zero-band: V2 default model assigns 0 AU (all valid HR below 50% HRR)');
  if (v2.coveragePct < 100) causes.push(`coverage: ${v2.scorableMinutes}/${Math.round((dayEndMs - dayStartMs) / 60000)} min scorable (gaps/dups/quality)`);
  causes.push(`hrmax: ${v2.hrMax.source}=${v2.hrMax.value}`);
  causes.push(`rhr: ${v2.restingHr.source}=${v2.restingHr.value}`);
  if (v1Strain !== v2.strain) causes.push('model: V1 Edwards-log-7201 vs V2 ' + (v2.cardioModel?.name ?? '?'));
  else causes.push('models agree');
  out.causes = causes;
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(LIVE)) {
    console.error('no local data at', LIVE);
    process.exit(1);
  }
  const users = args.user ? [args.user] : fs.readdirSync(LIVE).filter((d) => fs.statSync(path.join(LIVE, d)).isDirectory());
  const results = [];
  for (const user of users) {
    const ud = path.join(LIVE, user);
    const files = fs.readdirSync(ud).filter((f) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(f) && (!args.day || f === `${args.day}.ndjson`));
    for (const f of files) results.push(compareUserDay(user, path.join(ud, f)));
  }
  const done = results.filter((r) => !r.skipped);
  console.log('Strain V1 vs V2 shadow replay (READ-ONLY, local data)');
  console.log('=====================================================');
  for (const r of done) {
    console.log(`\n${r.user} ${r.day}: samples=V1/V2 over ${r.scorableMinutes} scorable min, coverage ${r.coveragePct}% [${r.qualityState}]`);
    console.log(`  V1 strain:        ${r.v1Strain}`);
    console.log(`  V2 (default):     ${r.v2Strain} (au=${r.v2Au})`);
    console.log(`  V2 (banister):    ${r.v2BanisterStrain}`);
    for (const c of r.causes) console.log(`  cause: ${c}`);
  }
  const skipped = results.filter((r) => r.skipped);
  if (skipped.length) console.log(`\nskipped: ${skipped.length} day files (no bpm rows)`);
  if (!done.length) console.log('no comparable days found');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
