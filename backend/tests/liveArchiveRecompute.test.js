import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUserRuntimes } from '../identity/userRuntime.js';

const USER = '7f2c9a10-4b3e-4d8a-9c11-00000000f001';

async function waitUntil(pred, { tries = 40, ms = 25 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, ms));
  }
}

test('live_archive marks dirty and recomputes affected days from storage', async () => {
  const recomputes = [];
  const dirty = [];
  const runtimes = createUserRuntimes({
    engine: {
      archiveRawSamples: async () => ({ id: 'obj', status: 'ready' }),
      persistComputed: async () => ({ scored: { day: '2026-08-20' } }),
      recomputeFromStorage: async (args) => {
        recomputes.push(args.days.slice());
        return { results: [] };
      },
    },
    liveDir: fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-live-recompute-')),
    cfg: { hrChunkMs: 3600_000 },
    loadStore: () => ({ profile: { timezone: 'UTC' } }),
    markDaysDirty: (_uid, days) => { dirty.push(...days); },
  });
  runtimes.append(USER, { datetime: '2026-08-20T15:04:00.000Z', bpm: 64 });
  await runtimes.flushAll();
  await waitUntil(() => recomputes.length > 0);
  assert.deepEqual(dirty, ['2026-08-20']);
  assert.deepEqual(recomputes[0], ['2026-08-20']);
});

test('live_archive recomputes from storage even when an overnight finalizer exists', async () => {
  const recomputes = [];
  const finalized = [];
  const runtimes = createUserRuntimes({
    engine: {
      archiveRawSamples: async () => ({ id: 'obj', status: 'ready' }),
      persistComputed: async () => null,
      recomputeFromStorage: async (args) => {
        recomputes.push(args.days.slice());
        return { results: [] };
      },
    },
    finalizer: {
      finalizeAffectedDays: async (args) => {
        finalized.push(args.trigger);
        return { results: [] };
      },
    },
    liveDir: fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-live-recompute-finalizer-')),
    cfg: { hrChunkMs: 3600_000 },
    loadStore: () => ({ profile: { timezone: 'UTC' } }),
  });
  runtimes.append(USER, { datetime: '2026-08-18T09:00:00.000Z', bpm: 61 });
  await runtimes.flushAll();
  await waitUntil(() => recomputes.length > 0);
  assert.deepEqual(recomputes[0], ['2026-08-18']);
  assert.deepEqual(finalized, []);
});

test('live_archive recompute failure is logged, not swallowed as success', async () => {
  const errors = [];
  const orig = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(' ')); };
  try {
    const runtimes = createUserRuntimes({
      engine: {
        archiveRawSamples: async () => ({ id: 'obj', status: 'ready' }),
        persistComputed: async () => null,
        recomputeFromStorage: async () => { throw new Error('b2_replay_failed'); },
      },
      liveDir: fs.mkdtempSync(path.join(os.tmpdir(), 'frwhoop-live-recompute-fail-')),
      cfg: { hrChunkMs: 3600_000 },
      loadStore: () => ({ profile: { timezone: 'UTC' } }),
    });
    runtimes.append(USER, { datetime: '2026-08-19T11:00:00.000Z', bpm: 58 });
    await runtimes.flushAll();
    await runtimes.flushAllScores();
    await waitUntil(() => errors.some((line) => /b2_replay_failed/.test(line)));
    assert.ok(errors.some((line) => /history_recompute_failed/.test(line) && /b2_replay_failed/.test(line)));
  } finally {
    console.error = orig;
  }
});
