import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyEvidence } from './verify-sync-evidence.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-evidence-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = 'SYNTHETIC VALIDATOR TEST ONLY. NOT DEVICE OR DEPLOYMENT EVIDENCE.\n';
  fs.writeFileSync(path.join(directory, 'synthetic.txt'), bytes);
  const now = Date.now();
  const at = new Date(now - 1000).toISOString();
  const hash = 'a'.repeat(64);
  const artifact = 'synthetic.txt';
  const stages = Object.fromEntries(['committed', 'accepted', 'archiveVerified', 'indexed', 'computed', 'displayed']
    .map(name => [name, { at, ownerNamespace: hash, recordDigest: hash, artifact }]));
  const evidence = {
    schemaVersion: 1, environment: 'staging', endpoint: 'https://fixture.invalid',
    build: { commit: 'a'.repeat(40), version: 'fixture', number: '1', configuration: 'Release', xcode: 'fixture', sdk: 'fixture' },
    server: { commit: 'b'.repeat(40), imageDigest: `sha256:${hash}`, edgeRevision: 'fixture',
      migrations: ['20260918010000', '20260918020000', '20260918030000', '20260918040000',
        '20260918050000', '20260918060000', '20260918070000', '20260918080000'],
      heartbeats: [new Date(now - 20000).toISOString(), at] },
    canary: { credentialKind: 'userJWT', ownerNamespace: hash, recordDigest: hash, stages,
      inputRevision: 1, resultRevision: 2, displayedRevision: 2 },
    scenarios: Object.fromEntries(['twoHourLockedReconnect', 'overnightThroughWake', 'forceQuitRecovery', 'twoAccounts', 'twoDevices', 'backlog72Hours']
      .map(name => [name, { status: 'pass', artifact }])),
    performance: [60, 120].map(actualRefreshHz => ({ actualRefreshHz, device: 'synthetic', os: 'synthetic', artifact,
      physicalDevice: true, configuration: 'Release', metric: 'aggregateHitchesMsPerSecond', value: 1,
      unresolvedMainThreadStalls250ms: 0, toolVersion: 'synthetic', denominator: 'synthetic' })),
    latency: { warmNavigationP95Ms: 1, coldCachedDashboardP95Ms: 1, activeCommitToDisplayP95Ms: 1 },
    energy: { matchedBaseline: true, unexplainedRetryLoop: false, sustainedSeriousThermal: false, artifact },
    security: { userLevelRls: 'pass', crossAccountRejected: 'pass', artifact },
    artifacts: [{ path: artifact, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }],
  };
  return { evidence, directory, now };
}

test('validates internally consistent test evidence without calling it production-ready', t => {
  const f = fixture(t);
  assert.equal(verifyEvidence(f.evidence, f.directory, f.now).status, 'EVIDENCE_VALIDATED');
});
test('missing or skipped required gate fails', t => {
  const f = fixture(t);
  f.evidence.scenarios.overnightThroughWake.status = 'skipped';
  assert.throws(() => verifyEvidence(f.evidence, f.directory, f.now), /overnightThroughWake/);
});
test('every production-sync migration is required, including history and input-selection repairs', t => {
  const f = fixture(t);
  const applied = [...f.evidence.server.migrations];
  for (const missing of applied) {
    f.evidence.server.migrations = applied.filter(value => value !== missing);
    assert.throws(() => verifyEvidence(f.evidence, f.directory, f.now), new RegExp(`migration missing: ${missing}`));
  }
});
test('migration evidence cannot be a substring, number list or duplicate ledger', t => {
  const f = fixture(t);
  const applied = [...f.evidence.server.migrations];
  for (const malformed of [applied.join(','), applied.map(Number), [...applied, applied[0]], null]) {
    f.evidence.server.migrations = malformed;
    assert.throws(() => verifyEvidence(f.evidence, f.directory, f.now), /distinct applied migration IDs/);
  }
});
test('existing but stalled heartbeat fails', t => {
  const f = fixture(t);
  f.evidence.server.heartbeats[1] = f.evidence.server.heartbeats[0];
  assert.throws(() => verifyEvidence(f.evidence, f.directory, f.now), /heartbeat must advance/);
});
test('other account result and older displayed revision fail', t => {
  const f = fixture(t);
  f.evidence.canary.stages.displayed.ownerNamespace = 'b'.repeat(64);
  assert.throws(() => verifyEvidence(f.evidence, f.directory, f.now), /correlation/);
  f.evidence.canary.stages.displayed.ownerNamespace = f.evidence.canary.ownerNamespace;
  f.evidence.canary.displayedRevision = 1;
  assert.throws(() => verifyEvidence(f.evidence, f.directory, f.now), /displayed result/);
});
test('wrong metric or missing physical trace cannot pass performance', t => {
  const f = fixture(t);
  f.evidence.performance[1].metric = 'fixed33msCounter';
  assert.throws(() => verifyEvidence(f.evidence, f.directory, f.now), /Hitches/);
});
test('changed artifact bytes fail verification', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, 'synthetic.txt'), 'different fixture');
  assert.throws(() => verifyEvidence(f.evidence, f.directory, f.now), /digest mismatch/);
});
test('empty evidence and a missing manifest reference fail', t => {
  const f = fixture(t);
  assert.throws(() => verifyEvidence({}, f.directory, f.now), /schemaVersion/);
  f.evidence.canary.stages.displayed.artifact = 'missing.trace';
  assert.throws(() => verifyEvidence(f.evidence, f.directory, f.now), /no verified artifact/);
});
