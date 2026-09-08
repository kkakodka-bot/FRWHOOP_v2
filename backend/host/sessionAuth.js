import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceTokenOf } from '../identity/resolveUser.js';
import { isProductionRuntime } from '../storage/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function isLoopbackAddress(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '').toLowerCase();
  return a === '127.0.0.1' || a === '::1' || a === 'localhost';
}

export function hostTokenPath() {
  return path.join(here, '../.frwhoop-host-token');
}

export function ensureHostToken(cfg = {}, { tokenPath = hostTokenPath() } = {}) {
  const existing = String(cfg.deviceToken || '').trim();
  if (existing) return existing;
  if (isProductionRuntime(cfg)) return '';
  try {
    if (existsSync(tokenPath)) {
      const fromFile = String(readFileSync(tokenPath, 'utf8') || '').trim();
      if (fromFile) return fromFile;
    }
  } catch { /* generate */ }
  const token = randomBytes(32).toString('hex');
  try { writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 }); } catch { /* best-effort */ }
  return token;
}

export function requireHostSession({ cfg = {} } = {}) {
  const production = isProductionRuntime(cfg);
  return function hostSession(req, res, next) {
    const ip = req.socket?.remoteAddress || req.ip || '';
    const loopback = isLoopbackAddress(ip);
    const presented = deviceTokenOf(req.headers || {})
      || String(req.headers?.['x-frwhoop-host-token'] || req.headers?.['X-FRWHOOP-HOST-TOKEN'] || '').trim();
    if (cfg.deviceToken && presented && presented === cfg.deviceToken) return next();
    if (loopback && !production) return next();
    return res.status(401).json({ error: 'host session required' });
  };
}
