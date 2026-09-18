import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const fail = reason => { throw new Error(`NOT_READY: ${reason}`); };
const requireThat = (condition, reason) => { if (!condition) fail(reason); };
const instant = value => typeof value === 'string' ? Date.parse(value) : NaN;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

// Validates collected evidence; it neither generates a canary nor certifies artifact authenticity.
export function verifyEvidence(e, directory, now = Date.now()) {
  requireThat(e?.schemaVersion === 1, 'evidence schemaVersion must be 1');
  requireThat(e?.environment === 'staging' || e?.environment === 'production', 'record effective environment');
  requireThat(nonempty(e.endpoint) && /^https:\/\//.test(e.endpoint), 'record effective HTTPS endpoint');
  requireThat(/^[0-9a-f]{40}$/.test(e.build?.commit ?? ''), 'record exact app commit');
  requireThat(nonempty(e.build?.version) && nonempty(e.build?.number), 'record installed version/build');
  requireThat(e.build?.configuration === 'Release', 'device measurements require Release');
  requireThat(nonempty(e.build?.xcode) && nonempty(e.build?.sdk), 'record toolchain/SDK');
  requireThat(/^[0-9a-f]{40}$/.test(e.server?.commit ?? ''), 'record server commit');
  requireThat(/^sha256:[0-9a-f]{64}$/.test(e.server?.imageDigest ?? ''), 'record immutable scorer image digest');
  requireThat(nonempty(e.server?.edgeRevision), 'record effective Edge revision');
  const migrations = e.server?.migrations;
  requireThat(Array.isArray(migrations) && migrations.every(value => typeof value === 'string' && /^\d{14}$/.test(value)) &&
              new Set(migrations).size === migrations.length, 'record distinct applied migration IDs as an array');
  for (const migration of ['20260918010000', '20260918020000', '20260918030000', '20260918040000',
                           '20260918050000', '20260918060000', '20260918070000', '20260918080000']) {
    requireThat(migrations.includes(migration), `deployed migration missing: ${migration}`);
  }
  const beats = e.server?.heartbeats;
  requireThat(Array.isArray(beats) && beats.length >= 2, 'two heartbeat samples required');
  const first = instant(beats[0]), last = instant(beats.at(-1));
  requireThat(Number.isFinite(first) && Number.isFinite(last) && last > first,
              'heartbeat must advance, not merely exist');
  requireThat(last <= now + 60_000 && now - last <= 15 * 60_000, 'heartbeat evidence is stale or future dated');
  requireThat(e.canary?.credentialKind === 'userJWT', 'canary must use normal authenticated user credentials');
  requireThat(sha(e.canary?.ownerNamespace) && sha(e.canary?.recordDigest), 'canary needs opaque owner and record correlation');
  const stages = ['committed', 'accepted', 'archiveVerified', 'indexed', 'computed', 'displayed'];
  let previous = -Infinity;
  for (const stage of stages) {
    const observed = e.canary?.stages?.[stage];
    const at = instant(observed?.at);
    requireThat(Number.isFinite(at) && at >= previous && at <= now + 60_000, `invalid or missing ${stage} observation`);
    requireThat(observed.ownerNamespace === e.canary.ownerNamespace && observed.recordDigest === e.canary.recordDigest,
                `${stage} correlation does not match captured owner/record`);
    requireThat(nonempty(observed.artifact), `${stage} requires a raw evidence artifact`);
    previous = at;
  }
  requireThat(Number.isSafeInteger(e.canary.inputRevision) && e.canary.inputRevision > 0, 'missing input revision');
  requireThat(Number.isSafeInteger(e.canary.resultRevision) && e.canary.resultRevision > 0, 'missing result revision');
  requireThat(e.canary.displayedRevision === e.canary.resultRevision, 'displayed result is not the observed server revision');
  for (const name of ['twoHourLockedReconnect', 'overnightThroughWake', 'forceQuitRecovery', 'twoAccounts', 'twoDevices', 'backlog72Hours']) {
    const gate = e.scenarios?.[name];
    requireThat(gate?.status === 'pass' && nonempty(gate.artifact), `${name} is unverified`);
  }
  requireThat(Array.isArray(e.performance) && e.performance.length >= 2, '60 Hz and ProMotion traces required');
  for (const hz of [60, 120]) {
    const sample = e.performance.find(p => p.actualRefreshHz === hz);
    requireThat(sample && nonempty(sample.device) && nonempty(sample.os) && nonempty(sample.artifact), `${hz} Hz physical-device trace missing`);
    requireThat(sample.physicalDevice === true && sample.configuration === 'Release', `${hz} Hz must be physical Release evidence`);
    requireThat(sample.metric === 'aggregateHitchesMsPerSecond' && Number.isFinite(sample.value) && sample.value >= 0 && sample.value <= 10,
                `${hz} Hz aggregate Hitches outside good band`);
    requireThat(sample.unresolvedMainThreadStalls250ms === 0, `${hz} Hz unresolved main-thread stalls`);
    requireThat(nonempty(sample.toolVersion) && nonempty(sample.denominator), `${hz} Hz metric scope/tool missing`);
  }
  const bounds = { warmNavigationP95Ms: 100, coldCachedDashboardP95Ms: 1000, activeCommitToDisplayP95Ms: 120000 };
  for (const [metric, limit] of Object.entries(bounds)) {
    requireThat(Number.isFinite(e.latency?.[metric]) && e.latency[metric] >= 0 && e.latency[metric] <= limit,
                `${metric} absent or above gate`);
  }
  requireThat(e.energy?.matchedBaseline === true && e.energy?.unexplainedRetryLoop === false &&
              e.energy?.sustainedSeriousThermal === false && nonempty(e.energy?.artifact), 'matched energy/thermal evidence missing');
  requireThat(e.security?.userLevelRls === 'pass' && e.security?.crossAccountRejected === 'pass' && nonempty(e.security?.artifact),
              'user-level RLS and cross-account evidence missing');
  requireThat(Array.isArray(e.artifacts) && e.artifacts.length > 0, 'raw artifact manifest missing');
  const names = new Set();
  const canonicalDirectory = fs.realpathSync(directory);
  for (const artifact of e.artifacts) {
    requireThat(nonempty(artifact.path) && !path.isAbsolute(artifact.path) && sha(artifact.sha256), 'invalid artifact path/digest');
    const resolved = fs.realpathSync(path.resolve(canonicalDirectory, artifact.path));
    requireThat(resolved.startsWith(canonicalDirectory + path.sep), 'artifact escaped evidence directory');
    requireThat(fs.statSync(resolved).isFile(), 'artifact is not a regular file');
    requireThat(crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex') === artifact.sha256, 'artifact digest mismatch');
    names.add(artifact.path);
  }
  const references = [...stages.map(stage => e.canary.stages[stage].artifact),
    ...Object.values(e.scenarios).map(gate => gate.artifact), ...e.performance.map(p => p.artifact), e.energy.artifact, e.security.artifact];
  requireThat(references.every(reference => names.has(reference)), 'an evidence reference has no verified artifact');
  return { status: 'EVIDENCE_VALIDATED', artifacts: names.size, productionReadiness: 'requires exact candidate review' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const filename = process.argv[2];
    requireThat(nonempty(filename), 'provide evidence JSON path');
    requireThat(fs.statSync(filename).size <= 1024 * 1024, 'evidence JSON exceeds 1 MiB');
    const result = verifyEvidence(JSON.parse(fs.readFileSync(filename, 'utf8')), path.dirname(path.resolve(filename)));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error?.message?.startsWith('NOT_READY:') ? error.message : 'NOT_READY: evidence file or artifact cannot be verified');
    process.exitCode = 3;
  }
}
