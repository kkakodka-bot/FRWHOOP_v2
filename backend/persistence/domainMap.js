import fs from 'node:fs';
import path from 'node:path';
import { encryptJson, decryptJson, credentialsConfigured } from './cryptoSecrets.js';

function asArray(v) { return Array.isArray(v) ? v : []; }

function ownedBy(row, userId) {
  return Boolean(row?.userId && row.userId === userId);
}

/// Detector-created and hand-logged activities often omit userId. The store
/// is already scoped to `userId`; a foreign stamp is the only reject.
function sessionOwnedBy(row, userId) {
  if (!userId) return false;
  if (row?.userId && row.userId !== userId) return false;
  return true;
}

export function settingsFromStore(store) {
  return {
    prefs: store.prefs || {},
    permissions: store.permissions || {},
    alarms: store.alarms || [],
    weeklyPlan: store.weeklyPlan || {},
    longevity: store.longevity || {},
    community: {
      team: store.community?.team || null,
      follows: asArray(store.community?.members).filter((m) => m.followed).map((m) => m.id),
    },
    ble: {
      model: store.ble?.model || null,
      deviceId: store.ble?.deviceId || null,
      name: store.ble?.name || null,
    },
  };
}

export function applySettings(store, settings) {
  if (!settings || typeof settings !== 'object') return store;
  if (settings.prefs) store.prefs = { ...store.prefs, ...settings.prefs };
  if (settings.permissions) store.permissions = { ...store.permissions, ...settings.permissions };
  if (settings.alarms) store.alarms = settings.alarms;
  if (settings.weeklyPlan) store.weeklyPlan = { ...store.weeklyPlan, ...settings.weeklyPlan };
  if (settings.longevity) store.longevity = { ...store.longevity, ...settings.longevity };
  if (settings.ble) store.ble = { ...store.ble, ...settings.ble };
  return store;
}

export function eventsFromStore(store, userId) {
  const out = [];
  for (const row of asArray(store.journal)) {
    if (!ownedBy(row, userId)) continue;
    out.push({
      id: row.id,
      user_id: userId,
      event_type: 'journal',
      occurred_at: row.date || row.at || new Date().toISOString(),
      source: 'manual',
      payload: row,
    });
  }
  for (const row of asArray(store.checkIns)) {
    if (!ownedBy(row, userId)) continue;
    out.push({
      id: row.id,
      user_id: userId,
      event_type: 'check_in',
      occurred_at: row.date || row.at || row.createdAt || new Date().toISOString(),
      source: 'manual',
      text_value: row.feeling || row.note || null,
      payload: row,
    });
  }
  for (const row of asArray(store.captures)) {
    if (!ownedBy(row, userId)) continue;
    out.push({
      id: row.id,
      user_id: userId,
      event_type: 'capture',
      occurred_at: row.date || row.at || new Date().toISOString(),
      source: 'manual',
      text_value: row.kind || null,
      payload: row,
    });
  }
  return out.filter((e) => e.id);
}

export function measurementsFromStore(store, userId) {
  const out = [];
  const profile = store.profile || {};
  if (ownedBy(profile, userId) && profile.weightKg != null) {
    out.push({
      user_id: userId,
      metric_type: 'weight',
      measured_at: new Date().toISOString(),
      value: Number(profile.weightKg),
      unit: 'kg',
      source: 'profile',
    });
  }
  if (ownedBy(profile, userId) && profile.vo2Max != null) {
    out.push({
      user_id: userId,
      metric_type: 'vo2_max',
      measured_at: new Date().toISOString(),
      value: Number(profile.vo2Max),
      unit: 'ml/kg/min',
      source: profile.vo2MaxSource || 'user_entered',
    });
  }
  for (const row of asArray(store.bpReadings)) {
    if (!ownedBy(row, userId)) continue;
    out.push({
      id: row.id,
      user_id: userId,
      metric_type: 'blood_pressure',
      measured_at: row.at || row.date || new Date().toISOString(),
      value: row.systolic ?? row.sys ?? null,
      unit: 'mmHg',
      source: 'manual',
      metadata: row,
    });
  }
  return out;
}

export function sessionsFromStore(store, userId) {
  const out = [];
  for (const row of asArray(store.activities)) {
    if (!row.start || !row.end) continue;
    if (!sessionOwnedBy(row, userId)) continue;
    // A detected workout is written here and by the detector under the same id.
    // Both writers must agree on kind/source/external_id or whichever upsert
    // lands last relabels an auto workout as manual.
    const auto = row.autoDetected === true || row.source === 'auto';
    out.push({
      id: row.id,
      user_id: userId,
      kind: auto ? 'workout' : (row.kind || 'manual_workout'),
      source: auto ? 'auto-detect' : (row.source || 'manual'),
      external_id: auto && row.id
        ? `workout:auto:${row.id}`
        : (row.id ? `activity:${row.id}` : null),
      start_at: row.start,
      end_at: row.end,
      summary: row,
      user_modified: Boolean(row.userModified),
    });
  }
  for (const [id, row] of Object.entries(store.strengthSessions || {})) {
    if (!row.start || !row.end) continue;
    if (row.userId && row.userId !== userId) continue;
    out.push({
      id: row.id || id,
      user_id: userId,
      kind: 'strength_workout',
      source: 'manual',
      external_id: `strength:${id}`,
      start_at: row.start,
      end_at: row.end,
      summary: row,
    });
  }
  return out;
}

export function profileRow(store, userId) {
  const p = store.profile || {};
  return {
    id: userId,
    sex_model: p.sex || null,
    height_cm: p.heightCm ?? null,
    weight_kg: p.weightKg ?? null,
    timezone: p.timezone || 'UTC',
    preferences: store.prefs || {},
    consents: store.permissions || {},
  };
}

export function encodeIntegrationSecrets(store, secret) {
  const out = [];
  for (const [provider, row] of Object.entries(store.integrations || {})) {
    if (!row || typeof row !== 'object') continue;
    const tokens = row.tokens && typeof row.tokens === 'object' ? row.tokens : {};
    const hasTokens = Object.keys(tokens).length > 0;
    out.push({
      provider,
      status: row.status || 'disconnected',
      meta: row.meta || {},
      connected_at: row.connectedAt || row.connected_at || null,
      credentials_present: hasTokens,
      ciphertext: hasTokens && credentialsConfigured(secret) ? encryptJson(tokens, secret) : null,
      tokens: {},
    });
  }
  return out;
}

export function applyIntegrations(store, rows, secret) {
  store.integrations = store.integrations || {};
  for (const row of rows || []) {
    let tokens = {};
    if (row.ciphertext && secret) {
      try { tokens = decryptJson(row.ciphertext, secret); } catch { tokens = {}; }
    }
    store.integrations[row.provider] = {
      status: row.status,
      meta: row.meta || {},
      connectedAt: row.connected_at || null,
      tokens,
    };
  }
  return store;
}

export function writeCacheFile(filePath, store) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, filePath);
}

export function readCacheFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}
