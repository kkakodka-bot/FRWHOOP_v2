import express from 'express';
import { storageConfig, assertServerConfig } from './config.js';
import { createSupabaseAdmin } from './supabaseAdmin.js';
import { createRateLimiter } from './rateLimit.js';
import { createHandlers } from './handlers.js';
import { getStores } from './stores.js';

let cached;

async function getHandlers() {
  if (cached) return cached;
  const cfg = storageConfig();
  const missing = assertServerConfig(cfg);
  if (missing.length) {
    const err = new Error('storage_unconfigured');
    err.missing = missing;
    throw err;
  }
  const db = await createSupabaseAdmin({
    url: cfg.supabaseUrl,
    anonKey: cfg.supabaseAnonKey,
    serviceRoleKey: cfg.supabaseServiceRoleKey || cfg.supabaseAnonKey,
  });
  const { raw, derived } = await getStores(cfg);
  const s3 = raw || derived;
  if (!s3) {
    const err = new Error('storage_unconfigured');
    err.missing = ['object store'];
    throw err;
  }
  cached = createHandlers({ db, s3, rateLimit: createRateLimiter() });
  return cached;
}

function send(res, result) {
  res.status(result.status).json(result.body);
}

export function storageRouter() {
  const r = express.Router();
  r.post('/upload-intent', async (req, res) => {
    try { send(res, await (await getHandlers()).uploadIntent({ headers: req.headers, body: req.body })); }
    catch { res.status(503).json({ error: 'storage_unavailable' }); }
  });
  r.post('/upload-complete', async (req, res) => {
    try { send(res, await (await getHandlers()).uploadComplete({ headers: req.headers, body: req.body })); }
    catch { res.status(503).json({ error: 'storage_unavailable' }); }
  });
  r.post('/download-intent', async (req, res) => {
    try { send(res, await (await getHandlers()).downloadIntent({ headers: req.headers, body: req.body })); }
    catch { res.status(503).json({ error: 'storage_unavailable' }); }
  });
  r.post('/delete-account', async (req, res) => {
    try { send(res, await (await getHandlers()).deleteAccount({ headers: req.headers })); }
    catch { res.status(503).json({ error: 'storage_unavailable' }); }
  });
  r.post('/export', async (req, res) => {
    try { send(res, await (await getHandlers()).exportAccount({ headers: req.headers, body: req.body })); }
    catch { res.status(503).json({ error: 'storage_unavailable' }); }
  });
  r.post('/expire', async (req, res) => {
    const secret = process.env.STORAGE_CRON_SECRET || '';
    if (!secret || req.headers['x-cron-secret'] !== secret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try { send(res, await (await getHandlers()).expireObjects()); }
    catch { res.status(503).json({ error: 'storage_unavailable' }); }
  });
  r.get('/status', async (_req, res) => {
    try {
      const cfg = storageConfig();
      const { rawKind, derivedKind } = await getStores(cfg);
      res.json({
        ok: true,
        raw: rawKind,
        derived: derivedKind,
        supabase: Boolean(cfg.supabaseUrl),
        ingest: Boolean(cfg.ingestSecret),
      });
    } catch {
      res.status(503).json({ error: 'storage_unavailable' });
    }
  });
  return r;
}
