import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFiles() {
  const candidates = [
    path.join(here, '../.env'),
    path.join(here, '../../.env'),
  ];
  for (const file of candidates) {
    if (existsSync(file)) dotenv.config({ path: file, override: false });
  }
  dotenv.config({ override: false });
}

loadEnvFiles();

/** Decode a Supabase JWT `role` without logging the token. */
export function jwtRole(token) {
  try {
    const payload = String(token || '').split('.')[1];
    if (!payload) return '';
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return String(json.role || '');
  } catch {
    return '';
  }
}

function withHttps(endpoint) {
  const v = String(endpoint || '').trim();
  if (!v) return '';
  return /^https?:\/\//i.test(v) ? v.replace(/\/$/, '') : `https://${v.replace(/\/$/, '')}`;
}

/** Server-only config. Never log values. Never ship this module to a client bundle. */
export function storageConfig(env = process.env) {
  const pick = (...names) => {
    for (const name of names) {
      const v = env[name];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  };
  const b2Ready = Boolean(pick('B2_KEY_ID', 'KEY_ID') && pick('B2_APPLICATION_KEY', 'APPLICATION_KEY'));
  const nodeEnv = pick('NODE_ENV') || 'development';
  const runtime = pick('FRWHOOP_RUNTIME').toLowerCase();
  const production = nodeEnv.toLowerCase() === 'production' || runtime === 'production';
  const rawStore = (pick('RAW_STORE') || (b2Ready ? 'b2' : 'none')).toLowerCase();
  const derivedStore = (pick('DERIVED_STORE') || (b2Ready ? 'b2' : 'none')).toLowerCase();
  const serviceCandidate = pick('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'SERVICE_ROLE_KEY');
  const anonCandidate = pick('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'ANNON_KEY', 'PUBLISHABLE_KEY');
  const serviceRoleName = jwtRole(serviceCandidate);
  const serviceRole = serviceRoleName === 'service_role'
    || (serviceCandidate && serviceCandidate !== anonCandidate && !['anon', 'authenticated'].includes(serviceRoleName))
    ? serviceCandidate
    : '';
  const allowDevUser = pick('FRWHOOP_ALLOW_DEV_USER') === 'true'
    || (pick('FRWHOOP_ALLOW_DEV_USER') !== 'false' && !production);
  return {
    supabaseUrl: pick('SUPABASE_URL', 'PROJECT_URL').replace(/\/$/, ''),
    supabaseAnonKey: anonCandidate,
    supabaseServiceRoleKey: serviceRole,
    b2KeyId: pick('B2_KEY_ID', 'KEY_ID'),
    b2ApplicationKey: pick('B2_APPLICATION_KEY', 'APPLICATION_KEY'),
    b2Bucket: pick('B2_BUCKET', 'BUCKET_NAME') || 'FRWHOOP',
    b2S3Endpoint: withHttps(pick('B2_S3_ENDPOINT')),
    b2Region: pick('B2_REGION', 'B2_S3_REGION') || 'us-west-004',
    rawSyncEnabled: pick('B2_RAW_SYNC_ENABLED') === 'true' || rawStore === 'b2',
    rawStore,
    derivedStore,
    ingestSecret: pick('INGEST_SECRET'),
    localUserId: production ? '' : (pick('FRWHOOP_LOCAL_USER_ID') || '7f2c9a10-4b3e-4d8a-9c11-00000000f001'),
    deviceToken: pick('FRWHOOP_DEVICE_TOKEN'),
    allowDevUser,
    nodeEnv,
    runtime: runtime || nodeEnv.toLowerCase(),
    credentialsKey: pick('FRWHOOP_CREDENTIALS_KEY'),
    credentialsPreviousKey: pick('FRWHOOP_CREDENTIALS_PREVIOUS_KEY'),
    credentialsKeyVersion: Number(pick('FRWHOOP_CREDENTIALS_KEY_VERSION') || 1) || 1,
    buildHash: pick('FRWHOOP_BUILD_HASH', 'GIT_SHA') || 'dev',
    hrChunkMs: Number(pick('RAW_HR_CHUNK_MS')) > 0 ? Number(pick('RAW_HR_CHUNK_MS')) : 60 * 60 * 1000,
    hfChunkMs: Number(pick('RAW_HF_CHUNK_MS')) > 0 ? Number(pick('RAW_HF_CHUNK_MS')) : 15 * 60 * 1000,
    retentionHrDays: pick('RETENTION_HR_DAYS') === '' ? null : (pick('RETENTION_HR_DAYS') ? Number(pick('RETENTION_HR_DAYS')) : null),
    retentionRrDays: pick('RETENTION_RR_DAYS') === '' ? null : (pick('RETENTION_RR_DAYS') ? Number(pick('RETENTION_RR_DAYS')) : null),
    retentionPpgDays: Number(pick('RETENTION_PPG_DAYS')) || 30,
    retentionImuDays: Number(pick('RETENTION_IMU_DAYS')) || 30,
    retentionBleDays: Number(pick('RETENTION_BLE_DAYS')) || 7,
    retentionDiagDays: Number(pick('RETENTION_DIAG_DAYS')) || 7,
    uploadTtlSec: 15 * 60,
    downloadTtlSec: 5 * 60,
  };
}

export function isProductionRuntime(cfg = {}, env = process.env) {
  const nodeEnv = String(cfg.nodeEnv || env.NODE_ENV || '').toLowerCase();
  const runtime = String(cfg.runtime || env.FRWHOOP_RUNTIME || '').toLowerCase();
  return nodeEnv === 'production' || runtime === 'production';
}

export function assertServerConfig(cfg) {
  const missing = [];
  if (!cfg.supabaseUrl) missing.push('SUPABASE_URL');
  if (!cfg.supabaseAnonKey) missing.push('SUPABASE_ANON_KEY');
  if (!cfg.supabaseServiceRoleKey && !cfg.ingestSecret) {
    missing.push('SUPABASE_SERVICE_ROLE_KEY or INGEST_SECRET');
  }
  const b2Ready = Boolean(cfg.b2KeyId && cfg.b2ApplicationKey && cfg.b2Bucket);
  if (!b2Ready) missing.push('B2_KEY_ID/B2_APPLICATION_KEY');
  return missing;
}

/** Production must have full persistence. No RPC-only, no B2-less, no secret OR. */
export function assertProductionRuntime(cfg, env = process.env) {
  const missing = [];
  if (!cfg.supabaseUrl) missing.push('SUPABASE_URL');
  if (!cfg.supabaseAnonKey) missing.push('SUPABASE_ANON_KEY');
  if (!cfg.supabaseServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!cfg.ingestSecret) missing.push('INGEST_SECRET');
  if (!cfg.b2KeyId || !cfg.b2ApplicationKey) missing.push('B2_KEY_ID/B2_APPLICATION_KEY');
  if (!cfg.b2Bucket) missing.push('B2_BUCKET');
  if (cfg.rawStore && cfg.rawStore !== 'b2') missing.push('RAW_STORE must be b2');
  if (cfg.derivedStore && cfg.derivedStore !== 'b2') missing.push('DERIVED_STORE must be b2');
  if (isProductionRuntime(cfg, env) && cfg.allowDevUser) missing.push('FRWHOOP_ALLOW_DEV_USER must be false in production');
  if (!String(env.FRWHOOP_DEVICE_TOKEN || '').trim()) missing.push('FRWHOOP_DEVICE_TOKEN');
  return missing;
}

export function requireProductionRuntime(cfg, env = process.env) {
  const missing = assertProductionRuntime(cfg, env);
  if (missing.length) {
    const err = new Error(`production_runtime_unconfigured: ${missing.join(', ')}`);
    err.code = 'production_runtime_unconfigured';
    err.missing = missing;
    throw err;
  }
  return cfg;
}

export function objectStoreReady(cfg = storageConfig()) {
  return assertServerConfig(cfg).length === 0;
}

export function tokenIntegrationsEnabled(env = process.env) {
  return Boolean(String(env.STRAVA_CLIENT_ID || '').trim() && String(env.STRAVA_CLIENT_SECRET || '').trim());
}

/** Fail closed: never start a process that would write integration tokens in plaintext. */
export function assertCredentialsPolicy(cfg = storageConfig(), env = process.env) {
  if (tokenIntegrationsEnabled(env) && !cfg.credentialsKey) {
    throw new Error('FRWHOOP_CREDENTIALS_KEY is required because a token integration is enabled');
  }
}
