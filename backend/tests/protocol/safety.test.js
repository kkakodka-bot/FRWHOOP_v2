import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKED_COMMANDS, GATED_COMMANDS, READ_ONLY_COMMANDS,
  gateCommand, makeDeveloperConsent, createBoundedCapture, gateReplayedFrame,
  SAFETY_VERSION,
} from '../../protocol/safety.js';

const consent = (scopes) => makeDeveloperConsent({ userId: 'u1', scopes });

test('mission-blocked commands are NEVER writable in any mode', () => {
  for (const cmd of [25, 32, 36, 37, 38, 45, 99, 142, 143, 144]) {
    const v = gateCommand(cmd, { consent: consent(['raw_data_capture', 'ecg_capture', 'feature_flag_write', 'device_config_write']) });
    assert.equal(v.allowed, false, `cmd ${cmd} must be blocked`);
    assert.equal(v.rule, 'BLOCKED_COMMANDS');
    assert.ok(BLOCKED_COMMANDS.has(cmd));
  }
  // blocked even with every scope + replay mode
  const replay = gateReplayedFrame(Uint8Array.from([0xAA, 0x01, 0, 0, 0, 0, 0, 0, 35, 1, 99]), { consent: consent(['raw_data_capture']) });
  assert.equal(replay.allowed, false);
  assert.equal(replay.reason, 'blocked by mission directive (99)');
});

test('gated activation commands require explicit developer-mode consent', () => {
  for (const cmd of [81, 82, 106, 124, 125, 139, 120, 119]) {
    const v = gateCommand(cmd, {}); // no consent
    assert.equal(v.allowed, false, `${cmd} without consent`);
    assert.equal(v.rule, 'DEVELOPER_CONSENT');
    assert.match(v.reason, /developer-mode consent/);
  }
});

test('gated commands pass with a valid consent scope, fail on wrong scope or revoked/expired consent', () => {
  const ok = gateCommand(106, { consent: consent(['raw_data_capture']), batteryPct: 80 });
  assert.equal(ok.allowed, true);
  const wrongScope = gateCommand(124, { consent: consent(['raw_data_capture']), batteryPct: 80 });
  assert.equal(wrongScope.allowed, false);
  const revoked = { ...makeDeveloperConsent({ scopes: ['ecg_capture'] }), revoked: true };
  assert.equal(gateCommand(139, { consent: revoked }).allowed, false);
  const expired = { ...makeDeveloperConsent({ scopes: ['ecg_capture'] }), granted_at: new Date(Date.now() - 25 * 3600e3).toISOString() };
  assert.equal(gateCommand(124, { consent: expired }).allowed, false);
  assert.equal(gateCommand(124, { consent: expired }).reason.includes('consent_older_than_24h'), true);
});

test('battery floor + bounded duration stop activations', () => {
  const c = makeDeveloperConsent({ scopes: ['raw_data_capture'], maxCaptureSeconds: 60 });
  assert.equal(gateCommand(81, { consent: c, batteryPct: 15 }).rule, 'BATTERY_FLOOR');
  assert.equal(gateCommand(81, { consent: c, batteryPct: 80 }).allowed, true);
  const started = new Date(Date.now() - 61e3).toISOString();
  assert.equal(gateCommand(81, { consent: c, batteryPct: 80, captureStartedAt: started }).rule, 'BOUNDED_DURATION');
});

test('bounded capture session enforces duration and forces a stop', () => {
  const c = makeDeveloperConsent({ scopes: ['ecg_capture'], maxCaptureSeconds: 5 });
  const sess = createBoundedCapture({ consent: c, kind: 'ecg_capture', now: () => Date.now() });
  assert.equal(sess.start().ok, true);
  assert.equal(sess.start().ok, false, 'double start refused');
  assert.equal(sess.shouldStop().should_stop, false);
  let fakeNow = Date.now();
  const s2 = createBoundedCapture({ consent: c, kind: 'ecg_capture', now: () => fakeNow });
  assert.equal(s2.start().ok, true);
  fakeNow += 61e3;
  assert.equal(s2.shouldStop().should_stop, true, 'expired session must stop');
});

test('read-only probes never require consent and stay unmolested', () => {
  for (const cmd of [117, 118, 115, 116, 121, 128, 26, 34]) {
    assert.equal(gateCommand(cmd, {}).allowed, true, `read-only cmd ${cmd}`);
  }
  assert.ok(READ_ONLY_COMMANDS.has(121));
  assert.ok(!READ_ONLY_COMMANDS.has(120));
});
