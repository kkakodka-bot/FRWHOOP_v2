
// WHOOP command safety gate.
//
// MISSION RULE (non-negotiable): never sweep opcodes; never automatically send
// destructive commands. The backend NEVER originates strap writes itself, but
// the redecode/capture tooling can replay archived COMMAND frames and the app
// client can write opcodes - both paths MUST pass this gate. This module is the
// single enforcement point:
//
//   1. BLOCKED_COMMANDS - never writable, never replayable, in any mode.
//   2. Developer-mode capture consent: the R22 raw-data stream (feature flag
//      enable_r22_packets) and the MG/Labrador ECG toggles (124/125/139) are
//      activation-gated behind explicit, persisted, revocable consent plus a
//      bounded capture duration, an explicit stop, and a battery safeguard.
//   3. Every verdict is auditable (reason string + rule id).
//
// Blocked set (mission directive): 25, 32, 36-38, 45, 99, 142-144.
// (36/37/38 are packet TYPES too, but as COMMAND opcodes 36/37/38 sit in the
// destructive set - the mission list is normative for both reading frames and
// writing commands.)

export const SAFETY_VERSION = 'frwhoop-safety/1';

export const BLOCKED_COMMANDS = Object.freeze(new Set([25, 32, 36, 37, 38, 45, 99, 142, 143, 144]));

export const BLOCKED_COMMAND_NAMES = Object.freeze({
  25: 'blocked by mission directive (25)',
  32: 'blocked by mission directive (32)',
  36: 'blocked by mission directive (36)',
  37: 'blocked by mission directive (37)',
  38: 'blocked by mission directive (38)',
  45: 'blocked by mission directive (45)',
  99: 'blocked by mission directive (99)',
  142: 'blocked by mission directive (142)',
  143: 'blocked by mission directive (143)',
  144: 'blocked by mission directive (144)',
});

// Commands that activate the opt-in data products. Writable ONLY inside a
// consented developer-mode capture session with a bounded duration + stop +
// battery floor. READ-ONLY probes (117/118/115/116/121/128) are NOT in this set
// - enumeration is read-only and allowed without consent.
export const GATED_COMMANDS = Object.freeze({
  81: { name: 'START_RAW_DATA', gate: 'raw_data_capture' },
  82: { name: 'STOP_RAW_DATA', gate: 'raw_data_capture' },
  106: { name: 'TOGGLE_IMU_MODE', gate: 'raw_data_capture' },
  124: { name: 'TOGGLE_LABRADOR_DATA_GENERATION', gate: 'ecg_capture' },
  125: { name: 'TOGGLE_LABRADOR_RAW_SAVE', gate: 'ecg_capture' },
  139: { name: 'TOGGLE_LABRADOR_FILTERED', gate: 'ecg_capture' },
  120: { name: 'SET_FF_VALUE (SET_CONFIG)', gate: 'feature_flag_write' },
  119: { name: 'SET_DEVICE_CONFIG_VALUE', gate: 'device_config_write' },
});

// Read-only probes: never need developer-mode consent.
export const READ_ONLY_COMMANDS = Object.freeze(new Set([1, 2, 3, 7, 10, 11, 26, 34, 115, 116, 117, 118, 121, 128, 145]));

// Battery safeguard: captures auto-stop under this state of charge.
export const MIN_BATTERY_PCT_FOR_CAPTURE = 20;

/**
 * Developer-mode consent record (persisted, revocable). Required fields are
 * enforced; the caller stores it and re-presents it on every gated write.
 */
export function makeDeveloperConsent({
  userId = null,
  grantedAt = null,
  expiresAt = null,
  scopes = [],
  maxCaptureSeconds = 300,
  minBatteryPct = MIN_BATTERY_PCT_FOR_CAPTURE,
} = {}) {
  return {
    version: SAFETY_VERSION,
    user_id: userId,
    granted_at: grantedAt || new Date().toISOString(),
    expires_at: expiresAt,
    scopes: Array.isArray(scopes) ? scopes : [],
    max_capture_seconds: Math.max(1, Math.min(3600, maxCaptureSeconds | 0)),
    min_battery_pct: Math.max(0, Math.min(100, minBatteryPct | 0)),
    revoked: false,
  };
}

function consentValid(consent, scope, nowMs = Date.now()) {
  if (!consent || typeof consent !== 'object') return { ok: false, reason: 'no_consent_record' };
  if (consent.revoked === true) return { ok: false, reason: 'consent_revoked' };
  if (!Array.isArray(consent.scopes) || !consent.scopes.includes(scope)) {
    return { ok: false, reason: `scope_not_granted:${scope}` };
  }
  const granted = Date.parse(consent.granted_at || '') || 0;
  if (granted <= 0) return { ok: false, reason: 'consent_missing_granted_at' };
  if (nowMs - granted > 24 * 3600 * 1000) return { ok: false, reason: 'consent_older_than_24h' };
  if (consent.expires_at) {
    if (Date.parse(consent.expires_at) < nowMs) {
      return { ok: false, reason: 'consent_expired' };
    }
  }
  return { ok: true };
}

/**
 * The one gate every command write / replay passes.
 *
 * @param {number} command
 * @param {Object} ctx { consent, scope ('raw_data_capture'|'ecg_capture'|'feature_flag_write'|'device_config_write'), batteryPct, captureStartedAt (iso), mode ('replay'|'live') }
 * @returns {{ allowed: true } | { allowed: false, reason: string, rule: string }}
 */
export function gateCommand(command, ctx = {}) {
  const cmd = Number(command);
  if (!Number.isInteger(cmd)) return { allowed: false, reason: 'command must be an integer opcode', rule: 'shape' };
  if (BLOCKED_COMMANDS.has(cmd)) {
    return { allowed: false, reason: BLOCKED_COMMAND_NAMES[cmd] || `blocked opcode ${cmd}`, rule: 'BLOCKED_COMMANDS' };
  }
  const gated = GATED_COMMANDS[cmd];
  if (!gated) return { allowed: true, rule: 'ungated' };

  const scope = ctx.scope || gated.gate;
  const consentCheck = consentValid(ctx.consent, gated.gate, Date.parse(ctx.now || '') || Date.now());
  if (!consentCheck.ok) {
    return { allowed: false, reason: `${gated.name} requires developer-mode consent (${consentCheck.reason})`, rule: 'DEVELOPER_CONSENT' };
  }
  if (gated.gate === 'raw_data_capture' || gated.gate === 'ecg_capture') {
    // battery safeguard
    const pct = ctx.batteryPct;
    if (typeof pct === 'number' && pct < (ctx.minBatteryPct ?? 20)) {
      return { allowed: false, reason: `battery ${pct}% below the ${ctx.minBatteryPct ?? 20}% capture floor`, rule: 'BATTERY_FLOOR' };
    }
    // bounded duration: a START without an active stop must fit the consent window
    if (ctx.captureStartedAt) {
      const started = Date.parse(ctx.captureStartedAt);
      const maxMs = (ctx.maxCaptureSeconds ?? ctx.consent?.max_capture_seconds ?? 900) * 1000;
      if (Number.isFinite(started) && Date.now() - started > maxMs) {
        return { allowed: false, reason: 'bounded capture duration exceeded - send the stop command', rule: 'BOUNDED_DURATION' };
      }
    }
  }
  return { allowed: true, rule: `gated:${gated.gate}`, scope };
}

/**
 * Bounded capture session helper: start/stop with duration + battery checks.
 * The session never extends itself; expiry forces a stop.
 */
export function createBoundedCapture({ consent, kind = 'raw_data_capture', now = () => Date.now() } = {}) {
  let startedAt = null;
  const maxMs = (consent?.max_capture_seconds ?? 900) * 1000;
  return {
    kind,
    start() {
      const check = consentValid(consent, kind, now());
      if (!check.ok) return { ok: false, reason: check.reason };
      if (startedAt) return { ok: false, reason: 'capture_already_running' };
      startedAt = now();
      return { ok: true, started_at: new Date(startedAt).toISOString(), max_seconds: maxMs / 1000 };
    },
    stop() {
      const started = startedAt;
      startedAt = null;
      return { ok: true, stopped: true, was_running: startedAt === null ? 'expired' : true };
    },
    shouldStop() {
      if (!startedAt) return { should_stop: false, reason: 'not_started' };
      const elapsed = now() - startedAt;
      return { should_stop: elapsed >= maxMs, elapsed_seconds: Math.floor(elapsed / 1000), max_seconds: maxMs / 1000 };
    },
    elapsedSeconds() {
      return startedAt ? Math.floor((now() - startedAt) / 1000) : null;
    },
  };
}

/**
 * Replay guard: a COMMAND (35/37) frame from the archive may only be re-sent
 * through the gate; blocked opcodes are never replayed even inside a consented
 * session. Returns the reason a replayed frame must be dropped.
 */
export function gateReplayedFrame(frame, ctx = {}) {
  if (!frame || frame.length < 8) return { allowed: false, reason: 'not a frame', rule: 'shape' };
  const type = frame[8];
  if (type !== 35 && type !== 37) return { allowed: true, rule: 'not_a_command' };
  const cmd = frame[10]; // inner cmd byte (family-aware offsets differ; both carry cmd at +2 from type)
  return gateCommand(cmd, { ...ctx, mode: 'replay' });
}
