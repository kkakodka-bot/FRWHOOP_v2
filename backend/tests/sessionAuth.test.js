import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureHostToken, isLoopbackAddress, requireHostSession } from '../host/sessionAuth.js';

test('loopback addresses are recognized through ipv4-mapped ipv6', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('10.0.0.5'), false);
});

test('ensureHostToken prefers config then persists a generated token', () => {
  assert.equal(ensureHostToken({ deviceToken: 'abc' }), 'abc');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'frwhoop-token-'));
  const tokenPath = path.join(dir, 'token');
  writeFileSync(tokenPath, 'from-file\n');
  assert.equal(ensureHostToken({}, { tokenPath }), 'from-file');
});

test('production does not generate or reuse a file host token', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'frwhoop-token-'));
  const tokenPath = path.join(dir, 'token');
  writeFileSync(tokenPath, 'from-file\n');
  assert.equal(ensureHostToken({ nodeEnv: 'production' }, { tokenPath }), '');
  assert.equal(ensureHostToken({ nodeEnv: 'production', deviceToken: 'phone' }, { tokenPath }), 'phone');
});

test('LAN clients cannot hit workout endpoints without the host token', async () => {
  const app = express();
  app.use(express.json());
  app.use(requireHostSession({ cfg: { deviceToken: 'secret', nodeEnv: 'development' } }));
  app.post('/api/ble/live', (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  try {
    const okLoopback = await fetch(`http://127.0.0.1:${port}/api/ble/live`, { method: 'POST' });
    assert.equal(okLoopback.status, 200);

    const denied = await new Promise((resolve) => {
      const req = {
        socket: { remoteAddress: '10.0.0.12' },
        headers: {},
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { resolve({ status: this.statusCode, body }); return this; },
      };
      requireHostSession({ cfg: { deviceToken: 'secret', nodeEnv: 'development' } })(req, res, () => {
        resolve({ status: 200, body: { ok: true } });
      });
    });
    assert.equal(denied.status, 401);

    const allowed = await new Promise((resolve) => {
      const req = {
        socket: { remoteAddress: '10.0.0.12' },
        headers: { 'x-frwhoop-device-token': 'secret' },
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { resolve({ status: this.statusCode, body }); return this; },
      };
      requireHostSession({ cfg: { deviceToken: 'secret', nodeEnv: 'development' } })(req, res, () => {
        resolve({ status: 200, body: { ok: true } });
      });
    });
    assert.equal(allowed.status, 200);

    const jwtDenied = await new Promise((resolve) => {
      const req = {
        socket: { remoteAddress: '10.0.0.12' },
        headers: { authorization: 'Bearer user-jwt' },
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { resolve({ status: this.statusCode, body }); return this; },
      };
      requireHostSession({ cfg: { deviceToken: 'secret', nodeEnv: 'production' } })(req, res, () => {
        resolve({ status: 200, body: { ok: true } });
      });
    });
    assert.equal(jwtDenied.status, 401);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
