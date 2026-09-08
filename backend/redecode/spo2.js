// Extract v18 SpO₂ observations from Level A/B WHOOP captures.
// Idempotent on source_frame_hash. Does not write spo2_pct.

import { replayNotifies } from './redecode.js';
import {
  observationFromLevelB, upsertObservations, reportsByDeviceFirmwareNight,
  summarizeSpo2Observations, correlateConsoleLogs, scanConfigReadbacks,
  applyConnectionFirmware, annotateSpo2Identity,
  SPO2_DECODER_VERSION, SPO2_SOURCE,
} from '../protocol/spo2.js';

function framedRows(rows) {
  return (rows || []).map((row) => ({
    ...row,
    hex: typeof row?.hex === 'string' && row.hex ? row.hex : row?.frame_hex,
  })).filter((row) => {
    const hex = typeof row?.hex === 'string' ? row.hex : '';
    return hex.length >= 16 && hex.toLowerCase().startsWith('aa');
  });
}

function consoleLogsFromLevelB(levelB) {
  const out = [];
  for (const rec of levelB || []) {
    if (rec.packet_type !== 50) continue;
    const parsed = rec.decoded?.parsed || {};
    if (parsed.log) out.push({ unix: parsed.unix, log: parsed.log, frame_hash: rec.frame_hash });
  }
  return out;
}

export function extractSpo2FromNotifies(notifies, opts = {}) {
  const framed = framedRows(notifies);
  const replay = replayNotifies(framed, { family: opts.family, decoder: opts.decoder });
  const incoming = [];
  for (const rec of replay.levelB) {
    const obs = observationFromLevelB(rec);
    if (obs) incoming.push(obs);
  }
  const fws = [...new Set((notifies || []).map((n) => n.fw || n.firmware).filter(Boolean))];
  const firmware = fws.length === 1 ? fws[0] : null;
  const recovered = applyConnectionFirmware(incoming, firmware).map((o) => annotateSpo2Identity(o, {
    userId: o.user_id || opts.userId || null,
    sourceDeviceId: o.device_id || opts.deviceId || null,
  }));
  const merged = upsertObservations(opts.existing || [], recovered);
  const logs = consoleLogsFromLevelB(replay.levelB);
  const out = {
    decoder_version: SPO2_DECODER_VERSION,
    source: SPO2_SOURCE,
    replay: replay.session,
    observations: merged.observations,
    inserted: merged.inserted,
    duplicates: merged.duplicates,
    logs,
    config_readbacks: scanConfigReadbacks(replay.levelB),
  };
  if (opts.summarize === false) return { ...out, summary: null, nights: [], console: { log_hits: 0, hits: [] } };
  return {
    ...out,
    summary: summarizeSpo2Observations(merged.observations),
    nights: reportsByDeviceFirmwareNight(merged.observations),
    console: correlateConsoleLogs(merged.observations, logs),
  };
}

export function extractSpo2FromObjects(objects, opts = {}) {
  const notifies = [];
  for (const o of objects || []) {
    for (const row of o.rows || []) {
      notifies.push({
        ...row,
        device_id: row.device_id || o.device || null,
        user_id: row.user_id || o.user || o.userId || null,
        fw: row.fw || o.firmware || null,
      });
    }
  }
  const first = extractSpo2FromNotifies(notifies, opts);
  const second = extractSpo2FromNotifies(notifies, { ...opts, existing: first.observations });
  return { ...first, rerun_duplicates: second.duplicates, rerun_inserted: second.inserted };
}
