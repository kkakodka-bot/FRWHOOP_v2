#!/usr/bin/env node
// Push wire-conformance suite. Runs the SAME byte-fixed scenarios against ANY receiver.
//   BASE_URL=http://127.0.0.1:54321/functions/v1/push PUSH_PATH=   (Edge, local serve)
//   BASE_URL=https://<ref>.supabase.co/functions/v1/push PUSH_PATH=   (Edge, prod)
//   AUTH=noop_...|jwt|"test"                   (bearer)
//   Object lane endpoints resolve as BASE_URL + /objects (Node) or the Edge base (sub = /objects).
// Exit 0 = all scenarios pass; non-zero = first failing scenario name.
//
// Suite mirrors the original Node push wire assertions (now retired; Edge is canonical).
import { hrBatch, gzipBatch, BATCH } from './scenarios.mjs';

const BASE = String(process.env.BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const PUSH = process.env.PUSH_PATH != null ? process.env.PUSH_PATH : '/api/push';
const AUTH = process.env.AUTH || 'test';
const TAG = `${BASE}`;
let failures = 0;

function ok(name, cond, extra = '') {
  if (cond) { console.log(`  ok ${name} ${extra}`.trimEnd()); }
  else { failures += 1; console.error(`  FAIL ${name} ${extra}`); }
}

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${AUTH}`,
      accept: 'application/json',
      'content-type': 'application/octet-stream',
      ...headers,
    },
    body,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { res, json };
}

// --- capabilities ---
{
  const { res, json } = await call(`${PUSH}`, { headers: { 'noop-push-accept-version': '1.1,1.0' } });
  ok('capabilities 1.1 status 200', res.status === 200, `got ${res.status}`);
  ok('capabilities type', json?.type === 'capabilities');
  ok('capabilities protocol 1.1', json?.protocolVersion === '1.1');
  ok('capabilities hrSample advertised', Array.isArray(json?.streams) && json.streams.includes('hrSample'));
  ok('capabilities 1.1 no objectLane', json?.objectLane == null);
}
{
  const { res, json } = await call(`${PUSH}`, { headers: { 'noop-push-accept-version': '1.2' } });
  ok('capabilities 1.2 status 200', res.status === 200);
  ok('capabilities 1.2 protocol', json?.protocolVersion === '1.2');
  ok('capabilities 1.2 objectLane present', json?.objectLane != null,
    JSON.stringify(json?.objectLane || null).slice(0, 120));
}
{
  const { res } = await call(`${PUSH}`);
  ok('capabilities no version header 406', res.status === 406, `got ${res.status}`);
}
// --- inline ingest: accept + archive + project + ack ---
{
  const { res, json } = await call(`${PUSH}`, {
    method: 'POST',
    body: gzipBatch(hrBatch()),
    headers: { 'content-encoding': 'gzip' },
  });
  ok('accept hrSample status 200', res.status === 200, `got ${res.status}`);
  ok('accept status accepted', json?.status === 'accepted');
  ok('accept batchId echo', json?.batchId === BATCH);
  ok('accept acceptedRows 2', json?.acceptedRows === 2);
}
// --- replay idempotence (identical ack, no double-write) ---
{
  const first = await call(`${PUSH}`, {
    method: 'POST',
    body: gzipBatch(hrBatch()),
    headers: { 'content-encoding': 'gzip' },
  });
  const replay = await call(`${PUSH}`, {
    method: 'POST',
    body: gzipBatch(hrBatch(/* identical */)),
    headers: { 'content-encoding': 'gzip' },
  });
  ok('replay status 200', replay.res.status === 200);
  ok('replay ack equals first', JSON.stringify(replay.json) === JSON.stringify(first.json),
    `first=${JSON.stringify(first.json)} replay=${JSON.stringify(replay.json)}`.slice(0, 160));
}
// --- auth ---
{
  const res = await fetch(`${BASE}${PUSH}`, {
    method: 'POST', body: gzipBatch(hrBatch()), headers: { 'content-encoding': 'gzip' },
  });
  ok('no auth 401', res.status === 401, `got ${res.status}`);
}
// --- protocol error ---
{
  const res = await fetch(`${BASE}${PUSH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${AUTH}` },
    body: Buffer.from('not-ndjson\n', 'utf8'),
  });
  ok('malformed body 4xx', res.status >= 400 && res.status < 500, `got ${res.status}`);
}
// --- object lane intent (only for receivers advertising it) ---
{
  const cap = await call(`${PUSH}`, { headers: { 'noop-push-accept-version': '1.2' } });
  if (cap.json?.objectLane) {
    const intentPath = `${PUSH}/objects`;
    const { res, json } = await call(intentPath, { method: 'POST', body: JSON.stringify({}) });
    // Intent with empty body must be a protocol error (not 200) — the lane exists.
    ok('object intent rejects empty body', res.status >= 400 && res.status < 500, `got ${res.status} ${JSON.stringify(json).slice(0,100)}`);
    ok('object lane endpoint shape', cap.json.objectLane.endpoint != null);
  } else {
    console.log('  skip object lane (not advertised)');
  }
}
// --- token lifecycle (mint/list/revoke). Reported as a gap when the receiver lacks the routes. ---
{
  const mint = await call(`${PUSH}/tokens`, { method: 'POST', body: JSON.stringify({ label: `conformance-${Date.now()}` }) });
  if (mint.res.status === 404 || mint.res.status === 501) {
    console.log('  GAP token lifecycle (POST/GET/DELETE /tokens not implemented by this receiver)');
  } else {
    ok('token mint 201', mint.res.status === 201, `got ${mint.res.status}`);
    ok('token mint returns noop_ token', typeof mint.json?.token === 'string' && mint.json.token.startsWith('noop_'));
    const token = mint.json?.token;
    const list = await call(`${PUSH}/tokens`);
    ok('token list 200', list.res.status === 200, `got ${list.res.status}`);
    ok('token list contains minted', Array.isArray(list.json?.tokens) && list.json.tokens.some((x) => x.id === mint.json?.id));
    const revoke = await call(`${PUSH}/tokens/${mint.json?.id}`, { method: 'DELETE' });
    ok('token revoke 200', revoke.res.status === 200, `got ${revoke.res.status}`);
    const denied = await call(`${PUSH}`, {
      method: 'POST', body: gzipBatch(hrBatch()), headers: { 'content-encoding': 'gzip', authorization: `Bearer ${token}` },
    });
    ok('revoked token rejected 401', denied.res.status === 401, `got ${denied.res.status}`);
  }
}

console.log(`\n[${TAG}] ${failures === 0 ? 'CONFORMANCE PASS' : `CONFORMANCE FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
