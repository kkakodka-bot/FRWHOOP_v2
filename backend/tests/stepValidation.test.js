import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';

import {
  normalizeStepValidationSession,
  registerStepValidationRoutes,
} from '../metrics/stepValidation.js';

const USER = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';

function body(overrides = {}) {
  return {
    id: ID,
    requested_start: '2026-08-30T12:00:00.000Z',
    requested_end: '2026-08-30T12:01:00.000Z',
    scenario: 'treadmill walk',
    participant_key: 'participant-001',
    raw_imu_refs: ['v3/core/users/u/imu_raw/a.ndjson.gz'],
    label_source: 'video_manual',
    true_count: 2,
    event_timestamps: [
      '2026-08-30T12:00:10.000Z',
      '2026-08-30T12:00:20.000Z',
    ],
    wrist: 'left',
    ...overrides,
  };
}

async function serverFor(dependencies) {
  const app = express();
  app.use(express.json());
  registerStepValidationRoutes(app, dependencies);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('manual/video and public labels are accuracy eligible by construction', () => {
  const row = normalizeStepValidationSession(body(), USER);
  assert.equal(row.metadata.accuracy_eligible, true);
  assert.equal(row.metadata.agreement_only, false);
  assert.equal(row.event_timestamps.length, row.true_count);
  const synthetic = normalizeStepValidationSession(body({
    label_source: 'synthetic',
    event_timestamps: null,
  }), USER);
  assert.equal(synthetic.metadata.accuracy_eligible, false);
  assert.equal(synthetic.metadata.synthetic, true);
});

test('Apple Watch intervals cannot masquerade as heel-strike timestamps', () => {
  assert.throws(
    () => normalizeStepValidationSession(body({ label_source: 'apple_watch' }), USER),
    /apple_watch_has_no_step_event_ground_truth/,
  );
  const row = normalizeStepValidationSession(body({
    label_source: 'apple_watch',
    event_timestamps: null,
  }), USER);
  assert.equal(row.metadata.agreement_only, true);
  assert.equal(row.metadata.accuracy_eligible, false);
});

test('database constraints preserve validation event semantics on direct writes', () => {
  const sql = readFileSync(
    new URL(
      '../../supabase/migrations/20260831081315_steps_v3_read_auth_and_label_invariants.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(sql, /step_validation_sessions_event_integrity_check/);
  assert.match(sql, /cardinality\(p_events\) = p_true_count/);
  assert.match(sql, /count\(distinct event_at\)/);
  assert.match(sql, /event_at >= p_start and event_at <= p_end/);
  assert.match(sql, /label_source <> 'apple_watch' or event_timestamps is null/);
  assert.match(sql, /'read_requested'::text/);
});

test('validation API persists authenticated sessions and reads guarded views', async () => {
  const calls = [];
  const rest = {
    configured: true,
    async upsert(table, row) {
      calls.push({ operation: 'upsert', table, row });
      return [row];
    },
    async select(table, filter) {
      calls.push({ operation: 'select', table, filter });
      return [];
    },
  };
  const server = await serverFor({ rest, resolveUser: async () => USER });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const create = await fetch(`${base}/api/steps/validation-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    });
    assert.equal(create.status, 201);
    assert.equal(calls[0].table, 'step_validation_sessions');
    assert.equal(calls[0].row.user_id, USER);

    const nonsynthetic = await fetch(`${base}/api/steps/validation-sessions`);
    assert.equal(nonsynthetic.status, 200);
    assert.equal(calls[1].table, 'step_validation_nonsynthetic');

    const accuracy = await fetch(`${base}/api/steps/validation-sessions?accuracy_eligible=true`);
    assert.equal(accuracy.status, 200);
    assert.equal(calls[2].table, 'step_validation_ground_truth');
    assert.match((await accuracy.json()).evidence_role, /accuracy_ground_truth/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('validation API fails closed without auth or durable storage', async () => {
  const noAuth = await serverFor({
    rest: { configured: true },
    resolveUser: async () => null,
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${noAuth.address().port}/api/steps/validation-sessions`,
    );
    assert.equal(response.status, 401);
  } finally {
    await new Promise((resolve) => noAuth.close(resolve));
  }

  const noStorage = await serverFor({
    rest: { configured: false },
    resolveUser: async () => USER,
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${noStorage.address().port}/api/steps/validation-sessions`,
    );
    assert.equal(response.status, 503);
  } finally {
    await new Promise((resolve) => noStorage.close(resolve));
  }
});
