import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc16Modbus, crc32 } from '../../protocol/crc.js';
import { gateCommand, READ_ONLY_COMMANDS, makeDeveloperConsent } from '../../protocol/safety.js';
import {
  planReadOnlyProbe,
  isProbeWriteBlocked,
  parseEnumerateStart,
  parseEnumerateNext,
  advanceEnumerate,
  interpretGetValue,
  PROBE_BLOCKED_OPCODES,
} from '../../protocol/spo2Probe.js';

function echoRecord(name, value) {
  const f = new Uint8Array(33);
  for (let i = 0; i < 32 && i < name.length; i += 1) f[i] = name.charCodeAt(i);
  f[32] = value;
  return [0x01, ...f];
}

function whoop5Response(cmd, payload) {
  const inner = [36, 1, cmd, ...payload];
  const pad = (4 - (inner.length % 4)) % 4;
  for (let i = 0; i < pad; i += 1) inner.push(0);
  const declLen = inner.length + 4;
  const frame = [0xAA, 0x01, declLen & 0xFF, (declLen >> 8) & 0xFF, 0x00, 0x01];
  const c16 = crc16Modbus(Array.from(frame.slice(0, 6)));
  frame.push(c16 & 0xFF, (c16 >> 8) & 0xFF);
  frame.push(...inner);
  const c32 = crc32(inner);
  frame.push(c32 & 0xFF, (c32 >> 8) & 0xFF, (c32 >> 16) & 0xFF, (c32 >> 24) & 0xFF);
  return Uint8Array.from(frame);
}

test('19 GET probe plan is read-only', () => {
  const cfg = planReadOnlyProbe('device_config');
  const ff = planReadOnlyProbe('feature_flag');
  assert.deepEqual(cfg.planned_opcodes, [115, 116, 121]);
  assert.deepEqual(ff.planned_opcodes, [117, 118, 128]);
  for (const cmd of [...cfg.planned_opcodes, ...ff.planned_opcodes]) {
    assert.equal(gateCommand(cmd, {}).allowed, true);
    assert.ok(READ_ONLY_COMMANDS.has(cmd));
  }
  assert.equal(cfg.read_only, true);
});

test('20 SET_DEVICE_CONFIG_VALUE 119 is blocked from this probe', () => {
  assert.equal(isProbeWriteBlocked(119), true);
  assert.ok(PROBE_BLOCKED_OPCODES.includes(119));
  const consent = makeDeveloperConsent({
    userId: 'u1',
    scopes: ['device_config_write', 'feature_flag_write'],
  });
  assert.equal(gateCommand(119, { consent }).allowed, true);
  const plan = planReadOnlyProbe('device_config');
  assert.ok(!plan.planned_opcodes.includes(119));
});

test('21 SET_FF_VALUE 120 is blocked from this probe', () => {
  assert.equal(isProbeWriteBlocked(120), true);
  const consent = makeDeveloperConsent({
    userId: 'u1',
    scopes: ['device_config_write', 'feature_flag_write'],
  });
  assert.equal(gateCommand(120, { consent }).allowed, true);
  const plan = planReadOnlyProbe('feature_flag');
  assert.ok(!plan.planned_opcodes.includes(120));
});

test('22 timeout and UNSUPPORTED are inconclusive', () => {
  assert.equal(interpretGetValue(null, 'spo2_enable').status, 'inconclusive');
  assert.equal(interpretGetValue(null, 'spo2_enable').reason, 'timeout');
  const unsupported = interpretGetValue(
    whoop5Response(121, [0x0A, 0x03, ...echoRecord('spo2_enable', 0)]),
    'spo2_enable',
  );
  assert.equal(unsupported.status, 'inconclusive');
  assert.equal(unsupported.result, 'UNSUPPORTED');
  const missing = interpretGetValue(
    whoop5Response(121, [0x0A, 0x00, ...echoRecord('no_such_key', 0)]),
    'no_such_key',
  );
  assert.equal(missing.status, 'missing_key');
});

test('23 malformed enumeration fails closed', () => {
  const bad = parseEnumerateStart(whoop5Response(115, [0x0A, 0x01, 1]), { expecting: 115 });
  assert.equal(bad.status, 'fail_closed');
  const huge = parseEnumerateStart(whoop5Response(115, [0x0A, 0x01, 1, 0xff, 0xff]), { expecting: 115 });
  assert.equal(huge.status, 'fail_closed');
  const wrong = parseEnumerateStart(whoop5Response(116, [0x0A, 0x01, 1, 3, 0]), { expecting: 115 });
  assert.equal(wrong.status, 'fail_closed');
  const ok = parseEnumerateStart(whoop5Response(115, [0x0A, 0x01, 1, 3, 0]), { expecting: 115 });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.count, 3);
  const nextBad = parseEnumerateNext(
    whoop5Response(116, [0x0A, 0x01, 1, 0, 1, 0xff, 0x80, 0x81]),
    { expecting: 116 },
  );
  assert.equal(nextBad.status, 'fail_closed');
  const end = parseEnumerateNext(whoop5Response(116, [0x0A, 0x01, 1, 0xff, 1]), { expecting: 116 });
  assert.equal(end.status, 'end');
  let state = { keys: [], steps: 0, done: false };
  state = advanceEnumerate(state, bad);
  assert.equal(state.fail_closed, true);
  assert.equal(state.done, true);
});
