import { gateCommand, READ_ONLY_COMMANDS } from './safety.js';
import { decodeConfigReadBack } from './whoop5.js';
import { crc16Modbus, crc32 } from './crc.js';

export const PROBE_READ_OPCODES = Object.freeze([115, 116, 117, 118, 121, 128]);
export const PROBE_BLOCKED_OPCODES = Object.freeze([119, 120]);
export const ENUM_END_INDEX = 0xff;
export const MAX_ENUM_STEPS = 128;

const HINT = /spo2|oxygen|ox|sig|sleep|optical|ppg|r10|r11|r22/i;

export function planReadOnlyProbe(kind = 'device_config') {
  const start = kind === 'feature_flag' ? 117 : 115;
  const next = kind === 'feature_flag' ? 118 : 116;
  for (const cmd of [start, next, 121, 128]) {
    const g = gateCommand(cmd, {});
    if (!g.allowed) throw new Error(`${cmd} not read-only`);
  }
  for (const cmd of PROBE_BLOCKED_OPCODES) {
    const g = gateCommand(cmd, {});
    if (g.allowed) throw new Error(`${cmd} must stay blocked`);
  }
  return {
    kind,
    start_cmd: start,
    next_cmd: next,
    get_cmd: kind === 'feature_flag' ? 128 : 121,
    request_body: [0x01],
    max_steps: MAX_ENUM_STEPS,
    blocked: [...PROBE_BLOCKED_OPCODES],
    planned_opcodes: [start, next, kind === 'feature_flag' ? 128 : 121],
    read_only: true,
  };
}

export function isProbeWriteBlocked(cmd) {
  return PROBE_BLOCKED_OPCODES.includes(Number(cmd));
}

function payloadRecord(frame, family = 'puffin') {
  const buf = frame instanceof Uint8Array ? frame : Uint8Array.from(frame || []);
  if (buf.length < 16) return { ok: false, reason: 'truncated' };
  const cmdOff = family === 'puffin' ? 10 : 6;
  const typeOff = family === 'puffin' ? 8 : 4;
  if (buf[typeOff] !== 36) return { ok: false, reason: 'envelope' };
  const hdr = family === 'puffin' ? buf.subarray(0, 6) : buf.subarray(0, 4);
  const c16 = crc16Modbus(hdr);
  if (family === 'puffin' && ((buf[6] | (buf[7] << 8)) !== c16)) return { ok: false, reason: 'crc' };
  const innerStart = family === 'puffin' ? 8 : 4;
  const innerEnd = buf.length - 4;
  if (innerEnd <= innerStart) return { ok: false, reason: 'truncated' };
  const inner = buf.subarray(innerStart, innerEnd);
  const c32 = crc32(inner);
  const trail = (buf[buf.length - 4] | (buf[buf.length - 3] << 8) | (buf[buf.length - 2] << 16) | (buf[buf.length - 1] << 24)) >>> 0;
  if (trail !== (c32 >>> 0)) return { ok: false, reason: 'crc' };
  const pay = buf.subarray(cmdOff + 1, innerEnd);
  if (pay.length < 2) return { ok: false, reason: 'truncated' };
  return {
    ok: true,
    cmd: buf[cmdOff],
    result_code: pay[1],
    result: ({ 0: 'FAILURE', 1: 'SUCCESS', 2: 'PENDING', 3: 'UNSUPPORTED' })[pay[1]] || String(pay[1]),
    record: Array.from(pay.subarray(2)),
  };
}

export function parseEnumerateStart(frame, { family = 'puffin', expecting = 115 } = {}) {
  const r = payloadRecord(frame, family);
  if (!r.ok) return { ok: false, status: 'inconclusive', reason: r.reason };
  if (r.cmd !== expecting) return { ok: false, status: 'fail_closed', reason: 'wrong_command' };
  if (r.result === 'UNSUPPORTED' || r.result === 'PENDING') {
    return { ok: true, status: 'inconclusive', result: r.result, cmd: r.cmd };
  }
  if (r.record.length < 3) return { ok: false, status: 'fail_closed', reason: 'malformed' };
  const count = r.record[1] | (r.record[2] << 8);
  if (count < 1 || count > MAX_ENUM_STEPS) {
    return { ok: false, status: 'fail_closed', reason: 'implausible_count', count };
  }
  return { ok: true, status: 'ok', result: r.result, cmd: r.cmd, revision: r.record[0], count };
}

export function parseEnumerateNext(frame, { family = 'puffin', expecting = 116 } = {}) {
  const r = payloadRecord(frame, family);
  if (!r.ok) return { ok: false, status: 'inconclusive', reason: r.reason };
  if (r.cmd !== expecting) return { ok: false, status: 'fail_closed', reason: 'wrong_command' };
  if (r.result === 'UNSUPPORTED') return { ok: true, status: 'inconclusive', result: r.result, cmd: r.cmd };
  if (r.record.length < 2) return { ok: false, status: 'fail_closed', reason: 'malformed' };
  const index = r.record[1];
  const validKey = r.record.length >= 3 ? r.record[2] !== 0 : false;
  let key = null;
  if (r.record.length >= 4 && validKey) {
    const bytes = [];
    for (const b of r.record.slice(3)) {
      if (b === 0) break;
      if (b < 32 || b > 126) {
        return { ok: false, status: 'fail_closed', reason: 'malformed_key' };
      }
      bytes.push(b);
      if (bytes.length > 32) return { ok: false, status: 'fail_closed', reason: 'malformed_key' };
    }
    key = bytes.length ? Buffer.from(bytes).toString('utf8') : null;
  }
  return {
    ok: true,
    status: index === ENUM_END_INDEX ? 'end' : 'ok',
    result: r.result,
    cmd: r.cmd,
    revision: r.record[0],
    index,
    valid_key: validKey,
    key,
    exhausted: index === ENUM_END_INDEX,
  };
}

export function advanceEnumerate(state, parsed) {
  if (!parsed?.ok) {
    return { ...state, done: true, fail_closed: parsed?.status === 'fail_closed', inconclusive: parsed?.status === 'inconclusive' };
  }
  if (parsed.status === 'end' || parsed.exhausted) {
    return { ...state, done: true, keys: state.keys };
  }
  if (parsed.status === 'inconclusive') return { ...state, done: true, inconclusive: true };
  const keys = [...(state.keys || [])];
  if (parsed.key) keys.push(parsed.key);
  const steps = (state.steps || 0) + 1;
  if (steps >= MAX_ENUM_STEPS) return { ...state, done: true, fail_closed: true, reason: 'client_bound' };
  return { ...state, keys, steps, done: false };
}

export function interpretGetValue(frame, requestedKey, { family = 'puffin' } = {}) {
  if (frame == null) return { status: 'inconclusive', reason: 'timeout' };
  const rb = decodeConfigReadBack(frame, family);
  if (!rb) return { status: 'inconclusive', reason: 'malformed' };
  if (rb.result === 'UNSUPPORTED' || rb.result === 'PENDING') {
    return { status: 'inconclusive', result: rb.result, cmd: rb.cmd };
  }
  if (rb.result === 'FAILURE' || rb.result === 0 || rb.result === '0') {
    return { status: 'missing_key', result: 'FAILURE', key: requestedKey, cmd: rb.cmd };
  }
  if (rb.result === 'SUCCESS' && rb.key && requestedKey && rb.key !== requestedKey) {
    return { status: 'inconclusive', reason: 'key_mismatch', echoed: rb.key, requested: requestedKey };
  }
  if (rb.result === 'SUCCESS') {
    return { status: 'ok', result: 'SUCCESS', key: rb.key, value: rb.value, cmd: rb.cmd };
  }
  return { status: 'inconclusive', result: rb.result, cmd: rb.cmd };
}

export function searchInventory(keys) {
  return (keys || []).filter((k) => HINT.test(String(k)));
}

export function archiveProbeFromRecords(records) {
  const out = [];
  for (const rec of records || []) {
    const rb = rec.decoded?.parsed?.config_read_back || rec.config_read_back;
    if (!rb) continue;
    const cmd = Number(rb.cmd);
    if (!READ_ONLY_COMMANDS.has(cmd) && !PROBE_READ_OPCODES.includes(cmd)) continue;
    if (PROBE_BLOCKED_OPCODES.includes(cmd)) continue;
    out.push({
      opcode: cmd,
      result: rb.result,
      key: rb.key,
      value: rb.value,
      hint: rb.key && HINT.test(rb.key),
      frame_hash: rec.frame_hash || null,
      firmware: rec.fw || rec.firmware || null,
      timestamp: rec.t || rec.unix || null,
      raw_record: rb.raw_record || null,
    });
  }
  return out;
}
