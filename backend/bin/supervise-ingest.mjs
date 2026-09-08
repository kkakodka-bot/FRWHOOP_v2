#!/usr/bin/env node
/**
 * Keep the ingest API alive. launchd KeepAlive runs this; if /health is
 * already up (an unmanaged node), this waits instead of binding 8080 twice.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.PORT || '8080';
const health = `http://127.0.0.1:${port}/health`;
let child = null;

async function healthy() {
  try {
    const res = await fetch(health, { signal: AbortSignal.timeout(4000) });
    const body = await res.json().catch(() => ({}));
    return res.ok && body.status === 'healthy';
  } catch {
    return false;
  }
}

function start() {
  if (child && child.exitCode == null) return;
  child = spawn(process.execPath, ['index.js'], {
    cwd: backend,
    env: process.env,
    stdio: 'inherit',
  });
  child.on('exit', () => { child = null; });
}

while (true) {
  if (!(await healthy())) start();
  await sleep(15_000);
}
