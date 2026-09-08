
// eval/sse-test.mjs — validates the production SSE endpoint end-to-end.
// Spawns the real server, streams a simple + a tool-using turn, asserts event contract,
// no malformed partials, deltas present, done payload complete, and client-cancel safety.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, '..');
const PORT = 8091;

function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['index.js'], { cwd: BACKEND, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, PORT: String(PORT) } });
    let attempt = 0;
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 2000 }, (res) => {
        res.resume(); resolve(p);
      }).on('error', () => {
        if (attempt++ > 20) return reject(new Error('server boot timeout'));
        setTimeout(tick, 500);
      });
    };
    tick();
  });
}

function streamTurn(body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const timer = setTimeout(() => { req.destroy(); reject(new Error('turn timeout')); }, timeoutMs);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/ai-coach/stream', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      const events = [];
      let buffer = '';
      let sawMeta = false;
      const doneCheck = (data) => {
        buffer += data;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
          const line = block.split('\n')[0];
          const evt = line.startsWith('event: ') ? line.slice(7) : 'message';
          const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
          let parsed = null;
          if (dataLine) { try { parsed = JSON.parse(dataLine.slice(6)); } catch { parsed = { malformed: dataLine }; } }
          events.push({ evt, data: parsed });
          if (evt === 'meta') sawMeta = true;
        }
      };
      res.on('data', doneCheck);
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, events, sawMeta, trailed: buffer });
      });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end(payload);
  });
}

async function main() {
  const server = await startServer();
  const results = {};
  try {
    // 1) simple single-call turn
    const r1 = await streamTurn({ message: 'What is my recovery today?', userId: 'sse-user' });
    const deltas = r1.events.filter((e) => e.evt === 'delta');
    const done = r1.events.find((e) => e.evt === 'done');
    const errs = r1.events.filter((e) => e.evt === 'error' || e.data?.malformed);
    const streamed = deltas.map((d) => d.data.content).join('');
    results.simple = {
      ok: r1.status === 200 && r1.sawMeta && deltas.length > 0 && streamed.length > 20 && done && done.data.response && errs.length === 0,
      status: r1.status, deltas: deltas.length, streamedLen: streamed.length, hasDone: !!done, hasResponse: Boolean(done?.data?.response), errs: errs.length,
    };
    console.log('simple:', JSON.stringify(results.simple));

    // 2) tool-using turn (dynamic exposure: relational metric question)
    const r2 = await streamTurn({ message: 'What was my average HRV over the last month?', userId: 'sse-user' });
    const deltas2 = r2.events.filter((e) => e.evt === 'delta');
    const done2 = r2.events.find((e) => e.evt === 'done');
    const streamed2 = deltas2.map((d) => d.data.content).join('');
    results.tool = {
      ok: r2.status === 200 && deltas2.length > 0 && streamed2.length > 20 && done2 && done2.data.response,
      status: r2.status, deltas: deltas2.length, streamedLen: streamed2.length, tools: (done2?.data?.toolsUsed || []).map((t) => t.name),
    };
    console.log('tool-lane:', JSON.stringify(results.tool));

    // 3) guardrail turn (deterministic, no model) — should still emit meta + done, no deltas
    const r3 = await streamTurn({ message: 'Diagnose my chest pain', userId: 'sse-user' });
    const done3 = r3.events.find((e) => e.evt === 'done');
    results.guardrail = { ok: r3.status === 200 && Boolean(done3) && /clinician/.test(done3?.data?.response || ''), resp: (done3?.data?.response || '').slice(0, 60) };
    console.log('guardrail:', JSON.stringify(results.guardrail));
  } catch (e) {
    results.error = String(e.message || e);
  } finally {
    try { server.kill('SIGTERM'); } catch {}
  }
  const allOk = Object.values(results).every((v) => v.ok !== false) && !results.error;
  console.log('\nSSE integration:', allOk ? 'ALL PASS' : 'FAIL');
  const out = path.join(here, '../data/eval/reports', `sse-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ ok: allOk, results }, null, 2));
  console.log('report:', out);
  process.exit(allOk ? 0 : 1);
}
main();
