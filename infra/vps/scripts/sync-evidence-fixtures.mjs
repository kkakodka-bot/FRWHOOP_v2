// Synthetic offline TEST support only, never operator evidence or credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CANARY_STAGES, REQUIRED_MIGRATIONS, SCENARIOS } from './sync-evidence-contract.mjs';
import { SOURCE_ROOTS } from './check-sync-sources.mjs';

export function sourceFixture(root) {
  for (const relative of SOURCE_ROOTS) {
    fs.mkdirSync(path.join(root, relative), { recursive: true });
    fs.writeFileSync(path.join(root, relative, 'Synthetic.kt'), 'package fixture\nimport com.noop.data.HrSample\n');
  }
  const migrations = path.join(root, 'supabase/migrations'); fs.mkdirSync(migrations, { recursive: true });
  for (const id of REQUIRED_MIGRATIONS) fs.writeFileSync(path.join(migrations, `${id}_synthetic.sql`), '-- synthetic source-presence fixture only\n');
  fs.writeFileSync(path.join(migrations, '20260916160000_scoring_service_state.sql'), '-- scoring_service_heartbeats scoring_work_items engine_ingest_scored\n');
  return migrations;
}

export function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-evidence-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = 'SYNTHETIC VALIDATOR TEST ONLY. NOT DEVICE OR DEPLOYMENT EVIDENCE.\n';
  fs.writeFileSync(path.join(directory, 'synthetic.txt'), bytes);
  const now = Date.now(), at = new Date(now - 1000).toISOString();
  const hash = 'a'.repeat(64), artifact = 'synthetic.txt';
  const identity = { ownerNamespace: hash, recordDigest: hash,
    ownerUserId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222',
    objectId: '33333333-3333-4333-8333-333333333333', inputRevision: 1, resultRevision: 2 };
  const evidence = {
    schemaVersion: 2, environment: 'staging', endpoint: 'https://fixture.invalid',
    target: { sshHost: 'synthetic.invalid', bindingArtifact: artifact },
    collection: { startedAt: new Date(now - 4 * 86400_000).toISOString(), completedAt: at },
    build: { commit: 'a'.repeat(40), version: 'fixture', number: '1', configuration: 'Release', xcode: 'fixture', sdk: 'fixture' },
    server: { commit: 'b'.repeat(40), imageDigest: `sha256:${hash}`, dockerImageId: `sha256:${'b'.repeat(64)}`,
      containerId: 'c'.repeat(64), edgeRevision: 'fixture', migrations: [...REQUIRED_MIGRATIONS],
      migrationLedgerRaw: [...REQUIRED_MIGRATIONS], heartbeats: [new Date(now - 20000).toISOString(), at] },
    canary: { credentialKind: 'userJWT', ...identity, recordDigestScope: 'object-content-sha256',
      day: '2026-09-18', algorithmVersion: 'synthetic-v1', inputBindingArtifact: artifact,
      stages: Object.fromEntries(CANARY_STAGES.map(name => [name, { at, ...identity, artifact }])), displayedRevision: 2 },
    scenarios: Object.fromEntries(SCENARIOS.map(name => [name, { status: 'pass', artifact, observedAt: at }])),
    performance: [60, 120].map(actualRefreshHz => ({ actualRefreshHz, device: 'synthetic', os: 'synthetic', artifact,
      physicalDevice: true, configuration: 'Release', metric: 'aggregateHitchesMsPerSecond', value: 1,
      unresolvedMainThreadStalls250ms: 0, toolVersion: 'synthetic', denominator: 'synthetic', observedAt: at, buildCommit: 'a'.repeat(40) })),
    latency: { warmNavigationP95Ms: 1, coldCachedDashboardP95Ms: 1, activeCommitToDisplayP95Ms: 1, artifact, observedAt: at },
    energy: { matchedBaseline: true, unexplainedRetryLoop: false, sustainedSeriousThermal: false, artifact, observedAt: at },
    security: { userLevelRls: 'pass', crossAccountRejected: 'pass', artifact, observedAt: at },
    artifacts: [{ path: artifact, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }],
  };
  return { evidence, directory, now };
}
