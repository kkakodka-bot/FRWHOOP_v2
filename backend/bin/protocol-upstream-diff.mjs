#!/usr/bin/env node
// Repeatable upstream-diff report (read-only; see protocol_sources.lock.json).
//
// Usage: node bin/protocol-upstream-diff.mjs [--repo /path/to/noop-clone] [--out <file>]
//
// For each pinned source with a local git clone, records: local HEAD, upstream
// HEAD after fetch, behind/ahead counts, and the commits touching protocol-
// relevant paths. Prints a JSON report. NEVER modifies any file except the
// optional --out report. git fetch is the only network operation.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const CHECKOUTS = [
  { name: 'noop', path: flag('--repo', decodeURIComponent(new URL('../../../noop/', import.meta.url).pathname)) },
];

const repos = CHECKOUTS.map(({ name, path }) => {
  const out = { name, path, ok: false };
  try {
    out.local_head = execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', path, 'fetch', 'origin'], { stdio: 'ignore' });
    out.upstream_head = execFileSync('git', ['-C', path, 'rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
    const behind = execFileSync('git', ['-C', path, 'rev-list', '--count', `HEAD..origin/main`], { encoding: 'utf8' }).trim();
    out.behind = Number(behind);
    const commits = execFileSync('git', ['-C', path, 'log', '--oneline', `HEAD..origin/main`, '--',
      'Packages/WhoopProtocol', 'docs/PROTOCOL.md', 'docs/WHOOP5_DEEP_DATA.md', 'Tools/linux-capture'], { encoding: 'utf8' }).trim();
    out.protocol_commits = commits ? commits.split('\n').map((l) => l.slice(0, 100)) : [];
    out.ok = true;
  } catch (err) {
    out.error = String(err.message || err).slice(0, 200);
  }
  return out;
});

const report = {
  generated_at_utc: new Date().toISOString(),
  lock_file: 'protocol_sources.lock.json',
  checkout_states: repos,
  instructions: [
    'For each primary pin in protocol_sources.lock.json without a local clone, record the HEAD via the GitHub API commits endpoint (see the lock file URLs).',
    'Re-read WhoopProtocol sources at the new SHA and diff field maps against backend/protocol/registry.js CONFLICTS + entries.',
    'Update protocol_sources.lock.json head_sha values and note the decoder-version bump in backend/docs/PROTOCOL_COVERAGE.md.',
  ],
};
const text = JSON.stringify(report, null, 2);
if (argv.includes('--out')) writeFileSync(flag('--out', null), text);
console.log(text);
